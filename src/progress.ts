import type { Context } from '@deepseek-ai/cordis'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface ExecutionProgressData {
  callId: string
  rootCallId: string
  description: string
  stage: string
  submitted: number
  completed: number
  failed: number
  currentTool?: string
  cancelled: boolean
  finished: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:codebridge/progress': ExecutionProgressData
  }
}

/** 仅呈现执行状态；工具结果仍由原有持久记录负责。 */
export class ExecutionProgress {
  private readonly state: ExecutionProgressData
  private readonly listeners: (() => void)[] = []

  constructor(private readonly ctx: Context, private readonly exec: ToolRunContext, description: string) {
    this.state = {
      callId: String(exec.callId), rootCallId: String(exec.rootCallId), description,
      stage: '准备执行，等待此前取消的调用收尾', submitted: 0, completed: 0, failed: 0,
      cancelled: false, finished: false,
    }
  }

  observe(signal: AbortSignal): void {
    const cancel = () => {
      if (this.state.cancelled) return
      this.state.cancelled = true
      this.publish()
    }
    signal.addEventListener('abort', cancel, { once: true })
    this.listeners.push(() => signal.removeEventListener('abort', cancel))
    if (signal.aborted) cancel()
  }

  stage(stage: string): void {
    this.state.stage = stage
    this.publish()
  }

  submitted(): void { this.state.submitted++; this.publish() }

  start(name: string): void {
    this.state.currentTool = name
    this.stage('等待工具执行结束')
  }

  logging(): void { this.stage('等待工具日志收尾') }

  complete(isError: boolean): void {
    this.state.completed++
    if (isError) this.state.failed++
    delete this.state.currentTool
    this.stage('运行代码')
  }

  drain(): void {
    if (this.state.currentTool === undefined) this.stage('等待运行时及调用队列收尾')
    else this.publish()
  }

  drained(): void {
    delete this.state.currentTool
    this.stage('子调用及日志收尾已结束')
  }

  async track<T>(body: () => Promise<T>): Promise<T> {
    this.observe(this.exec.signal)
    this.publish()
    let succeeded = false
    try {
      const result = await body()
      succeeded = true
      return result
    } finally {
      for (const dispose of this.listeners) dispose()
      this.state.finished = true
      delete this.state.currentTool
      this.stage(this.state.cancelled ? '已取消，收尾已结束' : succeeded ? '执行完成，收尾已结束' : '执行失败，收尾已结束')
    }
  }

  private publish(): void {
    // 进度是辅助呈现。呈现记录故障不能打断取消回调或跳过工具日志的排空。
    try {
      appendPluginRecord(this.exec.agent!.session, 'plugin:codebridge/progress', { ...this.state })
    } catch (error) {
      this.ctx.logger.warn('CodeBridge 进度显示更新失败：%s', String(error))
    }
  }
}

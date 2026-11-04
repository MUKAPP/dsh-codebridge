import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

interface ActiveCall {
  sessionId: string
  mode: SandboxExecutionPolicy['mode']
  controller: AbortController
  done: Promise<void>
}

/** 拥有完整代码调用，包含运行时启动前等待和子工具收尾。 */
export class CallLifecycle {
  private readonly calls = new Set<ActiveCall>()
  private disposed = false
  private readonly policy

  constructor(ctx: Context) {
    this.policy = ctx.sandboxPolicy
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      for (const call of this.calls) {
        if (call.sessionId === session.id && call.mode !== event.data.mode) {
          call.controller.abort(new Error('会话权限已变化，代码执行已取消。'))
        }
      }
    }, { global: true })
    ctx.effect(() => async () => {
      this.disposed = true
      for (const call of this.calls) call.controller.abort(new Error('CodeBridge 已卸载。'))
      await Promise.all([...this.calls].map(call => call.done))
    }, 'CodeBridge active calls')
  }

  /** 在取消的同会话调用收尾后，取得当前权限并开始调用。 */
  async run<T>(exec: ToolRunContext, body: (signal: AbortSignal, policy: SandboxExecutionPolicy) => Promise<T>): Promise<T> {
    const agent = exec.agent
    if (agent === undefined) throw new Error('CodeBridge 代码执行需要当前代理会话。')
    for (;;) {
      const previous = [...this.calls].filter(call => call.sessionId === agent.session.id && call.controller.signal.aborted)
      if (previous.length === 0) break
      await Promise.all(previous.map(call => call.done))
    }
    exec.signal.throwIfAborted()
    if (this.disposed) throw new Error('CodeBridge 已卸载。')
    const policy = this.policy.resolve({ session: agent.session })
    const controller = new AbortController()
    const done = Promise.withResolvers<void>()
    const call: ActiveCall = { sessionId: agent.session.id, mode: policy.mode, controller, done: done.promise }
    this.calls.add(call)
    try {
      return await body(AbortSignal.any([exec.signal, controller.signal]), policy)
    } finally {
      this.calls.delete(call)
      done.resolve()
    }
  }
}

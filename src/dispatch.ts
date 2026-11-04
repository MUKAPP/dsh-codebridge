import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction } from '@deepseek-ai/dsh-ptc-runtime'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ToolExecutionInput, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type { ScheduledToolDispatch } from '@deepseek-ai/dsh-tools/pipeline'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// 子调用沿用宿主 PTC 的会话事件与消息来源声明，不重复定义同名事件。
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { EXCLUDED_TOOLS } from './catalog.js'
import type { ExecutionProgress } from './progress.js'

/** 一次程序的串行子调用队列，包含最终结果处理和日志持久化。 */
export class SerialDispatch {
  private tail: Promise<void> = Promise.resolve()
  private count = 0
  lastFailure: { toolName: string; callId: string; code?: string } | undefined
  private fatal: { error: unknown } | undefined
  private readonly tools
  private readonly pipeline: ToolExecutionPipeline
  readonly functions: Record<string, PtcBindingFunction> = Object.create(null)

  constructor(private readonly ctx: Context, private readonly exec: ToolRunContext, private readonly controller: AbortController, private readonly progress: ExecutionProgress) {
    this.tools = ctx.tools
    // 子调用与原生调用共用同一策略、守卫与结果结算管线。
    this.pipeline = new ToolExecutionPipeline(ctx)
    for (const schema of this.tools.schemas(exec.agent, exec.toolSet)) {
      if (EXCLUDED_TOOLS.has(schema.name)) continue
      const frozen = deepFreeze(schema)
      Object.defineProperty(this.functions, schema.name, {
        enumerable: true,
        value: (args: unknown) => this.enqueue(frozen, args),
      })
    }
  }

  private enqueue(schema: ToolSchema, args: unknown): Promise<JsonValue> {
    // 在提交时分离程序参数，不能让排队期间的修改改变实际执行和记录。
    const argumentsCopy = snapshotJsonValue(args)
    if (argumentsCopy === undefined) return Promise.reject(new Error('工具参数必须是无损 JSON。'))
    const subCallId = brandString<ToolCallId>(`${String(this.exec.callId)}:ptc:${++this.count}`)
    this.progress.submitted()
    const pending = this.tail.then(() => this.dispatch(schema, argumentsCopy, subCallId))
    // 队列自身始终可结算，失败仍由原始 Promise 交还调用程序。
    this.tail = pending.then(() => {}, () => {})
    return pending
  }

  private async dispatch(schema: ToolSchema, args: unknown, subCallId: ToolCallId): Promise<JsonValue> {
    this.controller.signal.throwIfAborted()
    const loggedArguments = snapshotJsonValue(args)
    const ids = { rootCallId: this.exec.rootCallId, parentCallId: this.exec.callId, subCallId, name: schema.name, arguments: loggedArguments }
    const input: ToolExecutionInput = {
      callId: subCallId,
      rootCallId: this.exec.rootCallId,
      name: schema.name,
      schema,
      arguments: args,
      ...(this.exec.agent === undefined ? {} : { agent: this.exec.agent }),
      ...(this.exec.toolSet === undefined ? {} : { toolSet: this.exec.toolSet }),
      parent: this.exec.token,
      signal: this.controller.signal,
    }
    let result: ToolExecutionResult
    try {
      this.exec.agent?.session.append('tool/ptc-dispatch-start', ids)
      this.progress.start(schema.name)
      const prepared = await this.pipeline.prepare(input)
      const outcome: ScheduledToolDispatch = prepared.kind === 'dispatch'
        ? await this.pipeline.dispatch(prepared.exec) : prepared
      result = await this.pipeline.complete(prepared.exec, outcome)
      if (!result.isError && result.content.some(block => block.type === 'image')) {
        this.exec.deferContext(createUserMessage({ content: result.content, source: { kind: 'ptc-mode' } }))
      }
      if (result.isError) {
        this.lastFailure = { toolName: schema.name, callId: String(subCallId), ...(result.error.info === undefined ? {} : { code: result.error.info.code }) }
      }
      for (const context of result.additionalContexts ?? []) this.exec.deferContext(context)
      if (result.concludesTurn) this.exec.concludeTurn()
      this.progress.logging()
      const content = await this.logContent(subCallId, schema.name, result)
      this.exec.agent?.session.append('tool/ptc-dispatch', {
        ...ids,
        isError: result.isError,
        content,
        ...(result.meta === undefined ? {} : { meta: result.meta }),
        ...(result.error?.info === undefined ? {} : { error: result.error.info }),
      })
      this.progress.complete(result.isError)
    } catch (error) {
      // 工具业务失败通过 result 返回；拒绝表示管线或会话记录本身失败。
      // 即使程序 catch 了绑定错误，外层也不能宣称成功。
      const failure = new HarnessError(
        `子调用管线或记录失败；工具：${schema.name}；调用：${String(subCallId)}；${error instanceof Error ? error.message : String(error)}`,
        'CODEBRIDGE_DISPATCH_FAILED',
      )
      this.fatal ??= { error: failure }
      this.controller.abort(failure)
      throw failure
    }
    this.controller.signal.throwIfAborted()
    if (result.isError) throw new Error(result.error.message)
    return result.value
  }

  private async logContent(subCallId: ToolCallId, name: string, result: ToolExecutionResult): Promise<ContentBlock[]> {
    const agent = this.exec.agent
    if (agent === undefined) return result.content
    try {
      return await this.ctx.waterfall(
        scopeTarget(this.tools, agent), 'tools/ptc-dispatch-log',
        { exec: this.exec, agent, subCallId, name, isError: result.isError, content: result.content },
        () => Promise.resolve(result.content),
      )
    } catch (error) {
      // 沿用原生 PTC 约定：日志内容转换失败时记录已经完成的原始结果。
      this.ctx.logger.warn('CodeBridge 子调用日志转换失败，保留原始结果：%s', String(error))
      return result.content
    }
  }

  /** 程序已结束，取消在途及排队调用，等待最后一个日志完成。 */
  async close(): Promise<void> {
    this.controller.abort(new Error('本次 CodeBridge 程序已结束。'))
    await this.tail
    if (this.fatal !== undefined) throw this.fatal.error
  }
}

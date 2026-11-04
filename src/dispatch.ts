import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction } from '@deepseek-ai/dsh-ptc-runtime'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { EXCLUDED_TOOLS } from './catalog.js'

/** 一次程序的串行子调用队列，包含最终结果处理和日志持久化。 */
export class SerialDispatch {
  private tail: Promise<void> = Promise.resolve()
  private count = 0
  lastFailure: { toolName: string; callId: string; code?: string } | undefined
  private fatal: { error: unknown } | undefined
  private readonly tools
  readonly functions: Record<string, PtcBindingFunction> = Object.create(null)

  constructor(private readonly ctx: Context, private readonly exec: ToolRunContext, private readonly controller: AbortController) {
    this.tools = ctx.tools
    for (const schema of this.tools.schemas(exec.agent)) {
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
    const pending = this.tail.then(() => this.dispatch(schema, argumentsCopy, subCallId))
    // 队列自身始终可结算，失败仍由原始 Promise 交还调用程序。
    this.tail = pending.then(() => {}, () => {})
    return pending
  }

  private async dispatch(schema: ToolSchema, args: unknown, subCallId: ToolCallId): Promise<JsonValue> {
    this.controller.signal.throwIfAborted()
    const loggedArguments = snapshotJsonValue(args)
    const ids = { rootCallId: this.exec.rootCallId, parentCallId: this.exec.callId, subCallId, name: schema.name, arguments: loggedArguments }
    let result: ToolExecutionResult
    try {
      this.exec.agent?.session.append('tool/ptc-dispatch-start', ids)
      result = await this.tools.execute({
        callId: subCallId,
        rootCallId: this.exec.rootCallId,
        name: schema.name,
        schema,
        arguments: args,
        agent: this.exec.agent,
        parent: this.exec.token,
        signal: this.controller.signal,
      })
      if (!result.isError && result.content.some(block => block.type === 'image')) {
        this.exec.deferContext(createUserMessage({ content: result.content, source: { kind: 'ptc-mode' } }))
      }
      if (result.isError) {
        this.lastFailure = { toolName: schema.name, callId: String(subCallId), ...(result.error.info === undefined ? {} : { code: result.error.info.code }) }
      }
      for (const context of result.additionalContexts ?? []) this.exec.deferContext(context)
      if (result.concludesTurn) this.exec.concludeTurn()
      const content = await this.logContent(subCallId, schema.name, result)
      this.exec.agent?.session.append('tool/ptc-dispatch', {
        ...ids,
        isError: result.isError,
        content,
        ...(result.meta === undefined ? {} : { meta: result.meta }),
        ...(result.error?.info === undefined ? {} : { error: result.error.info }),
      })
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

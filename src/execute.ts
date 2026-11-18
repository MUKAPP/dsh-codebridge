import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { EXEC_NAME } from './catalog.js'
import { CallLifecycle } from './lifecycle.js'
import type { Config } from './config.js'
import { SnapshotExecutionError, type SessionSnapshotStore, type SnapshotStatus } from './state.js'
import { SerialDispatch } from './dispatch.js'
import { RUNTIME_MISSING_MESSAGE, REPL_REQUIRED_MESSAGE } from './diagnostics.js'
import { runtimeFailureInvalidatesState, runtimeFailureText, stageFailure } from './errors.js'
import { DEFAULT_INLINE_BYTES, MAX_INLINE_BYTES, preparePreview, previewSchema, renderExecutionOutput, renderPreview, type ExecutionOutput } from './output.js'

/** 创建普通 native 工具，不改变宿主工具展示模式。 */
export function createExecuteTool(ctx: Context, lifecycle: CallLifecycle, snapshots: SessionSnapshotStore, config: Config) {
  const directories = ctx.workingDirectory
  return defineTool({
    name: EXEC_NAME,
    description: '工具选择：单步读取、写入或查询可直接调用原生工具；当任务需要两个或更多工具、循环、条件判断、批量筛选、分页处理或汇总时，优先使用本工具在一次代码执行中编排完成。它使用 Node TypeScript REPL 执行代码，支持顶层 await 和最后一个表达式；当前执行环境与重启恢复情况见 CodeBridge 代码执行状态提示。console.log 捕获到 logs；所有 tools.<工具名>(参数) 调用须 await，按串行执行。仅绑定当前代理可见工具，返回规范 JSON；失败抛出 ToolCallError（name、toolName、message）。先用 codebridge_tools 查询结构，或用 diagnostics:true 检查环境。大输出在全文保存成功后显示预览及取回位置，规范返回值保持完整；只返回任务需要的数据。Node 文件、网络和子进程操作沿用当前会话目录及宿主沙箱策略；取消、超时、权限变化或运行时重启可能清空会话状态。',
    parameters: {
      code: { type: 'string', required: true, description: 'TypeScript REPL 源码；支持顶层 await 和最后一个表达式。已有绑定是否可复用，以当前 CodeBridge 代码执行状态提示和最近一次工具结果为准。' },
      description: { type: 'string', required: true, description: '简短说明本次执行的任务。' },
      retainState: { type: 'boolean', description: '默认 false。true 时在执行后保留变量、函数和导入供后续调用复用；false 时仍可使用此前保留或恢复的数据，收尾后释放环境并清除恢复基线。后续需要复用时用 true，最后一步用 false。' },
      isolated: { type: 'boolean', description: '默认 false。true 时在独立的临时 REPL 执行，收尾后丢弃本次状态，不读取或修改共享环境与重启快照。适合插入一次性任务后继续使用原环境。不能与 retainState: true 同用；文件、网络与工具仍沿用当前会话权限。' },
      timeoutMs: { type: 'number', description: '正数毫秒超时，默认值和上限由 CodeBridge 专用 Node 运行时配置决定。' },
      maxInlineBytes: { type: 'integer', description: '展示正文的 UTF-8 字节预算，默认 32768，范围 1024–262144，不含预览提示。不改变运行时输出硬上限；全文无法保存时保留原文。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          stateRetained: { type: 'boolean', required: true },
          isolated: { type: 'boolean', enum: [true], description: '本次使用临时 REPL；stateRetained 只描述本次，不表示共享环境已释放。' },
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
          preview: previewSchema,
          snapshot: {
            type: 'object', additionalProperties: false,
            properties: {
              saved: { type: 'boolean', required: true },
              restored: { type: 'array', items: { type: 'string' } },
              omitted: { type: 'array', required: true, items: { type: 'string' } },
              warning: { type: 'string' },
            },
          },
          sandbox: {
            type: 'object', additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderExecutionOutput(value) }],
    },
    async execute(args, exec) {
      if (args.code.trim().length === 0 || args.description.trim().length === 0) {
        throw new Error('code 和 description 必须是非空字符串。')
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('timeoutMs 必须是正的有限数值。')
      }
      const maxInlineBytes = args.maxInlineBytes ?? DEFAULT_INLINE_BYTES
      if (!Number.isSafeInteger(maxInlineBytes) || maxInlineBytes < 1024 || maxInlineBytes > MAX_INLINE_BYTES) {
        throw new Error(`maxInlineBytes 必须是 1024–${MAX_INLINE_BYTES} 范围内的整数。`)
      }
      const retainState = args.retainState ?? false
      const isolated = args.isolated === true
      if (isolated && retainState) throw new Error('isolated: true 不能与 retainState: true 同用。')
      const onCleanupFailure = async (error: unknown, completedOutput: ExecutionOutput | undefined): Promise<never> => {
        if (completedOutput === undefined) throw error
        const { stateRetained: _state, preview: _preview, ...output } = completedOutput
        const text = 'CodeBridge 释放执行状态失败；用户代码已执行，不会重跑。\n'
          + String(error) + '\n已完成的代码输出：\n' + renderExecutionOutput(output)
        const failure = {
          logs: output.logs, error: String(error),
          ...(output.result === undefined ? {} : { result: output.result }),
          ...(output.snapshot === undefined ? {} : { snapshot: { ...output.snapshot } }),
          ...(output.sandbox === undefined ? {} : { sandbox: { ...output.sandbox } }),
        }
        const preview = exec.signal.aborted ? undefined
          : await preparePreview(ctx, exec, exec.signal, text, failure, maxInlineBytes)
        throw new HarnessError(preview === undefined ? text : 'CodeBridge 释放执行状态失败；用户代码已执行，不会重跑。\n' + renderPreview(preview), 'CODEBRIDGE_EXEC_FAILED')
      }
      return lifecycle.run(exec, isolated ? 'isolated' : retainState, async (signal, policy, stateOwner, runtime, invalidateState) => {
        let stateRetained = retainState
        const invalidate = () => { stateRetained = false; invalidateState() }
        if (runtime === undefined) throw new HarnessError(RUNTIME_MISSING_MESSAGE, 'CODEBRIDGE_RUNTIME_UNAVAILABLE')
        if (runtime.language !== 'typescript') throw new Error('CodeBridge 只支持 Node TypeScript 运行时。')
        if (runtime.programFormat !== 'repl') throw new HarnessError(REPL_REQUIRED_MESSAGE, 'CODEBRIDGE_REPL_UNAVAILABLE')
        if (args.timeoutMs !== undefined && runtime.timeout === undefined) throw new Error('当前运行时不支持 timeoutMs。')
        if (runtime.sandboxMode === undefined && policy.mode !== 'danger-full-access') {
          throw new Error(`当前运行时无法实施会话的 ${policy.mode} 文件权限。`)
        }
        const callId = String(exec.callId)
        let cwd: string
        try {
          cwd = await directories.ensure(exec.agent!, signal)
        } catch (error) {
          if (signal.aborted) throw new HarnessError('代码执行已取消。', TOOL_ABORTED)
          throw stageFailure('解析工作目录', callId, error)
        }
        signal.throwIfAborted()
        const recoveryEnabled = stateOwner !== undefined && config.restoreOnRestart.get()
        let recovered: { restored: string[]; omitted: string[] } | undefined
        try {
          if (recoveryEnabled) recovered = await snapshots.prepare(exec, runtime, stateOwner, cwd, policy, signal)
        } catch (error) {
          if (error instanceof SnapshotExecutionError && error.stateInvalidated) invalidate()
          throw error
        }
        if (stateOwner !== undefined && !recoveryEnabled) {
          const cleared = await snapshots.clear(exec)
          if (cleared.warning) throw new Error(cleared.warning)
        }
        signal.throwIfAborted()
        const controller = new AbortController()
        const onAbort = () => controller.abort(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        let result: PtcRunResult
        let dispatch: SerialDispatch
        let userExecutionStarted = false
        const clearRecovery = async (): Promise<string | undefined> => {
          if (!recoveryEnabled || !stateRetained) return undefined
          const status = await snapshots.clear(exec)
          return status.warning
        }
        try {
          dispatch = new SerialDispatch(ctx, exec, controller)
          let stage = '解析运行参数'
          try {
            const spec = runtime.resolve({
              program: args.code,
              ...(stateOwner === undefined ? {} : { stateOwner }),
              bindings: [{
                global: 'tools', functions: dispatch.functions,
                errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
              }],
              cwd,
              signal: controller.signal,
              ...(runtime.sandboxMode === undefined ? {} : { sandboxPolicy: policy }),
              ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            })
            stage = '启动或执行运行时'
            userExecutionStarted = true
            result = await runtime.run(spec)
            if (result.error !== undefined && runtimeFailureInvalidatesState(result.error)) invalidate()
          } catch (error) {
            invalidate()
            if (signal.aborted) throw new HarnessError('代码执行已取消。', TOOL_ABORTED)
            throw stageFailure(stage, callId, error)
          } finally {
            await dispatch.close()
          }
        } catch (error) {
          // The user program may already have changed state; invalidate only after dispatch/log drainage.
          const warning = userExecutionStarted ? await clearRecovery() : undefined
          if (warning) throw new HarnessError(`${error instanceof Error ? error.message : String(error)}\n${warning}`, signal.aborted ? TOOL_ABORTED : 'CODEBRIDGE_EXEC_FAILED')
          throw error
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
        if (signal.aborted) {
          const warning = await clearRecovery()
          throw new HarnessError(`代码执行已取消。${warning === undefined ? '' : `\n${warning}`}`, TOOL_ABORTED)
        }
        if (result.error !== undefined) {
          const snapshotWarning = await clearRecovery()
          const recent = dispatch.lastFailure === undefined ? ''
            : `\n最近失败的子调用（可能已被代码捕获）：${dispatch.lastFailure.toolName}；调用：${dispatch.lastFailure.callId}${dispatch.lastFailure.code === undefined ? '' : `；错误码：${dispatch.lastFailure.code}`}`
          const logs = result.logs.length === 0 ? '' : `\n已捕获日志：\n${result.logs.join('\n')}`
          const sandbox = result.sandbox === undefined ? '' : `\n文件沙箱：${result.sandbox.mode}${result.sandbox.denied ? '，操作被拒绝' : ''}${result.sandbox.enforcement === 'partial' ? '，部分实施' : ''}。`
          const text = `${runtimeFailureText(result.error, callId)}${recent}${logs}${sandbox}${snapshotWarning === undefined ? '' : `\n${snapshotWarning}`}`
          const failure = {
            logs: result.logs, error: { ...result.error }, callId,
            ...(dispatch.lastFailure === undefined ? {} : { lastFailedCall: { ...dispatch.lastFailure } }),
            ...(result.sandbox === undefined ? {} : { sandbox: { ...result.sandbox } }),
          }
          const preview = await preparePreview(ctx, exec, signal, text, failure, maxInlineBytes)
          throw new HarnessError(preview === undefined ? text
            : `代码执行失败（${result.error.kind}）；调用：${callId}${recent}\n${renderPreview(preview)}`, 'CODEBRIDGE_EXEC_FAILED')
        }
        let snapshot: SnapshotStatus | undefined = recovered === undefined
          ? undefined : { saved: false, restored: recovered.restored, omitted: recovered.omitted }
        if (recoveryEnabled && retainState) {
          const { stateInvalidated, ...captured } = await snapshots.capture(exec, runtime, stateOwner, cwd, policy, signal, args.code)
          snapshot = { ...captured, restored: recovered?.restored ?? [] }
          if (stateInvalidated) invalidate()
        }
        if (signal.aborted) {
          const warning = await clearRecovery()
          throw new HarnessError(`代码执行已取消。${warning === undefined ? '' : `\n${warning}`}`, TOOL_ABORTED)
        }
        const value = { stateRetained, ...(isolated ? { isolated: true as const } : {}), ...(snapshot === undefined ? {} : { snapshot: { ...snapshot } }), logs: result.logs, ...(result.value === undefined ? {} : { result: result.value }), ...(result.sandbox === undefined ? {} : { sandbox: { ...result.sandbox } }) }
        const preview = await preparePreview(ctx, exec, signal, renderExecutionOutput(value), value, maxInlineBytes)
        const output = { ...value, ...(preview === undefined ? {} : { preview }) }
        return output
      }, onCleanupFailure)
    },
    presentCall: args => ({ card: 'generic', title: args.description, kind: 'execute', rawInput: args.code }),
  })
}

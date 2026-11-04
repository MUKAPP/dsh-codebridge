import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { EXEC_NAME } from './catalog.js'
import { CallLifecycle } from './lifecycle.js'
import { SerialDispatch } from './dispatch.js'
import { renderJson } from './json.js'

/** 创建普通 native 工具，不改变宿主工具展示模式。 */
export function createExecuteTool(ctx: Context, lifecycle: CallLifecycle) {
  const directories = ctx.workingDirectory
  return defineTool({
    name: EXEC_NAME,
    description: '在临时 Node 环境执行 JavaScript/可擦除 TypeScript。代码是异步函数体，支持顶层 await 和 return；console.log 捕获到 logs。可 await tools.<工具名>(参数)，只包含当前代理可见工具；调用串行，不保留跨调用变量。工具返回规范 JSON，失败抛出 ToolCallError（name、toolName、message），用 codebridge_tools 按需查询输入和输出结构。所有异步工具调用必须 await；只返回任务需要的结果。使用当前会话工作目录和权限，Node 文件、网络和子进程操作受宿主沙箱约束。',
    parameters: {
      code: { type: 'string', required: true, description: '异步函数体源码。return 返回无损 JSON；无返回值时仅输出日志。' },
      description: { type: 'string', required: true, description: '简短说明本次执行的任务。' },
      timeoutMs: { type: 'number', description: '正数毫秒超时，默认值和上限由 CodeBridge 专用 Node 运行时配置决定。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
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
      render: (_args, value) => {
        const chunks = [...value.logs]
        if (value.result !== undefined) chunks.push(typeof value.result === 'string' ? value.result : renderJson(value.result))
        if (value.sandbox?.enforcement === 'partial') chunks.push('当前宿主仅部分实施文件沙箱限制。')
        if (value.sandbox?.denied) chunks.push(`文件操作被 ${value.sandbox.mode} 沙箱拒绝。`)
        return [{ type: 'text', text: chunks.join('\n') || '代码执行完成，无输出。' }]
      },
    },
    async execute(args, exec) {
      if (args.code.trim().length === 0 || args.description.trim().length === 0) {
        throw new Error('code 和 description 必须是非空字符串。')
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('timeoutMs 必须是正的有限数值。')
      }
      const runtime = ctx.get('ptcRuntime')
      if (runtime === undefined) throw new Error('未挂载 PTC 运行时；请在此 profile 启用兼容的 @deepseek-ai/dsh-ptc-runtime-node。')
      if (runtime.language !== 'typescript') throw new Error('CodeBridge 首版只支持 Node TypeScript 运行时。')
      if (args.timeoutMs !== undefined && runtime.timeout === undefined) throw new Error('当前运行时不支持 timeoutMs。')
      return lifecycle.run(exec, async (signal, policy) => {
        if (runtime.sandboxMode === undefined && policy.mode !== 'danger-full-access') {
          throw new Error(`当前运行时无法实施会话的 ${policy.mode} 文件权限。`)
        }
        // lifecycle 已要求 agent；ensure 仍使用原代理，而不是插件所在目录。
        const cwd = await directories.ensure(exec.agent!, signal)
        signal.throwIfAborted()
        const controller = new AbortController()
        const onAbort = () => controller.abort(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        let result: PtcRunResult
        try {
          const dispatch = new SerialDispatch(ctx, exec, controller)
          try {
            result = await runtime.run(runtime.resolve({
              program: runtime.programFormat === 'repl' ? `await (async () => {\n${args.code}\n})()` : args.code,
              bindings: [{
                global: 'tools', functions: dispatch.functions,
                errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
              }],
              cwd,
              signal: controller.signal,
              ...(runtime.sandboxMode === undefined ? {} : { sandboxPolicy: policy }),
              ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            }))
          } finally {
            await dispatch.close()
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
        if (signal.aborted) throw new HarnessError('代码执行已取消。', TOOL_ABORTED)
        if (result.error !== undefined) {
          const logs = result.logs.length === 0 ? '' : `\n已捕获日志：\n${result.logs.join('\n')}`
          const sandbox = result.sandbox === undefined ? '' : `\n文件沙箱：${result.sandbox.mode}${result.sandbox.denied ? '，操作被拒绝' : ''}${result.sandbox.enforcement === 'partial' ? '，部分实施' : ''}。`
          throw new HarnessError(`代码执行失败（${result.error.kind}）：${result.error.message}${logs}${sandbox}`, 'CODEBRIDGE_EXEC_FAILED')
        }
        return { logs: result.logs, ...(result.value === undefined ? {} : { result: result.value }), ...(result.sandbox === undefined ? {} : { sandbox: result.sandbox }) }
      })
    },
    presentCall: args => ({ card: 'generic', title: args.description, kind: 'execute', rawInput: args.code }),
  })
}

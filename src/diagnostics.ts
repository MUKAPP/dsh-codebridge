import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-spill'
import { DEFAULT_INLINE_BYTES } from './output.js'

export const RUNTIME_MISSING_MESSAGE = '未挂载 CodeBridge 专用 PTC 运行时；请启用 dsh-codebridge 组合包中的 codebridge-runtime（@deepseek-ai/dsh-ptc-runtime-node），并确保它与 codebridge 使用相同的 dsh-codebridge-runtime 隔离配置。仅启用公共运行时不能修复此问题。'

export const REPL_REQUIRED_MESSAGE = 'CodeBridge 会话级状态需要专用 runtime 使用 persistent-in-memory（programFormat: repl）；请恢复 dsh-codebridge 组合包的默认 runtime 配置。'

export const diagnosticsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    configurationReady: { type: 'boolean', required: true },
    cwd: { type: 'string', required: true },
    outputStorageAvailable: { type: 'boolean', required: true },
    defaultMaxInlineBytes: { type: 'integer', required: true },
    sandboxMode: { type: 'string', required: true },
    runtime: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        available: { type: 'boolean', required: true },
        language: { type: 'string' },
        isolation: { type: 'string' },
        programFormat: { type: 'string' },
        stateRetention: { type: 'string', enum: ['session', 'call', 'unknown'] },
        stateRecovery: { type: 'string', enum: ['process-only', 'durable', 'unknown'] },
        filePolicySupported: { type: 'boolean' },
        timeout: {
          type: 'object', additionalProperties: false,
          properties: {
            defaultMs: { type: 'number', required: true },
            maxMs: { type: 'number', required: true },
          },
        },
      },
    },
    issues: { type: 'array', required: true, items: { type: 'string' } },
    note: { type: 'string', required: true },
  },
} as const

/** 仅读取当前会话与公开运行时能力，不启动进程、不修复或改变工作目录。 */
export function collectDiagnostics(ctx: Context, exec: ToolRunContext) {
  exec.signal.throwIfAborted()
  if (exec.agent === undefined) throw new Error('CodeBridge 环境诊断需要当前代理会话。')
  const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
  const runtime = ctx.get('ptcRuntime')
  const issues: string[] = []
  if (runtime === undefined) issues.push(RUNTIME_MISSING_MESSAGE)
  else {
    if (runtime.language !== 'typescript') issues.push('CodeBridge 只支持 Node TypeScript 运行时。')
    if (runtime.programFormat !== 'repl') issues.push(REPL_REQUIRED_MESSAGE)
    if (runtime.sandboxMode === undefined && policy.mode !== 'danger-full-access') {
      issues.push(`当前运行时无法实施会话的 ${policy.mode} 文件权限。`)
    }
  }
  const timeout = runtime?.timeout
  const stateRetention: 'session' | 'call' = runtime?.programFormat === 'repl' ? 'session' : 'call'
  return {
    configurationReady: issues.length === 0,
    cwd: ctx.workingDirectory.get(exec.agent.session),
    outputStorageAvailable: ctx.get('spillStore') !== undefined,
    defaultMaxInlineBytes: DEFAULT_INLINE_BYTES,
    sandboxMode: policy.mode,
    runtime: runtime === undefined ? { available: false } : {
      available: true,
      language: runtime.language,
      isolation: runtime.isolation,
      programFormat: runtime.programFormat,
      stateRetention,
      stateRecovery: stateRetention === 'session' ? 'process-only' as const : 'unknown' as const,
      filePolicySupported: runtime.sandboxMode !== undefined,
      ...(timeout === undefined ? {} : { timeout }),
    },
    issues,
    note: '仅检查配置与声明能力，未启动运行时、检查目录存在性或验证实际沙箱隔离。代码在同一会话内使用持久 REPL，子调用仍串行；运行时输出硬上限请查看 codebridge-runtime 配置。',
  }
}

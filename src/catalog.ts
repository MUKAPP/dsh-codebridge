import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { renderJson } from './json.js'
import { collectDiagnostics, diagnosticsSchema } from './diagnostics.js'

export const EXEC_NAME = 'codebridge_exec'
export const DESCRIBE_NAME = 'codebridge_tools'
/** 不将复合代码传输暴露为递归绑定。 */
export const EXCLUDED_TOOLS: ReadonlySet<string> = new Set([EXEC_NAME, DESCRIBE_NAME, 'run_code'])

/** 按需提供当前代理能调用的工具签名，避免重复注入完整 SDK。 */
export function createDescribeTool(ctx: Context) {
  const tools = ctx.tools
  return defineTool({
    name: DESCRIBE_NAME,
    description: '查询供 CodeBridge 调用的工具参数和规范 JSON 返回结构；diagnostics:true 可只读检查当前会话和专用运行时配置，无需执行代码。工具查询仅返回当前代理可见的明确名称。原生展示文本可能不同于规范返回值。',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, description: '要查询的工具名称数组。不请求 diagnostics 时必须非空。' },
      diagnostics: { type: 'boolean', description: '为 true 时附带只读环境诊断；可省略 names，不启动运行时或改变配置。' },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          tools: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              description: { type: 'string', required: true },
              parameters: { type: 'json', required: true },
              output: { type: 'json', required: true },
            },
          } },
          unavailable: { type: 'array', required: true, items: { type: 'string' } },
          diagnostics: diagnosticsSchema,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      exec.signal.throwIfAborted()
      const names = args.names ?? []
      if ((!args.diagnostics && names.length === 0) || names.some(name => name.trim().length === 0)) {
        throw new Error('names 必须是非空工具名称数组；仅请求 diagnostics:true 时可省略。')
      }
      const diagnostics = args.diagnostics ? collectDiagnostics(ctx, exec) : undefined
      const schemas = new Map(tools.schemas(exec.agent).map(schema => [schema.name, schema]))
      const found = []
      const unavailable: string[] = []
      for (const name of new Set(names)) {
        const schema = schemas.get(name)
        const definition = tools.get(name, exec.agent)
        if (EXCLUDED_TOOLS.has(name) || schema === undefined || definition === undefined) {
          unavailable.push(name)
        } else {
          // 注册表在注册和 schema 投影时已验证 JSON，这里只收窄宽泛的 schema 类型。
          found.push({ name, description: schema.description, parameters: schema.parameters as JsonValue, output: definition.output.schema as JsonValue })
        }
      }
      return { tools: found, unavailable, ...(diagnostics === undefined ? {} : { diagnostics }) }
    },
  })
}

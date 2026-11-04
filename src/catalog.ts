import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { renderJson } from './json.js'

export const EXEC_NAME = 'codebridge_exec'
export const DESCRIBE_NAME = 'codebridge_tools'
/** 不将复合代码传输暴露为递归绑定。 */
export const EXCLUDED_TOOLS: ReadonlySet<string> = new Set([EXEC_NAME, DESCRIBE_NAME, 'run_code'])

/** 按需提供当前代理能调用的工具签名，避免重复注入完整 SDK。 */
export function createDescribeTool(ctx: Context) {
  const tools = ctx.tools
  return defineTool({
    name: DESCRIBE_NAME,
    description: '查询供 CodeBridge 代码调用的工具参数和规范 JSON 返回结构。仅查询明确名称且对当前代理可见的工具。原生工具呈现的文本可能不同于代码收到的规范返回值。',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: '要查询的非空工具名称数组。' },
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      exec.signal.throwIfAborted()
      if (args.names.length === 0 || args.names.some(name => name.trim().length === 0)) {
        throw new Error('names 必须是非空工具名称数组。')
      }
      const schemas = new Map(tools.schemas(exec.agent).map(schema => [schema.name, schema]))
      const found = []
      const unavailable: string[] = []
      for (const name of new Set(args.names)) {
        const schema = schemas.get(name)
        const definition = tools.get(name, exec.agent)
        if (EXCLUDED_TOOLS.has(name) || schema === undefined || definition === undefined) {
          unavailable.push(name)
        } else {
          // 注册表在注册和 schema 投影时已验证 JSON，这里只收窄宽泛的 schema 类型。
          found.push({ name, description: schema.description, parameters: schema.parameters as JsonValue, output: definition.output.schema as JsonValue })
        }
      }
      return { tools: found, unavailable }
    },
  })
}

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

/** 搜索先返回摘要，精确名称查询保持完整结构兼容。 */
export function createDescribeTool(ctx: Context) {
  const tools = ctx.tools
  return defineTool({
    name: DESCRIBE_NAME,
    description: '工具选择入口：单步任务可直接调用原生工具；当任务需要两个或更多工具、循环、条件判断、批量筛选、分页处理或汇总时，应先用本工具查询结构，再优先用 codebridge_exec 在一次代码执行中完成编排。query 按名称或描述筛选，默认仅返回摘要，空字符串浏览全部。用 names 按需查询完整参数及规范 JSON 返回结构，或 detail 显式选择 summary/full。diagnostics:true 只读检查会话及专用运行时，不执行代码。',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, description: '精确工具名称，去重后查询；默认返回完整结构。与 query 互斥。' },
      query: { type: 'string', description: '不区分大小写的名称或描述子串；空字符串浏览全部可见工具。默认返回摘要，按名称排序。' },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'summary 仅名称和说明；full 附完整 parameters/output。' },
      offset: { type: 'integer', description: '搜索分页起点，默认 0；仅用于 query。' },
      limit: { type: 'integer', description: '搜索每页数量，默认 20，范围 1–100；仅用于 query。' },
      diagnostics: { type: 'boolean', description: '附带只读环境诊断，可单独请求，不启动运行时或改变配置。' },
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
              parameters: { type: 'json' },
              output: { type: 'json' },
            },
          } },
          unavailable: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'integer' },
          nextOffset: { type: 'integer' },
          diagnostics: diagnosticsSchema,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      exec.signal.throwIfAborted()
      const names = args.names ?? []
      const hasNames = names.length > 0
      const queryText = typeof args.query === 'string' ? args.query : undefined
      const hasQuery = queryText !== undefined
      const searching = !hasNames && hasQuery && (!args.diagnostics || queryText.trim().length > 0)
      if (hasNames && hasQuery && queryText.trim().length > 0) throw new Error('names 与 query 不能同时使用。')
      if ((!args.diagnostics && !hasNames && !hasQuery) || names.some(name => name.trim().length === 0)) {
        throw new Error('请提供非空 names、query（可为空字符串）或 diagnostics:true。')
      }
      if (!searching && ((args.offset !== undefined && args.offset !== 0) || (args.limit !== undefined && args.limit !== 20))) throw new Error('offset 和 limit 仅用于 query 搜索。')
      const offset = args.offset ?? 0
      const limit = args.limit ?? 20
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负安全整数。')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须是 1–100 的整数。')
      const diagnostics = args.diagnostics ? collectDiagnostics(ctx, exec) : undefined
      const schemas = new Map(tools.schemas(exec.agent).map(schema => [schema.name, schema]))
      const query = args.query?.trim().toLowerCase() ?? ''
      const matches = searching ? [...schemas.values()].filter(schema =>
        !EXCLUDED_TOOLS.has(schema.name) && tools.get(schema.name, exec.agent) !== undefined
        && (schema.name.toLowerCase().includes(query) || schema.description.toLowerCase().includes(query)),
      ).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : []
      const selected = searching ? matches.slice(offset, offset + limit).map(schema => schema.name) : [...new Set(names)]
      const full = (args.detail ?? (searching ? 'summary' : 'full')) === 'full'
      const found = []
      const unavailable: string[] = []
      for (const name of selected) {
        const schema = schemas.get(name)
        const definition = tools.get(name, exec.agent)
        if (EXCLUDED_TOOLS.has(name) || schema === undefined || definition === undefined) {
          unavailable.push(name)
        } else {
          found.push({ name, description: schema.description, ...(full ? {
            parameters: schema.parameters as JsonValue, output: definition.output.schema as JsonValue,
          } : {}) })
        }
      }
      const nextOffset = offset + found.length
      return { tools: found, unavailable,
        ...(searching ? { total: matches.length, ...(nextOffset < matches.length ? { nextOffset } : {}) } : {}),
        ...(diagnostics === undefined ? {} : { diagnostics }),
      }
    },
  })
}

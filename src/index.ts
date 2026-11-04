import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createDescribeTool } from './catalog.js'
import { createExecuteTool } from './execute.js'
import { CallLifecycle } from './lifecycle.js'

/** Host 插件标识；两种工具共享同一卸载生命周期。 */
export const name = 'codebridge'
/** PTC 运行时在实际执行时读取，缺失时给出工具失败而不是隐藏查询入口。 */
export const inject = ['tools', 'sandboxPolicy', 'workingDirectory']

/** 注册 CodeBridge 工具，保留宿主原有展示与工具集合。 */
export function apply(ctx: Context): void {
  const lifecycle = new CallLifecycle(ctx)
  ctx.tools.register(createExecuteTool(ctx, lifecycle))
  ctx.tools.register(createDescribeTool(ctx))
}

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { createDescribeTool } from './catalog.js'
import { createExecuteTool } from './execute.js'
import { CallLifecycle } from './lifecycle.js'
import { SessionSnapshotStore } from './state.js'
import { registerStateModePrompt } from './state-prompt.js'

export { Config } from './config.js'
export const name = 'codebridge'
export const inject = ['tools', 'sandboxPolicy', 'workingDirectory', 'systemPrompt']

export async function apply(ctx: Context, config: Config): Promise<void> {
  const snapshots = new SessionSnapshotStore(ctx, config)
  await snapshots.ready
  registerStateModePrompt(ctx, config)
  const lifecycle = new CallLifecycle(ctx, config, async exec => {
    const status = await snapshots.clear(exec)
    if (status.warning) throw new Error(status.warning)
  })
  ctx.tools.register(createExecuteTool(ctx, lifecycle, snapshots, config))
  ctx.tools.register(createDescribeTool(ctx, config))
}

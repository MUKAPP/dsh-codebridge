import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { STATE_MODE_CONTEXT, registerStateModePrompt } from '../lib/state-prompt.js'
import { setup } from './fixture.mjs'

for (const [retain, restore, retentionText, recoveryText] of [
  [true, false, '会话状态：开启（有状态）', '重启恢复：关闭'],
  [true, true, '会话状态：开启（有状态）', '重启恢复：开启，仅自动恢复受支持的顶层 JSON 数据变量'],
  [false, false, '会话状态：关闭（无状态）', '重启恢复：关闭'],
  [false, true, '会话状态：关闭（无状态）', '因此恢复不生效'],
]) {
  test(`model receives explicit state guidance for retain=${retain}, restore=${restore}`, async t => {
    const f = await setup(t, { config: { retainSessionState: retain, restoreOnRestart: restore } })
    const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent })
    const execSchema = assembly.tools.find(tool => tool.name === 'codebridge_exec')
    assert.match(execSchema.parameters.properties.code.description, /以当前 CodeBridge 代码执行状态提示为准/)
    const contexts = assembly.contexts.filter(context => context.name === STATE_MODE_CONTEXT)
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0].text.includes(retentionText), contexts[0].text)
    assert.ok(contexts[0].text.includes(recoveryText), contexts[0].text)
    assert.equal(contexts[0].interpolate, false)
    if (!retain) assert.match(contexts[0].text, /每次代码必须自包含，不能依赖前一次绑定/)
    if (retain && restore) assert.match(contexts[0].text, /不恢复函数、模块实例或句柄，不重跑历史代码/)
    assert.match(contexts[0].text, /下一次调用会清空旧执行环境与恢复基线/)
  })
}

test('admission refresh reads changed settings without accumulating contexts or changing tools', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  const values = { retain: true, restore: false }
  const config = { retainSessionState: { get: () => values.retain }, restoreOnRestart: { get: () => values.restore } }
  await ctx.plugin(Object.assign(inner => registerStateModePrompt(inner, config), { inject: ['systemPrompt'] }))
  let assembly = await ctx.systemPrompt.assemble()
  const tools = assembly.tools
  for (const [retain, restore, expected] of [
    [false, false, '会话状态：关闭（无状态）'],
    [false, true, '因此恢复不生效'],
    [true, true, '重启恢复：开启，仅自动恢复'],
    [true, false, '重启恢复：关闭'],
  ]) {
    values.retain = retain; values.restore = restore
    assembly = ctx.systemPrompt.refreshContext(assembly)
    const contexts = assembly.contexts.filter(context => context.name === STATE_MODE_CONTEXT)
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0].text.includes(expected), contexts[0].text)
    assert.equal(assembly.tools, tools)
  }
})

test('state guidance survives optional runtime-context suppression and unregisters on unload', async t => {
  const f = await setup(t)
  f.ctx.systemPrompt.suppressRuntimeContext()
  let assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  assert.equal(assembly.contexts.some(context => context.name === STATE_MODE_CONTEXT), true)
  assembly = f.ctx.systemPrompt.refreshContext(assembly, { scope: f.agent })
  assert.equal(assembly.contexts.some(context => context.name === STATE_MODE_CONTEXT), true)
  await f.plugin.dispose()
  assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  assert.equal(assembly.contexts.some(context => context.name === STATE_MODE_CONTEXT), false)
})

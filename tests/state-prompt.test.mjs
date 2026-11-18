import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { STATE_MODE_CONTEXT, registerStateModePrompt } from '../lib/state-prompt.js'
import { setup, execute } from './fixture.mjs'

for (const restore of [false, true]) {
  test('model receives per-call retention guidance with restart recovery ' + restore, async t => {
    const f = await setup(t, { config: { restoreOnRestart: restore } })
    const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent, agent: f.agent })
    const execSchema = assembly.tools.find(tool => tool.name === 'codebridge_exec')
    assert.equal(execSchema.parameters.properties.retainState.type, 'boolean')
    assert.match(execSchema.parameters.properties.retainState.description, /默认 false/)
    assert.match(execSchema.parameters.properties.code.description, /以当前 CodeBridge 代码执行状态提示/)
    const contexts = assembly.contexts.filter(context => context.name === STATE_MODE_CONTEXT)
    assert.equal(contexts.length, 1)
    assert.match(contexts[0].text, /当前没有可续用的执行环境/)
    assert.ok(contexts[0].text.includes(restore ? '重启恢复：开启，仅自动恢复' : '重启恢复：关闭'))
    assert.equal(contexts[0].interpolate, false)
    if (restore) assert.match(contexts[0].text, /不恢复函数、模块实例或句柄，不重跑历史代码/)
    assert.match(contexts[0].text, /下一次调用会清空旧执行环境与恢复基线/)
  })
}

test('admission refresh reads changed recovery settings without accumulating contexts or changing tools', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  let restore = false
  const config = { restoreOnRestart: { get: () => restore } }
  await ctx.plugin(Object.assign(inner => registerStateModePrompt(inner, config, { hasRetainedState: () => false }), { inject: ['systemPrompt'] }))
  let assembly = await ctx.systemPrompt.assemble()
  const tools = assembly.tools
  for (const enabled of [true, false]) {
    restore = enabled
    assembly = ctx.systemPrompt.refreshContext(assembly)
    const contexts = assembly.contexts.filter(context => context.name === STATE_MODE_CONTEXT)
    assert.equal(contexts.length, 1)
    assert.ok(contexts[0].text.includes(enabled ? '重启恢复：开启，仅自动恢复' : '重启恢复：关闭'))
    assert.equal(assembly.tools, tools)
  }
})

test('state guidance follows successful per-call retention and release', async t => {
  const f = await setup(t)
  const context = { scope: f.agent, agent: f.agent }
  await execute(f, { retainState: true })
  let assembly = await f.ctx.systemPrompt.assemble(context)
  assert.match(assembly.contexts.find(item => item.name === STATE_MODE_CONTEXT).text, /已保留执行环境/)
  const tools = assembly.tools
  await execute(f, { retainState: false })
  assembly = f.ctx.systemPrompt.refreshContext(assembly, context)
  assert.match(assembly.contexts.find(item => item.name === STATE_MODE_CONTEXT).text, /当前没有可续用的执行环境/)
  assert.equal(assembly.tools, tools)
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

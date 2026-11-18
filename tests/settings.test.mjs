import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallLifecycle } from '../lib/lifecycle.js'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const controllerSource = await readFile(new URL('../src/client/settings-controller.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(controllerSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
const { CodeBridgeSettingsController } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))
import { setup } from './fixture.mjs'

test('session disposal during recovery-setting cleanup prevents admission of the next cell', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const lifecycle = new CallLifecycle(f.ctx)
  const context = { agent: f.agent, signal: new AbortController().signal }
  await lifecycle.run(context, true, async () => {})
  const entered = f.gate(), release = f.gate()
  f.runtime.releaseBehavior = async () => { entered.resolve(); await release.promise }
  f.ctx.emit('loader/volatile-update', [['restoreOnRestart']])
  let ran = false
  const next = lifecycle.run(context, true, async () => { ran = true })
  const rejected = assert.rejects(next, /会话状态已释放/)
  await entered.promise
  f.ctx.emit('session/disposed', f.agent.session)
  release.resolve()
  await rejected
  assert.equal(ran, false)
})

function fakeForm(overrides = {}) {
  let snapshot = { status: 'ready', writable: true, revision: 1, value: { restoreOnRestart: false }, base: { restoreOnRestart: false }, user: {}, ...overrides }
  const listeners = new Set()
  const mutations = []
  return {
    mutations, listeners,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(patch) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() },
    async mutate(ops, revision) {
      mutations.push({ ops, revision })
      if (revision !== snapshot.revision) return false
      const user = { ...snapshot.user }
      for (const op of ops) {
        if (op.op === 'unset') delete user[op.path[0]]
        else user[op.path[0]] = op.value
      }
      this.publish({ user, value: { ...snapshot.base, ...user }, revision: snapshot.revision + 1 })
      return true
    },
  }
}

test('settings save restart recovery in a revision-fenced mutation', async () => {
  const form = fakeForm()
  const controller = new CodeBridgeSettingsController(form)
  controller.edit('restoreOnRestart', true)
  assert.equal(form.mutations.length, 0)
  await controller.save()
  assert.equal(form.mutations.length, 1)
  assert.deepEqual(form.mutations[0], { revision: 1, ops: [
    { op: 'set', path: ['restoreOnRestart'], value: true },
  ] })
  assert.equal(controller.getSnapshot().result, 'saved')
  assert.equal(controller.getSnapshot().dirty, false)
  controller.dispose()
  assert.equal(form.listeners.size, 0)
})

test('settings reset restores inheritance; conflicting saves retain the draft', async () => {
  const form = fakeForm({ user: { restoreOnRestart: true }, value: { restoreOnRestart: true } })
  const controller = new CodeBridgeSettingsController(form)
  controller.reset('restoreOnRestart')
  assert.equal(controller.getSnapshot().restoreOnRestart.value, false)
  form.publish({ revision: 2 })
  await controller.save()
  assert.equal(controller.getSnapshot().result, 'failed')
  assert.equal(controller.getSnapshot().dirty, true)
  controller.discard()
  controller.reset('restoreOnRestart')
  await controller.save()
  assert.deepEqual(form.mutations[1].ops, [{ op: 'unset', path: ['restoreOnRestart'] }])
  assert.equal(controller.getSnapshot().restoreOnRestart.overridden, false)
  controller.dispose()
})

for (const state of [{ status: 'loading' }, { writable: false }]) {
  test(`settings are not editable when ${JSON.stringify(state)}`, async () => {
    const form = fakeForm(state)
    const controller = new CodeBridgeSettingsController(form)
    controller.edit('restoreOnRestart', true)
    controller.reset('restoreOnRestart')
    await controller.save()
    assert.equal(form.mutations.length, 0)
    controller.dispose()
  })
}

test('retainState false consumes the retained owner and releases it after execution', { timeout: 5000 }, async t => {
  const f = await setup(t)
  let clears = 0
  const lifecycle = new CallLifecycle(f.ctx, async () => { clears++ })
  const context = { agent: f.agent, signal: new AbortController().signal }
  const owners = []
  const call = retained => lifecycle.run(context, retained, async (_signal, _policy, owner) => {
    owners.push(owner)
    assert.equal(f.runtime.released.includes(owner), false)
  })
  await call(true)
  await call(true)
  assert.equal(owners[0], owners[1])
  assert.equal(lifecycle.hasRetainedState(f.agent.session), true)
  await call(false)
  assert.equal(owners[2], owners[0])
  assert.equal(f.runtime.released.includes(owners[0]), true)
  assert.equal(clears, 1)
  assert.equal(lifecycle.hasRetainedState(f.agent.session), false)
  await call(true)
  assert.notEqual(owners[3], owners[0])
  assert.notEqual(owners[3], undefined)
})

test('settings changed before a session first executes still clear its historical checkpoint', { timeout: 5000 }, async t => {
  const f = await setup(t)
  let clears = 0
  const lifecycle = new CallLifecycle(f.ctx, async () => { clears++ })
  f.ctx.emit('loader/volatile-update', [['restoreOnRestart']])
  f.ctx.emit('loader/volatile-update', [['restoreOnRestart']])
  await lifecycle.run({ agent: f.agent, signal: new AbortController().signal }, true, async () => {})
  assert.equal(clears, 1)
})

test('recovery disable/enable between calls still retires previous bindings', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const lifecycle = new CallLifecycle(f.ctx)
  const context = { agent: f.agent, signal: new AbortController().signal }
  const firstOwner = await lifecycle.run(context, true, async (_signal, _policy, owner) => owner)
  f.ctx.emit('loader/volatile-update', [['restoreOnRestart']])
  f.ctx.emit('loader/volatile-update', [['restoreOnRestart']])
  const nextOwner = await lifecycle.run(context, true, async (_signal, _policy, owner) => owner)
  assert.notEqual(firstOwner, nextOwner)
  assert.equal(f.runtime.released.includes(firstOwner), true)
})

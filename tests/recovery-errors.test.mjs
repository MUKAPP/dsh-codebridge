import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallLifecycle } from '../lib/lifecycle.js'
import { createExecuteTool } from '../lib/execute.js'
import { setup, execute, failed } from './fixture.mjs'

async function setupRecovery(t, overrides = {}) {
  const f = await setup(t)
  await f.plugin.dispose()
  const config = { retainSessionState: { get: () => true }, restoreOnRestart: { get: () => true } }
  const clears = []
  const snapshots = {
    prepare: async () => ({ restored: [], omitted: [] }),
    capture: async () => ({ saved: true, omitted: [] }),
    clear: async exec => { clears.push(exec.callId); return { saved: true, omitted: [] } },
    ...overrides,
  }
  await f.ctx.plugin(Object.assign(inner => {
    const lifecycle = new CallLifecycle(inner, config)
    inner.tools.register(createExecuteTool(inner, lifecycle, snapshots, config))
  }, { inject: ['tools', 'sandboxPolicy', 'workingDirectory'] }))
  return { ...f, clears }
}

test('a cancelled user cell invalidates its checkpoint after runtime drainage', { timeout: 5000 }, async t => {
  const f = await setupRecovery(t)
  const started = f.gate(), finish = f.gate()
  let runtimeDrained = false
  f.runtime.behavior = async () => {
    started.resolve()
    await finish.promise
    runtimeDrained = true
    return { logs: [], error: { kind: 'abort', message: 'cancelled' } }
  }
  const controller = new AbortController()
  const pending = execute(f, {}, { signal: controller.signal })
  await started.promise
  controller.abort(new Error('cancel'))
  assert.equal(f.clears.length, 0)
  finish.resolve()
  failed(await pending, /取消/)
  assert.equal(runtimeDrained, true)
  assert.equal(f.clears.length, 1)
})

test('a rejected runtime cannot preserve the previous recovery checkpoint', { timeout: 5000 }, async t => {
  const f = await setupRecovery(t)
  f.runtime.behavior = async () => { throw new Error('worker rejected') }
  failed(await execute(f), /worker rejected/)
  assert.equal(f.clears.length, 1)
  assert.equal(f.runtime.requests.length, 1, 'the user cell must not be retried')
})

test('a cancellation during checkpoint capture is not reported as execution success', { timeout: 5000 }, async t => {
  let entered, release
  const f = await setupRecovery(t, {
    capture: async () => { entered.resolve(); await release.promise; return { saved: false, omitted: [], warning: 'cancelled capture' } },
  })
  entered = f.gate(); release = f.gate()
  f.runtime.behavior = async () => ({ logs: [], value: 17 })
  const controller = new AbortController()
  const pending = execute(f, {}, { signal: controller.signal })
  await entered.promise
  controller.abort(new Error('cancel snapshot'))
  release.resolve()
  failed(await pending, /取消/)
  assert.equal(f.clears.length, 1)
})

test('checkpoint invalidation failure is visible alongside the original execution error', { timeout: 5000 }, async t => {
  const f = await setupRecovery(t, { clear: async () => ({ saved: false, omitted: [], warning: 'could not persist invalidation' }) })
  f.runtime.behavior = async () => { throw new Error('original worker error') }
  failed(await execute(f), /original worker error.*could not persist invalidation/s)
})

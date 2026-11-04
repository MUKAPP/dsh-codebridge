import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'zod'

export const name = 'codebridge-restart-verification'
export const inject = ['tools', 'sessions', 'sessionPersistence', 'sessionProjections', 'settings', 'workingDirectory', 'sandboxPolicy']

export async function apply(ctx) {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (!ready || !exit) throw new Error('Run this probe through the isolated DSH CLI profile')
  // The public projection reader also exposes the constructor's unpublished resume marker.
  const eventProjection = await ctx.sessionProjections.register({
    key: 'codebridgeVerificationEvents', stateVersion: 1, stateSchema: z.array(z.any()),
    init: () => [], apply: (events, event) => [...events, event],
  })
  const phase = process.env.CODEBRIDGE_RESTART_PHASE
  const id = SessionId(process.env.CODEBRIDGE_RESTART_ID)
  const marker = join(process.env.DSH_HOME, id + '.effect-count')
  ctx.tools.register(defineTool({
    name: 'verify_restart_effect', description: 'Count a real external operation for recovery verification.', parameters: {},
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      let previous = 0
      try { previous = Number(await readFile(marker, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await writeFile(marker, String(previous + 1))
      return previous + 1
    },
  }))
  async function run() {
    assert.equal(['seed', 'restore'].includes(phase), true)
    let handle
    let session
    if (phase === 'seed') {
      session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
      handle = await ctx.sessionPersistence.create(session.header)
    } else {
      handle = await ctx.sessionPersistence.open(id, 'write')
      const stored = await handle.read()
      session = ctx.sessions.prepare(id, { seed: stored.events, eventState: stored.eventState, inheritedEventCount: handle.inheritedEventCount, meta: handle.header })
      const resumeEvents = eventProjection.stateOf(session).slice(stored.events.length)
      if (resumeEvents.length > 0) await handle.append(resumeEvents)
      ctx.effect(() => {
        const detach = ctx.sessions.enter(session)
        ctx.sessions.announce(session)
        return detach
      }, 'restart verification restored session')
      assert.equal(session.seq, (await handle.read()).events.length)
    }
    const agent = { id, session, ctx }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    let count = 0
    const execute = async (code, who = agent) => {
      const batch = await ctx.tools.execute({
        calls: [{
          type: 'tool-call', id: ToolCallId(`restart-${phase}-${++count}`), name: 'codebridge_exec',
          arguments: JSON.stringify({ code, description: 'Verify actual restart data recovery', timeoutMs: 10000 }),
        }],
        agent: who, signal: new AbortController().signal,
      })
      const result = batch.results[0].result
      assert.equal(result.isError, false, JSON.stringify(result))
      return result.value
    }
    try {
      session.append('turn/start', { turn: phase === 'seed' ? 1 : 2 })
      if (phase === 'seed') {
        const saved = await execute(`
          const effectCount = await tools.verify_restart_effect({});
          let restartData = { count: effectCount, nested: [1, 2, 3] };
          const { label: restartLabel } = { label: 'retained' };
          function restartFunction() { return 99 }
          ({ effectCount, restartData, restartLabel });
        `)
        assert.equal(saved.snapshot?.saved, true, JSON.stringify(saved.snapshot))
        const updated = await execute('restartData.nested.push(4); restartData.count += 6; restartData')
        assert.equal(updated.snapshot?.saved, true, JSON.stringify(updated.snapshot))
        assert.equal(updated.result.count, 7)
        await writeFile(join(process.env.DSH_HOME, id + '.seed.json'), JSON.stringify({ hostPid: process.pid, id }))
      } else {
        const restored = await execute('({ restartData, restartLabel, effectCount, functionType: typeof restartFunction })')
        assert.deepEqual(restored.result, { restartData: { count: 7, nested: [1, 2, 3, 4] }, restartLabel: 'retained', effectCount: 1, functionType: 'undefined' })
        assert.equal(restored.snapshot?.restored?.includes('restartData'), true)
        assert.equal(restored.snapshot?.saved, true, JSON.stringify(restored.snapshot))
        assert.equal(await readFile(marker, 'utf8'), '1', 'recovery must not rerun the source or external tool')
        const seed = JSON.parse(await readFile(join(process.env.DSH_HOME, id + '.seed.json'), 'utf8'))
        assert.notEqual(seed.hostPid, process.pid, 'seed and restore must run in distinct DSH Host processes')
        const otherSession = ctx.sessions.create(SessionId(id + '-other'), { meta: { cwd: process.cwd() } })
        const otherHandle = await ctx.sessionPersistence.create(otherSession.header)
        const other = { id: otherSession.id, session: otherSession, ctx }
        const otherScope = createScope(ctx, other)
        other.ctx = otherScope.ctx
        try {
          otherSession.append('turn/start', { turn: 1 })
          const isolated = await execute('typeof restartData', other)
          assert.equal(isolated.result, 'undefined')
          otherSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        } finally {
          await otherHandle.close()
          await otherScope.dispose()
        }
        const settings = ctx.settings
        const descriptor = () => settings.describe().find(item => item.ns === 'codebridge')
        assert.equal(descriptor()?.value.retainSessionState, true)
        assert.equal(descriptor()?.value.restoreOnRestart, true)
        await settings.update('codebridge', { retainSessionState: false }, descriptor().revision)
        assert.equal((await execute('typeof restartData')).result, 'undefined')
        await execute('const ephemeralValue = 17; ephemeralValue')
        assert.equal((await execute('typeof ephemeralValue')).result, 'undefined')
        await settings.update('codebridge', { retainSessionState: true, restoreOnRestart: false }, descriptor().revision)
        assert.equal((await execute('typeof restartData')).result, 'undefined')
        assert.equal(descriptor().value.restoreOnRestart, false)
        process.stdout.write(`CODEBRIDGE_RESTART_VERIFIED ${JSON.stringify({ seedHostPid: seed.hostPid, restoredHostPid: process.pid, restoredVariables: restored.snapshot.restored, externalEffectCount: 1, sessionIsolation: true, liveSettings: true })}\n`)
      }
      session.append('turn/end', { turn: phase === 'seed' ? 1 : 2, reason: { kind: 'completed' } })
      assert.equal(await ctx.sessions.flush(session), true)
    } finally {
      await handle.close()
      await scope.dispose()
    }
    if (phase === 'seed') process.stdout.write('CODEBRIDGE_RESTART_SEEDED\n')
  }
  ctx.effect(() => ready.onReady(() => {
    void run().then(() => exit(0), error => { console.error(error); exit(1) })
  }), 'CodeBridge restart verification')
}

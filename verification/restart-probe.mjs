import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'zod'

export const name = 'codebridge-restart-verification'
export const inject = ['tools', 'sessions', 'sessionPersistence', 'sessionProjections', 'systemPrompt', 'settings', 'workingDirectory', 'sandboxPolicy']

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
    assert.equal(['seed', 'restore', 'discarded'].includes(phase), true)
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
    const invoke = async (args, who) => {
      const batch = await ctx.tools.execute({
        calls: [{
          type: 'tool-call', id: ToolCallId(`restart-${phase}-${++count}`), name: 'codebridge_exec',
          arguments: JSON.stringify({ description: 'Verify actual restart data recovery', timeoutMs: 10000, ...args }),
        }],
        agent: who, signal: new AbortController().signal,
      })
      return batch.results[0].result
    }
    const executeChecked = async (args, who = agent) => {
      const result = await invoke(args, who)
      assert.equal(result.isError, false, JSON.stringify(result))
      return result
    }
    const execute = async (code, who = agent, retainState = true) => (await executeChecked({ code, retainState }, who)).value
    try {
      session.append('turn/start', { turn: phase === 'seed' ? 1 : phase === 'restore' ? 2 : 3 })
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
        const temporary = await executeChecked({
          isolated: true,
          code: "const restartData = { count: -1 }; const isolatedOnly = 42; ({ count: restartData.count, fn: typeof restartFunction })",
        })
        assert.deepEqual(temporary.value.result, { count: -1, fn: 'undefined' })
        assert.equal(temporary.value.isolated, true)
        assert.equal(temporary.value.stateRetained, false)
        assert.equal(temporary.value.snapshot, undefined)
        assert.match(temporary.content[0].text, /临时执行环境已释放/)
        const conflicting = await invoke({ code: '1', isolated: true, retainState: true }, agent)
        assert.equal(conflicting.isError, true)
        assert.match(conflicting.error.message, /不能与 retainState: true 同用/)
        const overflow = await invoke({ isolated: true, code: "'x'.repeat(4096)" }, agent)
        assert.equal(overflow.isError, true)
        assert.match(overflow.error.message, /output-limit/)
        const resumed = await execute('({ count: restartData.count, fn: restartFunction(), isolatedOnly: typeof isolatedOnly })')
        assert.deepEqual(resumed.result, { count: 7, fn: 99, isolatedOnly: 'undefined' })
        const retainedState = await ctx.systemPrompt.assemble({ scope: agent, agent })
        assert.match(retainedState.contexts.find(item => item.name === 'codebridge:execution-state').text, /已保留执行环境/)
        await writeFile(join(process.env.DSH_HOME, id + '.seed.json'), JSON.stringify({ hostPid: process.pid, id }))
      } else if (phase === 'restore') {
        const temporary = await executeChecked({ isolated: true, code: "const restartData = { count: -1 }; ({ count: restartData.count, label: typeof restartLabel })" })
        assert.deepEqual(temporary.value.result, { count: -1, label: 'undefined' })
        assert.equal(temporary.value.snapshot, undefined)
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
        assert.equal(Object.hasOwn(descriptor()?.value ?? {}, 'retainSessionState'), false)
        assert.equal(descriptor()?.value.restoreOnRestart, true)
        const consumed = await execute('restartData.count', agent, false)
        assert.equal(consumed.result, 7)
        assert.equal(consumed.stateRetained, false)
        assert.equal(consumed.snapshot?.saved, false)
        assert.equal((await execute('typeof restartData')).result, 'undefined')
        await execute('const ephemeralValue = 17; ephemeralValue', agent, false)
        assert.equal((await execute('typeof ephemeralValue')).result, 'undefined')
        await settings.update('codebridge', { restoreOnRestart: false }, descriptor().revision)
        assert.equal((await execute('typeof restartData')).result, 'undefined')
        assert.equal(descriptor().value.restoreOnRestart, false)
        await settings.update('codebridge', { restoreOnRestart: true }, descriptor().revision)
        assert.equal((await execute('typeof restartData')).result, 'undefined')
        const limited = await execute("const limitedData = 'x'.repeat(4096); console.log('completed limited work'); 1")
        assert.equal(limited.result, 1)
        assert.equal(limited.stateRetained, false)
        assert.equal(limited.snapshot?.saved, false)
        assert.match(limited.snapshot?.warning, /output-limit/)
        assert.equal(limited.logs.some(line => line.includes('completed limited work')), true)
        const state = await ctx.systemPrompt.assemble({ scope: agent, agent })
        assert.match(state.contexts.find(item => item.name === 'codebridge:execution-state').text, /当前没有可续用的执行环境/)
        assert.equal((await execute('typeof limitedData')).result, 'undefined')
        const savedBeforeDiscard = await execute('const discardedData = { value: 29 }; discardedData')
        assert.equal(savedBeforeDiscard.snapshot?.saved, true)
        const discarded = await execute('discardedData.value', agent, false)
        assert.equal(discarded.result, 29)
        assert.equal(discarded.stateRetained, false)
        assert.equal(discarded.snapshot?.saved, false)
        process.stdout.write('CODEBRIDGE_RESTART_VERIFIED ' + JSON.stringify({ seedHostPid: seed.hostPid, restoredHostPid: process.pid, restoredVariables: restored.snapshot.restored, externalEffectCount: 1, sessionIsolation: true, isolatedCallPreservesSharedState: true, liveSettings: true, perCallRelease: true, snapshotOutputLimitInvalidatesState: true }) + '\n')
      } else {
        const discarded = await execute('({ data: typeof restartData, discarded: typeof discardedData })', agent, false)
        assert.deepEqual(discarded.result, { data: 'undefined', discarded: 'undefined' })
        assert.deepEqual(discarded.snapshot?.restored, [])
        assert.equal(await readFile(marker, 'utf8'), '1')
        process.stdout.write('CODEBRIDGE_RESTART_DISCARDED ' + JSON.stringify({ hostPid: process.pid, releasedDataAbsentAfterRestart: true, externalEffectCount: 1 }) + '\n')
      }
      session.append('turn/end', { turn: phase === 'seed' ? 1 : phase === 'restore' ? 2 : 3, reason: { kind: 'completed' } })
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

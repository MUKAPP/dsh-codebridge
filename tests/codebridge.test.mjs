import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as checkpoint } from 'node:timers/promises'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setup, invoke, execute, register, functions, text, ok, failed } from './fixture.mjs'

test('native tools remain directly callable; bindings return canonical JSON instead of rendered text', { timeout: 5000 }, async t => {
  const f = await setup(t)
  register(f, 'record', {
    output: { schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'integer', required: true } } }, render: () => [{ type: 'text', text: 'human-readable record' }] },
    execute: async () => ({ count: 7 }),
  })
  const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  assert.deepEqual(assembly.tools.map(item => item.name).sort(), ['codebridge_exec', 'codebridge_tools', 'record'])
  assert.equal(assembly.sections.some(section => section.name === 'tools:sdk'), false)
  const direct = await invoke(f, 'record', { value: 'direct' })
  assert.deepEqual(ok(direct), { count: 7 })
  assert.equal(text(direct), 'human-readable record')
  f.runtime.behavior = async request => {
    assert.deepEqual(request.bindings[0].errorClass, { name: 'ToolCallError', memberNameProperty: 'toolName' })
    assert.deepEqual(Object.keys(functions(request)), ['record'])
    return { logs: ['captured'], value: await functions(request).record({ value: 'nested' }) }
  }
  const code = 'return await tools.record({ value: "nested" })'
  assert.deepEqual(ok(await execute(f, { code, timeoutMs: 75 })), { logs: ['captured'], result: { count: 7 } })
  const request = f.runtime.requests[0]
  assert.equal(request.program, code)
  assert.equal(request.cwd, f.agent.session.header.cwd)
  assert.deepEqual(request.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: f.agent.session.header.cwd })
  assert.equal(request.timeoutMs, 75)
  assert.equal(f.ensured[0].agent, f.agent)
})

test('nested business failure is catchable without poisoning later calls; failure is logged', { timeout: 5000 }, async t => {
  const f = await setup(t)
  register(f, 'broken', { execute: async () => { throw new Error('business refused') } })
  register(f)
  f.runtime.behavior = async request => {
    await assert.rejects(functions(request).broken({ value: 'x' }), /business refused/)
    await assert.rejects(functions(request).echo({ value: 'lossy', dropped: undefined }), /无损 JSON/)
    return { logs: [], value: await functions(request).echo({ value: 'recovered' }) }
  }
  assert.equal(ok(await execute(f)).result, 'recovered')
  const events = f.events.filter(event => event.type === 'tool/ptc-dispatch')
  assert.deepEqual(events.map(event => [event.data.name, event.data.isError]), [['broken', true], ['echo', false]])
  assert.match(events[0].data.content[0].text, /business refused/)
})

test('query deduplicates visible names and excludes hidden/missing/recursive tools', { timeout: 5000 }, async t => {
  const f = await setup(t)
  register(f)
  register(f, 'hidden')
  f.scope.ctx.tools.restrict({ deny: ['hidden'] })
  const value = ok(await invoke(f, 'codebridge_tools', { names: ['echo', 'hidden', 'missing', 'codebridge_exec', 'codebridge_tools', 'run_code', 'echo'] }))
  assert.equal(value.tools.length, 1)
  assert.equal(value.tools[0].name, 'echo')
  assert.equal(value.tools[0].parameters.properties.value.type, 'string')
  assert.deepEqual(value.tools[0].output, { type: 'string' })
  assert.deepEqual(value.unavailable, ['hidden', 'missing', 'codebridge_exec', 'codebridge_tools', 'run_code'])
  f.runtime.behavior = async request => { assert.deepEqual(Object.keys(functions(request)), ['echo']); return { logs: [] } }
  ok(await execute(f))
})

test('subcalls and durable logs are serial; root/parent/call IDs and argument snapshots stay associated', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const firstBody = f.gate(), releaseFirst = f.gate(), firstLog = f.gate(), releaseLog = f.gate()
  const seen = [], identities = []
  register(f, 'echo', {
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      seen.push(args.value); identities.push(exec)
      if (args.value === 'first') { firstBody.resolve(); await releaseFirst.promise }
      return args.value
    },
  })
  let outer
  f.ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === 'codebridge_exec') outer = exec; return next() })
  f.ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    if (dispatch.subCallId.endsWith(':1')) { firstLog.resolve(); await releaseLog.promise }
    return next()
  })
  f.runtime.behavior = async request => {
    const second = { value: 'second' }
    const calls = [functions(request).echo({ value: 'first' }), functions(request).echo(second)]
    second.value = 'mutated after enqueue'
    return { logs: [], value: await Promise.all(calls) }
  }
  const pending = execute(f, {}, { callId: 'outer-call', rootCallId: 'root-call' })
  await firstBody.promise
  assert.deepEqual(seen, ['first'])
  releaseFirst.resolve()
  await firstLog.promise
  await checkpoint()
  assert.deepEqual(seen, ['first'], 'next body must wait for previous durable log')
  releaseLog.resolve()
  assert.deepEqual(ok(await pending).result, ['first', 'second'])
  assert.deepEqual(identities.map(exec => exec.callId), ['outer-call:ptc:1', 'outer-call:ptc:2'])
  for (const exec of identities) { assert.equal(exec.parent, outer.token); assert.equal(exec.rootCallId, 'root-call'); assert.equal(exec.agent, f.agent) }
  const events = f.events.filter(event => event.type.startsWith('tool/ptc-dispatch'))
  assert.deepEqual(events.map(event => event.type), ['tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
  assert.deepEqual(events.map(event => event.data.subCallId), ['outer-call:ptc:1', 'outer-call:ptc:1', 'outer-call:ptc:2', 'outer-call:ptc:2'])
  for (const event of events) { assert.equal(event.data.parentCallId, 'outer-call'); assert.equal(event.data.rootCallId, 'root-call') }
  assert.deepEqual(events[2].data.arguments, { value: 'second' })
})

test('nested image, additional context and concludesTurn are deferred to outer result', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
  f.ctx.tools.register(defineContentToolFixture({ name: 'picture', description: 'Fixture picture', parameters: {}, execute: async (_args, exec) => { exec.concludeTurn(); return [image] } }))
  const extra = createUserMessage({ content: [{ type: 'text', text: 'deferred note' }], source: { kind: 'ptc-mode' } })
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'picture' ? { kind: 'accept', additionalContexts: [extra] } : next())
  f.runtime.behavior = async request => { await functions(request).picture({}); return { logs: [], value: 'done' } }
  const result = await execute(f)
  ok(result)
  assert.equal(result.concludesTurn, true)
  assert.equal(result.additionalContexts.length, 2)
  assert.deepEqual(result.additionalContexts[0].content, [image])
  assert.equal(result.additionalContexts[0].source.kind, 'ptc-mode')
  assert.deepEqual(result.additionalContexts[1], extra)
})

test('post-execute rejection removes nested images and terminal conclusion', { timeout: 5000 }, async t => {
  const f = await setup(t)
  f.ctx.tools.register(defineContentToolFixture({
    name: 'picture', description: 'Fixture picture', parameters: {},
    execute: async (_args, exec) => { exec.concludeTurn(); return [{ type: 'image', attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] },
  }))
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'picture' ? { kind: 'block', feedback: [{ type: 'text', text: 'image denied' }] } : next())
  f.runtime.behavior = async request => { await assert.rejects(functions(request).picture({}), /image denied/); return { logs: [], value: 'recovered' } }
  const result = await execute(f)
  ok(result)
  assert.equal(result.concludesTurn, undefined)
  assert.equal(result.additionalContexts?.length ?? 0, 0)
})

// Timeout is a provider outcome injected through the seam, not a wall-clock sleep.
for (const outcome of ['cancel', 'early return', 'timeout']) {
  test(`${outcome} aborts active subcall, abandons queue and drains body plus log before settlement`, { timeout: 5000 }, async t => {
    const f = await setup(t)
    const started = f.gate(), aborted = f.gate(), releaseBody = f.gate(), runtimeFinish = f.gate(), logEntered = f.gate(), releaseLog = f.gate()
    const seen = []
    let bindingCalls
    register(f, 'slow', {
      isConcurrencySafe: () => true,
      execute: async (args, exec) => { seen.push(args.value); exec.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); started.resolve(); await releaseBody.promise; return args.value },
    })
    f.ctx.on('tools/ptc-dispatch-log', async (_dispatch, next) => { logEntered.resolve(); await releaseLog.promise; return next() })
    f.runtime.behavior = async request => {
      bindingCalls = Promise.allSettled([functions(request).slow({ value: 'first' }), functions(request).slow({ value: 'queued' })])
      await runtimeFinish.promise
      return outcome === 'early return' ? { logs: [], value: 'returned' } : { logs: ['before stop'], error: { kind: outcome === 'timeout' ? 'timeout' : 'abort', message: 'controlled stop' } }
    }
    const controller = new AbortController()
    let settled = false
    const pending = execute(f, { timeoutMs: 75 }, { signal: controller.signal }).then(result => { settled = true; return result })
    await started.promise
    if (outcome === 'cancel') controller.abort(new Error('user cancel'))
    runtimeFinish.resolve()
    await aborted.promise
    await checkpoint()
    assert.equal(settled, false, 'must await a non-cooperative in-flight body')
    assert.deepEqual(seen, ['first'])
    releaseBody.resolve()
    await logEntered.promise
    await checkpoint()
    assert.equal(settled, false, 'must await durable logging too')
    releaseLog.resolve()
    const result = await pending
    if (outcome === 'early return') assert.equal(ok(result).result, 'returned')
    else failed(result, outcome === 'timeout' ? /timeout/ : undefined)
    await bindingCalls
    assert.deepEqual(seen, ['first'])
    assert.equal(f.events.filter(event => event.type === 'tool/ptc-dispatch').length, 1)
    assert.equal(f.runtime.requests[0].signal.aborted, true)
  })
}

test('permission changes cancel matching sessions; replacement waits for drainage, other agents proceed', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const other = await f.mintAgent('agent-b')
  const started = f.gate(), aborted = f.gate(), release = f.gate()
  register(f, 'slow', { execute: async (_args, exec) => { exec.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); started.resolve(); await release.promise; return 'old finished' } })
  let calls = 0
  f.runtime.behavior = async request => {
    if (++calls === 1) {
      const child = functions(request).slow({ value: 'old' }).catch(() => undefined)
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
      await child
      return { logs: [], error: { kind: 'abort', message: 'policy changed' } }
    }
    return { logs: [], value: request.cwd }
  }
  const old = execute(f)
  await started.promise
  f.changeMode(other.agent, 'read-only')
  assert.equal(f.runtime.requests[0].signal.aborted, false)
  f.changeMode(f.agent, 'read-only')
  await aborted.promise
  const replacement = execute(f)
  assert.equal(ok(await execute(f, {}, { agent: other.agent })).result, other.agent.session.header.cwd)
  await checkpoint()
  assert.equal(calls, 2, 'same-session replacement cannot enter runtime before old resources drain')
  release.resolve()
  failed(await old)
  assert.equal(ok(await replacement).result, f.agent.session.header.cwd)
  assert.equal(calls, 3)
  assert.equal(f.runtime.requests[2].sandboxPolicy.mode, 'read-only')
})

test('unload aborts and awaits active calls, unregisters plugin tools and preserves native tools', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const started = f.gate(), aborted = f.gate(), release = f.gate()
  register(f)
  register(f, 'slow', { execute: async (_args, exec) => { exec.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); started.resolve(); await release.promise; return 'drained' } })
  f.runtime.behavior = async request => { await functions(request).slow({ value: 'x' }).catch(() => undefined); return { logs: [] } }
  const pending = execute(f)
  await started.promise
  let disposed = false
  const disposal = f.plugin.dispose().then(() => { disposed = true })
  await aborted.promise
  await checkpoint()
  assert.equal(disposed, false)
  release.resolve()
  failed(await pending)
  await disposal
  assert.equal(f.ctx.tools.get('codebridge_exec', f.agent), undefined)
  assert.equal(f.ctx.tools.get('codebridge_tools', f.agent), undefined)
  assert.equal(ok(await invoke(f, 'echo', { value: 'still native' })), 'still native')
})

test('agent-scoped tools, restrictions, directories and dispatch events remain isolated', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const other = await f.mintAgent('agent-b')
  register(f, 'only_a', {}, f.scope.ctx)
  register(f, 'only_b', {}, other.scope.ctx)
  register(f, 'shared')
  f.scope.ctx.tools.restrict({ deny: ['shared'] })
  const a = ok(await invoke(f, 'codebridge_tools', { names: ['only_a', 'only_b', 'shared'] }))
  const b = ok(await invoke(f, 'codebridge_tools', { names: ['only_a', 'only_b', 'shared'] }, { agent: other.agent }))
  assert.deepEqual(a.tools.map(tool => tool.name), ['only_a'])
  assert.deepEqual(b.tools.map(tool => tool.name), ['only_b', 'shared'])
  f.runtime.behavior = async request => {
    const expected = request.cwd === f.agent.session.header.cwd ? 'only_a' : 'only_b'
    assert.equal(functions(request)[expected === 'only_a' ? 'only_b' : 'only_a'], undefined)
    return { logs: [], value: await functions(request)[expected]({ value: expected }) }
  }
  assert.equal(ok(await execute(f)).result, 'only_a')
  assert.equal(ok(await execute(f, {}, { agent: other.agent })).result, 'only_b')
  assert.deepEqual(f.events.filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.name), ['only_a'])
  assert.deepEqual(other.events.filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.name), ['only_b'])
})

test('missing runtime leaves query available and execution fails actionably', { timeout: 5000 }, async t => {
  const f = await setup(t, { runtime: false })
  register(f)
  assert.equal(ok(await invoke(f, 'codebridge_tools', { names: ['echo'] })).tools[0].name, 'echo')
  failed(await execute(f), /PTC.*运行时.*@deepseek-ai\/dsh-ptc-runtime-node/)
})

test('invalid arguments fail before runtime execution', { timeout: 5000 }, async t => {
  const f = await setup(t)
  for (const args of [{ code: '' }, { code: '  ' }, { description: '' }, { description: '  ' }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Infinity }, { code: 1 }]) failed(await execute(f, args))
  for (const names of [[], [''], ['  '], [1], 'echo']) failed(await invoke(f, 'codebridge_tools', { names }))
  failed(await execute(f, {}, { agent: undefined }), /代理会话/)
  assert.equal(f.runtime.requests.length, 0)
})

test('unsupported language, timeout override and unenforceable sandbox fail clearly', { timeout: 5000 }, async t => {
  for (const [options, args, pattern] of [
    [{ runtime: { language: 'python' } }, {}, /Node TypeScript/],
    [{ runtime: { timeout: false } }, { timeoutMs: 10 }, /不支持 timeoutMs/],
    [{ runtime: { sandbox: false } }, {}, /无法实施.*workspace-write/],
  ]) await t.test(pattern.source, async subtest => { const f = await setup(subtest, options); failed(await execute(f, args), pattern); assert.equal(f.runtime.requests.length, 0) })
  await t.test('unconfined provider permitted in danger-full-access', async subtest => {
    const f = await setup(subtest, { runtime: { sandbox: false }, mode: 'danger-full-access' })
    ok(await execute(f))
    assert.equal(f.runtime.lastRequest.sandboxPolicy, undefined)
  })
})

test('runtime errors retain failure kind, message, logs and sandbox diagnostics', { timeout: 5000 }, async t => {
  const f = await setup(t)
  f.runtime.behavior = async () => ({ logs: ['before failure', 'second log'], error: { kind: 'worker-exit', message: 'worker unavailable' }, sandbox: { mode: 'workspace-write', denied: true, enforcement: 'partial' } })
  const result = failed(await execute(f), /worker-exit.*worker unavailable/s)
  assert.equal(result.error.info.code, 'CODEBRIDGE_EXEC_FAILED')
  assert.match(result.error.message, /before failure.*second log/s)
  assert.match(result.error.message, /workspace-write.*拒绝.*部分实施/s)
})

test('failed durable append cannot be hidden by catching binding rejection', { timeout: 5000 }, async t => {
  const f = await setup(t)
  register(f)
  const append = f.agent.session.append
  f.agent.session.append = (type, data) => { if (type === 'tool/ptc-dispatch') throw new Error('durable append failed'); return append(type, data) }
  f.runtime.behavior = async request => { await functions(request).echo({ value: 'x' }).catch(() => undefined); return { logs: [], value: 'not success' } }
  failed(await execute(f), /durable append failed/)
})

test('log transformation failure keeps original content and canonical binding value', { timeout: 5000 }, async t => {
  const f = await setup(t)
  register(f)
  f.ctx.on('tools/ptc-dispatch-log', () => { throw new Error('log transform failed') })
  f.runtime.behavior = async request => ({ logs: [], value: await functions(request).echo({ value: 'original' }) })
  assert.equal(ok(await execute(f)).result, 'original')
  assert.deepEqual(f.events.find(event => event.type === 'tool/ptc-dispatch').data.content, [{ type: 'text', text: 'display:original' }])
})

test('permission revocation while resolving cwd prevents runtime startup and waits for directory work', { timeout: 5000 }, async t => {
  let entered, release
  const f = await setup(t, { ensure: async agent => { entered.resolve(); await release.promise; return agent.session.header.cwd } })
  entered = f.gate()
  release = f.gate()
  let settled = false
  const pending = execute(f).then(result => { settled = true; return result })
  await entered.promise
  f.changeMode(f.agent, 'read-only')
  await checkpoint()
  assert.equal(settled, false)
  assert.equal(f.ensured[0].signal.aborted, true)
  assert.equal(f.runtime.requests.length, 0)
  release.resolve()
  failed(await pending)
  assert.equal(f.runtime.requests.length, 0)
})

test('captured bindings cannot bypass a later agent tool restriction', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const seen = []
  register(f, 'echo', { execute: async args => { seen.push(args.value); return args.value } })
  f.runtime.behavior = async request => {
    assert.equal(typeof functions(request).echo, 'function')
    const lift = f.scope.ctx.tools.restrict({ deny: ['echo'] })
    try { await assert.rejects(functions(request).echo({ value: 'denied' })) } finally { lift() }
    return { logs: [], value: await functions(request).echo({ value: 'restored' }) }
  }
  assert.equal(ok(await execute(f)).result, 'restored')
  assert.deepEqual(seen, ['restored'])
})

test('provider contract rejection is a tool failure rather than an escaped rejection', { timeout: 5000 }, async t => {
  const f = await setup(t)
  f.runtime.resolve = () => { throw new Error('resolve rejected request') }
  failed(await execute(f), /resolve rejected request/)
  assert.equal(f.runtime.requests.length, 0)
  f.runtime.resolve = request => ({ ...request, timeoutMs: 120_000 })
  f.runtime.behavior = async () => { throw new Error('provider contract violation') }
  failed(await execute(f), /provider contract violation/)
})

test('renderer accepts deeply nested JSON and preserves mixed JSON escaping and empty containers', { timeout: 5000 }, async t => {
  const f = await setup(t)
  let value = 0
  for (let i = 0; i < 10_000; i++) value = [value]
  f.runtime.behavior = async () => ({ logs: [], value })
  const deep = await execute(f)
  ok(deep)
  assert.equal(text(deep), `${'['.repeat(10_000)}0${']'.repeat(10_000)}`)
  const mixed = { quote: '"\\\n\t', empty: [], object: {}, values: [null, true, false, -1.5, { nested: '中文' }] }
  f.runtime.behavior = async () => ({ logs: [], value: mixed })
  const result = await execute(f)
  assert.deepEqual(ok(result).result, mixed)
  assert.equal(text(result), JSON.stringify(mixed))
})

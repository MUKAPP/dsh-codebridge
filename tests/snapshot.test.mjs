import assert from 'node:assert/strict'
import { start } from 'node:repl'
import { PassThrough } from 'node:stream'
import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import {
  SNAPSHOT_MAX_BYTES, collectSnapshotVariables, collectUnsupportedSnapshotNames, createSnapshotCodec,
  isSnapshotIdentifier, snapshotBootstrapProgram, snapshotCaptureProgram, snapshotProbeProgram, snapshotRestoreProgram,
} from '../lib/snapshot-program.js'
import { parseSnapshotRecord } from '../lib/state.js'

const codec = () => createSnapshotCodec(types.isProxy, Buffer.byteLength)
const read = (name, value, kind = 'const') => [name, kind, () => value]
const plain = value => JSON.parse(JSON.stringify(value))

function replHarness(t) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const server = start({ input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true })
  t.after(() => { server.close(); input.destroy(); output.destroy() })
  return {
    context: server.context,
    evaluate: source => new Promise((resolve, reject) => {
      server.eval(`${source}\n`, server.context, 'snapshot-test', (error, value) => error ? reject(error) : resolve(value))
    }),
  }
}

const marker = '__codebridge_snapshot_0123456789abcdef'
const binding = 'codebridge_snapshot_0123456789abcdef'

function record(entries = [{ name: 'data', kind: 'const', json: '{"ok":true}' }]) {
  return {
    version: 1, sessionId: 'session-a',
    policy: { mode: 'workspace-write', workspaceRoot: 'D:/workspace' }, entries, omitted: [],
  }
}

test('AST only collects actual top-level variable declarations, including nested destructuring', () => {
  const variables = collectSnapshotVariables(`
    const first = 1, second = 2;
    let { a: renamed, b: { c }, ...rest } = source;
    var [head, , [deep], ...tail] = list;
    if (true) { const inside = 1; var nestedVar = 2; }
    for (let index = 0; index < 1; index++) {}
    function fn() { const local = 1; }
    class Example { field = 1; }
    namespace Space { export const child = 1; }
    declare const ambient: string;
    using handle = resource;
  `)
  assert.deepEqual(variables, [
    { name: 'first', kind: 'const' }, { name: 'second', kind: 'const' },
    { name: 'renamed', kind: 'let' }, { name: 'c', kind: 'let' }, { name: 'rest', kind: 'let' },
    { name: 'head', kind: 'var' }, { name: 'deep', kind: 'var' }, { name: 'tail', kind: 'var' },
  ])
})

test('contextual and Unicode identifiers are accepted, source fragments and reserved names are not', () => {
  for (const name of ['async', 'from', 'of', 'get', 'set', 'type', '数据', '$value', '_value']) assert.equal(isSnapshotIdentifier(name), true, name)
  for (const name of ['x; sideEffect()', 'x = 1', 'x/*comment*/', 'x.y', 'const', 'await', 'yield', 'eval', '__codebridge_snapshot_deadbeef']) assert.equal(isSnapshotIdentifier(name), false, name)
  assert.deepEqual(collectSnapshotVariables('const async = 1; let from = 2; var of = 3;'), [
    { name: 'async', kind: 'const' }, { name: 'from', kind: 'let' }, { name: 'of', kind: 'var' },
  ])
  assert.throws(() => snapshotRestoreProgram(marker, [{ name: 'x;danger()', kind: 'const' }]))
  assert.throws(() => snapshotCaptureProgram(marker, [{ name: 'x', kind: 'function' }]))
  assert.throws(() => snapshotProbeProgram('x;danger()'))
})

test('function/class/import bindings are reported without collecting their source', () => {
  assert.deepEqual(collectUnsupportedSnapshotNames(`
    import main, { readFile as read, type Stats } from 'node:fs';
    import * as path from 'node:path';
    import type { TypeOnly } from 'types';
    function helper() { throw new Error('not replayed'); }
    class Widget {}
    enum Mode { A }
    const data = 1;
  `), ['main', 'read', 'path', 'helper', 'Widget', 'Mode'])
})

test('serializer rejects getters/toJSON/proxies before invoking user code', () => {
  let calls = 0
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; return 1 } })
  const toJSON = { toJSON() { calls++; return { unsafe: true } } }
  const proxy = new Proxy({}, {
    getPrototypeOf() { calls++; throw new Error('trap') },
    ownKeys() { calls++; throw new Error('trap') },
    getOwnPropertyDescriptor() { calls++; throw new Error('trap') },
    get() { calls++; throw new Error('trap') },
  })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const output = codec().capture([read('getter', getter), read('toJSON', toJSON), read('proxy', proxy), read('revoked', revoked.proxy), read('safe', { a: [true, null, 'text'] })], SNAPSHOT_MAX_BYTES)
  assert.equal(calls, 0)
  assert.deepEqual(output.omitted, ['getter', 'toJSON', 'proxy', 'revoked'])
  assert.deepEqual(output.entries, [{ name: 'safe', kind: 'const', json: '{"a":[true,null,"text"]}' }])
})

test('snapshot work arrays never invoke inherited getters or setters', () => {
  const output = runInNewContext(`
    const instance = (${createSnapshotCodec.toString()})(isProxy, byteLength);
    let reads = 0, writes = 0;
    const define = Object.defineProperty;
    define(Array.prototype, '0', {
      configurable: true,
      get() { reads++; return false },
      set(value) { writes++; define(this, '0', { value, writable: true, enumerable: true, configurable: true }) },
    });
    const result = instance.capture([['data', 'const', () => ({ nested: [1, true] })]], 1024);
    delete Array.prototype['0'];
    ({ result, reads, writes });
  `, { isProxy: types.isProxy, byteLength: Buffer.byteLength });
  assert.equal(output.reads, 0);
  assert.equal(output.writes, 0);
  assert.equal(output.result.entries[0].json, '{"nested":[1,true]}');
});

test('serializer rejects non-data values and lossy object/array shapes', () => {
  const sparse = []; sparse.length = 1
  const symbol = { [Symbol('hidden')]: 1 }
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 })
  const extra = [1]; extra.extra = 2
  const values = [undefined, () => 1, new Date(), new Map(), Promise.resolve(1), 1n, NaN, Infinity, -0, sparse, symbol, hidden, extra, Object.create(null)]
  const output = codec().capture(values.map((value, index) => read(`value${index}`, value)), SNAPSHOT_MAX_BYTES)
  assert.deepEqual(output.entries, [])
  assert.equal(output.omitted.length, values.length)
  assert.equal(output.overflow, false)
})

test('cycles and shared references, including across bindings, are omitted explicitly', () => {
  const shared = { value: 1 }
  const cycle = {}; cycle.self = cycle
  const output = codec().capture([read('first', shared), read('second', { nested: shared }), read('cycle', cycle), read('innerAlias', { a: {}, b: null }), read('safe', 4)], SNAPSHOT_MAX_BYTES)
  assert.deepEqual(output.omitted, ['first', 'second', 'cycle'])
  assert.deepEqual(output.entries.map(entry => entry.name), ['innerAlias', 'safe'])
  const same = {}; assert.deepEqual(codec().capture([read('alias', { a: same, b: same })], SNAPSHOT_MAX_BYTES).omitted, ['alias'])
})

test('captured intrinsics survive replacement of Object/JSON/Reflect/WeakMap globals', () => {
  const instance = codec()
  const originals = { Object: globalThis.Object, JSON: globalThis.JSON, Reflect: globalThis.Reflect, WeakMap: globalThis.WeakMap }
  const readers = [read('data', { nested: [1, 'ok'] })]
  let output
  try {
    globalThis.Object = undefined; globalThis.JSON = undefined; globalThis.Reflect = undefined; globalThis.WeakMap = undefined
    output = instance.capture(readers, SNAPSHOT_MAX_BYTES)
  } finally {
    globalThis.Object = originals.Object; globalThis.JSON = originals.JSON; globalThis.Reflect = originals.Reflect; globalThis.WeakMap = originals.WeakMap
  }
  assert.equal(output.entries[0].json, '{"nested":[1,"ok"]}')
})

test('deep JSON uses an iterative encoder and aggregate overflow clears all entries', () => {
  let deep = 1
  for (let index = 0; index < 12000; index++) deep = [deep]
  const output = codec().capture([read('deep', deep)], SNAPSHOT_MAX_BYTES)
  assert.equal(output.omitted.length, 0)
  assert.equal(output.entries[0].json.length, 24001)
  const limited = codec().capture([read('first', '1234567890'), read('second', '1234567890')], 20)
  assert.equal(limited.overflow, true)
  assert.deepEqual(limited.entries, [])
  assert.deepEqual(limited.omitted, ['first', 'second'])
})

test('bootstrap/restore installs only bound JSON data, keeps declaration kinds and never replays source', async t => {
  const harness = replHarness(t)
  const payload = 'globalThis.executed = true; throw new Error("do not run")'
  const entries = [
    { name: 'constant', kind: 'const', json: JSON.stringify({ text: payload }) },
    { name: 'mutable', kind: 'let', json: '2' },
    { name: 'legacy', kind: 'var', json: '3' },
  ]
  harness.context[binding] = { load: async args => { assert.deepEqual(plain(args), {}); return entries.map(entry => entry.json) } }
  const bootstrap = snapshotBootstrapProgram(marker, binding)
  const restore = snapshotRestoreProgram(marker, entries)
  assert.equal(bootstrap.includes(payload), false)
  assert.equal(restore.includes(payload), false)
  assert.equal(await harness.evaluate(snapshotProbeProgram(marker)), false)
  await harness.evaluate(bootstrap)
  await harness.evaluate(restore)
  assert.equal(await harness.evaluate(snapshotProbeProgram(marker)), true)
  assert.equal(await harness.evaluate('typeof executed'), 'undefined')
  assert.equal(await harness.evaluate('constant.text'), payload)
  assert.equal(await harness.evaluate('(() => { try { constant = 1; return false; } catch { return true; } })()'), true)
  assert.deepEqual(plain(await harness.evaluate('mutable += 1; legacy += 1; [mutable, legacy]')), [3, 4])
})

test('restore supports names shadowing built-ins, and subsequent captures read mutations', async t => {
  const harness = replHarness(t)
  const entries = [
    { name: 'Object', kind: 'const', json: '{"count":1}' },
    { name: 'JSON', kind: 'let', json: '2' },
    { name: 'WeakMap', kind: 'var', json: '3' },
    { name: 'async', kind: 'const', json: '4' },
  ]
  harness.context[binding] = { load: async args => { assert.deepEqual(plain(args), {}); return entries.map(entry => entry.json) } }
  await harness.evaluate(snapshotBootstrapProgram(marker, binding))
  await harness.evaluate(snapshotRestoreProgram(marker, entries))
  await harness.evaluate('Object.count += 1; JSON = 8; void 0')
  const captured = plain(await harness.evaluate(snapshotCaptureProgram(marker, entries)))
  assert.deepEqual(captured.entries.map(entry => entry.json), ['{"count":2}', '8', '3', '4'])
  await harness.evaluate('JSON = () => 9; void 0')
  const changed = plain(await harness.evaluate(snapshotCaptureProgram(marker, entries)))
  assert.deepEqual(changed.omitted, ['JSON'])
  assert.equal(changed.entries.some(entry => entry.name === 'JSON'), false)
})

test('stored records reject bad versions, injected names, malformed/lossy JSON and duplicates', () => {
  assert.deepEqual(parseSnapshotRecord(record()), record())
  const hostName = record([{ name: 'process', kind: 'var', json: '{"data":1}' }])
  assert.deepEqual(parseSnapshotRecord(hostName), hostName)
  assert.equal(parseSnapshotRecord({ ...record(), version: 2 }), undefined)
  assert.equal(parseSnapshotRecord({ ...record(), extra: true }), undefined)
  for (const entry of [
    { name: 'x;globalThis.executed=true', kind: 'const', json: '1' },
    { name: 'x', kind: 'function', json: '1' },
    { name: 'x', kind: 'let', json: 'globalThis.executed=true' },
    { name: 'x', kind: 'const', json: '-0' },
    { name: 'x', kind: 'const', json: '1e999' },
    { name: 'x', kind: 'const', json: '{"toJSON":1}' },
  ]) assert.equal(parseSnapshotRecord(record([entry])), undefined)
  assert.equal(parseSnapshotRecord(record([{ name: 'same', kind: 'var', json: '1' }, { name: 'same', kind: 'let', json: '2' }])), undefined)
  assert.equal(parseSnapshotRecord({ ...record(), omitted: ['data'] }), undefined)
  assert.equal(parseSnapshotRecord(record([{ name: 'big', kind: 'const', json: JSON.stringify('x'.repeat(SNAPSHOT_MAX_BYTES)) }])), undefined)
  assert.equal(globalThis.executed, undefined)
})

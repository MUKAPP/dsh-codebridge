import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'codebridge-verification'
export const inject = ['tools', 'sessions', 'ptcRuntime', 'workingDirectory', 'sandboxPolicy']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (!ready || !exit) throw new Error('Verification must run through the dsh profile launcher')
  const events = []
  ctx.on('session/event', (_session, event) => { events.push(event) }, { global: true })
  ctx.tools.register(defineTool({
    name: 'verify_double', description: 'Double a number in the verification host.',
    parameters: { value: { type: 'number', required: true } },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: `Rendered: ${value}` }] },
    async execute({ value }) { return value * 2 },
  }))
  ctx.tools.register(defineTool({
    name: 'verify_denied', description: 'Must be denied by the verification guard.', parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { throw new Error('guard did not run') },
  }))
  ctx.tools.guard(exec => exec.name === 'verify_denied' ? 'verification policy denial' : undefined)

  const run = async () => {
    assert(ctx.tools.get('codebridge_exec'), 'CodeBridge bundle did not activate')
    const session = ctx.sessions.create(SessionId('codebridge-verification'), { meta: { cwd: process.cwd() } })
    const agent = { id: session.id, session, ctx }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    let call = 0
    const invoke = (name, args) => ctx.tools.execute({
      callId: ToolCallId(`verify-${++call}`), name, arguments: args,
      agent, signal: new AbortController().signal,
    })
    const exec = (code, timeoutMs) => invoke('codebridge_exec', {
      description: 'CodeBridge independent profile verification', code,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
    try {
      const catalog = await invoke('codebridge_tools', { names: ['verify_double', 'codebridge_exec', 'not_registered'] })
      assert.equal(catalog.isError, false, JSON.stringify(catalog))
      assert.equal(catalog.value.tools[0].output.type, 'number')
      assert.deepEqual(catalog.value.unavailable, ['codebridge_exec', 'not_registered'])
      const direct = await invoke('verify_double', { value: 2 })
      assert.equal(direct.value, 4)

      const first = await exec(`
        const doubled: number = await tools.verify_double({ value: 21 });
        let failure;
        try { await tools.verify_denied({}); }
        catch (error) { failure = { typed: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message }; }
        console.log('codebridge-smoke', doubled);
        return { doubled, failure, pid: process.pid, cwd: process.cwd(), recursive: Object.keys(tools).some(name => ['codebridge_exec', 'codebridge_tools', 'run_code'].includes(name)) };
      `)
      assert.equal(first.isError, false, JSON.stringify(first))
      assert.equal(first.value.result.doubled, 42)
      assert.notEqual(first.value.result.pid, process.pid)
      assert.equal(first.value.result.cwd, process.cwd())
      assert.equal(first.value.result.recursive, false)
      assert.deepEqual(first.value.result.failure, {
        typed: true, name: 'ToolCallError', toolName: 'verify_denied', message: 'verification policy denial',
      })
      assert(first.value.logs.some(line => line.includes('codebridge-smoke 42')))
      const starts = events.filter(event => event.type === 'tool/ptc-dispatch-start')
      const ends = events.filter(event => event.type === 'tool/ptc-dispatch')
      assert.equal(starts.length, 2)
      assert.equal(ends.length, 2)
      assert.deepEqual(starts.map(event => event.data.subCallId), ends.map(event => event.data.subCallId))
      assert(ends[1].data.isError)

      const deep = await exec('let value = 0; for (let i = 0; i < 10000; i++) value = [value]; return value;')
      assert.equal(deep.isError, false, deep.error?.message)
      assert.equal(deep.content[0].text, '['.repeat(10000) + '0' + ']'.repeat(10000))
      const timeout = await exec('while (true) {}', 1500)
      assert.equal(timeout.isError, true)
      assert.match(timeout.error.message, /timeout/)
      assert.equal((await exec('return 7')).value.result, 7)
      assert.equal((await exec('globalThis.codebridgeMemory = 1; return true')).value.result, true)
      assert.equal((await exec('return typeof globalThis.codebridgeMemory')).value.result, 'undefined')

      setSandboxMode(session, 'read-only')
      const confined = await exec(`
        const fs = await import('node:fs/promises');
        try { await fs.writeFile('codebridge-denied.txt', 'must not be written'); return { denied: false }; }
        catch (error) { return { denied: true, code: error.code }; }
      `)
      assert.equal(confined.isError, false, JSON.stringify(confined))
      assert.equal(confined.value.sandbox.mode, 'read-only')
      assert.equal(confined.value.result.denied, true)
      assert(['EACCES', 'EPERM'].includes(confined.value.result.code), JSON.stringify(confined.value.result))
      setSandboxMode(session, 'danger-full-access')
      const evidence = {
        runtime: '0.2.1-rc.5', nativeDirect: true, catalog: true,
        hostPid: process.pid, childPid: first.value.result.pid,
        typescript: true, guardedBinding: true, typedToolError: true,
        nestedEventPairs: ends.length, timeoutAndRecovery: true, temporaryMemory: true,
        readOnlyWriteDenied: true, enforcement: confined.value.sandbox.enforcement,
      }
      await writeFile(join(process.env.DSH_HOME, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
      process.stdout.write(`CODEBRIDGE_VERIFIED ${JSON.stringify(evidence)}\n`)
    } finally {
      await scope.dispose()
    }
  }
  ctx.effect(() => ready.onReady(() => {
    void run().then(() => exit(0), error => {
      console.error(error)
      exit(1)
    })
  }), 'CodeBridge verification driver')
}

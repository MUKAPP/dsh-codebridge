import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as CodeBridge from '../lib/index.js'

// Only the provider seam is scripted; dispatch uses the real rc.1 shared pipeline.
class FakeRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'fake'
  requests = []
  released = []
  releaseBehavior = async () => {}
  behavior = async () => ({ logs: [] })
  constructor(ctx, options = {}) { super(ctx); this.options = options; this.language = options.language ?? 'typescript' }
  get sandboxMode() { return this.options.sandbox === false ? undefined : 'danger-full-access' }
  get timeout() { return this.options.timeout === false ? undefined : { defaultMs: 120_000, maxMs: 240_000 } }
  get programFormat() { return this.options.programFormat ?? 'repl' }
  resolve(request) { this.lastRequest = request; return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 } }
  run(spec) { this.requests.push(spec); return this.behavior(spec) }
  release(owner) { this.released.push(owner); return this.releaseBehavior(owner) }
}

export async function setup(t, options = {}) {
  const ctx = new Context()
  const gates = []
  const policies = new Map()
  const ensured = []
  const gate = () => { const deferred = Promise.withResolvers(); gates.push(deferred); return deferred }
  t.after(async () => { for (const deferred of gates) deferred.resolve(); await ctx.fiber.dispose() })
  ctx.provide('workingDirectory', {
    defaultDirectory: process.cwd(), get: session => session.header.cwd,
    ensure: async (agent, signal) => { ensured.push({ agent, signal }); return options.ensure ? options.ensure(agent, signal) : agent.session.header.cwd },
  })
  ctx.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: policies.get(session.id) ?? options.mode ?? 'workspace-write', workspaceRoot: session.header.cwd }),
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const pipeline = new ToolExecutionPipeline(ctx)
  let runtimePlugin
  if (options.runtime !== false) {
    runtimePlugin = ctx.plugin(FakeRuntime, options.runtime ?? {})
    await runtimePlugin
  }
  const plugin = ctx.plugin(CodeBridge, options.config ?? {})
  await plugin
  const fixture = {
    ctx, pipeline, gate, policies, ensured, plugin, runtime: ctx.get('ptcRuntime'),
    async removeRuntime() { await runtimePlugin?.dispose(); fixture.runtime = undefined },
    async installRuntime(options = {}) {
      runtimePlugin = ctx.plugin(FakeRuntime, options)
      await runtimePlugin
      fixture.runtime = ctx.get('ptcRuntime')
      return fixture.runtime
    },
    async mintAgent(id = 'agent-a') {
      const events = []
      const agent = { id, ctx, session: { id, header: { cwd: `${process.cwd()}/${id}` }, append: (type, data) => events.push({ type, data }) } }
      let scope
      await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
      agent.ctx = scope.ctx
      return { agent, scope, events }
    },
    changeMode(agent, mode) { policies.set(agent.session.id, mode); ctx.emit('session/event', agent.session, { type: 'sandbox/mode', data: { mode } }) },
  }
  Object.assign(fixture, await fixture.mintAgent())
  return fixture
}

let nextCall = 0
export async function invoke(f, name, args, extras = {}) {
  const prepared = await f.pipeline.prepare({ callId: `call-${++nextCall}`, name, arguments: args, agent: f.agent, signal: new AbortController().signal, ...extras })
  const outcome = prepared.kind === 'dispatch' ? await f.pipeline.dispatch(prepared.exec) : prepared
  return f.pipeline.complete(prepared.exec, outcome)
}
export function execute(f, args = {}, extras = {}) { return invoke(f, 'codebridge_exec', { code: 'return null', description: 'Run fixture', ...args }, extras) }
export function register(f, name = 'echo', overrides = {}, owner = f.ctx) {
  owner.tools.register(defineTool({
    name, description: `Fixture ${name}`, parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: `display:${value}` }] },
    execute: async args => args.value, ...overrides,
  }))
}
export const functions = request => request.bindings[0].functions
export const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
export const ok = result => { assert.equal(result.isError, false, text(result)); return result.value }
export const failed = (result, pattern) => { assert.equal(result.isError, true); if (pattern) assert.match(result.error.message, pattern); return result }

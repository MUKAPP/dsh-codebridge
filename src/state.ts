import { randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { PtcBindingNamespace, PtcRunResult, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { appendPluginRecord, pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from 'zod'
import {
  SNAPSHOT_MAX_BYTES, collectSnapshotVariables, collectUnsupportedSnapshotNames, createSnapshotCodec,
  isSnapshotIdentifier, snapshotBootstrapProgram, snapshotCaptureProgram, snapshotProbeProgram, snapshotRestoreProgram,
  type SnapshotDeclarationKind, type SnapshotVariable,
} from './snapshot-program.js'

const RECORD_TYPE = 'plugin:codebridge/snapshot'
const PROJECTION_KEY = 'codebridge/snapshot'
const EntrySchema = z.object({ name: z.string(), kind: z.enum(['const', 'let', 'var']), json: z.string() }).strict()
const PolicySchema = z.object({ mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']), workspaceRoot: z.string() }).strict()
export interface SnapshotRecord {
  version: 1
  sessionId: string
  policy: { mode: SandboxExecutionPolicy['mode']; workspaceRoot: string } | null
  entries: Array<SnapshotVariable & { json: string }>
  omitted: string[]
}
export interface SnapshotProjectionState { record: SnapshotRecord | null; invalid: boolean }
const RecordSchema: z.ZodType<SnapshotRecord> = z.object({
  version: z.literal(1), sessionId: z.string(), policy: PolicySchema.nullable(),
  entries: z.array(EntrySchema), omitted: z.array(z.string()),
}).strict()
const StateSchema: z.ZodType<SnapshotProjectionState> = z.object({ record: RecordSchema.nullable(), invalid: z.boolean() }).strict()

export interface SnapshotStatus {
  /** True only after append, affirmative flush and read-back verification. */
  saved: boolean
  restored?: string[]
  omitted: string[]
  warning?: string
}
export interface SnapshotConfig {
  retainSessionState: { get(): boolean }
  restoreOnRestart: { get(): boolean }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:codebridge/snapshot': SnapshotRecord }
}

const recordCodec = createSnapshotCodec(types.isProxy, Buffer.byteLength)

/** Stored logs/cache are input, not trusted source or executable declarations. */
export function parseSnapshotRecord(value: unknown): SnapshotRecord | undefined {
  const parsed = RecordSchema.safeParse(value)
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > SNAPSHOT_MAX_BYTES) return undefined
  const record = parsed.data
  if (record.policy === null && (record.entries.length !== 0 || record.omitted.length !== 0)) return undefined
  const names = new Set<string>()
  try {
    const readers: Array<[string, SnapshotDeclarationKind, () => unknown]> = []
    for (const entry of record.entries) {
      if (!isSnapshotIdentifier(entry.name) || names.has(entry.name)) return undefined
      names.add(entry.name)
      const data: unknown = JSON.parse(entry.json)
      readers.push([entry.name, 'const', () => data])
    }
    for (const name of record.omitted) {
      if (!isSnapshotIdentifier(name) || names.has(name)) return undefined
      names.add(name)
    }
    const validated = recordCodec.capture(readers, SNAPSHOT_MAX_BYTES)
    if (validated.overflow || validated.omitted.length !== 0) return undefined
  } catch {
    return undefined
  }
  return record
}

function identity(value: object): object { return Reflect.get(value, symbols.original) ?? value }
function emptyRecord(session: Session): SnapshotRecord {
  return { version: 1, sessionId: String(session.id), policy: null, entries: [], omitted: [] }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : '未知错误' }

interface OwnerState {
  marker: string
  binding: string
  variables: Map<string, SnapshotDeclarationKind>
  unsupported: Set<string>
}

/** Automatic data-only checkpoints. All environment reads/writes use official runtime runs. */
export class SessionSnapshotStore {
  private readonly owners = new WeakMap<object, OwnerState>()
  private readonly cleared = new WeakSet<object>()
  private readonly pendingClear = new WeakSet<object>()
  private readonly sessionOwners = new WeakMap<object, Set<OwnerState>>()
  private disposed = false
  private projection: ProjectionHandle<SnapshotProjectionState> | undefined
  readonly ready: Promise<void>

  constructor(private readonly ctx: Context, private readonly config: SnapshotConfig) {
    ctx.effect(() => () => { this.disposed = true }, 'CodeBridge JSON snapshot store')
    const projections = ctx.get('sessionProjections')
    this.ready = projections === undefined ? Promise.resolve() : projections.register<typeof PROJECTION_KEY, SnapshotProjectionState>({
      key: PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: StateSchema,
      init: () => ({ record: null, invalid: false }),
      apply: (state, event) => {
        const record = pluginRecordOf(event)
        if (record?.type !== RECORD_TYPE) return state
        const parsed = parseSnapshotRecord(record.data)
        // A malformed latest whole-value record must never revive its predecessor.
        return { record: parsed ?? null, invalid: parsed === undefined }
      },
    }).then(handle => { this.projection = handle })
  }

  private enabled(): boolean { return this.config.retainSessionState.get() && this.config.restoreOnRestart.get() }

  private session(exec: ToolRunContext): Session {
    if (this.disposed) throw new Error('CodeBridge 快照服务已卸载。')
    if (exec.agent === undefined) throw new Error('CodeBridge 快照需要当前代理会话。')
    return exec.agent.session
  }

  private state(owner: object): OwnerState {
    let state = this.owners.get(owner)
    if (state === undefined) {
      const nonce = randomBytes(16).toString('hex')
      state = { marker: `__codebridge_snapshot_${nonce}`, binding: `codebridge_snapshot_${nonce}`, variables: new Map(), unsupported: new Set() }
      this.owners.set(owner, state)
    }
    return state
  }

  private async run(
    runtime: PtcRuntime, owner: object, cwd: string, policy: SandboxExecutionPolicy, signal: AbortSignal,
    program: string, bindings: PtcBindingNamespace[] = [],
  ): Promise<PtcRunResult> {
    signal.throwIfAborted()
    if (runtime.sandboxMode === undefined && policy.mode !== 'danger-full-access') throw new Error('当前运行时无法实施快照所需的文件沙箱策略。')
    const spec = runtime.resolve({
      program, bindings, stateOwner: owner, cwd, signal,
      ...(runtime.sandboxMode === undefined ? {} : { sandboxPolicy: policy }),
      // Do not request an unlimited deadline; resolve supplies/caps the provider budget.
    })
    const result = await runtime.run(spec)
    if (result.error !== undefined) throw new Error(`内部快照运行失败（${result.error.kind}）：${result.error.message}；运行时状态可能已被清空。`)
    signal.throwIfAborted()
    return result
  }

  async prepare(
    exec: ToolRunContext, runtime: PtcRuntime, stateOwner: object, cwd: string, policy: SandboxExecutionPolicy, signal: AbortSignal,
  ): Promise<{ restored: string[]; omitted: string[] }> {
    if (!this.enabled()) return { restored: [], omitted: [] }
    const session = this.session(exec)
    const projections = this.ctx.get('sessionProjections')
    if (projections === undefined) throw new Error('自动数据恢复需要 sessionProjections 服务；尚未执行用户代码。')
    if (this.pendingClear.has(identity(session))) {
      const status = await this.clear(exec)
      if (status.warning) throw new Error(status.warning)
    }
    const state = this.state(stateOwner)
    let owned = this.sessionOwners.get(identity(session))
    if (owned === undefined) { owned = new Set(); this.sessionOwners.set(identity(session), owned) }
    owned.add(state)
    const probe = await this.run(runtime, stateOwner, cwd, policy, signal, snapshotProbeProgram(state.marker))
    if (probe.value === true) return { restored: [], omitted: [] }
    if (probe.value !== false) throw new Error('无法确认 CodeBridge 快照环境；尚未执行用户代码。')
    const projection = this.projection?.stateOf(session)
    if (projection === undefined) throw new Error('CodeBridge 快照 projection 未注册；尚未执行用户代码。')
    if (projection.invalid) throw new Error('最新 CodeBridge 快照记录损坏；请关闭恢复以清除记录后继续。')
    const record = projection.record === null ? undefined : parseSnapshotRecord(projection.record)
    if (projection.record !== null && record === undefined) throw new Error('CodeBridge 快照记录验证失败；尚未执行用户代码。')
    // Fork prefixes belong to the source session, not to the child session.
    const ownRecord = record?.sessionId === String(session.id) ? record : undefined
    if (ownRecord?.policy && (ownRecord.policy.mode !== policy.mode || ownRecord.policy.workspaceRoot !== policy.workspaceRoot)) {
      throw new Error('CodeBridge 快照的文件权限或工作区已变化；请关闭恢复以清除旧快照后继续。')
    }
    const entries = ownRecord?.entries ?? []
    try {
      await this.run(runtime, stateOwner, cwd, policy, signal, snapshotBootstrapProgram(state.marker, state.binding), [{
        global: state.binding,
        functions: { load: async () => entries.map(entry => entry.json) },
      }])
      if (entries.length > 0) await this.run(runtime, stateOwner, cwd, policy, signal, snapshotRestoreProgram(state.marker, entries))
    } catch (error) {
      // Never leave a half-restored marker that could admit the next user cell.
      await runtime.release(stateOwner)
      throw error
    }
    state.variables = new Map(entries.map(entry => [entry.name, entry.kind]))
    state.unsupported = new Set(ownRecord?.omitted ?? [])
    return { restored: entries.map(entry => entry.name), omitted: ownRecord?.omitted ?? [] }
  }

  private async persist(session: Session, record: SnapshotRecord): Promise<SnapshotStatus> {
    try {
      const seq = appendPluginRecord(session, RECORD_TYPE, record)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined || await sessions.flush(session) !== true) {
        return { saved: false, omitted: record.omitted, warning: '快照已更新到会话内存，但未保证持久保存；不会重跑用户代码。' }
      }
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) return { saved: false, omitted: record.omitted, warning: '缺少 sessionPersistence，无法核验快照已持久保存；不会重跑用户代码。' }
      const handle = await persistence.open(session.id, 'read')
      try {
        const stored = (await handle.read(seq, 1)).events[0]
        const plugin = stored === undefined ? undefined : pluginRecordOf(stored)
        const data = plugin?.type === RECORD_TYPE && plugin.seq === seq ? parseSnapshotRecord(plugin.data) : undefined
        if (data === undefined || JSON.stringify(data) !== JSON.stringify(record)) throw new Error('flush 后未读回当前快照记录，可能没有活动的会话 writer。')
      } finally {
        await handle.close()
      }
      return { saved: true, omitted: record.omitted }
    } catch (error) {
      return { saved: false, omitted: record.omitted, warning: `未保证快照持久保存：${errorText(error)}；不会重跑用户代码。` }
    }
  }

  private async invalidate(session: Session): Promise<SnapshotStatus> {
    const key = identity(session)
    this.pendingClear.add(key)
    const status = await this.persist(session, emptyRecord(session))
    if (status.saved) { this.cleared.add(key); this.pendingClear.delete(key) }
    return status
  }

  /** Called on disabled recovery and failed user cells; repeated empty clears are no-ops. */
  async clear(exec: ToolRunContext): Promise<SnapshotStatus> {
    if (this.disposed || exec.agent === undefined) return { saved: false, omitted: [] }
    const session = exec.agent.session
    const key = identity(session)
    for (const state of this.sessionOwners.get(key) ?? []) { state.variables.clear(); state.unsupported.clear() }
    if (this.cleared.has(key)) return { saved: false, omitted: [] }
    const projections = this.ctx.get('sessionProjections')
    // Default-off must not introduce records or require optional projection/session services.
    if (projections === undefined) return this.pendingClear.has(key)
      ? { saved: false, omitted: [], warning: '缺少 sessionProjections，旧快照未保证已清空。' }
      : { saved: false, omitted: [] }
    const projection = this.projection?.stateOf(session)
    if (!this.pendingClear.has(key) && !projection?.invalid && (projection?.record == null || projection.record.sessionId !== String(session.id) || projection.record.policy === null)) {
      this.cleared.add(key)
      return { saved: false, omitted: [] }
    }
    return this.invalidate(session)
  }

  async capture(
    exec: ToolRunContext, runtime: PtcRuntime, owner: object, cwd: string, policy: SandboxExecutionPolicy, signal: AbortSignal, code: string,
  ): Promise<SnapshotStatus> {
    if (!this.enabled()) return { saved: false, omitted: [] }
    let session: Session | undefined
    let omitted: string[] = []
    try {
      session = this.session(exec)
      this.cleared.delete(identity(session))
      if (this.ctx.get('sessionProjections') === undefined) throw new Error('自动数据快照需要 sessionProjections 服务。')
      const state = this.owners.get(owner)
      if (state === undefined) throw new Error('当前环境尚未 prepare，不能在用户代码执行后安装安全快照 helper。')
      for (const variable of collectSnapshotVariables(code)) { state.variables.set(variable.name, variable.kind); state.unsupported.delete(variable.name) }
      for (const name of collectUnsupportedSnapshotNames(code)) { state.variables.delete(name); state.unsupported.add(name) }
      const variables: SnapshotVariable[] = [...state.variables].map(([name, kind]) => ({ name, kind }))
      omitted = [...state.variables.keys(), ...state.unsupported]
      const result = await this.run(runtime, owner, cwd, policy, signal, snapshotCaptureProgram(state.marker, variables))
      const captured = z.object({ entries: z.array(EntrySchema), omitted: z.array(z.string()), overflow: z.boolean() }).strict().safeParse(result.value)
      if (!captured.success) throw new Error('运行时未返回合法快照数据。')
      omitted = [...new Set([...captured.data.omitted, ...state.unsupported])]
      const record: SnapshotRecord = {
        version: 1, sessionId: String(session.id), policy: { mode: policy.mode, workspaceRoot: policy.workspaceRoot },
        entries: captured.data.entries, omitted,
      }
      if (captured.data.overflow || Buffer.byteLength(JSON.stringify(record)) > SNAPSHOT_MAX_BYTES) {
        const status = await this.invalidate(session)
        return { saved: false, omitted: [...state.variables.keys(), ...state.unsupported], warning: `JSON 数据快照超过 ${SNAPSHOT_MAX_BYTES} 字节，未保存当前数据；${status.saved ? '已清空旧快照。' : '旧快照未保证已持久清空。'}${status.warning ?? ''}` }
      }
      if (parseSnapshotRecord(record) === undefined) throw new Error('捕获的 JSON 快照未通过校验。')
      const status = await this.persist(session, record)
      if (status.saved) this.pendingClear.delete(identity(session))
      return status
    } catch (error) {
      // The user cell has already finished: no retry, no re-execution, no stale checkpoint.
      const cleared = session === undefined ? undefined : await this.invalidate(session)
      return { saved: false, omitted, warning: `数据快照失败：${errorText(error)} 用户代码不会重跑；内部运行失败可能清空 REPL。${cleared?.warning ?? ''}` }
    }
  }
}

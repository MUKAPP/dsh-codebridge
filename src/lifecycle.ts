import { symbols, type Context } from '@deepseek-ai/cordis'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'

export interface LifecycleConfig {
  retainSessionState: { get(): boolean }
}

interface ActiveCall {
  state: SessionState
  mode: SandboxExecutionPolicy['mode']
  controller: AbortController
  done: Promise<void>
}

interface SessionState {
  readonly session: object
  readonly sessionId: string
  owner: object | undefined
  retained: boolean
  retentionEpoch: number
  readonly runtimes: Map<object, PtcRuntime>
  tail: Promise<void>
  release?: Promise<void>
}

type CallBody<T> = (
  signal: AbortSignal, policy: SandboxExecutionPolicy, stateOwner: object | undefined, runtime: PtcRuntime | undefined,
) => Promise<T>

/** 拥有完整代码调用，包含运行时启动前等待、会话状态串行化和子工具收尾。 */
export class CallLifecycle {
  private readonly calls = new Set<ActiveCall>()
  private readonly sessions = new Map<object, SessionState>()
  private readonly disposedSessions = new WeakSet<object>()
  private disposed = false
  private retentionEpoch = 0
  private readonly policy

  constructor(
    private readonly ctx: Context, private readonly config: LifecycleConfig,
    private readonly clearSnapshot?: (exec: ToolRunContext) => Promise<unknown>,
  ) {
    this.policy = ctx.sandboxPolicy
    ctx.on('loader/volatile-update', paths => {
      if (paths.some(path => path[0] === 'retainSessionState' || path[0] === 'restoreOnRestart')) this.retentionEpoch++
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      for (const call of this.calls) {
        if (call.state.session === this.identity(session) && call.mode !== event.data.mode) {
          call.controller.abort(new Error('会话权限已变化，代码执行已取消。'))
        }
      }
    }, { global: true })
    ctx.on('session/disposed', session => {
      void this.releaseSession(this.identity(session))
    }, { global: true })
    ctx.effect(() => async () => {
      this.disposed = true
      for (const call of this.calls) call.controller.abort(new Error('CodeBridge 已卸载。'))
      const releases = await Promise.allSettled([...this.sessions.keys()].map(session => this.releaseSession(session)))
      await Promise.all([...this.calls].map(call => call.done))
      const errors = releases.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'CodeBridge 会话状态释放失败。')
    }, 'CodeBridge active calls and session runtimes')
  }

  /** 取消可提前退出等待，但原队列节点仍须经过尾链，不能让后续调用越过收尾。 */
  async run<T>(exec: ToolRunContext, body: CallBody<T>): Promise<T> {
    const agent = exec.agent
    if (agent === undefined) throw new Error('CodeBridge 代码执行需要当前代理会话。')
    exec.signal.throwIfAborted()
    const state = this.getSessionState(this.identity(agent.session), String(agent.session.id))
    let started = false
    const cancelled = Promise.withResolvers<never>()
    const onAbort = () => { if (!started) cancelled.reject(exec.signal.reason) }
    exec.signal.addEventListener('abort', onAbort, { once: true })
    const operation = state.tail.then(async () => {
      started = true
      if (this.disposed || this.disposedSessions.has(state.session)) throw new Error('CodeBridge 会话状态已释放。')
      exec.signal.throwIfAborted()
      await this.syncRetention(state, exec)
      if (this.disposed || this.disposedSessions.has(state.session)) throw new Error('CodeBridge 会话状态已释放。')
      return this.runActive(exec, state, body)
    })
    state.tail = operation.then(() => {}, () => {})
    try {
      return await Promise.race([operation, cancelled.promise])
    } finally {
      exec.signal.removeEventListener('abort', onAbort)
    }
  }

  private identity(value: object): object {
    // Cordis 每次 get 都创建 traceable proxy，以底层对象区分 Session/provider generation。
    return Reflect.get(value, symbols.original) ?? value
  }

  private getSessionState(session: object, sessionId: string): SessionState {
    if (this.disposed) throw new Error('CodeBridge 已卸载。')
    if (this.disposedSessions.has(session)) throw new Error('CodeBridge 会话状态已释放。')
    const existing = this.sessions.get(session)
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId) throw new Error('CodeBridge 会话标识已变化。')
      return existing
    }
    const retained = this.config.retainSessionState.get()
    const state: SessionState = {
      session,
      sessionId,
      owner: retained ? {} : undefined,
      retained,
      retentionEpoch: 0,
      runtimes: new Map(),
      tail: Promise.resolve(),
    }
    this.sessions.set(session, state)
    return state
  }

  private async syncRetention(state: SessionState, exec: ToolRunContext): Promise<void> {
    const retained = this.config.retainSessionState.get()
    if (retained === state.retained && state.retentionEpoch === this.retentionEpoch) return
    if (state.owner !== undefined) {
      await this.releaseOwnedState(state)
      state.owner = undefined
      state.retained = false
    }
    await this.clearSnapshot?.(exec)
    state.owner = retained ? {} : undefined
    state.retained = retained
    state.retentionEpoch = this.retentionEpoch
  }

  private async runActive<T>(exec: ToolRunContext, state: SessionState, body: CallBody<T>): Promise<T> {
    exec.signal.throwIfAborted()
    const policy = this.policy.resolve({ session: exec.agent!.session })
    // 在排队真正准入时读取 provider；释放始终使用这个实际接收 owner 的 generation。
    const runtime = this.ctx.get('ptcRuntime')
    if (runtime !== undefined && state.owner !== undefined) state.runtimes.set(this.identity(runtime), runtime)
    const controller = new AbortController()
    const done = Promise.withResolvers<void>()
    const call: ActiveCall = { state, mode: policy.mode, controller, done: done.promise }
    this.calls.add(call)
    try {
      return await body(AbortSignal.any([exec.signal, controller.signal]), policy, state.owner, runtime)
    } finally {
      this.calls.delete(call)
      done.resolve()
    }
  }

  private releaseSession(session: object): Promise<void> {
    // 未创建 owner 的 Session 也须标记；恢复出的同 id 新 Session 则有独立身份。
    this.disposedSessions.add(session)
    const state = this.sessions.get(session)
    if (state === undefined) return Promise.resolve()
    if (state.release !== undefined) return state.release
    state.release = this.drainSession(state)
    // session/disposed 是通知事件；失败已逐项记录，保留同一 rejection 供卸载等待。
    void state.release.catch(() => {})
    for (const call of this.calls) {
      if (call.state === state) call.controller.abort(new Error('会话已释放，代码执行已取消。'))
    }
    return state.release
  }

  private async releaseOwnedState(state: SessionState): Promise<void> {
    const results = await Promise.allSettled([...state.runtimes.entries()].map(async ([key, runtime]) => {
      try {
        if (state.owner !== undefined) await runtime.release(state.owner)
        state.runtimes.delete(key)
      } catch (error) {
        this.ctx.logger.warn('CodeBridge 会话 %s 状态释放失败：%s', state.sessionId, String(error))
        throw error
      }
    }))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'CodeBridge 会话状态释放失败。')
  }

  private async drainSession(state: SessionState): Promise<void> {
    // release 不进入 tail：tail 只等待调用及子调用日志，避免互相等待。
    await state.tail
    await this.releaseOwnedState(state)
    this.sessions.delete(state.session)
  }
}

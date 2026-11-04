import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

export const SETTINGS_NAMESPACE = 'codebridge'

export interface CodeBridgeSettings {
  retainSessionState?: boolean
  restoreOnRestart?: boolean
}

export type SettingsField = keyof CodeBridgeSettings

const defaults: Required<CodeBridgeSettings> = {
  retainSessionState: true,
  restoreOnRestart: false,
}

export interface BooleanFieldState {
  value: boolean
  overridden: boolean
  resetting: boolean
  dirty: boolean
}

export interface CodeBridgeSettingsState {
  status: ConfigFormSnapshot<CodeBridgeSettings>['status']
  writable: boolean
  dirty: boolean
  saving: boolean
  result: 'saved' | 'failed' | undefined
  retainSessionState: BooleanFieldState
  restoreOnRestart: BooleanFieldState
}

function booleanValue(section: unknown, field: SettingsField): boolean {
  const value = section !== null && typeof section === 'object'
    ? (section as Record<string, unknown>)[field]
    : undefined
  return typeof value === 'boolean' ? value : defaults[field]
}

/** Stages both switches and commits them in one revision-fenced mutation. */
export class CodeBridgeSettingsController {
  private readonly drafts = new Map<SettingsField, boolean | undefined>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private baselineRevision: number | undefined
  private saving = false
  private result: CodeBridgeSettingsState['result']
  private snapshot: CodeBridgeSettingsState

  constructor(private readonly form: ConfigForm<CodeBridgeSettings>) {
    this.snapshot = this.project()
    this.unsubscribe = form.subscribe(() => this.publish())
  }

  readonly getSnapshot = (): CodeBridgeSettingsState => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private field(field: SettingsField, accepted: ConfigFormSnapshot<CodeBridgeSettings>): BooleanFieldState {
    const user = accepted.user
    const overridden = user !== null && typeof user === 'object' && Object.hasOwn(user, field)
    const resetting = this.drafts.has(field) && this.drafts.get(field) === undefined
    const value = this.drafts.has(field)
      ? this.drafts.get(field) ?? booleanValue(accepted.base, field)
      : booleanValue(accepted.value, field)
    return { value, overridden, resetting, dirty: this.drafts.has(field) }
  }

  private project(): CodeBridgeSettingsState {
    const accepted = this.form.getSnapshot()
    return {
      status: accepted.status,
      writable: accepted.status === 'ready' && accepted.writable,
      dirty: this.drafts.size > 0,
      saving: this.saving,
      result: this.result,
      retainSessionState: this.field('retainSessionState', accepted),
      restoreOnRestart: this.field('restoreOnRestart', accepted),
    }
  }

  private publish(): void {
    this.snapshot = this.project()
    for (const listener of this.listeners) listener()
  }

  private stage(field: SettingsField, value: boolean | undefined): void {
    if (!this.snapshot.writable || this.saving) return
    if (!this.drafts.size) this.baselineRevision = this.form.getSnapshot().revision
    this.drafts.set(field, value)
    this.result = undefined
    this.publish()
  }

  readonly edit = (field: SettingsField, value: boolean): void => { this.stage(field, value) }
  readonly reset = (field: SettingsField): void => { this.stage(field, undefined) }

  readonly discard = (): void => {
    if (this.saving) return
    this.drafts.clear()
    this.baselineRevision = undefined
    this.result = undefined
    this.publish()
  }

  readonly save = async (): Promise<void> => {
    if (!this.snapshot.writable || this.saving || !this.drafts.size) return
    const ops = [...this.drafts].map(([field, value]) => value === undefined
      ? { op: 'unset' as const, path: [field] }
      : { op: 'set' as const, path: [field], value })
    this.saving = true
    this.result = undefined
    this.publish()
    try {
      const accepted = await this.form.mutate(ops, this.baselineRevision)
      this.result = accepted ? 'saved' : 'failed'
      if (accepted) {
        this.drafts.clear()
        this.baselineRevision = undefined
      }
    } catch {
      this.result = 'failed'
    } finally {
      this.saving = false
      this.publish()
    }
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }
}

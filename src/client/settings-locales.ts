export const SETTINGS_LOCALE = 'codebridge.settings'

export const settingsZh = {
  title: '设置',
  restoreOnRestart: '重启后恢复',
  restoreOnRestartHint: '开启后，模型保留执行状态时，受支持的顶层 JSON 变量会写入会话日志，供重启后恢复。',
  restoreOnRestartEffect: '更改此项后，下一次非隔离调用会清除旧环境和恢复快照。',
  save: '保存更改',
  saving: '正在保存…',
  discard: '放弃更改',
  reset: '恢复继承值',
  resetting: '保存后将使用继承值。',
  pending: '有未保存的更改。',
  saved: '设置已保存。',
  failed: '保存失败或配置已变化。请放弃更改后重试。',
  loading: '正在加载设置…',
  unavailable: '宿主尚未提供 CodeBridge 设置。',
  readOnly: '当前配置不可写，无法保存或重置设置。',
}

export type SettingsLocaleKey = keyof typeof settingsZh

export const settingsEn: Record<SettingsLocaleKey, string> = {
  title: 'Settings',
  restoreOnRestart: 'Restore after restart',
  restoreOnRestartHint: 'When the model retains execution state, save supported top-level JSON variables to the session log so they can be restored after a restart.',
  restoreOnRestartEffect: 'Changing this setting clears the old environment and recovery snapshot on the next non-isolated call.',
  save: 'Save changes',
  saving: 'Saving…',
  discard: 'Discard changes',
  reset: 'Use inherited value',
  resetting: 'Save changes to use the inherited value.',
  pending: 'You have unsaved changes.',
  saved: 'Settings saved.',
  failed: 'Saving failed or the configuration changed. Discard your changes and try again.',
  loading: 'Loading settings…',
  unavailable: 'The Host has not exposed CodeBridge settings.',
  readOnly: 'The current configuration is read-only. Settings cannot be saved or reset.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'codebridge.settings': SettingsLocaleKey
  }
}

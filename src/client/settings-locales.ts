export const SETTINGS_LOCALE = 'codebridge.settings'

export const settingsZh = {
  title: 'CodeBridge',
  description: '管理代码执行环境的会话状态与重启恢复。',
  retainSessionState: '保留会话状态',
  retainSessionStateHint: '在同一会话中保留变量、函数和导入。关闭后，从下一次调用开始使用新鲜环境。',
  restoreOnRestart: '重启后恢复',
  restoreOnRestartHint: '自动保存和恢复支持的顶层 JSON 数据变量，不重跑历史代码；函数、模块和句柄不会恢复。需同时开启保留会话状态；修改此设置后，下次调用将新建执行环境。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃更改',
  reset: '重置为继承值',
  resetting: '保存后重置为继承值',
  overridden: '已覆盖',
  pending: '更改尚未保存。重置操作也需要保存后生效。',
  saved: '设置已保存。',
  failed: '保存失败或配置已变化。请放弃更改后重试。',
  loading: '正在加载设置…',
  unavailable: '宿主尚未提供 CodeBridge 设置。',
  readOnly: '当前配置不可写，无法保存或重置设置。',
}

export type SettingsLocaleKey = keyof typeof settingsZh

export const settingsEn: Record<SettingsLocaleKey, string> = {
  title: 'CodeBridge',
  description: 'Manage execution session state and restart recovery.',
  retainSessionState: 'Retain session state',
  retainSessionStateHint: 'Keep variables, functions, and imports within the same session. When disabled, the next invocation starts with a fresh environment.',
  restoreOnRestart: 'Restore after restart',
  restoreOnRestartHint: 'Automatically save and restore supported top-level JSON data variables without replaying historical code. Functions, modules, and handles are not restored. Requires session state retention. Changing this setting starts a new environment on the next invocation.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard changes',
  reset: 'Reset to inherited value',
  resetting: 'Will reset to the inherited value when saved',
  overridden: 'Overridden',
  pending: 'Changes are not saved. Resets also take effect only after saving.',
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

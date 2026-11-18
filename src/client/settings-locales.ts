export const SETTINGS_LOCALE = 'codebridge.settings'

export const settingsZh = {
  title: 'CodeBridge',
  description: '模型按次决定是否保留执行状态；这里管理重启后的数据恢复。',
  restoreOnRestart: '重启后恢复',
  restoreOnRestartHint: '自动保存和恢复支持的顶层 JSON 数据变量，不重跑历史代码；函数、模块和句柄不会恢复。仅为模型选择保留的执行状态保存数据；模型释放状态时会清除恢复基线。修改此设置后，下次调用将新建执行环境。',
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
  description: 'The model decides state retention per invocation. Manage restart data recovery here.',
  restoreOnRestart: 'Restore after restart',
  restoreOnRestartHint: 'Automatically save and restore supported top-level JSON data variables without replaying historical code. Functions, modules, and handles are not restored. Only saves data when the model retains execution state; releasing state clears the recovery baseline. Changing this setting starts a new environment on the next invocation.',
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

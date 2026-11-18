import { createElement, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CodeBridgeSettingsController } from './settings-controller.js'
import type { CodeBridgeSettings as SettingsValue } from './settings-controller.js'
import type {} from './settings-locales.js'
import { SETTINGS_STYLES } from './settings-styles.js'

type SettingsLocaleProps = PropsLocale<'codebridge.settings'>
type CodeBridgeSettingsProps = PropsRuntime<'plugins.bundle.config'> & SettingsLocaleProps & {
  settingsForm: ConfigForm<SettingsValue>
}

const field = 'restoreOnRestart'

export function CodeBridgeSettings({ settingsForm, t }: CodeBridgeSettingsProps) {
  const [controller, setController] = useState<CodeBridgeSettingsController>()
  useEffect(() => {
    const editor = new CodeBridgeSettingsController(settingsForm)
    setController(editor)
    return () => editor.dispose()
  }, [settingsForm])

  return createElement('div', { className: 'codebridge-settings' },
    createElement('style', null, SETTINGS_STYLES),
    createElement('h4', null, t('title')),
    controller
      ? createElement(SettingsEditor, { controller, t })
      : createElement('p', { role: 'status' }, t('loading')),
  )
}

function SettingsEditor({ controller, t }: SettingsLocaleProps & { controller: CodeBridgeSettingsController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const id = useId()
  if (state.status !== 'ready') {
    return createElement('p', { role: 'status' }, t(state.status === 'loading' ? 'loading' : 'unavailable'))
  }

  const setting = state[field]
  const locked = !state.writable || state.saving
  const notice = !state.writable ? t('readOnly')
    : state.saving ? t('saving')
      : state.result === 'failed' ? t('failed')
        : state.result === 'saved' ? t('saved')
          : setting.resetting ? t('resetting')
            : state.dirty ? t('pending') : ''

  return createElement('form', {
    onSubmit: event => { event.preventDefault(); void controller.save() },
  },
  createElement('div', { className: 'codebridge-settings__row' },
    createElement('div', { className: 'codebridge-settings__copy' },
      createElement('label', { id: `${id}-label`, htmlFor: id }, t(field)),
      createElement('p', { id: `${id}-hint` }, t('restoreOnRestartHint')),
      createElement('p', { id: `${id}-effect` }, t('restoreOnRestartEffect'))),
    createElement('button', {
      id,
      type: 'button',
      role: 'switch',
      className: 'codebridge-settings__switch',
      'aria-checked': setting.value,
      'aria-labelledby': `${id}-label`,
      'aria-describedby': `${id}-hint ${id}-effect`,
      disabled: locked,
      onClick: () => { controller.edit(field, !setting.value) },
    }, createElement('span', { 'aria-hidden': true }))),
  createElement('div', { className: 'codebridge-settings__footer' },
    createElement('p', { role: 'status', 'data-result': state.result }, notice),
    createElement('div', { className: 'codebridge-settings__actions' },
      setting.overridden && !setting.resetting ? createElement('button', {
        type: 'button',
        disabled: locked,
        onClick: () => { controller.reset(field) },
      }, t('reset')) : null,
      createElement('button', {
        type: 'button',
        disabled: state.saving || !state.dirty,
        onClick: controller.discard,
      }, t('discard')),
      createElement('button', {
        type: 'submit',
        disabled: locked || !state.dirty,
      }, t('save')))))
}

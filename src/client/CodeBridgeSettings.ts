import { createElement, useId, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './settings-locales.js'
import type { CodeBridgeSettingsController, SettingsField } from './settings-controller.js'

export interface CodeBridgeSettingsFace {
  controller: CodeBridgeSettingsController
}

type CodeBridgeSettingsProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'codebridge.settings'>
  & CodeBridgeSettingsFace

const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 1.5,
}
const hintStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: '0.875em',
}
const actionsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const buttonStyle: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-label-quaternary, #8886)',
  color: 'inherit',
  background: 'transparent',
  font: 'inherit',
}

export function CodeBridgeSettings({ controller, t }: CodeBridgeSettingsProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const id = useId()
  const disabled = !state.writable || state.saving
  const field = (name: SettingsField) => {
    const value = state[name]
    const inputId = id + '-' + name
    return createElement('div', { key: name, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      createElement('label', { htmlFor: inputId, style: { display: 'flex', alignItems: 'center', gap: 10 } },
        createElement('input', {
          id: inputId,
          type: 'checkbox',
          role: 'switch',
          checked: value.value,
          disabled,
          'aria-describedby': inputId + '-hint',
          onChange: event => { controller.edit(name, event.currentTarget.checked) },
        }),
        createElement('span', null, t(name))),
      createElement('p', { id: inputId + '-hint', style: hintStyle },
        t(name === 'retainSessionState' ? 'retainSessionStateHint' : 'restoreOnRestartHint')),
      createElement('div', { style: actionsStyle },
        value.overridden ? createElement('span', { style: hintStyle }, t('overridden')) : null,
        createElement('button', {
          type: 'button',
          style: { ...buttonStyle, fontSize: '0.875em' },
          disabled: disabled || value.resetting || (!value.overridden && !value.dirty),
          onClick: () => { controller.reset(name) },
        }, t('reset'))),
      value.resetting ? createElement('p', { style: hintStyle }, t('resetting')) : null)
  }
  const availability = state.status === 'loading' ? t('loading')
    : state.status === 'unavailable' ? t('unavailable')
      : !state.writable ? t('readOnly') : undefined
  const notice = state.result === 'failed' ? t('failed')
    : state.result === 'saved' ? t('saved')
      : state.dirty ? t('pending') : undefined

  return createElement('form', {
    style: formStyle,
    'aria-busy': state.saving || state.status === 'loading',
    onSubmit: event => { event.preventDefault(); void controller.save() },
  },
  createElement('div', null,
    createElement('h3', { style: { margin: '0 0 6px' } }, t('title')),
    createElement('p', { style: hintStyle }, t('description'))),
  availability ? createElement('p', { role: 'status', style: hintStyle }, availability) : null,
  field('retainSessionState'),
  field('restoreOnRestart'),
  createElement('div', { style: actionsStyle },
    createElement('button', {
      type: 'submit', style: buttonStyle, disabled: disabled || !state.dirty,
    }, t(state.saving ? 'saving' : 'save')),
    createElement('button', {
      type: 'button', style: buttonStyle, disabled: state.saving || !state.dirty,
      onClick: controller.discard,
    }, t('discard'))),
  notice ? createElement('p', {
    role: state.result === 'failed' ? 'alert' : 'status',
    style: hintStyle,
  }, notice) : null)
}

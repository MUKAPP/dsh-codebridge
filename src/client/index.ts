import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { en, NS, zh } from './locales.js'
import { progressDefinition } from './progress.js'
import { ProgressView } from './ProgressView.js'
import { CodeBridgeSettings } from './CodeBridgeSettings.js'
import { CodeBridgeSettingsController, SETTINGS_NAMESPACE } from './settings-controller.js'
import type { CodeBridgeSettings as CodeBridgeSettingsValue } from './settings-controller.js'
import { SETTINGS_LOCALE, settingsEn, settingsZh } from './settings-locales.js'

export const inject = ['slots', 'locale', 'uiConversation', 'configForms']

export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(progressDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codebridge: progress dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'codebridge-progress',
    locale: NS,
  }, ProgressView))

  ctx.effect(() => ctx.locale.register(SETTINGS_LOCALE, { zh: settingsZh, en: settingsEn }), 'codebridge: settings dictionaries')
  const t = ctx.locale.bind(SETTINGS_LOCALE)
  const controller = new CodeBridgeSettingsController(ctx.configForms.get<CodeBridgeSettingsValue>(SETTINGS_NAMESPACE))
  ctx.effect(() => () => { controller.dispose() }, 'codebridge: settings subscription')
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: SETTINGS_NAMESPACE,
    order: 40,
    label: () => t('title'),
    locale: SETTINGS_LOCALE,
    inject: () => ({ controller }),
  }, CodeBridgeSettings))
}

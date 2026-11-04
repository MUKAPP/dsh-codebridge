import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CodeBridgeSettings } from './CodeBridgeSettings.js'
import { CodeBridgeSettingsController, SETTINGS_NAMESPACE } from './settings-controller.js'
import type { CodeBridgeSettings as CodeBridgeSettingsValue } from './settings-controller.js'
import { SETTINGS_LOCALE, settingsEn, settingsZh } from './settings-locales.js'

export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: Context): void {
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

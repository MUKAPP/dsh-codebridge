import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { CodeBridgeToolView } from './CodeBridgeToolView.js'
import { TOOL_LOCALE, toolEn, toolZh } from './tool-locales.js'
import { TOOL_STYLES } from './tool-styles.js'
import { CodeBridgeSettings } from './CodeBridgeSettings.js'
import { CodeBridgeSettingsController, SETTINGS_NAMESPACE } from './settings-controller.js'
import type { CodeBridgeSettings as CodeBridgeSettingsValue } from './settings-controller.js'
import { SETTINGS_LOCALE, settingsEn, settingsZh } from './settings-locales.js'

export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.codebridge = 'tool'
    style.textContent = TOOL_STYLES
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'codebridge: tool styles')
  ctx.effect(() => ctx.locale.register(SETTINGS_LOCALE, { zh: settingsZh, en: settingsEn }), 'codebridge: settings dictionaries')
  ctx.effect(() => ctx.locale.register(TOOL_LOCALE, { zh: toolZh, en: toolEn }), 'codebridge: tool dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'codebridge_exec', locale: TOOL_LOCALE,
  }, CodeBridgeToolView))
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

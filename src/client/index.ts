import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, NS, zh } from './locales.js'
import { progressDefinition } from './progress.js'
import { ProgressView } from './ProgressView.js'

export const inject = ['slots', 'locale', 'uiConversation']

export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(progressDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codebridge: progress dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'codebridge-progress',
    locale: NS,
  }, ProgressView))
}

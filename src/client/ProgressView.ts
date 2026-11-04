import { createElement } from 'react'
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from './locales.js'
import type {} from './progress.js'

type ProgressViewProps = PropsRuntime<'conversation.chat.node', 'codebridge-progress'>
  & PropsLocale<'codebridge.progress'>

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 10px',
  borderLeft: '2px solid var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
  color: 'var(--dsw-alias-label-primary)',
}
const detailStyle: CSSProperties = {
  fontSize: '0.875em',
  color: 'var(--dsw-alias-label-tertiary)',
  fontVariantNumeric: 'tabular-nums',
}

export function ProgressView({ node, t }: ProgressViewProps) {
  const progress = node.data
  const stage = progress.cancelled && !progress.finished
    ? `${t('cancelling')} · ${progress.stage}`
    : progress.stage

  return createElement('section', {
    style: rowStyle,
    role: 'status',
    'aria-live': 'polite',
    'aria-busy': !progress.finished,
    'data-codebridge-call-id': progress.callId,
  },
  createElement('div', null,
    createElement('strong', null, t('title')),
    progress.description === '' ? null : ` · ${progress.description}`),
  createElement('div', null, stage),
  progress.currentTool === undefined ? null
    : createElement('div', { style: detailStyle }, t('currentTool', { tool: progress.currentTool })),
  createElement('div', { style: detailStyle }, t('counts', {
    submitted: progress.submitted,
    completed: progress.completed,
    failed: progress.failed,
  })))
}

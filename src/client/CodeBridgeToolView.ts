import { createElement, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { CodeBlock, DisclosureRow, IconCodeOutlineRegular, IconInspectOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './tool-locales.js'
import { formatCode } from './format-code.js'
import type { FormattedCode } from './format-code.js'

type CodeBridgeToolViewProps = ToolCallViewProps & PropsLocale<'codebridge.tool'>

function inputSource(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const args: unknown = JSON.parse(raw)
    if (typeof args === 'object' && args !== null && !Array.isArray(args) && 'code' in args && typeof args.code === 'string') {
      return args.code
    }
  } catch {
    // Rejected calls may retain malformed argument JSON. Show the original input.
  }
  return null
}

/** One keyed Tool view; its parent still owns the original subcall tree. */
export function CodeBridgeToolView({ phase, block, toolName, inspect, useDisclosure, t }: CodeBridgeToolViewProps) {
  const { expanded, toggle } = useDisclosure()
  const raw = 'kind' in block ? block.call?.argsRaw ?? null : block.phase === 'start' ? block.argsRaw : null
  const source = useMemo(() => inputSource(raw), [raw])
  const cache = useRef<{ source: string; result: Promise<FormattedCode> } | null>(null)
  const [formatted, setFormatted] = useState<(FormattedCode & { source: string }) | null>(null)

  useEffect(() => {
    if (!expanded || source === null) return
    if (cache.current?.source !== source) cache.current = { source, result: formatCode(source) }
    let current = true
    void cache.current.result.then(result => {
      if (current) setFormatted({ ...result, source })
    })
    return () => { current = false }
  }, [expanded, source])

  const output = useMemo(() => {
    if (!('kind' in block)) return null
    const parts = block.content.map(part => part.type === 'text' ? part.text : JSON.stringify(part, null, 2))
    if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
    return parts.join('\n') || null
  }, [block])
  const stopped = 'kind' in block && block.error?.code === 'interrupted'
  const failed = 'kind' in block && (block.isError || (typeof block.meta === 'object' && block.meta !== null
    && !Array.isArray(block.meta) && 'stopped' in block.meta && block.meta.stopped === true))
  const state = stopped ? 'stopped' : failed ? 'error' : phase === 'result' ? 'ok' : phase === 'preparing' ? 'preparing' : 'running'
  const description = block.args.text('description')?.split('\n', 1)[0] ?? ''
  const summary = failed && !stopped && output !== null ? output.split('\n', 1)[0] : description
  const ready = formatted?.source === source ? formatted : null
  const expandable = raw !== null || output !== null || inspect !== undefined

  const fallbackInput = source === null ? raw : null

  return createElement('div', { className: 'codebridge-tool', 'data-codebridge-state': state },
    createElement(DisclosureRow, {
      title: toolName,
      titleClassName: 'codebridge-tool__title',
      icon: createElement(IconCodeOutlineRegular, { size: 14 }),
      open: expanded,
      expandable,
      onToggle: toggle,
      running: phase !== 'result',
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      collapsedContent: summary ? createElement(Fragment, null,
        createElement('span', { className: 'codebridge-tool__sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
        createElement('span', { className: 'codebridge-tool__summary', 'data-error': state === 'error' || undefined },
          createElement(TextShimmer, null, summary))) : undefined,
      headerAccessory: stopped || failed ? createElement('span', {
        className: 'codebridge-tool__state', 'data-error': state === 'error' || undefined,
      }, t(stopped ? 'stopped' : 'failed')) : undefined,
    }, expanded ? createElement('div', { className: 'codebridge-tool__body' },
      source !== null ? createElement(Fragment, null,
        createElement('span', { className: 'codebridge-tool__input-label' }, t('input')),
        createElement('div', { className: 'codebridge-tool__code-scroll' },
          createElement(CodeBlock, {
            code: ready?.code ?? source,
            lang: 'typescript',
            lineNumbers: true,
            className: 'codebridge-tool__code',
            copyLabel: t('copy'),
            copiedLabel: t('copied'),
            toolbarLabels: { codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap') },
          })),
        ready?.failed ? createElement('span', { className: 'codebridge-tool__format-note' }, t('unformatted')) : null) : null,
      fallbackInput !== null || output !== null ? createElement('div', { className: 'codebridge-tool__io' },
        fallbackInput !== null ? createElement('div', { className: 'codebridge-tool__io-section', tabIndex: 0 },
          createElement('span', { className: 'codebridge-tool__io-label' }, t('input')),
          createElement('span', { className: 'codebridge-tool__text' }, fallbackInput)) : null,
        fallbackInput !== null && output !== null ? createElement('span', { className: 'codebridge-tool__io-divider', 'aria-hidden': true }) : null,
        output !== null ? createElement('div', { className: 'codebridge-tool__io-section', tabIndex: 0 },
          createElement('span', { className: 'codebridge-tool__io-label' }, t('output')),
          createElement('span', { className: 'codebridge-tool__text', 'data-error': state === 'error' || undefined }, output)) : null) : null,
      inspect !== undefined ? createElement('button', { type: 'button', className: 'codebridge-tool__inspect', onClick: inspect },
        createElement(IconInspectOutlineRegular), t('inspect')) : null) : null))
}

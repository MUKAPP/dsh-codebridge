/** Scoped Tool chrome aligned with DSH 0.2.2-rc.1; shared primitives own the code block. */
export const TOOL_STYLES = `
.codebridge-tool {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.codebridge-tool__title {
  font-weight: 400;
}

.codebridge-tool__sep {
  flex: none;
  width: 2px;
  height: 2px;
  border-radius: 1px;
  margin: 0 8px;
  background: var(--dsw-alias-label-caption);
}

.codebridge-tool__summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}

.codebridge-tool__summary[data-error],
.codebridge-tool__state[data-error],
.codebridge-tool__text[data-error] {
  color: var(--dsw-alias-state-error-primary);
}

.codebridge-tool__state {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary);
}

.codebridge-tool__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.codebridge-tool__input-label,
.codebridge-tool__format-note {
  margin: 4px 0 4px 4px;
  font: var(--dsw-font-markdown-code-block-small);
  color: var(--dsw-alias-label-caption);
}

.codebridge-tool__code-scroll {
  max-height: 360px;
  overflow: auto;
}

.codebridge-tool__code {
  margin: 4px 0 4px 4px;
}

.codebridge-tool__io {
  display: flex;
  flex-direction: column;
  margin: 4px 0 4px 4px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-markdown-code-block);
  font: var(--dsw-font-markdown-code-block-small);
}

.codebridge-tool__io-section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  align-items: baseline;
  padding: 12px 16px;
  max-height: 150px;
  overflow-y: auto;
}

.codebridge-tool__io-section::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  background-clip: padding-box;
  border-radius: var(--dsw-radius-sm);
}

.codebridge-tool__io-section::-webkit-scrollbar-track {
  margin: 6px 0;
}

.codebridge-tool__io-label {
  position: sticky;
  top: 0;
  align-self: start;
  color: var(--dsw-alias-label-caption);
}

.codebridge-tool__io-divider {
  flex: none;
  height: 0.5px;
  background: var(--dsw-alias-border-l2);
}

.codebridge-tool__text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}

.codebridge-tool__inspect {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  margin: 4px 0 2px 4px;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 100ms ease;
}

.codebridge-tool__inspect:focus-visible {
  opacity: 1;
}

@media (hover: hover) {
  .codebridge-tool:hover .codebridge-tool__inspect {
    opacity: 1;
  }

  .codebridge-tool__inspect:hover {
    background: var(--dsw-alias-interactive-bg-hover-solid);
    color: var(--dsw-alias-label-primary);
  }
}

@media (hover: none) {
  .codebridge-tool__inspect { opacity: 1; }
}
`

export const SETTINGS_STYLES = `
.codebridge-settings h4 {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
}
.codebridge-settings p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.codebridge-settings > p { margin-top: 12px; }
.codebridge-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.codebridge-settings__copy { min-width: 0; }
.codebridge-settings__copy label {
  display: block;
  width: fit-content;
  margin-bottom: 4px;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}
.codebridge-settings__copy p + p { margin-top: 4px; }
.codebridge-settings__switch {
  display: grid;
  flex: none;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.codebridge-settings__switch span {
  display: flex;
  align-items: center;
  width: 36px;
  height: 20px;
  padding: 2px;
  box-sizing: border-box;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
}
.codebridge-settings__switch span::before {
  content: '';
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-switch-thumb);
}
.codebridge-settings__switch[aria-checked='true'] span {
  justify-content: flex-end;
  background: var(--dsw-alias-brand-primary);
}
.codebridge-settings__switch[aria-checked='true'] span::before {
  background: var(--dsw-alias-label-primary-foreground);
}
.codebridge-settings__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding-top: 10px;
}
.codebridge-settings__footer p[data-result='failed'] { color: var(--dsw-alias-state-error-primary); }
.codebridge-settings__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
  margin-inline-start: auto;
}
.codebridge-settings__actions button {
  min-height: 28px;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-primary);
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.codebridge-settings__actions button[type='submit'] {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-button-primary-fill);
}
@media (hover: hover) {
  .codebridge-settings__actions button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  .codebridge-settings__actions button[type='submit']:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
}
.codebridge-settings button:disabled { cursor: default; opacity: 0.45; }
.codebridge-settings button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
`

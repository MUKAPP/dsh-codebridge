export interface FormattedCode {
  code: string
  failed: boolean
}

/** Format display text only; the recorded and executed source stays untouched. */
export async function formatCode(source: string): Promise<FormattedCode> {
  try {
    const { format } = await import('prettier/standalone')
    const { default: typescript } = await import('prettier/plugins/typescript')
    const { default: estree } = await import('prettier/plugins/estree')
    const code = await format(source, {
      parser: 'typescript',
      plugins: [typescript, estree],
      tabWidth: 2,
      useTabs: false,
      singleQuote: true,
      semi: true,
      printWidth: 100,
      endOfLine: 'lf',
    })
    return { code, failed: false }
  } catch {
    // Invalid/incomplete REPL source must remain readable, not fail the Tool view.
    return { code: source, failed: true }
  }
}

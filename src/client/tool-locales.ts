export const TOOL_LOCALE = 'codebridge.tool'

export const toolZh = {
  input: '输入',
  output: '输出',
  failed: '调用失败',
  stopped: '已取消',
  unformatted: '未格式化，显示原始代码',
  inspect: '查看调用',
  copy: '复制',
  copied: '已复制',
  code: '代码',
  wrap: '自动换行',
  unwrap: '取消自动换行',
}

export type ToolLocaleKey = keyof typeof toolZh

export const toolEn: Record<ToolLocaleKey, string> = {
  input: 'Input',
  output: 'Output',
  failed: 'Call failed',
  stopped: 'Cancelled',
  unformatted: 'Formatting unavailable; showing original code',
  inspect: 'Inspect call',
  copy: 'Copy',
  copied: 'Copied',
  code: 'Code',
  wrap: 'Wrap lines',
  unwrap: 'Unwrap lines',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'codebridge.tool': ToolLocaleKey
  }
}

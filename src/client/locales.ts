export const NS = 'codebridge.progress'

export const zh = {
  title: 'CodeBridge',
  cancelling: '取消中',
  currentTool: '当前工具：{tool}',
  counts: '已提交 {submitted} · 已完成 {completed} · 失败 {failed}',
}

export type ProgressKey = keyof typeof zh

export const en: Record<ProgressKey, string> = {
  title: 'CodeBridge',
  cancelling: 'Cancelling',
  currentTool: 'Current tool: {tool}',
  counts: 'Submitted {submitted} · Completed {completed} · Failed {failed}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'codebridge.progress': ProgressKey
  }
}

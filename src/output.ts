import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { PtcRunSandbox } from '@deepseek-ai/dsh-ptc-runtime'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-spill'
import { renderJson } from './json.js'

export const DEFAULT_INLINE_BYTES = 32 * 1024
export const MAX_INLINE_BYTES = 256 * 1024

export interface OutputPreview {
  text: string
  locator: string
  bytes: number
  retrievalHint: string
}

export const previewSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    locator: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    retrievalHint: { type: 'string', required: true },
  },
} as const

export interface ExecutionOutput {
  logs: string[]
  result?: JsonValue
  sandbox?: PtcRunSandbox
  preview?: OutputPreview
}

/** 小结果保持可直接阅读的原文；日志和返回值同时存在时明确分区。 */
export function renderExecutionOutput(value: ExecutionOutput): string {
  if (value.preview !== undefined) return renderPreview(value.preview)
  const chunks: string[] = []
  if (value.logs.length > 0) chunks.push(`${value.result === undefined ? '' : '日志：\n'}${value.logs.join('\n')}`)
  if (value.result !== undefined) {
    const result = typeof value.result === 'string' ? value.result : renderJson(value.result)
    chunks.push(`${value.logs.length === 0 ? '' : '返回值：\n'}${result}`)
  }
  if (value.sandbox?.enforcement === 'partial') chunks.push('当前宿主仅部分实施文件沙箱限制。')
  if (value.sandbox?.denied) chunks.push(`文件操作被 ${value.sandbox.mode} 沙箱拒绝。`)
  return chunks.join('\n') || '代码执行完成，无输出。'
}

export function renderPreview(preview: OutputPreview): string {
  return `以下仅为文本预览，不是完整 JSON：\n${preview.text}\n完整 JSON（${preview.bytes} 字节）：${preview.locator}\n${preview.retrievalHint}\n可在当前权限允许时读取完整 JSON，并筛选需要的字段；不要为获取输出而重新执行原操作。`
}

/** 按 UTF-8 字节保留首尾，不在多字节字符中间切断。预算不包含提示文字。 */
function previewText(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8')
  let headEnd = Math.floor(limit * 0.75)
  while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd--
  let tailStart = bytes.length - (limit - headEnd)
  while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart++
  return `${bytes.subarray(0, headEnd).toString('utf8')}\n…（省略 ${tailStart - headEnd} 字节展示文本）…\n${bytes.subarray(tailStart).toString('utf8')}`
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new HarnessError('代码执行已取消。', TOOL_ABORTED)
}

/** 原文可恢复才缩短展示；不替换执行期规范值，也不创建自有结果仓库。 */
export async function preparePreview(
  ctx: Context, exec: ToolRunContext, signal: AbortSignal,
  text: string, value: JsonValue, limit: number,
): Promise<OutputPreview | undefined> {
  if (Buffer.byteLength(text, 'utf8') <= limit) return undefined
  throwIfCancelled(signal)
  const store = ctx.get('spillStore')
  if (store === undefined) {
    ctx.logger.warn('CodeBridge 输出超过预览预算，但未挂载 spillStore；保留完整输出。')
    return undefined
  }
  try {
    const ref = await store.saveText({
      owner: { sessionId: exec.agent!.session.id },
      source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
      suggestedName: 'codebridge-output.json',
      content: renderJson(value),
    })
    throwIfCancelled(signal)
    return { text: previewText(text, limit), locator: ref.locator, bytes: ref.bytes, retrievalHint: ref.retrievalHint }
  } catch (error) {
    throwIfCancelled(signal)
    ctx.logger.warn('CodeBridge 完整输出保存失败，保留原文：%s', String(error))
    return undefined
  }
}

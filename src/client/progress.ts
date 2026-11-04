import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Full durable snapshot emitted by the Host's plugin:codebridge/progress event. */
export interface ProgressSnapshot {
  callId: string
  rootCallId: string
  description: string
  stage: string
  submitted: number
  completed: number
  failed: number
  currentTool?: string
  cancelled: boolean
  finished: boolean
}

interface ProgressState {
  readonly anchorSeq: number
  readonly snapshot: ProgressSnapshot
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'codebridge-progress': ProgressSnapshot
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Session data can outlive this plugin version; ignore malformed snapshots. */
function snapshotOf(event: { readonly type: string; readonly data: unknown }): ProgressSnapshot | undefined {
  if (event.type !== 'plugin:codebridge/progress' || event.data === null || typeof event.data !== 'object') return undefined
  const data = event.data as Record<string, unknown>
  if (typeof data.callId !== 'string' || data.callId === ''
    || typeof data.rootCallId !== 'string' || data.rootCallId === ''
    || typeof data.description !== 'string' || typeof data.stage !== 'string'
    || !isCount(data.submitted) || !isCount(data.completed) || !isCount(data.failed)
    || (data.currentTool !== undefined && typeof data.currentTool !== 'string')
    || typeof data.cancelled !== 'boolean' || typeof data.finished !== 'boolean') return undefined
  return {
    callId: data.callId,
    rootCallId: data.rootCallId,
    description: data.description,
    stage: data.stage,
    submitted: data.submitted,
    completed: data.completed,
    failed: data.failed,
    currentTool: data.currentTool,
    cancelled: data.cancelled,
    finished: data.finished,
  }
}

function requireSnapshot(match: ConversationMatch): ProgressSnapshot {
  const snapshot = snapshotOf(match.event)
  if (snapshot === undefined) throw new Error('CodeBridge progress requires a valid progress snapshot')
  return snapshot
}

function interruptedCallId(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'tool/result' || event.data === null || typeof event.data !== 'object') return undefined
  const data = event.data as Record<string, unknown>
  if (data.error === null || typeof data.error !== 'object') return undefined
  const error = data.error as Record<string, unknown>
  if (error.code !== 'TOOL_OUTCOME_UNKNOWN') return undefined
  if (data.message === null || typeof data.message !== 'object') return undefined
  const message = data.message as Record<string, unknown>
  if (message.source === null || typeof message.source !== 'object') return undefined
  const source = message.source as Record<string, unknown>
  return typeof source.callId === 'string' && source.callId !== '' ? source.callId : undefined
}

function interruptedSnapshot(previous: ProgressSnapshot): ProgressSnapshot {
  if (previous.finished) return previous
  return {
    ...previous,
    stage: '执行已中断，最终结果和收尾情况未知',
    cancelled: true,
    finished: true,
    currentTool: undefined,
  }
}

export const progressDefinition: ConversationNodeDefinition<ProgressState> = {
  kind: 'codebridge-progress',
  target: 'chat',
  match(event) {
    const snapshot = snapshotOf(event)
    // Any snapshot can initialize a partially loaded history window.
    if (snapshot !== undefined) return { id: snapshot.callId, role: 'start' }
    const callId = interruptedCallId(event)
    return callId === undefined ? null : { id: callId, role: 'update' }
  },
  start(_context, match) {
    return { anchorSeq: match.event.seq, snapshot: requireSnapshot(match) }
  },
  update(context, match) {
    const snapshot = snapshotOf(match.event)
    return { anchorSeq: context.state.anchorSeq, snapshot: snapshot ?? interruptedSnapshot(context.state.snapshot) }
  },
  buildViewNode(context): ChatNode<'codebridge-progress'> | null {
    if (context.state === undefined) return null
    return {
      key: context.key,
      id: context.id,
      kind: 'codebridge-progress',
      target: 'chat',
      anchorSeq: context.state.anchorSeq,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      groupTree: 'process',
      data: context.state.snapshot,
    }
  },
}

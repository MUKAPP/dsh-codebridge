import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PtcRunFailure } from '@deepseek-ai/dsh-ptc-runtime'

const FAILURE_HINTS: Record<PtcRunFailure['kind'], string> = {
  exception: '检查原始异常中的代码或子工具错误；已完成的操作不会回滚。',
  timeout: '减少本次工作量，或在运行时上限内调整 timeoutMs；重试前核查已完成的操作。',
  abort: '执行已停止；如需继续，请先核查已有操作的结果。',
  'worker-exit': '运行进程意外退出；检查资源占用与宿主运行时日志。',
  'invalid-output': '最终结果值必须是无损 JSON；请转换对象字段中的 undefined、BigInt、循环引用等不支持的值。',
  'output-limit': '减少 console 输出和返回数据；maxInlineBytes 只控制展示，不能提高运行时硬上限，超限原文不保证可恢复。',
  protocol: '检查宿主运行时日志及插件兼容版本。',
  'sandbox-unavailable': '检查当前文件权限策略及运行时支持；环境诊断可用 codebridge_tools({diagnostics:true})。',
}

export function runtimeFailureText(failure: PtcRunFailure, callId: string): string {
  return `代码执行失败（${failure.kind}）：${failure.message}\n阶段：运行程序；调用：${callId}\n${FAILURE_HINTS[failure.kind]}`
}

/** resolve/run 拒绝是运行时契约或启动失败，与程序返回的 failure.kind 区分。 */
export function stageFailure(stage: string, callId: string, error: unknown): HarnessError {
  return new HarnessError(
    `CodeBridge ${stage}失败；调用：${callId}；${error instanceof Error ? error.message : String(error)}`,
    'CODEBRIDGE_SETUP_FAILED',
  )
}

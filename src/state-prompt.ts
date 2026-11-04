import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Config } from './config.js'

export const STATE_MODE_CONTEXT = 'codebridge:execution-state'

/** 当前配置只说明状态模型，不保证历史绑定仍存在。 */
export function executionStateText(config: Config): string {
  const retain = config.retainSessionState.get()
  const restore = config.restoreOnRestart.get()
  const retention = retain
    ? '会话状态：开启（有状态）。同一会话的 codebridge_exec 调用可以复用变量、函数、导入和中间结果；避免重复声明已有的 const/let，优先复用绑定或使用新名称。'
    : '会话状态：关闭（无状态）。每次 codebridge_exec 都在全新环境中执行，不保留上次调用的变量、函数或导入；每次代码必须自包含，不能依赖前一次绑定。'
  const recovery = !restore
    ? '重启恢复：关闭。重启或重载后，不应假设之前的进程内绑定仍然存在。'
    : !retain
      ? '重启恢复：设置已开启，但会话状态保留已关闭，因此恢复不生效；不要依赖旧快照中的变量。'
      : '重启恢复：开启，仅自动恢复受支持的顶层 JSON 数据变量，不恢复函数、模块实例或句柄，不重跑历史代码。恢复范围以工具结果及 snapshot 的 saved/restored/omitted/warning 为准，不能假设所有绑定都已恢复。'
  return [
    'CodeBridge 代码执行状态（当前配置；替代此前同名状态提示）：',
    retention,
    recovery,
    '修改任一状态设置后，下一次调用会清空旧执行环境与恢复基线；失败、取消或超时也可能使状态失效。不要仅根据对话历史假设旧变量仍存在，以当前提示和实际工具结果为准。',
  ].join('\n')
}

/** 动态上下文在模型组装和请求准入时读取最新设置，注册随插件释放。 */
export function registerStateModePrompt(ctx: Context, config: Config): void {
  ctx.systemPrompt.context({
    name: STATE_MODE_CONTEXT,
    order: 130,
    required: true,
    interpolate: false,
    text: () => executionStateText(config),
  })
}

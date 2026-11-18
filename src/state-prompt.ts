import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Config } from './config.js'
import type { CallLifecycle } from './lifecycle.js'
import type {} from '@deepseek-ai/dsh-agent'

export const STATE_MODE_CONTEXT = 'codebridge:execution-state'

/** 当前环境和恢复设置，不保证历史绑定仍存在。 */
export function executionStateText(config: Config, retained?: boolean): string {
  const restore = config.restoreOnRestart.get()
  const retention = retained === undefined
    ? '会话状态：按次决定，以最近一次非隔离调用的 stateRetained 为准。'
    : retained
      ? '会话状态：已保留执行环境。可以复用变量、函数、导入和中间结果；避免重复声明已有的 const/let，优先复用绑定或使用新名称。'
      : '会话状态：当前没有可续用的执行环境。不要依赖旧的函数、导入或进程句柄；未开启重启恢复时，每次代码必须自包含。'
  const recovery = restore
    ? '重启恢复：开启，仅自动恢复受支持的顶层 JSON 数据变量，不恢复函数、模块实例或句柄，不重跑历史代码。恢复范围以工具结果及 snapshot 的 saved/restored/omitted/warning 为准，不能假设所有绑定都已恢复。'
    : '重启恢复：关闭。重启或重载后，不应假设之前的进程内绑定仍然存在。'
  return [
    'CodeBridge 代码执行状态（当前环境与恢复设置；替代此前同名状态提示）：',
    retention,
    recovery,
    '修改重启恢复设置不影响隔离调用；在共享模式下，下一次调用会清空旧执行环境与恢复基线；失败、取消、超时或运行时重启也可能使状态失效。不要仅根据对话历史假设旧变量仍存在，以实际工具结果为准。',
  ].join('\n')
}

/** 动态上下文在模型组装和请求准入时读取最新设置，注册随插件释放。 */
export function registerStateModePrompt(ctx: Context, config: Config, lifecycle: CallLifecycle): void {
  ctx.systemPrompt.context({
    name: STATE_MODE_CONTEXT,
    order: 130,
    required: true,
    interpolate: false,
    text: ({ agent }) => executionStateText(config, agent === undefined ? undefined : lifecycle.hasRetainedState(agent.session)),
  })
}

# 状态管理、重启恢复与运行时配置

> 返回 [README](../README.md) · 相关文档：[工具参考与用法](tools-reference.md) | [开发与发布](development-and-release.md)

本文档说明 CodeBridge 的会话状态模型、动态状态提示、重启 JSON 数据快照恢复机制，以及 `codebridge-runtime` 组合包配置与升级注意事项。

---

## 会话状态模型

CodeBridge 为每个会话维护一个专用的共享 Node TypeScript REPL（`persistent-in-memory`）。每次调用 `codebridge_exec` 时，模型可通过参数组合控制状态行为：

| 模式 | 参数组合 | 读取共享状态 | 结束后保留共享状态 | 影响重启快照基线 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| 默认收尾 | `retainState: false`（默认） | 是 | 否（释放共享环境） | 清除恢复基线 | 单次编排，或多步流程的最后一步 |
| 保留续用 | `retainState: true` | 是 | 是 | 开启恢复时更新快照 | 多步连续处理，复用变量、函数与导入 |
| 临时隔离 | `isolated: true` | 否 | 不影响原共享环境 | 不读写、不清除 | 中途穿插一次性独立任务，结束后继续原上下文 |
| 重置再执行 | `resetState: true` | 否（先释放再执行） | 取决于 `retainState` | 先清除旧基线 | 清理污染变量、损坏快照或从干净环境重来 |

> `isolated: true` 不能与 `retainState: true` 或 `resetState: true` 同时使用，且不会改变当前工作目录、工具权限或文件沙箱。

### 多步状态流转示例

1. **第一步（保留状态）**：传入 `retainState: true` 准备数据与辅助函数：

```js
const values = [12, 8, 5]
function total() { return values.reduce((sum, value) => sum + value, 0) }
total()
```

2. **中途穿插隔离调用**：传入 `isolated: true` 执行独立脚本（例如 `const values = [1, 2]; values.length`），不会覆盖共享环境中的 `values`。
3. **最后一步（释放状态）**：切回共享调用并保持默认 `retainState: false`，复用最初的 `values` 完成计算并释放环境：

```js
values.filter(value => value >= 8).map(value => value * 2)
```

---

## 动态代码执行状态提示

每次模型请求前，插件通过系统提示上下文（`codebridge:execution-state`）自动注入当前的 **CodeBridge 代码执行状态**：

- 实时反映当前会话是否存在可续用的共享执行环境，以及 `restoreOnRestart` 是否开启。
- 每次调用保留或释放状态、或热更新恢复设置后，后续请求立即读取最新状态，无需模型主动调用诊断。
- 即使关闭宿主的可选运行时上下文，该提示也会保留（`required: true`）。
- 提示仅描述当前环境与恢复设置，不保证对话历史中的旧变量仍存在，实际状态以工具返回结果为准。

---

## 重启后恢复（JSON 数据快照）

默认情况下，`retainState: true` 仅在当前进程内保留会话环境。在 **插件 → CodeBridge → 设置** 中开启 **重启后恢复**（`restoreOnRestart: true`）并点击 **保存更改** 后，插件会额外在会话持久化记录中保存受支持的顶层 JSON 数据变量。

### 工作机制

- **追踪范围**：从新环境中的 `retainState: true` 调用开始，自动追踪顶层 `const`、`let`、`var` 声明（包含解构声明），并在后续保留调用中更新已追踪变量的快照。
- **仅恢复数据，不重跑代码**：进程重启后，插件按原变量名将最近一次有效快照注入新 REPL，**不会重新执行历史代码**，因此不会触发重复的工具调用、文件写入或网络请求。
- **单次上限**：每次快照的完整持久化记录上限为 **1 MiB**。超出上限时会返回警告并使旧快照失效，避免后续误将过期数据当作最新状态恢复。

### 支持与不支持的值类型

| 类别 | 具体范围 | 处理方式 |
| --- | --- | --- |
| 支持恢复 | 有限数字、字符串、布尔值、`null`、普通 JSON 数组与普通数据对象 | 序列化保存并在重启后按原变量名恢复 |
| 不支持恢复 | 函数、模块导入、类实例、Promise、进程句柄、getter、Proxy、循环引用或共享引用 | 列入 `snapshot.omitted`，不保存也不恢复 |
| 不自动追踪 | 嵌套块级作用域内的变量、直接挂载到 `globalThis` 的属性 | 不纳入快照追踪 |

> 不能把未出现在 `snapshot.omitted` 中的外部进程资源或句柄当作仍然存活。

### `snapshot` 返回字段说明

| 字段 | 说明 |
| --- | --- |
| `saved` | 仅在快照写入会话日志、刷新完成并通过回读校验后为 `true`。 |
| `restored` | 本次执行前从快照恢复并注入环境的变量名列表；没有恢复变量时可能为空数组。 |
| `omitted` | 本次被跳过、未纳入快照的顶层绑定名称列表。 |
| `warning` | 说明旧基线失效、快照未保存或未保证持久化的具体原因。 |

### 失效与异常保护规则

- **切换恢复设置**：开启或关闭 `restoreOnRestart` 后，会在各会话下一次非隔离调用前释放旧环境并清除恢复基线，防止重新打开开关时复活旧数据。
- **会话权限或工作区变化**：若当前会话的文件沙箱策略或工作区根目录发生变化，仅当前会话的旧环境与不兼容基线失效；清除成功后从新环境执行并在结果中提示。
- **非隔离调用失败或取消**：已开始执行的非隔离调用若失败或被取消，会使旧恢复基线失效，防止后续从不一致状态恢复。
- **快照保存失败不重跑**：用户代码已执行成功但快照保存失败时，不会自动重跑；若捕获快照期间运行环境失效，则返回 `stateRetained: false` 并保留已完成的日志与结果。不要为获取快照而重复执行带有副作用的操作。
- **损坏快照处理**：遇到损坏快照时，直接在该会话执行 `resetState: true` 即可清除，无需关闭全局恢复开关。

### 数据隐私与持久性提示

- 快照随会话日志一起存储，可能包含代码读取到的文件或工具数据；开启前请确认当前环境适合保存这些数据。
- 关闭恢复会停止后续保存并清除恢复基线，但**不会物理删除**历史会话日志中已记录的旧快照数据。
- 会话文件删除或损坏、权限策略变化或超过 1 MiB 限制均可能导致数据无法恢复。

---

## 组合包结构与运行时配置

[cordis.patch.yml](../cordis.patch.yml) 将 `dsh-codebridge` 定义为包含两个条目的组合包，两者共享专用的 `ptcRuntime` 命名隔离（`dsh-codebridge-runtime`），其余服务继续继承宿主：

- `codebridge`（`dsh-codebridge`）：工具注册、状态生命周期、快照存储与动态提示。
- `codebridge-runtime`（`@deepseek-ai/dsh-ptc-runtime-node`）：专用官方 Node TypeScript REPL 运行时。

这种隔离确保即使同时安装了 PTC Plus 或其他接管公共 `ptcRuntime` 的插件，CodeBridge 仍保有独立的超时、输出上限与沙箱能力。

### `codebridge-runtime` 运行限额

可在插件配置中调整 `codebridge-runtime` 的运行参数：

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `executionMode` | `persistent-in-memory` | 每个会话维持一个专用 Node REPL（CodeBridge 必需项） |
| `timeoutMs` | `120000` | 默认单次执行超时（毫秒） |
| `maxTimeoutMs` | `600000` | 单次调用允许传入的 `timeoutMs` 上限（毫秒） |
| `maxOutputBytes` | `67108864` | 日志与结果的合计输出硬上限（64 MiB） |

### 运行时硬性要求与单文件宿主适配

- **禁止切回 `per-call`**：CodeBridge 要求 `codebridge-runtime` 保持 `executionMode: persistent-in-memory` 且 `programFormat: "repl"`。若手动改为 `per-call`，`codebridge_tools({ diagnostics: true })` 会报告 `configurationReady: false`，`codebridge_exec` 也会直接拒绝执行，避免将 REPL 末尾表达式误交给函数体运行时。
- **单文件 DSH 宿主（`process.pkg`）**：当前组合包验证覆盖标准 Electron / Node 宿主。若运行在带 `process.pkg` 的单文件 DSH 宿主中，官方 runtime 额外要求将持久 worker 配置为 `node-script`，并提供外部 Node 可执行文件路径与 `process.js` bootstrap，请按实际宿主部署方式补充配置。

### 升级与卸载

- **升级**：必须重新加载整个 `dsh-codebridge` 组合包，确保工具与专用运行时同步更新；仅刷新浏览器不会替换 Host runtime。
- **卸载**：关闭或移除整个组合包，并等待正在进行的会话资源释放完成。

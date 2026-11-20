# 工具参考与用法

> 返回 [README](../README.md) · 相关文档：[状态管理与运行时配置](state-and-recovery.md) | [开发与发布](development-and-release.md)

本文档涵盖 `codebridge_tools` 与 `codebridge_exec` 的完整参数、返回结构、大输出预览、环境诊断、长任务收尾、失败定位与 Web GUI 输入展示规则。

---

## `codebridge_tools`：工具发现与环境诊断

`codebridge_tools` 用于查询当前代理可见工具的摘要或完整结构，也可只读检查运行环境。该工具并发安全（`isConcurrencySafe`），不会执行代码或启动运行时进程。

### 参数说明

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `names` | `string[]` | — | 精确工具名称列表（自动去重）。默认返回完整结构；与非空 `query` 互斥，且忽略 `offset`/`limit`。 |
| `query` | `string` | — | 不区分大小写的名称或描述子串（去除首尾空白后匹配）。单独传入 `""` 浏览全部可见工具；与 `diagnostics: true` 同传且未指定名称时，只返回诊断。搜索默认仅返回摘要并按名称排序。 |
| `detail` | `"summary" \| "full"` | `query` 默认 `"summary"`；`names` 默认 `"full"` | `summary` 仅返回 `name` 与 `description`；`full` 额外附带完整 `parameters` 与 `output` schema。 |
| `offset` | `integer` (`>= 0`) | `0` | 仅在 `query` 搜索模式下生效的分页起点；`names` 查询或仅诊断时忽略。 |
| `limit` | `integer` (`1–100`) | `20` | 仅在 `query` 搜索模式下生效的每页数量；`names` 查询或仅诊断时忽略。 |
| `diagnostics` | `boolean` | `false` | 附带只读环境诊断；可单独使用，也可与 `names` 或 `query` 组合。 |

调用时必须至少提供非空 `names`、`query`（可为空字符串）或 `diagnostics: true` 之一，且 `names` 中不能包含空白字符串。

### 搜索与查询规则

1. **搜索摘要**（不知道确切工具名时）：

```json
{ "query": "文件", "limit": 20 }
```

- 结果按名称字典序排列，`total` 表示匹配总数。
- 存在后续页时返回 `nextOffset`，使用相同 `query` 与该 `offset` 继续翻页。
- 每次查询均实时读取当前代理可见且可执行的工具集合，并遵守当前模型步骤的工具准入结果，不是固定快照。

2. **精确查询结构**（确认工具名后）：

```json
{ "names": ["working_directory"] }
```

- 匹配的可用工具写入 `tools`（默认含 `name`、`description`、`parameters`、`output`）；不可用或被排除的名称列入 `unavailable`。
- 名称查询允许附带空 `query`（`""`），并忽略 `offset` 与 `limit`，始终返回全部指定名称的查询结果。
- 所有查询始终排除不可见工具、`codebridge_exec`、`codebridge_tools` 与 `run_code`。

### 返回结构

以下为 `{ "query": "working_directory", "detail": "full" }` 只匹配一个工具时的结构示意：

```json
{
  "tools": [
    {
      "name": "working_directory",
      "description": "...",
      "parameters": {},
      "output": {}
    }
  ],
  "unavailable": [],
  "total": 1
}
```

- `total` 仅在 `query` 搜索时出现；`nextOffset` 仅在仍有下一页时出现；`diagnostics` 仅在 `diagnostics: true` 时出现。

---

## `codebridge_exec`：代码执行与工具编排

`codebridge_exec` 在当前会话的专用 Node TypeScript REPL 中执行代码，通过全局对象 `tools.<工具名>(参数)` 调用当前代理可见工具。

### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `code` | `string` | 是 | — | 非空 TypeScript REPL 源码；支持顶层 `await` 与最后一个表达式作为返回值，无需额外包裹函数。 |
| `description` | `string` | 是 | — | 非空任务简述，用于工具卡片与记录展示。 |
| `retainState` | `boolean` | 否 | `false` | `true` 时保留变量、函数与导入供后续调用复用；`false` 时本次仍可使用此前保留或恢复的数据，收尾后释放共享环境并清除恢复基线。 |
| `isolated` | `boolean` | 否 | `false` | `true` 时在独立临时 REPL 中运行，不读写或清除共享环境与重启快照，结束后丢弃临时状态。不能与 `retainState: true` 或 `resetState: true` 同用。 |
| `resetState` | `boolean` | 否 | `false` | `true` 时先释放本会话的共享 REPL 并清除重启恢复基线，再执行 `code`。清除失败时不会执行代码；不能与 `isolated: true` 同用。 |
| `timeoutMs` | `number` | 否 | 由运行时决定 | 正有限毫秒数，受 `codebridge-runtime` 的 `maxTimeoutMs` 上限约束。 |
| `maxInlineBytes` | `integer` | 否 | `32768` | 展示正文的 UTF-8 字节预算（范围 `1024–262144`），不含预览说明与取回提示。 |

### 执行与错误处理约定

- **规范 JSON 输入输出**：代码中通过 `tools.*` 收到的是子工具的规范 JSON 返回值，可能与原生工具展示给模型的文本不同。`console.log()` 写入 `logs`，最后一个表达式作为 `result`；最终返回值必须是无损 JSON（不能包含对象字段中的 `undefined`、`BigInt`、循环引用等不支持的值）。
- **子工具异常**：子工具失败时会向代码抛出可捕获的 `ToolCallError`，仅保证包含 `name`、`toolName`、`message` 字段；不提供代码侧 `error.code`，也不自动重试。
- **仅清除状态**：若只想清空当前会话状态而不执行实际逻辑，可传入 `resetState: true`、`code: "void 0"` 与默认 `retainState: false`。此操作不影响 profile 设置、其他会话或历史会话日志。

### 返回结构

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `stateRetained` | `boolean`（必填） | 本次成功调用结束后是否保留执行环境。隔离调用固定返回 `isolated: true`、`stateRetained: false`，仅代表临时环境已释放，不能据此判断共享环境不存在。 |
| `isolated` | `true`（可选） | 仅在 `isolated: true` 调用时返回。 |
| `logs` | `string[]`（必填） | 代码执行期间捕获的 `console.log` 输出。 |
| `result` | `JsonValue`（可选） | 最后一个表达式的无损 JSON 返回值；与 `logs` 同时存在时，展示文本会分区标明。 |
| `preview` | `object`（可选） | 展示正文超过 `maxInlineBytes` 且全文保存成功时返回，包含 `text`、`locator`、`bytes`、`retrievalHint`。 |
| `snapshot` | `object`（可选） | 重启恢复相关状态，包含 `saved`、`omitted`，以及可选的 `restored`、`warning`（详见 [状态管理与重启恢复](state-and-recovery.md)）。 |
| `sandbox` | `object`（可选） | 沙箱执行反馈，包含 `mode`（`read-only` / `workspace-write` / `danger-full-access`）、`denied` 与可选 `enforcement`（`full` / `partial`）。 |

---

## 大输出与全文访问

当渲染后的展示正文超过 `maxInlineBytes`（默认 `32768` 字节，即 32 KiB，可设 `1024–262144`）时：

1. 插件调用宿主挂载的 `spillStore` 保存完整 JSON（包含 `logs`、`result` 与可用的 `sandbox`/`snapshot` 信息；运行失败时保存运行时已返回的日志、错误与调用定位信息）。
2. 保存成功后，展示文本按 UTF-8 字节预算截取首尾（约前 75% 与后 25%，不在多字节字符中间切断），并附带 `locator`、完整文件 `bytes` 与 `retrievalHint`。
3. 规范返回值中的 `logs` 与 `result` **不会被截断**；但 `preview.text` 在中间省略了部分内容，**不能当作完整 JSON 解析**。
4. 后续可按 `locator` 与 `retrievalHint` 使用可用读取工具取回，或在权限允许时由后续代码读取并筛选，无需重新执行原操作。文件访问与保留期限由宿主策略决定。

**边界情况**：
- 若宿主未挂载 `spillStore` 或保存失败，插件会保留完整原文展示，并在宿主日志中记录原因。
- `maxInlineBytes` 仅控制展示裁剪，**不改变 `codebridge-runtime` 的 `maxOutputBytes` 硬上限**；运行时已拒绝的超限数据不保证可找回。

---

## 只读环境诊断

单独或配合工具查询调用 `codebridge_tools`：

```json
{ "diagnostics": true }
```

### 诊断字段说明

| 字段 | 含义 |
| --- | --- |
| `configurationReady` | 所有配置检查项均无问题时为 `true`；仅检查配置与声明能力，不启动进程、不校验目录存在性、不修改配置，也不证明沙箱完整隔离。 |
| `cwd` | 当前会话的工作目录路径。 |
| `outputStorageAvailable` | 宿主是否已挂载 `spillStore`（决定大输出能否保存全文并缩短预览）。 |
| `defaultMaxInlineBytes` | 默认展示字节预算（`32768`）。 |
| `sandboxMode` | 当前会话解析出的文件沙箱策略（`read-only` / `workspace-write` / `danger-full-access`）。 |
| `runtime.available` | CodeBridge 专用运行时是否已挂载。 |
| `runtime.language` / `programFormat` / `isolation` | 运行时语言（需为 `typescript`）、执行形式（需为 `repl`）与隔离类型。 |
| `runtime.stateRetention` | `model-controlled` 表示支持按次控制状态保留；已挂载但不是 REPL 的运行时返回 `call`。 |
| `runtime.stateRecovery` | `process-only` 表示未启用重启恢复；`json-snapshot` 表示已启用受限的 JSON 数据快照。 |
| `runtime.restoreOnRestart` | 当前 profile 的 `restoreOnRestart` 开关状态。 |
| `runtime.filePolicySupported` | 运行时是否支持实施文件沙箱策略。 |
| `runtime.timeout` | 运行时声明的 `{ defaultMs, maxMs }`（运行时硬输出上限需在 `codebridge-runtime` 配置中查看）。 |
| `issues` | 检测到的配置问题列表（如专用运行时缺失、非 REPL 模式、缺少持久化服务等）。 |
| `note` | 关于诊断范围和运行时配置的说明。 |

> 共享环境当前是否仍有保留状态，以最近一次非隔离调用的 `stateRetained` 和动态状态提示为准。专用运行时缺失时，应恢复整个 `dsh-codebridge` 组合包及其命名隔离配置；单独启用公共 Node 运行时无法修复。

---

## 长任务、取消收尾与失败定位

### 原生工具卡片与收尾语义

- 执行过程直接沿用 DSH 原生工具卡片与子调用树，CodeBridge 不向聊天流额外插入自定义运行状态块。
- 取消、超时或程序提前返回后，插件会停止新子调用，并等待运行时、在途子调用、日志以及已开始的全文保存收尾；`console.log` 在最终结果中统一返回，不是实时日志流。

### 失败定位与错误分类

外层失败报告会标明运行阶段（如解析工作目录、解析运行参数、启动或执行运行时、运行程序）、调用标识（`callId`）、运行时错误类别与处理建议；若存在失败的子调用，还会附带最近失败工具及子调用标识。

- 最近失败的子调用可能已被代码 `try/catch` 捕获，不一定是导致外层异常的直接原因。
- 子调用管线错误或会话持久记录失败仍会使整次执行失败。
- 所有已发生的外部副作用都不会回滚，重试前应先核查实际结果。

下表说明运行时失败类别（`failure.kind`）是否会强制释放共享 REPL。默认的 `retainState: false` 仍会释放环境；开启重启恢复时，已开始执行的失败调用会使旧恢复基线失效。

| `failure.kind` | 是否强制释放共享 REPL | 典型原因 |
| --- | --- | --- |
| `exception` | 否 | 用户代码抛出未捕获异常或子工具报错 |
| `invalid-output` | 否 | 最后一个表达式不是无损 JSON |
| `timeout` | 是 | 超出 `timeoutMs` 限制 |
| `abort` | 是 | 会话或工具调用被取消 |
| `worker-exit` | 是 | Node 运行时子进程意外退出 |
| `output-limit` | 是 | 超过 `codebridge-runtime` 的 `maxOutputBytes` 硬上限 |
| `protocol` | 是 | 宿主运行时协议通信异常或版本不兼容 |
| `sandbox-unavailable` | 是 | 当前运行时无法实施会话沙箱策略 |

---

## Web GUI 调用输入展示

在 Web GUI 中展开 `codebridge_exec` 工具卡片时：

- **代码渲染**：输入区直接显示 `code` 字段，提供 TypeScript 语法高亮、行号、复制与自动换行控件；长代码可在输入区内滚动查看。
- **非默认选项标识**：输入标题旁仅显示非默认执行选项（如 `retainState`、`isolated`、`resetState`、`timeoutMs`、`maxInlineBytes`）。
- **按需格式化**：首次展开代码时懒加载独立格式化模块（Prettier TypeScript parser），按 2 空格缩进、单引号、保留分号、行宽 100 与 LF 换行格式化。
- **无副作用与降级**：格式化仅影响前端展示，不修改实际执行的源码或历史调用记录，也不读取项目的 Prettier 配置。加载期间先展示原文；若模块不可用或源码语法不完整导致无法格式化，继续以原文高亮展示并给出提示。缺少字符串 `code` 或参数 JSON 无法解析时回退为原始输入视图。
- **范围限制**：输出、失败报告与子调用树保持可读；`codebridge_tools` 与其他原生工具的展示方式不变。插件更新后需重新加载插件并刷新 Web 页面，才能加载新版输入视图。

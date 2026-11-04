<img src="icon.svg" width="64" height="64" alt="CodeBridge">

# CodeBridge

让 **DSH 标准模式**也能用代码调用工具：执行 JavaScript / TypeScript，在同一会话中保留变量、函数、导入和中间结果，通过 `tools.*` 完成多步操作，再把需要的结果返回给模型。原有工具仍可直接调用。

**兼容 DSH `0.2.1-rc.5` · Node.js `>=24.9.0` · MIT**

## 安装

在 DSH 的**插件 → 添加插件**中输入 GitHub 地址：

```text
https://github.com/MUKAPP/dsh-codebridge.git
```

安装时会从源码编译插件。如果管理器提示构建脚本待批准，核对本仓库的编译脚本后选择允许并重试；`prepare` 和 `prepack` 会编译 Host 与 Web 客户端。安装完成后按管理器提示启用或重启 DSH。仅刷新浏览器页面不会重新加载 Host 插件。

命令行用户也可安装到指定 profile，以下以 `web` 为例：

```sh
dsh plugin --profile web add https://github.com/MUKAPP/dsh-codebridge.git
```

安装会影响使用该 profile 的所有会话。当前只声明支持上述 DSH 版本，其他版本需先适配，不能靠忽略版本检查保证兼容。

## 能做什么

- **会话级持久 REPL**：同一会话的变量、函数、导入和中间结果可在后续代码调用中继续使用；不同会话彼此隔离。
- **用代码串联工具**：支持条件判断、循环、结果筛选和汇总，减少模型往返与中间结果回传。
- **先搜索摘要，再查结构**：按名称或描述筛选当前可用工具，再按需获取参数和规范返回值 schema；也可只读检查环境。
- **按任务复杂度选择调用方式**：单步读取、写入或查询直接调用原生工具；需要两个或更多工具、循环、条件判断、批量筛选、分页处理或汇总时，先查询结构，再优先用 `codebridge_exec` 编排。
- **执行与取消反馈**：显示当前工具、已提交和已完成情况，区分等待工具、日志收尾与执行结束。
- **可恢复的大输出预览**：全文保存成功后缩短展示，保留规范 JSON，并给出取回位置。
- **沿用当前会话权限**：每个子调用经过 DSH 工具管线，保留可见性检查、审批、取消和调用记录。
- **与 PTC Plus 共存**：使用专用官方 Node 运行时，避免公共运行时被接管后丢失超时或沙箱能力。

标准模式的工具 schema 仍会保留，CodeBridge 不承诺固定的 token 节省比例。

## 工具与用法

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `codebridge_exec` | `code`、`description`、可选 `timeoutMs`、`maxInlineBytes` | 执行代码并返回日志与结果，大输出可预览并保留全文 |
| `codebridge_tools` | `names` 或 `query`，可选 `detail`、`offset`、`limit`、`diagnostics` | 搜索摘要、按需查询完整结构或只读检查环境 |

### 先查询，再调用

不知道工具名时，先让模型调用 `codebridge_tools` 搜索名称或描述：

```json
{ "query": "文件", "limit": 20 }
```

搜索不区分大小写，按去除首尾空白后的子串匹配；`query: ""` 浏览全部可见工具。默认仅返回名称和说明，不附带参数与返回结构。结果按名称排序，`total` 是匹配总数；有后续页时返回 `nextOffset`，以相同查询和该 `offset` 继续。`limit` 默认为 20，范围 1–100，`offset` 默认为 0。每次查询使用当时的可见工具集合，不是固定快照。

找到目标后，用精确名称查询完整结构，例如：

```json
{ "names": ["working_directory"] }
```

`names` 查询保留原有行为：`tools` 默认包含名称、说明、完整 `parameters` 和 `output`；`unavailable` 列出不可用名称。可用 `detail: "summary"` 或 `detail: "full"` 显式选择返回内容。`names` 与 `query` 互斥，分页参数只用于搜索；`diagnostics: true` 可单独请求或与任一查询组合。查询始终排除不可见工具、CodeBridge 自身和 `run_code`。确认参数后，即可调用 `codebridge_exec`：

```json
{
  "description": "读取当前工作目录",
  "code": "const directory = await tools.working_directory({}); directory",
  "timeoutMs": 10000
}
```

`code` 是 TypeScript REPL 源码，支持顶层 `await` 和最后一个表达式，同一会话中的声明与导入可被后续调用复用，无需再包一层函数。工具名与返回结构以当前会话查询结果为准；代码收到的是工具的规范 JSON，可能与原生工具展示的文本不同。子工具失败会抛出可捕获的 `ToolCallError`，包含 `name`、`toolName` 和 `message`。

例如第一次调用可以准备数据：

```js
const values = [12, 8, 5]
function total() { return values.reduce((sum, value) => sum + value, 0) }
total()
```

同一会话的下一次调用可以直接继续使用已有绑定：

```js
values.filter(value => value >= 8).map(value => value * 2)
```

会话状态只存在于当前 runtime 进程；插件重载、进程重启、权限变化、超时或部分运行时失败都可能清空它。文件写入、网络请求和其他外部副作用不会因为代码失败而回滚。

代码工具的规范返回值包含 `logs`，并可包含 `result`、`sandbox` 和 `preview`。`console.log()` 写入日志，最后一个表达式提供 `result`；返回值必须是无损 JSON。日志和返回值同时存在时，展示文本会分区标明。

### 大输出与全文访问

`maxInlineBytes` 控制展示正文的 UTF-8 字节预算，默认为 `32768`（32 KiB），允许 `1024`–`262144`，不含预览说明与取回提示。超过预算时，插件使用宿主已挂载的 `spillStore` 保存完整 JSON，再展示首尾预览。规范返回值中的 `logs`、`result` 不截断；新增的 `preview` 提供 `text`、`locator`、完整文件 `bytes` 和 `retrievalHint`。预览文本可能在 JSON 中间省略，不能当作完整 JSON 解析。

完整 JSON 包含日志、返回值及可用的沙箱信息；运行失败时保存运行时已返回的日志、错误及调用定位信息。按照 `locator` 和 `retrievalHint` 使用当前可用的读取工具取回；本地文件也可由后续代码在权限允许时读取并筛选。无需重新执行原操作。文件访问和保留期限仍由宿主策略决定。

未挂载全文存储或保存失败时，插件保留完整展示并在宿主日志说明原因。此预算不改变 `codebridge-runtime` 的 `maxOutputBytes` 硬上限；运行时已拒绝的超限数据不保证可以找回。

### 只读环境诊断

调用 `codebridge_tools`：

```json
{ "diagnostics": true }
```

也可同时传入 `names` 查询工具结构。返回的 `diagnostics` 包括当前目录、会话文件权限、专用运行时的语言/执行形式/隔离类型/状态保留范围/恢复限制/超时能力，以及全文存储是否已挂载。`stateRetention: "session"` 表示同一会话的代码调用共享运行环境；`stateRecovery: "process-only"` 表示状态不承诺跨进程恢复。`configurationReady` 仅表示这些配置检查未发现问题；不会启动进程、检查目录存在性、修改配置或证明沙箱完整隔离。输出硬上限请查看运行时配置。

专用运行时缺失时，应恢复整个 `dsh-codebridge` 组合包及其命名隔离配置；单独启用公共 Node 运行时可能无效。

### 长任务与取消收尾

Web 会话中的执行状态显示当前阶段、当前子工具以及已提交、已完成和失败数量。已完成数量包括返回失败的子调用，只有工具结果和日志均已处理后才计入；已提交不代表程序预计的总步骤，排队后被取消的调用不算已完成。原有子调用树仍保留每次调用的详细结果。

取消请求到达后，状态会标明取消中，并继续显示正在等待的工具或日志阶段；只有运行时、在途子调用、日志以及已开始的全文保存均结束后，才显示收尾已结束。超时和程序提前返回也会等待收尾。运行时 `console.log` 仍在最终结果中返回，不是实时日志流；此状态不会改变串行执行或取消语义。

进度记录用于界面呈现，不进入模型上下文；刷新后可从会话事件恢复。需要重新加载更新后的插件及其客户端扩展才能看到新状态。

### 失败定位

外层失败报告会标明运行阶段、调用标识、运行时错误类别和处理建议；存在失败子调用时，还会附最近失败工具及子调用标识。最近失败的子调用可能已经被代码捕获，不一定是最终异常的原因。子调用管线或持久记录失败仍会使整个执行失败。

`ToolCallError` 仍仅保证 `name`、`toolName`、`message`；不新增代码侧 `error.code`，不自动重试。已发生的操作不会回滚，重试前应核查其实际结果。

## 执行规则

- **子调用串行**：提交多个 Promise 也不代表工具并行。所有异步工具调用都要 `await`，程序结束时未完成的调用会被取消并等待收尾。取消或超时后仍需等待在途工具、日志及已开始的全文保存结束，`timeoutMs` 不代表包含这些收尾工作的总返回时限。
- **会话状态**：同一会话的代码调用共享变量和函数，但状态只存在于当前 runtime 进程；插件重载、进程重启、权限变化、超时或部分运行时失败都可能清空它。已发生的文件写入或外部请求不会因报错、超时而回滚。
- **遵守作用域**：只能调用当前代理可见工具，不提供递归调用 CodeBridge 或 `run_code` 的入口。代码工具本身没有提权参数。
- **沙箱沿用宿主**：Node 文件、网络和子进程操作受实际宿主策略约束。Windows 后端可能报告 `partial`，不能将其视为完整隔离。

## 配置与更新

组合包包含 `codebridge` 工具条目和 `codebridge-runtime` 运行时条目。运行时使用 `persistent-in-memory`，同一会话共享一个专用 Node REPL；两者仅共享专用的 `ptcRuntime` 命名隔离，其他服务继续继承宿主。

在插件配置中调整 `codebridge-runtime` 的运行限额：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `executionMode` | `persistent-in-memory` | 每个会话保留一个 Node REPL；进程重启后状态不恢复 |
| `timeoutMs` | `120000` | 默认执行超时，毫秒 |
| `maxTimeoutMs` | `600000` | 单次超时参数的上限，毫秒 |
| `maxOutputBytes` | `67108864` | 日志与结果的合计输出上限，64 MiB |

CodeBridge 要求 `codebridge-runtime` 保持 `persistent-in-memory` 和 `programFormat: "repl"`；手动改回 `per-call` 时，`codebridge_tools({ diagnostics: true })` 会报告配置未就绪，代码执行也会明确拒绝，避免把 REPL 末尾表达式误交给函数体 runtime。使用带 `process.pkg` 的单文件 DSH 宿主时，官方 runtime 还要求把持久 worker 配置为 `node-script`，并提供外部 Node executable 与 `persistent-process.js` bootstrap；当前组合包验证覆盖标准 Electron/Node 载体，单文件宿主需要按宿主部署方式补充这项 runtime 配置。

升级后必须重新加载整个 `dsh-codebridge` 组合包，使工具与专用运行时一起更新为持久模式；仅刷新浏览器不会更换 Host runtime。卸载时关闭或移除整个组合包，等待会话资源释放。

## 本地开发

使用 pnpm `11.28.5`。克隆仓库后，在项目目录执行：

```sh
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run build
pnpm test
```

构建结果位于 `lib/`；测试使用这些构建结果。完成构建后，可在 DSH 插件管理器中以本项目的绝对目录作为本地安装来源。生成安装包：

```sh
pnpm pack --pack-destination artifacts
```

[独立验证入口](verification/run.mjs) 接受 Node 或 Electron 可执行文件路径及对应的 `dsh` CLI 入口，Electron 额外传入 `--electron`。它通过公开 CLI 在 `verification/.profile` 下创建独立环境，不需要模型 API key，也不改动现有 desktop profile。

已有验证覆盖工具可见性、规范 JSON、串行调度、取消与卸载、会话隔离，以及真实 Node 子进程中的超时恢复、深层 JSON 和只读写入拒绝。开发规则见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE) © MUKAPP

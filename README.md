<img src="icon.svg" width="64" height="64" alt="CodeBridge">

# CodeBridge

让 **DSH 标准模式**也能用代码调用工具：执行 JavaScript / 可擦除 TypeScript，通过 `tools.*` 完成多步操作，再把需要的结果返回给模型。原有工具仍可直接调用。

**兼容 DSH `0.2.1-rc.5` · Node.js `>=24.9.0` · MIT**

## 安装

在 DSH 的**插件 → 添加插件**中输入 GitHub 地址：

```text
https://github.com/MUKAPP/dsh-codebridge.git
```

安装时会从源码编译插件。如果管理器提示构建脚本待批准，核对本仓库的编译脚本后选择允许并重试；`prepare` 和 `prepack` 都只执行 `tsc -p tsconfig.json`。安装完成后按管理器提示启用或重启 DSH。仅刷新浏览器页面不会重新加载 Host 插件。

命令行用户也可安装到指定 profile，以下以 `web` 为例：

```sh
dsh plugin --profile web add https://github.com/MUKAPP/dsh-codebridge.git
```

安装会影响使用该 profile 的所有会话。当前只声明支持上述 DSH 版本，其他版本需先适配，不能靠忽略版本检查保证兼容。

## 能做什么

- **用代码串联工具**：支持条件判断、循环、结果筛选和汇总，减少模型往返与中间结果回传。
- **按需查看工具结构**：查询参数和规范返回值 schema，避免猜测工具返回字段。
- **沿用当前会话权限**：每个子调用经过 DSH 工具管线，保留可见性检查、审批、取消和调用记录。
- **与 PTC Plus 共存**：使用专用官方 Node 运行时，避免公共运行时被接管后丢失超时或沙箱能力。

标准模式的工具 schema 仍会保留，CodeBridge 不承诺固定的 token 节省比例。

## 工具与用法

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `codebridge_exec` | `code`、`description`、可选 `timeoutMs` | 执行代码并返回日志与结果 |
| `codebridge_tools` | `names`：非空工具名数组 | 查询当前代理可见工具的输入和规范输出结构 |

### 先查询，再调用

让模型调用 `codebridge_tools` 查询目标工具，例如：

```json
{ "names": ["working_directory"] }
```

查询结果中，`tools` 包含名称、说明、`parameters` 和 `output`；`unavailable` 列出不可用名称。确认参数后，即可调用 `codebridge_exec`：

```json
{
  "description": "读取当前工作目录",
  "code": "const directory = await tools.working_directory({}); return directory;",
  "timeoutMs": 10000
}
```

`code` 是**异步函数体**，支持顶层 `await` 和 `return`，无需再包一层函数。工具名与返回结构以当前会话查询结果为准；代码收到的是工具的规范 JSON，可能与原生工具展示的文本不同。子工具失败会抛出可捕获的 `ToolCallError`，包含 `name`、`toolName` 和 `message`。

代码工具的规范返回值包含 `logs`，并可包含 `result` 和 `sandbox`。`console.log()` 写入日志，`return` 提供最终结果；返回值必须是无损 JSON。

## 执行规则

- **子调用串行**：提交多个 Promise 也不代表工具并行。所有异步工具调用都要 `await`，程序结束时未完成的调用会被取消并等待收尾。
- **每次独立执行**：不保留跨调用变量；已发生的文件写入或外部请求不会因报错、超时而回滚。
- **遵守作用域**：只能调用当前代理可见工具，不提供递归调用 CodeBridge 或 `run_code` 的入口。代码工具本身没有提权参数。
- **沙箱沿用宿主**：Node 文件、网络和子进程操作受实际宿主策略约束。Windows 后端可能报告 `partial`，不能将其视为完整隔离。

## 配置与更新

组合包包含 `codebridge` 工具条目和 `codebridge-runtime` 运行时条目。两者仅共享专用的 `ptcRuntime` 命名隔离，其他服务继续继承宿主。

在插件配置中调整 `codebridge-runtime` 的运行限额：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `timeoutMs` | `120000` | 默认执行超时，毫秒 |
| `maxTimeoutMs` | `600000` | 单次超时参数的上限，毫秒 |
| `maxOutputBytes` | `67108864` | 日志与结果的合计输出上限，64 MiB |

这些设置独立于公共 PTC 运行时。升级后需重新加载组合包；从 `0.1.0` 升级尤其需要加载新增的运行时隔离配置。卸载时在插件管理器中关闭或移除整个 `dsh-codebridge` 组合包，使工具和运行时一起停止。

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

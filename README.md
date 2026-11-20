<img src="icon.svg" width="64" height="64" alt="CodeBridge">

# CodeBridge

让 **DSH 标准模式**也能用代码调用工具：在专用的会话级 Node TypeScript REPL 中执行代码，由模型按次决定是否保留变量、函数、导入与中间结果，通过 `tools.*` 编排多步操作，再把需要的结果返回给模型。原有原生工具仍可直接调用。

**DSH 版本要求：`<0.3` · Node.js `>=24.9.0` · MIT**

## 核心能力

- **按任务复杂度选择调用方式**：单步读取、写入或查询直接调用原生工具；需要两个及以上工具、循环、条件判断、批量筛选、分页或汇总时，先查工具结构，再用 `codebridge_exec` 一次编排完成。
- **模型按次控制状态保留**：默认执行后释放环境；需要连续处理时传入 `retainState: true` 保留变量、函数与导入，最后一步释放；也支持临时隔离（`isolated: true`）与单会话重置（`resetState: true`）。
- **可选重启数据恢复**：按 profile 开启后，自动持久化受支持的顶层 JSON 数据变量，进程重启后按原变量名恢复，不重跑历史代码。
- **先搜索摘要，再查结构**：通过 `codebridge_tools` 按名称或描述筛选当前代理可见工具，按需获取参数与规范返回值 schema，或执行只读环境诊断。
- **可恢复的大输出预览**：展示正文超过字节预算时，通过宿主 `spillStore` 保存完整 JSON，仅展示首尾预览并附取回位置，规范返回值保持完整。
- **沿用当前会话权限**：每个子调用经过完整 DSH 工具管线，保留可见性检查、审批、取消与调用记录；文件与网络操作遵循宿主沙箱策略。
- **与 PTC Plus 共存**：通过 `ptcRuntime` 命名隔离绑定专用官方 Node 运行时，避免公共运行时被接管后丢失超时或沙箱能力。
- **优化的代码输入视图**：在 Web GUI 展开 `codebridge_exec` 时提供 TypeScript 语法高亮、行号、复制/换行与按需格式化展示（不修改实际执行的源码）。

> 标准模式的原生工具 schema 仍会保留，CodeBridge 不承诺固定的 token 节省比例。

## 安装

### 通过 DSH 插件管理器（推荐）

在 DSH 左侧打开 **插件 → 添加插件**，输入 `dsh-codebridge` 即可从 npm 安装预编译包（也可输入 `dsh-codebridge@0.1.7` 指定版本）。

使用命令行安装到指定 profile（例如 `web`）：

```sh
dsh plugin --profile web add dsh-codebridge
```

### 其他安装方式

- **GitHub Releases**：从 [GitHub Releases](https://github.com/MUKAPP/dsh-codebridge/releases) 复制目标版本 Assets 下的 `.tgz` 下载地址，粘贴到 **添加插件** 入口。npm 与 Release 安装包均为预编译产物，无需批准源码构建脚本。
- **源码安装**：在同一入口输入 `https://github.com/MUKAPP/dsh-codebridge.git`。若管理器提示构建脚本待批准，核对脚本后允许并重试。

### 安装与版本说明

- 安装完成后按管理器提示启用或重启 DSH；**仅刷新浏览器页面不会重新加载 Host 插件**。
- 安装会影响使用该 profile 的所有会话。
- `<0.3` 为插件管理器的版本检查范围（不含 `0.3.0` 预发布版）。构建基于 DSH `0.2.2-rc.3` SDK，通过版本检查不代表插件已在该宿主版本上完成全部验证。

## 工具速览

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `codebridge_tools` | `names` 或 `query`，可选 `detail`、`offset`、`limit`、`diagnostics` | 搜索工具摘要、查询完整参数与输出结构，或只读诊断环境 |
| `codebridge_exec` | `code`、`description`，可选 `retainState`、`isolated`、`resetState`、`timeoutMs`、`maxInlineBytes` | 在会话级 TypeScript REPL 中执行代码并调用 `tools.*` |

### 基本流程：先查询，再执行

1. **搜索或查询工具结构**（已知工具名直接用 `names`，未知工具名先用 `query` 搜索摘要）：

```json
{ "names": ["working_directory"] }
```

2. **执行编排代码**（支持顶层 `await` 与最后一个表达式作为返回值）：

```json
{
  "description": "读取当前工作目录",
  "code": "const directory = await tools.working_directory({}); directory",
  "timeoutMs": 10000
}
```

3. **多步连续处理**：第一步传入 `"retainState": true` 保留环境，后续步骤复用已有变量或函数；若中途需穿插一次性任务，传入 `"isolated": true` 避免影响共享状态；最后一步使用默认 `retainState: false` 释放环境。

## 插件设置

在左侧 **插件 → CodeBridge** 详情页的 **设置** 区可调整以下配置，点击 **保存更改** 后生效（选择 **恢复继承值** 后同样需要保存）：

| 设置 | 配置键 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 重启后恢复 | `restoreOnRestart` | 关闭（`false`） | 仅对 `retainState: true` 的调用保存受支持的顶层 JSON 数据变量；重启后自动恢复数据，释放状态时清除恢复基线 |

配置作用于当前 profile，该 profile 下的所有会话共享恢复开关；每次调用是否保留进程内环境仍由模型通过 `retainState` 决定。详见 [状态管理、重启恢复与运行时配置](docs/state-and-recovery.md)。

## 核心执行规则

- **子调用串行执行**：即使代码中使用 `Promise.all`，子工具仍按顺序执行。所有异步工具调用必须 `await`，程序结束时未完成的调用会被取消并等待收尾。
- **收尾与不回滚**：取消、超时或提前返回后，插件仍会等待运行时、在途子调用、日志及已开始的全文保存结束（`timeoutMs` 不包含这些收尾耗时）。已发生的文件写入或外部请求不会因报错或超时而回滚。
- **严格遵守作用域**：仅绑定当前代理可见且可执行的工具，始终排除 CodeBridge 自身工具与 `run_code`，不提供任何提权参数。
- **沿用宿主沙箱**：Node 文件、网络与子进程操作受当前会话宿主策略约束。Windows 后端可能报告 `partial`，不能将其视为完整隔离。

## 详细文档

- [工具参考与用法](docs/tools-reference.md)：`codebridge_tools` 与 `codebridge_exec` 完整参数与返回结构、大输出预览与全文取回、只读环境诊断、取消收尾、失败定位与 Web GUI 输入展示。
- [状态管理、重启恢复与运行时配置](docs/state-and-recovery.md)：共享/隔离/重置状态模型、动态状态提示、JSON 快照追踪与失效规则、`cordis.patch.yml` 命名隔离、`codebridge-runtime` 限额与单文件宿主适配。
- [本地开发、验证与发布](docs/development-and-release.md)：本地构建与测试流程、`verification/run.mjs` 独立集成验证（含 `--electron` / `--restart`），以及 npm Trusted Publishing 与 GitHub Actions 发布流程。
- [项目开发约定](AGENTS.md)：面向贡献者与 AI 编码代理的架构约束、代码入口与提交规范。

## 许可证

[MIT](LICENSE) © MUKAPP

# dsh-codebridge

面向 **DeepSeek Harness 0.2.1-rc.5** 的独立 Host 插件，版本 **0.1.1**。用一段临时 JavaScript 或可擦除 TypeScript 组合当前代理可见的工具，在一次外层调用内完成多步工具操作与结果整理。

本插件以 rc.5 的接口为兼容基线，已在该安装版的独立 DSH profile 中验证加载及真实 Node 子进程执行。CodeBridge 使用专用的官方 Node 运行时，公共 `ptcRuntime` 被 PTC Plus 接管时也不会改变其超时、沙箱和临时环境语义。

## 工具

### `codebridge_exec({ code, description, timeoutMs? })`

`code` 是异步函数体，不是完整模块；支持 `await` 和 `return`，无需再包一层 `async function`。可以使用 JavaScript，或只需擦除类型即可执行的 TypeScript；不支持需要额外编译转换的 TypeScript 语法。`description` 简述本次操作目的，`timeoutMs` 可选，执行限额仍受当前运行时约束。

函数体通过 `tools.<工具名>(参数对象)` 调用工具。`tools` 只包含**当前代理可见**的工具，并排除 `codebridge_exec`、`codebridge_tools` 与 `run_code`，不能借此递归执行桥接代码。子调用按序调度，不提供并行执行保证；所有异步子调用都必须显式 `await`，未等待的调用会在程序结束时取消。

返回包含 `logs`，并可包含 `result` 和 `sandbox`：

- `logs`：本次代码产生的日志。
- `result`：代码显式返回的值；没有返回值时可省略。
- `sandbox`：执行过程中可提供的沙箱信息；是否出现以实际结果为准。

不要把日志当作子工具的规范返回值，也不要假设每个工具都返回相同的包装结构。处理子工具结果前，先查询其返回 schema。

### `codebridge_tools({ names })`

`names` 是非空的明确工具名称数组。查询指定工具的名称、说明、参数 schema 和规范返回 schema，不执行工具，不一次性导出整个工具目录。

返回的 `tools` 条目包含 `name`、`description`、`parameters` 和 `output`；`unavailable` 列出不能提供的名称。不可见、未知或被桥接排除的工具不能通过查询或执行绕过可见性约束。工具自身对可选返回字段和失败的定义，仍以查询到的实际 schema 与说明为准。

## 示例：先查契约，再调用

先调用 `codebridge_tools`，确认当前代理确实可见 `working_directory`，并读取其参数与返回 schema：

```json
{
  "names": ["working_directory"]
}
```

**仅当返回的 `parameters` 确认允许空参数对象时**，再调用 `codebridge_exec`：

```json
{
  "description": "读取当前工作目录并保留原始结果",
  "code": "const directory = await tools.working_directory({}); console.log(directory); return directory;"
}
```

该示例不假定 `working_directory` 返回路径字符串，也不读取臆造的 `cwd`、`path` 或 `result` 字段；它直接返回实际工具结果。如果本机 schema 要求参数，先按查询结果调整调用。如果该工具不可见，停止使用该示例，不猜测替代工具或参数。

在一次执行里，可以继续用普通 JavaScript 对真实返回值进行筛选、计数或摘要，再只返回后续推理需要的内容。跨调用需要的数据应由调用方明确传入，不能依赖上次执行的变量。

## 权限、生命周期与失败

每次执行使用独立的临时环境，不保留跨调用的内存或变量。**临时环境不等于事务回滚**：子工具已经写入的文件、发出的请求或其他副作用，不会因为代码返回、失败或超时而自动撤销。

子工具沿用当前 session 的可见性、权限、审批及沙箱策略。`codebridge_exec` 不提供外层 `sandbox_permissions`、`justification` 等提权参数，也不允许用桥接绕过批准、被拒绝的操作或工具自身的限制。需要审批的操作应遵循原工具和当前会话的实际审批流程；不能把多步包装视为整批授权。

组合包会挂载 `@deepseek-ai/dsh-ptc-runtime-node` 的专用 `codebridge-runtime` 条目，并把它与 CodeBridge 工具放在同一 `ptcRuntime` 命名隔离中。它仍继承宿主的文件系统、子进程和 sandbox policy 服务，每次执行显式使用当前会话工作目录及权限；不会修改 PTC Plus 或其他消费者的公共运行时。超时默认值、上限及输出限制在 `codebridge-runtime` 条目配置，默认分别为 120 秒、600 秒和 64 MiB，独立于公共运行时的设置。运行时缺失、不可用工具、无效代码、参数错误、执行超时及子工具失败会明确报告。

本插件是 Host 代码，安装与启用它本身属于受信任插件管理操作；代码中的子工具执行权限与 Host 插件安装权限不是同一件事。

## 与原生工具共存

原生工具始终可以直接调用，不要求所有操作经过桥接。简单的一次读取、需要独立审批的操作或需要直接查看完整结果的任务，通常仍适合直调原生工具。

桥接的 token 收益主要来自**减少模型往返轮次与中间结果的回传体积**。它不会移除当前代理的 native tool schemas，也不承诺固定的 token 节省比例。查询 schema、代码文本、日志与最终返回值仍占用上下文；返回完整大对象可能抵消收益。

## 本地开发

要求 Node.js **>=24.9.0**、pnpm **11.28.5**，以及与 DSH **0.2.1-rc.5** 匹配的依赖。请先核对包清单与锁文件；仅在已授权准备本地依赖时安装，避免执行未经批准的依赖脚本：

```sh
pnpm install --ignore-scripts
```

准备依赖后，在本包目录执行：

```sh
pnpm run typecheck
pnpm run build
pnpm test
```

`build` 使用 `tsc -p tsconfig.json`，产出 Host 入口 `lib/index.js`；`test` 使用 `node --test tests/*.test.mjs`，需要先构建。`prepack` 使用相同的编译命令，打包时会刷新构建产物。

### 独立运行验证

[验证入口](verification/run.mjs) 使用公开 `dsh` CLI，在本项目的 `verification/.profile` 下生成独立 profile 和工作目录，以本地包链接加载插件；不会修改现有 desktop profile，也不需要模型 API key。传入 Node 或 Electron 可执行文件及其对应的 `dsh` CLI 入口；Electron 增加 `--electron`。本机可运行：

```sh
node verification/run.mjs "D:/APP/DeepSeek Harness/DeepSeek Harness.exe" "D:/APP/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --electron
```

已验证真实子进程执行可擦除 TypeScript、原生工具直调、规范 JSON 返回、策略拒绝和可捕获错误、嵌套调用事件、深层 JSON、超时后恢复及跨调用状态隔离。验证会暂时将其独立会话设为只读并确认文件写入被拒绝。本机 Windows 后端报告的文件沙箱实施程度为 `partial`；写入拒绝验证不代表所有操作都实现了完整隔离。成功后输出 `CODEBRIDGE_VERIFIED`，并在临时 profile home 下保存 `evidence.json`。

## 本地安装与启用

**推荐使用当前 DSH 的插件管理器**，而不是手工改写应用安装目录。在已构建本包且确认依赖兼容后，打开目标 profile 的插件管理页，以本地目录 `D:/Projects/dsh-plugin/dsh-codebridge` 作为安装来源，按界面提示安装并启用组合包。安装完成后，以管理器报告的实际激活状态为准；若要求重启，重启目标 DSH 应用再使用。

安装会修改**目标 profile** 的依赖及组合包选择，并可能改动锁文件；影响使用该 profile 的所有会话，而不只当前会话。依赖构建脚本需要单独批准。本说明不授权执行安装、允许脚本或修改 profile；不要将“已保存”或包管理器成功等同于 Host 已激活。

组合补丁挂载专用运行时与工具，只有 `ptcRuntime` 被命名隔离，其他宿主服务仍共享：

```yaml
- insert:
    - id: codebridge-runtime
      name: '@deepseek-ai/dsh-ptc-runtime-node'
      isolate:
        ptcRuntime: dsh-codebridge-runtime
      config:
        executionMode: per-call
    - id: codebridge
      name: dsh-codebridge
      isolate:
        ptcRuntime: dsh-codebridge-runtime
```

工具插件无额外配置字段，运行限额通过 `codebridge-runtime` 条目设置。包已包含 Host 构建入口、组合补丁、中英文元信息及图标。卸载时，在目标 profile 的插件管理页关闭或移除整个 `dsh-codebridge` 组合包，使运行时与工具一起停止；正在执行的代码会被取消，并等待在途子调用收尾。

从 0.1.0 升级后需要重新加载组合包，使新增运行时和命名隔离生效。本地 link 安装使用已构建的当前目录；若管理器未重新加载这份组合补丁，重启 DSH。仅刷新浏览器页面不能重新加载 Host 插件。

# 项目开发约定

## 项目与兼容性

CodeBridge 是 DeepSeek Harness 的 Host 插件，为标准模式提供代码执行和工具编排能力。使用 TypeScript、ESM 和 pnpm，兼容版本以 [package.json](package.json) 的 `engines.dsh` 与 DSH peer dependencies 为准。参考宿主源码时必须使用匹配版本；升级需同步核查工具执行接口和运行时契约，不能只放宽版本范围。

## 代码入口

### Host 核心模块

- [src/index.ts](src/index.ts)：插件注册、依赖声明与生命周期组装。
- [src/config.ts](src/config.ts)：插件配置 schema（`restoreOnRestart` 热更新配置）。
- [src/execute.ts](src/execute.ts)：`codebridge_exec` 工具定义、运行时调用与清理兜底。
- [src/catalog.ts](src/catalog.ts)：`codebridge_tools` 工具定义、当前代理作用域查询与摘要分页。
- [src/diagnostics.ts](src/diagnostics.ts)：只读环境诊断收集与 schema 定义。
- [src/dispatch.ts](src/dispatch.ts)：串行子调用调度、会话事件及上下文转发。
- [src/lifecycle.ts](src/lifecycle.ts)：取消、权限/配置变化与插件卸载清理。
- [src/output.ts](src/output.ts)：输出渲染、`maxInlineBytes` 首尾预览裁剪与 `spillStore` 全文保存。
- [src/errors.ts](src/errors.ts)：运行时失败分类（`failure.kind`）、状态失效判定与阶段错误报告。
- [src/json.ts](src/json.ts)：深层 JSON 的非递归渲染。

### 状态快照与动态提示

- [src/state.ts](src/state.ts)：`SessionSnapshotStore` 会话投影注册、JSON 快照持久化与回读校验。
- [src/snapshot-program.ts](src/snapshot-program.ts)：顶层声明收集、快照编解码与 REPL 捕获/恢复脚本生成。
- [src/state-prompt.ts](src/state-prompt.ts)：`codebridge:execution-state` 动态系统提示注入。

### Web 客户端与组合包配置

- [src/client/index.ts](src/client/index.ts)：Web 端 slot、样式与多语言字典注册。
- [src/client/CodeBridgeToolView.ts](src/client/CodeBridgeToolView.ts) 与 [src/client/format-code.ts](src/client/format-code.ts)：`codebridge_exec` 代码高亮与按需 Prettier 格式化视图。
- [src/client/CodeBridgeSettings.ts](src/client/CodeBridgeSettings.ts) 与 [src/client/settings-controller.ts](src/client/settings-controller.ts)：插件详情页设置表单与控制器。
- [cordis.patch.yml](cordis.patch.yml)：工具与专用 Node 运行时的组合和命名隔离。

## 实现约束

- 保留原生工具直接调用入口；不替换宿主工具展示模式，不注册保留名 `run_code`。
- CodeBridge 与专用官方 Node 运行时必须共享同一 `ptcRuntime` 命名隔离，不使用可能被 PTC Plus 接管的公共运行时。只隔离运行时；工作目录、文件系统、子进程和 sandbox policy 仍按当前会话解析。
- 模型代码交给 `ptcRuntime.resolve/run` 执行，不在 Host 主进程内求值。运行时的超时、输出限制及沙箱检查不得静默跳过。
- 只绑定当前代理可见工具，并排除 CodeBridge 自身工具与 `run_code`。子调用必须通过完整工具执行管线，保留 agent、root/parent/call identity 和取消信号，不直接调用工具定义的执行函数。
- 当前子调用按序执行；共享状态由每次调用的 `retainState` 参数决定，`isolated` 调用不读写共享状态，重启 JSON 数据恢复由插件设置控制，范围见 [状态管理与运行时配置](docs/state-and-recovery.md)。改变调度或状态模型时须同步说明和验证，不能将 `Promise.all` 等同于安全并行。
- 程序结束、取消、权限变化或插件卸载后，停止新调用，等待在途子调用及日志收尾。不得丢失图片、额外上下文、回合结束标记或把记录失败当成功。
- 规范 JSON 返回值可能很深；输出渲染继续使用迭代实现，不能直接以递归 `JSON.stringify` 替换整棵值的渲染。
- DSH 服务包保持为与宿主匹配的 peer dependencies，避免引入另一份 Cordis/服务实例。所有注册和监听随插件生命周期释放。

## 构建与验证

Node 与 pnpm 版本见 [package.json](package.json)，依赖沿用 [pnpm-lock.yaml](pnpm-lock.yaml)。在已准备依赖的源码目录中按变更范围运行：

```sh
pnpm run typecheck
pnpm run build
pnpm test
```

`pnpm test` 使用编译后的 `lib/`，须先构建。安装依赖可用 `pnpm install --ignore-scripts --config.strict-dep-builds=false` 后显式构建；正常开发安装及 Git 依赖准备会通过 `prepare` 编译，打包通过 `prepack` 编译。修改这些生命周期入口时核查 GitHub 来源安装与发布文件清单。

新增或修改测试代码需获得用户授权；已有检查按实际影响运行，不为文档改动重复全部运行时验证。[verification/run.mjs](verification/run.mjs) 通过真实 `dsh` CLI 创建独立 profile，具体用法见 [本地开发、验证与发布](docs/development-and-release.md#独立集成验证)。它只用于集成验证，不修改用户正在使用的 profile。报告中区分受控 provider 测试、真实子进程验证及当前会话实测。

## 文档与提交

文档按受众分层维护：[README.md](README.md) 面向安装与快速上手，专题细节放在 [docs/](docs/) 下（`tools-reference.md`、`state-and-recovery.md`、`development-and-release.md`），保持简体中文；不要写入本机绝对路径、会话进度或未验证的成功声明。功能、参数、兼容范围和安装行为发生变化时，同步更新 `README.md`、对应 `docs/` 文档、包清单及相关 locale 元信息。

提交仅包含源码、文档、配置、资源及获授权的测试；遵循现有 Conventional Commits。依赖、构建产物、安装包、临时 profile 和本地项目记忆不提交。本地记忆按用户全局约定维护，并使用 Git 本地排除，不写入公共规则或公开文档。

# 本地开发、验证与发布

> 返回 [README](../README.md) · 相关文档：[工具参考与用法](tools-reference.md) | [状态管理与运行时配置](state-and-recovery.md) | [项目开发约定](../AGENTS.md)

本文档面向维护者与贡献者，说明本地构建、单元测试、真实 DSH CLI 集成验证以及 npm / GitHub Releases 发布流程。

---

## 本地开发与构建

环境要求：Node.js `>=24.9.0`，包管理器 pnpm `11.28.5`（版本以 [package.json](../package.json) 为准，依赖锁定在 [pnpm-lock.yaml](../pnpm-lock.yaml)）。

克隆仓库后，在项目根目录执行：

```sh
pnpm install --ignore-scripts --config.strict-dep-builds=false
pnpm run typecheck
pnpm run build
pnpm test
```

说明：
- 安装命令显式跳过依赖安装脚本并允许 pnpm 继续，随后由 `pnpm run build` 编译 Host（`tsc -p tsconfig.json`）与 Web 客户端（`scripts/build-client.mjs`）。
- 构建产物输出到 `lib/`；`pnpm test` 直接测试 `lib/` 中的编译结果，运行测试前必须先执行 `pnpm run build`。
- 完成构建后，可在 DSH 插件管理器中将本项目根目录的绝对路径作为本地插件源加载调试。
- 打包为可分发 `.tgz`（自动触发 `prepack` 编译）：

```sh
pnpm pack --pack-destination artifacts
```

---

## 独立集成验证

[verification/run.mjs](../verification/run.mjs) 通过公开的 `dsh` CLI 在 `verification/.profile` 下创建独立临时环境进行端到端验证。该流程**不需要模型 API key**，也**不会修改现有的 desktop 或其他用户 profile**。

### 基本用法

```sh
node verification/run.mjs <node-or-electron> <dsh-cli-entry> [--electron] [--restart]
```

- **Node 宿主验证**：传入 Node 可执行文件路径与 `dsh` CLI 入口文件。
- **Electron 宿主验证**：传入 Electron 可执行文件路径，并附加 `--electron`（脚本内部设置 `ELECTRON_RUN_AS_NODE=1`）。
- **多进程重启恢复验证（`--restart`）**：在 `verification/.profile/restart` 下启用真实 JSONL 会话持久化，顺序启动三个独立 DSH Host 进程（`seed` → `restore` → `discarded`），验证：
  - 顶层 JSON 变量跨进程恢复且不重复执行外部副作用操作；
  - 多会话隔离与设置服务热更新；
  - `isolated: true` 调用保留共享快照；
  - 释放状态（`retainState: false`）后再次重启不会复活已清除的数据。

### 已覆盖的验证范围

结合 `tests/*.test.mjs` 与 `verification/`，现有验证覆盖：
- 工具可见性、作用域排除与规范 JSON 渲染（含深层 JSON 非递归处理）；
- 串行子调用调度、取消与卸载收尾；
- 多会话隔离与权限策略变化清理；
- 真实 Node 子进程中的超时恢复、只读沙箱写入拒绝与跨重启快照恢复。

---

## 发布流程

发布由 [release.yml](../.github/workflows/release.yml) 驱动，仅在推送符合 `vX.Y.Z` 格式的 Git 标签时触发（普通提交与 PR 不触发发布）。

### 首次配置 npm Trusted Publishing

1. 打开 [npm 包页面](https://www.npmjs.com/package/dsh-codebridge) 的 **Settings → Trusted publishing**，添加 GitHub Actions 发布者：
   - **Organization or user**：`MUKAPP`
   - **Repository**：`dsh-codebridge`
   - **Workflow filename**：`release.yml`
   - **Environment name**：留空
   - **Allowed actions**：勾选 `npm publish`
2. 无需在 GitHub 仓库中配置 npm 令牌。
3. 新建绑定后需在两天内完成首次成功发布，详见 [npm Trusted Publishers 文档](https://docs.npmjs.com/trusted-publishers/)。

### 执行发布

1. 将 [package.json](../package.json) 中的 `version` 更新为 npm 尚未发布的新版本，提交并推送至远程仓库。
2. 在对应提交上创建并推送与版本号一致的附注标签（以 `0.1.7` 为例）：

```sh
git tag -a v0.1.7 -m "Release v0.1.7"
git push origin v0.1.7
```

### 工作流行为与失败恢复

1. `build` 作业校验标签与 `package.json` 版本一致，依次执行冻结依赖安装、`typecheck`、`pnpm pack` 与 `pnpm test`，并将预编译 `.tgz` 上传为 7 天有效期的构建产物。
2. `publish-npm` 与 `publish-github` 作业并行下载同一份 `.tgz`，分别发布到 npm registry 与 GitHub Releases。
3. 若其中某个发布作业失败，可在构建产物的 7 天保留期内**仅重跑失败的单个作业**，避免重复发布另一渠道。

# pi-packages

个人 Pi 扩展 monorepo。统一维护需要的包，保留上游实现与历史；不把审批、代理调度和 OpenAI 上下文机制混成一个扩展。

| 目录 | 职责 |
| --- | --- |
| `packages/pi-subagents` | 子代理会话、工具集、生命周期与原生日志 |
| `packages/pi-permission-system` | 确定性权限、审批转发、人工确认与审计 |
| `packages/pi-auto-mode` | 复用 Toolkit 审批策略，通过权限接口派发受限只读审批子代理 |
| `packages/pi-openai-toolkit` | 换窗、远端压缩、搜索、生图和 Astra 兼容层 |
| `packages/pi-usage` | 用量查询、账号缓存、今日／5h／周金额及预算估算、Fast、`/usage` 和 `/fast` |
| `packages/pi-statusline` | 消费结构化用量快照，统一渲染状态栏；管理 `/statusline` |
| `packages/pi-tui-kit` | 两包既有的菜单依赖库，不注册 Pi 扩展 |

## 当前边界

Toolkit 的独立 Auto 扩展已从包的加载清单中移除，其源码与测试保留供跟踪上游；审批只有 `pi-permission-system → pi-auto-mode → pi-subagents` 这一条入口。Toolkit 其他扩展保留原有加载顺序与行为，包括 Astra 的自动兼容改写。

用量显示只有 `pi-usage → 结构化快照 → pi-statusline` 一条路径。查询、日志扫描和 Fast 费用修正仅在 `pi-usage` 执行；状态栏保留今日、5h、周窗口和倒计时／金额轮播，不解析其他插件的显示字符串，也不额外显示一条 usage 状态。

每个包仍按需加载，不整仓自动启用。不要同时加载原仓库和本仓的同名扩展；权限和审批配置不由用量迁移改变。

## 开发

需要 Node.js 24+、pnpm 10.31.0 和独立安装的 Bun 1.2.23+。不依赖 npm 的 Bun 启动占位文件。

```bash
pnpm install --ignore-scripts
pnpm check
pnpm test
pnpm test:integration
```

- `check` 构建公开类型、Kit 和两个显示扩展，再检查所有包。
- `test` 运行各包测试；Toolkit 使用 Bun，gotgenes 和 narumitw 包使用 Vitest，Auto 使用 Node test。
- `test:integration` 运行审批集成及用量到状态栏的离线集成，不调用付费模型。
- 只验证显示链路时使用 `pnpm build:status`、`pnpm check:status`、`pnpm test:status` 和 `pnpm test:status:integration`。

依赖准备后可用 `pnpm install --offline --frozen-lockfile --ignore-scripts` 重建安装。构建输出不提交；Pi 加载两个显示包的目录前必须运行 `pnpm build:status`。

审批代理配置示例位于 `packages/pi-auto-mode/examples/approver.md`。模型与思考强度继续使用代理文件配置；扩展排除继续使用子代理的 `excludedExtensionPackages`。

## 选择性安装

在完成旧包来源迁移后，从本仓根目录按需安装，不整仓自动启用：

```bash
pi install ./packages/pi-subagents
pi install ./packages/pi-permission-system
pi install ./packages/pi-auto-mode
pi install ./packages/pi-openai-toolkit
pi install ./packages/pi-usage
pi install ./packages/pi-statusline
```

这些命令是安装示例。用量和状态栏配套启用，但只有状态栏渲染 footer；Kit 不加入 Pi 加载清单。Fast 配置归 `pi-usage.json`，布局、配色和图标归 `pi-statusline.json`。由旧版一体化状态栏迁移时，将原 `codexFastMode` 值移到 `pi-usage.json`，其他状态栏字段不动。

安装或改动构建输出后建议退出并重启 Pi，避免旧进程保留懒加载缓存。权限系统的启用仍需用户明确决定。

## 上游与发布

见 [UPSTREAMS.md](UPSTREAMS.md)。原有上游历史与 narumitw 导入基线的完整源历史均以合并祖先保留，随主线推送；当前工作树只保留选定包。

所有包暂设 `private: true`，避免误发布为上游同名包。gotgenes 包暂保留原 npm 名称和公开协议标识，确保现有适配接口一致；发布前需单独确定自己的命名空间。推送、发布和上游升级分别执行，不由本地安装或构建自动触发。

各包保留自己的许可证与第三方归属，本仓新增代码采用 MIT。

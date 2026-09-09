# pi-packages

个人 Pi 扩展 monorepo。统一维护需要的包，保留上游实现与历史；不把审批、代理调度和 OpenAI 上下文机制混成一个扩展。

| 目录 | 职责 |
| --- | --- |
| `packages/pi-subagents` | 子代理会话、工具集、生命周期与原生日志 |
| `packages/pi-permission-system` | 确定性权限、审批转发、人工确认与审计 |
| `packages/pi-auto-mode` | 复用 Toolkit 审批策略，通过权限接口派发无工具审批子代理 |
| `packages/pi-openai-toolkit` | 换窗、远端压缩、搜索、生图和 Astra 兼容层 |

## 当前边界

Toolkit 的独立 Auto 扩展已从包的加载清单中移除，其源码与测试保留供跟踪上游；审批只有 `pi-permission-system → pi-auto-mode → pi-subagents` 这一条入口。Toolkit 其他扩展保留原有加载顺序与行为，包括 Astra 的自动兼容改写。

建仓不改变当前 Pi 的全局安装来源。原 `~/Projects/pi-model-approver/` 仍保留，运行配置尚未迁移；`pi-permission-system` 仍处于用户此前设置的禁用状态。不要同时加载原包和本仓对应包。

## 开发

需要 Node.js 24+、pnpm 10.31.0 和独立安装的 Bun 1.2.23+。不依赖 npm 的 Bun 启动占位文件。

```bash
pnpm install --ignore-scripts
pnpm check
pnpm test
pnpm test:integration
```

- `check` 构建两项公开服务的类型声明，然后检查四个包。
- `test` 运行各包原有测试；Toolkit 使用 Bun，gotgenes 包使用 Vitest，Auto 使用 Node test。
- `test:integration` 使用本地模拟模型验证真实 Pi、权限和子代理的集成，不调用付费模型。

审批代理配置示例位于 `packages/pi-auto-mode/examples/approver.md`。模型与思考强度继续使用代理文件配置；扩展排除继续使用子代理的 `excludedExtensionPackages`。

## 选择性安装

在完成旧包来源迁移后，从本仓根目录按需安装，不整仓自动启用：

```bash
pi install ./packages/pi-subagents
pi install ./packages/pi-permission-system
pi install ./packages/pi-auto-mode
pi install ./packages/pi-openai-toolkit
```

这些命令只作为迁移说明，本次建仓没有执行。安装后仍需按各包文档配置功能，并执行 `/reload`。权限系统的启用需要用户明确决定。

## 上游与发布

见 [UPSTREAMS.md](UPSTREAMS.md)。上游完整历史以合并祖先保留，当前主线只包含选定包；可用 `git log --first-parent` 看本仓集成历史。

所有包暂设 `private: true`，避免误发布为上游同名包。gotgenes 包暂保留原 npm 名称和公开协议标识，确保现有适配接口一致；发布前需单独确定自己的命名空间。当前没有 GitHub `origin`，只有只读使用的上游 remotes。

各包保留自己的许可证与第三方归属，本仓新增代码采用 MIT。

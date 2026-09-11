# 工作约定

- 从仓库根目录工作；包内 AGENTS.md 是保留的上游说明，不代表当前会话从子目录启动。
- 修改前阅读相关实现和对应包文档，优先复用已有机制，不另建重复的会话、日志或权限系统。
- `pi-subagents` 管生命周期；`pi-permission-system` 管权限；`pi-auto-mode` 只做审批适配；Toolkit 保留非门禁功能。
- Toolkit 审批提示词、裁剪和解析使用固定源码快照；未经用户确认，不另定预算、授权政策或回退规则。
- 审批代理仅有 `read`、`grep`、`find`、`ls` 四个只读证据工具，最多调查 3 个模型轮次，第 4 轮无工具输出最终 verdict；模型与思考强度从代理文件读取，插件排除复用 `excludedExtensionPackages`。
- 保留各包 LICENSE、NOTICE 与上游历史；修改上游实现时更新 UPSTREAMS.md 的差异说明。
- 只使用一个根 pnpm 锁文件；修改依赖后检查 workspace 链接，避免适配器运行在另一份服务包上。
- 不擅自变更用户全局 Pi 安装来源、启用权限系统、创建远端或发布包。
- 修改后执行相关测试；最终集成检查使用 `pnpm check`、`pnpm test` 和 `pnpm test:integration`，区分模拟模型与真实后端验证。
- 不提交 node_modules、构建输出、用户凭据、会话或审批日志。

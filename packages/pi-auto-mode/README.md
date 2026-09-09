# Pi Model Approver（本地实验扩展）

将 `pi-permission-system` 的 `ask` 请求交给 `pi-subagents` 运行的审批代理。审核策略、材料构造、裁剪和结果解析直接复用 `pi-openai-toolkit` 的源码快照，不维护第二套规则。来源、固定提交及必要的导入调整见 [vendor 说明](src/vendor/toolkit/README.md)。

## 分工

- **Toolkit 源码**：`reviewerSystemPrompt(false)`、`transcriptFromEntries`、`buildReviewPrompt`、`parseReviewVerdict`。不启用调查工具。
- **权限系统**：提供待审命令、路径与规则证据，执行最终决定，向父会话转发子代理审批。
- **适配层**：从审批父会话的 `buildContextEntries()` 补充历史，通过权限插件的格式化接口补全 `write/edit` 参数，将证据转换成 Toolkit 输入。缺少原始参数时保留插件已有证据，不新增拒绝条件。
- **子代理**：负责模型调用、插件排除、取消及原生会话日志，不另建审批日志系统。

Toolkit 将工具参数裁剪到 8,000 字符后继续审核；历史采用它原有的最近 40 条、单条 2,000 字符、总预算 24,000 字符等规则。没有额外的 64 KiB 转人工门槛，也不单独修订它的裁剪标记或授权政策。被省略的内容可能影响模型判断，这不是完整代码审计或沙箱。

## 代理配置

`~/.pi/agent/agents/approver.md` 配置模型与思考强度，可信项目的 `.pi/agents/approver.md` 可覆盖。`tools` 必须为 `none`。Toolkit 原版策略和输出合同在审批子会话启动时注入，不再在代理 Markdown 中维护另一份 DSH 提示词。

审批使用一次性前台子代理，不继承主对话全文，不走后台队列；共享 `excludedExtensionPackages`。生命周期保留 120 秒限时、取消与退出处理。模型返回 Toolkit 的 `outcome: allow/deny`，适配到权限系统；超时、取消或无法解析的回复回到人工审批，权限系统原有硬性边界仍生效。

审批输入、回复与 token 用量保存在父会话旁的 `tasks/` 原生日志中，通过 `/subagents:sessions` 查看。权限插件现有日志中的 `model_approver.started` / `model_approver.review` 关联 `requestId`、`childId` 和 `transcript`。会话可能包含敏感材料和模型思考，请勿直接公开分享。

## 启用

```bash
pi install /Users/zhaoqixuan/Projects/pi-model-approver
```

在权限系统配置中合并：

```json
{ "authorizerChain": ["model-approver"] }
```

修改后 `/reload`。代码更新不会自动启用此前禁用的权限系统。

## 验证

```bash
npm test
npm run test:integration
```

集成测试使用真实 Pi、权限插件和子代理插件，模型由本地 HTTP 服务模拟，不调用付费服务。

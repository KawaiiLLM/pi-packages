# 上游基线

| 本地包 | 来源 | 基线 |
| --- | --- | --- |
| `pi-subagents` | https://github.com/gotgenes/pi-packages ，目录 `packages/pi-subagents` | tag `pi-subagents-v21.5.0`；commit `e311a0d1eff8ce73db43912b7483cbf15faf0fa3` |
| `pi-permission-system` | 同上，目录 `packages/pi-permission-system` | tag `pi-permission-system-v31.1.3`；commit `cf99c19b2cad9d26f6c4d0b9dc464c7fde0fab18` |
| `pi-openai-toolkit` | https://github.com/awoaCrim/pi-openai-toolkit | commit `32d568ab6b58f8c914e3c143d625869a71ad55a3` |
| `pi-auto-mode` | 本地 `~/Projects/pi-model-approver/`，导入时改目录名 | 初始快照提交 `e9b80ae6`；Toolkit 策略快照归属见包内 `src/vendor/toolkit/README.md` |

## 历史保留

这不是浅克隆或只留下版本号：三个上游基线及其历史已通过 `ours` 合并成为本仓主线的祖先。合并仅保留历史，不把无关上游包加入当前工作树。全新克隆本仓主线也能保留这些祖先。

本地查询上游历史：

```bash
git log e311a0d1 -- packages/pi-subagents
git log cf99c19b -- packages/pi-permission-system
git log 32d568ab -- src/auto-mode
```

当前差异对比：

```bash
git diff e311a0d1:packages/pi-subagents HEAD:packages/pi-subagents
git diff cf99c19b:packages/pi-permission-system HEAD:packages/pi-permission-system
git diff 32d568ab HEAD:packages/pi-openai-toolkit
```

## 集成差异

- 建立 pnpm workspace、统一锁文件与根目录检查命令；保留各上游包的测试和开发版本基线。
- 所有包标为私有，未发布或修改上游归属。
- `pi-auto-mode` 通过 `workspace:*` 链接本仓两个 gotgenes 服务包，而非另装注册表副本；其运行逻辑未重写。
- `pi-subagents` 的 `resume` 按既有代理类型解析前后台模式：后台立即返回并复用并发队列，前台等待结果；每轮重置取消控制器和结果交付状态，后台不绑定父调用取消信号，仍支持显式停止及会话清理。补充排队取消、模式切换和旧完成通知跨轮误发的回归测试。
- `pi-subagents` 的未认领进度消息直接通过 Pi 原生 `steer` 队列交付，不再暂存到父会话 `agent_settled`；空闲时仍触发一轮处理。完成通知保留原有暂存、认领、消费和跨轮检查，前台等待期间的进度仍随结果返回；不新增批处理、过期丢弃或配置项。
- `pi-subagents` 服务新增 `waitForResult`，复用已有结果认领、等待和消费标记；`pi-auto-mode` 用它替换轮询，避免审批完成后重复通知主会话，保留取消、原生日志及普通子代理通知。
- `pi-auto-mode` 恢复 Toolkit 默认只读证据调查：审批代理定义及运行期均严格限制为 `read`、`grep`、`find`、`ls`，复用 `reviewerSystemPrompt(true)`；最多 3 个调查轮次，第 4 轮移除工具并收取最终 verdict。只读调用仍经过权限系统，现有路径 deny 与 Skill 权限策略不变；脚本内容不预先内联，仅按需读取。
- `pi-auto-mode` 按用户确认将审批历史改为独立的用户 12,000 字符与其他材料 12,000 字符配额：先按角色分组，用户消息不受其他 entry 的最近 40 条限制；其他池最多 40 条，优先保留用户消息前的助手上下文。每条先裁剪到 2,000 字符再计费，包含角色标签、换行及其他池内的裁剪提示；不更改授权政策或将助手内容转为用户授权。
- Toolkit 与 `pi-auto-mode` 快照新增 `user_authorization: forbidden`：用户仍有效的明确禁止优先于风险规则；普通“继续”不能撤销禁令，后续用户明确撤销或针对该操作重新授权才重新评估。共享 verdict 归一化强制把 `forbidden + allow` 改为 `deny`，保留独立风险等级并记录覆盖原因；低风险简答及可选 classifier 提示同步修订。此保护依赖模型识别可见禁令，不能恢复被裁剪的授权材料。扩展独立 opt-in Luna 红队测试，待审操作不可执行，隐蔽危害与安全对照不进入默认付费测试。
- Toolkit 审批 verdict 解析器改为从后向前验证平衡的 JSON 对象，模型在最终 verdict 前序列化旧工具调用文本时仍取最后一个合法 `allow/deny`，没有合法对象时继续失败关闭；`pi-auto-mode` 同步该解析段。审批适配器也为 `subagent` 注册完整输入格式化器，避免任务说明先被权限系统的 200 字符通用预览截断，再统一接受 Toolkit 的 8,000 字符操作参数上限。
- `pi-permission-system` 将 Pi 标记为 `interactive`/`rpc` 的 `/skill:name` 输入视为本次加载授权，仅跳过 `ask`；保留 `deny`、模型 Skill 读取及后续工具检查，不创建会话授权。复用 gate bypass、审计和决策事件，记录输入来源；`pi-subagents` 首次及 resume 的 `session.prompt()` 明确传 `source: "extension"`，避免默认来源误授。仍受宿主输入转换保留来源、直接 RPC steer/follow_up 不经过 input hook 的边界限制。
- `pi-permission-system` 在同一 UI 会话复用人工终端，并将直接请求和子代理转发请求的人工弹窗排队；取消及会话结束会关闭活动弹窗、取消待处理请求，避免并发 `ui.custom` 相互覆盖后永久等待。模型审批仍可并行，权限规则不变。
- Toolkit 加载清单不再包含 `extensions/auto-mode.ts`；相应清单测试同步调整。原 Auto 源码保留，但不作为第二个门禁自动加载。
- Toolkit 上下文工具按当前 registry 中的定义确认归属，不再将 Pi 启动时自动激活的工具误认为外部基线；关闭功能会隐藏本插件工具，启用恢复。每次同步重新检查归属，部分注册失败或同名冲突时仅清理仍属于本插件的工具。新增控制器回归测试和真实 Pi 默认激活场景的冒烟测试。
- Toolkit 移除 npm `bun` 开发依赖，改为环境前置要求，避免跳过安装脚本后空执行文件造成测试假通过。
- pnpm catalog 和 TypeScript 基础配置取自 gotgenes 基线并缩减到当前使用项。

后续更新先 fetch 并审查对应包的变更，再导入选定目录、解决上述集成差异并运行检查。不要将整个上游主线直接 merge 到工作树，也不要在未决定授权边界前放宽审批规则。

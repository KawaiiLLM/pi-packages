# 上游基线

| 本地包 | 来源 | 基线 |
| --- | --- | --- |
| `pi-subagents` | https://github.com/gotgenes/pi-packages ，目录 `packages/pi-subagents` | tag `pi-subagents-v21.5.0`；commit `e311a0d1eff8ce73db43912b7483cbf15faf0fa3` |
| `pi-permission-system` | 同上，目录 `packages/pi-permission-system` | tag `pi-permission-system-v31.1.3`；commit `cf99c19b2cad9d26f6c4d0b9dc464c7fde0fab18` |
| `pi-openai-toolkit` | https://github.com/awoaCrim/pi-openai-toolkit | commit `32d568ab6b58f8c914e3c143d625869a71ad55a3` |
| `pi-auto-mode` | 本地 `~/Projects/pi-model-approver/`，导入时改目录名 | 初始快照提交 `e9b80ae6`；Toolkit 策略快照归属见包内 `src/vendor/toolkit/README.md` |
| `pi-usage`、`pi-statusline` | https://github.com/narumiruna/pi-extensions ，同名 `packages/` 目录 | 上游起点 `530b081ed5f0feed6a5c7fda2f4a3f9c7c1f9cee`；本地导入 `11a0fcf95823bc63ec9c63368ad9f666a6ef41d7`，叠加原工作区未提交的统计修复；版本分别为 `0.60.3`、`0.50.0` |
| `pi-tui-kit` | 同上，目录 `packages/pi-tui-kit` | `0.59.0`；commit `efc0c56e20f9ad9092d803904783b3d1cd9e1b7d`，与原两个插件实际安装的依赖一致，不夹带源 HEAD 的 `0.60.0` 升级 |

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

## narumitw 目录更新

2026-09-12 的迁移保留原 `pi-extensions` 工作树，不在原仓提交、清理或回滚。原状态栏未提交的递归日志统计、今日刷新、Prism 预算显示及其测试一并导入。两个插件共用的 `test/` helpers、Vitest 隔离与超时机制、Biome 配置沿用本地导入基线；Kit 使用上述独立版本基线。保留 Kit 懒加载测试依赖的根 benchmark 脚本，并以 workspace 开发依赖解析本地 Kit；两个 Kit 测试改为按 pnpm 实际路径检查，未改库业务源码。共享 mock 使用对应 Pi interface 类型，新增源码与测试的联合类型检查。

导入基线 `11a0fcf95823bc63ec9c63368ad9f666a6ef41d7` 的完整源历史已通过 `ours` 合并接入本仓主线祖先，包含上述上游起点与 Kit 基线，随主线推送。合并只保留历史，选定目录及本地修改另行提交，不把源主线的其他包合入工作树。本地 `narumitw-local/import` 指向导入基线，`upstream-narumiruna/main` 仅作后续更新参考，不代表已合入该分支的全部更新。

后续更新按包选择旧基线到新基线的差异，先审查再应用：

```bash
git fetch --no-tags https://github.com/narumiruna/pi-extensions.git main:refs/remotes/upstream-narumiruna/main
git diff 530b081ed5f0feed6a5c7fda2f4a3f9c7c1f9cee upstream-narumiruna/main -- packages/pi-usage packages/pi-statusline
git log narumitw-local/import -- packages/pi-statusline
```

更新时保持目录名，以旧基线做三方合并；不要用整目录覆盖本地改动。Git 历史便于定位冲突，不保证自动合并：状态栏自身布局定制、usage 发布位置、依赖 manifest 和被移出的重复逻辑仍需人工核对。Kit 按自己的基线独立更新。

## 集成差异

- 建立 pnpm workspace、统一锁文件与根目录检查命令；保留各上游包的测试。新导入 narumitw 包的 Pi 开发依赖对齐本仓 `0.85.1`，编译器使用已有 TypeScript 6，避免夹带其他插件或宿主升级；Kit 为显式 `workspace:*`，不另装注册表副本。
- `pi-usage` 保留上游账号查询、缓存、菜单和 Fast 主流程，新增独立的结构化快照发布；迁入原状态栏的递归会话日志金额、5h／周估算和今日预算运算，不增加第二套 provider 查询。快照不携带凭据，使用会话和模型标识处理切换失效及重新订阅；今日扫描恢复成功后仅清除自身的旧错误，不清除其他诊断。
- `pi-statusline` 只通过 `@narumitw/pi-usage/snapshot` 和 Pi 事件总线消费数据，删除复制的查询目录、日志扫描、Fast 请求与费用钩子及 `/usage`、`/fast`。颜色、图标、布局和倒计时／金额轮播保留；Prism 前导 `░▒▓` 分别使用 `#3A3A3A`、`#4A4A4A`、`#5A5A5A`；背景按 `#5A5A5A`、`#4A4A4A`、`#3A3A3A`、`#2A2A2A`、`#1A1A1A` 五段循环，不改 Mono；模型与思考强度基础字体色统一为 `#E77B92`，5h 与周用量基础字体色统一为 `#DCE58A`，缓存基础字体色为 `#A582DD`，保留原有对比度适配及 80% 告警前景／背景反转；`pi-usage` 不再单独发布一条 usage 状态。今日金额的订阅标识不再调用 `modelRegistry.isUsingOAuth`：无预算百分比时，仅在有用量快照或模型公开 provider 为 `kimi-coding` 时显示 `(sub)`，否则不猜测账号类型。此个人工作区有意偏离上游「扩展完全独立」约定，耦合集中在公开快照入口，不解析显示字符串。
- `pi-usage.json` 唯一持有 Fast 设置，`pi-statusline.json` 只管理显示。两包构建脚本各自保留，不为迁移抽成通用 builder；新增的 Vitest 配置只覆盖这批包和跨包用量集成，不接管原包测试。
- Fast 能力改读当前匹配的 Codex OAuth 账号模型目录：仅结构化 `service_tiers` 的 `priority` 确认支持，不再查型号白名单；缺失、畸形、旧字段单独声明或请求失败均明确为未知。复用现有认证匹配与有界 HTTP 读取，拒绝重定向，目录最大 2 MiB；按账号与协议版本缓存五分钟、合并并发读取，取消和会话切换不发布旧数据。可在 `pi-usage.json` 配置 `codexModelsClientVersion`，默认 `0.153.4`；契约固定于官方 Codex `aee8a55ab6010f1d53e741edec74dbcffa07bcfe`。目录实测仍被当前审批链拦截，未绕过；实现通过离线响应验证，Fast 默认关闭。
- 目录不提供结构化价格。旧五款模型的已知费用重算保留为独立价目兼容，不作为 Fast 支持名单；新型号不套默认倍率，保留 Pi 返回的估算费用并明确提示可能缺少 Fast 附加费。Pi 会吞下 payload hook 的异常，因此已开启 Fast 但无法验证能力时，还会中止所属运行，防止请求沿旧 payload 静默继续。
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
- Toolkit 生图模型配置、选择校验和测试来自上游 `0.14.5`（`a9746b50b68e3085233e5b55028110709072040f`），作为生图修复的前置一并纳入，双语 README 仅同步生图说明；不表示已提交其余上游升级。`imageGeneration.models` 首项为默认，调用可用 `model` 精确选择配置项；省略列表时沿用该上游默认 `gpt-image-2.5`，空或无效配置告警后回退默认。未配置的显式型号在付费请求前拒绝。不更改本机配置、不恢复包内 npm 锁文件。
- Toolkit 生图按 API 选择响应模式：`openai-codex-responses` 使用 `stream: true` 与 SSE Accept 头，普通 `openai-responses` 保留非流式 JSON。复用 `remote-v2-client` 的 SSE 帧解析，在既有响应大小上限内读取；仅在 `response.completed`（或 Pi Codex 已支持的 `response.done`）成功终结后，按图片调用 ID 核对并合并 `response.output_item.done` 与终结输出，再走原单图／PNG 校验及保存流程。该扩展解决实测的终结 `output: []` 丢失已完成 item-done 图片问题；两份输出有冲突、响应标识不一致或存在多张有效图片时拒绝，不任选一份。部分图、item-added 或单独 item-done 不算成功，截断、失败、不完整或重复／乱序终结仍显式失败。保留取消、超时、诊断脱敏及不自动重试；已用一次真实 Codex 调用验证生成并保存 PNG，其他模型及参考图编辑路径未实测。
- Toolkit 生图 `no-image` 错误新增有界结构诊断：合并后输出数量／类型、图片调用状态、结果字段类型／长度、脱敏错误，以及原始终结输出数量、SSE 事件计数和 image item-done 的结构摘要；只展示有限条目与已知标签，不复制正文、拒绝原文、提示词、标识或图片数据，不另写原始响应日志。中间事件不能替代整条响应成功终结，不自动重试；该诊断不代表真实生图已跑通。
- Toolkit 生图 HTTP 错误保留状态码与脱敏后的 `message`／`error.message`／`detail`／`error.detail`／字符串错误，非 JSON 拒绝响应也提供有界文本，不再误判为成功响应格式错误。复用 64 KiB 错误体上限与 4,096 字符诊断上限，先脱敏再截断，补齐带引号凭据及完整认证／Cookie 头的清理；不记录原始响应体、不改请求协议、不自动重试。离线错误样例不代表真实后端的拒绝原因。
- Toolkit 加载清单不再包含 `extensions/auto-mode.ts`；相应清单测试同步调整。原 Auto 源码保留，但不作为第二个门禁自动加载。
- Toolkit 上下文工具按当前 registry 中的定义确认归属，不再将 Pi 启动时自动激活的工具误认为外部基线；关闭功能会隐藏本插件工具，启用恢复。每次同步重新检查归属，部分注册失败或同名冲突时仅清理仍属于本插件的工具。新增控制器回归测试和真实 Pi 默认激活场景的冒烟测试。
- Toolkit 移除 npm `bun` 开发依赖，改为环境前置要求，避免跳过安装脚本后空执行文件造成测试假通过。
- pnpm catalog 和 TypeScript 基础配置取自 gotgenes 基线并缩减到当前使用项。

后续更新先 fetch 并审查对应包的变更，再导入选定目录、解决上述集成差异并运行检查。不要将整个上游主线直接 merge 到工作树，也不要在未决定授权边界前放宽审批规则。

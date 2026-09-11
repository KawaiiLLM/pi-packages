# Toolkit source snapshot

来源： https://github.com/awoaCrim/pi-openai-toolkit

基线提交：`32d568ab6b58f8c914e3c143d625869a71ad55a3`。

- `prompt.ts`：基于原 `src/auto-mode/prompt.ts`；与仓库内 Toolkit 同步新增 `forbidden` 明确禁止状态及优先否决规则，并在共享 verdict 归一化处将矛盾的 `forbidden + allow` 强制改为 `deny`。低风险简答和 classifier 提示同步修订；普通“继续”不撤销禁令，用户明确撤销或针对该操作重新授权才重新评估。
- `transcript.ts`：基于原 `src/auto-mode/transcript.ts`；本地修订为先按角色分组，用户 12,000 字符、其他材料 12,000 字符独立计费。其他材料最多 40 条，优先保留用户消息前的助手上下文；每条先裁剪，再计入行号、角色标签和换行，最后按原顺序呈现。
- `types.ts`：原 `src/auto-mode/types.ts`；去掉依赖根配置的 `AutoModeConfig` 类型导入与未使用的 `AutoModeGateSource` 类型别名，并新增 12,000 字符用户配额常量，总上限仍为 24,000 字符；`UserAuthorization` 同步新增 `forbidden`。
- `verdict.ts`：与仓库内 `pi-openai-toolkit/src/auto-mode/reviewer.ts` 从 `RISK_LEVELS` 到 `candidateJsonObjects` 的完整解析段同步，只补齐所需导入；解析器从后向前验证平衡的 JSON 对象，避免最终 verdict 前残留的序列化工具调用文本造成误回退。

相对导入补 `.ts` 后缀以便 Node 原生 TypeScript 测试加载。上述历史选择与预算修订由用户确认；verdict 修复先落在仓库内 Toolkit 实现，再同步到本快照，仍严格校验合法 `allow/deny` 并在无有效对象时失败关闭。除用户确认的 `forbidden` 否决规则外，其余授权政策及操作参数裁剪不变；它依赖模型识别可见禁令，不能补偿历史截断或漏识别。上游许可证与 NOTICE 同目录保留。

模型调用与原生日志由子代理生命周期管理，Auto 门禁由权限系统承担；调查工具只开放 `read/grep/find/ls`，轮次和工具边界由适配层执行。

# Toolkit source snapshot

来源： https://github.com/awoaCrim/pi-openai-toolkit

基线提交：`32d568ab6b58f8c914e3c143d625869a71ad55a3`。

- `prompt.ts`：原 `src/auto-mode/prompt.ts`。
- `transcript.ts`：原 `src/auto-mode/transcript.ts`。
- `types.ts`：原 `src/auto-mode/types.ts`；仅去掉依赖根配置的 `AutoModeConfig` 类型导入与未使用的 `AutoModeGateSource` 类型别名。
- `verdict.ts`：原 `src/auto-mode/reviewer.ts` 从 `RISK_LEVELS` 到 `candidateJsonObjects` 的完整解析段；只补齐所需导入。

相对导入补 `.ts` 后缀以便 Node 原生 TypeScript 测试加载。提示词、裁剪、历史选择和结果解析逻辑未修改；上游许可证与 NOTICE 同目录保留。未移植其模型调用循环、调查工具、日志和 Auto 门禁；这些分别由现有子代理生命周期与权限系统承担，审批代理仍无执行工具。

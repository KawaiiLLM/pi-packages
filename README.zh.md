# pi-openai-toolkit

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![license: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](./LICENSE)

面向 Pi 的 OpenAI 工具包：Codex 远端上下文窗口、远端无损压缩 v2、托管联网搜索、图像生成与 Auto 模式。

[English](./README.md)

`pi-openai-toolkit` 为 OpenAI Responses 协议族（`openai-responses` 与 `openai-codex-responses`）集成五个 Pi 扩展：

1. **压缩与远端上下文管理**（`extensions/compaction.ts`）：两套长上下文策略。[Codex 远端上下文管理](#codex-远端上下文管理)把 Codex 原生窗口体系移植到 Pi——无摘要 `new_context` 换窗（附成功的 notes checkpoint 硬门禁）、跨窗口 `history` / `notes` 工具（加密参数传输）、按预算触发的 checkpoint 提醒。关闭它时，本扩展走 **Remote Compaction v2**：服务端密文压缩，绝不做有损文本重摘要。
2. **联网搜索**（`extensions/web-search.ts`）：为 `provider/model-id` 精确白名单注入托管 `web_search`，复用当前模型连接。
3. **图像生成**（`extensions/image-generation.ts`）：由托管 `image_generation` 工具驱动的本地 `openai_generate_image`，支持文生图与显式本地参考图编辑，图像字节不进会话历史。
4. **Auto 模式**（`extensions/auto-mode.ts`）：为改变状态的工具调用增设审批模型门禁，Agent 不必停下来等你确认。
5. **Codex Astra**（`extensions/codex-astra.ts`）：为 `gpt-6-astra` 补发 Codex 后端版本门禁头，并用 `configuration_update` 会话项保住提示缓存。

本包是 Pi 扩展集而非可导入库：一切通过一个 JSON 配置文件驱动，在 Pi 内自动生效。

## 目录

- [背景](#背景)
- [安装](#安装)
- [使用](#使用)
  - [配置](#配置)
  - [功能指南](#功能指南)
- [安全](#安全)
- [开发](#开发)
- [API](#api)
  - [Remote Context 工具](#remote-context-工具)
  - [HTTP 协议参考](#http-协议参考)
- [维护者](#维护者)
- [贡献](#贡献)
- [许可证](#许可证)

## 背景

Pi 内置压缩会把旧轮次摘要成文本，细节随之丢失；OpenAI Codex 后端其实提供两种无损机制，普通客户端拿不到：**`remote_compaction_v2` SSE 协议**（用加密密文项替换被摘要的前缀）与实验性**上下文窗口体系**（`new_context` / `history` / `notes`，完全不做摘要地换窗）。本工具包对着真实后端实现了两者，并已在 Codex OAuth 与 Codex 兼容网关中继（NEWapi + CLIProxyAPI）上端到端验证。

来源说明：Remote Context 协议逆向自 `@howaboua/pi-codex-conversion@3.0.29`（source commit `7021ae48e8efe36a3becc5830d529696ff798e5e`）；Astra 适配层移植自 Oh My Pi 18.1.8（MIT）；联网搜索行为改编自 [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search)（commit `3964338`）。完整归属见 [NOTICE](./NOTICE)。alpha 的 `history`/`notes` 端点可能随时变更，本仓库的端点与 header fixture 必须同步更新。

要求 **Pi >= 0.85.1**、**Node.js >= 22.19.0**。模型目录与 Codex/API Key 登录由 Pi 提供；本包不实现独立登录流程，也绝不直接触碰凭据存储。

## 安装

```bash
pi install npm:pi-openai-toolkit
```

写入 Pi 全局配置，用 `pi list` 验证。只装到当前项目：

```bash
pi install npm:pi-openai-toolkit --local
```

从 git 安装（开发或锁版本）：

```bash
pi install git:github.com/awoaCrim/pi-openai-toolkit
```

### 更新

`pi update --extensions` 会连同本工具包一起更新 Pi 包。已发布版本见 [npm](https://www.npmjs.com/package/pi-openai-toolkit)。

### 冲突警告

不要将 `pi-remote-compact`、`@lll9p/pi-better-compaction` 或独立的 `pi-openai-web-search` 与本包同时运行：重复 hook 会造成竞态和系统提示词重复。

## 使用

所有功能由一个配置文件加会话内命令控制。无配置文件时：压缩与 Astra 在符合条件的模型上启用，联网搜索、图像生成、Auto 模式、Remote Context 全部默认不启用。

创建 `~/.pi/agent/extensions/pi-openai-toolkit/config.json`（Windows：`C:\Users\<user>\.pi\agent\extensions\pi-openai-toolkit\config.json`）：

```json
{
  "compaction": {
    "enabled": true,
    "contextManagement": "remote",
    "codexGatewayModels": ["uwoacrimson/gpt-6-astra"],
    "contextReminderThresholdPercent": 10,
    "allowCompactionContinuityBreak": false,
    "remoteCompactModel": "uwoacrimson/gpt-5.6-luna",
    "nativeFallback": { "enabled": true, "model": null, "thinkingLevel": "off" },
    "responsesApis": ["openai-responses", "openai-codex-responses"],
    "notifyOnLoad": false,
    "debug": false,
    "logProviderPayloads": false,
    "logCompactResponses": false,
    "redactSensitiveData": true,
    "artifactRoot": "~/.pi/agent/artifacts/pi-openai-toolkit/compaction"
  },
  "webSearch": { "enabled": true, "models": ["uwoacrimson/gpt-5.6-luna"] },
  "imageGeneration": { "enabled": false },
  "autoMode": {
    "enabled": true,
    "models": ["uwoacrimson/gpt-5.6-luna"],
    "reviewerModel": "uwoacrimson/gpt-5.6-luna",
    "gate": "side-effect"
  },
  "codexAstra": { "enabled": true, "models": ["uwoacrimson/gpt-6-astra"] }
}
```

之后正常启动 Pi，工具包自动加载并接管每个会话：

```bash
pi --model uwoacrimson/gpt-6-astra "继续部署任务"
```

### 配置

所有键都可选；未知键只告警忽略，不会回写你的文件。`models` 类键是精确 `provider/model-id` 白名单——只做 trim，不做通配——所以每个功能在你列入模型前都是关的。

#### `compaction`

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | 压缩扩展 hook 总开关。 |
| `contextManagement` | `"off"` \| `"remote"`, `"off"` | 为原生 Codex 模型及 `codexGatewayModels` 条目启用 Codex 远端上下文管理。覆盖模型由其独占：不发送 `remote_compaction_v2`，且取消 Pi 原生压缩（见[安全](#安全)）。设回 `"off"` 即回滚。 |
| `codexGatewayModels` | *string[]*, `[]` | 允许走 Codex 兼容网关跑 Remote Context 的精确 `provider/model-id`（如 `"uwoacrimson/gpt-5.6-luna"`，API 须为 `openai-responses`）。网关收到的是 `X-Codex-Model` 里的裸模型 ID，Base URL 保持配置的 `/v1`。 |
| `contextReminderThresholdPercent` | *integer* `0`-`100`, `5` | 仅 Remote Context：当前窗口剩余 token 低于窗口该百分比时，每窗口注入一次 checkpoint 提醒；`0` 关闭提醒（窗口耗尽兜底仍生效）。建议明显高于 Pi 原生 reserve 余量（默认 16384 token，约为 272k 窗口的 6%），让模型在撞阈值前有机会主动换窗。 |
| `allowCompactionContinuityBreak` | *boolean*, `false` | v2 路径：最近一次压缩由其他方式（如文本摘要）生成时，允许从当前文本上下文重建密文链。 |
| `remoteCompactModel` | *string \| null*, `null` | v2 路径：仅用于 synthetic `remote_compaction_v2` 请求的模型，会话模型不切换；必须与当前模型解析出相同生效 Base URL。 |
| `nativeFallback.enabled` | *boolean*, `true` | 远端请求已尝试但失败时，用显式摘要模型跑 Pi 原生压缩；成功远端链路不受影响。 |
| `nativeFallback.model` | *string \| null*, `null` | 仅用于完全无法走 v2 的模型（非 Responses API 或被 `responsesApis` 排除）；`null` 用当前模型。 |
| `nativeFallback.thinkingLevel` | *string*, `"off"` | 本扩展指定模型时传给 Pi `compact()` 的思考级别。 |
| `responsesApis` | *string[]*, 两个 API | 限定可尝试远端压缩的 API 标识符子集；仅 `contextManagement` 为 `"off"` 时生效。 |
| `notifyOnLoad` | *boolean*, `false` | 启动横幅通知。 |
| `debug` | *boolean*, `false` | 在 `artifactRoot` 下写 lifecycle 与压缩 artifact，含每次 `session_start` 的 Remote Context 激活结果与原因。 |
| `logProviderPayloads` / `logCompactResponses` | *boolean*, `false` | 额外把原始 provider 请求体与压缩 SSE 事件写入 artifact。除非排查特定请求，保持关闭。 |
| `redactSensitiveData` | *boolean*, `true` | artifact 全量脱敏；即使设为 `false`，Authorization 凭据、API Key/Token、Codex account ID 与 `encrypted_content` / `encrypted_output` 也始终脱敏。 |
| `artifactRoot` | *string*, `~/.pi/agent/artifacts/pi-openai-toolkit/compaction` | artifact 根目录；相对路径基于配置目录解析。 |

#### `webSearch`

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | 总开关。 |
| `models` | *string[]*, `[]` | 接收托管 `web_search` 注入的精确白名单（限 Responses 系 API）。名单内模型的上行载荷会移除本地 `web_search` 函数工具，原生搜索成为唯一路径；切到名单外模型即恢复。 |

#### `imageGeneration`

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `enabled` | *boolean*, `false` | `openai_generate_image` 的唯一开关。默认关闭，因为每次成功请求都可能产生费用。无模型白名单：托管图像工具是 Responses API 能力，对所有 Responses 系模型暴露、其余隐藏。 |

#### `autoMode`

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | 总开关；未列入白名单或未设 `reviewerModel` 前依然无法启用。 |
| `models` | *string[]*, `[]` | 允许进入 auto 模式的当前会话模型白名单。 |
| `reviewerModel` | *string \| null*, `null` | 审批模型（`provider/model-id`，经 Pi 注册表解析）。只用于单次审批请求，绝不成为会话模型。 |
| `gate` | `"side-effect"` \| `"all"`, `"side-effect"` | 审批范围；`/auto all` 把当次会话扩到全部工具。 |
| `extraTools` | *string[]*, `[]` | 在副作用集（`bash`、`write`、`edit`）之外追加审批的工具名。 |
| `timeoutMs` | *integer* 1000-120000, `30000` | 审批模型全部轮次的总时限；超时绝不视为通过。 |
| `transcript` | *boolean*, `true` | 给审批模型有界的会话视图，使其能判断"用户是否授权"而非只看命令危险度。 |
| `evidenceTools` | *boolean*, `true` | 允许审批模型先用 Pi 只读工具（`read`/`grep`/`find`/`ls`）查证；它永远拿不到 `bash`、写工具或网络。 |
| `maxEvidenceRounds` | *integer* 0-8, `3` | 调查轮数上限；`0` 为单次补全。 |
| `classifier.*` | 见码内说明 | 可选非阻塞低风险预打分（`enabled` `false`、`model`、`timeoutMs` `15000`、`maxLag` `2`），只能给普通调用开快车道，绝不否决。 |
| `circuitBreaker.*` | — | 否决熔断（连续 `consecutiveDenials` `3` 或窗口 `windowSize` `50` 内 `recentDenials` `10` 结束回合；`0` 关闭）。 |

#### `codexAstra`

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Astra 兼容层：后端版本门禁头 + 保缓存的档位改写（见下）。 |
| `models` | *string[]*, `[]` | 接受 `configuration_update` 输入项的模型（目前仅 Astra 世代，如网关侧 `"uwoacrimson/gpt-6-astra"`）；版本头则对所有 `openai-codex-responses` 请求生效，与本名单无关。宿主（如 Oh My Pi）已实现同款改写时只开一边，避免双重插入。 |

模型目录说明：Pi 内置 `openai-codex` 列表可能还没有 `gpt-6-astra`。在 `~/.pi/agent/models.json` 的内置 provider 下登记（`api: "openai-codex-responses"`、`baseUrl: "https://chatgpt.com/backend-api"`、`contextWindow: 272000`、`maxTokens: 128000`、`thinkingLevelMap` `low`…`max`）；令牌由 Pi 的 Codex OAuth 提供。

### 功能指南

#### Codex 远端上下文管理

`contextManagement` 为 `"remote"` 且会话模型被覆盖（原生 `openai-codex`，或 `codexGatewayModels` 中精确匹配且 API 为 `openai-responses` 的条目）时，会话进入 Codex 窗口生命周期：

- **窗口身份。** `session_start` 初始化窗口（first/current/previous id、窗口编号），以 `codex-context-window` 自定义消息持久化进 Pi 会话；resume 回放、fork 后重建。实时请求携带 `x-codex-window-id` 与 `x-codex-turn-metadata`。
- **无摘要换窗。** `new_context` 安装新窗口并把旧窗口从模型上下文裁剪，不做任何再摘要；旧轮次仍可通过服务端 `history` 取回。
- **Checkpoint 门禁。** 换窗前必须存在当前窗口内*成功的* `notes` `append_to_file` / `write_file`，校验基于持久化会话分支重建（重启后依然有效）；不满足时 `new_context` 拒绝。`force: true` 是用户明确授权丢弃的唯一逃生口；Toolkit 自己的窗口耗尽兜底会在要求最后一次 notes 写入后自动绕过门禁。
- **预算。** `get_context_remaining` 报告实时窗口预算；`contextReminderThresholdPercent` 控制每窗口一次的 checkpoint 提醒。
- **压缩独占。** 覆盖模型的全部压缩事件由本包接管：不发送 v2；即使 Remote 运行时暂时未激活也取消 Pi 原生压缩（阈值、手动 `/compact`、溢出三条路径全拦），不会有有损摘要背地里插入。未激活原因以通知呈现（`debug` 开启时同时写入 `session_start` lifecycle artifact 的 `activation` 字段），请修复该原因而非期待压缩。

原生路线经 `ModelRegistry` 复用 Pi 的 Codex OAuth；网关路线只用配置的数据面 API key——本地 OAuth 凭据、account cookie、account ID 绝不转发给网关。

**验证是否激活。** `/reload` 或新开会话后：会话里应出现 `codex-context-window` 边界消息，`new_context` / `get_context_remaining` / `history` / `notes` 工具可用。`debug: true` 时每次 `session_start` 在 `artifactRoot` 下写 lifecycle artifact，`activation` 字段记录 `active` 或未激活的确切原因（如 `tool-name-conflict`、`missing-api-key`、`auth-resolution-failed`）。

#### Remote Compaction v2

`contextManagement` 关闭时，符合条件的 Responses 会话走 v2：在实时流式请求尾部追加 `compaction_trigger`，响应需返回恰好一个带非空 `encrypted_content` 的 `type: "compaction"` 输出项，密文存入 `CompactionEntry.details.compactedWindow`；后续请求把密文项前置回放——零丢失、无文本摘要。回放有 fail-closed 保护：找不到摘要锚点即中止请求并通知、写无内容失败 artifact，绝不发送 sentinel 裸载荷。降级层：远端尝试失败可交给 Pi 原生压缩（`remoteCompactModel`/当前模型）；完全不能用 v2 的模型走 `nativeFallback`。Pi 0.85.1+ 自己驱动自动压缩，本包不再另起驱动器。

#### Auto 模式

会话内用 `pi --auto` 或 `/auto on` 启用（页脚显示状态；启用动作本身不发起任何请求）。被门禁的每个调用由 `reviewerModel` 审批：分开评估行为固有风险与对话授权程度，按固定表得出 `allow`/`deny`；审批模型可先跑只读工具取证；否决会把理由与禁止绕条款返回给请求模型；未完成的审批（超时/取消/报错）按故障上报，绝不伪装成安全结论。所有决策以非上下文会话条目持久化备审计。无 UI（`-p`/JSON）时无人可升级确认，审批不可用即拦截。

## 安全

- **覆盖模型不会有静默的有损摘要。** `contextManagement: "remote"` 覆盖某模型期间，Pi 原生压缩在阈值、手动 `/compact`、溢出全部路径上被取消，v2 也不发送。若想再加宿主级保险，在 Pi `settings.json` 设 `"compaction": { "enabled": false }`；覆盖范围外的模型照常走 Pi 自己的策略。
- **网关隔离。** 网关模式只转发配置的数据面 key；OAuth 令牌、account cookie、account ID 一律剥离；artifact 中凭据与不透明密文永远脱敏。
- **Checkpoint 门禁。** `new_context` 无法在没有本窗口成功 notes 写入、也没有用户显式 `force` 授权时丢弃未保存工作状态——Codex 官方实验特性上出现过的"后端故障 + 换窗丢状态"在此被硬拦。
- **计费与审批边界。** 图像生成显式开启且可能产生费用；审批请求禁用提示缓存、只授予只读工具，无 UI 会话 fail-closed。

## 开发

```bash
npm run typecheck   # tsc 项目检查
bun test            # 全量单元测试
npm run test:pi     # Pi 集成冒烟测试
npm pack --dry-run  # 检查发布包内容
```

Remote Context 协议 fixture（`src/context-management/`）必须与上游 alpha 端点变更同步更新。

## API

### Remote Context 工具

Remote Context 激活时注册的四个工具：

| 工具 | 参数 | 结果 / 错误 |
| --- | --- | --- |
| `new_context` | `{ force?: boolean }` | 换到下一窗口，不摘要。当前窗口没有成功的 notes checkpoint 时拒绝（`force` 可越过）；已有换窗排队时报告 "already scheduled"。 |
| `get_context_remaining` | 无 | 当前窗口剩余 token 与窗口身份；尚无任何用量来源时返回 unknown。 |
| `history` | `{ action: "list_windows" \| "list_items" \| "read_item" \| "search_contents", ... }` | 读取既往窗口。返回的 `item_id`/窗口 ID 必须原样传递；搜索词按加密参数策略发送。 |
| `notes` | `{ action: "list_files_by_prefix" \| "read_file" \| "search_contents" \| "append_to_file" \| "write_file", path, text, ... }` | 跨窗口工作记忆。路径解析到会话 agent 目录下（如 `/root/notes/<file>` 或相对路径）；非法路径由后端拒绝。成功的 append/write 就是满足 `new_context` 门禁的凭证。 |

四个工具在超时、取消、非 2xx、非法 JSON、认证、协议故障时都抛出明确工具错误，绝不静默降级。

### HTTP 协议参考

内部 alpha 端点，改编自 `@howaboua/pi-codex-conversion`（见[背景](#背景)）：

```text
POST {base}/alpha/history/v2/list_windows | list_items | read_item | search_contents
POST {base}/alpha/notes/v2/list_files_by_prefix | read_file | search_contents | append_to_file | write_file
GET  {base}/alpha/notes/v2/thread_hint
```

原生路线 `{base} = <backend-api>/codex`，携带 `Authorization: Bearer <oauth token>`、`ChatGPT-Account-ID` 与 Codex CLI 头。网关路线用配置的 `/v1` base + 数据面 API key，携带 `originator: codex_cli_rs`、`X-Codex-Affinity-Scope`、`X-Codex-Model`（裸模型 ID）——绝不含本地凭据。两条路线都设置 `Session-Id` / `X-Client-Request-Id`（有界的 Pi 会话 ID）、`x-openai-tool-output-truncation-policy`，加密参数端点另带 `x-openai-encrypted-tool-arguments`；加密结果以 `encrypted_output` 返回并重新编码进后续请求。这些是 alpha 契约，上游可能随时变更。

## 维护者

[awoaCrim](https://github.com/awoaCrim)

## 贡献

欢迎在 [issue 区](https://github.com/awoaCrim/pi-openai-toolkit/issues)提问和提交 PR。涉及行为变更请先开 issue 讨论（尤其是 alpha `history`/`notes` 协议假设）。提交前跑 `bun test` 与 `npm run typecheck`；新的线路协议行为需要 fixture 测试。

## 许可证

MIT © awoaCrim and contributors。见 [LICENSE](./LICENSE)，第三方归属见 [NOTICE](./NOTICE)。

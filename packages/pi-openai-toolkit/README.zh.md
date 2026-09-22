# pi-openai-toolkit

> **pi-packages 集成版本**：独立 Auto 门禁已从加载清单移除，审批改由 `pi-permission-system` 与 `pi-auto-mode` 负责。其他功能保留。下文为上游文档，Auto 配置与 `/auto` 用法不适用于本发行版的默认加载方式。来源及差异见仓库根目录 `UPSTREAMS.md`。

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![license: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](./LICENSE)
[English](./README.md)

面向 Pi 的 OpenAI 工具包：无损长会话上下文管理、托管联网搜索、图像生成与带审批门禁的 Auto 模式。

Pi 内置压缩把较早的轮次摘要为文本，细节永久丢失。OpenAI Codex 后端用一整套通用客户端从未获得的机制解决这个问题：上下文窗口体系（`new_context`、`history`、`notes`）、加密无损压缩、托管工具。本包通过对接真实后端协议，把这些 Codex 能力移植进 Pi；Auto 模式则是本包自有功能。需要说明：覆盖模型会话中出现的窗口工具是 Codex 的机制、由本包接通，并非 Pi 或本包独立发明的能力。

## 特性

- **上下文窗口**（Codex 机制移植）- `new_context` 切换新窗口，全程不重摘要
- **跨窗口回读** - `history` 搜索、阅读更早窗口的原始内容
- **工作记忆笔记** - `notes` 持久化存档，作为每次换窗的门禁
- **加密压缩 v2** - OpenAI 后端压缩能力，为 Responses 模型接通
- **托管联网搜索** - OpenAI Responses 原生 `web_search`，对列入的模型替换 Pi 本地工具
- **图像生成** - 托管 `image_generation`（可配置模型）的 Pi 封装，图像字节不入会话历史
- **Auto 模式** - 本包自有功能：副作用工具调用的审查模型门禁
- **安全承诺** - 覆盖模型上杜绝有损摘要，凭据不出本机

需要 Pi >= 0.85.1、Node.js >= 22.19.0。本包不注册任何 provider 或模型，全部经由 Pi 已有的目录、登录与会话存储工作。不要与 `pi-remote-compact`、`@lll9p/pi-better-compaction` 或独立的 `pi-openai-web-search` 同时运行：重复 hook 会导致竞态。

## 安装

```bash
pi install npm:pi-openai-toolkit
```

仅安装到当前项目：

```bash
pi install npm:pi-openai-toolkit --local
```

从 git 安装（开发或锁定构建）：

```bash
pi install git:github.com/awoaCrim/pi-openai-toolkit
```

后续用 `pi update --extensions` 更新。

## 快速开始

**1.** 创建 `~/.pi/agent/extensions/pi-openai-toolkit/config.json`（Windows：`C:\Users\<user>\.pi\agent\extensions\pi-openai-toolkit\config.json`）：

```json
{
  "compaction": {
    "contextManagement": "remote",
    "contextReminderThresholdPercent": 10
  }
}
```

**2.** 在覆盖的模型上启动 Pi：Pi 内置 Codex provider（`openai-codex`）上的任意会话，或已列入 `gatewayContextModels` 的网关模型：

```bash
pi --model uwoacrimson/gpt-6-astra
```

**3.** 确认生效：会话内出现四个 Codex 上下文工具（`new_context`、`get_context_remaining`、`history`、`notes`）。

窗口余量低于提醒阈值时，模型收到一次提醒：存档笔记并换窗。更早的内容始终可通过 `history` 搜索。没有配置文件时，Pi 按默认策略运行，所有可选功能保持关闭。

网关覆盖是一份显式白名单：`compaction.gatewayContextModels` 逐条列出 `provider/model` 精确键，模型须走 `openai-responses` 线路，且你的网关确实透传 Codex 窗口标记。若 Pi 中尚未配置该网关，在 `~/.pi/agent/models.json` 添加：

```json
{
  "providers": {
    "uwoacrimson": {
      "baseUrl": "https://<your-gateway>/v1",
      "apiKeyRef": "uwoacrimson",
      "api": "openai",
      "models": [{
        "id": "gpt-6-astra",
        "name": "GPT-6 Astra",
        "api": "openai-responses",
        "reasoning": true,
        "input": ["text"],
        "contextWindow": 272000,
        "maxTokens": 16384,
        "compat": {"thinkingLevelMap": {"off": 0, "minimal": 0.1, "low": 0.2, "medium": 0.5, "high": 1, "xhigh": 2, "max": 2}}
      }]
    }
  }
}
```

## 用法

### Codex Remote Context

这是 Codex 自身的上下文窗口机制，由本包为 Pi 实现。覆盖模型的会话按 Codex 客户端的方式运行：模型在上下文窗口中工作，用 `notes` 存档状态，在窗口装满前调用 `new_context`。不发生任何摘要，更早窗口通过 `history` 完整可读。本窗口没有成功笔记存档时换窗会被拒绝；resume 与 fork 后规则不变。提醒与窗口耗尽消息只向模型建议，换窗始终由模型自己调用 `new_context` 完成。

覆盖模型的压缩路径由本包独占：Pi 原生压缩全部取消，有损摘要无法进入会话。Remote Context 无法激活时，以通知报告确切原因。

生命周期机制与协议契约：[docs/internals.md](docs/internals.md#rollover-lifecycle)。

### Remote Compaction v2

适用于其他 Responses 模型：压缩触发时，本包请求 OpenAI 后端的压缩能力为旧前缀生成加密检查点，而非由文本摘要顶替；检查点由服务端计算，客户端只负责存储与回放。后续请求将其回放到较近轮次之前。远端尝试失败时回退到 Pi 原生压缩（`nativeFallback`）。线路契约：[docs/internals.md](docs/internals.md#remote-compaction-v2-wire-contract)。

### 联网搜索

```json
{
  "webSearch": { "enabled": true, "models": ["uwoacrimson/gpt-5.6-luna"] }
}
```

列入的模型获得 OpenAI 托管 `web_search`，其本地 `web_search` 工具从载荷移除。复用当前模型连接，无需额外 key。

### 图像生成

图像生成需要 Responses 会话，并且可能产生服务商费用。启用方式如下：

```json
{
  "imageGeneration": {
    "enabled": true,
    "models": ["gpt-image-2.5", "grok-imagine-image-2.0"]
  }
}
```

`models` 填写嵌套 Responses `image_generation` 工具使用的裸模型 ID。列表第一项是默认模型；`openai_generate_image` 也支持通过可选的 `model` 参数在单次调用中切换，但该值必须与配置列表中的某一项完全一致。省略 `models` 时默认使用 `gpt-image-2.5`。列表为空或格式无效时会告警并回退到默认模型；如果要关闭工具，将 `enabled` 设置为 `false`。服务商或网关必须实际支持配置的生图模型。

`openai_generate_image` 支持文生图，也支持使用明确传入的本地参考图片进行编辑。

### Auto 模式

```json
{
  "autoMode": {
    "enabled": true,
    "models": ["uwoacrimson/gpt-5.6-luna"],
    "reviewerModel": "uwoacrimson/gpt-5.6-luna"
  }
}
```

会话内用 `/auto on` 启用。副作用工具调用由 `reviewerModel` 批准（固有风险 + 对话授权），不再阻塞等用户。审查员仅有只读工具，超时不视为批准，无头会话一律阻断而非猜测。每条决定落盘可审计。

## 配置

配置文件唯一：`~/.pi/agent/extensions/pi-openai-toolkit/config.json`。所有键可选，未知键告警忽略。`models` 键是精确 `provider/model-id` 白名单（不支持通配），列入前功能保持关闭。

<details>
<summary><b>完整选项参考</b>（compaction、webSearch、imageGeneration、autoMode）</summary>

### `compaction`

| 键 | 类型 / 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | 压缩扩展总开关。 |
| `contextManagement` | `"off"` \| `"remote"`, `"off"` | 为覆盖模型开启 Codex Remote Context：`openai-codex-responses` API 上的任意 `openai-codex` 会话，加上下列白名单中的网关模型。 |
| `gatewayContextModels` | *string[]*, `[]` | 允许经 `openai-responses` 网关线路使用 Codex Remote Context 的 `provider/model` 精确键。覆盖范围由使用者配置；原生 Codex 路线不看此列表。 |
| `contextReminderThresholdPercent` | *integer* `0`-`100`, `5` | 当剩余量低于可用预算（上下文窗口减去固定 16384 token 输出预留）的该百分比时，注入每窗口一次的 checkpoint 提醒。`0` 会连同窗口耗尽兜底一起关闭（当前实现如此），请保持大于 0。该阈值度量本包自己的预算，与 Pi 原生预留为固定数值配合，并非运行时动态联动。 |
| `allowCompactionContinuityBreak` | *boolean*, `false` | v2：最近一次压缩来自其他策略（如安装前的文本摘要）时，重建全新密文链。 |
| `remoteCompactModel` | *string \| null*, `null` | v2：仅用于服务端压缩请求的模型，会话模型不切换。必须与当前模型同 base URL。 |
| `nativeFallback.enabled` | *boolean*, `true` | 仅在远端压缩确实失败后回退到原生压缩。 |
| `nativeFallback.model` | *string \| null*, `null` | 完全无法使用 v2 的模型的摘要模型。`null` 沿用当前模型。 |
| `nativeFallback.thinkingLevel` | *string*, `"off"` | 回退摘要的 thinking level（`off`...`max`）。 |
| `responsesApis` | *string[]*, 两个 API | 允许使用 v2 压缩的 Responses API 标识。v2 只作用于未被 Remote Context 覆盖的模型。 |
| `notifyOnLoad` | *boolean*, `false` | 启动横幅。 |
| `debug` | *boolean*, `false` | 向 `artifactRoot` 写生命周期与压缩 artifact，含每次 `session_start` 的激活原因。 |
| `logProviderPayloads` / `logCompactResponses` | *boolean*, `false` | 额外写原始载荷与 SSE 响应体，排查特定请求时再开。 |
| `redactSensitiveData` | *boolean*, `true` | artifact 脱敏；凭据、account ID、密文永远脱敏。 |
| `artifactRoot` | *string*, `~/.pi/agent/artifacts/pi-openai-toolkit/compaction` | artifact 根目录；相对路径按配置目录解析。 |

### `webSearch`

| 键 | 类型 / 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | 总开关。 |
| `models` | *string[]*, `[]` | 接收 OpenAI 托管 `web_search` 的会话：本地 `web_search` 工具被移除，原生 Responses API 工具被注入。 |

### `imageGeneration`

| 键 | 类型 / 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | *boolean*, `false` | 向所有 Responses 协议会话开放 `openai_generate_image`。有意不设模型白名单。 |

### `autoMode`

| 键 | 类型 / 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | 总开关；启用模式仍需列入模型并设置 `reviewerModel`。 |
| `models` | *string[]*, `[]` | 允许运行 Auto 模式的会话模型。 |
| `reviewerModel` | *string \| null*, `null` | 一次性审查的审批模型，绝不成为对话模型。 |
| `gate` | `"side-effect"` \| `"all"`, `"side-effect"` | 审查范围；`/auto all` 按会话切换。 |
| `extraTools` | *string[]*, `[]` | 在 `bash`、`write`、`edit` 之外追加审查的工具。 |
| `timeoutMs` | *integer* 1000-120000, `30000` | 审查总时限。超时不视为批准。 |
| `transcript` | *boolean*, `true` | 提供有界对话视图，供审查员判断授权情况。 |
| `evidenceTools` | *boolean*, `true` | 审查员可用 `read`、`grep`、`find`、`ls`；永远没有 `bash`、写工具与网络。 |
| `maxEvidenceRounds` | *integer* 0-8, `3` | 出结论前的调查轮数；`0` 为单次补全。 |
| `classifier.*` | *object* | 可选非阻塞低风险预打分器，只放行、不否决。 |
| `circuitBreaker.*` | *object* | 连续否决结束回合（`consecutiveDenials` `3`，或 `windowSize` `50` 内 `recentDenials` `10`；`0` 关闭）。 |

### `codexAstra`

已移除的配置段。Astra 兼容层对所有 Responses 系 API 的 `gpt-6-astra` 会话静默启用；旧 `codexAstra` 配置按未知字段告警忽略。若其他宿主（如 Oh My Pi）实现了同款改写，只启用一边。

</details>

## 安全

- 覆盖模型被 Remote Context 接管期间，Pi 原生压缩全部路径（阈值、手动 `/compact`、溢出）取消，无法产生有损摘要。
- 网关模式只转发配置的数据面 API key。OAuth token、account cookie、account ID 绝不发给网关，artifact 中永远脱敏。
- `new_context` 无法丢弃未保存状态：必须有本窗口成功的 notes 存档，或用户显式 `force`。
- 图像生成（计费）与 Auto 模式均需显式开启；无人可批准的场景下 Auto 模式阻断。

需要宿主层保险时，在 Pi 的 `settings.json` 设置 `"compaction": { "enabled": false }`。

## 开发

```bash
npm run typecheck    # tsc 项目检查
bun test             # 单元测试
npm run test:pi      # Pi 集成冒烟测试
npm pack --dry-run   # 检查发布包内容
```

## 文档

- [docs/internals.md](docs/internals.md) - 协议端点、换窗生命周期、v2 线路契约、artifact、来源归属
- [README.md](README.md) - 英文原版（canonical）
- [NOTICE](./NOTICE) - 第三方归属

## 贡献

欢迎在 [issue 区](https://github.com/awoaCrim/pi-openai-toolkit/issues)提问和提交 PR。行为变更前先开 issue 讨论协议假设；提交前运行 `bun test` 与 `npm run typecheck`，线路变更需要 fixture 测试。

## 维护者

[awoaCrim](https://github.com/awoaCrim)

## 许可证

MIT © awoaCrim and contributors。见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。

## 致谢

感谢 [Linux.do](https://linux.do/) 社区的支持与讨论。

---

*本文译自 [README.md](README.md)。若两版内容冲突，以英文版为准。*

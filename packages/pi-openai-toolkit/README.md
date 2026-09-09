# pi-openai-toolkit

> **Pi AgentFlow integration:** the standalone Auto gate is excluded from the extension manifest. Approvals belong to `pi-permission-system` and `pi-auto-mode`; other features remain. The upstream Auto configuration and `/auto` instructions below do not apply to this distribution's default loading. See the repository-root `UPSTREAMS.md` for provenance and changes.

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![license: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](./LICENSE)
[简体中文](./README.zh.md)

OpenAI toolkit for Pi: lossless long-session context management, hosted web search, image generation, and approval-gated auto mode.

Pi's built-in compaction summarizes older turns into text, permanently losing detail. The OpenAI Codex backend solves this with mechanisms generic clients never received: a context-window system (`new_context`, `history`, `notes`), encrypted lossless compaction, and hosted tools. This package ports those Codex capabilities into Pi by implementing their protocols against the live backends; Auto Mode is its own feature. One note: the context-window tools you see in a covered session are Codex's mechanism, surfaced by this toolkit, not something Pi or this package invented independently.

## Features

- **Context windows** (Codex mechanism, ported) - roll over to a fresh window with `new_context`; nothing is re-summarized
- **Cross-window recall** - search and read earlier windows with `history`
- **Working-memory notes** - persistent checkpoint files with `notes`, gating every rollover
- **Encrypted compaction (v2)** - OpenAI backend compaction capability, surfaced for Responses models
- **Hosted web search** - OpenAI Responses native `web_search`, swapped in for Pi's local tool on listed models
- **Image generation** - hosted `image_generation` (gpt-image-2) wrapped in a Pi tool that keeps image bytes out of history
- **Auto mode** - this package's own feature: a reviewer-model approval gate for side-effecting tool calls
- **Safety guarantees** - no lossy summary on covered models, credentials never leave the machine

Requires Pi >= 0.85.1 and Node.js >= 22.19.0. The toolkit registers no provider or model of its own; it works entirely through Pi's existing catalog, auth, and session storage. Do not run `pi-remote-compact`, `@lll9p/pi-better-compaction`, or a standalone `pi-openai-web-search` alongside it: duplicate hooks cause race conditions.

## Install

```bash
pi install npm:pi-openai-toolkit
```

Per-project install:

```bash
pi install npm:pi-openai-toolkit --local
```

Install from git for development or pinned builds:

```bash
pi install git:github.com/awoaCrim/pi-openai-toolkit
```

Update later with `pi update --extensions`.

## Quick start

**1.** Create `~/.pi/agent/extensions/pi-openai-toolkit/config.json` (Windows: `C:\Users\<user>\.pi\agent\extensions\pi-openai-toolkit\config.json`):

```json
{
  "compaction": {
    "contextManagement": "remote",
    "contextReminderThresholdPercent": 10
  }
}
```

**2.** Start Pi on a covered model: any session on Pi's built-in Codex provider (`openai-codex`), or a gateway model listed in `gatewayContextModels`:

```bash
pi --model uwoacrimson/gpt-6-astra
```

**3.** Confirm activation: the four Codex context tools (`new_context`, `get_context_remaining`, `history`, `notes`) appear in the session.

When the window drops below the reminder threshold, the model gets one nudge to save notes and roll over. Everything earlier stays searchable through `history`. With no config file, Pi's defaults apply and every optional feature stays off.

Gateway coverage is an explicit allowlist: `compaction.gatewayContextModels` holds exact `provider/model` keys, each on the `openai-responses` wire and actually relayed by your gateway with Codex window markers intact. If your gateway isn't configured in Pi yet, add it to `~/.pi/agent/models.json`:

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

## Usage

### Codex Remote Context

This is Codex's own context-window mechanism, implemented for Pi by this toolkit. Covered sessions run like they do in the Codex client: the model works in context windows, checkpoints state into `notes`, and calls `new_context` before the window fills. Nothing is summarized; earlier windows remain fully readable through `history`. A rollover is refused unless a notes checkpoint succeeded in the current window, and the session survives resume and fork with the same rules. Reminder and exhausted-window messages only advise the model; every rollover is the model's own tool call.

The toolkit owns compaction for covered models: Pi-native compaction is cancelled on every path, so no lossy summary can enter the session. If Remote Context cannot activate, the exact reason is reported as a notification.

Lifecycle mechanics and protocol contracts: [docs/internals.md](docs/internals.md#rollover-lifecycle).

### Remote Compaction v2

For other Responses models: when compaction triggers, the toolkit asks the OpenAI backend's compaction capability for an encrypted checkpoint of the old prefix instead of allowing a text summary to replace it; the server computes the checkpoint, the client only stores and replays it. Later requests replay the checkpoint ahead of recent turns. Failed attempts degrade to Pi's native compaction (`nativeFallback`). Wire contract: [docs/internals.md](docs/internals.md#remote-compaction-v2-wire-contract).

### Web search

```json
{
  "webSearch": { "enabled": true, "models": ["uwoacrimson/gpt-5.6-luna"] }
}
```

Listed models get OpenAI's hosted `web_search`; their local `web_search` tool is removed from the payload. The live model connection is reused, no extra key.

### Image generation

```json
{
  "imageGeneration": { "enabled": true }
}
```

Adds `openai_generate_image` to every Responses-wire session, wrapping OpenAI's hosted `image_generation` tool (`gpt-image-2`): text-to-image and edits from explicitly passed local reference files. The wrapper stores image bytes as artifacts instead of session history. Each successful request may incur a charge, hence the default off.

### Auto mode

```json
{
  "autoMode": {
    "enabled": true,
    "models": ["uwoacrimson/gpt-5.6-luna"],
    "reviewerModel": "uwoacrimson/gpt-5.6-luna"
  }
}
```

Engage per session with `/auto on`. Side-effecting tool calls are approved by `reviewerModel` (intrinsic risk plus conversation authorization) instead of blocking on the user. The reviewer has read-only tools only, a timeout is never approval, and headless sessions block instead of guessing. Decisions are persisted for audit.

## Configuration

One JSON file at `~/.pi/agent/extensions/pi-openai-toolkit/config.json`. Every key is optional; unknown keys are ignored with a warning. `models` keys are exact `provider/model-id` allowlists (no globbing); each feature stays off until a model is listed.

<details>
<summary><b>Full option reference</b> (compaction, webSearch, imageGeneration, autoMode)</summary>

### `compaction`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Master switch for the compaction extension. |
| `contextManagement` | `"off"` \| `"remote"`, `"off"` | Enables Codex Remote Context for covered models: any `openai-codex` session on the `openai-codex-responses` API, plus gateway models listed below. |
| `gatewayContextModels` | *string[]*, `[]` | Exact `provider/model` keys allowed to use Codex Remote Context over the `openai-responses` gateway wire. Coverage is operator-configured; the native Codex route ignores this list. |
| `contextReminderThresholdPercent` | *integer* `0`-`100`, `5` | Percentage of the usable budget (context window minus a fixed 16384-token output reserve) below which the once-per-window checkpoint reminder fires. `0` suppresses the reminder and, in the current implementation, the exhausted-window fallback too; keep it above 0. The threshold measures the toolkit's budget, a fixed pairing with Pi's native reserve rather than a live sync. |
| `allowCompactionContinuityBreak` | *boolean*, `false` | v2: rebuild a fresh encrypted chain when the latest compaction came from another strategy (e.g. a pre-install text summary). |
| `remoteCompactModel` | *string \| null*, `null` | v2: model for the server-side compaction request only; the session model never switches. Must resolve to the same base URL as the active model. |
| `nativeFallback.enabled` | *boolean*, `true` | Native compaction fallback, only after a remote attempt actually failed. |
| `nativeFallback.model` | *string \| null*, `null` | Summary model for models that cannot use v2 at all. `null` keeps the active model. |
| `nativeFallback.thinkingLevel` | *string*, `"off"` | Thinking level for the fallback summary (`off`...`max`). |
| `responsesApis` | *string[]*, both APIs | Which Responses API identifiers may use v2 compaction. v2 only applies to models that Remote Context does not cover. |
| `notifyOnLoad` | *boolean*, `false` | Startup banner. |
| `debug` | *boolean*, `false` | Write lifecycle and compaction artifacts under `artifactRoot`, including the activation reason per `session_start`. |
| `logProviderPayloads` / `logCompactResponses` | *boolean*, `false` | Also write raw provider payloads and SSE bodies. Off unless debugging one request. |
| `redactSensitiveData` | *boolean*, `true` | Artifact redaction; credentials, account ids, and encrypted payloads are always redacted. |
| `artifactRoot` | *string*, `~/.pi/agent/artifacts/pi-openai-toolkit/compaction` | Artifact root; relative paths resolve against the config directory. |

### `webSearch`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Master switch. |
| `models` | *string[]*, `[]` | Sessions receiving OpenAI's hosted `web_search`: the local `web_search` tool is removed and the native responses-API tool injected. |

### `imageGeneration`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `false` | Exposes `openai_generate_image` to all Responses-wire sessions. No model allowlist by design. |

### `autoMode`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Master switch; engaging still needs a listed model and `reviewerModel`. |
| `models` | *string[]*, `[]` | Session models allowed to run auto mode. |
| `reviewerModel` | *string \| null*, `null` | Approving model for one-off reviews; never becomes the conversation model. |
| `gate` | `"side-effect"` \| `"all"`, `"side-effect"` | Review scope; `/auto all` switches per session. |
| `extraTools` | *string[]*, `[]` | Additional reviewed tools beyond `bash`, `write`, `edit`. |
| `timeoutMs` | *integer* 1000-120000, `30000` | Review deadline. Expiry is never approval. |
| `transcript` | *boolean*, `true` | Bounded conversation view so the reviewer can judge authorization. |
| `evidenceTools` | *boolean*, `true` | Reviewer may use `read`, `grep`, `find`, `ls`. Never `bash`, writes, or network. |
| `maxEvidenceRounds` | *integer* 0-8, `3` | Investigation rounds before the verdict; `0` is a single completion. |
| `classifier.*` | *object* | Optional non-blocking low-risk pre-scorer. Fast-path only, never denies. |
| `circuitBreaker.*` | *object* | End the turn after repeated denials (`consecutiveDenials` `3`, or `recentDenials` `10` within `windowSize` `50`; `0` disables). |

### `codexAstra`

Removed section. The Astra compatibility layer activates silently for any `gpt-6-astra` session on a Responses-family API; old `codexAstra` config sections are ignored with a warning. If another host (e.g. Oh My Pi) implements the same rewrite, enable only one.

</details>

## Security

- On covered models, every Pi-native compaction path (threshold, manual `/compact`, overflow) is cancelled while Remote Context owns the session; no lossy summary is possible.
- Gateway mode forwards only the configured data-plane API key. OAuth tokens, account cookies, and account ids are never sent to a gateway and are always redacted from artifacts.
- `new_context` cannot discard unsaved state: a successful notes checkpoint (or explicit user `force`) is required.
- Image generation (billed) and Auto Mode are opt-in; Auto Mode fails closed where nobody can approve.

For host-level insurance, set `"compaction": { "enabled": false }` in Pi's `settings.json`.

## Development

```bash
npm run typecheck    # tsc project check
bun test             # unit suite
npm run test:pi      # Pi integration smoke tests
npm pack --dry-run   # inspect the published archive
```

## Documentation

- [docs/internals.md](docs/internals.md) - protocol endpoints, rollover lifecycle, v2 wire contract, artifacts, provenance
- [README.zh.md](README.zh.md) - 简体中文
- [NOTICE](./NOTICE) - third-party attribution

## Contributing

Issues and pull requests are welcome at the [issue tracker](https://github.com/awoaCrim/pi-openai-toolkit/issues). Open an issue before behavior-changing work so protocol assumptions can be discussed. Run `bun test` and `npm run typecheck` before submitting; new wire behavior needs fixture-based tests.

## Maintainers

[awoaCrim](https://github.com/awoaCrim)

## License

MIT © awoaCrim and contributors. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Thanks

Thanks to the [Linux.do](https://linux.do/) community for the support and discussions.

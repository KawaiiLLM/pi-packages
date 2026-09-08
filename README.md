# pi-openai-toolkit

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![license: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](./LICENSE)

OpenAI toolkit for Pi: Codex Remote Context windows, remote compaction v2, hosted Web Search, image gen, auto mode.

`pi-openai-toolkit` bundles five Pi extensions for the OpenAI Responses wire family (`openai-responses` and `openai-codex-responses`):

1. **Compaction & Remote Context** (`extensions/compaction.ts`): two long-context strategies. [Codex Remote Context management](#codex-remote-context-management) ports Codex's native window lifecycle to Pi — no-summary `new_context` rollover with a hard notes-checkpoint gate, cross-window `history` / `notes` tools with encrypted argument transport, and budgeted checkpoint reminders. With it off, the extension runs **Remote Compaction v2**: server-side opaque encrypted compaction that never re-summarizes your conversation into lossy text.
2. **Web Search** (`extensions/web-search.ts`): hosted `web_search` injection for an exact `provider/model-id` allowlist, reusing the live model connection.
3. **Image Generation** (`extensions/image-generation.ts`): a local `openai_generate_image` tool backed by the hosted `image_generation` tool, for text-to-image and explicit local-reference edits without putting image bytes into session history.
4. **Auto Mode** (`extensions/auto-mode.ts`): a reviewer-model approval gate on state-changing tool calls so the agent keeps working without interrupting you.
5. **Codex Astra** (`extensions/codex-astra.ts`): Codex backend version-gate headers and cache-preserving `configuration_update` effort changes for `gpt-6-astra`.

The package is a Pi extension set, not an importable library: everything is configured through one JSON file and activated automatically inside Pi.

## Table of Contents
- [Security](#security)
- [Background](#background)
- [Install](#install)
- [Usage](#usage)
  - [Configuration](#configuration)
  - [Feature guides](#feature-guides)
- [Development](#development)
- [API](#api)
  - [Remote Context tools](#remote-context-tools)
  - [HTTP protocol reference](#http-protocol-reference)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Security

- **No silent lossy summaries on covered models.** While `contextManagement: "remote"` covers a model, Pi-native compaction is cancelled on every path (threshold, manual `/compact`, overflow) even if the remote runtime is inactive, and v2 is never sent. If you additionally want host-level belt-and-braces, set `"compaction": { "enabled": false }` in Pi's `settings.json`; uncovered models keep Pi's normal policy either way.
- **Gateway isolation.** Gateway-mode Remote Context forwards only the configured data-plane key; OAuth tokens, account cookies, and account ids are stripped, and artifacts always redact credentials, account ids, and opaque encrypted payloads.
- **Checkpoint gate.** `new_context` cannot discard unsaved working state without either a successful notes write in the window or an explicit `force` the user authorized — the failure mode reported against Codex's own experimental rollout is blocked here.
- **Billing and review boundaries.** Image generation is opt-in and may incur charges; auto mode reviews run with caching disabled, grant the reviewer read-only tools only, and fail closed in headless sessions.

## Background

Pi's built-in compaction summarizes old turns into text, which loses detail; the OpenAI Codex backend instead offers two lossless mechanisms that plain clients do not get for free: the `remote_compaction_v2` SSE protocol (an encrypted opaque checkpoint replaces the summarized prefix) and the experimental **context-window system** (`new_context`, `history`, `notes`) that rolls the window over without any summary at all. This toolkit implements both against the live backends, verified end to end on Codex OAuth and on a Codex-compatible gateway relay (NEWapi + CLIProxyAPI).

Provenance: the Remote Context protocol was reverse-engineered from `@howaboua/pi-codex-conversion@3.0.29` (source commit `7021ae48e8efe36a3becc5830d529696ff798e5e`); the Astra compatibility layer is adapted from Oh My Pi 18.1.8 (MIT); Web Search behavior was adapted from [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) (commit `3964338`). Attribution details are in [NOTICE](./NOTICE). The alpha `history`/`notes` endpoints may change upstream without notice; endpoint and header fixtures in this repository must be updated together with them.

Requires **Pi >= 0.85.1** and **Node.js >= 22.19.0**. Pi supplies the model catalog and Codex/API-key login; this toolkit never implements its own login flow and never touches the credential store directly.

## Install

```bash
pi install npm:pi-openai-toolkit
```

This registers the package in Pi's global settings; verify with `pi list`. For a single project instead:

```bash
pi install npm:pi-openai-toolkit --local
```

From git (development or pinned builds):

```bash
pi install git:github.com/awoaCrim/pi-openai-toolkit
```

### Updating

`pi update --extensions` updates Pi packages including this toolkit. Published versions are on [npm](https://www.npmjs.com/package/pi-openai-toolkit).

### Conflict warning

Do not run `pi-remote-compact`, `@lll9p/pi-better-compaction`, or a standalone `pi-openai-web-search` alongside this toolkit: duplicate hooks cause race conditions and duplicated system prompts.

## Usage

All features are controlled by one configuration file, plus per-session commands. With no config file present, compaction and Astra are enabled on eligible models while Web Search, image generation, auto mode, and Remote Context stay opt-in.

Create `~/.pi/agent/extensions/pi-openai-toolkit/config.json` (Windows: `C:\Users\<user>\.pi\agent\extensions\pi-openai-toolkit\config.json`):

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

Then start Pi as usual; the toolkit loads automatically and hooks every session:

```bash
pi --model uwoacrimson/gpt-6-astra "resume the deploy task"
```

### Configuration

Every key is optional; unknown keys are ignored with a warning rather than written back to your file. `models`-style keys are exact `provider/model-id` allowlists — trimming only, no globbing — so each feature is off until you list a model for it.

#### `compaction`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Master switch for the compaction extension's hooks. |
| `contextManagement` | `"off"` \| `"remote"`, `"off"` | Opt into Codex Remote Context management for native Codex models and `codexGatewayModels` entries. While it owns a covered model, `remote_compaction_v2` is never sent and Pi-native compaction is cancelled (see [Security](#security)). Set back to `"off"` to roll back. |
| `codexGatewayModels` | *string[]*, `[]` | Exact `provider/model-id` entries allowed to run Remote Context through a Codex-compatible gateway (e.g. `"uwoacrimson/gpt-5.6-luna"` on `openai-responses`). The gateway receives the bare model id in `X-Codex-Model` and keeps the configured `/v1` base URL. |
| `contextReminderThresholdPercent` | *integer* `0`-`100`, `5` | Remote Context: inject the once-per-window checkpoint reminder when remaining tokens fall below this percentage of the context window. `0` disables reminders; the exhausted-window fallback still fires. Set it comfortably above Pi's native reserve band (default 16384 tokens ≈ 6% of a 272k window) so the model can roll over before the native threshold. |
| `allowCompactionContinuityBreak` | *boolean*, `false` | v2 path: restart a fresh opaque chain from current session text when the latest compaction was made by another strategy (e.g. a text summary). |
| `remoteCompactModel` | *string \| null*, `null` | v2 path: `provider/model-id` used only for the synthetic `remote_compaction_v2` request; the session model never switches. Must resolve to the same effective base URL as the active model. |
| `nativeFallback.enabled` | *boolean*, `true` | Toolkit-driven native compaction with an explicit summary model when the remote request was attempted and failed. Never touches a successful remote chain. |
| `nativeFallback.model` | *string \| null*, `null` | Summary model for models that cannot use v2 at all (non-Responses API, or excluded via `responsesApis`). `null` keeps the active model. |
| `nativeFallback.thinkingLevel` | *string*, `"off"` | Thinking level passed to Pi's `compact()` when this extension supplies the model (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). |
| `responsesApis` | *string[]*, both APIs | Narrow which Responses API identifiers may use remote compaction. Applies only when `contextManagement` is `"off"`. |
| `notifyOnLoad` | *boolean*, `false` | Startup notification banner. |
| `debug` | *boolean*, `false` | Write lifecycle and compaction artifacts under `artifactRoot`, including the Remote Context activation reason per `session_start`. |
| `logProviderPayloads` / `logCompactResponses` | *boolean*, `false` | Additionally write raw provider request payloads and compact SSE bodies to artifacts. Keep off unless inspecting a specific request. |
| `redactSensitiveData` | *boolean*, `true` | Full artifact redaction. Authorization credentials, API keys/tokens, Codex account ids, and opaque `encrypted_content` / `encrypted_output` are always redacted even when this is `false`. |
| `artifactRoot` | *string*, `~/.pi/agent/artifacts/pi-openai-toolkit/compaction` | Artifact directory root; relative paths resolve against the config directory. |

#### `webSearch`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Master switch. |
| `models` | *string[]*, `[]` | Exact allowlist of `provider/model-id` sessions that receive hosted `web_search` injection on `openai-responses` / `openai-codex-responses`. For a listed model the local `web_search` function tool is removed from the payload so native search is the only path; switching away restores it. |

#### `imageGeneration`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `false` | Single opt-in switch for the `openai_generate_image` tool. Off by default because every successful request may incur a charge. No model allowlist: the hosted tool is a capability of the Responses API, so it is exposed to every active model on a Responses wire and hidden elsewhere. |

#### `autoMode`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Master switch; the mode still cannot engage until a model is allowlisted and `reviewerModel` is set. |
| `models` | *string[]*, `[]` | Allowlist of active session models permitted to run in auto mode. |
| `reviewerModel` | *string \| null*, `null` | Approving model (`provider/model-id`, resolved through Pi's registry). Used only for one-off reviews; never becomes the conversation model. |
| `gate` | `"side-effect"` \| `"all"`, `"side-effect"` | Which tool calls are reviewed. `/auto all` flips the session scope to everything. |
| `extraTools` | *string[]*, `[]` | Additional reviewed names on top of the side-effect set (`bash`, `write`, `edit`). |
| `timeoutMs` | *integer* 1000-120000, `30000` | Reviewer deadline across all rounds. Expiry is never approval. |
| `transcript` | *boolean*, `true` | Give the reviewer a bounded view of the conversation so it can judge authorization, not just intrinsic risk. |
| `evidenceTools` | *boolean*, `true` | Let the reviewer run Pi's read-only tools (`read`, `grep`, `find`, `ls`) to establish facts. It never receives `bash`, write tools, or network access. |
| `maxEvidenceRounds` | *integer* 0-8, `3` | Investigation rounds before the reviewer must answer; `0` is a single completion. |
| `classifier.*` | see code comments | Optional non-blocking low-risk pre-scorer (`enabled` `false`, `model`, `timeoutMs` `15000`, `maxLag` `2`). Can only fast-path ordinary calls, never deny. |
| `circuitBreaker.*` | — | Denials that end the turn instead of letting agent and reviewer negotiate forever (`consecutiveDenials` `3`, `recentDenials` `10` within `windowSize` `50`; `0` disables). |

#### `codexAstra`

| Key | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | *boolean*, `true` | Astra compatibility layer: backend version-gate header plus the cache-preserving effort rewrite below. |
| `models` | *string[]*, `[]` | Models that accept the `configuration_update` input item (today only Astra-era models, e.g. `"uwoacrimson/gpt-6-astra"` on a gateway). The version header applies to all `openai-codex-responses` requests regardless of this list. Never enable this layer on a host that already implements the same rewrite (e.g. Oh My Pi) to avoid double-splicing. |

Catalog note: Pi's bundled `openai-codex` list may not include `gpt-6-astra` yet. Register it in `~/.pi/agent/models.json` under the built-in provider (`api: "openai-codex-responses"`, `baseUrl: "https://chatgpt.com/backend-api"`, `contextWindow: 272000`, `maxTokens: 128000`, `thinkingLevelMap` `low`…`max`); Pi's Codex OAuth supplies the token.

### Feature guides

#### Codex Remote Context management

When `contextManagement` is `"remote"` and the session model is covered (native `openai-codex`, or an exact `codexGatewayModels` entry on `openai-responses`), the toolkit takes the session through the Codex window lifecycle:

- **Window identity.** `session_start` initializes a window (first/current/previous ids, window number) persisted as a `codex-context-window` custom message in the Pi session; boundaries replay on resume and rebuild after forks. Live requests carry `x-codex-window-id` and `x-codex-turn-metadata`.
- **No-summary rollover.** `new_context` installs a fresh window and trims the previous one from model context. Nothing is re-summarized; old turns stay retrievable server-side through `history`.
- **Checkpoint gate.** A rollover requires a *successful* `notes` `append_to_file` / `write_file` inside the current window, verified against the persisted session branch (so it survives restarts). Without it, `new_context` refuses; `force: true` is the explicit user-authorized escape, and the toolkit's exhausted-context fallback bypasses the gate automatically after instructing one final notes write.
- **Budget.** `get_context_remaining` reports the live window budget; `contextReminderThresholdPercent` controls the once-per-window checkpoint reminder.
- **Ownership.** For covered models the toolkit owns every compaction event: `remote_compaction_v2` is not sent, and Pi-native compaction is cancelled on all paths — including while the remote runtime is temporarily inactive, so no lossy summary can slip in behind its back. The inactive reason is surfaced as a notification (and in the `session_start` lifecycle artifact when `debug` is on); fix that cause rather than expecting compaction.

The native route reuses Pi's Codex OAuth through `ModelRegistry`; gateway route requests use the configured data-plane API key only — local OAuth credentials, account cookies, and account ids are never forwarded to a gateway.

**Verifying activation.** After `/reload` or a new session, the session should contain a `codex-context-window` boundary message and `new_context` / `get_context_remaining` / `history` / `notes` tools. With `debug: true`, each `session_start` writes a lifecycle artifact under `artifactRoot` whose `activation` field records `active` and, when inactive, the exact reason (e.g. `tool-name-conflict`, `missing-api-key`, `auth-resolution-failed`).

#### Remote Compaction v2

With `contextManagement` off, eligible Responses sessions compact through `remote_compaction_v2`: a `compaction_trigger` item appended to the live streaming request yields one output item of `type: "compaction"` with non-empty `encrypted_content`, stored in `CompactionEntry.details.compactedWindow`. On later requests the opaque checkpoint is replayed ahead of live turns — zero-loss, no text summary. Replay fails closed: if the summary anchor cannot be located, the request is aborted with a notification and a content-free failure artifact; the sentinel-only payload is never sent. Fallback tiers: a failed remote attempt may use Pi's native compaction (`remoteCompactModel`/active model); models that cannot use v2 at all use `nativeFallback`. Pi 0.85.1+ owns automatic compaction driving; the toolkit never starts its own driver.

#### Auto Mode

Engage per session with `pi --auto` or `/auto on` (footer shows state; engaging never stalls the current turn). Each gated call is reviewed by `reviewerModel`, which scores intrinsic risk and conversation authorization separately and derives `allow`/`deny` from a fixed table; it may investigate with read-only tools first; denials return the reason plus an anti-workaround clause; unfinished reviews are reported as failures, never safety verdicts. Every decision is persisted as a non-context session entry for audit. In headless (`-p`/JSON) sessions there is nobody to escalate to, so unavailable reviews block.

## Development

```bash
npm run typecheck   # tsc project check
bun test            # full unit suite
npm run test:pi     # Pi integration smoke tests
npm pack --dry-run  # inspect the published archive
```

The Remote Context protocol fixtures (`src/context-management/`) must be updated together with any upstream alpha endpoint change.

## API

### Remote Context tools

The four tools the extension registers when Remote Context is active:

| Tool | Parameters | Result / errors |
| --- | --- | --- |
| `new_context` | `{ force?: boolean }` | Rolls to the next window without summarizing. Refuses unless a successful notes checkpoint exists in the current window (`force` overrides). Reports "already scheduled" if a rollover is pending. |
| `get_context_remaining` | none | Remaining tokens and window identity for the current budget; `unknown` when no usage source exists yet. |
| `history` | `{ action: "list_windows" \| "list_items" \| "read_item" \| "search_contents", ... }` | Reads prior windows. Pass returned `item_id` / window ids **unchanged**. Search text is sent under the encrypted-argument policy. |
| `notes` | `{ action: "list_files_by_prefix" \| "read_file" \| "search_contents" \| "append_to_file" \| "write_file", path, text, ... }` | Cross-window working memory. Paths resolve under the session agent (e.g. `/root/notes/<file>` or a relative note path); an invalid path is rejected by the backend. Successful append/write is what satisfies the `new_context` gate. |

All four throw explicit tool errors on timeout, abort, non-2xx, malformed JSON, authentication, or protocol failures — they never silently degrade.

### HTTP protocol reference

Internal alpha endpoints, adapted from `@howaboua/pi-codex-conversion` (see [Background](#background)):

```text
POST {base}/alpha/history/v2/list_windows | list_items | read_item | search_contents
POST {base}/alpha/notes/v2/list_files_by_prefix | read_file | search_contents | append_to_file | write_file
GET  {base}/alpha/notes/v2/thread_hint
```

Native route uses `{base} = <backend-api>/codex` with `Authorization: Bearer <oauth token>`, `ChatGPT-Account-ID`, and Codex CLI headers. Gateway route uses the configured `/v1` base with the data-plane API key, `originator: codex_cli_rs`, `X-Codex-Affinity-Scope`, and `X-Codex-Model` carrying the bare model id — never local credentials. Both set `Session-Id` / `X-Client-Request-Id` to the bounded Pi session id, `x-openai-tool-output-truncation-policy`, and `x-openai-encrypted-tool-arguments` for endpoints with encrypted parameters; encrypted results come back as `encrypted_output` and are re-encoded into later requests. These are alpha contracts: the upstream backend may change them at any time.

## Maintainers

[awoaCrim](https://github.com/awoaCrim)

## Contributing

Issues and pull requests are welcome at the [issue tracker](https://github.com/awoaCrim/pi-openai-toolkit/issues). For behavior-changing work, open an issue first so protocol assumptions (especially alpha `history`/`notes` contracts) can be discussed. Run `bun test` and `npm run typecheck` before submitting; new wire-protocol behavior needs fixture-based tests.

## License

MIT © awoaCrim and contributors. See [LICENSE](./LICENSE) and the third-party attribution in [NOTICE](./NOTICE).

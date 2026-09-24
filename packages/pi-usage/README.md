# 📊 pi-usage — Check Provider Usage, API Balance, and Codex Fast Mode

[![npm](https://img.shields.io/npm/v/@narumitw/pi-usage)](https://www.npmjs.com/package/@narumitw/pi-usage) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Inspect usage and DeepSeek API balance for Pi's active provider account, query other configured providers, and toggle Fast mode for supported OpenAI Codex models.
The extension keeps each provider's native quota, allowance, and spending semantics instead of treating unlike values as equivalent.
xAI OAuth subscription reporting follows the reviewed Grok Build contract and runs only after an explicit `/usage` action.

## ✨ Features

- Shows active-account usage and next actions through `/usage`.
- Reports subscription allowances, API balances, and spending for the supported providers listed below without mixing their billing semantics.
- Toggles persistent Codex Fast routing through `/fast` or the usage menu.
- Redeems eligible Codex resets only after fresh account matching and explicit confirmation.
- Refreshes one or all configured providers with bounded concurrency while preserving partial results.
- Scopes statusline and cache data to the active provider and runtime account.
- Resolves credentials through Pi or the process-local OAuth credential-source protocol and validates the effective provider endpoint before sending them.

## 📦 Install

Requires Pi 0.81.0 or newer to validate the effective base URL for resolved provider auth before sending credentials to an official usage endpoint.
The v1 credential-source path is characterized against Pi 0.84.3; other runtimes keep the standalone fallback without its protocol timing guarantee.

Like every Pi extension, this package runs with Pi's process permissions.
Review [Security and privacy](#-security-and-privacy) before installation.

```bash
pi install npm:@narumitw/pi-usage
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-usage
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-usage run build
pi -e ./packages/pi-usage
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

## 🚀 Quick start

Run `/usage` in TUI or RPC mode to inspect the active provider, refresh its usage, or choose another configured provider.
When a provider exposes several billing targets, `/usage` asks for one target before querying usage.
Run `/fast` to toggle Fast mode for a supported active Codex model.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/usage` | Query the active provider's usage, then manage provider queries, preferences, or eligible Codex resets. |
| `/fast` | Toggle Fast mode for the active supported Codex model. |

Both commands support TUI and RPC, accept no arguments, and reject print and JSON modes.
Cross-provider queries require an explicit interactive choice; there are no provider-ID, `--refresh`, or `--all` arguments.
Requests use the matched provider credentials; see [Security and privacy](#-security-and-privacy).
Fast mode uses more plan allowance; see [Codex Fast mode](#codex-fast-mode) for eligibility and when changes apply.

Codex reset redemption requires a freshly matched current OAuth account and explicit confirmation; **after confirmation, its progress view cannot cancel the reset**.
Read the [query and reset guide](./docs/operations.md) for target selection, cancellation, and safe retry behavior.

## ⚙️ Settings

Choose **Settings** in `/usage` to edit Codex Fast mode through Pi's settings-list interaction in TUI mode.
RPC mode reports the active manual settings path instead of opening terminal UI.

These preferences live in `pi-usage.json` under Pi's user agent directory, normally `~/.pi/agent/pi-usage.json`.
The extension reloads this file at every session start and does not create it until the first successful save.
Within one Pi process, changes save immediately in invocation order.
Saves preserve unknown JSON fields and publish through a private temporary file plus rename.
Malformed or invalid files remain untouched.
A failed save restores the prior displayed and effective value, while shutdown waits for queued writes.
Separate Pi processes are not mutually locked.

Target selections are stored only as IDs in the provider-neutral `selectedTargets` object in this file and are managed through `/usage`, not the Settings screen.
The former `fireworksAccountId` field remains read-compatible: it supplies `selectedTargets.fireworks` in memory only when the generic value is absent.
A successful explicit Fireworks account selection writes the generic field and removes the legacy field atomically; ordinary reads do not rewrite the file.

### Codex Fast mode

Run `/fast` without arguments to toggle Fast for the active Codex model, or use **Turn Fast mode on/off** in `/usage`. The `codexFastMode` preference defaults to Off. Fast support comes from the current account's official model catalog, not a model-name allowlist; new models such as Astra require no code update when the catalog advertises their priority tier.

`/usage`, enabling `/fast`, and requests with Fast already enabled resolve current Codex OAuth credentials and query `GET https://chatgpt.com/backend-api/codex/models?client_version=…`. The entire catalog is cached in memory for five minutes, scoped to validated auth and client version. Concurrent reads share the request; cancellation, account changes and shutdown cannot publish old-account data. No credentials or raw model prompts are persisted, and another application's `.codex` cache is not used as current-account evidence. Startup with Fast Off makes no catalog request.

Only a structured `service_tiers` entry with `id: "priority"` confirms support. A missing model, missing or malformed metadata, legacy-only `fast` hints, or a failed request produces **Unknown**, not a guessed capability. An explicit list without priority is unavailable. Unknown/unavailable support cannot enable Fast. If an already-enabled request cannot verify support, the owning run is aborted with an error rather than silently requesting another tier. `/fast` can still turn the saved preference off without contacting the catalog.

The optional `codexModelsClientVersion` setting in `pi-usage.json` overrides the catalog protocol version; it accepts `major.minor.patch` and defaults to `0.153.4`. This is protocol negotiation, not a model list. The contract is pinned to OpenAI Codex commit `aee8a55ab6010f1d53e741edec74dbcffa07bcfe` (`codex-rs/protocol/src/openai_models.rs` and `codex-rs/protocol/src/config_types.rs`). Account-specific live catalog access has not been verified in this environment; validation uses controlled offline responses.

Validated Fast requests send `service_tier: "priority"`; disabled requests send explicit `service_tier: "default"`. Foreign APIs/origins and payloads for another model are not rewritten. The public snapshot separates the saved preference from verified effectiveness; `pi-statusline` still owns rendering. A toggle affects hooks that begin after the save, not an already-started request.

**Capability is not pricing.** The catalog has no structured price multiplier. Existing tariff reconciliation is retained only for the previously supported models, to handle Pi 0.85.1's payload/stream-option tier mismatch. Newly discovered models keep Pi's reported cost unchanged; if Pi lacks the final tier information, local API-equivalent figures may omit a Fast surcharge. These are estimates, not subscription invoices, and no rate is inferred from a model name or speed description.

Repair or remove an invalid settings file, then run `/reload` before trying the toggle again.

### Retired statusline preference

Existing `codexStatusResetCountdown` values remain read-compatible, but no longer control presentation and are not offered in Settings. This package publishes data rather than rendering a usage status item; countdowns and other display choices belong to `pi-statusline`.

## 📋 Provider semantics

Usage is provider-specific: a subscription allowance, current balance, and rated spend are not interchangeable.
Currencies and billing targets remain separate.

| Provider | Reported data |
| --- | --- |
| OpenAI Codex | Subscription windows, credits, resets, and model buckets |
| Kimi For Coding | Plan request windows and a separate booster wallet |
| Moonshot AI Global/China | Current API balance in USD/CNY |
| MiniMax Global/China | Token Plan windows or pay-as-you-go API balance |
| GitHub Copilot | AI credits, premium requests, or Free-plan chat allowance |
| OpenRouter | Per-key credit limits and spending windows |
| DeepSeek | Exact current CNY and USD API balances |
| Fireworks | Rated trailing 30-day spend for one selected account |
| Vercel AI Gateway | Team credit balance and lifetime spend |
| Baseten | Organization-wide trailing 30-day Model APIs spend after credits |
| OpenCode Go | Rolling, weekly, and monthly plan windows |
| xAI | OAuth subscription allowance and credits; explicit menu queries only |
| Z.AI | Coding Plan quota windows, MCP allowance, plan name, and renewal date |

Read the [provider reference](./docs/providers.md) for provider IDs, exact endpoints, authentication requirements, normalization rules, statusline examples, limitations, and pinned contract evidence.
Codex reset redemption requires a freshly matched current OAuth account and explicit confirmation; custom or proxy origins fail before mutation.

## 🧭 Current and configured accounts

`Current` identifies the provider and credential used by Pi's selected model.
`Configured` identifies runtime auth for another supported provider, not an active provider.

The extension selects one provider target for one query and never flattens targets into provider rows or aggregates every visible target.
Provider adapters own target discovery and validation; core owns one-target selection, persistence, cache identity, cancellation, and UI.
A compatible credential owner may offer the verified active named account through the versioned process-local protocol without exposing its account label or storage.
Without such an owner, `pi-usage` retains its standalone Pi `auth.json` behavior.
An older or incompatible owner degrades to the existing authentication-unavailable result when the stored login does not match runtime auth.
After the active runtime credential changes, the next command, turn, or scheduled refresh resolves auth again and cannot reuse another account's cached report.

## 📊 Snapshots and statusline ownership

`pi-usage` owns provider queries, account-scoped caching, local spend scans, budget estimates, `/usage`, and `/fast`. It does not call `setStatus("usage", text)` or render a separate usage row. Automatic provider refreshes retain the five-minute cache lifecycle; xAI remains explicit-menu-only. Balances and other provider-specific reports remain available in `/usage`. Only the active provider's supported percentage windows enter the public snapshot; count quotas are not converted into percentage windows.

Consumers import `UsageSnapshot`, `usageModelKey`, and `subscribeUsageSnapshots` from `@narumitw/pi-usage/snapshot`, without loading the extension entrypoint. Snapshots use `pi-usage:snapshot:v1`; subscribing requests memory-only replay through `pi-usage:request-snapshot:v1`. Filter by `sessionId` and `modelKey` (provider, model ID, API, and base URL). The payload contains window values, local daily spend, estimated daily budget percentage, Fast state, and safe errors—not credentials, account fingerprints, or raw reports. Session/model/account changes invalidate old data; asynchronous scans check their generation, and shutdown removes listeners and timers.

Local spend maintains one process-local incremental ledger for daily and usage-window totals. It recursively discovers session JSONL without following discovered symlinks, reads appended bytes in bounded chunks, and deduplicates copied fork replies. The ledger is rebuilt on process restart; transient file read errors retain the last successfully read contribution. It is provider-wide local API-price spend, not an account invoice. Window value is local spend divided by used percentage, scaled to 100%; estimates below 1% usage remain unpriced. Today's budget uses one seventh of the weekly allowance and caps today's attributed spend at the spend since that window opened. Daily figures refresh after each turn and retire at local midnight. `pi-statusline` consumes these values and owns all visual formatting; it does not scan logs or query accounts.

## 🔄 Migrating from pi-codex-usage

`pi-codex-usage` is deprecated and its source is archived under `deprecated/`.
To migrate one installation:

```bash
pi remove npm:@narumitw/pi-codex-usage
pi install npm:@narumitw/pi-usage
```

Remove the deprecated package rather than loading both usage extensions together.

Behavior changes:

- Use `/usage` for usage management; `/codex-status` is no longer registered.
- Refresh and cross-provider operations are menu actions rather than flags.
- Codex CLI fallback is removed to preserve active-runtime-account correctness.
- Usage display is supplied by `pi-statusline` through the public snapshot contract, not a separate status item.

## 🔒 Security and privacy

Credential candidates are collected synchronously in memory and are not cached, persisted, logged, formatted, or appended to the Pi session.
The protocol carries no account name or extension identity.
Only the selected provider's exact runtime match is used, and secrets are sent only to its validated official origin.
DeepSeek balance requests require Bearer authentication, send only that resolved credential from Pi's runtime auth to `https://api.deepseek.com/user/balance`, and refuse redirects.
Fireworks spend requests send only that resolved credential to the official `https://api.fireworks.ai` account-listing and billing-summary endpoints and refuse redirects.
Moonshot balance requests send only the resolved Bearer credential to the matching official Global or China balance origin and refuse redirects.
Vercel AI Gateway credit requests send only the resolved Bearer credential to `https://ai-gateway.vercel.sh/v1/credits` and refuse redirects.
MiniMax usage requests send only the resolved API key to one deterministic endpoint on the matching official Global or China API root and refuse redirects.
Baseten billing requests send only the resolved Bearer credential to `https://api.baseten.co/v1/billing/usage_summary` for an official Baseten model and refuse redirects.
Pi extensions run with the user's process privileges, so the shared event bus is not a security boundary between installed extensions.
Install only trusted extensions because they can read user files and process memory.
Protocol v1 interoperability is characterized for the repository's supported Pi runtime.
An absent or incompatible peer preserves standalone fallback and fail-closed mismatch behavior.

## 🚧 Limitations

- Only providers with a meaningful usage source and verifiable Pi runtime auth are supported.
- GitHub Copilot quota, Kimi managed usage, Z.AI quota, and OpenAI Codex reset redemption rely on provider-owned endpoints that may change without notice.
- Codex reset redemption requires a current ChatGPT OAuth credential from Pi's login or a compatible credential source; Codex API keys cannot redeem earned subscription resets.
- xAI usage supports only a uniquely matched Pi OAuth subscription credential; xAI API keys and Management API credentials are unsupported.
- Credentials resolved for custom provider base URLs are never forwarded to the providers' official usage endpoints; effective auth origin validation requires Pi 0.81.0 or newer.
- Provider reports are snapshots and may themselves be delayed by the provider.
- DeepSeek reports current API balance only; it does not expose historical usage, quota windows, reset times, or account-wide token totals through the balance endpoint.
- Fireworks reports rated 30-day spend only; credit balance and spend caps are visible only in the Fireworks web console, and `/usage` must select one visible account before querying a multi-account key.
- Moonshot AI reports current API balance only; it does not expose historical spend, aggregate token usage, quota windows, or reset times through the balance endpoint.
- Vercel AI Gateway reports current team credits and lifetime spend only; Custom Reporting and request-rate counters are not queried.
- MiniMax Token Plan field semantics have changed over time; contradictory counts and percentages are reported as unavailable rather than guessed.
- Baseten reports organization-wide Model APIs spend, not usage attributable only to Pi's current key; Dedicated and Training spend are excluded.
- OpenRouter successful inference responses do not expose proactive request-rate counters; `/usage` reports the documented per-key credit/spend fields instead.
- A provider may not return a safe human-readable account identity.
  In that case the provider and runtime credential state remain visible without exposing secrets.
- Immediate account-change events are not available from Pi; auth is re-resolved before commands, turns, and scheduled refreshes.
- Fast support depends on the current account's model catalog being available or cached within its TTL. Offline cache misses are Unknown, and newly discovered models' Fast surcharges are not inferred. A catalog protocol change may require updating `codexModelsClientVersion` or the parser, but adding a model does not require editing a whitelist.
- Another later-loaded extension can replace the final provider payload, so arbitrary third-party payload-rewrite conflicts cannot be prevented.

## 🗂️ Package layout

```text
packages/pi-usage/
├── src/                               # Provider adapters, auth, settings, and presentation
│   ├── index.ts                       # Thin Pi entrypoint
│   └── usage.ts                       # Provider queries, cache, and menu
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

`src/index.ts` forwards the default factory from `usage.ts` and retains the package's named helper exports. `src/snapshot.ts` is the side-effect-free public consumer contract; other source modules are internal.
The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, usage, quota, DeepSeek API balance, DeepSeek balance, Fireworks API spend, Fireworks rated spend, Vercel AI Gateway credits, Vercel AI Gateway usage, Baseten Model APIs spend, Baseten usage, OpenAI Codex usage, ChatGPT subscription limits, Kimi For Coding, Kimi Coding Plan usage, Moonshot AI balance, Moonshot API balance, MiniMax Token Plan, MiniMax API balance, GitHub Copilot AI credits, GitHub Copilot premium requests, OpenRouter credits, xAI OAuth usage, Grok subscription allowance, API-key spend limits, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).

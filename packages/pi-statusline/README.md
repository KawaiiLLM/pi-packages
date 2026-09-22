# ✨ pi-statusline — Add a Ready-to-Use Powerline Footer to Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Add a Powerline-style footer that works without setup and keeps important Pi, workspace, Git, usage, and time context visible as the terminal narrows.

A representative uncolored layout:

```text
░▒▓ ~/pi-extensions ⎇ main ~2 ✱ Sonnet 4 ◈ high ◔ 84K (42%) § ↑5.3K ↓259 ☉ $186.00 (93%) ◒ 12% (4h 45m) ◑ 8% ($3064) ⌁ 82%
```

## ✨ Features

- Works immediately with a balanced default for workspace, Git, model, thinking, context, tokens, cost, subscription windows, cache hit rate, and activity.
- Shows subscription usage windows with a reset countdown that alternates with the window's value at API prices, and inverts segment colors at 80% usage or 50% and lower cache hit rate.
- Removes lower-priority segments before important information is clipped.
- Shows when Pi is waiting for an extension UI prompt, streaming, or running tools.
- Adds optional provider, time, and turn details.
- Offers three information levels, eight previewable palettes, and advanced custom layouts; backgrounds cycle by position. Prism adds field-bound text colors while preserving the original Mono palette.
- Wraps a full row onto the next one by default instead of hiding segments.
- Uses ANSI-256 palette colors when Pi's effective terminal capabilities disable true color.
- Loads a generated split runtime to reduce Pi package startup work.

> **Need more customization?**
> See [`pi-starship`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-starship) ([npm](https://www.npmjs.com/package/@narumitw/pi-starship)).
> It uses [Starship-inspired](https://starship.rs/) TOML and style syntax for deeper control over layout, modules, and colors.
> Choose `pi-statusline` for practical defaults and quick setup.

## 📦 Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try the published package without installing it permanently:

```bash
pi -e npm:@narumitw/pi-statusline
```

Build the generated runtime and try the local package from this repository:

```bash
npm --workspace @narumitw/pi-statusline run build
pi -e ./packages/pi-statusline
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
Install only from sources you trust because Pi extensions run with Pi's permissions.

## 🚀 Quick start

Install the extension and start Pi to use the balanced default immediately.
Run `/statusline` to preview and apply an appearance or information level.
Load `pi-usage` alongside it for today's spend, subscription windows, and the Fast marker; either extension load order works.

## 🎛️ Menu and information levels

```text
Appearance (tokyo-night)
Information (balanced)
Advanced
Status
Help
```

| Menu item | What it does |
| --- | --- |
| **Appearance** | Preview palettes with Up/Down; Enter applies and Escape cancels |
| **Information** | Preview and apply a curated segment set |
| **Advanced** | Open Custom layout or Edit settings JSON |
| **Status** | Show the effective source, path, appearance, layout, and diagnostics |
| **Help** | Show command and schema guidance |

### Information levels

Selecting a level replaces only `segments` and preserves unrelated JSON fields.

| Level | Included segments |
| --- | --- |
| **Minimal** | `cwd model context branch` |
| **Balanced** (default) | `cwd model thinking context cost branch tokens five_hour weekly cache tools` |
| **Detailed** | `cwd model thinking context cost branch tokens five_hour weekly cache tools provider time` |
| **Custom** | Any other segment order, including explicit line breaks |

The `tools` segment takes no space while idle.
`cache` takes no space until Pi has reported prompt tokens; `five_hour` and `weekly` take no space until the provider has reported that window.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/statusline` | Customize footer appearance, information density, and layout. |
| `/statusline settings` | Edit the settings JSON. |
| `/statusline status` | Show effective settings and diagnostics. |
| `/statusline help` | Show command and schema guidance. |

The menu and editor require TUI; RPC receives notifications instead, including the manual settings path for `settings`.
Status and help support TUI and RPC; print and JSON modes produce no command output.
Unknown subcommands and trailing arguments are rejected.
Palette previews save on Enter and revert on Escape, but layout changes save immediately and are not undone by closing the editor; see the [configuration guide](./docs/configuration.md).

## 📐 Runtime behavior

### Responsive fitting

Each row keeps its configured segment order, and every theme starts a new row before the background ramp repeats. The default five-color ramps place at most five visible segments in a row.
By default (`"overflow": "wrap"`) a row that is too wide continues on the next row; every new row starts the palette ramp again.
With `"overflow": "drop"`, each cycle-sized group instead loses its lowest-priority segments until it fits. The cycle boundary still starts a new row.
Retention priority is highest to lowest:

```text
context model branch weekly tools five_hour cwd thinking cost provider cache tokens time turn brand
```

Explicit `line_break` entries remain row boundaries.
A segment that is itself wider than the row is left out in either mode rather than emitting an over-width line.

### Directory, activity, Git, and PR state

- `cwd` uses Starship's directory presentation defaults: contract the home directory to `~`, contract to the Git repository root when available, then retain at most the last three path components.
  This changes display only; the configured segment list and Pi working directory are untouched.
- Repository-root discovery is cached with Git status outside footer rendering; a failed root query falls back to home/path-component contraction without hiding the segment.
- During active work, `tools` shows `⌨ waiting for <kind>`, `💭 thinking`, or `⚙️ <tool>` with parallel counts.
- A sanitized prompt title follows the prompt kind when available.
- Prompt waiting takes precedence without losing the underlying tool or streaming state, which returns when the prompt closes.
- Activity disappears after the agent settles and resets across session replacement or shutdown.
- Clean repositories show no Git counters.
- Dirty counters are `⇡` ahead, `⇣` behind, `+` staged, `~` modified/deleted, `?` untracked, and `!`
  conflicts.
- A linked or plain GitHub PR reference appears with the branch when possible, avoiding a duplicate extension status.
- Git state is cached outside footer rendering and stale session results are ignored.

### Usage and context

- `context` renders the tokens in use and their share of the window, such as `149K (40%)`.
  After compaction it can temporarily render `?` until the next valid assistant response.
  At 80% usage or higher, the segment swaps its foreground and background colors.
- `tokens` totals every usage-bearing session entry, matching Pi's native footer.
  This includes assistant messages, nested-LLM tool results, compactions, and branch summaries, including abandoned branches retained in the session.
- `cache` is the latest assistant response's prompt-cache hit rate: `cacheRead / (input + cacheRead + cacheWrite)` for that response, rounded to whole percent, followed by whole minutes since that response once a minute has passed, such as `82% (12m)`. A session total would be dominated by early cache writes and never recover, so it tracks the most recent turn instead, and the idle time says whether that cache is still warm. At 50% or lower, the segment swaps its foreground and background colors; until a response reports prompt tokens it stays hidden.
- `cost` displays today's provider spend from `pi-usage`, such as `$12.40`, and stays hidden until a snapshot supplies it. The dollar value is usage cost, not proof of an amount billed under a subscription. A subscription usage snapshot or the `kimi-coding` provider adds `(sub)` when no daily budget is available; the footer never inspects credentials.
- When the snapshot supplies today's budget percentage, `cost` appends it, such as `$186.00 (93%)`, and inverts its colors at 100%. `pi-usage` owns budget calculations, spend scans, and midnight refreshes.

### Subscription windows

- `five_hour` and `weekly` render the structured windows published by `pi-usage` through `@narumitw/pi-usage/snapshot`. The footer performs no usage queries, credential lookup, or session-log scans.
- Session start, model selection, and tree navigation clear the old snapshot, resubscribe, and request replay. Only snapshots matching the current session and model are accepted; shutdown removes the subscription. Replay never starts a query. Missing fields stay hidden, and usage errors do not create another footer status.
- Each window alternates every eight seconds between its reset countdown, `12% (4h 45m)`, and its value at API prices, `12% ($647)`.
  The API-price value is supplied by `pi-usage`; the footer only formats and rotates the readings.
- At 80% usage or higher, the window swaps its foreground and background colors, just like context. All palettes use the same single-stage alert; thresholds use unrounded percentages, and rounded separators follow the displayed background.
- Pi's public extension API does not expose the current auto-compaction toggle, so this footer cannot reliably show the native `(auto)` marker.

### Usage controls

`pi-usage` owns `/usage`, `/fast`, Fast settings, request routing, and cost correction. `pi-statusline` registers only `/statusline` and renders `fast` after the model name when the snapshot marks it effective.

An old `codexFastMode` field in `pi-statusline.json` is preserved as an unknown field, not read or changed by this extension.

## ⚙️ Settings

Use `/statusline` for appearance and information presets, or **Advanced → Edit settings JSON** (`/statusline settings`) for a custom document.
The only settings file is `<getAgentDir()>/pi-statusline.json`; there are no project or environment overrides.

A minimal customization selects a palette and a few segments:

```json
{
  "palettePreset": "ocean",
  "segments": ["cwd", "branch", "model", "context"]
}
```

A missing file uses the balanced built-in footer without creating the file or its parent directory.
The first successful save creates an editable document atomically.
Menu saves preserve unknown fields; invalid recognized values block saving and keep the live footer unchanged.
Malformed or unreadable files are never overwritten.
Manual edits load at startup, `/reload`, or session replacement.

Appearance previews save only on Enter, while Escape restores the saved palette.
Custom-layout changes save immediately, so closing that screen does not undo them.

Read the [configuration reference](./docs/configuration.md) for all settings, palettes, model truncation, multiline layouts, effective layout controls, extension-status icon precedence, and legacy-file handling.

## 🚧 Limitations

- The footer needs Powerline glyphs and emoji for its intended appearance.
- Pi does not arbitrate footer ownership, so another footer extension can replace pi-statusline.
- Custom layouts support ordered segments and line breaks, not a variable or format language.

## 🛠️ Troubleshooting

- **Powerline symbols look wrong:** use a font with Powerline glyphs and emoji support.
- **The footer reports settings warnings:** run `/statusline status`, then `/statusline settings` to fix invalid recognized fields.
- **The footer appears to be replaced:** disable `pi-starship` or another extension that also calls Pi's `setFooter()`.
- **A custom segment disappears on a narrow terminal:** check the responsive priority above or add an explicit `line_break`.

## 🗂️ Package layout

```text
packages/pi-statusline/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── statusline.ts                  # Responsive footer lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, statusline, Tokyo Night, powerline, responsive terminal footer, context usage, prompt cache, cache hit rate, model status.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).

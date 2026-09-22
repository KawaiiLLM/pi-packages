# Pi Statusline configuration reference

[Back to README](../README.md)

- [Settings fields](#settings-reference)
- [Appearance and palettes](#-appearance)
- [Model truncation](#model-truncation)
- [Advanced layout and controls](#-advanced-layout)
- [Extension statuses and icons](#-extension-statuses-and-icons)

## ⚙️ Settings

The extension uses one user-level file:

```text
<getAgentDir()>/pi-statusline.json
```

There are no project or environment overrides.
When the file is absent, pi-statusline uses built-in defaults without creating the file or its parent directory.
The first successful settings save creates a complete editable document atomically.
Malformed or unreadable settings are never overwritten.
Settings reload on startup, `/reload`, and session replacement.

A valid legacy `pi-statusline-settings.json` remains readable with a warning and is never modified automatically; rename it to `pi-statusline.json`.
If both files exist, `pi-statusline.json` wins.

### Settings reference

| Field | Accepted values | Purpose |
| --- | --- | --- |
| `palettePreset` | `tokyo-night`, `ocean`, `sunset`, `forest`, `candy`, `neon`, `mono`, `prism`, `custom` | Select the active color preset |
| `palette` | Array of `fg`/`bg` `#RRGGBB` colors in ramp order | Define colors used by `custom` |
| `density` | `compact`, `cozy` | Control horizontal padding |
| `separator` | `none`, `dot`, `bar`, `powerline`, `round` | Separate adjacent segments in one color block |
| `overflow` | `wrap`, `drop` | Continue a full row on a new row, or shed segments by priority |
| `segments` | Ordered unique segment names and `line_break` | Control visibility, order, and rows |
| `segmentText` | Per-segment `prefix` and `suffix`; model truncation fields | Format Pi-owned dynamic values |
| `extensionStatusIcons` | Raw status key or `namespace:*` to icon string | Customize extension status icons |

All fields are optional in an existing document.
Missing fields use defaults.
Menu saves warn about and preserve unknown fields.
Invalid recognized values block saving and leave the file and live footer unchanged.
The legacy `codexFastMode` field is now unknown and preserved unchanged; Fast is managed by `pi-usage`.

A compact customization example:

```json
{
  "palettePreset": "ocean",
  "density": "compact",
  "separator": "dot",
  "segments": ["cwd", "branch", "model", "thinking", "context", "cost", "five_hour", "weekly"],
  "segmentText": {
    "model": {
      "truncationLength": 40,
      "truncationSymbol": "…",
      "truncationDirection": "middle"
    },
    "context": { "prefix": "ctx ", "suffix": "" }
  },
  "extensionStatusIcons": {
    "goal": "◎",
    "foo:*": "🧪"
  }
}
```

Use **Advanced → Edit settings JSON** or `/statusline settings` to edit, validate, atomically save, and apply the file.

## 🎨 Appearance

Named palettes provide contrast-checked color ramps.
Appearance previews update while the picker moves, but save only when Enter is pressed; Escape restores the saved palette.

Backgrounds go by position: the first visible segment of a row takes the first ramp color, the second the second. Every theme starts a new row before a second background cycle; five-color ramps allow at most five segments per row.
Every row starts the ramp again, whether the row came from `line_break`, a cycle boundary, or width wrapping. A one-color custom ramp puts each segment on its own row; an empty ramp has no cycle boundary.

Prism's leading `░`, `▒`, and `▓` use `#3A3A3A`, `#4A4A4A`, and `#5A5A5A` respectively.

Prism cycles through `#5A5A5A`, `#4A4A4A`, `#3A3A3A`, `#2A2A2A`, and `#1A1A1A` backgrounds; Mono's ramp is unchanged.

Only Prism adapts field-bound text colors: model/thinking start from `#E77B92`, context/tokens from `#A2DAF4`, five-hour and weekly usage from `#DCE58A`, cache from `#A582DD`, and cost from `#E8CE99`. It adjusts OKLCH lightness to reach 4:1 contrast, retaining hue and reducing chroma only if no in-gamut lightness can meet that target. Neutral fields use contrast-selected light text on Prism's dark backgrounds. Mono and the other presets keep their original foreground colors. Alerts invert the final foreground/background pair in every preset.

When `palettePreset` is `custom`, `palette` is the ramp, an array of foreground/background colors:

```json
{
  "palettePreset": "custom",
  "palette": [
    { "fg": "#090c0c", "bg": "#a3aed2" },
    { "fg": "#c0caf5", "bg": "#1d2230" }
  ]
}
```

- Selecting `custom` without a palette copies the active named preset's ramp as a starting point.
- A manually authored `"palettePreset": "custom"` without `palette` uses Tokyo Night colors.
- Named presets ignore but preserve an existing custom palette.
- A `palette` array without `palettePreset` selects `custom`.
- Legacy string palettes such as `"palette": "ocean"` remain accepted.
- Missing custom colors remain unstyled instead of inheriting Tokyo Night.
- Adjacent segments with identical colors share one block; transitions use ``.
- Hex palette colors render as ANSI-256 when Pi's effective terminal capabilities disable true color.

`segmentText` values must be single-line text without terminal control characters.
Use `line_break` for another row rather than inserting a newline into a prefix or suffix.

### Model truncation

Long model IDs are truncated out of the box so the balanced footer can retain useful model context:

```json
{
  "segmentText": {
    "model": {
      "truncationLength": 36,
      "truncationSymbol": "…",
      "truncationDirection": "start"
    }
  }
}
```

`truncationLength` counts model grapheme clusters retained before the symbol.
The built-in value is `36`; set it to `0` to display the complete ID.
The direction names the removed portion:

- `start` retains the suffix and is the default, which is useful for long llama.cpp paths and model variants.
- `middle` retains both ends.
- `end` retains the prefix.

Truncation runs after the built-in Claude family shortening (`claude-opus-5` becomes `Opus 5`; other ids stay as the provider names them) but before the configured model prefix and suffix.
It changes display only—the provider model ID is untouched.
Terminal control sequences in model IDs are removed at render time, and unsafe configured symbols are rejected.
An empty `truncationSymbol` truncates without a marker.
pi-statusline treats model IDs as opaque strings and does not parse paths, repositories, GGUF suffixes, or quantization names.
At very narrow widths, the existing responsive priorities may still omit the model rather than overflow the terminal.

## 🧩 Advanced layout

Open **Advanced → Custom layout** when the curated levels are not enough.

| Key | Action |
| --- | --- |
| Up/Down | Navigate |
| Page Up/Page Down | Move by one viewport |
| Enter/Space | Show or hide the selected segment |
| `M` | Enter or leave Move mode |
| Up/Down in Move mode | Reorder the selected visible segment |
| `Alt+Up` / `Alt+Down` | Reorder without entering Move mode |
| `B` | Add or remove a line break after the selected segment |
| Configured Back key (Escape by default) | Leave Move mode first, then close the screen |
| Ctrl+C | Close the screen immediately, including from Move mode |

The layout displays the effective Back key and keeps Ctrl+C available when Back is remapped.
Every successful change saves and applies immediately.
Closing the screen does not roll it back.

Available data segments:

```text
brand provider model thinking cwd branch tools context tokens cache cost five_hour weekly time turn
```

Data segments must be unique.
`line_break` may repeat when data segments separate occurrences, but consecutive breaks are invalid.
It has no `segmentText` entry.
The menu cleans up leading, trailing, and newly consecutive breaks after visibility changes.
Manually authored leading/trailing breaks represent empty rows.

```json
{
  "segments": ["model", "line_break", "cwd", "branch", "context"]
}
```

An empty `segments` array hides the main powerline while extension statuses can still render.

## 🔌 Extension statuses and icons

Other extension statuses appear below the main powerline, wrap to terminal width, and are limited to five items.
Usage status strings (`usage` and legacy `codex-usage`) are omitted: usage data belongs in the structured main-footer segments, not a second status.
Icons use this order:

1. Exact configured raw key, such as `goal` or `foo:server`.
2. Longest configured colon wildcard, such as `foo:*` or `foo:server:*`.
3. Unambiguous installed-package alias, such as `@vendor/pi-foo`, `pi-foo`, or `foo`.
4. Leading emoji supplied by the status text.
5. Built-in icon.
6. Generic `🔌` fallback.

Set an icon to `""` to hide only the icon.
Wildcards match colon namespaces, not slash-delimited keys.
Configure slash keys exactly.
Compatibility fallbacks retain `codex-usage`, `pisync`, and `unknown-error-retry`; an explicit canonical key wins.

For interoperable extensions, prefer one aggregated key or a stable coexistence slot:

```text
<extension-id>
<extension-id>:<stable-slot>
```

Put transient activity in the value, and clear the exact key that was set.

---
issue: 669
issue_title: "pi-subagents: formatTurns() glyph U+27F3 (⟳) overflows its monospace cell, overlapping the next column"
---

# Fix the turn-count glyph overflow and centralize the display glyph vocabulary

## Release Recommendation

**Release:** ship independently

Issue #669 does not appear in the package's architecture roadmap, so it carries no `Release:` batch tag.
It is a user-visible rendering fix with no dependency on other in-flight work, so it should ship on its own.

## Problem Statement

The turn-count indicator renders as `⟳5≤30` via `formatTurns` in `src/ui/display.ts`.
Pi's TUI sizes every terminal cell with `get-east-asian-width`, which reports `⟳` (U+27F3) as one cell wide.
No monospace font on macOS covers U+27F3, so the terminal falls back to a proportional font whose glyph advance exceeds the single cell Pi allocated, and the following digit is drawn on top of the glyph's right half.

The reporter framed this as font-specific to their setup (Ghostty, IBM Plex Mono, a `ko_KR` system locale), and the upstream issue framed it as an East Asian Width problem.
Both framings are wrong in a way that matters: the measurement below shows the cause is monospace coverage, which makes the defect general rather than environmental, and makes an EAW-based fix or guard useless.

## Goals

- Replace the turn-count glyph so the stats line renders within its allocated cells on a stock macOS or Linux terminal.
- Keep the turn and compaction indicators visually distinct from each other.
- Give the package a single place where its semantic display glyphs are declared, so the monospace-coverage constraint is stated once next to the glyphs it governs instead of being rediscovered per incident.
- Record the constraint and its verification command where both a human and an agent will encounter it before choosing a new glyph.

This change is **not** breaking.
It alters rendered TUI output only — no API, no config key, no default, and no persisted or wire-format shape.
It does reassign the meaning of an existing glyph (`↻` moves from compactions to turns), so the commit body must spell the migration out for anyone comparing against older screenshots or logs.

## Non-Goals

- Replacing the other zero-coverage glyphs (`⎿` U+23BF, the Braille spinner frames) or the single-family `◍` (U+25CD).
  These are Pi/Claude-Code house style, so changing them trades a rendering artifact for divergence from pi core — a judgment call tracked in [#683] with the measurements recorded.
- Centralizing the box-drawing characters (`├ └ │ ─ ╭ ╮ ╰ ╯`).
  They are layout, not vocabulary, and they resolve to 9 monospace families; the operator scoped the new module to semantic indicators.
- Any automated glyph guard test.
  Both the buggy and the fixed glyph are EAW width 1, so an EAW assertion passes on `⟳`; a font-coverage assertion is machine-dependent and unfit for CI.
  The existing rendered-output tests remain the pin, and the module doc comment carries the rationale.
- Recomputing the architecture doc's `Total LOC` figure.
  It reads `7,432 (57 files)`, but the source tree measures 7,721 raw lines and 6,853 non-blank lines today, so the LOC number is already stale under an undocumented counter.
  This plan updates the file count only and leaves the LOC recompute to a phase-level metrics pass.
- Editing `CHANGELOG.md`, which release-please owns.

## Background

The defect and the direction were already established in `docs/retro/0669-fix-turn-glyph-monospace-overflow.md` during the review of [#681], the third-party PR from `@goranmoomin` that ports the upstream `tintinweb/pi-subagents` fix.
The operator's recorded decision is to keep upstream's glyph choices but land the work here with expanded scope, using [#681] as reference rather than as the merge target.

Coverage measured on macOS 15 with `fc-list ":charset=<cp>:spacing=100" family | cut -d, -f1 | sort -u | grep -v LastResort`, counting families:

| Glyph                           | Codepoint              | Role                                         | Monospace families |
| ------------------------------- | ---------------------- | -------------------------------------------- | ------------------ |
| `⟳`                             | U+27F3                 | turn count (today)                           | 0                  |
| `↻`                             | U+21BB                 | compaction count (today), turn count (after) | 1 (Menlo)          |
| `⇊`                             | U+21CA                 | compaction count (after)                     | 1 (Menlo)          |
| `⎿`                             | U+23BF                 | sub-line prefix                              | 0                  |
| `⠋`…`⠏`                         | U+280B etc.            | spinner frames                               | 0                  |
| `◍`                             | U+25CD                 | streaming dot                                | 1 (Menlo)          |
| `✓` `✗` `▸`                     | U+2713, U+2717, U+25B8 | status icons, tool-call bullet               | 6                  |
| `■` `●` `○` `◦` `├` `└` `│` `─` | U+25A0 etc.            | status icon, headings, tree                  | 9                  |
| `≤`                             | U+2264                 | turn-limit separator                         | 10                 |

The family-trimming step above must be `cut -d, -f1` rather than the more habitual `sed 's/,.*//'` wherever the command is quoted inside a block comment.
The `sed` script contains `*/`, which closes the comment early and breaks the enclosing file's parse.

Two constraints from `AGENTS.md` and the package skill apply.
First, the package is a hard fork whose stated policy is to cherry-pick upstream fixes that align with the fork's scope, which is exactly what the glyph substitution is.
Second, `pi-autoformat` reflows what it writes, so a README table row edited once must be re-read before it is edited again.

The relevant modules and their current glyph sites:

| Module                           | Glyph sites                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/ui/display.ts`              | `SPINNER` frames, `↻` compactions (`formatSessionTokens`), `⟳` turns (`formatTurns`)                                    |
| `src/ui/widget-renderer.ts`      | `✓` `✗` `■` status icons, `\u23BF` activity prefix, `\u25E6` queued marker, `\u25CF`/`\u25CB` heading icon, box drawing |
| `src/observation/renderer.ts`    | `✓` `✗` status icons, `⎿` preview prefix                                                                                |
| `src/tools/result-renderer.ts`   | `\u2713` `\u2717` `\u25A0` icons, `⎿` and `\u23BF` sub-line prefixes, `SPINNER` import                                  |
| `src/tools/agent-tool.ts`        | `▸` inline tool-call bullet                                                                                             |
| `src/tools/foreground-runner.ts` | `SPINNER` import                                                                                                        |
| `src/ui/session-navigator.ts`    | `◍` streaming dot, box drawing                                                                                          |

## Design Overview

### Why a vocabulary module, concretely

The same glyph is written two ways in this codebase, sometimes within one file: `src/tools/result-renderer.ts` uses a literal `⎿` at line 37 and the escape `\u23BF` at line 43, and `✓` appears as a literal in `src/observation/renderer.ts` but as `\u2713` in `src/tools/result-renderer.ts`.
This is not cosmetic.
A literal-only grep — the search both [#681] and this issue's review used — cannot see the escaped sites, and it missed `\u25E6` and `\u25CF`/`\u25CB` entirely.
Centralizing the semantic glyphs removes the class of error where a glyph is changed at four of its six sites.

The module is a leaf: string constants, no imports, no behavior.
The `design-review` checklist finds nothing to flag — there is no interface to widen, no dependency to thread, no state to own, and no discriminator to scatter.
Consumers in `observation/` and `tools/` already import from `ui/display.ts`, so importing from `ui/glyphs.ts` introduces no new direction of dependency.

### The module

`src/ui/glyphs.ts`, using literal characters (not escapes) so that the file is both the single source and the thing a non-ASCII scan finds:

```typescript
/**
 * glyphs.ts — the semantic display-glyph vocabulary for the agent UI.
 *
 * Pi's TUI sizes each cell with `get-east-asian-width`, which reports one cell
 * for every glyph below. A glyph that no monospace font covers is therefore
 * drawn by a proportional fallback font whose advance overruns that cell and
 * collides with the next column — the defect in #669.
 *
 * Before adding or changing a glyph, measure its monospace coverage:
 *
 *   fc-list ":charset=<codepoint>:spacing=100" family | cut -d, -f1 | sort -u | grep -v LastResort
 *
 * Coverage on macOS 15, in families:
 *
 *   ↻ U+21BB turns         1 (Menlo)      ✓ U+2713 success     6
 *   ⇊ U+21CA compactions   1 (Menlo)      ✗ U+2717 failure     6
 *   ■ U+25A0 stopped       9              ▸ U+25B8 tool call   6
 *   ● U+25CF / ○ U+25CB    9              ◦ U+25E6 queued      9
 *   ⎿ U+23BF sub-line      0  — pi house style, tracked in #683
 *   ◍ U+25CD streaming     1 (Menlo)      — tracked in #683
 *   ⠋…⠏ spinner frames     0  — pi house style, tracked in #683
 *
 * Glyphs are written here as literal characters, so a non-ASCII scan of `src/`
 * shows this file plus only layout box-drawing and punctuation. Box-drawing
 * characters stay at their render sites: they are layout, not vocabulary.
 */
export const GLYPHS = {
  turns: "↻",
  compactions: "⇊",
  success: "✓",
  failure: "✗",
  stopped: "■",
  subLine: "⎿",
  toolCall: "▸",
  streaming: "◍",
  queued: "◦",
  agentsActive: "●",
  agentsIdle: "○",
} as const;

/** Braille spinner frames for the animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
```

`SPINNER` keeps its current name and its mutable `string[]` type.
Renaming it or freezing it would churn three importers and their index arithmetic for no gain.

### Consumer call sites

The substitution is direct, and the surrounding code does not change shape:

```typescript
// src/ui/display.ts
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `${GLYPHS.turns}${turnCount}≤${maxTurns}` : `${GLYPHS.turns}${turnCount}`;
}

// src/ui/widget-renderer.ts
icon = theme.fg("success", GLYPHS.success);
const activityLine = theme.fg("dim", `  ${GLYPHS.subLine}  ${activityText}`);
```

Note that `✓` serves both `completed` (success color) and `steered` (warning color), so the key is named for the glyph's outcome class, not for a single status.
The `≤` in `formatTurns` stays inline: it is a comparison operator in a formatted string, not an indicator, and it resolves to 10 monospace families.

### Ordering: tidy first

The extraction lands before the glyph change.
Moving the glyphs while they still hold their current values is a pure refactor whose correctness is proven by the existing rendered-output tests passing with **zero test edits**.
The fix then becomes a two-constant change in one file, which is the smallest reviewable form of the behavior change and keeps the `fix:` commit's diff about the decision rather than the plumbing.

## Module-Level Changes

| File                                       | Change                                                                                                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/glyphs.ts`                         | **New.** `GLYPHS` vocabulary plus `SPINNER`, with the coverage rationale and verification command in the module doc comment.                                                                                                           |
| `src/ui/display.ts`                        | `SPINNER` removed (moved to `glyphs.ts`); `formatSessionTokens` and `formatTurns` read `GLYPHS.compactions` / `GLYPHS.turns`; doc comments updated to the new glyphs.                                                                  |
| `src/ui/widget-renderer.ts`                | `✓` `✗` `■` `\u23BF` `\u25E6` `\u25CF` `\u25CB` replaced with `GLYPHS.*`; `SPINNER` import repointed to `#src/ui/glyphs`. Box drawing left as-is.                                                                                      |
| `src/observation/renderer.ts`              | `✓` `✗` in `resolveStatusPresentation` and the `⎿` preview prefix replaced with `GLYPHS.*`.                                                                                                                                            |
| `src/tools/result-renderer.ts`             | `\u2713` `\u2717` `\u25A0` and all six `⎿`/`\u23BF` prefixes replaced with `GLYPHS.*`; `SPINNER` import repointed; `renderStats` doc comment updated to the new turn glyph.                                                            |
| `src/tools/agent-tool.ts`                  | `▸` replaced with `GLYPHS.toolCall`.                                                                                                                                                                                                   |
| `src/tools/foreground-runner.ts`           | `SPINNER` import repointed to `#src/ui/glyphs`.                                                                                                                                                                                        |
| `src/ui/session-navigator.ts`              | `◍` replaced with `GLYPHS.streaming`. Box drawing left as-is.                                                                                                                                                                          |
| `test/display.test.ts`                     | Compaction expectations `↻N` → `⇊N` (4 assertions).                                                                                                                                                                                    |
| `test/observation/renderer.test.ts`        | `buildStatsParts` expectations `⟳5≤10` → `↻5≤10` (5 assertions).                                                                                                                                                                       |
| `test/tools/result-renderer.test.ts`       | `renderStats` expectations `[dim:⟳5≤30]` → `[dim:↻5≤30]`, and the two `not.toContain("⟳")` assertions → `"↻"`.                                                                                                                         |
| `test/widget-renderer.test.ts`             | `⟳3≤10` / `⟳2≤10` expectations → `↻`, and the `↻1` compaction expectation → `⇊1`.                                                                                                                                                      |
| `test/ui/agent-widget.test.ts`             | `⟳3` expectation → `↻3`.                                                                                                                                                                                                               |
| `README.md`                                | 11 inline stats-line examples plus the `↻N` legend bullet → new glyphs.                                                                                                                                                                |
| `docs/architecture/architecture.md`        | Module tree gains `ui/glyphs.ts` (`semantic display-glyph vocabulary`); health-metrics file count `57` → `58`.                                                                                                                         |
| `.pi/skills/package-pi-subagents/SKILL.md` | Domain table: UI modules `6` → `7` with `glyphs.ts` listed, `seven domains (57 files)` → `58 files`; new note stating that display glyphs live in `src/ui/glyphs.ts` and must be verified for monospace coverage before being changed. |

Grep verification performed at planning time, so the file list above is complete:

- `rg -n '\\u[0-9A-Fa-f]{4}' src` — found the escaped sites a literal grep misses, including `\u25E6`, `\u25CF`, `\u25CB`.
- `rg -n 'SPINNER' src test` — three `src/` importers, no `test/` importers, so moving the export breaks nothing in the suite.
- `rg -n '⟳|↻|⇊' packages/ .pi --glob '!CHANGELOG.md'` — only `src/ui/display.ts`, `src/tools/result-renderer.ts`, `README.md`, the five test files, and historic `docs/plans`/`docs/retro` prose, which stays untouched.
- No `docs/guides`, `docs/decisions`, or sibling-package reference to either glyph exists.

`README.md` is the only user-facing doc that renders the glyphs, and no `pkg:*` sibling or shared skill names them.

## Test Impact Analysis

1. **New tests enabled.**
   None are required, and none are added, per the operator's docs-only guard decision.
   The extraction does make a future vocabulary-level test possible for the first time — a single import surface instead of eleven scattered literals — which is what [#683] would need if it proceeds.
2. **Tests that become redundant.**
   None.
   It is tempting to collapse the five files' literal assertions into one test of `GLYPHS`, and that would be wrong: those tests assert *rendered output*, which is what a user sees, whereas a `GLYPHS` test would assert only that a constant holds what it holds.
   Keep the rendered-output assertions distributed as they are.
3. **Tests that must stay as-is.**
   All of `test/display.test.ts`, `test/observation/renderer.test.ts`, `test/tools/result-renderer.test.ts`, `test/widget-renderer.test.ts`, and `test/ui/agent-widget.test.ts`.
   In Step 1 they are the safety net that proves the extraction changed no output; in Steps 2 and 3 they are the red/green pin on the glyph change itself.

## Invariants at risk

| Invariant                                                                                          | Origin                                                    | Pinned by                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `buildStatsParts` returns ordered parts with `formatTurns`' exact output shape                     | Phase 20 Step 7, decompose notification renderer ([#541]) | `test/observation/renderer.test.ts` `buildStatsParts` cases — updated in Step 2, still asserting the full ordered array   |
| Widget renders turn counts read off the persisted `Subagent` record, including for finished agents | Phase 18 migration of activity readers to record getters  | `test/ui/agent-widget.test.ts` projection case — updated in Step 2, still asserting the turn count appears                |
| Compaction count is annotated inside the token parens, dim, and omitted at zero                    | Context-utilization indicator work                        | `test/display.test.ts` `formatSessionTokens` cases, including the `compactions=0` omission assertion, which no step edits |
| Rendered output is unchanged by the extraction                                                     | This plan, Step 1                                         | The full suite passing with zero test edits in Step 1 — a measurement, not an argument                                    |

No invariant here is quantitative: the change touches no prompt prefix, token budget, cache key, or latency path.

## TDD Order

1. **Extract the glyph vocabulary.**
   Add `src/ui/glyphs.ts` holding the eleven `GLYPHS` entries at their *current* values (`turns: "⟳"`, `compactions: "↻"`) plus `SPINNER`, with the doc comment's coverage table reflecting the current state.
   Replace every literal and escaped glyph site in `src/ui/display.ts`, `src/ui/widget-renderer.ts`, `src/observation/renderer.ts`, `src/tools/result-renderer.ts`, `src/tools/agent-tool.ts`, and `src/ui/session-navigator.ts`, and repoint the `SPINNER` imports in `src/tools/result-renderer.ts`, `src/ui/widget-renderer.ts`, and `src/tools/foreground-runner.ts`.
   Removing the `SPINNER` export from `display.ts` breaks its importers at the type level, so the move and all three import updates must land in this one commit.
   Verify: `pnpm run check`, `pnpm run lint`, and the full package suite pass with **no test file edited**; `rg -n '[^\x00-\x7f]' src --glob '*.ts'` shows glyphs only in `glyphs.ts` plus box drawing and punctuation.
   Commit: `refactor(pi-subagents): centralize display glyph vocabulary`
2. **Red: expect the new glyphs.**
   Update the turn-count and compaction expectations across `test/display.test.ts`, `test/observation/renderer.test.ts`, `test/tools/result-renderer.test.ts`, `test/widget-renderer.test.ts`, and `test/ui/agent-widget.test.ts`.
   Verify: the suite fails on exactly those assertions and no others.
   Commit: `test(pi-subagents): expect monospace-safe turn and compaction glyphs`
3. **Green: swap the two constants.**
   Set `turns: "↻"` and `compactions: "⇊"` in `src/ui/glyphs.ts` and refresh its coverage table; update the `formatSessionTokens`, `formatTurns`, and `renderStats` doc comments; update the 11 README examples and the legend bullet.
   Verify: full suite green; `rg '⟳' src README.md` returns nothing.
   Commit: `fix(pi-subagents): replace turn glyph that overflows its monospace cell` The body states the mechanism (zero monospace coverage for U+27F3, not East Asian Width), spells out the migration for anyone matching on the old output — `⟳` → `↻` for turns and `↻` → `⇊` for compactions — and ends with `Refs #669`, `Refs #681`, and the `Co-authored-by: Sungbin Jo <goranmoomin@daum.net>` trailer after a blank line.
4. **Document the constraint.**
   Add the `ui/glyphs.ts` entry to the architecture doc's module tree and bump its file count `57` → `58`; update the package skill's domain table (UI `6` → `7`, `57` → `58` files) and add the note that display glyphs live in `src/ui/glyphs.ts` and need a monospace-coverage check before they change.
   Verify: `pnpm exec rumdl check` on both files.
   Commit: `docs(pi-subagents): record the monospace glyph-coverage constraint`

Every commit in Steps 1 through 4 carries the `Co-authored-by: Sungbin Jo <goranmoomin@daum.net>` trailer, per the decision recorded in the retro.
No commit uses `Closes #681`, which would pre-empt the curated close comment at ship time.

## Risks and Mitigations

| Risk                                                                                                 | Mitigation                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A literal-only grep misses escaped glyph sites, leaving a glyph changed at some sites and not others | Step 1's verification is a non-ASCII scan of `src/`, not a per-glyph grep, so any missed site shows up as a literal outside `glyphs.ts`                                                                       |
| `↻` and `⇊` each resolve to a single monospace family (Menlo), so coverage is thin                   | Accepted deliberately, and recorded in the module doc comment with the numbers; Menlo ships with macOS, and both glyphs sit in the standard Arrows block that Linux mono fonts such as DejaVu Sans Mono cover |
| Reassigning `↻` from compactions to turns makes old screenshots and logs ambiguous                   | Step 3's commit body states the mapping explicitly so release-please carries it into the CHANGELOG entry                                                                                                      |
| `pi-autoformat` reflows README table rows on write, so a second edit to the same row fails to match  | Re-read the README region after the first edit before editing it again                                                                                                                                        |
| The extraction could silently alter rendered output                                                  | Step 1 edits no test; the suite passing unchanged is the measurement                                                                                                                                          |
| Renaming `SPINNER` or freezing it as `readonly` would churn three importers                          | The move keeps the name and the `string[]` type                                                                                                                                                               |

## Open Questions

- Whether `⎿`, the Braille spinner frames, and `◍` should also change is deferred to [#683], which records the coverage measurements and the pi-core-divergence tradeoff.
  Nothing here should be done unless a user reports one of them misrendering.
- Whether the architecture doc's `Total LOC` figure should be recomputed and under which counter is left to a phase-level metrics pass; this plan touches the file count only.

[#541]: https://github.com/gotgenes/pi-packages/issues/541
[#681]: https://github.com/gotgenes/pi-packages/pull/681
[#683]: https://github.com/gotgenes/pi-packages/issues/683

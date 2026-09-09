---
issue: 669
issue_title: "pi-subagents: formatTurns() glyph U+27F3 (⟳) overflows its monospace cell, overlapping the next column"
pr: 681
---

# Retro: #669 — pi-subagents: `formatTurns()` glyph U+27F3 (⟳) overflows its monospace cell

## Stage: PR Review (2026-07-28T15:01:30Z)

### Session summary

PR #681 from `@goranmoomin` (Sungbin Jo) ports the upstream `tintinweb/pi-subagents` fix for its issue #84 (commit `aad202a`) into this fork: the turn-count glyph moves from `⟳` (U+27F3) to `↻` (U+21BB), and the compaction glyph moves from `↻` to `⇊` (U+21CA) to keep the two indicators distinct.
The defect was confirmed on current `main` by mechanism, and the PR passes the full repo gate cleanly.
The operator chose to adopt the capability with upstream's glyph choices but land it ourselves with expanded scope — a centralized glyph-vocabulary module plus a follow-up issue for the other mono-unsafe glyphs — so #681 is reference, not the merge target.

### Evaluation

The defect is real, and the mechanism is now pinned down rather than inferred.
Pi's TUI computes cell width with `get-east-asian-width` (`../pi/packages/tui/src/utils.ts:196`), which reports `U+27F3` as width 1, type `neutral` — so the issue body's "East Asian Width is Ambiguous" claim is wrong and upstream's commit message ("despite its Neutral EAW") is right.
The actual cause is font coverage: `fc-list ":charset=27F3:spacing=100"` returns **zero** monospace families on macOS (only Apple Symbols, STIX, and `.LastResort` cover it, all proportional), so the terminal font-falls-back to a proportional glyph whose advance exceeds the one cell Pi allocated, and the next character overlaps it.
That makes the failure general rather than specific to the reporter's Ghostty + IBM Plex + `ko_KR` setup.

Archaeology and boundary checks:

| Check                             | Result                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Already fixed upstream of us?     | No — `main` still emits `⟳` at `src/ui/display.ts:103`                                                                                                                                                 |
| Real boundary                     | `formatTurns` (`src/ui/display.ts:101-103`) and `formatSessionTokens` (`src/ui/display.ts:94`); the PR touches exactly those, plus the `renderStats` doc comment in `src/tools/result-renderer.ts:106` |
| Regression in the other direction | Safe — `↻` (U+21BB) and `⇊` (U+21CA) both resolve to Menlo, a monospace macOS system font, so both render at one cell                                                                                  |
| Repo gate at PR head `33f40bff`   | `pnpm run check` rc=0; `pnpm run lint` rc=0 (biome + eslint + rumdl); `@gotgenes/pi-subagents` 1134 tests / 64 files passed                                                                            |

What is valuable in the PR: the glyph selection is well-reasoned and verified, the port to this fork's structure is correct (upstream's single `src/ui/agent-widget.ts` maps to our `src/ui/display.ts` + `src/tools/result-renderer.ts`), all 11 README examples and the legend were updated consistently, no stray `⟳` remains outside historic `docs/plans`/`docs/retro`, and `CHANGELOG.md` was correctly left alone since release-please owns it.
It also matches this package's stated policy of cherry-picking upstream fixes that align with the fork's scope.

What we would add rather than change:

1. Glyph coverage is thin for the replacements — `↻` and `⇊` each resolve to exactly one monospace family here (Menlo), versus 18–27 families for `✓`, `✗`, `≤`, and the box-drawing characters.
   Acceptable, but it means the vocabulary deserves a recorded rationale rather than folklore.
2. There is no new test, and that is close to the honest ceiling: both the buggy and the fixed glyph are EAW width 1, so an EAW-based guard test would pass on `⟳`.
   The only feasible guard is a centralized glyph vocabulary with a documented monospace-coverage rationale — hence the expanded scope.
3. The same defect class exists elsewhere in the package and the PR leaves it untouched: `⎿` (U+23BF) has **zero** monospace families (`src/observation/renderer.ts:91`, `src/tools/result-renderer.ts:37`), and `◍` (U+25CD) has one (`src/ui/session-navigator.ts:267`).
   Both are Pi/Claude-Code house style, so changing them trades one rendering artifact for divergence from pi core — a judgment call that belongs in its own tracked issue, not in this fix.
4. Glyph literals are scattered inline across four modules with no single vocabulary, so this fix required a repo-wide hunt that the next one would repeat.

Behavior and versioning: the change is visual output only, with no API, config, or default change, so `fix(pi-subagents):` is correct and it is not breaking.
It does reassign the meaning of an existing glyph (`↻` moves from compactions to turns), which makes `↻N` ambiguous when comparing against older screenshots and logs, so the commit body must spell the migration out.

### Decision and attribution

Direction: adopt the capability, plan the expanded scope — use #681 as reference and land the work ourselves via `/plan-issue #669`.

Agreed scope:

1. Keep upstream's glyph choices: turns render as `↻` (U+21BB), compactions move to `⇊` (U+21CA).
   The reassignment is accepted deliberately, in favor of staying aligned with the upstream vocabulary the reporter (a user of both projects) matched.
2. Centralize the scattered glyph literals into one vocabulary module with a documented monospace-coverage rationale, so a future glyph change is one edit and the "must be present in a monospace font" constraint is written down rather than rediscovered.
3. File a follow-up issue covering `⎿` (U+23BF, zero monospace families) and `◍` (U+25CD, one), recording the pi-core-divergence tradeoff.
   The follow-up must carry a real issue number before the implementing stage closes.
4. The commit body carries an explicit migration heads-up — `⟳` → `↻` (turns) and `↻` → `⇊` (compactions) — so release-please surfaces it in the generated CHANGELOG entry.

Non-goals: changing `⎿`, `◍`, or the Braille spinner glyphs in this issue; any automated EAW-based glyph test (it cannot detect this defect class); editing `CHANGELOG.md` by hand.

Attribution: every implementation and docs commit for this issue ends with a blank line and then the trailer:

```text
Co-authored-by: Sungbin Jo <goranmoomin@daum.net>
```

Reference the PR as `Refs #681` / `(#681)`, never `Closes #681`.
At ship time, close PR #681 with a comment thanking `@goranmoomin` by name, crediting the upstream port and the glyph analysis, and linking the implementing SHA(s).

## Stage: Planning (2026-07-28T16:48:21Z)

### Session summary

Wrote `docs/plans/0669-fix-turn-glyph-monospace-overflow.md`: a four-step plan that extracts `src/ui/glyphs.ts` first (tidy first, zero test edits as the proof), then swaps the two glyph constants red/green, then documents the monospace-coverage constraint in the architecture doc and the package skill.
The operator settled four design parameters via `ask_user`: the module covers semantic indicators only (box drawing stays inline as layout), the guard is a documented rationale rather than a new test, the rationale lives in a module doc comment plus a package-skill note, and the follow-up covers `⎿` + `◍` + the Braille spinner.
Filed that follow-up as issue #683 with the coverage measurements recorded.

### Observations

- **The strongest argument for the vocabulary module was found during planning, not during review.**
  The same glyph is written two ways in one file — literal `⎿` at `src/tools/result-renderer.ts:37` and `\u23BF` at line 43, `✓` literal in `src/observation/renderer.ts` but `\u2713` in `src/tools/result-renderer.ts`.
  A literal-only grep — which PR #681 relied on, and which the PR-review stage of this issue also used — cannot see the escaped sites, and it missed `\u25E6` (queued marker) and `\u25CF`/`\u25CB` (widget heading) entirely.
  Centralization removes the failure mode where a glyph is changed at four of its six sites.
  Lesson worth carrying: when auditing character-level usage, scan for the escaped form (`rg '\\u[0-9A-Fa-f]{4}'`) as well as the literal, or scan non-ASCII wholesale.
- **A measurement was wrong for two stages before it was caught.**
  The PR-review stage reported `✓`/`✗`/box-drawing as covering "18–27 monospace families"; the real figures are 6 and 9.
  The pipeline used `wc -w` on a family list, so every multi-word family name (`Andale Mono`, `Courier New`) counted two or three times.
  Corrected here, and issue #683's body was edited to match before the plan was committed.
  Counting lines of a list requires `grep -c .` or `wc -l`, never `wc -w`.
- **Ordering was inverted relative to the PR deliberately.**
  PR #681 changes the glyph in place; this plan extracts first so the `fix:` commit is a two-constant diff.
  That also gives the extraction a free correctness proof — the existing rendered-output tests pass with no test file edited — which is a measurement rather than a review argument.
- **The docs-only guard decision is the honest one, and worth recording as a general point.**
  An EAW-based assertion would pass on the buggy glyph (`⟳` is width 1), and a font-coverage assertion is machine-dependent.
  When a defect class has no deterministic detector, a documented rationale next to the constrained code beats a test that pins the wrong property.
- **The architecture doc's `Total LOC` figure is stale under an unknown counter** — it reads `7,432 (57 files)` while the tree measures 7,721 raw and 6,853 non-blank lines.
  The plan updates the file count only and defers the LOC recompute rather than inventing a number.
- Issue #669 is absent from the architecture roadmap, so the release recommendation is `ship independently` with no batch tag to consult.

## Stage: Implementation — TDD (2026-07-28T17:45:18Z)

### Session summary

Executed all four planned steps in order: extracted `src/ui/glyphs.ts` as a pure refactor (`5b22891f`), turned the five test files red on the new glyphs (`fd8035f8`), went green by changing two constants plus the doc comments and 11 README examples (`8a54b9ca`), and documented the monospace-coverage constraint in the architecture doc and package skill (`0bf4e4e6`).
A fifth commit (`a5fc1f0b`) corrected a trap in the plan itself, in response to the reviewer's WARN.
Test count is unchanged at 1135 — by design, since the guard decision was documented rationale rather than a new test; the five test files' assertions were updated in place.

### Observations

- **The plan's own doc-comment sketch was unshippable, and the failure was instant and loud.**
  The sketch trimmed `fc-list` output with `sed 's/,.*//'`, whose script contains `*/`.
  Quoted inside the `/** ... */` block comment it was documenting, that closed the comment early; biome reported 66 parse errors on the first write of `src/ui/glyphs.ts`, including "unterminated regex literal" pointing at the `sed` script.
  Fixed by switching to `cut -d, -f1`, verified equivalent.
  Generalizable: any shell snippet embedded in a block comment must be screened for `*/`, and `sed` substitutions ending in `//` are the common way to smuggle one in.
- **Tidy First paid off exactly as the plan predicted, and the assessor agreed without adding work.**
  The `tidy-first-assessor` returned "no preparatory tidying warranted," explicitly reasoning that Step 1 *is* the tidy-first move and that pre-normalizing the literal-vs-escape split would touch the same lines twice for no risk reduction.
  The extraction commit then passed the full suite with zero test files edited, which is the measurement the plan wanted, and the `fix:` commit's source diff came out to two constants.
- **The escaped-glyph hazard the plan flagged was real in practice, not just in theory.**
  `src/tools/result-renderer.ts` alone held six `\u23BF` escapes plus one literal `⎿`, and `widget-renderer.ts` line 179 interleaves a box-drawing escape that stays with a `\u25E6` that goes.
  The non-ASCII scan (`rg -n '[^\x00-\x7f]' src`) rather than a per-glyph grep was what made completeness checkable; after Step 1 it reported only `glyphs.ts`, layout box drawing, punctuation, and the four doc comments Step 3 then updated.
- **`pi-autoformat` fought a one-sentence-per-line edit twice.**
  It rejoins a colon-terminated line with the sentence after it, so the deviation note appended to the coverage-table lead-in kept collapsing back onto one line.
  Resolved by moving the note below the table as its own paragraph.
  Worth remembering: to add a sentence after a colon-terminated line, start a new paragraph rather than a new line.
- **A skill-table edit needed a script, not the `Edit` tool.**
  The package skill's domain table is padded to fixed column widths well past 600 characters, so changing `6` → `7` and widening a description cell by hand would have broken alignment; a short Python rewrite preserved the exact line length.
- Pre-completion reviewer: WARN (1 non-blocking finding).
  Reviewer warnings: the plan's embedded sketch still showed the broken `sed` form with no record of the deviation — addressed in `a5fc1f0b`, which corrects the sketch and states why `cut` is required there.
  Everything else passed, including the issue-specific attribution check (all implementation commits carry the `Co-authored-by` trailer, none uses `Closes #681`) and the follow-up-filing check (#683).

## Stage: Final Retrospective (2026-07-28T21:39:28Z)

### Session summary

One continuous session carried a third-party PR from evaluation to release: PR #681 was evaluated and declined-in-favor-of-reimplementation, issue #669 was planned, implemented across four TDD commits, shipped, and released as `@gotgenes/pi-subagents@19.2.1`.
The defect was confirmed by mechanism rather than by the PR's narrative — `⟳` (U+27F3) has zero monospace coverage, so Pi's one-cell allocation overflows — and the fix landed behind a preparatory extraction of `src/ui/glyphs.ts`.
Contributor credit rode every commit as a `Co-authored-by` trailer, and both #669 and PR #681 were closed with linked SHAs.

### Observations

#### What went well

- **The Verify gate paid for itself immediately, and inverted the PR's own diagnosis.**
  Both the issue body ("East Asian Width is Ambiguous") and the reporter's framing (font-specific to their Ghostty + IBM Plex + `ko_KR` setup) were wrong.
  Reading Pi's own source at `../pi/packages/tui/src/utils.ts:196` plus an `fc-list` coverage sweep established the real mechanism in under ten tool calls, which is what made the fix generalizable rather than a sympathetic patch.
  The upstream commit message, not the issue, turned out to be the accurate account — worth remembering that a linked upstream fix can be right for reasons its own issue states incorrectly.
- **Tidy First validated a plan's sequencing instead of adding work.**
  The `tidy-first-assessor` returned "no preparatory tidying warranted" and argued that Step 1 *was* the tidy-first move, explicitly rejecting a pre-normalization pass as double-touching the same lines.
  This is the first time the assessor's value showed up as a confirmation rather than a list — a useful demonstration that a null result from it is a real signal, not a wasted dispatch.
- **The extraction's correctness proof was a measurement, not an argument.**
  "Full suite green with zero test files edited" is checkable in a way that "this refactor is behavior-preserving" is not.
  Worth reaching for whenever a refactor precedes a behavior change.
- **The PR-review → planning handoff did not re-litigate the decision.**
  The recorded direction in the PR Review stage entry satisfied `/plan-issue`'s Decide gate, so planning spent its `ask_user` budget on genuinely open design parameters (module scope, guard shape, rationale home, follow-up breadth) rather than re-asking whether to proceed.
- **The ship stage honored a subtle prompt distinction under a cheaper model.**
  `release_pr_merge` refused with `merge_state: UNSTABLE`; the rollup showed a check genuinely `IN_PROGRESS` rather than the empty-rollup `GITHUB_TOKEN` case, so the run was watched to completion and the merge retried — no `gh pr merge` fallback.

#### What caused friction (agent side)

- `missing-context` — the plan's sketched module doc comment embedded `sed 's/,.*//'`, whose `*/` closes the enclosing block comment.
  Nothing in planning screened the snippet for comment-terminating sequences before writing it into a `/** ... */` block.
  Impact: 66 biome parse errors on the first `Write` of `src/ui/glyphs.ts`, one corrective edit, and a follow-up commit (`a5fc1f0b`) to fix the plan — the latter only because the pre-completion reviewer flagged the plan/implementation divergence.
  Self-identified at write time; the plan-side correction was reviewer-caught.
- `missing-context` — a coverage measurement was wrong for two full stages.
  The PR-review stage counted monospace families with `wc -w` on a family list, inflating `✓`/`✗` to "18–27" (real: 6) and box drawing to the same (real: 9), because multi-word names such as `Andale Mono` counted twice.
  Impact: wrong figures shipped into issue #683's body and had to be corrected with `gh issue edit` before the plan was committed; no code impact.
  Self-identified during planning when the sweep was re-run.
- `missing-context` — the PR-review completeness check ("no stray `⟳` remains") used a literal-only grep against a codebase that writes the same glyphs as `\uXXXX` escapes.
  Impact: no rework — planning caught it before implementation, and it became the strongest argument for the vocabulary module — but the review stage's confidence was unearned at the time it was stated.
- `other` (tooling) — `pi-autoformat` rejoins a line ending in `:` with the sentence following it, so a deviation note appended after the coverage-table lead-in collapsed onto one line twice before being restructured as its own paragraph below the table.
  Impact: two extra edit round-trips.
- `other` (tooling) — an `Edit` on the package skill's domain table failed because its cells are padded to fixed widths past 600 characters and the `oldText` was reconstructed rather than read.
  Impact: one failed edit, recovered with a short Python rewrite that preserved column widths; verified afterwards that `rumdl fmt` does **not** re-pad tables, so preserving alignment by hand was in fact required.
- `other` — the first `ask_user` call in planning bundled four questions and came back with the `direction` answer missing.
  Impact: one extra `ask_user` round-trip to recover the single dropped answer.

#### What caused friction (user side)

- Nothing obstructive — the session ran with near-full delegation across five stages.
  The one mid-flow intervention ("Next step is /plan-issue?") was a cheap confirming question at a stage boundary, which is the right shape.
- Opportunity, not criticism: the operator's four planning answers were all preference calls that only they could make, so the `ask_user` budget was well spent.
  The one place earlier context would have helped is the release-batching picture — an unreleased sibling `fix:` (`b6ab6bbe`, the `escapeXml` fix) was sitting on `main` and rode this release, which only surfaced at step 4b of shipping.
  Knowing that up front would not have changed the outcome, but it would have made the release contents predictable rather than discovered.

### Diagnostic details

- **Model-performance correlation** — clean, no mismatches.
  PR review, planning, and TDD ran on `anthropic/claude-opus-5` (judgment-heavy: defect verification, design parameters, code review).
  Shipping ran on `anthropic/claude-sonnet-5` (mechanical: push, CI watch, merge, close) and still handled its two prose tasks — the issue close comment and the PR #681 credit comment — without quality loss.
  Both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `anthropic/claude-sonnet-5` per their frontmatter; the reviewer produced a substantive, correct WARN, so neither was under-powered.
- **Escalation-delay tracking** — nothing to flag; no `rabbit-hole` friction points, and the longest streak on a single error was two tool calls (the plan-file edit after an autoformat reflow).
- **Unused-tool detection** — no gap.
  `colgrep` went unused, correctly: every search was an exact character, codepoint, or symbol hunt where `rg` is the right instrument.
  The `../pi` lookup for the width function was a single targeted read, which `AGENTS.md` explicitly permits without an `Explore` dispatch.
- **Feedback-loop gap analysis** — no gap.
  Verification ran incrementally rather than only at the end: a green baseline (`check`, `lint`, `test`) before Step 1; `check` + full package suite + root `lint` after the extraction; a targeted `vitest run` to confirm the red; full suite + `check` + `lint` after the green; then full gates plus `pnpm fallow dead-code` before the pre-completion dispatch.
  The planning stage also ran `rumdl check` on the plan before committing it.

### Changes made

1. `AGENTS.md` — Code Style: added the rule that a shell snippet quoted inside a `/* */` block comment must not contain `*/`, with `cut -d, -f1` as the replacement for `sed 's/,.*//'`.
2. `AGENTS.md` — Edit tool batches: extended the existing decorative-comment-rule anchoring sentence to cover width-padded table rows, noting that `rumdl fmt` does not re-pad tables.
3. `AGENTS.md` — Tool-injected messages: added that `pi-autoformat` joins a line ending in `:` with the sentence after it, so a following sentence needs a new paragraph.
4. `.pi/prompts/plan-issue.md` — Module-Level Changes: added the rule to grep the `\uXXXX` escaped form as well as the literal when a step changes a character or codepoint, or to scan non-ASCII wholesale.

Considered and rejected: a `wc -l` vs `wc -w` counting rule (generic shell competence, and `AGENTS.md` is already dense); an `ask_user` batch-size limit (one occurrence, reads as a UI artifact); a heuristic that documented rationale can beat a guard test (one data point, and it risks discouraging real tests).

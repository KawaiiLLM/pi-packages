---
issue: 689
issue_title: "pi-subagents: /subagents:sessions becomes unresponsive on large live transcripts"
---

# Retro: #689 — Make the `/subagents:sessions` preview viewport-bound

## Stage: Planning (2026-08-10T21:09:23Z)

### Session summary

Planned the fix for the `/subagents:sessions` overlay becoming unresponsive on large live transcripts.
Issue #689 and PR [#690] are both third-party (`@daoguademeng`), and PR [#670] (`@aqua2k1`) independently reports the width-mismatch half — so the session began by verifying the diagnosis by measurement rather than trusting either PR body, then researched Pi's own event ordering at `../pi` before putting the depth decision to the operator.
The plan lands in five code steps plus a docs step: fix the input/render width mismatch, extract a `TranscriptContent` collaborator, make paint and scroll viewport-bound, stop rebuilding history per streaming delta, and settle messages incrementally.

### Observations

Measurement came before the `ask_user` gate, and it changed the question.
A scratch Vitest fixture (200 messages, width 144, `Container.render()` counted by prototype spy) put current `main` at 90.5 ms per scroll interaction and 44.7 ms per settle, scaling linearly (170 ms/settle at 800 messages).
Applying PR [#690]'s two commits to a scratch tree and re-running the same fixture produced the after-numbers directly, so every figure in the plan's table is measured on both sides rather than quoted from the PR.

The first `ask_user` bounced on depth — the operator asked whether Pi itself needed researching before choosing.
It did, and the answer flipped the risk assessment.
An `Explore` subagent on `../pi` (HEAD `98145a6c0`) confirmed three things that made the deeper option the safer one: `message_end` fires per message for **every** role including each tool result (so the ~45 ms settle is the dominant cost on a tool-heavy agent, projecting to ~225 ms on the reported session); the state-before-listeners ordering is real (`agent.ts:556` before `:588`); and Pi's own interactive mode already settles incrementally (`interactive-mode.ts:3120`–`3192`), so the design mirrors Pi rather than inventing a model.

Two findings simplify our version relative to PR [#690].
A partial assistant message lives in `state.streamingMessage` and is never in `state.messages` (`agent.ts:552`), so the PR's `isLiveMessage` / timestamp-matching guard defends a state that cannot occur and is dropped.
And an extension's in-place `message_end` replacement is applied *before* session listeners are notified (`agent-session.ts:634` before `:637`), so the overlay always consumes final content — a risk the PR body does not address at all.

One incidental discovery reframes the whole change: pi-tui's `Markdown` already caches rendered lines per width (`markdown.ts:248`), while `Container.render` does not cache.
So a rebuild is expensive chiefly because it *discards* pi-tui's own caches by constructing fresh components — incremental settling is "stop throwing pi-tui's cache away," not a new caching layer.

Decisions: adopt-and-reimplement (matching the [#661]/[#662]/[#674] precedent, and explicitly invited by the PR author); full depth; extract `src/ui/transcript-content.ts` rather than growing `TranscriptOverlay` to ~590 lines (also chosen with [#695]'s steering request in mind, since it would build on this substrate); and land the width fix as an independent first commit so [#670] is separately attributable and revertable.

Rejected: merging either PR directly, and the "viewport-bound only" option — the latter fixes the frozen-keys symptom but leaves a ~225 ms hitch at every tool completion on the reported session, which is the same complaint with a different trigger.

No follow-up issues filed.
Both Open Questions are deliberately unfiled: the streaming-activity row's ownership is a revisit-if-[#695]-needs-it note, and a width-keyed cache on pi-tui's `Container` is an upstream question worth raising only if a second consumer here needs it.

Note for the implementation session: the two performance pins (`vi.spyOn(Container.prototype, "render")` call counts, and a zero `getMessages` call count across paints and scrolls) are deliberately white-box.
They are the only assertions that can catch a silent return to per-frame rebuilding, and they should stay isolated in their own `describe`.

## Stage: Implementation — TDD (2026-08-10T22:20:21Z)

### Session summary

Landed all six planned TDD steps plus two Tidy-First preparatory commits and one follow-up test commit — nine commits in all.
`/subagents:sessions` now scrolls at the width it renders at, and its paint, scroll, settle, and streaming-delta paths are all O(viewport) rather than O(total transcript).
The `pi-subagents` suite went from 1,135 to 1,175 tests (+40), with a new `TranscriptContent` collaborator (`src/ui/transcript-content.ts`) carrying its own 34-test suite.

### Observations

The Tidy-First assessor earned its keep.
It proposed two small preparatory commits — extracting `mockTui`/`fakeSource` into `test/helpers/transcript-fixtures.ts`, and reshaping `TranscriptRenderOptions` to carry `source: TranscriptSource` instead of a projected `getToolDefinition` callback.
The second in particular turned step 2's extraction into a literal cut-and-paste rather than a move-plus-reshape.
It also corrected the dispatch brief: I had claimed four test helpers would be shared, and it determined only two actually would be, because `TranscriptContentOptions` has no `theme` field.

Measurement caught two tests that were green for the wrong reason and would otherwise have shipped as decoration.
The first: the incremental-settling render-count pins called a `fullRebuildRenderCount` helper that installed a `vi.spyOn` while an outer spy on the same method was still active, so the baseline double-counted and `toBeLessThan` could never discriminate.
Measuring the baseline *before* installing the spy made both tests genuinely red (22 vs 22, 24 vs 24) and then genuinely green.
The second was surfaced by the pre-completion reviewer and is the more interesting one — see below.

The reviewer's one substantive WARN was correct and worth acting on.
The hoisted `hasVisibleContent` flag (the leading-spacer decision that used to read `container.children.length`) was, per the plan, supposedly pinned by the incremental-vs-fresh equivalence test.
It was not: both sides of that comparison run the same `consumeMessage` path, so the test pins self-consistency, not correctness.
The fix was an arithmetic assertion instead — a user message following other content costs exactly one extra row — asserted both in a single build and across a batch boundary.
Both were then verified non-vacuous by forcing the flag to `false` and confirming both fail.
The lesson generalizes: an A-vs-B equivalence test where A and B share the code under test proves nothing about that code.

Plan deviations, all minor:

- The plan's baseline table predicted 2.8 ms for streaming deltas "after step 3".
  That figure came from PR [#690]'s commit 1, which bundled the live-assistant split that our step 4 does separately, so deltas correctly stayed at ~45 ms after step 3 and dropped to 0.45 ms after step 4.
  Final measurements otherwise matched the plan's prediction closely — scroll 0.50 ms (predicted 0.46), settle 0.79 ms (0.81), delta 0.45 ms (0.42), against a `main` baseline of 90.5 / 44.7 / 44.0 ms.
- Two files beyond the plan's Module-Level Changes table: `test/helpers/transcript-fixtures.ts` and its test, both from the Tidy-First step.
- Step 2 exposed a transitional `lines(width)` accessor rather than the plan's final `lineCount`/`slice` pair, so the pure-move step neither regressed performance nor smuggled in the caching that step 3 was supposed to introduce.
  Step 3 replaced it.
- The plan's Test Impact Analysis said the skill-block spacing cases would "move" from the overlay suite; the reviewer noted no such test existed there, so it is new rather than relocated.

Two simplifications over PR [#690] survived implementation, both grounded in the planning session's read of Pi's source.
The `isLiveMessage`/timestamp-matching guard is absent, because a partial assistant message is never in `state.messages`.
And `message_end` clears the in-flight component unconditionally rather than matching it, because an assistant message always settles before its tool calls execute, so nothing is ever in flight at another role's `message_end`.

Pre-completion reviewer: WARN (no FAILs).
The one substantive finding — the `hasVisibleContent` equivalence-test gap — was fixed in `52e535b8` before shipping.
The reviewer's other finding was a historical-accuracy nit in the plan document itself, left as-is.

## Stage: Final Retrospective (2026-08-10T23:01:22Z)

### Session summary

Planned, implemented, and shipped the `/subagents:sessions` performance fix in a single continuous session: nine commits, `pi-subagents` 19.2.2 released, issue #689 closed, and the two superseded third-party PRs ([#690], [#670]) closed with credit.
The overlay's paint, scroll, settle, and streaming-delta paths went from O(total transcript) to O(viewport) — measured 90.5 → 0.50 ms per scroll and 44.7 → 0.79 ms per settle on a 200-message fixture.
The defining characteristic of the session was that every consequential claim was measured rather than argued, including two tests that turned out to be measuring nothing.

### Observations

#### What went well

- Measuring **both sides** before the `ask_user` gate turned a preference question into an evidence question.
  Applying [#690]'s two commits to a scratch tree and re-running the same fixture produced the after-column directly, so the plan's table compared like with like instead of quoting the PR's numbers.
  This also caught that the PR's own "after commit 1" delta figure did not transfer to our step boundaries — a discrepancy that would have been invisible without re-measuring.
- Two independent false-green tests were caught **before** shipping, by two different mechanisms.
  The `fullRebuildRenderCount` helper nested a `vi.spyOn` inside an active spy on the same method, inflating the baseline so `toBeLessThan` could never discriminate; noticing that the new tests passed on the first run — when they were supposed to be red — exposed it.
  The `hasVisibleContent` equivalence gap was caught by the `pre-completion-reviewer`, and is the subtler of the two: an incremental-vs-freshly-built comparison cannot pin the code both of its sides run.
- The `tidy-first-assessor` did more than propose tidying — it **corrected the dispatch brief**.
  I asserted four test helpers would be shared post-split; it determined only two would be, because `TranscriptContentOptions` carries no `theme` field.
  Its second proposal (reshaping `TranscriptRenderOptions` to hold `source` rather than a projected `getToolDefinition` callback) turned the extraction commit into a literal cut-and-paste.
- Reading Pi's own source at `../pi` rather than reasoning from the PR body produced two simplifications the PR does not have, and closed a risk the PR never addresses (in-place `message_end` replacement is applied before session listeners are notified).

#### What caused friction (agent side)

- `instruction-violation` (self-identified late) — recovering the corrupted retro file, I rebuilt it with a shell heredoc (`cat > /tmp/retro-tail.md <<'MARKER'` plus `cat` concatenation and a `python3` repair).
  `AGENTS.md`, the `markdown-conventions` skill, and the `/tdd-plan` prompt all say to append retro files with `Edit`/`Write`, never a heredoc; `Write` with the full content was the correct recovery and is named in the prompt.
  Impact: 4 extra tool calls; no rework, and `rumdl` happened to pass — but the rule exists precisely because heredocs make one-sentence-per-line and escape slips easy, so this was luck rather than safety.
  The rule is already stated in three places, so the gap is adherence, not documentation.
- `other` (tool misuse) — the first `Edit` appending the TDD stage notes emitted a `newText` that terminated mid-sentence (`installed a \`vi.spyOn(Container.prototype, `), and the autoformatter then joined the fragment to the following `[#661]:` link-reference definition, corrupting it into a bare autolink.
  Impact: file corruption requiring a 4-call repair, and it is what prompted the heredoc violation above.
- `other` (stale measurement) — the scratch benchmark wrote to a fixed `/tmp/perf.json`.
  Trying to restore it after step 5 via `git show <commit>^:<path>` produced an empty file (it had never been committed), the run silently no-opped, and I read and reported the **step-3** numbers as if they were final.
  Impact: one wrong measurement stated mid-session, self-caught within 2 tool calls by noticing the numbers were identical to the earlier run; recreating the benchmark properly cost ~3 more calls.
  A fixed output path plus a run that can no-op is a false-freshness trap.
- `other` (scratch-file churn) — the same disposable benchmark was written, run, and deleted four times across planning and implementation (`scratch-perf.test.ts` ×3, `scratch-scale.test.ts`, plus a `/tmp/dbg.test.ts` copied into `test/ui/`).
  Impact: no rework, but it is the mechanism behind the stale-measurement error above.
- `missing-context` (user-caught) — Step 10's next-issue recommendation consulted only the architecture roadmap.
  The roadmap had no successor (#689 was a standalone third-party bug, and Phase 21 is complete), so I fell back to a raw `gh issue list` scan and ranked by judgment, never opening `docs/triage/2026-08-05-backlog.md`.
  That document ranks the shipped issue at 4 and still has #694 (rank 2, security) and #696/#697 (rank 3, crash) open above it — and it lists my actual recommendation, [#695], under **Deferred** with the rationale "they belong in a pi-subagents phase, not this list."
  Impact: recommended work that contradicted a recorded triage decision while two higher-severity items sat open; caught by the operator after the retro commit, costing one follow-up commit.
  The second suggestion (#709) was filed after the triage date and so was genuinely unranked — legitimate to raise, but it should have been labelled un-triaged rather than presented beside a deferred item as equally vetted.

#### What caused friction (user side)

- The operator's redirect at the depth gate was the highest-leverage intervention of the session, and worth naming as a pattern rather than a friction point.
  Rather than picking an option or correcting me, they asked a question — "45 ms isn't bad, but 0.42 ms is pretty impressive.
  Do we need to research Pi itself to answer some questions?"
  That bounced an under-evidenced `ask_user` back for grounding, and the research inverted the risk assessment: the deeper option turned out to be the *safer* one, because it mirrors Pi's own interactive-mode model rather than inventing one.
  A flat answer to the original ask would have shipped the shallower fix.
- PR [#690] was supplied as a follow-up message after `/plan-issue` had already begun.
  Impact: negligible directly (~2 tool calls), but it exposed a real prompt gap — `/plan-issue` sweeps sibling **issues** and not sibling **PRs**, so the operator had to supply what the prompt should have found.
  [#670] was found only because I ran `gh pr list --state open` on my own initiative.
- The operator caught the retro's own next-step recommendation being wrong, after the retro had already been committed.
  Impact: one follow-up commit; see the `instruction-violation` below, which this prompted.

### Diagnostic details

- **Model-performance correlation** — planning and implementation ran on `anthropic/claude-opus-5`; the ship stage ran on `anthropic/claude-sonnet-5`; the retro on `anthropic/claude-opus-5`.
  All three subagents ran on `anthropic/claude-sonnet-5`: the `Explore` dispatch tracing Pi's agent core (explicitly requested per the `AGENTS.md` rule that Haiku is too weak for a multi-hop trace there), plus `tidy-first-assessor` and `pre-completion-reviewer` via their frontmatter defaults.
  No mismatches: the judgment-heavy work (design decisions, the reviewer's WARN) landed on reasoning-capable models, and the mechanical ship sequence on the cheaper one without incident.
- **Escalation-delay tracking** — no sequence exceeded 5 consecutive tool calls on the same error.
  The longest was the retro-file corruption repair at 4 calls, and the stale-measurement diagnosis at 2.
  No dispatch or escalation was warranted.
- **Unused-tool detection** — `colgrep` was never invoked this session.
  Justified: every search was exact-symbol (`TranscriptOverlay`, `buildContentLines`, `subscribeToUpdates`, `parseSkillBlock`), which the `colgrep` skill's own decision table assigns to `grep`.
  No missed dispatch opportunity found for any friction point.
- **Feedback-loop gap analysis** — no gap.
  `pnpm run check` and the affected test file ran after every Red and every Green; the full suite, root `lint`, and `fallow dead-code` ran after each of the six TDD steps and again before the pre-completion dispatch.
  The green baseline was established with all four gates before the first change, which is what made the two false-green tests legible as anomalies rather than noise.

### Changes made

1. `.pi/prompts/plan-issue.md` — step 4 now sweeps open PRs (`gh pr list --state open`) alongside the existing sibling-issue sweep, since a third-party PR on the same module often carries a diagnosis the issue omits and becomes a close target at ship time.
2. `.pi/prompts/ship-issue.md` — step 5 now covers an issue that **supersedes** open third-party PRs, distinct from the existing case where the adopted PR is itself the close target.
3. `.pi/skills/testing/SKILL.md` — added an assertion rule under § Test assertions: an equivalence test pins self-consistency, not correctness, when both sides run the code under test.
4. `.pi/prompts/retro.md` — Step 10 now falls back to the newest `docs/triage/*.md` when the roadmap has no successor, re-checks ranked items with `gh`, and treats a triage **Deferred** entry as disqualifying rather than as a candidate.
   Landed after the first retro commit, prompted by the operator catching this retro's own recommendation contradicting the 2026-08-05 triage.

Not landed, considered and declined:

- A fourth statement of the "no shell heredoc for retro files" rule — it is already in `AGENTS.md`, the `markdown-conventions` skill, and the `/tdd-plan` prompt; the gap here was adherence, not documentation.
- A rule about stale output from a disposable measurement script writing to a fixed path — real but self-caught in two tool calls, and judged too situational to earn permanent space.
- A rule derived from the `Edit` truncation — no reliable account of the cause, and a rule built on a guess is worse than none.

[#661]: https://github.com/gotgenes/pi-packages/issues/661
[#662]: https://github.com/gotgenes/pi-packages/issues/662
[#670]: https://github.com/gotgenes/pi-packages/issues/670
[#674]: https://github.com/gotgenes/pi-packages/issues/674
[#690]: https://github.com/gotgenes/pi-packages/issues/690
[#695]: https://github.com/gotgenes/pi-packages/issues/695

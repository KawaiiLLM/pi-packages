---
issue: 661
issue_title: "fix(pi-subagents): hold completion nudges while the parent agent streams"
pr: 661
---

# Retro: #661 — Hold completion nudges while the parent agent streams

## Stage: PR Review (2026-07-27T01:02:42Z)

### Session summary

Third-party PR #661 (from `@daoguademeng`, references no issue) reports that a background agent's completion nudge can be delivered twice — once as the result the parent pulls mid-turn, and again verbatim when Pi drains its `followUp` queue at turn end.
The defect was confirmed real on current `main` by reproduction, and the PR's fix works, but it layers a second hold mechanism on top of the existing 200 ms debounce and gates on `agent_end`, which fires once per agent-run *segment* rather than once per run.
The operator chose to adopt the capability with our own simplified design: gate on `agent_settled` and collapse the two hold mechanisms into one.

### Evaluation

Verify gate — the defect is real and correctly diagnosed.
A scratch test driving `NotificationManager` through a double that mirrors Pi's verified `sendCustomMessage` semantics failed on current `main`: the `<task-notification>` was delivered even though `record.markConsumed()` ran before turn end.
The same test passes on the PR branch.
A control case (nudge fired while the parent is idle) delivers exactly once on both, so the patch does not degrade the path that is already correct.

The mechanism matches Pi's source rather than the PR's narrative alone.
`AgentSession.sendCustomMessage` routes to `this.agent.followUp(appMessage)` whenever `isStreaming` is true (`agent-session.ts:1443-1450`), and that queue is drained by the agent loop at turn end (`agent-session.ts:1100-1102`).
Once handed off, the extension cannot recall it — so the existing schedule-time and fire-time `record.consumed` guards in `emitIndividualNudge` cannot cover the fire→turn-end window.
The archaeology shows no earlier fix being re-added: `NUDGE_HOLD_MS` dates to `1a2e3220` and the consumption guard to `0cedaad5` (#617), and neither addresses this window.

Checks were run in a scratch worktree rather than trusted from the PR body: `pnpm run check`, `pnpm run lint`, and the `@gotgenes/pi-subagents` suite all exited `0`.
The diff does ship five tests.

Two findings constrain any re-implementation and should not be re-litigated during planning.
Flushing from inside an `agent_end` handler is safe by design — `_handlePostAgentRun` re-checks `this.agent.hasQueuedMessages()` after the awaited extension handlers and runs a continuation (`agent-session.ts:1100-1102`), so a flushed nudge is never lost.
And the PR's `parentStreaming` mirror flag is *justified*, not redundant state: `isIdle()` is exposed on `ExtensionContext` / `ExtensionContextActions`, **not** on `ExtensionAPI` (`extensions/types.ts:324`, `:1616`), so the extension cannot query streaming state from inside a `setTimeout`.
Per the `code-design` rule about confirming an SDK method on the exact type the code holds, `pi.isIdle()` is not an available simplification.

What to change, and why.
The boundary is wrong: `agent_end` fires once per agent-run segment, and a single `_runAgentPrompt` emits several across auto-retry, auto-compaction, and `followUp` continuations, so a held nudge can be flushed between a failed attempt and its retry.
`agent_settled` fires exactly once per run and sets `_isAgentRunActive = false` *before* emitting to extensions (`agent-session.ts:581-582`), so a flush there takes the clean idle `triggerTurn` → `_runAgentPrompt` path instead of re-entering the unrecallable queue.
The structure is also over-built: the PR adds `heldNudges` alongside the existing `pendingNudges` timer map plus a `parentStreaming` flag, leaving two queues and three `record.consumed` checks (schedule-time, fire-time, flush-time).
Once delivery is gated on the turn boundary, the 200 ms `NUDGE_HOLD_MS` debounce is largely vestigial — an idle parent cannot pull at all, since pulling requires a tool call, which requires a turn, which means streaming.

Test coverage is the weakest part of the diff.
The test named as the bug repro (`suppresses a held nudge when the record is consumed before agent end`) fails on `main` only because `onParentAgentStart` does not exist there — a `TypeError`, not an observed duplicate.
None of the five new tests model Pi's `followUp` queue, so none actually demonstrate the duplicate being fixed.
The re-implementation should pin the regression with a Pi-semantics test double at the real boundary, as the scratch repro did.

This is not a breaking change: it suppresses a redundant message and a redundant forced turn, with no change to output shape or defaults, so `fix:` is the correct type.

### Decision and attribution

Direction: adopt the capability, plan a simplified design — PR #661 is reference material, not the merge target.

Agreed scope:

1. Gate the flush on `agent_settled` (once per agent run), not `agent_end` (once per run segment).
2. Collapse the two hold mechanisms into a single pending-nudge collection flushed at the turn boundary, retiring the now-redundant `NUDGE_HOLD_MS` debounce and the third `consumed` check.
3. Cover the regression with a test double that models Pi's `followUp` queue semantics, so the test fails on `main` for the right reason.

Non-goals: no change to nudge content or rendering, no change to `deliverAs` for the idle path, and no rework of the consumption domain state landed in #617.

Attribution: every implementation and docs commit carries the trailer below, separated from the body by a blank line.

```text
Co-authored-by: daoguademeng <whumaple@gmail.com>
```

The close comment on PR #661 thanks `@daoguademeng` by name, links the implementing SHA(s), and credits the diagnosis — the fire→turn-end window was correctly identified and is a genuine defect.
Reference the PR as `Refs #661` in commits; never `Closes #661`.

## Stage: Planning (2026-07-27T01:10:40Z)

### Session summary

Wrote `docs/plans/0661-hold-completion-nudges-while-parent-streams.md` around the direction settled during PR review, so the `Decide` gate was already satisfied and not re-litigated.
The plan is three TDD steps: gate `NotificationManager` on the parent turn boundary (with the `index.ts` wiring in the same commit), re-arrange the two Bug-1 race tests, then update the architecture module-tree entry and the package skill row.
The central planning work was validating — by spike, not argument — that removing the 200 ms `NUDGE_HOLD_MS` debounce is safe despite two prior docs calling it load-bearing.

### Observations

The spike was the decisive step and is worth repeating in similar situations.
`docs/architecture/history/phase-20-result-delivery.md:60` and retro `0535:42` both credit `NUDGE_HOLD_MS` as load-bearing for the `consume()`-after-await invariant, with an explicit warning that *decreasing* it narrows correctness.
Rather than reason about that from prose, a scratch worktree implemented the collapsed design and ran the suite: exactly three tests failed, all of which had been using the timer as a stand-in for "a parent turn is in progress".
After arranging the streaming state in those three, the full suite passed 1083/1083 with `check` and `lint` clean.
The invariant strengthens rather than weakens, because the hold window widens from 200 ms to the remainder of the parent's agent run.

The argument that makes the debounce removable is grep-verifiable, not theoretical: all three `markConsumed()` call sites (`get-result-tool.ts:44`, `foreground-runner.ts:114`, `agent-tool.ts:109`) execute inside tool handlers, which only run inside an agent run.
So no consumer can race a nudge on the idle path, and the idle path needs no debounce.

`pnpm fallow dead-code` against the spike flagged `onParentAgentSettled` as an unused class member until `index.ts` registers the handler.
That forced a plan-shaping decision: the method and its wiring must land in one commit, which is why step 1 is deliberately larger than a pure red/green split would suggest.

Two design choices were rejected.
Putting the lifecycle hooks on the `NotificationSystem` interface was rejected on ISP grounds — `SubagentEventsObserver` calls only `sendCompletion`, and `index.ts` already holds the concrete `NotificationManager`, so the interface does not need to widen.
Replacing `parentStreaming` with a direct `pi.isIdle()` query was rejected after checking the exact type the code holds: `isIdle()` is on `ExtensionContext`, not `ExtensionAPI`.
That is recorded in Open Questions as the cleanup to make if Pi ever surfaces it on `ExtensionAPI`.

No follow-up issues were filed — the plan names no concrete deferred work, and #636 (compact `get_subagent_result` rendering) already exists and is unrelated to delivery timing.

## Stage: Implementation — TDD (2026-07-27T01:41:09Z)

### Session summary

Implemented the turn-boundary nudge gating in three commits: the behavior change (`8f7f387d`), the doc updates (`f514ad86`), and a lint fixup (`795b9370`).
`NotificationManager` now withholds nudges arriving while the parent's agent run is active and flushes them on `agent_settled` with a fresh consumption re-check; the 200 ms `NUDGE_HOLD_MS` debounce, `scheduleNudge`, and `cancelNudge` are gone.
The `pi-subagents` suite went from 1083 to 1087 tests (six new turn-boundary tests, three pre-existing timer-based tests re-arranged, one renamed).

### Observations

The session's defining event was a planning error caught at the type checker.
The plan chose `agent_settled` over `agent_end` by reading the sibling Pi checkout at `../pi`, which sits at 0.82.1 — but the package pinned SDK `0.79.1`, where `agent_settled` does not exist.
This is precisely the failure mode AGENTS.md warns about when reading the sibling checkout instead of the installed `dist/`, and the planning stage did not check the pinned version before committing to the design.
A useful rule for future plans: when a design depends on a specific SDK event, method, or type, verify it against the **installed** `node_modules` version, not the sibling checkout, before writing it into the plan.

The operator chose to raise the peer floor and take the break rather than fall back to `agent_end`.
Establishing the correct floor turned up a second trap: `agent_settled` was added in Pi `0.80.4`, but `0.80.4` was git-tagged and **never published to npm** — the registry jumps `0.80.3` → `0.80.5`.
A `>=0.80.4` floor would have named an uninstallable version in a `BREAKING CHANGE:` remediation, so the floor is `>=0.80.5`.
The first attempt at the dev pin also failed: the three `@earendil-works/*` packages version independently, and `pi-ai@0.80.4` does not exist at all.

The plan's split of TDD steps 1 and 2 did not survive contact.
The `notification.ts` rework leaves `subagent-manager.test.ts`'s after-await race test red until that test arranges the streaming state, so committing step 1 alone would have left the repository red.
Both landed in one commit with the deviation recorded in the body.

The planning spike paid for itself.
It had predicted exactly three failing tests from removing the debounce, and exactly those three failed — so the only surprise in the implementation was the SDK version, not the design.
The plan's mutation check also proved worthwhile: reverting just the `parentRunActive` branch fails four tests including the `#661` regression, confirming the tests pin behavior rather than passing vacuously.

Pre-completion reviewer: PASS.
It independently re-verified the `0.80.4`-never-published finding and the ancestry of the introducing commit, and raised one non-blocking warning — an unused `afterEach` import left by the removed fake-timer hooks.
On inspection `beforeEach` was dead too (the remaining `vi.useFakeTimers()` calls are inline inside an `it`), and both were removed in `795b9370`.
Because the most recent commit was a `docs:` one, which must not absorb a fixup, it landed as a separate `style:` commit.

PR #661 remains open and unmerged; every commit carries the `Co-authored-by` trailer, and the ship stage owes `@daoguademeng` a close comment crediting the diagnosis.

## Stage: Final Retrospective (2026-07-27T13:20:46Z)

### Session summary

One continuous session carried a third-party PR from triage through release: PR review, planning, TDD implementation, and ship, landing `@gotgenes/pi-subagents@19.0.0`.
The capability was adopted with an independent, simpler design rather than merging the contributor's diff, and PR #661 was closed with credit rather than merged.
The defining friction was a planning-stage design decision made against the wrong SDK version, which surfaced only at the type checker and escalated the change into a breaking peer-floor bump.

### Observations

#### What went well

The planning spike is the pattern most worth repeating.
Two prior docs called `NUDGE_HOLD_MS` "load-bearing", which is exactly the kind of prose that stops a change on reputation alone.
Spiking the removal in a scratch worktree predicted precisely three failing tests, and precisely those three failed during implementation — converting an argument into a measurement and leaving the SDK version as the session's only real surprise.

The verify-then-evaluate ordering in `/review-third-party-pr` earned its place.
Reproducing the defect on `main` *before* reading the diff for design meant the whole review rested on a measurement rather than the PR's narrative, and it exposed that the contributor's own "bug repro" test failed on `main` only as a `TypeError` — a detail that directly shaped the re-implementation's test strategy.

The `Explore`-on-`sonnet-5` guidance for Pi-internals traces (AGENTS.md line 62) worked as designed: 35 tool calls and 162 s of subagent budget returned exact `file:line` citations for the `followUp` queue semantics without spending this session's context.
The `scripts/bin` `npm` shim also did its job, catching an `npm view` slip and pointing at AGENTS.md.

#### What caused friction (agent side)

1. `missing-context` — the plan chose the `agent_settled` event after reading the sibling checkout `../pi` (0.82.1) without checking that the package pins SDK `0.79.1`, where the event does not exist.
   Caught only by `tsc` after the source change was already written.
   Impact: the largest cost of the session — an `ask_user` re-decision mid-implementation, a scope escalation from a non-breaking `fix:` to a breaking `fix!:` with a peer-floor raise, plus two follow-on version traps (`0.80.4` was git-tagged but never published to npm, and `pi-ai@0.80.4` does not exist at all, since the three `@earendil-works/*` packages version independently).
   The prior stage note misattributed this to ignoring AGENTS.md; that is wrong, and the correction matters.
   AGENTS.md line 61 actively *directs* reading the sibling checkout over the installed `dist/`.
   The gap is that the rule is silent on version skew — the checkout is fine for mechanism and misleading for API availability.

2. `instruction-violation` (self-identified, at retro) — the `/tdd-plan` prompt's Tidy First step and the `tidy-first` skill were both skipped outright.
   The plan modifies `src/` and `test/` files, so the skill's applicability gate plainly applied; the `testing` skill named in the same prompt was also never loaded.
   Impact: no rework — the change was small and the design already settled — but a mandated review step was silently dropped, which is exactly the failure the bracketing subagents exist to prevent.

3. `instruction-violation` (user-caught in effect — the tooling caught it) — ran `npm view` twice despite AGENTS.md's "pnpm exclusively, never `npm` or `npx`".
   Impact: one wasted tool call; the shim redirected immediately, no rework.

4. `other` — ran `gh issue close 661 --comment "test dry"` intending to probe whether the command accepts a PR number.
   It is not a dry-run command; it closed the contributor's PR and posted a junk comment to a public, third-party-facing thread.
   Impact: recovered within one turn by leaving the closed state (correct outcome anyway) and posting the real credit comment, but the `test dry` comment remains in the thread visible to `@daoguademeng`.
   The underlying error is probing a state-mutating command by executing it.

5. `missing-context` — locating the installed SDK types took roughly five consecutive failing calls (a zsh glob that found no matches, two `node -p` module-not-found errors, a failed `pnpm exec` resolve) before `ls` plus `find` succeeded.
   Root cause: assuming a flat `node_modules/@scope/pkg` layout instead of pnpm's `.pnpm/` store with per-package symlinks.
   Impact: added friction, no rework.

#### What caused friction (user side)

The SDK-version trap was structurally invisible to the operator too — the plan read as well-evidenced (it cited real `file:line` references), and nothing in it signalled that the citations came from a version the package does not install.
A planning-stage habit of naming the *version* alongside an SDK citation would have made the skew reviewable rather than latent.

The mid-implementation `ask_user` on the peer-floor decision worked well: it arrived with the concrete before/after table and a measured fallback already verified against the pinned version, so the operator could decide in one round trip rather than requesting analysis.

### Diagnostic details

- Model-performance correlation — three effective model switches (`opus-5` → `sonnet-5` → `opus-5`) across the stages.
  Both subagents ran on `sonnet-5`: the `Explore` Pi-internals trace (explicitly per AGENTS.md guidance) and the `pre-completion-reviewer` (its frontmatter default).
  Both were appropriate to judgment-heavy work; no mismatch to flag, and the reviewer independently re-verified the npm publication gap rather than trusting the commit message.
- Escalation-delay tracking — the installed-SDK hunt (friction 5) ran about five consecutive failing calls on the same goal, at the flagging threshold.
  No subagent was warranted; the fix was knowing pnpm's store layout.
- Unused-tool detection — for friction 1, no subagent would have helped.
  Reading `packages/pi-subagents/package.json` `devDependencies` during planning, a single cheap call, would have caught it outright.
- Feedback-loop gap analysis — no gap.
  A green baseline ran before any edit, `vitest` ran per-file at each red and green, and `pnpm run check` ran immediately after the source-plus-wiring change — which is precisely what surfaced the SDK gap before it reached a commit, as `/tdd-plan` prescribes for interface changes.
  The plan's mandated mutation check (revert the gate, confirm four tests fail) added a verification most cycles skip.

### Changes made

1. `AGENTS.md` — added a version-skew caveat to the sibling-checkout rule: the `../pi` checkout runs ahead of the pinned dependency, so an API must be confirmed against the installed version before a design is built on it.
2. `AGENTS.md` — added a Workflow rule against running a state-mutating command (`gh issue close`, `gh pr merge`, `git push`) to discover its behavior, directing read-only probes instead.
3. `.pi/prompts/ship-issue.md` — added the third-party-PR close case to step 5, covering the gap where `/review-third-party-pr` hands off into `/ship-issue` with a PR number rather than an issue number.
4. PR #661 — deleted the stray `test dry` comment (id `5086492506`), leaving only the credit comment on the contributor-facing thread.

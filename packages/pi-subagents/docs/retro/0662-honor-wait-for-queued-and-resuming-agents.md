---
issue: 662
issue_title: "fix(pi-subagents): honor wait:true for queued agents and in-flight resumes"
pr: 662
---

# Retro: #662 — honor `wait:true` for queued agents and in-flight resumes

## Stage: PR Review (2026-07-27T14:25:08Z)

### Session summary

Third-party PR #662 from `@daoguademeng` fixes `get_subagent_result`'s `wait` path, which only awaited `status === "running"` and therefore returned a stale report for a queued agent and for an agent whose `resume()` was still in flight.
Both defects were reproduced on current `main` before the diff was evaluated.
The operator chose to adopt the capability with our own simplified design: include both fixes, and close the ignored-`AbortSignal` gap in the same change rather than deferring it.

### Evaluation

Verify gate — both defects reproduce on current `main`.
The PR branch was checked out in a scratch worktree and the full gate ran green there (`pnpm run check`, `pnpm run lint`, 1085/1085 `pi-subagents` tests).
Reverting only `src/lifecycle/subagent.ts` and `src/tools/get-result-tool.ts` to `origin/main` and re-running the two touched test files fails both new tests: the queued case returns `Status: queued` with no result, and `agent.promise` settles immediately during an in-flight resume.
The PR base `104339af` is 28 commits behind `main`, but `git log 104339af..origin/main` over the four touched files is empty, so the branch result is representative of `main`.

Defect 1 — `src/tools/get-result-tool.ts:36` — is real, high-value, and the fix is this repo's own documented idiom.
`SubagentManager.pendingPromises()` (`src/lifecycle/subagent-manager.ts:344`) already selects awaitable records with `filter(r => r.isActive()).map(r => r.promise)`, and `GetResultTool.execute` was the lone remaining site hand-rolling `status === "running"` — the exact scattered-decision smell the `code-design` skill names, down to the literal example.
It also repairs a second-order bug: because the queued record stayed `isActive()`, the `markConsumed()` branch below never ran, so the completion nudge fired redundantly after the parent had already collected the outcome.

Defect 2 — `Subagent.resume()` in `src/lifecycle/subagent.ts` — is real but nearly unreachable today.
The only caller is `src/tools/agent-tool.ts:100`, which awaits the resume synchronously and returns the result inline, and `src/service/service.ts` exposes no resume on the cross-extension surface.
Reaching it requires the model to issue `Agent(resume=…)` and `get_subagent_result(wait=true)` against the same agent as parallel tool calls.
The PR's fix is nonetheless sound and structurally forced — `_promise` cannot be assigned from inside an `async` body, so extracting `runResume` is the only way to publish the live handle — and it mirrors the existing `start()` and `scheduleVia()` shape.

What we would change relative to the PR.
Widening the wait from "running" to "everything queued ahead of it" can block the parent for the full queue depth (`maxConcurrent` defaults to 4), and `GetResultTool.execute` ignores its own `_signal: AbortSignal`; today the only escape is ESC's global abort-all (Issue #664), which resolves queued promises via `ConcurrencyLimiter.clear()` but is a blunt instrument.
`resume()` should drop `async` and return the tracked promise directly rather than paying a redundant wrapper tick.
The new subagent test introduces `await new Promise((r) => setTimeout(r, 0))`, the first `setTimeout` in the package's 64 test files — asserting promise identity against the pre-resume handle, or awaiting a microtask, is deterministic and in-convention.
The change is a fix toward the tool's own documented `wait` contract, so it is `fix:`, not `fix!:`.

### Decision and attribution

Direction: adopt the capability, plan a simplified design.
The PR is reference material, not the merge target.

Scope: both defects are in scope — the queued-agent guard and the `resume()` promise-refresh invariant — plus honoring `GetResultTool.execute`'s `AbortSignal` so an interrupt returns a partial report instead of depending on ESC's abort-all.
Non-goals: no change to `ConcurrencyLimiter`, no new background-resume path, no change to the notification or nudge layer beyond what falls out of the queued record now reaching `markConsumed()`.

Attribution: every implementation and docs commit for this work carries the trailer below, and the PR close comment thanks `@daoguademeng` by name and links the implementing SHAs.
Reference the PR as `Refs #662` — never `Closes #662`.

```text
Co-authored-by: daoguademeng <whumaple@gmail.com>
```

## Stage: Planning (2026-07-27T14:42:30Z)

### Session summary

Wrote `docs/plans/0662-honor-wait-for-queued-and-resuming-agents.md`, a seven-cycle TDD plan covering the queued-agent wait, the ignored `AbortSignal`, and the stale `promise` getter across a resume.
The PR-review stage had already run the direction gate, so this session planned around the recorded decision rather than re-litigating it.
The plan ships independently — Issue #662 is not a step in the Phase 15–21 roadmap, so it carries no `Release: batch` tag.

### Observations

The central design call was where the wait decision lives.
The PR patched the guard in place (`record.status === "running"` → `record.isActive()`), which fixes the defect but leaves `GetResultTool` asking the record three questions before acting — the Law-of-Demeter case in the `design-review` checklist.
The plan instead adds `Subagent.waitUntilSettled(signal?)` so the record owns "am I still awaitable, and what is my handle", and the call site collapses to one tell.
This also lands the `code-design` OCP heuristic: the discriminator sweep drops `status === "running"` from 2 production sites to 1, and the survivor (`get-result-report.ts:45`) is per-status presentation dispatch that the Non-Goals deliberately keep.

Interrupt semantics were the other real decision.
Ending the wait must **not** abort the agent — `get_subagent_result` is a query, and the agent-killing reading of ESC already lives in `InterruptHandler` (Issue #664).
Today ESC ends a wait twice over (the signal race and `abortAll()`), so the race looks redundant; it stops being redundant the moment #664 makes abort-all opt-out, which is the argument for landing it here instead of deferring.
The listener-cleanup channel uses an inner `AbortController` with the `{ signal }` listener option rather than the returned-closure shape of `RunListeners.wireSignal` and `forwardAbortSignal`.

Two sequencing traps are pinned in the TDD order.
Making `resume()` non-`async` would convert its precondition rejection into a synchronous throw that escapes `.rejects.toThrow()`, so the plan lands a rejection test before the conversion and specifies `Promise.reject` over `throw`.
And the new tests must not copy the PR's `await new Promise((r) => setTimeout(r, 0))` — that would be the first `setTimeout` across the package's 64 test files; promise identity or a microtask tick is deterministic and in-convention.

No follow-up issues were filed.
Both Open Questions (signalling a cut-short wait in the report; a per-call `timeout`) are speculative and entangled with Issues #636 and #664, which already exist.

## Stage: Implementation — TDD (2026-07-27T15:23:18Z)

### Session summary

Landed the three behavior fixes in three `fix:` commits plus three docs commits: `Subagent.waitUntilSettled()` for queued agents, the `AbortSignal` interrupt exit, and the republished `promise` getter across a resume.
The `pi-subagents` suite went from 1087 to 1095 tests (+8), with `check`, root `lint`, `fallow dead-code`, and all 5 architecture Mermaid diagrams green.
The pre-completion reviewer returned **PASS**; its one non-blocking WARN was fixed before stopping.

### Observations

The Tidy-First assessor (dispatched on `claude-opus-5` per the skill's model checkpoint) recommended no preparatory commits, but its reconnaissance changed the plan twice.
It found an existing `describe("Subagent.scheduleVia() — eager promise capture")` block already using `Promise.withResolvers` gating — the exact timer-free idiom the new tests needed, confirming the plan's warning against the PR's `setTimeout(0)`.
It also found that `"throws when no session exists"` already pins the resume precondition with `.rejects.toThrow(/missing session/)`, so the plan's step-5 rejection test was unnecessary — the existing test served as the guard across the `async`→synchronous conversion.
Because Opus also reported no preparatory tidying, the skill's self-deleting model checkpoint was satisfied and removed (`da812270`, Refs #635).

Five deviations from the plan, all accepted by the reviewer:

1. Each Red was folded into its Green commit (3 `fix:` commits, not 6).
   A committed red test leaves `main` failing, and the template calls test-only commits "rare; usually folded into the feat" — which matches #661's own history.
   Red was verified in-session before each Green.
2. `waitUntilSettled(signal)` takes a **required** signal, not the planned `signal?`.
   The single caller always has one, and optional would have added a `if (!signal)` branch plus an unexercised no-signal path.
3. The planned rejection test was replaced by the pre-existing one (above).
4. A second resume test ("keeps a waiter blocked until the resume finishes") was written, found to **pass on unfixed `main`**, and deleted rather than shipped as a false-green.
   The resume settles in the same tick that the test resolves it, so the observation microtask never runs while the stale handle is still observable; no timer-free construction distinguishes the two.
   The surviving `expect(agent.promise).toBe(returned)` identity assertion is the stronger guard — it is synchronous and has no timing sensitivity at all.
5. `da812270` (the skill-checkpoint removal) is scope creep relative to the plan, landed separately, referencing #635 and deliberately carrying no `#662` co-author trailer.

The near-miss worth remembering is deviation 4.
The test looked like a proper integration pin — it asserted the status a waiter observes, which is exactly the bug's symptom — and it was only caught because the Red step was run against unfixed source before implementing.
Had Red and Green been written together, it would have shipped green and pinned nothing.

`new Promise<void>(...)` did not trip `@typescript-eslint/no-invalid-void-type` (unlike `Promise.withResolvers<void>()` in `concurrency-limiter.ts`), so no `eslint-disable` was added — the plan's instruction not to add one preemptively paid off.

Pre-completion reviewer: **PASS**.
One WARN — `architecture.md`'s `Subagent` class diagram omitted `waitUntilSettled` — fixed in `5475ca28`, since the diagram already lists the sibling `run`/`resume`/`abort`/`steer` family and the omission read as inconsistency rather than terseness.
All 5 diagrams re-verified with `mmdc` after the edit.

## Stage: User Note (2026-07-27T15:43:52Z)

Repeatedly hitting `sleep` in the ship stage's `release_pr_merge` retry loop for this issue (the release-please PR came back `UNSTABLE` with a genuinely `IN_PROGRESS` `check` run, not the empty-rollup `GITHUB_TOKEN` case, so `/ship-issue`'s runbook correctly polled rather than falling back to `gh pr merge`).
The user flagged this as a recurring friction: is a fixed `sleep 60` the right accommodation, or does the workflow need to change?

What we're accommodating: a release-please PR opened immediately after the shipped commit's own CI run completes can still have its *own* `check` run in flight when `/ship-issue` reaches step 6 — the PR is a fresh ref, so GitHub queues a new run for it rather than reusing the just-finished one from `main`.
`release_pr_merge`'s single-shot `UNSTABLE` check can't distinguish "no checks ran" (the documented `GITHUB_TOKEN`-doesn't-trigger-workflows case, safe to `gh pr merge --rebase` past) from "a check is still running" (must wait) without a second `gh pr view --json statusCheckRollup` read — which this session did correctly, but by hand, with an arbitrary `sleep 60`.

A sturdier accommodation would be a small poll loop (e.g. `gh pr checks 672 --watch` or a `statusCheckRollup`-driven loop with short backoff) instead of one fixed sleep — avoids both under-waiting (retrying too soon) and over-waiting (a flat 60s when the check finishes in 10s), and removes the manual re-poll step from the runbook prose into something scriptable.
Worth raising at the next `/retro` for this issue as a candidate `ci_watch`-style helper for the release-please PR's own checks, parallel to the existing `ci_watch` tool for the shipped commit's CI run.

## Stage: Final Retrospective (2026-07-27T15:53:02Z)

### Session summary

A single session carried all four stages for #662 — third-party PR review, planning, TDD implementation, and ship — landing `pi-subagents` `19.0.1` with three `fix:` commits and +8 tests.
The work adopted an external contributor's diagnosis while re-implementing the design, moving the wait decision onto `Subagent.waitUntilSettled()` and closing an `AbortSignal` gap the PR did not address.
Two process frictions surfaced, both in the release/ship tail rather than the engineering: a hand-rolled `sleep 60` around `release_pr_merge`, and a stranded local commit that diverged history.

### Observations

#### What went well

- The red-first discipline caught a **false-green test**, which is the strongest signal in the session.
  The deleted "keeps a waiter blocked until the resume finishes" test asserted the status a waiter observes — exactly the bug's symptom — and looked like a proper integration pin.
  Run against unfixed source it *passed*, because the resume settles in the same tick the test resolves it.
  Written Red-and-Green together it would have shipped as a no-op pin that nobody would ever question.
- The `/review-third-party-pr` verify gate produced binary evidence instead of a judgment call.
  Checking the PR branch out, reverting only `src/lifecycle/subagent.ts` and `src/tools/get-result-tool.ts` to `origin/main`, and re-running the two touched test files turned "is this defect real" into a watched failure.
  A single `git log 104339af..origin/main -- <four files>` returning empty also settled "the PR base is 28 commits behind" as irrelevant — cheap and decisive.
- "No preparatory tidying warranted" was not the same as "no value".
  The `tidy-first-assessor` recommended zero prep commits but its reconnaissance changed two plan steps: it found the existing `describe("Subagent.scheduleVia() — eager promise capture")` block already using `Promise.withResolvers` gating (the timer-free idiom the new tests needed), and found `"throws when no session exists"` already pinning the resume precondition, making the plan's step-5 test redundant.
- The plan's instruction *not* to add an `eslint-disable` preemptively paid off: `new Promise<void>(...)` did not trip `@typescript-eslint/no-invalid-void-type`, unlike `Promise.withResolvers<void>()` in `concurrency-limiter.ts`.

#### What caused friction (agent side)

- `other` (tooling gap) — `release_pr_merge` returned `UNSTABLE` because the release-please PR had its own `check` run still `IN_PROGRESS`, and the recovery was a hand-rolled `sleep 60`.
  Root cause: `mergeReleasePR` in `packages/pi-github-tools/src/lib/release.ts` is single-shot — one `gh pr view`, then error if not `CLEAN`.
  The sibling `watchRelease` in the same file already implements a `pollInterval = 10` loop, so the polling idiom sits ten lines away from the code that needed it.
  Impact: one wasted `release_pr_merge` call and one arbitrary 60s sleep; the user flagged it as recurring across sessions.
- `other` (workflow gap) — `/retro-note` commits but never pushes, and it is designed to interrupt any workflow.
  Invoked here *after* `/ship-issue` had already pushed (step 3), its commit `fe61d301` stranded locally while CI pushed the `last-release-sha` write-back onto the same base.
  Impact: divergent history at the next sync, `/retro`'s gate correctly refused to fast-forward, and a user-authorized `git rebase origin/main` was needed before the retrospective could start.
- `instruction-violation` (self-identified, after the fact) — the `/ship-issue` step-7 report named `fe61d301` as "New HEAD on `main`" when that commit had never been pushed.
  The prompt says to print `git log --oneline -1`, which is local HEAD; nothing in step 7 cross-checks it against the upstream.
  Impact: an inaccurate final report, caught only when `/retro`'s sync gate failed; no rework beyond the rebase.

#### What caused friction (user side)

- Nothing that cost work — the `/retro-note` intervention was well-timed and strategic, questioning whether the `sleep` was the right accommodation rather than just accepting it.
  The one structural observation is that "we **keep** having to sleep" is cross-session knowledge the agent cannot see: each session starts fresh and reads a single issue's retro, so a friction recurring across unrelated issues is invisible until the operator names it.
  That makes the operator the only detector for this class, and argues for landing such observations as prompt/tooling changes rather than retro prose — prose in `0662` will not be read by the next issue's ship stage.

### Diagnostic details

- **Model-performance correlation** — the `tidy-first-assessor` was explicitly overridden to `anthropic/claude-opus-5` (its frontmatter default is `anthropic/claude-sonnet-5`) to satisfy the skill's model checkpoint; appropriate for judgment-heavy design assessment, and the checkpoint was retired afterwards in `da812270`.
  The `pre-completion-reviewer` ran on its default `anthropic/claude-sonnet-5` and returned a substantive PASS with one real WARN (the class-diagram omission), so no capability mismatch was evident on judgment-heavy review.
  On the main thread the ship stage ran on `claude-sonnet-5` — appropriate, as it is mechanical — and this retrospective on `claude-opus-5`.
- **Escalation-delay tracking** — no `rabbit-hole` frictions.
  The longest same-error sequence was three consecutive calls fixing `awk` quoting while extracting Mermaid blocks for `mmdc`, well under the five-call threshold.
- **Unused-tool detection** — nothing missed.
  `colgrep` was never dispatched this session, which was the correct call: every search was for an exact symbol (`isActive`, `_promise`, `scheduleVia`, `forwardAbortSignal`), which the `colgrep` skill's own decision table assigns to `grep`.
- **Feedback-loop gap analysis** — no gap.
  `pnpm run check`, root `pnpm run lint`, and the full package suite ran after each of the three TDD cycles rather than only at the end, and `pnpm fallow dead-code` plus `mmdc` diagram verification ran before the pre-completion dispatch.

### Changes made

1. `.pi/prompts/ship-issue.md` step 6.4 — replaced the vague "re-poll `statusCheckRollup`" instruction with the concrete `gh pr checks <N> --watch --fail-fast`, the command whose absence produced the arbitrary `sleep 60`.
2. `.pi/prompts/ship-issue.md` step 7 — the new-HEAD bullet now requires confirming `git status -sb` shows no unpushed commits before naming it, backstopping the inaccurate report this session produced.
3. `.pi/prompts/retro-note.md` step 4 — added a push when the branch tracks an upstream and was in sync before the note, so an interrupting note cannot strand a commit behind a workflow that already pushed.
4. `.pi/skills/testing/SKILL.md` § Timers and environment — added a line directing observation of not-yet-settled state to promise identity or `Promise.withResolvers` gating, since a `setTimeout(…, 0)` sleep false-greens when the code settles in the same tick.
5. Filed Issue #673 (`release_pr_merge` fails on a still-running check instead of waiting for it) for the tooling fix behind change 1 — beyond retro scope, so it wants its own `/plan-issue`.

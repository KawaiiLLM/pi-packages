---
issue: 709
issue_title: "pi-subagents: child disposal skips session_shutdown and leaks extension-owned processes"
---

# Retro: #709 — pi-subagents: child disposal skips `session_shutdown` and leaks extension-owned processes

## Stage: Planning (2026-08-13T17:55:00Z)

### Session summary

Verified the third-party bug report against the pinned SDK (`@earendil-works/pi-coding-agent@0.80.5`) and confirmed it is accurate: `AgentSession.dispose()` invalidates the extension runner without ever emitting `session_shutdown`, and pi-subagents does not use the `AgentSessionRuntime` path that would emit it.
Ran the `ask_user` direction gate (mandatory for a third-party issue) and got four decisions: fix as proposed, full await chain, bounded timeout, `fix:` with a behavior-change note.
Wrote `packages/pi-subagents/docs/plans/0709-child-session-shutdown-on-dispose.md` — a new `child-shutdown.ts` emitter plus async propagation through `SubagentSession` → `Subagent` → `SubagentManager` → `SessionLifecycleHandler`, in seven TDD steps.

### Observations

- **The fix is available on the public SDK surface.**
  `emitSessionShutdownEvent` is module-private in Pi and not re-exported from the package entry — checked both the installed `dist/` and the sibling `../pi` checkout on `main` — but `AgentSession.hasExtensionHandlers()` and `AgentSession.extensionRunner` are both public, so the three lines can be replicated.
  No deep import, no upstream dependency.
- **The ordering constraint is forced, not stylistic.**
  `AgentSession.dispose()` calls `extensionRunner.invalidate(...)`, and every `ctx` getter calls `assertActive()` and throws once invalidated.
  So a fire-and-forget emit followed by a synchronous `dispose()` would hand every shutdown handler a stale context — which is exactly why the "internal async, sync signatures" option was rejected in the `ask_user` gate.
- **Cross-package check paid off.**
  `pi-permission-system`'s `subagent-registry.ts:41` and `serving-registry.ts:93` already carry comments saying a child's `session_shutdown` must not wipe parent registrations, which is strong evidence the ecosystem anticipated this event firing in children and that the change is safe for the one known consumer.
- **Alternatives rejected.**
  Adopting `AgentSessionRuntime` for children (it emits shutdown for free) was rejected as disproportionate — the runtime also owns session replacement, UI context, and `/new`/`/fork`/`/resume` flows a child never uses.
  Filing a companion upstream Pi issue was offered and declined.
  A configurable `childShutdownTimeoutMs` setting was offered and declined in favor of a module constant.
- **Scope boundary held against [#617].**
  Shutting extensions down at child *completion* rather than *disposal* would release resources sooner but break resume, since retention deliberately outlives the run.
  The plan ties the emit to disposal and lists the completion-time variant as an Open Question with no issue filed.
- **No quantitative baseline was claimed.**
  The reporter's 25-pair / 221 MB figures are their measurement, not one reproduced here (it needs a configured stdio MCP server).
  The plan's verifiable assertion is deterministic and test-level instead: exactly one `session_shutdown` per disposed child, emitted before the runner is invalidated.
- **Lint hazard flagged up front.**
  `eslint.config.js` enables `recommendedTypeCheckedOnly`, so `no-floating-promises` and `no-misused-promises` are live.
  The plan keeps `sweep()` a synchronous function (so the `setInterval` callback still returns `void`) and requires an explicit `void promise.catch(debugLog)` at each fire-and-forget.
- **Three separate session mocks need the new runner stub** — `test/helpers/mock-session.ts`, its local counterpart inside `test/lifecycle/subagent-session.test.ts`, and (transitively, via a spread) `test/helpers/subagent-session-io.ts`.
  Step 2 of the TDD order lands that helper prep on its own so the type-forced steps that follow stay small.

## Stage: Implementation — TDD (2026-08-13T18:20:45Z)

### Session summary

Executed all seven TDD steps from the plan in order: a new bounded `child-shutdown.ts` emitter, extension-runner stubs on the session mocks, the shutdown-before-dispose wiring in `SubagentSession`, and then promise propagation up through `Subagent`, `SubagentManager`, and `SessionLifecycleHandler`, closing with the doc updates.
Seven commits, all green at each step; pi-subagents went from 1199 to 1229 tests (+30).
The `pre-completion-reviewer` returned **PASS**.

### Observations

- **The plan's file list held.**
  Two files it missed surfaced only through lint, not `tsc`: `test/tools/agent-tool.test.ts` and `test/tools/get-result-tool.test.ts` each had one bare `record.releaseSession();` that became a floating promise.
  `pnpm run check` passes on an un-awaited promise-returning call, so a `src/`-caller grep at plan time would not have found them — only `no-floating-promises` did.
  The general lesson: when a method becomes promise-returning, the blast radius is the lint rule's, not the type checker's.
- **`Promise.withResolvers<void>()` needs the repo's boilerplate disable.**
  It trips `@typescript-eslint/no-invalid-void-type` despite `allowInGenericTypeArguments: true`, and the codebase already carries a standard `eslint-disable-line` comment for it at six sites.
  Three of the new gating tests needed the same comment; the pre-commit hook caught it before the commit landed.
- **The retention sweep uses a bare `void`, not the plan's `void promise.catch(debugLog)`.**
  `Subagent.releaseSession()` routes through a new private `disposeQuietly()` that already swallows a failing teardown, so a `.catch` at the sweep call site would be unreachable.
  Preferring the honest bare `void` keeps the dead-code gate meaningful.
- **`index.ts` needed no edit, as predicted.**
  Its three `pi.on(...)` handlers are expression-bodied arrows that return the handler's value, and `ExtensionHandler` permits a `Promise<void>` return that Pi awaits — so making the lifecycle handlers async propagated the await into Pi's own emit loop with zero wiring change.
- **`session_start`'s reason for a child is `"startup"`, not `"new"`.**
  The README draft asserted `"new"` from intuition; checking `AgentSession`'s constructor showed `sessionStartEvent` defaults to `{ reason: "startup" }` and pi-subagents never overrides it.
  A documented event payload is worth verifying against the SDK rather than inferring from the event's meaning.
- **The architecture doc's `Total LOC` row is a raw `wc -l` of `src/**/*.ts`, not a fallow metric.**
  Reproduced the recorded 8,162/60 exactly from the plan commit's tree, which confirmed the method before updating it to 8,323/61.
  `fallow health` reports whole-package totals (23,774 lines, 144 files) and would have been the wrong source.
- **Tidy-First assessor found no blocking preparatory work.**
  It flagged the third mock layer (`subagent-session.test.ts`'s private `createSession`, which does not spread `createMockSession`) as a real but medium-sized consolidation, and correctly declined it as a prerequisite — the duplication this change added there was two lines.

## Stage: Final Retrospective (2026-08-13T21:54:25Z)

### Session summary

Planning, TDD, and ship all ran in one session: a third-party bug report was verified against the pinned SDK, put to the operator through a four-question direction gate, planned, implemented in seven TDD cycles (+30 tests), and released as `@gotgenes/pi-subagents@19.3.1`.
Every child session now receives one awaited, bounded `session_shutdown` before its `AgentSession` is disposed.
The `pre-completion-reviewer` returned PASS and both CI runs (push and release) were green.

### Observations

#### What went well

- **The third-party `ask_user` gate fired cleanly on the first attempt.**
  Roughly thirty tool calls of SDK grounding preceded it, and the pre-ask message carried a concrete before/after table rather than abstract option labels.
  All four bundled questions (direction, async shape, hang guard, semver) came back decided with no bounce and no follow-up round.
  The accumulated rules behind that gate (Refs #533, #635, #678) were each written after a bounced ask; this is the first time the assembled set produced a one-round answer on a four-question bundle.
- **Reading Pi's compiled `dist/` answered a design question the `.d.ts` could not.**
  `emitSessionShutdownEvent` is not exported from the package entry — visible only by reading `runner.js` and `index.d.ts` together — and the ordering constraint that shaped the entire design (`AgentSession.dispose()` calls `extensionRunner.invalidate()`, after which every `ctx` getter's `assertActive()` throws) exists only in the compiled `.js`.
  This is exactly the case `AGENTS.md`'s #696 clause describes, and it converted a plausible-but-wrong design (fire-and-forget the emit, then dispose) into the correct one before any code was written.
- **A cross-package grep turned an unknown risk into documented evidence.**
  `grep -rn "session_shutdown" packages/*/src` surfaced two comments in `pi-permission-system` (`authority/subagent-registry.ts:41`, `authority/serving-registry.ts:93`) stating that their process-global stores deliberately have no teardown hook so "a child's `session_shutdown` must not be able to wipe the parent's registrations."
  The main consumer had already anticipated this event firing in children, which moved the biggest risk in the plan from speculation to citation.
- **The staged async propagation kept every commit green.**
  Steps 3→4→5→6 each made one layer promise-returning and left the next layer up on a temporary `void`, picking up its `await` in the following commit.
  Six commits, no reordering, no red intermediate state — the plan designed this explicitly and it held.

#### What caused friction (agent side)

- `instruction-violation` (self-identified only in retro) — the root-cause hunt ran inline instead of in an `Explore` subagent.
  `.pi/prompts/plan-issue.md` step 6 says to dispatch `Explore` when a bug report does not reproduce locally (Refs #719); this one never reproduced locally (no stdio MCP server configured) and the hunt ran inline across roughly thirty tool calls, turns 5–36.
  Impact: no rework and no compaction, but a large share of the planning session's context spent before the plan was written — the exact cost #719's rule exists to prevent.
  Mitigating nuance: the issue body supplied a five-step source trace naming every relevant symbol, so the task was *verifying a supplied diagnosis*, not hunting an unknown cause — and its output (which API is public, what the ordering constraint is) fed directly into the plan's Design Overview.
  The rule does not currently distinguish those two cases.
- `instruction-violation` (self-identified) — `echo ===` as a separator in a chained bash command.
  `AGENTS.md` names this exactly: zsh's `equals` expansion reads `=word` as a command-path lookup.
  Impact: one wasted tool call, and the second half of the `A; B` chain (the `emitSessionShutdownEvent` grep) was silently discarded and re-run.
- `instruction-violation` (self-identified) — a commit chained after a failing lint with `;` instead of `&&`.
  Turn 119 ran `pnpm run lint >/tmp/l4.log 2>&1; echo "lint=$?"; grep ...; git add -A && git commit -m ...`.
  The redirect followed `AGENTS.md`'s rule (redirect rather than pipe, to preserve the exit status) but the `;` separator discarded the gate the rule exists to create.
  Impact: none — the `prek` `commit-msg`/`pre-commit` hook caught the four lint errors and blocked the commit.
  The rule's own example already shows `&&`; this was a failure to follow it, not a gap in it.
- `other` — emitted a zero-width space (U+200B) into the plan file, then spent four tool calls diagnosing why a `perl` substitution would not match it.
  The text `void …​.catch(debugLog)` reached the file through a `Write` call; `perl -i -pe` then failed silently because it treats the file as bytes without `-CSD`.
  Diagnosis needed a `hexdump`.
  Impact: four extra tool calls (turns 54–57), no rework.
  The wholesale non-ASCII scan (`rg -n '[^\x00-\x7f]'`) that `AGENTS.md` recommends found it immediately — but only after the failure, not before.
- `rabbit-hole` — six consecutive tool calls to establish the architecture doc's `Total LOC` baseline (turns 157–162).
  Tried `fallow health` (reports whole-package totals: 23,774 lines, 144 files), then `fallow health --format json` (same), then a `git checkout HEAD~7 -- src` that produced a nonsense count, before finally reproducing the recorded 8,162/60 exactly with `git ls-tree` + `git show` against the plan commit.
  Impact: six tool calls, no rework.
  Root cause: the health-metrics table records values without recording how they were computed, even though the `improvement-discovery` skill says to "record the recompute command with the metric."
- `missing-context` — wrote a documented SDK event payload from intuition.
  The README draft asserted `session_start` fires with `reason: "new"` for a child; the SDK defaults `sessionStartEvent` to `{ reason: "startup" }` and `pi-subagents` never overrides it.
  Impact: five verification tool calls and one edit; caught before the commit, so nothing wrong shipped.
- `missing-context` — did not grep for an existing lint-disable convention before writing `Promise.withResolvers<void>()` in new tests.
  The codebase already carries a standard `eslint-disable-line @typescript-eslint/no-invalid-void-type` comment at six sites for exactly this call.
  Impact: one blocked commit and five tool calls (turns 120–127) to diagnose and fix, alongside two unrelated `no-floating-promises` errors surfaced by the same run.
- `other` — deviated from the plan's own TDD sequencing and the plan was right.
  The plan put `createSubagentSessionStub.dispose` becoming async in step 2; this session deferred it to step 3, then hit 41 test failures and had to make the change anyway.
  The `tidy-first-assessor` had explicitly noted the plan "already sequences the duplication correctly."
  Impact: three tool calls to diagnose (turns 99–101), no rework beyond the deferred edit.

#### What caused friction (user side)

- Nothing that cost the session time.
  The four `ask_user` answers were decisive and needed no clarifying round, and no correction was issued at any point.
- All three stages ran in one session rather than the separate sessions the `AGENTS.md` multi-session lifecycle assumes.
  For a change this size that was efficient, but it means the planning and TDD stage notes served no cross-session bridging purpose — they were written and read inside the same context window.
  Worth noting as a data point on when the stage-note ritual earns its cost.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `anthropic/claude-opus-5` (judgment-heavy: SDK archaeology, design decisions, `ask_user` construction); ship ran on `anthropic/claude-sonnet-5` (mechanical: push, CI watch, close, merge).
  Both assignments are appropriate.
  The one sonnet-5 artifact: three consecutive `git rev-parse` calls on the same SHA, including `git rev-parse 886caa4f | wc -c` to count characters — an over-literal reading of the ship prompt's "never hand-type a SHA" rule.
  Cost: two wasted tool calls.
  Both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on their configured `anthropic/claude-sonnet-5`; both produced correctly-scoped reports, and the tidy assessor's declining to recommend a medium-sized test-mock consolidation was the right judgment call.
- **Escalation-delay tracking** — two sequences over the five-call threshold: the `Total LOC` baseline hunt (six calls, turns 157–162) and the `Promise.withResolvers` lint fix (five calls, turns 120–127).
  Neither warranted a subagent — both were self-contained shell puzzles — but the first would have collapsed to one call by asking how the recorded number was originally produced before trying to reproduce it, and the second by grepping the codebase for the symbol before writing it.
- **Unused-tool detection** — `colgrep` was never used despite its skill being loaded; every search this session was exact-symbol (`session_shutdown`, `disposeSession`, `withResolvers`), which is correctly grep's domain, so this is not a miss.
  The real unused tool was the `Explore` subagent for the root-cause hunt, covered under the first friction point.
- **Feedback-loop gap analysis** — no gap.
  `pnpm run check` ran after every type-touching step (turns 86, 98, 118, 144, 152), the package suite after every green (86, 99, 103, 118, 127, 145, 152), root `pnpm run lint` at each commit boundary (79, 104, 119, 127, 146, 153, 177), and `pnpm fallow dead-code` at baseline, after step 1, and at the end (71, 80, 179).
  The only flaw was the `;`-vs-`&&` gating slip at turn 119, which the pre-commit hook absorbed.

### Changes made

1. `.pi/prompts/plan-issue.md` — added a carve-out to step 6's `Explore`-dispatch rule: verifying a diagnosis the report already supplies (named files, a numbered source trace) stays inline, because what it establishes is the design's input.
   The rule previously read as a blanket "does not reproduce locally → delegate," which would have sent this issue's compiled-`.js` verification to a subagent and returned a summary instead of the ordering constraint the design turned on.
2. `packages/pi-subagents/docs/architecture/architecture.md` — recorded the recompute command for the `Total LOC` health metric as a note under the table, and stated that every other row is a `fallow health` field.
   Added as prose rather than a table cell because all eleven rows are width-padded to a fixed column and `rumdl fmt` does not re-pad them.

[#617]: https://github.com/gotgenes/pi-packages/issues/617

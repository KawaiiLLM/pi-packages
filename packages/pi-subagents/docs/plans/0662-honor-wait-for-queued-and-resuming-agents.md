---
issue: 662
issue_title: "fix(pi-subagents): honor wait:true for queued agents and in-flight resumes"
---

# Honor `wait:true` for queued agents and in-flight resumes

## Release Recommendation

**Release:** ship independently

This work is not a step in the Phase 15–21 roadmap in `docs/architecture/architecture.md`, so it carries no `Release: batch` tag.
It is a self-contained `fix:` to a tool contract users can observe immediately, with no sibling step whose release it should wait for.

## Problem Statement

`get_subagent_result`'s wait path in `src/tools/get-result-tool.ts` guards on `record.status === "running"`.
Two states that the package already promises to support fall outside that guard, so `wait: true` returns a stale report instead of waiting:

1. A **queued** agent.
   `Subagent.scheduleVia()` captures the limiter promise eagerly — its doc comment states that "a still-queued agent is awaitable via the `promise` getter from spawn" — but the tool never reaches that promise, so the parent gets an immediate `Status: queued` report with no result.
2. An agent whose **`resume()` is in flight**.
   `Subagent.resume()` never refreshes `_promise`, so the `promise` getter still holds the settled handle of the original run; awaiting it returns instantly and the parent sees `Status: running` with the previous run's data.

Both were reproduced against current `main` during the PR-review stage (see `docs/retro/0662-honor-wait-for-queued-and-resuming-agents.md`), not inferred from the report.

A third gap surfaced while evaluating the fix.
`GetResultTool.execute` receives an `AbortSignal` and ignores it (`_signal`).
Widening the wait from "running" to "everything queued ahead of this agent" makes that matter: with `maxConcurrent` defaulting to 4, a parent can now block for the full queue depth with no way to escape except ESC's global `abortAll()`, which kills every background agent as collateral.

## Goals

- `get_subagent_result` with `wait: true` waits for a **queued** agent until its slot frees and its run finishes.
- The `Subagent.promise` getter always refers to the **current** run, including an in-flight `resume()`.
- A parent-turn interrupt ends the wait promptly and returns the agent's current report, **without** aborting the agent.
- Move the "is this agent still awaitable" decision onto `Subagent`, so the tool stops reaching through to the record's internal promise handle.

This change is **not breaking**.
It moves observable behavior toward the contract the tool's own parameter description and `README.md` already state ("Wait for completion"), and it changes no default, config key, or output shape.
The suggested commits are `fix:`, not `fix!:`.

## Non-Goals

- Making ESC's abort-all behavior configurable — that is Issue #664, a separate policy question.
  This plan deliberately does not change `src/handlers/interrupt.ts` or `SubagentManager.abortAll()`.
- Compact/expandable rendering for `get_subagent_result` — Issue #636, a presentation concern that does not touch the wait path.
- Adding a background-resume path (a `run_in_background` resume, or a `resume` method on `SubagentsService`).
  The `promise` invariant is repaired here so a future background resume cannot inherit the bug, but no such caller is introduced.
- Changing `ConcurrencyLimiter`.
  Its `clear()` already settles dropped tasks, so a queued wait terminates on shutdown or abort-all without limiter changes.
- Collapsing the remaining `status === "running"` comparison in `src/tools/get-result-report.ts:45`.
  That is per-status presentation dispatch, which the `code-design` skill names as idiomatic rather than a scattered-decision smell.
- Any change to the public `SubagentsService` surface.
  `SubagentRecord` in `src/service/service.ts` is a serializable snapshot with no `promise` field, so the type bundles in `dist/` are unaffected.

## Background

The relevant modules:

- `src/tools/get-result-tool.ts` — `GetResultTool.execute` looks the record up, optionally waits, marks the outcome consumed when the agent is no longer active, then formats a report.
- `src/lifecycle/subagent.ts` — `Subagent` owns `_promise` and publishes it read-only via the `promise` getter.
  `start()` and `scheduleVia()` both assign `_promise`; `resume()` does not.
- `src/lifecycle/subagent-state.ts` — `isActiveStatus()` is the single definition of "running or queued"; `Subagent.isActive()` delegates to it.
- `src/lifecycle/subagent-manager.ts` — `pendingPromises()` (line 344) already selects awaitable records with `filter(r => r.isActive()).map(r => r.promise)`, and `waitForAll()` documents that a queued agent's promise settles when its slot frees.
- `src/lifecycle/concurrency-limiter.ts` — every scheduled promise settles: with the task when it runs, or early via `clear()` when it is dropped.

The tool is the only remaining site that hand-rolls `status === "running"` where the manager uses the `isActive()` predicate.
The `code-design` skill's Open/Closed section names this exact case: prefer a predicate on the object that owns the data over `status === "running" || status === "queued"` re-derived at each consumer.
The `design-review` checklist's Law-of-Demeter check names the other half: the tool asks the record three questions (`isActive()`, `promise`, then `await promise`) instead of telling it to wait.

Constraints from `AGENTS.md` and the package skill that apply:

- Pi SDK imports stay out of business-logic modules.
  `AbortSignal` is a platform type, not an SDK type, so accepting one on a `lifecycle/` method introduces no SDK dependency.
- The package is ship-source except for the `dist/` type bundles; no public export changes here, so `pnpm run verify:public-types` is a sanity check rather than a required gate.
- Every implementation and docs commit for this issue carries the contributor trailer recorded in the retro (see Risks).

## Design Overview

### Tell the record to wait

Add one behavior method to `Subagent`, and let it own the whole decision:

```typescript
/**
 * Wait until this agent's current run settles.
 * Resolves immediately when the agent is no longer active (running or queued)
 * or has no run handle. A queued agent is awaitable because scheduleVia()
 * captures the limiter promise at spawn, so the wait spans the queue slot and
 * the run that follows it.
 * When `signal` fires, the wait ends early and the agent keeps running —
 * this is a query, so interrupting it must not cancel the work.
 */
async waitUntilSettled(signal?: AbortSignal): Promise<void> {
  const run = this._promise;
  if (!run || !this.isActive()) return;
  await settleOrAbort(run, signal);
}
```

The call site collapses to a single tell:

```typescript
// src/tools/get-result-tool.ts
if (params.wait) {
  await record.waitUntilSettled(signal);
}
```

The `markConsumed()` branch below it is unchanged and stays correct under interruption: an interrupted wait leaves the record active, so the outcome is not marked consumed and the completion nudge still fires later.

### Ending the wait on interrupt

A module-private helper in `subagent.ts`, placed below `waitUntilSettled` per the stepdown rule:

```typescript
/** Settle with the run, or early when `signal` fires. Detaches its listener either way. */
function settleOrAbort(run: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return run;
  if (signal.aborted) return Promise.resolve();
  const detach = new AbortController();
  const interrupted = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => { resolve(); }, { once: true, signal: detach.signal });
  });
  return Promise.race([run, interrupted]).finally(() => { detach.abort(); });
}
```

The inner `AbortController` is the listener-cleanup channel: when the run wins the race, `detach.abort()` removes the listener so repeated `get_subagent_result` calls within one parent turn do not accumulate listeners on that turn's signal.
This mirrors the wire-then-detach shape already used by `RunListeners.wireSignal` and `forwardAbortSignal` in `src/lifecycle/subagent-session.ts`, using the modern `{ signal }` listener option rather than a returned cleanup closure.

Do not add an `eslint-disable` for `@typescript-eslint/no-invalid-void-type` preemptively.
`concurrency-limiter.ts:24` needs one for `Promise.withResolvers<void>()`, but `new Promise<void>(...)` is a construct expression and may not trip the rule; add the disable only if `pnpm run lint` reports it, with the same rationale comment.

Interrupting the wait deliberately does **not** abort the agent.
`get_subagent_result` is a query; ESC on the parent means "stop what *you* are doing", and the agent-killing interpretation already lives in `InterruptHandler` (Issue #664).
Today ESC ends the wait twice over — through the signal race and through `abortAll()` — but if #664 makes `abortAll` opt-out, the signal race becomes the only escape, which is the reason to land it here rather than defer it.

### Republishing the run handle on resume

`resume()` cannot assign `_promise` from inside its own `async` body, so the body moves to a private `runResume` and `resume` becomes a synchronous method returning the tracked promise:

```typescript
resume(prompt: string, signal?: AbortSignal): Promise<void> {
  const subagentSession = this.subagentSession;
  if (!subagentSession) {
    return Promise.reject(new Error("Subagent not configured for resume — missing session"));
  }
  this._promise = this.runResume(subagentSession, prompt, signal);
  return this._promise;
}
```

Two details matter.
The precondition failure becomes `Promise.reject`, not `throw`: dropping `async` would otherwise turn the rejection into a synchronous throw that escapes `expect(...).rejects.toThrow(...)`, per the `testing` skill.
Dropping `async` also makes `resume()` return the *same* promise object as the `promise` getter, which is directly assertable (`expect(agent.promise).toBe(agent.resume("…"))` in spirit) rather than merely "settles at about the same time".

`runResume` keeps the always-resolves contract of the existing body (errors are captured by `failResume`), so `_promise` never becomes an unhandled rejection for a waiter that is not watching it.

`SubagentManager.resume()` and `AgentTool`'s `ManagerLike.resume` signatures are unchanged — only `Subagent.resume`'s internal shape changes, and `await`ing a non-`async` method that returns `Promise<void>` is identical at every call site.

## Module-Level Changes

`packages/pi-subagents/src/lifecycle/subagent.ts`

- Add `waitUntilSettled(signal?: AbortSignal): Promise<void>` as a public method, placed with the other lifecycle behavior methods near `abort()`.
- Add the module-private `settleOrAbort(run, signal)` helper below it.
- Change `resume()` from `async` to a synchronous method that assigns and returns `this._promise`, returning `Promise.reject(...)` for the missing-session precondition.
- Add `private async runResume(subagentSession, prompt, signal?): Promise<void>` holding the former `resume()` body verbatim.
- Extend the `promise` getter's doc comment to state that it tracks the current run, including a resume.

`packages/pi-subagents/src/tools/get-result-tool.ts`

- Rename the `_signal: AbortSignal` parameter of `execute` to `signal` and use it.
- Replace the `params.wait && record.status === "running" && record.promise` guard and its `await record.promise` with `if (params.wait) await record.waitUntilSettled(signal);`.
- Update the comment to describe the queued case and the interrupt exit, replacing the `// Wait for completion if requested.` line.

`packages/pi-subagents/test/tools/get-result-tool.test.ts`

- Add an optional `signal` argument to the file-local `execute()` helper (currently hardcodes `new AbortController().signal`), defaulting to a fresh signal so existing call sites are untouched.
- Add the queued-wait test and the interrupted-wait test (see TDD Order).

`packages/pi-subagents/test/lifecycle/subagent.test.ts`

- Add tests for the in-flight-resume promise identity and the missing-session rejection.

`packages/pi-subagents/docs/architecture/architecture.md`

- Update the `subagent.ts` module-tree entry (line 317) from `owns full execution lifecycle (run, abort, steer)` to include the wait capability.
  This describes current behavior; per the `AGENTS.md` architecture-doc convention it carries no issue citation, because the method encodes no lint-guarded or ADR boundary.

Files deliberately **not** changed, each confirmed by grep:

- `packages/pi-subagents/README.md` — line 215 already documents `wait` as "Wait for completion", which this fix makes true; no stale prose to correct.
- `.pi/skills/package-pi-subagents/SKILL.md` — its only `get_subagent_result` mention is the domain table's tool list, which is unaffected.
- `src/lifecycle/subagent-manager.ts` — `spawnAndWait()` (line 222) and `pendingPromises()` (line 345) keep using the `promise` getter directly; `Promise.allSettled` over many records is a different use than a single record's guarded wait, and the getter stays public.
- `src/service/service.ts` and the `dist/` type bundles — no public surface change.

Repeated-discriminator baseline, per the `design-review` sweep (`grep -rhoE '[A-Za-z_.]+ [!=]== "[a-z0-9_-]+"' src --include="*.ts" | sort | uniq -c | sort -rn`): `status === "running"` currently has 2 production sites.
This change removes the `get-result-tool.ts:36` site, leaving 1 — `get-result-report.ts:45`, which the Non-Goals keep as presentation dispatch.

## Test Impact Analysis

1. **New tests the change enables.**
   `Subagent.waitUntilSettled` is directly unit-testable at the lifecycle layer: a queued record whose scheduler is driven by hand, an already-settled record (returns immediately), and an interrupt mid-wait.
   Previously the queued path could only be probed through the tool, because the decision lived in the tool.
2. **Tests that become redundant.**
   None.
   The existing `waits for promise when wait=true and agent is running` test (`test/tools/get-result-tool.test.ts:86`) still pins the running case end-to-end through the tool and must stay green unchanged — it is the regression guard proving the fix did not narrow the path that already worked.
3. **Tests that must stay as-is.**
   `test/lifecycle/subagent-manager.test.ts` resume tests (lines 436–566) exercise `SubagentManager.resume` and must pass untouched; they are the proof that making `Subagent.resume` non-`async` changed nothing observable for its real caller.
   The `Subagent.resume() — observer lifecycle` describe block likewise must stay green without edits, since `runResume` holds the former body verbatim.

## Invariants at risk

| Invariant                                                                                                             | Origin                                                                  | Pinned by                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The parent collecting a settled outcome marks it consumed, so the completion nudge suppresses itself                  | #617 (`docs/plans/0617-consumption-aware-session-retention.md`)         | `expect(record.consumed).toBe(true)` in the existing `wait=true` running test, plus a new negative assertion on the interrupted-wait test |
| Status classification goes through predicates, not re-derived comparisons                                             | #563 (`docs/plans/0563-status-classification-predicates.md`)            | The discriminator sweep above: 2 → 1 production `status === "running"` sites, the survivor being presentation dispatch                    |
| `resume()` routes termination through `onResumeFinished`, releasing listeners on both the completed and errored paths | #466 (`docs/plans/0466-resume-completion-signalling.md`)                | The `Subagent.resume() — observer lifecycle` describe block, which must stay green with no edits                                          |
| A queued agent dropped by `clear()` still settles its promise                                                         | `ConcurrencyLimiter` doc comment                                        | Existing `concurrency-limiter.test.ts` coverage; the new wait path inherits it rather than adding a second mechanism                      |
| Nudges are withheld during the parent's agent run and flushed at `agent_settled`                                      | #661 (`docs/plans/0661-hold-completion-nudges-while-parent-streams.md`) | Untouched: this change lengthens a tool call but adds no nudge-layer code path                                                            |

The one quantitative risk is wait duration rather than tokens or bytes: the bound on a `wait: true` call rises from "one agent's run" to "the queue ahead of it plus its run".
`maxConcurrent` defaults to 4 (`src/settings.ts:27`).
The interrupt exit is the mitigation, and is why it is in scope rather than deferred.

## TDD Order

1. **`test:` red — queued agents are not awaited.**
   Add `waits for a queued agent when wait=true` to `test/tools/get-result-tool.test.ts`, driving admission by hand through a stub passed to `record.scheduleVia()` so the slot frees only after the wait has begun.
   Assert both the completed result text and `record.consumed === true`.
   Commit: `test(pi-subagents): pin wait:true against a queued agent (#662)`.
2. **`fix:` green — tell the record to wait.**
   Add `Subagent.waitUntilSettled(signal?)` (initially awaiting `_promise` with no race) and rewire `GetResultTool.execute` to call it.
   Commit: `fix(pi-subagents): honor wait:true for queued agents (#662)`.
3. **`test:` red — an interrupted wait does not hang or consume.**
   Add the `signal` parameter to the file-local `execute()` helper, then add `returns the current report when the parent turn is interrupted`: a running agent whose turn loop never resolves, aborted mid-wait, expecting the call to resolve with a `running` report and `record.consumed === false`.
   Add a sibling lifecycle test asserting the agent is still active afterwards, so the "a query must not cancel the work" rule is pinned, not just implied.
   Commit: `test(pi-subagents): pin interrupt exit for get_subagent_result waits (#662)`.
4. **`fix:` green — honor the tool's AbortSignal.**
   Add the `signal?` parameter to `waitUntilSettled`, the `settleOrAbort` helper, and thread `signal` at the call site.
   Run `pnpm run lint` in this step specifically to settle the `no-invalid-void-type` question before adding any disable comment.
   Commit: `fix(pi-subagents): end a get_subagent_result wait on parent interrupt (#662)`.
5. **`test:` red — the promise getter goes stale across a resume.**
   Add `exposes the in-flight resume via the promise getter` to `test/lifecycle/subagent.test.ts`, asserting the handle does not settle before the resume does — using promise identity or a microtask tick, **not** `setTimeout`, which no test in this package's 64 files currently uses.
   Add `rejects when resumed without a session`, which pins the precondition contract across the `async`-to-synchronous conversion in the next step.
   Commit: `test(pi-subagents): pin the promise getter across a resume (#662)`.
6. **`fix:` green — republish the run handle on resume.**
   Extract `runResume`, make `resume()` synchronous, and return the tracked promise.
   Run the full package suite here, not just the two touched files — `subagent-manager.test.ts`'s resume tests are the untouched-caller proof.
   Commit: `fix(pi-subagents): track the live resume in the Subagent promise getter (#662)`.
7. **`docs:` — architecture module-tree entry.**
   Update the `subagent.ts` line in `docs/architecture/architecture.md` to name the wait capability.
   Commit: `docs(pi-subagents): note the wait capability on the Subagent module entry (#662)`.

Every commit in steps 1–7 carries, after a blank line at the end of the body:

```text
Co-authored-by: daoguademeng <whumaple@gmail.com>
```

## Risks and Mitigations

| Risk                                                                        | Mitigation                                                                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `wait: true` on a deep queue blocks the parent far longer than before     | Step 4's interrupt exit gives the parent an escape that does not kill the agents, independent of Issue #664's abort-all policy                                       |
| An abort listener leaks onto the parent turn signal across repeated calls   | `settleOrAbort` detaches through an inner `AbortController` in a `finally`, so the listener is removed whichever branch of the race wins                             |
| Making `resume()` non-`async` converts a rejection into a synchronous throw | Step 5 lands the rejection test *before* step 6's conversion, and the precondition uses `Promise.reject` rather than `throw`                                         |
| `runResume` extraction silently drops a line of the original body           | Step 6 runs the full package suite; the `Subagent.resume() — observer lifecycle` block passes only if the body is intact                                             |
| The contributor's credit is lost                                            | The `Co-authored-by` trailer above is required on every commit, and the PR close comment thanks `@daoguademeng` and links the implementing SHAs; never `Closes #662` |
| An interrupted wait leaves the parent with a report it did not expect       | The report is honest (`Status: running` / `queued`) and the record stays unconsumed, so the completion nudge still arrives later                                     |

## Open Questions

- Should the report state explicitly that a requested wait was cut short by an interrupt, rather than leaving the parent to infer it from a non-terminal `Status:`?
  Deferred, not filed: the current report is accurate, and the answer may depend on Issue #636's rendering rework of this same tool.
- If Issue #664 lands an opt-out for abort-all, is a per-call `timeout` on `get_subagent_result` also wanted, so a parent can bound a queued wait without an interrupt?
  Deferred until a real need appears; the signal exit covers the interactive case.

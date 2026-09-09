---
issue: 661
issue_title: "fix(pi-subagents): hold completion nudges while the parent agent streams"
---

# Gate completion nudges on the parent turn boundary

## Release Recommendation

**Release:** ship independently

Issue #661 is not part of any roadmap phase in `packages/pi-subagents/docs/architecture/architecture.md`, so no release batch applies.
It lands as a `fix!:` commit and cuts a **major** release on the next release-please merge.

Revised during implementation: the `agent_settled` event this design depends on does not exist in the SDK version the package supported, so the peer floor is raised and the change is breaking.
See the Goals note below.

## Problem Statement

A background agent's completion nudge can reach the parent LLM twice: once as the result the parent pulls mid-turn via `get_subagent_result`, and again when Pi drains its `followUp` queue at turn end.

`NotificationManager` guards against this by re-reading `record.consumed` at nudge schedule time and at fire time.
Neither guard covers the real window.
"Fire" means handing the message to `pi.sendMessage()`, and Pi routes that to `this.agent.followUp(appMessage)` whenever the session is streaming (`agent-session.ts:1443-1450`), a queue the extension cannot recall.
The message is only *delivered* when the agent loop drains that queue at turn end (`agent-session.ts:1100-1102`).
The entire remainder of the parent's turn sits between handoff and delivery, and a `get_subagent_result` call in that span marks the record consumed far too late.
The result is a redundant `<task-notification>` carrying a result the parent already has, plus a forced extra LLM turn re-reporting it.

The defect was reproduced against current `main` during PR review, using a double that mirrors Pi's verified `sendCustomMessage` semantics.
The existing 200 ms `NUDGE_HOLD_MS` debounce only shrinks the completion→pull window; the dangerous window is fire→turn-end.

## Goals

- Suppress the completion nudge when the parent pulls the agent's result at any point during the turn in which the agent completed.
- Gate nudge delivery on the parent's agent-run boundary rather than a fixed wall-clock debounce.
- Collapse the hold mechanism to a single pending-nudge collection with a single delivery path.
- Preserve today's correct behavior: a nudge for an agent the parent never pulled is still delivered exactly once, and an agent completing while the parent is idle still triggers a fresh turn.

This change is **breaking**, as settled with the operator during implementation.
The runtime behavior change is benign — it removes a redundant message and a redundant forced turn, with no output shape, config default, or public export change.
What breaks is the supported host range: gating delivery on `agent_settled` requires `@earendil-works/pi-coding-agent >= 0.80.5`, raised from `>= 0.75.0`.
On an older host the event never fires and withheld nudges would never be delivered, so the floor is raised rather than silently degrading.
Commits use `fix!:` with a `BREAKING CHANGE:` footer.

## Non-Goals

- No change to nudge content, the `<task-notification>` XML shape, or the themed renderer (`observation/renderer.ts`).
- No change to the consumption domain state landed in #617 — `consumedAt` stays owned by `SubagentState`, and the three `markConsumed()` call sites are untouched.
- No change to `NotificationSystem`, so `observation/subagent-events-observer.ts` and its tests are untouched.
- No rework of `get_subagent_result` result presentation — that is issue #636, which is open against the same tool but concerns compact/expandable rendering, not delivery timing.
- Adopting PR #661's diff as-is: it is reference material for this plan, not the merge target.

## Background

`NotificationManager` (`src/observation/notification.ts`) receives `sendCompletion(record)` from `SubagentEventsObserver` (`subagent-events-observer.ts:83`), which delegates unconditionally — the manager decides whether to nudge.
Today `sendCompletion` arms a 200 ms `setTimeout` keyed by agent id, and `emitIndividualNudge` re-checks `record.consumed` before calling `sendMessage`.

Three facts established by reading Pi's source at the sibling checkout `../pi` constrain the design, and should not be re-derived during implementation.

1. `isIdle()` is exposed on `ExtensionContext` / `ExtensionContextActions` (`extensions/types.ts:324`, `:1616`), **not** on `ExtensionAPI` (`:1179`).
   The extension holds `pi: ExtensionAPI`, so it cannot query streaming state on demand and must mirror it from lifecycle events.
   Per the `code-design` rule about confirming an SDK method on the exact type the code holds, `pi.isIdle()` is not available here.
2. `agent_end` fires once per agent-run *segment*; a single `_runAgentPrompt` emits several across auto-retry, auto-compaction, and `followUp` continuations.
   `agent_settled` fires exactly once per run, from the `finally` block of `_runAgentPrompt` (`agent-session.ts:1071`), so it also fires on error and abort.
3. `_emitAgentSettled` sets `_isAgentRunActive = false` **before** emitting to extensions (`agent-session.ts:581-582`).
   A `sendMessage` issued from an `agent_settled` handler therefore sees `isStreaming === false` and takes the `triggerTurn` → `_runAgentPrompt` path, rather than re-entering the unrecallable `followUp` queue.

All three `markConsumed()` call sites — `tools/get-result-tool.ts:44`, `tools/foreground-runner.ts:114`, `tools/agent-tool.ts:109` — execute inside tool handlers, which run inside an agent run.
Consumption can therefore only happen while the parent is streaming, which is why the idle delivery path needs no debounce at all.

AGENTS.md constraint: PR #661 is third-party, so every implementation and docs commit carries the `Co-authored-by` trailer recorded in the triage note, and commits reference the PR as `Refs #661`, never `Closes #661`.

## Design Overview

`NotificationManager` mirrors the parent's agent-run state in one boolean and holds fired nudges in one map until the run settles.

```typescript
export class NotificationManager implements NotificationSystem {
  /** Nudges withheld while the parent streams, keyed by agent id (last write wins). */
  private pendingNudges = new Map<string, Subagent>();
  private parentStreaming = false;

  sendCompletion(record: Subagent): void {
    if (record.consumed) return;
    if (this.parentStreaming) {
      this.pendingNudges.set(record.id, record);
      return;
    }
    this.emitIndividualNudge(record);
  }

  onParentAgentStart(): void {
    this.parentStreaming = true;
  }

  onParentAgentSettled(): void {
    this.parentStreaming = false;
    const pending = [...this.pendingNudges.values()];
    this.pendingNudges.clear();
    for (const record of pending) {
      try {
        this.emitIndividualNudge(record);
      } catch (err) {
        debugLog("notification render", err);
      }
    }
  }

  dispose(): void {
    this.pendingNudges.clear();
  }
}
```

`emitIndividualNudge` keeps its `record.consumed` early return unchanged, which is what makes the flush a fresh re-check rather than a blind replay.
Two consumption checks remain — one when the nudge is enqueued, one when it is emitted — down from the three the PR's design would leave.

The consumer wiring in `src/index.ts` is two lines beside the existing construction:

```typescript
pi.on("agent_start", () => notifications.onParentAgentStart());
pi.on("agent_settled", () => notifications.onParentAgentSettled());
```

Interface segregation: the two lifecycle hooks go on the concrete `NotificationManager`, **not** on the `NotificationSystem` interface.
`SubagentEventsObserver` depends on `NotificationSystem` and calls only `sendCompletion`; widening that interface would force it to depend on methods it never calls.
`index.ts` holds the concrete `NotificationManager`, so the wiring type-checks without touching the interface.

Edge cases.
The `agent_start` / `agent_settled` pairing is asymmetric — `agent_start` fires once per run segment while `agent_settled` fires once per run — but `onParentAgentStart` is idempotent, so the asymmetry is harmless.
Keying `pendingNudges` by agent id makes re-completion during a single turn (a resumed run reaching terminal state again) collapse to one delivery by construction.
Because `agent_settled` is emitted from a `finally` block, a run that errors or aborts still flushes rather than stranding held nudges.
Several agents completing in one turn each produce their own message at flush, in insertion order, matching today's one-message-per-agent behavior.

Reentrancy: the flush calls `pi.sendMessage`, whose runtime binding is fire-and-forget (`sendCustomMessage(...).catch(...)`, not awaited), so the new turn is launched detached and the `agent_settled` handler returns promptly.

## Module-Level Changes

| File                                                            | Change                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/src/observation/notification.ts`         | Remove `NUDGE_HOLD_MS`, `scheduleNudge`, `cancelNudge`; retype `pendingNudges` to `Map<string, Subagent>`; add `parentStreaming`, `onParentAgentStart`, `onParentAgentSettled`; gate `sendCompletion`; simplify `dispose`. |
| `packages/pi-subagents/src/index.ts`                            | Register `agent_start` and `agent_settled` handlers delegating to the manager.                                                                                                                                             |
| `packages/pi-subagents/package.json`                            | Added during implementation: raise the `@earendil-works/pi-coding-agent` peer floor to `>=0.80.5` and move the three `@earendil-works/*` dev pins to `0.80.5`.                                                             |
| `packages/pi-subagents/test/observation/notification.test.ts`   | Re-arrange 2 timer-based tests to the turn boundary; rename the idle-delivery test; add a `parent-turn boundary` describe with a Pi-semantics double; drop now-dead fake timers.                                           |
| `packages/pi-subagents/test/lifecycle/subagent-manager.test.ts` | `seedNotificationScenario` arranges the streaming state; 1 Bug-1 test re-arranged to settle instead of advancing timers.                                                                                                   |
| `packages/pi-subagents/docs/architecture/architecture.md`       | Module-tree entry for `notification.ts` (line 329) gains the turn-boundary constraint.                                                                                                                                     |
| `.pi/skills/package-pi-subagents/SKILL.md`                      | Observation-domain row (line 45) mirrors the same description.                                                                                                                                                             |

Greps run at planning time to bound the blast radius.
`NUDGE_HOLD_MS` appears in no `src/` file other than `notification.ts`, and in `docs/` only inside historical plans and retros, which are immutable records and are not edited.
`scheduleNudge` and `cancelNudge` are private with no call sites outside the class.
`README.md` describes notification *rendering*, never delivery timing, so it needs no edit.
`architecture.md:592` describes #617's consumption ownership and stays accurate — the notification layer still only reads `consumedAt`.

## Test Impact Analysis

New tests this enables.
Turn-boundary behavior is directly assertable for the first time: a nudge held across a streaming turn, suppressed on mid-turn consumption, delivered once when never pulled, and delivered immediately when the parent is idle.
The regression test uses a double modeling Pi's `followUp` queue and settle ordering, so it fails for the behavioral reason rather than a missing method.

Tests that become redundant in their current framing.
Three tests use the 200 ms timer as a stand-in for "a parent turn is in progress" and were measured failing against the spike: `suppresses a scheduled nudge when the record becomes consumed before it fires` and `dispose clears all pending timers` in `notification.test.ts`, and `marking consumed after awaiting still suppresses the nudge` in `subagent-manager.test.ts`.
Each is re-arranged, not deleted — they pin the same invariant at the boundary that actually governs it.
`sendCompletion schedules a nudge after the hold delay` keeps passing but its name becomes false, so it is renamed to describe idle delivery.

Tests that must stay as-is.
`marking consumed before await suppresses the nudge (schedule-time guard)` exercises the enqueue-time guard, which is unchanged.
The `sendCompletion` delegation tests in `subagent-events-observer.test.ts` stay untouched, since `NotificationSystem` does not change.

## Invariants at risk

The `consume()`-after-await invariant from Phase 20 / #617 is documented as depending on this constant.
`docs/architecture/history/phase-20-result-delivery.md:60` credits the 200 ms window, and retro `0535-extract-result-delivery-from-subagent.md:42` calls `NUDGE_HOLD_MS` "a load-bearing constant", warning that a *decrease* narrows the window in which a post-await `consume()` remains effective.

This was measured at planning time rather than argued, per the spike rule.
A scratch worktree implemented the collapsed design and ran the full package suite: 1083/1083 tests pass once the three tests above arrange the streaming state, with `pnpm run check` and `pnpm run lint` both clean.
The invariant does not weaken — it strengthens.
Removing the timer replaces a 200 ms window with one spanning the remainder of the parent's agent run, and because every `markConsumed()` call site runs inside a tool handler (therefore inside an agent run), the new window strictly contains every case the old one covered.

The invariant stays pinned by the two Bug-1 tests in `subagent-manager.test.ts`, which survive in re-arranged form.

`pnpm fallow dead-code` was also run against the spike: it flags `NotificationManager.onParentAgentSettled` as an unused class member until `index.ts` registers the handler, so the method and its wiring must land in the same commit.

## TDD Order

1. `fix(pi-subagents): gate completion nudges on the parent turn boundary (#661)` — red: `notification.test.ts` gains a `parent-turn boundary` describe driven by a Pi-semantics double (holds across a streaming turn; suppresses when consumed mid-turn; delivers once when never pulled; delivers immediately when idle; re-completion collapses to one; `dispose` drops held nudges), plus the two re-arranged timer tests and the renamed idle test; green: the `notification.ts` rework above **and** the two `index.ts` handler registrations in the same commit, since `fallow` fails on the unwired method and the removed private helpers have no other callers.
   Verify the regression test actually pins the fix by temporarily reverting only the `parentStreaming` branch in `sendCompletion` and confirming the suppression test fails.
2. `test(pi-subagents): re-arrange Bug-1 nudge races around the turn boundary (#661)` — red/green together: `seedNotificationScenario` calls `onParentAgentStart` (the spawning tool call runs inside a parent turn) and the after-await test settles the run instead of advancing timers; the schedule-time-guard test is unchanged.
3. `docs(pi-subagents): document turn-boundary nudge delivery (#661)` — architecture module-tree entry for `notification.ts` and the matching `SKILL.md` Observation row.

Steps 1 and 2 touch the same behavior from different layers and must both be green before moving on; run `pnpm --filter @gotgenes/pi-subagents run test` and `pnpm run check` at each step, and `pnpm fallow dead-code` at the end of step 1.

Every commit in this plan carries the trailer below, separated from the body by a blank line, crediting the PR author who diagnosed the defect.

```text
Co-authored-by: daoguademeng <whumaple@gmail.com>
```

## Risks and Mitigations

| Risk                                                                     | Mitigation                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A nudge is stranded if `agent_settled` never fires (host crash mid-run). | `agent_settled` is emitted from a `finally` block, so it fires on error and abort; `dispose()` clears the map at session shutdown.                                                                       |
| Flushing from `agent_settled` re-enters the agent loop.                  | `_isAgentRunActive` is already `false` when extensions are notified, so the flush takes the ordinary `triggerTurn` path; `pi.sendMessage` is fire-and-forget, so the handler does not await the new run. |
| Removing the debounce exposes a consumption race on the idle path.       | All three `markConsumed()` sites run inside tool handlers, i.e. while streaming; the idle path has no reachable racing consumer. Measured: full suite green.                                             |
| Re-arranged tests silently stop pinning the race.                        | Step 1 includes an explicit mutation check — revert the gate, confirm the test fails.                                                                                                                    |
| A held record is retained until the turn ends.                           | The map holds completed records already retained by `SubagentManager` for the retention sweep (#617), so it adds no new lifetime.                                                                        |

## Open Questions

None blocking.
The `agent_start` hook is retained because `ExtensionAPI` exposes no streaming-state query; if Pi later surfaces `isIdle()` on `ExtensionAPI`, `parentStreaming` and its `agent_start` handler could be dropped in favor of a direct query, leaving only the `agent_settled` flush.

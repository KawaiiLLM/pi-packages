---
issue: 563
issue_title: "Status classification predicates are re-derived outside SubagentState"
---

# Add status classification predicates to `SubagentState`

## Release Recommendation

**Release:** ship independently

Phase 21 declares every step independently releasable and tags this step `Release: independent` — it is in no batch.
The change is a pure refactor (no behavior change), so it lands as `refactor:` (a hidden changelog type) and auto-batches into the next unhidden (`feat:`/`fix:`/`docs:`) release rather than cutting one on its own.

## Problem Statement

`SubagentState` owns all six status transitions (`markRunning`, `markCompleted`, …) but not what a status _means_.
Consumers re-derive three semantic groupings at ~11 sites across 8 files: is-active (`status === "running" || status === "queued"`), terminal-error (`status === "error" || status === "stopped" || status === "aborted"`), and running/steer eligibility (`status === "running"`).
None of these are compiler-enforced exhaustive switches, so adding a status (e.g. `"paused"`) means finding and editing every grouping — and a missed site diverges silently.
This is a repeated-discriminator smell (state classified outside its owning object); fallow is structurally blind to it because scattered one-line conditionals never form a token-run clone.

## Goals

- Add classification predicates as the single decision point for the three re-derived status groupings, owned by `subagent-state.ts`.
- Replace every re-derived multi-status grouping outside `subagent-state.ts` with a predicate call, reaching **0** residual groupings (the roadmap target is ≤ 2).
- Preserve behavior exactly — this is a refactor, not a behavior change, and not breaking.

## Non-Goals

- Per-status _presentation dispatch_ that maps a status to a label or renderer arm stays: `getStatusLabel`'s switch (notification.ts), `resolveStatusPresentation`'s icon/style/label mapping (renderer.ts), and the `result-renderer.ts` / `widget-renderer.ts` status→icon maps.
  Only the `isError` _classification_ inside `resolveStatusPresentation` moves to a predicate; its presentation mapping is untouched.
- `ERROR_STATUSES` (display.ts) is **not** unified with the terminal-error predicate.
  It is a widget-linger presentation grouping whose membership (`error`, `aborted`, `steered`, `stopped`) deliberately includes `steered` and excludes nothing terminal — a different semantic from `isTerminalError()` (`error`, `stopped`, `aborted`; excludes `steered`).
- Single-status checks that are genuine presentation or wait guards stay: the queued/started label (background-spawner.ts), the `wait`-on-promise `=== "running"` guard (get-result-tool.ts), the queued-abort branch (subagent-manager.ts `abort`/`abortAll`), and the per-status running/queued counting in `assembleWidgetState` / `categorizeAgents`' running and queued buckets.
- No change to `SubagentStatus` itself, the transition/accumulation methods, or Step 2 ([#466]) / Step 3 wiring.

## Background

- `src/lifecycle/subagent-state.ts` is the `SubagentState` value object extracted in a prior phase (full-value seeding landed in [#542]).
  It owns `_status` behind a getter and mutates it only via transition methods — the natural home for read-only status predicates.
- `src/lifecycle/subagent.ts` (`Subagent` class) holds one `SubagentState` privately and already delegates its getters (`get status()`, `get consumed()`, …) to it.
  `src/types.ts` re-exports the `Subagent` class, so record-holding consumers hold the class and can call instance methods.
- Consumers split into two shapes:
  - **Record holders** (hold the `Subagent` class): `subagent-manager.ts`, `get-result-tool.ts`, `subagent-events-observer.ts`, and `subagent.ts` internals.
    These call instance methods (`record.isActive()`).
  - **Status-value / DTO holders** (hold a `SubagentStatus` value on a methods-less DTO): `widget-renderer.ts` (`WidgetAgent`), `renderer.ts` (`NotificationDetails`), `session-navigation.ts` (`NavigableSubagent`).
    These call exported free functions (`isActiveStatus(status)`).
- Two DTO status fields are currently typed `string` — `NotificationDetails.status` and `WidgetAgent.status` — even though both are produced directly from `record.status` (a `SubagentStatus`).
  The operator elected to tighten these to `SubagentStatus` so their groupings route through the shared predicates too (reaching 0 residual rather than the roadmap's ≤ 2).
  `AgentReport.status` and `NavigableSubagent.status` are already `SubagentStatus`.
  `AgentDetails.status` (display.ts) carries an extra `"background"` variant and is **not** touched — no `WidgetAgent`/`NotificationDetails` producer ever emits `"background"`, so the tightening is type-safe.
- AGENTS.md / architecture conventions: the roadmap step-mark (✅ + `Landed:` note + Mermaid node) and the health-metrics row are landed by `/tdd-plan` at implementation completion (Refs #540), listed below as expected doc updates.

## Design Overview

### Predicate surface (single decision point in `subagent-state.ts`)

Module-level free functions over `SubagentStatus` are the single source of truth; instance methods delegate to them, and `Subagent` re-delegates for record holders.

```typescript
// subagent-state.ts — exported free functions (for DTO / status-value consumers)
export function isActiveStatus(status: SubagentStatus): boolean {
	return status === "running" || status === "queued";
}
export function isTerminalErrorStatus(status: SubagentStatus): boolean {
	return status === "error" || status === "stopped" || status === "aborted";
}
export function isRunningStatus(status: SubagentStatus): boolean {
	return status === "running";
}

// SubagentState — instance predicates delegate to the free functions
isActive(): boolean { return isActiveStatus(this._status); }
isTerminalError(): boolean { return isTerminalErrorStatus(this._status); }
isRunning(): boolean { return isRunningStatus(this._status); }
canBeSteered(): boolean { return isRunningStatus(this._status); }
```

`canBeSteered()` and `isRunning()` currently share `isRunningStatus`, per the operator's decision to keep both: `canBeSteered()` reads as steer-intent at the steer call site, `isRunning()` as neutral state at the abort and live-streaming sites.
They delegate to one predicate so the decision has a single home and can diverge later (e.g. if steering gains a session-ready precondition) without touching the abort/streaming callers.

`Subagent` gains four one-line delegating methods mirroring its existing getter-delegation pattern:

```typescript
// subagent.ts
isActive(): boolean { return this.state.isActive(); }
isTerminalError(): boolean { return this.state.isTerminalError(); }
isRunning(): boolean { return this.state.isRunning(); }
canBeSteered(): boolean { return this.state.canBeSteered(); }
```

Only `isActiveStatus`, `isTerminalErrorStatus`, and `isRunningStatus` are **exported** — each has at least one DTO caller (widget-renderer, renderer, session-navigation respectively), so none is a speculative export fallow would flag.
`canBeSteered()` needs no free function (no DTO steer site).

### Consumer call sites

Record holders read as `record.isActive()` — Tell-Don't-Ask, no reach-through:

```typescript
// subagent-manager.ts sweep — before
if (record.status === "running" || record.status === "queued") continue;
// after
if (record.isActive()) continue;
```

DTO holders call the free function on the status value they already carry:

```typescript
// widget-renderer.ts categorizeAgents — before
finished: agents.filter(a => a.status !== "running" && a.status !== "queued" && a.completedAt != null && shouldShowFinished(...))
// after
finished: agents.filter(a => !isActiveStatus(a.status) && a.completedAt != null && shouldShowFinished(...))
```

### DTO tightening ripple

Tightening `NotificationDetails.status` and `WidgetAgent.status` from `string` to `SubagentStatus`:

- `NotificationDetails.status` producers are `record.status` (safe).
  Its only classification consumer is `resolveStatusPresentation(status)` (renderer.ts), whose parameter tightens to `SubagentStatus` and whose `isError` line becomes `isTerminalErrorStatus(status)`.
  `getStatusLabel` is called with `record.status` (already `SubagentStatus`), not the DTO field, so it needs no change.
- `WidgetAgent.status` producer is `toWidgetAgent` (`status: record.status`, safe).
  `categorizeAgents`' finished filter becomes `!isActiveStatus(a.status)`; its running/queued buckets keep single-status `=== "running"` / `=== "queued"` (presentation).
  The `shouldShowFinished: (agentId, status: string)` callback chain is unaffected — `SubagentStatus` is assignable to the `string` parameter, and `ERROR_STATUSES.has(status)` still accepts it.

## Module-Level Changes

- `src/lifecycle/subagent-state.ts` — add exported `isActiveStatus` / `isTerminalErrorStatus` / `isRunningStatus`; add instance methods `isActive()` / `isTerminalError()` / `isRunning()` / `canBeSteered()` delegating to them.
- `src/lifecycle/subagent.ts` — add four delegating methods (`isActive`, `isTerminalError`, `isRunning`, `canBeSteered`); convert `guardedRun` (`!this.isActive()`), `steer` (`!this.canBeSteered()`), `abort` (`!this.isRunning()`).
- `src/lifecycle/subagent-manager.ts` — convert the four `running || queued` groupings (`sweep`, `clearCompleted`, `hasRunning`, `pendingPromises`) to `record.isActive()`.
  Leave the single-status `=== "queued"` abort branches in `abort`/`abortAll`.
- `src/tools/get-result-tool.ts` — convert the `!== "running" && !== "queued"` mark-consumed guard to `!record.isActive()`.
  Leave the `wait && record.status === "running"` promise-wait guard.
- `src/observation/subagent-events-observer.ts` — convert the terminal-error grouping in `onSubagentCompleted` to `record.isTerminalError()`.
- `src/observation/renderer.ts` — tighten `resolveStatusPresentation(status: SubagentStatus)`; convert its `isError` line to `isTerminalErrorStatus(status)`; keep the icon/style/label mapping.
- `src/observation/notification.ts` — tighten `NotificationDetails.status` to `SubagentStatus`.
- `src/ui/widget-renderer.ts` — tighten `WidgetAgent.status` to `SubagentStatus`; convert `categorizeAgents`' finished filter to `!isActiveStatus(a.status)`.
- `src/ui/session-navigation.ts` — convert `liveSource`'s streaming `=== "running"` to `isRunningStatus(record.status)`.
- `docs/architecture/architecture.md` — mark Phase 21 Step 1 complete (✅ heading + `Landed:` note + Mermaid `S1` node), and update the health-metrics row "Multi-status classification groupings outside `subagent-state.ts`" from `11 → ≤ 2` actual to `0`.
  Landed by `/tdd-plan` at implementation completion (Refs #540).

Grep confirms no other `src/`, `test/`, `.pi/skills/package-*`, or `docs/` references need updating: the `isActive()` / `status === "running" || status === "queued"` strings in `improvement-discovery` and `code-design` skills are generic teaching exemplars, not references to this package's code, and stay.
`README.md` documents no status grouping.

## Test Impact Analysis

1. **New unit tests enabled by the extraction** — `test/lifecycle/subagent-state.test.ts` gains table-driven coverage of the three exported free functions and the four instance methods across all seven statuses.
   These are new lower-level tests that were previously impossible (the groupings lived inline in consumers, testable only through each consumer's behavior).
2. **Redundant tests** — none become redundant.
   The consumer tests (`subagent-manager.test.ts`, `agent-widget.test.ts`, `widget-renderer.test.ts`, get-result / observer / session-navigation suites) assert _behavior_ (which agents are swept, which are categorized finished), not the literal grouping, so they stay green unchanged and continue to guard the refactor.
3. **Tests that must change** — `test/observation/renderer.test.ts` currently asserts `resolveStatusPresentation("unknown")`; tightening the parameter to `SubagentStatus` makes `"unknown"` a type error.
   Remove that case — it exercised an out-of-domain fallback that the tightened type makes unreachable; the success default is already covered by the `"completed"` and `"steered"` cases.

## Invariants at risk

- **`SubagentState` transition semantics** ([#542] full-value seeding, prior extraction) — the predicates are pure reads over `_status` and touch no transition or accumulation method.
  Existing `SubagentState` transition tests (`markRunning`, `markCompleted`, `markStopped`, `resetForResume`, …) pin these and must stay green.
- **`ERROR_STATUSES` linger membership** — the widget's error-linger set includes `steered`; `isTerminalError()` does not.
  Not unifying them is deliberate; `widget-renderer` / `agent-widget` linger tests pin the linger behavior.
- **`abort` on a queued agent** — `Subagent.abort()` guards on running only (a queued agent is stopped by the manager); `!this.isRunning()` preserves this exactly.
  `subagent-manager.test.ts` abort/abort-while-queued cases pin it.

## TDD Order

1. **Add the predicate surface** (`test:` red → `refactor:` green, one commit `refactor(pi-subagents): add status classification predicates to SubagentState`).
   Red: `subagent-state.test.ts` asserts the three free functions and four instance methods return correct booleans across all seven statuses (fails to compile / resolve).
   Green: implement the free functions + `SubagentState` methods + `Subagent` delegating methods.
   Pure addition — nothing else breaks; run `pnpm run check`.
2. **Convert record-holding consumers** (`refactor(pi-subagents): replace re-derived status groupings with predicates`).
   Convert `subagent-manager.ts` ×4, `get-result-tool.ts`, `subagent.ts` (`guardedRun`/`steer`/`abort`), `subagent-events-observer.ts`, and `session-navigation.ts` (`isRunningStatus` free function).
   No new test — the existing suite pins behavior; run the full suite.
3. **Tighten presentation DTOs and route their groupings through predicates** (`refactor(pi-subagents): type presentation status DTOs through classification predicates`).
   Tighten `NotificationDetails.status` and `WidgetAgent.status` to `SubagentStatus`; tighten `resolveStatusPresentation`'s parameter; convert its `isError` and `categorizeAgents`' finished filter to the free functions; remove the `resolveStatusPresentation("unknown")` test case.
   Run `pnpm run check` (interface change) + full suite.
4. **Land the architecture-doc step-mark** (`docs(pi-subagents): mark Phase 21 Step 1 complete`).
   Add the ✅ heading + `Landed:` note + Mermaid `S1` node; update the health-metrics grouping row to `0`.

## Risks and Mitigations

- **Silent behavior drift during conversion** — a mistyped predicate (e.g. `isTerminalError` including `steered`) changes classification.
  Mitigation: Step 1's table-driven tests fix the exact membership before any consumer is converted; the unchanged consumer suites catch a wrong swap.
- **DTO-tighten ripple wider than expected** — a hidden `WidgetAgent`/`NotificationDetails` producer emitting a non-`SubagentStatus` string.
  Mitigation: both fields are produced solely from `record.status`; `pnpm run check` after Step 3 surfaces any stray producer at compile time.
- **Over-conversion of presentation dispatch** — converting a legitimate per-status label/icon map.
  Mitigation: Non-Goals enumerates every guard/switch that stays; the health-metric grep (`status [!=]== "…" (||\|&&)`) confirms only multi-status groupings are targeted.

## Open Questions

None — the predicate API (both `canBeSteered()` and `isRunning()`) and the DTO-tightening scope (reach 0 residual) were confirmed with the operator during planning.

[#466]: https://github.com/gotgenes/pi-packages/issues/466
[#542]: https://github.com/gotgenes/pi-packages/issues/542

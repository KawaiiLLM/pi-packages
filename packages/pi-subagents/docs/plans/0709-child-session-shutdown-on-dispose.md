---
issue: 709
issue_title: "pi-subagents: child disposal skips session_shutdown and leaks extension-owned processes"
---

# Emit `session_shutdown` before disposing a child session

## Release Recommendation

**Release:** ship independently

Issue [#709] is not a numbered step in the `docs/architecture/architecture.md` roadmap, so it carries no `Release:` batch tag.
It is a standalone lifecycle-contract fix that resource-leaking users should get as soon as it lands.

## Problem Statement

A child session created by `createSubagentSession` calls `session.bindExtensions({})`, which fires `session_start` and lets every inherited extension initialize.
When the child is torn down, `SubagentSession.dispose()` calls Pi's `AgentSession.dispose()` directly.
That method aborts the agent and calls `_extensionRunner.invalidate(...)` — it never emits `session_shutdown`.
Only `AgentSessionRuntime.dispose()` / `teardownCurrent()` emit the event, and pi-subagents does not use that runtime path.

The result is an asymmetric lifecycle: every child extension gets an `init` and a `session_start`, and none ever gets a `session_shutdown`.
An extension that releases resources from its shutdown handler therefore never releases them.
The reporter's concrete case is `pi-mcp-adapter@2.20.1`, which closes its FastCtx stdio server from `session_shutdown`: after 24 completed children, 25 FastCtx process pairs remained under the parent (the parent's own pair plus one per child), holding roughly 221 MB RSS.

This is a contract bug, not a tuning problem.
Issue [#696]'s `excludedExtensionPackages` setting is a workaround with a different failure mode — excluding `pi-mcp-adapter` from children also removes the child's MCP tools — and the [#696] plan already names [#709] as out of its scope.

## Goals

- Every child session that fired `session_start` receives exactly one `session_shutdown` (`reason: "quit"`), awaited, **before** its `AgentSession` is disposed and its extension runner invalidated.
- The shutdown emission is bounded: a child extension whose shutdown handler never resolves cannot stall the parent's teardown or Pi's exit indefinitely.
- Every teardown path that can await does await: parent `session_shutdown`, `session_start` / `session_before_switch` clear-completed, and the assembly factory's post-creation failure path.
- Disposal stays idempotent: a second `dispose()` on the same `SubagentSession` emits nothing and disposes nothing twice.
- The change is a `fix:`, released with a prominent behavior-change note — extensions with a `session_shutdown` handler now run it once per child, which they never did before.

## Non-Goals

- **No change to session-retention timing.**
  A completed child's session is still held for the [#617] retention window (10 min consumed / 720 min unconsumed) and released by the sweep.
  Shutting extensions down at completion instead of disposal would break resume, since the session outlives the run by design.
  The fix is tied to disposal, which is the correct seam.
- **No upstream Pi change and no companion upstream issue.**
  `emitSessionShutdownEvent` is not exported from `@earendil-works/pi-coding-agent` on the pinned version or on Pi's `main`, so this plan replicates its three lines against the public `AgentSession.hasExtensionHandlers` / `AgentSession.extensionRunner` surface.
- **No adoption of `AgentSessionRuntime` for children.**
  Its `dispose()` would emit the event for us, but the runtime also owns session replacement, UI context, and the `/new`, `/fork`, `/resume` flows a child never uses.
  Considered and rejected as disproportionate.
- **No configurable shutdown timeout.**
  The bound is a module constant, not a `subagents.json` key — no settings schema, `/subagents:settings` menu entry, or README setting section.
- **No change to the child-lifecycle event contract** (`subagents:child:*`).
  No new channel is added; `disposed` keeps its current payload and its current position after `session.dispose()`.
- **No change to `abortAll`, interrupt policy, or the notification/nudge path.**

## Background

Relevant modules and the facts verified against the pinned SDK (`@earendil-works/pi-coding-agent@0.80.5`, peer range `>=0.80.5`):

| Fact                                                                                                | Location                                                                         |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Child binds the full extension set; `session_start` fires                                           | `src/lifecycle/create-subagent-session.ts:247`                                   |
| Child teardown calls `AgentSession.dispose()` directly                                              | `src/lifecycle/subagent-session.ts:194`                                          |
| `AgentSession.dispose()` aborts, then `_extensionRunner.invalidate(...)`; no shutdown emit          | `dist/core/agent-session.js:540`                                                 |
| Only the runtime emits shutdown                                                                     | `dist/core/agent-session-runtime.js:103` (`teardownCurrent`), `:283` (`dispose`) |
| `emitSessionShutdownEvent` is module-private, not re-exported from the package entry                | `dist/index.d.ts`; same on Pi `main`                                             |
| `AgentSession.hasExtensionHandlers(eventType): boolean` is public                                   | `dist/core/agent-session.d.ts:618`                                               |
| `get extensionRunner(): ExtensionRunner` is public                                                  | `dist/core/agent-session.d.ts:622`                                               |
| `ExtensionRunner.emit` accepts `SessionShutdownEvent` (not in the `RunnerEmitEvent` exclusion list) | `dist/core/extensions/runner.d.ts:22`, `:141`                                    |
| `emit` catches each handler's **errors** per handler and routes them to `emitError`                 | `dist/core/extensions/runner.js:539`                                             |
| `emit` does **not** bound a handler that hangs                                                      | same                                                                             |
| Every `ctx` accessor calls `assertActive()` and throws once the runner is invalidated               | `dist/core/extensions/runner.js:420`, `:323`                                     |
| `SessionShutdownEvent.reason` is `"quit" \| "reload" \| "new" \| "resume" \| "fork"`                | `dist/core/extensions/types.d.ts:453`                                            |
| `ExtensionHandler` may return `Promise<void>`, and Pi awaits it                                     | `dist/core/extensions/types.d.ts:835`                                            |

The ordering constraint follows directly: because `invalidate()` makes every `ctx` getter throw, the emit must be **awaited to completion before** `session.dispose()` runs.
A fire-and-forget emit followed by a synchronous `dispose()` would hand every shutdown handler a stale context.

Cross-package check: `@gotgenes/pi-permission-system` already anticipates this event firing in a child.
`src/authority/subagent-registry.ts:41` and `src/authority/serving-registry.ts:93` both document that their process-global stores have no teardown hook precisely so that "a child's `session_shutdown` must not be able to wipe the parent's registrations."
Its `SessionLifecycleHandler.handleSessionShutdown` (`src/handlers/lifecycle.ts:117`) clears only its own session's state.

Constraints from `AGENTS.md` and the `package-pi-subagents` skill that apply:

- Read Pi internals from the sibling `../pi` checkout for mechanism, but confirm any API designed around exists in the **installed** version — done above, against `0.80.5`.
- pi-subagents is a minimal core with dependency arrows pointing inward; this change adds no knowledge of any consumer.
- `eslint.config.js` enables `tseslint.configs.recommendedTypeCheckedOnly`, so `no-floating-promises` and `no-misused-promises` are active: every deliberate fire-and-forget needs an explicit `void` and a `.catch()`.

## Design Overview

### New module: `src/lifecycle/child-shutdown.ts`

One narrow, independently testable collaborator owns the emit and its bound.
It declares its own structural seam rather than importing `AgentSession`, so the emitter reads only what it uses (ISP) and tests need no SDK cast.

```typescript
/** Narrow session seam — only what child shutdown reads. */
export interface ShutdownCapableSession {
  hasExtensionHandlers?(eventType: string): boolean;
  readonly extensionRunner?: {
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
}

/** Upper bound on how long a child's shutdown handlers may take. */
export const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Emit one `session_shutdown` on a child's extension runner and await it,
 * bounded by `timeoutMs`. Never throws: an absent runner, a handler-set miss,
 * a rejected emit, and a timeout all resolve quietly (debug-logged).
 */
export async function emitChildSessionShutdown(
  session: ShutdownCapableSession,
  timeoutMs?: number,
): Promise<void>;
```

Both seam members are optional because the emitter must stay safe against a Pi build that predates them and against a test double that omits them; the emitter treats either absence as "nothing to emit."
The timeout is implemented with `Promise.race` against a `setTimeout` that is always cleared in a `finally`, so a fast shutdown never leaves a pending timer holding the event loop.

Call site in `SubagentSession`:

```typescript
async dispose(): Promise<void> {
  if (this.disposed) return;
  this.disposed = true;
  await emitChildSessionShutdown(this._session);
  this._session.dispose?.();
  this.meta.lifecycle.disposed({ sessionId: this.meta.sessionId });
}
```

Three orderings are deliberate:

1. **Emit before `session.dispose()`** — forced by `invalidate()`, as established above.
2. **`lifecycle.disposed` stays last** — it is what unregisters the child from the permission system's `SubagentSessionRegistry`.
   Keeping it after the emit means a shutdown handler that still needs a permission decision resolves against a live registration, exactly as during the run.
3. **The `disposed` guard is set before the first `await`** — so a concurrent second `dispose()` (sweep tick racing a manager teardown) returns immediately rather than emitting twice.

### Async propagation

The emit must be awaited, and every current caller is synchronous, so the promise propagates up the teardown chain.
The chain is awaited wherever a caller can await and explicitly fire-and-forget only in the one place that cannot.

```text
SubagentSession.dispose()            → Promise<void>   (awaits the emit)
  ← Subagent.disposeSession()        → Promise<void>
  ← Subagent.releaseSession()        → Promise<void>
      ← SubagentManager.sweep()      stays sync: void promise.catch(debugLog)   [setInterval]
  ← SubagentManager.removeRecord()   → Promise<void>
      ← SubagentManager.clearCompleted() → Promise<void>
  ← SubagentManager.dispose()        → Promise<void>
      ← SessionLifecycleHandler.handleSessionShutdown()   already async — awaits
      ← SessionLifecycleHandler.handleSessionStart()      → Promise<void>
      ← SessionLifecycleHandler.handleSessionBeforeSwitch() → Promise<void>
  ← createSubagentSession() bind-failure path            already async — awaits
```

`index.ts` needs no edit: its handlers are already expression-bodied arrows that return the handler's value, and `ExtensionHandler` permits a `Promise<void>` return that Pi awaits.

Two state-ordering details keep the async versions safe against re-entry:

- `Subagent.releaseSession()` captures the session, then clears `subagentSession` and sets `_sessionReleased` / `_releasedOutputFile` **synchronously**, and only then awaits `session.dispose()` on the captured local.
  Otherwise a sweep tick one minute later would see a still-populated field and start a second teardown while the first is mid-await.
- `SubagentManager.dispose()` and `removeRecord()` mutate `this.agents` synchronously and collect the dispose promises, awaiting `Promise.allSettled` at the end.
  A rejected teardown must not abandon the remaining children.

`sweep()` stays a synchronous function so `setInterval(() => this.sweep(), 60_000)` does not trip `no-misused-promises`; the fire-and-forget lives on the one statement inside it.

### Behavior change for extension authors

After this change, an extension loaded into children runs its `session_shutdown` handler once per child in addition to once for the parent.
Handlers that flush a log, write an audit summary, or close a shared resource will now do so per child.
This is the documented contract being honored rather than a new obligation, but it is observable on upgrade, so it is called out in the README, the commit body, and the changelog entry.

## Module-Level Changes

### Source

| File                                       | Change                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lifecycle/child-shutdown.ts`          | **New.** `ShutdownCapableSession` seam, `CHILD_SHUTDOWN_TIMEOUT_MS`, `emitChildSessionShutdown()` with the race-and-clear timeout and the never-throw contract.                                                                                                                                                                                          |
| `src/lifecycle/subagent-session.ts`        | `dispose()` becomes `async` and returns `Promise<void>`; adds a private `disposed` re-entry guard; calls `emitChildSessionShutdown` before `this._session.dispose?.()`; doc comment updated from "session.dispose() + emit `disposed`" to name the shutdown emission and its ordering.                                                                   |
| `src/lifecycle/subagent.ts`                | `disposeSession()` and `releaseSession()` return `Promise<void>`; `releaseSession()` clears its fields before awaiting the captured session's teardown.                                                                                                                                                                                                  |
| `src/lifecycle/subagent-manager.ts`        | `removeRecord()`, `clearCompleted()`, and `dispose()` return `Promise<void>` and await `Promise.allSettled` over collected teardowns after synchronously mutating `this.agents`; `sweep()` stays sync with `void record.releaseSession().catch(…)`.                                                                                                      |
| `src/lifecycle/create-subagent-session.ts` | Bind-failure catch path becomes `await subagentSession.dispose();`.                                                                                                                                                                                                                                                                                      |
| `src/handlers/lifecycle.ts`                | `LifecycleManager.clearCompleted()` and `.dispose()` typed `Promise<void>`; `handleSessionStart` and `handleSessionBeforeSwitch` become `async` and return the clear-completed promise; `handleSessionShutdown` awaits `this.manager.dispose()`; the numbered cleanup-order comment gains a note that step 5 now awaits each child's `session_shutdown`. |

`src/index.ts` is verified unchanged: the three `pi.on(...)` arrows already return their handler's value.
`src/service/service.ts` and `src/service/service-adapter.ts` are verified unchanged — neither exposes `dispose`, `clearCompleted`, nor `releaseSession`, so the published `dist/public.d.ts` surface does not move and `verify:public-types` needs no new expectation.

Grep evidence for the touch list: `disposeSession|releaseSession` across `src/` matches only `subagent.ts` and `subagent-manager.ts`; `clearCompleted|abortAll|removeRecord` across `src/` outside the manager matches only `handlers/lifecycle.ts` and `handlers/interrupt.ts` (the latter uses `abortAll`, untouched); `extensionRunner|hasExtensionHandlers` has no existing match anywhere in `packages/*/src`, so this is a new SDK surface for the monorepo.

### Tests

| File                                             | Change                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/lifecycle/child-shutdown.test.ts`          | **New.** Unit tests for the emitter (see TDD Order step 1).                                                                                                                               |
| `test/helpers/mock-session.ts`                   | `MockSession` gains `hasExtensionHandlers` and an `extensionRunner` stub with an `emit` spy; `createSubagentSessionStub`'s `dispose` becomes an async spy delegating to the mock session. |
| `test/helpers/mock-session.test.ts`              | Companion assertions for the new stub members.                                                                                                                                            |
| `test/lifecycle/subagent-session.test.ts`        | Local `createSession` helper gains the runner stub; new `dispose` describe block.                                                                                                         |
| `test/lifecycle/subagent.test.ts`                | The existing `disposeSession` / `releaseSession` describes (lines 469-531) await the now-async methods.                                                                                   |
| `test/lifecycle/subagent-manager.test.ts`        | `clearCompleted` / `dispose` call sites await; the retention-sweep spy assertions (lines 326-327) keep asserting on `releaseSession` calls, not their resolution.                         |
| `test/handlers/lifecycle.test.ts`                | `handleSessionStart` / `handleSessionBeforeSwitch` call sites await; the narrow manager stub returns resolved promises.                                                                   |
| `test/lifecycle/create-subagent-session.test.ts` | Bind-failure test asserts the shutdown emit happens before `session.dispose()`.                                                                                                           |

`test/helpers/subagent-session-io.ts`'s `createFactorySession` spreads `createMockSession()`, so it inherits the new members with no edit of its own.

### Docs

| File                                                      | Change                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/docs/architecture/architecture.md` | Module-layout tree: add `child-shutdown.ts    bounded session_shutdown emit for a child session being disposed` under `lifecycle/`; amend the `subagent-session.ts` line from "turn loop, steer, dispose" to name the shutdown-then-dispose teardown.                                                                                     |
| `.pi/skills/package-pi-subagents/SKILL.md`                | Lifecycle domain row: add `child-shutdown.ts` to the module list, bump the count 13 → 14, and extend the responsibility text with "child extension shutdown on disposal".                                                                                                                                                                 |
| `packages/pi-subagents/README.md`                         | New `### Child session lifecycle` subsection near "Excluding package extensions from children", stating that a child fires `session_start` at bind and one `session_shutdown` (`reason: "quit"`) at disposal, that handlers are bounded, and that an extension's shutdown handler now runs once per child as well as once for the parent. |

Doc-grep sweep performed at planning time: `session_shutdown` across `packages/pi-subagents/docs/` matches only `docs/plans/`, `docs/retro/`, `docs/decisions/0004-*`, `docs/architecture/architecture.md:366`, and `docs/architecture/history/phase-5-*`.
The two architecture matches are the `handlers/lifecycle.ts` tree line, which describes the parent's handler set and stays accurate; history files are frozen.
`packages/pi-subagents/README.md` has no current `session_shutdown` mention, so the subsection is an addition, not an edit.
No exported symbol is removed or renamed, so no wider removal grep is required.

## Test Impact Analysis

1. **New tests the extraction enables.**
   `emitChildSessionShutdown` in its own module makes four previously impractical cases directly unit-testable: the handler-set miss (no emit at all), the missing-`extensionRunner` fallback, the rejected `emit` (swallowed), and the never-settling `emit` (resolves at the bound, with the timer cleared).
   Testing these through `SubagentSession.dispose()` alone would require driving fake timers through the whole session wrapper.
2. **Tests that become redundant.**
   None.
   Existing `dispose` coverage asserts the `disposed` lifecycle event and `session.dispose()` delegation, which remain the contract; the new tests add an ordering assertion rather than replacing one.
3. **Tests that must stay as-is.**
   `test/lifecycle/subagent.test.ts:519` ("disposeSession after release is a no-op") and `:530` (release on a session-less record) pin `Subagent`'s own guards, which are distinct from `SubagentSession`'s new re-entry guard — both layers need their own test.
   `test/lifecycle/subagent-manager.test.ts:326-327`'s retention spies pin the [#617] sweep policy and must keep asserting on call counts, unaffected by the promise return.

## Invariants at risk

| Invariant                                                                                                                                         | Origin                              | Pinned by                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| An excluded package's extension never loads in a child, so it registers no `session_shutdown` handler and the new emit reaches nothing extra      | [#696]                              | `test/session/package-exclusions.test.ts`                                           |
| Retention timing is unchanged: a terminal agent releases on the consumed/unconsumed window, measured from the later of completion and consumption | [#617]                              | `test/lifecycle/subagent-manager.test.ts` retention-sweep describe                  |
| `subagents:child:session-created` fires **before** `bindExtensions()`, and `subagents:child:disposed` fires **after** `session.dispose()`         | ADR-0002 / child-lifecycle contract | `test/lifecycle/child-lifecycle.test.ts`, `test/lifecycle/subagent-session.test.ts` |
| Parent shutdown cleanup order: unpublish service → clear context → dispose notifications → `abortAll` → dispose manager                           | [#674]                              | `test/handlers/lifecycle.test.ts` `handleSessionShutdown` describe                  |
| A terminal-while-queued agent's nudge is delivered before notifications are disposed at shutdown                                                  | [#674]                              | `test/observation/notification.test.ts`                                             |

The ordering invariant in row 3 is the one this change moves closest to: the new emit lands between `bindExtensions`-time registration and the `disposed` event.
Step 3's ordering test asserts the exact sequence (`emit` → `session.dispose` → `lifecycle.disposed`) with a shared call-order recorder, so a later reordering fails rather than passing silently.

Quantitative baselines are deliberately **not** claimed here.
The reporter's 25-pair / 221 MB figures are their measurement, not one reproduced in this repo, and reproducing them requires a configured stdio MCP server.
The verifiable assertion this plan does make is deterministic and test-level: exactly one `session_shutdown` per disposed child, emitted before the runner is invalidated.

## TDD Order

1. **`test/lifecycle/child-shutdown.test.ts` — the bounded emitter.**
   Red: emits `{ type: "session_shutdown", reason: "quit" }` once when `hasExtensionHandlers("session_shutdown")` is true; emits nothing when it is false; resolves quietly when `extensionRunner` is absent; swallows a rejected `emit`; resolves at the bound with fake timers when `emit` never settles, and leaves no pending timer.
   Green: add `src/lifecycle/child-shutdown.ts`.
   Commit: `fix(pi-subagents): add bounded child session_shutdown emitter`.

2. **Test-helper prep — extension-runner stubs.**
   Extend `test/helpers/mock-session.ts` (`hasExtensionHandlers`, `extensionRunner.emit` spy) and `test/helpers/mock-session.test.ts`.
   No production change; the suite stays green.
   Commit: `test(pi-subagents): stub the extension runner on session mocks`.

3. **`SubagentSession.dispose()` emits before disposing.**
   Red (in `test/lifecycle/subagent-session.test.ts`): a shared call-order recorder asserts `emit` → `session.dispose` → `lifecycle.disposed`; a second `dispose()` emits nothing and does not re-dispose; a session with no shutdown handlers still disposes and still emits `disposed`.
   Green: `dispose()` becomes `async` with the `disposed` guard, and `create-subagent-session.ts`'s bind-failure path awaits it (its test asserts the same ordering).
   `Subagent.disposeSession` / `releaseSession` adapt with an explicit `void promise.catch(debugLog)` in this step only — the awaits arrive in step 4.
   Commit: `fix(pi-subagents): emit session_shutdown before disposing a child session`.

4. **`Subagent` teardown returns its promise.**
   Red: `disposeSession()` and `releaseSession()` resolve only after the child's shutdown emit settles; `releaseSession()` clears `subagentSession` before awaiting, so a concurrent second call is a no-op.
   Green: both return `Promise<void>`; `subagent-manager.ts`'s three call sites adapt (sweep fire-and-forget with catch, the other two temporarily `void`).
   Commit: `fix(pi-subagents): await child session teardown in Subagent`.

5. **`SubagentManager` teardown returns its promise.**
   Red: `dispose()` and `clearCompleted()` resolve after every record's teardown; one rejecting teardown does not abandon the rest; the retention sweep still fires and still does not block the interval.
   Green: `removeRecord`, `clearCompleted`, `dispose` return `Promise<void>` with synchronous map mutation plus `Promise.allSettled`; `handlers/lifecycle.ts` adapts.
   Commit: `fix(pi-subagents): await child teardown across the manager`.

6. **`SessionLifecycleHandler` awaits the manager.**
   Red: `handleSessionShutdown()` resolves only after `manager.dispose()` settles, with the documented five-step order preserved; `handleSessionStart` and `handleSessionBeforeSwitch` resolve only after `clearCompleted()` settles.
   Green: widen `LifecycleManager` to promise-returning `clearCompleted`/`dispose`, make the two handlers `async`, await in the shutdown handler.
   Commit: `fix(pi-subagents): await manager teardown on session lifecycle events`.

7. **Docs.**
   Architecture module tree (new `child-shutdown.ts` line, amended `subagent-session.ts` line), `package-pi-subagents` skill Lifecycle row (module list + count 13 → 14), and the README `### Child session lifecycle` subsection with the per-child behavior-change note.
   Commit: `docs(pi-subagents): document the child session shutdown contract`.

The behavior-change note for the changelog rides on step 3's commit body — the commit that actually starts emitting the event.

## Risks and Mitigations

| Risk                                                                                                 | Mitigation                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A child extension's `session_shutdown` handler hangs and stalls Pi's exit                            | `CHILD_SHUTDOWN_TIMEOUT_MS` bounds each child's emit at 5 s; on expiry the emitter debug-logs and proceeds to `session.dispose()`.                                                                                                                         |
| An extension's shutdown handler throws in the child                                                  | Pi's `ExtensionRunner.emit` already catches per handler and routes to `emitError`; the emitter additionally wraps the whole call so a non-handler failure cannot break teardown.                                                                           |
| A shutdown handler runs per child and produces duplicate side effects (audit summaries, log flushes) | Documented in the README subsection, the step-3 commit body, and the changelog entry; this is the accepted cost of honoring the contract.                                                                                                                  |
| A child's shutdown handler wipes parent-scoped global state                                          | Verified safe for the one known consumer: `pi-permission-system`'s `SubagentSessionRegistry` and `ServingSessionRegistry` deliberately have no teardown hook for exactly this reason, and its `handleSessionShutdown` clears only its own session's state. |
| Emitting shutdown while the child's agent loop is still unwinding after `abortAll()`                 | Pre-existing at parent quit and identical to what Pi itself does in `AgentSessionRuntime.dispose()`; `AgentSession.dispose()` aborts the agent anyway. Not widened here.                                                                                   |
| A concurrent sweep tick and manager teardown both dispose the same session                           | Two guards: `SubagentSession`'s `disposed` flag set before the first `await`, and `Subagent.releaseSession()` clearing `subagentSession` synchronously before awaiting.                                                                                    |
| `no-floating-promises` / `no-misused-promises` findings from the newly async chain                   | Every fire-and-forget is an explicit `void promise.catch(debugLog)`; `sweep()` stays a sync function so the `setInterval` callback keeps returning `void`. Verified with `pnpm run lint` unpiped, counting `lint/` findings.                               |
| An older Pi build lacking `extensionRunner` / `hasExtensionHandlers`                                 | Both seam members are optional in `ShutdownCapableSession`; either absence resolves quietly with no emit and no throw.                                                                                                                                     |

## Open Questions

- Should a future change release the child session (and therefore its extensions) as soon as the agent's result is consumed, rather than waiting out the [#617] retention window?
  That would shorten the leak window further but trades away resume.
  Deferred; no issue filed, because this fix removes the unbounded leak and the retention window is already user-tunable.
- Whether Pi upstream should own the symmetric emit in `AgentSession.dispose()` (or in `bindExtensions`) so every embedder gets it.
  Deliberately not pursued in this issue.

[#617]: https://github.com/gotgenes/pi-packages/issues/617
[#674]: https://github.com/gotgenes/pi-packages/issues/674
[#696]: https://github.com/gotgenes/pi-packages/issues/696
[#709]: https://github.com/gotgenes/pi-packages/issues/709

---
issue: 664
issue_title: "pi-subagents: ESC (parent interrupt) aborts all background agents — should this be a policy setting?"
---

# `abortAllOnInterrupt` — make ESC's blast radius a policy setting

## Release Recommendation

**Release:** ship independently

This work is not a step in the Phase 15–21 roadmap in `docs/architecture/architecture.md`, so it carries no `Release: batch` tag.
It is a self-contained, additive `feat:` — a new settings key with a behavior-preserving default — that users can observe the moment it ships.
Issue [#676] (shortcut-driven stop UX) is the only related open issue, and the triage session recorded the two as independent and landable in either order.

## Problem Statement

`InterruptHandler` (`src/handlers/interrupt.ts`) latches the parent turn's `AbortSignal` and calls `manager.abortAll()` when it fires.
Pressing ESC to redirect the parent mid-sentence therefore also kills every background subagent, including long-running work the interrupt was never aimed at.

Background agents are presented as fire-and-forget ("You will be notified when this agent completes"), and a parent-turn interrupt expresses "stop what *you* are saying", not "stop all delegated work".
At the same time ESC-as-universal-stop is a defensible panic button that some users rely on.
That makes this policy, not a defect — so the answer is a setting, not a behavior change.

The design is @daoguademeng's, filed as issue #664 alongside an implementation on their fork.
The triage session (`docs/retro/0664-abort-all-on-interrupt-policy-setting.md`) recorded the operator's decision to accept the design and implement it in-repo, crediting the contributor with a `Co-authored-by:` trailer on every commit.

## Goals

- Add an `abortAllOnInterrupt` setting, defaulting to `true`, persisted alongside the existing numeric settings.
- `InterruptHandler` consults the policy **at abort time**, not at wiring time, so a mid-session settings change applies to the very next ESC.
- With `abortAllOnInterrupt: false`, ESC stops the parent and leaves background *and queued* subagents running.
- The setting is toggleable from `/subagents:settings` as a direct flip, with no input prompt.
- README documents that foreground agents abort on ESC regardless of this setting, and why.

This change is **not breaking**.
The default preserves current behavior exactly; no existing config, output shape, or public type changes.
The suggested commits are `feat:`/`docs:`, not `feat!:`.

## Non-Goals

- Shortcut-driven stop UX — a "stop all subagents" fast path and a per-agent picker on keys this package owns.
  That is [#676], which the triage session established is unreachable on ESC itself and needs its own bindings.
- Renaming the setting to a background-explicit key (e.g. `abortBackgroundAgentsOnInterrupt`).
  The operator chose to keep the name issue #664 proposes and document the foreground nuance instead.
- Splitting the policy into per-agent granularity (a per-spawn `abortOnInterrupt` flag).
  One global policy is what issue #664 asks for; nothing in the current UI could set a per-agent value.
- Changing `SubagentManager.abortAll()` semantics or adding a "spare running, drop queued" variant.
  The policy gates the whole call: `false` skips `abortAll()` entirely, so queued agents stay queued and start as slots free.
- Any change to the public `SubagentsService` surface or the `dist/` type bundles.
  `settings.ts` is internal; only `layered-settings.ts` is published, and it is untouched.
- Reading the contributor's fork branch during implementation.
  See Open Questions.

## Background

### The interrupt path today

`src/index.ts:152–154` wires the handler:

```typescript
const interrupt = new InterruptHandler(manager);
pi.on("turn_start", (_event, ctx) => interrupt.handleTurnStart(ctx));
```

`InterruptHandler.handleTurnStart` dedups by signal reference, detaches the previous listener, and attaches a one-shot `abort` listener that calls `this.manager.abortAll()`.
The handler's collaborator is already a narrow `InterruptManager { abortAll(): number }` interface, so the only thing missing is the policy.

`SubagentManager.abortAll()` (`src/lifecycle/subagent-manager.ts:313`) stops queued agents via `stopQueued()`, aborts the rest, then calls `this.limiter.clear()` to drop pending thunks.

### Measurement: foreground agents do not depend on this handler

Traced at planning time, not inferred:

- `spawnBackground` (`src/tools/background-spawner.ts:33`) passes **no** `signal` in its spawn options.
  `InterruptHandler` is the only thing that aborts a background agent on ESC.
- `runForeground` (`src/tools/foreground-runner.ts:84`) passes the tool's `signal` through `manager.spawnAndWait(...)`, and `Subagent.run()` wires it with `this.listeners.wireSignal(this.execution.signal, () => this.abort())` (`src/lifecycle/subagent.ts:247`).
  A foreground agent aborts itself on ESC through its own listener, independent of `InterruptHandler`.
- `AgentTool`'s resume path (`src/tools/agent-tool.ts:100`) likewise passes `signal` straight into `manager.resume(...)`.

So `abortAllOnInterrupt: false` spares background and queued agents only.
That is exactly the behavior the issue asks for, and it needs no background/foreground filtering in `abortAll()` — but it is a surprise worth documenting, since the key's name says "all".

### Settings shape

`SettingsManager` (`src/settings.ts`) owns five numeric values with a uniform lifecycle: a normalizing accessor pair, a `load()` branch, a `snapshot()` field, an `apply*()` method that ends in `saveAndNotify()`, and a `sanitize()` guard.
`loadLayeredSettings` merges global (`~/.pi/agent/subagents.json`) over project (`<cwd>/.pi/subagents.json`) with a caller-supplied `sanitize`.

`SubagentsSettingsHandler` (`src/ui/subagents-settings.ts`) is table-driven since [#540]: a `NUMERIC_SETTINGS` array of descriptors, each with `label`, `currentDisplay`, `inputTitle`, `inputDefault`, `minimum`, `validationMessage`, and `apply`.
`handle()` renders one select option per descriptor, matches the choice by `label` prefix, prompts for a value, validates, applies, and notifies.
Every current descriptor asks the user for a number — a boolean has no input step, which is the one structural gap this change has to close.

### Constraints from AGENTS.md and the skills

- `code-design` — Tell-Don't-Ask: the UI must not read the boolean, negate it, and write it back.
  The manager owns the flip.
- `code-design` — thread decisions, not discriminators: `InterruptHandler` should receive a resolved predicate, matching `new ConcurrencyLimiter(() => settings.maxConcurrent)` at `src/index.ts:116`, rather than a settings object it reaches into.
- Do not put `Closes #664` in any commit message; `/ship-issue` posts the close comment.
- Every implementation and docs commit ends with a blank line then `Co-authored-by: daoguademeng <whumaple@gmail.com>`.

## Design Overview

### Setting

```typescript
export interface SubagentsSettings {
  maxConcurrent?: number;
  defaultMaxTurns?: number;
  graceTurns?: number;
  consumedSessionRetentionMinutes?: number;
  unconsumedSessionRetentionMinutes?: number;
  /** When false, a parent interrupt (ESC) leaves background and queued subagents running. */
  abortAllOnInterrupt?: boolean;
}
```

`sanitize()` accepts it only when `typeof r.abortAllOnInterrupt === "boolean"` — no ceiling, no clamp, garbage becomes absent as with every other field.
`snapshot()` gains `abortAllOnInterrupt: boolean`, written on every save so a hand-edited global default is visible in the project file after any settings change.

`SettingsManager` gains a private `_abortAllOnInterrupt = DEFAULT_ABORT_ALL_ON_INTERRUPT` (`true`), a public getter, and one mutator:

```typescript
/** Flip the ESC policy, persist, and return the toast. The manager owns the negation. */
toggleAbortAllOnInterrupt(): { message: string; level: "info" | "warning" } {
  this._abortAllOnInterrupt = !this._abortAllOnInterrupt;
  return this.saveAndNotify(`Abort all subagents on ESC: ${this._abortAllOnInterrupt ? "on" : "off"}`);
}
```

No public setter and no `applyAbortAllOnInterrupt(value)`: a boolean needs no normalization, and a value-taking apply method would have no caller (`fallow dead-code` flags it).
`load()` writes the private field directly, as the numeric branches write through their normalizing setters.

### Interrupt policy

`InterruptHandler` takes a second, required constructor argument:

```typescript
constructor(
  private readonly manager: InterruptManager,
  private readonly shouldAbortAll: () => boolean,
) {}
```

and the one-shot listener becomes:

```typescript
const onAbort = (): void => {
  if (!this.shouldAbortAll()) return;
  this.manager.abortAll();
};
```

The predicate is called inside the listener, so the value read is the one in force when ESC fires — a mid-session toggle applies immediately with no re-wiring.
The handler stays ignorant of `SettingsManager` and of the key's name; it receives the decision, not the discriminator.

Call site (`src/index.ts`):

```typescript
const interrupt = new InterruptHandler(manager, () => settings.abortAllOnInterrupt);
```

The argument is required rather than defaulted: the single production call site is updated in the same commit, and a default of `() => true` would let a future wiring site silently opt out of the policy.

### Settings command: one table, two descriptor kinds

`NUMERIC_SETTINGS` becomes `SETTINGS`, a `readonly SettingDescriptor[]` over a discriminated union.
The shared fields — the two the select list needs — lift into a base:

```typescript
interface SettingDescriptorBase {
  label: string;
  currentDisplay: (settings: SubagentsSettingsManager) => string | number;
}

interface NumericSettingDescriptor extends SettingDescriptorBase {
  kind: "numeric";
  inputTitle: string;
  inputDefault: (settings: SubagentsSettingsManager) => string;
  minimum: number;
  validationMessage: string;
  apply: (settings: SubagentsSettingsManager, n: number) => SettingsToast;
}

interface ToggleSettingDescriptor extends SettingDescriptorBase {
  kind: "toggle";
  toggle: (settings: SubagentsSettingsManager) => SettingsToast;
}

type SettingDescriptor = NumericSettingDescriptor | ToggleSettingDescriptor;
```

`SettingsToast` is a local alias for the `{ message: string; level: "info" | "warning" }` shape the file already repeats seven times.

`handle()` keeps a single dispatch point:

```typescript
const descriptor = SETTINGS.find((d) => choice.startsWith(d.label));
if (!descriptor) return;
if (descriptor.kind === "toggle") {
  const toast = descriptor.toggle(this.settings);
  ui.notify(toast.message, toast.level);
  return;
}
// numeric path unchanged: input → parse → validate → apply → notify
```

The toggle descriptor:

```typescript
{
  kind: "toggle",
  label: "Abort all subagents on ESC",
  currentDisplay: (settings) => (settings.abortAllOnInterrupt ? "on" : "off"),
  toggle: (settings) => settings.toggleAbortAllOnInterrupt(),
}
```

It is appended last, after the two retention entries, so no existing option's position shifts.

The narrow `SubagentsSettingsManager` interface gains exactly what the new descriptor reads and calls — `readonly abortAllOnInterrupt: boolean` and `toggleAbortAllOnInterrupt()` — keeping the ISP boundary the file already maintains.

### Edge cases

| Case                                                     | Behavior                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Setting absent from both config files                    | Defaults to `true`; behavior identical to today.                                                                       |
| Non-boolean value on disk (`"false"`, `0`)               | Dropped by `sanitize()`; the default stands.                                                                           |
| Toggled off mid-turn, ESC pressed in the same turn       | Honored — the predicate runs inside the abort listener.                                                                |
| Toggled off, ESC pressed with a foreground agent running | Foreground agent still aborts (its own signal wiring); background and queued agents survive.                           |
| Toggled off, ESC pressed with agents queued              | Queue is left intact; queued agents start as slots free.                                                               |
| Project file write fails                                 | `saveAndNotify` downgrades the toast to `warning` with `(session only; failed to persist)`; the in-memory flip stands. |

## Module-Level Changes

### `src/settings.ts`

- Add `abortAllOnInterrupt?: boolean` to `SubagentsSettings` with a doc comment.
- Add `DEFAULT_ABORT_ALL_ON_INTERRUPT = true` beside the other default constants.
- Add the private field, public getter, and `toggleAbortAllOnInterrupt()`.
- `load()` — apply the field when the loaded value is a boolean.
- `snapshot()` — add `abortAllOnInterrupt: boolean` to both the return type and the object.
- `sanitize()` — accept the field when `typeof === "boolean"`.

### `src/handlers/interrupt.ts`

- Add the required `shouldAbortAll: () => boolean` constructor parameter.
- Guard `manager.abortAll()` on it inside the one-shot `onAbort` listener.
- Update the module doc comment: the handler applies a policy at abort time, it does not unconditionally abort.

### `src/index.ts`

- Pass `() => settings.abortAllOnInterrupt` to `new InterruptHandler(...)` (same commit as the signature change — the type checker rejects them apart).
- Update the `subagents:settings` command `description` string to mention the interrupt policy.
- Update the `// Abort all subagents when the parent agent loop is interrupted (ESC).` comment to reflect the policy gate.

### `src/ui/subagents-settings.ts`

- Add the `SettingsToast` alias and collapse the repeated inline `{ message; level }` shapes onto it.
- Split `NumericSettingDescriptor` into a base plus two `kind`-tagged members; rename `NUMERIC_SETTINGS` → `SETTINGS`.
- Append the `Abort all subagents on ESC` toggle descriptor.
- Dispatch on `descriptor.kind` in `handle()`.
- Extend `SubagentsSettingsManager` with `abortAllOnInterrupt` and `toggleAbortAllOnInterrupt()`.

### `packages/pi-subagents/README.md`

Grepped for every stale surface (`/subagents:settings`, "grace turns", "Persistent Settings", the defaults sentence):

- Commands table (line 232) — extend the `/subagents:settings` description.
- `### /subagents:settings` (line 237) — list the new toggle alongside the numeric settings.
- Persistent Settings intro (line 275) — add the toggle to the enumerated settings.
- Precedence/defaults sentence (line 288) — add `abort all on interrupt` default `true`.
- Add a short paragraph on what the setting does, including the foreground-agent nuance: a foreground agent holds the parent's run signal directly, so it aborts on ESC regardless of the setting; the policy governs background and queued agents.
- Optionally extend the global-defaults JSON example with `"abortAllOnInterrupt": false`.

### `packages/pi-subagents/docs/architecture/architecture.md`

Only the module-tree entry changes (current behavior, no issue ref — the module-tree convention in AGENTS.md):

- Line 362 — `interrupt.ts` entry: `turn_start handler — aborts subagents on parent interrupt (ESC) when policy allows`.
- Line 356 — `subagents-settings.ts` entry needs no change (still "/subagents:settings command handler").
- Line 295 — `settings.ts` entry needs no change.
- The Mermaid nodes at lines 85 and 383 reference the settings command generically; no change.

Greps run at planning time: `interrupt`/`ESC` across `README.md` and `docs/` (excluding `plans`/`retro`/`architecture/history`) matches only line 362 of the architecture doc and an unrelated `steer_subagent` sentence at README line 221.
`grep -rn "interrupt\|abortAll\|subagents.json" .pi/skills/` matches only `pi-extension-lifecycle/SKILL.md`, which documents Pi's own abort-signal lifecycle rather than this package's handler or settings keys.
No skill update is needed; re-run that grep before the docs commit.

## Test Impact Analysis

1. **New tests the change enables.**
   `InterruptHandler` gains its first policy tests: predicate `false` at abort time suppresses `abortAll()`; a predicate whose value changes between `handleTurnStart` and `abort` is read at abort time, not wiring time.
   `SettingsManager` gains boolean-field coverage in the existing sanitize/load/snapshot/apply describe blocks.
   `SubagentsSettingsHandler` gains its first non-numeric descriptor test: selecting the toggle calls `toggleAbortAllOnInterrupt()` and notifies **without** calling `ui.input`.
2. **Tests that become redundant.**
   None.
   Every existing test pins behavior that survives unchanged; the six `InterruptHandler` tests are edited only for the new constructor argument (a `() => true` stub), not replaced.
3. **Tests that must stay as-is.**
   The five existing `InterruptHandler` latch/re-wire/detach tests — they exercise signal bookkeeping, which the policy does not touch.
   The `subagents-settings` numeric-path tests — they pin that the input-prompt flow is unchanged by the union refactor.
   `test/settings.test.ts`'s existing `snapshot()` assertions — they must be extended, not rewritten, so a dropped numeric field would still fail.

## Invariants at risk

| Invariant                                                                         | Where it lives                                                                  | Pinned by                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESC still aborts every subagent by default                                        | This issue's core promise                                                       | New test: default-constructed settings + firing signal → `abortAll()` called once.                                                                                                                            |
| The abort listener stays one-shot and re-wires per run                            | `interrupt.ts` doc comment; [#540]-era tests                                    | Existing `latches only one listener…` and `re-wires to a new signal…` tests (unchanged).                                                                                                                      |
| A parent interrupt ends a `get_subagent_result` wait without cancelling the agent | [#662], `subagent.ts:340–347`                                                   | `test/lifecycle/subagent.test.ts:813` and `test/tools/get-result-tool.test.ts:131` — both drive the record's own signal path, not `InterruptHandler`, so they are unaffected. Run them explicitly to confirm. |
| Queued-stop still produces a completion notification                              | [#674]-adjacent; `test/observation/notification.test.ts:270` names the ESC path | That test drives `stopQueued()` directly; with the policy `true` (its default) the path is unchanged. Verify green.                                                                                           |
| `snapshot()` round-trips every persisted field                                    | `test/settings.test.ts` `snapshot()` block                                      | Extend the existing assertions with the new field rather than adding a separate test.                                                                                                                         |

## TDD Order

Every commit body ends with a blank line then `Co-authored-by: daoguademeng <whumaple@gmail.com>`.

1. **Persist the setting.**
   Red: `test/settings.test.ts` — `sanitize` accepts `true`/`false` and drops `"false"`/`0`/`null`; constructor default is `true`; `load()` applies a project/global boolean; `snapshot()` includes it; `toggleAbortAllOnInterrupt()` flips, persists, emits `subagents:settings_changed`, and returns the on/off toast; a failed write downgrades the toast.
   Green: the `src/settings.ts` changes above.
   Commit: `feat(pi-subagents): persist the abortAllOnInterrupt setting (#664)`.
2. **Gate the interrupt on the policy.**
   Red: `test/handlers/interrupt.test.ts` — a `() => false` predicate suppresses `abortAll()` when the signal fires; a `() => true` predicate preserves today's behavior; a mutable predicate flipped after `handleTurnStart` is honored at abort time.
   Existing tests get a `() => true` stub in `beforeEach`.
   Green: `src/handlers/interrupt.ts` plus the `src/index.ts` call site — one commit, since the required parameter breaks the call site at the type level.
   Commit: `feat(pi-subagents): gate ESC abort-all on the interrupt policy (#664)`.
3. **Toggle it from `/subagents:settings`.**
   Red: `test/ui/subagents-settings.test.ts` — the option list has six entries ending in `Abort all subagents on ESC (current: on)`; selecting it calls `toggleAbortAllOnInterrupt()` once, notifies with the returned toast, and never calls `ui.input`; `current: off` renders when the setting is false; the numeric paths still prompt.
   The local `makeSettings()` fixture gains `abortAllOnInterrupt` and a `toggleAbortAllOnInterrupt` mock.
   Green: the `src/ui/subagents-settings.ts` descriptor-union refactor and the new descriptor.
   Commit: `feat(pi-subagents): add the ESC abort-all toggle to /subagents:settings (#664)`.
4. **Document it.**
   No test cycle.
   README sections listed above, the architecture module-tree entry, and the `index.ts` command description.
   Commit: `docs(pi-subagents): document the abortAllOnInterrupt setting (#664)`.

Steps 1–3 are ordered by dependency: step 2's wiring reads the getter added in step 1, and step 3's descriptor calls the mutator added in step 1.

## Risks and Mitigations

| Risk                                                                                   | Mitigation                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A user reads "abort all" and expects a foreground agent to survive too                 | Document the foreground nuance in README and keep the settings label ESC-specific; the operator explicitly chose documentation over a rename.                            |
| Turning the policy off leaks long-running background agents a user has forgotten about | Out of scope here, but [#676]'s stop shortcuts are the deliberate alternative; the widget already shows live agents, and `session_shutdown` still aborts everything.     |
| The descriptor-union refactor silently breaks a numeric path                           | The existing numeric tests are untouched and must stay green; step 3 is red-first on the toggle only.                                                                    |
| `snapshot()` growth breaks a consumer of `subagents:settings_changed`                  | The payload is documented as "settings"; adding a field is additive, and no in-repo consumer destructures it. Re-verify with a repo-wide grep for `settings_changed`.    |
| Merge friction with [#676] in `subagents-settings.ts` / `index.ts`                     | These are independent issues on the same two files; land this one first if both are in flight, since [#676] adds shortcut registration rather than settings descriptors. |

## Open Questions

- **Read the contributor's fork branch or not?**
  The triage session left this to the implementation session: reading `daoguademeng/pi-packages@fc45d4c` makes co-authorship unambiguous, not reading it keeps the implementation independent.
  Recommendation: do **not** read it.
  This plan already specifies the design in full, the `Co-authored-by:` trailer goes on regardless because the design is theirs, and an independent implementation avoids importing shape decisions (descriptor handling, accessor pairs) that this plan makes differently.
- **Should the global-defaults README example include the new key?**
  Deferred to the docs step — decide by whether the example stays readable at four keys.
- No follow-up issues filed: everything this plan defers is already tracked by [#676] and [#674].

[#540]: https://github.com/gotgenes/pi-packages/issues/540
[#662]: https://github.com/gotgenes/pi-packages/issues/662
[#674]: https://github.com/gotgenes/pi-packages/issues/674
[#676]: https://github.com/gotgenes/pi-packages/issues/676

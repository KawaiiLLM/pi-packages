---
issue: 725
issue_title: "child sessions: registerTool during bind is silently dropped. intended?"
---

# Document the child tool allowlist contract, and make the recursion guard durable

## Release Recommendation

**Release:** ship independently

Issue #725 is a third-party report, not a step in the `docs/architecture/architecture.md` roadmap, so it carries no `Release:` batch annotation.
The plan lands two `feat:`/`fix:` commits, so the next release-please PR merge cuts a release that carries the corrected documentation with it.

## Problem Statement

An external reporter ([krisdock]) observed that a Pi extension's `pi.registerTool()` call inside a **child** session appears to do nothing: the setup function runs, the call returns no error, and yet the tool is absent from `getAllTools()` at `before_agent_start`.
The child's tool list is exactly the agent's `tools:` frontmatter list, nothing more.
The reporter noticed two consequences and asked whether the behavior is intended:

1. Naming an **extension** tool in `tools:` does admit it to the child — undocumented behavior they are relying on as a workaround, since the README documents `tools:` as built-ins only.
2. The recursion guard in `create-subagent-session.ts` has nothing to strip in practice, because the spawn tools are never in a child's registry to begin with — so the comment claiming it "runs after `bindExtensions` so extension-registered tools are included in the post-bind active set" reads stale.

The behavior is intended by Pi, but this package's documentation does not describe it and one of its own comments implies otherwise.

## Goals

- Document the real contract: a child session's tool set is exactly the agent's `tools:` allowlist, and extension-registered tool names are first-class entries in it.
- Make the YAML sequence form of `tools:` a supported, tested contract rather than an accident of string coercion.
- Make the recursion guard durable: express it as an SDK-level denylist that survives every tool-registry refresh, instead of a one-shot post-bind mutation.
- Give the package its own `docs/configuration.md`, mirroring `@gotgenes/pi-permission-system`, and move the agent-definition and settings reference there out of a 487-line README.
- Correct the stale comment in `create-subagent-session.ts`, the matching claim in `.pi/skills/package-pi-subagents/SKILL.md`, and the imprecise `excludedExtensionPackages` bullet in the README.

Not breaking.
No child's resolved tool set changes: the allowlist semantics stay exactly as they are, and the denylist reproduces (and hardens) a guard that already ran.

## Non-Goals

- **Inheriting extension tools into children by default.**
  Considered and declined for this issue.
  In this repository alone it would hand a read-only `Explore` child `issue_close`, `release_pr_merge`, `ci_watch`, `web_search`, and `fetch_content` — a capability expansion on upgrade that the operator did not sanction per agent.
  The documented escape hatch (name the tool in `tools:`) is explicit and per-agent.
  No follow-up issue is filed; the rationale is recorded in `docs/configuration.md` and `docs/architecture/architecture.md` so a future reader finds the analysis rather than re-deriving it.
- **A settings-scoped `inheritExtensionTools` opt-in.**
  Same decision, same rationale.
- **Changes to `@gotgenes/pi-permission-system`.**
  Despite the `pkg:pi-permission-system` label, no code or doc in that package is affected: its `before_agent_start` handler filters whatever active set the child has, and that set is unchanged.
  This is a single-package plan.
- **Restructuring the rest of the README** beyond the sections listed in Module-Level Changes.
  `## Features`, `## UI`, `## Tools`, `## Commands`, `## Events`, and `## For Extension Authors` stay where they are.

## Background

### How a child's tool set is actually built

`createSubagentSession()` (`src/lifecycle/create-subagent-session.ts`) passes `tools: cfg.toolNames` to the SDK's `createAgentSession`.
In `@earendil-works/pi-coding-agent@0.80.5` that option is an **allowlist**, not an initial active set (`dist/core/sdk.d.ts:36-46`):

> When provided, only the listed tool names are enabled.

The session stores it as `_allowedToolNames` and applies it inside `_refreshToolRegistry()` (`dist/core/agent-session.js:1911`) through `isAllowedTool()`, **before** the registry is built:

```javascript
const isAllowedTool = (name) => (!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);
const allCustomTools = [...registeredTools, ...].filter((tool) => isAllowedTool(tool.definition.name));
```

`pi.registerTool()` calls `runtime.refreshTools()`, so a child's registration does run and does trigger a refresh — the tool is then filtered out of `_toolDefinitions` and `_toolRegistry` entirely.
The reporter's "never lands in the child registry" is literally accurate, and it is Pi's documented behavior rather than a Pi defect.
A parent session passes no `tools:` option (the CLI sets it only for `--tools`), which is why the same extension tool is present in the parent and absent in the child.

Two corollaries follow from the same code:

- Naming an extension tool in `tools:` works because the allowlist is consulted by name at every refresh — a tool registered later is admitted the moment it registers.
  `parseCsvField` in `src/config/custom-agents.ts` never validates entries against `BUILTIN_TOOL_NAMES`, so any name passes through to `AgentConfig.builtinToolNames`.
- When an allowlist is set, every `_refreshToolRegistry()` **re-adds** every allowlisted registry tool to the active set (`agent-session.js:1968-1973`).
  A post-bind `setActiveToolsByName()` is therefore not durable: any later `registerTool()` in the child undoes it.

### The recursion guard

`applyRecursionGuard()` filters `subagent`, `get_subagent_result`, and `steer_subagent` out of the child's active set after `bindExtensions()`.
Today it strips nothing in the common case — those names are not in the allowlist — but it is load-bearing for the one case that matters: an agent whose frontmatter names `subagent` would otherwise get a child that can spawn children.
And in exactly that case the guard is undone by the next refresh, per the paragraph above.
The SDK's `excludeTools` denylist is checked inside `isAllowedTool` on every refresh (`sdk.d.ts:46`, "Applies after `tools` when both are provided"), which is the durable expression of the same intent.

### Constraints from AGENTS.md and the package skill

- **No policy enforcement in the core.**
  Tool restriction belongs to `@gotgenes/pi-permission-system`.
  This plan adds no policy: it documents an SDK-imposed contract and hardens an existing recursion guard.
- **Docs-in-distribution.**
  `package.json` `files` already lists `docs/*.md`, so a new `docs/configuration.md` ships in the tarball with no allowlist edit; `docs/architecture` is listed too, so links from the new doc into it resolve inside the tarball.
- **Architecture-doc discipline.**
  Module-tree entries describe current behavior; cite an issue only where the ref encodes an active constraint.

### Prior art: PR #612

[PR 612] (`wolfgangmeyers`, "inherit parent active tools") attacks the same symptom by unioning `cfg.toolNames` with the parent's `pi.getActiveTools()` in the spawn snapshot.
It is superseded by this plan's decision not to inherit, and it carries two defects worth recording when it is closed:

1. The parent's active set includes **built-ins**, so `tools: [...cfg.toolNames, ...snapshot.activeTools]` grants a read-only `Explore` agent `bash`, `edit`, and `write`.
2. It admits `subagent` into the child's allowlist (the parent has it active), so the post-bind guard strips it and the next refresh restores it — a live recursion path.

`/ship-issue` closes it with thanks and this analysis.

## Design Overview

Three small code changes and a documentation restructure.
Nothing changes about which tools a child ends up with.

### 1. `tools:` accepts a YAML sequence, on purpose

Agent frontmatter is YAML (Pi's `parseFrontmatter` runs `yaml@2.9.0`), but `tools:` is parsed as a comma-separated string, an inheritance from the upstream Claude-Code-style format.
Measured with that same parser:

| Frontmatter               | Parsed value         | `String(value)`      |
| ------------------------- | -------------------- | -------------------- |
| `tools: read, grep, find` | `"read, grep, find"` | `"read, grep, find"` |
| `tools: [read, grep]`     | `["read","grep"]`    | `"read,grep"`        |
| `tools:` + block list     | `["read","grep"]`    | `"read,grep"`        |
| `tools: none`             | `"none"`             | `"none"`             |

Both sequence forms already work — by accident, through the `String(val)` coercion in `parseCsvField`.
The plan makes that intentional with an explicit array branch and tests, and documents both forms.
Existing semantics are preserved exactly: omitted → all seven built-ins, `none` → no tools, empty → no tools.

```typescript
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const items = Array.isArray(val)
    ? val.map((entry) => String(entry).trim()).filter(Boolean)
    : String(val).trim().split(",").map((entry) => entry.trim()).filter(Boolean);
  if (items.length === 0) return undefined;
  return items.length === 1 && items[0] === "none" ? undefined : items;
}
```

The single-element `none` check preserves today's behavior for both `tools: none` and `tools: [none]`; a `none` among other names stays a literal name, as it is today.

### 2. The recursion guard becomes a denylist

`CreateSessionOptions` gains `excludeTools?: string[]`; `createSubagentSession` passes `excludeTools: EXCLUDED_TOOL_NAMES`; `applyRecursionGuard` and its post-bind call are deleted.

```typescript
const { session } = await deps.io.createSession({
  // …
  tools: cfg.toolNames,
  excludeTools: EXCLUDED_TOOL_NAMES,
  // …
});
```

The guarantee strengthens: the three spawn tools are excluded when the child's registry is **built**, and on every subsequent refresh, rather than being filtered out of the active set once and restorable afterwards.
The `try`/`catch` around `bindExtensions()` keeps its dispose-on-failure behavior ([#709]); only the guard call inside it goes away.

### 3. The SDK seam loses its `as any`

`src/index.ts` currently widens the factory's narrow structural contracts with a blanket cast:

```typescript
createSession: (opts) => createAgentSession(opts as any),
```

`as any` suppresses checking of the whole options object, including the field names — an SDK rename would land silently, and the new `excludeTools` field would be forwarded without any type check.
The narrow `SessionManagerLike` / `ResourceLoaderLike` / `ModelRegistry` interfaces exist so the factory can be tested with plain stubs, and TypeScript cannot carry "this narrow value is really the SDK class" across the seam without generics infecting `ParentSnapshot`.
Scope the assertion to the three fields that actually differ, and let the rest type-check:

```typescript
createSession: ({ sessionManager, resourceLoader, modelRegistry, ...rest }) =>
  createAgentSession({
    ...rest,
    sessionManager: sessionManager as SessionManager,
    resourceLoader: resourceLoader as ResourceLoader,
    modelRegistry: modelRegistry as ModelRegistry,
  }),
```

Each SDK type is assignable to its narrow counterpart (the narrow interfaces are subsets with compatible signatures), so each downcast is a permitted assertion rather than an `as unknown as` double-cast.
`cwd`, `agentDir`, `settingsManager`, `model`, `thinkingLevel`, `tools`, and `excludeTools` are then checked against `CreateAgentSessionOptions`.

### 4. `AgentConfig.builtinToolNames` → `toolNames`

Once extension tool names are a documented, tested part of `tools:`, `builtinToolNames` is a misnomer.
The field is internal (absent from the rolled `dist/public.d.ts`), and the neutral name already appears downstream as `getToolNamesForType()` and `cfg.toolNames`.
`BUILTIN_TOOL_NAMES` — the default list of seven — keeps its name, because that constant really is about built-ins.

### 5. `docs/configuration.md`

The README carries the whole agent-definition and settings reference inline at 487 lines (measured).
`@gotgenes/pi-permission-system` keeps a 178-line README plus a `docs/configuration.md`; this package adopts the same split.
The new document is a **move plus one new section**, not a rewrite:

```text
# Configuration
## Default agent types            ← moved from README
## Custom agents                  ← moved from README
### Example: .pi/agents/auditor.md
### Frontmatter fields
### Tool selection (`tools`)      ← new
## Persistent settings            ← moved from README
### Excluding package extensions from children
### Abort on interrupt
```

The new `### Tool selection` section states the contract in user terms: `tools:` is the child's complete allowlist; entries may name built-in **or** extension-registered tools; an extension tool that is not named is unavailable in the child even though its extension loads and runs there; the accepted forms are a comma-separated string, a YAML sequence, `none`, or omission; `subagent`, `get_subagent_result`, and `steer_subagent` are always removed from children; excluding a package (see below) prevents registration, so naming its tool has no effect; and `permission:` frontmatter narrows the set further per turn.

## Module-Level Changes

### Source

| File                                       | Change                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/custom-agents.ts`              | `parseCsvField` gains an `Array.isArray` branch; the `none` sentinel check moves after normalization so it covers both scalar and single-element-sequence forms. Doc comment on `csvList` updated to name both accepted forms.                                                                                      |
| `src/config/agent-types.ts`                | `AgentConfig` field rename (`builtinToolNames` → `toolNames`) at lines 98 and 116.                                                                                                                                                                                                                                  |
| `src/config/default-agents.ts`             | Same rename at lines 34 and 75; the line-19 comment (`builtinToolNames omitted …`) updated.                                                                                                                                                                                                                         |
| `src/types.ts`                             | `AgentConfig.builtinToolNames?: string[]` → `toolNames?: string[]` (line 51).                                                                                                                                                                                                                                       |
| `src/lifecycle/create-subagent-session.ts` | Add `excludeTools?: string[]` to `CreateSessionOptions`; pass `excludeTools: EXCLUDED_TOOL_NAMES` in the `createSession` call; delete `applyRecursionGuard` and its call site; rewrite the `EXCLUDED_TOOL_NAMES` doc comment and the module header's "apply the recursion guard" sentence to describe the denylist. |
| `src/index.ts`                             | Replace `createSession: (opts) => createAgentSession(opts as any)` with the destructured, field-scoped form; add the `SessionManager` / `ResourceLoader` / `ModelRegistry` type imports it needs.                                                                                                                   |

`applyRecursionGuard` is private and has exactly one call site, which the same step removes.
`EXCLUDED_TOOL_NAMES` stays — it becomes the denylist value.
Grep confirms no other `src/` or `test/` reference to `applyRecursionGuard`, and that `builtinToolNames` occurs 37 times across `src/` and `test/` with no occurrence in `.pi/skills/`, `docs/architecture/`, or `README.md`.

### Tests

| File                                                                                                                                                                                 | Change                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/config/custom-agents.test.ts`                                                                                                                                                  | New cases: block-sequence `tools:`, flow-sequence `tools: [read, grep]`, `tools: [none]`. Existing CSV, `none`, and `my_custom_tool` cases stay (the last one is the extension-name contract; its assertion gains a comment naming it as such). Rename the field in all assertions.           |
| `test/lifecycle/create-subagent-session.test.ts`                                                                                                                                     | Replace the two post-bind guard tests (lines 260-297) with an assertion that `createSession` receives `excludeTools: ["subagent", "get_subagent_result", "steer_subagent"]` and that `setActiveToolsByName` is never called. Keep the bind-order and dispose-on-bind-failure tests untouched. |
| `test/helpers/subagent-session-io.ts`, `test/helpers/subagent-session-io.test.ts`                                                                                                    | Field rename in the stub config and its assertion; the stub session keeps `setActiveToolsByName` (Pi's surface still has it).                                                                                                                                                                 |
| `test/config/agent-types.test.ts`, `test/config/invocation-config.test.ts`, `test/tools/spawn-config.test.ts`, `test/session/session-config.test.ts`, `test/session/prompts.test.ts` | Field rename in fixtures.                                                                                                                                                                                                                                                                     |

### Documentation

| File                                                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/docs/configuration.md`             | **New.** Receives README lines 108-189 (Default Agent Types, Custom Agents, Frontmatter Fields), 274-333 (Persistent Settings, Excluding package extensions), and 354-363 (Abort on interrupt) — 152 lines measured — plus the new `### Tool selection` section. The frontmatter table's `tools` row is rewritten (no longer "Comma-separated built-in tools"). The `excludedExtensionPackages` bullet "Excluding a package also removes the **tools** that extension registers from child sessions" is reworded: excluding a package prevents its tools from registering at all, so an agent that names one of them in `tools:` gets nothing — precision, not a correction of a false claim. |
| `packages/pi-subagents/README.md`                         | Sections above removed; `### Child session lifecycle` (lines 334-353) promoted to `##`, since its parent `## Persistent Settings` leaves. Four internal anchor links repointed to `docs/configuration.md#…`: line 239 (`#persistent-settings`), line 246 (`#custom-agents`), line 394 (`#excluding-package-extensions-from-children`), and the moved bullet's `#child-session-lifecycle` (which becomes a link back into the README). New `## Documentation` section linking `docs/configuration.md`, `docs/architecture/architecture.md`, and `docs/comparison-with-upstream.md`. Estimated result: ~345 lines.                                                                              |
| `packages/pi-subagents/docs/architecture/architecture.md` | Module-tree entry for `create-subagent-session.ts` — "assembly factory: session creation, binding, tool filtering" → binding plus SDK-level spawn-tool exclusion. New short subsection under `### What the core owns` recording why children do not inherit extension tools (the allowlist contract, and the capability-expansion reason for not changing it).                                                                                                                                                                                                                                                                                                                                |
| `.pi/skills/package-pi-subagents/SKILL.md`                | Line 23 ("A single post-bind call applies the `EXCLUDED_TOOL_NAMES` recursion guard after `bindExtensions`") is stale once the guard is a denylist; rewrite it, and add one sentence stating the child-allowlist contract so a future session does not re-derive it.                                                                                                                                                                                                                                                                                                                                                                                                                          |

`package.json` needs no `files` edit: `docs/*.md` already covers `docs/configuration.md`.
No other package references the moved README sections — the repo-wide anchor grep found matches only in `packages/pi-subagents/README.md` and the installed copy under `.pi/npm/`.

## Test Impact Analysis

**New coverage the change enables.**
The sequence-form cases pin behavior that until now existed only as a side effect of `String(val)` on an array; a future refactor of `parseCsvField` would otherwise break documented behavior with a green suite.
The `excludeTools` assertion pins the recursion guard at the point where it is now enforced, and — unlike the post-bind assertion — it pins a guarantee that survives a later refresh.

**Tests that become redundant.**
`test/lifecycle/create-subagent-session.test.ts` lines 260-297 ("calls `setActiveToolsByName` once, after `bindExtensions`" and "excludes `EXCLUDED_TOOL_NAMES` while keeping other tools") test the mechanism being removed, not the guarantee.
They are replaced, not deleted outright: the guarantee moves to the `createSession` options assertion, plus a negative assertion that no post-bind active-set mutation happens.

**Tests that must stay as-is.**
The bind-order test (`bindExtensions` called with `{}`, after `sessionCreated`) and the dispose-on-bind-failure test pin [#709]'s invariant and are untouched by this change.
`test/config/custom-agents.test.ts:111-119` (an extension tool name in `tools:` survives to the resolved config) is the contract this plan documents; it stays, with a comment naming it.

## Invariants at Risk

| Invariant                                                                                                | Source                                                                        | Pin                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A child never receives `subagent`, `get_subagent_result`, or `steer_subagent`.                           | Phase 14 ([#239]) simplified the two-pass filter to a single post-bind guard. | Today: the post-bind test. After: the `excludeTools` assertion, which is strictly stronger (registry-level, every refresh).                                                                   |
| Bind failure disposes the child (child `session_shutdown` + `dispose()` + `disposed`) before rethrowing. | [#709]                                                                        | Existing dispose-on-bind-failure test; the `try`/`catch` body is edited, so re-run it in the same step.                                                                                       |
| Excluding a package keeps its extension — and therefore its tools — out of children.                     | [#696]                                                                        | `test/session/package-exclusions*`; the reworded README bullet must stay true of it.                                                                                                          |
| A child sharing the parent's cwd keeps a byte-identical system-prompt prefix.                            | [#640]                                                                        | Untouched: no prompt assembly changes. `setActiveToolsByName` does rebuild the base prompt, but the child runs under `systemPromptOverride`, and the call is being removed rather than added. |

The last row is the one to watch: removing the post-bind `setActiveToolsByName` removes a base-prompt rebuild.
The child's effective prompt comes from `systemPromptOverride`, so the rebuild was inert — the existing prompt tests are the measurement, and they must stay green in that step without modification.

## TDD Order

1. **YAML sequence form for `tools:`** — `test/config/custom-agents.test.ts`.
   Red: block-sequence and flow-sequence frontmatter resolve to the same list as the CSV form; `tools: [none]` resolves to no tools.
   Green: the `Array.isArray` branch in `parseCsvField`.
   Commit: `feat(pi-subagents): accept a YAML sequence in agent frontmatter tools`.
2. **Durable recursion guard** — `test/lifecycle/create-subagent-session.test.ts`.
   Red: `createSession` receives `excludeTools: EXCLUDED_TOOL_NAMES`, and `setActiveToolsByName` is never called.
   Green: add the field to `CreateSessionOptions`, pass it, delete `applyRecursionGuard` and its call; update the module header comment, the `EXCLUDED_TOOL_NAMES` doc comment, and the stale sentence in `.pi/skills/package-pi-subagents/SKILL.md`.
   The old guard tests are rewritten in this same commit — they assert the removed mechanism and would not compile against it.
   Commit: `fix(pi-subagents): make the child recursion guard durable across tool refreshes`.
3. **Drop the `as any` at the SDK seam** — `src/index.ts`.
   No new test: the gate is `pnpm run check`, which is exactly what the cast was suppressing.
   Run the full suite to confirm the real wiring still constructs a session.
   Commit: `refactor(pi-subagents): type the SDK session-factory seam field by field`.
4. **Rename `builtinToolNames` → `toolNames`** — `src/types.ts`, `src/config/*`, and all test fixtures in one commit; a rename of an interface field cannot be split across commits without breaking the type check.
   Commit: `refactor(pi-subagents): rename AgentConfig.builtinToolNames to toolNames`.
5. **Extract `docs/configuration.md`** — pure move of the three README regions plus the anchor repointing, the `## Child session lifecycle` promotion, and the new `## Documentation` section.
   No content added in this step, so the diff reads as a move.
   Commit: `docs(pi-subagents): extract the configuration reference into docs/configuration.md`.
6. **Document the tool allowlist contract** — the new `### Tool selection` section, the rewritten `tools` frontmatter-table row, the reworded `excludedExtensionPackages` bullet, and the architecture-doc rationale and module-tree entry.
   Commit: `docs(pi-subagents): document the child tool allowlist contract`.

Steps 5 and 6 stay separate so the extraction is reviewable as a move and the new prose is reviewable as prose.

## Risks and Mitigations

| Risk                                                                                                                             | Mitigation                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A field-scoped downcast in step 3 does not compile — e.g. our `ModelRegistry` and the SDK class diverge on a member.             | Fall back to one documented `as unknown as CreateAgentSessionOptions` inside a named `toSdkSessionOptions()` helper. Still better than `as any`: the input is typed and the assertion has one home and a reason. If even the narrowed form is unstable, drop step 3 — it is independent of the rest. |
| Moving `## Persistent Settings` reparents `### Child session lifecycle` and `### Abort on interrupt`, which nest under it today. | The plan promotes the first to `##` in the README and moves the second with its parent. Read the README from `## Concurrency` to `## Events` end to end after the move, per the `markdown-conventions` insertion rule.                                                                               |
| A repointed anchor breaks in the published tarball.                                                                              | `docs/*.md` is already in the `files` allowlist, so `./docs/configuration.md` resolves inside the tarball. Verify with `pnpm --filter @gotgenes/pi-subagents exec pnpm pack --pack-destination /tmp` and `tar tzf`.                                                                                  |
| The new document trips `rumdl` (MD053 unused link definitions, MD029 numbering restarts, MD060 table padding).                   | `pnpm exec rumdl check` on both files before the docs commits; the pre-commit `rumdl fmt` hook runs regardless.                                                                                                                                                                                      |
| `excludeTools` is unavailable in a supported peer version.                                                                       | The peer range is `>=0.80.5` and `excludeTools` is present in `0.80.5`'s `CreateAgentSessionOptions` (`dist/core/sdk.d.ts:46`). No peer bump.                                                                                                                                                        |
| Step 4's rename touches 37 sites; a missed test fixture fails only at type-check.                                                | Run `pnpm run check` (unpiped) plus the full suite in that step; `grep -rn builtinToolNames packages/pi-subagents` must return only `CHANGELOG.md`, `docs/plans/`, and `docs/retro/` matches afterwards.                                                                                             |

## Open Questions

None blocking.
Two observations recorded for a future reader rather than deferred as work:

- If Pi ever exposes an "activate every registered extension tool" option on `createAgentSession`, inheriting extension tools into children becomes a one-line, opt-in change; the analysis in Non-Goals is what to revisit at that point.
- `getAllTools()` returns `ToolInfo` with `sourceInfo.source` discriminating `builtin` from an extension path, so a future opt-in could compute a child's extension-tool set post-bind without threading the parent's active set through `ParentSnapshot`.

[krisdock]: https://github.com/krisdock
[PR 612]: https://github.com/gotgenes/pi-packages/pull/612
[#239]: https://github.com/gotgenes/pi-packages/issues/239
[#640]: https://github.com/gotgenes/pi-packages/issues/640
[#696]: https://github.com/gotgenes/pi-packages/issues/696
[#709]: https://github.com/gotgenes/pi-packages/issues/709

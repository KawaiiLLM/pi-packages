---
issue: 696
issue_title: "pi-subagents: allow children to exclude selected package extensions"
---

# Exclude selected package extensions from child sessions

## Release Recommendation

**Release:** ship independently

`packages/pi-subagents/docs/architecture/architecture.md` contains no `Release:` tags and no roadmap step referencing [#696], so this issue is not a member of any release batch.
It is a self-contained, additive feature that fixes a reproducible crash for affected users, so it should cut its own release rather than wait for a batch.

## Problem Statement

`pi-subagents` creates in-process child `AgentSession`s and reloads the parent's Pi packages for every child, with no way to prevent a given package's extensions from loading in the child.
Some package extensions are intentionally parent-scoped or expensive to initialize per session, and re-initializing them once per child multiplies their cost inside the parent's single V8 heap.

The concrete failure reported in [#696] is `@cortexkit/pi-magic-context`: four concurrent children each initialize Magic Context and scan a Pi session store of 1,396 sessions (~1.1 GB) in the same heap, reproducibly reaching the ~4.1 GB V8 limit and aborting with exit 134.
Neither side's existing settings close the gap — `pi-subagents` children always inherit all parent extensions, and Magic Context's own `pi.subagent_extensions` governs subprocesses it spawns itself, not in-process children created by `pi-subagents`.

The absence of the seam was confirmed against current `main` during the PR review for [#697] (see `docs/retro/0696-exclude-package-extensions-from-children.md`).
`createSubagentSession` passes no `settingsManager`, no `extensionsOverride`, and no `noExtensions` to `createResourceLoader`, so Pi's `DefaultResourceLoader` builds its own `SettingsManager` from the parent's config and resolves every configured package.

## Goals

- Add an opt-in `excludedExtensionPackages` key to the layered `subagents.json` settings, matching Pi package sources exactly.
- Disable only the matched packages' **extensions** in child resource loading, before any extension module is imported or any factory runs.
- Leave the matched packages' skills, prompts, and themes available to children.
- Leave the parent session's behavior and the child session's own `SettingsManager` completely unchanged.
- Preserve today's child behavior exactly when the setting is absent or empty.
- Preserve a hand-edited `excludedExtensionPackages` across `/subagents:settings` writes, which currently overwrite the project settings file wholesale.
- Amend [ADR-0002] to record why the prevent-load policy input is a core settings key rather than the provider seam the ADR reserved.

This change is **not breaking**: absent or empty settings reproduce current behavior byte for byte, and no default changes on upgrade.

## Non-Goals

- **Not a fix for [#709]** (child disposal skips `session_shutdown` and leaks extension-owned processes).
  That issue explicitly names this feature as a workaround with a different failure mode: excluding a package removes the child's access to that package's tools, which is unacceptable for `pi-mcp-adapter`.
  The two are complementary — this issue prevents load-time cost, [#709] fixes the disposal contract — and neither substitutes for the other.
  This plan does not touch `SubagentSession.dispose()`.
- No restoration of per-agent extension policy.
  The `extensions:`, `isolated:`, and `noSkills` frontmatter keys removed in [#264] stay removed; exclusion is global/project scope only, never per agent type.
- No glob, prefix, or fuzzy package matching.
  Sources match Pi's configured source string exactly, as [#696] requests.
- No `/subagents:settings` UI affordance.
  The key is hand-edited in `subagents.json`; the settings command's menu is unchanged.
- No exclusion of skills, prompts, or themes.
  Only the `extensions` resource type is disabled for a matched package.
- No change to `SubagentSession`, `Subagent`, `SubagentManager`, the recursion guard, or the workspace provider seam.

## Background

### Where children load extensions

`packages/pi-subagents/src/lifecycle/create-subagent-session.ts` builds the child's resource loader and session:

```typescript
const loader = deps.io.createResourceLoader({ cwd, agentDir, /* … */ });
await loader.reload();
// …
const { session } = await deps.io.createSession({
  settingsManager: deps.io.createSettingsManager(cfg.effectiveCwd, agentDir),
  resourceLoader: loader,
  // …
});
```

`deps.io.createResourceLoader` is wired in `src/index.ts` to `new DefaultResourceLoader(opts)`.
Pi's `DefaultResourceLoader` falls back to `SettingsManager.create(this.cwd, this.agentDir)` when no `settingsManager` is supplied, then calls `packageManager.resolve()`, which reads `getGlobalSettings().packages` and `getProjectSettings().packages`.

### Why the `extensions: []` idiom is the right lever

Pi's `PackageSource` object form supports per-resource-type filters.
Two branches in `DefaultPackageManager.collectPackageResources` consume them, and `extensions: []` produces "load none" in **both**:

- Default mode (`autoload` unset or `true`) routes to `applyPackageFilter`, which special-cases the empty array — its own comment reads "Empty array explicitly disables all resources of this type" — and marks every discovered extension file `enabled: false`.
- Delta mode (`autoload: false`) routes to `applyPackageDeltaFilter`, which starts from nothing and only *adds* explicitly matched patterns, so an empty array adds no extensions.

This is the same idiom this repo already documents in `AGENTS.md` for its own double-load suppression entries.
Because the filter is applied during package **resolution**, an excluded package's extension paths never reach `loadExtensionsCached`, so the module is never imported and its factory never runs — which is what the reported OOM requires.

### Why Pi's `extensionsOverride` cannot be used

`DefaultResourceLoaderOptions` exposes `extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult`, which looks like a cleaner seam but is unusable here for two independent reasons found while reading `dist/core/resource-loader.js`:

- It runs *after* `loadFinalExtensionSet`, which has already called `loadExtensionsCached(extensionPaths, …)`.
  The excluded package's module is imported into the heap before the callback can drop it, so the memory cost this issue exists to avoid is already paid.
- It runs *before* `applyExtensionSourceInfo`, so `extension.sourceInfo` is still unpopulated when the callback fires.
  The callback would have to re-derive each extension's owning package by matching file paths against install roots — duplicating what `DefaultPackageManager` already knows.

### Why the child settings view cannot be a subclass

Pi's `SettingsManager` declares `private constructor()`, so TypeScript rejects `extends`.
Its `applyOverrides` is also unusable: it merges into the private `settings` field only, while `DefaultPackageManager` reads the per-scope `getGlobalSettings()` / `getProjectSettings()` accessors.

The usable seam is `SettingsManager.fromStorage(storage, options)`, which is public and accepts a one-method `SettingsStorage`.
Supplying a storage that serves filtered copies of the parent's settings yields a **real, fully typed `SettingsManager`** — no `Proxy`, no SDK-surface forwarding, no casts through `unknown`.

### AGENTS.md constraints that apply

- pi-subagents is a **minimal core** with no policy enforcement; extension filtering was evicted in Phase 14.
  [ADR-0002] carves out one exception, quoted in Design Overview, that this change lands inside.
- Architecture-doc module-tree entries describe **current behavior**; cite an issue only when the ref encodes an active constraint.
- `docs/plans` and `docs/retro` are release-please `exclude-paths`, so plan and retro commits do not themselves trigger a release.

## Design Overview

### Decision record

Three questions were deferred from the [#697] PR review to this planning stage and answered by the operator:

| Question        | Decision                                                                         |
| --------------- | -------------------------------------------------------------------------------- |
| Config shape    | Settings key `excludedExtensionPackages`, plus a deliberate [ADR-0002] amendment |
| Mechanism       | `SettingsManager.fromStorage` over a read-only filtering storage                 |
| Session manager | Loader only — the child session keeps today's real file-backed manager           |

The config-shape decision turns on [ADR-0002]'s own governing rule, "no vacant hooks": a provider seam with no consumer "is not extensibility — it is a speculative abstraction that taxes every reader, and `fallow` flags it as dead."
No external extension wants to supply a prevent-load policy today; the only policy source is the operator's config.
A registerable provider whose sole consumer is pi-subagents' own settings reader would be exactly the vacant hook the ADR forbids.
The amendment records this reasoning and notes that the seam remains additively admissible if a real consumer (a sandboxing extension, say) later appears.

### Where the decision lives

The core factory must not learn about exclusion policy.
Following the `code-design` rule "thread decisions, not discriminators", `src/index.ts` — the composition boundary that already owns settings — resolves the policy and hands `createSubagentSession` the *product*: a settings manager for the loader.

This is a deliberate divergence from [#697], which threads a `getExcludedExtensionPackages: () => readonly string[]` getter into `SubagentSessionDeps` and branches inside the factory.
Keeping the raw list out of the factory means `create-subagent-session.ts` gains no policy knowledge, no fifth dependency-bag field, and no conditional.

A new `SessionFactoryIO` member takes the parent manager and returns the loader's view:

```typescript
/** Settings view the child's resource loader sees; may disable configured package extensions. */
createLoaderSettingsManager: (parent: SettingsManager) => SettingsManager;
```

`src/index.ts` wires it, closing over the live `settings` object so a mid-session settings reload affects subsequent children:

```typescript
createLoaderSettingsManager: (parent) => {
  const excluded = new Set(settings.excludedExtensionPackages);
  if (excluded.size === 0) return parent;
  return SdkSettingsManager.fromStorage(createExcludedPackagesStorage(parent, excluded), {
    projectTrusted: parent.isProjectTrusted(),
  });
},
```

### Call site in the factory

`createSubagentSession` hoists the single `createSettingsManager` call it already makes, then derives the loader's view from it:

```typescript
const sessionSettings = deps.io.createSettingsManager(cfg.effectiveCwd, agentDir);
const loaderSettings = deps.io.createLoaderSettingsManager(sessionSettings);

const loader = deps.io.createResourceLoader({ cwd: cfg.effectiveCwd, agentDir, settingsManager: loaderSettings, /* … */ });
await loader.reload();
const { session } = await deps.io.createSession({ settingsManager: sessionSettings, resourceLoader: loader, /* … */ });
```

The factory reads no `PackageSource` shapes and holds no exclusion list, so Tell-Don't-Ask and the Law of Demeter both hold: it asks the IO boundary for a view and passes it on.
Only one settings file read happens per child, as today — the filtered view reads through the parent manager rather than re-reading disk.

### New module: `src/session/package-exclusions.ts`

Pure transform plus the storage adapter, with no SDK *value* imports.
`Settings` and `SettingsStorage` are not exported from the package root, so both are derived structurally from the exported `SettingsManager` class:

```typescript
import type { PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";

type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;
type PiSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

/** The parent-settings reads a child view needs — narrower than `SettingsManager`. */
export interface ParentSettingsView {
  getGlobalSettings(): PiSettings;
  getProjectSettings(): PiSettings;
}

export function withPackageExtensionsDisabled(settings: PiSettings, excluded: ReadonlySet<string>): PiSettings;
export function createExcludedPackagesStorage(parent: ParentSettingsView, excluded: ReadonlySet<string>): PiSettingsStorage;
```

`ParentSettingsView` satisfies ISP: the storage reads only the two scope accessors.
`isProjectTrusted()` is deliberately excluded from it — that value is read once by the wiring in `index.ts` to build `SettingsManagerCreateOptions`, not by the storage.

`withPackageExtensionsDisabled` maps each `PackageSource`, rewriting only matched entries and promoting the string form to the object form:

```typescript
const source = typeof pkg === "string" ? pkg : pkg.source;
if (!excluded.has(source)) return pkg;
return typeof pkg === "string" ? { source, extensions: [] } : { ...pkg, extensions: [] };
```

This transform is adopted from [#697] essentially unchanged — it is correct, and the contributor gets the `Co-authored-by` credit for it.
Non-matched entries are returned by identity, and the input object is never mutated.

### The storage adapter, and why writes are discarded

```typescript
export function createExcludedPackagesStorage(parent, excluded): PiSettingsStorage {
  return {
    withLock(scope, fn) {
      const source = scope === "global" ? parent.getGlobalSettings() : parent.getProjectSettings();
      fn(JSON.stringify(withPackageExtensionsDisabled(source, excluded)));
    },
  };
}
```

`SettingsStorage.withLock` persists whatever `fn` returns.
This adapter ignores that return value, making the child's loader view strictly read-only.
That is a correctness requirement, not a simplification: forwarding a write would persist the synthesized `extensions: []` entries into the user's real `settings.json`, silently disabling those packages for the **parent** and every future session.

Discarding writes is safe here because the loader never writes settings — `DefaultResourceLoader` only calls `setProjectTrusted()` and `reload()`, both of which are reads through this storage.
Because the storage reads through to the live parent manager, the loader's `reload()` re-reads and re-filters current values rather than a stale snapshot.

### Settings round-trip preservation

`SettingsManager.saveAndNotify` persists `this.snapshot()` via `saveSettings`, which does a whole-file `writeFileSync` of the project `subagents.json`.
Any key absent from `snapshot()` is therefore **destroyed** the next time a user changes a setting through `/subagents:settings`.
A hand-edited project-scoped `excludedExtensionPackages` would be silently erased by an unrelated grace-turns edit.

`snapshot()` must therefore carry the value through, as an optional field present only when non-empty so that existing on-disk files gain no noise:

```typescript
interface SettingsSnapshot {
  maxConcurrent: number;
  defaultMaxTurns: number;
  graceTurns: number;
  consumedSessionRetentionMinutes: number;
  unconsumedSessionRetentionMinutes: number;
  abortAllOnInterrupt: boolean;
  /** Present only when non-empty: `saveSettings` rewrites the whole file, so an omitted key is erased. */
  excludedExtensionPackages?: string[];
}
```

Naming the return type replaces today's inline literal and gives the round-trip rationale a home.
This is a genuine data-loss guard, and it is pinned by its own regression test rather than being an artifact of keeping `toEqual` assertions green.

### Sanitization

`sanitize()` gains an array branch adopted from [#697]: keep string members, trim them, drop empties, dedupe via `Set`, and drop the key entirely when the value is not an array.
Malformed input degrades to "no exclusions", matching the module's existing silent-drop contract.

### Edge cases

| Case                                    | Behavior                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Setting absent or `[]`                  | `createLoaderSettingsManager` returns the parent manager by identity; no storage, no filtering, no behavior change                       |
| Source not present in `packages`        | No entry matches; the filtered view equals the parent's                                                                                  |
| String-form entry                       | Promoted to `{ source, extensions: [] }`; skills, prompts, themes still resolve by convention                                            |
| Object-form entry with `skills`         | `skills` preserved; only `extensions` replaced                                                                                           |
| Entry with `autoload: false`            | Delta mode adds nothing for `extensions`; other listed resource types still apply                                                        |
| Project and global both list the source | Both scopes are filtered; Pi's existing `dedupePackages` precedence is untouched                                                         |
| Untrusted project                       | The child manager is constructed with the parent's `projectTrusted`, and Pi's own untrusted short-circuit returns `{}` for project scope |

## Module-Level Changes

### Source

| File                                       | Change                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/settings.ts`                          | Add `excludedExtensionPackages?: string[]` to `SubagentsSettings`; add the private field, the `readonly string[]` getter, the `load()` assignment, the `sanitize()` array branch, and the named `SettingsSnapshot` return type with the conditional field                                                                                 |
| `src/session/package-exclusions.ts`        | **New.** `ParentSettingsView`, `withPackageExtensionsDisabled`, `createExcludedPackagesStorage`                                                                                                                                                                                                                                           |
| `src/lifecycle/create-subagent-session.ts` | Add `settingsManager?: SettingsManager` to `ResourceLoaderOptions`; add `createLoaderSettingsManager` to `SessionFactoryIO`; hoist the `createSettingsManager` call and pass the derived view to the loader while `createSession` keeps the original; update the stale `Children always load the parent's extensions and skills.` comment |
| `src/index.ts`                             | Wire `createLoaderSettingsManager` into the `subagentSessionDeps.io` bag                                                                                                                                                                                                                                                                  |

`SubagentSessionDeps` is deliberately **unchanged** — the decision is resolved at the `index.ts` boundary, so no policy getter enters the factory's dependency bag.

### Tests

| File                                             | Change                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `test/settings.test.ts`                          | Sanitization and dedupe cases; default-empty case; load-from-disk case; snapshot round-trip regression test |
| `test/session/package-exclusions.test.ts`        | **New.** Pure-transform cases plus a real-`SettingsManager.fromStorage` integration case                    |
| `test/lifecycle/create-subagent-session.test.ts` | Assert the loader receives the derived view and `createSession` receives the unfiltered manager             |
| `test/helpers/subagent-session-io.ts`            | Add `createLoaderSettingsManager` to `createSubagentSessionIO`, defaulting to identity                      |

### Docs

| File                                                  | Change                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `README.md`                                           | New `### Excluding package extensions from children` subsection under `## Persistent Settings`, before `### Abort on interrupt`; update the `## Removed: agent memory and skill preloading` sentence that currently reads "Children now always inherit the parent's skills and extensions" |
| `docs/decisions/0002-extensions-on-a-minimal-core.md` | Amendment section recording the settings-key decision and the "no vacant hooks" reasoning                                                                                                                                                                                                  |
| `docs/architecture/architecture.md`                   | Add `package-exclusions.ts` to the `session/` module tree; update the `Recursion guard` and `Extension lifecycle control` bullets that assert children *always* load parent extensions; refresh the health-metrics file count and LOC                                                      |

### Grep sweep performed

- `noExtensions`, `extensionsOverride`, `settingsManager` across `src/` and `test/` — the only production `createSettingsManager` call site is `create-subagent-session.ts`.
- "always load"/"always inherit" phrasing across `README.md`, `docs/architecture/`, `docs/decisions/`, and `.pi/skills/package-pi-subagents/SKILL.md`.
  The skill file's Phase 14 bullet states extension filtering "belongs in `@gotgenes/pi-permission-system`, not in this package" and names the removal of the `extensions: string[]` allowlist.
  That sentence stays accurate — this change adds no per-agent allowlist — but the skill's Phase 16 bullet mentioning removal of `isolated`/`extensions: false`/`noSkills` should gain a clause noting the settings-scoped prevent-load key, so the skill does not contradict the shipped README.
- No `Symbol.for()` accessor, package `exports` entry, or event channel changes, so the public-surface doc sweep finds nothing further.

## Test Impact Analysis

This is an additive feature rather than an extraction, so no existing test becomes redundant and none must be rewritten.

**New coverage the design enables.**
Splitting the pure transform into its own module makes the package-filtering semantics unit-testable without any SDK object: string-form promotion, object-form merge, `autoload: false` passthrough, non-matched identity, and input non-mutation are all plain function calls.

**Closing the [#697] test gap.**
The PR's only integration test asserts against a stub `SettingsManager`, so it pins that a proxy wraps two methods rather than that Pi actually disables the extension.
This plan adds a test that builds a **real** `SettingsManager` via `SettingsManager.fromStorage(createExcludedPackagesStorage(...))` and asserts `getGlobalSettings().packages` and `getProjectSettings().packages`, plus a case asserting a write through `withLock` does not reach the parent.
That test survives a mechanism swap; a stub-based one does not.

**Tests that must stay as-is.**
Existing `create-subagent-session.test.ts` cases covering prompt suppression, recursion-guard application, lifecycle event ordering, and dispose-on-bind-failure genuinely exercise the assembly layer and are unaffected.
The `test/helpers/subagent-session-io.ts` default must be identity so every existing case keeps observing today's behavior.

## Invariants at risk

| Invariant                                                                                                     | Source                                               | Pinned by                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Recursion guard is unconditional for every child that reaches binding                                         | [#264] `Outcome:`; `applyRecursionGuard` doc comment | Existing recursion-guard cases in `create-subagent-session.test.ts`                       |
| `session-created` is published before `bindExtensions()` so the permission system registers the child in time | [#261], [ADR-0002]                                   | Existing lifecycle-ordering cases; untouched by this plan                                 |
| The child's inherited prompt prefix stays byte-identical to the parent's when cwds match                      | [#640]                                               | Existing prompt tests; this plan touches no prompt assembly                               |
| Parent session behavior is unchanged                                                                          | [#696] acceptance criterion                          | New test asserting the parent manager's `getGlobalSettings()` is not mutated by filtering |
| An excluded package's skills still load in children                                                           | [#696] acceptance criterion                          | New transform test asserting `skills` survives on a filtered entry                        |
| A hand-edited `excludedExtensionPackages` survives a `/subagents:settings` write                              | New in this plan                                     | New `snapshot()` round-trip regression test                                               |

None of these are quantitative, so no baseline measurement is required.
The one measurable claim — that an excluded package's extension module is never imported — is a consequence of Pi's resolution order documented in Background, and is verified by the real-`SettingsManager` test asserting the entries are marked disabled before `loadExtensionsCached` would see them.

## TDD Order

1. **Settings shape and sanitization.**
   Red: `test/settings.test.ts` cases for sanitize/dedupe/trim, non-array rejection, default-empty getter, and load-from-disk.
   Green: `SubagentsSettings` field, private field, getter, `load()` assignment, `sanitize()` branch in `src/settings.ts`.
   Commit: `feat(pi-subagents): read excludedExtensionPackages from layered settings`.

2. **Snapshot round-trip guard.**
   Red: a `test/settings.test.ts` case that writes a project `subagents.json` containing `excludedExtensionPackages`, calls `applyGraceTurns`, re-reads the file, and asserts the key survived.
   Green: named `SettingsSnapshot` return type with the conditional field in `snapshot()`.
   Commit: `fix(pi-subagents): preserve excludedExtensionPackages across settings writes`.

3. **Pure transform and storage adapter.**
   Red: `test/session/package-exclusions.test.ts` covering string-form promotion, object-form merge preserving `skills`, `autoload: false` entries, non-matched identity, input non-mutation, the real-`SettingsManager.fromStorage` integration case, and write-discard.
   Green: new `src/session/package-exclusions.ts`.
   Commit: `feat(pi-subagents): add package-extension exclusion transform`.
   If `pnpm fallow dead-code` flags the new exports at this commit because only tests consume them, fold this step into step 4 rather than adding a suppression.

4. **Wiring, in one commit.**
   Red: `create-subagent-session.test.ts` cases asserting the loader receives `createLoaderSettingsManager`'s result and `createSession` receives the unfiltered manager.
   Green: `ResourceLoaderOptions.settingsManager`, `SessionFactoryIO.createLoaderSettingsManager`, the hoisted call in `createSubagentSession`, the `index.ts` wiring, and the identity default in `test/helpers/subagent-session-io.ts`.
   These must land together: adding a required member to `SessionFactoryIO` breaks `src/index.ts` and every test helper at the type level in the same commit.
   Commit: `feat(pi-subagents): exclude configured package extensions from children`.

5. **Documentation.**
   README subsection and the corrected "always inherit" sentence, the [ADR-0002] amendment, the architecture-doc module-tree entry and corrected bullets, refreshed health metrics, and the `package-pi-subagents` skill clause.
   Commit: `docs(pi-subagents): document excludedExtensionPackages`.

Every commit in steps 1–5 carries, after a blank line at the end of the body:

```text
Co-authored-by: leipeng <leipeng950504@gmail.com>
```

Reference the contribution as `Refs #696, #697` — never `Closes`, which would pre-empt the curated close comments.

## Risks and Mitigations

| Risk                                                                                                                            | Mitigation                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A forwarded write persists synthesized `extensions: []` into the user's real `settings.json`, disabling packages for the parent | The storage adapter ignores `fn`'s return value by construction; a dedicated test asserts a write through `withLock` leaves the parent's settings untouched              |
| `/subagents:settings` erases a hand-edited `excludedExtensionPackages`                                                          | Step 2 lands the `snapshot()` round-trip fix with its own regression test, before the feature ships                                                                      |
| A user excludes a package and loses that package's child tools without understanding why                                        | README subsection states explicitly that extensions are disabled while skills and other resources remain, and points at [#709] for the tool-preserving lifecycle problem |
| Pi changes the `extensions: []` disable semantics in a future release                                                           | The real-`SettingsManager.fromStorage` test exercises Pi's actual resolution rather than a stub, so a semantic change fails the suite instead of passing silently        |
| The new module reads as dead code between steps 3 and 4                                                                         | Step 3 names the fold-forward remedy explicitly; no `fallow` suppression is added                                                                                        |
| Users read this as a fix for [#709]                                                                                             | Non-Goals states the distinction, and the README cross-reference repeats it                                                                                              |

## Open Questions

None blocking.
Two items are deliberately deferred rather than unresolved:

- Whether a prevent-load **provider seam** should exist alongside the settings key.
  Deferred until a real external consumer appears, per [ADR-0002]'s "no vacant hooks" rule; the amendment records that the seam stays additively admissible.
- Whether `saveSettings` should merge rather than overwrite the project file.
  Step 2 fixes the concrete data-loss path for this key; a general merge-on-write change would touch every setting and belongs in its own issue if another unmanaged key is ever added.

No follow-up issues are filed by this plan — [#709] already tracks the adjacent disposal-lifecycle work, and nothing else concrete emerged.

[#261]: https://github.com/gotgenes/pi-packages/issues/261
[#264]: https://github.com/gotgenes/pi-packages/issues/264
[#640]: https://github.com/gotgenes/pi-packages/issues/640
[#696]: https://github.com/gotgenes/pi-packages/issues/696
[#697]: https://github.com/gotgenes/pi-packages/pull/697
[#709]: https://github.com/gotgenes/pi-packages/issues/709
[ADR-0002]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md

# Pi TUI Kit Guidelines

## Runtime boundary

- Keep production JavaScript on public `pi-tui` primitives and make coding-agent imports type-only.
- Do not import the `pi-coding-agent` runtime root because repository resolution can evaluate a second agent runtime.
- Lazy-load command menus until consumers require the published Kit boundary.

## API admission

- Require two compatible consumers before adding a public Kit screen or lifecycle API by default.
- Record an explicit no-go or deferral when consumer behavior does not converge.
- Do not treat direct dialog count as a reason to add a Kit API.
- Replace a Kit contract with public Pi controls only when Pi provides the complete cross-mode lifecycle contract.
- Preserve consumer capabilities during migrations, including preview, rollback, selection restoration, three-way cancellation, persistence, validation, failure recovery, and non-TUI behavior.
- Keep action catalogs, async catalogs, trees, transcript workflows, reorder flows, setup or auth flows, preview-state frameworks, and session selectors specialized until two compatible consumers prove otherwise.

## Interaction and tests

- Dispatch injected keys and distinct Back or Close outcomes in Kit wrappers instead of relying on public `SelectList.handleInput()` or `ctx.ui.select()`.
- Reserve only a standalone Space key for searchable-wrapper activation; never strip spaces from an entire pasted input chunk.
- Treat settings and multi-select actions as asynchronous settlements.
- Drain pending callbacks and observe an accepted transition with the async-capable `runCustomInteraction()` harness.

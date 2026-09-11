import { describe, expect, it, vi } from "vitest";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import { type PermissionPromptUi, requestPermissionDecision } from "#src/authority/permission-prompt-component";
import { makePromptDetails } from "#test/helpers/prompt-details-fixtures";
import { makePromptPreferences } from "#test/helpers/prompt-view-fixtures";

// Exercise Pi's real custom-component mounting/focus/close implementation,
// without creating a terminal, a model connection, or a user session.
const modeUrl = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js", import.meta.url).href;
const { InteractiveMode } = await import(/* @vite-ignore */ modeUrl);

type Component = { render(width: number): string[]; handleInput?(data: string): void };
type Factory = (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown;
function harness(doublePressToConfirm = false) {
  const editor = { render: () => ["editor"], getText: () => "", setText: () => {} };
  let visible: Component = editor;
  let focus: Component = editor;
  const host = {
    editor,
    editorContainer: { clear() {}, addChild(c: Component) { visible = c; } },
    ui: { setFocus(c: Component) { focus = c; }, requestRender() {} },
    keybindings: { matches: () => false },
    disposeActiveSelector() {},
  };
  const ui = {
    custom: (factory: Factory, options: unknown) => InteractiveMode.prototype.showExtensionCustom.call(host,
      (_tui: unknown, _theme: unknown, _keys: unknown, done: (value: unknown) => void) =>
        factory(host.ui, { fg: (_color: string, text: string) => text }, host.keybindings, done), options),
    select: vi.fn(), input: vi.fn(), getToolsExpanded: () => false, setToolsExpanded() {},
  } as unknown as PermissionPromptUi;
  const makeAuthorizer = (getSignal?: () => AbortSignal | undefined) => new LocalUserAuthorizer({
    ui, mode: "tui", events: { emit() {}, on: () => () => {} }, getSignal,
    getPromptPreferences: () => makePromptPreferences({ doublePressToConfirm }),
    requestPermissionDecision,
  });
  return {
    makeAuthorizer,
    text: () => visible.render(100).join("\n"),
    press: (key: string) => focus.handleInput?.(key),
    isEditor: () => visible === editor && focus === editor,
  };
}
const direct = () => makePromptDetails({ requestId: "direct" });
const forwarded = () => makePromptDetails({ requestId: "forwarded", forwarding: {
  requesterAgentName: "worker", requesterSessionId: "child",
} });

describe("permission queue with real Pi inline UI", () => {
  it.each([false, true])("drains 20 consecutive dialogs without leaking decisions (double press: %s)", async (doublePress) => {
    const h = harness(doublePress);
    const authorizer = h.makeAuthorizer();
    let completed = 0;
    const pending = Array.from({ length: 20 }, (_, index) =>
      authorizer.authorize(index % 2 === 0 ? direct() : forwarded()).then(result => {
        completed++;
        return result;
      }));
    try {
      for (let index = 0; index < pending.length; index++) {
        await vi.waitFor(() => expect(h.isEditor()).toBe(false));
        expect(h.text().includes("(Subagent)")).toBe(index % 2 !== 0);
        expect(completed).toBe(index);
        const approve = index % 3 === 0;
        h.press(approve ? "y" : "\u001b");
        if (approve && doublePress) {
          await Promise.resolve();
          expect(completed).toBe(index);
          h.press("y");
        }
        expect((await pending[index]!).approved).toBe(approve);
        expect(completed).toBe(index + 1);
      }
      expect(h.isEditor()).toBe(true);
    } finally {
      authorizer.dispose();
      await Promise.all(pending);
    }
  });

  it("keeps the first prompt visible, then gives the forwarded prompt keyboard focus", async () => {
    const h = harness();
    const authorizer = h.makeAuthorizer();
    try {
      const a = authorizer.authorize(direct());
      const b = authorizer.authorize(forwarded());
      await vi.waitFor(() => expect(h.text()).toContain("Permission Required"));
      expect(h.text()).not.toContain("(Subagent)");
      h.press("y");
      expect((await a).approved).toBe(true);
      await vi.waitFor(() => expect(h.text()).toContain("(Subagent)"));
      h.press("\u001b");
      expect((await b).approved).toBe(false);
      expect(h.isEditor()).toBe(true);
    } finally { authorizer.dispose(); }
  });

  it("cancellation closes the active component before mounting the next prompt", async () => {
    const h = harness();
    const firstRun = new AbortController();
    const nextRun = new AbortController();
    let signal = firstRun.signal;
    const authorizer = h.makeAuthorizer(() => signal);
    try {
      const a = authorizer.authorize(direct());
      signal = nextRun.signal;
      const b = authorizer.authorize(forwarded());
      await vi.waitFor(() => expect(h.text()).toContain("Permission Required"));
      firstRun.abort();
      expect(await a).toMatchObject({ approved: false, confirmationUnavailable: true });
      await vi.waitFor(() => expect(h.text()).toContain("(Subagent)"));
      h.press("y");
      expect((await b).approved).toBe(true);
      expect(h.isEditor()).toBe(true);
    } finally { authorizer.dispose(); }
  });

  it("session disposal restores the editor and cancels queued prompts without displaying them", async () => {
    const h = harness();
    const old = h.makeAuthorizer();
    const a = old.authorize(direct());
    const b = old.authorize(forwarded());
    await vi.waitFor(() => expect(h.text()).toContain("Permission Required"));
    old.dispose();
    expect(h.isEditor()).toBe(true);
    for (const result of await Promise.all([a, b])) expect(result.approved).toBe(false);
    // Old cleanup must not clear a new session's component or steal its focus.
    const next = h.makeAuthorizer();
    try {
      const c = next.authorize(forwarded());
      await vi.waitFor(() => expect(h.text()).toContain("(Subagent)"));
      old.dispose();
      h.press("y");
      expect((await c).approved).toBe(true);
    } finally { next.dispose(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import { DECIDED_BY_HUMAN } from "#test/helpers/decision-fixtures";
import {
  makePromptDetails,
  makePromptPayload,
} from "#test/helpers/prompt-details-fixtures";
import { makePromptPreferences } from "#test/helpers/prompt-view-fixtures";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * This file's semantic defaults over the shared structural fixture: several
 * cases assert `agentName` and `toolName` on a no-override call.
 */
function makeDetails(
  overrides?: Partial<PromptPermissionDetails>,
): PromptPermissionDetails {
  return makePromptDetails({
    requestId: "req-123",
    agentName: "test-agent",
    toolName: "read",
    ...overrides,
  });
}

/** A `PermissionPromptUi` double; the tool-expansion accessors go unused here. */
function makePromptUi() {
  return {
    select: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
}

function makeDeps(
  overrides: {
    requestPermissionDecision?: typeof requestPermissionDecision;
  } = {},
) {
  const events = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
  const ui = makePromptUi();
  const decisionFn =
    overrides.requestPermissionDecision ??
    vi.fn<typeof requestPermissionDecision>().mockResolvedValue({
      approved: true,
      state: "approved",
      decidedBy: DECIDED_BY_HUMAN,
    });
  return {
    deps: {
      ui,
      mode: "tui" as const,
      events,
      getPromptPreferences: () => makePromptPreferences(),
      requestPermissionDecision: decisionFn,
    },
    events,
    ui,
    decisionFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("LocalUserAuthorizer", () => {
  it("serializes direct and forwarded dialogs without serializing other sessions", async () => {
    const closers: Array<(decision: PermissionPromptDecision) => void> = [];
    const { deps, decisionFn, events } = makeDeps({
      requestPermissionDecision: vi.fn<typeof requestPermissionDecision>(() => new Promise(resolve => closers.push(resolve))),
    });
    const authorizer = new LocalUserAuthorizer(deps);
    const first = authorizer.authorize(makeDetails({ requestId: "direct" }));
    const second = authorizer.authorize(makeDetails({ requestId: "forwarded", forwarding: {
      requesterAgentName: "worker", requesterSessionId: "child",
    } }));
    await vi.waitFor(() => expect(decisionFn).toHaveBeenCalledTimes(1));
    expect(events.emit).toHaveBeenCalledTimes(1);
    await new LocalUserAuthorizer(makeDeps().deps).authorize(makeDetails());
    const allowed = { approved: true, state: "approved", decidedBy: DECIDED_BY_HUMAN } as const;
    closers[0]!(allowed);
    expect(await first).toEqual(allowed);
    await vi.waitFor(() => expect(decisionFn).toHaveBeenCalledTimes(2));
    expect(vi.mocked(decisionFn).mock.calls[1]![1]).toBe("Permission Required (Subagent)");
    closers[1]!({ approved: false, state: "denied", decidedBy: DECIDED_BY_HUMAN });
    expect((await second).approved).toBe(false);
  });

  it("a rejected dialog does not poison the queue", async () => {
    const fn = vi.fn<typeof requestPermissionDecision>()
      .mockRejectedValueOnce(new Error("UI failed"))
      .mockResolvedValue({ approved: true, state: "approved", decidedBy: DECIDED_BY_HUMAN });
    const authorizer = new LocalUserAuthorizer(makeDeps({ requestPermissionDecision: fn }).deps);
    const first = authorizer.authorize(makeDetails());
    const second = authorizer.authorize(makeDetails());
    await expect(first).rejects.toThrow("UI failed");
    expect((await second).approved).toBe(true);
  });

  it("cancels a queued ask immediately without opening it or releasing the active dialog", async () => {
    const activeRun = new AbortController();
    const queuedRun = new AbortController();
    let signal = activeRun.signal;
    let close!: (decision: PermissionPromptDecision) => void;
    const { deps, decisionFn, events } = makeDeps({
      requestPermissionDecision: vi.fn<typeof requestPermissionDecision>(() => new Promise(resolve => { close = resolve; })),
    });
    const authorizer = new LocalUserAuthorizer({ ...deps, getSignal: () => signal });
    const active = authorizer.authorize(makeDetails());
    signal = queuedRun.signal;
    const queued = authorizer.authorize(makeDetails());
    await vi.waitFor(() => expect(decisionFn).toHaveBeenCalledTimes(1));
    queuedRun.abort();
    expect(await queued).toMatchObject({ approved: false, decidedBy: { kind: "unavailable" } });
    expect(events.emit).toHaveBeenCalledTimes(1);
    close({ approved: false, state: "denied", decidedBy: DECIDED_BY_HUMAN });
    await active;
    await Promise.resolve();
    expect(decisionFn).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels active and queued asks and never accepts a late approval", async () => {
    let close!: (decision: PermissionPromptDecision) => void;
    const { deps, decisionFn } = makeDeps({
      requestPermissionDecision: vi.fn<typeof requestPermissionDecision>(() => new Promise(resolve => { close = resolve; })),
    });
    const authorizer = new LocalUserAuthorizer(deps);
    const active = authorizer.authorize(makeDetails());
    const queued = authorizer.authorize(makeDetails());
    await vi.waitFor(() => expect(decisionFn).toHaveBeenCalledTimes(1));
    authorizer.dispose();
    for (const result of await Promise.all([active, queued, authorizer.authorize(makeDetails())])) {
      expect(result).toMatchObject({ approved: false, confirmationUnavailable: true });
    }
    close({ approved: true, state: "approved", decidedBy: DECIDED_BY_HUMAN });
    await Promise.resolve();
    expect(decisionFn).toHaveBeenCalledTimes(1);
  });

  it("emits a UI prompt event with normalized surface and value", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        toolName: "bash",
        command: "git push",
        toolInputPreview: "git push",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      agentName: "test-agent",
      request: makePromptPayload().request,
      forwarding: null,
    });
  });

  it("normalizes skill prompt events to the skill surface", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        source: "skill_input",
        toolName: undefined,
        skillName: "deploy-helper",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "skill_input",
      surface: "skill",
      value: "deploy-helper",
      agentName: "test-agent",
      request: makePromptPayload().request,
      forwarding: null,
    });
  });

  it("calls requestPermissionDecision with the threaded view, title, and payload", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);
    const details = makeDetails();

    await authorizer.authorize(details);

    expect(decisionFn).toHaveBeenCalledWith(
      { mode: "tui", ui, ...makePromptPreferences(), signal: expect.any(AbortSignal) },
      "Permission Required",
      details.payload,
      undefined,
    );
  });

  it("passes the sessionLabel option when present", async () => {
    const { deps, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({ sessionLabel: "Yes, for 'read' tool" }),
    );

    expect(decisionFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      { sessionLabel: "Yes, for 'read' tool" },
    );
  });

  it("emits the UI event before calling requestPermissionDecision", async () => {
    const calls: string[] = [];
    const events = {
      emit: vi.fn(() => {
        calls.push("emit");
      }),
      on: vi.fn().mockReturnValue(() => undefined),
    };
    const ui = makePromptUi();
    const decisionFn = vi.fn<typeof requestPermissionDecision>(() => {
      calls.push("dialog");
      return Promise.resolve({
        approved: true,
        state: "approved",
        decidedBy: DECIDED_BY_HUMAN,
      });
    });
    const authorizer = new LocalUserAuthorizer({
      ui,
      mode: "tui",
      events,
      getPromptPreferences: () => makePromptPreferences(),
      requestPermissionDecision: decisionFn,
    });

    await authorizer.authorize(makeDetails());

    expect(calls).toEqual(["emit", "dialog"]);
  });

  describe("forwarded provenance", () => {
    it("emits a non-degraded forwarded event with populated forwarding and the child's display projection", async () => {
      const { deps, events } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          source: "tool_call",
          agentName: "Explore",
          surface: "bash",
          value: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
        requestId: "req-123",
        source: "tool_call",
        surface: "bash",
        value: "git push",
        agentName: "Explore",
        request: makePromptPayload().request,
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });
    });

    it("uses the '(Subagent)' dialog title when the ask is forwarded", async () => {
      const { deps, ui, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);
      const details = makeDetails({
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });

      await authorizer.authorize(details);

      expect(decisionFn).toHaveBeenCalledWith(
        { mode: "tui", ui, ...makePromptPreferences(), signal: expect.any(AbortSignal) },
        "Permission Required (Subagent)",
        details.payload,
        undefined,
      );
    });

    it("offers a sessionScope when the forwarded ask carries a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
          sessionApproval: { grants: [{ surface: "bash", pattern: "git *" }] },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        "Permission Required (Subagent)",
        expect.anything(),
        {
          sessionScope: {
            subagentLabel: "This subagent ('Explore') only",
            servingSessionLabel:
              'The whole session — allow bash "git *" for parent and all subagents',
          },
        },
      );
    });

    it("names every path in the scope label when the ask covers several", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "cat /outside/a.ts > /elsewhere/b.ts",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
          sessionApproval: {
            grants: [
              { surface: "external_directory_read", pattern: "/outside/*" },
              { surface: "external_directory_write", pattern: "/elsewhere/*" },
            ],
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        expect.objectContaining({
          sessionScope: expect.objectContaining({
            servingSessionLabel:
              "The whole session — allow external_directory 2 paths for parent and all subagents",
          }),
        }),
      );
    });

    it("offers no sessionScope for a forwarded ask without a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        undefined,
      );
    });
  });

  describe("both-directions session grant (#813)", () => {
    /** Assert the options a bash ask with these grants reaches the dialog with. */
    async function expectOptionsFor(
      grants: { surface: string; pattern: string }[],
      expected: unknown,
    ) {
      const { deps, decisionFn } = makeDeps();
      await new LocalUserAuthorizer(deps).authorize(
        makeDetails({ toolName: "bash", sessionApproval: { grants } }),
      );
      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        expected,
      );
    }

    it("offers the width option when every grant proves one direction", async () => {
      await expectOptionsFor(
        [{ surface: "external_directory_write", pattern: "/tmp/*" }],
        {
          sessionLabel: 'Yes, allow writes to "/tmp/*" for this session',
          sessionWidth: {
            label: 'Yes, allow reads and writes to "/tmp/*" for this session',
          },
        },
      );
    });

    it("counts the paths when several grants prove the same direction", async () => {
      await expectOptionsFor(
        [
          { surface: "external_directory_read", pattern: "/outside/a/*" },
          { surface: "external_directory_read", pattern: "/outside/b/*" },
        ],
        {
          sessionLabel: "Yes, allow reads to 2 paths for this session",
          sessionWidth: {
            label: "Yes, allow reads and writes to 2 paths for this session",
          },
        },
      );
    });

    it("offers no width option when the grants prove different directions", async () => {
      await expectOptionsFor(
        [
          { surface: "external_directory_read", pattern: "/outside/a/*" },
          { surface: "external_directory_write", pattern: "/outside/b/*" },
        ],
        undefined,
      );
    });

    it("offers no width option for a non-directional surface", async () => {
      await expectOptionsFor(
        [{ surface: "bash", pattern: "git *" }],
        undefined,
      );
    });

    it("offers no width option for an ask with no suggestion at all", async () => {
      const { deps, decisionFn } = makeDeps();
      await new LocalUserAuthorizer(deps).authorize(makeDetails());
      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        undefined,
      );
    });
  });

  it("returns the decision from requestPermissionDecision", async () => {
    const decision: PermissionPromptDecision = {
      approved: false,
      state: "denied",
      decidedBy: DECIDED_BY_HUMAN,
    };
    const { deps } = makeDeps({
      requestPermissionDecision: vi
        .fn<typeof requestPermissionDecision>()
        .mockResolvedValue(decision),
    });
    const authorizer = new LocalUserAuthorizer(deps);

    const result = await authorizer.authorize(makeDetails());

    expect(result).toEqual(decision);
  });
});

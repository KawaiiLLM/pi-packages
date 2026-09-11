/**
 * Tests that handleInput emits permissions:decision events for skill input gates.
 */
import { describe, expect, it, vi } from "vitest";

import type { AskEscalator } from "#src/authority/authorizer-selection";
import {
  DECIDED_BY_ABSENT_AUTHORITY,
  DECIDED_BY_HUMAN,
} from "#test/helpers/decision-fixtures";
import {
  getDecisionEvents,
  makeCheckResult,
  makeCtx,
  makeHandler,
} from "#test/helpers/handler-fixtures";

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a checkPermission mock returning a skill-surface result. */
function makeSkillCheckPermission(state: "allow" | "deny" | "ask") {
  return vi.fn().mockReturnValue(
    makeCheckResult({
      state,
      toolName: "skill",
      source: "skill",
      origin: "global",
      matchedPattern: "*",
    }),
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("handleInput decision events — skill gate", () => {
  it.each(["interactive", "rpc"] as const)(
    "treats %s skill input as one-shot consent, with audit and no session grant",
    async (source) => {
      const { handler, events, logger, prompter, recorder } = makeHandler({
        session: { checkPermission: makeSkillCheckPermission("ask") },
      });
      const result = await handler.handleInput(
        { text: "/skill:explorer extra instructions", source },
        makeCtx({ hasUI: false }),
      );
      expect(result).toEqual({ action: "continue" });
      expect(prompter.escalate).not.toHaveBeenCalled();
      expect(recorder.getRuleset()).toEqual([]);
      const decisions = getDecisionEvents(events);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        surface: "skill",
        value: "explorer",
        result: "allow",
        resolution: "user_approved",
        matchedPattern: "*",
        origin: "global",
      });
      expect(logger.review).toHaveBeenCalledWith(
        "permission_request.user_approved",
        expect.objectContaining({
          requestId: decisions[0].requestId,
          source: "skill_input",
          inputSource: source,
          skillName: "explorer",
          decidedBy: { kind: "user", via: source },
          resolution: "user_approved",
        }),
      );
      // The consent must not cover later extension-injected calls.
      await handler.handleInput(
        { text: "/skill:explorer", source: "extension" }, makeCtx(),
      );
      expect(prompter.escalate).toHaveBeenCalledOnce();
      expect(recorder.getRuleset()).toEqual([]);
    },
  );

  it.each(["interactive", "rpc"] as const)(
    "preserves policy deny for %s skill input",
    async (source) => {
      const { handler, events, prompter } = makeHandler({
        session: { checkPermission: makeSkillCheckPermission("deny") },
      });
      expect(await handler.handleInput(
        { text: "/skill:restricted", source }, makeCtx(),
      )).toEqual({ action: "handled" });
      expect(prompter.escalate).not.toHaveBeenCalled();
      expect(getDecisionEvents(events)).toEqual([
        expect.objectContaining({ result: "deny", resolution: "policy_deny" }),
      ]);
    },
  );

  it.each(["extension", undefined] as const)(
    "still escalates an ask from %s input without recording input consent",
    async (source) => {
      const { handler, logger, prompter } = makeHandler({
        session: { checkPermission: makeSkillCheckPermission("ask") },
      });
      await handler.handleInput({ text: "/skill:explorer", source }, makeCtx());
      expect(prompter.escalate).toHaveBeenCalledOnce();
      // Only the real prompter may record approval on these sources.
      expect(logger.review).not.toHaveBeenCalled();
    },
  );

  it("does not emit when input is not a skill invocation", async () => {
    const { handler, events } = makeHandler();
    await handler.handleInput({ text: "hello world" }, makeCtx());
    expect(getDecisionEvents(events)).toHaveLength(0);
  });

  it("emits allow with policy_allow for an allowed skill", async () => {
    const { handler, events } = makeHandler({
      session: { checkPermission: makeSkillCheckPermission("allow") },
    });
    await handler.handleInput({ text: "/skill:librarian" }, makeCtx());

    const decisions = getDecisionEvents(events);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      surface: "skill",
      value: "librarian",
      result: "allow",
      resolution: "policy_allow",
    });
  });

  it("emits deny with policy_deny for a denied skill", async () => {
    const { handler, events } = makeHandler({
      session: { checkPermission: makeSkillCheckPermission("deny") },
    });
    await handler.handleInput({ text: "/skill:restricted" }, makeCtx());

    const decisions = getDecisionEvents(events);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      surface: "skill",
      value: "restricted",
      result: "deny",
      resolution: "policy_deny",
    });
  });

  it("emits allow with user_approved when state=ask and user approves", async () => {
    const { handler, events } = makeHandler({
      session: {
        checkPermission: makeSkillCheckPermission("ask"),
      },
      prompter: {
        escalate: vi.fn<AskEscalator["escalate"]>().mockResolvedValue({
          approved: true,
          state: "approved",
          decidedBy: DECIDED_BY_HUMAN,
        }),
      },
    });
    await handler.handleInput({ text: "/skill:explorer" }, makeCtx());

    const decisions = getDecisionEvents(events);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      surface: "skill",
      value: "explorer",
      result: "allow",
      resolution: "user_approved",
    });
  });

  it("emits deny with user_denied when state=ask and user denies", async () => {
    const { handler, events } = makeHandler({
      session: {
        checkPermission: makeSkillCheckPermission("ask"),
      },
      prompter: {
        escalate: vi.fn<AskEscalator["escalate"]>().mockResolvedValue({
          approved: false,
          state: "denied",
          decidedBy: DECIDED_BY_HUMAN,
        }),
      },
    });
    await handler.handleInput({ text: "/skill:explorer" }, makeCtx());

    const decisions = getDecisionEvents(events);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      surface: "skill",
      value: "explorer",
      result: "deny",
      resolution: "user_denied",
    });
  });

  it("emits deny with confirmation_unavailable when state=ask but no UI", async () => {
    const { handler, events } = makeHandler({
      session: {
        checkPermission: makeSkillCheckPermission("ask"),
      },
      prompter: {
        escalate: vi.fn<AskEscalator["escalate"]>().mockResolvedValue({
          approved: false,
          state: "denied",
          confirmationUnavailable: true,
          decidedBy: DECIDED_BY_ABSENT_AUTHORITY,
        }),
      },
    });
    await handler.handleInput(
      { text: "/skill:explorer" },
      makeCtx({ hasUI: false }),
    );

    const decisions = getDecisionEvents(events);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      surface: "skill",
      value: "explorer",
      result: "deny",
      resolution: "confirmation_unavailable",
    });
  });

  it("emits allow with auto_approved when yolo decided the escalated ask", async () => {
    const { handler, events } = makeHandler({
      session: {
        checkPermission: makeSkillCheckPermission("ask"),
      },
      prompter: {
        escalate: vi.fn<AskEscalator["escalate"]>().mockResolvedValue({
          approved: true,
          state: "approved",
          decidedBy: { kind: "yolo", pattern: "*" },
        }),
      },
    });
    await handler.handleInput({ text: "/skill:explorer" }, makeCtx());

    const decisions = getDecisionEvents(events);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      surface: "skill",
      value: "explorer",
      result: "allow",
      resolution: "auto_approved",
    });
  });
});

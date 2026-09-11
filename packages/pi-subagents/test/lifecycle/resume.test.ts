import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { InterruptHandler } from "#src/handlers/interrupt";
import { SessionLifecycleHandler } from "#src/handlers/lifecycle";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { NotificationManager } from "#src/observation/notification";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { AgentTool } from "#src/tools/agent-tool";
import { GetResultTool } from "#src/tools/get-result-tool";
import { createToolDeps } from "#test/helpers/make-deps";
import { createMockSession, toAgentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";

/** Real SubagentSession; only the SDK prompt/abort boundary is simulated. */
function controlledSession() {
  let pending: ReturnType<typeof Promise.withResolvers<string>> | undefined;
  let holdAbort = false;
  const session = createMockSession();
  const prompt = vi.fn(async (text: string) => {
    let answer = "initial answer";
    if (text !== "initial") {
      pending = Promise.withResolvers<string>();
      answer = await pending.promise;
      pending = undefined;
    }
    const message = {
      role: "assistant",
      content: [{ type: "text", text: answer }],
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheWrite: 0 },
    };
    session.messages.push(message);
    session.emit({ type: "message_end", message });
  });
  const abort = vi.fn(async () => {
    if (!holdAbort) pending?.reject(new Error("cancelled"));
  });
  session.prompt = prompt;
  session.abort = abort;
  const child = new SubagentSession(toAgentSession(session), {
    outputFile: "/sessions/child.jsonl",
    sessionId: "child",
    sessionDir: "/sessions",
    agentName: "general-purpose",
    agentMaxTurns: undefined,
    parentContext: undefined,
    lifecycle: createChildLifecycleMock(),
  });
  return {
    child, session, prompt, abort,
    finish: (text = "resumed answer") => pending!.resolve(text),
    fail: () => pending!.reject(new Error("provider unavailable")),
    holdAbort: () => { holdAbort = true; },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function harness(limit = 1) {
  const sendMessage = vi.fn();
  const notifications = new NotificationManager(sendMessage);
  const emit = vi.fn();
  const appendEntry = vi.fn();
  const observer = new SubagentEventsObserver({ emit, appendEntry, notifications });
  const children: ReturnType<typeof controlledSession>[] = [];
  const registry = new AgentTypeRegistry(() => new Map());
  const manager = new SubagentManager({
    limiter: new ConcurrencyLimiter(() => limit),
    baseCwd: "/repo",
    registry,
    observer,
    createSubagentSession: async () => {
      const child = controlledSession();
      children.push(child);
      return child.child;
    },
  });
  cleanups.push(async () => {
    notifications.dispose();
    manager.abortAll();
    await manager.dispose();
  });
  const deps = createToolDeps({ manager, registry });
  const tool = new AgentTool(manager, deps.runtime, deps.settings, registry, deps.agentDir).toToolDefinition();
  const execute = (id: string, background: boolean, signal?: AbortSignal) => tool.execute(
    "resume-call",
    { resume: id, prompt: "continue", description: "resume", subagent_type: "general-purpose", run_in_background: background },
    signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  const seed = async () => {
    const record = await manager.spawnAndWait(STUB_SNAPSHOT, "general-purpose", "initial", { description: "task" });
    record.markConsumed();
    return { record, child: children.at(-1)! };
  };
  const resumedEvents = () => emit.mock.calls.filter(([name]) => name === "subagents:resumed");
  return { manager, notifications, sendMessage, emit, appendEntry, execute, seed, resumedEvents, registry };
}

describe("resume — foreground/background lifecycle integration", () => {
  it("returns the same ID immediately in background, clears old delivery ownership, and announces completion", async () => {
    const h = harness();
    const { record, child } = await h.seed();
    const oldRun = record.promise;
    const parent = new AbortController();
    new InterruptHandler(h.manager, () => false).handleTurnStart({ signal: parent.signal });
    h.notifications.onParentAgentStart();

    const result = await h.execute(record.id, true, parent.signal);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`Agent ID: ${record.id}`) });
    expect(result.details).toMatchObject({ status: "background", agentId: record.id });
    expect(record.isBackground).toBe(true);
    expect(record.status).toBe("running");
    expect(record.promise).not.toBe(oldRun);
    expect(record.claimed).toBe(false);
    expect(record.consumed).toBe(false);

    parent.abort();
    h.notifications.onParentAgentSettled();
    expect(child.abort).not.toHaveBeenCalled();
    expect(record.status).toBe("running");
    child.finish();
    await record.promise;
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.sendMessage.mock.calls[0][0].content).toContain("resumed answer");
    expect(h.resumedEvents()).toHaveLength(1);
    expect(record.resumeRefusal).toBeUndefined();
  });

  it("foreground resume blocks, claims before completion, consumes the result, and can switch back to background", async () => {
    const h = harness();
    const { record, child } = await h.seed();
    await h.execute(record.id, true);
    child.finish("background answer");
    await record.promise;
    h.sendMessage.mockClear();

    let settled = false;
    const result = h.execute(record.id, false).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(record.isBackground).toBe(false);
    expect(record.claimed).toBe(true);
    expect(record.consumed).toBe(false);
    child.finish("foreground answer");
    expect((await result).content[0]).toMatchObject({ text: expect.stringContaining("foreground answer") });
    expect(record.consumed).toBe(true);
    expect(h.sendMessage).not.toHaveBeenCalled();

    await h.execute(record.id, true);
    expect(record.claimed).toBe(false);
    child.finish("third answer");
    await record.promise;
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(record.result).toBe("third answer");
  });

  it("foreground resume follows the parent signal even when abort-all-on-interrupt is disabled", async () => {
    const h = harness();
    const { record, child } = await h.seed();
    const parent = new AbortController();
    new InterruptHandler(h.manager, () => false).handleTurnStart({ signal: parent.signal });
    const result = h.execute(record.id, false, parent.signal);
    parent.abort();
    await result;
    expect(child.abort).toHaveBeenCalledOnce();
    expect(record.status).toBe("stopped");
    expect(record.consumed).toBe(true);
    expect(h.sendMessage).not.toHaveBeenCalled();

    // A stopped run's aborted controller must not poison its next resume.
    const stoppedController = record.abortController;
    await h.execute(record.id, true, parent.signal);
    expect(record.abortController).not.toBe(stoppedController);
    expect(record.abortController.signal.aborted).toBe(false);
    child.finish();
    await record.promise;
    expect(record.status).toBe("completed");
  });

  it("rejects a pre-aborted foreground invocation without resetting the previous outcome", async () => {
    const h = harness();
    const { record, child } = await h.seed();
    const priorPromise = record.promise;
    await h.execute(record.id, false, AbortSignal.abort(new Error("already cancelled")));
    expect(child.prompt).toHaveBeenCalledTimes(1);
    expect(record.promise).toBe(priorPromise);
    expect(record.result).toBe("initial answer");
    expect(record.consumed).toBe(true);
  });

  it.each(["explicit", "abortAll", "interrupt", "shutdown"] as const)("%s still cancels a background resume", async (kind) => {
    const h = harness();
    const { record, child } = await h.seed();
    const parent = new AbortController();
    new InterruptHandler(h.manager, () => kind === "interrupt").handleTurnStart({ signal: parent.signal });
    await h.execute(record.id, true, parent.signal);
    if (kind === "explicit") expect(h.manager.abort(record.id)).toBe(true);
    else if (kind === "abortAll") expect(h.manager.abortAll()).toBe(1);
    else if (kind === "interrupt") parent.abort();
    else {
      const lifecycle = new SessionLifecycleHandler(
        { setSessionContext: vi.fn(), clearSessionContext: vi.fn() },
        h.manager, () => h.notifications.dispose(), vi.fn(),
      );
      await lifecycle.handleSessionShutdown(); // Shared by quit, reload, and successful session switch.
      expect(h.manager.getRecord(record.id)).toBeUndefined();
      expect(child.session.dispose).toHaveBeenCalledOnce();
    }
    await record.promise;
    expect(child.abort).toHaveBeenCalledOnce();
    expect(record.status).toBe("stopped");
    expect(h.resumedEvents()).toHaveLength(1);
    if (kind === "shutdown") expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses another resume while running or stopping, without resetting state or listeners", async () => {
    const h = harness();
    const { record, child } = await h.seed();
    child.holdAbort();
    await h.execute(record.id, true);
    const run = record.promise;
    const controller = record.abortController;
    expect(await h.manager.resume(record.id, "overlap")).toBeUndefined();
    h.manager.abort(record.id);
    expect(await h.manager.resume(record.id, "still stopping")).toBeUndefined();
    expect(record.promise).toBe(run);
    expect(record.abortController).toBe(controller);
    expect(child.prompt).toHaveBeenCalledTimes(2);
    child.finish("partial output");
    await run;
    expect(record.resumeRefusal).toBeUndefined();
    expect(record.status).toBe("stopped");
  });

  it("detaches a previous foreground signal before a new background resume", async () => {
    const h = harness();
    const { record, child } = await h.seed();
    const parent = new AbortController();
    const foreground = h.execute(record.id, false, parent.signal);
    child.finish();
    await foreground;
    await h.execute(record.id, true);
    parent.abort();
    expect(child.abort).not.toHaveBeenCalled();
    expect(record.status).toBe("running");
    child.finish();
    await record.promise;
  });

  it("refuses resume of the initial run while it is still executing", async () => {
    const h = harness();
    const id = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "blocked initial", {
      description: "initial", background: { kind: "explicit", isBackground: true },
    });
    const record = h.manager.getRecord(id)!;
    await vi.waitFor(() => expect(record.isSessionReady()).toBe(true));
    const run = record.promise;
    expect(await h.manager.resume(id, "overlap")).toBeUndefined();
    expect(record.promise).toBe(run);
    expect(record.status).toBe("running");
  });

  it("background failure is recorded and announced once, then releases its slot", async () => {
    const h = harness();
    const a = await h.seed();
    const b = await h.seed();
    await h.execute(a.record.id, true);
    await h.execute(b.record.id, true);
    expect(b.record.status).toBe("queued");
    a.child.fail();
    await a.record.promise;
    await vi.waitFor(() => expect(b.record.status).toBe("running"));
    expect(a.record.status).toBe("error");
    expect(h.sendMessage).toHaveBeenCalledOnce();
    b.child.finish();
    await b.record.promise;
  });
});

describe("resume — queue admission, cancellation, and result collection", () => {
  it("shares the FIFO limiter with fresh spawns and publishes the queued promise immediately", async () => {
    const h = harness();
    const a = await h.seed();
    const b = await h.seed();
    await h.execute(a.record.id, true);
    const backgroundResult = await h.execute(b.record.id, true);
    expect(backgroundResult.content[0]).toMatchObject({ text: expect.stringContaining("queued") });
    expect(b.record.status).toBe("queued");
    expect(b.record.result).toBeUndefined();
    expect(b.record.claimed).toBe(false);
    expect(b.record.consumed).toBe(false);
    expect(b.child.prompt).toHaveBeenCalledTimes(1);
    expect(await h.manager.resume(b.record.id, "duplicate")).toBeUndefined();

    const fresh = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "initial", {
      description: "fresh", background: { kind: "explicit", isBackground: true },
    });
    expect(h.manager.getRecord(fresh)!.status).toBe("queued");
    let collected = false;
    const result = new GetResultTool(h.manager, h.registry).execute(
      "get", { agent_id: b.record.id, wait: true }, new AbortController().signal, undefined, undefined,
    ).then(value => { collected = true; return value; });
    let allSettled = false;
    const all = h.manager.waitForAll().then(() => { allSettled = true; });
    await Promise.resolve();
    expect(collected).toBe(false);
    expect(allSettled).toBe(false);
    a.child.finish();
    await a.record.promise;
    await vi.waitFor(() => expect(b.record.status).toBe("running"));
    expect(h.manager.getRecord(fresh)!.status).toBe("queued");
    b.child.finish("queued answer");
    expect((await result).content[0]).toMatchObject({ text: expect.stringContaining("queued answer") });
    expect(b.record.consumed).toBe(true);
    await all;
    expect(h.manager.getRecord(fresh)!.status).toBe("completed");
  });

  it("foreground resume bypasses a full background limiter", async () => {
    const h = harness();
    const a = await h.seed();
    const b = await h.seed();
    await h.execute(a.record.id, true);
    const foreground = h.execute(b.record.id, false);
    expect(b.record.status).toBe("running");
    expect(b.child.prompt).toHaveBeenCalledTimes(2);
    b.child.finish();
    await foreground;
    expect(a.record.status).toBe("running");
  });

  it("cancels a queued resume and settles its waiter without waiting for an occupied slot", async () => {
    const h = harness();
    const a = await h.seed();
    const b = await h.seed();
    await h.execute(a.record.id, true);
    await h.execute(b.record.id, true);
    const cancelledRun = b.record.promise;
    const waiting = b.record.waitUntilSettled(new AbortController().signal);
    expect(h.manager.abort(b.record.id)).toBe(true);
    await waiting;
    await cancelledRun;
    expect(b.record.status).toBe("stopped");
    expect(b.record.stoppedWhileQueued).toBe(true);
    expect(b.child.prompt).toHaveBeenCalledTimes(1);
    expect(h.resumedEvents()).toHaveLength(1);

    // A second admission must not revive the old queued thunk.
    await h.execute(b.record.id, true);
    expect(b.record.stoppedWhileQueued).toBe(false);
    a.child.finish();
    await a.record.promise;
    await vi.waitFor(() => expect(b.record.status).toBe("running"));
    expect(b.child.prompt.mock.calls.map(([text]) => text)).toEqual(["initial", "continue"]);
    b.child.finish();
    await b.record.promise;
    expect(h.resumedEvents()).toHaveLength(3);
  });

  it("abortAll settles queued resumes without executing them", async () => {
    const h = harness();
    const a = await h.seed();
    const b = await h.seed();
    await h.execute(a.record.id, true);
    await h.execute(b.record.id, true);
    expect(h.manager.abortAll()).toBe(2);
    await Promise.all([a.record.promise, b.record.promise]);
    expect(b.child.prompt).toHaveBeenCalledTimes(1);
    expect(b.record.status).toBe("stopped");
    expect(h.resumedEvents()).toHaveLength(2);
    expect(h.manager.hasRunning()).toBe(false);
  });
});

describe("resume — withheld notification with a reused record", () => {
  it("does not flush an old completion while the resumed run is stopping", async () => {
    const h = harness();
    const { record, child } = await h.seed();
    h.notifications.onParentAgentStart();
    await h.execute(record.id, true);
    child.finish("old result");
    await record.promise;
    child.holdAbort();
    await h.execute(record.id, true);
    h.manager.abort(record.id);
    expect(record.status).toBe("stopped");
    h.notifications.onParentAgentSettled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    child.finish("stopped resume output");
    await record.promise;
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.sendMessage.mock.calls[0][0].content).toContain("stopped resume output");
  });

  it.each([false, true])("drops an old completion while the new resume is active (queued=%s)", async (queued) => {
    const h = harness();
    const a = await h.seed();
    const b = await h.seed();
    h.notifications.onParentAgentStart();
    a.record.release();
    // Begin an unconsumed background completion, then reuse its record before flush.
    await h.execute(a.record.id, true);
    a.child.finish("old result");
    await a.record.promise;
    if (queued) await h.execute(b.record.id, true);
    await h.execute(a.record.id, true);
    expect(a.record.status).toBe(queued ? "queued" : "running");
    h.notifications.onParentAgentSettled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    if (queued) {
      b.child.finish();
      await b.record.promise;
      await vi.waitFor(() => expect(a.record.status).toBe("running"));
      h.sendMessage.mockClear();
    }
    a.child.finish("new result");
    await a.record.promise;
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.sendMessage.mock.calls[0][0].content).toContain("new result");
    expect(h.sendMessage.mock.calls[0][0].content).not.toContain("old result");
  });
});

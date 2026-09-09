import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHILD_SHUTDOWN_TIMEOUT_MS,
  emitChildSessionShutdown,
  type ShutdownCapableSession,
} from "#src/lifecycle/child-shutdown";

/** A child session whose runner records what it was asked to emit. */
function createShutdownCapableSession(
  overrides: Partial<ShutdownCapableSession> = {},
) {
  const emit = vi.fn((_event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> =>
    Promise.resolve(undefined),
  );
  const session: ShutdownCapableSession = {
    hasExtensionHandlers: vi.fn((_eventType: string): boolean => true),
    extensionRunner: { emit },
    ...overrides,
  };
  return { session, emit };
}

describe("emitChildSessionShutdown — emission", () => {
  it("emits one session_shutdown with reason quit when the child has handlers", async () => {
    const { session, emit } = createShutdownCapableSession();

    await emitChildSessionShutdown(session);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("asks only about the session_shutdown handler set", async () => {
    const { session } = createShutdownCapableSession();

    await emitChildSessionShutdown(session);

    expect(session.hasExtensionHandlers).toHaveBeenCalledWith("session_shutdown");
  });

  it("emits nothing when the child registered no shutdown handlers", async () => {
    const { session, emit } = createShutdownCapableSession({
      hasExtensionHandlers: vi.fn((_eventType: string): boolean => false),
    });

    await emitChildSessionShutdown(session);

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits when the session cannot report its handler set", async () => {
    const { session, emit } = createShutdownCapableSession({
      hasExtensionHandlers: undefined,
    });

    await emitChildSessionShutdown(session);

    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe("emitChildSessionShutdown — failure tolerance", () => {
  it("resolves when the session exposes no extension runner", async () => {
    const { session } = createShutdownCapableSession({ extensionRunner: undefined });

    await expect(emitChildSessionShutdown(session)).resolves.toBeUndefined();
  });

  it("resolves when the emit rejects", async () => {
    const { session } = createShutdownCapableSession({
      extensionRunner: { emit: vi.fn(() => Promise.reject(new Error("boom"))) },
    });

    await expect(emitChildSessionShutdown(session)).resolves.toBeUndefined();
  });

  it("resolves when the emit throws synchronously", async () => {
    const { session } = createShutdownCapableSession({
      extensionRunner: {
        emit: vi.fn((): Promise<unknown> => {
          throw new Error("boom");
        }),
      },
    });

    await expect(emitChildSessionShutdown(session)).resolves.toBeUndefined();
  });
});

describe("emitChildSessionShutdown — timeout bound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createHangingSession() {
    return createShutdownCapableSession({
      extensionRunner: { emit: vi.fn((): Promise<unknown> => new Promise(() => {})) },
    });
  }

  it("waits for the bound, then resolves, when a handler never settles", async () => {
    const { session } = createHangingSession();
    let settled = false;
    const pending = emitChildSessionShutdown(session, 5_000).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("bounds the wait at CHILD_SHUTDOWN_TIMEOUT_MS by default", async () => {
    const { session } = createHangingSession();
    let settled = false;
    const pending = emitChildSessionShutdown(session).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(CHILD_SHUTDOWN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("leaves no pending timer after a timed-out emit", async () => {
    const { session } = createHangingSession();
    const pending = emitChildSessionShutdown(session, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer as soon as the emit settles", async () => {
    const { session } = createShutdownCapableSession();

    await emitChildSessionShutdown(session, 5_000);

    expect(vi.getTimerCount()).toBe(0);
  });
});

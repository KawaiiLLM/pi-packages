/**
 * child-shutdown.ts — Bounded `session_shutdown` emission for a child session (issue #709).
 *
 * A child session binds the full extension set, so `session_start` fires and every
 * inherited extension initializes. Pi's `AgentSession.dispose()` does not emit the
 * matching `session_shutdown` — only `AgentSessionRuntime` does, and children do not
 * use that path — so extension-owned subprocesses, timers, and sockets outlive the
 * child. This module supplies the missing half of the pair.
 *
 * Two constraints shape it:
 *
 * 1. `AgentSession.dispose()` invalidates the extension runner, and every `ctx`
 *    accessor throws once invalidated. The emit must therefore be awaited to
 *    completion *before* disposal, never fired and forgotten alongside it.
 * 2. Pi's runner catches each handler's errors but does not bound a handler that
 *    hangs. An unbounded await here would stall the parent's teardown and Pi's exit,
 *    so the emit races a timeout and teardown proceeds either way.
 *
 * Nothing here throws: a child that will not shut down cleanly must still be disposed.
 */

import { debugLog } from "#src/debug";

/** Upper bound on how long one child's shutdown handlers may take. */
export const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

const SESSION_SHUTDOWN = "session_shutdown";

/** The event a disposed child session dispatches to its extensions. */
interface ChildSessionShutdownEvent {
  type: typeof SESSION_SHUTDOWN;
  reason: "quit";
}

/**
 * Narrow session seam — only what child shutdown reads.
 *
 * Both members are optional so the emitter stays safe against a Pi build that
 * predates them; either absence means "nothing to emit."
 */
export interface ShutdownCapableSession {
  hasExtensionHandlers?(eventType: string): boolean;
  readonly extensionRunner?: {
    emit(event: ChildSessionShutdownEvent): Promise<unknown>;
  };
}

/**
 * Dispatch one `session_shutdown` to a child's extensions and await it, bounded
 * by `timeoutMs`. Resolves quietly on every failure mode — no runner, no handlers,
 * a rejected emit, or a handler that never settles — so disposal always proceeds.
 */
export async function emitChildSessionShutdown(
  session: ShutdownCapableSession,
  timeoutMs: number = CHILD_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const runner = session.extensionRunner;
  if (!runner || !hasShutdownHandlers(session)) return;

  try {
    const emitted = runner.emit({ type: SESSION_SHUTDOWN, reason: "quit" });
    if ((await settleWithinBound(emitted, timeoutMs)) === "timed-out") {
      debugLog("child session_shutdown exceeded its bound (ms)", timeoutMs);
    }
  } catch (err) {
    debugLog("child session_shutdown emit", err);
  }
}

/** Whether the child has anything to hear the event; unknown counts as yes. */
function hasShutdownHandlers(session: ShutdownCapableSession): boolean {
  return session.hasExtensionHandlers?.(SESSION_SHUTDOWN) ?? true;
}

type ShutdownOutcome = "settled" | "timed-out";

/**
 * Resolve when `emitted` settles or when `timeoutMs` elapses, whichever is first.
 * A rejection counts as settled (the caller logs it); the timer is always cleared,
 * so a prompt shutdown leaves nothing holding the event loop.
 */
async function settleWithinBound(
  emitted: Promise<unknown>,
  timeoutMs: number,
): Promise<ShutdownOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<ShutdownOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve("timed-out");
    }, timeoutMs);
  });
  const settled = emitted.then(
    (): ShutdownOutcome => "settled",
    (err: unknown): ShutdownOutcome => {
      debugLog("child session_shutdown handler", err);
      return "settled";
    },
  );

  try {
    return await Promise.race([settled, bound]);
  } finally {
    clearTimeout(timer);
  }
}

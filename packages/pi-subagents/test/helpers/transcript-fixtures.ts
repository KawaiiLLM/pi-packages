import type { TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { SessionMessage } from "#src/types";
import type { TranscriptSource } from "#src/ui/session-navigation";

/**
 * Minimal TUI double for transcript rendering: terminal dimensions plus a
 * `requestRender` spy. Pi's per-entry components read nothing else from it.
 */
export function mockTui(rows = 40, columns = 80): TUI {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as unknown as TUI;
}

/**
 * A `TranscriptSource` double with a single user message; override any method.
 * Shared by the overlay and transcript-content suites, which both consume the
 * source seam rather than a live record.
 */
export function fakeSource(overrides: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    getMessages: () => [{ role: "user", content: "Hello world" }] as unknown as SessionMessage[],
    subscribe: () => () => {},
    streaming: () => undefined,
    getToolDefinition: () => undefined,
    ...overrides,
  };
}

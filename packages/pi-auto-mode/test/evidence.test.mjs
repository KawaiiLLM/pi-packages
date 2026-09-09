import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewRequest, fullActionEvidence, toolInputFromPermission } from "../src/evidence.mjs";
import { transcriptFromEntries } from "../src/vendor/toolkit/transcript.ts";
import { buildReviewPrompt } from "../src/vendor/toolkit/prompt.ts";

const message = (id, role, content) => ({ id, type: "message", message: { role, content } });
const details = (input) => ({ toolName: "write", payload: { request: { toolName: "write", surface: "write" }, evidence: [{ label: "input", text: fullActionEvidence(input) }] } });

test("uses Toolkit transcript and prompt functions without extra framing or limits", () => {
  const entries = [message("u", "user", "Implement the requested change"), message("a", "assistant", "Plan")];
  const input = { path: "a", content: "hello" };
  assert.equal(buildReviewRequest(entries, details(input), "/repo"), buildReviewPrompt({ transcript: transcriptFromEntries(entries).text, toolName: "write", toolInput: input, cwd: "/repo" }));
});

test("write larger than 64 KiB is passed through Toolkit's 8000-character truncation", () => {
  const input = { path: "a", content: "x".repeat(70000) + "TAIL_MARKER" };
  assert.deepEqual(toolInputFromPermission(details(input)), input);
  const prompt = buildReviewRequest([], details(input), "/repo");
  assert.equal(prompt, buildReviewPrompt({ transcript: "", toolName: "write", toolInput: input, cwd: "/repo" }));
  assert.ok(!prompt.includes("TAIL_MARKER"));
  assert.ok(prompt.includes("..."));
});

test("uses complete enclosing bash command rather than gated subcommand", () => {
  assert.deepEqual(toolInputFromPermission({ command: "second", payload: { request: { surface: "bash", value: "second" }, evidence: [{ label: "full command", text: "first && second" }] } }), { command: "first && second" });
});

test("retains plugin evidence when raw arguments are unavailable, without an extra rejection rule", () => {
  const request = { payload: { request: { surface: "mcp" }, evidence: [{ label: "input", text: "summary only" }] } };
  assert.deepEqual(toolInputFromPermission(request), { permissionEvidence: request.payload, accessIntent: undefined });
});

test("Toolkit keeps roles and excludes thinking", () => {
  const result = transcriptFromEntries([
    message("u", "user", "Do the task"),
    message("a", "assistant", [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "Plan" }]),
    message("t", "toolResult", "tool result"),
    { id: "s", type: "compaction", summary: "earlier summary" },
  ]);
  assert.ok(result.text.includes("[user]"));
  assert.ok(result.text.includes("[assistant]"));
  assert.ok(result.text.includes("[tool]"));
  assert.ok(!result.text.includes("PRIVATE"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewRequest, fullActionEvidence, toolInputFromPermission } from "../src/evidence.mjs";
import { transcriptFromEntries } from "../src/vendor/toolkit/transcript.ts";
import { buildReviewPrompt } from "../src/vendor/toolkit/prompt.ts";

const message = (id, role, content) => ({ id, type: "message", message: { role, content } });
const details = (input) => ({ toolName: "write", payload: { request: { toolName: "write", surface: "write" }, evidence: [{ label: "input", text: fullActionEvidence(input) }] } });

test("uses the local transcript selection with unchanged Toolkit prompt framing", () => {
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

test("subagent tasks bypass the generic 200-character preview and use Toolkit's action bound", () => {
  const input = {
    subagent_type: "general-purpose",
    description: "Continue approved work",
    prompt: "x".repeat(3_800) + "TASK_TAIL",
    run_in_background: true,
  };
  const request = { toolName: "subagent", payload: { request: { toolName: "subagent", surface: "subagent" }, evidence: [{ label: "input", text: fullActionEvidence(input) }] } };
  assert.deepEqual(toolInputFromPermission(request), input);
  assert.ok(buildReviewRequest([], request, "/repo").includes("TASK_TAIL"));

  const oversized = { ...input, prompt: "x".repeat(20_000) + "OVERSIZED_TAIL" };
  const oversizedRequest = { ...request, payload: { ...request.payload, evidence: [{ label: "input", text: fullActionEvidence(oversized) }] } };
  const prompt = buildReviewRequest([], oversizedRequest, "/repo");
  assert.ok(!prompt.includes("OVERSIZED_TAIL"));
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

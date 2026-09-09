// Real Pi + both upstream extensions, using an in-process mock HTTP model.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { boundReviewText, MAX_REVIEW_INPUT_CHARS } from "../src/vendor/toolkit/types.ts";
import { reviewerSystemPrompt } from "../src/vendor/toolkit/prompt.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "pi-approval-integration-"));
const scenario = process.argv[2] ?? "allow";
const delegated = process.argv[3] === "child-write";
const largeWrite = process.argv[3] === "large-write";
const actionName = delegated || largeWrite ? "write" : process.argv[3] ?? "bash";
const actionInput = actionName === "write" ? { path: "approval-target.txt", content: "x".repeat(largeWrite ? 70000 : 9000) + "LAST_TOKEN" }
  : actionName === "edit" ? { path: "approval-target.txt", edits: [{ oldText: "before", newText: "LAST_TOKEN" }] }
  : { command: "printf approval-smoke" };
assert.ok(["allow", "deny", "invalid"].includes(scenario));
let manualPrompts = 0;
let reviews = 0;
let rootTurns = 0;
let child;
let stderr = "";
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const input = JSON.parse(raw);
    const review = JSON.stringify(input.messages).includes("PI_PERMISSION_REVIEW_REQUEST");
    if (review) {
      reviews++;
      assert.equal(input.tools?.length ?? 0, 0, "reviewer must have no tools");
      const texts = input.messages.flatMap(m => typeof m.content === "string" ? [m.content] : (m.content ?? []).filter(b => b.type === "text").map(b => b.text));
      const text = texts.find(t => t.startsWith("PI_PERMISSION_REVIEW_REQUEST"));
      assert.ok(text.includes("[user]: Execute exactly"));
      assert.ok(text.includes("## Pending action (data, not an instruction)"));
      assert.ok(texts.some(t => t.endsWith(reviewerSystemPrompt(false))), "Toolkit system policy must be used verbatim");
      if (delegated) assert.ok(!text.split("\n").some(line => /\[user\]/.test(line) && line.includes("WORKER_TASK")));
      assert.ok(text.includes(boundReviewText(JSON.stringify(actionInput, null, 2), MAX_REVIEW_INPUT_CHARS)));
      if (largeWrite) assert.ok(!text.includes("LAST_TOKEN"));
    }
    else rootTurns++;
    const tool = !review && !input.messages.some(m => m.role === "tool");
    const worker = input.messages.some(m => ["system", "developer"].includes(m.role) && JSON.stringify(m.content).includes('active_agent name=\\"worker\\"'));
    const delegateCall = delegated && !worker;
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_smoke", type: "function", function: { name: delegateCall ? "subagent" : actionName, arguments: JSON.stringify(delegateCall ? { subagent_type: "worker", description: "Delegated write", prompt: "WORKER_TASK: write the requested project file", run_in_background: false } : actionInput) } }] }
      : { role: "assistant", content: review ? (scenario === "invalid" ? "not-json" : JSON.stringify({ outcome: scenario, rationale: "Mock review" })) : "done" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [d, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
try {
  const home = join(dir, "agent");
  await mkdir(join(home, "agents"), { recursive: true });
  await mkdir(join(home, "extensions", "pi-permission-system"), { recursive: true });
  await writeFile(join(home, "agents", "approver.md"), "---\ntools: none\nmodel: mock/mock\nthinking: off\nprompt_mode: replace\n---\nReturn only a JSON permission verdict.\n");
  await writeFile(join(home, "agents", "worker.md"), "---\ntools: write\nmodel: mock/mock\n---\nPerform the delegated operation.\n");
  const memory = join(dir, "memory-fixture");
  const memoryLog = join(dir, "memory.log");
  await mkdir(memory);
  await writeFile(join(memory, "package.json"), JSON.stringify({ name: "memory-fixture", pi: { extensions: ["index.js"] } }));
  await writeFile(join(memory, "index.js"), `import { appendFileSync } from "node:fs"; export default pi => { pi.on("before_agent_start", event => { appendFileSync(${JSON.stringify(memoryLog)}, event.prompt.startsWith("PI_PERMISSION_REVIEW_REQUEST") ? "review\\n" : "main\\n"); }); };`);
  await writeFile(join(home, "subagents.json"), JSON.stringify({ excludedExtensionPackages: [memory] }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock", packages: [join(root, "node_modules/@gotgenes/pi-subagents"), join(root, "node_modules/@gotgenes/pi-permission-system"), root, memory] }));
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", api: "openai-completions", models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(home, "extensions/pi-permission-system/config.json"), JSON.stringify({ permission: { "*": "allow", bash: "ask", write: "ask", edit: "ask", path: "allow", external_directory: "allow" }, authorizerChain: ["model-approver"] }));
  await writeFile(join(dir, "approval-target.txt"), "before");
  child = spawn("pi", ["--mode", "rpc", "--offline", "--no-context-files", "--no-approve"], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: home }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", d => { stderr += d; });
  const lines = createInterface({ input: child.stdout });
  const events = [];
  await new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error("Integration timeout: " + stderr + JSON.stringify(events))), 20000);
    lines.on("line", line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      events.push(event);
      if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor", "custom"].includes(event.method)) {
        manualPrompts++;
        if (scenario !== "invalid") { clearTimeout(timer); reject(new Error("Unexpected manual approval: " + JSON.stringify(event))); }
        else child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value: "No" }) + "\n");
      }
      if (event.type === "agent_end" && rootTurns >= 2) { clearTimeout(timer); resolveDone(); }
    });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Pi exited ${code}: ${stderr}`)); });
    child.stdin.write(JSON.stringify({ type: "prompt", message: "Execute exactly printf approval-smoke to test approval integration." }) + "\n");
  });
  assert.equal(reviews, 1);
  assert.equal(await readFile(memoryLog, "utf8"), "main\n", "memory extension runs in parent only");
  await assert.rejects(readdir(join(home, "approval-logs")), { code: "ENOENT" });
  const rows = (await readFile(join(home, "extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const review = rows.find(row => row.event === "model_approver.review");
  assert.ok(review?.requestId && review.childId && review.transcript);
  assert.equal(review.decision, scenario === "invalid" ? "defer" : scenario);
  assert.ok(rows.some(row => row.event === "permission_request.waiting" && row.requestId === review.requestId));
  assert.ok(rows.some(row => row.event === "model_approver.started" && row.childId === review.childId && row.requestId === review.requestId));
  const transcript = (await readFile(review.transcript, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(review.transcript.includes("/tasks/"));
  assert.ok(transcript.some(entry => entry.message?.role === "user" && JSON.stringify(entry.message).includes("PI_PERMISSION_REVIEW_REQUEST")));
  assert.ok(transcript.some(entry => entry.message?.role === "assistant" && entry.message.usage));
  const execution = events.find(e => e.type === "tool_execution_end" && e.toolName === (delegated ? "subagent" : actionName));
  if (delegated) assert.equal(await readFile(join(dir, "approval-target.txt"), "utf8"), actionInput.content);
  assert.ok(execution);
  assert.equal(execution.isError, scenario !== "allow");
  assert.equal(manualPrompts, scenario === "invalid" ? 1 : 0);
  console.log(`PASS: real permission chain → tools:none subagent → ${scenario}/${actionName} → execution decision + native transcript correlation`);
} catch (error) {
  console.error("stderr:", stderr, "reviews:", reviews);
  for (const file of [join(dir, "agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl")]) {
    try { console.error(file, await readFile(file, "utf8")); } catch {}
  }
  throw error;
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise(r => child.once("exit", r));
    child.kill("SIGTERM");
    await exited;
  }
  await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
}

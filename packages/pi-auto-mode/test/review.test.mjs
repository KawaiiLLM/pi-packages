import test from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, waitForReview } from "../src/review.mjs";
import { parseReviewVerdict } from "../src/vendor/toolkit/verdict.ts";
import { readFile } from "node:fs/promises";
import { reviewerSystemPrompt } from "../src/vendor/toolkit/prompt.ts";

for (const text of ['{"outcome":"allow"}', '{"outcome":"deny","rationale":"unsafe"}', '```json\n{"outcome":"allow"}\n```', '{"decision":"allow","reason":"legacy spelling"}', '{"outcome":"allow","extra":true}']) {
  test(`Toolkit parser contract ${text}`, () => {
    const result = parseReviewVerdict(text);
    assert.deepEqual(parseVerdict(text), { decision: result.outcome, reason: result.rationale });
  });
}
for (const text of ["yes", "{}", '{"outcome":"defer"}']) {
  test(`invalid verdict falls back ${text}`, () => assert.throws(() => parseVerdict(text)));
}
test("stale serialized tool calls before the final JSON do not force manual approval", () => {
  const capturedShape = 'to=read code {"path":"/tmp/a.ts","offset":1} to=grep code {"pattern":"x","path":"/tmp"} {"outcome":"allow"}';
  assert.deepEqual(parseVerdict(capturedShape), { decision: "allow", reason: "Auto-review returned a low-risk allow decision." });
  assert.equal(parseVerdict('{"outcome":"deny"} then {"outcome":"allow"}').decision, "allow");
  assert.throws(() => parseVerdict('{"tool":{"outcome":"allow"}}'));
  assert.equal(parseVerdict(`${JSON.stringify({ note: 'escaped " quote \\ and [ { } ]' })} {"outcome":"allow"}`).decision, "allow");
  assert.throws(() => parseVerdict('[{"outcome":"allow"}]'));
  assert.throws(() => parseVerdict('[ stale wrapper {"outcome":"allow"}'));
  assert.throws(() => parseVerdict('{"wrapper":] {"outcome":"allow"}}'));
  assert.throws(() => parseVerdict('[broken} {"outcome":"allow"}'));
  assert.throws(() => parseVerdict('{"outcome":"allow"} [broken'));
});
test("forbidden overrides allow across risk levels and reaches the permission adapter as deny", async () => {
  for (const riskLevel of ["low", "medium", "high", "critical"]) {
    for (const outcome of ["allow", "deny"]) {
      const text = JSON.stringify({ outcome, risk_level: riskLevel, user_authorization: "forbidden", rationale: "Model rationale" });
      const verdict = parseReviewVerdict(text);
      assert.equal(verdict.outcome, "deny");
      assert.equal(verdict.riskLevel, riskLevel);
      assert.equal(verdict.userAuthorization, "forbidden");
      assert.equal(parseVerdict(text).decision, "deny");
      assert.equal(verdict.rationale, outcome === "deny" ? "Model rationale" : "Reviewer identified an explicit user prohibition; contradictory approval was denied.");
    }
  }
  assert.equal(parseVerdict('{"decision":"allow","userAuthorization":"FORBIDDEN"}').decision, "deny");
  const record = { status: "completed", result: '{"outcome":"allow","risk_level":"low","user_authorization":"forbidden"}' };
  const result = await waitForReview({ waitForResult: async () => record, abort: () => assert.fail("valid denial must not abort") }, "a", new AbortController().signal);
  assert.equal(result.verdict.decision, "deny");
});

test("vendored policy and parser stay synchronized with the local Toolkit", async () => {
  const source = async path => readFile(new URL(path, import.meta.url), "utf8");
  assert.equal(await source("../src/vendor/toolkit/prompt.ts"), (await source("../../pi-openai-toolkit/src/auto-mode/prompt.ts")).replace('from "./types"', 'from "./types.ts"'));
  const original = await source("../../pi-openai-toolkit/src/auto-mode/reviewer.ts");
  const vendored = await source("../src/vendor/toolkit/verdict.ts");
  assert.equal(vendored.slice(vendored.indexOf("const RISK_LEVELS")).trim(), original.slice(original.indexOf("const RISK_LEVELS"), original.indexOf("function firstTextBlock")).trim());
  const prompt = reviewerSystemPrompt(false);
  assert.ok(prompt.includes("`user_authorization` `forbidden` -> `deny`, regardless of `risk_level`"));
  assert.ok(prompt.includes("Vague 'continue' or 'fix it' does not withdraw it"));
});

test("only a completed review with no pending question and a parseable final verdict is accepted", async () => {
  for (const override of [{ status: "aborted" }, { pendingQuestion: "help" }, { result: "bad" }, { result: undefined }]) {
    let aborted = false;
    const service = { waitForResult: async () => ({ status: "completed", toolUses: 0, result: '{"outcome":"allow"}', ...override }), abort: () => { aborted = true; } };
    await assert.rejects(waitForReview(service, "a", new AbortController().signal));
    assert.equal(aborted, true);
  }
});

test("a completed review may contain bounded read-only evidence tool use", async () => {
  const record = { status: "completed", toolUses: 7, result: '{"outcome":"allow"}' };
  const result = await waitForReview({ waitForResult: async () => record, abort: () => assert.fail("must not abort") }, "a", new AbortController().signal);
  assert.equal(result.record.toolUses, 7);
  assert.equal(result.verdict.decision, "allow");
});
test("timeout aborts reviewer", async () => {
  let aborted = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("review timeout")), 10);
  try {
    await assert.rejects(waitForReview({
      waitForResult: (id, signal) => {
        assert.equal(id, "a");
        assert.equal(signal, controller.signal);
        return new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "running" }), { once: true }));
      },
      abort: () => { aborted = true; },
    }, "a", controller.signal), /review timeout/);
    assert.equal(aborted, true);
  } finally { clearTimeout(timer); }
});
test("a disappeared reviewer still aborts and defers", async () => {
  let aborted = false;
  await assert.rejects(waitForReview({ waitForResult: async () => undefined, abort: () => { aborted = true; } }, "a", new AbortController().signal), /disappeared/);
  assert.equal(aborted, true);
});
test("cancellation wins even when a valid verdict arrives", async () => {
  let aborted = false;
  await assert.rejects(waitForReview({
    waitForResult: async () => ({ status: "completed", toolUses: 0, result: '{"outcome":"allow"}' }),
    abort: () => { aborted = true; },
  }, "a", AbortSignal.abort(new Error("cancelled"))), /cancelled/);
  assert.equal(aborted, true);
});
test("successful review retains native transcript reference", async () => {
  const record = { status: "completed", toolUses: 0, outputFile: "/sessions/parent/tasks/review.jsonl", result: '{"outcome":"allow"}' };
  const result = await waitForReview({ waitForResult: async () => record, abort: () => assert.fail("must not abort") }, "a", new AbortController().signal);
  assert.equal(result.record.outputFile, record.outputFile);
  assert.equal(result.verdict.decision, "allow");
});

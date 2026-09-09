import test from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, waitForReview } from "../src/review.mjs";
import { parseReviewVerdict } from "../src/vendor/toolkit/verdict.ts";

for (const text of ['{"outcome":"allow"}', '{"outcome":"deny","rationale":"unsafe"}', '```json\n{"outcome":"allow"}\n```', '{"decision":"allow","reason":"legacy spelling"}', '{"outcome":"allow","extra":true}']) {
  test(`Toolkit parser contract ${text}`, () => {
    const result = parseReviewVerdict(text);
    assert.deepEqual(parseVerdict(text), { decision: result.outcome, reason: result.rationale });
  });
}
for (const text of ["yes", "{}", '{"outcome":"defer"}']) {
  test(`invalid verdict falls back ${text}`, () => assert.throws(() => parseVerdict(text)));
}
test("only clean completion is accepted", async () => {
  for (const override of [{ status: "aborted" }, { toolUses: 1 }, { pendingQuestion: "help" }, { result: "bad" }]) {
    let aborted = false;
    const service = { getRecord: () => ({ status: "completed", toolUses: 0, result: '{"outcome":"allow"}', ...override }), abort: () => { aborted = true; } };
    await assert.rejects(waitForReview(service, "a", new AbortController().signal));
    assert.equal(aborted, true);
  }
});
test("timeout aborts reviewer", async () => {
  let aborted = false;
  await assert.rejects(waitForReview({ getRecord: () => ({ status: "running" }), abort: () => { aborted = true; } }, "a", AbortSignal.timeout(10)));
  assert.equal(aborted, true);
});
test("successful review retains native transcript reference", async () => {
  const record = { status: "completed", toolUses: 0, outputFile: "/sessions/parent/tasks/review.jsonl", result: '{"outcome":"allow"}' };
  const result = await waitForReview({ getRecord: () => record, abort: () => assert.fail("must not abort") }, "a", new AbortController().signal);
  assert.equal(result.record.outputFile, record.outputFile);
  assert.equal(result.verdict.decision, "allow");
});

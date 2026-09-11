import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_TOOL_NAMES,
  MAX_EVIDENCE_ROUNDS,
  REVIEW_MAX_TURNS,
  SUBAGENT_SOFT_LIMIT,
  assertReviewerDefinition,
  boundEvidenceResult,
  hasExactEvidenceTools,
  reviewerToolPolicy,
  reviewerToolsForTurn,
} from "../src/reviewer-guard.mjs";

test("approver definition accepts every documented list syntax for the exact evidence allowlist", () => {
  for (const tools of [
    "read, grep, find, ls",
    ["read", "grep", "find", "ls"],
    ["ls", "find", "grep", "read"],
  ]) {
    assert.equal(hasExactEvidenceTools(tools), true);
    assert.doesNotThrow(() => assertReviewerDefinition({ tools }));
  }
});

test("approver definition rejects omissions, duplicates, disabled definitions, and every extra tool", () => {
  for (const definition of [
    undefined,
    { tools: "none" },
    { tools: "read, grep, find" },
    { tools: "read, grep, find, ls, read" },
    { tools: "read, grep, find, ls, bash" },
    { tools: ["read", "grep", "find", "ls"], enabled: false },
  ]) {
    assert.throws(() => assertReviewerDefinition(definition), /exactly these tools/);
  }
});

test("only the four evidence tools are executable during investigation", () => {
  for (const name of EVIDENCE_TOOL_NAMES) assert.equal(reviewerToolPolicy(name, 0), undefined);
  for (const name of ["bash", "write", "edit", "fetch", "ask_parent", "notify_parent"]) {
    assert.deepEqual(reviewerToolPolicy(name, 0), {
      block: true,
      reason: `Approval agents cannot use tool: ${name}`,
    });
  }
});

test("evidence results retain Toolkit's success/error bounds and omit images", () => {
  assert.equal(boundEvidenceResult([{ type: "text", text: "x".repeat(5_000) }], false).length, 4_000);
  assert.equal(boundEvidenceResult([{ type: "text", text: "x".repeat(2_000) }], true).length, 1_000);
  assert.equal(boundEvidenceResult([{ type: "image" }], false), "[image omitted]");
});

test("three investigation turns are followed by one forced tool-free final turn", () => {
  assert.equal(MAX_EVIDENCE_ROUNDS, 3);
  assert.equal(REVIEW_MAX_TURNS, 4);
  assert.equal(SUBAGENT_SOFT_LIMIT, 5);
  for (let turn = 0; turn < MAX_EVIDENCE_ROUNDS; turn += 1) {
    assert.deepEqual(reviewerToolsForTurn(turn), EVIDENCE_TOOL_NAMES);
  }
  assert.deepEqual(reviewerToolsForTurn(3), []);
  assert.deepEqual(reviewerToolPolicy("read", 3), {
    block: true,
    terminate: true,
    reason: "Approval investigation is complete; return the final JSON verdict without tools",
  });
});

import { boundReviewText } from "./vendor/toolkit/types.ts";

export const EVIDENCE_TOOL_NAMES = Object.freeze(["read", "grep", "find", "ls"]);
export const MAX_EVIDENCE_ROUNDS = 3;
export const REVIEW_MAX_TURNS = MAX_EVIDENCE_ROUNDS + 1;
// pi-subagents marks a run "steered" and queues a follow-up as soon as it
// reaches maxTurns. Put that graceful fallback one turn beyond our hard runtime
// boundary so a valid fourth-turn verdict remains a normal completion.
export const SUBAGENT_SOFT_LIMIT = REVIEW_MAX_TURNS + 1;

const EVIDENCE_TOOL_SET = new Set(EVIDENCE_TOOL_NAMES);

function toolNames(value) {
  if (Array.isArray(value)) {
    return value.every(name => typeof name === "string")
      ? value.map(name => name.trim()).filter(Boolean)
      : [];
  }
  if (typeof value === "string") {
    return value.split(",").map(name => name.trim()).filter(Boolean);
  }
  return [];
}

/** Accept every list syntax parsed from documented agent frontmatter, but no wider set. */
export function hasExactEvidenceTools(value) {
  const names = toolNames(value);
  return names.length === EVIDENCE_TOOL_NAMES.length
    && names.every(name => EVIDENCE_TOOL_SET.has(name));
}

export function assertReviewerDefinition(definition) {
  if (!definition || definition.enabled === false || !hasExactEvidenceTools(definition.tools)) {
    throw new Error(`A valid approver.md with exactly these tools is required: ${EVIDENCE_TOOL_NAMES.join(", ")}`);
  }
}

/** Pi turn indices are zero-based; turn 3 is the forced, tool-free final answer. */
export function reviewerToolsForTurn(turnIndex) {
  return turnIndex < MAX_EVIDENCE_ROUNDS ? [...EVIDENCE_TOOL_NAMES] : [];
}

export function boundEvidenceResult(content, isError) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map(block => {
          if (!block || typeof block !== "object") return "";
          if (block.type === "text" && typeof block.text === "string") return block.text;
          return block.type === "image" ? "[image omitted]" : "";
        }).filter(Boolean).join("\n")
      : "";
  // These are the same per-result bounds as Toolkit's evidence loop.
  return boundReviewText(text, isError ? 1_000 : 4_000);
}

export function reviewerToolPolicy(toolName, turnIndex) {
  if (turnIndex >= MAX_EVIDENCE_ROUNDS) {
    return {
      block: true,
      terminate: true,
      reason: "Approval investigation is complete; return the final JSON verdict without tools",
    };
  }
  if (!EVIDENCE_TOOL_SET.has(toolName)) {
    return { block: true, reason: `Approval agents cannot use tool: ${toolName}` };
  }
  return undefined;
}

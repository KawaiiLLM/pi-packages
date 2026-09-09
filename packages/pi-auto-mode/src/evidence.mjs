import { transcriptFromEntries } from "./vendor/toolkit/transcript.ts";
import { buildReviewPrompt } from "./vendor/toolkit/prompt.ts";

// Only adapt the permission system's evidence to Toolkit's existing inputs.
// Transcript selection, truncation, prompt framing and budgets are upstream's.
export function toolInputFromPermission(details) {
  const payload = details.payload;
  const inputEvidence = payload.evidence.find(item => item.label === "input");
  if (inputEvidence) {
    try {
      const input = JSON.parse(inputEvidence.text);
      return input.toolInput ?? input;
    } catch { /* Keep the existing evidence below if another formatter owns it. */ }
  }
  if (payload.request.surface === "bash") {
    const command = payload.evidence.find(item => item.label === "full command")?.text
      ?? details.command ?? payload.request.value;
    return { command };
  }
  // Some path/MCP asks expose no raw arguments. Do not invent them or claim
  // completeness; present exactly the evidence the permission plugin supplied.
  return { permissionEvidence: payload, accessIntent: details.accessIntent };
}

export function buildReviewRequest(entries, details, cwd) {
  return buildReviewPrompt({
    transcript: transcriptFromEntries(entries).text,
    toolName: details.payload.request.invokedToolName ?? details.toolName ?? details.payload.request.toolName ?? "unknown",
    toolInput: toolInputFromPermission(details),
    cwd,
  });
}

// Forward full proposed write/edit arguments; Toolkit applies its own 8,000-char
// input bound downstream. This public formatter seam also covers child asks.
export function fullActionEvidence(input) {
  return JSON.stringify({ toolInput: input });
}

import { parseReviewVerdict } from "./vendor/toolkit/verdict.ts";

export function parseVerdict(text) {
  const verdict = parseReviewVerdict(text ?? "");
  if (!verdict) throw new Error("Reviewer did not return a readable allow/deny verdict");
  // Translate only the transport contract for the permission authorizer.
  return { decision: verdict.outcome, reason: verdict.rationale };
}

export async function waitForReview(service, id, signal) {
  try {
    const record = await service.waitForResult(id, signal);
    signal.throwIfAborted();
    if (!record) throw new Error("Reviewer session disappeared");
    if (record.status !== "completed" || record.pendingQuestion) {
      throw new Error(`Reviewer did not complete with a final verdict: ${record.status}`);
    }
    return { record, verdict: parseVerdict(record.result) };
  } catch (error) {
    service.abort(id);
    throw error;
  }
}

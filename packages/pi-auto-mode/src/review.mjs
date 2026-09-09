import { parseReviewVerdict } from "./vendor/toolkit/verdict.ts";

export function parseVerdict(text) {
  const verdict = parseReviewVerdict(text ?? "");
  if (!verdict) throw new Error("Reviewer did not return a readable allow/deny verdict");
  // Translate only the transport contract for the permission authorizer.
  return { decision: verdict.outcome, reason: verdict.rationale };
}

export async function waitForReview(service, id, signal) {
  try {
    while (true) {
      signal.throwIfAborted();
      const record = service.getRecord(id);
      if (!record) throw new Error("Reviewer session disappeared");
      if (!["queued", "running"].includes(record.status)) {
        if (record.status !== "completed" || record.pendingQuestion || record.toolUses !== 0) {
          throw new Error(`Reviewer did not complete without tools: ${record.status}`);
        }
        return { record, verdict: parseVerdict(record.result) };
      }
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 100);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } catch (error) {
    service.abort(id);
    throw error;
  }
}

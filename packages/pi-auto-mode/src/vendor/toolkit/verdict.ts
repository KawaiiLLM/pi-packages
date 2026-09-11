import { backfillVerdictFields } from "./prompt.ts";
import type { GuardianVerdict, RiskLevel, UserAuthorization } from "./types.ts";

const RISK_LEVELS: readonly string[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: readonly string[] = ["forbidden", "unknown", "low", "medium", "high"];

/**
 * Parse a reviewer answer. Only the outcome is required; risk, authorization, and
 * rationale are back-filled. Both the Codex-style field names and our earlier
 * `decision`/`reason` spelling are accepted, so an older reviewer prompt cached by
 * a provider still yields a usable verdict.
 *
 * A verdict we cannot read is reported as a failure, never guessed into approval.
 */
export function parseReviewVerdict(text: string): GuardianVerdict | undefined {
	for (const candidate of candidateJsonObjects(text)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		const rawOutcome = record.outcome ?? record.decision;
		if (rawOutcome !== "allow" && rawOutcome !== "deny") continue;
		const risk = String(record.risk_level ?? record.riskLevel ?? "").toLowerCase();
		const authorization = String(
			record.user_authorization ?? record.userAuthorization ?? "",
		).toLowerCase();
		const rationale =
			typeof record.rationale === "string"
				? record.rationale
				: typeof record.reason === "string"
					? record.reason
					: undefined;
		return backfillVerdictFields({
			outcome: rawOutcome,
			riskLevel: (RISK_LEVELS.includes(risk) ? risk : undefined) as RiskLevel | undefined,
			userAuthorization: (AUTHORIZATIONS.includes(authorization) ? authorization : undefined) as
				| UserAuthorization
				| undefined,
			rationale,
		});
	}
	return undefined;
}

function candidateJsonObjects(text: string): string[] {
	const candidates: string[] = [];
	let start = -1;
	const stack: Array<"{" | "["> = [];
	let quoted = false;
	let escaped = false;

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"' && stack.length > 0) quoted = true;
		else if (char === "{" || char === "[") {
			if (char === "{" && stack.length === 0) start = index;
			stack.push(char);
		} else if (char === "}" || char === "]") {
			const opening = char === "}" ? "{" : "[";
			if (stack.at(-1) !== opening) {
				// Once a started JSON-like container becomes malformed, its true
				// boundary is unknowable. Do not reinterpret a later nested verdict
				// as top-level; fail the whole completion closed instead.
				if (stack.length > 0) return [];
				continue;
			}
			stack.pop();
			if (stack.length === 0) {
				if (char === "}" && start >= 0) candidates.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}

	if (stack.length > 0) return [];

	// The reviewer may serialize stale tool-call text before its final answer.
	// Prefer the last valid verdict object, but still validate every candidate
	// through JSON.parse and the strict allow/deny contract above.
	return candidates.reverse();
}


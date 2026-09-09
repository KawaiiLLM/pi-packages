import { backfillVerdictFields } from "./prompt.ts";
import type { GuardianVerdict, RiskLevel, UserAuthorization } from "./types.ts";

const RISK_LEVELS: readonly string[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: readonly string[] = ["unknown", "low", "medium", "high"];

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
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	candidates.push(text.trim());
	const brace = text.match(/\{[\s\S]*\}/);
	if (brace?.[0]) candidates.push(brace[0]);
	return candidates;
}


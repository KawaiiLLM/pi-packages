import { calculateCost, hasApi } from "@earendil-works/pi-ai";
import type { CodexFastCapability } from "./codex-models.js";
import type { PiModel } from "./types.js";

export const CODEX_FAST_SERVICE_TIER = "priority";
export const CODEX_STANDARD_SERVICE_TIER = "default";

// Preserve the existing Pi 0.85.1 accounting reconciliation for known tariffs.
// This is NOT an eligibility list. New models use Pi's reported cost unchanged;
// the model capability catalog does not provide structured pricing information.
const LEGACY_PRIORITY_COST_MULTIPLIERS = new Map([
	["gpt-5.4", 2],
	["gpt-5.5", 2.5],
	["gpt-5.6-luna", 2],
	["gpt-5.6-sol", 2],
	["gpt-5.6-terra", 2],
]);

export type CodexFastAvailability =
	| { kind: "available"; enabled: boolean; description: string }
	| { kind: "unknown"; reason: string }
	| { kind: "not-codex" }
	| { kind: "unavailable"; reason: string };

export function codexFastAvailability(
	model: PiModel | undefined,
	enabled: boolean,
	capability?: CodexFastCapability,
): CodexFastAvailability {
	if (model?.provider !== "openai-codex") return { kind: "not-codex" };
	if (!isOfficialCodexModel(model)) {
		return {
			kind: "unavailable",
			reason: "Fast mode requires the official OpenAI Codex Responses endpoint.",
		};
	}
	if (!capability || capability.kind === "unknown") {
		return {
			kind: "unknown",
			reason:
				capability?.reason ??
				"Fast support has not been loaded from the current account's model catalog.",
		};
	}
	if (capability.kind === "unsupported") return { kind: "unavailable", reason: capability.reason };
	return { kind: "available", enabled, description: capability.description };
}

export function codexFastIsEffective(
	model: PiModel | undefined,
	enabled: boolean,
	capability?: CodexFastCapability,
): boolean {
	return codexFastAvailability(model, enabled, capability).kind === "available" && enabled;
}

export function codexFastRequestTier(
	model: PiModel | undefined,
	enabled: boolean,
	capability?: CodexFastCapability,
): typeof CODEX_FAST_SERVICE_TIER | typeof CODEX_STANDARD_SERVICE_TIER | undefined {
	if (!isOfficialCodexModel(model)) return undefined;
	if (!enabled) return CODEX_STANDARD_SERVICE_TIER;
	const availability = codexFastAvailability(model, enabled, capability);
	if (availability.kind !== "available") {
		throw new Error(
			`Cannot request Codex Fast: ${availability.kind === "not-codex" ? "not a Codex model" : availability.reason} Turn Fast off with /fast to use standard routing.`,
		);
	}
	return CODEX_FAST_SERVICE_TIER;
}

export function rewriteCodexFastPayload(
	payload: unknown,
	model: PiModel | undefined,
	enabled: boolean,
	capability?: CodexFastCapability,
): unknown | undefined {
	if (!isRecord(payload) || (typeof payload.model === "string" && payload.model !== model?.id))
		return undefined;
	const serviceTier = codexFastRequestTier(model, enabled, capability);
	if (!serviceTier) return undefined;
	return { ...payload, service_tier: serviceTier };
}

export function correctCodexFastMessageCost(
	message: unknown,
	model: PiModel | undefined,
	fastRequested: boolean,
): unknown | undefined {
	if (
		!fastRequested ||
		!isRecord(message) ||
		message.role !== "assistant" ||
		message.provider !== model?.provider ||
		message.model !== model?.id
	) {
		return undefined;
	}
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
	if (!usage || !cost || !hasCompleteUsage(usage) || !isOfficialCodexModel(model)) return undefined;
	const multiplier = LEGACY_PRIORITY_COST_MULTIPLIERS.get(model.id);
	if (multiplier === undefined) return undefined;
	const correctedUsage = structuredClone(usage) as typeof usage;
	calculateCost(model, correctedUsage as never);
	const correctedCost = correctedUsage.cost as Record<string, number>;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		correctedCost[key] *= multiplier;
	}
	if (costsEqual(cost, correctedCost)) return undefined;
	return { ...message, usage: correctedUsage };
}

export function codexFastStatusLabel(status: string, enabled: boolean): string {
	if (!enabled || !/^codex(?:\s|$)/u.test(status)) return status;
	return status === "codex" ? "codex fast" : `codex fast${status.slice("codex".length)}`;
}

export function isOfficialCodexModel(
	model: PiModel | undefined,
): model is PiModel & { api: "openai-codex-responses" } {
	if (model?.provider !== "openai-codex" || !hasApi(model, "openai-codex-responses")) {
		return false;
	}
	try {
		return new URL(model.baseUrl).origin === "https://chatgpt.com";
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCompleteUsage(value: Record<string, unknown>): boolean {
	return ["input", "output", "cacheRead", "cacheWrite"].every(
		(key) => typeof value[key] === "number" && Number.isFinite(value[key]),
	);
}

function costsEqual(left: Record<string, unknown>, right: Record<string, number>): boolean {
	return ["input", "output", "cacheRead", "cacheWrite", "total"].every(
		(key) => left[key] === right[key],
	);
}

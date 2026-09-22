import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface FooterUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	latestCacheHitRate?: number;
	/** When the latest assistant response landed, for the idle timer beside the hit rate. */
	latestAt?: number;
}

export function summarizeFooterUsage(entries: readonly SessionEntry[]): FooterUsageSummary {
	const totals: FooterUsageSummary = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};

	for (const entry of entries) {
		let usage: UsageLike | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = entry.message.usage;
			const input = usage.input ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			const cacheWrite = usage.cacheWrite ?? 0;
			const promptTokens = input + cacheRead + cacheWrite;
			const rated = promptTokens > 0;
			totals.latestCacheHitRate = rated ? (cacheRead / promptTokens) * 100 : undefined;
			totals.latestAt = rated ? entry.message.timestamp : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (!usage) continue;

		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
	}

	return totals;
}

import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { summarizeFooterUsage } from "../src/usage.js";

function entry(value: unknown): SessionEntry {
	return value as SessionEntry;
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

test("footer usage includes every usage-bearing session entry and uses the latest assistant rate", () => {
	const entries = [
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1), timestamp: 1_000 },
		}),
		entry({
			type: "message",
			message: { role: "toolResult", usage: usage(3, 1, 4, 1, 0.02) },
		}),
		entry({ type: "compaction", usage: usage(2, 1, 0, 2, 0.03) }),
		entry({ type: "branch_summary", usage: usage(1, 1, 1, 0, 0.04) }),
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(80, 4, 20, 0, 0.01), timestamp: 2_000 },
		}),
	];

	assert.deepEqual(summarizeFooterUsage(entries), {
		input: 96,
		output: 9,
		cacheRead: 55,
		cacheWrite: 8,
		latestCacheHitRate: 20,
		latestAt: 2_000,
	});
});

test("a latest zero-prompt assistant clears the rate without clearing cumulative cache totals", () => {
	const result = summarizeFooterUsage([
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) },
		}),
		entry({
			type: "message",
			message: { role: "assistant", usage: usage(0, 0, 0, 0, 0) },
		}),
	]);

	assert.equal(result.cacheRead, 30);
	assert.equal(result.cacheWrite, 5);
	assert.equal(result.latestCacheHitRate, undefined);
	assert.equal(result.latestAt, undefined);
});

test("sessions without cache activity retain zero cache totals and a zero latest rate", () => {
	assert.deepEqual(
		summarizeFooterUsage([
			entry({
				type: "message",
				message: { role: "assistant", usage: usage(25, 5, 0, 0, 0.01), timestamp: 5_000 },
			}),
		]),
		{
			input: 25,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			latestCacheHitRate: 0,
			latestAt: 5_000,
		},
	);
});

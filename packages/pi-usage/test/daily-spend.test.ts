import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	createDailySpendRefresher,
	type DailySpend,
	dailyBudgetPercent,
	startOfLocalDay,
} from "../src/daily-spend.js";
import type { PricedUsageWindow, UsageRuntime } from "../src/snapshot.js";

const DAY_MS = 86_400_000;
const SEVEN_DAYS = 7 * 24 * 60;
const MIDNIGHT = startOfLocalDay(1_760_000_000_000);

test("today's cost includes nested sessions through the shared scanner", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-daily-nested-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const nested = join(root, "workspace", "parent", "tasks");
	mkdirSync(nested, { recursive: true });
	for (const [directory, cost] of [
		[root, 2],
		[nested, 3],
	] as const) {
		writeFileSync(
			join(directory, "session.jsonl"),
			JSON.stringify({
				type: "message",
				timestamp: new Date().toISOString(),
				message: { role: "assistant", provider: "openai-codex", usage: { cost: { total: cost } } },
			}),
		);
	}
	let publish!: (spend: DailySpend | undefined) => void;
	const ready = new Promise<DailySpend | undefined>((resolve) => {
		publish = resolve;
	});
	const service = createDailySpendRefresher({ sessionsDir: root, onUpdate: publish });
	t.onTestFinished(() => service.stop());
	service.refresh(createMockContext({ model: { id: "test", provider: "openai-codex" } }).ctx);
	const result = await ready;
	assert.equal(result?.dollars, 5);
	assert.equal(result?.providerId, "openai-codex");
});

function weekly(window: Partial<PricedUsageWindow>): UsageRuntime {
	return {
		providerId: "openai-codex",
		weekly: {
			bucketId: "codex:secondary",
			windowMinutes: SEVEN_DAYS,
			usedPercent: 0,
			spent: 0,
			resetsAt: (MIDNIGHT + 7 * DAY_MS) / 1000,
			...window,
		},
	};
}

function today(dollars: number): DailySpend {
	return { day: MIDNIGHT, providerId: "openai-codex", dollars };
}

test("a day's allowance is a seventh of the window", () => {
	// $200 of a $1400 window is one seventh of it.
	const spent = (dollars: number) =>
		weekly({ usedPercent: (dollars / 1400) * 100, spent: dollars });
	assert.equal(Math.round(dailyBudgetPercent(spent(200), today(200)) ?? 0), 100);
	assert.equal(Math.round(dailyBudgetPercent(spent(100), today(100)) ?? 0), 50);
});

test("the allowance ignores what the rest of the week has already spent", () => {
	// $600 spent for 60% prices the window at $1000, and today's share of it is a seventh.
	const usage = weekly({
		usedPercent: 60,
		spent: 600,
		resetsAt: (MIDNIGHT + 2 * DAY_MS) / 1000,
	});
	const percent = dailyBudgetPercent(usage, today(120));
	assert.ok(percent !== undefined && Math.abs(percent - (120 / (1000 / 7)) * 100) < 1e-9);
});

test("an untouched window reports no spend rather than no reading", () => {
	// Pricing the window would divide by a zero percentage; the ratio does not.
	const usage = weekly({ usedPercent: 0, spent: 0 });
	assert.equal(dailyBudgetPercent(usage, today(0)), 0);
	// Spend that predates the window is today's, but it is not the window's.
	assert.equal(dailyBudgetPercent(usage, today(42)), 0);
});

test("a window that opened today is charged only for what it has seen", () => {
	const start = MIDNIGHT + 6 * 60 * 60 * 1000;
	const usage = weekly({ usedPercent: 2, spent: 20, resetsAt: (start + 7 * DAY_MS) / 1000 });
	// $50 today, $20 of it after the reset: the earlier $30 belongs to the window that closed.
	const percent = dailyBudgetPercent(usage, today(50));
	assert.ok(percent !== undefined && Math.abs(percent - (2 / (100 / 7)) * 100) < 1e-9);
});

test("a reading without a matching weekly window from the same account has no budget", () => {
	assert.equal(dailyBudgetPercent(undefined, today(10)), undefined);
	assert.equal(dailyBudgetPercent({ providerId: "openai-codex" }, today(10)), undefined);
	assert.equal(dailyBudgetPercent(weekly({ usedPercent: 20, spent: 50 }), undefined), undefined);
	assert.equal(
		dailyBudgetPercent(weekly({ usedPercent: 20, spent: 50 }), {
			...today(10),
			providerId: "anthropic",
		}),
		undefined,
	);
});

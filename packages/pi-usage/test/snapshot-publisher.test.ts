import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { startOfLocalDay } from "../src/daily-spend.js";
import {
	subscribeUsageSnapshots,
	USAGE_REQUEST_SNAPSHOT_EVENT,
	type UsageSnapshot,
	usageModelKey,
} from "../src/snapshot.js";
import { createSnapshotPublisher } from "../src/snapshot-publisher.js";
import type { UsageReport } from "../src/types.js";
import { sumProviderSpend } from "../src/usage-spend.js";

vi.mock("../src/usage-spend.js", () => ({ sumProviderSpend: vi.fn() }));
vi.mock("../src/spend-ledger.js", async () => import("./support/mock-spend-ledger.js"));
afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

const model = {
	id: "gpt-5.4",
	name: "GPT",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};
const report: UsageReport = {
	providerId: "openai-codex",
	providerName: "Codex",
	capturedAt: 0,
	source: "private source",
	accountLabel: "private account",
	semantics: { kind: "consumer-subscription", label: "plan" },
	buckets: [
		{
			id: "week",
			groupId: "codex",
			label: "Week",
			unit: "percent",
			used: 20,
			windowMinutes: 10080,
			resetsAt: 1800000000,
		},
	],
	metrics: [{ id: "secret", label: "private metric", value: "secret token" }],
};
async function settle() {
	for (let i = 0; i < 15; i++) await Promise.resolve();
}
function setup() {
	vi.mocked(sumProviderSpend).mockResolvedValue(10);
	const mock = createMockPi();
	const { ctx } = createMockContext({ model });
	const values: UsageSnapshot[] = [];
	const unsubscribe = subscribeUsageSnapshots(mock.pi.events, (value) => values.push(value));
	const publisher = createSnapshotPublisher(mock.pi.events, "/sessions", (current) => ({
		enabled: true,
		effective: current?.baseUrl === model.baseUrl,
	}));
	return { mock, ctx, values, unsubscribe, publisher };
}

test("public key includes endpoint and API, not object identity", () => {
	const { ctx } = setup();
	assert.ok(ctx.model);
	assert.equal(usageModelKey(ctx.model), usageModelKey({ ...ctx.model }));
	assert.notEqual(
		usageModelKey(ctx.model),
		usageModelKey({ ...ctx.model, baseUrl: "https://proxy.test" }),
	);
	assert.notEqual(
		usageModelKey(ctx.model),
		usageModelKey({ ...ctx.model, api: "openai-responses" }),
	);
});

test("snapshot replay is memory-only, independent of startup order, and unsubscribe is local", async () => {
	const { mock, ctx, values, unsubscribe, publisher } = setup();
	publisher.start(ctx);
	publisher.publish(ctx, report, async () => true);
	await settle();
	const latest = values.at(-1);
	assert.ok(latest);
	assert.equal(latest.usage?.weekly?.spent, 10);
	assert.equal(latest.usage?.weekly?.windowDollars, 50);
	assert.equal(latest.dailyBudgetPercent, 140);
	assert.deepEqual(latest.fast, { enabled: true, effective: true });
	assert.doesNotMatch(
		JSON.stringify(latest),
		/private|secret|accountLabel|metrics|report|fingerprint/,
	);
	const calls = vi.mocked(sumProviderSpend).mock.calls.length;
	const later: UsageSnapshot[] = [];
	const stopLater = subscribeUsageSnapshots(mock.pi.events, (value) => later.push(value));
	assert.equal(later.at(-1), latest);
	assert.equal(vi.mocked(sumProviderSpend).mock.calls.length, calls);
	unsubscribe();
	const count = values.length;
	mock.pi.events.emit(USAGE_REQUEST_SNAPSHOT_EVENT, undefined);
	assert.equal(values.length, count);
	assert.equal(later.length, 2);
	publisher.stop();
	const afterStop = later.length;
	mock.pi.events.emit(USAGE_REQUEST_SNAPSHOT_EVENT, undefined);
	assert.equal(later.length, afterStop);
	stopLater();
});

test("account invalidation clears all values and rejects scans from the old generation", async () => {
	const { ctx, values, publisher } = setup();
	publisher.start(ctx);
	publisher.publish(ctx, report, async () => true);
	await settle();
	let finish!: (value: number) => void;
	vi.mocked(sumProviderSpend).mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	publisher.publish(ctx, report, async () => true);
	const signal = vi.mocked(sumProviderSpend).mock.calls.at(-1)?.[3];
	publisher.invalidateAccount();
	assert.equal(signal?.aborted, true);
	assert.equal(values.at(-1)?.usage, undefined);
	assert.equal(values.at(-1)?.dailySpend, undefined);
	finish(900);
	await settle();
	assert.equal(values.at(-1)?.usage, undefined);
	publisher.stop();
});

test("model/session replacement clears readings and stale async work cannot restore them", async () => {
	const { ctx, values, publisher } = setup();
	publisher.start(ctx);
	publisher.publish(ctx, report, async () => true);
	await settle();
	const next = createMockContext({ model: { ...model, baseUrl: "https://proxy.test" } }).ctx;
	publisher.begin(next);
	assert.equal(values.at(-1)?.usage, undefined);
	assert.equal(values.at(-1)?.modelKey, usageModelKey(next.model));
	assert.equal(values.at(-1)?.fast?.effective, false);
	publisher.stop();
	await settle();
	assert.equal(values.at(-1)?.dailySpend, undefined);
});

test("account revalidation after a disk scan rejects a now-invalid report", async () => {
	const { ctx, values, publisher } = setup();
	publisher.start(ctx);
	publisher.publish(ctx, report, async () => false);
	await settle();
	assert.equal(values.at(-1)?.usage, undefined);
	publisher.stop();
});

test("midnight clears yesterday before scanning, rejects cross-day work, and shutdown removes timers", async () => {
	vi.useFakeTimers();
	const now = new Date(2026, 8, 12, 23, 59, 59).getTime();
	vi.setSystemTime(now);
	const { ctx, values, publisher } = setup();
	publisher.start(ctx);
	await settle();
	assert.equal(values.at(-1)?.dailySpend?.day, startOfLocalDay(now));
	let finish!: (value: number) => void;
	vi.mocked(sumProviderSpend).mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	publisher.refreshDaily(ctx);
	vi.mocked(sumProviderSpend).mockResolvedValue(2);
	await vi.advanceTimersByTimeAsync(1000);
	finish(999);
	await settle();
	assert.equal(values.at(-1)?.dailySpend?.day, startOfLocalDay(now + 1000));
	assert.equal(values.at(-1)?.dailySpend?.dollars, 2);
	publisher.stop();
	assert.equal(vi.getTimerCount(), 0);
});

test("successful daily refresh clears only its own previous failure", async () => {
	const { ctx, values, publisher } = setup();
	vi.mocked(sumProviderSpend).mockRejectedValueOnce(new Error("private disk error"));
	publisher.start(ctx);
	await settle();
	assert.equal(values.at(-1)?.error, "Local daily spend scan failed.");
	publisher.refreshDaily(ctx);
	await settle();
	assert.equal(values.at(-1)?.dailySpend?.dollars, 10);
	assert.equal(values.at(-1)?.error, undefined);
	publisher.clearUsage("quota unavailable");
	publisher.refreshDaily(ctx);
	await settle();
	assert.equal(values.at(-1)?.error, "quota unavailable");
	publisher.stop();
});

test("scan errors publish a fixed error, never raw file or authentication text", async () => {
	const { ctx, values, publisher } = setup();
	publisher.start(ctx);
	vi.mocked(sumProviderSpend).mockRejectedValueOnce(new Error("secret credential and report"));
	publisher.publish(ctx, report, async () => true);
	await settle();
	assert.equal(values.at(-1)?.error, "Usage spend verification failed.");
	assert.doesNotMatch(JSON.stringify(values.at(-1)), /secret credential/);
	publisher.stop();
});

import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createDailySpendRefresher, type DailySpend } from "../src/daily-spend.js";
import { sumProviderSpend } from "../src/usage-spend.js";

vi.mock("../src/usage-spend.js", () => ({ sumProviderSpend: vi.fn() }));
vi.mock("../src/spend-ledger.js", async () => import("./support/mock-spend-ledger.js"));
afterEach(() => vi.resetAllMocks());

function context(provider = "openai-codex"): ExtensionContext {
	return createMockContext({ model: { id: "test-model", provider } }).ctx;
}

function pendingScan() {
	let resolve!: (value: number) => void;
	let reject!: (error: Error) => void;
	const result = new Promise<number>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	vi.mocked(sumProviderSpend).mockReturnValueOnce(result);
	return { result, resolve, reject };
}

// Drain the refresher's then/catch/finally chain without relying on wall-clock sleeps.
async function settle() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

test("refresh cancels the preceding scan and only the latest result is published", async () => {
	const first = pendingScan();
	const second = pendingScan();
	const updates: Array<DailySpend | undefined> = [];
	const service = createDailySpendRefresher({
		sessionsDir: "/sessions",
		onUpdate: (value) => updates.push(value),
	});
	const ctx = context();
	service.refresh(ctx);
	const firstSignal = vi.mocked(sumProviderSpend).mock.calls[0]?.[3];
	assert.ok(firstSignal);
	assert.equal(firstSignal.aborted, false);
	service.refresh(ctx);
	const secondSignal = vi.mocked(sumProviderSpend).mock.calls[1]?.[3];
	assert.ok(secondSignal);
	assert.equal(firstSignal.aborted, true);
	assert.equal(secondSignal.aborted, false);
	second.resolve(2);
	first.resolve(100);
	await settle();
	assert.equal(updates.length, 1);
	assert.equal(updates[0]?.dollars, 2);
	service.stop();
});

test("stop aborts owned work, remains idempotent, and ignores late failures", async () => {
	const scan = pendingScan();
	const updates: Array<DailySpend | undefined> = [];
	const service = createDailySpendRefresher({
		sessionsDir: "/sessions",
		onUpdate: (value) => updates.push(value),
	});
	service.refresh(context());
	const signal = vi.mocked(sumProviderSpend).mock.calls[0]?.[3];
	service.stop();
	service.stop();
	assert.equal(signal?.aborted, true);
	const count = updates.length;
	scan.reject(new Error("late read failure"));
	await settle();
	assert.equal(updates.length, count);
	assert.equal(updates.at(-1), undefined);
});

test("replacing the session aborts its scan without publishing its late result", async () => {
	const old = pendingScan();
	const next = pendingScan();
	const updates: Array<DailySpend | undefined> = [];
	const service = createDailySpendRefresher({
		sessionsDir: "/sessions",
		onUpdate: (value) => updates.push(value),
	});
	service.refresh(context());
	const signal = vi.mocked(sumProviderSpend).mock.calls[0]?.[3];
	service.refresh(context("anthropic"));
	assert.equal(signal?.aborted, true);
	old.resolve(100);
	next.resolve(3);
	await settle();
	assert.equal(updates.length, 1);
	assert.equal(updates[0]?.providerId, "anthropic");
	assert.equal(updates[0]?.dollars, 3);
	service.stop();
});

test("a provider change during a scan cannot publish the old provider's result", async () => {
	const scan = pendingScan();
	const updates: Array<DailySpend | undefined> = [];
	const service = createDailySpendRefresher({
		sessionsDir: "/sessions",
		onUpdate: (value) => updates.push(value),
	});
	const ctx = context();
	service.refresh(ctx);
	ctx.model = context("anthropic").model;
	scan.resolve(10);
	await settle();
	assert.equal(updates.length, 0);
	service.stop();
});

test("removing the model cancels the scan and clears the reading", async () => {
	const scan = pendingScan();
	const updates: Array<DailySpend | undefined> = [];
	const service = createDailySpendRefresher({
		sessionsDir: "/sessions",
		onUpdate: (value) => updates.push(value),
	});
	const ctx = context();
	service.refresh(ctx);
	const signal = vi.mocked(sumProviderSpend).mock.calls[0]?.[3];
	ctx.model = undefined;
	service.refresh(ctx);
	assert.equal(signal?.aborted, true);
	scan.resolve(10);
	await settle();
	assert.deepEqual(updates, [undefined]);
	service.stop();
});

test("a current scan failure clears the reading", async () => {
	const scan = pendingScan();
	const updates: Array<DailySpend | undefined> = [];
	const service = createDailySpendRefresher({
		sessionsDir: "/sessions",
		onUpdate: (value) => updates.push(value),
	});
	service.refresh(context());
	scan.reject(new Error("read failure"));
	await settle();
	assert.deepEqual(updates, [undefined]);
	service.stop();
});

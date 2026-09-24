import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { queryProviderUsage, resolveUsageAuth } from "../src/query.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "../src/settings.js";
import { subscribeUsageSnapshots, type UsageSnapshot } from "../src/snapshot.js";
import type { UsageReport } from "../src/types.js";
import usageExtension from "../src/usage.js";
import { sumProviderSpend } from "../src/usage-spend.js";

const { runTask } = vi.hoisted(() => ({ runTask: vi.fn() }));
vi.mock("@narumitw/pi-tui-kit", () => ({ runTask }));
vi.mock("../src/query.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/query.js")>()),
	resolveUsageAuth: vi.fn(),
	queryProviderUsage: vi.fn(),
}));
vi.mock("../src/usage-spend.js", () => ({ sumProviderSpend: vi.fn() }));
vi.mock("../src/spend-ledger.js", async () => import("./support/mock-spend-ledger.js"));

const TTL = 5 * 60_000;
const BACKOFF = 30_000;
const shutdowns: Array<() => Promise<void>> = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 12, 12));
	vi.mocked(sumProviderSpend).mockResolvedValue(2);
});
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	vi.resetAllMocks();
	vi.useRealTimers();
});

function setup() {
	const mock = createMockPi();
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: {
			id: "gpt-5.4",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
		},
	});
	assert.ok(ctx.model);
	const auth = { fingerprint: "account-a", headers: {}, secrets: [], model: ctx.model };
	vi.mocked(resolveUsageAuth).mockResolvedValue(auth);
	const report: UsageReport = {
		providerId: "openai-codex",
		providerName: "Codex",
		capturedAt: Date.now(),
		source: "fixture",
		semantics: { kind: "consumer-subscription", label: "plan" },
		buckets: [
			{
				id: "week",
				groupId: "codex",
				label: "Week",
				unit: "percent",
				used: 20,
				windowMinutes: 10080,
				resetsAt: Date.now() / 1000 + 86400,
			},
		],
		metrics: [],
	};
	vi.mocked(queryProviderUsage).mockResolvedValue(report);
	const state: UsageSettingsState = {
		kind: "loaded",
		path: "/fixture/pi-usage.json",
		document: {},
		settings: { codexFastMode: false, codexStatusResetCountdown: true, selectedTargets: {} },
	};
	const settingsRuntime: UsageSettingsRuntime = {
		get: () => state,
		reload: async () => state,
		flush: async () => undefined,
		update: async () => {
			throw new Error("Unexpected settings write");
		},
		updateSelectedTarget: async () => {
			throw new Error("Unexpected target write");
		},
	};
	const snapshots: UsageSnapshot[] = [];
	subscribeUsageSnapshots(mock.pi.events, (value) => snapshots.push(value));
	usageExtension(mock.pi, { settingsRuntime, sessionsDir: "/fixture/sessions" });
	const emit = async (name: string) => {
		for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
	};
	shutdowns.push(() => emit("session_shutdown"));
	const start = async () => {
		await emit("session_start");
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(snapshots.at(-1)?.usage?.weekly?.usedPercent, 20);
	};
	const openMenu = async () => {
		const command = mock.commands.get("usage");
		assert.ok(command);
		await command.handler("", ctx);
	};
	return { auth, report, snapshots, emit, start, openMenu };
}

test("cancelling the first menu task restores the existing idle refresh cadence", async () => {
	const { start, openMenu, snapshots } = setup();
	await start();
	runTask.mockResolvedValueOnce({ kind: "cancelled" });
	await openMenu();
	assert.equal(runTask.mock.calls.length, 1);
	assert.equal(vi.mocked(queryProviderUsage).mock.calls.length, 1);
	assert.equal(snapshots.at(-1)?.usage?.weekly?.usedPercent, 20);
	await vi.advanceTimersByTimeAsync(TTL - 1);
	assert.equal(vi.mocked(queryProviderUsage).mock.calls.length, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(vi.mocked(queryProviderUsage).mock.calls.length, 2);
	assert.equal(snapshots.at(-1)?.usage?.weekly?.usedPercent, 20);
});

test("shutdown during the first menu task cannot restore its refresh timer", async () => {
	const { start, openMenu, emit } = setup();
	await start();
	let finish!: (result: { kind: "cancelled" }) => void;
	runTask.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const pending = openMenu();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(runTask.mock.calls.length, 1);
	await emit("session_shutdown");
	finish({ kind: "cancelled" });
	await pending;
	assert.equal(vi.getTimerCount(), 0);
	await vi.advanceTimersByTimeAsync(TTL);
	assert.equal(vi.mocked(queryProviderUsage).mock.calls.length, 1);
});

test("an older cancelled menu does not replace a newer query's refresh schedule", async () => {
	const { start, openMenu, emit } = setup();
	await start();
	let finish!: (result: { kind: "cancelled" }) => void;
	runTask.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const pending = openMenu();
	await vi.advanceTimersByTimeAsync(0);
	await emit("turn_start");
	await vi.advanceTimersByTimeAsync(TTL / 2);
	finish({ kind: "cancelled" });
	await pending;
	await vi.advanceTimersByTimeAsync(TTL / 2);
	assert.equal(vi.mocked(queryProviderUsage).mock.calls.length, 2);
});

for (const failure of ["throws", "changes account"] as const) {
	test(`persistent auth revalidation that ${failure} backs off, clears stale usage, and recovers`, async () => {
		const { auth, report, start, emit, snapshots } = setup();
		await start();
		let reads = 0;
		vi.mocked(resolveUsageAuth).mockImplementation(async () => {
			reads++;
			if (reads % 2 === 0) {
				if (failure === "throws") throw new Error("Fixture revalidation unavailable");
				return { ...auth, fingerprint: "account-b" };
			}
			return auth;
		});
		await emit("turn_start");
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(reads, 2, "failed revalidation must not recursively restart a microtask query");
		assert.equal(snapshots.at(-1)?.usage, undefined);
		assert.equal(snapshots.at(-1)?.dailyBudgetPercent, undefined);
		const clearedAt = snapshots.length;
		const scans = vi.mocked(sumProviderSpend).mock.calls.length;
		await vi.advanceTimersByTimeAsync(BACKOFF - 1);
		assert.equal(reads, 2);
		assert.equal(vi.mocked(sumProviderSpend).mock.calls.length, scans);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(reads, 4);
		await vi.advanceTimersByTimeAsync(BACKOFF);
		assert.equal(reads, 6);
		assert.ok(snapshots.slice(clearedAt).every((value) => value.usage === undefined));
		assert.equal(vi.mocked(queryProviderUsage).mock.calls.length, 3);

		vi.mocked(resolveUsageAuth).mockResolvedValue({ ...auth, fingerprint: "account-b" });
		vi.mocked(queryProviderUsage).mockResolvedValue({
			...report,
			buckets: report.buckets.map((bucket) => ({ ...bucket, used: 40 })),
		});
		await vi.advanceTimersByTimeAsync(BACKOFF);
		assert.equal(snapshots.at(-1)?.usage?.weekly?.usedPercent, 40);
		assert.equal(vi.mocked(queryProviderUsage).mock.calls.length, 4);
		await emit("session_shutdown");
		assert.equal(vi.getTimerCount(), 0);
	});
}

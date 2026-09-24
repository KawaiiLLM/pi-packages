import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { subscribeUsageSnapshots, type UsageSnapshot } from "../src/snapshot.js";
import { createSnapshotPublisher } from "../src/snapshot-publisher.js";
import type { UsageReport } from "../src/types.js";

async function until(predicate: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("ledger snapshot did not arrive");
}

test("restart waits for cancelled IO and cannot publish stale data", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "spend-publisher-stale-"));
	const file = join(root, "session.jsonl");
	const model = {
		provider: "openai-codex",
		id: "fixture-model",
		api: "openai-codex-responses",
		baseUrl: "https://example.test",
	};
	const { ctx } = createMockContext({ model });
	const mock = createMockPi();
	const snapshots: UsageSnapshot[] = [];
	const unsubscribe = subscribeUsageSnapshots(mock.pi.events, (snapshot) =>
		snapshots.push(snapshot),
	);
	const publisher = createSnapshotPublisher(mock.pi.events, root, () => ({
		enabled: false,
		effective: false,
	}));
	t.onTestFinished(async () => {
		vi.restoreAllMocks();
		publisher.stop();
		unsubscribe();
		await rm(root, { recursive: true, force: true });
	});
	const line = (id: string, cost: number) =>
		`${JSON.stringify({ type: "message", id, timestamp: new Date().toISOString(), message: { role: "assistant", provider: model.provider, usage: { cost: { total: cost } } } })}\n`;
	await writeFile(file, line("old", 2));
	const sample = await open(file, "r");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<unknown>;
	};
	await sample.close();
	const original = prototype.read;
	let enter!: () => void;
	let unblock!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	let reads = 0;
	vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		reads++;
		if (reads === 1) {
			enter();
			await gate;
		}
		return original.apply(this, args);
	});
	publisher.start(ctx);
	await entered;
	publisher.stop();
	await writeFile(file, line("new", 5));
	publisher.start(ctx);
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(reads, 1, "restart must not overlap the old IO");
	unblock();
	await until(() => snapshots.at(-1)?.dailySpend?.dollars === 5);
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(snapshots.at(-1)?.dailySpend?.dollars, 5);
	assert.equal(
		snapshots.some((snapshot) => snapshot.dailySpend?.dollars === 2),
		false,
	);
});

test("publisher stop/start retains the ledger and only reads appended bytes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "spend-publisher-"));
	const model = {
		provider: "openai-codex",
		id: "fixture-model",
		api: "openai-codex-responses",
		baseUrl: "https://example.test",
	};
	const { ctx } = createMockContext({ model });
	const mock = createMockPi();
	const snapshots: UsageSnapshot[] = [];
	const unsubscribe = subscribeUsageSnapshots(mock.pi.events, (snapshot) =>
		snapshots.push(snapshot),
	);
	const publisher = createSnapshotPublisher(mock.pi.events, root, () => ({
		enabled: false,
		effective: false,
	}));
	t.onTestFinished(async () => {
		publisher.stop();
		unsubscribe();
		await rm(root, { recursive: true, force: true });
	});
	const line = (id: string) =>
		`${JSON.stringify({ type: "message", id, timestamp: new Date().toISOString(), message: { role: "assistant", provider: model.provider, usage: { cost: { total: 2 } } } })}\n`;
	const file = join(root, "session.jsonl");
	const sample = await open(file, "w+");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
	};
	await sample.close();
	const original = prototype.read;
	const readLengths: number[] = [];
	vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		const result = await original.apply(this, args);
		readLengths.push(result.bytesRead);
		return result;
	});
	await writeFile(file, line("a"));
	publisher.start(ctx);
	await until(() => snapshots.at(-1)?.dailySpend?.dollars === 2);
	publisher.stop();
	readLengths.length = 0;
	publisher.start(ctx);
	await until(() => snapshots.at(-1)?.dailySpend?.dollars === 2);
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(readLengths, [], "unchanged session must not be reread");
	const added = line("b");
	await appendFile(file, added);
	publisher.refreshDaily(ctx);
	await until(() => snapshots.at(-1)?.dailySpend?.dollars === 4);
	assert.deepEqual(readLengths, [64, Buffer.byteLength(added)]);
	const report: UsageReport = {
		providerId: model.provider,
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
				resetsAt: Math.floor(Date.now() / 1000) + 86400,
			},
		],
		metrics: [],
	};
	publisher.publish(ctx, report, async () => true);
	await until(() => snapshots.at(-1)?.usage?.weekly?.spent === 4);
	assert.equal(snapshots.at(-1)?.dailySpend?.dollars, 4);
});

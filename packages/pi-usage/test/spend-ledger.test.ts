import { strict as assert } from "node:assert";
import * as fsPromises from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { SpendLedger } from "../src/spend-ledger.js";
import { sumProviderSpend } from "../src/usage-spend.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, readdir: vi.fn(original.readdir), stat: vi.fn(original.stat) };
});

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "spend-ledger-"));
	roots.push(root);
	return { root, ledger: new SpendLedger(root), file: join(root, "session.jsonl") };
}
const date = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
function reply(id: string | number, n: number, provider = "openai-codex", cost = 1) {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: date(n),
		message: { role: "assistant", provider, usage: { cost: { total: cost } } },
	});
}
async function equal(root: string, ledger: SpendLedger, start: number) {
	await ledger.update("today", start);
	for (const provider of ["openai-codex", "anthropic"]) {
		assert.ok(
			Math.abs(ledger.sum(provider, start) - (await sumProviderSpend(root, provider, start))) <
				1e-9,
		);
	}
}

test("incremental append, partial EOF, fork, reset, and deleted subtree match full scanner", async () => {
	const { root, ledger, file } = await fixture();
	const start = Date.parse(date(0));
	await writeFile(file, reply("a", 1) + "\n");
	await equal(root, ledger, start);
	await appendFile(file, reply("b", 2));
	await equal(root, ledger, start);
	await appendFile(file, "\n");
	await equal(root, ledger, start);
	const branch = join(root, "nested");
	await mkdir(branch);
	await writeFile(join(branch, "fork.jsonl"), reply("a", 1) + "\n" + reply(0, 3) + "\n");
	await equal(root, ledger, start);
	await writeFile(file, reply("a", 1) + "\n" + reply("c", 4, "anthropic") + "\n");
	await equal(root, ledger, start);
	await rm(branch, { recursive: true });
	await equal(root, ledger, start);
	ledger.stop();
});

test("long UTF8 line across blocks and temporary non-string ID finalize exactly once", async () => {
	const { root, ledger, file } = await fixture();
	const start = Date.parse(date(0));
	const huge = JSON.stringify({
		type: "message",
		id: "large",
		timestamp: date(1),
		message: {
			role: "assistant",
			provider: "openai-codex",
			text: "x".repeat(1024 * 1024 - 120) + "中",
			usage: { cost: { total: 2 } },
		},
	});
	await writeFile(file, huge + "\n" + reply(42, 2));
	await equal(root, ledger, start);
	await appendFile(file, "\n");
	await equal(root, ledger, start);
	assert.equal(ledger.sum("openai-codex", start), 3);
	ledger.stop();
});

test("first today pass retains older entries for a later weekly purpose without rereading", async () => {
	const { ledger, file } = await fixture();
	const older = Date.parse(date(0));
	const today = Date.parse(date(5));
	await writeFile(file, `${reply("old", 1)}\n${reply("new", 6)}\n`);
	await ledger.update("today", today);
	assert.equal((ledger as unknown as { prunedTo?: number }).prunedTo, undefined);
	const sample = await open(file, "r");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<unknown>;
	};
	await sample.close();
	const spy = vi.spyOn(prototype, "read");
	await ledger.update("weekly", older);
	assert.equal(ledger.sum("openai-codex", older), 2);
	assert.equal(spy.mock.calls.length, 0);
	spy.mockRestore();
	ledger.stop();
});

test("each file tail owns only its tiny fingerprint, not a slice of a long source buffer", async () => {
	const { root, ledger } = await fixture();
	const since = Date.parse(date(0));
	for (let i = 0; i < 5; i++) {
		await writeFile(join(root, `${i}.jsonl`), `${reply(`id-${i}`, 1)}\n${"x".repeat(800_000)}\n`);
	}
	await ledger.update("today", since);
	const files = (ledger as unknown as { files: Map<string, { tail: Buffer }> }).files;
	assert.equal(files.size, 5);
	for (const record of files.values()) {
		assert.equal(record.tail.length, 64);
		assert.ok(record.tail.buffer.byteLength <= 64);
	}
	ledger.stop();
});

test("steady refresh reads no data; append reads new bytes and at most 64 bytes of fingerprint", async () => {
	const { ledger, file } = await fixture();
	const since = Date.parse(date(0));
	await writeFile(file, reply("a", 1) + "\n");
	await ledger.update("today", since);
	const sample = await open(file, "r");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
	};
	await sample.close();
	const original = prototype.read;
	const reads: Array<{ length: number; position: number }> = [];
	const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		const result = await original.apply(this, args);
		reads.push({ length: result.bytesRead, position: args[3] as number });
		return result;
	});
	await ledger.update("today", since);
	assert.equal(reads.length, 0);
	const added = reply("b", 2) + "\n";
	await appendFile(file, added);
	await ledger.update("today", since);
	assert.equal(reads.length, 2);
	assert.deepEqual(
		reads.map((read) => read.length),
		[64, Buffer.byteLength(added)],
	);
	spy.mockRestore();
	ledger.stop();
});

test("EOF promotion preserves same-file and cross-file references", async () => {
	const { root, ledger, file } = await fixture();
	const since = Date.parse(date(0));
	const fork = join(root, "fork.jsonl");
	const text = reply("shared", 1);
	await writeFile(fork, text + "\n");
	await writeFile(file, text + "\n" + text);
	await equal(root, ledger, since);
	assert.equal(ledger.replyCount, 1);
	await appendFile(file, "\n");
	await equal(root, ledger, since);
	assert.equal(ledger.replyCount, 1);
	await rm(file);
	await equal(root, ledger, since);
	assert.equal(ledger.sum("openai-codex", since), 1);
	ledger.stop();
});

test("active scan leaves newer refresh for next pass; cancelling one waiter does not cancel another", async () => {
	const { root, ledger, file } = await fixture();
	const since = Date.parse(date(0));
	await writeFile(file, reply("old", 1) + "\n");
	const sample = await open(file, "r");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<unknown>;
	};
	await sample.close();
	const original = prototype.read;
	let unblock!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let once = true;
	vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		if (once && args[3] === 0) {
			once = false;
			entered();
			await held;
		}
		return original.apply(this, args);
	});
	const first = ledger.update("today", since);
	await started;
	await appendFile(file, reply("new", 2) + "\n");
	const cancelled = new AbortController();
	const rejected = ledger.update("weekly", since, cancelled.signal);
	const next = ledger.update("fiveHour", since);
	cancelled.abort();
	await assert.rejects(rejected, { name: "AbortError" });
	unblock();
	await first;
	await next;
	assert.equal(ledger.sum("openai-codex", since), 2);
	ledger.stop();
});

test("release and changed purpose floor during a pass prune safely; earlier floor rebuilds", async () => {
	const { root, ledger, file } = await fixture();
	const older = Date.parse(date(0));
	const newer = Date.parse(date(5));
	await writeFile(file, reply("old", 1) + "\n" + reply("new", 6) + "\n");
	await ledger.update("weekly", older);
	await ledger.update("today", newer);
	await appendFile(file, reply("fresh", 7) + "\n");
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
	let once = true;
	const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		if (once && args[3] !== 0) {
			once = false;
			enter();
			await gate;
		}
		return original.apply(this, args);
	});
	const active = ledger.update("weekly", older);
	await entered;
	ledger.release("weekly");
	const queued = ledger.update("today", newer);
	unblock();
	await active;
	await queued;
	assert.equal(ledger.sum("openai-codex", newer), 2);
	assert.equal(ledger.replyCount, 3);
	const fork = join(root, "fork.jsonl");
	await writeFile(fork, reply("old", 1) + "\n");
	await ledger.update("today", newer);
	assert.equal(ledger.replyCount, 3, "release must not prune old replies");
	spy.mockRestore();
	await ledger.update("weekly", older);
	assert.equal(ledger.sum("openai-codex", older), 3);
	assert.equal(ledger.replyCount, 3);
	ledger.stop();
});

test("directory and stat errors retain cached contributions, then recover", async () => {
	const { root, ledger, file } = await fixture();
	const since = Date.parse(date(0));
	await writeFile(file, reply("old", 1) + "\n");
	await ledger.update("today", since);
	await writeFile(file, reply("new", 2, "openai-codex", 5) + "\n");
	vi.mocked(fsPromises.readdir).mockRejectedValueOnce(
		Object.assign(new Error("directory unavailable"), { code: "EIO" }),
	);
	await ledger.update("today", since);
	assert.equal(ledger.sum("openai-codex", since), 1);
	vi.mocked(fsPromises.stat).mockRejectedValueOnce(
		Object.assign(new Error("stat unavailable"), { code: "EMFILE" }),
	);
	await ledger.update("today", since);
	assert.equal(ledger.sum("openai-codex", since), 1);
	await equal(root, ledger, since);
	assert.equal(ledger.sum("openai-codex", since), 5);
	ledger.stop();
});

test("a newer request for the same purpose cannot prune an earlier in-flight waiter", async () => {
	const { ledger, file } = await fixture();
	const older = Date.parse(date(0));
	const newer = Date.parse(date(5));
	await writeFile(file, `${reply("old", 1)}\n${reply("new", 6)}\n`);
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
	let once = true;
	vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		if (once) {
			once = false;
			enter();
			await gate;
		}
		return original.apply(this, args);
	});
	const first = ledger.update("today", older);
	await entered;
	const next = ledger.update("today", newer);
	unblock();
	await first;
	assert.equal(ledger.sum("openai-codex", older), 2);
	await next;
	assert.equal(ledger.sum("openai-codex", newer), 1);
	ledger.stop();
});

test("reset read failure leaves old contribution until successful replacement", async () => {
	const { root, ledger, file } = await fixture();
	const since = Date.parse(date(0));
	await writeFile(file, reply("old", 1) + "\n");
	await ledger.update("today", since);
	await writeFile(file, reply("new", 2, "openai-codex", 5) + "\n" + " ".repeat(1024 * 1024) + "\n");
	const sample = await open(file, "r");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<unknown>;
	};
	await sample.close();
	const original = prototype.read;
	let calls = 0;
	const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		if (++calls === 3) throw Object.assign(new Error("transient read failure"), { code: "EIO" });
		return original.apply(this, args);
	});
	await ledger.update("today", since);
	assert.equal(ledger.sum("openai-codex", since), 1);
	spy.mockRestore();
	await equal(root, ledger, since);
	assert.equal(ledger.sum("openai-codex", since), 5);
	ledger.stop();
});

test("stop midway through a reset discards staged replies and keeps the old file", async () => {
	const { ledger, file } = await fixture();
	const since = Date.parse(date(0));
	await writeFile(file, reply("old", 1) + "\n");
	await ledger.update("today", since);
	await writeFile(file, reply("new", 2, "openai-codex", 5) + "\n" + "x".repeat(1024 * 1024) + "\n");
	const sample = await open(file, "r");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<unknown>;
	};
	await sample.close();
	const original = prototype.read;
	let entered!: () => void;
	let unblock!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	let calls = 0;
	vi.spyOn(prototype, "read").mockImplementation(async function (
		this: unknown,
		...args: unknown[]
	) {
		if (++calls === 3) {
			entered();
			await held;
		}
		return original.apply(this, args);
	});
	const pending = ledger.update("today", since);
	await started;
	ledger.stop();
	unblock();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(ledger.sum("openai-codex", since), 1);
});

test("unregistering every purpose and registering today does not discard weekly history", async () => {
	const { ledger, file } = await fixture();
	const older = Date.parse(date(0));
	const today = Date.parse(date(5));
	await writeFile(file, `${reply("old", 1)}\n${reply("new", 6)}\n`);
	await ledger.update("weekly", older);
	await ledger.update("fiveHour", today);
	await ledger.update("today", today);
	for (const purpose of ["today", "fiveHour", "weekly"] as const) ledger.release(purpose);
	await ledger.update("today", today);
	assert.equal(ledger.replyCount, 2);
	const sample = await open(file, "r");
	const prototype = Object.getPrototypeOf(sample) as {
		read: (...args: unknown[]) => Promise<unknown>;
	};
	await sample.close();
	const spy = vi.spyOn(prototype, "read");
	await ledger.update("fiveHour", today);
	await ledger.update("weekly", older);
	assert.equal(ledger.sum("openai-codex", older), 2);
	assert.equal(spy.mock.calls.length, 0);
	spy.mockRestore();
	ledger.stop();
});

test("advancing an existing purpose prunes old history and stop retains the cursor", async () => {
	const { ledger, file } = await fixture();
	const older = Date.parse(date(0));
	const today = Date.parse(date(5));
	await writeFile(file, `${reply("old", 1)}\n${reply("new", 6)}\n`);
	await ledger.update("today", older);
	await ledger.update("today", today);
	assert.equal(ledger.replyCount, 1);
	ledger.stop();
	await ledger.update("today", today);
	assert.equal(ledger.replyCount, 1);
	await ledger.update("weekly", older);
	assert.equal(ledger.sum("openai-codex", older), 2);
	ledger.stop();
});

test("seeded operations and retention rollback compare against full scan", async () => {
	const { root, ledger, file } = await fixture();
	const start = Date.parse(date(0));
	let seed = 17;
	const random = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	let lines: string[] = [];
	for (let i = 0; i < 45; i++) {
		const item = reply(
			i % 7 === 0 ? 10 : `id-${i}`,
			i,
			i % 3 ? "openai-codex" : "anthropic",
			i / 10,
		);
		if (random() < 0.3) lines = lines.slice(Math.floor(random() * lines.length));
		lines.push(item);
		await writeFile(file, lines.join("\n") + "\n");
		const since = start + Math.floor(random() * i) * 1000;
		await equal(root, ledger, since);
		if (i % 8 === 0) {
			await ledger.update("weekly", start);
			await equal(root, ledger, start);
		}
	}
	ledger.stop();
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { entryCost, sumProviderSpend } from "../src/usage-spend.js";

const SINCE = Date.parse("2026-09-01T00:00:00Z");

function reply(provider: string, at: string, total: number): string {
	return JSON.stringify({
		type: "message",
		timestamp: at,
		message: { role: "assistant", provider, usage: { cost: { total } } },
	});
}

test("only this provider's assistant replies inside the window cost anything", () => {
	assert.equal(
		entryCost(
			JSON.parse(reply("openai-codex", "2026-09-02T00:00:00Z", 0.5)),
			"openai-codex",
			SINCE,
		),
		0.5,
	);
	assert.equal(
		entryCost(JSON.parse(reply("anthropic", "2026-09-02T00:00:00Z", 0.5)), "openai-codex", SINCE),
		0,
	);
	assert.equal(
		entryCost(
			JSON.parse(reply("openai-codex", "2026-08-31T23:59:59Z", 0.5)),
			"openai-codex",
			SINCE,
		),
		0,
	);
	assert.equal(
		entryCost(
			{
				type: "message",
				timestamp: "2026-09-02T00:00:00Z",
				message: { role: "user", provider: "openai-codex" },
			},
			"openai-codex",
			SINCE,
		),
		0,
	);
	assert.equal(
		entryCost({ type: "session", timestamp: "2026-09-02T00:00:00Z" }, "openai-codex", SINCE),
		0,
	);
	assert.equal(entryCost("not an entry", "openai-codex", SINCE), 0);
	assert.equal(
		entryCost(
			{
				type: "message",
				timestamp: "2026-09-02T00:00:00Z",
				message: { role: "assistant", provider: "openai-codex", usage: {} },
			},
			"openai-codex",
			SINCE,
		),
		0,
	);
});

test("spend sums across session directories, screening files by mtime and entries by time", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-spend-"));
	try {
		const recent = join(root, "--workspace-a--");
		const other = join(root, "--workspace-b--");
		mkdirSync(recent);
		mkdirSync(other);
		writeFileSync(
			join(recent, "2026-08-31T20-00-00-000Z_a.jsonl"),
			[
				JSON.stringify({ type: "session", timestamp: "2026-08-31T20:00:00Z" }),
				reply("openai-codex", "2026-08-31T21:00:00Z", 1),
				reply("openai-codex", "2026-09-01T01:00:00Z", 0.25),
				reply("anthropic", "2026-09-01T02:00:00Z", 4),
				"not json",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(other, "2026-09-02T00-00-00-000Z_b.jsonl"),
			reply("openai-codex", "2026-09-02T00:00:00Z", 0.5),
		);
		writeFileSync(join(other, "notes.txt"), reply("openai-codex", "2026-09-02T00:00:00Z", 100));
		const stale = join(other, "2026-08-01T00-00-00-000Z_c.jsonl");
		writeFileSync(stale, reply("openai-codex", "2026-09-02T00:00:00Z", 100));
		const staleAt = new Date("2026-08-01T00:00:00Z");
		utimesSync(stale, staleAt, staleAt);

		assert.equal(await sumProviderSpend(root, "openai-codex", SINCE), 0.75);
		assert.equal(await sumProviderSpend(root, "anthropic", SINCE), 4);
		assert.equal(await sumProviderSpend(join(root, "missing"), "openai-codex", SINCE), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an aborted scan stops rather than finishing the sum", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-spend-"));
	try {
		writeFileSync(join(root, "a.jsonl"), reply("openai-codex", "2026-09-02T00:00:00Z", 1));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(sumProviderSpend(root, "openai-codex", SINCE, controller.signal));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nested sessions are included without pruning old directories or mixing providers and windows", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-nested-spend-"));
	try {
		const workspace = join(root, "--workspace--");
		const nested = join(workspace, "parent", "tasks");
		const deeper = join(nested, "child", "other-layout", "sessions");
		mkdirSync(deeper, { recursive: true });
		for (const [directory, total] of [
			[root, 1],
			[workspace, 2],
			[nested, 3],
			[deeper, 4],
		] as const) {
			writeFileSync(
				join(directory, "session.jsonl"),
				reply("openai-codex", "2026-09-02T00:00:00Z", total),
			);
		}
		writeFileSync(
			join(deeper, "filtered.jsonl"),
			[
				reply("openai-codex", "2026-08-31T23:59:59Z", 100),
				reply("anthropic", "2026-09-02T00:00:00Z", 200),
				'{"type":"message","message":{"role":"assistant"',
			].join("\n"),
		);
		const old = new Date("2026-08-01T00:00:00Z");
		utimesSync(workspace, old, old);
		utimesSync(nested, old, old);
		assert.equal(await sumProviderSpend(root, "openai-codex", SINCE), 10);
		assert.equal(await sumProviderSpend(root, "anthropic", SINCE), 200);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("symlinks to files, external directories, and ancestor cycles are not followed", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-links-"));
	const outside = mkdtempSync(join(tmpdir(), "pi-statusline-outside-"));
	try {
		const nested = join(root, "workspace", "parent", "children");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "actual.jsonl"), reply("openai-codex", "2026-09-02T00:00:00Z", 1));
		writeFileSync(
			join(outside, "external.jsonl"),
			reply("openai-codex", "2026-09-02T00:00:00Z", 100),
		);
		symlinkSync(root, join(nested, "cycle"), "dir");
		symlinkSync(outside, join(nested, "outside"), "dir");
		symlinkSync(join(outside, "external.jsonl"), join(nested, "linked.jsonl"), "file");
		symlinkSync(join(outside, "missing.jsonl"), join(root, "dangling.jsonl"), "file");
		mkdirSync(join(nested, "directory.jsonl"));
		assert.equal(await sumProviderSpend(root, "openai-codex", SINCE), 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("short entry ID collisions do not discard distinct replies", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-id-collision-"));
	try {
		const original = {
			...JSON.parse(reply("openai-codex", "2026-09-02T00:00:00Z", 2)),
			id: "12345678",
		};
		const different = { ...original, message: { ...original.message, content: "another reply" } };
		writeFileSync(join(root, "a.jsonl"), JSON.stringify(original));
		writeFileSync(join(root, "b.jsonl"), JSON.stringify(different));
		assert.equal(await sumProviderSpend(root, "openai-codex", SINCE), 4);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an already aborted scan rejects even when its root is missing", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-aborted-empty-"));
	try {
		const signal = AbortSignal.abort();
		await assert.rejects(sumProviderSpend(join(root, "missing"), "openai-codex", SINCE, signal), {
			name: "AbortError",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fork's copy of the history is charged once even in a nested session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-spend-"));
	try {
		const shared = JSON.stringify({
			type: "message",
			id: "a93fa05f",
			timestamp: "2026-09-02T00:00:00Z",
			message: { role: "assistant", provider: "openai-codex", usage: { cost: { total: 2 } } },
		});
		writeFileSync(join(root, "2026-09-02T00-00-00-000Z_main.jsonl"), shared);
		const nested = join(root, "workspace", "parent", "tasks");
		mkdirSync(nested, { recursive: true });
		writeFileSync(
			join(nested, "2026-09-02T00-01-00-000Z_fork.jsonl"),
			[shared, reply("openai-codex", "2026-09-02T00:01:00Z", 0.5)].join("\n"),
		);

		assert.equal(await sumProviderSpend(root, "openai-codex", SINCE), 2.5);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

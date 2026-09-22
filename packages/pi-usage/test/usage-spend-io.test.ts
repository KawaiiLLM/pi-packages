import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { sumProviderSpend } from "../src/usage-spend.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, readdir: vi.fn(original.readdir), readFile: vi.fn(original.readFile) };
});
const original = await vi.importActual<typeof fs>("node:fs/promises");
afterEach(() => {
	vi.mocked(fs.readdir).mockReset().mockImplementation(original.readdir);
	vi.mocked(fs.readFile).mockReset().mockImplementation(original.readFile);
});

function session(root: string, directory: string, cost: number) {
	const dir = join(root, directory);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "a.jsonl"),
		JSON.stringify({
			type: "message",
			timestamp: "2026-09-02T00:00:00Z",
			message: { role: "assistant", provider: "openai-codex", usage: { cost: { total: cost } } },
		}),
	);
}

test("a failed directory read does not discard other nested sessions", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-directory-error-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	session(root, "one", 1);
	session(root, "two", 1);
	vi.mocked(fs.readdir)
		.mockImplementationOnce(original.readdir)
		.mockRejectedValueOnce(new Error("unreadable"));
	assert.equal(await sumProviderSpend(root, "openai-codex", 0), 1);
});

test("a failed file read does not discard other nested sessions", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-file-error-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	session(root, "", 100);
	session(root, "nested", 1);
	vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("unreadable"));
	assert.equal(await sumProviderSpend(root, "openai-codex", 0), 1);
});

test("cancellation while discovering a nested directory propagates instead of returning a partial sum", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-discovery-abort-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	session(root, "", 1);
	session(root, "nested", 2);
	const controller = new AbortController();
	const reads = vi
		.mocked(fs.readdir)
		.mockImplementationOnce(original.readdir)
		.mockImplementationOnce(async () => {
			controller.abort();
			throw controller.signal.reason;
		});
	await assert.rejects(sumProviderSpend(root, "openai-codex", 0, controller.signal), {
		name: "AbortError",
	});
	assert.equal(reads.mock.calls.length, 2);
});

test("file reads receive the scan signal and cancellation is not swallowed as an unreadable file", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-read-abort-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	session(root, "nested", 1);
	const controller = new AbortController();
	const reads = vi.mocked(fs.readFile).mockImplementationOnce(async () => {
		controller.abort();
		throw controller.signal.reason;
	});
	await assert.rejects(sumProviderSpend(root, "openai-codex", 0, controller.signal), {
		name: "AbortError",
	});
	assert.equal(reads.mock.calls.length, 1);
	assert.deepEqual(reads.mock.calls[0]?.[1], { encoding: "utf8", signal: controller.signal });
});

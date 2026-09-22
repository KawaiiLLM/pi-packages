import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { subscribeUsageSnapshots, type UsageSnapshot, usageModelKey } from "../src/snapshot.js";
import usageExtension from "../src/usage.js";

async function until(predicate: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("Snapshot did not arrive");
}

test("production publishes numeric snapshots, reuses upstream menu cache, and never renders usage status", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-usage-snapshot-"));
	const originalFetch = globalThis.fetch;
	const mock = createMockPi();
	const now = Date.now();
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches++;
		return new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 10,
						limit_window_seconds: 18000,
						reset_at: now / 1000 + 3600,
					},
					secondary_window: {
						used_percent: 20,
						limit_window_seconds: 604800,
						reset_at: now / 1000 + 86400,
					},
				},
			}),
			{ status: 200 },
		);
	};
	const model = {
		id: "gpt-5.4",
		name: "GPT",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
	};
	const statusWriter = vi.fn();
	const { ctx } = createMockContext({
		model,
		hasUI: true,
		mode: "rpc",
		select: async () => "Close",
		ui: { setStatus: statusWriter },
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "fixture-token" } }),
			getAvailable: () => [model],
			getAll: () => [model],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "Codex",
		},
	});
	const values: UsageSnapshot[] = [];
	const unsubscribe = subscribeUsageSnapshots(mock.pi.events, (value) => values.push(value));
	usageExtension(mock.pi, {
		sessionsDir: root,
		settingsRuntime: createUsageSettingsRuntime({ path: join(root, "pi-usage.json") }),
	});
	t.onTestFinished(async () => {
		for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
		unsubscribe();
		globalThis.fetch = originalFetch;
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(
		join(root, "session.jsonl"),
		JSON.stringify({
			type: "message",
			id: "original",
			timestamp: new Date(now).toISOString(),
			message: { role: "assistant", provider: model.provider, usage: { cost: { total: 2 } } },
		}),
	);
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await until(() => values.at(-1)?.usage?.weekly !== undefined);
	assert.equal(values.at(-1)?.usage?.weekly?.spent, 2);
	assert.equal(values.at(-1)?.usage?.fiveHour?.spent, 2);
	assert.equal(values.at(-1)?.dailySpend?.dollars, 2);
	assert.equal(values.at(-1)?.modelKey, usageModelKey(ctx.model));
	assert.equal(fetches, 1);
	await mock.commands.get("usage")?.handler("", ctx);
	assert.equal(fetches, 1, "menu and background must share one provider query/cache");
	assert.equal(statusWriter.mock.calls.length, 0);
});

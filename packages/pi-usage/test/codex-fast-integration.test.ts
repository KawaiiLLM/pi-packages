import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { subscribeUsageSnapshots, type UsageSnapshot } from "../src/snapshot.js";
import usageExtension from "../src/usage.js";

const astra = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 500_000,
	maxTokens: 32_000,
	cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
};

test("real catalog adapter enables Astra, publishes Fast, and reuses metadata without extra usage queries", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fast-catalog-integration-"));
	const accountId = "synthetic-catalog-account";
	const token = `header.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url")}.signature`;
	const mock = createMockPi();
	const settings = createUsageSettingsRuntime(join(root, "pi-usage.json"));
	const context = createMockContext({
		mode: "rpc",
		model: astra,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
			getProviderAuth: async () => ({ auth: { apiKey: token } }),
			getAvailable: () => [astra],
			getAll: () => [astra],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "Codex",
		},
	});
	let catalogRequests = 0;
	let usageRequests = 0;
	const requests: Array<{ url: string; method?: string }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, method: init?.method });
		assert.equal(init?.method, "GET", "this test must never make an inference request");
		if (url.startsWith("https://chatgpt.com/backend-api/codex/models?")) {
			catalogRequests++;
			assert.equal(new URL(url).searchParams.get("client_version"), "0.153.4");
			assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), accountId);
			assert.equal(init?.redirect, "error");
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: astra.id,
							service_tiers: [{ id: "priority", name: "Fast", description: "Faster responses." }],
						},
					],
				}),
			);
		}
		assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
		usageRequests++;
		return new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 10,
						limit_window_seconds: 18_000,
						reset_at: Date.now() / 1000 + 3600,
					},
				},
			}),
		);
	});
	let snapshot: UsageSnapshot | undefined;
	const unsubscribe = subscribeUsageSnapshots(mock.pi.events, (value) => {
		snapshot = value;
	});
	usageExtension(mock.pi, {
		settingsRuntime: settings,
		sessionsDir: root,
		credentialReader: () => ({
			type: "oauth",
			access: token,
			refresh: "fixture-refresh",
			expires: Date.now() + 3_600_000,
			accountId,
		}),
	});
	try {
		for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
		await vi.waitFor(() => assert.equal(usageRequests, 1));
		assert.equal(catalogRequests, 0, "disabled Fast must not add a startup network request");
		await mock.commands.get("fast")?.handler("", context.ctx);
		assert.equal(settings.get().settings.codexFastMode, true);
		assert.deepEqual(snapshot?.fast, { enabled: true, effective: true });
		assert.equal(catalogRequests, 1);
		const hook = mock.events.get("before_provider_request")?.[0];
		assert.ok(hook);
		assert.deepEqual(await hook({ payload: { model: astra.id } }, context.ctx), {
			model: astra.id,
			service_tier: "priority",
		});
		assert.equal(catalogRequests, 1, "a cached catalog must serve subsequent request checks");
		assert.equal(usageRequests, 1, "Fast state updates must not trigger another quota query");
		const costHook = mock.events.get("message_end")?.[0];
		assert.ok(costHook);
		const message = {
			role: "assistant",
			provider: astra.provider,
			model: astra.id,
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
			},
		};
		assert.equal(
			await costHook({ message }, context.ctx),
			undefined,
			"new model pricing must remain the SDK's estimate, not a guessed multiplier",
		);
		assert.equal(message.usage.cost.total, 0.02);
		assert.doesNotMatch(
			JSON.stringify(snapshot),
			/synthetic-catalog-account|fixture-refresh|signature/,
		);
		assert.equal(context.statuses.get("usage"), undefined);
		await mock.commands.get("fast")?.handler("", context.ctx);
		assert.equal(settings.get().settings.codexFastMode, false);
		assert.deepEqual(snapshot?.fast, { enabled: false, effective: false });
		assert.equal(catalogRequests, 1, "turning off must not query the catalog");
		assert.ok(requests.every((request) => !request.url.includes("/responses")));
	} finally {
		for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, context.ctx);
		unsubscribe();
		vi.unstubAllGlobals();
		await rm(root, { recursive: true, force: true });
	}
});

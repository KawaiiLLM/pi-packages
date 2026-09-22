import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import statusline from "../packages/pi-statusline/src/statusline.js";
import {
	subscribeUsageSnapshots,
	USAGE_SNAPSHOT_EVENT,
	type UsageSnapshot,
} from "../packages/pi-usage/src/snapshot.js";
import usage from "../packages/pi-usage/src/usage.js";
import { createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

const model = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};
const accountId = "integration-fixture-account";
const token = `header.${Buffer.from(
	JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	}),
).toString("base64url")}.signature`;

type Footer = { render(width: number): string[]; dispose(): void };
type FooterFactory = (
	tui: { requestRender(): void },
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	data: {
		getGitBranch(): null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		onBranchChange(callback: () => void): () => void;
	},
) => Footer;

async function emit(
	mock: ReturnType<typeof createMockPi>,
	name: string,
	context: ReturnType<typeof createMockContext>["ctx"],
	event: unknown = {},
) {
	for (const handler of mock.events.get(name) ?? []) await handler(event, context);
}

for (const order of ["usage-first", "statusline-first"] as const) {
	test(`${order}: one query feeds the unified footer and replay does not query again`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-usage-statusline-"));
		const sessionsDir = join(root, "sessions");
		const now = Date.now();
		const day = new Date(now);
		day.setHours(0, 0, 0, 0);
		const localMessage = (id: string, cost: number) =>
			JSON.stringify({
				type: "message",
				id,
				timestamp: new Date(now).toISOString(),
				message: { role: "assistant", provider: model.provider, usage: { cost: { total: cost } } },
			});
		mkdirSync(join(sessionsDir, "parent", "tasks", "nested"), { recursive: true });
		writeFileSync(join(sessionsDir, "parent", "main.jsonl"), `${localMessage("main", 2)}\n`);
		writeFileSync(
			join(sessionsDir, "parent", "tasks", "nested", "child.jsonl"),
			`${localMessage("child", 3)}\n`,
		);
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						plan_type: "pro",
						rate_limit: {
							primary_window: {
								used_percent: 20,
								limit_window_seconds: 18_000,
								reset_at: Math.floor(now / 1000) + 3600,
							},
							secondary_window: {
								used_percent: 40,
								limit_window_seconds: 604_800,
								reset_at: Math.floor(now / 1000) + 86_400,
							},
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetch);
		const mock = createMockPi();
		const registrations = vi.spyOn(mock.pi, "registerCommand");
		const context = createMockContext({
			mode: "tui",
			cwd: root,
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
				getProviderAuth: async () => ({ auth: { apiKey: token } }),
				getAvailable: () => [model],
				getAll: () => [model],
				getProviderAuthStatus: () => ({ configured: true }),
				getProviderDisplayName: () => "OpenAI Codex",
			},
		});
		let footer: Footer | undefined;
		let latest: UsageSnapshot | undefined;
		const stopObserving = subscribeUsageSnapshots(mock.pi.events, (value) => {
			latest = value;
		});
		const installUsage = () =>
			usage(mock.pi, {
				sessionsDir,
				credentialReader: () => ({
					type: "oauth",
					access: token,
					refresh: "fixture-only",
					expires: now + 3_600_000,
					accountId,
				}),
			});
		try {
			if (order === "usage-first") {
				installUsage();
				statusline(mock.pi);
			} else {
				statusline(mock.pi);
				installUsage();
			}
			for (const name of ["usage", "fast", "statusline"]) {
				assert.equal(
					registrations.mock.calls.filter(([registered]) => registered === name).length,
					1,
				);
			}
			assert.equal(mock.events.get("before_provider_request")?.length, 1);
			assert.equal(mock.events.get("message_end")?.length, 1);
			await emit(mock, "session_start", context.ctx);
			await vi.waitFor(() => {
				assert.equal(latest?.usage?.fiveHour?.usedPercent, 20);
				assert.equal(latest?.usage?.weekly?.usedPercent, 40);
				assert.equal(latest?.dailySpend?.dollars, 5);
			});
			assert.equal(latest?.dailySpend?.day, day.getTime());
			assert.equal(latest?.usage?.weekly?.spent, 5);
			assert.equal(latest?.usage?.weekly?.windowDollars, 12.5);
			assert.equal(latest?.dailyBudgetPercent, 280);
			assert.equal(fetch.mock.calls.length, 1);
			assert.equal(context.statuses.get("usage"), undefined);
			const payload = JSON.stringify(latest);
			assert.ok(!payload.includes(token));
			assert.ok(!payload.includes(accountId));
			const factory = context.footer as FooterFactory;
			footer = factory(
				{ requestRender() {} },
				{ fg: (_role, text) => text, bold: (text) => text },
				{
					getGitBranch: () => null,
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => {},
				},
			);
			const rendered = stripVTControlCharacters(footer.render(300).join("\n"));
			assert.match(rendered, /20%/);
			assert.match(rendered, /40%/);
			assert.doesNotMatch(rendered, /codex 80%/);
			const replay: UsageSnapshot[] = [];
			const unsubscribe = subscribeUsageSnapshots(mock.pi.events, (value) => replay.push(value));
			assert.equal(replay.at(-1)?.usage?.weekly?.usedPercent, 40);
			unsubscribe();
			assert.equal(fetch.mock.calls.length, 1);
			// A foreign session cannot replace this footer's current windows.
			mock.pi.events.emit(USAGE_SNAPSHOT_EVENT, {
				...latest,
				sessionId: "another-session",
				usage: undefined,
			});
			assert.match(stripVTControlCharacters(footer.render(300).join("\n")), /40%/);
			await emit(mock, "session_shutdown", context.ctx);
			assert.equal(context.footer, undefined);
			assert.equal(latest?.usage, undefined);
		} finally {
			await emit(mock, "session_shutdown", context.ctx);
			footer?.dispose();
			stopObserving();
			vi.unstubAllGlobals();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

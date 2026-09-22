import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	USAGE_REQUEST_SNAPSHOT_EVENT,
	USAGE_SNAPSHOT_EVENT,
	type UsageSnapshot,
	usageModelKey,
} from "@narumitw/pi-usage/snapshot";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import statusline from "../src/statusline.js";
import { CAROUSEL_PERIOD_MS } from "../src/usage-windows.js";

vi.mock("../src/git-status.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	readGitStatus: vi.fn(async () => undefined),
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-snapshots-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.useFakeTimers({ now: 1_760_000_000_000 });
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
	writeFileSync(
		join(root, "pi-statusline.json"),
		JSON.stringify({
			segments: ["model", "cost", "five_hour", "weekly"],
		}),
	);
	const mock = createMockPi();
	let footer: { render(width: number): string[]; dispose(): void } | undefined;
	const installedReadings: string[] = [];
	const redraw = vi.fn();
	const active = new Set<(data: unknown) => void>();
	const retired: Array<(data: unknown) => void> = [];
	const on = mock.eventBus.on.bind(mock.eventBus);
	vi.spyOn(mock.eventBus, "on").mockImplementation((channel, listener) => {
		const unsubscribe = on(channel, listener);
		if (channel === USAGE_SNAPSHOT_EVENT) active.add(listener);
		return () => {
			unsubscribe();
			if (active.delete(listener)) retired.push(listener);
		};
	});
	let replays = 0;
	on(USAGE_REQUEST_SNAPSHOT_EVENT, () => {
		replays += 1;
	});
	const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
	const render = () => (footer?.render(300).join("\n") ?? "").replace(ansi, "");
	const context = (sessionId = "session-a", model = "model-a") => {
		const result = createMockContext({
			mode: "tui",
			cwd: root,
			model: {
				id: model,
				provider: "openai-codex",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com",
			},
			sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] },
			modelRegistry: new Proxy(
				{},
				{
					get() {
						throw new Error("No account lookup allowed");
					},
				},
			),
		});
		const ctx = result.ctx as ExtensionContext;
		ctx.ui.setFooter = (factory) => {
			footer?.dispose();
			footer = factory?.(
				{ requestRender: redraw } as never,
				{ fg: (_color: string, text: string) => text } as never,
				{
					getGitBranch: () => null,
					getExtensionStatuses: () =>
						new Map([
							["usage", "DUPLICATE USAGE"],
							["codex-usage", "DUPLICATE CODEX"],
						]),
					onBranchChange: () => () => undefined,
				} as never,
			) as typeof footer;
			if (factory) installedReadings.push(render());
		};
		return ctx;
	};
	const emit = async (name: string, ctx: ExtensionContext) => {
		for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
	};
	const snapshot = (ctx: ExtensionContext): UsageSnapshot => ({
		sessionId: ctx.sessionManager.getSessionId(),
		modelKey: usageModelKey(ctx.model),
		dailySpend: { day: 0, dollars: 12.34, providerId: "openai-codex" },
		// Deliberately independent of the spend/window ratio: the footer must not recompute it.
		dailyBudgetPercent: 123,
		fast: { enabled: true, effective: true },
		usage: {
			providerId: "openai-codex",
			fiveHour: {
				bucketId: "5h",
				usedPercent: 12,
				windowMinutes: 300,
				resetsAt: Date.now() / 1000 + 3600,
				spent: 1,
				windowDollars: 647,
			},
			weekly: {
				bucketId: "week",
				usedPercent: 8,
				windowMinutes: 10080,
				resetsAt: Date.now() / 1000 + 86400,
				spent: 10,
			},
		},
	});
	const publish = (value: UsageSnapshot) => mock.eventBus.emit(USAGE_SNAPSHOT_EVENT, value);
	return {
		mock,
		context,
		emit,
		snapshot,
		publish,
		render,
		installedReadings,
		active,
		retired,
		redraw,
		fetch,
		get replays() {
			return replays;
		},
		cleanup() {
			footer?.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

for (const usageFirst of [true, false]) {
	test(`structured data reaches the unified footer with usage ${usageFirst ? "before" : "after"} statusline`, async (t) => {
		const f = fixture();
		t.onTestFinished(() => f.cleanup());
		const ctx = f.context();
		const value = f.snapshot(ctx);
		const startUsage = () => {
			f.mock.eventBus.on(USAGE_REQUEST_SNAPSHOT_EVENT, () => f.publish(value));
			f.publish(value);
		};
		if (usageFirst) startUsage();
		statusline(f.mock.pi);
		await f.emit("session_start", ctx);
		if (!usageFirst) startUsage();
		assert.match(f.render(), /model-a fast/u);
		assert.match(f.render(), /\$12\.34 \(123%\)/u);
		assert.match(f.render(), /◒\s+12%/u);
		assert.match(f.render(), /◑ 8%/u);
		assert.doesNotMatch(f.render(), /DUPLICATE/u);
		assert.ok(f.installedReadings.every((reading) => !reading.includes("$12.34")));
		assert.equal(f.replays, 1);
		assert.equal(f.active.size, 1);
		const first = f.render();
		vi.advanceTimersByTime(CAROUSEL_PERIOD_MS);
		assert.notEqual(f.render(), first);
		assert.ok([first, f.render()].some((reading) => reading.includes("$647")));
		for (const event of ["agent_start", "turn_start", "turn_end", "agent_end", "agent_settled"]) {
			await f.emit(event, ctx);
		}
		assert.equal(f.replays, 1, "turns only redraw, never request another usage query");
		assert.deepEqual([...f.mock.commands.keys()], ["statusline"]);
		for (const hook of [
			"before_provider_headers",
			"before_provider_request",
			"after_provider_response",
			"message_start",
			"message_update",
			"message_end",
			"input",
		]) {
			assert.equal(f.mock.events.has(hook), false, hook);
		}
		assert.equal(f.fetch.mock.calls.length, 0);
		await f.emit("session_shutdown", ctx);
		assert.equal(f.active.size, 0);
		const redraws = f.redraw.mock.calls.length;
		f.publish(value);
		assert.equal(f.redraw.mock.calls.length, redraws);
		assert.equal(vi.getTimerCount(), 0);
	});
}

test("session/model changes and tree reinstall clear data and reject stale snapshots", async (t) => {
	const f = fixture();
	t.onTestFinished(() => f.cleanup());
	statusline(f.mock.pi);
	const ctx = f.context();
	await f.emit("session_start", ctx);
	const old = f.snapshot(ctx);
	f.publish(old);
	assert.match(f.render(), /\$12\.34/u);
	(ctx as { model: ExtensionContext["model"] }).model = {
		...ctx.model,
		id: "model-b",
	} as ExtensionContext["model"];
	await f.emit("model_select", ctx);
	assert.equal(f.active.size, 1);
	assert.equal(f.replays, 2);
	assert.doesNotMatch(f.render(), /\$12\.34| fast/u);
	f.publish(old);
	f.retired[0]?.(old);
	assert.doesNotMatch(f.render(), /\$12\.34| fast/u);
	const current = f.snapshot(ctx);
	f.publish(current);
	assert.match(f.render(), /model-b fast/u);
	for (const change of [
		{ baseUrl: "https://proxy.invalid" },
		{ api: "openai-responses" },
		{ provider: "other" },
	]) {
		f.publish({
			...current,
			modelKey: usageModelKey({ ...ctx.model, ...change } as ExtensionContext["model"]),
			dailySpend: { day: 0, providerId: "other", dollars: 999 },
		});
		assert.doesNotMatch(f.render(), /999/u);
	}
	await f.emit("session_tree", ctx);
	assert.equal(f.active.size, 1);
	assert.equal(f.replays, 3);
	assert.doesNotMatch(f.render(), /\$12\.34| fast/u);
	f.publish(current);
	assert.match(f.render(), /\$12\.34/u);
	f.publish({
		sessionId: current.sessionId,
		modelKey: current.modelKey,
		error: "private query failure",
	});
	assert.doesNotMatch(f.render(), /\$12\.34| fast|◒|◑|private query failure/u);
	await f.emit("session_shutdown", ctx);
	const next = f.context("session-b", "model-b");
	await f.emit("session_start", next);
	f.publish(current);
	assert.doesNotMatch(f.render(), /\$12\.34/u);
	f.publish(f.snapshot(next));
	assert.match(f.render(), /\$12\.34/u);
	await f.emit("session_shutdown", ctx); // An old session must not unsubscribe the new one.
	assert.equal(f.active.size, 1);
	await f.emit("session_shutdown", next);
	assert.equal(f.active.size, 0);
	assert.equal(f.fetch.mock.calls.length, 0);
});

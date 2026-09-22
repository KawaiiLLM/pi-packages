import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { CodexFastCapability } from "../src/codex-models.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "../src/settings.js";
import usageExtension from "../src/usage.js";

const codexModel = {
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
const supported: CodexFastCapability = {
	kind: "supported",
	tier: "priority",
	description: "Priority routing for this account",
};
function catalog(
	capability: CodexFastCapability = supported,
	onResolve: () => void = () => undefined,
) {
	return {
		async resolve(_ctx: unknown, signal: AbortSignal): Promise<CodexFastCapability> {
			signal.throwIfAborted();
			onResolve();
			return capability;
		},
		clear() {},
	};
}

function runtime(kind: UsageSettingsState["kind"] = "loaded") {
	let state: UsageSettingsState = {
		kind,
		path: "/tmp/pi-usage.json",
		settings: { codexFastMode: false, codexStatusResetCountdown: false, selectedTargets: {} },
		...(kind === "invalid" ? { issue: "bad file" } : { document: {} }),
	};
	const patches: unknown[] = [];
	const settingsRuntime: UsageSettingsRuntime = {
		get: () => structuredClone(state),
		async reload() {
			return structuredClone(state);
		},
		async update(patch) {
			patches.push(patch);
			state = {
				...state,
				kind: "loaded",
				settings: { ...state.settings, ...patch },
				document: { ...state.document, ...patch },
			};
			return structuredClone(state);
		},
		async updateSelectedTarget() {
			throw new Error("target selection is not used in Codex Fast menu tests");
		},
		async flush() {},
	};
	return {
		settingsRuntime,
		patches,
		get state() {
			return state;
		},
	};
}

function registry(model = codexModel) {
	return {
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "codex-token" }),
		getProviderAuth: async () => ({ auth: { apiKey: "codex-token" } }),
		getAvailable: () => [model],
		getAll: () => [model],
		getProviderAuthStatus: () => ({ configured: true }),
		getProviderDisplayName: () => "OpenAI Codex",
	};
}

function response(): Promise<Response> {
	return Promise.resolve(
		new Response(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
			}),
			{ status: 200 },
		),
	);
}

test("/usage refreshes quota before catalog and toggles Fast without an extra quota request", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const operations: string[] = [];
	globalThis.fetch = async () => {
		operations.push("quota");
		return response();
	};
	const memory = runtime();
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: memory.settingsRuntime,
		codexModelCatalog: catalog(supported, () => {
			operations.push("catalog");
		}),
	});
	const choices = ["Turn Fast mode on", "Close"];
	const titles: string[] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.deepEqual(memory.patches, [{ codexFastMode: true }]);
	assert.match(titles[0] ?? "", /Fast mode: Off/);
	assert.match(titles[1] ?? "", /Fast mode: On/);
	assert.match(titles[0] ?? "", /may use more plan allowance/);
	assert.match(titles[0] ?? "", /estimates/);
	assert.doesNotMatch(titles[0] ?? "", /1\.5/);
	assert.match(notifications[0]?.message ?? "", /Fast mode enabled/);
	assert.deepEqual(operations, ["quota", "catalog", "catalog"]);
});

test("/usage cancellation leaves Fast unchanged", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const memory = runtime();
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: memory.settingsRuntime,
		codexModelCatalog: catalog(),
	});
	let options: string[] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (_title: string, values: string[]) => {
			options = values;
			return undefined;
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.ok(options.includes("Turn Fast mode on"));
	assert.deepEqual(memory.patches, []);
});

for (const capability of [
	{ kind: "unsupported", reason: "No priority tier" },
	{ kind: "unknown", reason: "Model catalog offline" },
] as const) {
	test(`/usage explicitly shows ${capability.kind} and never offers an enable action`, async (t) => {
		const originalFetch = globalThis.fetch;
		t.onTestFinished(() => {
			globalThis.fetch = originalFetch;
		});
		globalThis.fetch = response;
		const memory = runtime();
		const mock = createMockPi();
		usageExtension(mock.pi, {
			settingsRuntime: memory.settingsRuntime,
			codexModelCatalog: catalog(capability),
		});
		let title = "";
		let options: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			model: codexModel,
			select: async (value: string, values: string[]) => {
				title = value;
				options = values;
				return "Close";
			},
			modelRegistry: registry(),
		});
		await mock.commands.get("usage")?.handler("", ctx);
		assert.match(
			title,
			capability.kind === "unknown" ? /Fast mode: Unknown/ : /Fast mode: Unavailable/,
		);
		assert.ok(title.includes(capability.reason));
		assert.ok(!options.includes("Turn Fast mode on"));
		assert.deepEqual(memory.patches, []);
	});
}

for (const capability of [
	{ kind: "unknown", reason: "Model catalog offline" },
	{ kind: "unsupported", reason: "Priority was removed" },
] as const) {
	test(`/usage can turn saved Fast off when support is ${capability.kind}`, async (t) => {
		const originalFetch = globalThis.fetch;
		t.onTestFinished(() => {
			globalThis.fetch = originalFetch;
		});
		globalThis.fetch = response;
		const memory = runtime();
		await memory.settingsRuntime.update({ codexFastMode: true });
		memory.patches.length = 0;
		let resolutions = 0;
		const mock = createMockPi();
		usageExtension(mock.pi, {
			settingsRuntime: memory.settingsRuntime,
			codexModelCatalog: catalog(capability, () => {
				resolutions += 1;
			}),
		});
		const choices = ["Turn Fast mode off", "Close"];
		const options: string[][] = [];
		const current = createMockContext({
			mode: "rpc",
			model: codexModel,
			modelRegistry: registry(),
			select: async (_title: string, values: string[]) => {
				options.push(values);
				return choices.shift();
			},
		});
		await mock.commands.get("usage")?.handler("", current.ctx);
		assert.ok(options[0]?.includes("Turn Fast mode off"));
		assert.ok(!options[0]?.includes("Turn Fast mode on"));
		assert.deepEqual(memory.patches, [{ codexFastMode: false }]);
		assert.equal(resolutions, 1, "disabling must not try to reload unavailable metadata");
	});
}

for (const id of ["gpt-6-astra", "new-account-model"]) {
	test(`/usage offers Fast for catalog-supported ${id}`, async (t) => {
		const originalFetch = globalThis.fetch;
		t.onTestFinished(() => {
			globalThis.fetch = originalFetch;
		});
		globalThis.fetch = response;
		const memory = runtime();
		const mock = createMockPi();
		usageExtension(mock.pi, {
			settingsRuntime: memory.settingsRuntime,
			codexModelCatalog: catalog(),
		});
		const model = { ...codexModel, id };
		const choices = ["Turn Fast mode on", "Close"];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			model,
			select: async (_title: string, options: string[]) => {
				const choice = choices.shift();
				assert.ok(choice && options.includes(choice));
				return choice;
			},
			modelRegistry: registry(model),
		});
		await mock.commands.get("usage")?.handler("", ctx);
		assert.deepEqual(memory.patches, [{ codexFastMode: true }]);
	});
}

test("invalid settings make the /usage Fast action visibly read-only", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const memory = runtime("invalid");
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: memory.settingsRuntime,
		codexModelCatalog: catalog(),
	});
	let rendered = "";
	let options: string[] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string, values: string[]) => {
			rendered = title;
			options = values;
			return "Close";
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.match(rendered, /Fast mode: Off/);
	assert.ok(options.includes("Turn Fast mode on"));
	assert.deepEqual(memory.patches, []);
});

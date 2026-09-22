import assert from "node:assert/strict";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { correctCodexFastMessageCost } from "../src/codex-fast.js";
import { registerCodexFastMode } from "../src/codex-fast-runtime.js";
import type { CodexFastCapability } from "../src/codex-models.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "../src/settings.js";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

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
const unsupported: CodexFastCapability = { kind: "unsupported", reason: "No priority tier" };
const unknown: CodexFastCapability = { kind: "unknown", reason: "Model catalog offline" };
const usage = {
	input: 100,
	output: 20,
	cacheRead: 10,
	cacheWrite: 0,
	totalTokens: 130,
	cost: { input: 0.00025, output: 0.0003, cacheRead: 0.0000025, cacheWrite: 0, total: 0.0005525 },
};
const assistantMessage = (model = codexModel) => ({
	role: "assistant",
	provider: model.provider,
	model: model.id,
	usage: structuredClone(usage),
});

function memoryRuntime(
	options: {
		kind?: UsageSettingsState["kind"];
		enabled?: boolean;
		failUpdates?: number;
		reload?: () => Promise<UsageSettingsState>;
	} = {},
) {
	let state: UsageSettingsState = {
		kind: options.kind ?? "loaded",
		path: "/tmp/pi-usage.json",
		settings: {
			codexFastMode: options.enabled ?? false,
			codexStatusResetCountdown: false,
			selectedTargets: {},
		},
		...(options.kind === "invalid" ? { issue: "bad file" } : { document: {} }),
	};
	let failUpdates = options.failUpdates ?? 0;
	let flushes = 0;
	const patches: unknown[] = [];
	const runtime: UsageSettingsRuntime = {
		get: () => structuredClone(state),
		async reload() {
			if (options.reload) state = await options.reload();
			return structuredClone(state);
		},
		async update(patch, signal) {
			signal?.throwIfAborted();
			patches.push(patch);
			if (failUpdates > 0) {
				failUpdates -= 1;
				throw new Error("disk full");
			}
			state = {
				...state,
				kind: "loaded",
				settings: { ...state.settings, ...patch },
				document: { ...state.document, ...patch },
			};
			return structuredClone(state);
		},
		async updateSelectedTarget() {
			throw new Error("target selection is not used in Codex Fast tests");
		},
		async flush() {
			flushes += 1;
		},
	};
	return {
		runtime,
		patches,
		get state() {
			return state;
		},
		get flushes() {
			return flushes;
		},
	};
}

function context(overrides: Record<string, unknown> = {}) {
	return createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		sessionManager: {
			getSessionId: () => "session-a",
			getBranch: () => [],
			getEntries: () => [],
		},
		...overrides,
	});
}

type Catalog = NonNullable<Parameters<typeof registerCodexFastMode>[3]>["catalog"];
function memoryCatalog(capability: CodexFastCapability = supported) {
	let calls = 0;
	let clears = 0;
	return {
		async resolve(_ctx: unknown, signal: AbortSignal): Promise<CodexFastCapability> {
			signal.throwIfAborted();
			calls += 1;
			return capability;
		},
		clear() {
			clears += 1;
		},
		get calls() {
			return calls;
		},
		get clears() {
			return clears;
		},
	};
}

function setup(
	options: Parameters<typeof memoryRuntime>[0] = {},
	catalog: Catalog = memoryCatalog(),
) {
	const memory = memoryRuntime(options);
	const mock = createMockPi();
	const publications: unknown[] = [];
	const fast = registerCodexFastMode(
		mock.pi,
		memory.runtime,
		(ctx) => {
			publications.push(fast.state(ctx.model));
		},
		{ catalog },
	);
	const command = mock.commands.get("fast");
	const hook = mock.events.get("before_provider_request")?.[0];
	const messageEnd = mock.events.get("message_end")?.[0];
	assert.ok(command);
	assert.ok(hook);
	assert.ok(messageEnd);
	return { memory, mock, fast, publications, command, hook, messageEnd };
}

test("/fast toggles one persistent setting with catalog-based usage guidance", async () => {
	const catalog = memoryCatalog();
	const { memory, fast, command } = setup({}, catalog);
	const current = context();
	await command.handler("", current.ctx);
	assert.equal(memory.state.settings.codexFastMode, true);
	assert.deepEqual(fast.state(current.ctx.model), { enabled: true, effective: true });
	assert.match(current.notifications[0]?.message ?? "", /may use more plan allowance/);
	assert.match(current.notifications[0]?.message ?? "", /estimates/);
	assert.doesNotMatch(current.notifications[0]?.message ?? "", /1\.5/);
	assert.equal(catalog.calls, 1);
	await command.handler("", current.ctx);
	assert.equal(memory.state.settings.codexFastMode, false);
	assert.match(current.notifications[1]?.message ?? "", /standard routing/);
	assert.equal(catalog.calls, 1, "disabling does not resolve the catalog");
});

test("new and arbitrary account models can enable Fast", async () => {
	for (const id of ["gpt-6-astra", "new-account-model"]) {
		const { command, memory, hook, messageEnd } = setup();
		const model = { ...codexModel, id };
		const current = context({ model });
		await command.handler("", current.ctx);
		assert.deepEqual(memory.patches, [{ codexFastMode: true }]);
		assert.deepEqual(await hook({ payload: { model: id } }, current.ctx), {
			model: id,
			service_tier: "priority",
		});
		const message = assistantMessage(model);
		assert.equal(await messageEnd({ message }, current.ctx), undefined);
		assert.deepEqual(message.usage, usage, "unknown tariffs retain SDK amounts");
	}
});

test("/fast rejects arguments and unsafe modes before mutation", async () => {
	const { memory, command } = setup();
	const rpc = context();
	await command.handler("on", rpc.ctx);
	assert.match(rpc.notifications[0]?.message ?? "", /does not accept arguments/);
	await assert.rejects(
		Promise.resolve(command.handler("", context({ hasUI: false, mode: "print" }).ctx)),
		/requires TUI or RPC/,
	);
	await assert.rejects(
		Promise.resolve(command.handler("on", context({ hasUI: false, mode: "json" }).ctx)),
		/does not accept arguments/,
	);
	assert.deepEqual(memory.patches, []);
});

test("/fast rejects foreign and custom-origin models without resolving metadata", async () => {
	for (const model of [
		{ ...codexModel, provider: "openrouter" },
		{ ...codexModel, api: "openai-responses" },
		{ ...codexModel, baseUrl: "https://proxy.example.test" },
	]) {
		const catalog = memoryCatalog();
		const { memory, command } = setup({}, catalog);
		const current = context({ model });
		await command.handler("", current.ctx);
		assert.deepEqual(memory.patches, []);
		assert.equal(catalog.calls, 0);
		assert.equal(current.notifications[0]?.level, "warning");
	}
});

test("unknown, offline, and unsupported catalogs forbid enabling without saving", async () => {
	for (const capability of [unknown, unsupported]) {
		const { memory, fast, command } = setup({}, memoryCatalog(capability));
		const current = context();
		await command.handler("", current.ctx);
		assert.deepEqual(memory.patches, []);
		assert.deepEqual(fast.state(current.ctx.model), { enabled: false, effective: false });
		assert.equal(current.notifications[0]?.message, capability.reason);
	}
	const { memory, command } = setup(
		{},
		{
			async resolve() {
				throw new Error("offline");
			},
			clear() {},
		},
	);
	const current = context();
	await command.handler("", current.ctx);
	assert.deepEqual(memory.patches, []);
	assert.match(current.notifications[0]?.message ?? "", /offline/);
});

test("invalid settings cannot mutate or request the catalog", async () => {
	const catalog = memoryCatalog();
	const { memory, command } = setup({ kind: "invalid" }, catalog);
	const current = context();
	await command.handler("", current.ctx);
	assert.deepEqual(memory.patches, []);
	assert.equal(catalog.calls, 0);
	assert.equal(current.notifications[0]?.level, "error");
});

test("failed persistence rolls back effective state and permits retry", async () => {
	const { memory, fast, command } = setup({ failUpdates: 1 });
	const current = context();
	await command.handler("", current.ctx);
	assert.equal(memory.state.settings.codexFastMode, false);
	assert.equal(fast.state(current.ctx.model).effective, false);
	assert.match(current.notifications[0]?.message ?? "", /disk full/);
	await command.handler("", current.ctx);
	assert.equal(memory.state.settings.codexFastMode, true);
});

test("saved Fast can be disabled offline and on an unsupported model without catalog GET", async () => {
	const { command, hook, memory } = setup(
		{ enabled: true },
		{
			async resolve() {
				assert.fail("disabling must not load the catalog");
			},
			clear() {},
		},
	);
	const current = context({ model: { ...codexModel, id: "unsupported-model" } });
	await command.handler("", current.ctx);
	assert.deepEqual(memory.patches, [{ codexFastMode: false }]);
	assert.deepEqual(await hook({ payload: { model: "unsupported-model" } }, current.ctx), {
		model: "unsupported-model",
		service_tier: "default",
	});
});

test("provider payload captures the toggle state when its hook begins", async () => {
	const { command, hook } = setup();
	const current = context();
	const before = await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
	await command.handler("", current.ctx);
	const after = await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
	assert.deepEqual(before, { model: "gpt-5.4", service_tier: "default" });
	assert.deepEqual(after, { model: "gpt-5.4", service_tier: "priority" });
});

test("an in-flight catalog lookup retains the hook's saved flag across a concurrent disable", async () => {
	const lookup = deferred<CodexFastCapability>();
	const { command, hook, messageEnd } = setup(
		{ enabled: true },
		{
			resolve: () => lookup.promise,
			clear() {},
		},
	);
	const current = context();
	const pending = hook({ payload: { model: "gpt-5.4" } }, current.ctx);
	await command.handler("", current.ctx);
	lookup.resolve(supported);
	assert.deepEqual(await pending, { model: "gpt-5.4", service_tier: "priority" });
	const correction = (await messageEnd({ message: assistantMessage() }, current.ctx)) as {
		message: { usage: typeof usage };
	};
	assert.equal(correction.message.usage.cost.total, usage.cost.total * 2);
});

test("cost correction follows the captured request tier and consumes the marker once", async () => {
	const { command, hook, messageEnd } = setup();
	const current = context();
	await command.handler("", current.ctx);
	await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
	await command.handler("", current.ctx);
	const event = { message: assistantMessage() };
	const correction = (await messageEnd(event, current.ctx)) as { message: { usage: typeof usage } };
	assert.equal(correction.message.usage.cost.total, usage.cost.total * 2);
	assert.equal(await messageEnd(event, current.ctx), undefined);
});

test("an already-correct cost still consumes its request marker", async () => {
	const { hook, messageEnd } = setup({ enabled: true });
	const current = context();
	await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
	const alreadyCorrect = correctCodexFastMessageCost(
		assistantMessage(),
		codexModel as never,
		true,
	) as { usage: typeof usage };
	assert.ok(alreadyCorrect);
	const event = { message: alreadyCorrect };
	assert.equal(await messageEnd(event, current.ctx), undefined);
	alreadyCorrect.usage.cost.total = 0;
	assert.equal(await messageEnd(event, current.ctx), undefined);
});

test("unverified enabled requests abort instead of leaking the original payload or a cost marker", async () => {
	for (const failure of [unknown, unsupported, new Error("offline")]) {
		let capability: CodexFastCapability | Error = supported;
		const { hook, messageEnd, fast } = setup(
			{ enabled: true },
			{
				async resolve() {
					if (capability instanceof Error) throw capability;
					return capability;
				},
				clear() {},
			},
		);
		let aborts = 0;
		const current = context({
			abort: async () => {
				aborts += 1;
			},
		});
		await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
		capability = failure;
		await assert.rejects(
			Promise.resolve(hook({ payload: { model: "gpt-5.4" } }, current.ctx)),
			/Cannot request Codex Fast|offline/,
		);
		assert.equal(aborts, 1);
		assert.deepEqual(fast.state(current.ctx.model), { enabled: true, effective: false });
		assert.equal(await messageEnd({ message: assistantMessage() }, current.ctx), undefined);
	}
});

test("a model switch during lookup aborts the owning run even though its model key changed", async () => {
	const lookup = deferred<CodexFastCapability>();
	const { hook } = setup({ enabled: true }, { resolve: () => lookup.promise, clear() {} });
	const controller = new AbortController();
	const current = context({
		signal: controller.signal,
		abort: async () => {
			controller.abort();
		},
	});
	const pending = hook({ payload: { model: "gpt-5.4" } }, current.ctx);
	Object.assign(current.ctx, { model: { ...codexModel, id: "gpt-6-astra" } });
	lookup.resolve(supported);
	await assert.rejects(Promise.resolve(pending), { name: "AbortError" });
	assert.equal(controller.signal.aborted, true);
});

test("the real SDK runner swallows the hook error but abort prevents inference fetch", async (t) => {
	const controller = new AbortController();
	const { mock, messageEnd } = setup({ enabled: true }, memoryCatalog(unknown));
	const current = context({
		signal: controller.signal,
		abort: async () => {
			controller.abort();
		},
	});
	const errors: Array<{ event: string; error: string }> = [];
	const runner = {
		extensions: [{ path: "pi-usage", handlers: mock.events }],
		createContext: () => current.ctx,
		emitError(error: { event: string; error: string }) {
			errors.push(error);
		},
	};
	let fetches = 0;
	const noNetwork = async () => {
		fetches += 1;
		throw new Error("Inference fetch must not run");
	};
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = noNetwork;
	const token = `unused.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
		}),
	).toString("base64url")}.unused`;
	let returnedOriginal = false;
	let abortedAfterHook = false;
	const stream = streamCodex(
		codexModel as never,
		{
			messages: [{ role: "user", content: "Test only; never sent", timestamp: 0 }],
		},
		{
			apiKey: token,
			transport: "sse",
			signal: controller.signal,
			fetch: noNetwork,
			onPayload: async (payload) => {
				const rewritten = await ExtensionRunner.prototype.emitBeforeProviderRequest.call(
					runner as never,
					payload,
				);
				returnedOriginal = rewritten === payload;
				abortedAfterHook = controller.signal.aborted;
				return rewritten;
			},
		},
	);
	const result = await stream.result();
	assert.equal(errors.length, 1);
	assert.equal(errors[0]?.event, "before_provider_request");
	assert.match(errors[0]?.error ?? "", /Cannot request Codex Fast/);
	assert.equal(returnedOriginal, true, "SDK swallows the hook error and returns the old payload");
	assert.equal(abortedAfterHook, true, "abort is effective before the SDK resumes transport");
	assert.equal(result.stopReason, "aborted");
	assert.equal(fetches, 0);
	assert.equal(await messageEnd({ message: assistantMessage() }, current.ctx), undefined);
});

test("shutdown discards the completed request's pending cost marker", async () => {
	const { mock, hook, messageEnd } = setup({ enabled: true });
	const current = context();
	await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
	await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
	assert.equal(await messageEnd({ message: assistantMessage() }, current.ctx), undefined);
});

test("foreign payload models never resolve metadata or create a cost marker", async () => {
	const catalog = memoryCatalog();
	const { hook, messageEnd } = setup({ enabled: true }, catalog);
	const current = context();
	assert.equal(await hook({ payload: { model: "another-model" } }, current.ctx), undefined);
	assert.equal(catalog.calls, 0);
	assert.equal(await messageEnd({ message: assistantMessage() }, current.ctx), undefined);
});

test("refresh distinguishes the saved preference from current verified support", async () => {
	const { fast, publications } = setup({ enabled: true });
	const current = context();
	assert.equal(fast.availability(current.ctx.model).kind, "unknown");
	assert.deepEqual(fast.state(current.ctx.model), { enabled: true, effective: false });
	await fast.refresh(current.ctx);
	assert.deepEqual(publications, [{ enabled: true, effective: true }]);
	assert.equal(fast.availability(current.ctx.model).kind, "available");
});

test("session reload warns and publishes without GET; shutdown clears catalog and flushes", async () => {
	const catalog = memoryCatalog();
	const { memory, mock, publications } = setup({ kind: "invalid" }, catalog);
	const current = context();
	await mock.events.get("session_start")?.[0]?.({}, current.ctx);
	assert.match(current.notifications[0]?.message ?? "", /Invalid pi-usage\.json/);
	assert.equal(publications.length, 1);
	assert.equal(catalog.calls, 0);
	assert.equal(catalog.clears, 1);
	await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
	assert.equal(memory.flushes, 1);
	assert.equal(catalog.clears, 2);
});

test("session replacement aborts stale settings loads before UI publication", async () => {
	const load = deferred<UsageSettingsState>();
	const { memory, mock, publications } = setup({ reload: () => load.promise });
	const current = context();
	const pending = mock.events.get("session_start")?.[0]?.({}, current.ctx);
	await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
	load.resolve(memory.state);
	await pending;
	assert.deepEqual(publications, []);
	assert.deepEqual(current.notifications, []);
});

for (const change of ["auth", "model", "session", "shutdown", "caller cancellation"] as const) {
	test(`stale ${change} catalog results cannot enable, save, or publish Fast`, async () => {
		const lookup = deferred<CodexFastCapability>();
		let signal: AbortSignal | undefined;
		const { memory, mock, fast, publications } = setup(
			{},
			{
				resolve(_ctx, requestSignal) {
					signal = requestSignal;
					return lookup.promise;
				},
				clear() {},
			},
		);
		const controller = new AbortController();
		let sessionId = "session-a";
		const current = context({
			sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
		});
		const pending = fast.toggle(current.ctx, true, controller.signal);
		assert.ok(signal);
		if (change === "auth") lookup.reject(new DOMException("Current account changed", "AbortError"));
		if (change === "model")
			Object.assign(current.ctx, { model: { ...codexModel, id: "gpt-6-astra" } });
		if (change === "session") sessionId = "session-b";
		if (change === "shutdown") await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
		if (change === "caller cancellation") controller.abort();
		lookup.resolve(supported);
		assert.equal(await pending, false);
		assert.deepEqual(memory.patches, []);
		assert.deepEqual(publications, []);
		assert.deepEqual(current.notifications, []);
		assert.equal(fast.state(current.ctx.model).effective, false);
	});
}

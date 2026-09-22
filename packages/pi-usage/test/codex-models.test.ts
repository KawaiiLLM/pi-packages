import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCodexModelCatalog, parseCodexModelCatalog } from "../src/codex-models.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../src/oauth-credential-source.js";
import { fetchProviderJson } from "../src/query.js";
import type { ResolvedUsageAuth } from "../src/types.js";

const priority = { id: "priority", name: "Fast", description: "Faster responses." };
const standard = { id: "default", name: "Standard", description: "Standard responses." };
const codexModel = {
	id: "astra",
	name: "Astra",
	api: "openai-codex-responses" as const,
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};
const fetchStub = vi.fn<typeof fetch>();

beforeEach(() => {
	fetchStub.mockReset();
	fetchStub.mockRejectedValue(new Error("Unexpected stub fetch"));
	vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function token(accountId: string): string {
	return `header.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url")}.signature`;
}

function fixture(options: { cacheTtlMs?: number; timeoutMs?: number } = {}) {
	const mock = createMockPi();
	const state = {
		account: "account-private-a",
		storedAccount: undefined as string | undefined,
		model: { ...codexModel },
		sessionId: "session-a",
		version: "0.153.4",
		providerBaseUrl: undefined as string | undefined,
		modelAuthBaseUrl: undefined as string | undefined,
		providerAuthBaseUrl: undefined as string | undefined,
	};
	const credential = () => ({
		type: "oauth",
		access: token(state.storedAccount ?? state.account),
		refresh: "refresh-private-value",
		expires: Date.now() + 60_000,
		accountId: state.storedAccount ?? state.account,
	});
	const registry = {
		getProvider: () => ({ baseUrl: state.providerBaseUrl }),
		getApiKeyAndHeaders: vi.fn(async () => ({
			ok: true as const,
			apiKey: token(state.account),
			baseUrl: state.modelAuthBaseUrl,
		})),
		getProviderAuth: vi.fn(async () => ({
			auth: { apiKey: token(state.account), baseUrl: state.providerAuthBaseUrl },
		})),
		getAvailable: () => [state.model],
		getAll: () => [state.model],
	};
	const { ctx } = createMockContext({
		model: state.model,
		sessionManager: { getSessionId: () => state.sessionId },
		modelRegistry: registry,
	});
	Object.defineProperty(ctx, "model", { get: () => state.model, configurable: true });
	const catalog = createCodexModelCatalog(mock.pi, {
		clientVersion: () => state.version,
		credentialReader: credential,
		...options,
	});
	return {
		...mock,
		state,
		ctx,
		registry,
		credential,
		catalog,
		resolve: (signal = new AbortController().signal, force = false) =>
			catalog.resolve(ctx, signal, force),
		event: async (name: string) => {
			for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
		},
	};
}

function response(models: unknown[] = [{ slug: "astra", service_tiers: [priority] }]): Response {
	return new Response(JSON.stringify({ models }));
}

function deferredValue<T>() {
	let complete: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		complete = resolve;
	});
	return { promise, resolve: (value: T) => complete(value) };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function parse(fields: Record<string, unknown>) {
	return parseCodexModelCatalog({ models: [{ slug: "astra", ...fields }] }).get("astra");
}

describe("structured Codex model catalog contract", () => {
	test("Astra and arbitrary new slugs need only the structured priority tier", () => {
		const models = parseCodexModelCatalog({
			models: [
				{ slug: "astra", service_tiers: [standard, priority], prompt: "DO NOT RETAIN" },
				{ slug: "unannounced-2040-anything", service_tiers: [priority] },
			],
		});
		expect([...models.keys()]).toEqual(["astra", "unannounced-2040-anything"]);
		for (const capability of models.values()) {
			expect(capability).toEqual({
				kind: "supported",
				tier: "priority",
				description: priority.description,
			});
			expect(Object.isFrozen(capability)).toBe(true);
		}
		expect(JSON.stringify([...models])).not.toContain("DO NOT RETAIN");
	});

	test("empty structured tiers explicitly mean unsupported, independent of model names and prose", () => {
		expect(parse({ service_tiers: [] })?.kind).toBe("unsupported");
		expect(
			parse({ service_tiers: [{ ...standard, description: "priority Fast 2x cheaper" }] })?.kind,
		).toBe("unsupported");
		expect(parse({ service_tiers: [{ ...priority, id: "fast" }] })?.kind).toBe("unsupported");
		expect(parse({ service_tiers: [{ ...priority, id: "Priority" }] })?.kind).toBe("unsupported");
	});

	test("legacy fast never confirms a requestable tier and contradictions stay unknown", () => {
		for (const fields of [
			{ additional_speed_tiers: ["fast"] },
			{ additional_speed_tiers: ["fast"], service_tiers: [] },
			{ additional_speed_tiers: ["fast"], service_tiers: [standard] },
		]) {
			expect(parse(fields)).toMatchObject({
				kind: "unknown",
				reason: expect.stringMatching(/legacy.*confirm/iu),
			});
		}
		expect(parse({ additional_speed_tiers: ["fast"], service_tiers: [priority] })?.kind).toBe(
			"supported",
		);
	});

	test.each([
		{},
		{ service_tiers: null },
		{ service_tiers: {} },
		{ service_tiers: "priority" },
		{ service_tiers: [null] },
		{ service_tiers: ["priority"] },
		{ service_tiers: [{ id: "priority" }] },
		{ service_tiers: [{ id: "priority", name: "Fast", description: null }] },
		{ service_tiers: [{ id: null, name: "Fast", description: "Fast" }] },
		{ service_tiers: [priority, priority] },
		{ service_tiers: [priority, null] },
		{ service_tiers: [priority], additional_speed_tiers: null },
		{ service_tiers: [priority], additional_speed_tiers: [null] },
		{ service_tiers: [priority], additional_speed_tiers: {} },
	])("incomplete or malformed tier metadata fails closed: %j", (fields) => {
		expect(parse(fields)?.kind).toBe("unknown");
	});

	test.each([
		null,
		[],
		{},
		{ models: null },
		{ models: {} },
		{ models: [] },
		{ models: [null, {}, { slug: 4 }] },
	])("invalid or empty envelopes cannot invent model capabilities: %j", (payload) => {
		expect(parseCodexModelCatalog(payload).size).toBe(0);
	});

	test("duplicate slugs are ambiguous and display text is bounded without pricing inference", () => {
		expect(
			parseCodexModelCatalog({
				models: [
					{ slug: "astra", service_tiers: [priority] },
					{ slug: "astra", service_tiers: [] },
				],
			}).get("astra")?.kind,
		).toBe("unknown");
		const capability = parse({
			service_tiers: [{ ...priority, description: `\u001b[31mFast\n${"x".repeat(5000)}` }],
		});
		expect(capability).toMatchObject({
			kind: "supported",
			description: expect.stringMatching(/^Fast x/u),
		});
		if (capability?.kind !== "supported") throw new Error("Expected supported");
		expect(capability.description.length).toBeLessThanOrEqual(160);
		expect(Object.keys(capability).sort()).toEqual(["description", "kind", "tier"]);
	});
});

describe("account-bound offline catalog queries", () => {
	test("uses the exact versioned official GET, OAuth account headers and redirect refusal", async () => {
		const f = fixture();
		fetchStub.mockResolvedValueOnce(response());
		expect((await f.resolve()).kind).toBe("supported");
		expect(fetchStub).toHaveBeenCalledTimes(1);
		const request = fetchStub.mock.calls[0];
		if (!request) throw new Error("Expected a catalog request");
		const [url, init] = request;
		expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.153.4");
		expect(init).toMatchObject({ method: "GET", redirect: "error" });
		expect(init?.body).toBeUndefined();
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${token(f.state.account)}`);
		expect(headers.get("chatgpt-account-id")).toBe(f.state.account);
	});

	test("uses the credential-source reader for the exact current OAuth match", async () => {
		const f = fixture();
		const offered = f.credential();
		f.state.storedAccount = "different-default-account";
		f.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (request) => {
			(request as { offer(value: unknown): void }).offer(offered);
		});
		fetchStub.mockResolvedValueOnce(response());
		expect((await f.resolve()).kind).toBe("supported");
	});

	test("mismatched OAuth refuses networking and invalidates a previous account cache", async () => {
		const f = fixture();
		fetchStub.mockImplementation(async () => response());
		await f.resolve();
		f.state.storedAccount = "wrong-account";
		expect((await f.resolve()).kind).toBe("unknown");
		expect(fetchStub).toHaveBeenCalledTimes(1);
		f.state.storedAccount = undefined;
		await f.resolve();
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	test.each(["providerBaseUrl", "modelAuthBaseUrl", "providerAuthBaseUrl"] as const)(
		"%s proxy override blocks both fresh fetch and cached capabilities",
		async (field) => {
			const f = fixture();
			fetchStub.mockResolvedValueOnce(response());
			await f.resolve();
			f.state[field] = "https://proxy.invalid/private-credential";
			const capability = await f.resolve();
			expect(capability.kind).toBe("unknown");
			expect(JSON.stringify(capability)).not.toContain("private-credential");
			expect(fetchStub).toHaveBeenCalledTimes(1);
		},
	);

	test.each([
		{ provider: "openai" },
		{ baseUrl: "https://proxy.invalid/backend-api" },
		{ baseUrl: "https://chatgpt.com.evil.invalid" },
		{ baseUrl: "http://chatgpt.com" },
		{ baseUrl: "not-a-url" },
		{ api: "openai-responses" },
	])("nonofficial current models never fetch: %j", async (override) => {
		const f = fixture();
		Object.assign(f.state.model, override);
		expect((await f.resolve()).kind).toBe("unknown");
		expect(fetchStub).not.toHaveBeenCalled();
	});

	test.each([
		"",
		"0.153",
		"v0.153.4",
		"0.153.04",
		"0.153.4?token=secret",
		"0.153.4-01",
		"0.153.4-rc.1",
		"0.153.4+test",
	])("invalid injected client version %j never makes an unversioned request", async (version) => {
		const f = fixture();
		f.state.version = version;
		expect(await f.resolve()).toMatchObject({
			kind: "unknown",
			reason: expect.stringContaining("clientVersion"),
		});
		expect(fetchStub).not.toHaveBeenCalled();
	});

	test("cache contains the whole directory, is authenticated on every hit and expires at five minutes", async () => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const f = fixture();
		fetchStub.mockImplementation(async () =>
			response([
				{ slug: "astra", service_tiers: [priority] },
				{ slug: "new-slug", service_tiers: [] },
			]),
		);
		await f.resolve();
		const authReads = f.registry.getProviderAuth.mock.calls.length;
		now += 299_999;
		expect((await f.resolve()).kind).toBe("supported");
		expect(f.registry.getProviderAuth.mock.calls.length).toBeGreaterThan(authReads);
		f.state.model = { ...f.state.model, id: "new-slug" };
		await f.event("model_select");
		expect((await f.resolve()).kind).toBe("unsupported");
		expect(fetchStub).toHaveBeenCalledTimes(1);
		now += 1;
		await f.resolve();
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	test("custom TTL, force refresh and clientVersion all control cache reuse", async () => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const f = fixture({ cacheTtlMs: 100 });
		fetchStub.mockImplementation(async () => response());
		await f.resolve();
		now += 100;
		await f.resolve();
		await f.resolve(undefined, true);
		f.state.version = "0.153.5";
		await f.resolve();
		expect(fetchStub).toHaveBeenCalledTimes(4);
		expect(String(fetchStub.mock.calls[3]?.[0])).toContain("client_version=0.153.5");
	});

	test.each([false, true])(
		"failed refresh never reuses an old capability (force=%s)",
		async (force) => {
			let now = 1000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const f = fixture({ cacheTtlMs: 100 });
			fetchStub
				.mockResolvedValueOnce(response())
				.mockResolvedValueOnce(new Response("private error", { status: 503 }))
				.mockResolvedValueOnce(response([{ slug: "astra", service_tiers: [] }]));
			await f.resolve();
			if (!force) now += 100;
			expect((await f.resolve(undefined, force)).kind).toBe("unknown");
			expect((await f.resolve()).kind).toBe("unsupported");
			expect(fetchStub).toHaveBeenCalledTimes(3);
		},
	);

	test("rotating accounts drops the old directory, including when switching back", async () => {
		const f = fixture();
		fetchStub
			.mockResolvedValueOnce(response())
			.mockResolvedValueOnce(response([{ slug: "astra", service_tiers: [] }]))
			.mockResolvedValueOnce(response());
		expect((await f.resolve()).kind).toBe("supported");
		f.state.account = "account-private-b";
		expect((await f.resolve()).kind).toBe("unsupported");
		f.state.account = "account-private-a";
		expect((await f.resolve()).kind).toBe("supported");
		expect(fetchStub).toHaveBeenCalledTimes(3);
	});

	test("missing model or missing directory fields yields explicit unknown", async () => {
		const f = fixture();
		for (const payload of [{ models: [] }, {}, { models: null }, { models: [{ slug: "other" }] }]) {
			fetchStub.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
			expect(await f.resolve(undefined, true)).toMatchObject({
				kind: "unknown",
				reason: expect.any(String),
			});
		}
	});

	test("returned capabilities cannot mutate the cache and echoed auth is redacted before truncation", async () => {
		const f = fixture();
		fetchStub.mockResolvedValueOnce(
			response([
				{
					slug: "astra",
					service_tiers: [
						{ ...priority, description: `${token(f.state.account)} ${f.state.account} Fast` },
					],
				},
			]),
		);
		const capability = await f.resolve();
		expect(capability).toMatchObject({
			kind: "supported",
			description: "<redacted> <redacted> Fast",
		});
		if (capability.kind === "supported") capability.description = "mutated";
		expect(await f.resolve()).toMatchObject({ description: "<redacted> <redacted> Fast" });
	});
});

describe("catalog cancellation and stale query isolation", () => {
	test("concurrent resolves share one GET; aborting one subscriber leaves the other alive", async () => {
		const f = fixture();
		const deferred = deferredValue<Response>();
		fetchStub.mockReturnValueOnce(deferred.promise);
		const controller = new AbortController();
		const first = f.resolve(controller.signal);
		const second = f.resolve();
		await flush();
		expect(fetchStub).toHaveBeenCalledTimes(1);
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchStub.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
		deferred.resolve(response());
		expect((await second).kind).toBe("supported");
		await f.resolve();
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});

	test("cancelling the last subscriber stops its GET and cannot cache a late response", async () => {
		const f = fixture();
		const deferred = deferredValue<Response>();
		fetchStub.mockReturnValueOnce(deferred.promise).mockImplementationOnce(async () => response());
		const controller = new AbortController();
		const first = f.resolve(controller.signal);
		await flush();
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchStub.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		deferred.resolve(response([{ slug: "astra", service_tiers: [] }]));
		await flush();
		expect((await f.resolve()).kind).toBe("supported");
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	test.each(["clear", "session_start", "model_select", "session_shutdown"])(
		"%s aborts shared work and prevents late publication",
		async (event) => {
			const f = fixture();
			const deferred = deferredValue<Response>();
			fetchStub
				.mockReturnValueOnce(deferred.promise)
				.mockImplementationOnce(async () => response());
			const first = f.resolve();
			const second = f.resolve();
			await flush();
			const assertions = [first, second].map((query) =>
				expect(query).rejects.toMatchObject({ name: "AbortError" }),
			);
			if (event === "clear") f.catalog.clear();
			else await f.event(event);
			await Promise.all(assertions);
			expect(fetchStub.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			deferred.resolve(response([{ slug: "astra", service_tiers: [] }]));
			await flush();
			if (event === "session_shutdown") {
				await expect(f.resolve()).rejects.toMatchObject({ name: "AbortError" });
				expect(fetchStub).toHaveBeenCalledTimes(1);
			} else {
				expect((await f.resolve()).kind).toBe("supported");
				expect(fetchStub).toHaveBeenCalledTimes(2);
			}
		},
	);

	test.each(["session", "model"])(
		"detects a changed %s even without a lifecycle event",
		async (change) => {
			const f = fixture();
			const deferred = deferredValue<Response>();
			fetchStub.mockReturnValueOnce(deferred.promise);
			const query = f.resolve();
			await flush();
			if (change === "session") f.state.sessionId = "session-b";
			else f.state.model = { ...f.state.model, id: "new-model" };
			deferred.resolve(response());
			await expect(query).rejects.toMatchObject({ name: "AbortError" });
		},
	);

	test("rotation while fetching rejects the old result even without a second resolve", async () => {
		const f = fixture();
		const deferred = deferredValue<Response>();
		fetchStub
			.mockReturnValueOnce(deferred.promise)
			.mockImplementationOnce(async () => response([{ slug: "astra", service_tiers: [] }]));
		const query = f.resolve();
		await flush();
		f.state.account = "account-private-b";
		deferred.resolve(response());
		await expect(query).rejects.toMatchObject({ name: "AbortError" });
		expect((await f.resolve()).kind).toBe("unsupported");
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	test("a new account query cancels the old GET instead of joining it", async () => {
		const f = fixture();
		const deferred = deferredValue<Response>();
		fetchStub
			.mockReturnValueOnce(deferred.promise)
			.mockImplementationOnce(async () => response([{ slug: "astra", service_tiers: [] }]));
		const old = f.resolve();
		await flush();
		const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
		f.state.account = "account-private-b";
		expect((await f.resolve()).kind).toBe("unsupported");
		await rejected;
		deferred.resolve(response());
		await flush();
		expect((await f.resolve()).kind).toBe("unsupported");
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	test("clear during slow authentication prevents even the initial GET", async () => {
		const f = fixture();
		const deferred = deferredValue<Awaited<ReturnType<typeof f.registry.getProviderAuth>>>();
		f.registry.getProviderAuth.mockReturnValueOnce(deferred.promise);
		const query = f.resolve();
		await flush();
		f.catalog.clear();
		await expect(query).rejects.toMatchObject({ name: "AbortError" });
		deferred.resolve({ auth: { apiKey: token(f.state.account), baseUrl: undefined } });
		await flush();
		expect(fetchStub).not.toHaveBeenCalled();
	});

	test("a slow old auth result cannot replace a more recently observed account", async () => {
		const f = fixture();
		const oldCredential = f.credential();
		f.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (request) => {
			(request as { offer(value: unknown): void }).offer(oldCredential);
		});
		const deferred = deferredValue<Awaited<ReturnType<typeof f.registry.getApiKeyAndHeaders>>>();
		f.registry.getApiKeyAndHeaders.mockReturnValueOnce(deferred.promise);
		fetchStub.mockImplementation(async () => response([{ slug: "astra", service_tiers: [] }]));
		const old = f.resolve();
		await flush();
		f.state.account = "account-private-b";
		expect((await f.resolve()).kind).toBe("unsupported");
		deferred.resolve({ ok: true, apiKey: oldCredential.access, baseUrl: undefined });
		await expect(old).rejects.toMatchObject({ name: "AbortError" });
		expect((await f.resolve()).kind).toBe("unsupported");
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});

	test("pre-aborted signals never authenticate or fetch", async () => {
		const f = fixture();
		await expect(f.resolve(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(f.registry.getProviderAuth).not.toHaveBeenCalled();
		expect(fetchStub).not.toHaveBeenCalled();
	});

	test("the default 15-second deadline bounds even a fetch stub that ignores abort", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const deferred = deferredValue<Response>();
		fetchStub.mockReturnValueOnce(deferred.promise);
		const query = f.resolve();
		await flush();
		await vi.advanceTimersByTimeAsync(14_999);
		expect(fetchStub.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await query).toMatchObject({
			kind: "unknown",
			reason: expect.stringMatching(/timed out/iu),
		});
		expect(fetchStub.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		deferred.resolve(response());
		await flush();
	});
});

describe("transport limits, explicit failures and redaction", () => {
	test("accepts catalogs larger than usage's 64 KiB, up to exactly 2 MiB", async () => {
		const f = fixture();
		const base = JSON.stringify({
			models: [{ slug: "astra", service_tiers: [priority] }],
			prompt: "",
		});
		const exact = base.replace(
			'"prompt":""',
			`"prompt":"${"x".repeat(2 * 1024 * 1024 - Buffer.byteLength(base))}"`,
		);
		expect(Buffer.byteLength(exact)).toBe(2 * 1024 * 1024);
		fetchStub.mockResolvedValueOnce(new Response(exact));
		expect((await f.resolve()).kind).toBe("supported");
	});

	test("rejects more than 2 MiB measured as UTF-8 bytes and does not cache the failure", async () => {
		const f = fixture();
		fetchStub
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						models: [{ slug: "astra", service_tiers: [priority] }],
						prompt: "界".repeat(700_000),
					}),
				),
			)
			.mockResolvedValueOnce(response());
		expect(await f.resolve()).toMatchObject({
			kind: "unknown",
			reason: expect.stringContaining("2 MiB"),
		});
		expect((await f.resolve()).kind).toBe("supported");
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	test("ordinary usage stays at 64 KiB and error responses stay bounded at 4 KiB", async () => {
		const auth: ResolvedUsageAuth = {
			apiKey: "stub-key",
			headers: { Authorization: "Bearer stub-key" },
			fingerprint: "stub-fingerprint",
			secrets: ["stub-key"],
			model: codexModel as NonNullable<ExtensionContext["model"]>,
		};
		fetchStub.mockResolvedValueOnce(
			new Response(JSON.stringify({ prompt: "x".repeat(64 * 1024) })),
		);
		await expect(
			fetchProviderJson(
				"https://offline.invalid",
				auth,
				new AbortController().signal,
				1000,
				"Usage",
			),
		).rejects.toThrow("exceeded 65536 bytes");
		let pulls = 0;
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls += 1;
					controller.enqueue(new Uint8Array(2048).fill(120));
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		fetchStub.mockResolvedValueOnce(new Response(body, { status: 503 }));
		await expect(
			fetchProviderJson(
				"https://offline.invalid",
				auth,
				new AbortController().signal,
				1000,
				"Usage",
				{ maxResponseBytes: 2 * 1024 * 1024 },
			),
		).rejects.toThrow("503");
		expect(pulls).toBe(3);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	test("redirected responses are refused even when a stub ignores redirect:error", async () => {
		const f = fixture();
		const redirected = response();
		Object.defineProperty(redirected, "redirected", { value: true });
		fetchStub.mockResolvedValueOnce(redirected);
		expect(await f.resolve()).toMatchObject({
			kind: "unknown",
			reason: expect.stringContaining("redirected"),
		});
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});

	test("3xx, HTTP errors, malformed JSON and fetch errors never leak credentials or provider bodies", async () => {
		const f = fixture();
		const sensitive = `${token(f.state.account)} ${f.state.account} refresh-private-value secret-prompt`;
		for (const status of [302, 401, 403, 500]) {
			fetchStub.mockResolvedValueOnce(new Response(sensitive, { status, statusText: sensitive }));
			expect(await f.resolve()).toEqual({
				kind: "unknown",
				reason: `Codex model catalog endpoint returned HTTP ${status}.`,
			});
		}
		for (const body of [sensitive, "null", "[]"]) {
			fetchStub.mockResolvedValueOnce(new Response(body));
			expect(await f.resolve()).toEqual({
				kind: "unknown",
				reason: "Codex model catalog returned malformed JSON metadata.",
			});
		}
		fetchStub.mockRejectedValueOnce(new Error(sensitive));
		expect(await f.resolve()).toEqual({
			kind: "unknown",
			reason: "Codex model catalog request failed; metadata is unavailable.",
		});
		fetchStub.mockResolvedValueOnce(response());
		expect((await f.resolve()).kind).toBe("supported");
	});

	test("auth errors never echo secrets when resolved-auth redaction inputs are unavailable", async () => {
		const f = fixture();
		f.registry.getProviderAuth.mockRejectedValueOnce(
			new Error("refresh-private-value secret-prompt"),
		);
		const result = await f.resolve();
		expect(result.kind).toBe("unknown");
		expect(JSON.stringify(result)).not.toMatch(/refresh-private-value|secret-prompt/u);
		expect(fetchStub).not.toHaveBeenCalled();
	});
});

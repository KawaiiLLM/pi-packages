import { describe, expect, test } from "bun:test";
import type { ResponsesRuntime } from "../runtime";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "../types";
import { _clientTest, requestGeneratedImage } from "./client";
import { buildImageGenerationRequest, normalizeGenerateImageParams } from "./protocol";
import { completedImageResponse, VALID_PNG_BASE64 } from "./test-helpers";
import { MAX_IMAGE_DIAGNOSTIC_CHARS, MAX_IMAGE_ERROR_BYTES, MAX_IMAGE_RESPONSE_BYTES } from "./types";

function runtime(overrides: Partial<ResponsesRuntime> = {}): ResponsesRuntime {
	return {
		provider: "newapi",
		api: "openai-responses",
		model: "gpt-5.5",
		baseUrl: "https://gateway.example/v1",
		apiKey: "sk-secret",
		headers: { "x-auth-header": "resolved" },
		responsesPath: "responses",
		responsesUrl: "https://gateway.example/v1/responses",
		currentModel: {
			provider: "newapi",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: "https://gateway.example/v1",
			headers: { "x-model-header": "model", "x-remove": "old" },
		} as never,
		...overrides,
	};
}

function codexToken(accountId: string): string {
	return [
		Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
		Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			}),
		).toString("base64url"),
		"signature",
	].join(".");
}

function body() {
	return buildImageGenerationRequest({
		api: "openai-responses",
		routingModel: "gpt-5.5",
		imageModel: DEFAULT_IMAGE_GENERATION_MODEL,
		params: normalizeGenerateImageParams({ prompt: "draw a cat" }),
		references: [],
	});
}

describe("image generation client", () => {
	test("preserves provider headers and only adds bearer auth when absent", () => {
		const headers = _clientTest.buildRequestHeaders(
			runtime({
				headers: {
					"X-Model-Header": "resolved-override",
					"x-remove": null,
					Authorization: "Custom auth",
				},
			}),
			false,
		);
		expect(headers.get("x-model-header")).toBe("resolved-override");
		expect(headers.has("x-remove")).toBe(false);
		expect(headers.get("authorization")).toBe("Custom auth");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("accept")).toBe("application/json");

		const bearer = _clientTest.buildRequestHeaders(runtime(), false);
		expect(bearer.get("authorization")).toBe("Bearer sk-secret");
	});

	test("adds the established Codex Responses headers for a current Codex model", () => {
		const token = codexToken("acct_image");
		const headers = _clientTest.buildRequestHeaders(
			runtime({
				api: "openai-codex-responses",
				apiKey: token,
				responsesPath: "codex/responses",
				responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
				currentModel: {
					provider: "openai-codex",
					api: "openai-codex-responses",
					id: "gpt-5.5",
					baseUrl: "https://chatgpt.com/backend-api",
				} as never,
			}),
			true,
		);
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("chatgpt-account-id")).toBe("acct_image");
		expect(headers.get("originator")).toBe("pi");
		expect(headers.get("openai-beta")).toBe("responses=experimental");
		expect(headers.get("user-agent")).toContain("pi (");
	});

	test("sends one non-streaming request and parses the completed image", async () => {
		let calls = 0;
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async (input, init) => {
				calls += 1;
				capturedUrl = String(input);
				capturedInit = init;
				return new Response(JSON.stringify(completedImageResponse()), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});

		expect(result.ok).toBe(true);
		expect(calls).toBe(1);
		expect(capturedUrl).toBe("https://gateway.example/v1/responses");
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual(body());
	});

	test.each([false, true])("accepts chunked Codex SSE after completion (terminal output omitted: %s)", async (omitTerminalImage) => {
		const completed = completedImageResponse({ output: [{
			type: "image_generation_call", id: "ig_test", status: "completed",
			result: VALID_PNG_BASE64, revised_prompt: "蓝色圆形",
		}] });
		const text = [
			": keepalive\r\n\r\n",
			`event: response.created\r\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_image_test" } })}\r\n\r\n`,
			`data: ${JSON.stringify({ type: "response.image_generation_call.partial_image", partial_image_b64: "not-the-final-image" })}\r\n\r\n`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: (completed.output as unknown[])[0] })}\r\n\r\n`,
			`event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: omitTerminalImage ? { ...completed, output: [] } : completed })}\r\n\r\n`,
			"data: [DONE]\r\n\r\n",
		].join("");
		const bytes = new TextEncoder().encode(text);
		let calls = 0;
		const result = await requestGeneratedImage({
			runtime: runtime({ api: "openai-codex-responses" }),
			body: { ...body(), stream: true },
			fetchFn: async (_url, init) => {
				calls += 1;
				expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
				expect(JSON.parse(String(init?.body)).stream).toBe(true);
				let offset = 0;
				return new Response(new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset === bytes.length) return controller.close();
						controller.enqueue(bytes.slice(offset, offset + 7));
						offset = Math.min(offset + 7, bytes.length);
					},
				}), { headers: { "content-type": "text/event-stream" } });
			},
		});
		expect(calls).toBe(1);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errorMessage);
		expect(result.image.bytes.toString("base64")).toBe(VALID_PNG_BASE64);
		expect(result.image.revisedPrompt).toBe("蓝色圆形");
		expect(result.image.responseId).toBe("resp_image_test");
	});

	test("accepts the Codex response.done terminal event with a completed envelope", async () => {
		const result = await requestGeneratedImage({
			runtime: runtime({ api: "openai-codex-responses" }),
			body: { ...body(), stream: true },
			fetchFn: async () => new Response(`data: ${JSON.stringify({ type: "response.done", response: completedImageResponse() })}\n\n`),
		});
		expect(result.ok).toBe(true);
	});

	test("keeps PNG, response status and response-size validation for SSE", async () => {
		for (const [response, reason] of [
			[completedImageResponse({ output: [] }), "no-image"],
			[completedImageResponse({ status: "failed" }), "request-rejected"],
			[completedImageResponse({ output: [{ type: "image_generation_call", status: "completed", result: "not-png" }] }), "malformed-response"],
		] as const) {
			const result = await requestGeneratedImage({
				runtime: runtime({ api: "openai-codex-responses" }),
				body: { ...body(), stream: true },
				fetchFn: async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`),
			});
			expect(result).toMatchObject({ ok: false, reason });
		}
		const oversized = await requestGeneratedImage({
			runtime: runtime({ api: "openai-codex-responses" }),
			body: { ...body(), stream: true },
			fetchFn: async () => new Response("data: {}\n\n", {
				headers: { "content-length": String(MAX_IMAGE_RESPONSE_BYTES + 1) },
			}),
		});
		expect(oversized).toMatchObject({ ok: false, reason: "oversized-response" });
	});

	test.each(["error", "response.failed", "response.incomplete"])("reports sanitized SSE %s failures, never a partial image", async (type) => {
		const failure = { detail: "image generation refused: sk-private12345678" };
		const event = type === "error" ? { type, ...failure } : { type, response: failure };
		const result = await requestGeneratedImage({
			runtime: runtime({ api: "openai-codex-responses" }),
			body: { ...body(), stream: true },
			fetchFn: async () => new Response(`data: ${JSON.stringify(event)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			}),
		});
		expect(result).toEqual({
			ok: false, reason: "request-rejected", status: 200,
			errorMessage: "image generation refused: [REDACTED]",
		});
	});

	test("rejects truncated, malformed, duplicate and out-of-order SSE completions", async () => {
		const completed = `data: ${JSON.stringify({ type: "response.completed", response: completedImageResponse() })}\n\n`;
		const item = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: VALID_PNG_BASE64 } })}\n\n`;
		for (const text of [
			"", "data: {broken}\n\n", item, "data: [DONE]\n\n",
			completed + completed, "data: [DONE]\n\n" + completed, completed + item,
		]) {
			const result = await requestGeneratedImage({
				runtime: runtime({ api: "openai-codex-responses" }),
				body: { ...body(), stream: true },
				fetchFn: async () => new Response(text, { headers: { "content-type": "text/event-stream" } }),
			});
			expect(result).toMatchObject({ ok: false, reason: "malformed-response", status: 200 });
		}
	});

	test("still reports JSON HTTP rejections when requesting a stream", async () => {
		const result = await requestGeneratedImage({
			runtime: runtime({ api: "openai-codex-responses" }),
			body: { ...body(), stream: true },
			fetchFn: async () => new Response(JSON.stringify({ detail: "image tool not supported" }), { status: 400 }),
		});
		expect(result).toEqual({
			ok: false, reason: "request-rejected", status: 400,
			errorMessage: "HTTP 400: image tool not supported",
		});
	});

	test.each(["cancel", "timeout"])("retains %s during SSE body reading and never retries", async (mode) => {
		const controller = new AbortController();
		let calls = 0;
		const result = await requestGeneratedImage({
			runtime: runtime({ api: "openai-codex-responses" }),
			body: { ...body(), stream: true },
			signal: controller.signal,
			timeoutMs: mode === "timeout" ? 10 : 1000,
			fetchFn: async (_url, init) => {
				calls += 1;
				return new Response(new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(new TextEncoder().encode(": pending\n\n"));
						init!.signal!.addEventListener("abort", () => stream.error(init!.signal!.reason), { once: true });
						if (mode === "cancel") queueMicrotask(() => controller.abort());
					},
				}));
			},
		});
		expect(result).toMatchObject({ ok: false, reason: mode === "cancel" ? "aborted" : "timeout" });
		expect(calls).toBe(1);
	});

	test("maps rate limits without exposing raw bodies and never retries", async () => {
		let calls = 0;
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () => {
				calls += 1;
				return new Response(
					JSON.stringify({ error: { message: "quota exhausted\nAuthorization: secret" } }),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			},
		});

		expect(result).toEqual({
			ok: false,
			reason: "rate-limit",
			status: 429,
			errorMessage: "HTTP 429: quota exhausted Authorization: [REDACTED]",
		});
		expect(calls).toBe(1);
	});

	test("recognizes provider usage-limit errors even when returned as HTTP 400", async () => {
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "usage_limit_reached",
							message: "Monthly image usage limit reached.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		});
		expect(result).toEqual({
			ok: false,
			reason: "rate-limit",
			status: 400,
			errorMessage: "HTTP 400: Monthly image usage limit reached.",
		});
	});

	test.each([
		[{ detail: "Instructions are required" }, "Instructions are required"],
		[{ error: { detail: "stream must be true" } }, "stream must be true"],
		[{ error: "image model is unsupported" }, "image model is unsupported"],
		["invalid image tool", "invalid image tool"],
	])("reports bounded JSON rejection details with HTTP status: %j", async (payload, diagnostic) => {
		let calls = 0;
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () => {
				calls += 1;
				return new Response(JSON.stringify(payload), { status: 400 });
			},
		});
		expect(result).toEqual({
			ok: false,
			reason: "request-rejected",
			status: 400,
			errorMessage: `HTTP 400: ${diagnostic}`,
		});
		expect(calls).toBe(1);
	});

	test.each([
		[400, "Instructions are required", "request-rejected"],
		[502, "<html><body>upstream unavailable</body></html>", "backend-unavailable"],
		[429, "quota exhausted", "rate-limit"],
	])("preserves non-JSON HTTP %i errors without misclassifying them as malformed responses", async (status, text, reason) => {
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () => new Response(text, { status }),
		});
		expect(result).toEqual({ ok: false, reason, status, errorMessage: `HTTP ${status}: ${text}` });
	});

	test("recognizes quota errors in detail and keeps a useful fallback for empty errors", async () => {
		for (const payload of [JSON.stringify({ detail: "image quota exhausted" }), "quota exhausted"]) {
			const result = await requestGeneratedImage({
				runtime: runtime(), body: body(),
				fetchFn: async () => new Response(payload, { status: 400 }),
			});
			expect(result).toMatchObject({ ok: false, reason: "rate-limit", status: 400 });
		}
		for (const payload of ["", "{}", JSON.stringify({ detail: " " })]) {
			const result = await requestGeneratedImage({
				runtime: runtime(), body: body(),
				fetchFn: async () => new Response(payload, { status: 400 }),
			});
			expect(result).toEqual({
				ok: false, reason: "request-rejected", status: 400,
				errorMessage: "Image generation request was rejected (HTTP 400).",
			});
		}
	});

	test("redacts and bounds newly exposed text before displaying it", async () => {
		const token = codexToken("acct_private");
		const responseText = `stream must be true\n{\"access_token\":\"private-access-value\",\"cookie\":\"session=private-cookie; csrf=private-csrf\"}\nBearer ${token}\ndata:image/png;base64,${"A".repeat(256)}\n${"diagnostic ".repeat(1000)}`;
		for (const payload of [responseText, JSON.stringify({ detail: responseText })]) {
			const result = await requestGeneratedImage({
				runtime: runtime(), body: body(),
				fetchFn: async () => new Response(payload, { status: 400 }),
			});
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected an HTTP error");
			expect(result.errorMessage).toStartWith("HTTP 400: stream must be true");
			expect(result.errorMessage.length).toBeLessThanOrEqual(MAX_IMAGE_DIAGNOSTIC_CHARS);
			for (const secret of ["private-access-value", "private-cookie", "private-csrf", token, "A".repeat(128)]) {
				expect(result.errorMessage).not.toContain(secret);
			}
			expect(result.errorMessage).not.toMatch(/[\r\n]/);
		}
	});

	test("keeps invalid successful JSON and oversized error bodies as explicit failures", async () => {
		const malformed = await requestGeneratedImage({
			runtime: runtime(), body: body(),
			fetchFn: async () => new Response("not JSON", { status: 200 }),
		});
		expect(malformed).toEqual({
			ok: false, reason: "malformed-response", status: 200,
			errorMessage: "Image generation returned invalid JSON.",
		});
		const oversized = await requestGeneratedImage({
			runtime: runtime(), body: body(),
			fetchFn: async () => new Response("x".repeat(MAX_IMAGE_ERROR_BYTES + 1), { status: 400 }),
		});
		expect(oversized).toMatchObject({ ok: false, reason: "oversized-response", status: 400 });
	});

	test("fails closed on oversized response bodies", async () => {
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-length": String(49 * 1024 * 1024) },
				}),
		});
		expect(result).toEqual(
			expect.objectContaining({ ok: false, reason: "oversized-response", status: 200 }),
		);
	});

	test("preserves caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			signal: controller.signal,
			fetchFn: async () => {
				throw new DOMException("aborted", "AbortError");
			},
		});
		expect(result).toEqual({
			ok: false,
			reason: "aborted",
			errorMessage: "Image generation was cancelled.",
		});
	});
});

import { describe, expect, test } from "bun:test";
import {
	buildImageGenerationRequest,
	decodeGeneratedPng,
	detectReferenceImageMimeType,
	extractProviderErrorMessage,
	normalizeGenerateImageParams,
	parseImageGenerationResponse,
	parseImageGenerationStream,
	readPngDimensions,
	selectImageGenerationModel,
} from "./protocol";
import {
	completedImageResponse,
	imageDetails,
	VALID_PNG_BASE64,
	validJpeg,
	validPng,
	validWebp,
} from "./test-helpers";
import {
	ImageGenerationError,
	isImageGenerationDetails,
	MAX_IMAGE_DIAGNOSTIC_CHARS,
	sanitizeImageDiagnostic,
} from "./types";

describe("image generation protocol", () => {
	test("normalizes the small tool interface and infers generate/edit", () => {
		expect(normalizeGenerateImageParams({ prompt: " draw a cat " })).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: [" a.png "],
				outputPath: " result.png ",
				size: "1024x1536",
				quality: "high",
			}),
		).toEqual({
			prompt: "edit",
			referenceImagePaths: ["a.png"],
			outputPath: "result.png",
			size: "1024x1536",
			quality: "high",
			action: "edit",
		});
		expect(() => normalizeGenerateImageParams({ prompt: " " })).toThrow();
		expect(() =>
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: ["1", "2", "3", "4", "5", "6"],
			}),
		).toThrow();
	});

	test("treats null, empty, and blank optional paths as absent", () => {
		expect(
			normalizeGenerateImageParams({
				prompt: "draw a cat",
				referenceImagePaths: null,
				outputPath: null,
			}),
		).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "draw a cat",
				referenceImagePaths: [],
				outputPath: " \t ",
			}),
		).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "draw a cat",
				referenceImagePaths: ["", " \t "],
				outputPath: "",
			}),
		).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: ["", " ", " first.png ", "\t", "second.webp"],
			}),
		).toEqual({
			prompt: "edit",
			referenceImagePaths: ["first.png", "second.webp"],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "edit",
		});
	});

	test("preserves arbitrary sentinel strings as paths and rejects non-string values", () => {
		expect(
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: [" omit ", "none", "null"],
				outputPath: " omit ",
			}),
		).toEqual({
			prompt: "edit",
			referenceImagePaths: ["omit", "none", "null"],
			outputPath: "omit",
			size: "auto",
			quality: "auto",
			action: "edit",
		});
		expect(() =>
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: [null] as unknown as string[],
			}),
		).toThrow("referenceImagePaths must contain only path strings.");
		expect(() =>
			normalizeGenerateImageParams({
				prompt: "draw",
				outputPath: 42 as unknown as string,
			}),
		).toThrow("outputPath must be a path string or null.");
	});

	test("normalizes the optional model argument and rejects malformed values", () => {
		expect(normalizeGenerateImageParams({ prompt: "draw", model: " grok-imagine-image-2.0 " }).model).toBe(
			"grok-imagine-image-2.0",
		);
		expect(normalizeGenerateImageParams({ prompt: "draw", model: null }).model).toBeUndefined();
		expect(normalizeGenerateImageParams({ prompt: "draw", model: " \t " }).model).toBeUndefined();
		expect(normalizeGenerateImageParams({ prompt: "draw" }).model).toBeUndefined();
		expect(() =>
			normalizeGenerateImageParams({ prompt: "draw", model: 42 as unknown as string }),
		).toThrow("model must be a model id string or null.");
		expect(() =>
			normalizeGenerateImageParams({ prompt: "draw", model: "x".repeat(257) }),
		).toThrow("model must be at most 256 characters when provided.");
	});

	test("selects the configured default or an explicitly configured image model", () => {
		expect(selectImageGenerationModel({ configuredModels: ["gpt-image-2"] })).toBe("gpt-image-2");
		expect(selectImageGenerationModel({})).toBe("gpt-image-2.5");
		expect(selectImageGenerationModel({ configuredModels: undefined })).toBe("gpt-image-2.5");
		expect(selectImageGenerationModel({ configuredModels: [] })).toBe("gpt-image-2.5");
		// Configuration order expresses the default, so the first usable entry wins.
		expect(
			selectImageGenerationModel({ configuredModels: ["grok-imagine-image-2.0", "gpt-image-2"] }),
		).toBe("grok-imagine-image-2.0");
		expect(
			selectImageGenerationModel({
				requestedModel: " gpt-image-2 ",
				configuredModels: ["grok-imagine-image-2.0", "gpt-image-2"],
			}),
		).toBe("gpt-image-2");
		// Whitespace and duplicates never become selectable models.
		expect(
			selectImageGenerationModel({
				requestedModel: "grok-imagine-image-2.0",
				configuredModels: [" ", "grok-imagine-image-2.0", "grok-imagine-image-2.0"],
			}),
		).toBe("grok-imagine-image-2.0");
		expect(selectImageGenerationModel({ configuredModels: [" \t "] })).toBe("gpt-image-2.5");
	});

	test("rejects an unconfigured image model before it can be selected", () => {
		expect(() =>
			selectImageGenerationModel({
				requestedModel: "grok-imagine-image-2.0",
				configuredModels: ["gpt-image-2"],
			}),
		).toThrow(
			'Unknown image generation model "grok-imagine-image-2.0". Configure it in imageGeneration.models first; available models: gpt-image-2.',
		);
		// Matching is exact: prefixes, casing, and provider prefixes are not aliases.
		expect(() =>
			selectImageGenerationModel({ requestedModel: "gpt-image", configuredModels: ["gpt-image-2"] }),
		).toThrow(ImageGenerationError);
		expect(() =>
			selectImageGenerationModel({
				requestedModel: "openai/gpt-image-2",
				configuredModels: ["gpt-image-2"],
			}),
		).toThrow(ImageGenerationError);

		const configuredModels = Array.from({ length: 10 }, (_, index) => `image-model-${index}`);
		let error: unknown;
		try {
			selectImageGenerationModel({ requestedModel: "missing", configuredModels });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ImageGenerationError);
		expect((error as Error).message).toContain("image-model-0");
		expect((error as Error).message).toContain("and 5 more");
		expect((error as Error).message).not.toContain("image-model-9");
		expect((error as Error).message.length).toBeLessThan(2_000);
	});

	test("builds an isolated one-turn non-streaming request with the selected image model", () => {
		const params = normalizeGenerateImageParams({
			prompt: "Turn this into a watercolor",
			referenceImagePaths: ["reference.png"],
			size: "1536x1024",
			quality: "medium",
		});
		const body = buildImageGenerationRequest({
			api: "openai-responses",
			routingModel: "gpt-5.5",
			imageModel: "grok-imagine-image-2.0",
			params,
			references: [{ path: "reference.png", mimeType: "image/png", bytes: validPng() }],
		});

		expect(body).toEqual({
			model: "gpt-5.5",
			store: false,
			stream: false,
			parallel_tool_calls: false,
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "Turn this into a watercolor" },
						{
							type: "input_image",
							image_url: `data:image/png;base64,${VALID_PNG_BASE64}`,
							detail: "auto",
						},
					],
				},
			],
			tools: [
				{
					type: "image_generation",
					model: "grok-imagine-image-2.0",
					action: "edit",
					size: "1536x1024",
					quality: "medium",
					output_format: "png",
				},
			],
			tool_choice: { type: "image_generation" },
		});
		expect(body).not.toHaveProperty("max_tool_calls");
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0]?.type).toBe("image_generation");
		expect(body.tool_choice).toEqual({ type: "image_generation" });
		expect(body.parallel_tool_calls).toBe(false);
		expect(body).not.toHaveProperty("instructions");
		expect(body).not.toHaveProperty("prompt_cache_key");
		expect(body).not.toHaveProperty("include");
		expect(body).not.toHaveProperty("reasoning");
		expect(body).not.toHaveProperty("previous_response_id");
	});

	test("requests streaming for the Codex API without changing the isolated image-tool contract", () => {
		const request = buildImageGenerationRequest({
			api: "openai-codex-responses",
			routingModel: "gpt-5.5",
			imageModel: "gpt-image-2",
			params: normalizeGenerateImageParams({ prompt: "draw a cat" }),
			references: [],
		});
		expect(request.stream).toBe(true);
		expect(request.store).toBe(false);
		expect(request.parallel_tool_calls).toBe(false);
		expect(request.tool_choice).toEqual({ type: "image_generation" });
		expect(request.input).toHaveLength(1);
	});

	test("keeps the routing model and the nested image model independent and rejects an empty image model", () => {
		const params = normalizeGenerateImageParams({ prompt: "draw a cat" });
		const build = (imageModel: string) =>
			buildImageGenerationRequest({
				api: "openai-responses",
				routingModel: "gpt-5.5",
				imageModel,
				params,
				references: [],
			});

		expect(build("gpt-image-2").model).toBe("gpt-5.5");
		expect(build("gpt-image-2").tools[0]?.model).toBe("gpt-image-2");
		expect(build("grok-imagine-image-2.0").tools[0]?.model).toBe("grok-imagine-image-2.0");
		expect(() => build(" ")).toThrow("A configured image generation model is required.");
		expect(() => build("x".repeat(257))).toThrow("A configured image generation model is required.");
	});

	test("parses exactly one completed image call and validates PNG metadata", () => {
		const parsed = parseImageGenerationResponse(completedImageResponse());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.image.imageCallId).toBe("ig_test");
		expect(parsed.image.responseId).toBe("resp_image_test");
		expect(parsed.image.revisedPrompt).toBe("A revised prompt");
		expect(parsed.image.bytes).toEqual(validPng());
		expect({ width: parsed.image.width, height: parsed.image.height }).toEqual({ width: 1, height: 1 });
	});

	test("deduplicates the same terminal item id but rejects conflicting or multiple images", () => {
		const duplicate = completedImageResponse();
		duplicate.output = [
			...(duplicate.output as unknown[]),
			...(duplicate.output as unknown[]),
		];
		expect(parseImageGenerationResponse(duplicate).ok).toBe(true);

		const conflicting = completedImageResponse();
		conflicting.output = [
			...(conflicting.output as unknown[]),
			{
				type: "image_generation_call",
				id: "ig_test",
				status: "completed",
				result: validPng().subarray(0, 24).toString("base64"),
			},
		];
		expect(parseImageGenerationResponse(conflicting)).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);

		const multiple = completedImageResponse();
		multiple.output = [
			...(multiple.output as unknown[]),
			{
				type: "image_generation_call",
				id: "ig_second",
				status: "completed",
				result: VALID_PNG_BASE64,
			},
		];
		expect(parseImageGenerationResponse(multiple)).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
	});

	test("rejects failed, missing, malformed base64, and non-PNG responses", () => {
		expect(parseImageGenerationResponse({ status: "failed", error: { message: "moderated" } })).toEqual({
			ok: false,
			reason: "request-rejected",
			errorMessage: "moderated",
		});
		expect(parseImageGenerationResponse({ status: "completed", output: [] })).toEqual(
			expect.objectContaining({ ok: false, reason: "no-image" }),
		);
		expect(decodeGeneratedPng("not-base64")).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
		expect(decodeGeneratedPng(Buffer.from("not a png").toString("base64"))).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
	});

	test("distinguishes empty output, text-only output and failed image calls without exposing message bodies", () => {
		const cases = [
			{ output: [], expected: ['"outputCount":0', '"imageCallCount":0'] },
			{ output: [{ type: "message", status: "completed", content: [
				{ type: "output_text", text: "private message body" },
				{ type: "refusal", refusal: "private refusal body" },
			] }], expected: ['"type":"message"', '"output_text":1', '"refusal":1'] },
			{ output: [{ type: "image_generation_call", status: "failed", result: null,
				error: { message: "quota exhausted: sk-private12345678" },
			}], expected: ['"imageCallCount":1', '"status":"failed"', '"result":{"type":"null"}', "quota exhausted: [REDACTED]"] },
		];
		for (const { output, expected } of cases) {
			const result = parseImageGenerationResponse({ status: "completed", output });
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected no image");
			expect(result.reason).toBe("no-image");
			for (const part of expected) expect(result.errorMessage).toContain(part);
			expect(result.errorMessage).not.toContain("private");
		}
	});

	test("describes missing, empty and non-string image results without dumping their values", () => {
		for (const [fields, expected] of [
			[{}, '"result":{"type":"missing"}'],
			[{ result: "  " }, '"result":{"type":"string","chars":2,"nonBlank":false}'],
			[{ result: { url: "https://private.example/image" } }, '"result":{"type":"object"}'],
			[{ b64_json: [] }, '"b64_json":{"type":"array"}'],
		] as const) {
			const parsed = parseImageGenerationResponse({ status: "completed", output: [
				{ type: "image_generation_call", status: "completed", ...fields },
			] });
			if (parsed.ok) throw new Error("Expected no image");
			expect(parsed.errorMessage).toContain(expected);
			expect(parsed.errorMessage).not.toContain("private.example");
		}
	});

	test("reports failed image item-done evidence without promoting it to success", () => {
		const item = { ...(completedImageResponse().output as Record<string, unknown>[])[0], status: "failed" };
		const events = [
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "response.image_generation_call.partial_image", partial_image_b64: VALID_PNG_BASE64 },
			{ type: "response.output_item.done", item },
			{ type: "response.completed", response: { status: "completed", output: [] } },
		];
		const parsed = parseImageGenerationStream(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("Expected no image");
		expect(parsed.reason).toBe("no-image");
		expect(parsed.errorMessage).toContain('"terminalOutputCount":0');
		expect(parsed.errorMessage).toContain('"imageItemDoneCount":1');
		expect(parsed.errorMessage).toContain('"response.image_generation_call.partial_image":1');
		expect(parsed.errorMessage).toContain(`"chars":${VALID_PNG_BASE64.length}`);
		expect(parsed.errorMessage).not.toContain(VALID_PNG_BASE64);
	});

	test("bounds diagnostics and excludes arbitrary fields, metadata and text from SSE summaries", () => {
		const output = Array.from({ length: 40 }, () => ({
			type: "image_generation_call", status: "failed", result: VALID_PNG_BASE64,
			id: "private-id", revised_prompt: "private-prompt",
			error: { detail: `unsupported image tool; Bearer private-token ${"diagnostic ".repeat(500)}` },
		}));
		const events = [
			{ type: "private-event-name", secret: "private-field" },
			...output.map(item => ({ type: "response.output_item.done", item })),
			{ type: "response.done", response: { status: "completed", output } },
		];
		const parsed = parseImageGenerationStream(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
		if (parsed.ok) throw new Error("Expected no image");
		expect(parsed.errorMessage.length).toBeLessThanOrEqual(MAX_IMAGE_DIAGNOSTIC_CHARS);
		expect(parsed.errorMessage).toContain('"outputCount":40');
		expect(parsed.errorMessage).toContain('"imageItemDoneCount":40');
		expect(parsed.errorMessage).toContain("unsupported image tool");
		expect(parsed.errorMessage).not.toContain("private");
		expect(parsed.errorMessage).not.toContain(VALID_PNG_BASE64);
	});

	test("recognizes complete PNG, JPEG, and WebP references and rejects truncated headers", () => {
		expect(detectReferenceImageMimeType(validPng())).toBe("image/png");
		expect(detectReferenceImageMimeType(validJpeg())).toBe("image/jpeg");
		expect(detectReferenceImageMimeType(validWebp())).toBe("image/webp");
		expect(detectReferenceImageMimeType(validPng().subarray(0, 8))).toBeUndefined();
		expect(detectReferenceImageMimeType(validPng().subarray(0, 24))).toBeUndefined();
		expect(detectReferenceImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBeUndefined();
		expect(detectReferenceImageMimeType(Buffer.from("RIFFxxxxWEBP", "ascii"))).toBeUndefined();
		expect(detectReferenceImageMimeType(Buffer.from("text"))).toBeUndefined();
		expect(readPngDimensions(validPng())).toEqual({ width: 1, height: 1 });
	});

	test("redacts credentials before truncating provider details", () => {
		const prefix = "diagnostic ".repeat(360);
		const diagnostic = extractProviderErrorMessage({
			detail: `${prefix}{"access_token":"${"private-secret-".repeat(50)}"}`,
		}, "fallback");
		expect(diagnostic.length).toBeLessThanOrEqual(MAX_IMAGE_DIAGNOSTIC_CHARS);
		expect(diagnostic).toContain("[REDACTED]");
		expect(diagnostic).not.toContain("private-secret");
	});

	test("redacts complete auth and cookie header values in text errors", () => {
		const diagnostic = sanitizeImageDiagnostic(
			"stream must be true\nAuthorization: Custom private-auth\nSet-Cookie: session=private-session; csrf=private-csrf\nrequest rejected",
			"fallback",
		);
		expect(diagnostic).toContain("stream must be true");
		expect(diagnostic).toContain("request rejected");
		expect(diagnostic).not.toContain("private-");
	});

	test("bounds persisted details and redacts image data from diagnostics", () => {
		const details = imageDetails("/agent/generated-images/session/ig.png");
		expect(isImageGenerationDetails(details)).toBe(true);
		// A configured custom model is as valid in persisted details as the shipped default.
		expect(isImageGenerationDetails({ ...details, imageModel: "grok-imagine-image-2.0" })).toBe(true);
		expect(isImageGenerationDetails({ ...details, imageModel: "" })).toBe(false);
		expect(isImageGenerationDetails({ ...details, imageModel: "x".repeat(257) })).toBe(false);
		expect(isImageGenerationDetails({ ...details, imageModel: undefined })).toBe(false);
		expect(isImageGenerationDetails({ ...details, artifactPath: "x".repeat(4097) })).toBe(false);
		expect(isImageGenerationDetails({ ...details, imageCallId: "x".repeat(257) })).toBe(false);
		expect(isImageGenerationDetails({ ...details, imageModel: "   " })).toBe(false);
		expect(isImageGenerationDetails({ ...details, referenceCount: 6 })).toBe(false);

		const diagnostic = sanitizeImageDiagnostic(
			`failed data:image/png;base64,${VALID_PNG_BASE64.repeat(2)} account-id=acct_secret`,
			"fallback",
		);
		expect(diagnostic).toContain("[REDACTED_IMAGE_DATA]");
		expect(diagnostic).toContain("account-id: [REDACTED]");
		expect(diagnostic).not.toContain(VALID_PNG_BASE64);
		expect(diagnostic).not.toContain("acct_secret");
	});
});

import { isDeepStrictEqual } from "node:util";
import { parseSseEvents } from "../remote-v2-client";
import { DEFAULT_IMAGE_GENERATION_MODELS } from "../types";
import {
	IMAGE_GENERATION_MIME_TYPE,
	IMAGE_GENERATION_QUALITIES,
	IMAGE_GENERATION_SIZES,
	MAX_GENERATED_IMAGE_BYTES,
	MAX_IMAGE_DIAGNOSTIC_CHARS,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_IDENTIFIER_CHARS,
	MAX_IMAGE_MODEL_ID_CHARS,
	MAX_IMAGE_PATH_CHARS,
	MAX_IMAGE_PROMPT_CHARS,
	MAX_REFERENCE_IMAGE_COUNT,
	ImageGenerationError,
	sanitizeImageDiagnostic,
	type GenerateImageParams,
	type ImageGenerationCapableApi,
	type NormalizedGenerateImageParams,
	type ParsedGeneratedImage,
	type PreparedReferenceImage,
	type ReferenceImageMimeType,
} from "./types";

const MAX_DISPLAYED_IMAGE_MODELS_IN_ERROR = 5;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is;

export type ImageGenerationRequestBody = {
	model: string;
	store: false;
	stream: boolean;
	parallel_tool_calls: false;
	input: Array<{
		role: "user";
		content: Array<
			| { type: "input_text"; text: string }
			| { type: "input_image"; image_url: string; detail: "auto" }
		>;
	}>;
	tools: Array<{
		type: "image_generation";
		model: string;
		action: "generate" | "edit";
		size: NormalizedGenerateImageParams["size"];
		quality: NormalizedGenerateImageParams["quality"];
		output_format: "png";
	}>;
	tool_choice: { type: "image_generation" };
};

export type ParsedImageResponseResult =
	| { ok: true; image: ParsedGeneratedImage }
	| {
			ok: false;
			reason: "malformed-response" | "no-image" | "request-rejected" | "oversized-response";
			errorMessage: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizedOptionalString(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

function normalizePathList(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new ImageGenerationError(
			"invalid-parameters",
			"referenceImagePaths must be an array of path strings or null.",
		);
	}

	const normalized: string[] = [];
	for (const rawPath of value) {
		if (typeof rawPath !== "string") {
			throw new ImageGenerationError(
				"invalid-parameters",
				"referenceImagePaths must contain only path strings.",
			);
		}
		const trimmed = rawPath.trim();
		if (!trimmed) continue;
		if (trimmed.length > MAX_IMAGE_PATH_CHARS) {
			throw new ImageGenerationError(
				"invalid-parameters",
				`Each reference image path must be at most ${MAX_IMAGE_PATH_CHARS} characters.`,
			);
		}
		normalized.push(trimmed);
		if (normalized.length > MAX_REFERENCE_IMAGE_COUNT) {
			throw new ImageGenerationError(
				"invalid-parameters",
				`referenceImagePaths must contain at most ${MAX_REFERENCE_IMAGE_COUNT} paths.`,
			);
		}
	}
	return normalized;
}

function normalizeOutputPath(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ImageGenerationError(
			"invalid-parameters",
			"outputPath must be a path string or null.",
		);
	}
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > MAX_IMAGE_PATH_CHARS) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`outputPath must be at most ${MAX_IMAGE_PATH_CHARS} characters when provided.`,
		);
	}
	return trimmed;
}

function normalizeRequestedModel(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ImageGenerationError("invalid-parameters", "model must be a model id string or null.");
	}
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > MAX_IMAGE_MODEL_ID_CHARS) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`model must be at most ${MAX_IMAGE_MODEL_ID_CHARS} characters when provided.`,
		);
	}
	return trimmed;
}

/**
 * Configured model ids are only trusted as far as the shared bounds: unusable entries are
 * dropped, and an empty or malformed list falls back to the shipped default model.
 */
function usableImageModels(models: readonly string[] | undefined): string[] {
	const usable: string[] = [];
	for (const rawModel of Array.isArray(models) ? models : []) {
		if (typeof rawModel !== "string") continue;
		const trimmed = rawModel.trim();
		if (!trimmed || trimmed.length > MAX_IMAGE_MODEL_ID_CHARS) continue;
		if (!usable.includes(trimmed)) usable.push(trimmed);
	}
	return usable.length > 0 ? usable : [...DEFAULT_IMAGE_GENERATION_MODELS];
}

/**
 * Resolve the nested `image_generation` model for one call. An omitted request selects the
 * first configured model so configuration order expresses the default; an explicit request must
 * match a configured id exactly, and it fails here — before any paid dispatch.
 */
function formatAvailableImageModels(models: readonly string[]): string {
	const visible = models.slice(0, MAX_DISPLAYED_IMAGE_MODELS_IN_ERROR);
	const remaining = models.length - visible.length;
	return remaining > 0 ? `${visible.join(", ")}, … and ${remaining} more` : visible.join(", ");
}

export function selectImageGenerationModel(args: {
	requestedModel?: string;
	configuredModels?: readonly string[];
}): string {
	const models = usableImageModels(args.configuredModels);
	const requested = typeof args.requestedModel === "string" ? args.requestedModel.trim() : "";
	if (!requested) return models[0]!;
	if (models.includes(requested)) return requested;
	throw new ImageGenerationError(
		"invalid-parameters",
		`Unknown image generation model "${requested.slice(0, MAX_IMAGE_MODEL_ID_CHARS)}". ` +
			`Configure it in imageGeneration.models first; available models: ${formatAvailableImageModels(models)}.`,
	);
}

export function normalizeGenerateImageParams(
	params: GenerateImageParams,
): NormalizedGenerateImageParams {
	const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_IMAGE_PROMPT_CHARS) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`prompt must be 1-${MAX_IMAGE_PROMPT_CHARS} characters.`,
		);
	}

	const size = params.size ?? "auto";
	if (!(IMAGE_GENERATION_SIZES as readonly string[]).includes(size)) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`Unsupported image size: ${String(size)}.`,
		);
	}

	const quality = params.quality ?? "auto";
	if (!(IMAGE_GENERATION_QUALITIES as readonly string[]).includes(quality)) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`Unsupported image quality: ${String(quality)}.`,
		);
	}

	const referenceImagePaths = normalizePathList(params.referenceImagePaths);
	const outputPath = normalizeOutputPath(params.outputPath);

	return {
		prompt,
		referenceImagePaths,
		outputPath,
		size,
		quality,
		model: normalizeRequestedModel(params.model),
		action: referenceImagePaths.length > 0 ? "edit" : "generate",
	};
}

export function buildImageGenerationRequest(args: {
	api: ImageGenerationCapableApi;
	routingModel: string;
	imageModel: string;
	params: NormalizedGenerateImageParams;
	references: readonly PreparedReferenceImage[];
}): ImageGenerationRequestBody {
	const imageModel = typeof args.imageModel === "string" ? args.imageModel.trim() : "";
	if (!imageModel || imageModel.length > MAX_IMAGE_MODEL_ID_CHARS) {
		throw new ImageGenerationError(
			"invalid-parameters",
			"A configured image generation model is required.",
		);
	}
	const content: ImageGenerationRequestBody["input"][number]["content"] = [
		{ type: "input_text", text: args.params.prompt },
	];
	for (const reference of args.references) {
		content.push({
			type: "input_image",
			image_url: `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`,
			detail: "auto",
		});
	}

	return {
		model: args.routingModel,
		store: false,
		stream: args.api === "openai-codex-responses",
		parallel_tool_calls: false,
		input: [{ role: "user", content }],
		tools: [
			{
				type: "image_generation",
				model: imageModel,
				action: args.params.action,
				size: args.params.size,
				quality: args.params.quality,
				output_format: "png",
			},
		],
		tool_choice: { type: "image_generation" },
	};
}

function hasPngEndChunk(buffer: Buffer): boolean {
	return (
		buffer.length >= 33 &&
		buffer.readUInt32BE(buffer.length - 12) === 0 &&
		buffer.toString("ascii", buffer.length - 8, buffer.length - 4) === "IEND"
	);
}

export function detectReferenceImageMimeType(bytes: Uint8Array): ReferenceImageMimeType | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (readPngDimensions(buffer) && hasPngEndChunk(buffer)) return "image/png";
	if (
		buffer.length >= 4 &&
		buffer[0] === 0xff &&
		buffer[1] === 0xd8 &&
		buffer[2] === 0xff &&
		buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 3
	) {
		return "image/jpeg";
	}
	if (
		buffer.length >= 20 &&
		buffer.toString("ascii", 0, 4) === "RIFF" &&
		buffer.toString("ascii", 8, 12) === "WEBP"
	) {
		const declaredSize = buffer.readUInt32LE(4) + 8;
		const chunkType = buffer.toString("ascii", 12, 16);
		const chunkSize = buffer.readUInt32LE(16);
		const paddedChunkSize = chunkSize + (chunkSize % 2);
		if (
			declaredSize === buffer.length &&
			(chunkType === "VP8 " || chunkType === "VP8L" || chunkType === "VP8X") &&
			20 + paddedChunkSize <= buffer.length
		) {
			return "image/webp";
		}
	}
	return undefined;
}

export function isValidPng(bytes: Uint8Array): boolean {
	return bytes.byteLength >= PNG_SIGNATURE.length && Buffer.from(bytes).subarray(0, 8).equals(PNG_SIGNATURE);
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (!isValidPng(buffer) || buffer.length < 24) return undefined;
	if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	if (
		width <= 0 ||
		height <= 0 ||
		width > MAX_IMAGE_DIMENSION ||
		height > MAX_IMAGE_DIMENSION
	) return undefined;
	return { width, height };
}

function extractBase64(value: string): string {
	const trimmed = value.trim();
	const dataUrl = DATA_URL_PATTERN.exec(trimmed);
	return (dataUrl?.[1] ?? trimmed).trim();
}

export function decodeGeneratedPng(value: string):
	| { ok: true; bytes: Buffer; width: number; height: number }
	| { ok: false; reason: "malformed-response" | "oversized-response"; errorMessage: string } {
	const base64 = extractBase64(value);
	const maxBase64Chars = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;
	if (base64.length > maxBase64Chars) {
		return {
			ok: false,
			reason: "oversized-response",
			errorMessage: "Image generation returned an image larger than the 32 MiB limit.",
		};
	}
	if (!base64 || base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned invalid base64 image data.",
		};
	}

	const bytes = Buffer.from(base64, "base64");
	if (
		bytes.length === 0 ||
		bytes.length > MAX_GENERATED_IMAGE_BYTES ||
		bytes.toString("base64") !== base64
	) {
		bytes.fill(0);
		return {
			ok: false,
			reason: bytes.length > MAX_GENERATED_IMAGE_BYTES ? "oversized-response" : "malformed-response",
			errorMessage: "Image generation returned invalid or oversized image data.",
		};
	}
	const dimensions = readPngDimensions(bytes);
	if (!dimensions) {
		bytes.fill(0);
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned data that is not a valid PNG image.",
		};
	}
	return { ok: true, bytes, ...dimensions };
}

export function extractProviderErrorMessage(value: unknown, fallback: string): string {
	if (typeof value === "string") return sanitizeImageDiagnostic(value, fallback);
	if (!isRecord(value)) return fallback;
	const error = isRecord(value.error) ? value.error : undefined;
	for (const candidate of [value.message, error?.message, value.detail, error?.detail, value.error]) {
		if (typeof candidate === "string" && candidate.trim()) {
			// Redact the complete field before truncation, including credentials crossing the limit.
			return sanitizeImageDiagnostic(candidate, fallback);
		}
	}
	return fallback;
}

// Diagnostics describe shape only: never copy IDs, prompts, message bodies or image values.
// Unknown tags are not echoed because a malformed provider can put arbitrary data in them.
const IMAGE_DIAGNOSTIC_TAGS = new Set([
	"image_generation_call", "message", "reasoning", "function_call", "custom_tool_call",
	"web_search_call", "file_search_call", "code_interpreter_call", "refusal", "output_text",
	"in_progress", "generating", "completed", "failed", "incomplete", "queued", "cancelled",
	"response.created", "response.in_progress", "response.completed", "response.done",
	"response.output_item.added", "response.output_item.done",
	"response.content_part.added", "response.content_part.done",
	"response.output_text.delta", "response.output_text.done",
	"response.refusal.delta", "response.refusal.done",
	"response.image_generation_call.in_progress", "response.image_generation_call.generating",
	"response.image_generation_call.partial_image", "response.image_generation_call.completed",
	"keepalive",
]);
const MAX_DIAGNOSTIC_ITEMS = 3;
const MAX_DIAGNOSTIC_ERROR_CHARS = 240;

function diagnosticTag(value: unknown): string {
	if (value === undefined) return "missing";
	return typeof value === "string" && IMAGE_DIAGNOSTIC_TAGS.has(value) ? value : "other";
}

function resultShape(value: unknown): Record<string, unknown> {
	if (typeof value === "string") return { type: "string", chars: value.length, nonBlank: !!value.trim() };
	return { type: value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value };
}

function summarizeImageOutput(item: unknown): Record<string, unknown> {
	if (!isRecord(item)) return { type: "non-object" };
	const summary: Record<string, unknown> = { type: diagnosticTag(item.type), status: diagnosticTag(item.status) };
	if (item.type === "image_generation_call") {
		summary.result = resultShape(item.result);
		summary.b64_json = resultShape(item.b64_json);
		const error = extractProviderErrorMessage(item, "");
		if (error) summary.error = error.slice(0, MAX_DIAGNOSTIC_ERROR_CHARS);
	} else if (item.type === "message" && Array.isArray(item.content)) {
		const contentTypes: Record<string, number> = {};
		for (const part of item.content) {
			const type = diagnosticTag(isRecord(part) ? part.type : undefined);
			contentTypes[type] = (contentTypes[type] ?? 0) + 1;
		}
		summary.contentTypes = contentTypes;
	}
	return summary;
}

function diagnosticSummary(value: unknown): string {
	// Reserve room for both terminal-output and stream summaries in the existing error limit.
	const text = JSON.stringify(value);
	const limit = MAX_IMAGE_DIAGNOSTIC_CHARS / 2 - 128;
	return text.length > limit ? `${text.slice(0, limit)}… (truncated)` : text;
}

function imageResult(item: Record<string, unknown>): string | undefined {
	return typeof item.result === "string" ? item.result : typeof item.b64_json === "string" ? item.b64_json : undefined;
}

function mergeImageItems(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
): Record<string, unknown> | undefined {
	// Like checkpoint reconciliation, only missing fields may be supplemented. Never
	// choose one of two conflicting copies, including copies using different result aliases.
	for (const [key, value] of Object.entries(left)) {
		if (Object.hasOwn(right, key) && !isDeepStrictEqual(value, right[key])) return undefined;
	}
	const leftResult = imageResult(left);
	const rightResult = imageResult(right);
	if (leftResult !== undefined && rightResult !== undefined && leftResult !== rightResult) return undefined;
	return { ...left, ...right };
}

function isStreamIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_IMAGE_IDENTIFIER_CHARS;
}

export function parseImageGenerationStream(text: string): ParsedImageResponseResult {
	const events = parseSseEvents(text);
	if (!events) {
		return { ok: false, reason: "malformed-response", errorMessage: "Image generation returned invalid SSE." };
	}

	let completed: Record<string, unknown> | undefined;
	let responseId: string | undefined;
	const imageItemsById = new Map<string, Record<string, unknown>>();
	for (const event of events) {
		if (event.dataText === "[DONE]") {
			if (!completed) {
				return { ok: false, reason: "malformed-response", errorMessage: "Image generation stream ended before response.completed." };
			}
			continue;
		}
		const data = isRecord(event.data) ? event.data : undefined;
		const type = typeof data?.type === "string" ? data.type : event.event;
		if (type === "error" || type === "response.failed" || type === "response.incomplete") {
			return {
				ok: false,
				reason: "request-rejected",
				errorMessage: extractProviderErrorMessage(
					data?.response,
					extractProviderErrorMessage(data, `Image generation stream reported ${type}.`),
				),
			};
		}
		if (completed) {
			if (type === "keepalive") continue;
			return { ok: false, reason: "malformed-response", errorMessage: "Image generation stream contains duplicate or out-of-order completion events." };
		}
		// When supplied, response identity must agree across created, item-done and terminal events.
		for (const id of [data?.response_id, isRecord(data?.response) ? data.response.id : undefined]) {
			if (id === undefined) continue;
			if (!isStreamIdentifier(id) || (responseId !== undefined && responseId !== id)) {
				return { ok: false, reason: "malformed-response", errorMessage: "Image generation stream contains invalid or conflicting response identities." };
			}
			responseId = id;
		}
		if (type === "response.output_item.done" && isRecord(data?.item) && data.item.type === "image_generation_call") {
			const item = data.item;
			if (!isStreamIdentifier(item.id)) {
				return { ok: false, reason: "malformed-response", errorMessage: "Image generation item-done has no valid image call identity." };
			}
			const previous = imageItemsById.get(item.id);
			const merged = previous ? mergeImageItems(previous, item) : item;
			if (!merged) {
				return { ok: false, reason: "malformed-response", errorMessage: "Image generation returned conflicting item-done results for one image call." };
			}
			imageItemsById.set(item.id, merged);
		}
		// Pi's Codex adapter also recognizes response.done as the terminal event.
		if (type === "response.completed" || type === "response.done") {
			if (!isRecord(data?.response)) {
				return { ok: false, reason: "malformed-response", errorMessage: "Image generation completion event has no response envelope." };
			}
			completed = data.response;
		}
	}
	if (!completed) {
		return { ok: false, reason: "malformed-response", errorMessage: "Image generation stream ended before response.completed." };
	}
	// Reconcile only after a successful terminal envelope. Partial images and item-added
	// events never enter this map; PNG validation and the single-image contract stay below.
	if (completed.status !== "completed" || !Array.isArray(completed.output)) {
		return parseImageGenerationResponse(completed);
	}
	const output: unknown[] = [];
	const remaining = new Map(imageItemsById);
	for (const item of completed.output) {
		const previous = isRecord(item) && typeof item.id === "string" ? imageItemsById.get(item.id) : undefined;
		if (previous && isRecord(item)) {
			const merged = mergeImageItems(previous, item);
			if (!merged) {
				return { ok: false, reason: "malformed-response", errorMessage: "Image generation returned conflicting item-done and terminal results for one image call." };
			}
			output.push(merged);
			remaining.delete(item.id as string);
		} else {
			output.push(item);
		}
	}
	output.push(...remaining.values());
	const parsed = parseImageGenerationResponse({ ...completed, output });
	if (parsed.ok || parsed.reason !== "no-image") return parsed;
	const eventTypes: Record<string, number> = {};
	const imageItems: Record<string, unknown>[] = [];
	let imageItemDoneCount = 0;
	for (const event of events) {
		if (event.dataText === "[DONE]") continue;
		const data = isRecord(event.data) ? event.data : undefined;
		const type = diagnosticTag(typeof data?.type === "string" ? data.type : event.event);
		eventTypes[type] = (eventTypes[type] ?? 0) + 1;
		if (type === "response.output_item.done" && isRecord(data?.item) && data.item.type === "image_generation_call") {
			imageItemDoneCount += 1;
			if (imageItems.length < MAX_DIAGNOSTIC_ITEMS) imageItems.push(summarizeImageOutput(data.item));
		}
	}
	return {
		...parsed,
		errorMessage: `${parsed.errorMessage} Stream diagnostic: ${diagnosticSummary({
			eventCount: events.length, terminalOutputCount: completed.output.length, imageItemDoneCount, eventTypes, imageItems,
		})}`,
	};
}

export function parseImageGenerationResponse(value: unknown): ParsedImageResponseResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned a non-object response.",
		};
	}

	if (value.status !== "completed") {
		return {
			ok: false,
			reason: "request-rejected",
			errorMessage: extractProviderErrorMessage(
				value,
				`Image generation did not complete (status: ${String(value.status ?? "unknown")}).`,
			),
		};
	}
	if (!Array.isArray(value.output)) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation response did not contain an output array.",
		};
	}

	const calls = new Map<string, { result: string; revisedPrompt?: string }>();
	for (let index = 0; index < value.output.length; index += 1) {
		const item = value.output[index];
		if (!isRecord(item) || item.type !== "image_generation_call") continue;
		if (item.status !== "completed") continue;
		const result = imageResult(item);
		if (!result?.trim()) continue;
		const id = normalizedOptionalString(item.id, MAX_IMAGE_IDENTIFIER_CHARS) ?? `image_generation_${index}`;
		const revisedPrompt = normalizedOptionalString(item.revised_prompt, MAX_IMAGE_DIAGNOSTIC_CHARS);
		const existing = calls.get(id);
		if (existing && existing.result !== result) {
			return {
				ok: false,
				reason: "malformed-response",
				errorMessage: "Image generation returned conflicting results for one image call.",
			};
		}
		calls.set(id, { result, revisedPrompt: revisedPrompt ?? existing?.revisedPrompt });
	}

	if (calls.size === 0) {
		return {
			ok: false,
			reason: "no-image",
			errorMessage: `Image generation completed without a usable image result. Response diagnostic: ${diagnosticSummary({
				outputCount: value.output.length,
				imageCallCount: value.output.filter(item => isRecord(item) && item.type === "image_generation_call").length,
				error: extractProviderErrorMessage(value, "").slice(0, MAX_DIAGNOSTIC_ERROR_CHARS) || undefined,
				output: value.output.slice(0, MAX_DIAGNOSTIC_ITEMS).map(summarizeImageOutput),
			})}`,
		};
	}
	if (calls.size !== 1) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned more than one image result for a single-image request.",
		};
	}

	const [imageCallId, call] = [...calls.entries()][0]!;
	const decoded = decodeGeneratedPng(call.result);
	if (!decoded.ok) return decoded;

	return {
		ok: true,
		image: {
			bytes: decoded.bytes,
			imageCallId,
			responseId: normalizedOptionalString(value.id, MAX_IMAGE_IDENTIFIER_CHARS),
			revisedPrompt: call.revisedPrompt,
			width: decoded.width,
			height: decoded.height,
		},
	};
}

export const _protocolTest = {
	PNG_SIGNATURE,
	IMAGE_GENERATION_MIME_TYPE,
};

import { describe, expect, test } from "bun:test";
import { parseImageGenerationStream } from "./protocol";
import { completedImageResponse, VALID_PNG_BASE64, validPng } from "./test-helpers";

const image = (completedImageResponse().output as Record<string, unknown>[])[0]!;
const created = { type: "response.created", response: { id: "resp_image_test" } };
const done = (item = image, extra: Record<string, unknown> = {}) => ({
	type: "response.output_item.done", item, ...extra,
});
const terminal = (output: unknown[] = [], extra: Record<string, unknown> = {}) => ({
	type: "response.completed", response: completedImageResponse({ output, ...extra }),
});
const parse = (...events: unknown[]) => parseImageGenerationStream(
	events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
);

function expectImage(...events: unknown[]) {
	const result = parse(...events);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.errorMessage);
	expect(result.image.bytes).toEqual(validPng());
	expect(result.image.imageCallId).toBe("ig_test");
	expect(result.image.responseId).toBe("resp_image_test");
	return result.image;
}

function expectFailure(...events: unknown[]) {
	const result = parse(...events);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("Expected stream failure");
	expect(result.errorMessage).not.toContain(VALID_PNG_BASE64);
	return result;
}

describe("image SSE reconciliation", () => {
	test("recovers an item-done image after successful completion with an empty output array", () => {
		expectImage(created, done(image, { response_id: "resp_image_test", output_index: 0 }), terminal());
	});

	test("keeps terminal-only images and deduplicates matching copies from both sources", () => {
		expectImage(created, terminal([image]));
		expectImage(created, done(), terminal([image]));
		expectImage(created, done(), done(), terminal([image]));
	});

	test("matches image IDs despite unrelated message items and merges absent metadata", () => {
		const metadataOnly = { type: "image_generation_call", id: "ig_test", status: "completed" };
		const result = expectImage(created, done(), terminal([
			{ type: "message", id: "msg_test", content: [] }, metadataOnly,
		]));
		expect(result.revisedPrompt).toBe("A revised prompt");
		expectImage(created, done(), terminal([{ type: "message", id: "msg_test", content: [] }]));
	});

	test("supports the existing b64_json alias and Codex response.done completion", () => {
		const { result, ...metadata } = image;
		expectImage(created, done({ ...metadata, b64_json: result }), {
			...terminal(), type: "response.done",
		});
		expectImage(created, done({ ...metadata, b64_json: result }), terminal([image]));
	});

	test.each(["result", "status", "revised_prompt"])("rejects conflicting %s across sources or repeated item-done events", field => {
		const conflict = { ...image, [field]: "conflicting-value" };
		expect(expectFailure(created, done(), terminal([conflict])).reason).toBe("malformed-response");
		expect(expectFailure(created, done(), done(conflict), terminal()).reason).toBe("malformed-response");
	});

	test("rejects conflicting aliases, multiple image IDs and reusing an image ID for a message", () => {
		const { result: _result, ...metadata } = image;
		expectFailure(created, done(), terminal([{ ...metadata, b64_json: "conflicting-value" }]));
		expectFailure(created, done(), terminal([{ ...image, id: "ig_other" }]));
		expectFailure(created, done(), done({ ...image, id: "ig_other" }), terminal());
		expectFailure(created, done(), terminal([{ type: "message", id: "ig_test" }]));
	});

	test("rejects inconsistent response identities without echoing IDs", () => {
		for (const events of [
			[created, done(), terminal([], { id: "private-other-response" })],
			[created, done(image, { response_id: "private-other-response" }), terminal()],
			[done(image, { response_id: "private-other-response" }), terminal()],
		]) {
			const failure = expectFailure(...events);
			expect(failure.reason).toBe("malformed-response");
			expect(failure.errorMessage).not.toContain("private-other-response");
		}
	});

	test("never accepts item-done alone, failure, incomplete or misordered completions", () => {
		for (const events of [
			[created, done()],
			[created, done(), { type: "response.failed", response: { error: { message: "failed" } } }],
			[created, done(), terminal([], { status: "incomplete" })],
			[created, done(), terminal(), { type: "error", message: "late error" }],
			[created, done(), terminal(), terminal()],
			[created, terminal(), done()],
		]) expectFailure(...events);
	});

	test("never promotes partial-image or item-added events, or failed image items", () => {
		expectFailure(created, { type: "response.image_generation_call.partial_image", partial_image_b64: VALID_PNG_BASE64 }, terminal());
		expectFailure(created, { type: "response.output_item.added", item: image }, terminal());
		expectFailure(created, done({ ...image, status: "failed" }), terminal());
	});

	test("keeps PNG validation and rejects malformed envelopes or unidentifiable stream items", () => {
		expect(expectFailure(created, done({ ...image, result: "not-a-png" }), terminal()).reason).toBe("malformed-response");
		expectFailure(created, done(), terminal([], { output: null }));
		expectFailure(created, done(), terminal([], { output: undefined }));
		for (const id of [undefined, "", " ", "x".repeat(257)]) {
			expectFailure(created, done({ ...image, id }), terminal());
		}
	});
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { INFORMATION_PROFILES, inferInformationProfile } from "../src/information-profiles.js";

test("information profiles expose curated segment sets in deterministic order", () => {
	assert.deepEqual(INFORMATION_PROFILES.minimal, ["cwd", "model", "context", "branch"]);
	assert.deepEqual(INFORMATION_PROFILES.balanced, [
		"cwd",
		"model",
		"thinking",
		"context",
		"cost",
		"branch",
		"tokens",
		"five_hour",
		"weekly",
		"cache",
		"tools",
	]);
	assert.deepEqual(INFORMATION_PROFILES.detailed, [
		"cwd",
		"model",
		"thinking",
		"context",
		"cost",
		"branch",
		"tokens",
		"five_hour",
		"weekly",
		"cache",
		"tools",
		"provider",
		"time",
	]);
});

test("information profile inference recognizes exact profiles and reports custom layouts", () => {
	assert.equal(inferInformationProfile(INFORMATION_PROFILES.minimal), "minimal");
	assert.equal(inferInformationProfile(INFORMATION_PROFILES.balanced), "balanced");
	assert.equal(inferInformationProfile(INFORMATION_PROFILES.detailed), "detailed");
	assert.equal(inferInformationProfile(["model", "context"]), "custom");
	assert.equal(inferInformationProfile(["context", "model", "cwd", "branch"]), "custom");
	assert.equal(
		inferInformationProfile(["model", "line_break", "cwd", "branch", "context"]),
		"custom",
	);
});

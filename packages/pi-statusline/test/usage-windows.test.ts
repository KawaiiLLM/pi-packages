import assert from "node:assert/strict";
import { test } from "vitest";
import {
	CAROUSEL_PERIOD_MS,
	formatEstimatedCost,
	formatTimeRemaining,
	formatUsageWindow,
	minutesUntil,
	rotateFrames,
} from "../src/usage-windows.js";

test("time remaining reads in the largest two units", () => {
	assert.equal(formatTimeRemaining(7_185), "4d 23h");
	assert.equal(formatTimeRemaining(1_440), "1d");
	assert.equal(formatTimeRemaining(285), "4h 45m");
	assert.equal(formatTimeRemaining(60), "1h");
	assert.equal(formatTimeRemaining(12), "12m");
	assert.equal(formatTimeRemaining(0), "0m");
});

test("minutes until a reset never go negative", () => {
	assert.equal(minutesUntil(1_000, 1_000_000 - 90_000), 2);
	assert.equal(minutesUntil(1_000, 2_000_000), 0);
});

test("estimated cost shows whole dollars and hides anything under one", () => {
	assert.equal(formatEstimatedCost(3_064.4), "$3064");
	assert.equal(formatEstimatedCost(1), "$1");
	assert.equal(formatEstimatedCost(0.5), "<$1");
});

test("the carousel alternates countdown and value on its period at a fixed width", () => {
	const now = 1_000_000_000;
	const window = {
		usedPercent: 12.4,
		resetsAt: now / 1000 + 285 * 60,
	};
	const frameStart = Math.floor(now / CAROUSEL_PERIOD_MS) * CAROUSEL_PERIOD_MS;
	const first = formatUsageWindow(window, 647, frameStart);
	const second = formatUsageWindow(window, 647, frameStart + CAROUSEL_PERIOD_MS);
	assert.deepEqual([first.trim(), second.trim()].sort(), ["12% ($647)", "12% (4h 45m)"]);
	assert.equal(first.length, second.length);
	assert.equal(formatUsageWindow(window, undefined, frameStart), "12% (4h 45m)");
	assert.equal(
		formatUsageWindow(window, undefined, frameStart + CAROUSEL_PERIOD_MS),
		"12% (4h 45m)",
	);
});

test("rotating frames pads every reading to the widest one", () => {
	assert.equal(rotateFrames(["ab", "abcd"], 0, 10), " ab ");
	assert.equal(rotateFrames(["ab", "abcd"], 10, 10), "abcd");
	assert.equal(rotateFrames(["ab", "abcd"], 20, 10), " ab ");
});

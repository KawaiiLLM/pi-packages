import assert from "node:assert/strict";
import { test } from "vitest";
import { contrastRatio, relativeLuminance } from "../src/presets/create-ramp.js";
import { adaptTextColor, hexToOklch } from "../src/presets/oklch.js";

const contrast = (a: string, b: string) =>
	contrastRatio(relativeLuminance(a), relativeLuminance(b));

test("OKLCH conversion preserves reference red and neutral endpoints", () => {
	const red = hexToOklch("#ff0000");
	assert.ok(Math.abs(red.L - 0.627955) < 1e-5);
	assert.ok(Math.abs(red.C - 0.257683) < 1e-5);
	assert.ok(Math.abs(red.H - 29.233885) < 1e-4);
	assert.deepEqual(hexToOklch("#000000"), { L: 0, C: 0, H: 0 });
	assert.ok(Math.abs(hexToOklch("#ffffff").L - 1) < 1e-6);
	assert.equal(hexToOklch("#ffffff").C, 0);
});

test("approved Prism seeds reach contrast four while preserving hue and never increasing chroma", () => {
	for (const seed of ["#E77B92", "#A2DAF4", "#DCE58A", "#A582DD", "#E8CE99"]) {
		for (const bg of ["#d4d4d4", "#a3a3a3", "#686868", "#404040", "#262626"]) {
			const output = adaptTextColor(seed, bg, 4);
			assert.match(output, /^#[0-9a-f]{6}$/u);
			assert.ok(contrast(output, bg) >= 4, `${seed} on ${bg}`);
			const before = hexToOklch(seed),
				after = hexToOklch(output);
			const difference = Math.abs(before.H - after.H);
			assert.ok(Math.min(difference, 360 - difference) < 3, `${seed} hue on ${bg}`);
			assert.ok(after.C <= before.C + 0.003, "allow only 8-bit rounding error");
			if (contrast(seed, bg) >= 4) assert.equal(output, seed.toLowerCase());
		}
	}
});

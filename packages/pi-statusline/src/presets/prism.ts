import type { SegmentName } from "../types.js";
import { createRampPreset } from "./create-ramp.js";
import { MONO_PRESET } from "./mono.js";
import { adaptTextColor } from "./oklch.js";
import type { PowerlinePreset } from "./types.js";

const TEXT_COLORS: Partial<Record<SegmentName, string>> = {
	model: "#E77B92",
	thinking: "#E77B92",
	context: "#A2DAF4",
	tokens: "#A2DAF4",
	five_hour: "#DCE58A",
	weekly: "#DCE58A",
	cache: "#A582DD",
	cost: "#E8CE99",
};

// Preset colors are static; never repeat the lightness search during width fitting or redraws.
const foregrounds = new Map<string, string>();

export const PRISM_PRESET: PowerlinePreset = {
	...MONO_PRESET,
	lead: ["#3A3A3A", "#4A4A4A", "#5A5A5A"],
	ramp: createRampPreset(["#5A5A5A", "#4A4A4A", "#3A3A3A", "#2A2A2A", "#1A1A1A"]).ramp,
	foreground(name, colors) {
		const text = TEXT_COLORS[name];
		if (!text || !colors.bg) return colors.fg ?? "#f0f0f0";
		const key = `${text}/${colors.bg}`;
		let result = foregrounds.get(key);
		if (!result) {
			result = adaptTextColor(text, colors.bg, 4);
			foregrounds.set(key, result);
		}
		return result;
	},
};

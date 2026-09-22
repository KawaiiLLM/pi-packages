import type { PaletteColor, SegmentName } from "../types.js";

export interface PowerlinePreset {
	/** One color for the lead, or one color each for ░, ▒, and ▓. */
	lead?: string | [string, string, string];
	/** Colours in ramp order, assigned to segments by their position in a row. */
	ramp: PaletteColor[];
	/** Optional field-specific text color; backgrounds still follow the ramp. */
	foreground?: (name: SegmentName, colors: PaletteColor) => string;
	extensionSeparator?: string;
}

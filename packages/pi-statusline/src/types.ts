import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const SEGMENT_NAMES = [
	"brand",
	"provider",
	"model",
	"thinking",
	"cwd",
	"branch",
	"tools",
	"context",
	"tokens",
	"cache",
	"cost",
	"five_hour",
	"weekly",
	"time",
	"turn",
] as const;
export type SegmentName = (typeof SEGMENT_NAMES)[number];

export const LINE_BREAK_SEGMENT_NAME = "line_break" as const;
export type ConfigSegmentName = SegmentName | typeof LINE_BREAK_SEGMENT_NAME;

export const PALETTE_NAMES = [
	"tokyo-night",
	"ocean",
	"sunset",
	"forest",
	"candy",
	"neon",
	"mono",
	"prism",
] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

export const PALETTE_PRESET_NAMES = [...PALETTE_NAMES, "custom"] as const;
export type PalettePreset = (typeof PALETTE_PRESET_NAMES)[number];

export const DENSITIES = ["compact", "cozy"] as const;
export type Density = (typeof DENSITIES)[number];

export const SEPARATOR_NAMES = ["none", "dot", "bar", "powerline", "round"] as const;
export type SeparatorName = (typeof SEPARATOR_NAMES)[number];

export const TRUNCATION_DIRECTIONS = ["start", "middle", "end"] as const;
export type TruncationDirection = (typeof TRUNCATION_DIRECTIONS)[number];

export const OVERFLOW_MODES = ["wrap", "drop"] as const;
export type OverflowMode = (typeof OVERFLOW_MODES)[number];

export interface SegmentTextConfig {
	prefix: string;
	suffix: string;
}

export interface ModelSegmentTextConfig extends SegmentTextConfig {
	truncationLength: number;
	truncationSymbol: string;
	truncationDirection: TruncationDirection;
}

export interface PaletteColor {
	fg?: string;
	bg?: string;
}

export interface StatuslineConfig {
	palettePreset: PalettePreset;
	/**
	 * Colours in ramp order. The n-th visible segment of a row takes the n-th
	 * entry, wrapping around when the row has more segments than the ramp.
	 */
	palette: PaletteColor[];
	density: Density;
	separator: SeparatorName;
	/** What a row does with segments that do not fit: continue on a new row, or shed by priority. */
	overflow: OverflowMode;
	segments: ConfigSegmentName[];
	segmentText: Record<SegmentName, SegmentTextConfig> & { model: ModelSegmentTextConfig };
	extensionStatusIcons: Record<string, string>;
}

export interface RenderSegment {
	name: SegmentName;
	text: string;
	color: ThemeColor;
	emphasis?: boolean;
	/** Swap foreground and background when the segment's alert condition is met. */
	alert?: boolean;
}

export interface RenderLineBreak {
	name: typeof LINE_BREAK_SEGMENT_NAME;
}

export type RenderItem = RenderSegment | RenderLineBreak;

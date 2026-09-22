import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ansiStyle } from "./ansi.js";
import { resolvePreset } from "./presets/index.js";
import type { PowerlinePreset } from "./presets/types.js";
import {
	LINE_BREAK_SEGMENT_NAME,
	type PaletteColor,
	type PalettePreset,
	type RenderItem,
	type RenderSegment,
	type SeparatorName,
	type StatuslineConfig,
} from "./types.js";

type PowerlineConfig = Pick<
	StatuslineConfig,
	"palettePreset" | "palette" | "density" | "separator" | "overflow"
>;

interface PowerlineBlock {
	colors: PaletteColor;
	segments: RenderSegment[];
	/** An alerting segment keeps its own block so the fill reads against its neighbours. */
	alert: boolean;
}

export function renderPowerlineStatusline(
	width: number,
	items: RenderItem[],
	config: PowerlineConfig,
	trueColor = true,
): string {
	if (items.length === 0 || width <= 0) return "";
	return splitLines(items)
		.flatMap((segments) => layoutRows(segments, width, config, trueColor))
		.map((segments) =>
			segments.length === 0 ? "" : joinPowerlineSegments(segments, config, trueColor),
		)
		.join("\n");
}

function splitLines(items: RenderItem[]): RenderSegment[][] {
	const lines: RenderSegment[][] = [[]];
	for (const item of items) {
		if (item.name === LINE_BREAK_SEGMENT_NAME) lines.push([]);
		else lines.at(-1)?.push(item);
	}
	return lines;
}

/**
 * Each row spans at most one background cycle. Wrapping carries what does
 * not fit onto the next row; dropping sheds segments by priority until the row
 * fits. A segment too wide for a row on its own is left out either way, and an
 * empty explicit row stays an empty row.
 */
function layoutRows(
	segments: readonly RenderSegment[],
	width: number,
	config: PowerlineConfig,
	trueColor: boolean,
): RenderSegment[][] {
	if (segments.length === 0) return [[]];
	const cycleLength = rampFor(config).length || Number.POSITIVE_INFINITY;
	if (config.overflow === "drop") {
		const rows: RenderSegment[][] = [];
		for (let start = 0; start < segments.length; start += cycleLength) {
			rows.push(
				fitPowerlineSegments(segments.slice(start, start + cycleLength), width, config, trueColor),
			);
		}
		return rows;
	}
	const fits = (row: RenderSegment[]) =>
		visibleWidth(joinPowerlineSegments(row, config, trueColor)) <= width;
	const rows: RenderSegment[][] = [];
	let row: RenderSegment[] = [];
	for (const segment of segments) {
		if (row.length < cycleLength && fits([...row, segment])) {
			row.push(segment);
			continue;
		}
		if (row.length > 0) rows.push(row);
		row = fits([segment]) ? [segment] : [];
	}
	if (row.length > 0) rows.push(row);
	return rows.length > 0 ? rows : [[]];
}

const SEGMENT_RETENTION_PRIORITY: Readonly<Record<RenderSegment["name"], number>> = {
	context: 120,
	model: 110,
	branch: 100,
	weekly: 95,
	tools: 90,
	five_hour: 85,
	cwd: 80,
	thinking: 70,
	cost: 60,
	provider: 50,
	cache: 45,
	tokens: 40,
	time: 30,
	turn: 20,
	brand: 10,
};

function fitPowerlineSegments(
	segments: readonly RenderSegment[],
	width: number,
	config: PowerlineConfig,
	trueColor: boolean,
): RenderSegment[] {
	const fitted = [...segments];
	while (fitted.length > 1) {
		if (visibleWidth(joinPowerlineSegments(fitted, config, trueColor)) <= width) return fitted;
		let removalIndex = 0;
		for (let index = 1; index < fitted.length; index += 1) {
			const candidate = fitted[index];
			const current = fitted[removalIndex];
			if (
				candidate &&
				current &&
				SEGMENT_RETENTION_PRIORITY[candidate.name] < SEGMENT_RETENTION_PRIORITY[current.name]
			) {
				removalIndex = index;
			}
		}
		fitted.splice(removalIndex, 1);
	}
	return visibleWidth(joinPowerlineSegments(fitted, config, trueColor)) <= width ? fitted : [];
}

export function powerlineExtensionSeparator(
	_theme: Theme,
	palettePreset: PalettePreset = "tokyo-night",
	trueColor = true,
): string {
	return ansiStyle(" • ", { fg: resolvePreset(palettePreset).extensionSeparator }, trueColor);
}

function joinPowerlineSegments(
	segments: readonly RenderSegment[],
	config: PowerlineConfig,
	trueColor: boolean,
): string {
	const preset = resolvePreset(config.palettePreset);
	const blocks = contiguousBlocks(segments, rampFor(config), preset.foreground);
	const lead = preset.lead;
	let line = Array.isArray(lead)
		? [..."░▒▓"].map((glyph, index) => ansiStyle(glyph, { fg: lead[index] }, trueColor)).join("")
		: ansiStyle("░▒▓", { fg: lead }, trueColor);

	for (const [index, block] of blocks.entries()) {
		const previous = index === 0 ? undefined : blocks[index - 1];
		if (previous) {
			line += ansiStyle(
				"\ue0b4",
				{ fg: blockBackground(previous), bg: blockBackground(block) },
				trueColor,
			);
		}
		line += ansiStyle(formatBlockText(block, config), block.colors, trueColor, block.alert);
	}

	const lastBlock = blocks.at(-1);
	if (lastBlock) line += ansiStyle("\ue0b4", { fg: blockBackground(lastBlock) }, trueColor);
	return line;
}

function rampFor(config: PowerlineConfig): readonly PaletteColor[] {
	return config.palettePreset === "custom"
		? config.palette
		: resolvePreset(config.palettePreset).ramp;
}

/**
 * Colours go by position: the n-th segment of the row takes the n-th ramp
 * entry, cycling once the ramp is used up. Neighbours that end up with the
 * same colours share one block within that row. Layout prevents a second cycle.
 */
function contiguousBlocks(
	segments: readonly RenderSegment[],
	ramp: readonly PaletteColor[],
	foreground?: PowerlinePreset["foreground"],
): PowerlineBlock[] {
	const blocks: PowerlineBlock[] = [];
	for (const [index, segment] of segments.entries()) {
		const base = ramp.length > 0 ? (ramp[index % ramp.length] ?? {}) : {};
		const colors = foreground ? { ...base, fg: foreground(segment.name, base) } : base;
		const previous = blocks.at(-1);
		const joins =
			previous !== undefined &&
			!previous.alert &&
			!segment.alert &&
			colorsEqual(previous.colors, colors);
		if (joins) previous.segments.push(segment);
		else blocks.push({ colors, segments: [segment], alert: segment.alert === true });
	}
	return blocks;
}

function blockBackground(block: PowerlineBlock): string | undefined {
	return block.alert ? block.colors.fg : block.colors.bg;
}

function colorsEqual(left: PaletteColor, right: PaletteColor): boolean {
	return left.fg === right.fg && left.bg === right.bg;
}

function formatBlockText(block: PowerlineBlock, config: PowerlineConfig): string {
	const texts = block.segments.map(formatSegmentText);
	const separator = separatorText(config.separator, config.density === "cozy");
	const leading = config.density === "cozy" ? "  " : " ";
	const trailing = config.density === "cozy" ? " " : "";
	return `${leading}${texts.join(separator)}${trailing}`;
}

function formatSegmentText(segment: RenderSegment): string {
	return segment.emphasis ? `\u001b[1m${segment.text}\u001b[22m` : segment.text;
}

function separatorText(separator: SeparatorName, cozy: boolean): string {
	const padding = cozy ? "  " : " ";
	switch (separator) {
		case "dot":
			return `${padding}•${padding}`;
		case "bar":
			return `${padding}│${padding}`;
		case "powerline":
			return `${padding}\ue0b5${padding}`;
		case "round":
			return `${padding}❯${padding}`;
		case "none":
			return padding;
	}
}

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
	UIPromptKind,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type {
	DailySpend,
	PricedUsageWindow,
	UsageRuntime,
	UsageSnapshot,
} from "@narumitw/pi-usage/snapshot";
import { formatDirectoryPath } from "./directory.js";
import {
	type ExtensionStatusRuntime,
	formatExtensionStatuses,
	wrapExtensionStatusline,
} from "./extension-status.js";
import { formatGitBranchValue, type GitStatusSummary } from "./git-status.js";
import { renderPowerlineStatusline } from "./powerline.js";
import {
	LINE_BREAK_SEGMENT_NAME,
	type RenderItem,
	type RenderSegment,
	type SegmentName,
	type StatuslineConfig,
	type TruncationDirection,
} from "./types.js";
import { type FooterUsageSummary, summarizeFooterUsage } from "./usage.js";
import { formatTimeRemaining, formatUsageWindow } from "./usage-windows.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface RuntimeState extends ExtensionStatusRuntime {
	homeDir?: string;
	turnCount: number;
	activeTools: Map<string, number>;
	isStreaming: boolean;
	uiPrompt?: { kind: UIPromptKind; title?: string };
	thinkingLevel: ThinkingLevel;
	gitStatus?: GitStatusSummary;
	usage?: UsageRuntime;
	dailySpent?: DailySpend;
	dailyBudgetPercent?: number;
	fast?: UsageSnapshot["fast"];
	requestRender?: () => void;
}

const GITHUB_PR_KEY = "github-pr";
const USAGE_STATUS_KEYS = new Set(["usage", "codex-usage"]);
const INLINE_STATUS_KEYS = new Set([...USAGE_STATUS_KEYS, GITHUB_PR_KEY]);
export function renderStatusline(
	width: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	_theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
	trueColor = true,
): string {
	if (width <= 0) return "";

	const usageSummary = summarizeFooterUsage(ctx.sessionManager.getEntries());
	const rows: Array<{ configuredSegments: number; segments: RenderSegment[] }> = [
		{ configuredSegments: 0, segments: [] },
	];
	for (const name of config.segments) {
		if (name === LINE_BREAK_SEGMENT_NAME) {
			rows.push({ configuredSegments: 0, segments: [] });
			continue;
		}

		const row = rows.at(-1);
		if (!row) continue;
		row.configuredSegments += 1;
		const rendered = buildSegment(name, ctx, footerData, config, runtime, usageSummary);
		if (rendered && rendered.text.length > 0) row.segments.push(rendered);
	}

	const segments: RenderItem[] = [];
	const renderedRows = rows.filter(
		(row) => row.configuredSegments === 0 || row.segments.length > 0,
	);
	for (const [index, row] of renderedRows.entries()) {
		if (index > 0) segments.push({ name: LINE_BREAK_SEGMENT_NAME });
		segments.push(...row.segments);
	}

	return renderPowerlineStatusline(width, segments, config, trueColor);
}

export function renderExtensionStatusline(
	width: number,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
	mainLine: string,
	trueColor = true,
): string[] {
	const statuses = footerData.getExtensionStatuses();
	const prContext = prContextFromStatuses(statuses);
	const rendersPrInline = prContext !== undefined && mainLine.includes(prContext);
	const status = formatExtensionStatuses(
		statuses,
		theme,
		config,
		runtime,
		rendersPrInline ? INLINE_STATUS_KEYS : USAGE_STATUS_KEYS,
		trueColor,
	);
	return wrapExtensionStatusline(status, width);
}

/** Whole minutes since the latest response; blank under a minute and for entries without a clock. */
function formatIdleTime(latestAt: number | undefined): string | undefined {
	if (latestAt === undefined) return undefined;
	const minutes = Math.floor((Date.now() - latestAt) / 60_000);
	return minutes >= 1 ? formatTimeRemaining(minutes) : undefined;
}

function buildSegment(
	name: SegmentName,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	config: StatuslineConfig,
	runtime: RuntimeState,
	usageSummary: FooterUsageSummary,
): RenderSegment | undefined {
	switch (name) {
		case "brand":
			return segment(name, "π", config, "accent", true);
		case "provider":
			return segment(name, ctx.model?.provider ?? "no-provider", config, "accent");
		case "model": {
			const presentation = config.segmentText.model;
			const model = truncateModel(
				shortenModel(ctx.model?.id ?? "no-model"),
				presentation.truncationLength,
				presentation.truncationSymbol,
				presentation.truncationDirection,
			);
			const fast = runtime.fast?.effective ? " fast" : "";
			return segment(name, `${model}${fast}`, config, "accent");
		}
		case "thinking":
			return segment(name, runtime.thinkingLevel, config, thinkingColor(runtime.thinkingLevel));
		case "branch": {
			const branch = footerData.getGitBranch();
			const pr = branch ? prContextFromStatuses(footerData.getExtensionStatuses()) : undefined;
			return segment(name, formatGitBranchValue(branch, runtime.gitStatus, pr), config, "accent");
		}
		case "cwd":
			return segment(
				name,
				formatDirectoryPath(ctx.cwd, runtime.homeDir, runtime.gitStatus?.root),
				config,
				"accent",
			);
		case "tools": {
			const activity = formatToolActivity(runtime);
			return activity ? segment(name, activity, config, "accent") : undefined;
		}
		case "context": {
			const usage = ctx.getContextUsage();
			const percent = usage?.percent ?? undefined;
			// The share is defined as tokens over the window, so a report carrying
			// only the share still says how many tokens are in use.
			const tokens =
				usage?.tokens ??
				(usage === undefined || percent === undefined
					? undefined
					: Math.round((percent / 100) * usage.contextWindow));
			const value =
				percent === undefined || tokens === undefined
					? "?"
					: `${formatCount(tokens)} (${Math.round(percent)}%)`;
			return segment(name, value, config, "accent", false, percentAlert(percent));
		}
		case "tokens":
			return segment(
				name,
				`↑${formatCount(usageSummary.input)} ↓${formatCount(usageSummary.output)}`,
				config,
				"accent",
			);
		case "cache": {
			// Latest assistant response only: a session total goes stale and never recovers.
			const hitRate = usageSummary.latestCacheHitRate;
			if (hitRate === undefined) return undefined;
			// Idle time decides whether that cache is still warm, so it belongs next to the rate.
			const idle = formatIdleTime(usageSummary.latestAt);
			const value = idle ? `${Math.round(hitRate)}% (${idle})` : `${Math.round(hitRate)}%`;
			return segment(name, value, config, "accent", false, hitRate <= 50);
		}
		case "cost": {
			// Today, not the session: a session total never resets, so it stops
			// answering the only question the figure is asked, what today cost.
			const today = runtime.dailySpent;
			if (!today) return undefined;
			// The share of today's budget spent says more than the dollars alone,
			// and it is the reading the alert fires on.
			const budget = runtime.dailyBudgetPercent;
			const suffix =
				budget !== undefined
					? ` (${Math.round(budget)}%)`
					: runtime.usage !== undefined || ctx.model?.provider === "kimi-coding"
						? " (sub)"
						: "";
			return segment(
				name,
				`$${today.dollars.toFixed(2)}${suffix}`,
				config,
				"accent",
				false,
				budget !== undefined && budget >= 100,
			);
		}
		case "five_hour":
			return usageWindowSegment(name, runtime.usage?.fiveHour, config);
		case "weekly":
			return usageWindowSegment(name, runtime.usage?.weekly, config);
		case "time":
			return segment(name, formatTime(), config, "accent");
		case "turn":
			return segment(name, `${runtime.turnCount}`, config, "accent");
	}
}

function segment(
	name: SegmentName,
	value: string,
	config: StatuslineConfig,
	color: RenderSegment["color"],
	emphasis = false,
	alert = false,
): RenderSegment {
	return {
		name,
		text: formatConfiguredSegment(name, value, config),
		color,
		emphasis,
		...(alert ? { alert } : {}),
	};
}

function usageWindowSegment(
	name: SegmentName,
	window: PricedUsageWindow | undefined,
	config: StatuslineConfig,
): RenderSegment | undefined {
	if (!window) return undefined;
	return segment(
		name,
		formatUsageWindow(window, window.windowDollars, Date.now()),
		config,
		"accent",
		false,
		percentAlert(window.usedPercent),
	);
}

/** Context and subscription windows share one inclusive alert threshold. */
export function percentAlert(percent: number | undefined): boolean {
	return percent !== undefined && Number.isFinite(percent) && percent >= 80;
}

export function formatConfiguredSegment(
	name: SegmentName,
	value: string,
	config: Pick<StatuslineConfig, "segmentText">,
): string {
	const presentation = config.segmentText[name];
	return `${presentation.prefix}${value}${presentation.suffix}`;
}

function thinkingColor(level: ThinkingLevel): ThemeColor {
	switch (level as string) {
		case "off":
			return "dim";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax" as ThemeColor;
		default:
			return "dim";
	}
}

const MAX_UI_PROMPT_TITLE_CODE_POINTS = 256;
const MAX_UI_PROMPT_TITLE_WIDTH = 40;

function boundUIPromptTitleLength(title: string): string {
	let end = 0;
	let ellipsisEnd = 0;
	let codePoints = 0;
	while (end < title.length && codePoints < MAX_UI_PROMPT_TITLE_CODE_POINTS) {
		const codePoint = title.codePointAt(end) ?? 0;
		end += codePoint > 0xffff ? 2 : 1;
		codePoints += 1;
		if (codePoints < MAX_UI_PROMPT_TITLE_CODE_POINTS) ellipsisEnd = end;
	}
	return end < title.length ? `${title.slice(0, ellipsisEnd)}…` : title;
}

function formatUIPromptTitle(title: string | undefined): string {
	const safeTitle = title ? sanitizeTerminalText(title).trim() : "";
	const boundedTitle = boundUIPromptTitleLength(safeTitle);
	if (visibleWidth(boundedTitle) <= MAX_UI_PROMPT_TITLE_WIDTH) return boundedTitle;
	return `${sliceByColumn(boundedTitle, 0, MAX_UI_PROMPT_TITLE_WIDTH - 1, true)}…`;
}

export function formatToolActivity(runtime: RuntimeState): string | undefined {
	if (runtime.uiPrompt) {
		const title = formatUIPromptTitle(runtime.uiPrompt.title);
		return `⌨ waiting for ${runtime.uiPrompt.kind}${title ? ` · ${title}` : ""}`;
	}

	const active = [...runtime.activeTools.entries()];
	if (active.length > 0) {
		const [name, count] = active[0] ?? ["tool", 1];
		const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return `⚙ ${name}${suffix}`;
	}

	return runtime.isStreaming ? "◌ thinking" : undefined;
}

export function prLinkFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const value = statuses.get(GITHUB_PR_KEY);
	if (!value) return undefined;
	// Extract the OSC 8 hyperlink span (the clickable "#123"); skip non-PR states
	// like "PR gh missing" that carry no link. github-pr emits exactly one link, so the
	// first OSC 8 span is the PR number.
	const open = value.indexOf("\x1b]8;;");
	if (open === -1) return undefined;
	const closeMarker = "\x1b]8;;\x07";
	const close = value.indexOf(closeMarker, open + 1);
	return close === -1 ? undefined : value.slice(open, close + closeMarker.length);
}

export function prContextFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const value = statuses.get(GITHUB_PR_KEY);
	if (!value) return undefined;
	const link = prLinkFromStatuses(statuses);
	const reference = link ?? plainPrReference(value);
	if (!reference) return undefined;

	const state = compactPrState(link ? value.replace(link, "") : value);
	return state ? `${reference} · ${state}` : undefined;
}

function plainPrReference(value: string): string | undefined {
	return /^PR\s+(#\d+):/u.exec(value)?.[1];
}

function compactPrState(value: string): string | undefined {
	if (/:\s*merged\s*$/.test(value)) return "merged";
	if (/:\s*closed\s*$/.test(value)) return "closed";
	if (/\bdraft\b/.test(value)) return "draft";

	const failing = /\bchecks failing \((\d+)\)/.exec(value);
	if (failing) return `${failing[1]} failing`;
	if (/\bchanges requested\b/.test(value)) return "changes requested";

	const pending = /\bchecks pending \((\d+)\)/.exec(value);
	if (pending) return `${pending[1]} pending`;
	if (/\bapproved\b/.test(value)) return "approved";
	if (/\breview required\b/.test(value)) return "review required";
	if (/\bchecks passing\b/.test(value)) return "checks passing";
	if (/\bno checks\b/.test(value)) return "no checks";
	return undefined;
}

export function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatTime(): string {
	const now = new Date();
	const hours = now.getHours().toString().padStart(2, "0");
	const minutes = now.getMinutes().toString().padStart(2, "0");
	return `${hours}:${minutes}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateModel(
	model: string,
	length: number,
	symbol: string,
	direction: TruncationDirection,
): string {
	const safeModel = sanitizeTerminalText(model);
	if (length === 0) return safeModel;
	const graphemes = [...graphemeSegmenter.segment(safeModel)].map(({ segment }) => segment);
	if (graphemes.length <= length) return safeModel;
	const safeSymbol = sanitizeTerminalText(symbol);

	switch (direction) {
		case "start":
			return `${safeSymbol}${graphemes.slice(-length).join("")}`;
		case "middle": {
			const headLength = Math.ceil(length / 2);
			const tailLength = Math.floor(length / 2);
			const tail = tailLength > 0 ? graphemes.slice(-tailLength).join("") : "";
			return `${graphemes.slice(0, headLength).join("")}${safeSymbol}${tail}`;
		}
		case "end":
			return `${graphemes.slice(0, length).join("")}${safeSymbol}`;
	}
}

const CLAUDE_MODEL_PATTERN =
	/^(?:(?:global|apac|au|eu|us|us-east-\d|us-west-\d|eu-west-\d|eu-central-\d)\.)?(?:anthropic\.|azure_ai\/|bedrock\/|vertex_ai\/)?claude-(?:(?<family>opus|sonnet|haiku|fable|mythos)-(?<major>\d{1,2})(?:-(?<minor>\d))?|(?<oldMajor>\d{1,2})(?:-(?<oldMinor>\d))?-(?<oldFamily>opus|sonnet|haiku|fable|mythos))(?:[-@]\d{8})?(?:-v\d+:\d+)?(?:-latest)?$/iu;

/**
 * A Claude id collapses to its family and version ("Opus 5"); any other id is
 * shown as the provider names it, since there is no family to name it by.
 */
export function shortenModel(model: string): string {
	const groups = CLAUDE_MODEL_PATTERN.exec(model)?.groups;
	if (!groups) return model;
	const family = groups.family ?? groups.oldFamily ?? "";
	const major = groups.major ?? groups.oldMajor ?? "";
	const minor = groups.minor ?? groups.oldMinor;
	const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}`;
	return `${name} ${minor ? `${major}.${minor}` : major}`;
}

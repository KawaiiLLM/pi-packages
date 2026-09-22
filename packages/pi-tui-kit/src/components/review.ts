import { stripVTControlCharacters } from "node:util";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MenuScreen, ReviewScreen } from "../types.js";
import type {
	MenuKeybindings,
	MenuScreenComponent,
	MenuScreenComponentOptions,
} from "./contracts.js";
import {
	createDocumentLineCache,
	documentDialogPages,
	RPC_DOCUMENT_LINE_WIDTH,
	RPC_DOCUMENT_PAGE_SIZE,
} from "./document-formatting.js";
import {
	componentRows,
	fitCompactHintSegments,
	menuHint,
	renderHorizontalRule,
	safeMenuText,
} from "./rendering.js";

const DEFAULT_REVIEW_VIEWPORT_SIZE = 14;
const MIN_FRAMED_ROWS = 5;

export type ReviewOptions<
	ScreenId extends string,
	ActionId extends string,
> = MenuScreenComponentOptions<ScreenId, ActionId> & {
	screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "review" }>;
};

export function createReviewComponent<ScreenId extends string, ActionId extends string>(
	options: ReviewOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	let scrollOffset = 0;
	let lastMaximumScroll = 0;
	let lastViewportSize = reviewViewportSize(options.screen);
	let disposed = false;
	const documentLineCache = createDocumentLineCache(options.theme);

	const moveTo = (offset: number) => {
		scrollOffset = Math.max(0, Math.min(offset, lastMaximumScroll));
		options.tui.requestRender();
	};

	return {
		render(width) {
			const safeWidth = Math.max(1, width);
			const formattedLines = documentLineCache.lines(
				options.screen.content,
				options.screen.format,
				safeWidth,
			);
			const allLines = formattedLines.some(
				(line) => stripVTControlCharacters(line).trim().length > 0,
			)
				? formattedLines
				: [];
			const frame = renderAdaptiveReviewFrame({
				screen: options.screen,
				allLines,
				width: safeWidth,
				terminalRows: options.tui.terminal.rows,
				maximumViewportSize:
					options.screen.viewportSize === "adaptive"
						? undefined
						: Math.min(reviewViewportSize(options.screen), allLines.length),
				scrollOffset,
				theme: options.theme,
				keybindings: options.keybindings,
			});
			scrollOffset = frame.scrollOffset;
			lastMaximumScroll = frame.maximumScroll;
			lastViewportSize = frame.viewportSize;
			return frame.lines;
		},
		invalidate() {
			documentLineCache.invalidate();
		},
		handleInput(data) {
			if (disposed) return;
			if (matchesKey(data, Key.ctrl("c"))) options.onEvent({ kind: "close" });
			else if (options.keybindings.matches(data, "tui.select.cancel")) {
				options.onEvent({ kind: options.screen.hint ?? "back" });
			} else if (options.keybindings.matches(data, "tui.select.up")) {
				moveTo(scrollOffset - 1);
			} else if (options.keybindings.matches(data, "tui.select.down")) {
				moveTo(scrollOffset + 1);
			} else if (options.keybindings.matches(data, "tui.select.pageUp")) {
				moveTo(scrollOffset - lastViewportSize);
			} else if (options.keybindings.matches(data, "tui.select.pageDown")) {
				moveTo(scrollOffset + lastViewportSize);
			} else if (matchesKey(data, Key.home)) moveTo(0);
			else if (matchesKey(data, Key.end)) moveTo(lastMaximumScroll);
			else if (options.screen.confirm && options.keybindings.matches(data, "tui.select.confirm")) {
				options.onEvent({ kind: "activate", itemId: options.screen.confirm.id });
			}
		},
		async waitForPending() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			options.onDispose?.();
		},
	};
}

interface AdaptiveReviewFrameOptions<ActionId extends string> {
	screen: ReviewScreen<ActionId>;
	allLines: readonly string[];
	width: number;
	terminalRows: number;
	maximumViewportSize?: number;
	scrollOffset: number;
	theme: MenuScreenComponentOptions<string, ActionId>["theme"];
	keybindings: MenuKeybindings;
}

interface AdaptiveReviewFrame {
	lines: string[];
	scrollOffset: number;
	maximumScroll: number;
	viewportSize: number;
}

interface AdaptiveReviewChrome {
	header: string[];
	separator: boolean;
	hint: string[];
	showPosition: boolean;
	viewportSize: number;
}

function renderAdaptiveReviewFrame<ActionId extends string>(
	options: AdaptiveReviewFrameOptions<ActionId>,
): AdaptiveReviewFrame {
	const totalRows = componentRows(options.terminalRows);
	const framed = totalRows >= MIN_FRAMED_ROWS;
	const availableRows = framed ? totalRows - 2 : totalRows;
	const destination = options.screen.hint ?? "back";
	const confirmAction = options.screen.confirm ? safeMenuText(options.screen.confirm.label) : "";
	const fullHeader = [
		...wrapTextWithAnsi(
			options.theme.fg("accent", options.theme.bold(safeMenuText(options.screen.title))),
			options.width,
		),
		...(options.screen.lines ?? []).flatMap((line) =>
			wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(line)), options.width),
		),
	].map((line) => truncateToWidth(line, options.width, ""));
	const fullHint = wrapTextWithAnsi(
		options.theme.fg("dim", menuHint(options.keybindings, destination, confirmAction)),
		options.width,
	).map((line) => truncateToWidth(line, options.width, ""));
	const criticalHint = options.theme.fg(
		"dim",
		compactReviewHint(options.keybindings, destination, confirmAction, options.width),
	);

	let chrome =
		options.allLines.length === 0
			? allocateEmptyReviewChrome(availableRows, fullHeader, fullHint, criticalHint)
			: allocateAdaptiveReviewChrome(
					availableRows,
					fullHeader,
					fullHint,
					criticalHint,
					false,
					options.maximumViewportSize,
				);
	if (availableRows >= 4 && options.allLines.length > chrome.viewportSize) {
		chrome = allocateAdaptiveReviewChrome(
			availableRows,
			fullHeader,
			fullHint,
			criticalHint,
			true,
			options.maximumViewportSize,
		);
	}

	const maximumScroll = Math.max(0, options.allLines.length - chrome.viewportSize);
	const scrollOffset = Math.max(0, Math.min(options.scrollOffset, maximumScroll));
	const visible = options.allLines.slice(scrollOffset, scrollOffset + chrome.viewportSize);
	const first = options.allLines.length === 0 ? 0 : scrollOffset + 1;
	const last = Math.min(options.allLines.length, scrollOffset + chrome.viewportSize);
	const position = chrome.showPosition
		? [options.theme.fg("dim", `${first}-${last}/${options.allLines.length}`)]
		: [];
	const contentLines = [
		...chrome.header,
		...(chrome.separator ? [""] : []),
		...visible,
		...position,
		...chrome.hint,
	].map((line) => truncateToWidth(line, options.width, ""));
	const lines = framed
		? [
				renderHorizontalRule(options.width, options.theme),
				...contentLines,
				renderHorizontalRule(options.width, options.theme),
			]
		: contentLines;

	return { lines, scrollOffset, maximumScroll, viewportSize: chrome.viewportSize };
}

function allocateEmptyReviewChrome(
	availableRows: number,
	fullHeader: readonly string[],
	fullHint: readonly string[],
	criticalHint: string,
): AdaptiveReviewChrome {
	if (availableRows <= 0) {
		return { header: [], separator: false, hint: [], showPosition: false, viewportSize: 0 };
	}
	const hint =
		fullHint.length > 0 && fullHint.length < availableRows ? [...fullHint] : [criticalHint];
	const header = fullHeader.slice(0, Math.max(0, availableRows - hint.length));
	return { header, separator: false, hint, showPosition: false, viewportSize: 0 };
}

function allocateAdaptiveReviewChrome(
	availableRows: number,
	fullHeader: readonly string[],
	fullHint: readonly string[],
	criticalHint: string,
	showPosition: boolean,
	maximumViewportSize?: number,
): AdaptiveReviewChrome {
	if (availableRows === 1) {
		return { header: [], separator: false, hint: [], showPosition: false, viewportSize: 1 };
	}
	const compactHeader = [fullHeader[0] ?? ""];
	if (availableRows === 2) {
		return {
			header: [],
			separator: false,
			hint: [criticalHint],
			showPosition: false,
			viewportSize: 1,
		};
	}
	if (availableRows === 3) {
		return {
			header: compactHeader,
			separator: false,
			hint: [criticalHint],
			showPosition: false,
			viewportSize: 1,
		};
	}

	let remainingRows = availableRows - 3 - Number(showPosition);
	const reservedViewportRows = Math.min(remainingRows, Math.max(0, (maximumViewportSize ?? 1) - 1));
	remainingRows -= reservedViewportRows;
	const extraHeaderCount = Math.min(remainingRows, Math.max(0, fullHeader.length - 1));
	const header = [...compactHeader, ...fullHeader.slice(1, 1 + extraHeaderCount)];
	remainingRows -= extraHeaderCount;

	let hint = [criticalHint];
	const fullHintExtraRows = Math.max(0, fullHint.length - 1);
	if (remainingRows > 0 && fullHint.length > 0 && fullHintExtraRows <= remainingRows) {
		hint = [...fullHint];
		remainingRows -= fullHintExtraRows;
	}

	const separator = remainingRows > 0;
	if (separator) remainingRows -= 1;
	return {
		header,
		separator,
		hint,
		showPosition,
		viewportSize: Math.min(
			1 + reservedViewportRows + remainingRows,
			maximumViewportSize === undefined ? Number.POSITIVE_INFINITY : maximumViewportSize,
		),
	};
}

function compactReviewHint(
	keybindings: MenuKeybindings,
	destination: "back" | "close",
	confirmAction: string,
	width: number,
) {
	const confirm = reviewBindingText(keybindings, "tui.select.confirm");
	const cancel = reviewBindingText(keybindings, "tui.select.cancel", "ctrl+c");
	const up = reviewBindingText(keybindings, "tui.select.up");
	const down = reviewBindingText(keybindings, "tui.select.down");
	return fitCompactHintSegments(
		[
			...(cancel ? [`${cancel} ${destination}`] : []),
			...(destination === "back" || !cancel ? ["ctrl+c close"] : []),
			...(confirm && confirmAction ? [`${confirm} ${confirmAction}`] : []),
			...(up || down ? [`${[up, down].filter(Boolean).join("/")} navigate`] : []),
		],
		width,
	);
}

function reviewBindingText(
	keybindings: MenuKeybindings,
	binding: Parameters<MenuKeybindings["getKeys"]>[0],
	excluded?: string,
) {
	return keybindings
		.getKeys(binding)
		.filter((key) => key !== excluded)
		.map((key) => {
			if (key === "up") return "↑";
			if (key === "down") return "↓";
			if (key === "escape") return "esc";
			return safeMenuText(key);
		})
		.filter(Boolean)
		.join("/");
}

export function reviewDialogPages<ActionId extends string>(
	screen: ReviewScreen<ActionId>,
): string[][] {
	return documentDialogPages(screen.content, RPC_DOCUMENT_LINE_WIDTH, reviewDialogPageSize(screen));
}

function reviewViewportSize<ActionId extends string>(screen: ReviewScreen<ActionId>) {
	return typeof screen.viewportSize === "number"
		? screen.viewportSize
		: DEFAULT_REVIEW_VIEWPORT_SIZE;
}

function reviewDialogPageSize<ActionId extends string>(screen: ReviewScreen<ActionId>) {
	return typeof screen.viewportSize === "number"
		? Math.min(screen.viewportSize, RPC_DOCUMENT_PAGE_SIZE)
		: RPC_DOCUMENT_PAGE_SIZE;
}

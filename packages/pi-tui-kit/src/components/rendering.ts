import { stripVTControlCharacters } from "node:util";
import {
	type Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { HorizontalRule } from "../horizontal-rule.js";
import { formatInteractionHints } from "../interaction-hints.js";
import { replaceTerminalControls, safeMenuText } from "../text.js";
import type { ActionMenuItem } from "../types.js";
import type { MenuKeybindings, MenuScreenComponentOptions } from "./contracts.js";

export { safeMenuText } from "../text.js";

export function actionMenuItemPresentation(item: ActionMenuItem<string, string>): {
	label: string;
	description?: string;
} {
	const label = safeMenuText(item.label);
	const description = item.description ? safeMenuText(item.description) : undefined;
	return { label: item.disabled ? `[-] ${label}` : label, description };
}

export function actionMenuUnavailableDescription(
	item: ActionMenuItem<string, string>,
): string | undefined {
	if (!item.disabled) return undefined;
	const reason = safeMenuText(item.disabledReason ?? "");
	return reason ? `Unavailable: ${reason}` : undefined;
}

export function actionMenuDialogLabel(item: ActionMenuItem<string, string>): string {
	const label = safeMenuText(item.label);
	const reason = safeMenuText(item.disabledReason ?? "");
	if (!item.disabled || !reason) return label;
	return `[-] ${label} (unavailable: ${reason})`;
}

interface FrameLayoutOptions {
	compactOverflowText?: string;
	confirmAction?: string;
	hint?: string;
	navigation?: boolean;
	pinnedContentRows?: number;
	priorityTailRows?: number;
}

export function renderFrame<ScreenId extends string, ActionId extends string>(
	title: string,
	lines: readonly string[],
	content: readonly string[],
	destination: "back" | "close",
	width: number,
	options: MenuScreenComponentOptions<ScreenId, ActionId>,
	layout: FrameLayoutOptions = {},
): string[] {
	const safeWidth = Math.max(1, width);
	const rule = renderHorizontalRule(safeWidth, options.theme);
	const confirmAction = layout.confirmAction ?? "select";
	const navigation = layout.navigation ?? true;
	const titleRows = wrapTextWithAnsi(
		options.theme.fg("accent", options.theme.bold(safeMenuText(title))),
		safeWidth,
	);
	const contextRows = lines.flatMap((line) =>
		wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(line)), safeWidth),
	);
	const hintText =
		layout.hint ??
		options.interactionHint ??
		menuHint(options.keybindings, destination, confirmAction, navigation);
	const hintRows = wrapTextWithAnsi(options.theme.fg("dim", hintText), safeWidth);
	const compactFullHintRows = wrapTextWithAnsi(
		options.theme.fg(
			"dim",
			layout.compactOverflowText
				? `${hintText} • ${safeMenuText(layout.compactOverflowText).trim()}`
				: hintText,
		),
		safeWidth,
	);
	const compactHintRow = options.theme.fg(
		"dim",
		compactMenuHint(
			hintText,
			options.keybindings,
			destination,
			confirmAction,
			navigation,
			layout.compactOverflowText,
			safeWidth,
		),
	);
	const fullFrame = [
		rule,
		...titleRows,
		...contextRows,
		...(content.length > 0 ? ["", ...content] : []),
		...hintRows,
		rule,
	];
	const maxRows = componentRows(options.tui.terminal.rows);
	const result =
		fullFrame.length <= maxRows
			? fullFrame
			: compactFrame(
					rule,
					titleRows,
					contextRows,
					content,
					compactFullHintRows,
					compactHintRow,
					maxRows,
					layout.pinnedContentRows ?? 0,
					layout.priorityTailRows ?? 0,
				);
	return result.map((line) => truncateToWidth(line, safeWidth, ""));
}

function compactFrame(
	rule: string,
	titleRows: readonly string[],
	contextRows: readonly string[],
	contentRows: readonly string[],
	hintRows: readonly string[],
	compactHintRow: string,
	maxRows: number,
	pinnedContentRows: number,
	priorityTailRows: number,
): string[] {
	const framed = maxRows >= 5;
	const availableRows = framed ? maxRows - 2 : maxRows;
	const compactContentRows = contentRows.filter(
		(line) => stripVTControlCharacters(line).trim().length > 0,
	);
	const body =
		compactContentRows.length > 0
			? compactInteractiveRows(
					titleRows,
					contextRows,
					compactContentRows,
					hintRows,
					compactHintRow,
					availableRows,
					pinnedContentRows,
					priorityTailRows,
				)
			: compactStaticRows(titleRows, contextRows, compactHintRow, availableRows);
	return framed ? [rule, ...body, rule] : body;
}

function compactInteractiveRows(
	titleRows: readonly string[],
	contextRows: readonly string[],
	contentRows: readonly string[],
	hintRows: readonly string[],
	compactHintRow: string,
	availableRows: number,
	pinnedContentRows: number,
	priorityTailRows: number,
): string[] {
	const hintBudget = compactHintRow && availableRows > 1 ? 1 : 0;
	const minimumContentRows = Math.min(
		availableRows - hintBudget,
		minimumFocusedRows(contentRows, pinnedContentRows, priorityTailRows),
	);
	let remainingRows = Math.max(0, availableRows - hintBudget - minimumContentRows);
	const titleBudget = titleRows.length > 0 && remainingRows > 0 ? 1 : 0;
	remainingRows -= titleBudget;
	const extraHintRows = Math.max(0, hintRows.length - hintBudget);
	const useFullHints = hintBudget > 0 && extraHintRows <= remainingRows;
	if (useFullHints) remainingRows -= extraHintRows;
	const contentBudget = Math.min(contentRows.length, minimumContentRows + remainingRows);
	remainingRows -= contentBudget - minimumContentRows;
	const contextBudget = Math.min(contextRows.length, remainingRows);
	const boundedContent = focusedRows(
		contentRows,
		contentBudget,
		pinnedContentRows,
		priorityTailRows,
	);
	return [
		...titleRows.slice(0, titleBudget),
		...contextRows.slice(0, contextBudget),
		...boundedContent,
		...(hintBudget > 0 ? (useFullHints ? hintRows : [compactHintRow]) : []),
	];
}

function compactStaticRows(
	titleRows: readonly string[],
	contextRows: readonly string[],
	compactHintRow: string,
	availableRows: number,
): string[] {
	if (availableRows <= 0) return [];
	if (availableRows === 1) {
		return [contextRows[0] || compactHintRow || titleRows[0] || ""];
	}
	const hintBudget = compactHintRow ? 1 : 0;
	const minimumContextRows = contextRows.length > 0 ? 1 : 0;
	let remainingRows = Math.max(0, availableRows - hintBudget - minimumContextRows);
	const titleBudget = titleRows.length > 0 && remainingRows > 0 ? 1 : 0;
	remainingRows -= titleBudget;
	const contextBudget = Math.min(contextRows.length, minimumContextRows + remainingRows);
	return [
		...titleRows.slice(0, titleBudget),
		...contextRows.slice(0, contextBudget),
		...(hintBudget > 0 ? [compactHintRow] : []),
	];
}

function minimumFocusedRows(rows: readonly string[], pinnedRows: number, priorityTailRows: number) {
	const priorities = priorityRowIndexes(rows, pinnedRows, priorityTailRows);
	return Math.max(1, priorities.size);
}

function focusedRows(
	rows: readonly string[],
	budget: number,
	pinnedRows = 0,
	priorityTailRows = 0,
): readonly string[] {
	if (budget <= 0) return [];
	if (rows.length <= budget) return rows;
	const indexes = priorityRowIndexes(rows, pinnedRows, priorityTailRows, budget);
	const selectedIndex = selectedRowIndex(rows);
	const fillOrder = Array.from({ length: rows.length }, (_, index) => index).sort((left, right) => {
		if (selectedIndex < 0) return left - right;
		return Math.abs(left - selectedIndex) - Math.abs(right - selectedIndex) || left - right;
	});
	for (const index of fillOrder) {
		if (indexes.size >= budget) break;
		indexes.add(index);
	}
	return [...indexes]
		.sort((left, right) => left - right)
		.map((index) => rows[index])
		.filter((line): line is string => line !== undefined);
}

function priorityRowIndexes(
	rows: readonly string[],
	pinnedRows: number,
	priorityTailRows: number,
	budget = Number.POSITIVE_INFINITY,
) {
	const indexes = new Set<number>();
	const pinned = Math.max(0, Math.min(rows.length, Math.floor(pinnedRows)));
	if (pinned > 0 && indexes.size < budget) indexes.add(0);
	const selectedIndex = selectedRowIndex(rows);
	if (selectedIndex >= 0 && indexes.size < budget) indexes.add(selectedIndex);
	for (let index = 1; index < pinned && indexes.size < budget; index += 1) indexes.add(index);
	const tailStart = Math.max(pinned, rows.length - Math.max(0, Math.floor(priorityTailRows)));
	for (let index = tailStart; index < rows.length && indexes.size < budget; index += 1) {
		indexes.add(index);
	}
	return indexes;
}

function selectedRowIndex(rows: readonly string[]) {
	return rows.findIndex((line) => /^[→›]\s/u.test(stripVTControlCharacters(line)));
}

export function componentRows(rows: number) {
	const terminalRows = Number.isFinite(rows) ? Math.floor(rows) : 24;
	return Math.max(1, terminalRows - 3);
}

export function renderHorizontalRule(
	width: number,
	theme: MenuScreenComponentOptions<string, string>["theme"],
): string {
	return (
		new HorizontalRule({
			ruleStyle: (text) => theme.fg("border", text),
		}).render(Math.max(1, width))[0] ?? ""
	);
}

export function menuHint(
	keybindings: MenuKeybindings,
	destination: "back" | "close",
	confirmAction: string,
	navigation = true,
) {
	return formatInteractionHints(keybindings, [
		...(navigation
			? [{ bindings: ["tui.select.up", "tui.select.down"] as const, label: "navigate" }]
			: []),
		...(confirmAction ? [{ bindings: ["tui.select.confirm"] as const, label: confirmAction }] : []),
		{
			bindings: ["tui.select.cancel"],
			excludeKeys: ["ctrl+c"],
			label: destination,
		},
		...(destination === "back" ? [{ keys: ["ctrl+c"], label: "close" }] : []),
	]);
}

function compactMenuHint(
	hintText: string,
	keybindings: MenuKeybindings,
	destination: "back" | "close",
	confirmAction: string,
	navigation: boolean,
	compactOverflowText: string | undefined,
	width: number,
) {
	const cancel = formatInteractionHints(keybindings, [
		{
			bindings: ["tui.select.cancel"],
			excludeKeys: ["ctrl+c"],
			label: destination,
		},
	]);
	const hardCancel =
		destination === "back" || !cancel
			? formatInteractionHints(keybindings, [{ keys: ["ctrl+c"], label: "close" }])
			: "";
	const confirm = confirmAction
		? formatInteractionHints(keybindings, [
				{ bindings: ["tui.select.confirm"], label: confirmAction },
			])
		: "";
	const navigate = navigation
		? formatInteractionHints(keybindings, [
				{ bindings: ["tui.select.up", "tui.select.down"], label: "navigate" },
			])
		: "";
	const supplied = hintSegments(hintText);
	const groups = {
		cancel: hintSegmentKeys(cancel),
		confirm: hintSegmentKeys(confirm),
		hardCancel: hintSegmentKeys(hardCancel),
		navigate: hintSegmentKeys(navigate),
	};
	const classified = supplied.map((segment) => ({ segment, keys: hintSegmentKeys(segment) }));
	const matching = (keys: ReadonlySet<string>) =>
		classified
			.filter((candidate) => intersects(candidate.keys, keys))
			.map(({ segment }) => segment);
	const cancelSegments = matching(groups.cancel);
	const confirmSegments = matching(groups.confirm);
	const hardCancelSegments = matching(groups.hardCancel);
	const navigationSegments = matching(groups.navigate);
	const claimed = new Set([
		...cancelSegments,
		...confirmSegments,
		...hardCancelSegments,
		...navigationSegments,
	]);
	const remaining = classified.filter(({ segment }) => !claimed.has(segment));
	const keyedCustom = remaining.filter(({ keys }) => keys.size > 0).map(({ segment }) => segment);
	const reminders = remaining.filter(({ keys }) => keys.size === 0).map(({ segment }) => segment);
	return fitCompactHintSegments(
		[
			...(cancelSegments.length > 0 ? cancelSegments : [cancel]),
			...(compactOverflowText ? [safeMenuText(compactOverflowText).trim()] : []),
			...confirmSegments,
			...hardCancelSegments,
			...navigationSegments,
			...keyedCustom,
			...reminders,
		],
		width,
	);
}

function hintSegments(hintText: string) {
	return safeMenuText(hintText)
		.split(/\s+[•·]\s+/u)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function hintSegmentKeys(segment: string) {
	const token = safeMenuText(segment).trim().split(/\s+/u, 1)[0]?.toLowerCase() ?? "";
	const parts = token.split("/");
	return parts.length > 0 && parts.every(isHintKey) ? new Set(parts) : new Set<string>();
}

function isHintKey(value: string) {
	return (
		value.length === 1 ||
		value.includes("+") ||
		[
			"esc",
			"escape",
			"enter",
			"return",
			"space",
			"↑",
			"↓",
			"up",
			"down",
			"pageup",
			"pagedown",
			"home",
			"end",
		].includes(value)
	);
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>) {
	for (const value of left) {
		if (right.has(value)) return true;
	}
	return false;
}

export function fitCompactHintSegments(segments: readonly string[], width: number) {
	const safeWidth = Math.max(1, width);
	let result = "";
	for (const segment of segments.map(safeMenuText).filter(Boolean)) {
		const candidate = result ? `${result} • ${segment}` : segment;
		if (visibleWidth(candidate) > safeWidth) continue;
		result = candidate;
	}
	return result;
}

export function handleSearchInput(input: Input, data: string) {
	input.handleInput(data);
	const value = replaceTerminalControls(input.getValue());
	if (value !== input.getValue()) input.setValue(value);
}

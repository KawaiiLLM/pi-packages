import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	boundReviewText,
	MAX_TRANSCRIPT_USER_CHARS,
	MAX_TRANSCRIPT_ENTRY_CHARS,
	MAX_TRANSCRIPT_RECENT_ENTRIES,
	MAX_TRANSCRIPT_TOOL_CHARS,
	TRUNCATION_MARKER,
} from "./types.ts";

/**
 * A transcript line already reduced to text, with the role kept so the reviewer can
 * tell whose words these are. `[user]` is the only role that carries authorization.
 */
export type TranscriptLine = {
	role: "user" | "assistant" | "tool";
	text: string;
};

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			if (record.type === "image") return "[image omitted]";
			if (record.type === "toolCall" && typeof record.name === "string") {
				const args = record.arguments;
				return `${record.name} ${typeof args === "object" && args ? JSON.stringify(args) : ""}`.trim();
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

/**
 * Flatten session entries into reviewer lines. Non-message entries are skipped,
 * except a compaction summary, which is kept as a `[user]`-adjacent context marker
 * because it is the only surviving view of the older conversation.
 */
export function sessionEntriesToLines(entries: readonly SessionEntry[]): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction" && typeof entry.summary === "string") {
			const summary = boundReviewText(entry.summary, MAX_TRANSCRIPT_ENTRY_CHARS);
			if (summary) lines.push({ role: "assistant", text: `[earlier conversation summary] ${summary}` });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		const text = textOfContent(message.content);
		if (!text) continue;
		if (message.role === "user") lines.push({ role: "user", text });
		else if (message.role === "assistant") lines.push({ role: "assistant", text });
		else if (message.role === "toolResult") lines.push({ role: "tool", text });
	}
	return lines;
}

function renderLine(index: number, line: TranscriptLine): string {
	const body = boundReviewText(line.text, MAX_TRANSCRIPT_ENTRY_CHARS);
	return `[${index}] [${line.role}]: ${body}`;
}

/**
 * Local deviation from Toolkit: split roles before imposing either quota. User
 * messages come from the entire supplied context; other evidence gets a separate
 * budget and entry cap. An assistant preceding a selected user message is given
 * priority as referential context, never relabelled as user authorization.
 *
 * Count bounded, rendered lines (including labels/newlines), not raw text, so a
 * long entry cannot exclude every later entry. Render in original chronology.
 */
export function buildReviewTranscript(
	lines: readonly TranscriptLine[],
	budgets: {
		maxUserChars?: number;
		maxToolChars?: number;
		maxRecentEntries?: number;
	} = {},
): { text: string; omitted: boolean } {
	const maxUserChars = budgets.maxUserChars ?? MAX_TRANSCRIPT_USER_CHARS;
	const maxToolChars = budgets.maxToolChars ?? MAX_TRANSCRIPT_TOOL_CHARS;
	const maxRecentEntries = budgets.maxRecentEntries ?? MAX_TRANSCRIPT_RECENT_ENTRIES;
	for (const budget of [maxUserChars, maxToolChars, maxRecentEntries]) {
		if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError("Transcript budgets must be non-negative integers");
	}

	const userLines: number[] = [];
	const otherLines: number[] = [];
	const precedingAssistant = new Map<number, number>();
	let lastAssistant: number | undefined;
	lines.forEach((line, index) => {
		if (line.role === "user") {
			userLines.push(index);
			if (lastAssistant !== undefined) precedingAssistant.set(index, lastAssistant);
		} else {
			otherLines.push(index);
			if (line.role === "assistant") lastAssistant = index;
		}
	});
	const renderedLines = lines.map((line, index) => renderLine(index + 1, line));
	const selected = new Set<number>();
	let userChars = 0;
	// Keep the current instruction and original task, then other users newest-first.
	const userPriority = [userLines.at(-1), userLines[0], ...userLines.slice(1, -1).reverse()];
	for (const index of userPriority) {
		if (index === undefined || selected.has(index)) continue;
		const cost = renderedLines[index]!.length + 1;
		if (userChars + cost > maxUserChars) continue;
		selected.add(index);
		userChars += cost;
	}

	const notice = `${TRUNCATION_MARKER} conversation entries or text were omitted.`;
	// Reserve notice space inside the other pool, never borrow from the user pool.
	const noticeCost = notice.length + 1;
	const otherBudget = Math.max(0, maxToolChars - noticeCost);
	const contextPriority = [...selected].sort((a, b) => b - a)
		.map(index => precedingAssistant.get(index)).filter((index): index is number => index !== undefined);
	let toolChars = 0;
	let otherCount = 0;
	for (const index of [...contextPriority, ...otherLines.slice(-maxRecentEntries).reverse()]) {
		if (otherCount >= maxRecentEntries) break;
		if (selected.has(index)) continue;
		const cost = renderedLines[index]!.length + 1;
		if (toolChars + cost > otherBudget) continue;
		selected.add(index);
		toolChars += cost;
		otherCount++;
	}

	const ordered = [...selected].sort((a, b) => a - b);
	const omitted = selected.size < lines.length || ordered.some(index =>
		boundReviewText(lines[index]!.text, MAX_TRANSCRIPT_ENTRY_CHARS) !== lines[index]!.text);
	const rendered = ordered.map(index => renderedLines[index]!);
	if (omitted && noticeCost <= maxToolChars) rendered.unshift(notice);
	return { text: rendered.join("\n"), omitted };
}

/**
 * Build the reviewer transcript straight from session entries.
 */
export function transcriptFromEntries(
	entries: readonly SessionEntry[],
	budgets?: Parameters<typeof buildReviewTranscript>[1],
): { text: string; omitted: boolean } {
	return buildReviewTranscript(sessionEntriesToLines(entries), budgets);
}

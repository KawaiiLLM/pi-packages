import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Sum of what one provider's replies cost, at the prices Pi's model registry
 * carries, across every session on disk since `sinceMs`. Session files are
 * append-only and named by start time, but a session opened before the window
 * can still hold replies inside it, so files are screened by mtime and entries
 * by their own timestamp.
 *
 * Forking a session copies its history into the new file, entry ids and all, so
 * a reply is charged the first time it is seen and skipped everywhere after.
 */
export async function sumProviderSpend(
	sessionsDir: string,
	providerId: string,
	sinceMs: number,
	signal?: AbortSignal,
): Promise<number> {
	let total = 0;
	const charged = new Set<string>();
	for await (const file of listSessionFiles(sessionsDir, signal)) {
		signal?.throwIfAborted();
		let modifiedAt: number;
		try {
			modifiedAt = (await stat(file)).mtimeMs;
		} catch {
			signal?.throwIfAborted();
			continue;
		}
		signal?.throwIfAborted();
		if (modifiedAt < sinceMs) continue;
		let text: string;
		try {
			text = await readFile(file, { encoding: "utf8", signal });
		} catch {
			signal?.throwIfAborted();
			continue;
		}
		signal?.throwIfAborted();
		for (const line of text.split("\n")) {
			if (!line.includes('"assistant"')) continue;
			const entry = parseLine(line);
			const cost = entryCost(entry, providerId, sinceMs);
			if (cost === 0) continue;
			if (isRecord(entry) && typeof entry.id === "string") {
				// Entry IDs are short and only unique within one session. Match the
				// original reply as well, without retaining its potentially large content.
				const key = createHash("sha256")
					.update(JSON.stringify([entry.id, entry.timestamp, entry.message]))
					.digest("hex");
				if (charged.has(key)) continue;
				charged.add(key);
			}
			total += cost;
		}
	}
	return total;
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

export function entryCost(entry: unknown, providerId: string, sinceMs: number): number {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return 0;
	const message = entry.message;
	if (message.role !== "assistant" || message.provider !== providerId) return 0;
	const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	if (!Number.isFinite(at) || at < sinceMs) return 0;
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const cost = isRecord(usage?.cost) ? usage.cost.total : undefined;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Discover nested sessions too, without following symlinks or assuming an extension's layout. */
async function* listSessionFiles(
	sessionsDir: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	const directories = [sessionsDir];
	for (let directory = directories.pop(); directory !== undefined; directory = directories.pop()) {
		signal?.throwIfAborted();
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			signal?.throwIfAborted();
			continue;
		}
		signal?.throwIfAborted();
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) directories.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
		}
	}
}

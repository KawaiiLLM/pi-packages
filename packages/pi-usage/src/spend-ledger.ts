import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { entryCost } from "./usage-spend.js";

export type SpendPurpose = "today" | "fiveHour" | "weekly";
const BLOCK = 1024 * 1024;

type Reply = { at: number; provider: string; cost: number; refs: number };
type FileRecord = {
	ino: number;
	size: number;
	mtime: number;
	position: number;
	tail: Buffer;
	keys: Set<string>;
	temporary?: string;
};
type Waiter = {
	resolve: () => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	abort: () => void;
	since: number;
};

function abortError(): Error {
	const error = new Error("Spend ledger update aborted");
	error.name = "AbortError";
	return error;
}
function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function replyFor(
	line: Buffer,
	file: string,
	ino: number,
	position: number,
): [string, Omit<Reply, "refs">] | undefined {
	const text = line.toString("utf8");
	if (!text.includes('"assistant"')) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	const item = entry as Record<string, unknown>;
	const message = item.message as Record<string, unknown> | undefined;
	const provider = message?.provider;
	if (typeof provider !== "string") return undefined;
	const cost = entryCost(entry, provider, Number.NEGATIVE_INFINITY);
	if (cost === 0) return undefined;
	const at = Date.parse(item.timestamp as string);
	const key =
		typeof item.id === "string"
			? `id:${createHash("sha256")
					.update(JSON.stringify([item.id, item.timestamp, item.message]))
					.digest("hex")}`
			: `line:${file}:${ino}:${position}`;
	return [key, { at, provider, cost }];
}

/** One process-local ledger shared by all local spend windows. */
export class SpendLedger {
	private readonly files = new Map<string, FileRecord>();
	private readonly replies = new Map<string, Reply>();
	private readonly purposes = new Map<SpendPurpose, number>();
	private prunedTo: number | undefined;
	private pruneTarget: number | undefined;
	private lastFloor: number | undefined;
	private inFlight: Waiter[] = [];
	private running = false;
	private scheduled = false;
	private pending: Waiter[] = [];
	private controller: AbortController | undefined;
	/** Exposed to tests without leaking session content. */
	get replyCount(): number {
		return this.replies.size;
	}
	constructor(private readonly sessionsDir: string) {}

	update(purpose: SpendPurpose, sinceMs: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError());
		const previous = this.purposes.get(purpose);
		this.purposes.set(purpose, sinceMs);
		if (previous !== undefined && sinceMs > previous) {
			const target = Math.min(...this.purposes.values());
			this.pruneTarget = Math.max(this.pruneTarget ?? Number.NEGATIVE_INFINITY, target);
		}
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal, since: sinceMs, abort: () => {} };
			waiter.abort = () => {
				this.pending = this.pending.filter((item) => item !== waiter);
				reject(abortError());
			};
			signal?.addEventListener("abort", waiter.abort, { once: true });
			this.pending.push(waiter);
			this.schedule();
		});
	}
	release(purpose: SpendPurpose): void {
		this.purposes.delete(purpose);
	}
	sum(providerId: string, sinceMs: number): number {
		let total = 0;
		for (const reply of this.replies.values())
			if (reply.provider === providerId && reply.at >= sinceMs) total += reply.cost;
		return total;
	}
	stop(): void {
		this.controller?.abort();
		for (const waiter of [...this.inFlight, ...this.pending.splice(0)]) {
			waiter.signal?.removeEventListener("abort", waiter.abort);
			waiter.reject(abortError());
		}
	}
	private schedule(): void {
		if (this.running || this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.pending.length) void this.run();
		});
	}
	private async run(): Promise<void> {
		this.running = true;
		const controller = new AbortController();
		this.controller = controller;
		const waiters = this.pending.splice(0);
		this.inFlight = waiters;
		try {
			const floor = this.floor();
			if (this.prunedTo !== undefined && floor < this.prunedTo) {
				this.files.clear();
				this.replies.clear();
				this.prunedTo = undefined;
				this.pruneTarget = undefined;
			}
			this.lastFloor = Math.min(this.lastFloor ?? floor, floor);
			await this.pass(floor, controller.signal);
			controller.signal.throwIfAborted();
			this.prune();
			for (const waiter of waiters) waiter.resolve();
		} catch (error) {
			for (const waiter of waiters) waiter.reject(error);
		} finally {
			for (const waiter of waiters) waiter.signal?.removeEventListener("abort", waiter.abort);
			if (this.controller === controller) this.controller = undefined;
			this.inFlight = [];
			this.running = false;
			this.schedule();
		}
	}
	private floor(): number {
		return Math.min(
			...this.purposes.values(),
			...this.inFlight.map((waiter) => waiter.since),
			...this.pending.map((waiter) => waiter.since),
		);
	}
	private prune(): void {
		if (this.pruneTarget === undefined) return;
		const floor = Math.min(this.pruneTarget, this.floor());
		if (floor <= (this.lastFloor ?? floor)) return;
		this.lastFloor = floor;
		const expired = new Set(
			[...this.replies].filter(([, reply]) => reply.at < floor).map(([key]) => key),
		);
		for (const record of this.files.values()) {
			for (const key of record.keys) {
				if (expired.has(key)) {
					this.remove(key);
					record.keys.delete(key);
				}
			}
			if (record.temporary && expired.has(record.temporary)) {
				this.remove(record.temporary);
				record.temporary = undefined;
			}
		}
		this.prunedTo = floor;
		if (floor === this.pruneTarget) this.pruneTarget = undefined;
	}
	private add(key: string, reply: Omit<Reply, "refs">): void {
		if (this.prunedTo !== undefined && reply.at < this.prunedTo) return;
		const existing = this.replies.get(key);
		if (existing) existing.refs++;
		else this.replies.set(key, { ...reply, refs: 1 });
	}
	private remove(key: string): void {
		const reply = this.replies.get(key);
		if (reply && --reply.refs === 0) this.replies.delete(key);
	}
	private forget(path: string): void {
		const record = this.files.get(path);
		if (!record) return;
		for (const key of record.keys) this.remove(key);
		if (record.temporary) this.remove(record.temporary);
		this.files.delete(path);
	}
	private async pass(floor: number, signal: AbortSignal): Promise<void> {
		const seen = new Set<string>();
		const failed = new Set<string>();
		const directories = [this.sessionsDir];
		while (directories.length) {
			signal.throwIfAborted();
			const directory = directories.pop()!;
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				if (!missing(error)) failed.add(directory);
				continue;
			}
			for (const entry of entries) {
				signal.throwIfAborted();
				const path = join(directory, entry.name);
				if (entry.isDirectory()) directories.push(path);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					seen.add(path);
					let info: Stats;
					try {
						info = await stat(path);
					} catch (error) {
						if (missing(error)) this.forget(path);
						else failed.add(path);
						continue;
					}
					if (info.mtimeMs < floor) continue;
					await this.readFile(path, info.ino, info.size, info.mtimeMs, signal);
				}
			}
		}
		signal.throwIfAborted();
		for (const path of this.files.keys()) {
			if (
				!seen.has(path) &&
				![...failed].some((prefix) => path === prefix || path.startsWith(prefix + sep))
			)
				this.forget(path);
		}
	}
	private async readFile(
		path: string,
		ino: number,
		size: number,
		mtime: number,
		signal: AbortSignal,
	): Promise<void> {
		let previous = this.files.get(path);
		if (previous?.ino === ino && size === previous.position && mtime === previous.mtime) return;
		let handle: FileHandle;
		try {
			handle = await open(path, "r");
		} catch (error) {
			if (missing(error)) this.forget(path);
			return;
		}
		try {
			if (previous && previous.ino === ino && size > previous.position) {
				const length = Math.min(64, previous.position);
				const check = Buffer.alloc(length);
				await handle.read(check, 0, length, previous.position - length);
				if (!check.equals(previous.tail)) previous = undefined;
			} else if (
				previous &&
				(size < previous.position || size === previous.position || previous.ino !== ino)
			)
				previous = undefined;
			const reset = !!this.files.has(path) && !previous;
			const record: FileRecord = previous ?? {
				ino,
				size,
				mtime,
				position: 0,
				tail: Buffer.alloc(0),
				keys: new Set(),
			};
			let position = record.position;
			let pending = Buffer.alloc(0);
			let temporaryReply: [string, Omit<Reply, "refs">] | undefined;
			const staged = new Map<string, Omit<Reply, "refs">>();
			while (position + pending.length < size) {
				signal.throwIfAborted();
				const start = position + pending.length;
				const chunk = Buffer.alloc(Math.min(BLOCK, size - start));
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
				if (!bytesRead) throw new Error("Session file changed during read");
				const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
				const additions: Array<[string, Omit<Reply, "refs">]> = [];
				let offset = 0;
				for (let end = data.indexOf(10, offset); end >= 0; end = data.indexOf(10, offset)) {
					const reply = replyFor(data.subarray(offset, end), path, ino, position + offset);
					if (reply) additions.push(reply);
					offset = end + 1;
				}
				pending = data.subarray(offset);
				const consumed = data.subarray(0, offset);
				if (consumed.length) {
					signal.throwIfAborted();
					if (record.temporary) {
						this.remove(record.temporary);
						record.temporary = undefined;
					}
					for (const [key, reply] of additions)
						if (
							!record.keys.has(key) &&
							(this.prunedTo === undefined || reply.at >= this.prunedTo)
						) {
							if (reset) staged.set(key, reply);
							else this.add(key, reply);
							record.keys.add(key);
						}
					const tail = Buffer.alloc(Math.min(64, record.tail.length + consumed.length));
					if (consumed.length >= tail.length) consumed.copy(tail, 0, consumed.length - tail.length);
					else {
						record.tail.copy(tail, 0, record.tail.length - (tail.length - consumed.length));
						consumed.copy(tail, tail.length - consumed.length);
					}
					record.tail = tail;
					position += consumed.length;
					record.position = position;
					record.size = size;
					record.mtime = mtime;
					if (!reset) this.files.set(path, record);
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (pending.length) {
				const reply = replyFor(pending, path, ino, position);
				if (reply && !record.keys.has(reply[0])) temporaryReply = reply;
			}
			signal.throwIfAborted();
			if (reset) this.forget(path);
			if (record.temporary) this.remove(record.temporary);
			if (
				temporaryReply &&
				(this.prunedTo === undefined || temporaryReply[1].at >= this.prunedTo)
			) {
				this.add(...temporaryReply);
				record.temporary = temporaryReply[0];
			} else record.temporary = undefined;
			record.size = size;
			record.mtime = mtime;
			if (reset) {
				// Reset reads stage their additions locally; commit after the entire read.
				for (const [key, reply] of staged) {
					if (this.prunedTo !== undefined && reply.at < this.prunedTo) record.keys.delete(key);
					else this.add(key, reply);
				}
			}
			this.files.set(path, record);
		} catch {
			if (signal.aborted) throw abortError();
			// Retain the last successfully committed state on transient IO errors.
		} finally {
			await handle.close();
		}
	}
}

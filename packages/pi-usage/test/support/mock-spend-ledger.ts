import { sumProviderSpend } from "../../src/usage-spend.js";

/** Legacy presentation tests keep their controlled scan promises and cancellation assertions.
 * The actual incremental ledger has separate filesystem/concurrency coverage. */
export class SpendLedger {
	private readonly values = new Map<number, number>();
	constructor(private readonly sessionsDir: string) {}
	async update(_purpose: string, since: number, signal?: AbortSignal): Promise<void> {
		const amount = await sumProviderSpend(this.sessionsDir, "openai-codex", since, signal);
		if (!signal?.aborted) this.values.set(since, amount);
	}
	sum(_provider: string, since: number): number {
		return this.values.get(since) ?? 0;
	}
	release(): void {}
	stop(): void {}
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDailySpendRefresher, dailyBudgetPercent } from "./daily-spend.js";
import { isStaleExtensionContextError } from "./query.js";
import {
	type PricedUsageWindow,
	USAGE_REQUEST_SNAPSHOT_EVENT,
	USAGE_SNAPSHOT_EVENT,
	type UsageSnapshot,
	usageModelKey,
} from "./snapshot.js";
import { SpendLedger } from "./spend-ledger.js";
import type { UsageReport } from "./types.js";
import {
	selectUsageWindows,
	type UsageWindow,
	usageWindowDollars,
	usageWindowStart,
} from "./usage-windows.js";

const DAILY_SPEND_ERROR = "Local daily spend scan failed.";

/** Local projection of the orchestrator's already-validated report; never queries a provider. */
export function createSnapshotPublisher(
	events: ExtensionAPI["events"],
	sessionsDir: string,
	fastState: (model: ExtensionContext["model"]) => NonNullable<UsageSnapshot["fast"]>,
) {
	const ledger = new SpendLedger(sessionsDir);
	let terminated = false;
	let context: ExtensionContext | undefined;
	let snapshot: UsageSnapshot | undefined;
	let revision = 0;
	let scan: AbortController | undefined;
	let unsubscribe: (() => void) | undefined;
	let midnightTimer: ReturnType<typeof setTimeout> | undefined;

	const emit = () => {
		if (!snapshot) return;
		snapshot = Object.freeze({
			...snapshot,
			dailyBudgetPercent: dailyBudgetPercent(snapshot.usage, snapshot.dailySpend),
		});
		events.emit(USAGE_SNAPSHOT_EVENT, snapshot);
	};
	const createDaily = () =>
		createDailySpendRefresher({
			sessionsDir,
			ledger,
			onUpdate(dailySpend) {
				if (!snapshot) return;
				snapshot = {
					...snapshot,
					dailySpend: dailySpend && Object.freeze(dailySpend),
					error: dailySpend && snapshot.error === DAILY_SPEND_ERROR ? undefined : snapshot.error,
				};
				emit();
			},
			onError() {
				if (!snapshot) return;
				snapshot = { ...snapshot, error: DAILY_SPEND_ERROR };
				emit();
			},
		});
	let daily = createDaily();
	const cancelScan = () => {
		revision += 1;
		scan?.abort();
		scan = undefined;
	};
	const empty = (ctx: ExtensionContext): UsageSnapshot => ({
		sessionId: ctx.sessionManager.getSessionId(),
		modelKey: usageModelKey(ctx.model),
		fast: Object.freeze({ ...fastState(ctx.model) }),
	});
	const scheduleMidnight = () => {
		if (midnightTimer) clearTimeout(midnightTimer);
		const next = new Date();
		next.setHours(24, 0, 0, 0);
		midnightTimer = setTimeout(
			() => {
				midnightTimer = undefined;
				if (!context || !snapshot) return;
				// Retire yesterday synchronously, before the new day's asynchronous scan.
				snapshot = { ...snapshot, dailySpend: undefined, dailyBudgetPercent: undefined };
				emit();
				daily.refresh(context);
				scheduleMidnight();
			},
			Math.max(1, next.getTime() - Date.now()),
		);
		midnightTimer.unref?.();
	};
	const begin = (ctx: ExtensionContext) => {
		cancelScan();
		const next = empty(ctx);
		if (
			context?.sessionManager !== ctx.sessionManager ||
			snapshot?.sessionId !== next.sessionId ||
			snapshot?.modelKey !== next.modelKey
		) {
			snapshot = undefined;
			daily.stop();
			ledger.release("fiveHour");
			ledger.release("weekly");
			snapshot = next;
		} else {
			snapshot = { ...snapshot, fast: next.fast };
		}
		context = ctx;
		emit();
		daily.refresh(ctx);
	};
	const invalidateAccount = () => {
		cancelScan();
		if (!context) return;
		snapshot = undefined;
		daily.stop();
		ledger.release("fiveHour");
		ledger.release("weekly");
		snapshot = empty(context);
		emit();
		daily.refresh(context);
	};
	return {
		start(ctx: ExtensionContext) {
			if (terminated) {
				daily = createDaily();
				terminated = false;
			}
			context = undefined;
			snapshot = undefined;
			daily.stop();
			unsubscribe?.();
			unsubscribe = events.on(USAGE_REQUEST_SNAPSHOT_EVENT, () => {
				// Replay is memory-only: no auth resolution, provider query, or disk scan.
				if (snapshot) events.emit(USAGE_SNAPSHOT_EVENT, snapshot);
			});
			begin(ctx);
			scheduleMidnight();
		},
		begin,
		invalidateAccount,
		updateFast(ctx: ExtensionContext) {
			if (
				!snapshot ||
				context?.sessionManager !== ctx.sessionManager ||
				snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
				snapshot.modelKey !== usageModelKey(ctx.model)
			)
				return;
			snapshot = { ...snapshot, fast: empty(ctx).fast };
			emit();
		},
		clearUsage(error?: string) {
			cancelScan();
			ledger.release("fiveHour");
			ledger.release("weekly");
			if (!snapshot) return;
			snapshot = { ...snapshot, usage: undefined, error };
			emit();
		},
		refreshDaily(ctx: ExtensionContext) {
			if (
				!snapshot ||
				snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
				snapshot.modelKey !== usageModelKey(ctx.model)
			)
				return;
			daily.refresh(ctx);
		},
		publish(
			ctx: ExtensionContext,
			report: UsageReport,
			stillCurrent: (signal: AbortSignal) => Promise<boolean>,
		) {
			cancelScan();
			if (!snapshot) return;
			const owner = revision;
			const activeLedger = ledger;
			const sessionId = snapshot.sessionId;
			const modelKey = snapshot.modelKey;
			const controller = new AbortController();
			scan = controller;
			const current = () => {
				try {
					return (
						!controller.signal.aborted &&
						owner === revision &&
						ctx.sessionManager.getSessionId() === sessionId &&
						usageModelKey(ctx.model) === modelKey
					);
				} catch (error) {
					if (isStaleExtensionContextError(error)) return false;
					throw error;
				}
			};
			const price = async (
				window: UsageWindow | undefined,
			): Promise<PricedUsageWindow | undefined> => {
				if (!window) return undefined;
				const start = usageWindowStart(window);
				await activeLedger.update(
					window === windows.fiveHour ? "fiveHour" : "weekly",
					start,
					controller.signal,
				);
				if (!current()) return undefined;
				const spent = activeLedger.sum(report.providerId, start);
				return Object.freeze({
					...window,
					spent,
					windowDollars: usageWindowDollars(spent, window.usedPercent),
				});
			};
			const windows =
				report.semantics.kind === "consumer-subscription" ? selectUsageWindows(report) : {};
			if (!windows.fiveHour) ledger.release("fiveHour");
			if (!windows.weekly) ledger.release("weekly");
			void (async () => {
				const [fiveHour, weekly] = await Promise.all([
					price(windows.fiveHour),
					price(windows.weekly),
				]);
				if (!current()) return;
				const verified = await stillCurrent(controller.signal);
				if (!current() || !snapshot) return;
				if (!verified) {
					invalidateAccount();
					return;
				}
				snapshot = {
					...snapshot,
					error: undefined,
					usage:
						fiveHour || weekly
							? Object.freeze({ providerId: report.providerId, fiveHour, weekly })
							: undefined,
				};
				emit();
			})()
				.catch((error: unknown) => {
					if (!current()) return;
					// Never send raw errors: auth/report or file contents may appear in them.
					if (error instanceof Error && error.name === "AbortError") return;
					if (snapshot) {
						snapshot = { ...snapshot, usage: undefined, error: "Usage spend verification failed." };
						emit();
					}
				})
				.finally(() => {
					if (scan === controller) scan = undefined;
				});
		},
		stop() {
			cancelScan();
			unsubscribe?.();
			unsubscribe = undefined;
			if (midnightTimer) clearTimeout(midnightTimer);
			midnightTimer = undefined;
			const previous = snapshot;
			snapshot = undefined;
			daily.stop();
			if (previous) {
				snapshot = { sessionId: previous.sessionId, modelKey: previous.modelKey };
				emit();
			}
			snapshot = undefined;
			context = undefined;
			ledger.stop();
			terminated = true;
		},
	};
}

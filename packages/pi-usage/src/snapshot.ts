import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageWindow } from "./usage-windows.js";

export interface PricedUsageWindow extends UsageWindow {
	/** Local API-price spend since this window opened. */
	readonly spent: number;
	readonly windowDollars?: number;
}

export interface UsageRuntime {
	readonly providerId: string;
	readonly fiveHour?: PricedUsageWindow;
	readonly weekly?: PricedUsageWindow;
}

export interface DailySpend {
	/** Local midnight in Unix milliseconds. */
	readonly day: number;
	readonly providerId: string;
	readonly dollars: number;
}

/** Consumer data only: never credentials, account fingerprints, or provider reports. */
export interface UsageSnapshot {
	readonly sessionId: string;
	readonly modelKey: string;
	readonly usage?: UsageRuntime;
	readonly dailySpend?: DailySpend;
	readonly dailyBudgetPercent?: number;
	readonly fast?: { readonly enabled: boolean; readonly effective: boolean };
	readonly error?: string;
}

export const USAGE_SNAPSHOT_EVENT = "pi-usage:snapshot:v1";
export const USAGE_REQUEST_SNAPSHOT_EVENT = "pi-usage:request-snapshot:v1";

export function usageModelKey(model: ExtensionContext["model"]): string {
	return JSON.stringify([model?.provider, model?.id, model?.api, model?.baseUrl]);
}

/** Subscribe before requesting replay so startup order cannot lose the current value. */
export function subscribeUsageSnapshots(
	events: ExtensionAPI["events"],
	listener: (snapshot: UsageSnapshot) => void,
): () => void {
	const unsubscribe = events.on(USAGE_SNAPSHOT_EVENT, (data) => listener(data as UsageSnapshot));
	events.emit(USAGE_REQUEST_SNAPSHOT_EVENT, undefined);
	return unsubscribe;
}

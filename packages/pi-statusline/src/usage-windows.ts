import type { PricedUsageWindow } from "@narumitw/pi-usage/snapshot";

/** How long each countdown / API-price reading holds. */
export const CAROUSEL_PERIOD_MS = 8_000;

/**
 * `12% (4h 45m)` alternating with `12% ($647)` when the window has a price.
 * Both readings are padded to the same width so the segment does not jitter.
 */
export function formatUsageWindow(
	window: Pick<PricedUsageWindow, "usedPercent" | "resetsAt">,
	windowDollars: number | undefined,
	now: number,
): string {
	const percent = Math.round(window.usedPercent);
	const frames = [`${percent}% (${formatTimeRemaining(minutesUntil(window.resetsAt, now))})`];
	if (windowDollars !== undefined) {
		frames.push(`${percent}% (${formatEstimatedCost(windowDollars)})`);
	}
	return rotateFrames(frames, now, CAROUSEL_PERIOD_MS);
}

export function minutesUntil(epochSeconds: number, now: number): number {
	return Math.round(Math.max(0, epochSeconds * 1000 - now) / 60_000);
}

export function formatTimeRemaining(totalMinutes: number): string {
	if (totalMinutes >= 1440) {
		const days = Math.floor(totalMinutes / 1440);
		const hours = Math.floor((totalMinutes % 1440) / 60);
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}
	if (totalMinutes >= 60) {
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${totalMinutes}m`;
}

/** Whole dollars: the figure is an extrapolation, not an exact price. */
export function formatEstimatedCost(dollars: number): string {
	return dollars >= 1 ? `$${Math.round(dollars)}` : "<$1";
}

export function rotateFrames(frames: readonly string[], now: number, periodMs: number): string {
	const width = Math.max(...frames.map((frame) => frame.length));
	const frame = frames[Math.floor(now / periodMs) % frames.length] ?? "";
	const left = Math.floor((width - frame.length) / 2);
	return frame.padStart(frame.length + left).padEnd(width);
}

import type { ConfigSegmentName, SegmentName } from "./types.js";

export const INFORMATION_PROFILE_NAMES = ["minimal", "balanced", "detailed"] as const;
export type InformationProfileName = (typeof INFORMATION_PROFILE_NAMES)[number];
export type InformationProfile = InformationProfileName | "custom";

export const INFORMATION_PROFILES: Readonly<
	Record<InformationProfileName, readonly SegmentName[]>
> = {
	minimal: ["cwd", "model", "context", "branch"],
	balanced: [
		"cwd",
		"model",
		"thinking",
		"context",
		"cost",
		"branch",
		"tokens",
		"five_hour",
		"weekly",
		"cache",
		"tools",
	],
	detailed: [
		"cwd",
		"model",
		"thinking",
		"context",
		"cost",
		"branch",
		"tokens",
		"five_hour",
		"weekly",
		"cache",
		"tools",
		"provider",
		"time",
	],
};

export function inferInformationProfile(
	segments: readonly ConfigSegmentName[],
): InformationProfile {
	for (const name of INFORMATION_PROFILE_NAMES) {
		const profile = INFORMATION_PROFILES[name];
		if (
			segments.length === profile.length &&
			segments.every((segment, index) => segment === profile[index])
		) {
			return name;
		}
	}
	return "custom";
}

import { hasApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodexResetAuth as resolveCodexAccountAuth } from "./codex-resets.js";
import { abortError, awaitWithDeadline, redactUsageError, sanitizeDisplayText } from "./core.js";
import { createOAuthCredentialCandidateReader } from "./oauth-credential-source.js";
import { fetchProviderJson, isStaleExtensionContextError } from "./query.js";
import { usageModelKey } from "./snapshot.js";

// Contract: openai/codex aee8a55ab6010f1d53e741edec74dbcffa07bcfe.
// client_version is required here; an unversioned request has not been verified.
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000; // Same five-minute lifecycle as usage reports.
const TIMEOUT_MS = 15_000;
const WHOLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export type CodexFastCapability =
	| { kind: "supported"; tier: "priority"; description: string }
	| { kind: "unsupported"; reason: string }
	| { kind: "unknown"; reason: string };

type Catalog = ReadonlyMap<string, CodexFastCapability>;
type CatalogResult = { kind: "catalog"; models: Catalog } | { kind: "unknown"; reason: string };
type PendingCatalog = {
	key: string;
	controller: AbortController;
	promise: Promise<CatalogResult>;
	users: number;
};

/** Retain only slugs and bounded display capabilities, never prompts or raw model records. */
export function parseCodexModelCatalog(payload: unknown): Catalog {
	return parseCatalog(payload);
}

function parseCatalog(payload: unknown, secrets: readonly string[] = []): Catalog {
	const models = new Map<string, CodexFastCapability>();
	const entries = asRecord(payload)?.models;
	if (!Array.isArray(entries)) return models;
	for (const entry of entries) {
		const model = asRecord(entry);
		if (!model || typeof model.slug !== "string" || !model.slug.trim()) continue;
		models.set(
			model.slug,
			Object.freeze(
				models.has(model.slug)
					? unknown("The model catalog contains duplicate model slugs.")
					: parseCapability(model, secrets),
			),
		);
	}
	return models;
}

function parseCapability(
	model: Record<string, unknown>,
	secrets: readonly string[],
): CodexFastCapability {
	const legacy = model.additional_speed_tiers;
	if (
		legacy !== undefined &&
		(!Array.isArray(legacy) || !legacy.every((id) => typeof id === "string"))
	) {
		return unknown("The model catalog contains malformed additional_speed_tiers metadata.");
	}
	const legacyFast = Array.isArray(legacy) && legacy.includes("fast");
	const tiers = model.service_tiers;
	if (tiers === undefined) {
		return unknown(
			legacyFast
				? "Legacy fast metadata does not confirm that the priority service tier can be requested."
				: "The model catalog does not provide structured service_tiers metadata.",
		);
	}
	if (!Array.isArray(tiers))
		return unknown("The model catalog contains malformed service_tiers metadata.");
	const ids = new Set<string>();
	let priority: Record<string, unknown> | undefined;
	for (const value of tiers) {
		const tier = asRecord(value);
		if (
			!tier ||
			typeof tier.id !== "string" ||
			!tier.id.trim() ||
			typeof tier.name !== "string" ||
			typeof tier.description !== "string" ||
			ids.has(tier.id)
		) {
			return unknown("The model catalog contains incomplete or malformed service_tiers metadata.");
		}
		ids.add(tier.id);
		if (tier.id === "priority") priority = tier;
	}
	if (priority) {
		return {
			kind: "supported",
			tier: "priority",
			description: sanitizeDisplayText(
				redactUsageError(priority.description as string, secrets),
				160,
			),
		};
	}
	return legacyFast
		? unknown(
				"Legacy fast metadata conflicts with service_tiers and does not confirm a requestable priority tier.",
			)
		: {
				kind: "unsupported",
				reason: "The model's structured service_tiers do not include priority.",
			};
}

export function createCodexModelCatalog(
	pi: ExtensionAPI,
	options: {
		clientVersion: () => string;
		credentialReader?: (providerId: string) => unknown;
		cacheTtlMs?: number;
		timeoutMs?: number;
	},
): {
	resolve(
		ctx: ExtensionContext,
		signal: AbortSignal,
		force?: boolean,
	): Promise<CodexFastCapability>;
	clear(): void;
} {
	const ttlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Catalog cache TTL must be positive.");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("Catalog timeout must be positive.");
	const candidates = createOAuthCredentialCandidateReader(pi, options.credentialReader);
	let lifecycle = new AbortController();
	let closed = false;
	let scope: { session: ExtensionContext["sessionManager"]; id: string; model: string } | undefined;
	let accountKey: string | undefined;
	let cache: { key: string; models: Catalog; createdAt: number } | undefined;
	let pending: PendingCatalog | undefined;
	let validationOrder = 0;
	let acceptedOrder = 0;

	const discardAccount = () => {
		accountKey = undefined;
		cache = undefined;
		pending?.controller.abort();
		pending = undefined;
	};
	const invalidateQueries = () => {
		lifecycle.abort();
		lifecycle = new AbortController();
		pending?.controller.abort();
		pending = undefined;
		scope = undefined;
	};
	const clear = () => {
		invalidateQueries();
		discardAccount();
	};
	pi.on("session_start", invalidateQueries);
	pi.on("model_select", invalidateQueries);
	pi.on("session_shutdown", () => {
		closed = true;
		clear();
	});

	return {
		clear,
		async resolve(ctx, callerSignal, force = false) {
			if (closed || callerSignal.aborted) throw abortError();
			const session = ctx.sessionManager;
			const id = session.getSessionId();
			const modelKey = usageModelKey(ctx.model);
			if (scope && (scope.session !== session || scope.id !== id || scope.model !== modelKey)) {
				invalidateQueries();
			}
			scope = { session, id, model: modelKey };
			if (!isOfficialCodex(ctx.model)) {
				discardAccount();
				return unknown(
					"Fast capability requires the current official OpenAI Codex Responses model.",
				);
			}
			const slug = ctx.model.id;
			const signal = AbortSignal.any([callerSignal, lifecycle.signal]);
			const startedAt = Date.now();
			const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
			const assertCurrent = () => {
				if (signal.aborted || closed) throw abortError();
				if (session.getSessionId() !== id || usageModelKey(ctx.model) !== modelKey) {
					invalidateQueries();
					throw abortError();
				}
			};
			const validate = async () => {
				assertCurrent();
				const order = ++validationOrder;
				try {
					const auth = await awaitWithDeadline(
						resolveCodexAccountAuth(ctx, undefined, options.credentialReader, candidates),
						signal,
						remaining(),
						"validating Codex model catalog authentication",
					);
					assertCurrent();
					const version = options.clientVersion();
					if (typeof version !== "string" || !WHOLE_VERSION.test(version)) {
						throw new Error("Codex model catalog clientVersion must use major.minor.patch.");
					}
					const key = `${auth.fingerprint}:${version}`;
					// A slower old auth read must never replace a newer observed account.
					if (order < acceptedOrder && key !== accountKey) throw abortError();
					acceptedOrder = Math.max(acceptedOrder, order);
					if (key !== accountKey) {
						discardAccount();
						accountKey = key;
					}
					return { auth, version, key };
				} catch (error) {
					assertCurrent();
					if (isAbort(error) || isStaleExtensionContextError(error)) throw abortError();
					if (order >= acceptedOrder) {
						acceptedOrder = order;
						discardAccount();
					}
					// Auth can fail before a complete secret list exists; do not echo its error.
					throw new Error(
						"Could not validate official Codex OAuth authentication and catalog clientVersion.",
					);
				}
			};

			let entry: PendingCatalog | undefined;
			try {
				const { auth, version, key } = await validate();
				assertCurrent();
				if (key !== accountKey) throw abortError();
				if (!force && cache?.key === key && Date.now() - cache.createdAt < ttlMs) {
					return capabilityFor(cache.models, slug);
				}
				if (!pending) {
					// A failed refresh must not resurrect the previous capability, even after force.
					cache = undefined;
					const controller = new AbortController();
					const url = new URL(CODEX_MODELS_URL);
					url.searchParams.set("client_version", version);
					const promise: Promise<CatalogResult> = fetchProviderJson(
						url.toString(),
						auth,
						controller.signal,
						remaining(),
						"Codex model catalog endpoint",
						{ redirect: "error", maxResponseBytes: MAX_CATALOG_BYTES },
					)
						.then((payload): CatalogResult => {
							return { kind: "catalog", models: parseCatalog(payload, auth.secrets) };
						})
						.catch((error: unknown): CatalogResult => {
							if (controller.signal.aborted || isAbort(error)) throw abortError();
							return unknown(catalogFailureReason(error));
						});
					pending = { key, controller, promise, users: 0 };
				}
				entry = pending;
				entry.users += 1;
				const result = await awaitWithDeadline(
					entry.promise,
					AbortSignal.any([signal, entry.controller.signal]),
					remaining(),
					"fetching the Codex model catalog",
				);
				assertCurrent();
				if (entry.controller.signal.aborted || pending !== entry) throw abortError();
				const current = await validate();
				assertCurrent();
				if (current.key !== entry.key || pending !== entry || entry.controller.signal.aborted)
					throw abortError();
				if (result.kind === "unknown") return result;
				cache = { key, models: result.models, createdAt: Date.now() };
				return capabilityFor(result.models, slug);
			} catch (error) {
				assertCurrent();
				if (isAbort(error) || isStaleExtensionContextError(error)) throw abortError();
				return unknown(redactUsageError(error instanceof Error ? error.message : String(error)));
			} finally {
				if (entry) {
					entry.users -= 1;
					if (entry.users === 0) {
						entry.controller.abort();
						if (pending === entry) pending = undefined;
					}
				}
			}
		},
	};
}

function capabilityFor(models: Catalog, slug: string): CodexFastCapability {
	const capability = models.get(slug);
	return capability
		? { ...capability }
		: unknown("The model catalog does not contain metadata for the current model.");
}

function unknown(reason: string): { kind: "unknown"; reason: string } {
	return { kind: "unknown", reason };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isOfficialCodex(
	model: ExtensionContext["model"],
): model is NonNullable<ExtensionContext["model"]> {
	if (model?.provider !== "openai-codex" || !hasApi(model, "openai-codex-responses")) return false;
	try {
		return new URL(model.baseUrl).origin === "https://chatgpt.com";
	} catch {
		return false;
	}
}

// Transport errors can quote arbitrary response bodies or redirect URLs. Report only
// known failure categories, not provider-controlled text (even before auth is complete).
function catalogFailureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	const status = /^Codex model catalog endpoint returned (\d{3}) /u.exec(message)?.[1];
	if (status) return `Codex model catalog endpoint returned HTTP ${status}.`;
	if (message === `Codex model catalog endpoint response exceeded ${MAX_CATALOG_BYTES} bytes.`) {
		return "Codex model catalog response exceeded the 2 MiB limit.";
	}
	if (message === "Codex model catalog endpoint refused a redirected response.") {
		return "Codex model catalog refused a redirected response.";
	}
	if (message.startsWith("Timed out after ")) return "Codex model catalog request timed out.";
	if (
		message.startsWith("Codex model catalog endpoint returned invalid JSON:") ||
		message === "Codex model catalog endpoint response was not an object."
	) {
		return "Codex model catalog returned malformed JSON metadata.";
	}
	return "Codex model catalog request failed; metadata is unavailable.";
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

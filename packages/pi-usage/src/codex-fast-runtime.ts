import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	codexFastAvailability,
	correctCodexFastMessageCost,
	isOfficialCodexModel,
	rewriteCodexFastPayload,
} from "./codex-fast.js";
import { type CodexFastCapability, createCodexModelCatalog } from "./codex-models.js";
import { abortError, errorMessage } from "./core.js";
import { isStaleExtensionContextError } from "./query.js";
import {
	DEFAULT_CODEX_MODELS_CLIENT_VERSION,
	type UsageSettingsRuntime,
	type UsageSettingsState,
} from "./settings.js";
import { usageModelKey } from "./snapshot.js";
import type { PiModel } from "./types.js";

const NO_FAST_REQUEST = Symbol("no-fast-request");
type PendingFastRequest = { fastRequested: boolean; model: PiModel };

export const FAST_USAGE_WARNING =
	"Fast may use more plan allowance. Prices are Pi estimates; new models' Fast surcharges may be missing.";

export function registerCodexFastMode(
	pi: ExtensionAPI,
	settingsRuntime: UsageSettingsRuntime,
	publishState: (ctx: ExtensionContext) => void,
	options: {
		registerSessionStart?: boolean;
		credentialReader?: (providerId: string) => unknown;
		catalog?: ReturnType<typeof createCodexModelCatalog>;
	} = {},
) {
	let sessionController = new AbortController();
	let generation = 0;
	const pendingFastRequests = new Map<string, PendingFastRequest>();
	const catalog =
		options.catalog ??
		createCodexModelCatalog(pi, {
			clientVersion: () =>
				settingsRuntime.get().settings.codexModelsClientVersion ??
				DEFAULT_CODEX_MODELS_CLIENT_VERSION,
			credentialReader: options.credentialReader,
		});
	let known: { modelKey: string; capability?: CodexFastCapability } | undefined;

	const availability = (model: PiModel | undefined) =>
		codexFastAvailability(
			model,
			settingsRuntime.get().settings.codexFastMode,
			known?.modelKey === usageModelKey(model) ? known.capability : undefined,
		);
	const state = (model: PiModel | undefined) => ({
		enabled: settingsRuntime.get().settings.codexFastMode,
		effective:
			availability(model).kind === "available" && settingsRuntime.get().settings.codexFastMode,
	});
	const refresh = async (ctx: ExtensionContext, callerSignal?: AbortSignal, force = false) => {
		if (!isOfficialCodexModel(ctx.model)) return availability(ctx.model);
		const ownerGeneration = generation;
		const owner = ctx.sessionManager;
		const sessionId = owner.getSessionId();
		const modelKey = usageModelKey(ctx.model);
		const signal = callerSignal
			? AbortSignal.any([callerSignal, sessionController.signal])
			: sessionController.signal;
		signal.throwIfAborted();
		const wasEffective = state(ctx.model).effective;
		known = { modelKey };
		if (wasEffective) publishState(ctx);
		const capability = await catalog.resolve(ctx, signal, force);
		if (
			signal.aborted ||
			generation !== ownerGeneration ||
			owner !== ctx.sessionManager ||
			owner.getSessionId() !== sessionId ||
			usageModelKey(ctx.model) !== modelKey
		)
			throw abortError();
		known = { modelKey, capability };
		if (state(ctx.model).enabled) publishState(ctx);
		return availability(ctx.model);
	};

	const toggle = async (
		ctx: ExtensionCommandContext,
		enabled: boolean,
		callerSignal?: AbortSignal,
	): Promise<boolean> => {
		const ownerGeneration = generation;
		const sessionId = ctx.sessionManager.getSessionId();
		const modelKey = usageModelKey(ctx.model);
		const signal = callerSignal
			? AbortSignal.any([callerSignal, sessionController.signal])
			: sessionController.signal;
		if (settingsRuntime.get().kind === "invalid") {
			ctx.ui.notify(
				"pi-usage.json is invalid; repair it and reload before changing Fast mode.",
				"error",
			);
			return false;
		}
		try {
			// Turning off must remain possible while offline or on an unsupported model.
			if (enabled) {
				const support = await refresh(ctx, signal);
				if (support.kind !== "available") {
					ctx.ui.notify(
						support.kind === "not-codex" ? "Fast requires an OpenAI Codex model." : support.reason,
						"warning",
					);
					return false;
				}
			}
			signal.throwIfAborted();
			await settingsRuntime.update({ codexFastMode: enabled }, signal);
		} catch (error) {
			if (isAbortError(error) || isStaleExtensionContextError(error)) return false;
			ctx.ui.notify(`Could not change Codex Fast mode: ${errorMessage(error)}`, "error");
			return false;
		}
		if (
			signal.aborted ||
			ownerGeneration !== generation ||
			ctx.sessionManager.getSessionId() !== sessionId ||
			usageModelKey(ctx.model) !== modelKey
		)
			return false;
		publishState(ctx);
		ctx.ui.notify(
			enabled
				? `Codex Fast mode enabled. ${FAST_USAGE_WARNING}`
				: "Codex Fast mode disabled; standard routing will be used.",
			"info",
		);
		return true;
	};

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast mode using the current account's model catalog",
		handler: async (args, ctx) => {
			if (args.trim()) {
				if (!ctx.hasUI) throw new Error("/fast does not accept arguments.");
				ctx.ui.notify("/fast does not accept arguments.", "warning");
				return;
			}
			if (!ctx.hasUI) throw new Error("/fast requires TUI or RPC mode.");
			if (ctx.model?.provider !== "openai-codex") {
				ctx.ui.notify("/fast is available only for the active OpenAI Codex model.", "warning");
				return;
			}
			await toggle(ctx, !settingsRuntime.get().settings.codexFastMode);
		},
	});

	const prepareSession = (ctx: ExtensionContext): Promise<void> => {
		const sessionId = ctx.sessionManager.getSessionId();
		generation += 1;
		sessionController.abort();
		catalog.clear();
		known = undefined;
		pendingFastRequests.clear();
		sessionController = new AbortController();
		const ownerGeneration = generation;
		return (async () => {
			let loaded: Readonly<UsageSettingsState>;
			try {
				loaded = await settingsRuntime.reload(sessionController.signal);
			} catch (error) {
				if (sessionController.signal.aborted || ownerGeneration !== generation) return;
				if (ctx.hasUI)
					ctx.ui.notify(`Could not load pi-usage.json: ${errorMessage(error)}`, "warning");
				return;
			}
			if (
				sessionController.signal.aborted ||
				ownerGeneration !== generation ||
				ctx.sessionManager.getSessionId() !== sessionId
			)
				return;
			if (ctx.hasUI && loaded.kind === "invalid") {
				ctx.ui.notify(
					`Invalid pi-usage.json; using defaults without overwriting it. ${loaded.issue}`,
					"warning",
				);
			}
			// Startup performs no catalog GET. /usage, /fast, or an enabled request loads it.
			publishState(ctx);
		})();
	};
	if (options.registerSessionStart !== false)
		pi.on("session_start", async (_event, ctx) => prepareSession(ctx));
	pi.on("model_select", () => {
		known = undefined;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (
			!isOfficialCodexModel(ctx.model) ||
			!isRecord(event.payload) ||
			(typeof event.payload.model === "string" && event.payload.model !== ctx.model.id)
		)
			return undefined;
		const enabled = settingsRuntime.get().settings.codexFastMode;
		const ownerGeneration = generation;
		const requestSignal = ctx.signal;
		const requestSessionId = ctx.sessionManager.getSessionId();
		const key = activeRequestKey(ctx);
		if (key) pendingFastRequests.delete(key);
		let rewritten: unknown;
		try {
			if (enabled) await refresh(ctx, ctx.signal);
			const capability =
				known?.modelKey === usageModelKey(ctx.model) ? known.capability : undefined;
			rewritten = rewriteCodexFastPayload(event.payload, ctx.model, enabled, capability);
		} catch (error) {
			// Pi reports payload-hook errors but otherwise continues with the old payload.
			// Abort the owning run as well, so an unverified Fast request cannot proceed.
			if (
				ownerGeneration === generation &&
				requestSessionId === ctx.sessionManager.getSessionId() &&
				requestSignal === ctx.signal
			)
				void ctx.abort();
			throw error;
		}
		if (key && ctx.model)
			pendingFastRequests.set(key, {
				fastRequested: isRecord(rewritten) && rewritten.service_tier === "priority",
				model: ctx.model,
			});
		return rewritten;
	});
	pi.on("message_end", (event, ctx) => {
		const request = consumeFastRequest(ctx, event.message, pendingFastRequests);
		if (request === NO_FAST_REQUEST) return undefined;
		const message = correctCodexFastMessageCost(
			event.message,
			request.model,
			request.fastRequested,
		);
		return message ? { message: message as never } : undefined;
	});
	pi.on("session_shutdown", async () => {
		generation += 1;
		sessionController.abort();
		catalog.clear();
		known = undefined;
		pendingFastRequests.clear();
		await settingsRuntime.flush();
	});

	return {
		prepareSession,
		availability,
		state,
		refresh,
		toggle,
		invalidate() {
			catalog.clear();
			known = undefined;
		},
	};
}

function activeRequestKey(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	return model ? `${ctx.sessionManager.getSessionId()}:${model.provider}/${model.id}` : undefined;
}
function consumeFastRequest(
	ctx: ExtensionContext,
	message: unknown,
	pending: Map<string, PendingFastRequest>,
): PendingFastRequest | typeof NO_FAST_REQUEST {
	if (!isRecord(message) || message.role !== "assistant") return NO_FAST_REQUEST;
	const key = messageRequestKey(ctx, message);
	if (!key) return NO_FAST_REQUEST;
	const request = pending.get(key);
	pending.delete(key);
	return request ?? NO_FAST_REQUEST;
}
function messageRequestKey(
	ctx: ExtensionContext,
	message: Record<string, unknown>,
): string | undefined {
	if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
	return `${ctx.sessionManager.getSessionId()}:${message.provider}/${message.model}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildDirectionalSessionLabels,
  buildForwardedScopeLabels,
  describeGrantTarget,
} from "#src/presentation/pattern-suggest";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "#src/service/permission-events";
import { buildUiPrompt } from "#src/service/permission-ui-prompt";
import { provenDirectionOf } from "#src/session/approval-grant";
import type { TerminalAuthorizer } from "./authorizer";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "./permission-dialog";
import type {
  PermissionPromptUi,
  PromptPreferences,
  requestPermissionDecision,
} from "./permission-prompt-component";
import type { PromptPermissionDetails } from "./permission-prompter";

/** Dependencies required by {@link LocalUserAuthorizer}. */
export interface LocalUserAuthorizerDeps {
  /** The active session's UI surface (select/input plus the inline `custom` dialog). */
  ui: PermissionPromptUi;
  /** The session run mode; the dispatcher renders the inline dialog only in `"tui"`. */
  mode: ExtensionContext["mode"];
  /** Event bus used for the `permissions:ui_prompt` broadcast. */
  events: PermissionEventBus;
  /** Read live at prompt time so a settings-modal toggle takes effect on the next prompt. */
  getPromptPreferences: () => PromptPreferences;
  /** Capture the current parent run's cancellation signal when an ask arrives. */
  getSignal?: () => AbortSignal | undefined;
  /** Injected for testability; production callers pass the real function. */
  requestPermissionDecision: typeof requestPermissionDecision;
}

/**
 * Authorizer for a session with an active UI: prompt the human here.
 *
 * Emits the `permissions:ui_prompt` broadcast (moved here from
 * `PermissionPrompter`'s `ctx.hasUI` arm) before showing the dialog, so
 * observers know a decision is imminent. This is the single emit site: a
 * forwarded ask carries its provenance on `details.forwarding`, which this
 * class renders (populated `forwarding` context + "(Subagent)" title) so the
 * broadcast stays non-degraded (#292) without a second emission path.
 */
export class LocalUserAuthorizer implements TerminalAuthorizer {
  private tail: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();

  constructor(private readonly deps: LocalUserAuthorizerDeps) {}

  dispose(): void {
    this.lifetime.abort(new Error("Permission session ended"));
  }

  authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    const runSignal = this.lifetime.signal.aborted ? undefined : this.deps.getSignal?.();
    const signal = AbortSignal.any(runSignal
      ? [this.lifetime.signal, runSignal]
      : [this.lifetime.signal]);
    return new Promise((resolve, reject) => {
      const cancel = () => resolve({
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
        decidedBy: { kind: "unavailable", reason: "Permission prompt cancelled" },
      });
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener("abort", cancel, { once: true });
      // One terminal per serving session: direct and forwarded asks share this
      // queue. Only human interaction is serialized, not the model reviewers.
      this.tail = this.tail.then(async () => {
        if (signal.aborted) return;
        emitUiPromptEvent(this.deps.events, buildUiPrompt(details));
        const decision = await this.deps.requestPermissionDecision(
          {
            mode: this.deps.mode,
            ui: this.deps.ui,
            ...this.deps.getPromptPreferences(),
            signal,
          },
          details.forwarding
            ? "Permission Required (Subagent)"
            : "Permission Required",
          details.payload,
          buildRequestOptions(details),
        );
        if (!signal.aborted) resolve(decision);
      }).catch(reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }
}

/**
 * The dialog options this ask offers, composed from three independent groups.
 *
 * The label names what the session grant covers (a gate-supplied one, or one
 * derived from the grants themselves for a path ask). An ask whose grants all
 * prove the same direction additionally offers the both-directions width
 * (#813). A forwarded ask additionally offers the scope choice (subagent vs
 * whole session).
 *
 * They compose rather than exclude: a forwarded path ask offers all three, and
 * an ask that qualifies for none passes `undefined` so the dialog keeps its
 * defaults.
 */
function buildRequestOptions(
  details: PromptPermissionDetails,
): RequestPermissionOptions | undefined {
  const grants = details.sessionApproval?.grants ?? [];
  const direction = provenDirectionOf(grants);
  const widths = direction
    ? buildDirectionalSessionLabels(direction, describeGrantTarget(grants))
    : null;
  const sessionLabel = widths?.sessionLabel ?? details.sessionLabel;

  const options: RequestPermissionOptions = {
    ...(sessionLabel ? { sessionLabel } : {}),
    ...(widths ? { sessionWidth: { label: widths.widenedLabel } } : {}),
    ...(details.forwarding && grants.length > 0
      ? {
          sessionScope: buildForwardedScopeLabels(
            details.forwarding.requesterAgentName,
            grants,
          ),
        }
      : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPermissionsService, type Authorizer } from "@gotgenes/pi-permission-system";
import { getSubagentsService, type SubagentsService } from "@gotgenes/pi-subagents";
import { waitForReview } from "./review.mjs";
import { buildReviewRequest, fullActionEvidence } from "./evidence.mjs";
import { reviewerSystemPrompt } from "./vendor/toolkit/prompt.ts";
import {
  assertReviewerDefinition,
  boundEvidenceResult,
  EVIDENCE_TOOL_NAMES,
  REVIEW_MAX_TURNS,
  SUBAGENT_SOFT_LIMIT,
  reviewerToolPolicy,
  reviewerToolsForTurn,
} from "./reviewer-guard.mjs";

const AGENT = "approver";
const NAME = "model-approver";
const REVIEW_PREFIX = "PI_PERMISSION_REVIEW_REQUEST\n";
const DEADLINE_MS = 120_000;
const isReviewer = (prompt: string) => /<active_agent\s+name="approver"\s*\/>/i.test(prompt);

// Use the same project-over-global agent locations. Fail rather than allow the
// subagent service's unknown-type fallback to create an execution-capable agent.
async function reviewerDefinition(ctx: ExtensionContext) {
  const directories = [join(getAgentDir(), "agents")];
  if (ctx.isProjectTrusted()) directories.push(join(ctx.cwd, ".pi", "agents"));
  let definition: Record<string, unknown> | undefined;
  for (const directory of directories) {
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const matches = files.filter(file => file.toLowerCase() === `${AGENT}.md`);
    if (matches.length > 1) throw new Error("Ambiguous approver definitions");
    if (matches.length) {
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(await readFile(join(directory, matches[0]), "utf8"));
      if (!body.trim()) throw new Error("Approver instructions are empty");
      definition = frontmatter;
    }
  }
  assertReviewerDefinition(definition);
  return definition;
}

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let service: SubagentsService | undefined;
  let dispose: (() => void) | undefined;
  const formatterDisposers: Array<() => void> = [];
  let lifetime = new AbortController();
  let task = "";
  let reviewerMode = false;
  let reviewerTurnIndex = 0;
  const active = new Map<string, SubagentsService>();

  const authorize: Authorizer["authorize"] = async (details, _query, log) => {
    const ctx = context;
    const agents = service;
    const runLifetime = lifetime;
    let childId: string | undefined;
    let verdict = { decision: "defer", reason: "Reviewer unavailable" };
    let transcript: string | undefined;
    try {
      if (!ctx || !agents || runLifetime.signal.aborted || !task || details.agentName?.toLowerCase() === AGENT) {
        throw new Error("No live parent task, or recursive approval request");
      }
      await reviewerDefinition(ctx);
      runLifetime.signal.throwIfAborted();
      // Same context-entry projection as Toolkit. Always use the approving
      // parent's history, not a delegated child's user-role task message.
      const request = buildReviewRequest(ctx.sessionManager.buildContextEntries(), details, ctx.cwd);
      const signal = AbortSignal.any([runLifetime.signal, AbortSignal.timeout(DEADLINE_MS), ...(ctx.signal ? [ctx.signal] : [])]);
      signal.throwIfAborted();
      // pi-subagents' maxTurns is a soft threshold that queues a wrap-up turn.
      // Keep that fallback beyond the exact four-turn boundary enforced below.
      childId = agents.spawn(AGENT,
        REVIEW_PREFIX + request,
        { description: "Permission review", foreground: true, bypassQueue: true, inheritContext: false, maxTurns: SUBAGENT_SOFT_LIMIT });
      active.set(childId, agents);
      log.review("model_approver.started", { requestId: details.requestId, childId });
      const result = await waitForReview(agents, childId, signal);
      signal.throwIfAborted();
      verdict = result.verdict;
      transcript = result.record.outputFile;
    } catch (error) {
      verdict = { decision: "defer", reason: error instanceof Error ? error.message : "Approval cancelled" };
    } finally {
      if (childId) {
        // Failed/invalid reviews also have a native transcript when creation succeeded.
        transcript ??= agents?.getRecord(childId)?.outputFile;
        active.delete(childId);
      }
    }
    // Never grant after reload/session replacement.
    if (runLifetime.signal.aborted) verdict = { decision: "defer", reason: "Parent session ended" };
    // Store correlation only in the existing permission log. Full evidence and
    // model output remain in the native subagent session, including token usage.
    log.review("model_approver.review", {
      requestId: details.requestId, childId, transcript, decision: verdict.decision,
      ...(verdict.decision === "defer" ? { reason: verdict.reason } : {}),
    });
    // Permission-system itself applies the delegation envelope after this return.
    return verdict.decision === "deny" ? { kind: "deny", reason: verdict.reason } : { kind: verdict.decision as "allow" | "defer" };
  };

  function register() {
    if (!context || lifetime.signal.aborted) return;
    const permissions = getPermissionsService(context.sessionManager.getSessionId());
    if (!permissions) return;
    // Install on child nodes as well; permissions forwards the resulting payload.
    // Write/edit need their exact changes, and subagent needs its complete task
    // instead of the permission system's generic 200-character preview. Toolkit
    // still applies the shared 8,000-character action-input bound downstream.
    // Do not overwrite another extension's custom formatter.
    for (const tool of ["write", "edit", "subagent"]) {
      if (!permissions.getToolInputFormatter(tool)) {
        formatterDisposers.push(permissions.registerToolInputFormatter(tool, fullActionEvidence));
      }
    }
    if (context.hasUI && !dispose) dispose = permissions.registerAuthorizer(NAME, authorize);
  }

  const unsubscribe = pi.events.on("permissions:ready", (event: unknown) => {
    const sessionId = (event as { sessionId?: string })?.sessionId;
    if (sessionId === context?.sessionManager.getSessionId()) register();
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    service = getSubagentsService();
    lifetime = new AbortController();
    register();
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (event.prompt.startsWith(REVIEW_PREFIX) || isReviewer(event.systemPrompt)) {
      reviewerMode = true;
      reviewerTurnIndex = 0;
      // The agent definition is only the first boundary. Strip the core's
      // communication tools and any extension tools again before the first call.
      pi.setActiveTools([...EVIDENCE_TOOL_NAMES]);
      // Reuse Toolkit's evidence-enabled policy verbatim. As in Toolkit, the
      // same prompt remains in force when the final request omits tool schemas.
      return { systemPrompt: `${event.systemPrompt}\n\n${reviewerSystemPrompt(true)}` };
    }
    context = ctx;
    task = event.prompt;
  });
  pi.on("turn_start", (event, ctx) => {
    if (!reviewerMode && !isReviewer(ctx.getSystemPrompt())) return;
    reviewerMode = true;
    reviewerTurnIndex = event.turnIndex;
    pi.setActiveTools(reviewerToolsForTurn(event.turnIndex));
    // maxTurns is a graceful subagent limit, not a hard provider-call cap. This
    // defensive stop makes a fifth model turn impossible if another component
    // somehow schedules one after the forced final turn.
    if (event.turnIndex >= REVIEW_MAX_TURNS) ctx.abort();
  });
  pi.on("turn_end", (event, ctx) => {
    if (!reviewerMode && !isReviewer(ctx.getSystemPrompt())) return;
    // Pi snapshots tools for the next provider request before emitting that
    // turn's turn_start. Remove them at the end of investigation turn three so
    // the immediately following (fourth) model request is actually tool-free.
    if (event.turnIndex === REVIEW_MAX_TURNS - 2) pi.setActiveTools([]);
  });
  pi.on("tool_call", (event, ctx) => {
    if (!reviewerMode && !isReviewer(ctx.getSystemPrompt())) return;
    // This runtime check is authoritative: project agent frontmatter and child
    // communication tools cannot widen the reviewer's capability surface.
    return reviewerToolPolicy(event.toolName, reviewerTurnIndex);
  });
  pi.on("tool_result", (event, ctx) => {
    if (!reviewerMode && !isReviewer(ctx.getSystemPrompt())) return;
    // Match Toolkit's evidence-loop result projection and 4,000/1,000-character
    // success/error bounds before the next reviewer request sees the evidence.
    return { content: [{ type: "text", text: boundEvidenceResult(event.content, event.isError) }] };
  });
  pi.on("session_shutdown", () => {
    lifetime.abort(new Error("Parent session ended"));
    for (const [id, agents] of active) agents.abort(id);
    active.clear();
    dispose?.();
    dispose = undefined;
    for (const release of formatterDisposers.splice(0)) release();
    unsubscribe();
    context = undefined;
    service = undefined;
    task = "";
    reviewerMode = false;
    reviewerTurnIndex = 0;
  });
}

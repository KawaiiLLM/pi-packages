import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPermissionsService, type Authorizer } from "@gotgenes/pi-permission-system";
import { getSubagentsService, type SubagentsService } from "@gotgenes/pi-subagents";
import { waitForReview } from "./review.mjs";
import { buildReviewRequest, fullActionEvidence } from "./evidence.mjs";
import { reviewerSystemPrompt } from "./vendor/toolkit/prompt.ts";

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
  if (!definition || definition.tools !== "none" || definition.enabled === false) {
    throw new Error("A valid approver.md with tools: none is required");
  }
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
      childId = agents.spawn(AGENT,
        REVIEW_PREFIX + request,
        { description: "Permission review", foreground: true, bypassQueue: true, inheritContext: false, maxTurns: 2 });
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
    // Do not overwrite another extension's custom formatter.
    for (const tool of ["write", "edit"]) {
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
      // tools:none already removes capability tools. Also remove communication
      // tools so a reviewer cannot ask back while the parent is awaiting it.
      pi.setActiveTools([]);
      // Reuse Toolkit's policy verbatim. No investigation suffix: this child has
      // no tools. Keep policy in source, not a separately maintained prompt copy.
      return { systemPrompt: `${event.systemPrompt}\n\n${reviewerSystemPrompt(false)}` };
    }
    context = ctx;
    task = event.prompt;
  });
  pi.on("tool_call", (_event, ctx) => {
    if (reviewerMode || isReviewer(ctx.getSystemPrompt())) return { block: true, reason: "Approval agents cannot execute tools" };
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
  });
}

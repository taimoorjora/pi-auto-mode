import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { classify } from "./classifier.js";
import { configPath, DEFAULT_CONFIG, loadConfig } from "./config.js";
import { evaluatePolicy } from "./policy.js";
import { projectTranscript } from "./transcript.js";
import type { AutoModeConfig, DecisionRecord } from "./types.js";
import { addUsage } from "./usage.js";

const MAX_RECENT_DENIALS = 20;

interface SessionState {
  enabled: boolean;
  allowed: number;
  denied: number;
  recentDenials: DecisionRecord[];
  repoRoot: string;
  gitRemotes: string[];
}

function initialState(enabled: boolean, cwd: string): SessionState {
  return { enabled, allowed: 0, denied: 0, recentDenials: [], repoRoot: cwd, gitRemotes: [] };
}

function updateStatus(ctx: ExtensionContext, state: SessionState, configError?: string): void {
  ctx.ui.setStatus("pi-auto-mode", !state.enabled ? undefined : configError
    ? "⏵ auto · configuration error · blocked"
    : `⏵ auto · ${state.allowed} allowed · ${state.denied} blocked`);
}

function record(pi: ExtensionAPI, state: SessionState, decision: DecisionRecord): void {
  if (decision.decision === "allow") state.allowed++;
  else {
    state.denied++;
    state.recentDenials.push(decision);
    state.recentDenials = state.recentDenials.slice(-MAX_RECENT_DENIALS);
  }
  pi.appendEntry("pi-auto-mode-decision", decision);
}

async function discoverRepository(pi: ExtensionAPI, cwd: string): Promise<{ repoRoot: string; gitRemotes: string[] }> {
  const root = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 3_000 });
  const repoRoot = root.code === 0 ? root.stdout.trim() : cwd;
  const remotes = await pi.exec("git", ["-C", cwd, "remote", "-v"], { timeout: 3_000 });
  const gitRemotes = remotes.code === 0
    ? [...new Set(remotes.stdout.split("\n").map((line) => line.trim().split(/\s+/)[1]).filter((url): url is string => Boolean(url)))]
    : [];
  return { repoRoot, gitRemotes };
}

export default async function autoModeExtension(pi: ExtensionAPI) {
  const path = configPath();
  let config: AutoModeConfig;
  let configError: string | undefined;
  try {
    config = await loadConfig(path);
  } catch (error) {
    config = structuredClone(DEFAULT_CONFIG);
    configError = error instanceof Error ? error.message : String(error);
  }

  // Invalid configuration is not the same as intentionally disabled mode.
  let state = initialState(Boolean(configError) || config.enabled, process.cwd());
  const pendingUsage = new Map<string, Usage>();

  pi.on("session_start", async (_event, ctx) => {
    state = initialState(Boolean(configError) || config.enabled, ctx.cwd);
    Object.assign(state, await discoverRepository(pi, ctx.cwd));
    updateStatus(ctx, state, configError);
    if (configError && ctx.hasUI) ctx.ui.notify(`Auto mode config error: ${configError}`, "error");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("pi-auto-mode", undefined);
    pendingUsage.clear();
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (!state.enabled) return;
    const base = { toolCallId: event.toolCallId, toolName: event.toolName, timestamp: Date.now() };
    const finish = (decision: Omit<DecisionRecord, keyof typeof base>) => {
      if (decision.decision === "allow") ctx.signal?.throwIfAborted();
      record(pi, state, { ...base, ...decision });
      updateStatus(ctx, state, configError);
      return decision.decision === "allow" ? undefined : {
        block: true as const,
        reason: `Blocked by auto mode (${decision.category}): ${decision.reason}. Choose a safer approach; do not route around this boundary.`,
      };
    };

    try {
      ctx.signal?.throwIfAborted();
      if (configError) return finish({ decision: "deny", source: "error", category: "config_error", reason: configError });
      const plan = await evaluatePolicy(config, event, ctx.cwd, path, ctx.sessionManager.getSessionFile());
      if (plan.kind === "block") return finish({ decision: "deny", source: "rule", category: plan.category, reason: plan.reason });
      if (plan.kind === "allow") return finish({ decision: "allow", source: plan.source, category: plan.category, reason: "Approved without classification" });
      if (plan.ask && !ctx.hasUI) return finish({ decision: "deny", source: "rule", category: "ask_rule", reason: "Approval is required, but no UI is available" });

      let decision: Omit<DecisionRecord, keyof typeof base> = {
        decision: "allow", source: "rule", category: "ask_rule", reason: "Approval required",
      };
      if (plan.classify) {
        const result = await classify(ctx, config, {
          cwd: ctx.cwd,
          trustBoundary: {
            repoRoot: state.repoRoot,
            gitRemotes: state.gitRemotes,
            trustedDomains: config.environment.trustedDomains,
            trustedPaths: config.environment.trustedPaths,
          },
          transcript: projectTranscript(ctx.sessionManager.buildContextEntries(), event.toolCallId, config.classifier.maxTranscriptChars),
          pendingAction: { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, resolvedPath: plan.resolvedPath },
        }, ctx.signal);
        if (result.usage) pendingUsage.set(event.toolCallId, result.usage);
        ctx.signal?.throwIfAborted();
        decision = {
          decision: result.verdict.decision, source: "classifier", category: result.verdict.category,
          reason: result.verdict.reason, model: result.model, latencyMs: result.latencyMs,
        };
        if (decision.decision === "deny") {
          if (ctx.hasUI) {
            const choice = await ctx.ui.select(
              `Auto mode blocked ${event.toolName}\n\n${result.verdict.summary}\n\nReason: ${result.verdict.reason}\n\nAction: ${JSON.stringify(event.input, null, 2)}`,
              ["Allow once", "Deny"], ctx.signal ? { signal: ctx.signal } : {},
            );
            ctx.signal?.throwIfAborted();
            // This explicit approval also satisfies an ask rule; don't prompt twice.
            if (choice === "Allow once") return finish({ ...decision, decision: "allow", source: "user", reason: `User overrode classifier: ${decision.reason}` });
            if (choice === "Deny") decision.source = "user";
          }
          return finish(decision);
        }
      }
      if (plan.ask) {
        const approved = await ctx.ui.confirm("Auto mode approval", `${event.toolName}: ${JSON.stringify(event.input, null, 2)}`, ctx.signal ? { signal: ctx.signal } : {});
        ctx.signal?.throwIfAborted();
        return finish({ ...decision, decision: approved ? "allow" : "deny", source: "user", category: "ask_rule", reason: approved ? "Approved by user" : "Rejected by user" });
      }
      return finish(decision);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return finish({ decision: "deny", source: "error", category: "review_error", reason });
    }
  });

  pi.on("tool_result", (event) => {
    const usage = pendingUsage.get(event.toolCallId);
    if (!usage) return;
    pendingUsage.delete(event.toolCallId);
    return { usage: addUsage(event.usage, usage) };
  });

  pi.registerCommand("auto-mode", {
    description: "Manage the model-based tool safety gate: on, off, status, denials, reload",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") state.enabled = true;
      else if (action === "off") state.enabled = false;
      else if (action === "reload") {
        try {
          config = await loadConfig(path);
          configError = undefined;
          state.enabled = config.enabled;
        } catch (error) {
          configError = error instanceof Error ? error.message : String(error);
          state.enabled = true;
          updateStatus(ctx, state, configError);
          ctx.ui.notify(configError, "error");
          return;
        }
      } else if (action === "denials") {
        ctx.ui.notify(state.recentDenials.length
          ? state.recentDenials.map((item) => `${item.toolName}: ${item.category} — ${item.reason}`).join("\n")
          : "No denials in this session.", "info");
        return;
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /auto-mode on|off|status|denials|reload", "warning");
        return;
      }
      updateStatus(ctx, state, configError);
      const configuredModel = config.classifier.provider && config.classifier.model
        ? `${config.classifier.provider}/${config.classifier.model}` : "current session model";
      ctx.ui.notify(`Auto mode ${state.enabled ? "on" : "off"}; classifier: ${configuredModel}; config: ${path}${configError ? `; error: ${configError}` : ""}`, configError ? "error" : "info");
    },
  });
}

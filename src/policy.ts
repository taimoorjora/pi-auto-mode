import { canonical, isSafeFileAction, normalizeFileAction, WRITE_TOOLS } from "./paths.js";
import { assertActionSize } from "./redact.js";
import { resolveRule } from "./rules.js";
import { checkDeletionBoundary, normalizeShellAction } from "./shell.js";
import type { AutoModeConfig } from "./types.js";

export type PolicyPlan =
  | { kind: "block"; category: string; reason: string }
  | { kind: "allow"; source: "rule" | "safe"; category: string }
  | { kind: "review"; classify: boolean; ask: boolean; resolvedPath?: string | undefined };

export async function evaluatePolicy(
  config: AutoModeConfig,
  action: { toolName: string; input: unknown },
  cwd: string,
  configFile: string,
  sessionFile?: string,
): Promise<PolicyPlan> {
  try {
    assertActionSize({ toolName: action.toolName, input: action.input });
    const file = await normalizeFileAction(action.toolName, action.input, cwd);
    const shell = normalizeShellAction(action.toolName, action.input);
    const protectedFiles = await Promise.all([configFile, ...(sessionFile ? [sessionFile] : [])].map(canonical));
    if (file && WRITE_TOOLS.has(action.toolName) && protectedFiles.includes(file.target)) {
      return { kind: "block", category: "hard_deny", reason: "Auto mode policy and session transcripts cannot be modified by the agent" };
    }
    await checkDeletionBoundary(shell, cwd, protectedFiles);

    const rule = resolveRule(config, action.toolName, action.input);
    if (rule === "deny") return { kind: "block", category: "deny_rule", reason: "Action matches a configured deny rule" };
    const deletion = Boolean(shell?.deletionTargets.length);
    // Classification and approval are independent requirements.
    if (rule === "ask") return { kind: "review", classify: deletion, ask: true, resolvedPath: file?.target };
    if (!deletion && (rule === "allow" || await isSafeFileAction(action.toolName, file))) {
      return { kind: "allow", source: rule === "allow" ? "rule" : "safe", category: rule === "allow" ? "allow_rule" : "safe_local" };
    }
    return { kind: "review", classify: true, ask: false, resolvedPath: file?.target };
  } catch (error) {
    return { kind: "block", category: "hard_deny", reason: error instanceof Error ? error.message : String(error) };
  }
}

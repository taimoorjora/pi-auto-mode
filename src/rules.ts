import type { AutoModeConfig } from "./types.js";

export type RuleDecision = "deny" | "ask" | "allow";

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globMatches(pattern: string, value: string): boolean {
  if (pattern.endsWith(" *") && value.toLowerCase() === pattern.slice(0, -2).toLowerCase()) return true;
  const source = escapeRegex(pattern).replaceAll("*", ".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

export function actionText(toolName: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "url", "file_path"]) {
      if (typeof record[key] === "string") return record[key];
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export function matchesRule(rule: string, toolName: string, input: unknown): boolean {
  const separator = rule.indexOf(":");
  const ruleTool = separator === -1 ? rule : rule.slice(0, separator);
  const pattern = separator === -1 ? "*" : rule.slice(separator + 1);
  return globMatches(ruleTool, toolName) && globMatches(pattern, actionText(toolName, input));
}

export function resolveRule(config: AutoModeConfig, toolName: string, input: unknown): RuleDecision | undefined {
  for (const decision of ["deny", "ask", "allow"] as const) {
    if (config.rules[decision].some((rule) => matchesRule(rule, toolName, input))) return decision;
  }
  return undefined;
}

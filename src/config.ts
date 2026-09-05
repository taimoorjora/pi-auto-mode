import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutoModeConfig } from "./types.js";

export const DEFAULT_CONFIG: AutoModeConfig = {
  enabled: false,
  classifier: {
    timeoutMs: 15_000,
    maxTranscriptChars: 24_000,
  },
  rules: {
    allow: [],
    ask: ["bash:git push *"],
    deny: [],
  },
  environment: {
    trustedDomains: [],
    trustedPaths: [],
  },
};

export function configPath(): string {
  return join(getAgentDir(), "auto-mode.json");
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export async function loadConfig(path = configPath()): Promise<AutoModeConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
  const value = raw as Record<string, unknown>;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const classifier = object(value.classifier, "classifier");
  const rules = object(value.rules, "rules");
  const environment = object(value.environment, "environment");

  const hasProvider = classifier.provider !== undefined;
  const hasModel = classifier.model !== undefined;
  if (hasProvider !== hasModel) throw new Error("classifier.provider and classifier.model must be set together");
  for (const key of ["provider", "model"]) {
    if (classifier[key] !== undefined && (typeof classifier[key] !== "string" || !classifier[key].trim())) {
      throw new Error(`classifier.${key} must be a nonempty string`);
    }
  }

  const timeoutMs = classifier.timeoutMs === undefined ? DEFAULT_CONFIG.classifier.timeoutMs : classifier.timeoutMs;
  const maxTranscriptChars = classifier.maxTranscriptChars === undefined ? DEFAULT_CONFIG.classifier.maxTranscriptChars : classifier.maxTranscriptChars;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("classifier.timeoutMs must be between 1000 and 120000");
  }
  if (typeof maxTranscriptChars !== "number" || !Number.isInteger(maxTranscriptChars) || maxTranscriptChars < 2_000 || maxTranscriptChars > 200_000) {
    throw new Error("classifier.maxTranscriptChars must be between 2000 and 200000");
  }

  return {
    enabled: value.enabled === true,
    classifier: {
      ...(typeof classifier.provider === "string" ? { provider: classifier.provider } : {}),
      ...(typeof classifier.model === "string" ? { model: classifier.model } : {}),
      timeoutMs,
      maxTranscriptChars,
    },
    rules: {
      allow: stringArray(rules.allow, "rules.allow"),
      ask: rules.ask === undefined ? [...DEFAULT_CONFIG.rules.ask] : stringArray(rules.ask, "rules.ask"),
      deny: stringArray(rules.deny, "rules.deny"),
    },
    environment: {
      trustedDomains: stringArray(environment.trustedDomains, "environment.trustedDomains"),
      trustedPaths: stringArray(environment.trustedPaths, "environment.trustedPaths"),
    },
  };
}

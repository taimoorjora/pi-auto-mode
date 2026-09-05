import type { Usage } from "@earendil-works/pi-ai";

export interface AutoModeConfig {
  enabled: boolean;
  classifier: {
    provider?: string;
    model?: string;
    timeoutMs: number;
    maxTranscriptChars: number;
  };
  rules: {
    allow: string[];
    ask: string[];
    deny: string[];
  };
  environment: {
    trustedDomains: string[];
    trustedPaths: string[];
  };
}

export interface ProjectedMessage {
  type: "user" | "tool_call";
  text?: string;
  toolName?: string;
  input?: unknown;
}

export interface ClassificationRequest {
  cwd: string;
  trustBoundary: {
    repoRoot: string;
    gitRemotes: string[];
    trustedDomains: string[];
    trustedPaths: string[];
  };
  transcript: ProjectedMessage[];
  pendingAction: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    resolvedPath?: string | undefined;
  };
}

export interface ClassificationVerdict {
  decision: "allow" | "deny";
  category: string;
  summary: string;
  reason: string;
}

export interface ClassificationResult {
  verdict: ClassificationVerdict;
  usage?: Usage;
  model: string;
  latencyMs: number;
}

export interface DecisionRecord {
  toolCallId: string;
  toolName: string;
  decision: "allow" | "deny";
  source: "safe" | "rule" | "classifier" | "error" | "user";
  category: string;
  reason: string;
  timestamp: number;
  model?: string;
  latencyMs?: number;
}

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_SYSTEM_PROMPT } from "./classifier-prompt.js";
import { assertActionSize, redact } from "./redact.js";
import type { AutoModeConfig, ClassificationRequest, ClassificationResult, ClassificationVerdict } from "./types.js";

function parseVerdict(text: string): ClassificationVerdict {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value: unknown = JSON.parse(trimmed);
  if (!value || typeof value !== "object") throw new Error("verdict is not an object");
  const record = value as Record<string, unknown>;
  if (
    (record.decision !== "allow" && record.decision !== "deny")
    || typeof record.category !== "string"
    || typeof record.summary !== "string"
    || typeof record.reason !== "string"
    || !record.category.trim() || !record.summary.trim() || !record.reason.trim()
  ) {
    throw new Error("verdict does not match the required schema");
  }
  return {
    decision: record.decision,
    category: record.category.slice(0, 80),
    summary: record.summary.slice(0, 300),
    reason: record.reason.slice(0, 500),
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    // Always attach a rejection handler, even if complete() aborted synchronously.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      onAbort();
    }
  });
}

export async function classify(
  ctx: ExtensionContext,
  config: AutoModeConfig,
  request: ClassificationRequest,
  signal?: AbortSignal,
): Promise<ClassificationResult> {
  assertActionSize({ toolName: request.pendingAction.toolName, input: request.pendingAction.input });
  const explicitModel = config.classifier.provider && config.classifier.model;
  const model = explicitModel
    ? ctx.modelRegistry.find(config.classifier.provider!, config.classifier.model!)
    : ctx.model;
  if (!model) throw new Error(explicitModel
    ? `Configured classifier model is unavailable: ${config.classifier.provider}/${config.classifier.model}`
    : "No classifier model is available");
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`no authentication configured for ${model.provider}/${model.id}`);

  const timeoutSignal = AbortSignal.timeout(config.classifier.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const started = Date.now();
  combinedSignal.throwIfAborted();
  const response = await abortable(ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: JSON.stringify(redact(request)) }],
        timestamp: Date.now(),
      }],
    },
    {
      maxTokens: 300,
      signal: combinedSignal,
      cacheRetention: "none",
      sessionId: randomUUID(),
    },
  ), combinedSignal);
  combinedSignal.throwIfAborted();
  if (response.stopReason !== "stop") {
    throw new Error(response.errorMessage ?? `classifier stopped: ${response.stopReason}`);
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return {
    verdict: parseVerdict(text),
    usage: response.usage,
    model: `${model.provider}/${model.id}`,
    latencyMs: Date.now() - started,
  };
}

export { parseVerdict };

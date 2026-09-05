import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProjectedMessage } from "./types.js";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item) && typeof item === "object" && (item as { type?: string }).type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function projectTranscript(entries: readonly SessionEntry[], currentToolCallId: string, maxChars: number): ProjectedMessage[] {
  const projected: ProjectedMessage[] = [];
  let foundCurrent = false;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = textContent(message.content);
      if (text) projected.push({ type: "user", text });
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      if (content.id === currentToolCallId) {
        foundCurrent = true;
        break;
      }
      projected.push({ type: "tool_call", toolName: content.name, input: content.arguments });
    }
    if (foundCurrent) break;
  }

  return trimProjection(projected, maxChars);
}

function size(item: ProjectedMessage): number {
  return JSON.stringify(item).length;
}

export function trimProjection(items: ProjectedMessage[], maxChars: number): ProjectedMessage[] {
  const result: ProjectedMessage[] = [];
  let used = 2; // JSON array brackets

  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    const itemSize = size(item) + (result.length ? 1 : 0);
    if (used + itemSize > maxChars) break;
    result.unshift(item);
    used += itemSize;
  }

  // Keep a contiguous recent suffix; don't resurrect old authorization after
  // dropping newer restrictions. Oversized history entries are omitted whole.
  return result;
}

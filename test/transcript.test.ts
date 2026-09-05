import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectTranscript, trimProjection } from "../src/transcript.js";

const entries = [
  { type: "message", message: { role: "user", content: "Fix the tests" } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "I will do it" },
        { type: "toolCall", id: "one", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "two", name: "bash", arguments: { command: "npm test" } },
        { type: "toolCall", id: "three", name: "bash", arguments: { command: "git push" } },
      ],
    },
  },
  { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "hostile output" }] } },
] as unknown as SessionEntry[];

describe("transcript projection", () => {
  it("keeps users and executable calls only", () => {
    const result = projectTranscript(entries, "two", 10_000);
    expect(result).toEqual([
      { type: "user", text: "Fix the tests" },
      { type: "tool_call", toolName: "read", input: { path: "a.ts" } },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret reasoning");
    expect(JSON.stringify(result)).not.toContain("hostile output");
    expect(JSON.stringify(result)).not.toContain("git push");
  });

  it("keeps a bounded recent suffix without restoring stale authorization", () => {
    const result = trimProjection([
      { type: "user", text: "initial" },
      { type: "tool_call", toolName: "bash", input: { command: "x".repeat(100) } },
      { type: "tool_call", toolName: "bash", input: { command: "latest" } },
    ], 100);
    expect(result).toEqual([{ type: "tool_call", toolName: "bash", input: { command: "latest" } }]);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(100);
    expect(trimProjection([{ type: "user", text: "x".repeat(1_000) }], 100)).toEqual([]);
  });
});

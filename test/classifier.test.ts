import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/classifier.js";
import { redact } from "../src/redact.js";

describe("classifier contract", () => {
  it("parses strict verdicts and fenced JSON", () => {
    expect(parseVerdict('{"decision":"allow","category":"local","summary":"Reads a local file.","reason":"safe"}')).toEqual({
      decision: "allow",
      category: "local",
      summary: "Reads a local file.",
      reason: "safe",
    });
    expect(parseVerdict('```json\n{"decision":"deny","category":"exfiltration","summary":"Uploads a file.","reason":"external"}\n```').decision).toBe("deny");
  });

  it("rejects malformed verdicts", () => {
    expect(() => parseVerdict('{"decision":"maybe"}')).toThrow();
    expect(() => parseVerdict("allow")).toThrow();
    expect(() => parseVerdict('{"decision":"allow","category":"","summary":"","reason":""}')).toThrow();
  });

  it("rejects excessive nesting instead of silently truncating it", () => {
    let value: unknown = "pending action";
    for (let n = 0; n < 34; n++) value = { nested: value };
    expect(() => redact(value)).toThrow("deeply nested");
  });

  it("redacts sensitive keys and common secret shapes", () => {
    const value = redact({ apiKey: "abc", nested: { text: "sk-abcdefghijklmnop" } });
    expect(value).toEqual({ apiKey: "[redacted]", nested: { text: "[redacted]" } });
  });
});

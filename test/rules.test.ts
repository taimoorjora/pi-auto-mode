import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { actionText, globMatches, matchesRule, resolveRule } from "../src/rules.js";

describe("rules", () => {
  it("matches glob patterns across command text", () => {
    expect(globMatches("git push *", "git push origin main")).toBe(true);
    expect(globMatches("git push *", "git push")).toBe(true);
    expect(globMatches("git push *", "git status")).toBe(false);
  });

  it("extracts primary action text", () => {
    expect(actionText("bash", { command: "npm test" })).toBe("npm test");
    expect(actionText("read", { path: "README.md" })).toBe("README.md");
  });

  it("matches tool and action", () => {
    expect(matchesRule("bash:git push *", "bash", { command: "git push origin main" })).toBe(true);
    expect(matchesRule("read:*", "bash", { command: "read notes" })).toBe(false);
  });

  it("uses deny then ask then allow precedence", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.rules = {
      deny: ["bash:git push --force *"],
      ask: ["bash:git push *"],
      allow: ["bash:*"],
    };
    expect(resolveRule(config, "bash", { command: "git push --force origin main" })).toBe("deny");
    expect(resolveRule(config, "bash", { command: "git push origin main" })).toBe("ask");
    expect(resolveRule(config, "bash", { command: "npm test" })).toBe("allow");
  });
});

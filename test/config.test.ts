import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, loadConfig } from "../src/config.js";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-auto-config-"));
  path = join(dir, "config.json");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("configuration", () => {
  it("uses disabled defaults when absent", async () => {
    const config = await loadConfig(path);
    expect(config.enabled).toBe(false);
    expect(config.rules.ask).toContain("bash:git push *");
  });

  it("loads and validates overrides", async () => {
    await writeFile(path, JSON.stringify({ enabled: true, classifier: { timeoutMs: 2000 }, rules: { deny: ["bash:rm *"] } }));
    const config = await loadConfig(path);
    expect(config.enabled).toBe(true);
    expect(config.classifier.timeoutMs).toBe(2000);
    expect(config.rules.deny).toEqual(["bash:rm *"]);
  });

  it.each([
    null, [], { enabled: "true" }, { enabled: 0 }, { classifier: [] }, { classifier: null },
    { rules: "allow" }, { environment: false }, { classifier: { timeoutMs: 1 } },
    { classifier: { timeoutMs: 1000.5 } }, { classifier: { timeoutMs: null } },
    { classifier: { maxTranscriptChars: 2000.5 } }, { classifier: { maxTranscriptChars: null } },
    { classifier: { provider: "test" } }, { classifier: { provider: "", model: "" } },
    { classifier: { provider: 123, model: 456 } }, { rules: { ask: [true] } },
    { environment: { trustedPaths: "*" } },
  ])("rejects invalid configuration %j", async (value) => {
    await writeFile(path, JSON.stringify(value));
    await expect(loadConfig(path)).rejects.toThrow();
  });

  it("does not treat malformed JSON as a missing config", async () => {
    await writeFile(path, "{");
    await expect(loadConfig(path)).rejects.toThrow("Cannot load");
  });

  it("uses Pi's tilde expansion for the agent directory", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/custom-agent");
    expect(configPath()).toBe(join(homedir(), "custom-agent/auto-mode.json"));
  });
});

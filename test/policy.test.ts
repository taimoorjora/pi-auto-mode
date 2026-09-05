import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { evaluatePolicy } from "../src/policy.js";
import { MAX_ACTION_CHARS } from "../src/redact.js";
import { normalizeShellAction } from "../src/shell.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "pi-auto-policy-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const plan = (command: string, rules = {}) => evaluatePolicy(
  { ...structuredClone(DEFAULT_CONFIG), rules: { allow: [], ask: [], deny: [], ...rules } },
  { toolName: "bash", input: { command } }, root, join(root, "policy.json"), join(root, "sessions/current.jsonl"),
);

describe("shell hard boundaries", () => {
  it.each([
    "aws s3 ls", "sudo aws s3 ls", "/usr/local/bin/aws sts get-caller-identity", "npm test && aws s3 ls",
    "(aws s3 ls)", "true & aws s3 ls", "echo $(aws s3 ls)", "env -C /tmp aws s3 ls", "sudo -u root aws s3 ls",
    "a''ws s3 ls", "[a]ws s3 ls", "bash -c 'aws s3 ls'", "cd /tmp && rm -rf unrelated",
    "rm -rf .", "rm ../outside", "rm $TARGET", "rm ~/file", "rm ./*", "rm ./[ab]", "rm ./.*",
    "rm -rf", "rm -rf -- .", "rm --no-preserve-root .", "rm dist\naws s3 ls", "echo hi > policy.json",
    "echo hi # comment", "echo 'unfinished", "A=1 npm test", "echo ok;", "echo ok && && aws s3 ls",
    "ln -s /tmp linked && rm linked/file", "rm dist && npm test",
  ])("blocks %s even when explicitly allowlisted", async (command) => {
    expect(await plan(command, { allow: ["bash:*"] })).toMatchObject({ kind: "block", category: "hard_deny" });
  });

  it.each(["npm test", "git status && git diff", "printf 'hello;world' | wc -c", "echo aws s3 ls"])("classifies supported command %s", async (command) => {
    expect(await plan(command)).toMatchObject({ kind: "review", classify: true, ask: false });
  });

  it("keeps quoted paths together and respects --", () => {
    expect(normalizeShellAction("bash", { command: "rm -rf -- 'build output' -file" })?.deletionTargets).toEqual(["build output", "-file"]);
  });

  it("rejects deletion through symlinks and deletion of policy/session ancestors", async () => {
    await symlink(tmpdir(), join(root, "escape"));
    for (const command of ["rm escape/file", "rm policy.json", "rm -rf sessions"]) {
      expect(await plan(command)).toMatchObject({ kind: "block" });
    }
  });

  it("blocks unsupported PowerShell rather than parsing it as Bash", async () => {
    expect(await evaluatePolicy(DEFAULT_CONFIG, { toolName: "powershell", input: { command: "Get-Item ." } }, root, join(root, "policy.json"))).toMatchObject({ kind: "block" });
  });
});

describe("policy precedence", () => {
  it("always classifies in-project deletion, including allow rules", async () => {
    expect(await plan("rm -rf dist", { allow: ["bash:*"] })).toMatchObject({ kind: "review", classify: true, ask: false });
    expect(await plan("rm -rf dist", { ask: ["bash:*"] })).toMatchObject({ kind: "review", classify: true, ask: true });
  });

  it("resolves deny before ask before allow", async () => {
    expect(await plan("npm test", { deny: ["bash:*"], ask: ["bash:*"], allow: ["bash:*"] })).toMatchObject({ kind: "block", category: "deny_rule" });
    expect(await plan("npm test", { ask: ["bash:*"], allow: ["bash:*"] })).toMatchObject({ kind: "review", classify: false, ask: true });
    expect(await plan("npm test", { allow: ["bash:*"] })).toMatchObject({ kind: "allow", source: "rule" });
  });

  it("blocks oversized inputs even with allow rules", async () => {
    expect(await plan(`echo ${"x".repeat(MAX_ACTION_CHARS)}`, { allow: ["bash:*"] })).toMatchObject({ kind: "block", reason: expect.stringContaining("split") });
  });

  it("classifies protected files and unknown tools, but not ordinary local writes", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".env"), "test");
    for (const action of [{ toolName: "read", input: { path: ".env" } }, { toolName: "custom", input: {} }]) {
      expect(await evaluatePolicy(DEFAULT_CONFIG, action, root, join(root, "policy.json"))).toMatchObject({ kind: "review", classify: true });
    }
    expect(await evaluatePolicy(DEFAULT_CONFIG, { toolName: "write", input: { path: "src/new.ts" } }, root, join(root, "policy.json"))).toMatchObject({ kind: "allow", source: "safe" });
  });
});

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonical, isObviouslySafe, isProtectedPath, isWithin, resolveToolPath } from "../src/paths.js";
import { evaluatePolicy } from "../src/policy.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let dir: string;
let root: string;
let outside: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pi-auto-paths-")));
  root = join(dir, "project");
  outside = join(dir, "outside");
  await mkdir(root);
  await mkdir(outside);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("paths", () => {
  it("checks containment without prefix confusion", () => {
    expect(isWithin("/work/app", "/work/app/src/a.ts")).toBe(true);
    expect(isWithin("/work/app", "/work/application/a.ts")).toBe(false);
  });

  it("recognizes protected paths", () => {
    expect(isProtectedPath("/work/app/.git/config", "/work/app")).toBe(true);
    expect(isProtectedPath("/work/app/.env.local", "/work/app")).toBe(true);
    expect(isProtectedPath("/work/app/src/index.ts", "/work/app")).toBe(false);
  });

  it("allows local files but reviews protected reads and writes", async () => {
    await writeFile(join(root, "a.ts"), "x");
    await writeFile(join(root, ".env"), "test");
    expect(await isObviouslySafe("read", { path: "a.ts" }, root)).toBe(true);
    expect(await isObviouslySafe("write", { path: "new/deep/file" }, root)).toBe(true);
    expect(await isObviouslySafe("write", { path: ".env" }, root)).toBe(false);
    expect(await isObviouslySafe("read", { path: ".env" }, root)).toBe(false);
    expect(await isObviouslySafe("read", { path: "../outside" }, root)).toBe(false);
    expect(await isObviouslySafe("read", { path: "missing" }, root)).toBe(false);
  });

  it("rejects escaping symlinks even through multiple nonexistent parents", async () => {
    await symlink(outside, join(root, "linked"));
    await writeFile(join(outside, "secret"), "test");
    expect(await isObviouslySafe("read", { path: "linked/secret" }, root)).toBe(false);
    expect(await canonical(join(root, "linked/new/deep/file"))).toBe(join(outside, "new/deep/file"));
    expect(await isObviouslySafe("write", { path: "linked/new/deep/file" }, root)).toBe(false);
  });

  it("checks protection on the canonical destination and the supplied path", async () => {
    await writeFile(join(root, ".env"), "test");
    await symlink(join(root, ".env"), join(root, "innocent"));
    await writeFile(join(root, "ordinary"), "test");
    await symlink(join(root, "ordinary"), join(root, ".npmrc"));
    for (const path of ["innocent", ".npmrc"]) {
      expect(await isObviouslySafe("write", { path }, root)).toBe(false);
    }
  });

  it("fails closed for dangling symlinks", async () => {
    await symlink(join(outside, "missing"), join(root, "dangling"));
    await expect(canonical(join(root, "dangling/new/file"))).rejects.toThrow("safely resolve");
  });

  it("matches Pi's tilde, @, URL and Unicode-space normalization", async () => {
    expect(resolveToolPath("@~/file", root)).toBe(join(homedir(), "file"));
    expect(resolveToolPath("~", root)).toBe(homedir());
    expect(resolveToolPath(pathToFileURL(join(outside, "file")).href, root)).toBe(join(outside, "file"));
    expect(resolveToolPath("some\u00a0file", root)).toBe(join(root, "some file"));
    expect(await isObviouslySafe("write", { path: "~/outside.txt" }, root)).toBe(false);
  });

  it("hard-denies policy writes via tilde and symlink aliases even with allow rules", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.rules.allow = ["write:*"];
    const policy = join(homedir(), ".pi/agent/auto-mode.json");
    expect(await evaluatePolicy(config, { toolName: "write", input: { path: "~/.pi/agent/auto-mode.json" } }, root, policy)).toMatchObject({ kind: "block" });
    const localPolicy = join(outside, "policy.json");
    await writeFile(localPolicy, "{}");
    await symlink(localPolicy, join(root, "alias"));
    expect(await evaluatePolicy(config, { toolName: "write", input: { path: "alias" } }, root, localPolicy)).toMatchObject({ kind: "block" });
  });
});

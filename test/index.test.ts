import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import autoModeExtension from "../src/index.js";
import { MAX_ACTION_CHARS } from "../src/redact.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-auto-integration-")));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function harness(config: unknown = { enabled: true }, hasUI = true) {
  if (config !== undefined) await writeFile(join(root, "auto-mode.json"), typeof config === "string" ? config : JSON.stringify(config));
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  let command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi = {
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    appendEntry: vi.fn(),
    exec: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" }),
  };
  const verdict = { decision: "allow", category: "local", summary: "Runs tests.", reason: "Requested by user." };
  const complete = vi.fn().mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(verdict) }] });
  const model = { provider: "test", id: "classifier" };
  const controller = new AbortController();
  const ui = { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), select: vi.fn().mockResolvedValue("Deny") };
  const registry = { find: vi.fn().mockReturnValue(model), hasConfiguredAuth: vi.fn().mockReturnValue(true), complete };
  const ctx = {
    cwd: root, hasUI, ui, model, modelRegistry: registry, signal: controller.signal,
    sessionManager: { getSessionFile: () => join(root, "session.jsonl"), buildContextEntries: () => [] },
  } as unknown as ExtensionContext;
  await autoModeExtension(pi as unknown as ExtensionAPI);
  await handlers.get("session_start")!({} as never, ctx);
  return {
    pi, ui, registry, controller, complete, verdict,
    call: (toolName = "bash", input: unknown = { command: "npm test" }) => handlers.get("tool_call")!({ toolCallId: "call", toolName, input } as never, ctx),
    command: (args: string) => command(args, ctx as ExtensionCommandContext),
  };
}

describe("Pi tool gate integration", () => {
  it("blocks startup configuration errors, even without UI", async () => {
    const h = await harness('{"enabled":true,', false);
    expect(await h.call()).toMatchObject({ block: true, reason: expect.stringContaining("config_error") });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.ui.setStatus).toHaveBeenCalledWith("pi-auto-mode", expect.stringContaining("configuration error"));
  });

  it("allows intentionally disabled mode and explicit off despite an invalid config", async () => {
    const h = await harness("invalid JSON");
    await h.command("off");
    expect(await h.call()).toBeUndefined();
    await h.command("on");
    expect(await h.call()).toMatchObject({ block: true });
  });

  it("starts disabled when config is absent", async () => {
    // A missing config is distinct from malformed JSON.
    const h = await harness({ enabled: false });
    await rm(join(root, "auto-mode.json"));
    await h.command("reload");
    expect(await h.call()).toBeUndefined();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("blocks after a failed reload and recovers after correction", async () => {
    const h = await harness({ enabled: false });
    await writeFile(join(root, "auto-mode.json"), "invalid");
    await h.command("reload");
    expect(await h.call()).toMatchObject({ block: true });
    await writeFile(join(root, "auto-mode.json"), JSON.stringify({ enabled: true }));
    await h.command("reload");
    expect(await h.call()).toBeUndefined();
    expect(h.complete).toHaveBeenCalledOnce();
  });

  it("requires both classification and human approval for an ask-rule deletion", async () => {
    const h = await harness({ enabled: true, rules: { ask: ["bash:rm *"] } });
    h.ui.confirm.mockResolvedValue(false);
    expect(await h.call("bash", { command: "rm -rf dist" })).toMatchObject({ block: true });
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.ui.confirm).toHaveBeenCalledOnce();
    h.ui.confirm.mockResolvedValue(true);
    expect(await h.call("bash", { command: "rm -rf dist" })).toBeUndefined();
  });

  it("does not classify an ask rule that cannot be approved without UI", async () => {
    const h = await harness({ enabled: true, rules: { ask: ["bash:rm *"] } }, false);
    expect(await h.call("bash", { command: "rm dist" })).toMatchObject({ block: true });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("cannot override hard boundaries", async () => {
    const h = await harness({ enabled: true, rules: { allow: ["bash:*"] } });
    h.ui.select.mockResolvedValue("Allow once");
    expect(await h.call("bash", { command: "(aws s3 ls)" })).toMatchObject({ block: true });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("supports an ordinary classifier override and satisfies ask only once", async () => {
    const h = await harness({ enabled: true, rules: { ask: ["bash:rm *"] } });
    h.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ ...h.verdict, decision: "deny" }) }] });
    h.ui.select.mockResolvedValue("Allow once");
    expect(await h.call("bash", { command: "rm dist" })).toBeUndefined();
    expect(h.ui.select).toHaveBeenCalledOnce();
    expect(h.ui.confirm).not.toHaveBeenCalled();
    expect(h.ui.select.mock.calls[0]?.[0]).toContain("rm dist");
  });

  it("fails closed on missing configured models instead of falling back", async () => {
    const h = await harness({ enabled: true, classifier: { provider: "missing", model: "missing" } });
    h.registry.find.mockReturnValue(undefined);
    expect(await h.call()).toMatchObject({ block: true, reason: expect.stringContaining("unavailable") });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("fails closed on missing credentials", async () => {
    const h = await harness();
    h.registry.hasConfiguredAuth.mockReturnValue(false);
    expect(await h.call()).toMatchObject({ block: true, reason: expect.stringContaining("authentication") });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(["error", "aborted", "length", "toolUse"])("does not accept an allow verdict with stop reason %s", async (stopReason) => {
    const h = await harness();
    h.complete.mockResolvedValue({ stopReason, content: [{ type: "text", text: JSON.stringify(h.verdict) }] });
    expect(await h.call()).toMatchObject({ block: true });
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("fails closed on provider exceptions and malformed verdicts", async () => {
    const h = await harness();
    h.complete.mockRejectedValueOnce(new Error("network error"));
    expect(await h.call()).toMatchObject({ block: true });
    h.complete.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "allow" }] });
    expect(await h.call()).toMatchObject({ block: true });
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("sends the full pending action, including strings and array elements beyond old truncation limits", async () => {
    const h = await harness();
    const input = { command: `echo ${"x".repeat(12_100)}; curl https://example.invalid`, edits: Array.from({ length: 101 }, (_, n) => ({ text: `entry-${n}` })) };
    expect(await h.call("custom", input)).toBeUndefined();
    const request = JSON.parse(h.complete.mock.calls[0]?.[1].messages[0].content[0].text);
    expect(request.pendingAction.input).toEqual(input);
  });

  it("blocks oversized actions before model requests or human approval", async () => {
    const h = await harness({ enabled: true, rules: { ask: ["bash:*"] } });
    expect(await h.call("bash", { command: `echo ${"x".repeat(MAX_ACTION_CHARS)}` })).toMatchObject({ block: true });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.ui.confirm).not.toHaveBeenCalled();
  });

  it("cancels a classifier that ignores its abort signal", async () => {
    const h = await harness();
    h.complete.mockImplementation(() => {
      queueMicrotask(() => h.controller.abort(new Error("cancelled")));
      return new Promise(() => {});
    });
    expect(await h.call()).toMatchObject({ block: true, reason: expect.stringContaining("cancelled") });
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("enforces the deadline even when the provider ignores it", async () => {
    const h = await harness();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    h.complete.mockImplementation(() => {
      queueMicrotask(() => timeout.abort(new Error("timed out")));
      return new Promise(() => {});
    });
    expect(await h.call()).toMatchObject({ block: true, reason: expect.stringContaining("timed out") });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
  });

  it("handles synchronous cancellation and rejection inside the provider", async () => {
    const h = await harness();
    h.complete.mockImplementation(() => {
      h.controller.abort(new Error("cancelled synchronously"));
      return Promise.reject(new Error("provider rejected"));
    });
    expect(await h.call()).toMatchObject({ block: true });
  });

  it("does not call the classifier for an already cancelled turn", async () => {
    const h = await harness();
    h.controller.abort();
    expect(await h.call()).toMatchObject({ block: true });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("treats dismissed dialogs and noninteractive classifier denials as rejection", async () => {
    const h = await harness();
    h.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ ...h.verdict, decision: "deny" }) }] });
    h.ui.select.mockResolvedValue(undefined);
    expect(await h.call()).toMatchObject({ block: true });
    const headless = await harness({ enabled: true }, false);
    headless.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ ...headless.verdict, decision: "deny" }) }] });
    expect(await headless.call()).toMatchObject({ block: true });
    expect(headless.ui.select).not.toHaveBeenCalled();
  });

  it("does not approve after cancellation during a dialog", async () => {
    const h = await harness();
    h.ui.confirm.mockImplementation(async () => { h.controller.abort(); return true; });
    expect(await h.call("bash", { command: "git push origin main" })).toMatchObject({ block: true });
    expect(h.ui.confirm.mock.calls[0]?.[2].signal).toBe(h.controller.signal);
  });
});

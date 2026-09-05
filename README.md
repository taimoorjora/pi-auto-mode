# pi-auto-mode

A safety gate for [Pi](https://github.com/earendil-works/pi-mono). Let routine work run without approving every tool call, and review the riskier stuff.

- Ordinary in-project reads and edits run directly.
- Shell commands, network actions, unknown tools, external paths, and protected files go through a separate model request.
- If the model denies a call, you can **Allow once** or **Deny**. Without an interactive UI, it stays blocked.
- Errors and hard-boundary violations stay blocked. No approval override.

**Not a sandbox.** Allowed commands still run with your OS permissions.

## Install

From this repo:

```bash
npm install
npm run build
pi install /absolute/path/to/pi-auto-mode
```

Restart Pi, then enable it for the session:

```text
/auto-mode on
```

Other commands: `/auto-mode off`, `/auto-mode status`, `/auto-mode denials`, `/auto-mode reload`.

## Config

Create `~/.pi/agent/auto-mode.json` (or `$PI_CODING_AGENT_DIR/auto-mode.json` if set):

```json
{
  "enabled": false,
  "classifier": {
    "timeoutMs": 15000,
    "maxTranscriptChars": 24000
  },
  "rules": {
    "allow": ["bash:npm test"],
    "ask": ["bash:git push *"],
    "deny": ["bash:terraform destroy *"]
  },
  "environment": {
    "trustedDomains": [],
    "trustedPaths": []
  }
}
```

By default, review uses the current session model in a separate request. Set `classifier.provider` and `classifier.model` to use another one. That exact model must be available and authenticated; there's no fallback.

No config means auto mode starts off. Invalid config blocks tool calls until you fix it and run `/auto-mode reload`, or explicitly turn the gate off.

### Rules

Rules use `tool-name:glob` and match the original tool input, not the resolved path.

Priority: **hard boundaries → deny → ask → allow → default review**.

- `deny` blocks the call.
- `ask` requires your approval. Without a UI, it blocks.
- `allow` skips model review, except for deletion.

Keep shell allow rules narrow. A glob can match a command chain, and even `npm test` can run arbitrary package scripts.

## Hard boundaries

While enabled, these apply before rules or approval:

- Direct `aws` commands are blocked, including supported wrappers. Run them manually.
- `rm` must be standalone and target explicit paths strictly inside the project. No globs, parent traversal, or deletion of policy/session files or their parent directories.
- File tools cannot write to the auto-mode config or current session transcript, including through symlinks.
- Tool calls over 64,000 serialized characters are blocked, not truncated.

Deletion always needs model review, even with an allow rule. The model is told to require an explicit deletion request, but this is a judgment call, not a guarantee. You can override an ordinary denial; an ask rule never gets skipped just because the model approves.

### Shell restrictions

Shell inspection supports a limited POSIX subset, not full Bash:

- Static, single-line commands and quoted arguments.
- `&&`, `||`, `;`, and pipes between non-deletion commands.
- Option-free `command`, `exec`, `nohup`, `sudo`, and `env` wrappers.

Unsupported syntax is blocked: redirects, background jobs, comments, substitutions, variables, directory changes, nested shells, control flow, and unquoted globs. `$`, backticks, backslashes, parentheses, braces, `~`, and line breaks are rejected even inside quotes. PowerShell and shell review on Windows aren't supported.

If a command doesn't fit, simplify it, use file tools, or run it manually.

## Limits

- Review sees recent user/tool-call history and the full pending action, with recognized secrets redacted. It does not see assistant prose or previous raw tool results. Older context may be omitted.
- Model errors, timeouts, invalid responses, and missing credentials block the call.
- Path checks resolve symlinks, but filesystem changes and parallel calls can still race them.
- The gate sees tool arguments, not what scripts, executables, or other extensions do internally. Indirect AWS calls or deletion aren't reliably intercepted.


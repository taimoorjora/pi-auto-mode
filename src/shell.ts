import { basename, resolve } from "node:path";
import { parse } from "shell-quote";
import { canonical, isWithin } from "./paths.js";

const SEPARATORS = new Set(["&&", "||", ";", "|"]);
const WRAPPERS = new Set(["command", "exec", "nohup", "sudo", "env"]);
const UNSUPPORTED_COMMANDS = new Set([
  "cd", "pushd", "popd", "eval", "source", ".", "bash", "sh", "zsh", "dash", "ksh", "fish",
  "powershell", "pwsh", "cmd", "if", "then", "else", "elif", "fi", "for", "while", "until",
  "do", "done", "case", "esac", "select", "function", "time", "coproc", "!", "[[", "[",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface ShellAction {
  commands: string[][];
  deletionTargets: string[];
}

// This is deliberately a restricted command language, not a Bash AST parser.
// shell-quote handles word quoting and separators. Syntax outside the subset
// is rejected rather than interpreted with regexes or delegated to a model.
export function normalizeShellAction(toolName: string, input: unknown): ShellAction | undefined {
  if (toolName === "powershell") throw new Error("PowerShell is unsupported by auto mode; run it manually");
  if (toolName !== "bash") return undefined;
  if (process.platform === "win32") throw new Error("Shell review is supported only on POSIX systems");
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || !command.trim()) throw new Error("Shell command must be nonempty");
  // Conservative even inside quotes: no substitutions, expansions, grouping,
  // multiline commands, or escaped command names. Ask for a simpler action.
  if (/[\x00-\x08\x0a-\x1f\x7f$`\\(){}~]/.test(command)) {
    throw new Error("Unsupported shell syntax; use static, single-line commands without expansions or grouping");
  }
  if (!/^(?:[^'\"]|'[^']*'|\"[^\"]*\")*$/.test(command)) throw new Error("Unterminated shell quote");
  const commands: string[][] = [];
  let words: string[] = [];
  for (const token of parse(command)) {
    if (typeof token === "string") words.push(token);
    else if ("op" in token && SEPARATORS.has(token.op) && words.length) {
      commands.push(words);
      words = [];
    } else {
      throw new Error("Unsupported shell operator, glob, or comment; use explicit static commands and paths");
    }
  }
  if (!words.length) throw new Error("Incomplete shell command");
  commands.push(words);

  const deletionTargets: string[] = [];
  for (const words of commands) {
    // Reject assignments and option-bearing wrappers: they can change PATH,
    // the working directory, or how the next command is interpreted.
    while (WRAPPERS.has(basename(words[0] ?? ""))) words.shift();
    const executable = words[0];
    if (!executable || executable.startsWith("-") || /[*?\[\]]/.test(executable) || ASSIGNMENT.test(executable)) {
      throw new Error("Shell assignments and wrapper options are unsupported; use a direct command");
    }
    const name = basename(executable).toLowerCase();
    if (name === "aws" || name === "aws.exe") {
      throw new Error("AWS CLI commands are reserved for the user; show the exact command for the user to run manually");
    }
    if (UNSUPPORTED_COMMANDS.has(name)) {
      throw new Error("Shell control flow, directory changes, and nested shells are unsupported; use a direct command");
    }
    if (name !== "rm") continue;
    // Earlier commands could create/retarget symlinks after this preflight.
    if (commands.length !== 1) throw new Error("Run rm as a standalone command, separate from other actions");
    let options = true;
    const targets: string[] = [];
    for (const word of words.slice(1)) {
      if (options && word === "--") { options = false; continue; }
      if (options && word.startsWith("-")) {
        if (!/^-[firdvIPRW]+$/.test(word) && !["--force", "--recursive", "--dir", "--verbose", "--interactive", "--preserve-root", "--one-file-system"].includes(word)) {
          throw new Error("Unsupported rm option; use explicit static targets");
        }
      } else {
        if (!word || /[*?\[\]]/.test(word) || word.split("/").includes("..")) throw new Error("rm targets must be static paths inside the current project, without globs or parent traversal");
        targets.push(word);
      }
    }
    if (!targets.length) throw new Error("rm targets must be explicit and inside the current project");
    deletionTargets.push(...targets);
  }
  return { commands, deletionTargets };
}

export async function checkDeletionBoundary(shell: ShellAction | undefined, cwd: string, protectedFiles: string[]): Promise<void> {
  if (!shell?.deletionTargets.length) return;
  const root = await canonical(cwd);
  for (const value of shell.deletionTargets) {
    const target = await canonical(resolve(cwd, value));
    if (target === root || !isWithin(root, target)) {
      throw new Error("rm may only delete targets inside the current project, never the project root itself");
    }
    if (protectedFiles.some((file) => isWithin(target, file))) {
      throw new Error("Auto mode policy and session transcripts cannot be deleted by the agent");
    }
  }
}

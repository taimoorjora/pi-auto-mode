import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
export const WRITE_TOOLS = new Set(["edit", "write"]);
const PROTECTED_SEGMENTS = new Set([".git", ".pi", ".claude", ".ssh"]);
const PROTECTED_FILES = new Set([
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".gitconfig", ".gitmodules",
  ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".envrc", ".mcp.json",
]);

// New files may have several missing parents. Never fall back to a lexical
// containment check, and never treat a dangling symlink as a missing directory.
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat) throw new Error(`Cannot safely resolve path: ${path}`);
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Matches Pi's built-in file-tool normalization (not shell path expansion).
export function resolveToolPath(value: string, cwd: string): string {
  let path = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !path.includes("\\")) {
    const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) path = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(cwd, path);
}

export function extractPath(toolName: string, input: unknown, cwd: string): string | undefined {
  if (!PATH_TOOLS.has(toolName) || !input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>).path;
  if (value === undefined && ["grep", "find", "ls"].includes(toolName)) return cwd;
  if (typeof value !== "string" || !value) throw new Error("File tool requires a nonempty path");
  return resolveToolPath(value, cwd);
}

export function isProtectedPath(path: string, cwd: string): boolean {
  const segments = relative(cwd, path).split(sep);
  const base = segments.at(-1)?.toLowerCase() ?? "";
  return segments.some((part) => PROTECTED_SEGMENTS.has(part.toLowerCase())) || PROTECTED_FILES.has(base) || base === ".env" || base.startsWith(".env.");
}

export interface FileAction {
  path: string;
  target: string;
  root: string;
  protected: boolean;
}

export async function normalizeFileAction(toolName: string, input: unknown, cwd: string): Promise<FileAction | undefined> {
  const path = extractPath(toolName, input, cwd);
  if (!path) return undefined;
  const [root, target] = await Promise.all([canonical(cwd), canonical(path)]);
  return { path, target, root, protected: isProtectedPath(path, cwd) || isProtectedPath(target, root) };
}

export async function isSafeFileAction(toolName: string, file: FileAction | undefined): Promise<boolean> {
  if (!file || !isWithin(file.root, file.target) || file.protected) return false;
  if (WRITE_TOOLS.has(toolName)) return true;
  // Pi's read tool can try alternate Unicode filenames when the supplied path
  // is missing. Don't auto-approve an unresolved read of a different target.
  try {
    await realpath(file.path);
    return true;
  } catch {
    return false;
  }
}

export async function isObviouslySafe(toolName: string, input: unknown, cwd: string): Promise<boolean> {
  return isSafeFileAction(toolName, await normalizeFileAction(toolName, input, cwd));
}

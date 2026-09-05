const SENSITIVE_KEY = /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g;

export const MAX_ACTION_CHARS = 64_000;

export function assertActionSize(action: unknown): void {
  const serialized = JSON.stringify(action);
  if (!serialized || serialized.length > MAX_ACTION_CHARS) {
    throw new Error(`Action exceeds the ${MAX_ACTION_CHARS}-character review limit; split it into smaller calls`);
  }
}

// Redact secrets, never silently discard executable content. Excessive nesting
// is an error so the caller blocks rather than classifying an incomplete action.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Action or context is too deeply nested to review");
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1)]),
  );
}

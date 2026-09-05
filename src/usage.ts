import type { Usage } from "@earendil-works/pi-ai";

export function addUsage(left: Usage | undefined, right: Usage): Usage {
  if (!left) return right;
  const reasoning = (left.reasoning ?? 0) + (right.reasoning ?? 0);
  const cacheWrite1h = (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0);
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
    ...(left.reasoning !== undefined || right.reasoning !== undefined ? { reasoning } : {}),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

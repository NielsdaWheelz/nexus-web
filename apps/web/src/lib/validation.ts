// Cross-cutting boundary validation primitives. Type guards and predicates
// that callers reach for when narrowing an `unknown` from an external surface
// (URL params, JSON payloads, SSE frames) into something the domain trusts.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Generate a unique opaque ID using crypto.randomUUID when available, with a
 * timestamp-plus-random fallback for environments that lack it.
 *
 * When `prefix` is provided, the returned ID is `${prefix}-${id}` regardless
 * of which path runs.
 */
export function createRandomId(prefix?: string): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${id}` : id;
}

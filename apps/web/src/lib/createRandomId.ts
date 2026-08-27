/** Generate a secure opaque ID, optionally prefixed for diagnostics. */
export function createRandomId(prefix?: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure random UUID generation is unavailable");
  }
  const id = globalThis.crypto.randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}

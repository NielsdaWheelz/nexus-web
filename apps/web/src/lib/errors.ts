// Cross-cutting error predicates. Use these instead of re-typing `instanceof
// DOMException && error.name === "AbortError"` at each catch site.

// True when an error is an AbortController/AbortSignal abort. Accepts both
// DOMException("AbortError") (the browser/SDK shape) and plain objects whose
// `name` is `AbortError` or Node's `ResponseAborted` (used inside server
// fetch/proxy code paths).
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }
  const name = error.name;
  return name === "AbortError" || name === "ResponseAborted";
}

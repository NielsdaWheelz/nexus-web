// One total deadline covering any bounded auth/internal HTTP operation a route
// handler issues toward Supabase or FastAPI. A per-fetch abort is not a
// substitute: a chain of internal calls under the same operation must share
// this single budget (see docs/rules/layers.md).
export const AUTH_OPERATION_DEADLINE_MS = 5_000;

export function makeAuthOperationTimeoutError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

// Single-shot bounded fetch. Callers wrap the await in try/catch to map an
// AbortError or other failure into their route-specific failure response.
export async function boundedAuthFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMessage: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(makeAuthOperationTimeoutError(timeoutMessage));
  }, AUTH_OPERATION_DEADLINE_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

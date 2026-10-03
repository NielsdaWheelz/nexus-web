// auth transport budget, also used by the sdk's separate deadline owner.
export const AUTH_OPERATION_DEADLINE_MS = 5_000;

export function makeAuthOperationTimeoutError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

// one request deadline; the native signal stays attached through body transfer.
export async function boundedAuthFetch(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(AUTH_OPERATION_DEADLINE_MS),
  });
}

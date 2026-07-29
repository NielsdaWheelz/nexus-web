import {
  ApiError,
  isApiError,
  isSameSystemApiDefect,
  isUnauthenticatedApiError,
} from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

function normalizeRequestError(error: unknown): ApiError {
  return isApiError(error)
    ? error
    : new ApiError(
        0,
        "E_NETWORK",
        error instanceof Error ? error.message : "Request failed",
      );
}

function retryDelay(attempt: number): number {
  const delay = Math.min(
    BASE_DELAY_MS * 2 ** (attempt - 1),
    MAX_DELAY_MS,
  );
  return delay * (0.75 + Math.random() * 0.5);
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", abort, { once: true });

    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
  });
}

/**
 * The browser GET retry policy: three total attempts with cancellable,
 * jittered exponential backoff. Client errors and same-system response defects
 * are never retried.
 */
export async function requestWithRetry<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await request(signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw error;
      }
      const unauthenticated = Boolean(isUnauthenticatedApiError(error));
      const retryable =
        !isApiError(error) ||
        (!unauthenticated &&
          !isSameSystemApiDefect(error) &&
          error.status >= 500);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw normalizeRequestError(error);
      }
      await waitForRetry(retryDelay(attempt), signal);
    }
  }

  throw new Error("Unreachable retry state");
}

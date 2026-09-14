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
// UNQUALIFIED foreground experiment: request time and backoff share this budget.
export const READ_RETRY_BUDGET_MS = 30_000;

export class ApiRetryExhausted extends Error {
  constructor(cause: unknown) {
    super("API read retry budget exhausted", { cause });
    this.name = "ApiRetryExhausted";
  }
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
 * The browser read retry policy: three total attempts with cancellable,
 * jittered exponential backoff. Client errors and same-system response defects
 * are never retried.
 */
export async function requestWithRetry<T>(
  request: (signal: AbortSignal, attempt: number) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const deadline = new AbortController();
  const endsAt = performance.now() + READ_RETRY_BUDGET_MS;
  const timer = setTimeout(() => deadline.abort(), READ_RETRY_BUDGET_MS);
  const readSignal = AbortSignal.any([signal, deadline.signal]);
  let lastFailure: unknown;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      readSignal.throwIfAborted();
      try {
        const result = await request(readSignal, attempt);
        signal.throwIfAborted();
        if (deadline.signal.aborted || performance.now() >= endsAt) {
          throw new ApiRetryExhausted(lastFailure ?? new ApiError(504, "E_UPSTREAM_TIMEOUT", "Read deadline elapsed"));
        }
        return result;
      } catch (error) {
        if (readSignal.aborted || isAbortError(error) || isUnauthenticatedApiError(error)) throw error;
        const retryable = isApiError(error) &&
          (error.code === "E_NETWORK" || (!isSameSystemApiDefect(error) && error.status >= 500));
        if (!retryable) throw error;
        lastFailure = error;
        // A server minimum cannot be shortened by client jitter or its deadline.
        const delay = (error.retryAfterMs ?? 0) + retryDelay(attempt);
        if (attempt === MAX_ATTEMPTS || delay >= endsAt - performance.now()) {
          throw new ApiRetryExhausted(error);
        }
        await waitForRetry(delay, readSignal);
      }
    }
    throw new Error("Unreachable retry state");
  } catch (error) {
    if (isAbortError(error) && deadline.signal.aborted && !signal.aborted) {
      throw new ApiRetryExhausted(lastFailure ?? new ApiError(504, "E_UPSTREAM_TIMEOUT", "Read deadline elapsed"));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

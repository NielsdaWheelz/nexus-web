import { isAbortError } from "@/lib/errors";
import { remoteAttemptAllowed, remoteReady } from "@/lib/native/admission";
import { isApiError, isRefusal, isSameSystemApiDefect, requestWithDeadline } from "./client";

export interface ReadPolicy {
  readonly retry?: "manual" | "capacity";
  readonly timeoutMs?: number;
}
const TRANSIENT = { attempts: 3, initialDelayMs: 250, maxDelayMs: 2_000, writeDeadlineMs: 30_000 };
const EXACT_WRITE_ERRORS = new Set(["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"]);

export class RetryExhaustedError extends Error {
  constructor(cause: unknown) { super("request recovery exhausted", { cause }); this.name = "RetryExhaustedError"; }
}
export type ExactWriteResult<T> =
  | { readonly kind: "Answered"; readonly value: T; readonly uncertain: boolean }
  | { readonly kind: "Failed"; readonly error: unknown; readonly uncertain: boolean };

/** One finite transport schedule. Delivery evidence is local to this group, never product state. */
async function group<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal,
  policy: ReadPolicy | { readonly retry: "exact_write" }): Promise<ExactWriteResult<T>> {
  const exact = policy.retry === "exact_write";
  const capacity = policy.retry === "capacity";
  let uncertain = false;
  let exhausted = false;
  let lastFailure: unknown = null;
  const run = async (ownedSignal: AbortSignal): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      ownedSignal.throwIfAborted();
      try {
        return capacity && policy.timeoutMs !== undefined
          ? await requestWithDeadline({ request, signal: ownedSignal, timeoutMs: policy.timeoutMs })
          : await request(ownedSignal);
      } catch (error) {
        lastFailure = error;
        if (exact && !isRefusal(error)) uncertain = true;
        const transient = isApiError(error) && (exact ? EXACT_WRITE_ERRORS.has(error.code)
          : error.code === "E_NETWORK" || !isSameSystemApiDefect(error) && error.status >= 500);
        const retryable = !ownedSignal.aborted && isApiError(error) &&
          (capacity ? remoteReady() && error.code === "E_DATABASE_BUSY"
            : remoteAttemptAllowed() && policy.retry !== "manual" && transient);
        if (!retryable || !capacity && attempt === TRANSIENT.attempts) {
          exhausted = exact && transient && !signal.aborted && (attempt === TRANSIENT.attempts || ownedSignal.aborted);
          throw error;
        }
        const delay = Math.min(TRANSIENT.initialDelayMs * 2 ** (attempt - 1), TRANSIENT.maxDelayMs);
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(ownedSignal.reason); };
          const timer = setTimeout(() => { ownedSignal.removeEventListener("abort", abort); resolve(); }, delay * (0.75 + Math.random() * 0.5));
          ownedSignal.addEventListener("abort", abort, { once: true });
        });
        if (capacity && !remoteReady()) throw error;
      }
    }
  };
  try {
    const timeoutMs = exact ? TRANSIENT.writeDeadlineMs : policy.timeoutMs;
    const value = capacity || timeoutMs === undefined ? await run(signal)
      : await requestWithDeadline({ request: run, signal, timeoutMs });
    return { kind: "Answered", value, uncertain };
  } catch (error) {
    // The outer deadline may expire during backoff: it changes severity, never prior delivery facts.
    const deadline = exact && !signal.aborted && isApiError(error) && error.code === "E_UPSTREAM_TIMEOUT";
    return { kind: "Failed", error: exact && (exhausted || deadline) && !isAbortError(error)
      ? new RetryExhaustedError(deadline ? lastFailure ?? error : error) : error, uncertain };
  }
}

/** Existing GET semantics, including its separately owned capacity policy. */
export async function requestWithRetry<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, policy: ReadPolicy = {}): Promise<T> {
  const result = await group(request, signal, policy);
  if (result.kind === "Failed") throw result.error;
  return result.value;
}

/** Only callers with a sealed replay-safe request may choose this policy. */
export function exactWrite<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<ExactWriteResult<T>> {
  return group(request, signal, { retry: "exact_write" });
}

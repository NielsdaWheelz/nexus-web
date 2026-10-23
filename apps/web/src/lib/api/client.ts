// The browser's one door to the api (docs/modules/api-edge.md): every call goes
// to a same-origin /api path, carries this build's wire revision, and answers
// the parsed json or throws ApiError. A request sealed under another revision is
// refused here, never rewritten. A 426 means this tab was built for another
// wire: the tab reloads itself once per build unless writing holds it.
import { installedApp, remoteReady, remoteAdmission, observeRemoteFailure } from "@/lib/native/admission";
import { androidShellDocument } from "@/lib/androidShell";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isAbortError } from "@/lib/errors";
import { isRecord } from "@/lib/validation";
import { WIRE_REVISION } from "./wire.gen";

export type ApiPath = `/api/${string}`;
export const WIRE_HEADER = "X-Nexus-Wire";
const RELOADED_FOR = "nexus.reloaded-for-wire";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The budget encloses the complete operation, including response bodies and retries. */
export async function requestWithDeadline<T>({ request, signal, timeoutMs }: {
  request: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut) throw new ApiError(504, "E_UPSTREAM_TIMEOUT", "Backend service timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** A collection view or cursor the server rejected. */
export function isInvalidViewError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_INVALID_REQUEST" || error.code === "E_INVALID_CURSOR")
  );
}

export type SameSystemApiDefect = ApiError & {
  readonly code: "E_INVALID_RESPONSE" | "E_UNKNOWN" | "E_INTERNAL";
};

/** A same-system defect: never a modeled failure; it throws to the render boundary. */
export function isSameSystemApiDefect(
  error: unknown,
): error is SameSystemApiDefect {
  return (
    isApiError(error) &&
    (error.code === "E_INVALID_RESPONSE" ||
      error.code === "E_UNKNOWN" ||
      error.code === "E_INTERNAL")
  );
}

/**
 * A write the server answered and refused, so nothing changed: a modeled 4xx
 * other than a lapsed session (426 included: a stale build's write never
 * landed). Anything else a sent write meets leaves its outcome unknown.
 */
export function isRefusal(error: unknown): error is ApiError {
  return (
    isApiError(error) &&
    !isSameSystemApiDefect(error) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401
  );
}

/** A lost answer or lapsed session keeps the same write intent for an explicit retry. */
export function outcomeUnknown(error: unknown): error is ApiError & { readonly code: "E_NETWORK" | "E_UPSTREAM" | "E_UPSTREAM_TIMEOUT" | "E_UNAUTHENTICATED" } {
  return (
    isApiError(error) &&
    (error.code === "E_NETWORK" || error.code === "E_UPSTREAM" || error.code === "E_UPSTREAM_TIMEOUT" || isUnauthenticatedApiError(error))
  );
}

export function isUnauthenticatedApiError(error: unknown): error is ApiError {
  return (
    isApiError(error) &&
    error.status === 401 &&
    error.code === "E_UNAUTHENTICATED"
  );
}

/**
 * A tab built for another wire (426) that did not reload: no defect, and every
 * request fails alike until a reload. A caller that models it shows
 * `apiTransportFeedback`; one that throws it reaches a render boundary. Both
 * show `STALE_BUILD_FEEDBACK`.
 */
export function isStaleBuild(error: unknown): error is ApiError & { readonly code: "E_WIRE_MISMATCH" } {
  return isApiError(error) && error.code === "E_WIRE_MISMATCH";
}

/** Hosted delivery reloads; installed delivery requires an APK update and retains work. */
export const STALE_BUILD_FEEDBACK: FeedbackContent = {
  tone: "Warning",
  title: installedApp || androidShellDocument ? "update nexus to reconnect" : "Nexus was updated. Reload this page to continue.",
  ...(installedApp || androidShellDocument ? { message: "install the current nexus apk, then reopen the app." } : { reload: true }),
};

/** Copy for the transport failures every command answers alike; null for domain codes. */
export function apiTransportFeedback(
  error: ApiError,
  title: string,
): FeedbackContent | null {
  const { requestId } = error;
  switch (error.code) {
    case "E_UNAUTHENTICATED":
      return {
        tone: "Warning",
        title,
        message: "sign in to reconnect, then retry this request.",
        requestId,
      };
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and try again.",
        requestId,
      };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Please wait a moment, then try again.",
        requestId,
      };
    case "E_WIRE_MISMATCH":
      return STALE_BUILD_FEEDBACK;
    default:
      return null;
  }
}

let reloadHeld: () => boolean = () => false;

/** Writing that a reload would lose holds the automatic reload; the stale-build
 * feedback still offers it. One holder; the returned function releases it. */
export function holdWireReload(held: () => boolean): () => void {
  reloadHeld = held;
  return () => {
    if (reloadHeld === held) reloadHeld = () => false;
  };
}

/** Reload once per (tab, build); a beforeunload guard may keep the page. */
function reloadForNewBuild(): void {
  if (reloadHeld()) return;
  try {
    if (sessionStorage.getItem(RELOADED_FOR) === String(WIRE_REVISION)) return;
    sessionStorage.setItem(RELOADED_FOR, String(WIRE_REVISION));
  } catch {
    // justify-ignore-error: without storage the tab still reloads at most once
    // per page life; the reloaded page is the new build or refuses again.
  }
  window.location.reload();
}

/** `Retry-After` is delay-seconds or an http-date (rfc 9110 §10.2.3). */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The one reader of an api answer: its json, or the envelope's ApiError. */
export async function readResponse<T>(response: Response): Promise<T> {
  const { ok, status } = response;
  const answerId = response.headers.get("x-request-id") ?? undefined;
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) throw error;
    // an incomplete body is transport, whatever the status (#604)
    observeRemoteFailure(0);
    throw new ApiError(0, "E_NETWORK", "Network request failed", answerId);
  }
  if (ok) {
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      const message = "API returned non-JSON";
      throw new ApiError(status, "E_INVALID_RESPONSE", message, answerId);
    }
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not the envelope: the status speaks alone
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const failure = new ApiError(
    status,
    typeof error.code === "string" ? error.code : "E_UNKNOWN",
    typeof error.message === "string"
      ? error.message
      : `Request failed with status ${status}`,
    typeof error.request_id === "string" ? error.request_id : answerId,
    isRecord(error.details) ? error.details : undefined,
    retryAfterMs(response.headers.get("retry-after")),
  );
  observeRemoteFailure(status);
  if (status === 426 && typeof window !== "undefined" && !installedApp && !androidShellDocument) reloadForNewBuild();
  throw failure;
}

/**
 * One api call. A string body is json; status 0 E_NETWORK is a transport
 * failure. `keepalive: true` lets a write outlive the page (64 KB in flight).
 * A caller naming another wire revision (a sealed write) is refused unsent.
 */
export async function apiFetch<T>(
  path: ApiPath,
  init: RequestInit = {},
): Promise<T> {
  if (installedApp && !remoteReady()) {
    const admission = remoteAdmission();
    throw new ApiError(admission === "SignInRequired" ? 401 : admission === "UpdateRequired" ? 426 : 0, admission === "SignInRequired" ? "E_UNAUTHENTICATED" : admission === "UpdateRequired" ? "E_WIRE_MISMATCH" : "E_NETWORK", "remote work is unavailable");
  }
  const headers = new Headers(init.headers);
  const sealed = headers.get(WIRE_HEADER);
  if (sealed !== null && sealed !== String(WIRE_REVISION))
    throw new ApiError(426, "E_WIRE_MISMATCH", "Request sealed for another wire revision");
  headers.set(WIRE_HEADER, String(WIRE_REVISION));
  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    observeRemoteFailure(0);
    throw new ApiError(0, "E_NETWORK", "Network request failed");
  }
  return readResponse<T>(response);
}

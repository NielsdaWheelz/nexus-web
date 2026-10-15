// The browser's one door to the api (docs/modules/api-edge.md): every call goes
// to a same-origin /api path, carries this build's wire revision, and answers
// the parsed json or throws ApiError. A 426 means this tab was built for
// another wire: the tab reloads itself once per build.
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
  ) {
    super(message);
    this.name = "ApiError";
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
 * `apiTransportFeedback`; one that throws it reaches a render boundary, which
 * shows the same copy.
 */
export function isStaleBuild(error: unknown): error is ApiError {
  return isApiError(error) && error.code === "E_WIRE_MISMATCH";
}

export const STALE_BUILD_COPY =
  "Nexus was updated. Reload this page to continue.";

/** Copy for the transport failures every command answers alike; null for domain codes. */
export function apiTransportFeedback(
  error: ApiError,
  title: string,
): FeedbackContent | null {
  const { requestId } = error;
  switch (error.code) {
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
      return { tone: "Warning", title, message: STALE_BUILD_COPY, requestId };
    default:
      return null;
  }
}

/** Reload once per (tab, build); a beforeunload guard may keep the page. */
function reloadForNewBuild(): void {
  try {
    if (sessionStorage.getItem(RELOADED_FOR) === String(WIRE_REVISION)) return;
    sessionStorage.setItem(RELOADED_FOR, String(WIRE_REVISION));
  } catch {
    // justify-ignore-error: without storage the tab still reloads at most once
    // per page life; the reloaded page is the new build or refuses again.
  }
  window.location.reload();
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
  );
  if (status === 426 && typeof window !== "undefined") reloadForNewBuild();
  throw failure;
}

/**
 * One api call. A string body is json; status 0 E_NETWORK is a transport
 * failure. `keepalive: true` lets a write outlive the page (64 KB in flight).
 */
export async function apiFetch<T>(
  path: ApiPath,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(WIRE_HEADER, String(WIRE_REVISION));
  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(0, "E_NETWORK", "Network request failed");
  }
  return readResponse<T>(response);
}

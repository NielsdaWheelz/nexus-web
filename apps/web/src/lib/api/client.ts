// The browser's one door to the api (docs/modules/api-edge.md): every call goes
// to a same-origin /api path, carries this build's wire revision, bypasses the
// browser http cache, and answers the parsed json or throws ApiError. A request
// sealed under another revision is refused here, never rewritten. A 426 means
// this tab was built for another wire: it reloads unless writing holds it.
import { installedApp, remoteAttemptAllowed, remoteAdmission, observeRemoteFailure, observeRemoteSuccess, checkSession, whenChecked } from "@/lib/native/admission";
import type { RemoteAdmission } from "@/lib/native/contracts";
import { androidShellDocument } from "@/lib/androidShell";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { isRecord } from "@/lib/validation";
import { WIRE_REVISION } from "./wire.gen";

export type ApiPath = `/api/${string}`;
export const WIRE_HEADER = "X-Nexus-Wire";
let accountBinding: { accountId: string } | null = null;
/** An account assertion prevents a changed cookie jar from moving local data
 * into another account. It grants no authority; the BFF verifies the bearer. */
export function bindApiAccount(accountId: string): () => void {
  const binding = { accountId }; accountBinding = binding;
  return () => { if (accountBinding === binding) accountBinding = null; };
}
/** Capture the existing account assertion, not an authorization or a new session. */
export const captureApiAccount = () => accountBinding;
export const isCurrentApiAccount = (binding: ReturnType<typeof captureApiAccount>) => accountBinding === binding;
const RELOADED_FOR = "nexus.reloaded-for-wire";

export class ApiError extends Error {
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;
  /** False only for a request refused before it left this client: nothing ran. */
  readonly sent: boolean;
  /** A status-0 failure the browser saw while offline: observed at construction, or carried from
   * where it was observed. Fixed, so its transport reads as it was seen, not as the connection
   * stands when it renders. */
  readonly offline: boolean;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    { requestId, details, retryAfterMs, sent = true, offline = status === 0 && typeof navigator !== "undefined" && navigator.onLine === false }:
      { requestId?: string; details?: Record<string, unknown>; retryAfterMs?: number; sent?: boolean; offline?: boolean } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.requestId = requestId;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
    this.sent = sent;
    this.offline = offline;
  }
}

/** Abort reasons `requestWithDeadline` raised, so an owner can tell its deadline from a caller's abort. */
const deadlines = new WeakSet<object>();

/** The budget encloses the complete operation, including response bodies and retries. A deadline
 * after the send is an unknown outcome; a request admission refused unsent stays refused. */
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
    const reason = new DOMException("request deadline", "AbortError");
    deadlines.add(reason);
    controller.abort(reason);
  }, timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut && !(error instanceof ApiError && !error.sent)) throw new ApiError(504, "E_UPSTREAM_TIMEOUT", "Backend service timed out");
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

declare const writeOutcome: unique symbol;
/** A write's modeled failure where nothing ran. */
export type Refusal = ApiError & { readonly [writeOutcome]: "Refused" };
/** A write's modeled failure that may have run. */
export type UnknownOutcome = ApiError & { readonly [writeOutcome]: "Unknown" };

/**
 * A write's modeled failure is exactly one of `isRefusal` and `outcomeUnknown`; a same-system
 * defect is neither and throws. Refused, nothing ran: it never left this client (admission, a
 * sealed revision, a stalled upload), or the server answered 4xx, a lapsed session's 401 and a
 * stale build's 426 included. Unknown, it may have run: it was sent and no answer came, a deadline
 * passed after the send, or the server answered 5xx. No 5xx proves a rollback: 502 and 504 come
 * from past the answerer; `E_DATABASE_BUSY` is a pool checkout a handler may make after its own
 * commit (python/nexus/api/edge.py, services/extension_sessions.py commits and then refreshes);
 * `E_AUTH_UNAVAILABLE` may end a provider write that got no answer (lib/account/settings.server.ts).
 */
export function isRefusal(error: unknown): error is Refusal {
  return isApiError(error) && !isSameSystemApiDefect(error) && (!error.sent || error.status >= 400 && error.status < 500);
}

/** The other half of `isRefusal`'s partition: its owner holds the write until a press settles it. */
export function outcomeUnknown(error: unknown): error is UnknownOutcome {
  return isApiError(error) && !isSameSystemApiDefect(error) && !isRefusal(error);
}

export function isUnauthenticatedApiError(error: unknown): error is ApiError & { readonly status: 401; readonly code: "E_UNAUTHENTICATED" } {
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
    case "E_ACCOUNT_MISMATCH":
      return {
        tone: "Warning",
        title,
        message: "sign in to reconnect.",
        requestId,
      };
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and try again.",
        requestId,
      };
    case "E_DATABASE_BUSY":
      return {
        tone: "Warning",
        title,
        message: "nexus is busy. wait a moment, then retry.",
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

/** The document guard holds automatic updates while live work remains. One holder;
 * the stale-build feedback still offers a deliberate reload. */
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

/** The failure of a request `admission` refuses unsent. It names what admission waits on, so a
 * caller's verb can be true. Pure: a render may read it. */
export function admissionError(admission: RemoteAdmission): ApiError {
  const message = "remote work is unavailable";
  switch (admission) {
    case "SignInRequired": return new ApiError(401, "E_UNAUTHENTICATED", message, { sent: false });
    case "UpdateRequired": return new ApiError(426, "E_WIRE_MISMATCH", message, { sent: false });
    case "Checking":
    case "Unavailable":
    case "Ready":
      return new ApiError(0, "E_NETWORK", message, { sent: false });
  }
}

/** Refuses an attempted request unsent. The attempt is demand: an installed client whose
 * admission is `Unavailable` asks native authority to recheck. */
export function admissionRefusal(): ApiError {
  const admission = remoteAdmission();
  if (installedApp && admission === "Unavailable") checkSession();
  return admissionError(admission);
}

/** Decode an answer. Its request owner publishes admission failures. */
export async function readResponse<T>(response: Response): Promise<T> {
  const { ok, status } = response;
  const answerId = response.headers.get("x-request-id") ?? undefined;
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) throw error;
    // an incomplete body is transport, whatever the status (#604)
    throw new ApiError(0, "E_NETWORK", "Network request failed", { requestId: answerId });
  }
  if (ok) {
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      const message = "API returned non-JSON";
      throw new ApiError(status, "E_INVALID_RESPONSE", message, { requestId: answerId });
    }
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not the envelope: the status speaks alone
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  throw new ApiError(
    status,
    typeof error.code === "string" ? error.code : "E_UNKNOWN",
    typeof error.message === "string"
      ? error.message
      : `Request failed with status ${status}`,
    {
      requestId: typeof error.request_id === "string" ? error.request_id : answerId,
      details: isRecord(error.details) ? error.details : undefined,
      retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
    },
  );
}

/** A retired response cannot change the next account's admission. */
export function observeApiFailure(error: unknown, binding: ReturnType<typeof captureApiAccount>): void {
  if (!isCurrentApiAccount(binding) || !(error instanceof ApiError)) return;
  if (binding !== null && (error.status !== 403 || error.code === "E_ACCOUNT_MISMATCH")) observeRemoteFailure(error.status);
  if (error.status === 426 && !installedApp && !androidShellDocument) reloadForNewBuild();
}

/** How long an installed client's command waits on a session check before admission refuses it. */
const CHECK_WAIT_MS = 30_000;

/**
 * One api call. A string body is json; status 0 E_NETWORK is a transport
 * failure. `keepalive: true` lets a write outlive the page (64 KB in flight).
 * A caller naming another wire revision (a sealed write) is refused unsent.
 * On an installed client a command (any method but GET and HEAD) meeting a
 * session check waits for it, then runs or is refused by what it settled.
 */
export async function apiFetch<T>(
  path: ApiPath,
  init: RequestInit = {},
): Promise<T> {
  const binding = captureApiAccount();
  const command = init.method !== undefined && init.method !== "GET" && init.method !== "HEAD";
  if (installedApp && command && remoteAdmission() === "Checking") {
    try { await whenChecked(CHECK_WAIT_MS, init.signal); }
    catch (reason) { throw deadlines.has(reason as object) ? admissionRefusal() : reason; }
  }
  // Unavailable pauses background owners; an explicit browser attempt may prove
  // reachability. Native session admission remains owned by the installed host.
  if (!remoteAttemptAllowed()) throw admissionRefusal();
  const headers = new Headers(init.headers);
  const sealed = headers.get(WIRE_HEADER);
  if (sealed !== null && sealed !== String(WIRE_REVISION))
    throw new ApiError(426, "E_WIRE_MISMATCH", "Request sealed for another wire revision", { sent: false });
  headers.set(WIRE_HEADER, String(WIRE_REVISION));
  if (binding) headers.set("X-Nexus-Account", binding.accountId);
  const requestId = headers.get("X-Request-ID") ?? createRandomId();
  headers.set("X-Request-ID", requestId);
  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const url = new URL(path, "http://localhost");
  const trace = url.pathname === "/api/search" && url.searchParams.get("phase") === "hybrid";
  const started = performance.now();
  const mark = (stage: string, facts: Record<string, unknown> = {}) => {
    if (trace) console.info(JSON.stringify({
      event: "search_transport", owner: "browser", stage, request_id: requestId,
      epoch_ms: Date.now(), elapsed_ms: performance.now() - started, ...facts,
    }));
  };
  mark("dispatch");
  let response: Response | undefined;
  try {
    response = await fetch(path, { ...init, cache: "no-store", headers });
    mark("headers", { status: response.status, response_request_id: response.headers.get("x-request-id") });
    const body = await readResponse<T>(response);
    if (!isCurrentApiAccount(binding)) throw new DOMException("api account changed", "AbortError");
    if (binding !== null) observeRemoteSuccess();
    mark("body_complete", { status: response.status });
    return body;
  } catch (error) {
    if (!isCurrentApiAccount(binding)) throw new DOMException("api account changed", "AbortError");
    let cause = "error";
    if (init.signal?.aborted) cause = deadlines.has(init.signal.reason) ? "read_deadline" : "caller_abort";
    else if (isAbortError(error)) cause = "transport_abort";
    mark("failed", {
      at: response === undefined ? "fetch" : "body", cause,
      error_type: error instanceof Error ? error.name : typeof error,
      error_code: error instanceof ApiError ? error.code : null,
    });
    if (isAbortError(error)) throw error;
    const failure = response === undefined ? new ApiError(0, "E_NETWORK", "Network request failed", { requestId }) : error;
    if (failure instanceof ApiError) console.warn(JSON.stringify({ event: "api_request_failed", request_id: requestId, path: url.pathname, status: failure.status, code: failure.code }));
    observeApiFailure(failure, binding);
    throw failure;
  }
}

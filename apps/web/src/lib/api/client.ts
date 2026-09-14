/**
 * Client-side API fetch helper for browser components.
 *
 * This module provides typed fetch utilities for making API calls
 * from client components to the BFF API routes.
 */

import { isAbortError } from "@/lib/errors";
import { compareStableString } from "@/lib/display/format";
import { isRecord } from "@/lib/validation";
import { TOOL_PROJECTION_REVISION } from "@/lib/conversations/toolContractProjection";

export type ApiPath = `/api/${string}`;
export const TOOL_PROJECTION_HEADER = "X-Nexus-Tool-Projection";
export const TOOL_PROJECTION_RELOAD_REQUIRED_CODE =
  "E_TOOL_PROJECTION_RELOAD_REQUIRED";

const TOOL_PROJECTION_PATHS = [
  /^\/api\/chat-runs$/,
  /^\/api\/chat-runs\/[^/]+$/,
  /^\/api\/chat-runs\/[^/]+\/cancel$/,
  /^\/api\/conversations\/[^/]+\/(?:messages|tree|active-path)$/,
  /^\/api\/conversations\/[^/]+\/tool-calls\/[^/]+\/undo$/,
  /^\/api\/messages\/[^/]+\/(?:rerun|regenerate)$/,
] as const;

function carriesToolProjection(path: ApiPath): boolean {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  return TOOL_PROJECTION_PATHS.some((pattern) => pattern.test(pathname));
}

function jsonRequestHeaders(
  path: ApiPath,
  headersInit: HeadersInit | undefined,
): Headers {
  const headers = new Headers(headersInit);
  headers.set("Content-Type", "application/json");
  if (carriesToolProjection(path)) {
    headers.set(TOOL_PROJECTION_HEADER, TOOL_PROJECTION_REVISION);
  }
  return headers;
}

/**
 * API error with status code and message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    details?: Record<string, unknown>,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Type guard for ApiError.
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export type SameSystemApiDefect = ApiError & {
  readonly code: "E_INVALID_RESPONSE" | "E_UNKNOWN" | "E_INTERNAL";
};

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

export function isToolProjectionReloadRequired(
  error: unknown,
): error is ApiError & {
  readonly status: 409;
  readonly code: typeof TOOL_PROJECTION_RELOAD_REQUIRED_CODE;
} {
  return (
    isApiError(error) &&
    error.status === 409 &&
    error.code === TOOL_PROJECTION_RELOAD_REQUIRED_CODE
  );
}

/**
 * Translate a strict same-system payload decoder failure into the API defect
 * taxonomy without weakening the decoder or misclassifying the failure as a
 * network problem.
 */
export function decodeApiPayload<T>(
  body: unknown,
  decode: (body: unknown) => T,
  context: string,
): T {
  try {
    return decode(body);
  } catch (error) {
    if (isApiError(error)) throw error;
    const reason = error instanceof Error ? error.message : "Invalid response";
    throw new ApiError(
      200,
      "E_INVALID_RESPONSE",
      `${context} returned an invalid response: ${reason}`,
    );
  }
}

/**
 * Response shape for API errors.
 */
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    request_id?: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Check if a response body is an error response.
 */
function isErrorResponse(body: unknown): body is ErrorResponse {
  return (
    isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.code === "string" &&
    typeof body.error.message === "string" &&
    (body.error.request_id === undefined ||
      typeof body.error.request_id === "string") &&
    (body.error.details === undefined || isRecord(body.error.details))
  );
}

/**
 * An owned envelope is a handful of fields. This branch exists precisely for the
 * case where something other than our API answered, so the body it returns is
 * never assumed to be small: past the ceiling the stream is cancelled and the
 * status-derived envelope stands.
 */
const ERROR_ENVELOPE_MAX_BYTES = 16_384;

/** The envelope text, or none when there is no body, it fails mid-stream, or it exceeds the ceiling. */
async function readErrorEnvelopeText(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ERROR_ENVELOPE_MAX_BYTES) return null;
      parts.push(part.value);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  } finally {
    // A failed stream can also reject cancellation; retain its original outcome.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Preserve owned envelopes; normalize only transport responses lacking one. */
export async function apiErrorEnvelopeFromResponse(
  response: Response,
): Promise<ErrorResponse> {
  const text = await readErrorEnvelopeText(response);
  if (text !== null) {
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A body that will not parse is not an owned envelope.
      body = null;
    }
    if (isErrorResponse(body)) {
      return body;
    }
  }
  return { error: {
    code: response.status === 504
      ? "E_UPSTREAM_TIMEOUT"
      : response.status === 502 || response.status === 503
        ? "E_UPSTREAM"
        : "E_UNKNOWN",
    message: `Request failed with status ${response.status}`,
  } };
}

/** Decode the common API error envelope without flattening its closed code. */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const { error } = await apiErrorEnvelopeFromResponse(response);
  const retryAfter = response.headers.get("retry-after");
  let retryAfterMs: number | undefined;
  if (retryAfter !== null) {
    if (/^[0-9]+$/.test(retryAfter)) retryAfterMs = Number(retryAfter) * 1_000;
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - Date.now());
    }
  }
  return new ApiError(response.status, error.code, error.message,
    error.request_id ?? response.headers.get("x-request-id") ?? undefined,
    error.details, retryAfterMs);
}

const inFlightGetRequests = new Map<string, Promise<unknown>>();
const PLAIN_GET_COALESCING_OPTION_KEYS = new Set([
  "cache",
  "headers",
  "method",
]);

function normalizeMethod(method: string | undefined): string {
  return method?.toUpperCase() ?? "GET";
}

function sortedHeaderEntries(
  headers: HeadersInit | undefined,
): [string, string][] {
  if (!headers) {
    return [];
  }
  return Array.from(new Headers(headers).entries()).sort(([a], [b]) =>
    compareStableString(a, b),
  );
}

function coalescedGetKey(
  path: string,
  headers: HeadersInit | undefined,
): string {
  return JSON.stringify({
    path,
    headers: sortedHeaderEntries(headers),
  });
}

function isPlainGetRequest(options: RequestInit): boolean {
  const hasOnlyPlainGetOptions = Object.keys(options).every((key) =>
    PLAIN_GET_COALESCING_OPTION_KEYS.has(key),
  );
  return (
    hasOnlyPlainGetOptions &&
    (options.cache === undefined || options.cache === "no-store") &&
    normalizeMethod(options.method) === "GET" &&
    options.body === undefined &&
    options.signal === undefined
  );
}

/**
 * Own the browser transport boundary: only a rejected fetch is a network
 * failure. Parsing and contract decoders run outside this boundary so defects
 * cannot be relabeled as connectivity problems or enter the retry schedule.
 */
export async function fetchApiResponse(
  path: ApiPath,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(0, "E_NETWORK", "Network request failed");
  }
}

export async function parseApiResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await apiErrorFromResponse(response);
  // Reading the bytes and decoding them are separate failures: a connection that
  // drops after the status line is an availability failure that may be retried,
  // while a complete body that will not parse is a same-system defect that must
  // not be. Only `text()` can fail for the first reason and only `JSON.parse`
  // for the second, so each is attributed to the step that produced it.
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(0, "E_NETWORK", "Response stream failed");
  }
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      response.status,
      "E_INVALID_RESPONSE",
      "API returned a non-JSON response",
    );
  }
}

/**
 * Fetch data from the API with typed response.
 *
 * @param path - API path (e.g., "/api/libraries")
 * @param options - Fetch options
 * @returns Parsed JSON response
 * @throws ApiError on non-2xx responses
 */
export async function apiFetch<T>(
  path: ApiPath,
  options: RequestInit = {},
): Promise<T> {
  const init = {
    ...options,
    method: normalizeMethod(options.method),
    headers: jsonRequestHeaders(path, options.headers),
  } satisfies RequestInit;

  if (isPlainGetRequest(options)) {
    const key = coalescedGetKey(path, init.headers);
    const inFlight = inFlightGetRequests.get(key);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const request = fetchApiResponse(path, init)
      .then((response) => parseApiResponse<T>(response))
      .finally(() => {
        inFlightGetRequests.delete(key);
      });
    inFlightGetRequests.set(key, request);
    return request;
  }

  const response = await fetchApiResponse(path, init);
  return parseApiResponse<T>(response);
}

/** Run a command whose owned wire contract is exactly HTTP 204. */
export async function apiCommand204(
  path: ApiPath,
  options: RequestInit,
): Promise<void> {
  const response = await fetchApiResponse(path, {
    ...options,
    method: normalizeMethod(options.method),
    headers: jsonRequestHeaders(path, options.headers),
  });
  await parseApiResponse<unknown>(response);
  if (response.status !== 204) {
    throw new ApiError(
      response.status,
      "E_INVALID_RESPONSE",
      `API command returned status ${response.status}; expected 204`,
    );
  }
}

export async function apiPostFormData<T>(
  path: ApiPath,
  formData: FormData,
): Promise<T> {
  const response = await fetchApiResponse(path, {
    method: "POST",
    body: formData,
  });

  return parseApiResponse<T>(response);
}

export async function apiKeepaliveJson(
  path: ApiPath,
  body: unknown,
): Promise<void> {
  const response = await fetchApiResponse(path, {
    method: "PUT",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await parseApiResponse<void>(response);
}

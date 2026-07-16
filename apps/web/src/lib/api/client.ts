/**
 * Client-side API fetch helper for browser components.
 *
 * This module provides typed fetch utilities for making API calls
 * from client components to the BFF API routes.
 */

import { isAbortError } from "@/lib/errors";
import { compareStableString } from "@/lib/display/format";
import { isRecord } from "@/lib/validation";

export type ApiPath = `/api/${string}`;

/**
 * API error with status code and message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/**
 * Type guard for ApiError.
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isUnauthenticatedApiError(error: unknown): error is ApiError {
  return (
    isApiError(error) &&
    error.status === 401 &&
    error.code === "E_UNAUTHENTICATED"
  );
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
    (body.error.request_id === undefined || typeof body.error.request_id === "string") &&
    (body.error.details === undefined || isRecord(body.error.details))
  );
}

const inFlightGetRequests = new Map<string, Promise<unknown>>();
const PLAIN_GET_COALESCING_OPTION_KEYS = new Set(["cache", "headers", "method"]);

function normalizeMethod(method: string | undefined): string {
  return method?.toUpperCase() ?? "GET";
}

function sortedHeaderEntries(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) {
    return [];
  }
  return Array.from(new Headers(headers).entries()).sort(([a], [b]) =>
    compareStableString(a, b),
  );
}

function coalescedGetKey(path: string, headers: HeadersInit | undefined): string {
  return JSON.stringify({
    path,
    headers: sortedHeaderEntries(headers),
  });
}

function isPlainGetRequest(options: RequestInit): boolean {
  const hasOnlyPlainGetOptions = Object.keys(options).every((key) =>
    PLAIN_GET_COALESCING_OPTION_KEYS.has(key)
  );
  return (
    hasOnlyPlainGetOptions &&
    (options.cache === undefined || options.cache === "no-store") &&
    normalizeMethod(options.method) === "GET" &&
    options.body === undefined &&
    options.signal === undefined
  );
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!response.ok) {
      throw new ApiError(
        response.status,
        "E_UNKNOWN",
        `Request failed with status ${response.status}`
      );
    }
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    throw new ApiError(
      response.status,
      "E_INVALID_RESPONSE",
      "API returned a non-JSON response"
    );
  }

  if (!response.ok) {
    if (isErrorResponse(body)) {
      throw new ApiError(
        response.status,
        body.error.code,
        body.error.message,
        body.error.request_id,
        body.error.details
      );
    }
    throw new ApiError(
      response.status,
      "E_UNKNOWN",
      `Request failed with status ${response.status}`
    );
  }

  return body as T;
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
  options: RequestInit = {}
): Promise<T> {
  const init = {
    ...options,
    method: normalizeMethod(options.method),
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  } satisfies RequestInit;

  if (isPlainGetRequest(options)) {
    const key = coalescedGetKey(path, init.headers);
    const inFlight = inFlightGetRequests.get(key);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const request = fetch(path, init)
      .then((response) => parseApiResponse<T>(response))
      .finally(() => {
        inFlightGetRequests.delete(key);
      });
    inFlightGetRequests.set(key, request);
    return request;
  }

  const response = await fetch(path, init);
  return parseApiResponse<T>(response);
}

export async function apiPostFormData<T>(
  path: ApiPath,
  formData: FormData
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    body: formData,
  });

  return parseApiResponse<T>(response);
}

export async function apiKeepaliveJson(path: ApiPath, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "PUT",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await parseApiResponse<void>(response);
}

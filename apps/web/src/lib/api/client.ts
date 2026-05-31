/**
 * Client-side API fetch helper for browser components.
 *
 * This module provides typed fetch utilities for making API calls
 * from client components to the BFF API routes.
 */

import { isAbortError } from "@/lib/errors";
import { isRecord } from "@/lib/validation";

/**
 * API error with status code and message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * Type guard for ApiError.
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Response shape for API errors.
 */
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    request_id?: string;
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
    (body.error.request_id === undefined || typeof body.error.request_id === "string")
  );
}

const inFlightGetRequests = new Map<string, Promise<unknown>>();
const PLAIN_GET_COALESCING_OPTION_KEYS = new Set(["headers", "method"]);

function normalizeMethod(method: string | undefined): string {
  return method?.toUpperCase() ?? "GET";
}

function sortedHeaderEntries(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) {
    return [];
  }
  return Array.from(new Headers(headers).entries()).sort(([a], [b]) =>
    a.localeCompare(b)
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
    if (
      response.status === 401 &&
      isErrorResponse(body) &&
      body.error.code === "E_UNAUTHENTICATED"
    ) {
      if (
        typeof window !== "undefined" &&
        window.location.pathname !== "/login"
      ) {
        const loginUrl = new URL("/login", window.location.origin);
        loginUrl.searchParams.set(
          "next",
          `${window.location.pathname}${window.location.search}`
        );
        window.location.assign(loginUrl.toString());
      }
      throw new ApiError(
        401,
        body.error.code,
        body.error.message,
        body.error.request_id
      );
    }
    if (isErrorResponse(body)) {
      throw new ApiError(
        response.status,
        body.error.code,
        body.error.message,
        body.error.request_id
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
  path: string,
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
  path: string,
  formData: FormData
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    body: formData,
  });

  return parseApiResponse<T>(response);
}

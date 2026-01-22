/**
 * Client-side API fetch helper for browser components.
 *
 * This module provides typed fetch utilities for making API calls
 * from client components to the BFF API routes.
 */

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
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ErrorResponse).error === "object"
  );
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
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  // Try to parse JSON response
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Non-JSON response
    if (!response.ok) {
      throw new ApiError(
        response.status,
        "E_UNKNOWN",
        `Request failed with status ${response.status}`
      );
    }
    return undefined as T;
  }

  // Check for error response
  if (!response.ok) {
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

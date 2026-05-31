import "server-only";

import { cookies } from "next/headers";
import { ApiError } from "@/lib/api/client";
import { getInternalApiConfig } from "@/lib/api/internal-config";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import { createRandomId } from "@/lib/createRandomId";
import { isRecord } from "@/lib/validation";

const FASTAPI_FETCH_TIMEOUT_MS = 30_000;

function readApiErrorBody(body: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
} {
  if (!isRecord(body) || !isRecord(body.error)) {
    return {};
  }
  return {
    code: typeof body.error.code === "string" ? body.error.code : undefined,
    message: typeof body.error.message === "string" ? body.error.message : undefined,
    requestId:
      typeof body.error.request_id === "string" ? body.error.request_id : undefined,
  };
}

/**
 * Server-side equivalent of `apiFetch`: reads the Supabase session cookie,
 * forwards the access token to FastAPI, and parses the response with the same
 * ApiError semantics as the browser path. Middleware (`updateSession`) has
 * already redirected `refreshable` sessions through `/auth/refresh`, so the
 * cookie is always `active` by the time a server component runs.
 */
export async function callFastAPI<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const session = readSupabaseSessionCookie(cookieStore.getAll());
  if (session.state !== "active") {
    throw new ApiError(401, "E_UNAUTHENTICATED", "Authentication required");
  }
  const config = getInternalApiConfig();
  if (!config.fastApiBaseUrl) {
    throw new ApiError(500, "E_INTERNAL", "Backend service is not configured");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (config.internalSecret) {
    headers["X-Nexus-Internal"] = config.internalSecret;
  }
  const requestId = createRandomId();
  headers["X-Request-ID"] = requestId;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FASTAPI_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.fastApiBaseUrl}${path}`, {
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(
        504,
        "E_UPSTREAM_TIMEOUT",
        "Backend service timed out",
        requestId,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "E_INVALID_RESPONSE",
      "API returned a non-JSON response",
    );
  }
  if (!response.ok) {
    const err = readApiErrorBody(body);
    throw new ApiError(
      response.status,
      err.code ?? "E_UNKNOWN",
      err.message ?? `Request failed with status ${response.status}`,
      err.requestId,
    );
  }
  return body as T;
}

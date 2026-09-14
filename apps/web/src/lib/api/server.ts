import "server-only";

import { cookies } from "next/headers";
import { ApiError, parseApiResponse } from "@/lib/api/client";
import { getEnv } from "@/lib/env";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";

const FASTAPI_FETCH_TIMEOUT_MS = 30_000;

/**
 * Server-side equivalent of `apiFetch`: reads the Supabase session cookie,
 * forwards the access token to FastAPI, and parses the response with the same
 * ApiError semantics as the browser path. The page/session gate owns browser
 * recovery; this server consumer never redirects or refreshes. It forwards
 * only an active session and reports every other cookie state as
 * `E_UNAUTHENTICATED`. Route handlers that own a response resolve refreshable
 * sessions inline before calling FastAPI.
 */
export async function callFastAPI<T>(
  path: string,
  options?: { timeoutMs?: number },
): Promise<T> {
  const cookieStore = await cookies();
  const session = readSupabaseSessionCookie(cookieStore.getAll());
  if (session.state !== "active") {
    throw new ApiError(401, "E_UNAUTHENTICATED", "Authentication required");
  }
  const config = getEnv().internalApi;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (config.internalSecret) {
    headers["X-Nexus-Internal"] = config.internalSecret;
  }
  const requestId = createRandomId();
  headers["X-Request-ID"] = requestId;
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? FASTAPI_FETCH_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  const timeoutError = () => new ApiError(
    504, "E_UPSTREAM_TIMEOUT", "Backend service timed out", requestId,
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${config.fastApiBaseUrl}${path}`, {
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError(0, "E_NETWORK", "Backend request failed", requestId);
    }
    const body = await parseApiResponse<T>(response);
    if (performance.now() >= deadline) throw timeoutError();
    return body;
  } catch (error) {
    if (controller.signal.aborted && isAbortError(error)) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

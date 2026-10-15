import "server-only";

import { cookies } from "next/headers";
import { ApiError } from "@/lib/api/client";
import { getEnv } from "@/lib/env";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { readBearer } from "@/lib/supabase/cookie";
import { isRecord } from "@/lib/validation";
import { isSuggestionJsonPath, SUGGESTIONS_REQUEST_TIMEOUT_MS } from "./suggestionPolicy";

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
 * Forwards a decoded cookie bearer to the verifying API without reapplying the
 * session owner's renewal margin. This consumer never redirects or refreshes.
 * Transport failures remain distinct from invalid same-system JSON; the deadline
 * covers both response headers and body consumption.
 */
export async function callFastAPI<T>(
  path: string,
  options?: { timeoutMs?: number },
): Promise<T> {
  const cookieStore = await cookies();
  const bearer = readBearer(cookieStore.getAll());
  if (bearer === null) {
    throw new ApiError(401, "E_UNAUTHENTICATED", "Authentication required");
  }
  const config = getEnv().internalApi;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
  };
  if (config.internalSecret) {
    headers["X-Nexus-Internal"] = config.internalSecret;
  }
  const requestId = createRandomId();
  let responseId = requestId;
  headers["X-Request-ID"] = requestId;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? (
      isSuggestionJsonPath(path) ? SUGGESTIONS_REQUEST_TIMEOUT_MS : FASTAPI_FETCH_TIMEOUT_MS
    ),
  );
  // Only the exchange and body acquisition use this boundary. URL/header
  // validation, JSON parsing and callers' payload handling keep their defects.
  const transportError = (error: unknown): never => {
    if (controller.signal.aborted && isAbortError(error)) {
      throw new ApiError(504, "E_UPSTREAM_TIMEOUT", "Backend service timed out", responseId);
    }
    if (error instanceof TypeError) {
      throw new ApiError(0, "E_NETWORK", "Network request failed", responseId);
    }
    throw error;
  };
  try {
    const url = new URL(`${config.fastApiBaseUrl}${path}`);
    const requestHeaders = new Headers(headers);
    const response = await fetch(url, {
      headers: requestHeaders,
      cache: "no-store",
      signal: controller.signal,
    }).catch(transportError);
    const upstreamId = response.headers.get("x-request-id");
    if (upstreamId && /^[A-Za-z0-9._:-]{1,128}$/.test(upstreamId)) responseId = upstreamId;
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    // The same narrow gateway contract as the BFF proxy. Claimed JSON must
    // still decode, even when its status is a gateway failure.
    if ([502, 503, 504].includes(response.status) && contentType !== "application/json") {
      controller.abort();
      throw new ApiError(
        response.status,
        response.status === 504 ? "E_UPSTREAM_TIMEOUT" : "E_UPSTREAM",
        response.status === 504 ? "Backend service timed out" : "Backend service unavailable",
        responseId,
      );
    }
    if (response.status === 204 || response.status === 205) {
      // justify-type-assertion: these statuses intentionally carry no JSON body.
      return undefined as T;
    }
    const text = await response.text().catch(transportError);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // justify-defect: this owned JSON transport returned an undecodable body.
      throw new ApiError(
        response.status,
        "E_INVALID_RESPONSE",
        "API returned a non-JSON response",
        responseId,
      );
    }
    if (!response.ok) {
      const err = readApiErrorBody(body);
      throw new ApiError(
        response.status,
        err.code ?? "E_UNKNOWN",
        err.message ?? `Request failed with status ${response.status}`,
        err.requestId ?? responseId,
      );
    }
    // justify-type-assertion: generated wire types describe this same-deploy API.
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

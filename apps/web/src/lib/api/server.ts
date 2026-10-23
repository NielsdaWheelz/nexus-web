// FastAPI from server components (the workspace bootstrap): the cookie's
// bearer, the internal secret, a fresh request id, this device and this
// build's wire revision. It never refreshes and never reapplies the session
// owner's renewal margin: no bearer is E_UNAUTHENTICATED and the page gate
// owns recovery (the api verifies the bearer).
import "server-only";

import { cookies } from "next/headers";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import { createRandomId } from "@/lib/createRandomId";
import { getEnv } from "@/lib/env";
import { isAbortError } from "@/lib/errors";
import { readBearer } from "@/lib/supabase/cookie";
import { ApiError, readResponse, WIRE_HEADER } from "./client";
import { WIRE_REVISION } from "./wire.gen";
import { isSuggestionJsonPath, SUGGESTIONS_REQUEST_TIMEOUT_MS } from "./suggestionPolicy";

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * One GET; the deadline (default 30 s) covers the headers and the body. Only
 * the exchange and the body read are transport (timeout, network, a gateway's
 * bare 502/503/504, the bff's contract); url and header validation, json
 * parsing and the caller's handling keep their defects.
 */
export async function callFastAPI<T>(
  path: string,
  { timeoutMs = 30_000, context }: {
    timeoutMs?: number;
    context?: { accessToken: string; deviceId: string };
  } = {},
): Promise<T> {
  const store = await cookies();
  const bearer = context?.accessToken ?? readBearer(store.getAll());
  if (bearer === null) {
    throw new ApiError(401, "E_UNAUTHENTICATED", "Authentication required");
  }
  const { fastApiBaseUrl, internalSecret } = getEnv().internalApi;
  let answerId = createRandomId();
  const url = new URL(`${fastApiBaseUrl}${path}`);
  const headers = new Headers({
    authorization: `Bearer ${bearer}`,
    "x-request-id": answerId,
    [WIRE_HEADER]: String(WIRE_REVISION),
  });
  if (internalSecret) headers.set("x-nexus-internal", internalSecret);
  const device = context?.deviceId ?? readDeviceId(store);
  if (device) headers.set("x-nexus-device", device);
  const controller = new AbortController();
  const budget = isSuggestionJsonPath(path)
    ? Math.min(timeoutMs, SUGGESTIONS_REQUEST_TIMEOUT_MS)
    : timeoutMs;
  const timer = setTimeout(() => controller.abort(), budget);
  const transport = (error: unknown): never => {
    if (controller.signal.aborted && isAbortError(error)) {
      const message = "Backend service timed out";
      throw new ApiError(504, "E_UPSTREAM_TIMEOUT", message, answerId);
    }
    if (error instanceof TypeError) {
      throw new ApiError(0, "E_NETWORK", "Network request failed", answerId);
    }
    throw error;
  };
  try {
    // the explicit signal keeps next from caching this exchange's lifetime
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: controller.signal,
    }).catch(transport);
    const upstreamId = response.headers.get("x-request-id");
    if (upstreamId && REQUEST_ID.test(upstreamId)) answerId = upstreamId;
    const json = /^application\/json\s*(;|$)/i.test(
      response.headers.get("content-type") ?? "",
    );
    if ([502, 503, 504].includes(response.status) && !json) {
      controller.abort();
      throw response.status === 504
        ? new ApiError(504, "E_UPSTREAM_TIMEOUT", "Backend service timed out", answerId)
        : new ApiError(response.status, "E_UPSTREAM", "Backend service unavailable", answerId);
    }
    return await readResponse<T>(response).catch(transport);
  } finally {
    clearTimeout(timer);
  }
}

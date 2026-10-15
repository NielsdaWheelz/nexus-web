// The bff (docs/modules/api-edge.md): every browser, apk and extension request
// reaches FastAPI here. A lane decides what crosses: an allow-listed header set
// in; the bearer, internal secret, request id, device and (for callers that
// cannot set headers) this build's wire revision added; an allow-listed header
// set out. Upstream credentials and cookies never reach the caller (I1).
import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import { ended, finish, isSameOrigin, liveSession } from "@/lib/auth/session";
import { createRandomId } from "@/lib/createRandomId";
import { getEnv } from "@/lib/env";
import { isAbortError } from "@/lib/errors";
import { PUBLIC_API_CSP } from "@/lib/security/csp";
import { AuthUnavailable } from "@/lib/supabase/auth";
import { WIRE_REVISION } from "./wire.gen";
import { isSuggestionJsonPath, SUGGESTIONS_REQUEST_TIMEOUT_MS } from "./suggestionPolicy";

/**
 * Json: structured calls (30 s to response headers; suggestions 10 s through
 * their bounded JSON body). Asset: bytes an element
 * loads (it cannot name a wire, so the bff names its own; FastAPI's cache
 * policy kept). Stream: event streams, ended cleanly at 280 s, before the
 * route's maxDuration. Copy: the offline reading copy's slow build.
 */
export type SessionLane = "Json" | "Asset" | "Stream" | "Copy";

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LONG_MS = 280_000;
const SESSION_IN =
  "content-type accept range if-none-match if-modified-since idempotency-key x-nexus-wire";
const SESSION_OUT =
  "content-type cache-control etag vary content-disposition x-content-type-options content-security-policy accept-ranges content-range location";
const SHARE_OUT =
  "content-type content-length content-disposition accept-ranges content-range";
const SHARE_SECURITY = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": PUBLIC_API_CSP,
};

function pick(source: Headers, names: string): Headers {
  const headers = new Headers();
  for (const name of names.split(" ")) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function failure(id: string, status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message, request_id: id } },
    { status, headers: { "x-request-id": id } },
  );
}

/** The bff's own word for an api it could not reach or a gateway's bare answer. */
function unreachable(id: string, status: number) {
  return status === 504
    ? failure(id, 504, "E_UPSTREAM_TIMEOUT", "Backend service timed out")
    : failure(id, status, "E_UPSTREAM", "Backend service unavailable");
}

function requestId(request: Request): string {
  const value = request.headers.get("x-request-id");
  return value && REQUEST_ID.test(value) ? value : createRandomId();
}

/** Ends the body cleanly after `ms`; the client resumes from its cursor. */
function cutAfter(body: ReadableStream<Uint8Array>, ms: number) {
  const reader = body.getReader();
  const timer = setTimeout(() => void reader.cancel(), ms);
  const stop = () => clearTimeout(timer);
  // the timer lives as long as the body: ended, failed upstream or cancelled
  void reader.closed.then(stop, stop);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * The one transport: request id, internal secret, a deadline to the response
 * headers, the client's abort until the body is done, 502/504/499 for what
 * never answered, the envelope for a gateway's bare 502/503/504. No encoded
 * slash crosses: uvicorn decodes %2F, so FastAPI would split a segment the
 * lane checked whole.
 */
async function forward(input: {
  request: Request;
  path: string;
  id: string;
  headers: Headers;
  out: string;
  deadlineMs: number;
  cutMs?: number;
}): Promise<NextResponse> {
  const { request, path, id, headers } = input;
  if (/%2f/i.test(path)) return failure(id, 404, "E_NOT_FOUND", "Not found");
  const { fastApiBaseUrl, internalSecret } = getEnv().internalApi;
  headers.set("x-request-id", id);
  if (internalSecret) headers.set("x-nexus-internal", internalSecret);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const boundedJson = isSuggestionJsonPath(path);
  let bodyOwnsDeadline = false;
  const deadline = setTimeout(abort, boundedJson ? SUGGESTIONS_REQUEST_TIMEOUT_MS : input.deadlineMs);
  const release = () => {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", abort);
  };
  // the client may have left already, or leave before next reads the body
  if (request.signal.aborted) abort();
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    const { method } = request;
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const upstream = await fetch(
      `${fastApiBaseUrl}${path}${new URL(request.url).search}`,
      { method, headers, body, signal: controller.signal },
    );
    const upstreamId = upstream.headers.get("x-request-id");
    const answerId =
      upstreamId && REQUEST_ID.test(upstreamId) ? upstreamId : id;
    // claimed json passes: an invalid answer from the api itself is a defect
    const json = /^application\/json\s*(;|$)/i.test(
      upstream.headers.get("content-type") ?? "",
    );
    if ([502, 503, 504].includes(upstream.status) && !json) {
      // the body may have errored already; abort releases it regardless
      controller.abort();
      const failed = unreachable(answerId, upstream.status);
      return method === "HEAD" ? new NextResponse(null, failed) : failed;
    }
    const out = pick(upstream.headers, input.out);
    out.set("x-request-id", answerId);
    const empty =
      method === "HEAD" || [204, 205, 304].includes(upstream.status);
    let content: ReadableStream<Uint8Array> | null = empty ? null : upstream.body;
    if (content !== null && boundedJson) {
      const reader = content.getReader();
      bodyOwnsDeadline = true;
      // Suggestions keep their deadline through streaming body consumption.
      // Closure also releases a body which the downstream never starts reading.
      void reader.closed.then(release, release);
      content = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const { done, value } = await reader.read();
            if (done) output.close();
            else output.enqueue(value);
          } catch (error) {
            output.error(error);
          }
        },
        cancel(reason) {
          release();
          controller.abort();
          return reader.cancel(reason);
        },
      });
    } else if (content !== null && input.cutMs) {
      content = cutAfter(content, input.cutMs);
    }
    return new NextResponse(content, { status: upstream.status, headers: out });
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("bff_upstream_failed", error);
      return unreachable(id, 502);
    }
    return request.signal.aborted
      ? new NextResponse(null, { status: 499, headers: { "x-request-id": id } })
      : unreachable(id, 504);
  } finally {
    if (!bodyOwnsDeadline) {
      if (boundedJson) release();
      else clearTimeout(deadline);
    }
  }
}

/** The session lane: cookies in, the bearer to FastAPI, private answers out (I2, I7, I9). */
export async function proxySession(
  request: Request,
  path: string,
  lane: SessionLane,
): Promise<Response> {
  const id = requestId(request);
  const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  if (mutation && !isSameOrigin(request)) {
    return finish(
      failure(id, 403, "E_FORBIDDEN", "Cross-origin request rejected"),
    );
  }
  let live;
  try {
    live = await liveSession();
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    const message = "Authentication service unavailable";
    return finish(failure(id, 503, "E_AUTH_UNAVAILABLE", message));
  }
  const unauthenticated = () =>
    failure(id, 401, "E_UNAUTHENTICATED", "Authentication required");
  if (live.kind === "Anonymous") return finish(unauthenticated());
  if (live.kind === "Ended") {
    return finish(unauthenticated(), ended(live.cookieNames));
  }
  const headers = pick(request.headers, SESSION_IN);
  headers.set("authorization", `Bearer ${live.accessToken}`);
  const device = readDeviceId(await cookies());
  if (device) headers.set("x-nexus-device", device);
  if (lane === "Asset" || lane === "Stream") {
    headers.set("accept-encoding", "identity");
  }
  if (lane === "Asset") headers.set("x-nexus-wire", String(WIRE_REVISION));
  const response = await forward({
    request,
    path,
    id,
    headers,
    out: lane === "Asset" ? `${SESSION_OUT} content-length` : SESSION_OUT,
    deadlineMs: lane === "Copy" ? LONG_MS : 30_000,
    cutMs: lane === "Stream" ? LONG_MS : undefined,
  });
  if (response.status === 401) {
    void response.body?.cancel();
    return finish(unauthenticated(), ended(live.cookieNames));
  }
  const cache = response.headers.get("cache-control");
  finish(response, { kind: "Write", writes: live.writes });
  // an answer that writes no cookie keeps FastAPI's own cache policy (D1)
  if (lane === "Asset" && cache && live.writes.length === 0) {
    response.headers.set("cache-control", cache);
  }
  if (lane === "Stream") {
    response.headers.set("cache-control", "private, no-store, no-transform");
  }
  return response;
}

/** The anonymous share lane: the share token in, the security headers always out. */
export async function proxyShare(
  request: Request,
  path: string,
): Promise<Response> {
  const token = "x-nexus-share-token";
  const headers = pick(
    request.headers,
    path.endsWith("/file") ? `${token} range` : token,
  );
  headers.set("accept-encoding", "identity");
  headers.set("x-nexus-wire", String(WIRE_REVISION));
  const id = requestId(request);
  const response = await forward({
    request,
    path,
    id,
    headers,
    out: SHARE_OUT,
    deadlineMs: 30_000,
  });
  for (const [name, value] of Object.entries(SHARE_SECURITY)) {
    response.headers.set(name, value);
  }
  return response;
}

/**
 * The extension lane: its own bearer and its own wire, json both ways; every
 * answer private (Cache-Control private, no-store; Vary: Cookie), as main's
 * #607 finalized it, with no cookie effect.
 */
export async function proxyExtension(
  request: Request,
  path: string,
): Promise<Response> {
  const id = requestId(request);
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^bearer /i.test(authorization)) {
    return finish(
      failure(id, 401, "E_UNAUTHENTICATED", "Extension token required"),
    );
  }
  const headers = pick(
    request.headers,
    "content-type accept idempotency-key x-nexus-wire",
  );
  headers.set("authorization", authorization);
  headers.set("accept-encoding", "identity");
  const out = "content-type";
  return finish(
    await forward({ request, path, id, headers, out, deadlineMs: 30_000 }),
  );
}

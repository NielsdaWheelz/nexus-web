/**
 * E2E-only network fault injector in front of the real FastAPI backend.
 *
 * This is a dedicated, test-tier-owned HTTP pass-through proxy. It is started
 * exclusively by the Playwright `webServer` machinery (see
 * `e2e/playwright.config.ts` and `make reader-profile-upstream-proxy-e2e`) and
 * is never imported by, bundled with, or compiled into `apps/web` or
 * `python/`. It exists only under `e2e/`.
 *
 * Wiring: the e2e Next.js server's `FASTAPI_BASE_URL` points at this proxy
 * (`READER_PROXY_PORT`); this proxy forwards every request on to the real
 * FastAPI instance (`API_PORT`). Unarmed, it is a transparent byte-for-byte
 * pass-through — headers, status, and (streamed, unbuffered) body — so every
 * e2e project can safely share it and the single underlying Next.js build.
 *
 * Fault injection is scoped to exactly one thing: the AC-1 reader-profile
 * bootstrap recovery proof. `POST /__e2e/reader-profile/fail-next-get` arms
 * the proxy to fail exactly the next `GET /me/reader-profile` with a 502 in
 * FastAPI's own error envelope shape, without forwarding that one request
 * upstream. Every other request — including the next `GET /me/reader-profile`
 * after the armed one fires — is delegated to the real FastAPI untouched.
 *
 * Control endpoints live under `/__e2e/` — a namespace no product route (BFF
 * or FastAPI) uses — so they can never collide with real traffic.
 */

import http from "node:http";

const LISTEN_PORT = Number.parseInt(process.env.READER_PROXY_PORT ?? "8010", 10);
const API_PORT = process.env.API_PORT ?? "8000";
const TARGET_ORIGIN = `http://localhost:${API_PORT}`;

const READER_PROFILE_PATH = "/me/reader-profile";
const CONTROL_PREFIX = "/__e2e/";

const INJECTED_FAILURE_BODY = JSON.stringify({
  error: {
    code: "E_INTERNAL",
    message: "injected upstream failure",
  },
});

// Headers that are per-hop, not end-to-end, or that Node's http.request
// recomputes itself from the target URL/body. Everything else — including
// auth, content-type, cache-control-relevant request headers, etc. — is
// forwarded unchanged so the proxy stays byte-accurate.
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// Armed by POST /__e2e/reader-profile/fail-next-get; consumed by exactly one
// subsequent GET /me/reader-profile.
let armed = false;
// Count of server-to-server GET /me/reader-profile requests observed since
// the last arm or reset (both zero it), so a recovery test can assert
// "exactly two occurred": the injected failure, then the Retry's success.
let profileGets = 0;

function forwardRequestHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    forwarded[name] = value;
  }
  return forwarded;
}

function sendJson(res: http.ServerResponse, status: number, body: string): void {
  const buffer = Buffer.from(body, "utf-8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(buffer.byteLength),
  });
  res.end(buffer);
}

function requestPathname(req: http.IncomingMessage): string {
  return new URL(req.url ?? "/", "http://reader-profile-upstream-proxy.invalid").pathname;
}

// Handles every /__e2e/* control call. Returns true once it has fully
// responded (or refused) the request; false is never reachable for a path
// under CONTROL_PREFIX because unknown control paths get an explicit 404.
function handleControlRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): void {
  req.resume(); // control calls carry no body we care about; drain defensively.

  if (req.method === "GET" && pathname === "/__e2e/health") {
    sendJson(res, 200, JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && pathname === "/__e2e/reader-profile/fail-next-get") {
    armed = true;
    profileGets = 0;
    sendJson(res, 200, JSON.stringify({ armed: true }));
    return;
  }

  if (req.method === "GET" && pathname === "/__e2e/reader-profile/observations") {
    sendJson(res, 200, JSON.stringify({ profileGets }));
    return;
  }

  if (req.method === "POST" && pathname === "/__e2e/reader-profile/reset") {
    armed = false;
    profileGets = 0;
    sendJson(res, 200, JSON.stringify({ armed, profileGets }));
    return;
  }

  sendJson(
    res,
    404,
    JSON.stringify({
      error: {
        code: "E_NOT_FOUND",
        message: `Unknown reader-profile-upstream-proxy control endpoint: ${req.method} ${pathname}`,
      },
    }),
  );
}

// Pipes the client request straight through to the real FastAPI and pipes its
// response straight back — headers, status, and body (streamed, never
// buffered) — so this is byte-accurate for JSON responses and long-lived
// streaming bodies alike.
function forwardToUpstream(req: http.IncomingMessage, res: http.ServerResponse): void {
  const upstreamReq = http.request(
    `${TARGET_ORIGIN}${req.url ?? "/"}`,
    { method: req.method, headers: forwardRequestHeaders(req.headers) },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendJson(
      res,
      502,
      JSON.stringify({
        error: {
          code: "E_INTERNAL",
          message: `reader-profile-upstream-proxy: upstream request failed: ${error.message}`,
        },
      }),
    );
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const pathname = requestPathname(req);

  if (pathname.startsWith(CONTROL_PREFIX)) {
    handleControlRequest(req, res, pathname);
    return;
  }

  if (req.method === "GET" && pathname === READER_PROFILE_PATH) {
    profileGets += 1;
    if (armed) {
      armed = false;
      req.resume(); // GET has no meaningful body, but drain it before short-circuiting.
      sendJson(res, 502, INJECTED_FAILURE_BODY);
      return;
    }
  }

  forwardToUpstream(req, res);
});

server.listen(LISTEN_PORT, () => {
  console.log(
    `[reader-profile-upstream-proxy] listening on :${LISTEN_PORT}, forwarding to ${TARGET_ORIGIN}`,
  );
});

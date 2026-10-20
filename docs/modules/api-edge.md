# api edge

## purpose

Every read, write and live stream between a Nexus client (the browser, the
apk's native client, the firefox extension, the anonymous share reader) and
FastAPI crosses one edge. It authenticates the caller, never hands the browser
the bearer or the internal secret, speaks one envelope and one error taxonomy,
correlates each request with one id, refuses a client built for another wire,
and delivers live state that survives a cut connection.

```
browser / apk webview ─/api/*─▶ next route handler (bff lane) ─▶ caddy ─▶ edge middleware ─▶ auth ─▶ router
apk native (cookies, Origin, wire) ┘   extension (bearer, wire) ┘
server components: callFastAPI ────────────────────────────────────────────▶ (the same api door)
```

## web (`apps/web/src/lib/api`, `app/api`)

- `client.ts`: `apiFetch(path: "/api/…", init)` answers the parsed json (an
  empty 2xx is `undefined`) or throws `ApiError {status, code, message,
  requestId?, details?}`; status 0 `E_NETWORK` is a transport failure. Every
  call carries `X-Nexus-Wire`; `keepalive: true` lets a write outlive the page. `readResponse` is the one envelope reader (the
  request id comes from the body, else the `x-request-id` header). A 426 reloads
  the tab once per (tab, build): a `sessionStorage` marker holds the bundle's
  own revision, the reload passes the page's `beforeunload` guard, and after it
  every 426 reads "Nexus was updated. Reload this page to continue."
  (`STALE_BUILD_COPY`): a caller that models the failure shows it through
  `apiTransportFeedback`; one that throws it (`isStaleBuild`) reaches the pane
  or workspace boundary, which shows it and reports no client defect. The
  workspace save keeps the workspace up.
- `serverState.tsx`: the one owner of keyed async reads.
  `useServerValue({key, stale, visit, load})` and `usePaneFreeServerValue` (no
  pane visit) answer `loading | failed | ready {data, generation, error,
  refreshing}` with `refetch()`. A new key loads (a null key waits); a moved
  `stale` refetches over the shown data; refetches queue behind the read in
  flight. invalidation supersedes that read's success and failure; only the
  current key/stale request may publish. existing snapshots remain while the
  fresh read runs, and queued refetch waiters settle from that fresh read.
  `requestWithRetry` retries transport failures and non-defect 5xx
  three times (I5); a modeled `ApiError` is a failure, a defect throws in
  render (I4), a 401 goes to sign-in (outside the shell it is a failure, which
  share capture shows). A pane return paints the visit's snapshot, then
  refetches. `ServerSeedsProvider` holds the bootstrap's first-paint reads
  (`lib/panes/paneResourceLoaders.ts`) for the entry's active pane (no other
  pane is seeded), under the key of the hook that reads them, the api path. A hook in the pane body's first commit paints
  its first key's seed without a fetch; that commit spends the pane's seeds
  (`ServerSeedsSpent`, beside the body), so every later mount reads and a seed
  no hook took is dropped unread. `useSettled(value, ms)` is a typed query
  once it held still: a search reads by its settled text and shows results
  only for that text.
  `useServerList`/`usePaneFreeServerList` hold server-ordered lists the same
  way (architecture §8.12); `usePagePrefix` is a value over page prefixes.
- `stream.ts`: `openStream({path: "/api/stream/…", after?, decode, isTerminal,
  onEvent, onError, onComplete?, onReconnect?, signal?, maxReconnects = 8,
  maxBackoffMs = 30 s})` returns a stop function. Resume is `?after=<id>` only.
  A 401 sends the tab to login (`handleUnauthenticatedApiError`), never to
  `onError`. Every other 4xx but 429, a non-event-stream answer, a malformed or
  oversized (256 K characters) event and a throwing `decode`/`onEvent` are final
  (`onError` once). Network failures, 5xx and 429 back off from 1 s doubling to
  `maxBackoffMs` with jitter and fire `onReconnect`. A clean end after an event
  (the bff's planned cut) resumes after ~250 ms without counting; a clean end
  without one counts as a failure. A delivered event resets the count.
- `proxy.ts` (server only): `proxySession(request, path, lane)`,
  `proxyShare`, `proxyExtension`. The session lane refuses a cross-origin
  mutation (403), resolves the session before reading a body (ended → 401 and
  the cookies cleared; refreshable → refreshed inline), forwards the allow-listed
  headers (`content-type accept range if-none-match if-modified-since
  idempotency-key x-nexus-wire`) plus the bearer, internal secret, request id
  and `X-Nexus-Device` from `nx_device`, and answers `private, no-store`,
  `Vary: Cookie`. Lanes: `Json` (30 s to response headers), `Asset` (identity
  encoding, `content-length` kept, the bff's own wire, FastAPI's cache policy
  kept when the answer writes no cookie), `Stream` (identity encoding, `private,
  no-store, no-transform`, the body ended cleanly at 280 s), `Copy` (280 s to
  headers). Upstream failures: 502 `E_UPSTREAM`, 504 `E_UPSTREAM_TIMEOUT`, 499
  when the client left. The client leaving ends the upstream request at any
  point, before it starts or with its body unread; the cut's timer ends with
  the body. A path holding an encoded slash is refused 404: uvicorn decodes
  `%2F`, so FastAPI would split a segment a lane checked whole (the json lane's
  denylist). The share lane forwards the share token (+`range` on
  `/file`) and names the bff's wire; `next.config.ts` stamps the share security
  headers on every answer at its path. The extension lane takes the extension's
  bearer and wire.
- `server.ts`: `callFastAPI(path, {timeoutMs = 30 s})` for server components:
  an active session's bearer, the internal secret, a fresh request id, the
  device and the build's wire; it never refreshes.
- routes: `[...path]` (Json; denies `auth docs ingest livez openapi.json public
  readyz redoc version`), `stream/[...path]` (Stream, `maxDuration = 300`),
  `media/[id]/assets/[...assetKey]` and `media/image` (Asset),
  `media/[id]/reading-copy` (Copy, `maxDuration = 300`),
  `public/resource-share/[[...path]]` (share, four closed shapes),
  `extension/[...path]` (`session` is the extension's session),
  `telemetry/client-defects` (a beacon: malformed json is 400; the bff adds
  `release` and names its own wire).

## python (`python/nexus`)

- `api/edge.py`: `WIRE_REVISION` and `EdgeMiddleware`, pure ASGI, outermost.
  It adopts a well-formed inbound `X-Request-ID` (`[A-Za-z0-9._:-]{1,128}`) or
  mints one, binds it to the log context and stamps it on every answer; refuses
  a missing or different `X-Nexus-Wire` with 426 `E_WIRE_MISMATCH` before
  routing (`auth.middleware.PUBLIC_PATHS` are exempt); renders an exception
  nothing claimed before the response started as 500 `E_INTERNAL` with its
  request id (a client disconnect as 499); logs `http.request.completed` with
  status, duration and viewer when the request ends (a stream when it closes or
  its client leaves).
- `app.py`: handlers for `ApiError`, `HTTPException`, and request validation
  (400 `E_INVALID_REQUEST`; 422 `E_INVALID_GENERATION_SELECTION` for a chat
  send's `body.selection`). Auth sits inside the edge.
- `responses.py` (the envelope), `errors.py` (the closed taxonomy; each code
  carries its status), `logging.py`, `api/deps.py` (`DeviceId`: the
  `X-Nexus-Device` header; absent → 400).
- `api/routes/stream.py`: `GET /stream/...` authenticated like every route.
  The chat run stream is a cursor stream (`id: <seq>`, `?after=<seq>`, closes
  after `done`); oracle readings, dossier builds, media processing, metadata
  (done once nothing is unfinished) and podcast subscriptions are snapshot streams (`state` on
  change, `done` when terminal, the whole snapshot again on reconnect). The
  first read happens before any byte; every wake re-reads committed state in a
  fresh session; a keepalive comment follows 15 s of quiet; an entity gone
  mid-stream closes it cleanly. `db/listen.py` holds one autocommit LISTEN
  connection per stream.

## wire revision

One int, `WIRE_REVISION` in `api/edge.py`. `gen:wire` writes it into
`wire.gen.ts`; the web, the extension and the apk (`BuildConfig.NEXUS_WIRE`,
read from `wire.gen.ts` by gradle) send it on every request. It moves at most
once between releases: the first change merged after a release that breaks that
release's clients bumps it; later breaking changes before the next release ride
that bump. The apk treats 426 as retryable and keeps its queues until it is
updated; the extension shows "Update the Nexus extension to keep capturing."

## invariants

- I1 the browser never sees the supabase bearer, the internal secret or a
  `set-cookie` from FastAPI.
- I2 a mutation through the session lane requires `Origin == APP_PUBLIC_URL`.
- I3 every answer the api renders carries `X-Request-ID`.
- I4 a defect (`E_INTERNAL`, `E_UNKNOWN`, `E_INVALID_RESPONSE`, a non-ApiError)
  is never shown as a modeled failure.
- I5 only read operations retry automatically: GETs and the explicitly read-only
  suggestions `/view`. 401 and same-system defects never do.
- I6 a stream's cursor advances only after the consumer accepted the event.
- I7 no client names a device; the bff does, from its httpOnly cookie.
- I8 at most 64 LISTEN connections per api process; one more answers 429.
- I9 session-lane answers are `private, no-store` with `Vary: Cookie`, except
  an asset answer that writes no cookie, which keeps FastAPI's own policy.
- I10 a wire mismatch is refused with 426 before routing, on every lane that
  carries a client build.

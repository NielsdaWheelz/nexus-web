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
  requestId?, details?, retryAfterMs?}`; status 0 `E_NETWORK` is a transport failure. Every
  call carries `X-Nexus-Wire`; a supplied sealed revision must match this build
  and is never rewritten; `keepalive: true` lets a write outlive the page. `readResponse` is the one envelope reader (the
  request id comes from the body, else the `x-request-id` header). decoding is
  pure: the request owner observes failures under its captured account assertion.
  retired-account answers become cancellation and cannot change admission. demand
  requests may test unavailable browser reachability; checking, sign-in and update
  fences remain closed, and native admission remains native-owned. background
  readiness stays separate. parsed current-account success can restore browser
  readiness; a transport failure cannot downgrade terminal admission. a 426 reloads
  the tab once per (tab, build), unless uncommitted writing or incompatible/sealed
  submitted work holds reload: a `sessionStorage` marker holds the bundle's
  own revision, the reload passes the page's `beforeunload` guard, and after it
  every 426 reads "Nexus was updated. Reload this page to continue."
  (`STALE_BUILD_FEEDBACK`: the notice's title, whatever failed, with reload as
  its only action, never the caller's retry): a caller that models the failure
  shows it through `apiTransportFeedback`; one that throws it (`isStaleBuild`)
  reaches the pane or workspace boundary, which shows it and reports no client
  defect. The workspace save keeps the workspace up.
  the existing work provider binds this automatic-reload decision to its current
  loss risks and admitted writing. it does not issue a beforeunload prompt to
  obtain permission for an automatic reload, or queue a deferred reload; normal
  later checks and the explicit reload action retain their existing ownership.
  structured api calls assign `X-Request-ID` before dispatch, preserve a supplied
  id and enforce `cache: "no-store"`. independent application read owners are not
  coordinated by the browser http cache. search manual reads have one aggregate
  operation deadline; an owned expiry remains distinct from caller cancellation.

- `serverState.tsx`: the one owner of keyed async reads.
  `useServerValue({key, stale, visit, load, catalog?})` and `usePaneFreeServerValue` (no
  pane visit) answer `loading | failed | ready {data, source, acceptedStale,
  fresh, generation, error, refreshing}` with strict awaitable `refetch()` and
  non-superseding `revalidate()`. freshness compares the accepted token with
  the requested token; retained data never borrows new authority. A new key loads (a null key waits); a moved
  `stale` refetches over the shown data; invalidation aborts the superseded flight and queues one fresh read.
  invalidation supersedes that read's success and failure; only the
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
  no hook took is dropped unread. accepted route entry also starts declared reads
  while lazy code loads; the same one-use account/visit/route owner holds pending,
  successful or failed outcomes until effect-time claims. mounted hooks own the
  result thereafter. retirement cancels unused work; no completed-read cache
  remains. bootstrap consumption observations reach the existing native owner
  once its account facts and transport are ready.
  concurrent identical reads share only a flight,
  keyed by account, representation/query, policy and prefix demand. subscribers
  cancel independently; the last departure aborts. completed responses never
  suppress later mounts. account generations fence stale success and failure;
  list subscribers append incoming rows to their own retained prefixes.
  `useSettled(value, ms)` is a typed query
  once it held still: a search reads by its settled text and shows results
  only for that text.
  `useServerList`/`usePaneFreeServerList` hold server-ordered lists the same
  way for genuinely paged domains (architecture §8.12); finite saved indexes use
  complete values. paged readers expose only the requested key’s rows and metadata
  from the first render and automatically exhausting active collections quietly.
  same-key refresh retains its usable snapshot; a different key exposes loading
  until its own snapshot exists. `requestedKey` names that requested scope, even
  before a response; initial-wait feedback uses it to retire abandoned queries. private exact-key visit snapshots remain valid. strict
  refresh supersedes; periodic `revalidate()` waits behind admitted reads and
  coalesces observations. these hooks serve server-owned domains. authored
  resources, adjacency, search and references always query the durable local owner.
  installed catalog loaders are explicit local reads, separate from `apiFetch`.
  values, lists and retained snapshots identify their live/catalog source; a
  complete saved result stages a complete live reread before promotion. local
  coverage misses do not suppress admitted remote work. native admission gates
  remote reads and retries; catalog failures do not change session admission.
  see [installed catalog](offline-catalog.md) and
  [device startup](device-startup.md) for local access and apk-update recovery.
- `stream.ts`: `openStream({path: "/api/stream/…", after?, decode, isTerminal,
  onEvent, onError, onSuspended, onComplete?, onReconnect?, signal?, maxReconnects = 8,
  maxBackoffMs = 30 s})` returns a stop function. Resume is `?after=<id>` only.
  hosted 401 starts sign-in (`handleUnauthenticatedApiError`) before `onError`.
  every other 4xx but 429, a non-event-stream answer, a malformed or
  oversized (256 K characters) event and a throwing `decode`/`onEvent` are final
  (`onError` once). same-system api defects are final before retry classification.
  modeled network failures, upstream 5xx and 429 back off from 1 s doubling to
  `maxBackoffMs` with jitter and fire `onReconnect`. A clean end after an event
  (the bff's planned cut) resumes after ~250 ms without counting; a clean end
  without one counts as a failure. A delivered event resets the count. exhaustion
  retains the final normalized error, including its code and available request id.
  installed admission suspends the same owner/cursor without spending its budget.
  an account stream retains its original account assertion through reconnect and
  stops delivery when that owner retires; a readiness event never retargets it.
- `proxy.ts` (server only): `proxySession(request, path, lane)`,
  `proxyShare`, `proxyExtension`. The session lane refuses a cross-origin
  mutation (403), resolves the session before reading a body (ended → 401 and
  the cookies cleared; refreshable → refreshed inline). ordinary android requests
  are passive: no rotation or clearing, including assets/streams. the fixed native
  credential operations own those effects ([installed workspace](device-startup.md)).
  it forwards the allow-listed
  headers (`content-type accept range if-none-match if-modified-since
  idempotency-key x-nexus-wire`) plus the bearer, internal secret, request id
  and `X-Nexus-Device` from `nx_device`, and answers `private, no-store`,
  `Vary: Cookie`; `Retry-After` is forwarded and parsed as delay-seconds or
  an http-date. Lanes: `Json` (30 s to response headers), `Asset` (identity
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

the pinned next route-writer patch backports [upstream #98044](https://github.com/vercel/next.js/pull/98044):
ordinary headers retain scalar values so existing compression can negotiate json.
cookie splitting, declared multivalue headers and stream restrictions are unchanged.

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
  after `done`); oracle readings, media processing, metadata
  (done once nothing is unfinished) and podcast subscriptions are snapshot streams (`state` on
  change, `done` when terminal, the whole snapshot again on reconnect).
  writing is an account revision stream: initial/changed `state {revision}`,
  with a fresh committed revision read on each existing 15-second timeout even
  if a postgres notification was lost. the browser probes only watched lanes.
  snapshot setup acquires LISTEN before its initial read and accepts that snapshot
  before response construction, so refusal is structured json. the first wake
  consumes that snapshot; later wakes re-read committed state in a fresh session.
  a keepalive comment follows 15 s of quiet; an entity gone
  mid-stream closes it cleanly. `db/listen.py` holds one autocommit LISTEN
  connection per stream. setup owns cleanup until response construction; the
  response's `__call__` finally owns it afterward, including failed header sends.
  listener close shields its complete idempotent cleanup and releases capacity
  after connection closure settles. synchronous preflight queries retain their
  existing cancellation/settlement semantics.

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

## authored transport

all authenticated `/authored` routes require `X-Nexus-Account` matching the verified
viewer. the header is a local-binding assertion, never another identity authority;
wrong or missing assertions return 403 before a transaction. wire mismatch remains
426, invalid authored schema 400, source gaps/foreign identities 409.

`POST /authored/replicas` admits a fresh replica; `POST /authored/changes` retries
immutable contiguous source commands. accepted prefixes are compared and skipped.
`GET /authored/changes?after=…` captures one head and returns a bounded complete
ascending prefix, never a cursor past unapplied commands.

`GET /authored/snapshot` uses a dedicated streaming bff route with `Stream`,
`maxDuration=300`, no buffering and no-store/no-transform. its ndjson header and
footer repeat the same repeatable-read head/lamport; the footer includes exact
counts. cancellation closes its server transaction even if the iterator is
suspended. the existing 280-second stream deadline still applies. writing-stream
`state {revision}` now carries the account feed head and is only a catch-up hint.

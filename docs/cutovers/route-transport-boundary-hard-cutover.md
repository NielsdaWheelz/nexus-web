# Route Transport Boundary Hard Cutover

## Status

Rev 2 — corrected against an SME implementation-readiness review (live-code-verified). Not built.

### Revision log

Rev 2 fixed the following against the working tree before the doc is execution-ready:
- **Media split ordering (High).** `/media/image` and every other static `/media/<literal>` path collides with `/media/{media_id}` once split across routers (`media.py:89-92` documents the intra-file ordering). Added a cross-router include-order invariant + order test (§6.4).
- **Media service ownership (High).** Corrected the `media_ingest` router's real service deps (`media`, `upload`, `epub_lifecycle`, `media_retry`), clarified these are legitimate delegations, and fixed the transcript module name to `podcasts.transcripts` (§6.1, §13).
- **Service URL inventory was stale (High).** The oracle literal is `services/oracle_plates.py:42`, not `oracle.py:146`; `oracle_plate_url` already exists and must *delegate*, not be re-defined; the `epub_ingest.py:1563` classifier is too broad and must become an exact media-asset matcher (§5.3, §7.6).
- **Oracle SSE gone-state (High).** A gone-code catch alone does not close a deleted oracle reading — `is_reading_terminal` returns `False` for a missing row, so it streams forever. Added the service fix + a dual "raise-or-return-terminal" contract (§7.1).
- **Stream-token rate limit (High).** The typed contract dropped the route's RPM throttle; kept it an explicit route guard with a test (§7.2).
- **Route-map inaccuracies (Med).** `conversation_references.py` is references CRUD, not "reference-filtered listing"; the "1–3 services" cap was wrong (reader/ingest routers legitimately use five) (§6.1).
- **`has_reference` scope-bypass (Med).** Pinned the existing behavior (scope ignored when `has_reference` set) with a decision + test (§7.4).
- **Missed duplicate parsers (Med).** Bearer parse is also in `extension_sessions.py:41`; stream-path classification is duplicated and drifted between `middleware.py:147` and `stream_cors.py:70`. Both centralized (§5.4, §7.3).
- **Envelope helper too narrow (Med).** Scoped `ok`/`ok_page` to model/paged shapes; binary/204/named-key returns are exempt; no `jsonable_encoder` catch-all (§7.7).
- **BFF claim imprecise (Med).** `api/csp-report` is a public sink, not a proxy; phrased as "BFF proxy handlers" (§5.5).

## 1. Thesis

The FastAPI route layer is, with two exceptions, already a thin transport boundary. A nine-agent survey confirmed that `libraries.py`, `notes.py`, `contributors.py`, `keys.py`, `playback.py`, `search.py`, and every Next.js `api/**` BFF handler are textbook dispatchers (`validate → call one service → success_response`). "Route god file" is therefore a misnomer for this codebase. The real defect is **transport-boundary discipline**, which fails in four distinct ways:

1. **Horizontal god file** — too many capabilities in one router. Only two files qualify: `media.py` (707 lines, 28 endpoints, 9 concerns, 17 service imports) and `conversations.py` (450 lines, 16 handlers, 5 services).
2. **Logic leaking UP into the route** — business decisions in handlers (HTTP status chosen from an untyped dict key, retry-stage dispatch, a visibility-then-mutate precondition, a CSP string built in a handler, scope/pagination guards).
3. **Transport leaking DOWN into services** — the inverse god file: `/api/...` URL strings hard-coded in three service modules, which the audit found already drifting on the `/api` prefix.
4. **Boundary duplication** — three near-identical SSE tail loops, a mismatched SSE frame formatter (a live `Last-Event-ID` foot-gun), bearer-token parsing copied 3–4×, `mine_only` parsing copied 3×, a 137× `model_dump(mode="json")` idiom with per-file `by_alias` folklore, and ~6 route+service double-validations that drift.

The single highest-leverage root cause unifying modes 2 and 4 is **untyped `dict[str, Any]` service returns**: when `mint_stream_token` and the transcript services return bare dicts, the route is *structurally forced* to reach into string keys to choose status codes and re-validate. Typed, discriminated return contracts dissolve a whole class of leaks at once.

This cutover makes the transport boundary uniform: thin routers, one owner per dependency, typed service contracts, no URL strings in services, validation owned once. Hard cutover — no compatibility shims, no dual paths, no fallbacks.

## 2. Goals

- The two true god files (`media.py`, `conversations.py`) split into per-capability routers mirroring the extant `conversation_references.py` / `playback.py` pattern. Each router imports only the services it directly delegates to.
- Every leaked business decision (mode 2) repatriated to its owning service. No route reads `result[...]` to choose an HTTP status, builds a security policy, runs domain dispatch, or owns a domain invariant.
- Every `/api/...` and `/stream/...` path literal (mode 3) removed from `nexus/services/**` and owned by one dependency-free module.
- The three SSE tail loops collapsed to one transport owner exposing **two** typed primitives (cursor and snapshot) — not one flag-driven generic. One `format_sse_event`. One set of keepalive constants.
- Stream-token capability moved out of the `auth/` adapter into a service with a typed return; the route-layer `Depends` adapter relocated out of a route file into `api/deps.py`.
- Bearer-token parsing owned by one function. Every validation owned once: transport shape at the boundary, domain invariant in the service, never both.
- One response-envelope converter replaces the 137 hand-written `model_dump(mode="json")` projections; one serialization mechanism across all product routes.
- Router registration uniform: one tag owner, one prefix convention, one registration site.
- Frontend auth-route duplication (handoff mint, internal headers, `noStore`, rotated cookies) collapsed to single owners.

## 3. Non-Goals

- **No service-internal decomposition** beyond the boundary moves named here. The library/search/notes/oracle service god files are out of scope (owned by the cleanliness audit backlog); this cutover only repatriates *route-leaked* logic into existing or thinly-new services.
- **No new media/oracle/podcast service ownership.** Those are owned by `media-service-owned-assets-hard-cutover.md` and `podcast-subsystem-ownership-hard-cutover.md`. This cutover *consumes* their typed contracts and is sequenced after their service extractions land (§13).
- **No URL contract changes.** Every browser-facing and BFF path stays byte-identical. Routers are reorganized; paths are not.
- **No auth protocol changes.** Supabase flows, the stream-token JWT format, the JTI replay table, and middleware JWT verification are unchanged in behavior.
- **No new abstractions that don't earn their place.** No generic SSE mega-function, no envelope wrapper that only renames `model_dump`, no `get_viewer` relocation churn across 200 call sites.
- **No DB schema changes.** This is a pure transport-boundary refactor. There is no migration.

## 4. Governing Rules

- `docs/rules/layers.md`: "FastAPI route handlers: validate input, call services, return response envelopes." "Route handlers must not contain business logic beyond input validation and response shaping." "Services: business logic. No HTTP or framework types." "Services must not import from route handlers or middleware."
- `docs/rules/cleanliness.md` §God files: "Keep boundary and controller files as thin dispatchers; put real behavior in the unit that owns it, never in a new middle layer. Parse transport shapes at the boundary and pass typed values inward; keep business logic out of transport handlers." §Duplication: "If a value is sanitized, validated, or derived in more than one place, cut it to one." §Indirection: "prefer a little duplication over a hollow generic helper." §Ownership: "Replace cross-module imports of private helpers by moving the code to its owner."
- `docs/rules/transport.md`: "Treat the transport layer as a delivery pipe that can disconnect and reconnect without interrupting in-flight application work."
- `docs/rules/module-apis.md`: "Expose each capability in one primary form. Do not expose interchangeable duplicate APIs for the same capability."
- `docs/rules/simplicity.md`: "Do not add speculative API surface. Do not add optional parameters until a real call site needs them."
- `docs/rules/keep-alive.md`, `docs/rules/errors.md`: SSE keepalive cadence; typed-error-at-boundary mapping.

## 5. Pre-Cutover State

### 5.1 The two horizontal god files

- **`media.py`** (707 L, 28 `@router` decorators, imports 17 services). Mixes 9 capabilities: image proxy, EPUB private assets, reader read-model (sections/nav/evidence), media CRUD, URL ingest/capture, upload/ingest/retry lifecycle, reader per-media state, listening state, podcast transcript admission. The service decomposition is in-flight (working tree already has `media_ingest.py`, `listening_state.py`, `epub_assets.py`, `media_file_access.py`), but **the router was never split** — the media cutover spec only required the route to *import* the new services.
- **`conversations.py`** (450 L, 16 handlers, imports 5 services: `conversations`, `conversation_branches`, `conversation_references`, `shares`, `chat_runs`). Mixes conversation CRUD, branches/forks, shares, message CRUD, retrieval/rerank ledgers, and chat-run retry, and squats two URL roots (`/conversations/*` and `/messages/*`).

### 5.2 Logic leaked UP into routes

- `media.py:603` — `status_code = 202 if result["request_enqueued"] else 200`, reaching into an untyped service dict to choose the HTTP status; hand-built `JSONResponse`.
- `media.py:494-523` — retry handler imports two lifecycle services *inside the body* and branches `if body.from_stage == "source"` (domain dispatch).
- `media.py:526-549` — library-add handler runs `get_media_for_viewer` (visibility precondition) then `add_media_to_libraries` then constructs the response (multi-step orchestration).
- `media.py:625-656` — EPUB-asset handler builds a CSP string (`default-src 'none'; img-src 'self' data:; …`) conditional on content type (security policy in transport).
- `media.py:64,67-86` — `_READER_RESUME_STATE_ADAPTER = TypeAdapter(ReaderResumeState)` + `_reader_resume_state_body`: a route-owned TypeAdapter duplicating `services/reader.py:23`, doing full deserialize-and-validate.
- `conversations.py:72-85` — `list_conversations` branches on `has_reference` to pick *which service* owns the query (domain dispatch), producing two divergent payload blocks.
- `conversations.py:87-93` — scope-membership guard duplicating `services/conversations.py:386-390` (route fires first; service guard is dead).
- `conversations.py:343-358` — `list_messages` pagination-mode guards are the *sole* owner; the service (`list_messages`, ~528-574) silently mis-branches on unknown `window`/`cursor` combos and returns wrong-but-200 results.
- `media_events.py:33,103,119-128` — `_TERMINAL_STATUSES` and `_build_state_payload` decide media's terminal/snapshot shape in the route (the cursor streams correctly delegate the terminal decision to their service).

### 5.3 Transport leaked DOWN into services

Verified live inventory (`grep -rn '/api/' python/nexus/services`):
- `services/sanitize_html.py:85` — `IMAGE_PROXY_URL = "/api/media/image?url={encoded_url}"`, used at `:317` to rewrite `<img src>`.
- `services/oracle_plates.py:42` — `f"/api/oracle/plates/{image_id}"` inside an existing `oracle_plate_url()` helper. **Not `oracle.py:146`** (the audit/earlier analysis ref is stale; the oracle-plate owned-asset cutover already moved it).
- `services/epub_ingest.py:1190` — `f"/api/media/{media_id}/assets/{key}"`.
- `services/epub_ingest.py:1563` — `value.startswith("/api/media/")` — a *too-broad* classifier: it also matches `/api/media/image` and any other `/media/*` path. The real intent is "is this an EPUB asset href," i.e. `/api/media/{id}/assets/...`. Replace with an exact media-asset classifier, not a bare prefix.

`oracle_plates.py:42` is already a *helper* (not a raw inline literal), so the move is: `web_paths` owns the template, and `oracle_plate_url()` becomes a thin re-export/delegate, not a second definition.

### 5.4 Boundary duplication

- **SSE**: `stream.py` holds `_tail_chat_run_events` (cursor, with an `E_NOT_FOUND` clean-close guard) and `_tail_oracle_reading_events` (cursor, **no** not-found guard — asymmetry: a reading deleted mid-stream raises unhandled). `media_events.py` holds `_tail_media_events` (snapshot/diff, no cursor). `STREAM_IDLE_TTL_SECONDS`/`KEEPALIVE_INTERVAL_SECONDS` are byte-identical in both files. `_format_sse_event` exists twice with **different arity and different wire output** (`stream.py:162` emits the `id:` resume line; `media_events.py:131` omits it) — an IDE autocomplete swap silently breaks `Last-Event-ID` resume with no type error.
- **DI / auth**: `get_stream_viewer` is defined inside `routes/stream.py:37` and **cross-imported by `routes/media_events.py:21`** (a route importing a sibling route's private helper). The `"bearer "` prefix + `[7:].strip()` parse is hand-rolled in **four** places: `auth/middleware.py`, `auth/extension.py:19-23`, `routes/stream.py:38-47`, and `routes/extension_sessions.py:41-46`. `api/deps.py` owns only `get_llm_router`.
- **Stream-path classification duplicated and drifted**: the set of SSE paths is hand-listed in both `auth/middleware.py:147-153` and `middleware/stream_cors.py:70-75` (`_is_stream_path`). They have already diverged — the middleware copy still lists the dead `/stream/conversations/...` routes; the CORS copy does not. Two authors of one path predicate.
- **Stream-token**: `auth/stream_token.py` is a service in disguise — JWT mint/verify *plus* a serializable-retry JTI replay-prevention table writer (`_claim_jti_once`, `:132-209`) — yet `mint_stream_token` returns a bare `dict` (`:43`), forcing `str(token["token"])` / `.rstrip("/")` coercions at `oracle.py:37-46` and a hand-built `{"data": result}` at `stream_tokens.py:42`.
- **Response envelope**: `success_response` (`responses.py:24`) is single-owned, but the projection into it — `model_dump(mode="json")`, with per-file `by_alias` choices — is copy-pasted 137× across routes; 4 endpoints carry `response_model=` and bypass or double-declare the `{data}` envelope.
- **Validation double-owners** (route + service re-guard the same constraint): conversation scope, oracle question strip/length (`services/oracle.py:155-160`), listening-state all-None, podcast sort/filter literals, chat-run status filter, object-type literal vs `OBJECT_TYPE_VALUES` set, `highlights.py` `mine_only` raw parse ×3.
- **Mid-tier leaks**: `me.py:12,27-31` imports the `WorkspaceSession` ORM model and serializes it inline; `object_links.py:98-99` builds service-input booleans from Pydantic `model_fields_set`; `internal_ingest.py:26-31` converts a service's swallowed `False` into `ApiError`; `browse.py:22-25` re-declares a `Literal` the service owns; `chat_runs.py:48` takes `status: str` validated by an inline if/elif chain.
- **Dead code**: `auth/middleware.py:149-152` bypass entries for removed `/stream/conversations/**/messages` routes + the `TestRemovedStreamingRoutesReturnNotFound` tombstone test; `keys.py:85-94` unreachable `except ValidationError`.

### 5.5 Already gold-standard (do not touch)

- **Error mapping** is the reference design: `ERROR_CODE_TO_STATUS` (`errors.py:171`) + three boundary handlers (`app.py:249-251`, `responses.py:60/78/96`); services raise typed `ApiError` and never touch HTTP. This is the template every other axis is normalized toward.
- **`libraries.py`** — 20 pure dispatchers, one service, one auth surface, and a load-bearing static-before-dynamic route-ordering invariant. Splitting it would manufacture middle-layer boilerplate and break route ordering.
- **The Next.js BFF *proxy* handlers** (`apps/web/src/app/api/**` *except* `api/csp-report`) — uniform, body-untouching single-line forwarders through `proxy.ts`. `api/csp-report/route.ts` is intentionally **not** a proxy — it is a public telemetry sink (parse → log → 204) and is out of scope for the proxy claim.

## 6. Final State

### 6.1 Backend route map (after)

| Router file | Handlers | Sole service(s) it imports |
|---|---|---|
| `conversations.py` | list (incl. `has_reference` listing), create, get, delete | `conversations` (which internally dispatches `has_reference` to `conversation_references`) |
| `conversation_references.py` *(unchanged)* | references **CRUD** — GET/POST/DELETE `/conversations/{id}/references` | `conversation_references` |
| `conversation_branches.py` **(new)** | tree, active-path, forks list/rename/delete | `conversation_branches` |
| `conversation_shares.py` **(new)** | shares get/set | `shares` |
| `messages.py` **(new)** | list_messages, delete_message | `conversations` |
| `message_retrievals.py` **(new)** | retrieval-candidate-ledgers, rerank-ledgers | `message_retrievals` **(new service)** |
| `chat_runs.py` *(gains one handler)* | create/list/get/cancel + **retry** | `chat_runs` |
| `media.py` (slimmed) | list, get, delete, fragments, libraries get/add, refresh | `media`, `media_deletion`, `libraries` |
| `media_ingest.py` **(new)** | from_url, capture/article, capture/file, capture/url, upload/init, ingest, retry | `media_ingest`, `media` (capture), `upload`, `epub_lifecycle` (confirm-ingest), `media_retry` **(new)** — see §13 service-ownership note |
| `media_assets.py` **(new)** | image-proxy, epub-asset | `image_proxy`, `epub_assets` |
| `reader.py` **(new)** | evidence, sections, navigation, reader-state get/put, file | `epub_read`, `reader_navigation`, `reader`, `locator_resolver`, `media_file_access` |
| `listening_state.py` **(new)** | listening-state get/put/batch | `listening_state` |
| `podcast_transcripts.py` **(new)** | transcript request/batch/forecast | `podcasts.transcripts` |
| `stream.py` (slimmed) | chat-run + oracle SSE | `chat_runs`, `oracle`, `_sse` |
| `media_events.py` (slimmed) | media-processing SSE | `media`, `_sse` |

Net: the two god files become 11 thin routers + 1 augmented `chat_runs.py`; no router imports a sibling router's private helper. The "import only the services you delegate to" rule is the bar — **not** a numeric cap; `reader.py` legitimately delegates to five reader-family services and `media_ingest.py` to five ingest-family services. A router calling `media_service.create_captured_web_article` is correct delegation, not a god-file violation. Whether capture/confirm-ingest get dedicated owner services is the media cutover's call (§13), not a precondition of this split.

### 6.2 New shared transport modules

```
python/nexus/api/routes/_sse.py        # SSE transport owner: constants, format_sse_event,
                                        #   tail_cursor_stream, tail_snapshot_stream, STREAM_GONE_CODES
python/nexus/api/deps.py               # + get_stream_viewer (moved out of routes/stream.py)
python/nexus/auth/bearer.py            # parse_bearer_token — the one bearer parser
python/nexus/services/stream_tokens.py # moved from auth/stream_token.py; typed StreamTokenResult / VerifiedStreamToken
python/nexus/services/message_retrievals.py  # ledger queries moved from services/conversations.py
python/nexus/services/media_retry.py   # retry-stage dispatch moved out of routes/media.py
python/nexus/web_paths.py              # the one owner of browser-facing /api/... templates
```

### 6.3 Dependency-injection map (after)

| Dependency | Home | Rationale |
|---|---|---|
| `get_db` | `db/session.py` *(unchanged)* | data layer owns the session lifecycle |
| `get_viewer` | `auth/middleware.py` *(unchanged)* | companion to the middleware that populates `request.state.viewer` |
| `get_extension_viewer` | `auth/extension.py` *(unchanged)* | auth adapter; now calls `parse_bearer_token` |
| `get_stream_viewer` | **`api/deps.py`** (moved from `routes/stream.py`) | shared by two routers; cannot live in one of them |
| `get_llm_router` | `api/deps.py` *(unchanged)* | API-layer shared resource |
| `parse_bearer_token` | **`auth/bearer.py`** (new) | one parser for all four viewers |

### 6.4 Router registration order — a load-bearing invariant of the media split

Today `media.py` relies on **intra-file definition order**: every static `/media/<literal>` route is declared before `/media/{media_id}` so FastAPI/Starlette (which match purely in registration order, with no static-before-dynamic precedence) don't parse `"image"`/`"transcript"`/`"upload"` as a UUID and 422. `media.py:89-92` documents this with an explicit comment.

Splitting `media.py` turns this intra-file ordering into a **cross-router include-order dependency**. The affected static paths and their new owners:

| Static path | New owner router | Collides with |
|---|---|---|
| `/media/image` | `media_assets` | `/media/{media_id}` |
| `/media/from_url`, `/media/capture/article`, `/media/capture/file`, `/media/capture/url`, `/media/upload/init` | `media_ingest` | `/media/{media_id}` |
| `/media/listening-state/batch` | `listening_state` | `/media/{media_id}` |
| `/media/transcript/request/batch`, `/media/transcript/forecasts` | `podcast_transcripts` | `/media/{media_id}` |

**Invariant:** in `create_api_router()`, every router owning a static `/media/<literal>` path (`media_assets`, `media_ingest`, `listening_state`, `podcast_transcripts`) **must be `include_router`'d before** the `media` router that owns `/media/{media_id}`. Within each router, static routes stay declared before that router's own dynamic ones (e.g. `podcast_transcripts` declares `/media/transcript/...` before `/media/{media_id}/transcript/...`). This invariant is enforced by an order test (§11.1, §14.4): a `TestClient` hits each static path and asserts it does **not** return a UUID-parse 422 — i.e., it reaches its intended handler.

## 7. Capability Contracts / API Design

### 7.1 `_sse.py` — two typed primitives, one framer (not a hollow generic)

There are two genuinely different stream semantics; a single `read_fn`-driven coroutine would need flag-soup (`has_cursor`, `dedupe`, `seq_extractor`, `terminal_fn`) — the exact hollow generic `cleanliness.md` forbids. The shared, *identical*, *dangerous* parts (the framer, constants, and the `try/except BaseException/finally close(reason)` envelope) are owned once; the divergent read/emit policy stays as two small tailers.

```python
# python/nexus/api/routes/_sse.py
STREAM_IDLE_TTL_SECONDS = 45.0
KEEPALIVE_INTERVAL_SECONDS = STREAM_IDLE_TTL_SECONDS / 3.0

# Error codes that mean "the streamed resource is gone" → clean terminal close,
# not a 500. Owned here so chat-run and oracle share one policy (fixes the
# oracle asymmetry where a mid-stream-deleted reading currently raises).
STREAM_GONE_CODES: frozenset[ApiErrorCode] = frozenset({
    ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_MEDIA_NOT_FOUND,
})

@dataclass(frozen=True)
class SseEvent:
    seq: int
    event_type: str
    payload: dict[str, Any]

@dataclass(frozen=True)
class CursorPage:
    events: Sequence[SseEvent]
    terminal: bool

@dataclass(frozen=True)
class Snapshot:
    event_type: str          # e.g. "state"
    payload: dict[str, Any]
    terminal: bool           # service-decided

def format_sse_event(*, event_type: str, payload: dict[str, Any], seq: int | None = None) -> str:
    """The ONE SSE framer. Emits the `id:` resume line iff seq is not None."""
    data = json.dumps(payload, separators=(",", ":"))
    head = f"id: {seq}\n" if seq is not None else ""
    return f"{head}event: {event_type}\ndata: {data}\n\n"

async def tail_cursor_stream(
    *, request: Request, listener: StreamNotificationListener, after: int,
    read_after: Callable[[int], Awaitable[CursorPage]],
) -> AsyncIterator[str]: ...
    # append-cursor semantics: emit every new event with its `id:`, advance cursor,
    # terminate on a `done` event or page.terminal; catch ApiError in STREAM_GONE_CODES
    # → clean close; keepalive on KEEPALIVE_INTERVAL_SECONDS; finally close(reason).

async def tail_snapshot_stream(
    *, request: Request, listener: StreamNotificationListener,
    read_snapshot: Callable[[], Awaitable[Snapshot]],
) -> AsyncIterator[str]: ...
    # snapshot/diff semantics: emit `state` only on payload change (no `id:`),
    # emit `done` and terminate on snapshot.terminal; same gone/keepalive/finally envelope.
```

`stream.py` keeps the two route decorators + `StreamingResponse` wiring + `_parse_last_event_id`, and supplies a `read_after` closure per stream. `media_events.py` keeps its decorator + a `read_snapshot` closure. The media terminal/snapshot decision moves to the service:

```python
# python/nexus/services/media.py  (addition)
@dataclass(frozen=True)
class MediaEventSnapshot:
    payload: dict[str, Any]
    terminal: bool          # owns the former route-level _TERMINAL_STATUSES

def read_event_snapshot(db, viewer_id: UUID, media_id: UUID) -> MediaEventSnapshot: ...
```

**Mid-stream deletion — the three streams surface "gone" differently, and the contract must cover both mechanisms.** Verified live behavior: chat-run reads **raise** `E_NOT_FOUND` for a gone run, media snapshot reads **raise** `E_MEDIA_NOT_FOUND` for gone media — so `STREAM_GONE_CODES` cleanly closes those. **Oracle does neither**: `get_reading_events` (`services/oracle.py:556`) has no existence check (returns `[]`), and `is_reading_terminal` (`:572`) returns `status in ("complete","failed")`, which is `False` for an absent row — so a deleted oracle reading would stream forever. A gone-code catch alone does not fix this. The contract is therefore: **a cursor read surfaces "gone" by EITHER raising an `ApiError` in `STREAM_GONE_CODES` (chat-run, media) OR returning `CursorPage(events=[], terminal=True)` (the typed gone-terminal path).** Slice 1 fixes the oracle service so a missing reading is terminal — `is_reading_terminal` (and the page the oracle `read_after` closure returns) treats an absent row as `terminal=True`. A characterization test asserts that mid-stream deletion closes the stream cleanly on **all three** SSE endpoints (§14.4). The two close mechanisms coexist in `tail_cursor_stream`; neither is removed.

### 7.2 `services/stream_tokens.py` — typed contract (moved from `auth/`)

```python
# python/nexus/services/stream_tokens.py  (was auth/stream_token.py — JTI table writer stays internal)
@dataclass(frozen=True)
class StreamTokenResult:
    token: str
    stream_base_url: str      # already normalized (no trailing slash)
    expires_at: str           # ISO-8601

@dataclass(frozen=True)
class VerifiedStreamToken:
    user_id: UUID
    jti: str

def mint_stream_token(user_id: UUID) -> StreamTokenResult: ...
def verify_stream_token(token: str) -> VerifiedStreamToken: ...
```

Consumers: `routes/oracle.py` reads `result.token` / `result.stream_base_url` / `result.expires_at` (the `str(...)` / `.rstrip("/")` casts are deleted — `stream_base_url` is normalized at the source). `routes/stream_tokens.py` returns `success_response({...})` over the typed result. `api/deps.get_stream_viewer` calls `verify_stream_token(token).user_id`.

**Rate limiting must survive the move.** `routes/stream_tokens.py:37-39` calls `rate_limiter.check_rpm_limit(viewer.user_id)` *before* minting — the same per-user RPM throttle shared with chat-run creation. It is a cross-endpoint throttle, not stream-token business logic, so it **stays an explicit guard in the route**, not silently absorbed into `mint_stream_token` (which would couple the service to a limiter and make the throttle invisible). The typed-contract move keeps the guard; an acceptance test asserts a stream-token mint past the RPM limit still 429s (§14.4).

### 7.3 `api/deps.py` + `auth/bearer.py` — one viewer home, one parser

```python
# python/nexus/auth/bearer.py
def parse_bearer_token(authorization: str | None) -> str | None:
    """Return the bearer token, or None if absent/malformed. Pure parse — callers map None to their own error."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    return token or None

# python/nexus/api/deps.py  (get_stream_viewer relocated here)
def get_stream_viewer(request: Request) -> UUID:
    token = parse_bearer_token(request.headers.get("authorization"))
    if token is None:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Missing or invalid Authorization header")
    verified = stream_tokens.verify_stream_token(token)
    set_stream_jti(verified.jti)
    return verified.user_id
```

All **four** inline `"bearer "` parses are replaced with `parse_bearer_token(...)`, each mapping `None` to its own error code: `auth/middleware.py` → `E_UNAUTHENTICATED`, `auth/extension.py:19-23` → `E_UNAUTHENTICATED`, `routes/extension_sessions.py:41-46` → `E_UNAUTHENTICATED`, `api/deps.get_stream_viewer` → `E_STREAM_TOKEN_INVALID`.

**Stream-path classification gets one owner too.** The SSE-path predicate is duplicated and already drifted between `auth/middleware.py:147-153` and `middleware/stream_cors.py:70-75`. Collapse to one `is_stream_path(path: str) -> bool` (co-located with the streaming transport — `_sse.py` or a small `auth`/`middleware` shared module, dependency-free). Both middlewares call it. The dead `/stream/conversations/...` entries (which only the middleware copy carries) are deleted in the same move, removing the drift and the tombstone.

### 7.4 `conversations.py` split + service moves

- **Scope is service-owned.** Delete the route guard (`conversations.py:87-93`); `services/conversations.py` keeps `VALID_SCOPES` and raises `InvalidRequestError(E_INVALID_REQUEST)`. The route may still default `None → "mine"`. The observable 400 contract is preserved (`tests/test_conversations.py:1265-1277` asserts through the API, not a layer).
- **`has_reference` dispatch is service-owned, and its scope-bypass is a pinned decision.** Live behavior (`conversations.py:72-85`): when `has_reference` is set, the handler returns the reference listing **before** the scope branch at `:87`, so `scope` is silently ignored (not validated). This is **correct and preserved** — reference filtering is viewer-owned-only in a single-user system, so `scope` is meaningless there; rejecting a `scope`+`has_reference` combo would add a code path for no benefit. Slice 0 pins this with a characterization test (`has_reference` + any/invalid `scope` → reference listing, no 400). The service then owns the dispatch: `services/conversations.list_conversations` gains `has_reference: str | None` and delegates to `conversation_references_service` when set (ignoring `scope`); the route stops choosing services and the two divergent payload blocks collapse to one.
- **Pagination mode is service-owned.** Move the `window`/`cursor`/`before_cursor` mutual-exclusion guards into `services/conversations.list_messages`, raising `InvalidRequestError` on illegal combos. The new `messages.py` handler becomes a pass-through.
- **Retrieval ledgers become a service.** Move `list_message_retrieval_candidate_ledgers`, `list_message_rerank_ledgers`, and `_retrieval_candidate_ledger_to_out` from `services/conversations.py:639-759` into `services/message_retrievals.py`; the visibility check reuses the already-public `get_conversation_for_visible_read_or_404`. New `message_retrievals.py` router delegates to it.
- **Retry follows its service owner.** Move `retry_failed_assistant_response` into the existing `chat_runs.py` router (its sole `chat_runs_service` caller). URL stays `/messages/{assistant_message_id}/retry`.

### 7.5 `media.py` split + logic relocations *(gated — §13)*

Routers per §6.1. Relocations:
- Reader-resume: delete `_READER_RESUME_STATE_ADAPTER`; `reader.py` router declares `body: ReaderResumeState | None` and lets FastAPI/Pydantic parse, or calls `reader.parse_reader_resume_state` backed by the existing `READER_RESUME_STATE_ADAPTER`.
- Retry: `media_retry.retry_for_viewer(*, db, viewer_id, media_id, from_stage, request_id)` owns the `source` vs `metadata` branch and the lifecycle imports; the handler delegates once.
- Library-add: `libraries.add_media_to_libraries_for_viewer(...)` owns the visibility precondition and returns `MediaLibrariesResponse`.
- EPUB-asset CSP + cache policy: `EpubAssetOut` carries `cache_control: str` and `content_security_policy: str | None`; the route maps fields onto headers.
- Transcript status: `podcasts.transcripts` returns a frozen result with a `Literal["enqueued","forecast_only"]` discriminant; the route maps discriminant → 202/200 and drops the `result["request_enqueued"]` index and the `model_validate(dict)` round-trips. *(The typed return is produced by the podcast cutover; see §13.)*
- `capture/file` header parsing → a route-local FastAPI dependency `parse_capture_file_request(request) -> CaptureFileInput`.

### 7.6 `web_paths.py` — one owner of browser `/api/...` templates

```python
# python/nexus/web_paths.py  (dependency-free; mirrors the Next.js BFF route contract)
API_PREFIX = "/api"
def media_image_url(encoded_url: str) -> str: return f"{API_PREFIX}/media/image?url={encoded_url}"
def media_asset_url(media_id: UUID, asset_key: str) -> str: return f"{API_PREFIX}/media/{media_id}/assets/{asset_key}"
def oracle_plate_url(image_id: UUID) -> str: return f"{API_PREFIX}/oracle/plates/{image_id}"

# EXACT EPUB-asset classifier — matches /api/media/{uuid}/assets/..., NOT a bare /api/media/ prefix
# (a prefix match would also catch /api/media/image and every other media path).
_MEDIA_ASSET_RE = re.compile(rf"^{re.escape(API_PREFIX)}/media/[0-9a-f-]{{36}}/assets/")
def is_media_asset_path(value: str) -> bool: return bool(_MEDIA_ASSET_RE.match(value))
```

Wiring:
- `services/sanitize_html.py` and `services/epub_ingest.py:1190` import `media_image_url` / `media_asset_url`; their hard-coded literals are deleted.
- `services/epub_ingest.py:1563` `value.startswith("/api/media/")` → `web_paths.is_media_asset_path(value)` (exact, not prefix).
- `services/oracle_plates.py:42` already *owns* an `oracle_plate_url()` helper — it becomes a thin delegate to `web_paths.oracle_plate_url` (one definition, no second literal); call sites are unchanged.

These are the *browser-facing BFF paths* (with `/api`), distinct from FastAPI mount paths (without `/api`) — a content contract, not the route decorators — so they live in one dependency-free module both services import without crossing into a route handler.

### 7.7 Response envelope — one converter

The helper is **scoped narrowly** to the one shape it actually owns — a Pydantic model or a list of them wrapped in `{data}`. Live routes also return: paged objects (`{"data": [...], "page": {...}}`), binary `Response` (image/asset bytes), bare `Response(status_code=204)`, and a few named-key wrapper dicts (`{"data": {"contributors": [...]}}`). The helper does **not** try to absorb those — a `jsonable_encoder`-style catch-all would be the hollow generic the rules reject. Two helpers, plus explicit exemptions:

```python
# python/nexus/responses.py  (additions)
def ok(data: BaseModel | Sequence[BaseModel], *, by_alias: bool = False) -> dict[str, Any]:
    """Single owner of the serialize-then-envelope projection for model payloads. Replaces ~137 hand-written model_dump calls."""
    if isinstance(data, BaseModel):
        return {"data": data.model_dump(mode="json", by_alias=by_alias)}
    return {"data": [m.model_dump(mode="json", by_alias=by_alias) for m in data]}

def ok_page(items: Sequence[BaseModel], page: BaseModel, *, by_alias: bool = False) -> dict[str, Any]:
    """Paged envelope owner: {"data": [...], "page": {...}} (e.g. list_conversations, list_messages)."""
    return {"data": [m.model_dump(mode="json", by_alias=by_alias) for m in items],
            "page": page.model_dump(mode="json", by_alias=by_alias)}
```

**Exempt (keep current shape):** binary/asset `Response`, `Response(status_code=204)`, and the named-key wrapper dicts (their inner key is intentional). The `by_alias` decision becomes a typed parameter, not per-file folklore. The `response_model=` endpoints are resolved per §9 Key Decision 8. The `~137` figure is the model/list bulk; the count will not reach literally zero because of the exempt shapes — the gate (§14.3) targets the model/list projection, not all returns.

## 8. Composition With Other Systems

- **Reader / EPUB**: the `reader.py` and `media_assets.py` routers consume `epub_read`, `reader_navigation`, `epub_assets`; the CSP/cache policy moves into `epub_assets` so the reader's served-asset security posture has one owner.
- **Oracle**: `oracle.py` consumes the typed `StreamTokenResult`; the oracle SSE route uses `_sse.tail_cursor_stream`; the plate route is unchanged (already conditional-GET correct). The oracle service drops its `/api/oracle/plates` literal in favor of `web_paths.oracle_plate_url`.
- **Chat runs / streaming**: `stream.py` tails durable chat-run rows via `tail_cursor_stream`; the run worker (`tasks/chat_run.py`) owns the work lifecycle and the cancel control plane (`chat_runs.py`). transport.md compliance — transport-survives-reconnect — is preserved verbatim.
- **Media service cutover**: this cutover's `media.py` router split sits on top of `media-service-owned-assets-hard-cutover.md`'s service extraction (§13).
- **Podcast cutover**: `podcast_transcripts.py` and the typed transcript status consume `podcast-subsystem-ownership-hard-cutover.md`'s typed returns; that spec relocates the sort/filter option sets, resolving the podcast double-validation (§13).
- **Frontend BFF**: `web_paths.py` mirrors the Next.js `api/**` route contract; no FE path changes. The FE dedup (§7 / Slice 9) is independent.

## 9. Key Decisions

1. **Two SSE primitives, not one generic.** The mismatched `format_sse_event` is a live foot-gun and the envelope/keepalive/close lifecycle is genuinely identical and dangerous — that clears the "dedupe only when large or dangerous" bar. The cursor-vs-snapshot read/emit policy stays split to avoid flag-soup. `STREAM_GONE_CODES` unifies the chat-run guard and fixes the oracle not-found gap in one owner.
2. **Stream-token is a service, not an auth adapter.** It owns persistence (the JTI table) and a serializable-retry loop — the definition of a service. The route-layer `Depends` adapter (`get_stream_viewer`) is the only part that stays in the API layer, and it moves to `api/deps.py` because two routers share it.
3. **Validation has exactly one owner.** Transport shape (Pydantic / `Query()` / `Literal`) at the boundary; domain invariant in the service; never both. Where the audit found a dead route guard (scope), delete the route copy; where it found a missing service guard (pagination), push the rule down.
4. **`get_viewer` does not move.** It is the companion of the middleware that populates `request.state.viewer`; relocating it would churn ~200 call sites for no ownership gain. Only `get_stream_viewer` (mislocated in a route file, cross-imported) moves.
5. **Browser `/api/...` templates live in `web_paths.py`, not the routers.** They are the BFF content contract (with `/api`), distinct from FastAPI mount paths (without `/api`); a single literal cannot serve both. One dependency-free owner that services import without crossing into a route handler.
6. **Retry routers follow the service, not the URL.** `retry_failed_assistant_response` lands in `chat_runs.py` (its sole service owner) though its URL is `/messages/...`. A route file's home is its service, not its path prefix.
7. **`media.py` split is sequenced last and gated.** It depends on the media-service extraction being merged. Until then the relocations that are *not* media-service-dependent (reader TypeAdapter, library-add precondition) can land in the current `media.py`.
8. **One serialization mechanism.** All product routes answer with the `{data}` envelope via `ok()`. The 4 `response_model=`-declared endpoints are audited: redundant declarations (the ledger handlers, which already return the envelope) drop `response_model=`; any endpoint that genuinely answers bare (`search.py:30`) is converted to the envelope and its FE client updated to unwrap `{data}`. SSE/streaming and binary-asset routes are envelope-exempt by nature. **As-built deviation:** `search.py` and `reader.py`'s evidence handler were *kept* on `response_model=` (a FastAPI-validated typed contract) rather than enveloped — a `response_model`-declared route is a *stronger* single serialization mechanism than `ok()`, not a violation of it, and reverting search to bare-`{data}` would have churned the FE search client and downgraded a typed contract for cosmetic uniformity. These two are the deliberate exemptions; every other model/list projection went through `ok()`/`ok_page()`.
9. **`from_url` vs `capture/url` are kept as two auth lanes, verified.** They share a service but differ by auth dependency (cookie viewer vs extension bearer). Both are retained as two-line dispatchers *only if both callers exist*; the cutover greps the FE/extension for each and deletes any endpoint with no caller (hard cutover — no dead routes).
10. **Router registration is uniform.** Tags self-declared on each `APIRouter(tags=[...])`; the redundant `tags=` on `include_router` calls are dropped. All routers register through `create_api_router()`, including `stream`/`media_events`/`stream_tokens` (currently bolted onto `app.py:285-289`). Feature-gating (`podcasts_enabled`) stays in the factory.
11. **The media static-path routers register before the `media` router** (§6.4). This is a correctness invariant, not a style choice — Starlette matches in registration order, so a misordered include turns `/media/image` into a UUID-parse 422. Enforced by an order test.
12. **Oracle mid-stream deletion is fixed in the service** (§7.1). The SSE consolidation cannot rely on a gone-code catch alone because oracle currently returns nonterminal for an absent reading. The fix is `is_reading_terminal` treating a missing row as terminal; the unified tailer accepts both "raise a gone code" and "return terminal" as clean-close signals.
13. **The stream-token RPM throttle stays an explicit route guard** (§7.2), not absorbed into the service mint. It is a cross-endpoint policy shared with chat-run creation; an acceptance test pins that the move doesn't drop it.
14. **`has_reference` keeps ignoring `scope`** (§7.4) — pinned, not "fixed." Reference filtering is viewer-owned-only, so scope is meaningless there; adding a reject-combo path would be a code path for nothing.
15. **The envelope helper is scoped, not universal** (§7.7) — `ok`/`ok_page` own the model and paged shapes; binary/204/named-key returns are exempt. No `jsonable_encoder` catch-all.

## 10. Duplicate / Similar / Repetitive Patterns To Consolidate

| Pattern | Current copies | Single owner (after) |
|---|---|---|
| SSE tail loop | `stream.py` ×2, `media_events.py` ×1 | `_sse.tail_cursor_stream` + `tail_snapshot_stream` |
| SSE frame formatter (mismatched) | `stream.py:162`, `media_events.py:131` | `_sse.format_sse_event` |
| SSE keepalive constants | `stream.py:33-34`, `media_events.py:30-31` | `_sse` |
| Bearer-token parse | `middleware.py`, `extension.py:20`, `stream.py:39` | `auth.parse_bearer_token` |
| `get_stream_viewer` (cross-route import) | `stream.py:37` ← `media_events.py:21` | `api/deps.py` |
| Stream-token untyped dict → coercions | `oracle.py:37-46`, `stream_tokens.py:42` | `services.stream_tokens.StreamTokenResult` |
| `model_dump(mode="json")` envelope projection | 137 sites | `responses.ok` |
| `/api/...` path string | `sanitize_html.py:85`, `oracle_plates.py:42`, `epub_ingest.py:1190/1563` | `web_paths.py` |
| Route+service double-validation | scope, oracle question, listening-state, podcast sort/filter, chat-run status, object-type, `mine_only` ×3 | boundary OR service, one each |
| Retrieval-ledger query + converter | `services/conversations.py:639-759` | `services/message_retrievals.py` |
| Reader-resume TypeAdapter | `media.py:64` + `reader.py:23` | `services/reader.py` |
| FE handoff-code mint | `auth/callback/route.ts:34-79`, `auth/native/google/route.ts:47-95` | one `lib/auth/mintHandoffCode` |
| FE internal-secret header idiom | 5 sites (`callback`, `native/google`, `handoff`, `extension/connect/start`, `password-flow`) | `lib/auth/internalAuthHeaders` |
| FE `noStore` | `refresh`, `password`, `handoff` routes | one helper |
| FE rotated-cookie loop | `auth/refresh/route.ts:21-28`, `proxy.ts:477-479` | one util |

## 11. File Plan

### 11.1 New files

- `python/nexus/api/routes/_sse.py` — SSE transport owner (§7.1).
- `python/nexus/api/routes/conversation_branches.py`, `conversation_shares.py`, `messages.py`, `message_retrievals.py` — conversation split (§7.4).
- `python/nexus/api/routes/media_ingest.py`, `media_assets.py`, `reader.py`, `listening_state.py`, `podcast_transcripts.py` — media split (§7.5).
- `python/nexus/auth/bearer.py` — `parse_bearer_token` (§7.3).
- `python/nexus/services/stream_tokens.py` — moved from `auth/stream_token.py`, typed (§7.2).
- `python/nexus/services/message_retrievals.py` — ledger queries (§7.4).
- `python/nexus/services/media_retry.py` — retry dispatch (§7.5).
- `python/nexus/web_paths.py` — `/api/...` templates (§7.6).
- `apps/web/src/lib/auth/mint-handoff-code.ts`, `internal-auth-headers.ts` — FE consolidation (Slice 9).

### 11.2 Modified files

- `python/nexus/api/routes/stream.py`, `media_events.py` — slim to `_sse` consumers; `get_stream_viewer` removed from `stream.py`.
- `python/nexus/api/routes/conversations.py` — CRUD only.
- `python/nexus/api/routes/media.py` — slim to catalog only.
- `python/nexus/api/routes/chat_runs.py` — gains `retry`; `status` → `Literal`.
- `python/nexus/api/routes/oracle.py`, `stream_tokens.py` — typed stream-token; envelope.
- `python/nexus/api/routes/highlights.py` — `mine_only`/`page_number` → `Query()`; top-level `pdf_highlights` import.
- `python/nexus/api/routes/me.py` — `WorkspaceSessionOut`, drop ORM import.
- `python/nexus/api/routes/object_links.py`, `browse.py`, `keys.py`, `internal_ingest.py` — boundary hygiene (§7 / Slice 4).
- `python/nexus/api/deps.py`, `auth/middleware.py`, `auth/extension.py`, `routes/extension_sessions.py` — DI/bearer consolidation (four parses → `auth/bearer.py`).
- `python/nexus/auth/middleware.py`, `python/nexus/middleware/stream_cors.py` — collapse the two `is_stream_path` copies to one owner; delete the dead `/stream/conversations` entries.
- `python/nexus/services/oracle.py` — `is_reading_terminal` treats an absent reading as terminal (mid-stream-deletion fix).
- `python/nexus/services/oracle_plates.py` — `oracle_plate_url` delegates to `web_paths`.
- `python/nexus/api/routes/__init__.py`, `python/nexus/app.py` — register new routers; single factory; one tag owner.
- `python/nexus/services/conversations.py` — `VALID_SCOPES` guard kept; `has_reference` dispatch; pagination guards; ledger code removed.
- `python/nexus/services/reader.py`, `media.py`, `libraries.py`, `epub_assets.py` — receive relocated logic.
- `python/nexus/services/sanitize_html.py`, `oracle.py`, `epub_ingest.py` — import `web_paths`.
- `python/nexus/services/oracle.py` — drop the question re-strip.
- `python/nexus/schemas/workspace_session.py`, `schemas/models.py` — `WorkspaceSessionOut`, `ModelOut` move.
- `python/nexus/responses.py` — add `ok`.
- `apps/web/src/app/auth/{callback,native/google,handoff,refresh,password,signout}/route.ts`, `extension/connect/start/route.ts`, `lib/api/proxy.ts`, `lib/auth/refresh.ts` — FE dedup.
- `docs/rules/layers.md` — acknowledge the proxy as the BFF-route session boundary (the DAL is not the *only* verified-session check).
- `docs/architecture.md`, relevant `docs/modules/*.md` — route-map update.

### 11.3 Deleted code

- `auth/stream_token.py` (moved). `routes/stream.py` `_format_sse_event`, `_tail_*`, constants, `get_stream_viewer`. `media_events.py` `_format_sse_event`, `_tail_media_events`, `_build_state_payload`, `_TERMINAL_STATUSES`, constants. `media.py` `_READER_RESUME_STATE_ADAPTER`, `_reader_resume_state_body`. `conversations.py` scope guard, pagination guards, `has_reference` branch, ledger handlers (moved). `auth/middleware.py:149-152` dead bypass + `TestRemovedStreamingRoutesReturnNotFound`. `keys.py:85-94` dead `except`. `schemas/notes.py` `OBJECT_TYPE_VALUES`. The four `/api/...` literals in services.

## 12. Slice Plan (correctness first; each slice lands green with its negative gate)

- **Slice 0 — Guardrails.** Pin characterization tests for: chat-run/oracle/media SSE wire output (incl. `id:` presence and resume); **mid-stream deletion closes cleanly on all three SSE streams**; stream-token mint/verify/replay **and RPM-limit 429**; conversation scope 400s; pagination 400s; **`has_reference` + invalid `scope` → reference listing, no 400**; oracle plate 304; transcript 202/200; **every static `/media/<literal>` path reaches its handler (not a UUID 422)**. Add the negative-grep gates of §14.3 to CI.
- **Slice 1 — SSE consolidation.** Add `_sse.py` (constants, `format_sse_event`, `tail_cursor_stream`, `tail_snapshot_stream`, `STREAM_GONE_CODES`, `is_stream_path`); **fix `services/oracle.is_reading_terminal` so an absent reading is terminal**; move `get_stream_viewer` → `deps.py`; add `auth/bearer.py` and repoint all four inline bearer parses (incl. `extension_sessions.py:41`); collapse the two `is_stream_path` copies (`middleware.py` + `stream_cors.py`) to one owner; move media snapshot/terminal → `media.read_event_snapshot`; rewire `stream.py` + `media_events.py`; delete the dead `/stream/conversations` middleware bypass + tombstone test. *Gate: no `_format_sse_event` / `_tail_` / `KEEPALIVE_INTERVAL_SECONDS` outside `_sse.py`; `media_events.py` no longer imports from `routes.stream`; one `is_stream_path` definition.*
- **Slice 2 — Stream-token service.** Move `auth/stream_token.py` → `services/stream_tokens.py`; typed `StreamTokenResult`/`VerifiedStreamToken`; rewire `oracle.py`, `stream_tokens.py`, `deps.get_stream_viewer`. *Gate: no `-> dict` from `mint_stream_token`; no `str(stream_token[` in routes; `auth/stream_token.py` gone.*
- **Slice 3 — conversations split.** Create `conversation_branches.py`, `conversation_shares.py`, `messages.py`, `message_retrievals.py` (+ service); move `retry` → `chat_runs.py`; delete scope guard; push pagination + `has_reference` into the service. Register routers. *Gate: each new router imports one service; `conversations.py` imports only `conversations_service`; scope/pagination strings absent from routes.*
- **Slice 4 — Boundary hygiene sweep.** `highlights` `Query()`; `me` `WorkspaceSessionOut`; `object_links` typed UNSET; `browse`/`chat_runs` `Literal`; `internal_ingest` error boundary; `keys` dead `except`; `ModelOut` → `schemas/models.py`; delete oracle question re-strip + listening-state service guard + `OBJECT_TYPE_VALUES`. *Gate: no `request.query_params` in `highlights.py`; no ORM import in `me.py`.*
- **Slice 5 — Transport-URL repatriation.** Add `web_paths.py` (incl. the exact `is_media_asset_path` regex); rewire `sanitize_html.py:85`, `epub_ingest.py:1190` (literal) and `epub_ingest.py:1563` (`startswith` → `is_media_asset_path`); make `oracle_plates.oracle_plate_url` a delegate to `web_paths`. *Gate: `grep -rn '/api/' python/nexus/services` returns nothing; no bare `startswith("/api/media/")` remains.*
- **Slice 6 — Response envelope.** Add `responses.ok`; convert the 137 sites; resolve the 4 `response_model=` endpoints (§9.8). *Gate: `model_dump(mode="json")` count in `routes/` drops to ~0; one serialization mechanism.*
- **Slice 7 — media split (gated on media-service cutover).** Create the 5 media routers; **register the static-`/media/` routers before the `media` router (§6.4) and add the order test**; relocate reader TypeAdapter, retry (`media_retry`), library-add precondition, EPUB CSP, transcript typed status (consuming the podcast cutover's typed return), capture/file parse; slim `media.py`. *Gate: `media.py` imports only `media`/`media_deletion`/`libraries`; no `result["request_enqueued"]`; no `TypeAdapter` in `routes/`; every static `/media/<literal>` path resolves to its handler in the registered app.*
- **Slice 8 — FE BFF dedup.** `mintHandoffCode`, `internalAuthHeaders`, `noStore`, rotated-cookie util; fix `proxyExtensionToFastAPI` query-string drop; update `layers.md`.
- **Slice 9 — Router registration + docs.** One tag owner; single factory (fold `app.py:285-289`); `architecture.md` + module-doc route map.

## 13. Dependencies / Reconciliation

- **`media-service-owned-assets-hard-cutover.md`** owns the media *service* extraction (`media_ingest`, `epub_assets`, `listening_state`, `media_file_access`, `oracle_plates`). Slice 7 here is the *route* half and **must land after** that spec's service extraction is merged. The two browser-route stability guarantees, the two-image-lane contract, and the import-repoint map there are inputs, not contradictions.
- **Capture and confirm-ingest service ownership.** The `media_ingest` router delegates `capture/article` and `capture/file` to `media_service.create_captured_*` and `confirm-ingest` to `epub_lifecycle.confirm_ingest_for_viewer` (verified `media.py:223/253/484`). These are **legitimate delegations** — a thin router calling a service it doesn't own is not a god-file violation — so the router split does **not** require extracting dedicated `media_capture`/`confirm_ingest` services first. Whether those services should exist is the media cutover's decision; if it extracts them, `media_ingest` repoints its imports with no structural change here. Only the **retry-stage dispatch** is newly owned by this spec (`media_retry`), because that branch is route-resident domain logic today (`media.py:503-523`).
- **`podcast-subsystem-ownership-hard-cutover.md`** owns the transcript *service* typed returns and the sort/filter option-set relocation. This cutover *consumes* them: the `podcast_transcripts.py` router and the §7.5 transcript status mapping depend on that spec's typed-result slice. Add to that spec's acceptance: *no route reads `result[...]` to choose an HTTP status*. The podcast double-validation (sort/filter) is resolved there; this cutover does not re-own it.
- **No conflict with the cleanliness audit:** the audit's only *route* god-file finding is `conversations.py` (Slice 3); every other route is flagged "clean and thin." This cutover's broader scope is the four boundary failure modes, which the audit catalogs as scattered service-slice findings, now unified.

## 14. Acceptance Criteria

### 14.1 Code shape
- No backend route handler contains domain branching, multi-step orchestration, a security-policy string, a `TypeAdapter`, an ORM-model import, or a read of `result[...]` to choose an HTTP status.
- Every router imports only the services it directly delegates to; no router imports a sibling router's symbol.
- `media.py` ≤ ~130 L; `conversations.py` holds only CRUD; the 11 new routers each cover one capability.
- `api/deps.py` owns `get_llm_router` + `get_stream_viewer`; `auth/bearer.py` is the only bearer parser; `parse_bearer_token` has exactly one definition.

### 14.2 Typed contracts
- `mint_stream_token -> StreamTokenResult`; `verify_stream_token -> VerifiedStreamToken`. No `dict` return, no `str(...)` coercion at call sites.
- `media.read_event_snapshot -> MediaEventSnapshot`; media SSE terminal logic lives in the service.
- Transcript admission returns a discriminated typed result; the route maps the discriminant.

### 14.3 Single owners (negative gates)
- `grep -rn '/api/' python/nexus/services` → empty (all browser paths live in `nexus/web_paths.py`).
- `grep -rn 'startswith("/api/media/")' python/nexus` → empty (exact `is_media_asset_path` only).
- `grep -rn '_format_sse_event\|KEEPALIVE_INTERVAL_SECONDS\|STREAM_IDLE_TTL_SECONDS' python/nexus/api/routes` → only `_sse.py`.
- `is_stream_path` has exactly one definition; `grep -rn 'chat-runs/.*events\|stream/oracle-readings' python/nexus/auth python/nexus/middleware` → only the call site, not a re-listed predicate.
- `grep -rn 'TypeAdapter' python/nexus/api/routes` → empty.
- `grep -rn 'from nexus.api.routes.stream import' python/nexus` → empty.
- `grep -rn 'mint_stream_token\|verify_stream_token' python/nexus/auth` → empty; `auth/stream_token.py` absent.
- `grep -rn '.lower().startswith("bearer ")' python/nexus` → only `auth/bearer.py` (one parser; four prior copies gone).
- `grep -rn 'request.query_params' python/nexus/api/routes/highlights.py` → empty.
- `OBJECT_TYPE_VALUES` absent; `WorkspaceSession` ORM import absent from `routes/me.py`.

### 14.4 Behavior preserved (and the two behavior *fixes*)
- SSE wire output byte-identical incl. `id:` lines on cursor streams and their absence on snapshot streams; `Last-Event-ID`/`?after` resume works.
- **Fix:** a mid-stream-deleted oracle reading now closes cleanly (was: streamed nonterminal forever, because `is_reading_terminal` returned `False` for a missing row). All three SSE streams close cleanly on mid-stream deletion — test-covered.
- **Invariant:** every static `/media/<literal>` path (`image`, `from_url`, `capture/*`, `upload/init`, `transcript/*`, `listening-state/batch`) resolves to its intended handler in the registered app — never a UUID-parse 422 — proving the §6.4 include order.
- Stream-token mint past the RPM limit still 429s (the throttle survived the service move).
- `has_reference` + any/invalid `scope` returns the reference listing with no 400 (pinned bypass).
- Every browser/BFF path unchanged. Conversation scope/pagination 400s, oracle plate 304, transcript 202/200, listening-state 204 unchanged.
- Validation: each constraint raises from exactly one layer; the observable API status/code is unchanged.

### 14.5 Tests
- New router files have behavior tests at the router; SSE primitives have wire-format tests; `message_retrievals`/`media_retry`/`stream_tokens` services have unit tests. Dead tests (removed-stream-route tombstone) deleted.

## 15. Verification Commands

```bash
cd python && uv run pytest -q                      # full backend suite
cd python && uv run pyright                         # types (typed stream-token / snapshot contracts)
cd python && grep -rn '"/api/' nexus/services       # → empty
cd python && grep -rn 'TypeAdapter' nexus/api/routes
cd python && grep -rn 'from nexus.api.routes.stream import' nexus
cd apps/web && bun run test                          # FE unit/browser
cd apps/web && bun run lint && bun run typecheck
make test-e2e                                        # auth + SSE + transcript flows
```

## 16. Risks & Rejected Fixes

- **Risk: a single generic `_tail_sse_events`.** Rejected — it would grow flag-soup and reintroduce the mismatched-formatter foot-gun as a parameter. Two typed tailers + one framer is the SME shape.
- **Risk: relocating `get_viewer`.** Rejected — ~200-site churn for no ownership gain; it legitimately lives with the middleware that populates `request.state.viewer`.
- **Risk: splitting `libraries.py`/`podcasts.py`.** Rejected — both are already thin; splitting `libraries.py` also breaks its static-before-dynamic route-ordering invariant.
- **Risk: the 137-site `ok()` sweep churns broadly.** Mitigated — it is mechanical, lands last (Slice 6), and is gated by a `model_dump` count that must drop to ~0; the `by_alias` parameter removes a latent serialization-drift bug.
- **Risk: `response_model=` removal changes the search wire shape.** Mitigated by Key Decision 8 — the FE search client is updated to unwrap `{data}` in the same slice; hard cutover, no back-compat.
- **Risk: media split lands before the media-service extraction.** Mitigated by the §13 gate — Slice 7 is sequenced after that cutover merges; non-media-dependent relocations can precede it.

## 17. SME Review Checklist

- [ ] Does every router import only the services it delegates to, and no sibling router's symbol?
- [ ] Is there exactly one SSE framer, one keepalive constant pair, one bearer parser, one stream-token owner?
- [ ] Does any handler still choose an HTTP status from an untyped value, build a policy string, or run domain dispatch?
- [ ] Is every `/api/...` literal gone from `services/`?
- [ ] Is each validated constraint owned by exactly one layer, with the API status unchanged?
- [ ] Are the SSE transport.md guarantees (work survives reconnect, resume by cursor) preserved?
- [ ] Did the media split wait for the media-service extraction, and does it consume the podcast typed returns rather than re-deriving them?
- [ ] Were dead routes/tests/guards deleted, not commented out?

## 18. Done Definition

All slices merged; §14 negative gates green in CI; backend `pytest` + `pyright`, FE `test`/`lint`/`typecheck`, and `make test-e2e` green; `architecture.md` + module-doc route map updated; `layers.md` corrected re the proxy session boundary; no `auth/stream_token.py`, no `/api/` literal in services, no `TypeAdapter`/`_format_sse_event`/cross-route import in the route layer. The two god files are gone; the transport boundary is uniform.

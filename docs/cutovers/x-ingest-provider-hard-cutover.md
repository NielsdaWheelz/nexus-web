# X ingest provider hard cutover

## Status

Implemented in the working tree on 2026-06-04 as a hard cutover onto the
durable source-ingest lifecycle.

Restoring or funding X API credits remains an operator action outside this
document. The live-provider gate proves the application contract only when
`X_API_BEARER_TOKEN`, `X_LIVE_TEST_POST_URL`, and
`X_LIVE_TEST_EXPECTED_TEXT` are configured and the provider account has credits.

## Parent Contract

This document is the X-provider specialization of
`docs/cutovers/durable-source-ingest-hard-cutover.md`.

If this X document and the durable source-ingest document disagree, the durable
source-ingest contract wins. X is not a special synchronous exception. X URL
ingest uses the same durable acceptance, source attempt, worker dispatch,
failure persistence, retry, refresh, and capability derivation as web articles,
remote PDF/EPUB URLs, browser captures, uploads, and YouTube.

## Summary

Adding an X/Twitter URL to Nexus is a strict official-API archival capture
capability:

- no scraping,
- no oEmbed,
- no generic web-article fallback for X URLs,
- no URL-username trust as provider truth,
- no raw single-post provider identity for author-thread media,
- no swallowed provider errors,
- no lost accepted ingest intent,
- no frontend-only masking of backend request IDs,
- no production env drift between config, examples, sync scripts, docs, and
  deployed containers.

The final state is one X provider capability composed with one source lifecycle
owner:

- `media_source_ingest.py` owns durable acceptance, attempts, queue dispatch,
  retry, refresh, idempotency, and provisional duplicate cleanup.
- `x_client.py` owns official X API calls and typed provider response/error
  parsing.
- `x_ingest.py` owns X materialization from a durable source attempt into
  canonical media, fragments, quote children, provider events, indexing, and
  metadata enqueue.
- `x_identity.py`, `x_types.py`, and `x_rendering.py` own narrow identity,
  type, and rendering concerns.
- `provider_events.py` records safe provider-call evidence.

This is a hard cutover. Runtime legacy lanes are removed instead of preserved as
fallbacks. Existing production data is handled by one-time migrations or repair
commands, not by permanent compatibility branches.

## SME Framing

A subject matter expert would not ask "How do we make tweets work?" or "Where do
we add a catch block?" The expert questions are:

- What durable object represents the accepted user command?
- What is the idempotency key for that command?
- Which side effects may run only after acceptance?
- Which module owns provider truth and provider failure classification?
- Which module owns media/source-attempt state transitions?
- What canonical provider identity prevents collisions and duplicates?
- How does a failed provider call remain visible and retryable to the user?
- How does ops answer "X ingest is down" from request ID, provider event rows,
  and logs without exposing secrets?

The mature pattern is idempotent command acceptance followed by bounded,
observable, retryable side effects. X is an unreliable but authoritative
external system. Nexus fails closed, records why, and leaves a durable media item
the user can retry later.

## Target Behavior

### Supported Input

Supported X URL inputs:

- `https://x.com/{username}/status/{post_id}`
- `https://twitter.com/{username}/status/{post_id}`
- `https://mobile.twitter.com/{username}/status/{post_id}`
- `/statuses/` variants already accepted by `x_identity.py`

The URL username is a hint only. Provider response data supplies the author ID,
author username, conversation ID, and canonical media identity.

Unsupported X URLs fail before durable acceptance with `E_INVALID_REQUEST`.

### Acceptance

`POST /media/from_url` and extension URL capture call the same source owner.

Request:

```json
{
  "url": "https://x.com/ada/status/1234567890",
  "library_ids": []
}
```

Response for a new accepted X source:

```json
{
  "data": {
    "media_id": "<uuid>",
    "source_attempt_id": "<uuid>",
    "source_type": "x_author_thread",
    "idempotency_outcome": "created",
    "processing_status": "pending",
    "ingest_enqueued": true
  }
}
```

At response time:

- a durable `media` row exists,
- a durable `media_source_attempts` row exists,
- default plus selected libraries are attached,
- one `ingest_media_source` job exists,
- no X provider call is required to have completed,
- provider failure after this point cannot lose the saved item.

### Provisional Media Shape

Before provider truth is known, the X media row is provisional:

```text
kind = "web_article"
title = "X post <requested_post_id>"
requested_url = <submitted URL>
canonical_source_url = "https://x.com/i/status/<requested_post_id>"
provider = "x"
provider_id = NULL
processing_status = "pending"
```

The requested post ID lives in:

- `media_source_attempts.provider_target_ref`
- `media_source_attempts.source_payload.post_id`

Do not store provisional X provider identity in `media.provider_id`.

### Worker Materialization

`ingest_media_source` calls `media_source_ingest.run_source_attempt`, which
dispatches `source_type="x_author_thread"` to
`x_ingest.materialize_x_author_thread_media`.

The X materializer:

1. fetches an official X author-thread snapshot for the requested post,
2. computes canonical provider identity from provider truth,
3. locks the canonical X provider ID with a transaction-level advisory lock,
4. creates or reuses quote-post child media,
5. renders sanitized author-thread fragments,
6. resets provisional web-article artifacts,
7. writes canonical X media fields,
8. writes contributor credits from provider author truth,
9. marks the media ready for reading,
10. rebuilds the web-article content index,
11. enqueues metadata enrichment,
12. records a compact success row in `external_provider_events`.

### Successful Materialized Media

Canonical X author-thread media:

```text
provider = "x"
provider_id = "author-thread:<x_author_id>:<x_conversation_id>"
canonical_source_url = "https://x.com/i/status/<canonical_anchor_post_id>"
canonical_url = NULL
publisher = "X"
processing_status = "ready_for_reading"
```

The canonical captured object is same-author posts in one X conversation. The
requested post ID alone is not enough identity. The conversation ID alone is not
enough identity because a conversation can contain multiple authors.

### Quote Posts

Quote-post child media use:

```text
provider = "x"
provider_id = "post:<post_id>"
kind = "web_article"
canonical_url = "https://x.com/i/status/<post_id>"
canonical_source_url = "https://x.com/i/status/<post_id>"
processing_status = "ready_for_reading"
```

Quote child creation uses insert/get-or-create with `IntegrityError` recovery.
A provider-ID or canonical-URL race for the same X post must not abort parent
thread materialization.

### Provider Failure

Provider-originated failures after acceptance must preserve the media row and
mark the source attempt failed.

Failure result:

```text
media.processing_status = "failed"
media.failure_stage = "extract"
media.last_error_code = <typed X error code>
media_source_attempts.status = "failed"
media_source_attempts.error_code = <typed X error code>
external_provider_events.status = "failure"
external_provider_events.source_attempt_id = <attempt id>
```

The user sees the saved failed item and can retry source acquisition later
through the shared source retry API when the failure is retryable.

### Exact Reuse

When a prior successful X attempt already captured the exact requested post ID,
`media_source_ingest.accept_url_source` reuses the known canonical media before
enqueueing another provider job.

Response:

```json
{
  "data": {
    "media_id": "<canonical media uuid>",
    "source_attempt_id": "<new succeeded attempt uuid>",
    "source_type": "x_author_thread",
    "idempotency_outcome": "reused",
    "processing_status": "ready_for_reading",
    "ingest_enqueued": false
  }
}
```

Selected libraries are assigned atomically to the canonical media.

### Canonical Duplicate After Provider Truth

Some duplicates are unknowable until X provider truth is fetched, such as adding
a different same-author post from a conversation that is already captured.

When X materialization resolves to an existing canonical author-thread media:

- `x_ingest.py` assigns selected libraries to the canonical media,
- `x_ingest.py` records a success provider event for the canonical media,
- `media_source_ingest.py` detects that the materializer returned a different
  `media_id`,
- `media_source_ingest.py` moves the source attempt to the canonical media,
- `media_source_ingest.py` hard-deletes the provisional duplicate through
  `media_deletion.delete_duplicate_document_media`,
- idempotency replay for the accepted command returns the canonical media.

No orphan pending X row may remain after a successful canonical dedupe.

### Refresh

Refreshing existing X media uses the same X materialization code path. Refresh
may upgrade old single-post X rows into author-thread media when the URL or
source fields contain a supported X post ID.

Refresh remains allowed only through the shared media refresh/source lifecycle.
There is no X-specific public refresh endpoint.

## Error Taxonomy

Provider-originated failures use X-specific public API error codes.

| Code | HTTP status | Meaning |
| --- | ---: | --- |
| `E_X_PROVIDER_CREDITS_DEPLETED` | 503 | X account credits are exhausted. Operator action required. |
| `E_X_PROVIDER_AUTH_REJECTED` | 503 | Bearer token is missing, invalid, revoked, or lacks access. |
| `E_X_PROVIDER_RATE_LIMITED` | 503 | X is rate limiting the app token or product tier. |
| `E_X_PROVIDER_TIMEOUT` | 504 | X did not return within the provider deadline. |
| `E_X_PROVIDER_UNAVAILABLE` | 503 | X transport/service failure not covered by a narrower code. |
| `E_X_POST_UNAVAILABLE` | 404 | Requested post is deleted, private, suspended, or unavailable. |

`E_BILLING_REQUIRED` is not used for X API credit exhaustion. That code means
the Nexus user needs a paid app plan. X provider credits are an operator/provider
availability issue.

Provider errors returned to clients and stored in the ledger must not include:

- bearer tokens,
- authorization headers,
- raw provider response bodies,
- raw request headers,
- URLs with credentials.

## Capability Contracts

### `media_source_ingest.py`

Owns:

- `accept_url_source(...) -> FromUrlResponse`
- URL source classification,
- durable media and source-attempt creation,
- idempotency replay,
- source job enqueue,
- source retry and refresh,
- exact X post reuse by prior source attempt,
- canonical duplicate supersession when a materializer returns a different
  media ID.

Must not own:

- X provider HTTP implementation,
- X HTML rendering,
- X provider response parsing.

### `x_identity.py`

Public contract:

```python
@dataclass(frozen=True)
class XIdentity:
    provider: str
    provider_id: str
    canonical_url: str
    username: str | None = None

def is_x_url(url: str) -> bool
def classify_x_url(url: str) -> XIdentity | None
def normalize_x_username(value: str | None) -> str | None
```

Rules:

- `provider_id` is the requested post ID at URL classification time.
- `username` is a URL hint only.
- `normalize_x_username` is the only X username regex owner.

### `x_client.py`

Public contract:

```python
def fetch_author_thread_snapshot(post_id: str) -> XAuthorThreadSnapshot
```

Rules:

- use official X API only,
- always request user expansions needed to resolve author ID and username,
- use full-archive search for same-author conversation capture,
- search query is author-scoped and conversation-scoped,
- honor `X_API_TIMEOUT_SECONDS` as the total provider deadline for one snapshot,
- honor `X_API_AUTHOR_THREAD_MAX_POSTS`,
- retry only transient provider/transport failures inside the provider deadline,
- preserve final provider status, Retry-After, error type, and title when
  raising `XProviderError`,
- never log or return bearer tokens or raw provider bodies.

### `x_types.py`

Public identity helpers:

```python
X_AUTHOR_THREAD_PROVIDER_ID_PREFIX = "author-thread:"
X_POST_PROVIDER_ID_PREFIX = "post:"

def canonical_x_post_url(post_id: str) -> str
def x_author_thread_provider_id(author_id: str, conversation_id: str) -> str
def x_post_provider_id(post_id: str) -> str
```

Snapshot dataclasses are frozen. Mapping members are treated as read-only by
callers.

### `x_rendering.py`

Owns:

- author-thread fragment rendering,
- single quote-post rendering,
- X title and description derivation,
- HTML escaping.

Must not own:

- provider HTTP calls,
- SQLAlchemy sessions,
- library assignment,
- content indexing,
- frontend copy.

### `x_ingest.py`

Owns:

- X provider snapshot orchestration from an accepted source attempt,
- provider error to public `ApiErrorCode` mapping,
- provider event recording,
- canonical X media creation/reuse,
- quote-post media creation/reuse,
- fragment creation,
- contributor credits,
- content indexing and metadata enqueue calls.

Must not own:

- durable acceptance,
- source retry policy,
- source job enqueue,
- idempotency replay,
- provisional duplicate deletion.

## API Composition

### Initial Add

Frontend and BFF layers do not branch on X. They submit URL ingest through the
same `addMediaFromUrl` transport and preserve:

- backend `ApiError.code`,
- backend `ApiError.status`,
- backend request ID,
- `Idempotency-Key`.

### Retry

Retry is not provider-specific:

```http
POST /media/{media_id}/retry
```

with the source stage selected by the shared retry body. Retry clones the latest
failed source attempt and enqueues `ingest_media_source`.

### Refresh

Refresh is not provider-specific:

```http
POST /media/{media_id}/refresh
```

Refresh clones the latest source attempt and enqueues source materialization
when the media state permits refresh.

## Observability

Every X provider failure records:

- a structured log event,
- an `external_provider_events` row.

Every successful X author-thread materialization records a compact success row
because the provider is credit-metered and operator-owned.

Minimum event fields used by X:

```text
request_id
source_attempt_id
viewer_id
media_id
provider = "x"
capability = "author-thread"
operation = "lookup_post" | "search_author_thread" | "lookup_quotes" | "ingest_author_thread"
target_ref
status = "success" | "failure"
api_error_code
provider_status_code
provider_error_type
provider_error_title
duration_ms
retry_after_seconds
metadata
```

Provider events are an operational ledger, not user-visible content. This
cutover intentionally does not add a provider-event retention job; if the ledger
outgrows one-user prototype needs, add a generic `provider_events` retention
policy rather than an X-only cleanup path.

## Environment And Deploy

Runtime X env:

- `X_API_BEARER_TOKEN`
- `X_API_BASE_URL`
- `X_API_TIMEOUT_SECONDS`
- `X_API_AUTHOR_THREAD_MAX_POSTS`

Live-provider gate env:

- `X_LIVE_TEST_POST_URL`
- `X_LIVE_TEST_EXPECTED_TEXT`

Rules:

- `X_API_BEARER_TOKEN` is backend/worker-only and must not sync to Vercel.
- staging/prod backend startup validation requires `X_API_BEARER_TOKEN`.
- `.env.example`, `deploy/env/env-prod-backend.example`,
  `deploy/hetzner/sync-env.sh`, deploy docs, and env validation tests must stay
  aligned.
- `X_API_INCLUDE_USER_EXPANSIONS` is deleted and must remain rejected.

## Files

Backend:

- `python/nexus/services/media_source_ingest.py`
- `python/nexus/tasks/ingest_media_source.py`
- `python/nexus/services/x_identity.py`
- `python/nexus/services/x_client.py`
- `python/nexus/services/x_types.py`
- `python/nexus/services/x_rendering.py`
- `python/nexus/services/x_ingest.py`
- `python/nexus/services/provider_events.py`
- `python/nexus/services/media_deletion.py`
- `python/nexus/services/media_ingest.py`
- `python/nexus/api/routes/media_ingest.py`
- `python/nexus/errors.py`
- `python/nexus/schemas/media.py`

Database and deploy:

- `migrations/alembic/versions/0132_external_provider_events.py`
- `migrations/alembic/versions/0133_media_source_attempts.py`
- `migrations/alembic/versions/0134_media_source_attempts_job_delete_contract.py`
- `migrations/alembic/versions/0135_media_source_attempts_user_delete_contract.py`
- `.env.example`
- `deploy/env/env-prod-backend.example`
- `deploy/env/env-prod-worker.example`
- `deploy/hetzner/sync-env.sh`
- `deploy/vercel/sync-env.sh`
- `deploy/hetzner/README.md`
- `deployment.md`

Frontend:

- `apps/web/src/lib/media/ingestionClient.ts`
- `apps/web/src/lib/media/captureFeedback.ts`
- `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/app/share/ShareCapture.tsx`
- `apps/web/src/components/feedback/Feedback.tsx`
- BFF `/api/media/from-url` and extension capture routes

Tests:

- `python/tests/test_x_api.py`
- `python/tests/test_from_url.py`
- `python/tests/live_providers/test_x_author_thread_live.py`
- `python/tests/test_config.py`
- `python/tests/test_hetzner_env_sync_validation.py`
- `python/tests/test_vercel_env_sync_validation.py`
- frontend Add Content, Share Capture, and feedback tests

## Acceptance Criteria

Functional:

- X URL add returns `202` with `source_attempt_id`, `source_type`,
  `processing_status="pending"`, and `ingest_enqueued=true` for new accepted
  sources.
- No X provider call runs before durable acceptance.
- Successful source job materializes a ready X author-thread web article.
- Provider 402/401/403/429/timeout/404 after acceptance marks the saved media
  failed and marks the source attempt failed.
- Failure rows include typed X error codes.
- X provider failures never fall back to generic web article ingest.
- Exact requested-post reuse returns the canonical existing media without
  enqueueing another provider job.
- Canonical same-thread duplicate discovered after provider truth deletes the
  provisional duplicate and leaves the source attempt attached to the canonical
  media.
- Refresh upgrades old X media through the same materializer.

Identity:

- author-thread provider ID is
  `author-thread:<x_author_id>:<x_conversation_id>`.
- quote-post provider ID is `post:<post_id>`.
- URL username is never provider truth.
- two authors in one X conversation cannot collide.
- multiple posts by one author in one X conversation resolve to one canonical
  thread.

Observability:

- provider failure event rows include request ID when available,
  `source_attempt_id`, viewer ID, provider, capability, operation, target ref,
  public API error code, provider status/title/type, duration, and retry-after.
- success event rows include canonical provider ID and compact post counts.
- no provider event or log stores bearer tokens or raw provider bodies.

Frontend:

- Add Content and Share Capture use the same ingestion client and feedback
  derivation.
- request IDs remain visible on failed add rows/notices.
- frontend retry after pre-acceptance transport errors preserves idempotency
  keys.
- accepted server-side failures are retried through media/source retry, not by
  resubmitting hidden X-specific routes.

Deploy:

- backend env examples and sync scripts require the runtime X token where the
  backend requires it.
- Vercel env sync rejects backend-only X secrets.
- live-provider gate env vars are documented in `.env.example`.

## Non-Goals

- No scraping fallback.
- No oEmbed fallback.
- No X-specific public retry endpoint.
- No compatibility import path for the deleted `x_api.py`.
- No automatic infinite retry loop.
- No provider-event retention job in this X-specific cutover.
- No attempt to make syntactically invalid URLs durable ingest attempts.

## Verification

Targeted local checks:

```bash
cd python
uv run ruff check nexus/services/x_client.py nexus/services/x_ingest.py nexus/services/media_source_ingest.py tests/test_x_api.py tests/test_from_url.py tests/live_providers/test_x_author_thread_live.py
uv run pytest -q tests/test_x_api.py
uv run pytest -q tests/test_from_url.py -k "XPost"
uv run pytest -q tests/test_config.py tests/test_hetzner_env_sync_validation.py tests/test_vercel_env_sync_validation.py
```

Live provider proof, only after credits/env are available:

```bash
X_LIVE_TEST_POST_URL=... \
X_LIVE_TEST_EXPECTED_TEXT=... \
uv run pytest -q tests/live_providers/test_x_author_thread_live.py
```

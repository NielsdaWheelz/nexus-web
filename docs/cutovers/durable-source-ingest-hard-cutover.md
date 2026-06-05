# Durable source ingest hard cutover

## Status

Local implementation and targeted verification are complete; production cutover
is pending deploy/migration verification. Written on 2026-06-04 after the X/Twitter ingest investigation
showed that failed X provider calls could return an API error before any
user-visible `media` row existed. A follow-up survey showed the same
first-source-acquisition hole for remote PDF/EPUB URL ingest: remote fetch,
validation, and storage could happen before the durable media row was created.

Local implementation now has the durable backend source owner, attempt table,
single source job, frontend ingest client, shared URL capture runner, shared
retry/refresh projection helper, and post-acceptance failure persistence for URL,
X/Twitter, YouTube, remote file, upload, and browser-capture flows. Remaining
work before this document can be marked fully complete:

- deploy migrations/code/env so production worker and DB are on the new contract.

Production read-only check on 2026-06-05 confirmed the VPS is still pre-cutover:
the database is at Alembic revision `0131`, `external_provider_events` does not
exist yet, and `WORKER_ALLOWED_JOB_KINDS` still includes the old source job
kinds. The production DB currently has only ready X media rows and no failed X
row for provider failures, which is the observed pre-cutover durability gap.

This is a hard cutover plan. The final implementation removes old acceptance,
retry, and refresh lanes rather than preserving compatibility branches. Existing
production data is handled by one-time migrations or repair commands, not by
permanent runtime fallbacks.

## Summary

Nexus must treat every accepted source-ingest request as a durable user intent.
Once the app accepts an ingest intent, the user must get a durable, visible media
item before any provider call, remote fetch, storage write, extraction,
transcription, rendering, indexing, or enrichment step can fail.

The final state is one canonical source-ingest lifecycle owner backed by:

- a durable `media` row as the user-visible item,
- a durable `media_source_attempts` row as the source-acquisition audit and retry
  record,
- one source-acquisition queue job,
- one retry/refresh state machine,
- one capability derivation path,
- one frontend API client for ingest/retry/refresh,
- source-specific adapters that do only source-specific work.

Source-specific modules continue to exist, but they no longer own durable
acceptance, retry, queue dispatch, failure-state fields, or capability policy.

## SME Framing

A subject matter expert would not ask "How do we save failed tweets?" The expert
question is:

> Where is the accepted command boundary, what durable object represents that
> intent, what is the idempotency key for the command, what side effects may run
> after acceptance, and what single owner records failure and retry state?

The mature distributed-systems pattern is idempotent command acceptance followed
by bounded, observable, retryable side effects. The caller's intent is recorded
atomically. Repeated requests with the same caller intent return a semantically
equivalent result. Provider and storage side effects run after the durable
record, use stable idempotency where available, and record typed failures.

Primary-source references:

- AWS Builders Library, "Making retries safe with idempotent APIs":
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-apis/>
- Stripe idempotent requests:
  <https://docs.stripe.com/api/idempotent_requests>
- AWS Durable Execution idempotency and retries:
  <https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/>
- PostgreSQL transaction-level advisory locks:
  <https://www.postgresql.org/docs/17/explicit-locking.html>

## Current Problems

### X/Twitter

`media_ingest.enqueue_media_from_url` dispatches X URLs directly to
`x_ingest.ingest_x_author_thread_url`. That function calls the X provider before
creating media. Provider failures are operationally observable, but there is no
saved item the user can open and retry later.

Current behavior:

- provider call happens first,
- media row is created only after a successful provider snapshot,
- failure creates no user-visible item,
- tests currently assert no media row on X provider failure.

### Remote PDF/EPUB URL

`remote_file_ingest.create_file_media_from_remote_url` fetches and stores the
remote bytes before creating media. Network errors, upstream errors, invalid
content, oversized files, and storage failures can all fail before a row exists.

Current behavior:

- remote fetch happens first,
- storage write happens before media insert,
- media row exists only after successful fetch/storage/validation,
- extraction failures after row creation are durable, but source-acquisition
  failures are not.

### Generic Web URL

`media.create_provisional_web_article` already creates a pending media row before
the background web-article job. This is closest to the desired acceptance
contract, but its state transitions, retry path, and queue dispatch are separate
from file, X, and video paths.

### YouTube

The previous YouTube URL path created a pending video row before
transcript/provider work, but the retry path was routed through podcast
transcription code and the job kind was separate from other source acquisition.

### Uploaded and Captured Files

Upload init creates a pending row before the bytes are uploaded. Confirm/extract
failures are durable, but upload confirm and captured-file flows have separate
lifecycle code from URL flows.

### Browser-Captured Article

Browser article capture sanitizes and builds content before returning a ready row.
For this cutover, once a capture request passes transport validation, sanitization
and readable-text failure must be recorded on a durable item rather than returned
as an item-lost error.

### Retry and Refresh

Retry/refresh ownership is split across:

- `python/nexus/services/media.py`
- `python/nexus/services/media_retry.py`
- `python/nexus/services/web_article_lifecycle.py`
- `python/nexus/services/pdf_lifecycle.py`
- `python/nexus/services/epub_lifecycle.py`
- `python/nexus/services/podcasts/transcription.py`
- `python/nexus/services/youtube_video_ingest.py`
- `python/nexus/services/x_ingest.py`

This produces repeated logic for:

- state transitions into extracting,
- failure-field clearing,
- artifact cleanup before retry,
- queue dispatch,
- source-available capability checks,
- refresh handling for ready and failed media.

## Target Behavior

### Universal Acceptance Rule

If an ingest request passes authentication, authorization, destination-library
validation, and basic source-shape validation, Nexus creates a durable media item
and returns a `media_id`.

After that point:

- provider failures mark the media failed,
- remote download failures mark the media failed,
- storage failures mark the media failed,
- extraction failures mark the media failed,
- sanitization failures mark the media failed,
- transcript acquisition failures mark the media failed or transcript-unavailable
  according to the existing transcript domain contract,
- indexing/enrichment failures remain separate soft-warning states when they are
  not source failures.

The user can see the item, delete it, and retry source acquisition when the
source intent is retryable.

### Pre-Acceptance Rejections

These are allowed to fail before media creation:

- unauthenticated user,
- forbidden destination library,
- default library ID in `library_ids`,
- duplicate destination IDs,
- syntactically invalid URL,
- unsupported URL/source type,
- unsupported upload kind,
- invalid request body shape,
- empty native share or empty note capture.

These are not ingest attempts. They are invalid commands.

### Post-Acceptance Failures

These must create or preserve a durable media row:

- X provider auth, credit, rate-limit, timeout, deleted/private post, or malformed
  response,
- generic web fetch, extraction, canonicalization, or sanitization failure,
- remote PDF/EPUB upstream HTTP error, redirect failure, timeout, invalid bytes,
  oversized body, storage write failure, or extraction failure,
- YouTube metadata/transcript/provider failure,
- uploaded PDF/EPUB missing object, invalid signature, unsafe EPUB archive, or
  extraction failure,
- browser-captured article sanitization or no-readable-text failure,
- browser-captured file storage or extraction failure after the request has been
  accepted.

## Final Architecture

### One Source Lifecycle Owner

New canonical owner:

- `python/nexus/services/media_source_ingest.py`

Public commands:

- `accept_url_source(...) -> FromUrlResponse`
- `accept_browser_article_capture(...) -> FromUrlResponse`
- `accept_browser_file_capture(...) -> FromUrlResponse`
- `confirm_uploaded_source(...) -> dict`
- `run_source_attempt(...) -> dict`
- `retry_source_for_viewer(...) -> dict`
- `refresh_source_for_viewer(...) -> dict`

Responsibilities:

- validate destination libraries through `library_governance`,
- classify source type through source identity modules,
- create the durable `media` row,
- create the durable `media_source_attempts` row,
- attach default plus selected libraries through `library_entries`,
- enqueue the single source-acquisition job,
- update `media` source failure fields,
- update attempt state,
- choose retry/refresh eligibility,
- call source adapters,
- perform canonical duplicate resolution after provider truth is known,
- emit source-attempt events and provider events,
- return stable response envelopes.

Responsibilities that must not live here:

- provider HTTP details,
- source-specific parser internals,
- source-specific HTML rendering,
- PDF/EPUB extraction internals,
- transcript normalization internals,
- frontend copy,
- route transport handling.

### Source Adapters

Each source-specific owner exposes a small adapter command consumed by
`media_source_ingest.py`.

Adapters:

- `x_ingest.py` for X/Twitter author-thread acquisition and materialization,
- `web_article_ingest.py` for generic web article acquisition and
  materialization,
- `web_article_artifacts.py` for shared web/X/browser article artifact cleanup,
- `remote_file_ingest.py` for remote PDF/EPUB download into storage,
- `pdf_lifecycle.py` for PDF extraction/materialization,
- `pdf_indexing.py` and `pdf_metadata.py` for PDF post-success evidence indexing
  and metadata persistence,
- `epub_lifecycle.py` for EPUB extraction/materialization,
- `epub_metadata.py` for EPUB metadata persistence,
- `youtube_video_ingest.py` for YouTube metadata/transcript materialization
  internals. It is called by the source owner and is not registered as an
  independent source-acquisition queue lane.
- browser capture helpers for submitted HTML/file bytes.

Adapter contract:

```python
class SourceAdapter(Protocol):
    source_type: SourceType

    def provisional_media(self, intent: SourceIntent) -> ProvisionalMediaSpec:
        ...

    def acquire_and_materialize(
        self,
        db: Session,
        media: Media,
        attempt: MediaSourceAttempt,
        intent: SourceIntent,
        request_id: str | None,
    ) -> SourceMaterializationResult:
        ...

    def cleanup_before_retry(
        self,
        db: Session,
        media: Media,
        retry_kind: RetryKind,
    ) -> None:
        ...
```

Adapters may call existing lower-level extraction/rendering helpers, but they do
not commit source lifecycle state directly. They return typed results and typed
errors to the lifecycle owner.

### One Queue Job

New job kind:

- `ingest_media_source`

Payload:

```json
{
  "media_id": "<uuid>",
  "attempt_id": "<uuid>",
  "actor_user_id": "<uuid>",
  "request_id": "<request id or null>"
}
```

The job handler:

- locks the attempt row,
- verifies it is runnable,
- marks the attempt running,
- marks media extracting,
- loads the source intent,
- invokes the adapter,
- marks media ready or failed,
- marks attempt succeeded or failed,
- dispatches metadata enrichment only after source success,
- returns a terminal result.

Hard cutover rules:

- remove source-acceptance usage of `ingest_web_article`,
  `ingest_youtube_video`, `ingest_pdf`, and `ingest_epub`,
- remove worker allowlist dependence on old source job kinds,
- keep lower-level extraction functions only as adapter internals when they still
  earn their place,
- do not keep old queue handlers as compatibility lanes.

### Database Schema

Add `media_source_attempts`.

Required columns:

```sql
id uuid primary key default gen_random_uuid(),
media_id uuid not null references media(id),
created_by_user_id uuid null references users(id),
source_type text not null,
attempt_no integer not null,
status text not null,
intent_key text not null,
idempotency_key text null,
requested_url text null,
canonical_source_url text null,
provider text null,
provider_target_ref text null,
source_payload jsonb not null default '{}'::jsonb,
request_id text null,
job_id uuid null,
error_code text null,
error_message text null,
retry_after_seconds integer null,
started_at timestamptz null,
finished_at timestamptz null,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

Constraints:

- `source_type` must be one of the supported source types,
- `status` must be one of `accepted`, `queued`, `running`, `succeeded`,
  `failed`, `superseded`,
- `attempt_no >= 1`,
- `source_payload` must be a JSON object,
- `requested_url` and `canonical_source_url` must respect existing URL length
  limits,
- `(media_id, attempt_no)` is unique,
- `(created_by_user_id, idempotency_key)` is unique where `idempotency_key IS NOT NULL`,
- `retry_after_seconds IS NULL OR retry_after_seconds >= 0`.

Indexes:

- `(media_id, created_at DESC, id DESC)` for media detail/history,
- `(status, updated_at, id)` for stale attempt reconciliation,
- partial unique idempotency index on `(created_by_user_id, idempotency_key)`,
- source-specific canonical indexes only where there is a real read path.

Do not use `media.provider_id` for provisional identities. For X, a failed
pre-provider attempt has `media.provider = 'x'` and `media.provider_id = NULL`.
The requested post ID lives in `media_source_attempts.provider_target_ref` and
`source_payload`. On success, X materialization sets `media.provider_id` to the
canonical `author-thread:<x_author_id>:<conversation_id>`.

### Source Types

Supported `source_type` values:

- `generic_web_url`
- `x_author_thread`
- `youtube_video`
- `remote_pdf_url`
- `remote_epub_url`
- `uploaded_pdf_file`
- `uploaded_epub_file`
- `browser_article_capture`
- `browser_pdf_capture`
- `browser_epub_capture`
- `podcast_episode_transcript`
- `video_transcript`

The initial cutover should implement all media-add and user-retry source types.
Podcast subscription polling can adopt the attempt table only where it creates or
updates user-visible media source state. It must not block the media-add cutover.

## API Design

### Idempotency

Mutating ingest endpoints accept a caller-provided idempotency key.

Header:

```http
Idempotency-Key: <opaque client-generated token>
```

Rules:

- the BFF preserves this header,
- frontend ingest clients generate a stable key per queued item or share result,
- duplicate requests from the same viewer with the same key return the same
  media ID and semantically equivalent status,
- parameter mismatch for an idempotency key is a typed client error,
- keys are not derived from sensitive data,
- keys are not used for GET/DELETE.

`request_id` remains an observability correlation ID. It is not an idempotency
key.

### `POST /media/from_url`

Request body remains:

```json
{
  "url": "https://example.com/source",
  "library_ids": []
}
```

Response after hard cutover:

```json
{
  "data": {
    "media_id": "<uuid>",
    "source_attempt_id": "<uuid>",
    "source_type": "x_author_thread",
    "source_attempt_status": "queued",
    "idempotency_outcome": "created",
    "processing_status": "pending",
    "ingest_enqueued": true
  }
}
```

Allowed `idempotency_outcome` values:

- `created`: this request created a new media item,
- `reused`: this request reused an existing media item or replayed an accepted
  idempotent request.

No source-specific public URL route is introduced.

### Browser Capture Endpoints

`POST /media/capture/article` and `POST /media/capture/file` use the same
acceptance owner. Once a request passes transport and auth validation, failures
inside sanitization, storage, or extraction are recorded against media.

### Upload Endpoints

`POST /media/upload/init` remains the durable acceptance boundary for uploaded
file sources. It creates media and media_source_attempt intent rows before
returning an upload URL.

`POST /media/{media_id}/ingest` confirms bytes and starts the same source
lifecycle. Confirm-time failures update the existing attempt/media instead of
owning separate lifecycle policy.

### Retry and Refresh

Public commands remain distinct because user intent differs:

- `POST /media/{media_id}/retry` retries a failed source or metadata stage.
- `POST /media/{media_id}/refresh` reacquires source content for a ready or
  failed source-backed item.

Internal implementation is unified. Both commands create a new
`media_source_attempts` row and enqueue `ingest_media_source` when source work is
needed.

Source retry and refresh accept the same `Idempotency-Key` header as source
acceptance. The first command returns `retrying` or `refreshed`; replaying the
same key for the same viewer, media item, and action returns the same
`source_attempt_id` with `idempotency_outcome: "reused"`. Reusing a key for a
different source command is a typed client error.

There must be no third source-retry API and no source-specific retry route.

## State Machine

### Media Summary State

`media.processing_status` remains the user-facing summary:

- `pending`: durable item accepted, no source attempt has started,
- `extracting`: source acquisition or materialization is running,
- `ready_for_reading`: source materialized for document reading,
- `embedding`: source readable, search/indexing still progressing,
- `ready`: all applicable processing complete,
- `failed`: source acquisition/materialization failed.

`failure_stage` uses existing values:

- `upload` for accepted uploaded/captured file bytes that are missing or invalid,
- `extract` for source acquisition, sanitization, remote fetch, storage, and
  document extraction failures,
- `transcribe` for transcript acquisition failures,
- `embed` for search/embedding failures,
- `metadata` for metadata enrichment soft warnings,
- `other` only for genuinely uncategorized expected failures.

Do not add source-type-specific failure stages. Use `source_type`, `provider`,
and `error_code` on the attempt row for specificity.

### Attempt State

`media_source_attempts.status` values:

- `accepted`: durable command recorded, job not enqueued yet,
- `queued`: source job enqueued,
- `running`: source job claimed the attempt,
- `succeeded`: source acquisition/materialization completed,
- `failed`: source acquisition/materialization failed,
- `superseded`: a newer attempt replaced this attempt before it ran.

Only `media_source_ingest.py` writes these states.

## Canonical Identity and Duplicate Resolution

Before provider/source truth is known, the media row stores provisional display
metadata only:

- kind,
- title,
- requested_url,
- canonical_source_url when derived from request URL,
- provider when the provider is known,
- `provider_id = NULL` unless provider truth is already canonical.

After acquisition:

- X sets provider ID to `author-thread:<x_author_id>:<conversation_id>`,
- X quote-post children use `post:<post_id>`,
- YouTube sets provider ID to the video ID and canonical watch URL,
- remote files set `file_sha256` after bytes are available,
- generic web articles set canonical URL after redirects,
- PDF/EPUB upload/capture sets `file_sha256` after bytes are available.

If materialization resolves to an existing canonical media item:

1. lock both rows in a deterministic order,
2. assign selected libraries to the canonical winner,
3. mark the provisional row superseded or delete it through the media deletion
   owner after preserving a user-visible result mapping,
4. return the canonical `media_id`,
5. never leave two canonical winners for the same provider/file identity.

No runtime compatibility branch may recognize old X provider IDs such as raw
post IDs or `thread:<post_id>`. Existing rows must be repaired by migration or a
one-time operator command.

## Capability Contract

`capabilities.py` must derive retry/refresh from the source contract, not just
media kind plus `media_file_exists`.

`can_retry` is true when:

- the viewer is the creator,
- `media.processing_status = failed`,
- the latest failed source attempt has a retryable source intent,
- the failure is not terminal,
- the source owner can reacquire or reprocess the source.

`can_refresh_source` is true when:

- the viewer is the creator,
- the item is source-backed,
- the latest source contract can be reacquired,
- processing status is refreshable.

Remote PDF/EPUB URL rows with no `media_file` but with a durable source URL must
be retryable after a source-fetch failure. Current kind/file checks are
insufficient and must be replaced.

Terminal failures:

- password-protected PDF remains non-retryable unless the user provides a new
  file,
- unsafe EPUB archive remains non-retryable unless the user provides a new file,
- unsupported/invalid initial source shapes remain pre-acceptance errors.

## Frontend Contract

### Add Content Tray

`AddContentTray` remains a transient local queue only until backend acceptance.
After `POST /media/from_url` returns a media ID, the durable media item is the
source of truth.

Final behavior:

- pending accepted items display as "Added" or "Processing",
- if the source later fails, the media/library panes show durable retry,
- frontend local retry is only for pre-acceptance transport/client errors,
- request IDs are shown for backend errors,
- selected library IDs stay attached to the accepted source intent.

### Share Capture

`ShareCapture` uses the same URL ingest client as Add Content. Failed
pre-acceptance URL calls remain retryable on the share page. Accepted URLs return
media IDs and are no longer treated as lost, even if source acquisition later
fails.

### Media and Library Panes

Retry and refresh buttons call the single source retry/refresh API clients. The
panes do not reconstruct source policy from kind-specific checks.

Duplicate frontend logic to consolidate:

- `AddContentTray` URL result handling,
- `ShareCapture` URL result handling,
- `useDocumentActions` retry/refresh mutation handling,
- `LibraryPaneBody` retry/refresh mutation handling,
- `PodcastDetailPaneBody` retry/refresh mutation handling,
- `retryClient.ts` pass-through wrappers.

Final frontend owner:

- one media ingest client module for from-url/capture/upload/retry/refresh,
- one typed result formatter for source-ingest failures,
- one bounded URL capture runner shared by Add Content and Share Capture,
- one retry/refresh action helper used by media, library, and podcast surfaces.

## Composition With Other Systems

### Libraries

`library_governance` continues to validate writable destinations. `library_entries`
continues to be the only writer of library entries.

The source lifecycle owner must call:

- `validate_writable_library_destinations` before durable acceptance,
- `assign_libraries_for_media_in_current_transaction` in the media creation
  transaction,
- `assign_libraries_for_media` when canonical duplicate resolution returns a
  winner.

### Background Jobs

`background_jobs` remains the queue. The cutover does not introduce Temporal,
Vercel Workflow, or a new queue service. For a one-user prototype, Postgres queue
plus idempotent commands is the correct local maximum.

The design remains future-compatible with durable workflow engines because the
source attempt table is already the workflow state and replay boundary.

### Provider Events

`external_provider_events` records provider-facing telemetry. It is not the
durable user item and must not be used as a substitute for `media` plus
`media_source_attempts`.

### Content Indexing and Metadata

Source success can dispatch indexing and metadata enrichment. Indexing/metadata
failures do not erase source success. They update their own state machines and
capabilities.

### Search and Reader

Search and reader surfaces depend on fragments, transcript versions, PDF text, or
EPUB nav artifacts. Failed source attempts may not have readable artifacts. They
must render as failed media, not as missing media.

### Storage

Storage writes and direct-upload URL signing happen after durable acceptance. If
signing or storage writes fail, the attempt and media are marked failed. Storage
cleanup after retry or duplicate resolution happens after DB state commits, using
existing explicit cleanup patterns.

Retry/refresh dispatch is a two-transaction command:

- transaction 1 records the new `media_source_attempts` retry/refresh intent,
- transaction 2 verifies non-reacquirable source storage when required, resets
  rewriteable domain artifacts, inserts the `ingest_media_source` job, and marks
  the attempt queued,
- storage objects collected by transaction 2 are deleted only after that
  transaction commits.

If transaction 2 fails, the cleanup rolls back and the retry/refresh attempt is
marked failed. The previous artifacts are not destroyed by a queue insertion or
source-preflight failure.

Podcast transcript source retry is part of the same dispatch contract. Operator
requeues run transcript quota admission and write
`podcast_transcript_request_audits` inside transaction 2 before the
`ingest_media_source` job is visible. Quota or billing rejection is recorded on
the source attempt and returned as the typed API error; it is not converted into
a silent non-enqueued success.

## File Plan

### New Files

- `python/nexus/services/media_source_ingest.py`
  - source acceptance, attempts, retry, refresh, job payload construction,
    canonical duplicate resolution orchestration.
- `python/nexus/services/media_source_types.py`
  - canonical source-attempt type constants and policy sets used by dispatch,
    retryability, failure-stage, and cleanup rules.
- `python/nexus/services/web_article_ingest.py`
  - generic web article materialization adapter consumed by the source owner.
- `python/nexus/services/web_article_artifacts.py`
  - shared web/X/browser article artifact cleanup.
- `python/nexus/services/pdf_indexing.py`, `python/nexus/services/pdf_metadata.py`,
  `python/nexus/services/epub_metadata.py`
  - PDF/EPUB post-success indexing and metadata ownership moved out of task
    modules.
- `python/nexus/tasks/ingest_media_source.py`
  - single queue handler for source attempts.
- `migrations/alembic/versions/0133_media_source_attempts.py`
  - exact version depends on whether `0132_external_provider_events.py` is
    already merged.
- `migrations/alembic/versions/0134_media_source_attempts_job_delete_contract.py`
  - makes `media_source_attempts.job_id` `ON DELETE SET NULL` so durable source
    attempts can outlive operational background-job pruning.
- `python/tests/test_from_url.py`, `python/tests/test_upload.py`,
  `python/tests/test_reconcile_stale_ingest_media.py`, and focused media tests
  - owner-level behavior tests for source acceptance, post-acceptance failures,
    retry/refresh, stale recovery, and upload/capture boundaries.
- `python/tests/test_media_source_attempts_migration.py` or migration tests in
  `test_migrations.py`.
- `apps/web/src/lib/media/sourceIngestClient.ts`
  - canonical frontend ingest/retry/refresh client if `ingestionClient.ts` grows
    too broad.

### Files To Rewrite or Narrow

- `python/nexus/services/media_ingest.py`
  - becomes a thin call into `media_source_ingest.accept_url_source`.
- `python/nexus/services/remote_file_ingest.py`
  - stops creating media; becomes a remote-file adapter.
- `python/nexus/services/x_ingest.py`
  - stops accepting media; becomes X adapter plus X-specific materialization.
- `python/nexus/services/youtube_video_ingest.py`
  - owns YouTube metadata/transcript materialization for queued source attempts.
  - is called only by `media_source_ingest.py`; it is not a registered
    source-acquisition queue lane.
- `python/nexus/services/media.py`
  - loses `create_provisional_web_article`, captured article/file acceptance, and
    `refresh_source_for_viewer`; remains media listing/hydration.
- `python/nexus/services/web_article_lifecycle.py`
  - deleted; retry now routes through `media_source_ingest.py` and generic web
    materialization lives in `web_article_ingest.py`.
- `python/nexus/services/pdf_lifecycle.py`
  - loses source retry/confirm ownership; keeps PDF extraction/materialization
    helpers that the source owner calls.
- `python/nexus/services/epub_lifecycle.py`
  - loses source retry/confirm ownership; keeps EPUB extraction/materialization
    helpers that the source owner calls.
- `python/nexus/services/media_retry.py`
  - becomes a thin stage dispatcher or is deleted if the source owner and
    metadata owner are called directly by the route.
- `python/nexus/services/capabilities.py`
  - derives source retry/refresh from `media_source_attempts`.
- `python/nexus/jobs/registry.py`
  - registers `ingest_media_source` and removes old source-acquisition job kinds.
- `python/nexus/config.py`
  - worker allowed job defaults updated for the hard cutover.
- `deploy/env/*`, `deploy/hetzner/sync-env.sh`, `deploy/vercel/sync-env.sh`,
  `.env.example`
  - remove old worker job-kind assumptions and add any new required env contract.

### Frontend Files

- `apps/web/src/lib/media/ingestionClient.ts`
  - either remains canonical or delegates to `sourceIngestClient.ts`.
- `apps/web/src/lib/media/sourceUrlCapture.ts`
  - shared bounded URL capture runner and saved-failed source formatter for Add
    Content and Share Capture.
- `apps/web/src/lib/media/sourceActionProjection.ts`
  - shared retry/refresh result projection for media, library, and podcast
    surfaces.
- `apps/web/src/lib/media/retryClient.ts`
  - delete; move meaningful commands into the canonical media client.
- `apps/web/src/lib/media/useDocumentActions.ts`
  - use shared retry/refresh helper.
- `apps/web/src/components/AddContentTray.tsx`
  - use shared URL capture runner and source failure formatter.
- `apps/web/src/app/share/ShareCapture.tsx`
  - use same runner and formatter.
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  - remove duplicate retry/refresh mutation helper.
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
  - remove inline refresh/retry behavior where it duplicates the shared helper.
- `apps/web/src/lib/actions/resourceActions.ts`
  - keep action construction only; no capability normalization beyond typed
    booleans supplied by the server.

### Tests To Update

- `python/tests/test_from_url.py`
- `python/tests/test_ingest_web_article.py`
- `python/tests/test_ingest_youtube_video.py`
- `python/tests/test_pdf_ingest_task.py`
- `python/tests/test_epub_ingest.py`
- `python/tests/test_upload.py`
- `python/tests/test_media.py`
- `python/tests/test_reconcile_stale_ingest_media.py`
- `python/tests/test_capabilities.py`
- `apps/web/src/__tests__/components/AddContentTray.test.tsx`
- `apps/web/src/app/share/ShareCapture.test.tsx`
- `apps/web/src/lib/media/ingestionClient.test.ts`
- `apps/web/src/lib/media/retryClient.test.ts` must be deleted with
  `retryClient.ts`.

## Duplicate Patterns To Eliminate

### Processing-State Mutation

Current repeated pattern:

- set `processing_status = extracting`,
- increment attempts,
- set `processing_started_at`,
- clear failure metadata,
- enqueue a job,
- commit,
- on error mark failed.

Canonical owner:

- `media_processing_state.py` for primitive transitions,
- `media_source_ingest.py` for when transitions occur.

No source module writes the failure tuple directly.

### Retry and Refresh Dispatch

Current repeated pattern:

- kind switch in route/service,
- cleanup artifacts,
- enqueue source-specific job,
- return similar dict.

Canonical owner:

- `media_source_ingest.retry_source_for_viewer`,
- `media_source_ingest.refresh_source_for_viewer`.

Source adapters provide cleanup, not dispatch policy.

### Source Acceptance

Current repeated pattern:

- create media in generic web, YouTube, upload, captured file,
- fetch before create in X and remote files,
- assign libraries in multiple modules.

Canonical owner:

- `media_source_ingest.accept_*`.

### Frontend Capture and Retry

Current repeated pattern:

- Add Content and Share Capture run parallel URL saves independently,
- media/library/podcast panes each perform retry/refresh API calls and local
  optimistic patches,
- retry client wraps raw API calls without owning behavior.

Canonical owner:

- one source ingest client,
- one source failure formatter,
- one bounded URL runner,
- one retry/refresh action helper.

## Implementation Phases

### Phase 1: Schema and Owner Skeleton

1. Add `media_source_attempts`.
2. Add model and migration tests.
3. Add `media_source_ingest.py` with acceptance and state commands.
4. Add `ingest_media_source` job kind.
5. Add source adapter interfaces.

No source path moves until the owner can create media plus attempt rows and run a
no-op test adapter end to end.

### Phase 2: Generic Web and Remote File Cutover

1. Move generic web URL acceptance into `media_source_ingest`.
2. Convert remote PDF/EPUB URL ingest to durable-first placeholders.
3. Remote file fetch/storage failures mark failed media.
4. Existing remote-file tests now assert durable failed rows for upstream
   failures.
5. Delete old remote-file create-before-fetch public entrypoint.

### Phase 3: X and YouTube Cutover

1. Convert X URL acceptance to durable-first.
2. Keep `provider_id = NULL` until X provider truth is known.
3. X provider failures mark failed media plus provider event.
4. Convert YouTube acceptance and transcript source acquisition to the shared
   owner.
5. Delete old direct `x_ingest.ingest_x_author_thread_url` route dispatch and
   old YouTube acceptance entrypoint.

### Phase 4: Upload and Browser Capture Cutover

1. Add upload-init attempt rows.
2. Move upload confirm policy into the shared owner.
3. Move browser article/file capture acceptance into the shared owner.
4. Ensure sanitization/storage failures after accepted capture are durable.

### Phase 5: Retry, Refresh, Capabilities

1. Move source retry/refresh from media/pdf/epub/web/transcript services into
   `media_source_ingest`.
2. Update `capabilities.py` to use source attempts.
3. Delete duplicated retry/refresh code.
4. Update media/library/podcast frontend surfaces to use one action helper.

### Phase 6: Job and Env Hard Cutover

1. Remove old source-acquisition job definitions.
2. Update worker allowlists and env validation.
3. Update stale-ingest reconciliation to inspect source attempts plus media
   summary state.
4. Run a grep for deleted job kinds and deleted public entrypoints.

### Phase 7: Data Repair and Production Cutover

1. Backfill source attempts for existing source-backed media where possible.
2. Repair legacy X provider IDs through a one-time command or migration.
3. Mark unreconstructable old rows as non-source-retryable through data, not
   runtime fallbacks.
4. Deploy backend and worker together.
5. Verify production with read-only DB checks, API smoke, and a gated live X test
   only when provider credits are available.

## Acceptance Criteria

### Backend

- Every accepted `POST /media/from_url` source returns a `media_id` and
  `source_attempt_id`.
- X provider 402/404/429/timeout creates a failed media row with retry
  capability when retryable.
- Remote PDF/EPUB 404/timeout/invalid bytes/storage failure creates a failed
  media row with retry capability when retryable.
- Generic web extraction failure creates a failed media row.
- YouTube transcript/provider failure creates a failed media row or transcript
  unavailable state according to the transcript contract.
- Browser article sanitization/no-readable-text failure after valid request
  creates a failed media row.
- Uploaded/captured file failures after acceptance update the existing media row,
  including direct-upload signing failures, missing upload objects, invalid
  captured file bytes, storage failures, and extraction failures.
- No route or source adapter performs provider/network/storage work before
  durable acceptance.
- No source module writes `media.processing_status`, `failure_stage`,
  `last_error_code`, `last_error_message`, or `failed_at` outside the state owner.
- One source-acquisition job kind exists.
- Old source-acquisition job kinds are removed from registry and env defaults.
  Historical docs/tests may mention old task names only as immutable history or
  adapter-level test fixtures, not as runtime queue lanes.

### Frontend

- Add Content and Share Capture use one URL capture runner.
- Backend-accepted failed ingest is not shown as "lost"; the media item can be
  opened later.
- Retry buttons call the shared source retry client.
- Request IDs are visible for backend errors.
- No component owns source-specific retry policy.

### Data and Ops

- Source attempts can be queried by request ID, media ID, source type, status, and
  provider target.
- Provider events correlate with source attempts.
- Production worker allowlist contains the new job kind and not the removed
  source job kinds.
- Existing media rows are backfilled or repaired before code requires attempts.
- Production smoke proves that a forced X provider failure and forced remote file
  failure both leave durable failed items.

## Non-Goals

- No scraping fallback for X.
- No oEmbed fallback for X.
- No generic web fallback for X URLs.
- No UI-only saved failed item.
- No provider-specific public retry routes.
- No permanent runtime compatibility for old X provider IDs or missing attempt
  rows.
- No new durable workflow engine in this cutover.
- No automatic infinite retry loop.
- No attempt to make unsupported invalid source shapes durable.
- No hidden fallback from remote PDF/EPUB URL to generic web article.

## Verification Plan

Targeted backend:

```sh
./scripts/with_test_services.sh bash -lc '
  make _test-back-db-ready &&
  cd python &&
  NEXUS_ENV=test uv run pytest -q \
    tests/test_from_url.py \
    tests/test_upload.py \
    tests/test_capabilities.py \
    tests/test_media.py \
    tests/test_podcasts.py \
    tests/test_reconcile_stale_ingest_media.py
'
```

Targeted frontend:

```sh
cd apps/web
bun run test:unit -- \
  src/__tests__/components/AddContentTray.test.tsx \
  src/app/share/ShareCapture.test.tsx \
  src/lib/media/ingestionClient.test.ts \
  src/lib/media/sourceActionProjection.test.ts \
  src/lib/actions/resourceActions.test.ts
bun run test:browser -- \
  src/__tests__/components/AddContentTray.test.tsx \
  src/app/share/ShareCapture.test.tsx
bun run typecheck
```

Grep gates:

```sh
rg -n "ingest_web_article|ingest_youtube_video|ingest_pdf|ingest_epub" \
  python/nexus/jobs python/nexus/config.py deploy/env .env.example
rg -n "thread:|provider_id = '[0-9]+'" python/nexus python/tests
rg -n "retryClient" apps/web/src
```

The first grep must show no source-acquisition registry/env allowlist survivors.
References inside adapter internals and historical migration/docs files are
acceptable only when they are not runtime queue lanes.

## Final State

The final product behavior is simple:

1. User asks Nexus to save a source.
2. Nexus validates the command.
3. Nexus creates a durable media item and source attempt.
4. Nexus returns the media ID.
5. Source acquisition runs after durability.
6. Success materializes readable/playable content.
7. Failure marks the saved item failed with a typed reason.
8. Retry and refresh use the same source attempt owner.

No accepted source disappears.

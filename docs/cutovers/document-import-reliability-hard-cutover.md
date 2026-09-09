# Document Import Reliability Hard Cutover

Status: implemented; its reader-facing surface is superseded by
[`imports-workspace-hard-cutover.md`](imports-workspace-hard-cutover.md) (the
Import Activity page and `GET /media/activity` are gone; the durable acceptance,
Heavy extraction, and ingest-operations clauses below remain in force)
Scope owner: Media ingestion
Applies to: uploaded PDF/EPUB acceptance, Heavy extraction, the Imports workspace, ingest operations
Supersedes: the uploaded-file acceptance/cleanup clauses of `durable-source-ingest-hard-cutover.md` and the in-process Heavy-extraction assumption of `bounded-resource-media-processing-hard-cutover.md`

## 0. Governing rules

`docs/rules/resource-lifecycle.md`, `database.md`, `mutation-ordering.md`, `operation-types.md`, `boundaries.md`, `errors.md`, `tagged-unions.md`, `cleanliness.md`, and `docs/local-rules/testing-standards.md` govern implementation. Where this document is silent, those rules win. Any required exception must be added to this document before code.

## 1. Decision

An upload URL is a temporary capability; an import request is durable user intent. Nexus MUST persist that intent before issuing the capability, but MUST NOT publish `media`, `media_file`, library membership, or a source attempt until the bytes have been verified.

After verification, Nexus MUST publish the media, immutable source identity, library destinations, source attempt, and exact Postgres job in one transaction. Heavy work MUST execute in a fresh bounded child process so a document can fail without killing its queue supervisor.

No blocking product decisions remain. This cut uses the existing direct object-store upload, Postgres job queue, sealed handles, storage cleanup reservation, source attempts, Heavy capacity, and failure-first Activity.

The philosophy is: capabilities expire; intent and causal facts do not. Publication is one database fact, execution is at-least-once and lease-fenced, and every external side effect is replay-convergent rather than claimed to be globally exactly-once.

### Key decisions

| Decision | Why | Deferred alternative |
| --- | --- | --- |
| Pre-publication support session, not provisional media | Makes transport failure durable without lying that media exists | Phantom media rows |
| Existing Postgres job in the publication transaction | Closes accepted/jobless state with no new system | Temporal, Kafka, Redis, or a second queue |
| Direct signed PUT with generation fencing | Current 50 MiB EPUB / 100 MiB PDF caps do not justify resumable-upload complexity | Multipart/tus after measured need |
| Fresh child inside the bounded worker | Contains failure while preserving current handlers and leases | Per-job container/microVM after prototype scale warrants it |
| Failure-first Activity; foreground owns active upload | One truthful owner per phase and no noisy success history | General import-history dashboard |

## 2. Goals

- Preserve one stable upload identity across URL expiry, transport ambiguity, reload, and retry.
- Never expose phantom media or an accepted-but-jobless source attempt.
- Prove source bytes by persisted SHA-256 before parsing.
- Turn parser memory/time/structure exhaustion into a typed terminal document failure while the worker remains healthy.
- Give the user truthful `Retry upload`, `Remove`, and terminal extraction guidance; successful work remains silent.
- Remove the old upload lifecycle completely.

## 3. Non-goals

- Resumable/multipart/tus upload, a new workflow engine, a new broker, or per-job containers/microVMs.
- Increasing the 448 MiB background-worker limit or retrying unchanged resource failures.
- A history dashboard, raw stack traces, presigned-URL logging, or automatic retry-all.
- Repairing unrelated TLS, provider-credit, transcript, 403, routing, embedding, or heading-anchor backlog defects.
- EPUBCheck as a publication gate, parser replacement, or broad error-taxonomy redesign.
- Backward-compatible routes, payloads, decoders, aliases, dual writes, or fallback behavior.

## 4. Target behavior

### 4.1 Upload

1. File selection creates or reuses one viewer-owned upload session under a required idempotency key. No media row exists.
2. Nexus returns a sealed session handle plus a short-lived, generation-fenced PUT capability.
3. The browser reports only safe phase facts: PUT start/end, duration, HTTP status, and a closed transport-failure kind. It never sends or logs the URL.
4. Confirmation claims the current generation under a renewable verification lease, streams and validates the object, computes SHA-256, and copies it to the immutable verification-token-fenced media path (`media/{media_id}/candidates/{verification_token}/original.{ext}`) outside a database transaction. That path is the published source path, not a scratch location: fencing it by the lease token is what makes a superseded or stolen verifier unable to overwrite a published source. It streams the final object and requires the same size, signature, and digest before publication.
5. One database transaction locks and rechecks the session, then creates `media`, `media_file`, destinations, `media_source_attempts`, and exactly one `ingest_media_source` job and marks the session published.
6. Replays return the same published media and attempt. A commit failure publishes nothing; retry converges using the same candidate media ID and digest.
7. URL expiry expires only the capability. The session remains visible and retryable. A retry increments the generation so an old PUT cannot affect the current attempt. Verification-lease expiry likewise expires only the right to *hold* the fence: it governs whether a new confirm may steal the lease, never whether the current holder may publish.
8. Explicit remove deletes the unpublished intent only after scheduling exact cleanup of every staged generation. Published sessions cannot be removed through this API.

### 4.2 Extraction

1. The background supervisor claims, heartbeats, and terminally settles the queue job; it does not import parsers or providers.
2. A fresh child imports and runs one job with the existing claim token and lease-fenced context.
3. The parser hashes the downloaded source and compares it with `media_file.source_sha256` before parsing.
4. Before source publication, a child memory kill, wall timeout, or declared parser budget breach becomes terminal `E_RESOURCE_LIMIT`; the owning source attempt/media are failed in the same transaction as the job. It is not retried unchanged.
5. A committed source-success projection is authoritative. A later child death during post-publication cleanup completes the queue job from that durable success and MUST NOT reverse media, attempt, artifact, or index state.
6. An unrelated or unexplained child exit remains `E_WORKER_INTERRUPTED` and follows the existing bounded retry policy.
7. The supervisor and other queue lanes remain healthy after either case.

### 4.3 User experience

- The foreground Add sheet owns `Preparing`, `Uploading`, and `Verifying`; Import Activity does not duplicate active foreground state.
- A transport failure or expired capability produces one viewer-scoped `UploadSession` Needs Attention item with `Retry upload` and `Remove`.
- Retry opens the file picker. The client requires the same name, kind, and size before requesting a new generation; a mismatch offers a new import instead.
- A verification failure is terminal for that session: explain the safe reason and offer `Remove` plus a new import.
- Published sessions disappear from Activity. Existing media extraction/index failures retain their present media actions.
- No badge counts completed imports, transient foreground work, or another viewer's rows.

`MediaActivityItem` becomes a strict `Media | UploadSession` union. The new item exposes only `session_handle`, display filename, document kind, expected byte size, derived attention reason, timestamps, and closed capabilities `{ can_retry_upload, can_remove }`; it never fabricates media, attempt, pipeline, or progress fields.

## 5. Capability and API contract

All bodies are strict (`extra="forbid"`), all unions use required PascalCase discriminators, and expected failures use the canonical API error envelope. A sealed handle identifies a session; it does not authorize it. Every endpoint rechecks viewer ownership.

### `POST /media/uploads`

Header: `Idempotency-Key` (required).
Body: `{ kind: "Pdf" | "Epub", filename, content_type, size_bytes, library_ids[] }`.

Response is exactly one of:

- `{ kind: "UploadRequired", session_handle, generation, method: "PUT", upload_url, required_headers, expires_at, idempotency_outcome: "Created" | "Reused" }`
- `{ kind: "Published", session_handle, media_id, source_attempt_id, idempotency_outcome: "Created" | "Reused" }`
- `{ kind: "NeedsAttention", session_handle, failure, capabilities }`

The same `(viewer, idempotency key)` MUST mean the same normalized intent. A different body returns `E_IDEMPOTENCY_CONFLICT`. A reusable live generation may be re-signed; an expired, transport-failed, or stolen-lease generation is advanced before signing. A generation whose verification lease was stolen after expiry is never reusable: an abandoned verifier may still be streaming its staged bytes, so the new capability must fence itself with a new generation and a new staging path.

Expected failures: `E_INVALID_REQUEST` (400, malformed intent), `E_INVALID_FILE_TYPE` (400, unsupported kind/content type), `E_FILE_TOO_LARGE` (400), `E_LIBRARY_FORBIDDEN` (403, unwritable destination), `E_UPLOAD_SESSION_NOT_FOUND` (404, a concurrent remove deleted the session before its capability was minted; drop the item and refresh Activity), `E_IDEMPOTENCY_CONFLICT` (409), `E_UPLOAD_VERIFICATION_IN_PROGRESS` (409, a confirm holds the live lease; re-POST the same key converges), `E_SIGN_UPLOAD_FAILED` (500, transient).

### `POST /media/uploads/{session_handle}/transport-failure`

Body is `{ kind: "Network" } | { kind: "Timeout" } | { kind: "HttpRejected", status } | { kind: "Aborted" }`, plus `generation`, `duration_ms`, and `request_id`. A phase report is telemetry, never a mutation the caller can be refused: a stale generation or an already-published session is accepted, returns success, and changes nothing.

Expected failures: `E_INVALID_REQUEST` (400), `E_UPLOAD_SESSION_NOT_FOUND` (404, the obligation is gone; refresh Activity).

### `POST /media/uploads/{session_handle}/retry`

Body: `{ filename, content_type, size_bytes }`. It must match the session intent, advances the generation, clears the transport-failure fact, and returns `UploadRequired`. The persisted intent was validated on create and is immutable, so the retry body is compared with it *before* any content-type judgement and a match needs no re-validation: picking the wrong file is always reported as `E_UPLOAD_INTENT_MISMATCH`, never as a malformed request. Retry uses the same live-lease policy as create — it reports a live verification instead of silently cancelling it.

Expected failures: `E_INVALID_REQUEST` (400), `E_UPLOAD_SESSION_NOT_FOUND` (404), `E_UPLOAD_ALREADY_PUBLISHED` (409, success-class: refresh Activity), `E_UPLOAD_INTENT_MISMATCH` (409, the body does not match the session intent, or the session already carries a terminal verification rejection; both mean "choose the same file or start a new import"), `E_UPLOAD_VERIFICATION_IN_PROGRESS` (409), `E_SIGN_UPLOAD_FAILED` (500, transient).

### `POST /media/uploads/{session_handle}/confirm`

Body: `{ generation }`. Returns `Published`. The server never trusts client-reported size, type, digest, ETag, or completion.

Exactly one locked read of the session row owns the "already published" decision. Confirm is idempotent at every point: a replay that blocks on that lock behind the winning publication, and a verifier that finds the session published at a later phase boundary, both return the same `Published` projection. `E_UPLOAD_ALREADY_PUBLISHED` is never raised by confirm.

The verifier holds a renewable verification lease and extends it under the session row lock at each phase boundary (after the staged measure, after the reserved copy, after the candidate measure). The candidate object's cleanup reservation is keyed to the lease token and its retention deadline trails every renewal by the delayed-writer window, so a durable sweep cannot reclaim bytes a live verifier still owns. Publication requires the lease **token** to match and its generation to be unchanged; lease *expiry* alone MUST NOT reject a commit, because expiry only governs whether a new confirm may steal the lease.

Expected failures: `E_INVALID_REQUEST` (400), `E_LIBRARY_FORBIDDEN` (403, a destination library stopped being writable between create and publication — §6 revalidates authorization at publication; the lease is cleared and no verification fact is recorded), `E_UPLOAD_SESSION_NOT_FOUND` (404), `E_UPLOAD_GENERATION_STALE` (409, a newer generation superseded this attempt), `E_UPLOAD_VERIFICATION_IN_PROGRESS` (409, another confirm owns the lease — either it still holds it, or it stole this one after expiry), `E_STORAGE_MISSING` (400, no staged bytes for this generation; not recorded as a verification fact because it is not a byte/format rejection), `E_SOURCE_INTEGRITY` / `E_INVALID_FILE_TYPE` / `E_FILE_TOO_LARGE` (400, deterministic rejection recorded as a terminal verification fact), `E_STORAGE_ERROR` (500, transient storage failure or a candidate reclaimed mid-verification; the lease is cleared and the confirm stays retryable).

### `DELETE /media/uploads/{session_handle}`

Returns `204` only for an unpublished viewer-owned session after durable cleanup intent exists for every staged generation. A cleanup job for a generation that is already claimed or running *is* that durable intent — strictly stronger evidence than a freshly armed reservation — so it yields `204`, not a conflict. Replay is idempotent.

Expected failures: `E_UPLOAD_SESSION_NOT_FOUND` (404, idempotent success on the client), `E_UPLOAD_ALREADY_PUBLISHED` (409).

The shared storage final-sweep reservation MUST NOT construct a `Media`-domain error for an `UploadSession` owner. It reports one owner-agnostic in-flight-cleanup condition; `Media` maps it to `E_MEDIA_DELETING`, and the upload owner maps it per call site as described above. Create and retry never reserve a staging path that is mid-sweep, because a capability that has been expired long enough for its 24-hour staged sweep to fire always advances the generation first; a reservation conflict there is a defect, not a modeled failure.

These per-endpoint sets are closed. Besides the universal envelope codes (`E_UNAUTHENTICATED`, `E_FORBIDDEN`, `E_VALIDATION`/`E_INVALID_REQUEST`), no other error code may escape these endpoints; anything else is a defect.

The following are deleted, not deprecated:

- `POST /media/upload/init`
- `POST /media/{mediaId}/ingest` for uploaded-file confirmation
- their web BFF routes, response shapes, compatibility decoders, and raw pre-publication media IDs

## 6. Data model and invariants

### `media_upload_sessions`

- `id UUID` application-generated UUIDv7 primary key
- `created_by_user_id UUID` foreign key, non-null
- `candidate_media_id UUID` application-generated UUIDv7, unique, non-null
- `kind TEXT`, `filename TEXT`, `content_type TEXT`, `expected_size_bytes BIGINT`, non-null
- `idempotency_key TEXT`, `request_id TEXT`, non-null
- `upload_generation BIGINT`, `upload_url_expires_at TIMESTAMPTZ`, non-null
- nullable verification lease: `verification_token UUID`, `verification_generation BIGINT`, `verification_expires_at TIMESTAMPTZ`
- nullable transport fact: `transport_failure_kind TEXT`, `transport_http_status INTEGER`, `transport_failed_at TIMESTAMPTZ`
- nullable verification fact: `verification_error_code TEXT`, `verification_failed_at TIMESTAMPTZ`
- nullable publication fact: `published_media_id UUID`, `published_source_attempt_id UUID`, `published_at TIMESTAMPTZ`
- `created_at`, `updated_at`, non-null

True uniqueness only: `(created_by_user_id, idempotency_key)`, `candidate_media_id`, and non-null publication IDs. Do not add business `CHECK`s, triggers, cascades, or a mutable status column.

### `media_upload_session_destinations`

- `(upload_session_id, library_id)` composite primary key and foreign keys
- `created_at TIMESTAMPTZ`, non-null

Destinations are durable intent, not JSON. Authorization is validated on create and revalidated at publication.

### `media_file`

Add non-null `source_sha256 TEXT`. It is the lowercase 64-character digest of the exact immutable stored source. Do not revive the removed `file_sha256` name.

### Cutover data migration

This is a maintenance-window hard cut, not expand/contract compatibility:

1. Stop API and both workers; keep PostgreSQL and object storage available.
2. Migration `0220` creates the session tables and adds a temporarily nullable digest column.
3. A resumable migration-owned backfill streams every existing `media_file`, verifies stored size/signature, and writes the measured digest. Missing or changed objects fail the release; never invent a digest.
4. Migration `0221` asserts zero null/invalid digests, makes the column non-null, and removes stale upload/index schema residue.
5. Start only the new runtime and run the acceptance smoke. No released runtime reads or writes the intermediate shape.

The backfill implementation lives with migration artifacts, is covered against PostgreSQL and MinIO, and is not imported by runtime code.

### Derived session state

Precedence is `Published`, `VerificationFailed`, `Verifying` (live lease), `TransportFailed`, `CapabilityExpired`, `AwaitingBytes`. Invalid field combinations are defects asserted by the service and tests, not tolerated or decoded.

Session identity is durable; staged bytes are not. Unpublished staged objects expire after 24 hours through the existing durable storage-cleanup owner. The small session row remains until explicit removal or publication so the user obligation and idempotency record do not disappear.

## 7. Composition and ownership

### Upload-session owner

Create `services/media_upload_sessions.py` as the sole lifecycle owner. It normalizes intent, seals/unseals `UploadSessionHandle` through `sealed_handles.py`, owns generation and verification leases, and calls existing domain owners rather than writing their tables ad hoc.

Generalize the existing storage final-sweep reservation to the closed owner union `Media | UploadSession`; do not create a second cleanup mechanism. Staged reservations carry a 24-hour `retain_until` and delete expired bytes even while the intent row remains. Canonical copy is reserved under the session before external I/O. After publication the cleanup job observes `media_file` and retains it; after an abandoned/failed copy it deletes it.

### Publication transaction

The upload owner performs staged read/hash, reserved canonical copy, and final read/hash first. Transient storage failure clears the verification lease and remains retryable; only deterministic byte/format/integrity rejection records a terminal verification fact. A short transaction then:

1. locks the session and verifies viewer, generation, lease token, intent, digest, and unpublished state (the lease token, not its expiry, is the fence);
2. creates the candidate `media` and `media_file` with the canonical path and digest;
3. assigns the validated libraries;
4. creates the accepted uploaded-file source attempt;
5. calls existing `enqueue_accepted_source_attempt_in_transaction(...)`;
6. records the publication fact and commits.

No external call occurs in this transaction. Exactly one exact source job row may correspond to the published attempt, regardless of job state. Notification remains the Postgres queue's commit-coupled behavior.

### Process executor

Add one background process executor modeled on `services/node_ingest.py`:

- closed, versioned, size-bounded JSON result union: `Succeeded | Reschedule | ModeledFailure | Defect`;
- supervisor owns claim, heartbeat, Heavy-capacity lease, timeout, and terminal queue transition;
- child owns handler imports and business execution, using the existing job/claim context;
- supervisor registry contains declarative module paths and a closed resource-failure projection, not imported handler objects;
- Heavy source projection atomically writes `E_RESOURCE_LIMIT` to job, attempt, and media;
- child raises its `oom_score_adj`; startup fails readiness unless cgroup v2 reports `memory.oom.group=0` and the configured limit is present;
- 15-minute Heavy-source wall limit; TERM grace then KILL; all process/temp state is cleaned on every exit;
- supervisor steady-state RSS target is at most 96 MiB. The container limit remains 448 MiB.

Only the background worker changes. Interactive jobs remain in-process.

### Parser budgets

Keep existing archive, aggregate-output, page, asset, and temp-disk limits. Add:

- EPUB XHTML decoded bytes: 16 MiB per entry;
- XML depth: 128;
- elements: 100,000 per entry and 1,000,000 per book;
- attributes: 64 per element and 1,000,000 per book;
- entity expansion and network access: disabled.

Run a streaming structural preflight before any DOM build or rewrite. PDF extraction MUST derive blocks/text from one page representation and release page-local objects before advancing. Both parsers MUST compare the stored digest before opening the document.

A declared budget breach and confirmed child memory/time exhaustion share public code `E_RESOURCE_LIMIT` with a safe dimension (`Memory`, `Time`, `Structure`, `Output`); raw parser/provider text remains operator-only.

### Reconciliation and operations

- Delete pending-upload media cleanup. Reconciliation never deletes a session because a capability expired.
- Production configuration MUST keep ingest reconciliation enabled; readiness includes last-success freshness.
- Extend the existing internal ingest health projection with counts for expired/failed upload sessions, verification leases, accepted-jobless defects, and child resource exits. Return aggregates and opaque IDs only. The existing worker health command—not the API container—owns supervisor heartbeat and cgroup readiness.
- Emit structured `IntentAccepted`, `PutFailed`, `ConfirmStarted`, `ConfirmFailed`, and `Published` facts keyed by session ID, generation, request ID, and attempt ID where the fact carries one. Never log filename, content, presigned URL, or credentials. `ConfirmFailed` has exactly one emission point covering every way a confirm can settle unsuccessfully — including a publication-transaction or commit failure — so no future failure path can settle a confirm silently; its `error_code` is the modeled code, or `E_INTERNAL` for a defect.
- The upload owner owns the derived-session-state precedence exactly once as a set-wise SQL expression and once as the per-row classifier the projection uses. The Activity page and the operator health aggregate both select that expression instead of restating the rule, and the bounded page cross-checks the two owners at runtime.
- Never run application imports inside a serving container for diagnostics; use the bounded internal endpoint or read-only SQL runbook.
- No automatic replay of today's outstanding rows. Each repair is exact, evidence-gated, and separately authorized after its owner is fixed.

## 8. Hard-cut residue

Delete the provisional-media upload constructor, `services/upload.py` if no caller remains, `MediaSourceAttempt.signed_upload_expires_at`, abandoned-pending-media reconciliation, the stale `media.file_sha256` index predicate, early Activity acceptance/invalidation, `AcceptedUncertain`, old BFF routes, old fixtures, and duplicate storage/hash helpers.

Historical migrations and historical decision documents remain history. Runtime names, exports, route registrations, payload literals, environment variables, mocks, and current docs contain no old contract. Do not add permanent source-grep tombstone tests after the cut is complete.

## 9. Non-overlapping implementation slices

| Slice | Owns | May not edit |
| --- | --- | --- |
| A. Persistence/identity | `migrations/alembic/versions/0220*`, `0221*`, migration backfill, `python/nexus/db/models.py`, `services/sealed_handles.py`, `storage/paths.py` | API, worker, parser, web |
| B. Upload/API | new `services/media_upload_sessions.py`, `media_source_ingest.py`, `schemas/media.py`, `api/routes/media_ingest.py`, storage final-sweep, errors | worker executor, parsers, web |
| C. Worker isolation | `python/nexus/jobs/{worker,registry,process_executor}.py`, `apps/worker/main.py`, `python/nexus/config.py`, background service in `deploy/hetzner/docker-compose.yml` | upload/API, parsers, web |
| D. Parser safety | `python/nexus/services/{pdf_ingest,epub_ingest,parser_temp}.py` and bounded parser fixtures/tests | worker, API, DB, web |
| E. Activity/ops | `python/nexus/{schemas,services,api/routes}/media_activity.py`, `api/routes/internal_ingest.py`, `tasks/reconcile_stale_ingest_media.py` | upload mutation, parser, web |
| F. Web capability UX | new `apps/web/src/app/api/media/uploads/**`, `lib/media/{ingestionClient,activityClient,MediaActivityProvider}*`, `useAddContentSession.ts`, `MediaActivityPage*` | backend Python |
| G. Integration/cut | existing durable-ingest journey, `testdata/proofs.json`, release/config docs, residue removal | new behavior |

Order: A first; C and D may proceed independently; B follows A; E follows A/B; F follows B/E; G integrates last. Do not deploy a partial slice.

## 10. Red / green / refactor proof plan

Use only `./scripts/test` as defined by `docs/local-rules/testing-standards.md`. Capture sensitivity before implementation, then keep one proof per ownership boundary.

| Boundary / named risk | One proof | Required realism |
| --- | --- | --- |
| Persistence | migration upgrade plus explicit irreversible-downgrade and model contracts | real PostgreSQL |
| Upload publication | expiry/retry identity, generation fencing, hash, forced commit failure, exactly-one job | service test with real PostgreSQL and MinIO |
| Worker containment | child allocation kill/timeout; supervisor runs the next job; stale child cannot publish | real worker process, PostgreSQL, cgroup-capable CI lane |
| Parser safety | adversarial EPUB depth/node/attribute cases and complex PDF; digest-before-open; temp cleanup | isolated parser process plus property/fuzz fixtures |
| Activity/ops | viewer scope, derived failure precedence, success silence, reconciler/readiness defect | service test with real PostgreSQL |
| Web UX | strict union decode and Upload/Retry/Remove phase/action behavior | Chromium component test with HTTP boundary stubs |
| End to end | extend `durable-ingest-reader-open`; do not add a second journey | existing journey topology |

Red evidence MUST show the current implementation fails the target assertion: provisional media exists, publication can precede its exact job, worker death loses the supervisor, structural amplification is untyped, and the browser lacks the session union. Fault/sensitivity IDs and their exact proof bindings belong in `testdata/faults/manifest.json`; `testdata/proofs.json` selects the document-import proof portfolio.

Green acceptance runs:

1. `./scripts/test changed <owned paths or nodes>` per slice.
2. `./scripts/test prove --proof <proof-id> --against base:<ref>|fault:<fault-id>` for each table row.
3. `./scripts/test confidence` once after integration.
4. `./scripts/test pr` before merge; `./scripts/test full` only when selected by release policy.

Refactor only after green: centralize primitives, delete the old path and duplicate helpers, run a one-time residue search, and rerun the same proofs. No production resources, provider calls, arbitrary sleeps, retry loops, new journey, or physical-device proof are in the 80/20 shape.

## 11. Acceptance criteria

- Upload creation commits a support session and destinations but zero media/source-attempt/job rows.
- Expiry and reload preserve the same sealed handle and candidate identity; retry advances the generation.
- A stale generation cannot confirm or change current user-visible state.
- Confirmation verifies size, signature, SHA-256, immutable final copy, and current lease before publication.
- Fresh readers can observe either no media or media + file digest + destinations + attempt + exactly one job; never a subset.
- Parser execution refuses a digest mismatch before document open.
- An injected transaction failure exposes no media; replay converges to the same media/attempt without duplicate jobs.
- A forced pre-publication child OOM/timeout leaves the supervisor ready, releases Heavy capacity, records `E_RESOURCE_LIMIT`, and does not retry unchanged work; a post-publication death preserves committed success.
- EPUB/PDF budget fixtures fail deterministically and clean temporary/object state.
- Activity shows only viewer-owned unresolved obligations with truthful capabilities; success is silent.
- Reconciler freshness and accepted-jobless defects affect readiness in production.
- Old routes return 404 and no runtime caller, decoder, config, or current contract references the legacy flow.
- The existing durable-ingest journey passes through upload, publication, extraction, and reader open.

## 12. Design references

- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads): durable session identity and retryable transport are separate concerns.
- [PostgreSQL locking clauses](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE): reuse the current `SKIP LOCKED` queue and transaction boundary.
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html): validate type, size, storage isolation, and decompressed output.
- [EPUB 3.3](https://www.w3.org/TR/epub-33/) and [EPUBCheck](https://www.w3.org/publishing/epubcheck/docs/getting-started/): conformance is distinct from safe bounded readability; EPUBCheck is not the runtime gate.
- [OpenTelemetry logs](https://opentelemetry.io/docs/specs/otel/logs/) and [messaging spans](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/): correlate upload, queue, worker, and parser facts without leaking capabilities.
- [Kafka delivery semantics](https://kafka.apache.org/documentation/#semantics): do not claim end-to-end exactly-once outside one transactional destination.

## 13. Final state

Nexus has one durable upload-session owner, one atomic media-publication boundary, one immutable source digest, one Postgres source job, one isolated background execution boundary, and one failure-first user repair surface. Temporary capabilities and expendable bytes may expire; accepted identity, causal facts, and user obligations do not disappear.

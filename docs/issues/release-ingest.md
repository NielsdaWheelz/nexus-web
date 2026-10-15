# release: ingest (PR1 source lifecycle and the post room)

PR1 changes these contracts at once; the api refuses the old forms and there is no
compatibility arm. the final combined release uses `X-Nexus-Wire: 2`: web and
api deploy together from the release sha. old tabs receive 426 until reloaded;
obsolete request bodies are also refused by the current schema.

| before | after |
|---|---|
| `POST /media/from-url {url, library_ids}` + `Idempotency-Key` → `{import_ref, media_id, source_attempt_id, source_type, source_attempt_status, idempotency_outcome, processing_status, ingest_enqueued}` | `{id, url, library_ids}` (`id` the client's attempt id, a version 4 uuid) → `{import_ref, media_id, source_attempt_id, created, processing_status}` |
| `POST /media/{id}/retry {from_stage, client_mutation_id, expected_attempt_id}` → `{kind: SourceRetry, …}` | `{expected_attempt_id}` → `{media_id, source_attempt_id, job_id}`; a resend after it landed is 202 again |
| `POST /media/{id}/repair {kind, client_mutation_id, …}` | the same without `client_mutation_id`; a resend after it landed is 202 again |
| `POST /media/{id}/refresh {client_mutation_id, expected_attempt_id}` → `SourceRefreshAdmission{media_id, source_attempt_id, job_id}` (replayed) | `{expected_attempt_id}` → `{media_id, source_attempt_id, job_id}`; a resend answers the expected attempt's successor that landed; the expected run in flight answers itself |
| `POST /ingest/email` → 200 `accepted` even when the body was never stored | 500 when storage fails (nothing created); the worker defers and the sender retries |
| `can_refresh_source` from its own sql (`media.last_error_code`, no email) and the attempt's `source_attempt_refreshable` | the source policy's `source_refreshable` (the attempt's error; email media gain Refresh) |

## order

- this PR deletes `nexus convert-browser-article-captures`, `release.py`'s conversion
  step and `python -m nexus.ops.processing_recovery`. its precondition, a release that
  ran the capture conversion (C8) and the processing repairs (Q8), held at merge: 665's
  `release.py` ran C8 after migrating, and of R1-R7 (`docs/releases/2026-10-13-nexus.md`)
  R1, R2 and R6 are done, R3-R5 owner-deferred and R7 the open rollback window. only R2's
  operators name `reprocess_retained_epub`, `correct_source_type` or
  `ops/processing_recovery.py`; the deferred book repairs (#608, #609, #613) import none.
- the migration `0282_ingest_sources` (after consume's `0281_consumption_override_register`)
  runs in the one end release with everything else; api, workers and web deploy together.

## preflight census (restored backup, mac only; each must match before the release)

```sql
-- refusals: each must be 0, else 0282 raises with the same counts
SELECT count(*) FROM media_source_attempts WHERE source_type = 'video_transcript';
SELECT count(*) FROM media_source_attempts WHERE source_payload ? 'source_storage_path';
SELECT count(*) FROM media_source_attempts
WHERE source_type IN ('youtube_video', 'x_author_thread', 'x_post') AND provider_target_ref IS NULL
  AND COALESCE(source_payload ->> 'video_id', source_payload ->> 'post_id') IS NULL;
WITH latest AS (
  SELECT DISTINCT ON (a.media_id) a.*, m.processing_status::text AS media_status
  FROM media_source_attempts a JOIN media m ON m.id = a.media_id
  ORDER BY a.media_id, a.attempt_no DESC, a.created_at DESC, a.id DESC)
SELECT count(*) FROM latest l
WHERE l.status IN ('accepted', 'queued', 'running')
  AND NOT (l.source_type = 'email_message' AND l.status = 'accepted' AND l.job_id IS NULL
           AND l.media_status = 'failed')
  AND NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.id = l.job_id
                  AND j.kind = 'ingest_media_source'
                  AND j.status IN ('pending', 'failed', 'running', 'dead'));
-- effects (n, for the release notes)
SELECT count(*) FROM media_source_attempts WHERE source_payload ? 'retained_legacy_paths';
SELECT count(*) FROM media_source_attempts
WHERE source_type IN ('youtube_video', 'x_author_thread', 'x_post') AND provider_target_ref IS NULL;
-- stranded post room messages (each converted to failed E_STORAGE_MISSING)
WITH latest AS (
  SELECT DISTINCT ON (a.media_id) a.*, m.processing_status::text AS media_status
  FROM media_source_attempts a JOIN media m ON m.id = a.media_id
  ORDER BY a.media_id, a.attempt_no DESC, a.created_at DESC, a.id DESC)
SELECT count(*) FROM latest
WHERE source_type = 'email_message' AND status = 'accepted' AND job_id IS NULL
  AND media_status = 'failed';
SELECT count(*) FROM background_jobs WHERE kind = 'reconcile_stale_ingest_media_job';
-- the content index loses the reconciler too (Q6): must be 0
SELECT count(*) FROM content_index_states s
WHERE s.owner_kind = 'media' AND s.status IN ('pending', 'indexing')
  AND NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.kind = 'media_content_reindex_job'
                  AND j.payload ->> 'media_id' = s.owner_id::text
                  AND j.status IN ('pending', 'failed', 'running', 'dead'));
```

a nonzero jobless count before the release: let the old reconciler drain it (it runs
every 600 s on the old build) and census again.

## data effects of 0282

- `retained_legacy_paths` leaves every payload: those legacy capture blobs become
  unowned and the orphan sweep deletes them at least 24 h later.
- youtube and X attempts gain `provider_target_ref` from their payload.
- each stranded Post Room message (its html never stored) becomes a failed attempt
  with `E_STORAGE_MISSING` (and "The email was never stored.") on attempt and media,
  and gains its terminal `SourceFailed` history event: Imports shows it failed with
  no retry. the owner deletes it; the sender resends.
- `reconcile_stale_ingest_media_job` rows are deleted; `idempotency_key` and
  `intent_key` are dropped; the type check no longer admits `video_transcript`.
- `resource_mutations` rows with ingest scopes (`media_source_retry:`,
  `media_source_refresh:`, `media_source_repair:`, `media_search_repair:`,
  `operator_*`) stay inert until the last user's migration drops the table.
- irreversible: the pre-migration backup is the rollback.

## env

remove `INGEST_RECONCILE_SCHEDULE_SECONDS` and `INGEST_STALE_EXTRACTING_SECONDS`
wherever set (hetzner worker env; the examples are updated). nothing is added.

## post room worker (Q10)

`wrangler deploy` the updated `deploy/cloudflare/email-worker/worker.js` with the api:
a 4xx still bounces; a 5xx or network failure now throws so the message is deferred.
smoke: send one message (accepted), then one with the staging bucket unreachable
(api 500). if cloudflare bounces the second instead of deferring it, record
`docs/issues/post-room-temporary-failure-unverified.md` and restore the bounce on 5xx.

## owner smoke

add a url, re-add the same url (answers the same media at once, "Already in your
library"); retry a failed source from Imports twice (both succeed); refresh an
email article; send one email to the Post Room.

# release: ingest (PR2 uploads, the firefox capture and the share page)

PR2 changes the upload contract and both its clients at once (hard cutover, wire
stays 1): web, api and the signed extension come from the same release sha.

| before | after |
|---|---|
| `POST /media/uploads {kind: Pdf \| Epub, …}` + `Idempotency-Key` → `UploadRequired{import_ref, session_handle, generation, method, upload_url, required_headers, expires_at, idempotency_outcome}` \| `Published{import_ref, …, source_attempt_id, idempotency_outcome}` \| `NeedsAttention{import_ref, failure, capabilities}` | `{id, kind: pdf \| epub, filename, content_type, size_bytes, library_ids}` → `UploadRequired{import_ref, session_id, generation, upload_url, content_type, expires_at}` \| `Published{import_ref, session_id, media_id, created}` \| `Rejected{import_ref, session_id, code}`; resending the id advances an unpublished session |
| `POST /media/uploads/{handle}/transport-failure`, `…/retry`; `GET /extension/captures/{handle}`, `POST …/retry`, `…/transport-failure` | gone: a failed PUT is answered by creating again |
| `…/{handle}/confirm`, `DELETE …/{handle}` (sealed `nup1.` handles; absent 404) | `…/{session_id}/confirm`, `DELETE …/{session_id}` (absent 204) |
| `POST /extension/captures` `BrowserCaptureIntent` + `Idempotency-Key` | `{id, kind, source_url, filename, content_type, size_bytes, sha256, library_ids}` |
| Imports `upload:nup1.…` refs, `RetryUploadOffer{expected_generation}`, state `TransportFailed` | `upload:<session id>`, `RetryUploadOffer{input}`, no `TransportFailed` |
| history `UploadFailed{generation, transport}` | `UploadFailed{generation}`; the envelope code says why |

## order

- PR2 merges after PR1 (its migration `0283_ingest_uploads` follows PR1's
  `0282_ingest_sources`) and runs in the same end release.
- the extension build and the web/api deploy go out together: an old extension
  build sends no `id` and gets 400, and an extension of another wire gets 426
  ("Update the Nexus extension to keep capturing.").

## preflight census (restored backup, mac only)

```sql
-- sessions by origin and derived state (TransportFailed ones become CapabilityExpired)
SELECT input_origin ->> 'kind' AS origin,
       CASE WHEN published_at IS NOT NULL THEN 'Published'
            WHEN verification_error_code IS NOT NULL THEN 'VerificationFailed'
            WHEN transport_failed_at IS NOT NULL THEN 'TransportFailed'
            WHEN upload_url_expires_at <= now() THEN 'CapabilityExpired'
            ELSE 'AwaitingBytes' END AS state, count(*)
FROM media_upload_sessions GROUP BY 1, 2 ORDER BY 1, 2;
-- history rows that lose their transport detail (they keep E_UPLOAD_TRANSPORT_FAILED)
SELECT count(*) FROM media_upload_events WHERE event_type = 'Failed' AND payload ? 'transport'
  AND payload -> 'transport' <> 'null'::jsonb;
-- reservation jobs deleted: their media/ paths go to the orphan sweep, uploads/ to R2's rule
SELECT status, payload -> 'checkpoint' ->> 'kind' AS checkpoint, count(*)
FROM background_jobs WHERE kind = 'storage_object_cleanup' GROUP BY 1, 2;
```

## preflight: the R2 staging rule

the ledger is gone, so R2's `uploads/` lifecycle rule is the only thing that deletes
staged upload bytes; without it every generation's staged copy stays forever. read
the production bucket's rules (owner, with the release's cloudflare token):

```sh
curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$R2_BUCKET/lifecycle"
```

it must hold `expire-direct-upload-staging`, enabled, prefix `uploads/`, delete at
age 86400. if not, run `deploy/cloudflare/apply-r2-lifecycle.sh`: its PUT replaces
every rule on the bucket, so first copy any other rule the read shows into
`deploy/cloudflare/r2-lifecycle.example.json`. read again before the deploy.

## data effects of 0283

- `media_upload_sessions` loses `idempotency_key` (and its unique constraint) and the
  three transport columns; a `TransportFailed` session derives `CapabilityExpired`:
  the same Imports group, Retry upload and Remove.
- every `UploadFailed` payload loses `transport`; history reads "Upload failed. Upload
  did not finish." for an old transport failure (no network/timeout/status detail).
- every `storage_object_cleanup` job is deleted; orphans live up to ~30 h (the sweep's
  24 h minimum age plus its 6 h interval).
- `resource_mutations` rows with `media_upload_retry:` scopes stay inert until the
  last user's migration drops the table.
- irreversible: the pre-migration backup is the rollback.

## env

remove `STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS` wherever set (hetzner api and
worker env; the example is updated). nothing is added.

## firefox (owner)

1. remove the old extension first: that clears its `nexus-capture-v1` IndexedDB,
   which may hold a frozen capture's bytes. a capture in flight in the old build is
   lost; its server session shows in Imports as an expired upload with Remove.
2. build with `NEXUS_EXTENSION_NEXUS_ORIGIN` / `NEXUS_EXTENSION_STORAGE_ORIGIN` set to
   production, sign it (AMO, unlisted) from the release sha, install, sign in again.
3. a restart, an extension reload or a crash now forgets the capture in progress (no
   Resume); Discard removes a created session in passing.

## web

open Imports panes that hold an `upload:nup1.…` ref read "This import is no longer
available" once; reopening Imports shows the same import as `upload:<session id>`.
android needs no apk change (the share page is web in the webview).

## owner smoke (PR2)

upload a pdf from Add; kill the network mid-upload, then Retry upload (one media,
the session at generation 2); Imports Retry upload of an expired upload with the
original file; capture an article and a pdf link from Firefox into two libraries,
block a PUT once and Retry, Discard a draft; share a url and plain text from the
phone.

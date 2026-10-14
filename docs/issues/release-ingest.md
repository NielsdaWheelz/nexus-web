# release: ingest (PR1 source lifecycle and the post room)

PR1 changes these contracts at once; the api refuses the old forms and there is no
compatibility arm. `X-Nexus-Wire` stays 1 (conventions): web and api deploy together
from the release sha, and a tab open across the deploy fails its url adds and
recoveries (400 `E_INVALID_REQUEST`) until reloaded.

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

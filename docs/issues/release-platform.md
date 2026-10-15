# release: platform substrate (config, storage, api substrate)

The commit "reauthor config, storage and the api substrate" re-authors
`python/nexus/config.py`, the R2 client, storage paths, the orphan sweep, runtime
identity and the web `lib/env.ts`. No migration, no wire change, no apk or extension
change. The commit "retire the replay ledger" converts the last writes that used
`resource_mutations` and drops it (migration `0286_drop_resource_mutations`):
[its section](#retire-the-replay-ledger-0286) below.

## env

Removed keys (constants now, or no reader). None is in `deploy/env/*.example`,
`deploy/vercel/sync-env.sh` or `deploy/hetzner/sync-env.sh`; unset each wherever it
is present (extra env is ignored, so one left set is harmless):

- backend: `DATABASE_LOCK_TIMEOUT_MS` (10 s), `R2_CONNECT_TIMEOUT_SECONDS` (5 s),
  `R2_READ_TIMEOUT_SECONDS` (30 s), `STORAGE_ORPHAN_SWEEP_INTERVAL_SECONDS` (6 h),
  `TRANSCRIPT_EMBEDDING_DIMENSIONS` (256), `MAX_EPUB_ARCHIVE_ENTRIES`,
  `MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES`,
  `MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES`,
  `MAX_EPUB_ARCHIVE_COMPRESSION_RATIO`, `MAX_EPUB_ARCHIVE_PARSE_TIME_MS` (today's
  maxima), `SUPABASE_DB_PORT` (nothing reads it).
- web (vercel): `CSP_MEDIA_ORIGINS` (deployed `media-src` already allows `https:`).

The edge removals (`NEXUS_FABLE_RETENTION_ACCEPTED_AT`, `PODCASTS_ENABLED`,
`EMAIL_INGEST_ENABLED`, the stream keys) are in [release-edge.md](release-edge.md).

Env names are unchanged: a settings field's name is its env name (case-insensitive).

## preflight (owner, on the mac, no network)

1. In the api image built from the release sha, with the prod backend env file and
   `NEXUS_ENV=prod`, run
   `python -c "from nexus.config import get_settings; get_settings()"`. It must pass.
   Refusals it can newly hit: `SIGNED_URL_EXPIRY_S` 0 or above 604800,
   `MAX_PDF_BYTES`, `MAX_EPUB_BYTES`, `EMAIL_INGEST_MAX_BYTES` or
   `BRAVE_SEARCH_TIMEOUT_SECONDS` 0 or negative, `STORAGE_ORPHAN_SWEEP_MIN_AGE_SECONDS`
   below 30, `NODE_INGEST_SCRIPT`, `PARSER_TEMP_ROOT` or
   `BACKGROUND_PROCESS_CGROUP_ROOT` not a normalized absolute path, and any
   `NEXUS_RUNTIME_IDENTITY_FILE` (now also read from a `.env`). A deployed process
   missing several required keys names all of them in one refusal. A field's own
   refusal (a bound, a type, a missing `DATABASE_URL`) names it in lower case
   (`signed_url_expiry_s`, `database_url`); match names case-insensitively.
   `STORAGE_ORPHAN_SWEEP_MIN_AGE_SECONDS`, if set, must stay above 900 and above
   `SIGNED_URL_EXPIRY_S` (config refuses only below 30; unset is 24 h).
2. Repeat with the prod worker env file (`WORKER_LANE` set).
3. Web: `next build` on vercel resolves `getEnv()` as before; now any set
   `FASTAPI_BASE_URL`, `APP_PUBLIC_URL`, `R2_S3_API_ORIGIN` or
   `NEXUS_EXTENSION_REDIRECT_ORIGINS` must be a bare origin (no credentials, path or
   query) in every env. Check the vercel values are bare origins.

## storage

No key shape changes; reading copies stay under `media/{id}/reading-copies/`. The R2
lifecycle file is untouched (no multipart). The sweep's payload key is now
`continuation_token`: one in-flight walk restarts from its first page once.

## owner smoke

Sign in; open a pdf and an epub (signed url, assets); share a pdf and open the public
link (whole and a ranged read); upload a pdf through Add; download an offline reading
copy on the phone; `GET /version` and `GET /readyz` on the api.

## retire the replay ledger (0286)

Wire changes (api and web deploy together; no apk or extension change: neither calls
these routes):

| before | after |
|---|---|
| `POST /chat-runs`, `POST /messages/{id}/rerun\|regenerate` with `Idempotency-Key: <1..128 chars>`; the same key with another body 409 `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`; rejections replayed from the memo | `Idempotency-Key: <uuid>` is the new run's id (else 400 `E_INVALID_REQUEST`); the run with that id answers a resend whatever the body; another user's run id 409 `E_RESOURCE_CONFLICT`; a rejection is not stored (a resend decides again) |
| `PUT /media/{id}/authors {client_mutation_id, mode, authors[{credited_name, binding: existing{contributor_handle} \| new{display_name}}]}` | `{mode, authors[{credited_name, binding: existing{contributor_handle} \| new{id, display_name}}]}`: absolute; a `new` id that exists binds that person if visible, else 422 `E_AUTHOR_NOT_SELECTABLE` (the code's status, as for an existing handle) |
| `POST /me/nexus-selections {client_mutation_id, …}` | without `client_mutation_id`: a plain increment (a resend counts again) |
| `POST /resource-graph/links {client_mutation_id, source, target}` | `{link_id, source, target}`: a resend that landed answers that link with `created: true`; the id held by another link 409 `E_RESOURCE_CONFLICT`; a resend after the link was deleted creates it again |

`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` leaves the api's error codes. Import history keeps it as
stored vocabulary (`schemas/import_history.py`, `lib/imports/copy.ts`; the imports slice
owns it). The metadata research admission and result review were converted by the media
slice (release-media.md).

### order

1. Before deploying, the owner makes sure no chat send shows "Send status unknown" (a
   pending retry): a send pending across the deploy is admitted again as a new run when
   retried, because its receipt lived in the dropped table. Authors, link and launcher
   intents live in memory and do not survive the 426 reload.
2. Writers stopped for the migration (release runbook); `0286_drop_resource_mutations`
   runs after `0285`. Irreversible: rollback restores the pre-release backup.
3. api, workers and web deploy back to back (edge order).

### census (rehearsal on a restored backup, mac only; informational)

```sql
-- what the drop deletes: receipts by scope family and age
SELECT split_part(mutation_scope, ':', 1) AS family, count(*),
       min(created_at), max(created_at)
FROM resource_mutations GROUP BY 1 ORDER BY 2 DESC;
-- import history that still carries the retired code (if 0 on production, the imports
-- slice may drop the literal and its copy)
SELECT 'upload', count(*) FROM media_upload_events
WHERE failure_code = 'E_IDEMPOTENCY_KEY_REPLAY_MISMATCH'
UNION ALL
SELECT 'processing', count(*) FROM media_processing_events
WHERE failure_code = 'E_IDEMPOTENCY_KEY_REPLAY_MISMATCH';
-- after 0286: the table is gone
SELECT to_regclass('public.resource_mutations');  -- null
```

`python/nexus/model_cutover_archive.py` (0246's census) still selects from the table; 0246
precedes 0286 in the chain, so a release that runs 0246 sees it. The query is dead after
0286 and leaves with the post-release purge.

### owner smoke

Send a chat message, toggle the network off mid-send, back on, and Retry send: one turn.
Edit authors adding a new person and save; reopen the editor: the person is listed once.
Research metadata. Link two notes from the link composer. Pick a launcher result.

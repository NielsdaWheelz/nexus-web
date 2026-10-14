# release: platform substrate (config, storage, api substrate)

The commit "reauthor config, storage and the api substrate" re-authors
`python/nexus/config.py`, the R2 client, storage paths, the orphan sweep, runtime
identity and the web `lib/env.ts`. No migration, no wire change, no apk or extension
change. The ledger retirement (PR B, migration `0286_drop_resource_mutations`) adds
its own section here when it lands.

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

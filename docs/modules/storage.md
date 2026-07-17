# Storage

Storage objects are owned by capability-specific DB rows. A storage key by itself
does not authorize access and must not encode user identity.

## Owners

| Object family | DB owner | Key shape | Access lane |
|---|---|---|---|
| Original PDF/EPUB uploads | `media_file` | `media/{media_id}/original.{pdf|epub}` | viewer-authenticated media/file services |
| Direct-upload staging | transient upload flow | `uploads/media/{media_id}/original.{pdf|epub}` | private upload lifecycle only |
| Media source artifacts | `media_source_attempts.source_payload` | `media/{media_id}/source/{attempt_id}.{html|tar}` | private source lifecycle only |
| Extracted EPUB resources | `epub_resources` | `media/{media_id}/assets/{asset_key}` | viewer-authenticated EPUB asset route |
| Oracle plates | `oracle_plates` | `oracle/plates/{slug}.{jpg|png|webp}` | public owned-asset route, internal-header protected |

All storage path construction goes through `python/nexus/storage/paths.py`.
Extension-taking builders accept only bare extensions: no leading dot, dot,
slash, backslash, or empty value. Storage keys are owner IDs or stable source
keys, not content hashes. Object reads enforce DB-owned byte-size metadata at
read time.

Oracle plates remain a public owned-asset lane (`oracle/plates/...`) holding plate
image metadata only — no embeddings. The Oracle public-domain corpus is ordinary
media: its source files (EPUB/PDF/web-article) use the normal `media_file` /
`epub_resources` lanes above, never plate storage.

## Public vs Private Assets

Private media assets require a viewer authorization check before metadata is
resolved. They must not be added to Next Image `images.localPatterns`.

Public owned Oracle plates are different: the browser requests
`/api/oracle/plates/[id]`, the BFF strips browser credentials, and FastAPI serves
`/oracle/plates/{id}` only after internal-header verification. The route uses DB
metadata for ETags and storage metadata validation, then reads the object through
the storage client only for `200` responses.

## Media Teardown & Lifecycle

Full contract: `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §3.1.

Removing the last lifetime reference to a document media (`WebArticle`, `Epub`,
`Pdf`) never deletes storage or child state inline. `media_deletion.py`'s
`claim_media_teardown` locks only the media row, checks zero committed
references, inserts a `media_teardown_intents` row (application-generated
UUIDv7 via `nexus.ids.new_uuid7`, not a database default — Python 3.12 has no
standard UUIDv7 generator), and enqueues one addressable `media_teardown` job
in that same transaction. Intent presence excludes the media from every public
visibility query and makes new references fail with `E_MEDIA_DELETING` (409).
The two actual reference owners (`library_entries.py`,
`default_library_closure.py`) — and the nine ingest callers that create
references — enforce the barrier via `SELECT ... FOR UPDATE` on the media row
before insert.

Three durable task modules own all teardown/lifecycle storage deletion
(`python/nexus/tasks/`):

- **`media_teardown.py`** — the claimed job. Reloads the current job row and
  transitions its checkpoint: `Unprepared` -> `PathsPrepared` (lease-fenced,
  reuses the existing path enumerator) -> `DeletionCommitted` (zero
  references: deletes child state through owners — the consumption owner's
  `delete_media_consumption_state_in_txn` and `attention.delete_media_state` —
  then intent/media, all in one `retry_serializable` transaction) or `Voided`
  (a reference reappeared: deletes only the intent). Absent intent + present
  media records `NoOp`; a stale (non-matching) intent records `Stale`. Every
  intent lookup/delete matches both `intentId` and `mediaId`, so an old job
  never acts on a later intent. `DeletionCommitted` reschedules itself until
  `cleanupNotBefore`, then deletes its persisted paths; deletion is
  idempotent and failure retries.
- **`storage_object_cleanup.py`** — the browser-direct-upload backstop. Every
  in-process object write (`media_source_ingest.py`, `email_ingest_service.py`,
  `epub_ingest.py`) and the staging-to-final copy in `upload.py` first locks
  media, rejects an intent, and reserves at most one nonterminal
  `StorageObjectCleanupJob` per `(mediaId, storagePath)` before the bounded
  external call: `Armed` -> `Retained` (a short post-write transaction rechecks
  media + no-intent + committed path ownership) or, at the `writeMayLandUntil`
  deadline, `DeleteRequired` -> `Deleted` (an exclusive queue-owned hold on the
  path; installed only when no other nonterminal writer targets it). Only
  `Retained`/`Deleted` is prunable. Browser direct upload is the exception
  because the server cannot perform the post-write check: signing locks the
  media row, rejects an intent, and persists the staging path plus
  `media_source_attempts.signed_upload_expires_at` (TTL capped at 300 seconds)
  before returning the signed URL.
- **`storage_orphan_sweep.py`** — the singleton recurring backstop for writes
  that complete after a signed-URL expiry or an earlier delete. Durably pages
  the `media/` prefix, ignores objects modified within
  `storage_orphan_sweep_min_age_seconds` (default 24h — a write completing
  after one pass gets a fresh modified time and is caught by a later pass),
  and deletes only paths with no live DB owner and no Armed cleanup writer.
  Runs on the job registry's `periodic_interval_seconds` mechanism (default
  `storage_orphan_sweep_interval_seconds` = 21600s / six hours) rather than the
  spec's self-chained successor — the registry's per-slot `enqueue_unique_job`
  dedupe already guarantees an at-most-one run per slot, and
  `never_prune_dead=True` keeps a failed run operator-discoverable via
  `requeue_dead_job` without inventing chain-restart bookkeeping.

On dead-letter, a live media row causes only the exact matching intent to be
voided; `DeletionCommitted` media jobs and failed path-cleanup jobs are never
pruned, so paths stay operator-discoverable via `requeue_dead_job`. Domain code
never writes `background_jobs` raw — every checkpoint write goes through the
queue owner's exact-attempt/claimant/lease-fenced CAS methods.

The existing one-day R2 lifecycle rule on the `uploads/` direct-upload staging
prefix (`deploy/cloudflare/r2-lifecycle.example.json`, applied by
`deploy/cloudflare/apply-r2-lifecycle.sh`) is the first durable backstop; its
prefix and max-age are asserted against `nexus.storage.paths` by
`python/tests/test_r2_lifecycle_drift.py` so the deployed rule cannot silently
drift from the code that writes the staging prefix.

## Deployment

Object-storage preconditions that migrations depend on are established by deploy
or operator code, not app startup. Backend deploy migrates schema first, then runs
`python /app/scripts/ensure_oracle_seed_objects.py` and the Oracle corpus
seed/readiness commands as worker-image one-offs so runtime surfaces only see
storage-backed Oracle assets.

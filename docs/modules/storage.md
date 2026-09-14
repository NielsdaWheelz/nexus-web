# Storage

Storage objects are owned by capability-specific DB rows. A storage key by itself
does not authorize access and must not encode user identity.

## Owners

| Object family | DB owner | Key shape | Access lane |
| --- | --- | --- | --- |
| Original PDF/EPUB sources | `media_file` | `media/{media_id}/original.{pdf,epub}` or `media/{media_id}/candidates/{verification_token}/original.{pdf,epub}` | viewer-authenticated media/file services |
| Direct-upload staging | `media_upload_sessions` | `uploads/sessions/{session_id}/{generation}/original.{pdf,epub}` | private upload lifecycle only |
| Media source artifacts | `media_source_attempts.source_payload` | `media/{media_id}/source/{attempt_id}.{html,tar}` | private source lifecycle only |
| Extracted EPUB resources | `epub_resources` | `media/{media_id}/assets/{asset_key}` | viewer-authenticated EPUB asset route |
| Oracle plates | `oracle_plates` | `oracle/plates/{slug}.{jpg,png,webp}` | public owned-asset route, internal-header protected |

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

Canonical member removal never deletes the final lifetime reference: it returns
`409 E_MEDIA_LAST_REFERENCE`. Whole-resource deletion of document media
(`WebArticle`, `Epub`, `Pdf`) uses `media_deletion.claim_media_teardown`, which
locks the media row, checks zero committed references, inserts a
`media_teardown_intents` row (application-generated UUIDv7 via
`nexus.ids.new_uuid7`, not a database default — Python 3.12 has no standard
UUIDv7 generator), and enqueues one addressable `media_teardown` job in that
same transaction. Intent presence excludes the media from every public
visibility query and makes new references fail with `E_MEDIA_DELETING` (409).
The administrative whole-library teardown is the narrow exception: while its
complete media lock set is held, it deletes a newly zero-reference document and
child state transactionally, then deletes storage objects after commit. The one
actual reference owner (`library_entries.py`) enforces the media-before-library
barrier for reference writes. Whether any reference remains is a count of
physical `library_entries` rows for that media, and nothing else.

Three durable task modules own all teardown/lifecycle storage deletion
(`python/nexus/tasks/`):

- **`media_teardown.py`** — the claimed job. Reloads the current job row and
  transitions its checkpoint: `Unprepared` -> `PathsPrepared` (lease-fenced,
  reuses the existing path enumerator) -> `DeletionCommitted` (zero
  references: deletes child state through owners — the one consumption call
  `delete_media_consumption_state_in_txn` — then intent/media, all in one
  `retry_serializable` transaction) or `Voided`
  (a reference reappeared: deletes only the intent). Absent intent + present
  media records `NoOp`; a stale (non-matching) intent records `Stale`. Every
  intent lookup/delete matches both `intentId` and `mediaId`, so an old job
  never acts on a later intent. `DeletionCommitted` reschedules itself until
  `cleanupNotBefore`, then deletes its persisted paths; deletion is
  idempotent and failure retries.
- **`storage_object_cleanup.py`** — the browser-direct-upload backstop. Every
  in-process object write (`media_source_ingest.py`, `email_ingest_service.py`,
  `epub_ingest.py`, `reader_publication_artifacts.py`) and each
  verification-token-fenced candidate copy in
  `media_upload_sessions.py` first locks its owner and reserves at most one
  nonterminal `StorageObjectCleanupJob` per `(owner, storagePath)` before the bounded
  external call: `Armed` -> `Retained` (a short post-write transaction rechecks
  media + no-intent + committed path ownership) or, after both `retainUntil`
  and `writeMayLandUntil`, `DeleteRequired` -> `Deleted` (an exclusive queue-owned
  hold on the path; installed only when no other nonterminal writer targets it). Only
  `Retained`/`Deleted` is prunable. Browser-direct writes are owned by a durable
  `media_upload_sessions` row and generation-scoped staging path. Capability
  expiry changes the session projection to `CapabilityExpired`; it never
  deletes accepted intent. Confirmation verifies size, signature, and SHA-256,
  copies to an immutable verification-token candidate, then persists that winning
  path with the media, source attempt, final object owner, and exact queue job
  atomically. Retry mints a new generation; explicit removal reserves cleanup. A
  reservation may carry an exact `retainUntil` of its own (reader-publication
  members set wall-timeout plus grace, which is wider than the write window), so
  the delete fence is `max(writeMayLandUntil, retainUntil)`; `media_teardown`
  takes that max over both keys of every armed writer rather than the write
  window alone. A candidate's reservation is keyed to the lease token and its `retainUntil` trails
  every lease renewal by the write window, so the sweep cannot reclaim bytes a live
  verifier still owns. The reservation CAS reports one owner-agnostic
  in-flight-cleanup condition rather than constructing a domain error: `Media` maps
  it to `E_MEDIA_DELETING`, while removal reads an already-claimed sweep of a staged
  generation as the durable cleanup intent it needs and still returns `204`.
  Browser PUTs abort at the earlier of the capability's `expires_at` or the fixed
  240-second client horizon and report `Timeout`; server configuration requires
  the cleanup write margin to be strictly longer than that horizon.
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

The one-day R2 lifecycle rule on the `uploads/` direct-upload staging prefix is
an independent durable backstop for late browser writes. The repository-owned
rule is `deploy/cloudflare/r2-lifecycle.example.json`; operators apply that exact
file with `deploy/cloudflare/apply-r2-lifecycle.sh`.

## Deployment

Object-storage preconditions that migrations depend on are established by deploy
or operator code, not app startup. Application release records the expected
Oracle manifest digest but does not read or mutate Oracle. The independent
Oracle reconciler writes plate objects before their DB metadata, proves the
exact DB/selector/R2 set, and publishes the current marker last. Runtime surfaces
accept only that published identity.

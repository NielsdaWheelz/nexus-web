# Storage

Storage objects are owned by capability-specific DB rows. A storage key by itself
does not authorize access and must not encode user identity.

## Owners

| Object family | DB owner | Key shape | Access lane |
| --- | --- | --- | --- |
| Original PDF/EPUB sources | `media_file` | `media/{media_id}/original.{pdf,epub}`, `media/{media_id}/candidates/{token}/original.{pdf,epub}` or, fetched from a url, `media/{media_id}/source/{attempt_id}.original-{pdf,epub}` | viewer-authenticated media/file services |
| Browser article packets | `media_source_attempts.source_payload.storage_path` | `media/{media_id}/candidates/{token}/original.json` or `media/{media_id}/source/{attempt_id}.json` | private source lifecycle only; never a `media_file` row |
| Upload staging | `media_upload_sessions` | `uploads/sessions/{session_id}/{generation}/original.{pdf,epub,json}` | private upload lifecycle only |
| Post Room email bodies | `media_source_attempts.source_payload.storage_path` | `media/{media_id}/source/{attempt_id}.html` | private source lifecycle only |
| Extracted EPUB resources | `epub_resources` | `media/{media_id}/assets/{asset_key}` | viewer-authenticated EPUB asset route |

All storage path construction goes through `python/nexus/storage/paths.py`.
Extension-taking builders accept only bare extensions: no leading dot, dot,
slash, backslash, or empty value. Storage keys are owner IDs or stable source
keys, not content hashes. Object reads enforce DB-owned byte-size metadata at
read time.

The Oracle public-domain corpus is ordinary media: its source files
(EPUB/PDF/web-article) use the normal `media_file` / `epub_resources` lanes above.
Oracle plates are not stored objects; they are static web assets
(`apps/web/public/oracle-plates/<key>.jpg`).

## Public vs Private Assets

Private media assets require a viewer authorization check before metadata is
resolved. They must not be added to Next Image `images.localPatterns`.

Static web assets (the Oracle plates under `/oracle-plates/**`) are the only
Next Image local pattern; they are public files, not storage objects.

## Media Teardown & Lifecycle

Full contract: `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §3.1 at `ebd648197`.

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

Two durable task modules own all teardown and orphan storage deletion
(`python/nexus/tasks/`); nothing reserves a path before a write:

- **`media_teardown.py`** — the claimed job. Reloads the current job row and
  transitions its checkpoint: `Unprepared` -> `PathsPrepared` (lease-fenced,
  the media's enumerated paths and `cleanupNotBefore` = now + the clock-skew
  grace) -> `DeletionCommitted` (zero references: deletes child state through
  owners — the one consumption call `delete_media_consumption_state_in_txn` —
  then intent/media, all in one `retry_serializable` transaction) or `Voided`
  (a reference reappeared: deletes only the intent). Absent intent + present
  media records `NoOp`; a stale (non-matching) intent records `Stale`. Every
  intent lookup/delete matches both `intentId` and `mediaId`, so an old job
  never acts on a later intent. `DeletionCommitted` reschedules itself until
  `cleanupNotBefore`, then deletes its persisted paths; deletion is
  idempotent and failure retries. A write that lands after the deletion leaves
  an unowned object for the sweep.
- **`storage_orphan_sweep.py`** — the one reclaimer of objects no row names.
  Writers store bytes first and then commit the row that names them, so a failed
  commit, a late browser PUT's candidate, a superseded remote file, a reused
  capture's candidate or a write after a teardown is unowned. The sweep durably
  pages the `media/` prefix, ignores objects modified within
  `storage_orphan_sweep_min_age_seconds` (default 24h), and deletes every path
  that `media_file`, `epub_resources` and the attempts' stored artifacts
  (`source_types.stored_artifact_path`) do not name. Orphans therefore live up
  to ~30 h. Runs on the job registry's `periodic_interval_seconds` mechanism
  (default `storage_orphan_sweep_interval_seconds` = 21600s / six hours) rather
  than a self-chained successor — the registry's per-slot `enqueue_unique_job`
  dedupe already guarantees an at-most-one run per slot, and
  `never_prune_dead=True` keeps a failed run operator-discoverable via
  `requeue_dead_job`.

On dead-letter, a live media row causes only the exact matching intent to be
voided; `DeletionCommitted` media jobs are never pruned, so paths stay
operator-discoverable via `requeue_dead_job`. Domain code
never writes `background_jobs` raw — every checkpoint write goes through the
queue owner's exact-attempt/claimant/lease-fenced CAS methods.

The one-day R2 lifecycle rule on the `uploads/` direct-upload staging prefix is
the only reclaimer of staged bytes: confirmation copies them to a candidate under
`media/`, and nothing deletes a generation's staging object. The repository-owned
rule is `deploy/cloudflare/r2-lifecycle.example.json`; operators apply that exact
file with `deploy/cloudflare/apply-r2-lifecycle.sh`.

## Deployment

Object-storage preconditions that migrations depend on are established by deploy
or operator code, not app startup.

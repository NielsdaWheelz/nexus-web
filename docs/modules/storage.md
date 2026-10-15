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
`409 E_MEDIA_LAST_REFERENCE`. Removing a media (`DELETE /media/{id}`: 204, idempotent;
`media_deletion.remove_media_for_viewer`) drops it from the viewer's whole workspace at
once. A document (`web_article`, `epub`, `pdf`) left with no reference (no library entry,
no grant) gets a `media_teardown_intents` row (one per media; UUIDv7 from
`nexus.ids.new_uuid7`) and one `media_teardown` job `{media_id, intent_id}` in the same
transaction, under the media row lock; so do a duplicate document
(`delete_duplicate_document_media`) and a document whose last grant or highlight goes
(`claim_document_teardown_if_unreferenced_locked`). The intent excludes the media from
every visibility query and makes new references fail with `E_MEDIA_DELETING` (409).

The job (`media_deletion.run_teardown_job`) is one step and acts only on its exact
(intent, media). In one `retry_serializable` transaction under the media lock: no intent
or another one is `Stale`; a reference that reappeared voids the intent and keeps the
media (`Voided`); otherwise every row of the media goes in the load-bearing order (owner
hooks before the rows they own, the content index before the media, highlight children
before their roots), and the objects those rows named (`media_file`, `epub_resources`,
the attempts' stored artifacts) are enumerated inside that transaction (`Deleted`).
After commit it deletes those objects best-effort; an object it fails to delete, or one
written after the deletion, is unowned and the orphan sweep reclaims it. There is no
grace and no checkpoint. A dead job voids its exact intent while the media lives
(`jobs/dead_letters.media_teardown`), so the media is readable again.

**`tasks/storage_orphan_sweep.py`** is the one reclaimer of objects no row names; nothing
reserves a path before a write. Writers store bytes first and then commit the row that
names them, so a failed commit, a late browser PUT's candidate, a superseded remote file,
a reused capture's candidate, a write after a teardown or an object a teardown failed to
delete is unowned. The sweep durably pages the `media/` prefix, ignores objects modified
within `storage_orphan_sweep_min_age_seconds` (default 24h), and deletes every path that
`media_file`, `epub_resources` and the attempts' stored artifacts
(`source_types.stored_artifact_path`) do not name. Orphans therefore live up to ~30 h.
Runs on the job registry's `periodic_interval_seconds` mechanism (default
`storage_orphan_sweep_interval_seconds` = 21600s / six hours) rather than a self-chained
successor — the registry's per-slot `enqueue_unique_job` dedupe already guarantees an
at-most-one run per slot, and `never_prune_dead=True` keeps a failed run
operator-discoverable via `requeue_dead_job`.

The one-day R2 lifecycle rule on the `uploads/` direct-upload staging prefix is
the only reclaimer of staged bytes: confirmation copies them to a candidate under
`media/`, and nothing deletes a generation's staging object. The repository-owned
rule is `deploy/cloudflare/r2-lifecycle.example.json`; operators apply that exact
file with `deploy/cloudflare/apply-r2-lifecycle.sh`.

## Deployment

Object-storage preconditions that migrations depend on are established by deploy
or operator code, not app startup.

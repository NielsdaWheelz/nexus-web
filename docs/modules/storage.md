# Storage

## Purpose

Private bytes (sources, epub assets, reading copies, staged uploads) live in one R2
bucket. A key authorizes nothing: a viewer reaches bytes only after the owning row's
check, then through a short-lived signed url or a server stream.

## Contract

`python/nexus/storage/client.py`, `get_storage_client()` (the process singleton,
closed at exit; unconfigured R2 raises `StorageError`):

| call | answer |
| --- | --- |
| `sign_upload(path, *, content_type, size_bytes, expires_in)` | a PUT url that admits exactly that type and length |
| `sign_download(path, *, expires_in)` | a GET url |
| `head_object(path)` | `ObjectMetadata{content_type, size_bytes}`, or `None` when missing |
| `stream_object(path, *, expected_size=None, byte_range=None)` | lazy chunks of at most 8 MiB; `byte_range` is inclusive |
| `read_object(path, *, expected_size=None)` | the whole object |
| `put_object(path, body, content_type)` | bytes, or a file at byte 0 |
| `copy_object(source, destination)`, `delete_object(path)` | |
| `list_objects(prefix, *, continuation_token=None)` | one page: `([(key, last_modified)], next_token)` |

Failures raise `StorageError(message, code)`, which is not an `ApiError`: each caller
maps it. `code` is `E_STORAGE_MISSING` for a missing object on read or copy (head
answers `None`), else `E_STORAGE_ERROR`. Botocore retries a transient failure (a 5xx,
throttling, a request timeout, a dropped connection) itself, three attempts in all,
inside the lock, and resends a file body from byte 0; any other failure (a 403, say)
is not retried.

key shapes (`storage/paths.py` builds media/upload keys;
`tasks/archive_x_capture_assets.py` owns capture-image keys):

| key | owner row |
| --- | --- |
| `media/{media_id}/source/{attempt_id}.{html,original-pdf,original-epub}` | the attempt's `source_payload.storage_path` (a Post Room body), or `media_file` (a file fetched from a url) |
| `media/{media_id}/candidates/{candidate_id}/original.{pdf,epub,json}` | `media_file`, or for an article packet the attempt's `source_payload.storage_path` |
| `media/{media_id}/source/{attempt_id}/assets/{asset_key}` | `epub_resources` |
| `media/x-captures/{capture_id}/{object_uuid}` | `x_post_capture_assets`; immutable archived x image bytes |
| `media/{media_id}/reading-copies/{copy_id}.zip` | none: built per request, handed back signed |
| `uploads/sessions/{session_id}/{generation}/original.{pdf,epub,json}` | `media_upload_sessions` (staging) |

## Invariants

- Keys are built from owner ids and our own extensions, never a content hash or a user
  identity; an epub asset key comes from the archive and is refused with a leading
  `/` or an empty, `.` or `..` part.
- Bytes come first, then the row that names them; nothing reserves a path. The
  periodic `storage_orphan_sweep` (every six hours) deletes a `media/` object only when
  it is older than `STORAGE_ORPHAN_SWEEP_MIN_AGE_SECONDS` (24 h) and no `media_file`,
  `epub_resources`, `x_post_capture_assets` row or attempt payload names it. The min age must outlast the
  longest store-then-commit window (the 900 s background wall) and a reading copy's
  signed url (`SIGNED_URL_EXPIRY_S`). Config refuses only values below 30 s
  (mistakes); a deployed environment must keep it above both.
- `uploads/` is reclaimed only by the R2 one-day lifecycle rule
  (`deploy/cloudflare/r2-lifecycle.example.json`, applied with
  `deploy/cloudflare/apply-r2-lifecycle.sh`); confirmation copies staged bytes to a
  candidate under `media/`.
- Every SDK call that can open or use a connection, and every body read, holds one
  process lock, never held while yielding to a caller: botocore reloads CA
  certificates into the shared TLS context when it opens a connection (#576).
  Presigning sends nothing and runs outside the lock.
- A read given `expected_size` proves the stored size before its first byte (a
  mismatch raises then, not mid-body); a body that ends short raises.
- Oracle plates are static web assets (`apps/web/public/oracle-plates/`), not stored
  objects, and the only Next Image local pattern; private media never is one.

## Media teardown

[libraries](library.md) owns personal retention: unfiling preserves the actor's
default holding; named-library deletion preserves its owner's eligible media.
organizational removal cannot remove that personal holding. removing a media (`DELETE /media/{id}`: 204, idempotent;
`media_deletion.remove_media_for_viewer`) drops it from the viewer's whole workspace at
once. A document (`web_article`, `epub`, `pdf`) left with no reference (no library entry,
no grant) gets a `media_teardown_intents` row (one per media; UUIDv7 from
`nexus.ids.new_uuid7`) and one `media_teardown` job `{media_id, intent_id}` in the same
transaction, under the media row lock; so do a duplicate document
(`delete_duplicate_document_media`) and a document whose last media-backed grant
reference disappears (`claim_document_teardown_if_unreferenced_locked`). capture
annotations retain their capture source rather than a containing media. the
intent excludes the media from
every visibility query and makes new references fail with `E_MEDIA_DELETING` (409).

The job (`media_deletion.run_teardown_job`) is one step and acts only on its exact
(intent, media). each `retry_serializable` attempt first locks affected lectern
viewers in uuid order, then the media. lectern-owned cleanup removes queue rows,
densifies survivors and advances each affected viewer's order revision. an
unseen read-committed append can produce `fk_consumption_queue_items_media`
(`23503`) at hard deletion; teardown alone maps that constraint to the existing
whole-transaction restart. serializable conflicts use the same bounded retry.
the next attempt reloads the viewer set before taking the media lock. no intent
or another one is `Stale`; a reference that reappeared voids the intent and keeps the
media (`Voided`); otherwise the media's dependent rows go in the load-bearing order (owner
hooks before the rows they own, the content index before the media), and the
objects those rows named (`media_file`, `epub_resources`,
the attempts' stored artifacts) are enumerated inside that transaction (`Deleted`).
After commit it deletes those objects best-effort; an object it fails to delete, or one
written after the deletion, is unowned and the orphan sweep reclaims it. There is no
grace and no checkpoint. a dead job clears its exact intent while the media lives
(`jobs/dead_letters.media_teardown`). this removes the teardown fence; it restores
no references, withdrawn x binding or reader authority.

committed x captures, fragments, direct contexts, admissions and archived image rows
outlive every media presentation. final unreferenced removal withdraws the optional
post binding in the teardown-intent commit. a fresh guarded capture save can create
a new presentation immediately; the old collector remains bound to its old media.
physical teardown removes thread memberships and article slots, never retained
source records or their object paths. the orphan sweep treats every
`x_post_capture_assets.storage_path` as owned;
only unpublished uploads can age into orphans. capture authorization is checked
before streaming archived bytes; image reads never fetch upstream.

synchronous capture acceptance is the only source-attempt teardown exception:
retain an actor-owned succeeded `x_post` attempt with no job, a finish time and an
exact `{capture_id:<uuid>}` payload naming a retained capture. its `media_id` is the
original accepted target, not a surviving media row. retries return that settled
acceptance and cannot restore a presentation or filing. ordinary attempts and
processing history are deleted; no media tombstone or separate replay ledger is
kept. the source-attempt writer locks a live media row before any new attempt.

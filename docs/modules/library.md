# Libraries

Libraries organize access to content; they do not own media ingestion or asset
delivery.

The domain is split into three owned modules, each owning its own tables:

- **`services/library_governance.py`** owns the `libraries` and `memberships`
  tables: library CRUD, membership/role management, ownership transfer, the
  membership guards (`lock_library_for_member` returns a frozen
  `LibraryMembershipContext`; `require_admin` / `require_non_default`), the
  writable-destination contract ingest paths call
  (`list_writable_library_destinations`,
  `validate_writable_library_destinations`,
  `resolve_writable_non_default_library_ids`,
  `default_library_id_for_user`), and library-intelligence cascade cleanup.
- **`services/library_entries.py`** is the **sole writer and lifecycle owner of
  the `library_entries` table**. It owns the `EntryTarget` discriminated union
  (`{kind: "media"|"podcast", id}` — a faithful model of the
  exactly-one-target check) and the `media_target`/`podcast_target` constructors,
  the single entry ordering constant (`_ENTRY_ORDER = "position ASC, created_at
  DESC, id DESC"`), the locked `ensure_entry` append, deletes and
  `normalize_positions`, all read accessors, hydration, and the item-in-library
  commands (`list_item_libraries`, `add_media_to_library`,
  `add_podcast_to_library`, `remove_podcast_from_library`, `reorder_entries`,
  `add_media_to_libraries_for_viewer`, `assign_libraries_for_media`,
  `set_subscription_libraries`, `remove_user_podcast_subscription_libraries`, …).
- **`services/library_invitations.py`** owns the `library_invitations` table:
  create/list/list-for-viewer/accept/decline/revoke. The accept path's durable
  backfill upsert is delegated to
  `default_library_closure.upsert_backfill_job_pending`.

Media capabilities call these services to attach or validate visibility, then
return to their own owners for ingestion, playback, files, or assets.

## The `library_entries` sole-writer rule

Every INSERT/UPDATE/DELETE on `library_entries` goes through
`library_entries.py`; no other module issues DML against the table.

- **Append serialization.** `ensure_entry` locks the target `libraries` row
  (`FOR UPDATE`) as the single per-library append point, so two concurrent
  appends can't both read the same `MAX(position)+1` and collide. It is the only
  inserter.
- **Position invariant.** Migration `0131` makes the per-library position a DB
  invariant: `UNIQUE (library_id, position) DEFERRABLE INITIALLY DEFERRED`. The
  set-based `reorder_entries` (one `unnest(...) WITH ORDINALITY` UPDATE) and the
  renormalizer rely on deferral to swap positions within a transaction.
- **Explicit cleanup.** `0131` also drops the `media_id`/`podcast_id`
  `ON DELETE CASCADE` FKs — entry cleanup on media/podcast deletion is now
  explicit in app code, not the database.
- **One read tier (Tier-R).** Writes have one owner; visibility/search readers
  read the table under an explicit allowlist: `auth/permissions.py`,
  `services/search.py`, `services/contributors.py`,
  `services/agent_tools/app_search.py`, `services/object_refs.py`,
  `services/note_indexing.py`, and `services/library_intelligence.py`.
  Visibility itself remains the boolean predicates in `auth/permissions.py`;
  `services/highlights.py` reuses `permissions.highlight_library_intersection_exists`
  rather than re-implementing the intersection.

## Default-library closure & media deletion

- **`services/default_library_closure.py`** routes all of its `library_entries`
  writes through `library_entries` (`ensure_entry` / `delete_entry` /
  `list_media_ids_in_library`) and owns the durable backfill-job and provenance
  helpers (`upsert_backfill_job_pending`, `mark_backfill_job_terminally_failed`,
  `detach_media_from_default_library`, `remove_media_from_default_intrinsic`,
  `purge_media_default_references`, `count_default_references`).
- **`services/media_deletion.py`** is now a pure orchestrator over the public
  `library_entries` + `default_library_closure` APIs; it issues zero direct
  `library_entries` / `default_library_intrinsics` /
  `default_library_closure_edges` SQL.

## Writable library destinations

`library_ids` in ingest and assignment request bodies means selected
non-default libraries where the viewer can write entries. It does not mean every
library the viewer can read.

- **Search/list.** `GET /libraries/writable-destinations` is the sole backend
  list contract for destination pickers. It excludes the default library and
  member-only libraries, performs server-side search, and pages with an opaque
  cursor.
- **Validation.** Write paths call
  `validate_writable_library_destinations` or
  `resolve_writable_non_default_library_ids`; default IDs, duplicate IDs,
  inaccessible IDs, and member-only IDs are invalid for destination arrays.
- **Assignment.** `library_entries.assign_libraries_for_media` is the standalone
  transaction-owning command for attaching media to the viewer's default library
  plus selected destinations. Media creation workflows that already own a
  transaction call `assign_libraries_for_media_in_current_transaction` before
  committing the created media. `add_media_to_libraries_for_viewer` adds
  post-hoc destinations atomically and returns only IDs that were actually
  inserted.

## Composition Rules

- URL ingest validates requested writable destination IDs at the durable
  acceptance boundary. `media_source_ingest.py` owns source-attempt creation and
  assigns default plus selected destinations through `library_entries` inside
  the media creation transaction.
- Source-specific materializers such as X, remote file, YouTube, and web-article
  adapters do not own durable acceptance, retry, dispatch, or destination
  policy. They may attach deduped canonical media only by calling
  `library_entries` from the shared source-ingest transaction.
- Library entries never make a private media file public.
- Public owned Oracle plates are not library resources; readings may reference
  them, but the plate asset route is owned by `oracle_plates.py`.
- Default-library closure affects visible media rows, not object-storage keys.

## Library Intelligence Citations

A Library Intelligence revision's citations are `resource_edges`, not a
per-feature citation table. The REDUCE worker
(`services/library_intelligence_reduce.py`) adopts them with
`source=library_intelligence_revision:<id>` before moving the artifact head's
`current_revision_id` to that revision. Promotion never rewrites historical
revision citations; the artifact read-model reads citations from its current
revision, identically to chat and Oracle.

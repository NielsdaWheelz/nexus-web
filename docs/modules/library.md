# Libraries

Libraries organize access to content; they do not own media ingestion or asset
delivery.

The domain is split into three owned modules, each owning its own tables:

- **`services/library_governance.py`** owns the `libraries` and `memberships`
  tables: library CRUD, membership/role management, ownership transfer, the
  membership guards (`lock_library_for_member` returns a frozen
  `LibraryMembershipContext`; `require_admin` / `require_non_default`), the
  libraries/memberships access checks ingest paths call
  (`validate_libraries_accessible`, `resolve_accessible_non_default_library_ids`,
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
  `services/object_search.py`, and `services/library_intelligence.py`. Visibility
  itself remains the boolean predicates in `auth/permissions.py`;
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

## Composition Rules

- URL ingest validates requested library IDs once at the dispatch boundary.
- Source owners (`x_ingest.py`, `youtube_ingest.py`, `remote_file_ingest.py`,
  web-article creation) attach resulting media through library services.
- Library entries never make a private media file public.
- Public owned Oracle plates are not library resources; readings may reference
  them, but the plate asset route is owned by `oracle_plates.py`.
- Default-library closure affects visible media rows, not object-storage keys.

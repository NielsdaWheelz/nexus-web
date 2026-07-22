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
  create/list/list-for-viewer/accept/decline/revoke. Accept is one transaction
  — membership upsert, then invite status update — and returns
  `{invite, membership, idempotent}`. The membership commit alone is what
  changes the accepting user's default-library list/count on the very next
  read; there is no backfill job, projection worker, or provenance row to
  catch up afterward (see [sharing.md](sharing.md)).

Media capabilities call these services to attach or validate visibility, then
return to their own owners for ingestion, playback, files, or assets.

Library entry mutations are commands, not refreshed read models. Successful
add-media, add-podcast, and reorder requests return `204 No Content`; callers
refresh or retain their existing local state deliberately. Agent filing receives
only inserted/already-present truth for Undo and never hydrates an entry payload.

## System libraries

`libraries.system_key` (nullable, unique where present) is the policy handle for
system-maintained libraries — there are **no name-based checks**. The Oracle
Corpus is one such library (`system_key = 'oracle_corpus'`). A system library
behaves like any library for reads (it appears in `GET /libraries`, opens, and is
searchable with `scope=library:<id>`) but is **protected from user mutation**:
rename, delete, share, and entry edits are blocked. `ensure_system_library` is the
idempotent (by `system_key`) creator, and the seed is an explicit system-maintenance
command, never a user request — system libraries still never bypass
`library_entries`.

`LibraryOut` carries the policy to the client so UI never infers protection from
the name: `system_key`, plus the booleans `can_rename` / `can_delete` /
`can_edit_entries`. `library_governance._library_capabilities` is the one place
they are computed — a library is mutable only when `system_key IS NULL`, it is not
the default library, and the viewer is an admin.

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

## The default library's virtual read surface

The default library holds no provenance, closure, or backfill machinery. Its
read surface — "personal All" — is a live query, computed on every read, over
`library_entries` + `memberships`: the distinct media reachable through any of
the viewer's *current* non-system memberships, deduplicated by `media_id` (a
direct entry in the viewer's own default library wins the tie over an
indirect one reached through a shared library; ties within a kind resolve by
earliest entry). There is no separate table recording *why* a work is
visible there and nothing to keep in sync — losing a membership (leaving,
being removed, or a shared library being deleted) removes that library's
contribution the moment it is gone, on the very next read.

- **The one actor-authorized filing command.**
  `library_entries.add_media_to_library` is the sole path that files media
  into any library, including the default one. Filing into the default
  library always inserts (or idempotently keeps) a direct, physical
  `library_entries` row there — there is no separate "intrinsic" bookkeeping
  distinct from the row itself. A work already visible virtually through
  another membership can still be explicitly filed; that direct row is what
  survives a later membership loss that would otherwise have removed it from
  view.
- **Stateless keyset pagination, three cursor kinds.** Listing any library
  never touches a snapshot table. The default library's own listing paginates
  the deduplicated virtual set by media recency; a non-default library
  paginates its physical entries either by position or by resonance order.
  Each cursor is opaque, self-describing (`k`), and scoped to the exact
  `(viewer_id, library_id, kind)` it was minted for — a cursor from the wrong
  viewer, library, or kind (including any cursor minted before this cutover)
  is a clean `400 E_INVALID_CURSOR`, never silently reinterpreted.
- **Media deletion counts physical references only.** Whether a document
  media has any reference left — the question that gates last-reference
  teardown — is answered by counting physical `library_entries` rows for
  that `media_id` and nothing else; there is no closure/intrinsic count to
  reconcile against it. `services/media_deletion.py` is a pure orchestrator
  over the public `library_entries` API; it issues zero direct
  `library_entries` DML of its own.

## Reading-time projection

Reading time is owned by the Library list read model, not `MediaOut` and not an
ingestion writer. Migration `0186` stores same-row word-count derivatives beside
canonical fragment text and PDF plain text. `services/media_document_metrics.py`
is the sole media-level aggregate owner: it sums stored integers for a bounded
batch and never reads document text on a request. Shared PDF quote readiness
likewise uses the stored positive word count instead of scanning `plain_text`.

`services/library_entries.py` applies the one product policy (240 words/minute,
coarse half-up 1/5/15-minute rounding) while hydrating entries. Only ready,
quotable web articles, EPUBs, and text PDFs with a positive count receive a
value. Every `LibraryEntryOut` has a required
`readingTimeEstimate: Presence<ReadingTimeEstimateOut>`: total is always present
inside a present estimate; remaining is present only for in-progress web/EPUB
media with the consumption projection's monotonic whole-document progression.
PDF is total-only. Nested `media` is the sole entry consumption owner; root entry
read-state/progress fields do not exist.

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
- The default library's virtual read surface affects which media rows are
  visible, not object-storage keys.

## Library Intelligence Citations

A Library Intelligence revision's citations are `resource_edges`, not a
per-feature citation table. The REDUCE worker
(`services/library_intelligence_reduce.py`) adopts them with
`source=library_intelligence_revision:<id>` before moving the artifact head's
`current_revision_id` to that revision. Promotion never rewrites historical
revision citations; the artifact read-model reads citations from its current
revision, identically to chat and Oracle.

# Library Entries Ownership Hard Cutover

## Status

**IMPLEMENTED 2026-06-03** (Rev 3 plan, all 9 slices landed). `libraries.py` deleted;
`library_governance.py` / `library_entries.py` / `library_invitations.py` created;
closure/media_deletion/backfill-worker/highlights repointed; all ~20 callers updated;
migration `0131` applied (DEFERRABLE `UNIQUE (library_id, position)` + non-cascading
`media_id`/`podcast_id`/`library_id` FKs, verified via `pg_constraint`). Gates green:
all four negative gates → 0; `make type-back` (pyright) 0 errors; `make test-migrations`
121 passed (incl. the new FK-cascade + position-uniqueness assertions); `make check-back`
clean for every cutover file. Behavior preserved: the library-domain integration suite
(libraries/closure/backfill/media-deletion/target-picker/media-libraries/highlights)
passes, plus two new final-state tests (deferred position-uniqueness rejection at COMMIT;
concurrent-append distinct positions for Key Decision 8). One test-harness consequence of
the cascade removal was fixed centrally in `tests/utils/db.py` (explicit `library_entries`
pre-delete on `media`/`podcast` cleanup, mirroring the app's explicit cleanup).

**Closure GC note (plan→shipped):** the plan's single public `gc_default_library_entry`
was realized as the public pair `detach_media_from_default_library` +
`purge_media_default_references` (plus `remove_media_from_default_intrinsic` /
`count_default_references`); the single-entry GC stays **private** as
`_gc_default_library_entry`, a closure-internal helper with no external caller. `media_deletion`
calls the public pair, so AC-9 (zero entry/closure SQL in `media_deletion`) holds either way.

Original plan below — hard-cutover spec, **Rev 3** (revised after a third line-level
review; see Revision log). This document owns the production-ready plan to give the
`library_entries` table one **sole writer and lifecycle owner**, collapse the
near-duplicate media/podcast code paths to a single entry-kind-parameterized
form, make the position total-order a single owned invariant, route every
*writer* (including `media_deletion.py` and the backfill worker) through public
APIs, and pin the visibility/search *readers* under an explicit allowlist.

> **Moving target.** The concurrently-landing podcast-subsystem cutover is
> actively reshaping neighbouring code (`podcasts/sync.py` is already split into
> `ingest.py`/`poll.py`/`identity.py`/…; the unsubscribe library teardown is
> already extracted; migrations `0129`/`0130` already landed). **Line numbers in
> this spec are indicative as of 2026-06-03; cite/verify by symbol name at
> implementation time.** `libraries.py` is currently **2295 L**.

The implementation is a hard cutover. There is no legacy mode, no compatibility
alias, no re-export shim, no dual code path, no silent fallback, and no
backward-compatibility branch. `libraries.py` is **deleted**; its concerns move to
three owned modules and every caller repoints in the same slice the old symbol is
removed.

This is **not** a feature project. Library CRUD, sharing/membership, invitations,
the default-library closure, podcast-in-library entries, and reordering all work
end-to-end and are covered by ~16k lines of integration tests. What is unfinished
is the *ownership cutover*.

### Revision log

**Rev 3 (2026-06-03)** — third review; nine more issues, all verified against the
*current* tree (the podcast cutover has partially landed, moving the ground):

1. **Migration renumbered to `0131`.** `0130_drop_active_transcript_version_pointer`
   already exists (podcast cutover KD9 landed); `0129` is the rss_feed widen.
2. **The unsubscribe tie-break bug is ALREADY FIXED upstream.**
   `remove_user_podcast_subscription_libraries` now lives in `libraries.py:883`,
   `subscriptions.py:407` calls it, the divergent ASC/ASC CTE is gone, and every
   renorm in the repo is now uniformly `position ASC, created_at DESC, id DESC`.
   This cutover therefore **relocates** that already-correct command (+
   `_remove_podcast_from_library_in_txn`) into `library_entries.py` as part of the
   split — it no longer "fixes a live bug." All "live ASC/ASC bug" language is
   downgraded to history.
3. **The new unique-position invariant is not concurrency-safe as written.** The
   closure/backfill append paths (`default_library_closure.ensure_default_intrinsic`,
   `add_media_to_non_default_closure`, `materialize_closure_for_source`) insert at
   `MAX(position)+1` **without locking the target library row**, so two concurrent
   appends can compute the same position and trip a `UNIQUE (library_id, position)`
   constraint at commit. Resolved: `ensure_entry` (the sole inserter after cutover)
   takes the library-row lock as the single per-library append serialization point
   (Key Decision 8); dropping the constraint is the documented fallback.
4. **Test-plan contradiction fixed.** The equal-position tie-break test is
   **pre-migration characterization only** (duplicate positions become
   uncommittable after `0131`); final-state tests assert deferrable uniqueness +
   commit-time rejection. Note: the unique constraint *subsumes* the tie-break for
   persisted state — `ORDER BY position` is then already a total order; the
   `created_at DESC, id DESC` tail remains only for the renormalizer's transient
   determinism and as the single definition.
5. **`media_deletion`'s reference check spans three tables.**
   `_remaining_reference_count` counts over `library_entries` +
   `default_library_intrinsics` + `default_library_closure_edges`;
   `count_entries_for_media` alone is not equivalent. Added
   `default_library_closure.count_default_references(media_id)` so the orchestrator
   sums two owned counts and keeps zero raw SQL.
6. **Allowlist corrected.** `highlights.py` *duplicates* the permissions-owned
   highlight predicate (`highlights.py:147-150` ≡
   `permissions._highlight_library_intersection_exists`); it is **repointed to
   permissions**, not allowlisted. `resource_loaders.py` is a **simple batch
   count** (`_load_library`'s correlated `COUNT(*)`), so it becomes a Tier-B
   accessor (`count_entries_by_library`), not a Tier-R reader. `catalog.py` no
   longer exists. Final Tier-R: permissions, search, contributors,
   agent_tools/app_search, object_refs, object_search, library_intelligence.
7. **Module ownership sharpened.** `validate_libraries_accessible` (+
   `_resolve_accessible_non_default_library_ids`) read only libraries/memberships
   → **governance**, not entries. The catalog-facing reads are the already-
   extracted `visible_non_default_libraries_for_viewer` /
   `podcast_ids_in_libraries_for_viewer` (`libraries.py:2227/2266`) — they read
   `library_entries` and become **public read commands on `library_entries.py`**
   that the podcast `subscriptions_query`/`episodes` call (which is why the
   podcasts package already references zero library tables).
8. **Negative gates redesigned.** The bare-token gate would flag legitimate
   `from nexus.services.library_entries import …` and `library_entries.fn()` calls.
   Split into a keyword-anchored raw-SQL/ORM gate, a separate deleted-import gate,
   a repo-wide `_ensure_library_entry_for_media` gate, and **cascade verification
   via a `test_migrations.py` `pg_constraint` assertion** (the `ondelete=` source
   lines omit column names, so grep can't see them).
9. **Caller/doc staleness.** Replace `podcasts/sync.py` with `podcasts/ingest.py`
   call sites; `subscriptions.py` is already routed (relocate-only); add `make
   check-back`/`type-back` to the gate; add the enumerated integration tests; add
   `docs/modules/podcast.md` + `docs/architecture.md` to acceptance; the frontend
   contract is "preserve every library BFF proxy route + DTO/envelope shape," not
   "three routes."

**Rev 2 (2026-06-03)** — line-level review corrected nine issues; all verified
against live code and folded in:

1. **Scope of "sole owner" was too narrow/absolute.** `library_entries` is read
   by ~10 modules across distinct capabilities (census: 57 `FROM library_entries`,
   21 `LibraryEntry` ORM, 13 `libraries` imports). Reframed: `library_entries.py`
   is the sole **writer** and owner of the entry **lifecycle** (insert/delete/
   reorder/normalize/hydrate) and the ordering invariant; reads are split into
   **public accessors** (simple lookups) and an **explicit allowlist** of
   visibility/search/intelligence capability owners. See Read Ownership Model.
2. **`media_deletion.py` is a missed writer** that issues `library_entries` DML
   and carries a **complete duplicate** of closure's `_gc_default_library_entry`
   (`media_deletion.py:694-727` ≡ `default_library_closure.py:276-309`). It
   becomes a pure orchestrator over public APIs. New Slice 5.
3. **Visibility ownership was self-contradictory** (reuse
   `visible_media_ids_cte_sql()` *and* ban table reads outside
   `library_entries.py`). Resolved: `auth/permissions.py` is the documented
   visibility source of truth (`docs/architecture.md`) and is **explicitly
   allowlisted** to read `library_entries`/`LibraryEntry`. Its fragment is *not*
   moved into `library_entries.py` — that would create a
   `library_entries ⇄ permissions` cycle (`library_entries` imports
   `can_read_media`). Key Decision 3.
4. **Migration number stale.** `0129_media_transcript_states_rss_feed_reason`
   already exists (the podcast cutover's slice-0 migration landed); this
   migration is **`0130`**. `test_migrations.py:6587-6594` and the exact-set
   `test_head_contains_request_storm_hot_path_indexes` (`:6602-6625`) assert the
   `library_entries` index/constraint set and must be updated.
5. **DB cascade rule violated.** `library_entries.media_id`/`podcast_id` carry
   `ondelete="CASCADE"` (`models.py:1391/1396`, `0047:52-53`), and `library_id`
   has `CASCADE` in the DDL (`0047:51`) but **no `ondelete` in the model**
   (`models.py:1384`) — an ORM/DDL mismatch. App code already deletes entries
   explicitly, so the cascades are removed and the mismatch fixed in `0130`.
   Key Decision 5.
6. **Concurrency citation was backwards.** The repo *prefers* SERIALIZABLE +
   retry and *warns against* layering `SELECT FOR UPDATE` (`concurrency.md:12-13`,
   `architecture.md:419`). The cutover is behavior-preserving: it keeps existing
   locks without claiming the rules require them, and notes the real
   duplicate-prevention guarantee is the unique constraints
   `(library_id, media_id)`/`(library_id, podcast_id)`. Key Decision 6.
7. **Backfill ownership is broader than the invite upsert.** The worker task
   `tasks/backfill_default_library_closure.py::_mark_terminal_failure`
   (`:209-243`) raw-`UPDATE`s the job to failed and `commit()`s, duplicating
   `mark_backfill_job_failed`. Both it and the `accept_library_invite` upsert
   move behind `default_library_closure.py`. Slice 6.
8. **Test plan under-specified.** Added the enumerated behavior tests and
   `make test-migrations`. See Test Plan.
9. **Module doc is stale, not empty.** `docs/modules/library.md` names
   `services/libraries.py` as owner; the task is *rewrite*, not *create*. The
   podcast cutover's slice 2 is reconciled by editing that doc, not only by
   asserting supersession.

Rev 1 facts that survive review: the `EntryTarget` discriminant is faithful to
the DB check `ck_library_entries_exactly_one_target` (`models.py:1407`); the
97% twins (`list_media_item_libraries`/`list_podcast_item_libraries`); the
canonical order matches index
`ix_library_entries_library_order (library_id, position, created_at DESC, id DESC)`
(migration `0125`); positional row→DTO fragility (6× `LibraryOut(row[…])`,
`_fetch_library_with_membership` returns a different column order);
`position` is non-unique (`Integer NOT NULL DEFAULT 0`, only `position >= 0`).
*(The unsubscribe ASC/ASC tie-break divergence — a Rev 1/2 "live bug" — is now
**resolved upstream**; see Rev 3 item 2.)*

## Read Ownership Model

`library_entries` writes and entry-lifecycle behavior get one owner; reads are
tiered. This is the load-bearing clarification of Rev 2.

- **Tier W — Writes + lifecycle (`library_entries.py`, sole owner).** Every
  INSERT/UPDATE/DELETE on `library_entries`, plus ordering, renormalization,
  hydration, and the `EntryTarget` polymorphism. After cutover **no other module
  issues `library_entries` DML.** Writers to relocate:
  `default_library_closure.py` (its INSERT `:90` / DELETE `:305` → call
  `ensure_entry`/`delete_entry`); `media_deletion.py` (all entry DELETEs +
  its duplicate GC → public APIs, Slice 5); `libraries.py` (moves in);
  `subscriptions.py` (Slice 4).

- **Tier B — Simple read accessors (`library_entries.py` public API).** Lookups
  that are a single owned query, exposed as named functions:
  `entry_exists(library_id, target) -> bool`,
  `next_position(library_id) -> int`,
  `list_library_ids_for_media(media_id) -> list[UUID]`,
  `list_media_ids_in_library(library_id) -> list[UUID]`,
  `count_entries_for_media(media_id) -> int`,
  `count_entries_by_library(library_ids) -> dict[UUID, int]` (batch, for the
  library-list item-count — replaces `resource_loaders._load_library`'s correlated
  subquery, no N+1),
  `entry_ids_in_library(library_id) -> list[UUID]`,
  plus the two catalog-facing read **commands** relocated from `libraries.py`
  (Rev 3 item 7): `visible_non_default_libraries_for_viewer(...)` and
  `podcast_ids_in_libraries_for_viewer(...)` (`libraries.py:2227/2266`), which the
  podcast `subscriptions_query`/`episodes` modules call.
  Callers to repoint here: `libraries.py` internal reads, `x_ingest.py`,
  `default_library_closure.py` (its `entry_exists`/`next_position`/backfill
  media-list reads), `media_deletion.py` (entry reads), `resource_loaders._load_library`.

- **Tier R — Allowlisted capability readers (stay where they are).** Modules that
  compose `library_entries` into a larger CTE/scope-join for a *different* owned
  capability, where extracting an accessor would lose the composition or force an
  N+1. **Explicitly allowlisted** in the negative gate:
  - `auth/permissions.py` — **visibility source of truth**
    (`visible_media_ids_cte_sql()`, highlight intersection
    `_highlight_library_intersection_exists`).
  - `services/search.py`, `services/contributors.py`,
    `services/agent_tools/app_search.py` — search-ranking scope joins.
  - `services/object_refs.py`, `services/object_search.py` — object-link
    visibility scoping.
  - `services/library_intelligence.py` — library source-set inventory.

  **Not allowlisted (Rev 3 corrections):**
  - `services/highlights.py` is a **consumer of permissions**, not a reader:
    `highlights.py:147-150` re-implements the viewer/author membership
    intersection over `LibraryEntry` that `permissions._highlight_library_intersection_exists`
    already owns. It is **repointed to call the permissions predicate** and its
    `LibraryEntry` import is deleted (Slice 8 boundary close).
  - `services/resource_loaders.py` is a **Tier-B accessor consumer** (batch
    item-count), not a visibility reader.
  - `services/podcasts/*` reference **zero** library tables already (the catalog
    reads were extracted to the two relocated read commands above), so the podcast
    package is not on the allowlist.

  **Noted follow-up (out of scope):** the Tier-R search/object visibility joins
  should eventually compose `permissions.visible_media_ids_cte_sql()` instead of
  re-joining `library_entries`, so visibility has one read owner. Search alone has
  ~14 independent joins; that is a separate consolidation, **not** attempted here.

## Governing Repo Rules

- `docs/rules/cleanliness.md`: Duplication (collapse mutation flows/normalizers/
  near-identical branches to one owner); Types (give unions discriminants; make
  illegal states unrepresentable); God files (split mixed-concern files);
  Ownership (one concern one owner; **call only a module's public service, never
  its tables/private helpers**; no re-exports); Services (deep modules, narrow
  typed interfaces).
- `docs/rules/module-apis.md`: one primary form per capability; no duplicate APIs.
- `docs/rules/layers.md`: services own their tables and business logic; routes do
  input-validation + response-shaping only.
- `docs/rules/database.md`: explicit SELECT-then-INSERT/UPDATE/DELETE (no
  `ON CONFLICT`); no `rowcount` control flow; **no `ON DELETE CASCADE` reliance —
  cleanup is explicit in application code**; hand-written linear Alembic with
  non-reversible `downgrade()` for hard cutovers.
- `docs/rules/concurrency.md` §12-13: SERIALIZABLE handles DB-only sequential
  equivalence; **do not add `SELECT FOR UPDATE`/advisory locks on top of
  SERIALIZABLE**. (See Key Decision 6 — the existing READ-COMMITTED + `FOR UPDATE`
  locks are preserved as-is, not introduced, and not claimed to be rule-mandated.)
- `docs/rules/simplicity.md`: fewer code paths; no speculative params; a little
  duplication over a hollow generic helper.
- `docs/rules/errors.md` / `correctness.md`: classify absence at the boundary;
  no `Optional` for classifiable absence in service APIs; defects for impossible
  states with `justify-defect`.
- `docs/rules/control-flow.md`: exhaustive `Literal` + `assert_never`; narrow
  before discarding an error.

## Goals

- `library_entries` is **written** through exactly one module
  (`library_entries.py`); no other module issues `library_entries` DML. Reads are
  either public accessors or allowlisted capability readers (Read Ownership
  Model).
- The entry target is a discriminated union (`EntryTarget`); media/podcast paths
  collapse to one kind-parameterized form where the rule is identical, and share
  extracted mechanics where it differs.
- One ordering expression and one renormalizer in the codebase (the
  `subscriptions.py` divergent CTE is already gone; this keeps it that way and
  makes `_ENTRY_ORDER` the single definition).
- `media_deletion.py` issues zero entry/closure SQL and carries no duplicate GC;
  it orchestrates over public `library_entries`/`default_library_closure` APIs.
- The backfill-job state machine is written only by `default_library_closure.py`;
  `accept_library_invite` and the backfill worker call its commands.
- One projection constant + one name-keyed `_*_from_row` mapper per table shape;
  zero positional `row[N]` reconstruction.
- The reorder is a set-based single statement; `libraries.py` is deleted, no
  shim; every caller imports from the owner directly.
- `library_entries.position` is a DB invariant (`UNIQUE (library_id, position)
  DEFERRABLE`); the `media_id`/`podcast_id` cascades are removed and the
  `library_id` ORM/DDL mismatch fixed.
- `docs/modules/library.md` is rewritten as the owned boundary doc; the podcast
  cutover's slice 2 is reconciled.

## Non-Goals

- Do not change product behavior of CRUD, sharing/membership, invitations,
  closure materialization, podcast-in-library, reordering, search, or media
  deletion. This cutover is **behavior-preserving** — the unsubscribe tie-break
  bug was already fixed upstream (Rev 3 item 2); the only new observable effect is
  that a same-`(library_id, position)` insert now fails at COMMIT (the position
  uniqueness invariant), which no correct path produces.
- Do not route the Tier-R visibility/search reads through an accessor or merge
  them onto `permissions.visible_media_ids_cte_sql()` — that is the noted
  follow-up, not this cutover.
- Do not redesign the closure algorithm, the backfill worker, or the
  library-intelligence read model.
- Do not merge `add_media_to_library` and `add_podcast_to_library` into one
  flag-driven function. Their invariants differ; only mechanics are shared.
- Do not migrate to SQLAlchemy Core/ORM for reads or introduce a generic
  repository; raw `text()` + named binds is the house idiom.
- Do not "upgrade" SELECT-then-INSERT into `ON CONFLICT`.
- Do not audit/remove cascades on the *other* library tables (memberships,
  default_library_*, invitations, subscription_libraries) — flagged but a
  separate hygiene pass.
- Do not change route shapes or response envelopes.

## Current Owners To Reuse

- `default_library_closure.py` owns the closure tables and the backfill state
  machine (`claim`/`mark_completed`/`mark_failed`/`reset`/`requeue`/
  `handle_backfill_job_failure`, `366-554`). After cutover it calls
  `library_entries.ensure_entry`/`delete_entry`/`list_media_ids_in_library`
  instead of its private `_ensure_library_entry_for_media`/`_gc_default_library_entry`
  raw SQL, and **gains** `upsert_backfill_job_pending` and a public
  `gc_default_library_entry` / `detach_media_from_default_library` for
  `media_deletion` to call.
- `auth/permissions.py`: `can_read_media` (`50`), `is_library_member` (`305`),
  `visible_media_ids_cte_sql()` (`99`) — the visibility SoT and the blessed
  reusable-SQL-fragment precedent. Allowlisted reader; unchanged.
- `contributor_credits.py`, `media.list_media_for_viewer_by_ids` — reused by
  hydration unchanged (lazy import to avoid the `media ⇄ library_entries` cycle).
- `db/session.py` `transaction(db)` — commit/rollback, READ COMMITTED,
  non-reentrant. Mutations run in the caller's transaction.
- Row→DTO exemplars: `media.py:351 _media_out_from_row`,
  `jobs/queue.py:642 _row_to_job`; in-domain `_invitation_row_to_out`
  (`libraries.py:1580`).
- Internal-literal interpolation precedent:
  `search.py:597 contributor_credits_rollup_cte_sql(owner_column)`.
- Schema already encodes the order: index `ix_library_entries_library_order`
  (migration `0125`); `_ENTRY_ORDER` mirrors it.

## Duplicate / Similar / Repetitive Patterns To Consolidate

### Entry-kind polymorphism (the headline)

Current: every entry operation branches media-vs-podcast by copy-pasting a
function and swapping the column — the `add_*` pair, the
`list_*_item_libraries` 97% twins, the `(media_id, podcast_id)` nullable pair
reconstructed positionally in `_hydrate_library_entries` (`libraries.py:1112-1113`),
the INSERT NULL-placement swap, and the EXISTS predicate column.

Final state: one `EntryTarget = {kind: "media"|"podcast", id: UUID}` (faithful
to `ck_library_entries_exactly_one_target`). The predicate column, INSERT
placement, and hydration branch derive from `target.kind`.
`list_item_libraries(target)` replaces both twins; `ensure_entry(library_id,
target)` replaces both inline inserts **and** closure's
`_ensure_library_entry_for_media`. The two `add_*` commands keep distinct policy.

### Position total-order + renormalization

Current: the order string is copy-pasted bare at ~five sites (now uniformly
DESC/DESC — the `subscriptions.py` ASC/ASC copy was already removed upstream);
canonical `normalize_library_entry_positions`; `reorder_library_entries` loops N
per-row UPDATEs then renormalizes, overwriting what it just set.

Final state: one `_ENTRY_ORDER` constant (the single definition of the order); one
`normalize_positions`; the reorder is a single `unnest(… ) WITH ORDINALITY`
assignment. The DEFERRABLE position unique constraint (Slice 7, mig `0131`),
paired with the `ensure_entry` append lock, makes a second/colliding position
unrepresentable.

### `library_entries` ensure/insert/delete (now incl. media_deletion)

Current writers: `add_media_to_library` inline ensure (`libraries.py:502-520`);
`add_podcast_to_library` insert (`786-797`); closure
`_ensure_library_entry_for_media` (`76-94`) + `_gc_default_library_entry` DELETE
(`276-309`); subscriptions DELETE (`454`); `delete_library` bulk DELETE (`239`);
**`media_deletion.py` DELETEs at `99/130/264/344/722` + a duplicate
`_gc_default_library_entry` at `694-727`**.

Final state: `library_entries.py` owns `ensure_entry`/`insert_entry`/
`delete_entry`/`delete_all_entries_for_media`/`next_position`/`normalize_positions`.
Closure calls them; `media_deletion` calls them + `default_library_closure`'s
public GC; its local GC copy is deleted; nobody else issues `library_entries` DML.

### Backfill-job state machine (now incl. the worker task)

Current: inline upsert in `accept_library_invite` (`libraries.py:1883-1941`); raw
terminal-failure UPDATE + `commit()` in
`tasks/backfill_default_library_closure.py::_mark_terminal_failure` (`209-243`),
both diverging from the state machine in `default_library_closure.py`.

Final state: `default_library_closure.upsert_backfill_job_pending` (new) +
existing `mark_backfill_job_failed` are the only writers; the invite path and the
worker task call them. No raw `default_library_backfill_jobs` SQL outside the
closure module.

### Row → DTO mapping

Final state: one projection constant + one `.mappings()` name-keyed mapper per
shape (`_library_out_from_row`, `_entry_out_from_row`,
`_item_library_membership_from_row`, `_member_out_from_row`,
`_invitation_row_to_out`). `_fetch_library_with_membership` →
`lock_library_for_member` returning a frozen `LibraryMembershipContext`.

### Membership-fetch-and-lock preamble

Final state: one `lock_library_for_member(db, viewer_id, library_id) ->
LibraryMembershipContext` (the `FOR UPDATE OF l` variant, **preserved as-is** —
Key Decision 6) + a `LEFT JOIN` variant for ownership-transfer's non-member case;
`require_admin`/`require_non_default` reused everywhere.

## Target Architecture & Final State

### Backend module map (after)

```
python/nexus/services/
  library_governance.py     # libraries + memberships tables
    create/rename/delete/list/get library, member CRUD, transfer_ownership,
    _delete_library_intelligence_rows (governance's cascade)
    lock_library_for_member -> LibraryMembershipContext, require_admin,
    require_non_default, is_library_member, _library_out_from_row, _member_out_from_row

  library_entries.py        # library_entries table — SOLE WRITER + lifecycle owner
    EntryTarget, media_target, podcast_target, target_from_columns
    _ENTRY_ORDER, _ENTRY_COLUMNS, _TARGET_COLUMN
    # Tier-W primitives:
    ensure_entry, insert_entry, delete_entry, delete_all_entries_for_media,
    delete_library_entries, next_position, normalize_positions,
    list_entry_rows, hydrate_entries
    # Tier-B accessors:
    entry_exists, list_library_ids_for_media, list_media_ids_in_library,
    count_entries_for_media, entry_ids_in_library
    # commands (closure imported lazily):
    add_media_to_library, add_podcast_to_library, remove_podcast_from_library,
    list_library_entries, reorder_entries, list_item_libraries,
    ensure_media_in_default_library, add_media_to_libraries,
    assign_libraries_for_media, validate_libraries_accessible,
    set_subscription_libraries,
    remove_user_podcast_subscription_libraries, _remove_podcast_from_library_in_txn

  library_invitations.py    # library_invitations table
    _INVITATION_COLUMNS, _invitation_row_to_out, create/list/list_viewer/
    accept/decline/revoke invite

  default_library_closure.py  # unchanged owner; GAINS upsert_backfill_job_pending,
                              # gc_default_library_entry (public), detach_media_from_default_library;
                              # calls library_entries.{ensure_entry,delete_entry,list_media_ids_in_library}

  media_deletion.py           # orchestrator only: calls library_entries + closure public APIs;
                              # NO library_entries/closure-table SQL; local _gc copy deleted
```

`libraries.py` is deleted. No re-export shim. `_delete_library_intelligence_rows`
moves with `delete_library` into governance.

### Dependency direction (after)

```
library_governance ─(guards)─► library_entries ─(lazy)─► default_library_closure
library_invitations ─────────► library_entries            ▲   │
media_deletion ──► library_entries  +  default_library_closure (public GC)
permissions/media(read)/contributor_credits ◄─ library_entries (read deps)
auth/permissions (visibility) reads library_entries directly  [allowlisted Tier-R]
```

`default_library_closure` imports `library_entries` top-level for primitives;
`library_entries`'s *commands* import closure **lazily** to break the back-edge
(the technique `libraries.py:462` uses today). `permissions` stays a Tier-R
reader; it is **not** restructured (avoids the `library_entries ⇄ permissions`
cycle).

### Frontend

No frontend changes. The three routes keep their shapes; only backend import
targets in `api/routes/*` change.

## Capability Contracts / API Design

All new value types are `@dataclass(frozen=True)`; discriminants are `Literal`;
commands are keyword-only at the boundary, run in the caller's transaction, and
raise existing typed `ApiErrorCode` errors.

### Entry target

```python
# library_entries.py
from nexus.schemas.library import LibraryEntryKind  # Literal["media", "podcast"]

@dataclass(frozen=True)
class EntryTarget:
    """What a library entry points at. Exactly one of media|podcast — a faithful
    model of ck_library_entries_exactly_one_target (models.py:1407)."""
    kind: LibraryEntryKind
    id: UUID

def media_target(media_id: UUID) -> EntryTarget:   return EntryTarget("media", media_id)
def podcast_target(podcast_id: UUID) -> EntryTarget: return EntryTarget("podcast", podcast_id)

def target_from_columns(media_id: UUID | None, podcast_id: UUID | None) -> EntryTarget:
    if media_id is not None and podcast_id is None:   return EntryTarget("media", media_id)
    if podcast_id is not None and media_id is None:   return EntryTarget("podcast", podcast_id)
    # justify-defect: ck_library_entries_exactly_one_target makes this unreachable.
    raise AssertionError("library_entries row violates exactly-one-target invariant")

_TARGET_COLUMN: dict[LibraryEntryKind, str] = {"media": "media_id", "podcast": "podcast_id"}
```

### Order + renormalization (single owner)

```python
_ENTRY_ORDER = "position ASC, created_at DESC, id DESC"   # mirrors ix_library_entries_library_order
_ENTRY_COLUMNS = "id, library_id, media_id, podcast_id, created_at, position"

def normalize_positions(db: Session, library_id: UUID) -> None:
    """Sole renormalizer → dense 0..n-1 by _ENTRY_ORDER. One statement; the
    position unique constraint is DEFERRABLE so the permutation never trips
    mid-statement. Used after every DELETE that can leave a gap."""
    db.execute(text(f"""
        WITH ordered AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY {_ENTRY_ORDER}) - 1 AS new_position
            FROM library_entries WHERE library_id = :library_id
        )
        UPDATE library_entries le SET position = ordered.new_position
        FROM ordered WHERE le.id = ordered.id AND le.position <> ordered.new_position
    """), {"library_id": library_id})
```

### Entry primitives + accessors (Tier W + B)

```python
def next_position(db, library_id) -> int: ...                # COALESCE(MAX(position),-1)+1
def entry_exists(db, library_id, target: EntryTarget) -> bool: ...
def list_library_ids_for_media(db, media_id) -> list[UUID]: ...   # x_ingest/media_deletion read
def list_media_ids_in_library(db, library_id) -> list[UUID]: ...  # closure backfill read
def count_entries_for_media(db, media_id) -> int: ...             # media_deletion reference check
def entry_ids_in_library(db, library_id) -> list[UUID]: ...

def ensure_entry(db, library_id, target: EntryTarget) -> None:
    """SELECT-exists-then-INSERT at next_position if absent (no ON CONFLICT).
    The SOLE inserter — replaces add_media's inline ensure, add_podcast's insert,
    and closure._ensure_library_entry_for_media.

    Locks the target library row FIRST (justify-concurrency: two concurrent appends
    computing MAX(position)+1 would otherwise pick the same position — a result no
    sequential ordering produces — and trip UNIQUE(library_id, position) at commit;
    concurrency.md §10 requires locking here, and §13's FOR-UPDATE prohibition is
    scoped to SERIALIZABLE, whereas transaction() is READ COMMITTED). This is the
    single per-library append serialization point; the closure/backfill paths,
    which today append without locking, inherit it for free (Key Decision 8). The
    unique constraints (library_id, media_id)/(library_id, podcast_id) independently
    make a duplicate *entry* uncommittable regardless of isolation."""
    db.execute(text("SELECT 1 FROM libraries WHERE id = :lib FOR UPDATE"), {"lib": library_id})
    col = _TARGET_COLUMN[target.kind]
    if db.execute(text(f"SELECT 1 FROM library_entries WHERE library_id=:lib AND {col}=:tid"),
                  {"lib": library_id, "tid": target.id}).fetchone() is not None:
        return
    db.execute(
        text("INSERT INTO library_entries (library_id, media_id, podcast_id, position) "
             "VALUES (:lib, :media_id, :podcast_id, :pos)"),
        {"lib": library_id,
         "media_id": target.id if target.kind == "media" else None,
         "podcast_id": target.id if target.kind == "podcast" else None,
         "pos": next_position(db, library_id)})

def delete_entry(db, library_id, target: EntryTarget) -> bool:
    """DELETE the (library_id, target) entry; return whether a row went. No
    implicit renormalize — caller decides."""

def delete_all_entries_for_media(db, media_id) -> list[UUID]:
    """DELETE every entry for a media across libraries; return affected library_ids
    (so the caller can renormalize them). The sole owner of the bulk media-detach
    that media_deletion needs."""
```

### Entry commands

```python
def list_item_libraries(db, *, viewer_id, target: EntryTarget) -> list[ItemLibraryMembershipOut]:
    """Replaces BOTH list_media_item_libraries and list_podcast_item_libraries.
    Existence/visibility check branches on target.kind (can_read_media vs
    podcast-exists, exhaustive); EXISTS predicate column = _TARGET_COLUMN[kind]."""

def add_media_to_library(db, *, viewer_id, library_id, media_id) -> LibraryEntryOut:
    """Distinct policy KEPT (clear media-deletion; default→ensure_default_intrinsic;
    non-default→ensure_entry + add_media_to_non_default_closure). Shared mechanics:
    lock_library_for_member+require_admin, ensure_entry, hydrate."""

def add_podcast_to_library(db, *, viewer_id, library_id, podcast_id) -> LibraryEntryOut:
    """Distinct policy KEPT (forbid default; require ACTIVE subscription; no closure)."""

def reorder_entries(db, *, viewer_id, library_id, body: LibraryEntryOrderRequest) -> list[LibraryEntryOut]:
    """Validate requested set == existing set, then ONE statement (no per-row loop,
    no follow-up renormalize):
        WITH desired AS (
            SELECT id, ord - 1 AS new_position
            FROM unnest(cast(:entry_ids AS uuid[])) WITH ORDINALITY AS t(id, ord))
        UPDATE library_entries le SET position = desired.new_position
        FROM desired WHERE le.id = desired.id AND le.library_id = :library_id"""
```

### Unsubscribe teardown (ALREADY EXISTS in libraries.py — relocate only)

> Rev 3: this command and its helper **already live in `libraries.py:883`** (the
> podcast cutover's slice 2 landed); `subscriptions.py:407` already calls it and
> touches zero library tables; the divergent CTE is already gone. This cutover
> **moves** them into `library_entries.py` during the split and re-points the one
> `subscriptions.py` import — it does not author them or fix a bug.

```python
@dataclass(frozen=True)
class PodcastLibraryRemovalResult:
    removed_from_library_count: int
    retained_shared_library_count: int

def remove_user_podcast_subscription_libraries(db, *, viewer_id, podcast_id
                                               ) -> PodcastLibraryRemovalResult:
    """Sole owner of unsubscribe library teardown: classify the viewer's
    library_entries for this podcast (admin-owned non-default → removable;
    foreign-owned shared → retained+counted), delete via delete_entry, renormalize
    each affected library, return counts. Caller's transaction."""

def _remove_podcast_from_library_in_txn(db, *, library_id, podcast_id) -> bool:
    """delete_entry(podcast) + normalize_positions. Shared by the public single-
    library remove and the teardown command."""
```

### Governance guards

```python
# library_governance.py
@dataclass(frozen=True)
class LibraryMembershipContext:
    library_id: UUID; is_default: bool; owner_user_id: UUID
    name: str; color: str | None; role: LibraryRole
    created_at: datetime; updated_at: datetime

def lock_library_for_member(db, viewer_id, library_id) -> LibraryMembershipContext:
    """Library + viewer membership with FOR UPDATE OF the library row (preserved
    behavior, Key Decision 6); masked NotFoundError if not a member. Replaces the
    five hand-rolled preambles; callers read .role/.is_default by name."""

def require_admin(role: LibraryRole) -> None: ...
def require_non_default(is_default: bool) -> None: ...
```

### Closure gains (Tier-W consolidation for media_deletion + invites + worker)

```python
# default_library_closure.py
def upsert_backfill_job_pending(db, *, default_library_id, source_library_id, user_id) -> str:
    """(Re)set the (dl, src, user) job to pending/attempts=0/error=NULL via
    explicit SELECT-then-INSERT/UPDATE (no ON CONFLICT). Returns status for
    AcceptLibraryInviteResponse. Replaces accept_library_invite's inline upsert."""

def gc_default_library_entry(db, *, default_library_id, media_id) -> None:
    """Public form of the existing private GC: delete the default-library entry iff
    no intrinsic and no closure edge. media_deletion calls THIS instead of its
    duplicate copy (media_deletion.py:694-727 deleted)."""

def detach_media_from_default_library(db, *, default_library_id, media_id) -> None:
    """Delete intrinsic + closure edges + (via library_entries) the default entry
    for one media. Replaces media_deletion's inline 3-table delete (:81-104)."""

def count_default_references(db, *, media_id) -> int:
    """Count this media's references in the closure-owned tables
    (default_library_intrinsics + default_library_closure_edges). media_deletion
    sums this with library_entries.count_entries_for_media(media_id) to decide
    hard-delete — replacing its inline 3-table UNION (_remaining_reference_count),
    so each owner keeps its tables private (Rev 3 item 5)."""
```

## How It Composes With Other Systems

- **default_library_closure** depends on the `library_entries` primitive
  (`ensure_entry`/`delete_entry`/`list_media_ids_in_library`) and exposes
  `upsert_backfill_job_pending`, `gc_default_library_entry`,
  `detach_media_from_default_library`. Sole owner of the closure tables and the
  backfill state machine.
- **media_deletion** becomes a pure orchestrator: viewer-scoped delete, per-library
  removal, and hard-delete-if-unreferenced all call public `library_entries`
  (`delete_entry`/`delete_all_entries_for_media`/`count_entries_for_media`) and
  `default_library_closure` (`gc_default_library_entry`/
  `detach_media_from_default_library`/`count_default_references`) APIs. The
  duplicate `_gc_default_library_entry` and the three-table
  `_remaining_reference_count` are deleted; the hard-delete decision sums
  `library_entries.count_entries_for_media` + `closure.count_default_references`.
- **podcasts/subscriptions**: already routed — `unsubscribe` already calls
  `remove_user_podcast_subscription_libraries` and the package references zero
  library tables. This cutover only re-points that import to the relocated command
  in `library_entries.py`.
- **auth/permissions (visibility SoT)**: unchanged, allowlisted reader.
  `list_item_libraries`/hydration reuse `can_read_media` /
  `visible_media_ids_cte_sql()`. **highlights** stops re-implementing the
  intersection and calls the permissions predicate.
- **search / contributors / agent_tools / object_refs / object_search /
  library_intelligence**: allowlisted Tier-R readers, unchanged. **resource_loaders**
  uses the Tier-B `count_entries_by_library` accessor; **catalog** no longer
  exists. The visibility-join consolidation onto the permissions fragment is the
  noted follow-up.
- **backfill worker** (`tasks/backfill_default_library_closure.py`): calls
  `mark_backfill_job_failed` instead of raw SQL; `claim`/`mark_completed` already
  go through the state machine.
- **ingest tasks**: `ingest_web_article.py` calls
  `ensure_media_in_default_library` (gaining the media-deletion clearance); other
  ingest callers repoint imports to the owning module.
- **routes**: `api/routes/{libraries,media,podcasts}.py` import each function from
  its new owner; bodies unchanged.

### Composition with the podcast-subsystem cutover

The podcast cutover's slice 2 **already landed**:
`remove_user_podcast_subscription_libraries` + `_remove_podcast_from_library_in_txn`
exist in `libraries.py`, `subscriptions.py` calls them, the divergent CTE is gone.
This (lower-layer) spec **relocates** that command into `library_entries.py` during
the split and re-points the `subscriptions.py` import. The shared contract is the
`PodcastLibraryRemovalResult` signature above; the podcast cutover doc's slice-2
note is updated to point at the relocated owner.

## Test Plan

Real-DB integration tests (house pattern: `direct_db` + `auth_client`,
`register_cleanup`). The position tests split across the migration boundary
(Rev 3 item 4):

**Pre-migration characterization (Slice 0, before Slice 7):**
- **Equal-position tie-break.** Directly insert two entries in one library with
  *equal* `position` (possible only before `0131`'s unique constraint); assert
  `list_entries` orders them `created_at DESC, id DESC`. This pins the
  `_ENTRY_ORDER` definition before the code moves; it is **deleted/retired by
  Slice 7** because equal positions then become uncommittable.

**Final-state behavior:**
- **Position uniqueness enforced.** After `0131`, inserting two entries with the
  same `(library_id, position)` fails at COMMIT (deferred unique). One test for
  the deferred-at-commit rejection.
- **Concurrent append safety (Key Decision 8).** Two appends to the same library
  in overlapping transactions both succeed with distinct dense positions (the
  `ensure_entry` library-row lock serializes them) — no commit-time unique
  violation. Exercise via two sessions on `direct_db`.
- **Mixed media+podcast reorder.** A library with both kinds; full reorder;
  assert the exact requested order and dense 0..n-1 positions.
- **Reorder rejects bad sets.** Duplicate IDs and foreign/missing IDs →
  `E_INVALID_REQUEST`.
- **Unsubscribe ordering** (regression guard for the already-landed fix): after
  unsubscribe removes a middle entry, remaining entries are dense and ordered by
  the canonical tie-break.
- **Accept-invite backfill reset.** Accepting re-resets a `failed`/`completed`
  backfill job to `pending`/attempts=0 (via `upsert_backfill_job_pending`).
- **Idempotent accept returns real durable status** — the actual job status, not
  a synthesized constant.
- **Podcast add without active subscription** → `E_NOT_FOUND`.
- **media_deletion** (existing tests pass unchanged) plus one asserting a
  hard-deleted media's `library_entries` are gone **without** relying on the FK
  cascade (cascade removed — Key Decision 5), and one asserting the three-table
  reference check still hard-deletes only truly-unreferenced media.

**Gate for a module move this size:** `make check-back` (lint/format) +
`make type-back` (type check) + the backend suite + `make test-migrations`
(`cd python && DATABASE_URL=$DATABASE_URL_TEST_MIGRATIONS NEXUS_ENV=test uv run
pytest tests/test_migrations.py`) — all green after `test_migrations.py` is updated
for the new index/constraint/FK set (`:6587-6594`, `:6602-6625`, + the cascade
assertions below).

## Schema Changes (single non-reversible migration, revision 0131)

Head is `0130_drop_active_transcript_version_pointer`; this migration is `0131_*`
(Rev 3 item 1 — `0129`/`0130` already landed from the podcast cutover).

- **Data cleanup first:** renormalize every library to dense 0..n-1 by the
  canonical order (clears any legacy duplicate positions from the ASC/ASC path):
  ```sql
  WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (
          PARTITION BY library_id ORDER BY position ASC, created_at DESC, id DESC
      ) - 1 AS new_position
      FROM library_entries
  )
  UPDATE library_entries le SET position = ordered.new_position
  FROM ordered WHERE le.id = ordered.id AND le.position <> ordered.new_position;
  ```
- **Add** `UNIQUE (library_id, position) DEFERRABLE INITIALLY DEFERRED` as
  `uq_library_entries_library_position_unique`; mirror in `models.py`. DEFERRABLE
  so the renormalize and `unnest` reorder validate at COMMIT.
- **Drop** the redundant non-unique index `ix_library_entries_library_position`
  (the unique constraint's index serves the same lookups); keep
  `ix_library_entries_library_order`.
- **Remove the cascades** (Key Decision 5): recreate the `library_entries`
  `media_id` and `podcast_id` FKs **without** `ON DELETE CASCADE`, and fix the
  `library_id` ORM/DDL mismatch (`models.py:1384` gets no cascade; the DDL is
  recreated to match — non-cascading). Cleanup is already explicit in app code
  after Slices 1–5.
- **Update `test_migrations.py`**: `:6593` (`ix_library_entries_library_position`
  removed), the exact-set assertion at `:6618-6625`, and add the new
  `uq_library_entries_library_position_unique`.
- **Cascade verification is a migration test, not a grep** (Rev 3 item 8): the
  `ondelete=` source lines omit column names, so a `models.py` grep can't see
  them. Assert against the live catalog instead — query `pg_constraint`
  (`confrelid`/`conkey`/`confdeltype`) or `information_schema.referential_constraints`
  for the `library_entries` FKs and assert `confdeltype = 'a'` (NO ACTION) for the
  `media_id` and `podcast_id` FKs (was `'c'` = CASCADE) and for `library_id`.
- `downgrade()` raises `NotImplementedError("Hard cutover: 0131 is not reversible")`.

## Scope

In scope: delete `libraries.py`; create `library_governance.py`,
`library_entries.py`, `library_invitations.py`; edit
`default_library_closure.py`, `media_deletion.py`,
`tasks/backfill_default_library_closure.py`, `podcasts/subscriptions.py`,
`highlights.py` (repoint to the permissions predicate), `resource_loaders.py`
(Tier-B count accessor), and the caller/import sites
(`api/routes/{libraries,media,podcasts}.py`, `media.py`, `upload.py`,
`media_ingest.py`, `remote_file_ingest.py`, `youtube_ingest.py`, `x_ingest.py`,
`epub_lifecycle.py`, `podcasts/ingest.py`, `podcasts/subscriptions_query.py`,
`podcasts/episodes.py`, `ingest_web_article.py`); one migration `0131` +
`models.py` mirror + `test_migrations.py` updates; rewrite `docs/modules/library.md`,
add/update `docs/modules/podcast.md` + `docs/architecture.md`; reconcile the
podcast cutover doc.

The frontend needs no logic change, but the contract surface is **every library
BFF proxy route and its JSON DTO/envelope shape**, not just three paths — preserve
all of them (`/api/libraries*`, `/api/media/{id}/libraries`,
`/api/podcasts/{id}/libraries`, and any nested member/invite/entry proxies).

Out of scope: the Tier-R visibility-join consolidation onto the permissions
fragment; the closure algorithm / backfill worker / library-intelligence
redesign; cascade audit of the other library tables; any frontend logic change.

## Files

Delete: `services/libraries.py`; `default_library_closure.py::_ensure_library_entry_for_media`;
`media_deletion.py::_gc_default_library_entry` (duplicate) + `_remaining_reference_count`
+ its inline `library_entries`/closure SQL; the inline backfill upsert in
`accept_library_invite`; the raw terminal-failure UPDATE in
`tasks/backfill_default_library_closure.py::_mark_terminal_failure`. (The
`subscriptions.py` inline CTE is **already gone** — Rev 3 item 2.)

Create: `services/library_governance.py`, `services/library_entries.py`,
`services/library_invitations.py`, the `0131_*` migration, the new tests,
`docs/modules/library.md` (rewrite), `docs/modules/podcast.md` (update).

Edit: `default_library_closure.py`, `media_deletion.py`,
`tasks/backfill_default_library_closure.py`, `podcasts/subscriptions.py`
(re-point the one import), `podcasts/ingest.py`, `podcasts/subscriptions_query.py`,
`podcasts/episodes.py`, `highlights.py`, `resource_loaders.py`, `media.py`,
`upload.py`, `media_ingest.py`, `remote_file_ingest.py`, `youtube_ingest.py`,
`x_ingest.py`, `epub_lifecycle.py`, `tasks/ingest_web_article.py`,
`api/routes/{libraries,media,podcasts}.py`, `db/models.py`,
`tests/test_migrations.py`, `docs/architecture.md`,
`docs/cutovers/podcast-subsystem-ownership-hard-cutover.md`.

## Slice Plan (correctness first; each slice lands green with its gate)

0. **Pin behavior.** Add the Test Plan's pre-migration equal-position
   characterization + the reorder/add-policy tests against current code.
1. **`library_entries.py` data-owner + `EntryTarget`.** Create the module
   (primitives incl. the `ensure_entry` library-row lock, Tier-B accessors +
   batch `count_entries_by_library`, mappers, commands); collapse the twins into
   `list_item_libraries`; collapse reorder to the `unnest` statement; **relocate**
   `remove_user_podcast_subscription_libraries` + `_remove_podcast_from_library_in_txn`
   and the two catalog-facing read commands
   (`visible_non_default_libraries_for_viewer`,
   `podcast_ids_in_libraries_for_viewer`) here; closure imported lazily. Repoint
   entry callers (incl. the one `subscriptions.py` import and the podcast
   `subscriptions_query`/`episodes` callers). Delete entry concerns from
   `libraries.py`. **Gate:** `rg "list_media_item_libraries|list_podcast_item_libraries"` → 0;
   `rg -P "ORDER BY position ASC, created_at" python/nexus -g '!library_entries.py'` → 0;
   `rg "library_entries" python/nexus/services/podcasts/` → 0 (already true; keep it true).
2. **`library_governance.py`.** Move CRUD/members/transfer + guards
   (`lock_library_for_member`, `LibraryMembershipContext`, `require_*`,
   `is_library_member`, `_delete_library_intelligence_rows`), **and the
   libraries/memberships access checks `validate_libraries_accessible` +
   `_resolve_accessible_non_default_library_ids`** (Rev 3 item 7 — they read no
   entries), + the `LibraryOut`/member mappers. **Gate:**
   `rg "_fetch_library_with_membership"` → 0; no positional `LibraryOut(row[`.
3. **`library_invitations.py` + invite upsert ownership.** Move the invite
   lifecycle; `_INVITATION_COLUMNS` + `_invitation_row_to_out`; move the inline
   upsert to `default_library_closure.upsert_backfill_job_pending`; collapse
   decline/revoke to `UPDATE … RETURNING`. **Gate:**
   `rg -P "(INSERT INTO|UPDATE|DELETE FROM)\s+default_library_backfill_jobs" python/nexus/services/library_invitations.py` → 0.
4. **`media_deletion.py` → orchestrator.** Delete the duplicate
   `_gc_default_library_entry` and `_remaining_reference_count`; route every
   entry/closure access through public APIs (`library_entries.delete_entry`/
   `delete_all_entries_for_media`/`count_entries_for_media`;
   `default_library_closure.gc_default_library_entry`/
   `detach_media_from_default_library`/`count_default_references`). **Gate:**
   `rg -P "(FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+(library_entries|default_library_intrinsics|default_library_closure_edges)" python/nexus/services/media_deletion.py` → 0.
5. **Backfill worker ownership.** Replace
   `tasks/backfill_default_library_closure.py::_mark_terminal_failure` raw UPDATE
   (+ its `commit()`) with `mark_backfill_job_failed`. **Gate:**
   `rg -P "(INSERT INTO|UPDATE|DELETE FROM)\s+default_library_backfill_jobs" python/nexus/tasks/` → 0.
6. **`highlights.py` → permissions consumer.** Replace the local `LibraryEntry`
   intersection (`:147-150`) with a call to
   `permissions._highlight_library_intersection_exists` (promote it to a public
   name if needed); delete the `LibraryEntry` import. **Gate:**
   `rg "LibraryEntry" python/nexus/services/highlights.py` → 0.
7. **Migration 0131.** Renormalize-all; add DEFERRABLE `UNIQUE (library_id,
   position)`; drop redundant index; **remove `media_id`/`podcast_id` cascades +
   fix `library_id` mismatch**; update `models.py` + `test_migrations.py` (incl.
   the `pg_constraint` cascade assertions); retire the pre-migration
   equal-position test. **Gate:** `make test-migrations` green; inserting two
   same-position entries fails at COMMIT.
8. **Close boundaries, delete `libraries.py`.** Repoint `ingest_web_article.py`,
   `x_ingest.py`, `media.py`, `resource_loaders.py` to the public accessors;
   delete `services/libraries.py`. **Gate:** the redesigned census gate (below).
9. **Docs.** Rewrite `docs/modules/library.md`; update `docs/modules/podcast.md`
   + `docs/architecture.md`; edit the podcast cutover doc's slice 2 to reference
   the relocated command (already cross-referenced).

## Acceptance Criteria

1. **Sole writer.** No module other than `library_entries.py` (and `migrations/`)
   issues `INSERT/UPDATE/DELETE … library_entries` (keyword-anchored gate below).
2. **One ordering, one renormalizer.** `_ENTRY_ORDER` defined once; no other file
   contains `position ASC, created_at` (the `subscriptions.py` CTE is already
   gone — verify it stays gone).
3. **Twins collapsed.** `list_item_libraries(target)` serves both routes;
   `test_library_target_picker.py` passes unchanged.
4. **`add_*` policy preserved**; closure/intrinsic/subscription tests pass
   unchanged. `ensure_entry` holds the library-row lock (concurrent-append test
   passes).
5. **Reorder is one statement**; no per-row loop, no post-assignment normalize;
   reorder tests (mixed-kind, bad-set) pass.
6. **Position uniqueness + ordering correct.** Post-`0131`, same-`(library_id,
   position)` inserts fail at COMMIT; the pre-migration tie-break characterization
   ran green before Slice 7 and is retired.
7. **No positional row→DTO**; `_fetch_library_with_membership` gone;
   `LibraryMembershipContext` used; `validate_libraries_accessible` lives in
   governance.
8. **Backfill single-owner.** No raw `default_library_backfill_jobs` DML outside
   `default_library_closure.py`; accept-invite + worker call its commands.
9. **media_deletion has zero entry/closure SQL**, no duplicate GC, no
   `_remaining_reference_count`; its tests pass; a hard-deleted media's entries
   are removed by app code, not the FK.
10. **highlights uses the permissions predicate** (no `LibraryEntry` import);
    resource_loaders uses the Tier-B count accessor.
11. **Cascades removed.** `pg_constraint` shows `confdeltype='a'` for
    `library_entries.media_id`/`podcast_id`/`library_id` FKs; `0131` applied;
    `make check-back` + `make type-back` + `make test-migrations` green.
12. **`libraries.py` deleted**, no shim; the redesigned census gate is clean.
13. **Docs.** `docs/modules/library.md` rewritten; `docs/modules/podcast.md` +
    `docs/architecture.md` updated; the podcast cutover slice 2 reconciled.

## Negative Gates

Split by intent (Rev 3 item 8): a **raw-SQL/ORM access** gate (keyword-anchored,
so it ignores `from nexus.services.library_entries import …` and
`library_entries.fn()` calls), a **deleted-import** gate, **helper-gone** gates,
and **cascade verification via a migration test** (not grep — `ondelete=` source
lines have no column names).

```
# (1) Raw table access + ORM model use, outside the owner and the Tier-R allowlist.
rg -nP '\b(FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+library_entries\b|\bLibraryEntry\b' python/nexus \
  -g '!python/nexus/services/library_entries.py' \
  -g '!python/nexus/db/models.py' \
  -g '!python/nexus/auth/permissions.py' \
  -g '!python/nexus/services/search.py' \
  -g '!python/nexus/services/contributors.py' \
  -g '!python/nexus/services/agent_tools/app_search.py' \
  -g '!python/nexus/services/object_refs.py' \
  -g '!python/nexus/services/object_search.py' \
  -g '!python/nexus/services/library_intelligence.py'
# expected: 0  (closure, media_deletion, highlights, resource_loaders, podcasts all
#               go through public APIs / the permissions predicate)

# (2) The deleted god-file is no longer imported.
rg -nP 'from nexus\.services import libraries\b|from nexus\.services\.libraries import' python/nexus   # 0

# (3) Collapsed twins + deleted private helpers (repo-wide, not just one file).
rg -n 'list_media_item_libraries|list_podcast_item_libraries' python/nexus                 # 0
rg -n '_ensure_library_entry_for_media|_remaining_reference_count' python/nexus            # 0
rg -n '_gc_default_library_entry' python/nexus/services/media_deletion.py                  # 0 (the public one stays in closure)

# (4) Backfill state machine writes only in the closure module.
rg -nP '(INSERT INTO|UPDATE|DELETE FROM)\s+default_library_backfill_jobs' python/nexus \
  -g '!python/nexus/services/default_library_closure.py'                                   # 0

# (5) Cascades — assert in test_migrations.py against pg_constraint, NOT grep:
#     SELECT conname, confdeltype FROM pg_constraint
#     WHERE conrelid = 'library_entries'::regclass AND contype = 'f';
#     assert confdeltype == 'a' (NO ACTION) for media_id, podcast_id, library_id FKs.
```

## Key Decisions

1. **EntryTarget discriminant** — faithful to the DB exclusive-arc check; the
   single lever that collapses the twins and the positional `(media_id,
   podcast_id)` reconstruction. A small honest type, not a generic.

2. **Sole *writer* + lifecycle owner, not sole reader** (Rev 2). Writes and the
   entry lifecycle are non-negotiably single-owned (that is where the bug lived);
   reads split into public accessors (simple lookups) and an explicit Tier-R
   allowlist (visibility/search/intelligence composition). Forcing every
   visibility JOIN through an accessor would lose composition or cause N+1 and is
   the noted follow-up, not this cutover.

3. **`permissions.py` stays the visibility owner and is allowlisted** (Rev 2).
   It is the documented SoT; moving `visible_media_ids_cte_sql()` into
   `library_entries.py` would create a `library_entries ⇄ permissions` cycle
   (`library_entries` imports `can_read_media`). The gate excludes it and the
   other Tier-R readers.

4. **`add_media`/`add_podcast` are not merged.** Their invariants differ (closure
   + default policy + media-deletion clearance vs subscription gate +
   default-forbidden + no closure). Extract mechanics, keep two policy commands.

5. **Remove the `library_entries` cascades; fix the `library_id` mismatch**
   (Rev 2/3). `media_id`/`podcast_id` `ON DELETE CASCADE` (`models.py:1391/1396`,
   `0047:52-53`) violate `database.md` (cleanup is explicit). After Slices 1–4
   every media/podcast delete path deletes entries explicitly (media_deletion +
   the entry commands), so the cascades are redundant; `0131` recreates the FKs
   non-cascading and fixes the `library_id` ORM/DDL mismatch (`models.py:1384` has
   no `ondelete` while `0047:51` has CASCADE). Verified by a `pg_constraint`
   migration test, not grep. The other library tables' cascades are flagged but
   out of scope.

6. **Concurrency: `ensure_entry` adds the required append lock; the rule is cited
   correctly** (Rev 3 supersedes Rev 2). `concurrency.md §10` *requires* locking
   when concurrent calls could produce a result no sequential order yields — two
   appends computing the same `MAX(position)+1` is exactly that — and §13's
   `SELECT FOR UPDATE` prohibition is scoped to *SERIALIZABLE*, whereas
   `transaction()` is READ COMMITTED. The closure/backfill append paths today take
   **no** library-row lock, so the new unique constraint would turn their races
   into commit failures. `ensure_entry` therefore locks `libraries WHERE id=:lib
   FOR UPDATE` as the single per-library append serialization point
   (`justify-concurrency`); the existing per-command `lock_library_for_member`
   locks are preserved and simply re-acquire the same row idempotently. Duplicate
   *entries* are independently prevented by the `(library_id, media_id)`/
   `(library_id, podcast_id)` unique constraints.

7. **Reorder is set-based** — `unnest(… ) WITH ORDINALITY` in one statement; the
   full requested order is already dense, so no follow-up renormalize.

8. **`UNIQUE (library_id, position) DEFERRABLE INITIALLY DEFERRED`, paired with the
   `ensure_entry` lock** (Rev 3). The make-illegal-states-unrepresentable move and
   the reason there is a migration. DEFERRABLE so permutation statements validate
   at COMMIT; a one-time renormalize-all clears legacy duplicates. It is only safe
   *because* `ensure_entry` serializes appends per library (Key Decision 6) —
   otherwise the constraint converts the closure/backfill append race into a
   commit failure. **Recommendation (user-confirmed): keep the constraint + lock**
   (for a single-user prototype the per-library serialization is negligible). **If
   backfill throughput ever matters**, the first-resort optimization is to lock the
   target default library row **once per materialization batch** in
   `materialize_closure_for_source` (and have `ensure_entry` skip re-locking when
   the caller already holds it) rather than per-entry — *not* to drop the
   constraint. Dropping the constraint (keeping `position` non-unique, invariant
   enforced by the single renormalizer + gates only) is the last-resort fallback.

9. **Backfill state machine is single-owned, incl. the worker** (Rev 2/3). Both
   the invite upsert and the worker's `_mark_terminal_failure` (raw UPDATE +
   `commit()`) move behind `default_library_closure.py`; no module else issues
   `default_library_backfill_jobs` DML.

10. **The unsubscribe tie-break fix already landed; this is a relocation**
    (Rev 3). `remove_user_podcast_subscription_libraries` + the single tie-break
    already live in `libraries.py` (podcast cutover slice 2); this cutover moves
    them into `library_entries.py` during the split. The spec's value is the
    god-file decomposition, the `EntryTarget` collapse, the positional-DTO fix,
    the writer consolidation (media_deletion + backfill worker), and the position
    DB invariant — not a bug fix.

11. **Hard cutover, one concern per slice, negative gates.** Old symbol + last
    caller move together; `libraries.py` deleted, not shimmed.

12. **`remove_user_podcast_subscription_libraries` is a historically shared
    contract, now relocated here.** It originated in `libraries.py` via the podcast
    cutover (slice 2, already landed); this cutover moves it into
    `library_entries.py` during the split. Both specs reference the one
    `PodcastLibraryRemovalResult` signature; there is no remaining tie-break fix to
    own (see Key Decision 10).
```

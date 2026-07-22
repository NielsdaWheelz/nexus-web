# Authors Directory + Contributor Ownership Hard Cutover

**Status:** SUPERSEDED by `lightweight-author-deduplication-hard-cutover.md`
(2026-07) — the `/authors` faceted directory, the `merge`/`split`/`tombstone`
verbs, `contributor_identity_events`, and `contributor_reconciliation` this
document builds/finishes are all **removed** by that cutover in favor of an
inline, write-time resolver with no dedupe proposal job and no root directory
pane (author search moved into the universal Launcher at
`/search?kinds=people`). Retained here as historical record only; do not
implement anything below. See `docs/architecture.md` §8.6 for the current
ownership map.
**Status (as shipped, historical):** Implemented + reviewed · **Rev 3** · 2026-06-05
**Type:** Hard cutover — no legacy code, no fallbacks, no backward-compat shims.

> **Implementation notes (deviations from the spec text below, all verified):** the migration is **`0139_contributor_sort_name_invariant_and_directory_index`** (`down_revision="0138"`) — built as `0137` off head `0136`, then renumbered onto current main when integrating (`0137_media_document_readiness` and `0138_current_only_artifacts` landed first). `repoint_contributor_object_links` lives in **`object_links.py`** (the real `ObjectLink` DML owner), not `object_refs.py` as §4.1/§7/I10/§17 state — so I10 is enforced as "`contributors.py` issues no `object_links` DML" and the link repoint flows through the owner. `run_identity_write` is **SERIALIZABLE + bounded retry with no `FOR UPDATE`/row locks** (concurrency.md forbids locking atop SERIALIZABLE; overrides §9's literal "FOR UPDATE" wording). C4's shared FTS expression is a `search.py`-local `_contributor_fts_text_sql()` (the directory typeahead uses ILIKE per N4, so there is no contributors.py consumer to share with). `CONTRIBUTOR_KINDS`/`CONTRIBUTOR_ALIAS_KINDS` named in §4.2 are DB-CHECK-enforced, not Python frozensets. Facet counts are global (not drill-down). See `docs/architecture.md` §8.6 for the living ownership map.

## One-line

Give the `Contributor` entity the **list/index surface every other first-class entity already has**, finish the **modeled-but-unbuilt `merge` verb**, and **collapse the contributor backend's ownership/visibility/taxonomy duplications into single owners** — shipped as one hard cutover.

## Rev 3 — review resolutions (changelog)

| # | Review finding | Resolution in this rev |
|---|---|---|
| 1 | Migration `0137` collides with existing head `0137_media_document_readiness_hard_cutover` | This migration is **`0138`** (verified head). §6, §15, §18, §20 updated. |
| 2 | `sort_name NOT NULL` not carried through model/contracts | Carried through migration **+ ORM (`models.py:1149`) + API schemas + TS types + create seam**. §6, §7, §11, §14, §20. |
| 3 | Merge "serializable + retry mirroring split/tombstone" is false — they `db.commit()` directly | New shared `run_identity_write(...)` boundary (FOR UPDATE on parents, SERIALIZABLE, bounded retry) applied to **all** identity writes incl. split/tombstone. §9, §7. |
| 4 | Merge rewrites `object_links` — crosses that table's owner | Merge no longer writes `object_links`; canonicalization-on-read handles it. Split's link move goes through a **narrow `object_refs` command** (object_links' owner). §4, §9. |
| 5 | Visibility consolidation missed third copy in `object_refs.py:408` | `object_refs.py` added as a required consumer of the extracted CTEs; grep gate covers all inliners. §4, §5, §10, §17. |
| 6 | Old-handle canonicalization under-scoped (search filters raw handles) | One contributor-owned `resolve_canonical_contributor_ids(handles)`; **all** handle consumers filter by canonical IDs. §7, §10. |
| 7 | Identity API leaks (`credit: dict`; role-norm in credits + import ban = contradiction) | Typed `ContributorResolutionInput`/`...Result`; new **`contributor_taxonomy.py` leaf** owns roles/kinds/authorities/normalizers. §4, §5, §7. |
| 8 | Post-merge name-only reingest can re-duplicate (provider aliases aren't "confirmed") | Merge writes a **confirmed merge-alias** (`source="merge"` added to confirmed set); post-merge reingest test. §9, §15, §16. |
| 9 | External-ID identity proof too loose (provider IDs + raw `source_ref`) | `STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`; only STRONG resolves identity; `source_ref` is provenance, never identity. Explicit X/YouTube decision: **not promoted**. §9, §13. |
| 10 | Directory contract inconsistent (cursor vs offset; index vs FTS) | Final SQL defined first (§8.1); **opaque cursor** (keyset for name, offset for works); index rationale corrected (A–Z keyset, not typeahead). |
| 11 | Frontend route/BFF/resource incomplete | Adds `authors/page.tsx`, `api/contributors/directory/route.ts`, `api/contributors/[handle]/merge/route.ts`, `contributorDirectoryResource`. §11, §20. |
| 12 | `ContributorFilter` is multi-select (wrong for merge target); facets shouldn't use `useStringIdSet`; prefetch needs params | Extract single-select `ContributorPicker` + shared `useContributorSearch`; facets are **URL query-state**; directory is **client-fetched** (no server loader), matching browse/search. §11, §13. |
| 13 | "Every ingest source mints contributors independently" overstates behavior | Reworded: same-source+name reuse exists (`_previous_contributors_by_source_name`), curated aliases + explicit external IDs resolve; only unconfirmed cross-identity provider/LLM names don't auto-merge. §1. |

---

## 1. Problem

The contributor (author/creator) layer is already authority-grade: `0071_authors_layer_hard_cutover` replaced denormalized author strings with `contributors` + `contributor_aliases` + `contributor_external_ids` + `contributor_credits` + `contributor_identity_events`, modeled on real name-authority files (VIAF/LCNAF/ISNI/ORCID). The detail pane (`/authors/{handle}`), clickable chips everywhere, typeahead search, and credit ingest from every provider all exist and work.

Four concrete defects remain:

1. **List/detail asymmetry.** Every other first-class entity has both a list view and a detail view: Libraries (`/libraries` + `/libraries/{id}`), Podcasts (`/podcasts` + `/podcasts/{id}`), Media (list + `/media/{id}`). Contributors have **only** the detail view (`/authors/{handle}`). A contributor is reachable only by *traversal* (click a chip on content you already have open) or by *exact-ish typeahead*. There is no surface that **enumerates** the entity — no "who is in my knowledge base?".

2. **Missing `merge` verb.** `contributors.status='merged'`, `contributors.merged_into_contributor_id`, `contributors.merged_at`, and `contributor_identity_events.event_type='merge'` all exist in schema, but **no service, route, or test implements merge** (`models.py:1153-1158,1193,1444`). Identity resolution today is deliberately conservative: same-source-and-name reingest is reused (`contributor_credits.py:424 _previous_contributors_by_source_name`), curated aliases (`{manual, curated, user}`) and explicit STRONG external IDs resolve. What it does **not** do — by design — is auto-merge unconfirmed provider/LLM names *across* identities. So the same person ingested as `rss` vs `web_article_byline` vs `youtube_metadata` becomes several contributors, and there is **no reconciliation verb** to collapse them. An authority file without reconciliation accrues duplicates; the directory makes them visible, so merge must ship with it.

3. **Identity-resolution ownership inversion + leaks.** Contributor *identity* (create-or-resolve, alias lookup, external-id attachment, handle generation, name normalization) lives in `contributor_credits.py:569-859`, but is logically owned by the contributor entity. `contributors.py:35-40` therefore imports *up* from `contributor_credits.py`. The resolver also takes a raw `credit: dict` and treats `source_ref` as identity evidence (`contributor_credits.py:730-738`), and the external-id authority set (`contributor_credits.py:43`) mixes true authority files with provider/source IDs — so provenance can masquerade as identity proof.

4. **Divergent / triplicated visibility predicates.** Contributor visibility is implemented **three times**:
   - `search.py:_search_contributors` (2252-2488): credit-on-visible-media/podcast/gutenberg. **Excludes** object-link-only contributors.
   - `contributors.py:_visible_contributor_ctes_sql` (753-804): credit **OR** viewer object-link. **Includes** them.
   - `object_refs.py:~405` inlines the same `visible_media`/`visible_podcasts`/`visible_contributor_credits` CTEs again.
   - The `visible_podcasts` CTE (`subscriptions ∪ library_entries`) is **inlined verbatim** across `contributors.py`, `search.py`, `object_refs.py` (and the same shape recurs in `media.py`, `playback_queue.py`, `library_entries.py`).
   - `contributors.py:_persisted_contributor_ref_exists` (959-1000) reaches **across domains** into `message_retrievals`, `message_tool_calls`, `chat_prompt_assemblies` JSONB — a `layers.md` violation.

This cutover fixes all four together because they touch the same files and the same SQL.

---

## 2. Target behavior (user-facing)

- A new top-level **Authors** destination in the left nav, a peer of Libraries (primary slot), routing to `/authors`.
- `/authors` is a **faceted directory** of every contributor visible in my corpus:
  - Default order: **most-present first** (visible work count desc), then surname (`sort_name`) A–Z.
  - Alternate order: **A–Z by `sort_name`**.
  - Each row: display name, kind badge (person/org/group), disambiguation, status, and a **work-count pill**.
  - **Facets** (multi-select, URL-driven): role, kind, content kind, status — each with a count.
  - **Typeahead search** within the directory (reuses the existing contributor FTS/alias index).
  - Cursor pagination ("Load more").
  - Click a row → existing `/authors/{handle}` detail pane.
- The **detail pane gains curation** (curator-gated): manage aliases, manage external IDs, **split**, **tombstone**, and the new **merge into another contributor** (single-select picker). Duplicates are reconcilable where you notice them.
- **Bidirectional pivot:** author detail → "Search this author's works" deep-links to `/search?authors={handle}`; search/result contributor rows → author detail (already true via chips).
- A **merged** contributor's handle transparently resolves to its canonical survivor (authority-control "use X" redirect), with a subtle "formerly …" note.

Non-visible but required: ingest keeps writing credits as today; all identity writes are append-audited in `contributor_identity_events`.

---

## 3. Goals / Non-goals

### Goals
- G1. Ship the Authors **index pane** as a first-class entity-collection surface, peer of Libraries.
- G2. Implement contributor **merge** end-to-end (service + route + frontend + tests), with a correct transaction boundary and post-merge reingest stability.
- G3. **One owner** for contributor identity (`contributors.py`), **one** for the credit junction (`contributor_credits.py`), **one** leaf for taxonomy (`contributor_taxonomy.py`); fix the inversion and the raw-dict/`source_ref` leaks.
- G4. **One** contributor-visibility predicate and **one** podcast-visibility predicate in `auth/permissions.py`, consumed by `contributors.py`, `search.py`, `object_refs.py` (and every other inliner).
- G5. Remove cross-domain chat-table reads from `contributors.py` behind a chat-domain read predicate.
- G6. Make `contributors.sort_name` a **NOT NULL** invariant carried through migration, ORM, API schema, TS types, and the create seam.
- G7. One contributor-owned **handle→canonical-ID** resolver; all handle consumers filter by canonical IDs (merge-safe).

### Non-goals (explicit)
- N1. No generic tags/topics/subjects taxonomy. Contributor entity only.
- N2. No LLM/auto disambiguation or auto-merge. Merge is explicit and human-confirmed.
- N3. No surname-first `sort_name` parsing. Backfill = `display_name`.
- N4. No `pg_trgm`/fuzzy typeahead. ILIKE/FTS over the indexed `normalized_alias` suffices.
- N5. No author avatars / external bio enrichment.
- N6. No author "follow"/subscription or recommendations.
- N7. Not a `search.py` god-file split (separate cutover); only its contributor branch + shared predicates change.
- N8. No multi-user curator workflow.
- N9. **Provider accounts (X user, YouTube channel, Podcast Index, RSS, Gutenberg) are NOT promoted to identity keys** in this cutover (see D-EXT). They remain provenance/weak external IDs; cross-provider identity is reconciled by explicit merge only.

---

## 4. Architecture & final state

### 4.1 Final ownership map

| Concern | Sole owner (final) | Writes |
|---|---|---|
| **Contributor taxonomy** — role/kind/status/alias-kind vocab, external-id authorities (incl. STRONG subset), name/role normalizers | `services/contributor_taxonomy.py` *(new leaf, no DB)* | — |
| **Contributor identity** — resolve/create, merge, split, tombstone, aliases, external IDs, handle gen, canonical-ID resolution | `services/contributors.py` | `contributors`, `contributor_aliases`, `contributor_external_ids`, `contributor_identity_events` |
| **Credit junction** — link content↔contributor, replace-by-source, machine-vs-manual preservation | `services/contributor_credits.py` | `contributor_credits` |
| **Object links** — pin/link rewrites, self-link/dedup semantics | `services/object_refs.py` | `object_links` |
| **Contributor & podcast visibility predicates** | `auth/permissions.py` | (read-only SQL) |
| **"Contributor referenced in persisted chat context?"** | `services/chat_context_refs.py` *(new)* | (read-only) |

Dependency arrows (all one-directional, no cycles):

```
contributor_taxonomy.py  ◀── contributors.py ◀── contributor_credits.py
auth/permissions.py      ◀── contributors.py, search.py, object_refs.py
chat_context_refs.py     ◀── contributors.py            (tombstone safety)
object_refs.py           ◀── contributors.py            (split link-move only)
contributors.py          ◀── search.py                  (canonical-ID resolver, shared FTS expr)
```

**Note on object_links:** contributor identity does **not** DML `object_links`. Merge relies on canonicalization-on-read (§9). Split — which assigns specific links to a genuinely new identity — calls a narrow command on `object_refs.py` (the owner). This removes the boundary violation present in today's `split_contributor`.

### 4.2 Module before → after

**`contributor_taxonomy.py` (new leaf)** — owns `CONTRIBUTOR_ROLES`, `normalize_contributor_role`, `CONTRIBUTOR_KINDS`, `CONTRIBUTOR_RESOLUTION_STATUSES`, `CONTRIBUTOR_ALIAS_KINDS`, `CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`, `STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`, `CONFIRMED_ALIAS_SOURCES` (now incl. `"merge"`), `normalize_contributor_name`, `display_contributor_name`. Pure; no DB, no imports from sibling services.

**`contributor_credits.py`** — keeps `replace_*_contributor_credits` (×4), `load_contributor_credits_for_*`, `upstream_contributor_credit_previews_for_names`, `_previous_contributors_by_source_name`, preservation source sets. **Sheds** all identity resolution (569-859) and taxonomy constants. Imports taxonomy from the leaf and `resolve_or_create_contributor` from `contributors.py`. Builds a typed `ContributorResolutionInput` (below) per credit instead of passing a raw dict.

**`contributors.py`** — absorbs identity resolution as a **typed** public seam; gains `list_contributors`, `merge_contributor`, `resolve_canonical_contributor_ids`, `contributor_search_text_sql`, and the shared `run_identity_write` transaction helper. `get_contributor_by_handle` follows the merge chain. Switches to the shared visibility CTEs. `_persisted_contributor_ref_exists` (959-1000) **deleted** → `chat_context_refs`.

**`auth/permissions.py`** — new `visible_podcast_ids_cte_sql()` and `visible_contributor_ids_cte_sql()` (credit-OR-objectlink, the canonical definition); existing `visible_media_ids_cte_sql()` unchanged.

**`object_refs.py`** — drops its inline visibility CTEs (consume permissions.py); gains `repoint_contributor_object_links(db, *, link_ids, from_id, to_id)` (split's link move) and canonicalizes contributor refs on read (follow `merged_into`).

**`search.py`** — contributor branch consumes shared CTEs + `contributor_search_text_sql`; media/podcast/content branches filter by **canonical contributor IDs** from `resolve_canonical_contributor_ids` instead of raw handles.

**`chat_context_refs.py` (new)** — `contributor_is_referenced_in_persisted_context(db, contributor_id) -> bool`; sole reader of `message_*` / `chat_*` JSONB for contributor refs.

---

## 5. Consolidations (duplicate/repetitive patterns centralized)

| # | Duplication | Final single home |
|---|---|---|
| C1 | Identity resolution split from its entity (`contributor_credits.py:569-859`) | `contributors.py` |
| C2 | Three divergent contributor-visibility CTEs (`search.py`, `contributors.py`, `object_refs.py`) | `permissions.py:visible_contributor_ids_cte_sql()` |
| C3 | `visible_podcasts` CTE inlined in ≥6 files | `permissions.py:visible_podcast_ids_cte_sql()` |
| C4 | Contributor FTS `concat_ws(...)` expr in `search.py` + `contributors.py` | `contributors.py:contributor_search_text_sql()` |
| C5 | Cross-domain chat JSONB scan (`contributors.py:959-1000`) | `chat_context_refs.py` |
| C6 | Frontend role/kind/content-kind option lists (`AuthorPaneBody`, `SearchPaneBody`, new `AuthorsPaneBody`) | `apps/web/src/lib/contributors/vocab.ts` |
| C7 | Per-contributor visible-work-count (none today; modeled on `search.py` `credit_text` GROUP BY) | `contributors.py:list_contributors` |
| C8 | Taxonomy constants/normalizers scattered in `contributor_credits.py` | `contributor_taxonomy.py` (leaf) |
| C9 | Contributor-search typeahead duplicated debounce/fetch in `ContributorFilter` (and needed by merge picker) | `apps/web/.../contributors/useContributorSearch.ts` powering `ContributorFilter` (multi) + `ContributorPicker` (single) |
| C10 | Identity-write transaction handling (split/tombstone commit directly, no isolation) | `contributors.py:run_identity_write(...)` used by alias/external/split/tombstone/merge |

Each consolidation **deletes** the redundant copy — no aliasing re-exports.

---

## 6. Data model & migrations

**Merge needs no schema change** (fields exist). One migration:

### `migrations/alembic/versions/0138_contributor_sort_name_invariant_and_directory_index.py`
`down_revision = "0137"` (verified head: `0137_media_document_readiness_hard_cutover`).

```
upgrade():
  UPDATE contributors SET sort_name = display_name WHERE sort_name IS NULL;
  ALTER TABLE contributors ALTER COLUMN sort_name SET NOT NULL;
  CREATE INDEX ix_contributors_sort_name ON contributors (sort_name, id);  -- A–Z keyset
downgrade():
  raise NotImplementedError("Hard cutover: 0138 is not reversible")
```

**Carry the invariant through every layer (Finding 2):**
- ORM: `Contributor.sort_name: Mapped[str] = mapped_column(Text, nullable=False)` (`models.py:1149`).
- API schema: `ContributorOut.sort_name: str`, `ContributorSearchResultOut.sort_name: str`, `ContributorDirectoryEntry.sort_name: str` (drop `| None`). `ContributorAliasOut.sort_name` stays nullable (that is `contributor_aliases.sort_name`, a different, genuinely-optional column).
- TS: `ContributorSummary.sort_name: string`, directory entry `sort_name: string` (drop `| null`); alias keeps `sort_name?: string | null`.
- Create seam: after C1, the single contributor-create site sets `sort_name` non-empty (assert).

Composite index `(sort_name, id)` is for the **A–Z keyset cursor**, not typeahead (typeahead uses `ix_contributor_aliases_normalized_alias` + the FTS expr).

---

## 7. Capability contract (final signatures)

### `contributor_taxonomy.py` (leaf)
```python
CONTRIBUTOR_ROLES: frozenset[str]
STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES: frozenset[str]  # orcid,isni,viaf,wikidata,openalex,lcnaf
CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES: frozenset[str]         # STRONG ∪ {podcast_index,rss,youtube,gutenberg}
CONFIRMED_ALIAS_SOURCES: frozenset[str]                     # {manual, curated, user, merge}
def normalize_contributor_role(value: str | None) -> str: ...
def normalize_contributor_name(value: str) -> str: ...
```

### `contributors.py` — identity resolution (typed; called by credits)
```python
@dataclass(frozen=True)
class ContributorResolutionInput:
    credited_name: str
    role: str
    source: str
    ordinal: int | None = None
    explicit_handle: str | None = None
    explicit_id: UUID | None = None
    external_ids: tuple[ContributorExternalIdEvidence, ...] = ()  # STRONG-only used for identity
    provenance: Mapping[str, object] | None = None               # ex-`source_ref`; NEVER identity proof
    confidence: Decimal | None = None

@dataclass(frozen=True)
class ContributorResolution:
    contributor_id: UUID
    resolution_status: str  # external_id|manual|confirmed_alias|unverified

def resolve_or_create_contributor(db, item: ContributorResolutionInput) -> ContributorResolution: ...
def resolve_canonical_contributor_ids(db, handles: Sequence[str]) -> list[UUID]: ...  # follows merge chain
def unique_contributor_handle_for_name(db, normalized_name: str) -> str: ...
```

### `contributors.py` — reads
```python
def get_contributor_by_handle(db, contributor_handle, viewer_id=None) -> ContributorOut: ...  # follows merge
def list_contributors(db, *, viewer_id: UUID,
    q: str | None = None,
    roles: frozenset[str] = frozenset(), kinds: frozenset[str] = frozenset(),
    content_kinds: frozenset[str] = frozenset(), statuses: frozenset[str] = frozenset(),
    sort: Literal["works","name"] = "works",
    cursor: str | None = None, limit: int = 40,
) -> ContributorDirectoryPage: ...                              # opaque cursor (Finding 10)
def list_contributor_works(...) -> list[ContributorWorkOut]: ...
def search_contributors(...) -> list[ContributorSearchResultOut]: ...
def contributor_search_text_sql() -> str: ...                  # shared FTS expr (C4)
def hydrate_contributor_object_ref(...) -> HydratedObjectRef: ...  # follows merge
```

### `contributors.py` — writes (curator-gated, via `run_identity_write`)
```python
def run_identity_write(db, fn: Callable[[], T], *, retries: int = 3) -> T: ...  # SERIALIZABLE + retry (C10)
def add_contributor_alias / delete_contributor_alias / add_contributor_external_id /
    delete_contributor_external_id / split_contributor / tombstone_contributor (...) -> ContributorOut
def merge_contributor(db, *, actor_user_id, actor_roles=frozenset(),
    contributor_handle: str, request: ContributorMergeRequest) -> ContributorOut: ...  # source=path, target=body
```

### `permissions.py`, `object_refs.py`, `chat_context_refs.py`
```python
def visible_podcast_ids_cte_sql() -> str: ...
def visible_contributor_ids_cte_sql() -> str: ...
def repoint_contributor_object_links(db, *, link_ids, from_id, to_id) -> int: ...  # split only; dedup/self-link
def contributor_is_referenced_in_persisted_context(db, contributor_id: UUID) -> bool: ...
```

---

## 8. API design

### Routes (`api/routes/contributors.py`)
```
GET  /contributors/directory
  query: q?, roles?(csv), kinds?(csv), content_kinds?(csv), statuses?(csv),
         sort?(works|name, default works), cursor?(opaque), limit?(1..50, default 40)
  → ContributorDirectoryPage     (no curator gate; viewer-scoped by visibility)

POST /contributors/{contributor_handle}/merge            [curator]
  body: ContributorMergeRequest { target_handle: str }
  → ContributorOut (canonical target)
```
Unchanged: `GET /contributors` (typeahead), `GET /contributors/{handle}`, `/works`, alias/external-id add/delete, split, tombstone.

**Decision — separate `/directory` endpoint** (different envelope: counts+facets+pagination+sort). Consolidation is at the **predicate/FTS-expr** level, not the path.

### 8.1 Directory final SQL (defined before choosing the cursor — Finding 10)
```sql
WITH visible AS ( {visible_contributor_ids_cte_sql()} ),
     scoped AS (
       SELECT cc.contributor_id, cc.role,
              CASE WHEN cc.media_id IS NOT NULL THEN m.kind
                   WHEN cc.podcast_id IS NOT NULL THEN 'podcast'
                   ELSE 'gutenberg' END AS content_kind,
              COALESCE(cc.media_id::text, cc.podcast_id::text,
                       cc.project_gutenberg_catalog_ebook_id::text) AS work_key
       FROM contributor_credits cc
       JOIN visible v ON v.contributor_id = cc.contributor_id
       LEFT JOIN media m ON m.id = cc.media_id
     ),
     counts AS (SELECT contributor_id, COUNT(DISTINCT work_key) AS work_count FROM scoped GROUP BY 1)
SELECT c.id, c.handle, c.display_name, c.sort_name, c.kind, c.status, c.disambiguation, counts.work_count
FROM contributors c
JOIN counts ON counts.contributor_id = c.id
WHERE c.status NOT IN ('merged','tombstoned')
  {roles?:    AND EXISTS (SELECT 1 FROM scoped s WHERE s.contributor_id=c.id AND s.role = ANY(:roles))}
  {kinds?:    AND c.kind = ANY(:kinds)}
  {ckinds?:   AND EXISTS (SELECT 1 FROM scoped s WHERE s.contributor_id=c.id AND s.content_kind = ANY(:content_kinds))}
  {statuses?: AND c.status = ANY(:statuses)}
  {q?:        AND ( {contributor_search_text_sql()} @@ websearch_to_tsquery('english', :q)
                    OR EXISTS (SELECT 1 FROM contributor_aliases a
                               WHERE a.contributor_id=c.id AND a.normalized_alias ILIKE :q_prefix) )}
ORDER BY {sort}
```
- **`sort=name`** → `ORDER BY c.sort_name, c.id` → **keyset cursor** on `(sort_name, id)` (uses `ix_contributors_sort_name`).
- **`sort=works`** → `ORDER BY counts.work_count DESC, c.sort_name, c.id` → **offset cursor** (ordering on an aggregate; keyset not viable).
- Cursor is **opaque base64 JSON** (`{"k":"name","after":[sort_name,id]}` or `{"k":"works","offset":N}`); callers never construct it. Facet counts are a second aggregate over `scoped` across the full visible set.

### Schemas (`schemas/contributors.py`) — new
`ContributorMergeRequest{target_handle}`, `ContributorDirectoryEntry{handle,href,display_name,sort_name:str,kind,status,disambiguation,work_count,roles[],content_kinds[]}`, `FacetCount{value,count}`, `ContributorDirectoryFacets{roles[],kinds[],content_kinds[],statuses[]}`, `ContributorDirectoryPage{entries[],facets,page:{has_more,next_cursor}}`.

---

## 9. Merge semantics (algorithm + transaction boundary)

Curator-gated. Runs inside `run_identity_write` (Finding 3): set SERIALIZABLE before first SQL, `SELECT … FOR UPDATE` the source and target contributor rows **in stable id order** (deadlock-safe), mutate, commit; on serialization failure rollback and retry (bounded, reload by handle each attempt).

```
merge_contributor(source_handle, target_handle):
  require_curator(actor_roles)
  run_identity_write(db, lambda: _do_merge(...))

_do_merge:
  source = lock_active_by_handle(source_handle)        # FOR UPDATE; rejects merged/tombstoned
  target = lock_active_by_handle(target_handle)        # FOR UPDATE
  reject if source.id == target.id

  # 1. CREDITS: repoint, dedup by (work, role, normalized_credited_name).
  for cc in credits(source):
      if target has equivalent: delete cc else cc.contributor_id = target.id

  # 2. ALIASES: repoint, dedup by (normalized_alias, alias_kind); demote moved primaries.
  for al in aliases(source): al.is_primary=False; (delete if dup on target else repoint)

  # 3. CONFIRMED MERGE-ALIAS (Finding 8): ensure target has an alias for source.display_name
  #    with source="merge", alias_kind="search", is_primary=False (idempotent).
  #    "merge" ∈ CONFIRMED_ALIAS_SOURCES, so future name-only ingest resolves to target.

  # 4. EXTERNAL IDS: repoint, dedup by UNIQUE(authority, external_key). (Differing keys coexist; see R3.)

  # 5. NO object_links write here. Canonicalization-on-read (object_refs + hydrator + visibility) maps
  #    source→target via merged_into. (Boundary: object_links owned by object_refs.py — Finding 4.)

  # 6. FLATTEN: UPDATE contributors SET merged_into_contributor_id=target.id WHERE merged_into_contributor_id=source.id

  # 7. DEPRECATE: source.status='merged'; source.merged_into_contributor_id=target.id; source.merged_at=now(); target.updated_at=now()
  # 8. AUDIT: ContributorIdentityEvent(event_type='merge', source, target, payload={counts...})
  return _contributor_out(target)
```

**Resolution-follows-merge (Finding 6).** `get_contributor_by_handle`, `hydrate_contributor_object_ref`, the object_links read path, and `resolve_canonical_contributor_ids` follow `merged_into_contributor_id` (depth-guarded ≤8) to the canonical survivor. All handle-based filters (search media/podcast/content branches at `search.py:_search_media`/`_search_podcasts`/`_search_content_chunks`) resolve handles → canonical IDs first, then filter `c.id = ANY(:contributor_ids)`. Persisted chat-context refs stay pointed at the old id but hydrate to canonical.

**External-ID identity policy (Finding 9 / D-EXT).** During resolution, only `STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES` evidence asserts identity. Provider IDs (`podcast_index/rss/youtube/gutenberg`) and `provenance` (ex-`source_ref`) are recorded for display/lineage but never collapse identities. The credit-write path passes STRONG evidence in `ContributorResolutionInput.external_ids` and everything else in `provenance`. `_extract_external_id`'s "append whole `source_ref`" behavior is removed.

---

## 10. Visibility model (unified)

`permissions.py:visible_podcast_ids_cte_sql()` = `subscriptions(active) ∪ library_entries(member)`.
`permissions.py:visible_contributor_ids_cte_sql()` = contributors with a credit on `{visible_media ∪ visible_podcasts ∪ gutenberg}` **∪** viewer-owned `object_links` of type `contributor` (canonicalized through `merged_into`).

**Decision — visible = credit OR viewer object-link** (adopts `contributors.py`'s broader, correct definition; fixes `search.py`'s omission). Consumed by `contributors.py`, `search.py`, **`object_refs.py`** (Finding 5). The `subscriptions ∪ library_entries` shape is also inlined in `media.py`, `playback_queue.py`, `library_entries.py`; repoint every byte-identical copy and surface any that legitimately differ. Work count = `COUNT(DISTINCT work_key)` over the scoped credits.

---

## 11. Frontend

### Routing & registration
- `paneRouteModel.ts`: add `"authors"` to `PaneRouteId` with `defaultLabel: "Authors"`, `labelMode: "static"`, and a section-header contract owned by the Authors destination (segment-count disambiguates from `["authors", ":handle"]`).
- `paneRouteTable.ts`: add the `UsersRound` icon metadata; the route model's
  typed section-header contract supplies Authors identity.
- `paneRenderRegistry.tsx`: `authors: () => import("@/app/(authenticated)/authors/AuthorsPaneBody")`.
- **`app/(authenticated)/authors/page.tsx`** (new route marker — top-level entities require one; cf. `libraries/page.tsx`, `podcasts/page.tsx`). (Finding 11)
- `navModel.ts`: insert after Libraries, `slot:"primary"`, `icon:UsersRound`, `match:{exact:["/authors"],prefix:["/authors/"]}`.
- **No `paneServerLoaders` entry** — the directory is filter/facet-driven, so it is **client-fetched like `/browse` and `/search`** (which are intentionally not prefetched). (Finding 12)

### BFF proxy routes (new — Finding 11)
- `app/api/contributors/directory/route.ts`
- `app/api/contributors/[handle]/merge/route.ts`

### Resource (new — Finding 11)
- `lib/api/resource.ts`: `contributorDirectoryResource` (`clientPath: () => "/api/contributors/directory"`, server path unused since client-fetched).

### Pane bodies
- `app/(authenticated)/authors/AuthorsPaneBody.tsx` (new): `useResource` → `fetchContributorDirectory(params)`; **facet/sort/query state lives in the URL** via `usePaneSearchParams` + `usePaneRouter.replace(buildAuthorsHref(...))` (a small `useUrlMultiSelect` helper) — **not `useStringIdSet`** (which is ephemeral). Rows via `AppList`/`AppListItem` with a work-count `<Pill>`; "Load more" on `page.has_more`; `<PaneLoadingState>`/`<FeedbackNotice>`.
- `app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`: add curator section — alias/external-id add+delete, split, tombstone, and **merge** via a new single-select **`ContributorPicker`** (Finding 12) in a `useDialogOverlay` dialog → `mergeContributor(source, target)` → navigate to canonical. Add "Search this author's works" → `/search?authors={handle}`. "formerly …" note when the loaded handle was merged.

### Components / hooks
- `lib/contributors/useContributorSearch.ts` (new): debounced `fetchContributors`; powers both `ContributorFilter` (multi) and `ContributorPicker` (single). (C9)
- `lib/contributors/vocab.ts` (new): role/kind/content-kind option lists + labels; consumed by `AuthorsPaneBody`, `AuthorPaneBody`, `SearchPaneBody` (replacing its inline lists). (C6)
- `lib/contributors/api.ts`: add `fetchContributorDirectory`, `mergeContributor`, and the curation fetchers (`add/deleteContributorAlias`, `add/deleteContributorExternalId`, `splitContributor`, `tombstoneContributor`) — backend routes already exist; only these client fetchers are missing.
- `lib/contributors/types.ts`: `ContributorDirectoryEntry/Facets/Page`, `FacetCount`; `ContributorSummary.sort_name: string` (Finding 2).

---

## 12. How it composes with other systems

- **Search.** Shares the visibility predicate, FTS expr, and the canonical-ID resolver; the pivot deep-links to `/search?authors=…`.
- **Libraries.** Visibility derives from library membership/closure (`visible_media_ids_cte_sql`); the directory is a *people lens* over the same corpus.
- **Notes / object_links.** A pinned contributor is directory-visible without a credit; merge keeps links valid via canonicalization; split moves links through the object_links owner.
- **Chat.** Persisted refs are immutable; merge leaves a redirect; the only chat-table read (tombstone safety) is owned by the chat domain.
- **Ingest.** Unchanged externally; resolves identity via the typed `resolve_or_create_contributor`; the confirmed merge-alias prevents post-merge re-duplication.

---

## 13. Key decisions

- **D1.** Label "Authors"; entity stays `Contributor`; role is a facet.
- **D2.** Peer of Libraries, not under Browse (acquisition vs corpus-navigation).
- **D3.** Separate `/directory` endpoint; consolidate at predicate/FTS level.
- **D4.** Merge = redirect, **not** delete or object_links-rewrite; canonicalization-on-read everywhere.
- **D5.** Visible = credit OR viewer object-link (broader, correct), unified across all three callers.
- **D6.** `sort_name` NOT NULL, carried through migration→ORM→schema→TS→seam.
- **D7.** Identity resolution moves to `contributors.py` with a **typed** input/result; taxonomy is a leaf both depend on.
- **D-EXT.** Only STRONG authority files assert identity; provider IDs + `source_ref` are provenance. **X users / YouTube channels are not promoted** to identity keys now (N9) — a one-line change to `STRONG_…` if revisited.
- **D8.** Directory is **client-fetched** (no server loader), matching browse/search; facet state is URL-driven.
- **D9.** All identity writes go through `run_identity_write` (SERIALIZABLE + bounded retry + parent row locks) — including split/tombstone, which today commit directly.
- **D10.** `search.py` god-file split stays out of scope.

---

## 14. Rules / invariants (enforced)

- I1. `contributor_credits.py` issues no DML on identity tables; identity writes go through `contributors.py`.
- I2. Dependency arrows: `contributor_taxonomy` ← `contributors` ← `contributor_credits`; no module imports up.
- I3. Exactly one contributor-visibility and one podcast-visibility SQL definition (in `permissions.py`); grep finds no inline `podcast_subscriptions … UNION … library_entries` elsewhere.
- I4. `contributors.py` reads no `message_*`/`chat_*` table directly.
- I5. `contributors.sort_name` NOT NULL across DB/ORM/schema/TS; create seam sets it.
- I6. Every identity write appends a `contributor_identity_events` row and runs inside `run_identity_write`.
- I7. Curation routes enforce `_require_contributor_curator`.
- I8. Resolving any `merged` contributor yields its canonical survivor (depth-guarded); all handle filters use canonical IDs.
- I9. Identity is asserted only from STRONG external IDs; `source_ref`/`provenance` is never scanned for identity.
- I10. `object_links` is DML'd only by `object_refs.py`.

---

## 15. Acceptance criteria

- **AC1.** Nav shows **Authors** after Libraries; `/authors` opens the directory pane (client-fetched; no SSR prefetch).
- **AC2.** Directory lists visible contributors with correct visibility-scoped `work_count`; default sort works-desc then `sort_name`; A–Z toggle works; cursor paging returns stable, non-overlapping pages for both sort modes.
- **AC3.** Facets filter and show counts; selections are URL-encoded and survive reload; typeahead narrows.
- **AC4.** A contributor with no visible credit/object-link is absent; an object-link-only contributor is present (unified predicate, incl. `object_refs`).
- **AC5.** Row → `/authors/{handle}`; "Search this author's works" → `/search?authors={handle}` with results.
- **AC6.** Merge repoints credits/aliases/external-ids (deduped), writes a confirmed merge-alias for the source name, marks source `merged`→`merged_into=target`, flattens prior chains, writes a `merge` event, returns/navigates to canonical; re-opening the source handle resolves to target with "formerly …".
- **AC7.** Merge dedup: equivalent credit dropped not duplicated; duplicate `(authority, external_key)` dropped (no unique violation); merge runs under SERIALIZABLE and survives a simulated serialization conflict via retry.
- **AC8.** `object_links` rows are **not** modified by merge; a note pinned to the source still resolves (canonical) post-merge; split's link move goes through `object_refs.repoint_contributor_object_links`.
- **AC9.** Post-merge **name-only reingest** of the source's display name resolves to the canonical target (no new duplicate).
- **AC10.** Search/works filtering by a **merged** handle returns the canonical's works (canonical-ID resolution).
- **AC11.** Tombstone still blocks on a live reference, now via `chat_context_refs`.
- **AC12.** `0138` backfills `sort_name`, sets NOT NULL, adds `(sort_name,id)` index; ORM/schema/TS are non-nullable; `make test-migrations` green.
- **AC13.** Static: `pyright` include-list green; ESLint `--max-warnings 0`; guard tests for I2/I3/I4/I9/I10 pass.

---

## 16. Testing plan

- **Backend unit:** taxonomy normalizers; merge dedup helpers; cursor encode/decode (both modes); depth-guard.
- **Backend integration:** `list_contributors` (visibility AC4, counts, both sorts + cursors, each facet, facet counts); `merge_contributor` (repoint/dedup AC6/7, chain flatten, confirmed merge-alias, event, canonical resolution, reject self/merged/tombstoned, **serialization-retry** via injected conflict); **post-merge name-only reingest** (AC9); **merged-handle search/works filter** (AC10); tombstone via `chat_context_refs`; STRONG-only identity (provider IDs/`source_ref` do not collapse identities); guard tests — no `contributor_credits`→identity DML (I1), single visibility predicate incl. `object_refs` (I3), parity test that `search.py`/`contributors.py`/`object_refs.py` yield identical visible-contributor sets.
- **Frontend browser (.test.tsx):** `AuthorsPaneBody` render/filter/sort/paginate (URL state, fetch-boundary stub), row→detail; `AuthorPaneBody` merge dialog with `ContributorPicker` + "Search works" pivot; `ContributorPicker` single-select behavior.
- **E2E:** nav → directory → facet+search → open author → merge → source redirects.
- **Real-media:** ingest two sources crediting one name → both appear → merge → one canonical with combined works → reingest name resolves to canonical (no dup).

---

## 17. Negative gates (CI)

- Grep gates: zero inline `podcast_subscriptions`+`library_entries` visibility CTE outside `permissions.py`; zero `message_retrievals`/`message_tool_calls`/`chat_prompt_assemblies` reads outside `chat_context_refs.py`; zero `from nexus.services.contributor_credits import` in `contributors.py`; zero `from nexus.services.contributors import` in `contributor_taxonomy.py`; `object_links` INSERT/UPDATE/DELETE only in `object_refs.py`; no `source_ref`/`provenance` read inside `resolve_or_create_contributor`'s identity branch.
- Pyright include-list extended to `contributor_taxonomy.py`, `chat_context_refs.py`, new `contributors.py` symbols.
- ESLint: panes use `<MediaImage>`/`useIntervalPoll`; no barrels.

---

## 18. Slice sequence (ordered hard cutover)

0. **Taxonomy leaf.** Create `contributor_taxonomy.py`; move constants+normalizers out of `contributor_credits.py`; repoint both services. Import-direction guard (C8/I2).
1. **Visibility predicates.** Add `visible_podcast_ids_cte_sql` + `visible_contributor_ids_cte_sql` to `permissions.py`; repoint `contributors.py`, `search.py`, `object_refs.py` (+ other identical inliners); delete inline copies; parity + single-predicate guards (C2/C3/C4).
2. **Chat-ref ownership.** Add `chat_context_refs.py`; repoint `tombstone_contributor`; delete `_persisted_contributor_ref_exists` (C5).
3. **Identity ownership (typed).** Move resolution into `contributors.py` with `ContributorResolutionInput/Result`; STRONG-only identity; `contributor_credits.py` builds the typed input and imports down; inversion + STRONG guards (C1/I1/I9).
4. **Canonical-ID resolver.** Add `resolve_canonical_contributor_ids`; switch search media/podcast/content handle filters to canonical IDs; `get_contributor_by_handle`/hydrator follow merge (G7).
5. **Transaction helper.** Add `run_identity_write`; route alias/external/split/tombstone through it; split's link move → `object_refs.repoint_contributor_object_links` (C10/D9/I10).
6. **sort_name invariant.** Migration `0138`; ORM/schema/TS non-nullable; create-seam assert (G6).
7. **Merge backend.** `merge_contributor` + schema + `POST …/merge` + confirmed merge-alias + canonicalization; integration + serialization-retry + reingest tests (G2).
8. **Directory backend.** `list_contributors` + final SQL + cursor + facets + `GET /contributors/directory` (G1 backend).
9. **Frontend directory.** `vocab.ts`, `useContributorSearch`, resource, BFF route, `AuthorsPaneBody`, `page.tsx`, registries, nav (client-fetched, URL state).
10. **Frontend curation+merge+pivot.** `ContributorPicker`, curation section + merge dialog + "Search works" + "formerly" note.
11. **E2E + real-media + docs.** Full flows; update `architecture.md` §6/§7.6/§9 and `docs/modules/`.

---

## 19. Risks & edge cases

- **R1. Work-count cost.** Per-request aggregate; fine at single-user scale; materialized per-viewer count is a future move (`log` if ever capped).
- **R2. Merge-chain depth.** Flatten on merge (step 6) keeps depth 1; resolution guards ≤8; a cycle raises a defect.
- **R3. Two different keys for one authority after merge** (e.g. two ORCIDs) — coexist (only identical keys violate the unique constraint). Surface both in curation UI + event payload; do **not** add `UNIQUE(contributor_id, authority)` here.
- **R4. Curator role.** The single user must hold `admin`/`contributor_curator`; verify the seed grants it (do not relax the gate).
- **R5. `/authors` vs `/authors/{handle}`** — resolver disambiguates by segment count; explicit resolver test.
- **R6. Object-link-only contributors newly in `/search`** — intended (fixes a prior omission); note in the change log so it doesn't read as a regression.
- **R7. Podcast-CTE repoint reach.** `media.py`/`playback_queue.py`/`library_entries.py` also inline the podcast CTE; repoint only byte-identical copies, surface any semantic divergence rather than forcing it.
- **R8. Provider-identity decision (D-EXT).** Declining to promote X/YouTube means same provider account ingested under two display-name spellings stays two contributors until merged. Accepted for a single-user prototype; revisit by adding to `STRONG_…`.

---

## 20. Files touched (explicit)

**Backend**
- `migrations/alembic/versions/0138_contributor_sort_name_invariant_and_directory_index.py` *(new; down_revision 0137)*
- `python/nexus/db/models.py` *(`Contributor.sort_name` → NOT NULL)*
- `python/nexus/services/contributor_taxonomy.py` *(new leaf)*
- `python/nexus/auth/permissions.py` *(+2 CTE builders)*
- `python/nexus/services/contributors.py` *(absorb typed resolution; +`list_contributors`, `merge_contributor`, `resolve_canonical_contributor_ids`, `contributor_search_text_sql`, `run_identity_write`; follow-merge reads; drop chat scan)*
- `python/nexus/services/contributor_credits.py` *(shed identity+taxonomy; build typed input; import down)*
- `python/nexus/services/object_refs.py` *(consume shared CTEs; +`repoint_contributor_object_links`; canonicalize on read)*
- `python/nexus/services/chat_context_refs.py` *(new)*
- `python/nexus/services/search.py` *(contributor branch → shared predicates/FTS; handle filters → canonical IDs)*
- `python/nexus/api/routes/contributors.py` *(+`/directory`, +`/merge`)*
- `python/nexus/schemas/contributors.py` *(+merge/directory/facet models; `sort_name: str`)*
- `python/nexus/services/{media,playback_queue,library_entries}.py` *(repoint identical podcast CTE — verify)*
- `python/tests/test_contributors*.py`, `test_search*.py`, `test_object_refs*.py`, migration test *(new/updated)*

**Frontend (`apps/web/src`)**
- `lib/panes/paneRouteModel.ts`, `paneRouteTable.ts`, `paneRenderRegistry.tsx` *(+`authors` index; no server loader)*
- `app/(authenticated)/authors/page.tsx` *(new route marker)*
- `app/api/contributors/directory/route.ts`, `app/api/contributors/[handle]/merge/route.ts` *(new BFF proxies)*
- `lib/api/resource.ts` *(+`contributorDirectoryResource`)*
- `components/appnav/navModel.ts` *(+Authors)*
- `lib/contributors/api.ts`, `types.ts` *(+directory/merge/curation fetchers & types; `sort_name: string`)*
- `lib/contributors/vocab.ts`, `lib/contributors/useContributorSearch.ts` *(new — C6/C9)*
- `components/contributors/ContributorPicker.tsx` *(new single-select — Finding 12)*; `ContributorFilter.tsx` *(reuse `useContributorSearch`)*
- `app/(authenticated)/authors/AuthorsPaneBody.tsx` *(new)* + `.test.tsx`
- `app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx` *(+curation/merge/pivot)* + tests
- `app/(authenticated)/search/SearchPaneBody.tsx` *(use shared vocab)*
- `e2e/` *(authors directory + merge flow)*

**Docs**
- `docs/architecture.md` (§6, §7.6, §9), `docs/modules/` (contributor ownership map), this file.

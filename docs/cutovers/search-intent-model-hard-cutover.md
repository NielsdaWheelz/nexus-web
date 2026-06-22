# Search Intent-Model Hard Cutover

**Status:** BUILT + verified + reviewed/hardened (2026-06-07), all 9 slices · **Rev 2** · 2026-06-05

> **Build note (2026-06-07).** All slices implemented and verified. **S0** result-type authority + `search/kinds.py`; **S1** `scope_filter_sql(scope, entity)` + the §4.6 matrix as the single scope→SQL owner (`UNSUPPORTED` sentinel; all 10 retrievers refactored to consume it; every cell carried over verbatim and pinned by `test_search_scope_matrix.py`); **S2** the `services/search.py` god file → an 18-module `services/search/` package; **S3** hybrid invariant — `semantic` axis deleted at every layer incl. DB column, SSE field, and all four `message_tool_calls` writers; **S4** `SearchQuery` value object + route parsing + route-edge 400 on deleted params + implied-kind + strict role/format validation; **S2′** migration `0140` drops `message_tool_calls.semantic`; SSE producers + TS consumer scrubbed; `filters` keys → `formats`/`authors`; **S5–S7** the `lib/search` query model + operator parser + six-kind `SearchPaneBody` + pressable `Chip` + palette unification + score-label removal; **S8** 11 source-scanning gate guards + the scope-matrix test, FE unit + browser tests, `docs/architecture.md` §7.6/§8.9, the authors `/search?authors=` deep-link, and the real-media E2E seed. **Verified:** backend integration **145 + 152 passed**, backend unit **859 passed** (+ 11 guards + 48 matrix/cell), FE typecheck/lint/css-tokens clean, FE unit **111 passed**, browser **14 passed**. `make test-back-integration` (whole suite), `make test-e2e`, and `make test-csp` not run; work is uncommitted.
> **Review/hardening pass (2026-06-07).** A 10-cluster adversarial review (completeness + standards + consolidation vs `docs/rules/`) surfaced fixes, all applied + verified: **consolidation** — `visible_conversation_ids_cte_sql` moved to its canonical owner `auth/permissions.py` (beside its 3 siblings + `can_read_conversation`); one `scope_from_uri` shared by the route + chat tool; `_scoped_content_chunk_empty_status` now consumes the §4.6 `scope_filter_sql`; `_csv_frozenset` → `parse_comma_list`; `DEFAULT_LIMIT` centralized; four query validators share `_dedup`/`_validate_dedup`; package `__init__` re-exports trimmed; FE operator parser consumes `contributors/vocab.ts` (`CONTRIBUTOR_ROLES`). **Dead code** — deleted `validate_result_types`, `SEARCH_SCOPE_PREFIXES`, `VALID_FORMATS`, telemetry's `types is None` branch, the orphan `.score` CSS + `conversation.py` comment, the `'podcasts'` plural alias. **Correctness** — palette "See all" now serializes the `SearchQuery` (`searchHref(searchQueryFromInput(...))`) instead of dumping operators into `q=`; `Chip` pressable branch forwards its ref + rest props; authors render once (ContributorFilter, display names) not twice; `_search_type`'s unreachable branch raises `E_INTERNAL` not a 400. **Tests/gates** — added `effective_kinds`/validator unit tests (`test_search_kinds.py`, 72), `search_scopes` behavior (`test_search_batch.py`, 6), FE `searchApi`/`normalizeSearchResult`/`Chip`/`AppliedFilters`/`SearchPaneBody` tests, the AC-6 filter-doesn't-bypass-embedding test, implied-kind + out-of-vocab-400 + 4-key deleted-param 400 integration tests, the 0140 column-drop migration test, and §14 gates for `e2e/tests/**` + `docs/**` + palette + the `MessageToolCall` DDL. **e2e** fully migrated to the six-kind surface (`search.spec.ts`, `real-media-seed.ts`, `security-headers.csp.spec.ts`, `workspace-pane-minimize.spec.ts`). **Note (not a bug):** the chat `app_search` tool's `filters["formats"]` carries **storage** values (web_article/podcast_episode — the renamed internal `content_kinds`), not the public `MediaFormat` vocab, so it is fed to retrievers as-is and must NOT be remapped through `FORMAT_TO_STORAGE`. **Verified:** backend integration 158 (search/contributor/app_search/chat/citations) + migrations green; backend unit 132 (guards/kinds/batch/matrix); FE typecheck/lint clean, 106 unit + 20 browser. `make test-e2e`/`test-csp` still not run; uncommitted.

**Type:** Hard cutover — no legacy code, no fallbacks, no backward-compat shims, no dual param sets.
**Migration:** Yes — `0140_drop_message_tool_calls_semantic.py` drops
`message_tool_calls.semantic`. Downgrade raises `NotImplementedError` because
this is a hard cutover; the migration docstring records the manual re-add shape.

## One-line

Replace the search UI's **schema-leaking 29-checkbox filter wall** (14 result-`types` + 9 `roles` + 6 `content_kinds`) with a **six-kind intent model + operator-backed filter chips**, unify the `/search` page and the command-palette `@` lane onto **one query model**, make **hybrid retrieval an invariant** (delete the `semantic` flag and its filter-bypass), and collapse the duplications this exposes — one kind taxonomy, one result-type authority, one scope owner, one multi-scope executor — shipped as one hard cutover.

## Rev 2 — review resolutions (changelog)

| # | Review finding | Resolution in this rev |
|---|---|---|
| 1 | **Not migration-free.** `message_tool_calls.requested_types`/`semantic` persist (`models.py:4361,4366`); SSE requires `types`+`semantic` (`conversation.py:293–294`); `app_search` writes them (`app_search.py:563`). | Real migration: **drop `message_tool_calls.semantic`** (now a constant) + drop SSE `semantic` field. **Keep `requested_types`** (+ SSE `types`) recording the *resolved internal result types*. SSE `filters` keys rename. §6.3, §6.4, §8.2, §11, S2′. |
| 2 | **Old params silently broaden stale links.** `/api/search` proxies the raw query string (`route.ts:8`, `proxy.ts:310`); FastAPI ignores unknown params. | **Route-edge rejection:** the FastAPI handler inspects `request.query_params` and **400s** on any deleted key (`types`/`content_kinds`/`contributor_handles`/`semantic`). §6.2, AC-5, test plan. |
| 3 | **N6 fallback violates hard-cutover** (`cleanliness.md:3`). "Consume whatever exists" is dual ownership. | Removed. **Hard prerequisite P-1:** the authors cutover's visibility-CTE-→`permissions.py` slice and canonical-handle-resolver slice land first (extractable independently). No fallback; no new CTE copies. §0, §3 N6, §8.4. |
| 4 | **`kinds: empty ⇒ all` is a footgun.** Current code distinguishes omitted from explicit-empty (`search.py:99–117`; tested `test_search.py:1091`). | `SearchQuery.requested_kinds: frozenset \| None`. **`None` (omitted) ⇒ all; explicit empty ⇒ no results** (preserve tested semantics); invalid kind ⇒ 400. §4.5, §5.1. |
| 5 | **Role taxonomy ownership/validation wrong.** Vocab owned by `contributor_credits.CONTRIBUTOR_ROLES` (12 roles incl. `publisher`/`organization`/`unknown`); invalid → `unknown` (`contributor_credits.py:73`). | Search **consumes contributor taxonomy** (the authors cutover's `contributor_taxonomy.py`, P-1); defines no role vocab. Filter validation **rejects** out-of-vocab roles (400) — query is strict, unlike lenient ingestion-normalization. §3 N4, §4.4, §5.4. |
| 6 | **`formats` ≠ rename of `content_kinds`.** `MediaKind = {web_article, epub, pdf, video, podcast_episode}` (`models.py:90`); podcasts are a separate table; Gutenberg is a credit field, not a kind. | `search/kinds.py` owns an explicit **`MediaFormat` → storage-target** map (incl. `podcast` → `podcasts` table; `episode`→`podcast_episode`; `article`→`web_article`). **Gutenberg dropped** from the format vocab (provenance, not format). §4.4a, §5.4. |
| 7 | **`app_search` is under-modeled.** It takes a scope **list**, resolves conversation refs, unions per-scope, dedupes, has empty-status behavior (`app_search.py:363`). | New first-class **`search/batch.py` `search_scopes(...)`** owns the per-scope union/dedupe/sort/cap (moved out of `app_search`). Chat keeps ref-resolution + empty-status (chat-domain). §5.6, §8.2. |
| 8 | **Scope consolidation needs a compatibility matrix.** Per-type rules differ (podcast/message reject `media:`; fragment rejects `conversation:`; message/web use share semantics). | `scope_filter_sql(scope, entity)` returns a typed **`UNSUPPORTED`** sentinel; an explicit, **tested scope×entity matrix** (§4.6) preserves every current rule. |
| 9 | **Result-type authority undercounted.** Runtime `ALL_RESULT_TYPES` (`search.py:101`); FE `ALL_SEARCH_TYPES` is also the result-discriminant validator (`types.ts:4`). | Canonical **runtime `ALL_RESULT_TYPES` stays beside `SEARCH_RESULT_TYPES`**; FE list is **renamed `RESULT_TYPE_VALUES`** (kept for `normalizeSearchResult`), only its *filter* use removed. §7.1, §9. |
| 10 | **Chip/Tabs not accessible as written.** `Chip` is a `<div>` (`Chip.tsx:21`); `Tabs` is single-value (`Tabs.tsx:33`). | Extend **`Chip` to a pressable button mode** (`pressed`/`onPressedChange` → `<button aria-pressed>`); `KindChips` uses it. No claim that `Tabs` gives multi-select. §7.3. |
| 11 | **Test/docs migration incomplete.** Real-media E2E builds `/search?types=…&content_kinds=…` (`real-media-seed.ts:530`); authors spec deep-links `contributor_handles` (`authors…md:65`). | Grep gates + tests expanded to **`e2e/tests/**`, `docs/**`, SSE/chat TS contracts, real-media seeds.** §14, §15, §16. |
| 12 | **Stale path refs.** Route is `python/nexus/api/routes/search.py:28`. Score-label removal spans adapter + row + tests (`SearchResultRow.tsx:42`). | Paths corrected throughout; score-label removal owners = `searchViewModel.ts` + `SearchResultRow.tsx:42` + tests. §7.3, §16. |

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** The **visibility-predicate consolidation** (`visible_media` / `visible_conversation` / `visible_podcasts` CTEs → `auth/permissions.py`) and the **canonical contributor-handle resolver** + **`contributor_taxonomy.py`** (role/kind vocab owner) — i.e. **authors-directory cutover G4/G7 and its taxonomy leaf** — must land **before** this cutover's S3–S5. They are extractable as a standalone slice ahead of the full authors feature. This cutover **consumes** those owners and introduces **no** new CTE copies and **no** search-local role vocabulary. If P-1 is not yet landed, this cutover is **blocked** on it (no interim dual-ownership path).

> Rationale: the search retriever rewrite (S2) mechanically touches every site that inlines those CTEs and every site that filters by raw handle/role; doing so against canonical owners is the only hard-cutover-clean option. Owning identity/visibility *here* would invert entity ownership (contributor identity belongs to the contributor entity), so it is a prerequisite, not absorbed.

---

## 1. Problem

### 1.1 The UI exposes the database schema as the filter taxonomy

`apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx` renders **four** filter groups as raw checkbox `<fieldset>`s:

- **14 result-`type` checkboxes**, all default **ON** (`SearchPaneBody.tsx:38–53`): Authors, Media, Podcasts, Episodes, Videos, **Evidence** (`content_chunk`), **Fragments** (`fragment`), **Pages** (`page`), Notes (`note_block`), Highlights, Messages, **Evidence spans** (`evidence_span`), Conversations, Web.
- **9 `role` checkboxes**, default **OFF** (`SearchPaneBody.tsx:55–65`): Authors, Editors, Translators, Hosts, Guests, Narrators, Creators, Producers, Channels.
- **6 `content_kind` checkboxes**, default **OFF** (`SearchPaneBody.tsx:67–74`): Articles, PDFs, EPUBs, Videos, Episodes, Podcasts.
- A contributor combobox-with-chips (`ContributorFilter.tsx`) — the one well-built control here.

The 14 `types` are the backend's result-union tables (`schemas/search.py:23`). `content_chunk` vs `fragment` vs `evidence_span`, and `page` vs `note_block`, are **retrieval-granularity / storage distinctions**, not user intents. This schema leak is the root cause; every other defect is downstream of it.

### 1.2 Concrete defects (all caused by 1.1)

1. **Cross-group overlap.** "Videos"/"Episodes" each appear in **two** groups (a `type` and a `content_kind`); "Authors" appears in **two** (a `type` and a `role`). The `type`/`role` "Authors" duplication is the worst: `type=contributor` returns author **rows**, while `role=author` filters **other** content to a chosen author — two unrelated operations sharing a label.
2. **Mechanism-named labels.** "Evidence" = `content_chunk`, "Evidence spans" = `evidence_span`, "Fragments" = reader source fragments.
3. **Inconsistent defaults** (`types` ON, `roles`/`content_kinds` OFF), no select-all/none, no applied-filter summary.
4. **Filter-only search is blocked** by the submit disable logic (`SearchPaneBody.tsx:358–364`) though the backend supports it.
5. **Incompatible combinations are allowed** (e.g. "Notes" + "PDFs"), silently returning confusing results.

### 1.3 Two divergent search surfaces

The palette `@` lane runs the **same** backend (`usePaletteController.ts:166–172`) but hardcodes all-types, **no filters**, `limit: 5`. Page and palette share a view model but not a query model.

### 1.4 The `semantic` flag silently downgrades quality

`services/search.py:768–779` builds the query embedding only when `content_chunk` is requested **or** (no structured filters **and** `page`/`note_block` requested). So adding **any** filter silently drops notes/pages to keyword-only. Retrieval mode is an invisible side effect of an unrelated filter.

### 1.5 The contract is **not** purely HTTP — chat telemetry persists it

`message_tool_calls` persists **`requested_types` (JSONB)** and **`semantic` (Boolean)** per tool call (`models.py:4361,4366`); the started/updated SSE payload `ChatRunToolCallEventPayload` requires **`types: list[str]`**, **`semantic: bool`**, and **`filters: dict`** (`conversation.py:293–295`); `app_search` writes all of these (`app_search.py:563`). Removing the `semantic` axis and renaming filter keys is therefore a **DB + SSE + chat-UI** change, not just an HTTP one (see §6.3–§6.4, §11).

### 1.6 Old links would silently broaden, not fail

`/api/search` forwards the raw query string verbatim (`apps/web/src/app/api/search/route.ts:8` → `proxyToFastAPI` → `proxy.ts:310`). FastAPI `Query(default=…)` **ignores unknown params**, so a stale `/search?types=note_block` would, post-rename, search *everything* — a silent semantic change. The contract must **reject** deleted keys (§6.2).

### 1.7 Duplications the contract change exposes

- **Three+ taxonomy authorities for the same 14 types**: FE `ALL_SEARCH_TYPES` (`lib/search/types.ts:4`), backend `SEARCH_RESULT_TYPES` (Literal) **and** runtime `ALL_RESULT_TYPES` (`search.py:101`), and the verbatim-duplicate `APP_SEARCH_RESULT_TYPES` (`schemas/conversation.py:32`).
- **Scope-to-SQL repeated 9+ times** with per-type variations; `parse_scope` (`search.py:483`) and `hash_query` (`search.py:460`) leaked into `app_search`.
- **Multi-scope union/dedupe lives in `app_search`** (`_search_across_scopes`, `app_search.py:363`) instead of the search domain.
- **`resultRowAdapter.ts` mixes HTTP transport + view-model** (audit `fe-search`).

This cutover fixes the UX defect and the duplications together because they live in the same files and the same contract.

---

## 2. Target behavior (user-facing)

**One search box. Searches everything by default. Refine after, never before.**

- A single input (`/search` and palette `@`) queries **all six kinds** by default. No precondition, no submit button — debounced live search (200 ms).
- **Six kind chips** — **Documents, Notes, Highlights, Conversations, People, Web** — under the box as a multi-select row, all active by default. Narrowing is one click; the rest stay one click away.
- **Refinements are removable chips**, added three ways, all compiling to the *same* visible chips:
  1. **Typed operators**: `format:pdf`, `author:le-guin`, `role:translator`, `in:library:<id>` (deterministic, no LLM).
  2. **A "+ Filter" overflow** (`ActionMenu`) for formats/authors.
  3. **The existing agentic `?` ask lane / chat** for natural language — unchanged; that path already extracts structured filters.
- **Applied filters render as a removable chip bar above results**, per-chip remove + **Clear all**.
- **Incompatible kinds disable themselves** when a media-only filter is active: `format:pdf` / `author:…` collapses effective scope to the supporting kinds and greys the rest with a reason ("PDFs are documents"). "Notes + PDFs" is unrepresentable.
- **Retrieval mode is invisible.** No keyword/semantic control; hybrid always; filters never change the mode.
- **Zero-results keeps the editable query** and, when filters are active, leads with **Clear filters / broaden**.
- Results, deep-links, and citations render exactly as today (`SearchResultRow`, `SearchResultRowViewModel`); the dev-only `score 0.42` label is removed.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Replace the 14-`type` / 9-`role` / 6-`content_kind` checkbox wall with a **six-kind intent model** + **operator-backed filter chips**; delete the old checkbox UI entirely.
- **G2.** One **`SearchQuery`** value object is the sole input to `search()`; the HTTP route and the chat tool both parse transport → `SearchQuery` at the edge.
- **G3.** Unify `/search` and the palette `@` lane on one frontend query model (`lib/search`): one parser, one fetch, one serializer.
- **G4.** **Hybrid retrieval is an invariant.** Delete the `semantic` axis (HTTP param, service arg, DB column, SSE field) and the filter-bypass; build the embedding **once**, feed every semantic-capable retriever regardless of filters.
- **G5.** **One kind taxonomy owner** (`search/kinds.py`): kind → internal result types, the `MediaFormat` → storage-target map, and filter↔kind compatibility.
- **G6.** **One result-type authority** — delete `APP_SEARCH_RESULT_TYPES`; `schemas/search.py` (`SEARCH_RESULT_TYPES` + runtime `ALL_RESULT_TYPES`) is canonical.
- **G7.** **One scope owner** (`search/scope.py`: `parse_scope` + `authorize_scope` + `scope_filter_sql` with a tested compatibility matrix); **one multi-scope executor** (`search/batch.py`); move `hash_query` to a logging util.
- **G8.** Split the 3,970-line `services/search.py` into a `services/search/` package, one concern per module.
- **G9.** **Distinguish omitted from explicit-empty kinds** and enforce **implied-kind compatibility** in one place; illegal combinations are unrepresentable.
- **G10.** Reuse existing primitives (`Chip` extended to pressable, `ContributorFilter`, `ActionMenu`, palette family, `useStringIdSet`); add no new generic UI.

### Non-goals (explicit)

- **N1. Cross-encoder reranking.** `0089_retrieval_rerank_ledgers` tables are chat-execution tracing, unused by `search()` ranking. Search keeps FTS ∪ ANN + type-weighted normalization. A rerank stage is a separate cutover.
- **N2. Keyset pagination.** Offset cursor preserved.
- **N3. A synchronous LLM in the search box.** NL→filters stays on the agentic `?`/chat path. The box uses **deterministic operator parsing only** — cost/latency/determinism + honors *explicit-UI-over-automation*.
- **N4. Role vocabulary in search.** The 9-role grid is deleted. Role survives as an operator (`role:`) and an NL-extractable filter; its vocabulary is **owned by `contributor_taxonomy.py`** (P-1) and **consumed**, never redefined, by search. Search **rejects** out-of-vocab role operators (400).
- **N5. Answer-first / agentic search UI.** The `?` lane and chat-as-search are unchanged.
- **N6. Re-owning visibility predicates or canonical handle resolution.** Owned by the authors cutover (P-1); consumed here with no fallback.
- **N7. Embedding model/provider/dimension changes.** Unchanged (256-dim).
- **N8. Saved searches.** Out of scope (the `SearchQuery` is serializable, leaving room; no persistence ships).
- **N9. On-device / local indexing.** Out of scope.
- **N10. Gutenberg as a "format".** Gutenberg is provenance (a contributor-credit catalog id), not a media kind. Dropped from the format vocab; not replaced (a future `source:` operator could re-add it — not now).

---

## 4. Architecture & final state

### 4.1 Final ownership map

| Concern | Sole owner (final) | Notes |
|---|---|---|
| **Kind taxonomy** — six `SearchKind`s ↔ internal result types; `MediaFormat`→storage map; filter↔kind compatibility | `services/search/kinds.py` *(new leaf)* | The only place kind→type, format→storage, and implied-kind live. |
| **Result-type authority** — `SEARCH_RESULT_TYPES` (Literal) + runtime `ALL_RESULT_TYPES` | `schemas/search.py` | `APP_SEARCH_RESULT_TYPES` deleted; chat imports this. |
| **Search scope** — `parse_scope`, `authorize_scope`, `scope_filter_sql(scope, entity)` + compatibility matrix | `services/search/scope.py` *(new)* | Replaces 9+ inline branches; `UNSUPPORTED` sentinel. |
| **Multi-scope execution** — per-scope union/dedupe/sort/cap | `services/search/batch.py` *(new)* | Moved out of `app_search`. |
| **Query value object** — `SearchQuery`, `SearchScope`, normalization (`None`-vs-empty) | `services/search/query.py` *(new)* | One typed input. |
| **Query embedding gate** — build-once, capability decision | `services/search/embedding.py` *(new)* | No filter bypass. |
| **Ranking** — `TYPE_WEIGHTS`, per-type normalization, merge, window | `services/search/ranking.py` *(new)* | Behavior preserved; relocated. |
| **Projection** — `InternalSearchResult` → `SearchResultOut`, snippet truncate, source build | `services/search/projection.py` *(new)* | |
| **Cursor** — offset encode/decode | `services/search/cursor.py` *(new)* | |
| **Per-type retrievers** | `services/search/retrievers/*.py` *(new)* | media, library_content, objects, highlights, conversations, contributors, web. |
| **Orchestrator + durable-ref resolver** | `services/search/service.py` *(re-exported from `__init__`)* | Thin. |
| **Visibility CTEs / canonical handles / role+kind vocab** | `auth/permissions.py` / `services/contributors.py` / `services/contributor_taxonomy.py` | **Consumed (P-1), not owned.** |
| **Frontend query model** — `SearchQuery`, `parseSearchInput`, params, kinds, fetch, view-model | `apps/web/src/lib/search/*` | One owner for page + palette. |

### 4.2 Dependency arrows (one-directional, no cycles)

```
search/query.py     ◀── routes/search.py, agent_tools/app_search.py
search/kinds.py     ◀── search/service.py, search/embedding.py, search/scope.py
search/scope.py     ◀── search/retrievers/*, search/batch.py
search/batch.py     ◀── agent_tools/app_search.py
search/embedding.py ◀── search/service.py, search/batch.py
search/{ranking,projection,cursor,retrievers/*} ◀── search/service.py
auth/permissions.py, contributors.py, contributor_taxonomy.py ◀── search/*   (P-1, consume)
lib/search/*        ◀── search/SearchPaneBody.tsx, palette/usePaletteController.ts
```

### 4.3 The kind taxonomy — the spine (14 → 6)

| `SearchKind` (user) | Label | Internal result types folded in |
|---|---|---|
| `documents` | Documents | `media`, `episode`, `video`, `podcast`, `content_chunk`, `fragment`, `evidence_span` |
| `notes` | Notes | `page`, `note_block` |
| `highlights` | Highlights | `highlight` |
| `conversations` | Conversations | `conversation`, `message` |
| `people` | People | `contributor` |
| `web` | Web | `web_result` |

`podcast`/`episode`/`video` are **Documents**, distinguished by *format* (resolving the type↔content_kind overlap). `people` returns author rows; `author:` filters other kinds (resolving the type↔role overlap). The **media retriever's default exclusion** (`m.kind NOT IN ('podcast_episode','video')` when no format, `search.py:1697`) is preserved by the resolver so a plain Documents search does not double-count episodes/videos already returned by their own retrievers.

### 4.4 Filter dimensions = operators = chips (one system)

| Dimension | Operator | Chip | API param | Applies to kinds | Backed by (today) |
|---|---|---|---|---|---|
| Kind | `kind:documents` | kind chip (multi-select row) | `kinds` | — | `types` mapping |
| Format | `format:pdf` | format chip | `formats` | `documents` | `content_kinds` (remapped, §4.4a) |
| Author | `author:le-guin` | author chip (display name) | `authors` | `documents`, `people` | `contributor_handles` (canonical-resolved, P-1) |
| Role | `role:translator` | role chip (operator/NL only) | `roles` | `documents`, `people` | `roles` (taxonomy-owned, P-1) |
| Scope | `in:library:<id>` / context | scope chip (usually contextual) | `scope` | all | `scope` |

- **Canonical values:** `format` per §4.4a; `role` per `contributor_taxonomy.py` (P-1) — the FE emits a role chip **only** for taxonomy-known roles, else free text; the backend **rejects** out-of-vocab roles (400). `kind` aliases: `doc|docs→documents`, `note→notes`, `chat→conversations`, `person→people` (no `author` alias — `author:` is an operator).
- **Forgiving parse:** a token matching `^(kind|format|author|role|in):\S+` with a valid value becomes a chip; anything else (malformed operators, quoted phrases) stays free text passed as `q`.

### 4.4a `MediaFormat` → storage-target map (owner: `search/kinds.py`)

`MediaKind` enum is `{web_article, epub, pdf, video, podcast_episode}` (`models.py:90`); podcasts are a **separate `podcasts` table**. The public format vocab is clean; the owner maps it:

| Public `MediaFormat` | Storage target |
|---|---|
| `article` | `media.kind = 'web_article'` |
| `pdf` | `media.kind = 'pdf'` |
| `epub` | `media.kind = 'epub'` |
| `video` | `media.kind = 'video'` (`video` retriever) |
| `episode` | `media.kind = 'podcast_episode'` (`episode` retriever) |
| `podcast` | `podcasts` table (podcast retriever; **not** a `media.kind`) |

The old `content_kinds` accepted storage-ish values (`web_article`, `podcast_episode`, `podcast`) and string-aliases (`podcasts`, `gutenberg`/`project_gutenberg`) scattered across retrievers (`search.py:1694–1698, 1827–1828, 1989–1991, 2354–2368`). Those alias branches are deleted; the single map above is the only translation. **Gutenberg** (a `contributor_credits.project_gutenberg_catalog_ebook_id`) is **dropped** from formats (N10).

### 4.5 Omitted vs explicit-empty, and implied-kind (owner: `search/kinds.py` + `search/query.py`)

- `SearchQuery.requested_kinds: frozenset[SearchKind] | None`. **`None`** (param omitted) ⇒ **all kinds**. **Explicit empty** ⇒ **no results** (preserves `search.py:99–101` semantics and `test_search.py:1091`). Invalid kind value ⇒ **400** (preserves `test_search.py:1083`).
- **Implied-kind:** `formats` present ⇒ effective kinds = requested ∩ `{documents}`; `authors`/`roles` present ⇒ requested ∩ `{documents, people}`. Enforced server-side (intersection before dispatch) **and** mirrored in the UI (incompatible kind chips disabled with a reason). `effective_kinds` is computed once in `search/kinds.py`.

### 4.6 Scope × entity compatibility matrix (owner: `search/scope.py`; **required, tested**)

`scope_filter_sql(scope, entity)` returns either a `(sql, params)` fragment or the `UNSUPPORTED` sentinel (retriever yields `[]`). The matrix below is **authoritative and must be enumerated from the current retrievers** (confirmed cells shown; the builder fills the rest from existing code, inventing nothing) and covered by one test per cell:

| Entity (retriever) | `all` | `media:` | `library:` | `conversation:` |
|---|---|---|---|---|
| media / episode / video | ✓ | ✓ (anchor) | ✓ | per current |
| podcast | ✓ | **UNSUPPORTED** (`search.py:1854`) | ✓ | per current |
| content_chunk / evidence_span | ✓ | ✓ | ✓ | per current |
| fragment | ✓ | ✓ | ✓ | **UNSUPPORTED** (`search.py:2728`) |
| page / note_block / highlight | ✓ | per current | per current | per current |
| message | ✓ | **UNSUPPORTED** (`search.py:3051`) | **share-semantics** (`conversation_shares` where `sharing='library'`, `search.py:3054`) | ✓ |
| conversation | ✓ | per current | share-semantics | ✓ |
| web_result | ✓ | per current | **share-semantics** (`search.py:3310`) | ✓ |
| contributor | ✓ | per current | per current | per current |

"per current" = the cell's behavior in today's retriever, carried over verbatim and pinned by a test. No cell changes behavior in this cutover; the matrix only **centralizes and tests** what is today implicit.

---

## 5. Capability contract (backend service)

### 5.1 `SearchQuery` value object (`search/query.py`)

```python
SearchKind = Literal["documents", "notes", "highlights", "conversations", "people", "web"]
MediaFormat = Literal["article", "pdf", "epub", "video", "episode", "podcast"]

@dataclass(frozen=True, slots=True)
class SearchScope:
    kind: Literal["all", "media", "library", "conversation"]
    id: UUID | None = None  # None iff kind == "all"

@dataclass(frozen=True, slots=True)
class SearchQuery:
    text: str                                   # free text only; operators parsed out at the edge
    requested_kinds: frozenset[SearchKind] | None  # None ⇒ all; empty ⇒ none
    authors: tuple[str, ...]                     # canonical-resolved handles (P-1)
    formats: tuple[MediaFormat, ...]
    roles: tuple[str, ...]                       # validated against contributor_taxonomy (P-1)
    scope: SearchScope
    cursor: str | None
    limit: int                                   # 1..50

    @property
    def effective_kinds(self) -> frozenset[SearchKind]:  # None→all, then §4.5 implied-kind intersection
        ...
```

`query.py` owns the normalizers today scattered as `_normalize_result_types`/`_normalize_credit_roles`/`_dedup_strings` (`search.py:542–598`). Invalid kind/format ⇒ `InvalidRequestError(E_INVALID_REQUEST)` (400); roles validated against `contributor_taxonomy` (400 on out-of-vocab).

### 5.2 `search()` signature (single object param)

```python
# services/search/service.py  (re-exported from __init__)
def search(db: Session, viewer_id: UUID, query: SearchQuery) -> SearchResponse: ...
```

Orchestration: `effective_kinds` → `kinds.result_types_for(...)` → dispatch retrievers with the shared scope filter (§4.6) + (optional) embedding (§5.5) → `ranking.merge_and_window(...)` → `projection.to_response(...)`. Authorization via `scope.authorize_scope(...)` (404 on unauthorized — existence non-leak preserved).

### 5.3 `get_search_result()` — durable-ref resolver, contract preserved & typed

`get_search_result(db, viewer_id, result_type: SEARCH_RESULT_TYPES, result_id, evidence_span_ids)` moves to `service.py`; the bare-`str` param becomes the typed discriminant and the 13-branch positional-row chain (`search.py:861–1540`) becomes discriminant dispatch (audit `py-search` fix #5). Used by citation/object-ref resolution; behavior unchanged.

### 5.4 Kind / format / scope / role owners

- `kinds.result_types_for(kinds) -> tuple[ResultType, ...]`, `kinds.storage_target_for(format) -> StorageTarget`, `kinds.effective_kinds(query)`.
- `scope.parse_scope(raw) -> SearchScope`, `scope.authorize_scope(...)`, `scope.scope_filter_sql(scope, entity) -> tuple[str, dict] | UNSUPPORTED` (§4.6).
- `roles`: validated against `contributor_taxonomy` (P-1) at the edge; **rejected** if out-of-vocab (query is strict; ingestion's lenient `normalize_contributor_role`→`unknown` is **not** reused for filtering).
- `SEARCH_RESULT_TYPES` + runtime `ALL_RESULT_TYPES` (`schemas/search.py`) is the only result-type authority; `schemas/conversation.py` imports it; `APP_SEARCH_RESULT_TYPES` deleted.

### 5.5 Hybrid retrieval invariant

Delete the `semantic` parameter from the service, route, and `app_search`; delete the `search.py:768–779` conditional. `embedding.build_query_embedding(db, text)` is called **once** iff `text` is non-empty and `effective_kinds` includes a semantic-capable type (`content_chunk` via Documents, `note_block` via Notes), **independent of filters**. `content_chunk` keeps its hybrid pipeline (ANN union lexical, 0.50 floor, `CONTENT_CHUNK_*`); `note_block` uses the same page-owned `content_chunks`/`content_embeddings` pipeline; `page` remains title/description/daily-date lexical only. Embedding-provider-unavailable → lexical-only, **typed and logged** (operational resilience, not a legacy shim).

### 5.6 Multi-scope executor (`search/batch.py`)

```python
def search_scopes(db: Session, viewer_id: UUID, base: SearchQuery,
                  scopes: Sequence[SearchScope]) -> SearchResponse: ...
```

Owns the per-scope loop, union, **dedupe by `(result_type, id)` keeping max score**, sort, and cap — moved verbatim from `app_search._search_across_scopes` (`app_search.py:363–406`). `app_search` calls `search_scopes(...)`; it retains only chat-domain concerns (resolving empty `scopes` → conversation context refs, and `_empty_status_for_scopes`).

---

## 6. API design (HTTP)

`GET /api/search` (Next proxy → FastAPI `python/nexus/api/routes/search.py:28`). The route parses query params → `SearchQuery` at the boundary and calls `search(db, viewer_id, query)`.

### 6.1 Request params — old → new

| Old param | New param | Change |
|---|---|---|
| `q` | `q` | free text only after edge parse |
| `types` (14) | `kinds` (6) | **replaced**; comma list; **omitted ⇒ all, explicit empty ⇒ none** |
| `content_kinds` | `formats` | **replaced** (remapped, §4.4a) |
| `contributor_handles` | `authors` | **renamed** (canonical-resolved) |
| `roles` | `roles` | unchanged param; taxonomy-validated; no standing UI |
| `scope` | `scope` | unchanged |
| `semantic` | — | **deleted** (axis removed) |
| `cursor`, `limit` | `cursor`, `limit` | unchanged |

### 6.2 Route-edge rejection of deleted keys (anti-broadening)

The handler inspects `request.query_params` and raises `InvalidRequestError(E_INVALID_REQUEST)` (**400**) if any of `types`, `content_kinds`, `contributor_handles`, `semantic` is present. This converts stale links into a loud, correct failure instead of a silent broaden (§1.6). Covered by a test.

### 6.3 Chat telemetry (DB) — `message_tool_calls`

- **`semantic` column dropped** (migration §11) — the axis no longer exists.
- **`requested_types` retained**, now storing the **resolved internal result types** (`kinds.result_types_for(effective_kinds)`), still valid `SEARCH_RESULT_TYPES` values.
- `scope` column unchanged (multi-scope resolution happens before persistence, as today).

### 6.4 Chat SSE — `ChatRunToolCallEventPayload` (`schemas/conversation.py:284`)

- **`semantic: bool` field removed.**
- **`types: list[str]` retained** (resolved internal result types).
- **`filters: dict` keys renamed** at the producer: `content_kinds→formats`, `contributor_handles→authors` (the schema is an open dict, but the producer and the TS consumer must change together).

### 6.5 Response — unchanged

`SearchResponse` (`schemas/search.py`) uses the canonical `SEARCH_RESULT_TYPES`
/ `ALL_RESULT_TYPES` result discriminants, including `reader_apparatus_item`.
Result `type` discriminants and locators are frozen by the current backend,
database, and frontend authorities rather than by a duplicated count in this
doc.

### 6.6 Deleted from the contract

`types`, `content_kinds`, `contributor_handles`, `semantic` (HTTP); `semantic` (DB column + SSE field); `APP_SEARCH_RESULT_TYPES` (Python). No persisted search-filter rows exist outside the telemetry handled above.

---

## 7. Frontend architecture

### 7.1 `apps/web/src/lib/search/` — one query model

| File | Owns |
|---|---|
| `kinds.ts` | `SEARCH_KINDS` (6), labels, operator alias map, `MediaFormat` vocab. |
| `query.ts` | `SearchQuery` (TS, with `requestedKinds: Set \| null`), `effectiveKinds()` (mirrors §4.5). |
| `parseSearchInput.ts` | **pure** `(raw) → { text, chips }` operator parser. |
| `searchParams.ts` | `SearchQuery ↔ URLSearchParams` (omitted-vs-empty `kinds` preserved). |
| `searchApi.ts` | `fetchSearchResultPage(query, { limit, cursor, signal })` — HTTP only (split from `resultRowAdapter.ts`). |
| `searchViewModel.ts` | `adaptSearchResultRow` + snippet/segment helpers; **drops `scoreLabel`** (split from `resultRowAdapter.ts`). |
| `types.ts` | Keeps the `SearchType` union + `SearchResultRowViewModel`; **renames `ALL_SEARCH_TYPES` → `RESULT_TYPE_VALUES`** (kept as the result-discriminant validator for `normalizeSearchResult`); removes its use as a *filter* selection. |

`resultRowAdapter.ts` deleted (split into `searchApi.ts` + `searchViewModel.ts`).

### 7.2 Operator grammar (`parseSearchInput.ts`)

Pure, unit-tested (`.test.ts`, node). Tokenize honoring quotes; `^(kind|format|author|role|in):(.+)$` with a value in the canonical/alias set → chip; else → `text`. Role chips emitted only for taxonomy-known roles (else free text). No throw, no async, no network.

### 7.3 The search surface (page) — components & reuse

| Need | Reuse (existing) | New / change |
|---|---|---|
| Input box | `components/ui/Input` (lg, `bare`) | — |
| Kind selector (6, multi-select, default-all, implied-disable) | — | **`KindChips`** rendering **pressable `Chip`s** (see below) |
| Applied-filter bar (removable chips + Clear all) | `components/ui/Chip` (`removable` — already a `<button>` remove) | thin `AppliedFilters` |
| Author chip picker | `ContributorFilter` generalized | — |
| "+ Filter" overflow | `components/ui/ActionMenu` | — |
| Selection state | `lib/useStringIdSet` | — |
| Result rows | `components/search/SearchResultRow` (+ `SearchResultRowViewModel`) | **remove `score` label** (`SearchResultRow.tsx:42` + view-model + tests) |
| Pagination | existing "Load more" (offset cursor) | — |

**Accessibility fix (finding #10):** `Chip` today is a non-interactive `<div>` (`Chip.tsx:21`) and `Tabs` is single-value (`Tabs.tsx:33`) — neither gives multi-select toggle semantics. **Extend `Chip`** with a pressable button mode: when given `pressed`/`onPressedChange`, it renders a real `<button type="button" aria-pressed={pressed}>` (keeping its visual styling). `KindChips` uses that mode; `AppliedFilters` uses the existing removable mode. No new visual primitive.

**Deleted from `SearchPaneBody.tsx`:** the three `<fieldset>` checkbox blocks (`:370–415`), `SEARCH_TYPE_LABELS`/`SEARCH_ROLE_FILTERS`/`SEARCH_CONTENT_KIND_FILTERS`, `parseSelectedTypes`/`buildSearchHref`/`toggleType`/`toggleValue`/handlers, the submit `Button` + disable logic.

### 7.4 Palette `@` lane unification

`usePaletteController.ts:156–190` swaps its hardcoded `{ selectedTypes: ALL_SEARCH_TYPES, limit: 5 }` call for `fetchSearchResultPage(parseSearchInput(intent.term)→SearchQuery, { limit: 5 })`. "See all results" serializes the **same** `SearchQuery` via `searchParams.ts`. **Preserve the palette DOM contract** (roles/labels its e2e depends on).

### 7.5 States & interaction

Default all-kinds live search; applied-filter chips always visible + Clear all; zero-results keeps the editable query and leads with **Clear filters / broaden** when filters are active; incompatible kind chips greyed with a reason; interactive (live) filtering on desktop.

---

## 8. Composition with other systems

### 8.1 Command palette
Same `SearchQuery` model + `searchApi`; `@` lane = inline 5-result search; "See all" hands the serialized query to `/search`. `>` actions / `?` ask lanes unchanged.

### 8.2 Chat `app_search` RAG tool
Keeps NL→filter extraction (existing self-query). Changes: builds `SearchQuery`(s); calls **`search_scopes(...)`** (§5.6) instead of looping `search()`; imports `parse_scope` from `search/scope.py`; drops the `semantic` argument; uses canonical `SEARCH_RESULT_TYPES`; renames persisted/SSE filter keys (§6.3–§6.4). Its XML render slab (`app_search.py:800–1199`) is unchanged (renders result variants). The **chat-UI consumer** of the tool-call SSE event updates for the dropped `semantic` and renamed `filters` keys.

### 8.3 Citations / durable refs
`get_search_result(...)` keeps its contract (now typed). Result discriminants/locators frozen; existing citations remain valid.

### 8.4 Contributors / authors-directory cutover (P-1)
This cutover consumes the canonical visibility CTEs, `resolve_canonical_contributor_ids`, and `contributor_taxonomy`. The authors cutover's author-detail deep-link **must change `/search?contributor_handles={handle}` → `/search?authors={handle}`** (`authors…md:65`); both specs are unbuilt, and whichever lands second adopts the new param.

### 8.5 Libraries / reader scope
A library/media/conversation pane passes `scope` contextually (`in:library:<id>` etc.); the scope chip shows it with one-click "search everything." No new scope mechanism.

---

## 9. Reuse / consolidation map

| Today (duplicated / leaked) | After (single owner) |
|---|---|
| FE `ALL_SEARCH_TYPES` + BE `SEARCH_RESULT_TYPES` + runtime `ALL_RESULT_TYPES` + `APP_SEARCH_RESULT_TYPES` | `SEARCH_RESULT_TYPES`+`ALL_RESULT_TYPES` (authority) + `search/kinds.py` (taxonomy); FE list renamed `RESULT_TYPE_VALUES`; `APP_SEARCH_RESULT_TYPES` deleted. |
| Scope→SQL in 11 retrievers; `parse_scope`/`hash_query` leaked | `search/scope.py` (+ matrix) ; `hash_query`→logging util. |
| Multi-scope union/dedupe in `app_search` | `search/batch.py`. |
| `content_kinds` alias branches scattered (`podcast`/`podcasts`/`gutenberg`) | `search/kinds.py` `MediaFormat`→storage map (§4.4a). |
| `resultRowAdapter.ts` (transport + view-model) | `searchApi.ts` + `searchViewModel.ts`. |
| URL parsing inline in `SearchPaneBody.tsx` | `lib/search/searchParams.ts`. |
| Palette hardcoded search vs page filter call | one `fetchSearchResultPage(SearchQuery)`. |
| `semantic` flag + filter bypass + DB column + SSE field | deleted; hybrid invariant in `search/embedding.py`. |
| 3,970-line `services/search.py` | `services/search/` package. |

---

## 10. Key decisions

- **D-1.** Kind = intent; format/granularity = mechanism. Six kinds; podcast/episode/video are Documents differentiated by `format`.
- **D-2.** People-kind ≠ author-filter.
- **D-3.** Operators are an edge concern; the wire is structured (cleanliness §6).
- **D-4.** No synchronous LLM in the search box; NL→filters stays on the agentic path.
- **D-5.** Hybrid is an invariant, not a flag — removed at every layer incl. DB/SSE.
- **D-6.** Implied-kind enforced once, server- and client-side; illegal combos unrepresentable.
- **D-7.** Reranking + keyset pagination out of scope (separate cutovers).
- **D-8.** Visibility/identity/taxonomy are **prerequisites (P-1), not absorbed** — preserves entity ownership.
- **D-9.** Result variants and locators are frozen.
- **D-10.** **Omitted ≠ explicit-empty** for `kinds` (`None`⇒all, empty⇒none) — preserves tested semantics.
- **D-11.** **Query-time role/format validation is strict** (400 on out-of-vocab); ingestion-time normalization (`→unknown`) is not reused for filtering.
- **D-12.** **`MediaFormat` is a clean public vocab with an explicit storage map**, not a passthrough of `media.kind`; Gutenberg is provenance, dropped from formats.
- **D-13.** **Stale links fail loud** (route-edge 400 on deleted keys), never silently broaden.
- **D-14.** **`semantic` is removed from telemetry too** (drop column + SSE field) rather than frozen to a constant — no dead state (cleanliness §3).
- **D-15.** **Multi-scope is a first-class search capability** (`search/batch.py`), not chat-private logic.

---

## 11. Migration / data

One migration: `0140_drop_message_tool_calls_semantic.py`.

- `ALTER TABLE message_tool_calls DROP COLUMN semantic;`
- No other schema change. `requested_types` is **retained** (re-meaning: resolved internal result types). `message_retrievals.result_type` keeps the canonical current result-type CHECK.
- No backfill: telemetry is not load-bearing history (single-user prototype). The HTTP/service contract carries no persisted filter rows beyond the above. Existing values stay valid current result-type strings.
- No automatic downgrade path; downgrade raises `NotImplementedError` with manual
  re-add notes in the migration docstring.

---

## 12. Slices (hard cutover plan)

- **P-1 (prerequisite).** Authors-cutover visibility-CTE + canonical-handle + `contributor_taxonomy` slices land first (§0).
- **S0 — Taxonomy & types.** Add `search/kinds.py` (kind↔types, `MediaFormat`→storage, implied-kind, omitted-vs-empty) and FE `lib/search/{kinds,query}.ts`. Delete `APP_SEARCH_RESULT_TYPES` → import canonical. Rename FE `ALL_SEARCH_TYPES`→`RESULT_TYPE_VALUES`.
- **S1 — Scope owner + matrix.** Add `search/scope.py` (`scope_filter_sql` + `UNSUPPORTED` + the §4.6 matrix); move `hash_query` to logging; repoint `app_search` imports. Behavior-preserving; matrix tests added.
- **S2 — Service package split + batch.** Carve `services/search.py` into `services/search/{service,query,embedding,ranking,projection,cursor}.py` + `retrievers/*` + `batch.py` (`search_scopes`); typed `get_search_result` dispatch. Behavior-preserving relocation guarded by `test_search.py`.
- **S2′ — Telemetry/SSE migration.** Migration drops `message_tool_calls.semantic`; SSE `ChatRunToolCallEventPayload` drops `semantic`; producer + TS consumer renamed `filters` keys.
- **S3 — Hybrid invariant.** Delete `semantic` (service + route + `app_search`) and the `768–779` bypass; embedding built once. Add the "filters never change retrieval mode" test. (Needs P-1 consumed.)
- **S4 — Contract rename + route-edge rejection.** Service takes `SearchQuery`; route parses `kinds`/`formats`/`authors`/`roles`/`scope`/`q` → `SearchQuery`, **400s** on deleted keys; implied-kind enforced server-side; roles validated against taxonomy.
- **S5 — FE query model.** Add `parseSearchInput`, `searchParams`, `searchApi`, `searchViewModel`; delete `resultRowAdapter.ts`; extend `Chip` to pressable.
- **S6 — Search surface.** Rewrite `SearchPaneBody.tsx` to box + `KindChips` + `AppliedFilters` + results; delete checkbox/role/content-kind/submit/score code.
- **S7 — Palette unification.** Repoint `usePaletteController` to `fetchSearchResultPage(SearchQuery)`; preserve palette DOM contract.
- **S8 — Gates + tests + docs.** Land grep gates (§14) and tests (§15); update `docs/architecture.md` §7.6/§8.9, the authors deep-link, and real-media seeds.

---

## 13. Acceptance criteria

- **AC-1.** `/search` shows one box + six kind chips + applied-filter chip bar; zero checkboxes/role-grid/content-kind-grid; no submit button.
- **AC-2.** Default (no `kinds` param) searches all six kinds; deselecting narrows live; deselecting **all** returns no results (not all).
- **AC-3.** `format:pdf` / `author:<handle>` / `role:translator` / `in:library:<id>` produce removable chips and narrow; remove restores; Clear all resets.
- **AC-4.** A media-only filter disables incompatible kind chips client-side and yields the narrowed set server-side; "Notes + PDFs" is unrepresentable.
- **AC-5.** The HTTP contract accepts `kinds`/`formats`/`authors`/`roles`/`scope`/`q`/`cursor`/`limit` and **400s** on `types`/`content_kinds`/`contributor_handles`/`semantic`.
- **AC-6.** Identical query with vs without a structured filter both run the ANN arm for semantic-capable kinds (test asserts embedding built in both).
- **AC-7.** Palette `@` lane and `/search` produce identical results for the same input; "See all" round-trips via URL.
- **AC-8.** `APP_SEARCH_RESULT_TYPES` gone; `parse_scope`/`scope_filter_sql`/multi-scope each single-owner; `services/search.py` is a package.
- **AC-9.** Chat `app_search` RAG + existing citations resolve unchanged; tool-call SSE has no `semantic`, `filters` uses `formats`/`authors`.
- **AC-10.** `MediaFormat` values map correctly to storage (`article→web_article`, `episode→podcast_episode`, `podcast→podcasts` table); no `gutenberg` format.
- **AC-11.** `message_tool_calls.semantic` column removed; migration reversible-down documented.
- **AC-12.** Every §4.6 matrix cell has a test; no cell's behavior changed.
- **AC-13.** All negative gates (§14) pass.

## 14. Negative gates (grep, CI-enforced)

- No `APP_SEARCH_RESULT_TYPES` anywhere.
- No `\bsemantic\b` in `services/search/**`, `routes/search.py`, `agent_tools/app_search.py`, `schemas/conversation.py` (SSE), or `message_tool_calls` DDL/model.
- No stale `/search?...content_kinds=`, `/search?...contributor_handles=`, or
  `/search?...types=` deep links in app search surfaces, e2e tests, or docs
  except this spec's old-to-new examples. Endpoint-local vocabularies owned by
  other cutovers, such as author-directory `content_kinds`, are not part of
  this search URL-param guard.
- No `<input type="checkbox">` in `SearchPaneBody.tsx`.
- No `parse_scope` / `hash_query` defined in `services/search/service.py`.
- No `_search_across_scopes` in `agent_tools/app_search.py` (moved to `search/batch.py`).
- No `resultRowAdapter` import remains; `services/search.py` (single file) no longer exists.
- No `gutenberg`/`project_gutenberg` in search format handling.

## 15. Test plan

- **Unit (`.test.ts`, node):** `parseSearchInput` (operators, aliases, quotes, malformed→text, role only-if-known); `searchParams` round-trip incl. omitted-vs-empty `kinds`; `effectiveKinds` implied-kind.
- **Browser (`.test.tsx`, chromium):** kind chips default-all + narrow + deselect-all-⇒-none; pressable `Chip` `aria-pressed`; applied-filter add/remove + Clear all; implied-disable; zero-results "clear filters"; palette↔page parity by role/label (preserve palette DOM contract).
- **Backend (pytest):** kind→types; `MediaFormat`→storage (incl. podcast table + episode); omitted-vs-explicit-empty kinds (port `test_search.py:1091`) + invalid-kind 400 (port `:1083`); **route-edge 400 on each deleted key**; `scope_filter_sql` **per matrix cell** (§4.6); role validation 400 on out-of-vocab; **hybrid invariant** (embedding built with and without filters); `search_scopes` union/dedupe/cap (port `app_search` behavior); typed `get_search_result` dispatch; `app_search` end-to-end with renamed filters; migration up/down drops/re-adds `semantic`; SSE payload has no `semantic`.
- **E2E / real-media:** update `e2e/tests/real-media/real-media-seed.ts:530` and any `/search?...` builders to the new params; assert old-param 400.
- **Delete** tests asserting old checkbox wiring / `types` filter selection / `semantic` toggle.

## 16. Files

**Created (backend):** `services/search/__init__.py`, `service.py`, `query.py`, `kinds.py`, `scope.py`, `batch.py`, `embedding.py`, `ranking.py`, `projection.py`, `cursor.py`, `retrievers/{media,library_content,objects,highlights,conversations,contributors,web}.py`; migration `0140_drop_message_tool_calls_semantic.py`.
**Created (frontend):** `lib/search/{kinds,query,parseSearchInput,searchParams,searchApi,searchViewModel}.ts`, `components/search/{KindChips,AppliedFilters}.tsx`.
**Modified:** `python/nexus/api/routes/search.py`, `schemas/search.py` (canonical runtime list), `schemas/conversation.py` (import canonical types; SSE drop `semantic`, rename `filters` keys), `db/models.py` (drop `semantic`), `agent_tools/app_search.py` (use `search_batch`, renames), the chat-UI SSE consumer + its TS type, `components/ui/Chip.tsx` (pressable mode), `SearchPaneBody.tsx`, `page.module.css`, `palette/usePaletteController.ts`, `lib/search/types.ts` (rename `ALL_SEARCH_TYPES`→`RESULT_TYPE_VALUES`), `components/search/SearchResultRow.tsx` (drop score), `e2e/tests/real-media/real-media-seed.ts`, `docs/architecture.md`, `docs/cutovers/authors-directory-and-contributor-ownership-hard-cutover.md` (deep-link param).
**Deleted:** `services/search.py` (→ package), `lib/search/resultRowAdapter.ts`, `APP_SEARCH_RESULT_TYPES`, the three checkbox fieldsets + their constants, the `semantic` axis (param/arg/column/SSE field), the submit/disable/score code, `_search_across_scopes` (→ `batch.py`), the `content_kinds` alias branches.

## 17. Risks & mitigations

- **R1. Service split regressions.** S2 is a behavior-preserving relocation guarded by `test_search.py` before any contract change (S3/S4).
- **R2. Matrix omissions.** The §4.6 matrix is enumerated from current retrievers with a test per cell; the grep gate forbids new inline scope branches.
- **R3. Telemetry/SSE consumer drift.** S2′ changes producer, schema, and TS consumer together; gate forbids residual `semantic`.
- **R4. Embedding latency on the live palette path.** Already occurs today (`content_chunk` always triggers semantic) — no regression; optional later LRU on `hash_query`.
- **R5. P-1 sequencing.** If the authors consolidation slices are not yet landed, this cutover is blocked, not branched — by design (no dual ownership).
- **R6. Operator ambiguity** (`word:thing` in prose). Closed operator set + forgiving fallthrough to free text; unit-tested.
- **R7. Palette e2e breakage.** "Preserve palette DOM contract" rule + parity test (§15).
```

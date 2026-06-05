# Codebase cleanliness audit — god files & ownership boundaries

Status: findings only (no code changed) · Scope: whole repo · Method: 57-slice subagent fan-out · Generated against `docs/rules/`

This is an **exhaustive catalog of where the code does not align with the repository's own rules** in
`docs/rules/`, with primary emphasis on `cleanliness.md` and the stated goal of **eliminating god files and
separating code into isolated, self-contained services / modules / hooks with clean, simple public contracts**.
It is a backlog, not a cutover spec: every finding cites concrete `file:line` evidence and a proposed
decomposition, so each can be lifted into its own change.

## 1. Scope & method

The whole tree (`python/nexus` + `apps/web`) was partitioned into **57 narrow slices** — one per god-file or
cohesive module cluster, so every non-trivial source file is covered exactly once. Each slice was audited by a
dedicated subagent that read the actual rule docs (`cleanliness.md`, `layers.md`, `module-apis.md`, plus
`errors.md` / `control-flow.md` / `simplicity.md`), the relevant `docs/modules/*.md` design doc, and its assigned
files in full, then returned structured findings: title, category, severity, confidence, rule refs,
`file:line` locations, the concrete problem, and a recommended decomposition. Repo-wide discipline signals
(legacy naming, barrels, bare excepts, dead-marker comments) were swept separately by the main agent (§6).

**What "aligned" looks like here.** The repo is unusually disciplined on the *easy* signals (see §6): no
`TODO/FIXME`, no `legacy/compat/fallback` naming in code, no TS re-export barrels, near-zero type-suppressions.
The misalignment is almost entirely **structural** — a relatively small number of very large files that each own
many unrelated capabilities, and a recurring set of cross-module duplications where two owners encode the same
rule. That is exactly the target the rules call out, and exactly where the leverage is.


## 2. By the numbers

**465 findings** across **57 slices** (418 at High confidence, 47 Medium; zero Low-confidence — every finding cites concrete `file:line` evidence).

| Severity | Count |  | Category | Count |
|---|---|---|---|---|
| 🔴 High | 120 |  | Duplication | 164 |
| 🟠 Medium | 179 |  | GodFile | 73 |
| 🟡 Low | 166 |  | OwnershipLayering | 66 |
|  |  |  | DocDrift | 27 |
|  |  |  | Indirection | 24 |
|  |  |  | Types | 22 |
|  |  |  | PublicSurface | 21 |
|  |  |  | DeadCode | 20 |
|  |  |  | Other | 14 |
|  |  |  | LegacyCompat | 13 |
|  |  |  | Tests | 11 |
|  |  |  | ErrorHandling | 6 |
|  |  |  | Naming | 4 |

Categories map to `cleanliness.md` sections: GodFile→§5, Duplication→§4, OwnershipLayering→§6/§8, PublicSurface→§6, Indirection→§7, DeadCode→§2, LegacyCompat→§3, Types→§9, ErrorHandling→§10, Tests→§11, Naming→§12, DocDrift→stale-doc lead (§3).

### Slice index

Each slice links to its full findings in the catalog (Part A backend / Part B frontend). Sorted by High-severity count.

| Slice | Area | Issues | High | Jump |
|---|---|---:|---:|---|
| Media service core | Backend | 10 | 5 | [↳](#py-media-core) |
| Notes service | Backend | 10 | 4 | [↳](#py-notes) |
| Ingest tasks (video/podcast) | Backend | 9 | 4 | [↳](#py-ingest-tasks) |
| Podcast sync & subscriptions | Backend | 8 | 4 | [↳](#py-podcast-sync) |
| Object refs & links | Backend | 6 | 4 | [↳](#py-object-refs) |
| Workspace host & pane shell | Frontend | 11 | 3 | [↳](#fe-workspace-host) |
| Billing / rate limit | Backend | 11 | 3 | [↳](#py-billing) |
| Libraries service | Backend | 10 | 3 | [↳](#py-libraries) |
| Workspace store & pane routing | Frontend | 9 | 3 | [↳](#fe-workspace-store) |
| Search service | Backend | 9 | 3 | [↳](#py-search) |
| Misc panes & contributors (FE) | Frontend | 8 | 3 | [↳](#fe-misc-panes) |
| PdfReader god component | Frontend | 8 | 3 | [↳](#fe-pdf-reader) |
| Browse / discovery | Backend | 8 | 3 | [↳](#py-browse) |
| Content indexing / chunks | Backend | 8 | 3 | [↳](#py-content-indexing) |
| Conversations service | Backend | 11 | 2 | [↳](#py-conversations) |
| Podcast catalog & playback | Backend | 11 | 2 | [↳](#py-podcast-catalog-playback) |
| Vault / BYOK / keys | Backend | 11 | 2 | [↳](#py-vault) |
| Oracle panes (FE) | Frontend | 10 | 2 | [↳](#fe-oracle) |
| Global player | Frontend | 10 | 2 | [↳](#fe-player) |
| Settings & local vault (FE) | Frontend | 10 | 2 | [↳](#fe-settings) |
| Jobs / worker | Backend | 10 | 2 | [↳](#py-jobs) |
| Oracle service | Backend | 10 | 2 | [↳](#py-oracle) |
| Podcast/transcript pipeline | Backend | 10 | 2 | [↳](#py-podcast-transcripts) |
| Auth (FE) + middleware | Frontend | 9 | 2 | [↳](#fe-auth) |
| MediaPaneBody god component | Frontend | 9 | 2 | [↳](#fe-media-pane) |
| Podcast panes (FE) | Frontend | 9 | 2 | [↳](#fe-podcast-panes) |
| Chat runs service | Backend | 9 | 2 | [↳](#py-chat-runs) |
| Highlights & reader (backend) | Backend | 9 | 2 | [↳](#py-highlights-reader) |
| Library panes (FE) | Frontend | 8 | 2 | [↳](#fe-library-panes) |
| Agent tools | Backend | 8 | 2 | [↳](#py-agent-tools) |
| Context assembler / retrieval | Backend | 8 | 2 | [↳](#py-context-assembler) |
| Contributor credits | Backend | 8 | 2 | [↳](#py-contributor-credits) |
| Contributors service | Backend | 8 | 2 | [↳](#py-contributors) |
| EPUB ingest & read | Backend | 8 | 2 | [↳](#py-epub) |
| Web article / image proxy | Backend | 8 | 2 | [↳](#py-web-article) |
| API client & SSE (FE) | Frontend | 7 | 2 | [↳](#fe-api-sse) |
| Browse & add content (FE) | Frontend | 7 | 2 | [↳](#fe-browse) |
| Conversation forks (FE) | Frontend | 7 | 2 | [↳](#fe-forks) |
| Conversation branches | Backend | 7 | 2 | [↳](#py-conversation-branches) |
| Library intelligence | Backend | 7 | 2 | [↳](#py-library-intel) |
| Auth (backend) | Backend | 6 | 2 | [↳](#py-auth) |
| DB models god file | Backend | 6 | 2 | [↳](#py-db-models) |
| PDF ingest | Backend | 6 | 2 | [↳](#py-pdf-ingest) |
| Metadata & social identity | Backend | 5 | 2 | [↳](#py-metadata-social) |
| Upload / storage | Backend | 5 | 2 | [↳](#py-upload-storage) |
| Notes (FE) | Frontend | 10 | 1 | [↳](#fe-notes) |
| Chat surface & hooks | Frontend | 8 | 1 | [↳](#fe-chat) |
| Resource actions / media hooks / UI | Frontend | 8 | 1 | [↳](#fe-resource-actions) |
| Search (FE) | Frontend | 8 | 1 | [↳](#fe-search) |
| Command palette (FE) | Frontend | 7 | 1 | [↳](#fe-command-palette) |
| Reader surface (FE) | Frontend | 7 | 1 | [↳](#fe-reader) |
| App bootstrap / config | Backend | 7 | 1 | [↳](#py-app-infra) |
| Highlights (FE) | Frontend | 6 | 1 | [↳](#fe-highlights) |
| Media deletion & sharing | Backend | 6 | 1 | [↳](#py-media-deletion) |
| Command palette (backend) | Backend | 4 | 1 | [↳](#py-command-palette) |
| BFF proxy routes | Frontend | 6 | 0 | [↳](#fe-bff-routes) |
| DB infrastructure | Backend | 6 | 0 | [↳](#py-db-infra) |

## 3. Cross-cutting patterns (highest leverage)

These span many slices. Fixing each one collapses several catalog findings at once, because the same rule is
re-encoded by multiple owners. They are the highest-value work in this audit.

### 3.1 Visibility / access SQL is re-implemented per consumer
The "what media/conversations/podcasts can this viewer see" predicate is duplicated across the codebase instead
of living once in `auth/permissions.py` next to `visible_media_ids_cte_sql`.
- `search.py:561` `visible_conversation_ids_cte_sql` duplicates `conversations.py:335` `_build_visibility_cte` (and is inlined at 6 call sites).
- `object_refs.py` re-encodes the **podcast** visibility predicate **3×** in one file, and its `evidence_span` search uses a *weaker, divergent* `visible_media` CTE — a latent correctness gap.
- **Canonical owner:** `auth/permissions.py`. Expose `visible_media_ids_cte_sql` / `visible_conversation_ids_cte_sql` / `visible_podcast_ids_cte_sql`; delete every copy. *(See `py-search`, `py-conversations`, `py-object-refs`.)*

### 3.2 The media processing-state machine has multiple writers
`media_processing_state.py` was created to be the single owner of `processing_status` / `failure_stage` /
`last_error_*` transitions, but several call sites mutate those columns directly:
- `media.py:836` `_reset_media_for_reingest` re-implements `begin_extraction` (and uses Python `datetime.now` vs the canonical `func.now()` — a silent behavioural divergence).
- `tasks/ingest_pdf.py` hand-mutates every state field across 4+ points; the YouTube/podcast ingest tasks do the same.
- **Canonical owner:** `media_processing_state.py`. Add `reset_for_reingest`, `begin_*`, `mark_failed`, and route **all** writers through it. *(See `py-media-core`, `py-pdf-ingest`, `py-ingest-tasks`.)*

### 3.3 Library-entry position renormalization is duplicated — with a divergent tie-break
`libraries.py:1000` `normalize_library_entry_positions` is the canonical renormalizer
(`ORDER BY position ASC, created_at DESC, id DESC`), but `podcasts/subscriptions.py:461` inlines its own CTE with
`created_at ASC, id ASC` — **different results on ties**, a real data-correctness divergence. The library-entry
*ensure/insert* and *backfill-job upsert* flows are likewise duplicated (`libraries.py` vs
`default_library_closure.py`, `accept_library_invite` inline SQL).
- **Canonical owner:** the libraries service. Subscriptions/closure must call its public commands, never touch `library_entries`. *(See `py-podcast-sync`, `py-libraries`.)*

### 3.4 Podcast upsert / transcript-version writes have two owners each
- `catalog.py:605` `upsert_podcast` and `subscriptions.py:626` `_upsert_podcast_from_opml` are two ~130-line copies of the same identity-resolution algorithm, already diverging in which fields they set.
- `sync.py` imports **six private `_`-prefixed helpers** from `transcripts.py` and drives the transcript-version state machine inline — two co-owners of one capability with no public contract. `tasks/ingest_youtube_video.py` adds a *third* `media_transcript_states` upsert and a `podcast_transcript_versions` create **without the advisory lock** (race).
- **Fix:** one `upsert_podcast` in the podcasts package; one public `write_transcript_version` / `ingest_rss_transcript_if_eligible` command on `transcripts.py`. *(See `py-podcast-catalog-playback`, `py-podcast-transcripts`, `py-podcast-sync`, `py-ingest-tasks`.)*

### 3.5 Outbound HTTP lives in the service/task layer instead of behind a client
`layers.md`/`cleanliness.md §8` require vendor HTTP behind a driver service. Instead:
- `media.py` runs an `httpx` streaming download + redirect loop in the service body.
- `browse.py` and `podcasts/provider.py` each carry a near-identical retry-with-backoff `_get_json` loop; the **YouTube Data API client** is embedded in *both* `browse.py` and `tasks/ingest_youtube_video.py`.
- `billing.py` mixes the Stripe SDK with domain reads/webhook parsing.
- **Fix:** one `youtube_data_client.py`, one shared retry-HTTP helper, Stripe behind a driver. *(See `py-media-core`, `py-browse`, `py-ingest-tasks`, `py-billing`.)*

### 3.6 `embedding_config_hash` formula copied 4×
The `openai_{model}_{dims}_v1` config-hash string is constructed in four places across `content_indexing.py` and
the podcast pipeline. One `embedding_config_hash()` function; delete the rest. *(See `py-content-indexing`, `py-podcast-transcripts`.)*

### 3.7 Fragment-highlight write primitive triplicated
The "lock fragment row + detect span conflict + validate/derive offsets" primitive exists in `highlights.py` and
is **copied into `vault.py`** (`_lock_fragment_row_for_highlight_write`, `_fragment_highlight_span_conflict_exists`).
`vault.py` should call the highlights service, not own a second copy. *(See `py-vault`, `py-highlights-reader`.)*

### 3.8 The `message_retrievals` write path is bypassed
`retrieval_citation.insert_retrieval_row` is the single validated path (used correctly by `app_search.py`), but
`agent_tools/web_search.py` re-implements the whole SELECT/INSERT/UPDATE upsert inline. Route web-search citations
through the canonical owner. *(See `py-agent-tools`, `py-context-assembler`.)*

### 3.9 Duplicate *type authorities* for one concept
Two+ independent definitions of the same closed set, so a new variant must be added in several places:
- `SEARCH_RESULT_TYPES` (schemas/search) ≡ `APP_SEARCH_RESULT_TYPES` (schemas/conversation) ≡ `ALL_RESULT_TYPES` tuple (services/search) — same 14 strings, 3 owners.
- `QueueInsertPosition` ≡ `PlaybackQueueInsertPosition` (both `Literal["next","last"]`); `PlaybackQueueListeningStateOut` overlaps `ListeningStateOut`.
- Frontend `PdfHighlightOut` ≡ `PdfHighlight` (`lib/highlights/api.ts`).
- **Fix:** one `Literal`/type per concept; derive runtime tuples via `get_args`. *(See `py-search`, `py-podcast-catalog-playback`, `fe-pdf-reader`.)*

### 3.10 Frontend: the same data-mutation loop re-implemented per pane
- **Library membership** fetch/add/remove/optimistic-patch loop is written **3×** (`useLibraryMembership`, `PodcastDetailPaneBody`, `LibraryPaneBody`) against the same four `mediaLibraries.ts` functions — no shared hook owns it.
- **Podcast subscription** mutation flow duplicated in `PodcastsPaneBody` + `PodcastDetailPaneBody`.
- **Library edit-dialog** mutation suite duplicated in `LibrariesPaneBody` + `LibraryPaneBody`.
- **Local-vault sync** duplicated in `SettingsLocalVaultPaneBody` + `LocalVaultAutoSync`; `setPasswordAction`/`changePasswordAction` are byte-identical.
- **RAF scroll-retry** loop appears 3× inline in `MediaPaneBody`.
- **Fix:** one hook per mutation flow (`useLibraryMembership` as the sole owner, `usePodcastSubscription`, `useLibraryEditor`, `useLocalVaultSync`, a `rafScrollRetry` util). *(See `fe-resource-actions`, `fe-podcast-panes`, `fe-library-panes`, `fe-settings`, `fe-media-pane`.)*

### 3.11 Cross-module imports of private helpers (boundary leaks)
Beyond `sync.py`←`transcripts.py` (§3.4): `tasks/ingest_web_article.py` imports `ensure_default_intrinsic` from
`default_library_closure` (skipping the libraries public API *and* the media-deletion clearance it would do);
`contributors.py` reaches directly into AI tables for its tombstone scan. `cleanliness.md §6` forbids this —
move the code to its owner or expose one public function.

### 3.12 Doc drift — several module docs are empty stubs
27 `DocDrift` findings. Multiple `docs/modules/*.md` referenced as the design contract are **empty** (`sharing.md`,
`podcast.md`, `player.md`, `library.md`, `oracle.md` were reported empty by their auditors), so there is no
authoritative design to check code against. Either fill them or remove the stubs; a stale/empty doc is itself a
lead per `cleanliness.md §3`.

---

## 4. God-file inventory

The structural core of the audit. Each of these owns multiple unrelated capabilities in one body and is the
subject of a `GodFile` finding with a concrete split. Ordered by size.

| File | Lines | Owns (unrelated concerns) → split into |
|---|---:|---|
| `db/models.py` | 6401 | **All 62 tables + 28 enums** in one module → per-domain modules under `db/` *(+18 enums after L3520 appear unused — dead public surface)* |
| `app/(authenticated)/media/[id]/MediaPaneBody.tsx` | 5047 | media load · EPUB nav · web-article · transcript polling · resume state · **3 scroll machines** · highlights → reader-kind hooks + thin shell |
| `services/search.py` | 3970 | scope/authz · 11 per-type query builders · 650-line `get_search_result` · projection · cursors → `search_scope`/`search_query`/`search_projection` |
| `services/podcasts/transcripts.py` | 2824 | admission gate · Deepgram adapter · quota ledger · job state machine · semantic-repair → `deepgram_adapter`/`transcription_quota`/`transcription_job` |
| `services/media.py` | 2710 | hydration · listening-state · X/web-article/YouTube/remote-file ingest · EPUB assets → `x_ingest`/`youtube_ingest`/`remote_file_ingest`/`epub_assets`/`listening_state` |
| `components/PdfReader.tsx` | 2369 | viewer lifecycle · highlight CRUD · selection · resume · 13 useState/28 useRef → focused hooks + render shell |
| `services/podcasts/sync.py` | 2337 | poll singleton · sync state machine · RSS fetch · RSS parse · inline transcript ingest → `feed_fetch`/`feed_parse`/`poll` |
| `services/libraries.py` | 2166 | CRUD/governance · entries/ordering · invitations · subscription-libraries · closure → `library_governance`/`library_entries`/`library_invitations` |
| `app/.../podcasts/[podcastId]/PodcastDetailPaneBody.tsx` | 2099 | podcast/episode fetch · transcript machine · 2× membership · subscription · layout → episode-list/header/transcript/shell |
| `services/epub_ingest.py` | 2056 | archive safety · OPF parse · **duplicate HTML sanitizer** · asset rewrite · TOC → `epub_archive`/`epub_opf`/`epub_sanitize`/`epub_toc` |
| `services/content_indexing.py` | 1903 | index-run state machine · chunking · per-kind block builders · selector validation → 5 modules |
| `services/notes.py` | 1888 | page/block CRUD · ProseMirror transforms · object-link graph · markdown → `note_prosemirror`/`note_links` |
| `services/oracle.py` | 1838 | CRUD · rate-limit · corpus readiness · retrieval · LLM prompt/parse · SSE persist; `execute_reading` is a 282-line 6-phase fn |
| `services/chat_runs.py` | 1611 | `_execute_chat_run` 541-line fn mixes LLM streaming + tool dispatch for 4 tools → `chat_run_tool_dispatch` |
| `services/library_intelligence.py` | 1438 | source-set · build lifecycle · publish · read-model → 4 modules |
| `services/vault.py` | 1388 | export/download · filesystem I/O · **duplicated** highlight mutation · markdown serde |
| `lib/workspace/store.tsx` | 1337 | reducer · 14 handlers · Provider · URL sync · listeners · title cache → title-mgmt + URL-bridge hooks |
| `lib/player/globalPlayer.tsx` | 1284 | Web Audio DSP · queue mgmt · transport control · context wiring → 4 units |
| `components/workspace/WorkspaceHost.tsx` | 1194 | publication-record service · secondary-surface lifecycle · canvas/focus/keybindings → extract embedded "service" |
| `app/.../libraries/[id]/LibraryPaneBody.tsx` | 1143 | fetch/cache · 2 list item types · media-processing · membership · edit-dialog → 4 units |
| `services/conversation_branches.py` | 1131 | anchor validation · active-path persist · `ForkOptionOut` (2 strategies) · graph build |
| `services/contributors.py` | 1107 | identity CRUD · visibility search · cross-domain tombstone scan |
| `services/contributor_credits.py` | 943 | credit write · credit batch read · **contributor identity resolution** (belongs in `contributors.py`) |
| `services/context_assembler.py` | 918 | orchestration · raw-SQL reads · raw-SQL writes · block render · resource attach |
| `services/browse.py` | 865 | YouTube Data API client · Gutenberg query · cursors · 4 section pipelines |
| `services/podcasts/catalog.py` | 767 | discovery · podcast-row writes · subscription queries · episode queries |
| `app/.../oracle/[readingId]/OracleReadingPaneBody.tsx` | 762 | SSE/canvas · state machine · fetch · render |
| `app/.../browse/BrowsePaneBody.tsx` | 764 | 4 async action flows · search-state · 4 inline row layouts |
| `app/.../pages/[pageId]/PagePaneBody.tsx` | 755 | page load · draft serde · conflict resolution · title edit · block-diff · ProseMirror |
| `services/x_api.py` | 753 | API transport · snapshot parsing · **HTML rendering** |
| `services/object_refs.py` | 750 | per-type hydration · 11-type search · pinned-refs · dead `render_object_context` |
| `services/media_deletion.py` | 747 | viewer delete · hard delete · orphan cleanup · per-user teardown · storage |
| `components/GlobalPlayerFooter.tsx` | 722 | mobile bottom-sheet + desktop footer = two components in one body |
| `services/rate_limit.py` | 845 | RPM/concurrency flow-control **and** the whole token-budget accounting subsystem |
| `services/agent_tools/app_search.py` | 1215 | tool def · orchestration · persistence · **10-type XML context renderer** |
| `config.py` | 693 | 115 fields + a 229-line mega-validator spanning 12+ subsystems |
| `components/reader/ReaderHighlightsSurface.tsx` | 830 | layout engine · note-key registry · mutation feedback · render |
| `components/chat/useConversation.ts` | 852 | god hook — 5 unrelated concerns |
| `app/.../oracle/atlas/AtlasPaneBody.tsx` | 622 | canvas engine · interaction state · fetch · render |
| `components/CommandPalette.tsx` | 568 | lifecycle/URL · 2 fetch pipelines · command assembly · action exec · render |

Plus god *functions* inside otherwise-split files: `tasks/reconcile_stale_ingest_media.py` (356-line 4-phase fn),
`upload.py:confirm_ingest` (317-line 3-phase, 18 commit points), `oracle.py:execute_reading` (282-line 6-phase).

---

## 5. Highest-leverage fixes (suggested order)

Curated from the 120 High findings, front-loading the cross-cutting collapses (which each kill several findings)
and the worst god files. Confirm each symbol is truly unused before deleting (`cleanliness.md §13`).

1. **Canonicalize visibility CTEs** in `auth/permissions.py`; delete the copies in `search.py`/`conversations.py`/`object_refs.py` and fix the divergent `evidence_span`/podcast predicates (§3.1) — *also a correctness fix*.
2. **Single owner for the processing-state machine** (`media_processing_state.py`); route `media.py`, `ingest_pdf`, and the ingest tasks through it; kill the Python-clock vs DB-clock divergence (§3.2).
3. **Fix the library-position tie-break divergence** and route subscriptions/closure through the libraries public API (§3.3) — *correctness fix*.
4. **Collapse podcast-upsert + transcript-version writes** to one owner each; add the missing advisory lock in the YouTube ingest path (§3.4) — *removes a race*.
5. **Split `db/models.py`** into per-domain modules and delete the ~18 unused trailing enums (§4).
6. **Split `search.py`** into scope/query/projection; type `get_search_result`'s dispatch and drop positional row indexing.
7. **Split `media.py`** ingest pipelines into per-source services; move the `httpx` download behind a client; **delete dead `create_or_reuse_x_oembed_article`** (177 lines).
8. **Split the podcast god files** (`transcripts.py`, `sync.py`, `catalog.py`) along the lines in §4 + §3.4.
9. **De-dupe the EPUB sanitizer** against `sanitize_html.py` (one configurable sanitizer) and split `epub_ingest.py`.
10. **One shared library-membership hook** (and subscription/edit-dialog/local-vault hooks) on the frontend (§3.10).
11. **Decompose the worst panes/components**: `MediaPaneBody` (5047), `PdfReader`, `PodcastDetailPaneBody`, `store.tsx`, `globalPlayer`, `WorkspaceHost`, `LibraryPaneBody` into hooks + thin shells.
12. **Route web-search citations through `retrieval_citation.insert_retrieval_row`** (§3.8); pull the 10-type XML renderer out of `app_search.py`.
13. **Collapse `embedding_config_hash` (×4)** and the fragment-highlight write primitive (`vault.py`→highlights) (§3.6, §3.7).
14. **Move contributor identity resolution** out of `contributor_credits.py` into `contributors.py`.
15. **Split `rate_limit.py`** (flow-control vs token-budget) and `config.py`'s mega-validator.
16. **Delete confirmed dead code**: `object_refs.render_object_context`, `password-actions` `signIn/signUpWithPasswordAction`, the auth-bypass entries for removed `/stream/conversations/` routes, the EPUB `run_epub_ingest_sync` test shim.
17. **Unify duplicate type authorities** (§3.9).
18. **Pull stream-token service** out of the `auth/` adapter layer into a service; move pane URL-allowlist policy out of the command-palette usage service.

---

## 6. Repo-wide discipline scan (main-agent sweep)

Complementary to the per-slice audit; these are whole-repo greps the file-scoped agents could not see.

- ✅ **No dead-marker comments:** `0` `TODO`/`FIXME`/`HACK`/`XXX` in `python/nexus` or `apps/web/src`.
- ✅ **No legacy/compat naming in code:** `0` `legacy|compat|cutover|bridge|shim|deprecated|_old|_v2` identifiers (the few `fallback` hits are legitimate — idle-timeout fallback, default-value params).
- ✅ **No TS re-export barrels** (`export … from`) in `apps/web/src` — `cleanliness.md §6` "remove barrels" already honoured.
- ✅ **Near-zero type suppressions:** `0` Python `# type: ignore`; `2` `@ts-ignore/@ts-expect-error`, `6` `eslint-disable` in the entire web tree.
- ⚠️ **Catch-all error handling:** `49` `except Exception` sites in non-test Python (concentrated in `tasks/` ingest pipelines); only ~9 carry a nearby `justify-ignore-error`. The repo *has* the `justify-ignore-error` convention (39 uses) — but `control-flow.md` requires every discarding catch to narrow first and carry the token. The unmarked sites need a per-site pass (re-raise, narrow, or justify). Tracked under `ErrorHandling` findings in `py-ingest-tasks`, `py-jobs`, `py-web-article`.

The takeaway: the team already enforces the lexical rules well. The remaining work is the structural decomposition
above — which is precisely what `cleanliness.md §5`–§8 exist to drive.

---

## 7. Reading the catalog

The full **465 findings** follow, grouped **Part A — Backend** then **Part B — Frontend**, one section per slice
(use the §2 slice index to jump). Within each slice, findings are sorted 🔴 High → 🟠 Medium → 🟡 Low. Each carries
its severity, confidence, category, rule refs, `file:line` locations, the problem, and a concrete fix. Confidence
is the auditor's certainty that the finding is real; treat `Medium`-confidence items as leads to verify before
acting. Nothing here has been applied to the tree.



# Part A — Backend (`python/nexus`)


<a id="py-search"></a>
## Search service  · `py-search`
*9 issues (3 High)*  

> **Verdict.** search.py is the dominant god file in this slice at 3970 lines. It conflates six distinct concerns in one module: scope parsing and authorization, SQL query building for every content type (11 distinct _search_* functions), a single-object-by-id resolver (get_search_result with 13 if-chains covering ~650 lines), result projection/mapping logic, pagination cursor encoding, and cross-cutting SQL fragment helpers. The worst rot is the combination of the god-file violation with two ownership violations: (1) visible_conversation_ids_cte_sql duplicates conversations.py._build_visibility_cte, and (2) SEARCH_RESULT_TYPES and APP_SEARCH_RESULT_TYPES in schemas/search.py and schemas/conversation.py are identical sets with different names, creating two competing type authorities for the same concept.


#### 🔴 1. search.py is a god file mixing authorization, query-building, projection, and routing
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/search.py:1-3970`  

**Problem.** A single 3970-line file owns six unrelated capabilities: (a) scope parsing and authorization (parse_scope, authorize_scope, lines 443-499), (b) pagination cursor encoding (encode_search_cursor/decode_search_cursor, lines 371-412), (c) SQL-level query builders for 11 different content types (lines 1616-3367), (d) a by-ID point-resolver for each type (get_search_result, lines 821-1472), (e) result projection and deep-link logic (_result_to_out, _result_deep_link, _result_model_fields, lines 3478-3944), and (f) standalone SQL CTE helper functions that should belong to the modules that own those visibility predicates. Services rule requires capability-oriented decomposition with small, deep interfaces; this file exposes a large surface and owns too many orthogonal concerns.

**Fix.** Split into at minimum four modules with clear ownership: (1) a thin search.py that exposes only search() and get_search_result() as the public API; (2) search_scope.py owning parse_scope, authorize_scope, and scope-filter SQL fragment generation (currently repeated in 10+ places inside every _search_* function); (3) search_query.py owning the per-type SQL query builders (_search_media, _search_podcasts, _search_content_chunks, _search_contributors, _search_fragments, _search_highlights, _search_messages, _search_conversations, _search_evidence_spans, _search_web_results) — these are called only inside search() and get_search_result(); (4) search_projection.py owning _result_to_out, _result_deep_link, _result_model_fields, _result_context_ref, _build_source_label, and the _Ranked* dataclasses. The cursor helpers (encode/decode) can either stay in search.py or move to a tiny search_cursor.py if they grow callers.

#### 🔴 2. visible_conversation_ids_cte_sql duplicates conversations.py._build_visibility_cte
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `python/nexus/services/search.py:561-594` · `python/nexus/services/conversations.py:335-360`  

**Problem.** search.py defines visible_conversation_ids_cte_sql() (lines 561-594) that encodes the identical three-UNION conversation visibility predicate (owner OR public OR library-shared-with-dual-membership) already owned by conversations.py._build_visibility_cte (lines 335-360). The bodies are semantically identical; only the column alias (conversation_id vs c.id) and CTE header differ. There are now two owners for conversation-visibility SQL — any change to the visibility rules must be replicated in both files. The SQL is also inlined at 6 call sites in search.py (lines 1295, 1337, 1362, 3004, 3078, 3253).

**Fix.** Move the canonical definition to nexus/auth/permissions.py alongside visible_media_ids_cte_sql(), or expose it from conversations.py as a public function (e.g. visible_conversation_ids_cte_sql). Delete the copy in search.py and replace all six inline uses with a single import. The conversations.py version should be made public (drop the leading underscore); the conversations.py version currently returns the CTE body prefixed with 'visible_conversations AS (' while the search.py version returns just the SELECT body, so align the interface to the pattern used by visible_media_ids_cte_sql (returns the inner SELECT body only, caller wraps in CTE name).

#### 🔴 3. get_search_result is a 650-line point-resolver with 13 if-chains on bare str, using untyped row indexing throughout
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §9`, `cleanliness.md §10`  
**Where:** `python/nexus/services/search.py:821-1472`  

**Problem.** get_search_result (lines 821-1472) dispatches on result_type: str with 13 consecutive if-blocks, each running its own raw SQL query (via db.execute(text(...))), constructing ad-hoc _Ranked* dataclasses and calling _result_to_out. The function is ~650 lines long. Every per-type block accesses row data by positional index (row[0], row[1], ..., row[20]) rather than named columns, making it extremely fragile. The parameter result_type: str admits any string; the runtime VALID_RESULT_TYPES check is the only guard. The function unconditionally ends with raise AssertionError (line 1472) rather than raise InvalidRequestError for an unrecognized type after the last if-block, which will produce a 500 rather than a 400 for a bad caller input if a type somehow slips through the earlier guard — though in practice the guard at line 829 prevents this.

**Fix.** Extract each per-type block from get_search_result into a _get_<type>_result(db, viewer_id, result_id, ...) private function collocated with its matching _search_<type> function. Replace the bare positional row indexing with SQLAlchemy RowMapping or named-column access (.mappings()). Change the parameter type from str to SEARCH_RESULT_TYPES Literal and derive exhaustive dispatch from it. The final unreachable AssertionError can then become an assert False or be removed entirely.

#### 🟠 4. SEARCH_RESULT_TYPES and APP_SEARCH_RESULT_TYPES are duplicate identical type authorities
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`, `cleanliness.md §9`  
**Where:** `python/nexus/schemas/search.py:23-38` · `python/nexus/schemas/conversation.py:32-47`  

**Problem.** SEARCH_RESULT_TYPES (schemas/search.py line 23) and APP_SEARCH_RESULT_TYPES (schemas/conversation.py line 32) are Literal types containing exactly the same 14 strings in different order. They are independent definitions with different names, and there is also a third runtime duplicate: the ALL_RESULT_TYPES tuple (services/search.py line 101) enumerates the same 14 values. Three separate locations own the authoritative list of valid search result types; any new type must be added to all three.

**Fix.** Define a single SEARCH_RESULT_TYPE Literal in nexus/schemas/search.py (or a dedicated nexus/schemas/result_types.py). Import and re-use it in schemas/conversation.py (replacing APP_SEARCH_RESULT_TYPES with the shared type or an alias). Derive ALL_RESULT_TYPES in services/search.py by calling get_args() on the shared Literal rather than maintaining a parallel tuple. Delete the two redundant definitions.

#### 🟠 5. contributor_credits_rollup_cte_sql is a search.py private SQL helper exposed as public but used nowhere else
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `python/nexus/services/search.py:597-653`  

**Problem.** contributor_credits_rollup_cte_sql is defined as a module-level public function (no underscore) in search.py and called exclusively from within search.py (13 call sites). No other module imports it. It also inlines the full contributor/alias/external-id join — logic that the contributors service already owns — but exposes it as a SQL fragment helper for use only in search queries. Its public naming implies it is part of search.py's contract, which inflates the module's public surface.

**Fix.** Rename to _contributor_credits_rollup_cte_sql (private). If the query-building split described in issue 1 is applied, this function moves with the query builders. No external callers to update.

#### 🟠 6. visible_conversation_ids_cte_sql and contributor_credits_rollup_cte_sql are public-named helpers living in the wrong owner
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/search.py:561-653`  

**Problem.** visible_conversation_ids_cte_sql encodes conversation visibility rules — a predicate owned by the conversations/permissions layer. contributor_credits_rollup_cte_sql encodes contributor credit aggregation logic owned by the contributor credits domain. Both live inside search.py, meaning the search module is a de facto second owner of those business rules. If either visibility predicate changes, the search module must be edited too, which violates the one-concern-one-owner principle.

**Fix.** Move visible_conversation_ids_cte_sql to nexus/auth/permissions.py (next to visible_media_ids_cte_sql). Move or eliminate contributor_credits_rollup_cte_sql — if the contributors service exposes a suitable helper, use it; otherwise move this private helper into the contributor credits module so that the SQL predicate lives with its owner.

#### 🟠 7. scope filter SQL is duplicated across every _search_* function body
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §5`  
**Where:** `python/nexus/services/search.py:1630-1685` · `python/nexus/services/search.py:1793-1820` · `python/nexus/services/search.py:1960-1985` · `python/nexus/services/search.py:2317-2358` · `python/nexus/services/search.py:2655-2671` · `python/nexus/services/search.py:2770-2795` · `python/nexus/services/search.py:2982-3001` · `python/nexus/services/search.py:3058-3073` · `python/nexus/services/search.py:3123-3141`  

**Problem.** Every _search_* function independently constructs a scope_filter string and populates scope-related params by switching on scope_type with the same four branches (all / media / library / conversation), each emitting structurally equivalent SQL. The scope-to-SQL mapping is repeated 9+ times across the file and contains subtle per-entity variations (e.g. media scope for conversations returns [], library scope for messages uses conversation_shares, etc.). This is exactly the pattern cleanliness.md §4 targets: near-identical branches repeated across functions. The existing authorize_scope function (lines 472-499) already does the permission check, but no parallel helper extracts the SQL fragment.

**Fix.** Introduce a typed ScopeFilter dataclass or named tuple that bundles the SQL snippet and the scope_id param. Create a per-entity scope-filter builder function, e.g. _media_scope_filter(scope_type, scope_id) -> ScopeFilter, eliminating the scattered switch statements. This also eliminates the 10 separate raise InvalidRequestError('Invalid scope format') clauses (currently triggered in 10 spots across the file: one per _search_* function plus object_search.py).

#### 🟡 8. parse_scope and hash_query are leaked as part of search.py's public API and consumed by app_search.py
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `module-apis.md`  
**Where:** `python/nexus/services/search.py:420-427` · `python/nexus/services/search.py:443-469` · `python/nexus/services/agent_tools/app_search.py:49`  

**Problem.** app_search.py imports hash_query and parse_scope directly from search.py (line 49), treating them as part of the search module's public contract. These are utility helpers — parse_scope is an input-parsing step and hash_query is a privacy-safe logging primitive — neither is a domain operation of the search service itself. Exposing them forces the search module to maintain backwards compatibility for utilities that belong elsewhere.

**Fix.** Move parse_scope to a search_scope.py module (or nexus/api/query_params.py for input parsing). Move hash_query to nexus/logging.py or a privacy_utils.py. Update app_search.py to import from the new owner. This trims search.py's public surface to search() and get_search_result().

#### 🟡 9. visible_podcasts CTE is inlined redundantly in search.py in three separate queries
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/search.py:886-896` · `python/nexus/services/search.py:1823-1836` · `python/nexus/services/search.py:2363-2376`  

**Problem.** The visible_podcasts CTE (selecting podcast_subscriptions + library_entries memberships) is inlined verbatim in three separate SQL strings inside search.py (and also in contributors.py and object_refs.py). Unlike visible_media_ids_cte_sql which was extracted and lives in auth/permissions.py, there is no shared helper for visible podcasts. The same SQL logic is duplicated every time a query needs to check podcast visibility.

**Fix.** Add a visible_podcast_ids_cte_sql() function to nexus/auth/permissions.py alongside visible_media_ids_cte_sql(). Replace all inline copies in search.py, contributors.py, and object_refs.py with calls to the new helper.


<a id="py-agent-tools"></a>
## Agent tools (chat tool layer)  · `py-agent-tools`
*8 issues (2 High)*  

> **Verdict.** app_search.py (1215 lines) is a clear god file: it mixes tool definition, orchestration, database persistence, search fan-out, empty-status diagnosis, and multi-table XML rendering of at least 10 distinct domain entity types. web_search.py (667 lines) is also oversized, owning both the search orchestration layer and a full duplicate persistence implementation that bypasses the established retrieval_citation.insert_retrieval_row canonical path. The worst rot is: (1) app_search.py's render slab (_render_single_retrieved_context plus 10 per-type helpers, lines 828–1215) is effectively a second presentation layer embedded inside a service file, (2) web_search.py's persist_web_search_run completely re-implements the message_retrievals upsert pattern that retrieval_citation already provides as the single validated path, and (3) the LLM-facing tool output for app_search and web_search is split across two modules (chat_runs._app/web_search_tool_output) instead of living on the run objects as it does for read_resource and inspect_resource."


#### 🔴 1. app_search.py is a god file: split off context rendering from search orchestration
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/agent_tools/app_search.py:1-1215` · `python/nexus/services/agent_tools/app_search.py:800-1215`  

**Problem.** app_search.py (1215 lines) mixes four unrelated concerns in one file: (1) tool definition and public contract (lines 59–143), (2) search orchestration and scope resolution (lines 148–503), (3) database persistence of message_tool_calls / message_retrievals / message_rerank_ledgers (lines 536–797), and (4) XML rendering of retrieved context — a 415-line slab containing 10 per-type _render_* functions that each issue their own raw SQL queries against media, fragments, content_chunks, evidence_spans, note_blocks, pages, highlights, conversations, messages, and podcasts (lines 800–1215). The rendering concern is effectively a second presentation layer embedded inside a service file; it has no business owning per-entity SQL queries.

**Fix.** Extract the rendering slab into a dedicated module, e.g. nexus/services/agent_tools/app_search_context.py (or nexus/services/retrieval_context_renderer.py). Its public contract: render_retrieved_context_blocks(db, viewer_id, citations) -> tuple[str, int, list[RetrievalCitation]]. All 10 _render_* helpers and their SQL stay internal to that module. app_search.py imports only the public function. This removes ~415 lines from app_search.py and gives the rendering concern a single, testable owner.

#### 🔴 2. web_search.py duplicates the message_retrievals upsert path that retrieval_citation.insert_retrieval_row already owns
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/agent_tools/web_search.py:362-555` · `python/nexus/services/retrieval_citation.py:285-373`  

**Problem.** web_search.py:persist_web_search_run (lines 228–595) contains its own full inline SQL for SELECT/INSERT/UPDATE on message_retrievals (lines 362–530). The project already has retrieval_citation.insert_retrieval_row as the canonical, validator-enforced single path for writing message_retrievals rows — and app_search.py correctly uses it (line 706). web_search.py bypasses this owner entirely, duplicating the upsert logic with a slightly different shape (no scope, no evidence_span_id, no section_label). This creates two code paths for the same mutation and risks divergence in schema evolution.

**Fix.** Refactor persist_web_search_run to use insert_retrieval_row from retrieval_citation.py for each citation, exactly as app_search does. Model the web_result citation as a WebSearchCitation-to-RetrievalCitation adapter (or let WebSearchCitation implement the interface insert_retrieval_row expects). The inline INSERT/UPDATE/SELECT SQL blocks for message_retrievals in web_search.py (lines 362–555) can then be deleted.

#### 🟠 3. Tool LLM output is split across modules: AppSearchRun/WebSearchRun have no tool_output(); chat_runs owns that rendering instead
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §5`, `module-apis.md`  
**Where:** `python/nexus/services/chat_runs.py:278-320` · `python/nexus/services/agent_tools/read_resource.py:103-129` · `python/nexus/services/agent_tools/inspect_resource.py:62-100`  

**Problem.** ReadResourceResult and InspectResourceResult each own a tool_output() method — the authoritative XML/JSON the LLM receives. But AppSearchRun and WebSearchRun have no tool_output(); instead chat_runs.py owns two private helpers _app_search_tool_output (lines 278–297) and _web_search_tool_output (lines 300–320) that produce the LLM-facing JSON from the run objects. This violates the single-owner rule: the contract between the agent tool and the LLM is split across files. Adding a new field to the tool output requires touching chat_runs.py, not the tool module.

**Fix.** Add a tool_output(start_ordinal: int) -> str method to AppSearchRun and WebSearchRun (parallel to ReadResourceResult.tool_output). Delete _app_search_tool_output and _web_search_tool_output from chat_runs.py and call run_result.tool_output(start_n) at the two call sites. This is a simple, safe refactor that aligns ownership with the pattern already established by the other two tools.

#### 🟠 4. _scoped_content_chunk_empty_status issues raw SQL against content indexing tables from inside the agent_tools layer
`Medium` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/agent_tools/app_search.py:432-503`  

**Problem.** _scoped_content_chunk_empty_status (lines 432–503) issues a 30-line raw SQL query that joins content_chunks, media, visible_media CTE, media_content_index_states, content_index_runs, and evidence_spans — tables that belong to the content indexing domain. This business logic (distinguishing 'no_results' from 'no_indexed_evidence') requires knowledge of the content indexing schema and should not live in the agent_tools layer. It is also untested via the public execute_app_search surface.

**Fix.** Move this query to a function in nexus/services/search.py (or a dedicated nexus/services/content_index_status.py), e.g. get_scoped_content_chunk_status(db, viewer_id, scope, filters) -> Literal['no_results', 'no_indexed_evidence']. The agent_tools layer calls the function; it does not own the SQL. This keeps content-indexing schema knowledge in the services that own indexing.

#### 🟡 5. _xml_attr is defined identically in three agent_tools files — belongs in a shared utility
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/agent_tools/app_search.py:55-56` · `python/nexus/services/agent_tools/read_resource.py:73-74` · `python/nexus/services/agent_tools/inspect_resource.py:46-47`  

**Problem.** The one-liner `def _xml_attr(value: object) -> str: return xml_escape(str(value), {'"': '&quot;'})` is copy-pasted verbatim in three of the four agent_tools files. The fourth (web_search.py) uses xml_escape directly without the attribute quoting variant. This is a small but concrete duplication of a non-trivial helper (the double-quote escaping is easy to get wrong).

**Fix.** Define _xml_attr once in a private shared location — either a new nexus/services/agent_tools/_xml.py or inlined into a nexus/services/agent_tools/__init__.py if that is kept thin — and import it in the three files. The function is genuinely shared and the duplication is large enough (not mere formatting) to fix.

#### 🟡 6. web_search.py uses its own inline SHA-256 hash instead of search.hash_query — two owners for query hashing
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/services/agent_tools/web_search.py:652` · `python/nexus/services/search.py:420-426`  

**Problem.** search.hash_query(q) exists as the canonical privacy-safe query hash (normalizes, truncates to 16 hex chars). web_search.py bypasses it with a raw hashlib.sha256 call that produces a full 64-char digest (line 652). The two functions produce different values for the same query, making log correlation between app_search and web_search impossible despite both claiming to record a privacy-safe query_hash for the same message_tool_calls column.

**Fix.** web_search.py should import and call hash_query from nexus.services.search instead of calling hashlib directly. The raw_query normalization already happens (line 611: strip + truncate), so hash_query can receive raw_query directly. Delete the hashlib import from web_search.py.

#### 🟡 7. execute_app_search parameter names planned_query/planned_types/planned_filters are immediately rebound — vestigial indirection
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §12`  
**Where:** `python/nexus/services/agent_tools/app_search.py:156-165`  

**Problem.** execute_app_search receives parameters named planned_query, planned_types, and planned_filters (lines 156–158), then immediately rebinds them to query, requested_types, and filters (lines 163–165). The 'planned_' prefix is a naming artifact that adds no information at the call site or inside the function; the body never references the planned_ names again. This is a staging variable that only moves the eye.

**Fix.** Rename the parameters to query, types, and filters directly. Update the single caller in chat_runs.py (lines 1299–1304). No logic change required.

#### 🟡 8. module docs for chat.md and oracle.md are empty — design contract is undocumented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`, `cleanliness.md §13`  
**Where:** `docs/modules/chat.md` · `docs/modules/oracle.md`  

**Problem.** Both docs/modules/chat.md and docs/modules/oracle.md exist as 1-line empty files. These are the intended design contracts for the slice being audited (the agent tool layer belongs to the chat/oracle capability). Without a doc, there is no authoritative statement of what these modules own, what their public surface is, or how the four agent tools relate to the chat pipeline. This makes it impossible to flag doc-vs-code drift.

**Fix.** Write minimal module docs for chat.md and oracle.md covering: the four agent tools and their public contracts (execute_*), what chat_runs.py is permitted to call vs what it must not cross into (e.g. private render helpers, direct persist SQL), and the retrieval_citation.py ownership of message_retrievals writes. This also serves as the authoritative test for whether future additions respect the layer boundary.


<a id="py-media-core"></a>
## Media service core  · `py-media-core`
*10 issues (5 High)*  

> **Verdict.** media.py is a 2710-line god file that owns at least six unrelated capabilities simultaneously: (1) media hydration/listing, (2) podcast listening-state CRUD, (3) web-article and X-thread ingest, (4) YouTube video create-or-reuse, (5) remote-file (PDF/EPUB) download and staging, and (6) EPUB asset serving. The worst structural rot is the ingest side: X-author-thread, X-oEmbed, and YouTube ingestion pipelines each carry full create-media, build-fragment, insert-blocks, replace-credits, assign-library, enqueue-job, rebuild-index flows in one monolithic file, making the 2700-line count almost entirely earned by co-located unrelated concerns. A secondary problem is partial ownership of processing-state transitions: _reset_media_for_reingest duplicates the semantics of media_processing_state.begin_extraction rather than calling it, leaving two owners of the same state machine. The schemas file is also a catch-all that bundles reader navigation, EPUB section, transcript admission, media evidence, and upload schemas together with no governing concern.


#### 🔴 1. Split media.py: X-thread ingest, X-oEmbed ingest, YouTube ingest, and remote-file ingest are unrelated pipelines living in one god file
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/media.py:1526-1708 (create_or_reuse_x_author_thread_article)` · `python/nexus/services/media.py:1741-1892 (_refresh_x_author_thread_media_for_viewer)` · `python/nexus/services/media.py:1940-2008 (_create_or_reuse_x_snapshot_post_media)` · `python/nexus/services/media.py:2011-2042 (_build_x_fragment)` · `python/nexus/services/media.py:2045-2087 (_rebuild_web_article_index_or_mark_failed)` · `python/nexus/services/media.py:2089-2265 (create_or_reuse_x_oembed_article)` · `python/nexus/services/media.py:2268-2352 (create_or_reuse_youtube_video)` · `python/nexus/services/media.py:963-1128 (_download_remote_file, _create_file_media_from_remote_url)`  

**Problem.** media.py mixes at least four orthogonal ingestion pipelines — X-author-thread (API-based, multi-fragment), X-oEmbed (HTML scrape, single fragment), YouTube (identity-only stub), and remote PDF/EPUB file download — alongside media hydration queries, listening-state CRUD, and EPUB asset serving. Each pipeline carries its own full create-media + build-fragment + insert-blocks + replace-credits + assign-library + enqueue-job + rebuild-index sequence. The result is a 2710-line file where adding or fixing any one pipeline requires reading and reasoning about all others.

**Fix.** Extract into three new service modules, each owning one capability end-to-end:

1. `python/nexus/services/x_ingest.py` — owns `create_or_reuse_x_author_thread_article`, `_refresh_x_author_thread_media_for_viewer`, `_create_or_reuse_x_snapshot_post_media`, `_build_x_fragment`, `_rebuild_web_article_index_or_mark_failed`, and the `_WebArticleIndexTarget` dataclass. Public contract: `ingest_x_url(db, viewer_id, url, library_ids) -> FromUrlResponse` and `refresh_x_media(db, viewer_id, media, ...) -> dict`.

2. `python/nexus/services/youtube_ingest.py` — owns `create_or_reuse_youtube_video` and `_enqueue_youtube_ingest_task`. Public contract: `ingest_youtube_url(db, viewer_id, url, *, enqueue, request_id) -> FromUrlResponse`.

3. `python/nexus/services/remote_file_ingest.py` — owns `_download_remote_file`, `_remote_file_kind_from_url`, `_remote_file_name`, `_create_file_media_from_remote_url`, and the `_REMOTE_FILE_*` constants. Public contract: `ingest_remote_file_url(db, viewer_id, url, kind, request_id) -> FromUrlResponse`.

`media.py` retains only the dispatcher `enqueue_media_from_url` that calls these three services, plus hydration, listing, and listening-state logic.

#### 🔴 2. Split media.py: EPUB asset serving and listening-state CRUD belong in their own service modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/media.py:2576-2710 (EpubAssetOut, _EpubAssetMetadata, get_epub_asset_for_viewer, _get_epub_asset_metadata_for_viewer)` · `python/nexus/services/media.py:462-492 (get_listening_state_for_viewer)` · `python/nexus/services/media.py:632-718 (_position_meets_completion_threshold, upsert_listening_state_for_viewer)` · `python/nexus/services/media.py:720-788 (batch_mark_listening_state_for_viewer)`  

**Problem.** EPUB asset serving (storage integrity check, content-type allowlist, per-key metadata lookup) and podcast listening-state upsert/batch logic are completely independent capabilities with no shared data path. Both are buried inside media.py solely because the route file imports from it, creating unnecessary coupling. `EpubAssetOut` and `_EpubAssetMetadata` are service-private types that have no business being in the media hydration module.

**Fix.** Move EPUB asset logic to `python/nexus/services/epub_assets.py` — public contract: `get_epub_asset_for_viewer(*, session_factory, viewer_id, media_id, asset_key, storage_client) -> EpubAssetOut`. Move listening-state logic to `python/nexus/services/listening_state.py` — public contract: `get_listening_state(db, viewer_id, media_id) -> ListeningStateOut`, `upsert_listening_state(db, viewer_id, media_id, *, ...) -> None`, `batch_mark_listening_state(db, viewer_id, *, media_ids, is_completed) -> None`. Both route handlers in `media.py` and `media_events.py` import the respective new module instead of the monolithic `media` service.

#### 🔴 3. Dead function: create_or_reuse_x_oembed_article is unreachable from any caller
`High` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `python/nexus/services/media.py:2089-2265 (create_or_reuse_x_oembed_article)`  

**Problem.** A grep across the entire repository finds exactly one occurrence of `create_or_reuse_x_oembed_article` — its own definition. It is not called by `enqueue_media_from_url`, any route, any test, or any script. The function contains a full X oEmbed HTTP fetch (177 lines), contributor-credits insertion, content-index rebuild, and enrich dispatch — all unreachable dead code. The `_X_OEMBED_TIMEOUT` constant at line 121 exists only for this dead function.

**Fix.** Delete `create_or_reuse_x_oembed_article` (lines 2089-2265) and the `_X_OEMBED_TIMEOUT` constant (line 121). Confirm that the `x_oembed_article` source value in `python/nexus/services/contributor_credits.py:68` is also no longer reachable; if so, remove that branch as well.

#### 🔴 4. Duplicate processing-state transition: _reset_media_for_reingest re-implements media_processing_state.begin_extraction
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/media.py:836-846 (_reset_media_for_reingest)` · `python/nexus/services/media_processing_state.py:32-45 (begin_extraction)`  

**Problem.** Both functions set `processing_status = extracting`, clear the same five failure-field columns (`failure_stage`, `last_error_code`, `last_error_message`, `failed_at`), and stamp `updated_at`. `_reset_media_for_reingest` additionally clears `processing_completed_at` and uses `datetime.now(UTC)` (Python time) where `begin_extraction` uses `func.now()` (DB time) — a subtle behavioural difference with no rationale. `media_processing_state.py` was explicitly created to be the single owner of these transitions, but `media.py` bypasses it with its own private copy.

**Fix.** Add a `reset_for_reingest(db, media)` function to `media_processing_state.py` that clears `processing_completed_at` and uses `func.now()` consistently. Replace the four calls to `_reset_media_for_reingest` in `media.py` with calls to the new function, then delete `_reset_media_for_reingest` and its module-level `datetime` import (which is only used there and in ingest helpers that already have their own `now = datetime.now(UTC)`).

#### 🔴 5. Service layer performs HTTP I/O directly (httpx.Client) in _download_remote_file and create_or_reuse_x_oembed_article
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/media.py:973-1048 (_download_remote_file — httpx.Client, streaming, redirect loop)` · `python/nexus/services/media.py:2120-2145 (create_or_reuse_x_oembed_article — httpx.Client)`  

**Problem.** The rules require that edge adapters (HTTP clients, vendor SDKs) are kept behind driver/client services and do not own business rules, and that services must not import from HTTP/framework types. `_download_remote_file` implements a full redirect-following streaming HTTP download loop inside the service layer, complete with SSRF validation borrowed from `image_proxy`. This couples the service to transport concerns and makes it untestable without mocking `httpx`. The X oEmbed fetch in the dead `create_or_reuse_x_oembed_article` has the same problem.

**Fix.** Create `python/nexus/services/remote_file_client.py` (or extend `image_proxy.py` as a more general outbound HTTP adapter) that owns the raw HTTP download behaviour — redirect following, size limiting, SSRF validation — and exposes a typed result. `remote_file_ingest.py` (see god-file finding) calls this adapter and translates its result into domain types. The service layer never imports `httpx` directly.

#### 🟠 6. Duplicate enrich-dispatch helpers: _try_enrich_dispatch and _try_enrich_dispatch_with_session differ only in session ownership
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/media.py:2393-2408 (_try_enrich_dispatch)` · `python/nexus/services/media.py:2411-2426 (_try_enrich_dispatch_with_session)`  

**Problem.** The two functions are identical except that `_try_enrich_dispatch` creates its own session by calling `get_session_factory()()` while `_try_enrich_dispatch_with_session` accepts the caller's `db`. Both enqueue the same `enrich_metadata` job, swallow `SQLAlchemyError`, log the same warning, and commit or rollback the same way. There is no substantive difference that justifies two separate functions.

**Fix.** Collapse to a single `_try_enrich_dispatch(db, media_id, request_id)` that accepts a session. Update the two callers that currently use the no-arg session variant (`create_captured_web_article` at line 1243 and `create_or_reuse_x_oembed_article` at line 2258) to pass their existing `db`. Delete `_try_enrich_dispatch` (the session-creating version) entirely.

#### 🟠 7. schemas/media.py is a catch-all schema file mixing five unrelated schema groups
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `python/nexus/schemas/media.py:1-557` · `python/nexus/schemas/media.py:480-557 (ReaderNavigationSectionOut, MediaNavigationOut, EpubSectionOut — owned by reader_navigation/epub_read services)` · `python/nexus/schemas/media.py:344-478 (MediaEvidence* — owned by locator_resolver)` · `python/nexus/schemas/media.py:260-293 (TranscriptRequest* — owned by podcasts/transcripts service)`  

**Problem.** The schemas file bundles: core media hydration types (MediaOut, FragmentOut), upload/ingest request/response types, listening-state types, transcript admission types (TranscriptRequestRequest/Response), media evidence resolver types (MediaEvidence*), and reader navigation types (ReaderNavigationSectionOut, MediaNavigationOut, EpubSectionOut). The reader navigation schemas are imported exclusively by `reader_navigation.py` and `epub_read.py`; the evidence schemas are used only by `locator_resolver.py` and the media route; transcript schemas are used only by the podcast transcript service and the media route. Placing them all in `schemas/media.py` hides the true ownership of each group and bloats the public surface.

**Fix.** Split into capability-aligned schema files:
- `python/nexus/schemas/reader.py` (or co-locate with `reader_navigation.py`) for `ReaderNavigationSectionOut`, `ReaderNavigationTocNodeOut`, `ReaderNavigationLocationOut`, `MediaNavigationOut`, `EpubSectionOut`.
- `python/nexus/schemas/evidence.py` (or co-locate with `locator_resolver.py`) for all `MediaEvidence*` classes.
- `python/nexus/schemas/transcripts.py` (or co-locate with `podcasts/transcripts.py`) for `TranscriptRequest*` and `TranscriptForecast*` classes.
- `python/nexus/schemas/media.py` retains only the media hydration and ingest schemas that are central to the media service public contract.

#### 🟠 8. Route file /media/from_url and /media/capture/url are interchangeable duplicate API endpoints
`Medium` · `High-confidence` · `Duplication` · rules: `module-apis.md`, `cleanliness.md §4`  
**Where:** `python/nexus/api/routes/media.py:177-210 (POST /media/from_url via get_viewer)` · `python/nexus/api/routes/media.py:262-276 (POST /media/capture/url via get_extension_viewer)`  

**Problem.** Both routes call `media_service.enqueue_media_from_url` with identical arguments extracted from the same `FromUrlRequest` schema. The only difference is the auth dependency (`get_viewer` vs `get_extension_viewer`). This exposes two public API paths for the same capability, violating the one-primary-form rule from module-apis.md.

**Fix.** Determine the intended caller for each path. If `/media/capture/url` exists only for browser-extension clients that authenticate differently, document that explicitly and keep both but add a comment. If `/media/from_url` already serves both client types, delete `/media/capture/url` and update the extension client to use the canonical endpoint. Either way the doc on `FromUrlRequest` should state which endpoint(s) it belongs to.

#### 🟡 9. Double validation of listening-state mutation precondition in schema validator and service function
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/schemas/media.py:222-233 (ListeningStateUpsertRequest.validate_has_mutation_field)` · `python/nexus/services/media.py:649-658 (upsert_listening_state_for_viewer — duplicate guard)`  

**Problem.** The Pydantic model `ListeningStateUpsertRequest` already raises a `ValueError` if all four fields are `None` via `@model_validator`. `upsert_listening_state_for_viewer` in the service then re-checks the exact same condition and raises `InvalidRequestError`. Because the route handler validates the request body through the Pydantic model before calling the service, the service guard can never fire in normal operation — it is defensive dead code that drifts alongside the schema check.

**Fix.** Delete the guard at `media.py:649-658`. The Pydantic schema is the correct boundary for this syntactic constraint. If the service is ever called programmatically with raw kwargs (e.g. from tests), a call contract assertion (`assert not all-None`) is sufficient; a full `InvalidRequestError` path through the service adds no production value.

#### 🟡 10. Stale module docs: docs/modules/video.md and docs/modules/library.md are empty
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/video.md` · `docs/modules/library.md`  

**Problem.** Both module docs are 1-line empty files. The audit was directed to read them as the intended design — but they provide no design signal. The code that implements video ingest (create_or_reuse_youtube_video, YouTube identity classification) and the library-assignment patterns inside media.py have no documented design contract to drift from or conform to. Empty docs are themselves a form of bit-rot: they exist as stubs that suggest a design was once planned but never recorded.

**Fix.** Either populate each file with a concise module contract (owned capabilities, public interface, what is out of scope) or delete the files if the module has no design that differs from the code. The video module is especially important to document given the YouTube ingest god-file problem above.


<a id="py-media-deletion"></a>
## Media deletion & sharing  · `py-media-deletion`
*6 issues (1 High)*  

> **Verdict.** media_deletion.py (747 lines) is the dominant problem in this slice: it owns at least five distinct concerns in one file (viewer-scoped deletion, global hard deletion, orphan/duplicate cleanup, per-user media state teardown, and storage lifecycle). shares.py is small and coherent but deviates from the project's transaction-management convention by calling db.flush()/db.commit() directly and embeds a membership-check helper that belongs to the libraries layer. object_links.py is a clean, thin route handler with no material issues. The sharing module doc (docs/modules/sharing.md) is empty, so there is no authoritative design contract to drift against.


#### 🔴 1. Split media_deletion.py: five unrelated concerns in one 747-line file
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/media_deletion.py:1-748`  

**Problem.** media_deletion.py mixes five distinct concerns in one file: (1) viewer-scoped deletion that removes media from the viewer's libraries and hides or hard-deletes (delete_document_for_viewer, lines 34-184); (2) per-library removal with library-entry and default-closure housekeeping (remove_document_from_library, lines 187-289); (3) hard-deletion of globally unreferenced media including cascade teardown of highlights, fragments, epub tables, podcast tables, conversation references, and content index (delete_document_media_if_unreferenced, lines 364-532); (4) duplicate/abandoned media cleanup for ingest workflows (delete_duplicate_document_media, delete_abandoned_document_media, _delete_document_media_with_references, lines 303-354); and (5) per-user media state teardown (object_links, conversation_media, highlights, reader state, playback state) extracted into _delete_viewer_media_state (lines 556-673). Each of these concerns has different callers, lifecycles, and invariants.

**Fix.** Decompose into at minimum three focused modules with narrow public contracts: (a) a viewer deletion command module (owns delete_document_for_viewer and remove_document_from_library, the two public entry points called by the route handler); (b) a media hard-delete module (owns delete_document_media_if_unreferenced and _delete_document_media_with_references — the global cascade — exposed as a single named command called by library deletion and the duplicate/abandoned cleanup paths); (c) a user media state teardown module (owns the _delete_viewer_media_state body, called by the viewer deletion path). The ingest cleanup helpers (delete_duplicate_document_media, delete_abandoned_document_media) can remain in the viewer deletion module or move to ingest_recovery since their callers are ingest tasks. clear_user_media_deletion is a single-row delete called by libraries.py and ingest tasks; it should stay with or near the viewer deletion module. Each module exposes one named command with typed params, and storage deletion is wired only at the top-level command boundary, not threaded through the cascade.

#### 🟠 2. Duplicate object_links deletion for content_chunk type between media_deletion and content_indexing
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/media_deletion.py:392-411` · `python/nexus/services/content_indexing.py:1329-1346`  

**Problem.** delete_document_media_if_unreferenced explicitly deletes object_links rows where a_type='content_chunk' or b_type='content_chunk' (lines 403-408). It then calls delete_media_content_index at line 452, which performs the identical delete (content_indexing.py lines 1332-1346). The second delete is always a no-op because all matching rows were removed by the first. This duplicates the ownership of object_links cleanup for content_chunks: media_deletion claims ownership before delegating to content_indexing which claims the same ownership.

**Fix.** Remove the content_chunk branches from the object_links DELETE in media_deletion.py (lines 403-408). Let delete_media_content_index be the sole owner of content_chunk object_link teardown, since content_indexing already owns all other content_chunk table mutations. The media-level object_links DELETE in media_deletion should cover only the 'media' and 'highlight' arms, which content_indexing does not handle.

#### 🟡 3. shares.py manages its transaction with raw db.flush/db.commit instead of the project's transaction() context manager
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §1`, `cleanliness.md §13`  
**Where:** `python/nexus/services/shares.py:159-161`  

**Problem.** set_conversation_shares_for_owner calls db.flush(), db.commit(), and db.refresh(conversation) directly (lines 159-161). Every other service in the codebase that owns mutations (libraries, media_deletion, media, podcasts) uses the transaction() context manager from nexus.db.session, which commits on success and rolls back on exception. The manual sequence here is inconsistent and omits the rollback-on-exception guarantee; if an exception occurs between flush and commit the session is left in an inconsistent state. The db.refresh after commit is unnecessary because expire_on_commit=False is set on the session factory.

**Fix.** Wrap the writes in set_conversation_shares_for_owner with the transaction() context manager (from nexus.db.session import transaction). Remove the explicit db.flush(), db.commit(), and db.refresh() calls. The conversation's sharing field will be visible after commit without a refresh because the session is configured with expire_on_commit=False.

#### 🟡 4. delete_document_storage_objects is a one-use indirection wrapper adding no value
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `python/nexus/services/media_deletion.py:357-361`  

**Problem.** delete_document_storage_objects (lines 357-361) is a three-line public function that does nothing except delegate to _delete_storage_objects(storage_paths, None). Its only external caller is python/nexus/tasks/ingest_web_article.py (lines 477, 503). The wrapper adds a name that diverges from the underlying capability without hiding any real complexity.

**Fix.** Remove delete_document_storage_objects. Have ingest_web_article.py call _delete_storage_objects directly, or — if that violates the public/private boundary — expose _delete_storage_objects under a cleaner name as the single storage-delete entry point. This collapses a one-level indirection stack that only renames property access.

#### 🟡 5. docs/modules/sharing.md is empty — no module design contract exists
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/sharing.md`  

**Problem.** The sharing module doc is an empty file (0 bytes). The sharing slice (shares.py, conversation share routes) has clear ownership rules documented only in the service file's docstring (lines 2-8 of shares.py). There is no authoritative module-level design contract covering sharing lifecycle, who can call the service, what the invariants are, or what the public API surface is. The audit was directed to flag doc drift but there is no doc to drift against.

**Fix.** Write a minimal docs/modules/sharing.md that documents: the sharing capability scope (conversation-to-library sharing, owner-only management, atomic replacement), the public API surface (get_conversation_shares_for_owner, set_conversation_shares_for_owner), the key invariants (owner-only, dedup, default-library forbidden, billing gate, empty targets transition to private), and the single caller (conversations route handler). This is a documentation gap, not a code issue, but the empty file is misleading.

#### 🟡 6. is_member_of_library in shares.py is a misplaced private membership query that duplicates libraries.py capability
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `python/nexus/services/shares.py:25-32` · `python/nexus/services/libraries.py:1191-1214`  

**Problem.** shares.py exposes is_member_of_library as a public function (line 25) but it is only called once within the same file (line 128). It queries the memberships table directly — the same table that libraries.py's _fetch_library_with_membership and numerous inline membership JOINs already own. The Membership model import and the memberships table query live in the shares module rather than in libraries where membership semantics belong. No external callers import this function (confirmed by grep).

**Fix.** Inline the is_member_of_library call at its single use site (line 128), replacing it with a call to a thin public helper in libraries.py (e.g., a new user_is_library_member(db, user_id, library_id) function) or with the existing _fetch_library_with_membership query if the library object is already being fetched in the same block. This removes the Membership model import from shares.py and consolidates membership queries in the library layer.


<a id="py-podcast-transcripts"></a>
## Podcast/transcript pipeline  · `py-podcast-transcripts`
*10 issues (2 High)*  

> **Verdict.** transcripts.py is a severe god file at 2824 lines that bundles at least six unrelated concerns: admission-gate logic with quota reservation, the Deepgram provider adapter, job lifecycle state machines, semantic-index repair orchestration, transcript version management, and video-retry plumbing. The worst rot is the ownership boundary collapse between transcripts.py and sync.py: sync.py directly imports six underscore-prefixed private helpers from transcripts.py, meaning two files co-own the transcript-version write path with no defined public contract between them. A secondary but concrete problem is the embedding_config_hash formula duplicated three times across two files, and a dead private function that was never wired up.


#### 🔴 1. Split transcripts.py god file: extract Deepgram provider adapter, quota ledger, job state machine, and semantic-repair orchestrator into separate modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/podcasts/transcripts.py:1-2824`  

**Problem.** At 2824 lines, transcripts.py bundles at least six unrelated concerns in one file: (1) admission gate with entitlement checks (lines 113–563), (2) batch and forecast orchestration (lines 566–706), (3) Deepgram HTTP adapter including raw payload parsing (lines 2571–2824), (4) quota reservation ledger (lines 2206–2533), (5) podcast transcription job state machine — claim/heartbeat/complete/fail (lines 879–1192, 1194–1525), and (6) semantic-index repair orchestration (lines 1528–1705). Services must own a capability end-to-end with a small semantic interface; a single file that touches Deepgram HTTP, PostgreSQL usage daily rows, threading heartbeats, content-index state, and viewer entitlement checks violates both the god-file and service-decomposition rules.

**Fix.** Extract into four focused modules under python/nexus/services/podcasts/: (a) deepgram_adapter.py — owns Deepgram HTTP call, response parsing (_transcribe_with_deepgram, _extract_deepgram_segments, _transcribe_real_media_fixture, _seconds_to_ms, _word_range_end_ms), public contract: fetch_podcast_transcript(audio_url) -> TranscriptResult; (b) transcription_quota.py — owns podcast_transcription_usage_daily rows, public contract: reserve_minutes(db, user_id, ...) -> QuotaSnapshot / release_minutes / commit_minutes; (c) transcription_job.py — owns podcast_transcription_jobs rows and heartbeat thread (run_podcast_transcription_now, claim/complete/fail helpers, heartbeat), public contract: run_transcription(db, media_id, ...) -> JobOutcome; (d) keep transcripts.py as a thin admission+orchestration coordinator calling those services. The existing public functions (request_podcast_transcript_for_viewer, repair_podcast_transcript_semantic_index_now, etc.) stay as the outer interface.

#### 🔴 2. sync.py imports six private (_-prefixed) helpers from transcripts.py, creating an undeclared shared write path for transcript versions
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `python/nexus/services/podcasts/sync.py:65-71` · `python/nexus/services/podcasts/transcripts.py:2068 (_create_next_transcript_version)` · `python/nexus/services/podcasts/transcripts.py:1757 (_set_media_transcript_state)` · `python/nexus/services/podcasts/transcripts.py:2142 (_insert_transcript_segments_for_version)` · `python/nexus/services/podcasts/transcripts.py:2189 (_rebuild_transcript_content_index_for_version)` · `python/nexus/services/podcasts/transcripts.py:1708 (_ensure_media_transcript_state_row)` · `python/nexus/services/podcasts/transcripts.py:959 (_try_enqueue_metadata_enrichment)`  

**Problem.** sync.py imports _create_next_transcript_version, _ensure_media_transcript_state_row, _insert_transcript_segments_for_version, _rebuild_transcript_content_index_for_version, _set_media_transcript_state, and _try_enqueue_metadata_enrichment — all underscore-prefixed private helpers — from transcripts.py. This makes two modules co-owners of the transcript-version creation flow (podcast_transcript_versions table, fragments, podcast_transcript_segments, media_transcript_states) with no public contract between them. Any change to the private helpers risks silently breaking the sync path. cleanliness.md §6 forbids cross-module imports of private helpers; they must either move to the owner or be exposed as one public function.

**Fix.** Expose a single public function in transcripts.py (or a new transcript_version_writer.py): write_transcript_version(db, media_id, transcript_segments, *, created_by_user_id, request_reason, transcript_coverage, now) -> TranscriptVersionResult that wraps _create_next_transcript_version, _insert_transcript_segments_for_version, insert_transcript_fragments, the fragment index bump, and _set_media_transcript_state. sync.py calls only this one public operation. Similarly, expose try_enqueue_metadata_enrichment (drop the underscore) if sync.py needs it. The private helpers remain private to transcripts.py.

#### 🟠 3. Video retry logic (_enqueue_video_transcription_retry, related branches in retry_transcript_media_for_viewer) lives inside the podcast transcript service
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/services/podcasts/transcripts.py:709-845 (retry_transcript_media_for_viewer)` · `python/nexus/services/podcasts/transcripts.py:983-1018 (_enqueue_video_transcription_retry)` · `python/nexus/services/podcasts/transcripts.py:739 (kind in {podcast_episode, video} check)` · `python/nexus/services/podcasts/transcripts.py:793-838 (video retry branch)`  

**Problem.** retry_transcript_media_for_viewer handles both podcast_episode and video kinds; when kind == video it calls _enqueue_video_transcription_retry which enqueues an ingest_youtube_video job and writes media failure state directly in the podcast transcripts file. Video retry is an unrelated concern: it has different job kind, different state machine, no quota accounting, and is called from pdf_lifecycle.py (which routes multi-kind retries). This mixes video ingest and podcast transcript concerns in a single service file, violating the one-concern-one-owner rule.

**Fix.** Move the video retry path into a video-appropriate service (e.g., python/nexus/services/youtube/ingest.py or a new video_lifecycle.py). pdf_lifecycle.py's routing switch can then call the video service directly rather than routing through the podcast transcripts module. Remove _enqueue_video_transcription_retry from transcripts.py and narrow retry_transcript_media_for_viewer to podcast_episode only.

#### 🟠 4. mark_podcast_transcription_failure_for_recovery is a one-line public wrapper that adds no behavior over _mark_podcast_transcription_failure
`Medium` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §6`  
**Where:** `python/nexus/services/podcasts/transcripts.py:1089-1108 (mark_podcast_transcription_failure_for_recovery)` · `python/nexus/services/podcasts/transcripts.py:1021-1086 (_mark_podcast_transcription_failure)` · `python/nexus/tasks/reconcile_stale_ingest_media.py:52-55`  

**Problem.** mark_podcast_transcription_failure_for_recovery (lines 1089–1108) is a 3-line function body that calls _mark_podcast_transcription_failure with exactly the same arguments. The docstring says it is 'used by operational recovery paths' to avoid 'orphaned running jobs or reserved quota', but _mark_podcast_transcription_failure already does all of that. The wrapper exists only to give external callers a public-looking name, not to hide complexity or enforce any invariant distinct from the private function.

**Fix.** Rename _mark_podcast_transcription_failure to mark_podcast_transcription_failure (remove the underscore), drop the wrapper function, and update the one external caller in reconcile_stale_ingest_media.py to import the renamed function directly.

#### 🟠 5. embedding_config_hash formula duplicated identically at three sites across two files
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/podcasts/transcripts.py:73-75 (_semantic_index_requires_repair)` · `python/nexus/services/podcasts/transcripts.py:1551-1553 (repair_podcast_transcript_semantic_index_now)` · `python/nexus/services/content_indexing.py:92-94 (rebuild_transcript_content_index)`  

**Problem.** The expression hashlib.sha256(f'{embedding_provider}:{embedding_model}:{dims}:{CHUNKER_VERSION}'.encode()).hexdigest() is written out in full at all three locations. If any component (separator, field order, CHUNKER_VERSION) changes, all three sites must be updated in lockstep. This is exactly the dangerous duplication that cleanliness.md §4 targets.

**Fix.** Add a function compute_embedding_config_hash(provider, model, dimensions, chunker_version) -> str in content_indexing.py (which already imports all components) and export it. Replace all three inline computations with a call to that function.

#### 🟠 6. Three test-environment production seams (nexus_env == Environment.TEST) inside enqueue helpers make enqueue always succeed in tests regardless of queue state
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`, `cleanliness.md §3`  
**Where:** `python/nexus/services/podcasts/transcripts.py:906-913 (_enqueue_podcast_transcription_job)` · `python/nexus/services/podcasts/transcripts.py:947-955 (_enqueue_podcast_semantic_repair_job)` · `python/nexus/services/podcasts/transcripts.py:1009-1017 (_enqueue_video_transcription_retry)`  

**Problem.** Each enqueue helper catches SQLAlchemyError and, if nexus_env == TEST, logs a message and returns True (pretending the enqueue succeeded). This means tests that exercise paths where the queue is unreachable cannot observe the failure path. It is a production seam kept only for tests (cleanliness.md §11) — the test environment silently swallows a real error class.

**Fix.** Remove the Environment.TEST branches. Tests that need to simulate a queue failure should configure a queue that raises or use a proper test double at the enqueue_job boundary. If the current test suite relies on this behavior, those tests need to be rewritten to control queue availability at the enqueue_job level rather than inside service-private helpers.

#### 🟠 7. All public service functions return untyped dict[str, Any] instead of named typed results
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §8`, `cleanliness.md §9`  
**Where:** `python/nexus/services/podcasts/transcripts.py:122 (request_podcast_transcript_for_viewer)` · `python/nexus/services/podcasts/transcripts.py:572 (request_podcast_transcripts_batch_for_viewer)` · `python/nexus/services/podcasts/transcripts.py:682 (forecast_podcast_transcripts_for_viewer)` · `python/nexus/services/podcasts/transcripts.py:715 (retry_transcript_media_for_viewer)` · `python/nexus/services/podcasts/transcripts.py:1200 (run_podcast_transcription_now)` · `python/nexus/services/podcasts/transcripts.py:1534 (repair_podcast_transcript_semantic_index_now)`  

**Problem.** Every public function in transcripts.py returns dict[str, Any]. Callers must know key names by convention (e.g., 'request_enqueued', 'transcript_state', 'remaining_minutes') with no type checking, no discriminated union, and no guarantee that a key exists. This makes illegal states representable and forces callers such as _batch_transcript_status_from_admission to re-derive state from string keys. cleanliness.md §8 requires typed inputs/outputs at service boundaries; cleanliness.md §9 requires discriminants on unions.

**Fix.** Define dataclasses or TypedDicts for each distinct outcome shape (e.g., TranscriptAdmissionResult, TranscriptJobResult, SemanticRepairResult) and use those as return types. Give result unions a discriminant field typed as a Literal so callers can match exhaustively.

#### 🟡 8. _rebuild_transcript_content_index_for_version is a pure passthrough one-liner that adds no value
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `python/nexus/services/podcasts/transcripts.py:2189-2203 (_rebuild_transcript_content_index_for_version)` · `python/nexus/services/podcasts/transcripts.py:1428` · `python/nexus/services/podcasts/transcripts.py:1656` · `python/nexus/services/podcasts/sync.py:1046`  

**Problem.** _rebuild_transcript_content_index_for_version (lines 2189–2203) is a 14-line function that calls rebuild_transcript_content_index with the same keyword arguments, adds no guard, no translation, and no error handling. It is called three times (twice in transcripts.py, once in sync.py). This is the hollow wrapper indirection that cleanliness.md §7 explicitly flags.

**Fix.** Delete _rebuild_transcript_content_index_for_version and replace all three call sites with a direct call to the imported rebuild_transcript_content_index.

#### 🟡 9. _get_usage_snapshot is defined but never called — dead code
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `python/nexus/services/podcasts/transcripts.py:2206-2228 (_get_usage_snapshot)`  

**Problem.** _get_usage_snapshot (lines 2206–2228) queries podcast_transcription_usage_daily and returns a dict. It appears at exactly one location in the file: its own definition. No site in transcripts.py or anywhere else in the codebase calls it. The callers that need usage data use get_transcription_usage from billing.py instead.

**Fix.** Delete _get_usage_snapshot entirely.

#### 🟡 10. docs/modules/podcast.md is completely empty — the module's intended design is undocumented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/podcast.md:1`  

**Problem.** The module doc for the podcast pipeline is a zero-byte file. Without a stated intended design it is impossible to audit for doc-vs-code drift, and engineers cannot know what the module is supposed to own, what its public contract is, or what constraints it enforces. cleanliness.md §3 directs treating a stale doc as a lead to hunt dead concepts through code; an empty doc means there is no authoritative design to drift from or enforce.

**Fix.** Write the module doc to capture: (a) what capabilities podcast/transcripts.py, podcast/sync.py, rss_transcript_fetch.py, and youtube_transcripts.py each own; (b) the public contract of each module; (c) which tables each module writes to; (d) the lifecycle state machine for transcript_state and semantic_status. This doc then becomes the anchor for future cleanliness audits.


<a id="py-podcast-sync"></a>
## Podcast sync & subscriptions  · `py-podcast-sync`
*8 issues (4 High)*  

> **Verdict.** sync.py (2337 lines) is a textbook god file: it owns five completely unrelated capabilities in one body — poll-run orchestration with singleton leasing, per-subscription sync state machine, RSS feed fetching and pagination, RSS feed XML parsing (items, show notes, chapters, transcripts), and full inline transcript ingestion that duplicates the logic in transcripts.py. This is the worst concentration of rot. subscriptions.py has a secondary but significant violation: its unsubscribe_from_podcast directly mutates library_entries tables and inlines the position-renormalization SQL that libraries.py already owns as normalize_library_entry_positions, and the inline SQL uses a different tie-break ordering (ASC) than the canonical libraries service (DESC). A third concern is that both subscriptions.py and catalog.py independently implement the podcast upsert identity-conflict resolution pattern with slightly different branching, resulting in two owners of the same mutation flow.


#### 🔴 1. Split sync.py: separate RSS feed ingestion from subscription sync state machine and from poll orchestration
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/podcasts/sync.py:1-2337`  

**Problem.** sync.py conflates five unrelated capabilities: (1) active-subscription poll scheduling and singleton-lease management (run_scheduled_active_subscription_poll, poll_active_subscriptions_once, _claim_subscription_poll_run_singleton, _mark_subscription_poll_run_completed, _mark_subscription_poll_run_failed, lines 103-515); (2) per-subscription sync state machine (run_podcast_subscription_sync_now, _claim_subscription_sync_pending, _mark_subscription_sync_completed, _mark_subscription_sync_failed, lines 518-1531); (3) RSS feed fetching and pagination (_fetch_feed_episodes_paginated, _fetch_feed_episode_page, _augment_provider_episodes_with_feed_pagination, _hydrate_selected_episode_chapters_from_feed, lines 1599-1781); (4) RSS feed XML parsing for episodes, show notes, chapters, and transcript refs (_parse_feed_episode_page, _episode_from_feed_item, _extract_episode_show_notes_from_feed_item, _extract_rss_chapters_from_feed_item, _extract_rss_transcript_refs_from_feed_item, _fetch_podcasting20_chapters, _parse_podcasting20_chapter_payload, _parse_podlove_chapters, lines 1844-2243); and (5) inline transcript ingestion that drives the transcript state machine from inside _sync_subscription_ingest (lines 940-1109). These concerns have completely independent change rates and ownership.

**Fix.** Create three new modules: (a) python/nexus/services/podcasts/feed_fetch.py — owns all RSS/Atom feed HTTP fetching, redirect-following, and pagination (_fetch_feed_episodes_paginated, _fetch_feed_episode_page, _fetch_podcasting20_chapters, _is_safe_feed_page_url, _augment_provider_episodes_with_feed_pagination, _hydrate_selected_episode_chapters_from_feed). Public contract: fetch_feed_episodes(feed_url, limit) -> list[FeedEpisode] and hydrate_episode_feed_data(episodes, feed_url). (b) python/nexus/services/podcasts/feed_parse.py — owns RSS/Atom XML parsing (_parse_feed_episode_page, _episode_from_feed_item, _extract_episode_show_notes_from_feed_item, _extract_plain_text_from_html_fragment, _truncate_utf8_bytes, _extract_rss_chapters_from_feed_item, _extract_rss_transcript_refs_from_feed_item, _parse_podcasting20_chapter_payload, _parse_podlove_chapters, _normalize_podcast_chapter_link, _parse_chapter_timestamp_ms, _parse_feed_duration_seconds, _normalize_feed_published_at, _extract_feed_next_page_url). Public contract: parse_feed_page(content, page_url) -> tuple[list[FeedEpisode], str | None]. (c) python/nexus/services/podcasts/poll.py — owns the poll-run singleton lease and telemetry (_claim_subscription_poll_run_singleton, _mark_subscription_poll_run_completed, _mark_subscription_poll_run_failed, run_scheduled_active_subscription_poll, poll_active_subscriptions_once). Retain in sync.py only: the subscription sync state machine, _sync_subscription_ingest, chapter upsert, and episode identity logic. Move the inline transcript ingestion out of _sync_subscription_ingest and into a call to a named command on transcripts.py (e.g. ingest_rss_transcript_if_eligible).

#### 🔴 2. subscriptions.unsubscribe_from_podcast directly mutates library_entries, bypassing the libraries service owner
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/podcasts/subscriptions.py:410-482` · `python/nexus/services/libraries.py:850-871` · `python/nexus/services/libraries.py:1000-1019`  

**Problem.** unsubscribe_from_podcast (subscriptions.py:386) directly issues DELETE FROM library_entries and inlines a WITH ordered AS / UPDATE library_entries position renormalization CTE (lines 461-482). The libraries service already owns this capability: remove_podcast_from_library (libraries.py:850) performs the same delete-and-renormalize, and normalize_library_entry_positions (libraries.py:1000) is the canonical renormalization implementation. Beyond the ownership violation, the inline CTE uses ORDER BY position ASC, created_at ASC, id ASC (subscriptions.py:469) while the canonical normalize_library_entry_positions uses ORDER BY position ASC, created_at DESC, id DESC (libraries.py:1007), producing different results on ties and constituting a silent data-correctness divergence.

**Fix.** Replace the inline library mutation block in unsubscribe_from_podcast with a call to a new libraries service command — e.g. remove_user_podcast_subscription_libraries(db, viewer_id, podcast_id) — that deletes all removable library_entries for this (viewer_id, podcast_id) pair and calls normalize_library_entry_positions for each affected library. subscriptions.py must stop importing library tables directly; it calls only the libraries service's public API. The returned removed_from_library_count and retained_shared_library_count must come from that service call.

#### 🔴 3. Duplicate podcast upsert identity-resolution logic in subscriptions._upsert_podcast_from_opml vs catalog.upsert_podcast
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `python/nexus/services/podcasts/subscriptions.py:626-736` · `python/nexus/services/podcasts/catalog.py:605-703`  

**Problem.** _upsert_podcast_from_opml in subscriptions.py (lines 626-736) re-implements the full podcast identity-conflict resolution: check by feed_url, check by provider_id, INSERT with a nested savepoint, catch IntegrityError, retry selects, call update_podcast_metadata with conditional set_provider_podcast_id/set_feed_url flags, call replace_podcast_contributors_from_body. This is the same algorithm as catalog.upsert_podcast (lines 605-703), duplicated with minor flag variations. Two callers now own the same mutation flow over the same rows, and they can diverge independently.

**Fix.** Extend catalog.upsert_podcast to accept the opml-specific flag semantics (the opml path differs only in whether set_provider_podcast_id is set when a conflict is found with an existing provider_id owner), then delete _upsert_podcast_from_opml and have import_subscriptions_from_opml call catalog.upsert_podcast. If the opml variant truly needs subtly different identity rules, express that as a parameter (e.g. prefer_feed_url_match: bool) on the single canonical implementation rather than a copy.

#### 🔴 4. sync.py imports private helpers from transcripts.py, breaking the service boundary
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/podcasts/sync.py:65-72` · `python/nexus/services/podcasts/sync.py:850-855` · `python/nexus/services/podcasts/sync.py:973-1109` · `python/nexus/services/podcasts/transcripts.py:1708` · `python/nexus/services/podcasts/transcripts.py:1757` · `python/nexus/services/podcasts/transcripts.py:2068` · `python/nexus/services/podcasts/transcripts.py:2142` · `python/nexus/services/podcasts/transcripts.py:2189`  

**Problem.** sync.py imports six private (underscore-prefixed) helpers from transcripts.py: _create_next_transcript_version, _ensure_media_transcript_state_row, _insert_transcript_segments_for_version, _rebuild_transcript_content_index_for_version, _set_media_transcript_state, _try_enqueue_metadata_enrichment. It then orchestrates 80 lines of transcript state machine logic inline in _sync_subscription_ingest (lines 940-1109), calling these private helpers directly while also driving the fragments table and media processing_status. This means sync.py co-owns the transcript capability's state machine, which is documented as solely owned by transcripts.py.

**Fix.** Add one public command to transcripts.py, e.g. ingest_rss_transcript_if_eligible(db, media_id, refs, duration_seconds, episode_language, feed_language, created_by_user_id, now) -> bool. It should encapsulate the eligibility check, fetch, normalize, version-create, fragment-insert, index-rebuild, media status update, and transcript state update. _sync_subscription_ingest calls this single function. The six private imports in sync.py are removed. The private helpers stay private to transcripts.py.

#### 🟠 5. Inline library position renormalization in subscriptions.py uses opposite tie-break ordering to the canonical libraries service
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/podcasts/subscriptions.py:461-482` · `python/nexus/services/libraries.py:1000-1019`  

**Problem.** The inline position-renormalization CTE in unsubscribe_from_podcast (subscriptions.py:469) orders by created_at ASC, id ASC, while the canonical normalize_library_entry_positions in libraries.py (line 1007) orders by created_at DESC, id DESC. Both operate on the same library_entries rows. When two entries share a position value, these two implementations produce opposite orderings, meaning any library renormalized through unsubscribe ends up in a different position order than one renormalized through the libraries service. This is a silent correctness divergence.

**Fix.** This is resolved by the fix for the ownership issue above: once unsubscribe_from_podcast delegates library teardown to the libraries service (and calls normalize_library_entry_positions), the divergent CTE is deleted and there is only one ordering.

#### 🟠 6. RSS feed fetching and parsing in sync.py uses untyped dict[str, Any] throughout instead of a typed FeedEpisode model
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`  
**Where:** `python/nexus/services/podcasts/sync.py:1736-1338` · `python/nexus/services/podcasts/sync.py:1879` · `python/nexus/services/podcasts/sync.py:1940-1955` · `python/nexus/services/podcasts/sync.py:645-660`  

**Problem.** Every episode object flowing through the feed fetching, parsing, merging, and ingest pipeline is typed as dict[str, Any]. Fields like rss_chapters, rss_transcript_refs, authors, description_html, description_text, language, feed_language, guid, audio_url, published_at, provider_episode_id, and duration_seconds are accessed by string key throughout, making all mismatches silent. The sync ingestion loop (lines 682-930) has 25+ individual .get() accesses without any structural validation at the feed parse boundary. This also prevents the compiler from catching missing or renamed keys across _episode_from_feed_item, _augment_provider_episodes_with_feed_pagination, _hydrate_selected_episode_chapters_from_feed, and _sync_subscription_ingest.

**Fix.** Define a typed dataclass or TypedDict (e.g. FeedEpisode) in feed_parse.py (see the god-file split above) with all the fields that episodes carry. Parse and validate at the _episode_from_feed_item boundary, returning FeedEpisode. Pass FeedEpisode objects through the entire pipeline. Delete the downstream str-keyed .get() accesses and replace with attribute access. This makes illegal field states unrepresentable and eliminates the need for isinstance guards on known-structured data.

#### 🟠 7. sync.py public API returns untyped dict[str, Any] for all service commands instead of named typed output types
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §8`, `cleanliness.md §9`  
**Where:** `python/nexus/services/podcasts/sync.py:110` · `python/nexus/services/podcasts/sync.py:208` · `python/nexus/services/podcasts/sync.py:524` · `python/nexus/services/podcasts/sync.py:1406`  

**Problem.** run_scheduled_active_subscription_poll, poll_active_subscriptions_once, run_podcast_subscription_sync_now, and get_subscription_sync_snapshot all return dict[str, Any] or dict[str, Any] | None. Callers (subscriptions.py:275-289, poll.py, tasks) must know the undocumented key names and types. This also means the callers use .get() with fallback values that hide KeyError rather than failing fast. For example, subscriptions.py:287 checks sync_result.get('reason') == 'not_pending' and sync_result.get('sync_status') == 'failed' — if the keys change, this silently does nothing.

**Fix.** Replace dict[str, Any] return types with named TypedDicts or dataclasses: SyncResult, PollResult, SyncSnapshot. For run_podcast_subscription_sync_now, model the two outcomes (skipped_not_pending vs completed/failed) as a discriminated union so callers use structural matching rather than string key inspection. get_subscription_sync_snapshot should either return a typed SubscriptionSyncSnapshot dataclass or be folded into the callers that already have the subscription row in scope.

#### 🟡 8. run_podcast_subscription_sync_now accepts request_id but immediately discards it with _ = request_id
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §13`  
**Where:** `python/nexus/services/podcasts/sync.py:523-525`  

**Problem.** The function signature declares request_id: str | None = None at line 523 but the very next line is _ = request_id, meaning the parameter is accepted and silently discarded. The task handler (podcast_sync_subscription.py:37) passes it through, but sync.py never uses it. The parameter widens the public surface without providing any behaviour.

**Fix.** If request_id carries no intent, remove it from the signature of run_podcast_subscription_sync_now and stop passing it from the task handler. If it is meant for future correlation logging, add that logging now; otherwise it is speculative surface.


<a id="py-podcast-catalog-playback"></a>
## Podcast catalog & playback  · `py-podcast-catalog-playback`
*11 issues (2 High)*  

> **Verdict.** catalog.py is a god file (767 lines) mixing at least four unrelated concerns: podcast discovery (external provider search), podcast row-write orchestration (upsert/ensure), subscription list queries (large aggregating SQL with ordering, filtering, and library joins), and episode catalog queries with inline show-notes truncation. The two module docs (podcast.md, player.md) are empty, so no doc-vs-code drift can be assessed, but the code itself violates nearly every decomposition rule. The most dangerous rot is the near-identical podcast-upsert logic duplicated verbatim between catalog.py:upsert_podcast and subscriptions.py:_upsert_podcast_from_opml — 130 lines of insert-or-update-with-race-recovery that diverge subtly and will diverge further. A secondary structural problem is the duplicate type definitions for the same concept: QueueInsertPosition vs PlaybackQueueInsertPosition (both Literal[\"next\",\"last\"]) and PlaybackQueueListeningStateOut vs the richer ListeningStateOut in schemas/media.py — two types modelling overlapping data where one should own it.


#### 🔴 1. catalog.py is a god file: split discovery, subscription-list queries, episode-list queries, and podcast-write orchestration into separate modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `python/nexus/services/podcasts/catalog.py:1-767`  

**Problem.** catalog.py mixes four unrelated concerns in one 767-line file: (1) external-provider discovery (discover_podcasts, lines 55-103); (2) podcast-row write orchestration (ensure_podcast, upsert_podcast, select_podcast_id_by_*, validate_and_normalize_feed_url, lines 106-767); (3) subscription list queries with complex aggregating SQL (list_subscriptions, lines 163-400); (4) episode list queries with inline show-notes truncation (list_podcast_episodes_for_viewer, lines 472-602). These concerns have different dependencies (external HTTP client, DB write logic, subscription aggregation, media service) and different change rates. Having them in one file is causing duplication (the upsert logic is already copied into subscriptions.py) and makes boundaries unclear.

**Fix.** Split into three modules, keeping the current file as a thin re-export during migration if needed: (a) podcasts/_discovery.py — owns discover_podcasts, calls the provider client, returns PodcastDiscoveryOut; (b) podcasts/_podcast_row.py (or merge into the existing _writes.py) — owns upsert_podcast, ensure_podcast, select_podcast_id_by_provider_id, select_podcast_id_by_feed_url, is_podcast_identity_conflict, validate_and_normalize_feed_url; this is the single source of truth for podcast-row identity resolution; (c) podcasts/_episodes.py — owns list_podcast_episodes_for_viewer, PODCAST_EPISODE_STATES, PODCAST_EPISODE_SORT_OPTIONS, the show-notes truncation constant; (d) podcasts/_subscriptions_query.py or move into subscriptions.py — owns list_subscriptions, get_podcast_detail_for_viewer, PODCAST_SUBSCRIPTION_SORT_OPTIONS, PODCAST_SUBSCRIPTION_FILTER_OPTIONS, _podcast_list_item_from_row. Each new module has one reason to change and a clear public contract.

#### 🔴 2. Duplicate podcast-upsert logic: upsert_podcast (catalog.py) and _upsert_podcast_from_opml (subscriptions.py) implement the same identity-resolution algorithm separately
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/podcasts/catalog.py:605-706` · `python/nexus/services/podcasts/subscriptions.py:626-736`  

**Problem.** Both functions implement the same three-phase podcast identity resolution: look up by provider_podcast_id, look up by feed_url, INSERT with IntegrityError recovery re-running the same lookups. The logic is ~130 lines each, nearly identical, but they diverge subtly: upsert_podcast always calls set_feed_url=True in the 'existing_id found, no feed conflict' branch whereas _upsert_podcast_from_opml does not, and the IntegrityError recovery branch computes set_provider_podcast_id differently. Two owners of the same mutation flow means divergence is guaranteed as the rules change. The duplication already exists despite the upsert_podcast function being publicly importable from catalog and already imported by subscriptions.py.

**Fix.** Collapse to a single podcast_row.upsert_podcast function in the podcasts package (best placed in _writes.py or a new _podcast_row.py). Give it a typed options parameter (dataclass or named booleans) controlling which identity fields to update so both callers can express their slight preference differences without forking the algorithm. Delete _upsert_podcast_from_opml entirely; make import_subscriptions_from_opml call the unified function.

#### 🟠 3. Duplicate type for the same value: QueueInsertPosition (service) and PlaybackQueueInsertPosition (schema) are identical Literal types
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`, `module-apis.md`  
**Where:** `python/nexus/services/playback_queue.py:22` · `python/nexus/schemas/playback.py:9`  

**Problem.** QueueInsertPosition = Literal["next", "last"] is defined in playback_queue.py and PlaybackQueueInsertPosition = Literal["next", "last"] is defined in schemas/playback.py. They are structurally identical. The service function add_queue_items_for_viewer uses QueueInsertPosition for its parameter, while PlaybackQueueAddRequest uses PlaybackQueueInsertPosition for its field. Two types for one concept means type mismatches silently coexist and callers cannot tell which to import.

**Fix.** Keep one definition in schemas/playback.py (the public contract) as PlaybackQueueInsertPosition. Import and alias it in playback_queue.py if needed, or just use it directly. Delete QueueInsertPosition from the service file.

#### 🟠 4. Duplicate queue-source constants vs Literal type: QUEUE_SOURCE_* constants and set duplicate PlaybackQueueSource Literal
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`  
**Where:** `python/nexus/services/playback_queue.py:23-30` · `python/nexus/schemas/playback.py:10`  

**Problem.** playback_queue.py defines three string constants (QUEUE_SOURCE_MANUAL, QUEUE_SOURCE_AUTO_SUBSCRIPTION, QUEUE_SOURCE_AUTO_PLAYLIST) and a QUEUE_SOURCES set, while schemas/playback.py defines PlaybackQueueSource = Literal["manual","auto_subscription","auto_playlist"] covering the same values. The set is used for a runtime membership check (_insert_media_ids_for_viewer line 354) that is redundant because source is only ever set by the service itself to one of the three constants — no external caller passes a free-form string. Two representations of the same enumeration.

**Fix.** Delete QUEUE_SOURCE_MANUAL, QUEUE_SOURCE_AUTO_SUBSCRIPTION, QUEUE_SOURCE_AUTO_PLAYLIST, and QUEUE_SOURCES. Use the string literals directly at the two internal call sites (lines 103 and 258) and remove the runtime membership check at line 354 since the function is private and source is always a compile-time constant.

#### 🟠 5. listening_state assembled as an untyped dict inside _row_to_queue_item instead of using PlaybackQueueListeningStateOut
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §7`  
**Where:** `python/nexus/services/playback_queue.py:282-286`  

**Problem.** PlaybackQueueItemOut.listening_state is typed as PlaybackQueueListeningStateOut | None, but _row_to_queue_item constructs listening_state as a plain dict {"position_ms": ..., "playback_speed": ...} at lines 284-287 and assigns it to the field. Pydantic will coerce the dict to the model on construction, but the code bypasses the typed constructor and loses the benefit of type-checker verification at the assembly point. The typed class exists and is unused at the one place it should be.

**Fix.** Replace the dict literal with PlaybackQueueListeningStateOut(position_ms=int(row["listening_position_ms"]), playback_speed=float(row["listening_playback_speed"])). Import PlaybackQueueListeningStateOut at the top of the file (it is already defined in schemas/playback.py which is already imported).

#### 🟡 6. get_next_queue_item_for_viewer re-fetches the entire queue from the DB and scans it in Python to find a neighbour
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/playback_queue.py:204-222`  

**Problem.** get_next_queue_item_for_viewer calls list_queue_for_viewer to load the full queue (including full JOINs with podcast, listening state, subscription), then linearly scans the resulting list to find the item after current_media_id. This is wasteful — the queue can be large and the function only needs one row. It is also a separate public API (the /playback/queue/next endpoint) that duplicates logic already implicit in a client-side list scan.

**Fix.** Replace with a targeted SQL query: SELECT the next queue row (position > current item's position) with all needed JOINs in a single keyset query, returning one row. Alternatively, if this endpoint is unused by clients (check frontend call sites), delete it entirely. If retained, move the SQL to a private helper and keep the public function thin.

#### 🟡 7. Duplicate episode-state SQL CASE expression defined in two separate queries in catalog.py
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/podcasts/catalog.py:243-246` · `python/nexus/services/podcasts/catalog.py:550-553`  

**Problem.** The SQL CASE expression computing episode state (played/in_progress/unplayed) from podcast_listening_states.is_completed and position_ms is repeated verbatim in two separate queries within the same file: once in list_subscriptions (the subscription_aggregates CTE) and once in list_podcast_episodes_for_viewer (the episode_rows CTE). If the state logic changes (e.g., a new state is added), both queries must be updated in sync.

**Fix.** Extract the CASE expression into a Python string constant (e.g., EPISODE_STATE_SQL_EXPR) defined once at the module level, and reference it via f-string interpolation in both queries. This mirrors how visible_media_ids_cte_sql() is already used to avoid duplication of the visibility CTE.

#### 🟡 8. Duplicate sort-option and filter-option validation: Literal types in route handler duplicate the set-membership checks in the service
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/api/routes/podcasts.py:70-71` · `python/nexus/api/routes/podcasts.py:211-212` · `python/nexus/services/podcasts/catalog.py:178-188` · `python/nexus/services/podcasts/catalog.py:487-492`  

**Problem.** The route handler declares Literal["recent_episode","unplayed_count","alpha"] and Literal["all","unplayed","in_progress","played"] / Literal["newest","oldest","duration_asc","duration_desc"] as parameter types, performing FastAPI's input validation. The service then independently checks the same values against PODCAST_SUBSCRIPTION_SORT_OPTIONS, PODCAST_SUBSCRIPTION_FILTER_OPTIONS, PODCAST_EPISODE_STATES, PODCAST_EPISODE_SORT_OPTIONS at lines 178-192 and 487-492. Two validation layers for the same constraint means they can drift apart.

**Fix.** If the route enforces Literal types (which FastAPI validates at the HTTP boundary), the service-layer set-membership checks are redundant for this call path and should be deleted, or the service should accept only the typed Literal value (no string). Alternatively, delete the service-layer string-set constants and keep only the Literal types in the schema. Pick one owner for the validation: the boundary (route) or the service, not both.

#### 🟡 9. Lazy in-function import of media service inside catalog.py hides a circular dependency
`Low` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `python/nexus/services/podcasts/catalog.py:591`  

**Problem.** list_podcast_episodes_for_viewer does `from nexus.services import media as media_service` inside the function body at line 591 to avoid a circular import. Lazy imports that exist solely to break circular dependencies are a code smell indicating the modules have coupled concerns that should be separated. Here, catalog.py borrows media_service.list_media_for_viewer_by_ids only to enrich its episode query result — this coupling should not exist between sibling service modules.

**Fix.** As part of splitting catalog.py (Issue 1), move list_podcast_episodes_for_viewer to podcasts/_episodes.py. At that point evaluate whether the enrichment step can be done with a single combined SQL query (joining media columns directly) instead of a two-phase lookup via media_service, eliminating the cross-service dependency entirely.

#### 🟡 10. Both module docs (podcast.md, player.md) are empty — stale doc shells with no design guidance
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/podcast.md` · `docs/modules/player.md`  

**Problem.** Both files exist but contain only a newline — they have no design content. The audit instruction treats them as intended-design documents, but they are empty shells. Any future reader looking for module ownership guidance will find nothing, and the cleanliness rule 'treat a stale doc as a lead' cannot be applied because there is no content to stale.

**Fix.** Either populate the docs with the intended design (public contracts, ownership boundaries, what each service owns) or delete the files so they do not create false impressions of documentation existing.

#### 🟡 11. Two overlapping listening-state output types: PlaybackQueueListeningStateOut vs ListeningStateOut
`Low` · `Medium-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/schemas/playback.py:13-16` · `python/nexus/schemas/media.py:47-53`  

**Problem.** PlaybackQueueListeningStateOut (schemas/playback.py) has position_ms and playback_speed. ListeningStateOut (schemas/media.py) has position_ms, duration_ms, playback_speed, and is_completed. Both model a listening position snapshot. The queue item intentionally omits duration_ms and is_completed, but these are derived from other queue-item fields (duration_seconds is already on the queue item and playback completion is implicit). Having two nearly-identical named types for one concept violates module-apis.md (one primary form per capability).

**Fix.** Determine whether the queue item genuinely needs different fields. If yes, document the intentional difference with a comment and leave them separate. If not, unify to ListeningStateOut (the richer type) in both schemas, dropping PlaybackQueueListeningStateOut, and let the queue item carry the full listening state or null-out the fields it does not have.


<a id="py-libraries"></a>
## Libraries service  · `py-libraries`
*10 issues (3 High)*  

> **Verdict.** libraries.py at 2166 lines is a god file mixing five unrelated concern groups: library CRUD and governance, library entry and ordering operations, default-library closure orchestration (partially duplicating default_library_closure.py), invitation lifecycle, and podcast-subscription library management. default_library_closure.py is itself 806 lines and owns its own sub-god file problem (backfill job state-machine, GC logic, enqueue infrastructure, and materialization all in one file). The worst rot is: the inline backfill-job upsert in accept_library_invite duplicates the state-machine owned by default_library_closure.py without calling any helper there; external callers (ingest_web_article.py) bypass the libraries service public surface and import directly from the private closure module; and the library-entry ensure/insert logic is duplicated across both files.


#### 🔴 1. Split libraries.py god file: extract invitation, governance, podcast-entry, and subscription-library concerns into separate modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/libraries.py:1-2166`  

**Problem.** libraries.py mixes five unrelated concern groups in one 2166-line file: (1) library CRUD and governance (create/rename/delete/list/get, member management, ownership transfer) lines 46-1573; (2) library entry management (add/remove/reorder media and podcasts, hydration) lines 439-1183; (3) invitation lifecycle (create/list/accept/decline/revoke invites) lines 1575-2112; (4) podcast-subscription library assignment lines 2113-2167; (5) default-library closure orchestration calls scattered throughout. This violates the one-concern-one-owner rule and makes the file extremely hard to reason about or change safely.

**Fix.** Decompose into focused modules: (a) python/nexus/services/library_governance.py — create, rename, delete, list, get, member CRUD, ownership transfer; public contract: named commands returning typed LibraryOut/LibraryMemberOut, raises typed errors. (b) python/nexus/services/library_entries.py — add/remove/reorder media and podcast entries, hydration, position normalization; public contract: add_media_to_library, add_podcast_to_library, remove_podcast_from_library, list_library_entries, reorder_library_entries. (c) python/nexus/services/library_invitations.py — invite create/list/accept/decline/revoke; public contract: named commands returning typed InvitationOut. (d) Keep set_subscription_libraries and validate_libraries_accessible in library_governance.py or expose them through library_entries.py depending on what callers need. Keep python/nexus/services/libraries.py as a thin re-export shim only during transition, then delete it.

#### 🔴 2. Inline backfill-job upsert in accept_library_invite duplicates the state-machine owned by default_library_closure.py
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `python/nexus/services/libraries.py:1883-1941` · `python/nexus/services/default_library_closure.py:366-490`  

**Problem.** accept_library_invite (libraries.py:1883-1941) contains raw SQL to SELECT/INSERT/UPDATE default_library_backfill_jobs to perform a pending-upsert. This is a second owner of the backfill job state-machine logic. default_library_closure.py already owns all other state transitions (claim_backfill_job_pending, mark_backfill_job_completed, mark_backfill_job_failed, reset_backfill_job_to_pending_for_retry, requeue_backfill_job) but has no upsert helper. The accept path implements the upsert inline using raw SQL, diverging from the pattern and making it easy for the two owners to drift.

**Fix.** Add a named function upsert_backfill_job_pending(db, default_library_id, source_library_id, user_id) to default_library_closure.py that encapsulates the SELECT + INSERT-or-UPDATE to pending logic. Call it from accept_library_invite. This collapses ownership of all backfill job writes to the single owner module and shrinks accept_library_invite by ~60 lines of raw SQL.

#### 🔴 3. ingest_web_article.py imports directly from default_library_closure, bypassing the libraries service boundary
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/tasks/ingest_web_article.py:496-498` · `python/nexus/services/libraries.py:552-559`  

**Problem.** ingest_web_article.py imports ensure_default_intrinsic directly from nexus.services.default_library_closure and calls it with a raw library_id (lines 496-498). The libraries service already exposes ensure_media_in_default_library (libraries.py:552-559) as the correct public API which calls ensure_default_intrinsic internally and also handles clear_user_media_deletion. The task is reaching into the internal wiring of the closure service, bypassing the higher-level service contract and skipping the media-deletion clearance that the canonical public function provides.

**Fix.** Replace the direct import and call in ingest_web_article.py with a call to libraries_service.ensure_media_in_default_library(db, actor_user_id, winner_id). This respects the service boundary and prevents the task from needing to know about the internal closure module.

#### 🟠 4. Library-entry ensure/insert logic duplicated across libraries.py and default_library_closure.py
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/libraries.py:502-520` · `python/nexus/services/default_library_closure.py:76-94`  

**Problem.** add_media_to_library (libraries.py:502-520) implements its own inline check-and-insert into library_entries for non-default libraries (SELECT 1 + INSERT with _next_library_entry_position). default_library_closure.py already owns this logic in the private helper _ensure_library_entry_for_media (lines 76-94) which does exactly the same thing. The two implementations are semantically identical, meaning a bug fix or schema change must be applied in both places.

**Fix.** Expose _ensure_library_entry_for_media as a package-internal function (rename to ensure_library_entry_for_media without leading underscore, or move it to the library_entries module). Call it from add_media_to_library's non-default branch instead of the duplicated inline SQL. This unifies the single owner for library_entries insertion logic.

#### 🟠 5. get_library duplicates _fetch_library_with_membership without using it
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/libraries.py:399-436` · `python/nexus/services/libraries.py:1191-1214`  

**Problem.** get_library (lines 399-436) runs its own SELECT joining libraries and memberships, then manually unpacks row columns into a LibraryOut. The private helper _fetch_library_with_membership (lines 1191-1214) performs the same join and raises the same masked 404. The only difference is column order and return type. get_library does not use _fetch_library_with_membership despite it being the canonical fetch helper used by 7 other functions in the same file.

**Fix.** Reimplement get_library to call _fetch_library_with_membership and construct LibraryOut from its result tuple, eliminating the duplicate SQL. Note the column order difference: _fetch_library_with_membership returns (id, is_default, owner_user_id, created_at, updated_at, name, role, color) while get_library uses a different column order — standardize on one column mapping.

#### 🟠 6. accept_library_invite function body is excessively long mixing membership upsert, invite state-machine, backfill-job upsert, and post-commit enqueue
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`  
**Where:** `python/nexus/services/libraries.py:1780-1972`  

**Problem.** accept_library_invite spans ~193 lines and orchestrates four unrelated phases inside a single transaction block: (1) invite state machine (lock, idempotency check, status guards), (2) membership upsert, (3) invite status update, (4) backfill job SELECT/INSERT/UPDATE upsert (60+ lines of raw SQL), plus post-commit enqueue. Each phase is a named step with a comment, indicating they should be separate operations. The backfill-job upsert in particular (lines 1883-1941) belongs to default_library_closure.py's owned behavior.

**Fix.** After extracting upsert_backfill_job_pending to default_library_closure.py (see related issue), accept_library_invite should slim to: lock invite, check idempotency, upsert membership, update invite status, call upsert_backfill_job_pending, commit, then call enqueue_backfill_task. This brings the function to ~40 meaningful lines with no inline SQL for the backfill table.

#### 🟠 7. _add_media_to_resolved_libraries calls add_media_to_library in a loop, opening a new transaction per library
`Medium` · `Medium-confidence` · `Other` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/libraries.py:636-660`  

**Problem.** _add_media_to_resolved_libraries (lines 636-660) calls add_media_to_library in a loop over library_ids. Each add_media_to_library call opens its own transaction (via the `with transaction(db):` block at line 467) and acquires a FOR UPDATE lock on the library row. This means for N libraries, the operation runs N separate transactions with N separate lock-and-release cycles — incorrect behavior inside an already-open outer transaction. The outer callers (add_media_to_libraries, assign_libraries_for_media) do not themselves open a transaction, so these N micro-transactions are individually committed rather than atomically.

**Fix.** Extract a _add_single_media_entry_no_transaction(db, library_id, media_id) helper that performs the entry insert and closure edge calls without wrapping a transaction. Have _add_media_to_resolved_libraries call this helper inside a single transaction it owns. Alternatively, batch the inserts into a single INSERT ... ON CONFLICT DO NOTHING statement if the closure semantics allow it.

#### 🟡 8. Name validation logic duplicated between schema Field constraints and service guard clauses
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/schemas/library.py:23` · `python/nexus/schemas/library.py:28` · `python/nexus/services/libraries.py:61-63` · `python/nexus/services/libraries.py:118-120`  

**Problem.** CreateLibraryRequest and UpdateLibraryRequest schema fields already declare min_length=1, max_length=100 constraints (schemas/library.py:23, 28). The service functions create_library and rename_library re-validate the same constraints with manual strip + length checks (libraries.py:61-63, 118-120). The strip-then-validate pattern means a whitespace-only name passes schema validation but fails the service guard, implying the schema constraint does not match the actual acceptance criterion. This is both a duplication and a type-precision issue — the schema promises a non-empty string but actually empty-after-strip names can reach the service.

**Fix.** Add a @field_validator('name', mode='before') to CreateLibraryRequest and UpdateLibraryRequest that strips whitespace before Pydantic validates min_length. Then remove the manual strip-and-length checks from create_library and rename_library, trusting that the schema pre-validation enforces the constraint before service entry. This makes the boundary the single owner of this validation.

#### 🟡 9. Invitee-identifier validation duplicated between schema validator and service guard
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/schemas/library.py:157-161` · `python/nexus/services/libraries.py:1630-1633`  

**Problem.** CreateLibraryInviteRequest already has a @model_validator that raises ValueError when both invitee_user_id and invitee_email are None (schemas/library.py:157-161). create_library_invite in the service (libraries.py:1630-1633) re-checks the same condition and raises InvalidRequestError. Because the schema validator runs first on the route path, the service check is dead code for the HTTP path. If the service is called directly (e.g., from tests), the service check is a duplicate of schema logic living in the wrong layer.

**Fix.** Remove the redundant guard in create_library_invite (lines 1630-1633). The schema already enforces this constraint at the boundary. If the function needs to be callable without schema pre-validation, document the precondition rather than re-validating.

#### 🟡 10. BackfillJobStatus type duplicated across default_library_closure.py and schemas/library.py
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`  
**Where:** `python/nexus/services/default_library_closure.py:31` · `python/nexus/schemas/library.py:14`  

**Problem.** BackfillJobStatus = Literal['pending', 'running', 'completed', 'failed'] is defined in default_library_closure.py (line 31) and BackfillJobStatusValue with identical values is defined in schemas/library.py (line 14). Two type aliases with different names represent the same domain concept, meaning a new status value must be added in both places.

**Fix.** Keep BackfillJobStatusValue in schemas/library.py as the single definition. Import it into default_library_closure.py (or share it via a common types module) and remove the local BackfillJobStatus alias. Update the BackfillRequeueResult dataclass to use the shared type.


<a id="py-library-intel"></a>
## Library intelligence  · `py-library-intel`
*7 issues (2 High)*  

> **Verdict.** The 1438-line library_intelligence.py is a classic god file: it owns four unrelated capabilities — source-set inventory/versioning, build lifecycle management, deterministic artifact publication (section compilation, node/claim/evidence insertion, version activation), and read-model assembly — all collapsed into a single module with no separation. The route handler and task are clean thin dispatchers; all rot lives in the service. The two module docs (library.md, oracle.md) are empty stubs, providing no design intent to drift against. The worst concentrations of complexity are the source-set upsert block (~300 lines) and the publish-artifact block (~450 lines), each of which owns multiple sub-concerns and embeds all SQL inline with no typed row types.


#### 🔴 1. Split library_intelligence.py into four focused modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/library_intelligence.py:1-1438`  

**Problem.** The 1438-line file mixes four fully independent concerns: (1) source-set inventory management — loading library entries, computing hashes, upserting library_source_set_versions/items (~lines 208-513); (2) build lifecycle — plan, queue, update, fail builds in library_intelligence_builds (~lines 516-812, 1348-1415); (3) artifact publication — compile sections, fetch evidence snippets, insert versions/sections/nodes/claims/evidence, activate (~lines 835-1345); (4) read-model assembly — query and hydrate LibraryIntelligenceOut from persisted rows (~lines 687-811). Each concern owns distinct tables, distinct invariants, and distinct callers. Placing them together means any engineer touching publication has to read 1400 lines.

**Fix.** Create four modules inside python/nexus/services/: (a) library_source_set.py — owns ensure_current_source_set(), load_inventory(), source_set_hash(), and all library_source_set_versions/items CRUD. Public contract: ensure_current_source_set(db, library_id) -> SourceSetRow. (b) library_intelligence_build.py — owns plan_build(), update_build(), fail_build(), build-by-id/idempotency-key queries. Public contract: plan_build(db, library_id, source_set_id, ...) -> BuildRow, update_build(...), fail_build(...). (c) library_intelligence_publish.py — owns compile_sections(), first_snippet(), publish_artifact(), insert_source_node/claim/evidence(), activate_version(). Public contract: publish_artifact(db, ...) -> UUID. (d) Keep library_intelligence.py as a thin orchestrator exposing only the four public functions (get_library_intelligence, refresh_library_intelligence, run_library_intelligence_build, mark_library_intelligence_build_failed), each delegating to the appropriate sub-module.

#### 🔴 2. Duplicate media readiness check diverges from READABLE_PROCESSING_STATUSES
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/library_intelligence.py:405` · `python/nexus/services/capabilities.py:6-12`  

**Superseded by:** `docs/cutovers/media-document-readiness-hard-cutover.md`.

**Current contract.** `media.processing_status` has no `embedding` or `ready`
states. `ready_for_reading` is the only successful document-readiness status,
and library intelligence must use the centralized readiness/capability policy
plus active-ready content-index checks instead of carrying a local status set.

#### 🟠 3. N+1 query pattern in _sections_for_version read path
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/library_intelligence.py:707-763` · `python/nexus/services/library_intelligence.py:730` · `python/nexus/services/library_intelligence.py:760`  

**Problem.** _sections_for_version() loads sections then calls _claims_for_section(db, row['id']) for each section row (line 730), and _claims_for_section() in turn calls _evidence_for_claim(db, row['id']) for each claim row (line 760). With S sections, C claims each, this fires 1 + S + S*C queries per GET request. For the current schema (up to 7 sections each potentially having multiple claims), this is bounded in practice, but the pattern grows unboundedly as the data model evolves and violates the rule that a service should own a capability end-to-end with a clean read path.

**Fix.** Replace the three-level nested query loop with a single JOIN query that fetches sections, claims, and evidence for a given version_id in one round-trip, then reassemble the tree in Python. Alternatively, if section/claim counts are always small and bounded by schema constraints, document that bound explicitly with a justify comment so the pattern is not inadvertently extended.

#### 🟠 4. All domain objects passed as untyped Mapping[str, Any] dicts between functions
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §8`  
**Where:** `python/nexus/services/library_intelligence.py:208` · `python/nexus/services/library_intelligence.py:323` · `python/nexus/services/library_intelligence.py:564-570` · `python/nexus/services/library_intelligence.py:967-975` · `python/nexus/services/library_intelligence.py:1146-1151`  

**Problem.** Every internal domain object — source set rows, build rows, inventory items, snippet rows — is typed as Mapping[str, Any] or dict[str, object] and passed across all internal function boundaries by string key. There are no dataclasses or TypedDicts for SourceSetRow, BuildRow, InventoryItem, or SnippetRow. This means illegal states (missing keys, wrong types) are not detectable until runtime, and there is no IDE or type-checker assistance when keys are added or renamed. The 34 cast(Any, ...) calls in the service suppress checker warnings rather than fix the type gap.

**Fix.** Introduce typed dataclasses or TypedDicts for at least SourceSetRow, BuildRow, and InventoryItem — the three structs that cross the most internal boundaries. Parse DB rows into typed structs at the boundary (the query functions), and thread those typed values inward. This makes illegal states unrepresentable and eliminates the cast(Any) suppression calls throughout.

#### 🟡 5. fragment_count selected in both inventory queries but never consumed
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `python/nexus/services/library_intelligence.py:340` · `python/nexus/services/library_intelligence.py:377`  

**Problem.** Both the media inventory query (line 340) and the podcast inventory query (line 377) SELECT COUNT(DISTINCT f.id) AS fragment_count, but neither _media_inventory_item() nor _podcast_inventory_item() ever reads row["fragment_count"]. The column is computed by the DB, transferred over the wire, and silently discarded. The JOIN on fragments is retained only to produce this unused count.

**Fix.** Remove the fragment_count column alias and the COUNT(DISTINCT f.id) aggregate from both SQL queries. Verify the fragments LEFT JOIN is not needed for any other selected column; if not, remove it from both queries as well. This eliminates a useless DB-side aggregate and join on what is likely a large table.

#### 🟡 6. module docs library.md and oracle.md are empty stubs
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/library.md` · `docs/modules/oracle.md`  

**Problem.** Both docs/modules/library.md and docs/modules/oracle.md exist as zero-byte files. They carry no design intent, no ownership description, and no public contract. They are placeholders that were never filled in. The audit process treats them as authoritative module docs, so their emptiness means drift cannot be detected in either direction.

**Fix.** Either populate them with the actual intended design (capability boundary, public contract, owned tables/state, non-obvious invariants) or delete them so the directory does not contain misleading empty markers. Given library_intelligence.py is 1438 lines with no documentation, a populated library.md would directly support the god-file split.

#### 🟡 7. _ensure_current_source_set silently returns a stale source set when library is empty
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §10`  
**Where:** `python/nexus/services/library_intelligence.py:208-213`  

**Problem.** When _load_inventory() returns an empty list (no library entries), the function short-circuits at line 210-213 and returns _latest_source_set() if one exists — which may have been computed for a different source set hash with a different prompt_version or schema_version. The caller never knows it received a stale source set rather than a newly-computed one for the current (empty) state. This is a silent fallback that violates the rule against silent fallbacks (cleanliness.md §3) and makes the control flow non-obvious. If this is intentional (preserve the last known set for display), it should be explicit and named.

**Fix.** Extract the two cases into clearly named branches: if no inventory exists, either compute a new empty-library source set (hash of []) unconditionally, or name the early-return path explicitly (e.g. _latest_source_set_for_empty_library). Remove the implicit fall-through that continues past line 213 with an empty inventory after the early-return guard has already fired.


<a id="py-epub"></a>
## EPUB ingest & read  · `py-epub`
*8 issues (2 High)*  

> **Verdict.** epub_ingest.py is a 2056-line god file mixing five distinct concerns: archive safety, OPF/spine/manifest parsing, HTML sanitization (with a nearly complete parallel reimplementation of sanitize_html.py), asset resource rewriting, and TOC/nav materialization. The worst rot is the duplicated sanitizer: epub_ingest.py contains ~250 lines of sanitization logic (_epub_sanitize, _sanitize_epub_element, _sanitize_epub_attributes, _sanitize_epub_link, _sanitize_epub_image, _sanitize_svg_attributes, plus 6 helper predicates) that structurally parallels sanitize_html.py but lives hidden inside an extraction god file with no public contract. Secondary issues are the double-guard duplication across reader_navigation.py and epub_read.py, the test-only shim run_epub_ingest_sync kept in the production task module, the untyped bare dict return from every lifecycle function boundary, and a local blocked_tags set that should be a module constant.


#### 🔴 1. epub_ingest.py is a 2056-line god file: split into archive-safety, OPF parser, HTML sanitizer, asset rewriter, and TOC materializer
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/epub_ingest.py:1-2056`  

**Problem.** epub_ingest.py mixes five unrelated concerns in one 2056-line file: (1) archive safety gate (lines 750-861), (2) OPF/manifest/spine parsing and title/metadata extraction (lines 864-1019), (3) chapter HTML sanitization with a full parallel sanitizer stack (lines 1389-1586), (4) resource rewriting and asset key derivation (lines 1069-1341), and (5) TOC/nav materialization (lines 1588-2057). The two public symbols (extract_epub_artifacts and check_archive_safety) are callable from outside but the file provides no isolation: callers of check_archive_safety already pull in the entire 2000-line sanitizer and TOC parser as a side-effect of the import.

**Fix.** Create four focused internal modules, all private to the epub ingest capability: (a) nexus/services/epub_archive.py — check_archive_safety only; public contract: takes bytes, returns EpubExtractionError | None. (b) nexus/services/epub_opf.py — _find_opf_path, _parse_xml_entry, _parse_manifest, _parse_spine, _resolve_title, _extract_opf_metadata, _resolve_epub_path; returns typed dataclasses. (c) nexus/services/epub_sanitize.py — _epub_sanitize and the full sanitize/SVG helper stack; public contract: sanitize_epub_html(html: str) -> str. (d) nexus/services/epub_toc.py — _materialize_toc, _parse_epub3_nav, _parse_ncx_toc, _walk_nav_ol, _walk_ncx_navpoints, _materialize_nav_locations and all node-id helpers. epub_ingest.py then becomes a thin orchestrator importing from these modules, approximately 150-200 lines.

#### 🔴 2. EPUB HTML sanitizer is a near-complete parallel reimplementation of sanitize_html.py, living inside the extraction god file
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/epub_ingest.py:1394-1586` · `python/nexus/services/sanitize_html.py:88-315`  

**Problem.** epub_ingest.py contains a bespoke sanitizer stack (_epub_sanitize, _sanitize_epub_element, _sanitize_epub_attributes, _sanitize_epub_link, _sanitize_epub_image, _sanitize_svg_attributes, _is_safe_svg_href, _is_safe_svg_image_href, _is_safe_svg_url_reference, _normalized_attr_name, _local_name) totalling ~200 lines. sanitize_html.py contains a parallel sanitizer (sanitize_html, _sanitize_element, _sanitize_attributes, _sanitize_link, _sanitize_image) with the same structural pattern: parse html -> walk tree -> remove forbidden tags -> strip disallowed attrs -> special-case links and images. The allowed-tag sets differ (epub adds SVG tags, dl/dt/dd, main, etc.) but the logic architecture is identical. The epub version is never imported from sanitize_html.py — it is a full reimplementation with no shared contract.

**Fix.** Extend sanitize_html.py or create nexus/services/epub_sanitize.py as the single owner of EPUB HTML sanitization. The sanitizer must accept an EPUB-specific config (allowed tags, allowed attrs, SVG support flag) and expose one public function: sanitize_epub_html(html: str) -> str. The web sanitizer and epub sanitizer can share the recursive walk, event-handler stripping, and link/image guard logic; the config object distinguishes their allowlists. Remove the parallel stack from epub_ingest.py entirely.

#### 🟠 3. Double-guard duplication: reader_navigation.get_media_navigation_for_viewer re-checks visibility/kind/readiness that epub_read._enforce_epub_read_guards will repeat
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/reader_navigation.py:26-44` · `python/nexus/services/epub_read.py:22-42`  

**Problem.** reader_navigation.get_media_navigation_for_viewer performs can_read_media (line 26), fetches kind+status (lines 29-34), and branches on kind=='epub' (line 38) before delegating to epub_read.get_epub_navigation_for_viewer. That function immediately calls _enforce_epub_read_guards which again calls can_read_media (line 28), fetches kind+status (lines 31-38), checks kind=='epub' (line 39), and checks status in READABLE_PROCESSING_STATUSES (line 41). Every epub navigation request runs the same three DB checks twice.

**Fix.** Remove _enforce_epub_read_guards from get_epub_navigation_for_viewer. The guard at the reader_navigation layer is sufficient when the epub_read functions are reached only via that dispatcher. Alternatively, if epub_read functions must be safe to call directly (e.g. for testing), pass a pre-validated context object rather than re-running the same SQL. The epub_read.py internal helpers should trust that the caller has already verified access.

#### 🟠 4. run_epub_ingest_sync is a test-only seam living in the production task module
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`, `cleanliness.md §2`  
**Where:** `python/nexus/tasks/ingest_epub.py:168-178`  

**Problem.** run_epub_ingest_sync is called exclusively from tests (test_epub_ingest.py x14) and the seed script (seed_e2e_data.py x2). It is a one-line wrapper: `return extract_epub_artifacts(db, media_id, sc)`. Tests and scripts can call extract_epub_artifacts directly; the wrapper exists only to provide a convenient call site from outside the task lifecycle. This is a production seam kept for tests (cleanliness.md §11).

**Fix.** Delete run_epub_ingest_sync. Update the 14 test call sites and 2 seed script call sites to import and call extract_epub_artifacts directly from nexus.services.epub_ingest. The function signature is identical so no logic changes are required.

#### 🟠 5. Lifecycle entry points return bare untyped dict — public service contract is typeless at the boundary
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §8`, `cleanliness.md §9`  
**Where:** `python/nexus/services/epub_lifecycle.py:56` · `python/nexus/services/epub_lifecycle.py:105` · `python/nexus/services/epub_lifecycle.py:252` · `python/nexus/tasks/ingest_epub.py:33`  

**Problem.** confirm_ingest_for_viewer, _confirm_epub_ingest, retry_epub_ingest_for_viewer, and ingest_epub all return `dict` with no type annotation narrower than the built-in. The keys (media_id, duplicate, processing_status, ingest_enqueued, retry_enqueued, etc.) are opaque to callers. Route handlers access these fields by string literal, so any key rename or key removal is a silent runtime bug. The services rules require typed outputs at service boundaries.

**Fix.** Define named dataclasses or TypedDicts for the lifecycle outcomes: e.g. `IngestConfirmResult(media_id: str, duplicate: bool, processing_status: str, ingest_enqueued: bool)` and `RetryResult(media_id: str, processing_status: str, retry_enqueued: bool)`. Return these from the lifecycle functions and let route handlers access typed fields.

#### 🟡 6. check_archive_safety builds _ArchiveSafetyConfig from settings on every call when cfg=None, duplicating the same config construction that extract_epub_artifacts already performs
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/epub_ingest.py:422-429` · `python/nexus/services/epub_ingest.py:759-766`  

**Problem.** extract_epub_artifacts builds _ArchiveSafetyConfig from get_settings() at lines 422-429 and passes it to check_archive_safety. check_archive_safety also builds _ArchiveSafetyConfig itself when called with cfg=None (lines 759-766), as epub_lifecycle does when calling check_archive_safety(epub_bytes) with no config argument (epub_lifecycle.py:177). The settings read and config construction happen twice per preflight call and again inside extraction.

**Fix.** Remove the cfg=None default from check_archive_safety and always require a caller-provided config. The two callers (epub_lifecycle and the extraction path) both have access to settings; they can build the config once and pass it in. This removes the hidden double-read of settings and makes the config construction explicit.

#### 🟡 7. blocked_tags set allocated inside _sanitize_epub_element on every call instead of being a module-level constant
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §7`  
**Where:** `python/nexus/services/epub_ingest.py:1430-1444`  

**Problem.** `blocked_tags` is a literal `{...}` set created inside `_sanitize_epub_element` on every invocation of the function, which is called once per element in every EPUB chapter during extraction. The set is never modified. This creates unnecessary allocation per element and is inconsistent with the module-level constant pattern used for _EPUB_ALLOWED_HTML_TAGS, _EPUB_ALLOWED_SVG_TAGS, and _SVG_FORBIDDEN_TAGS.

**Fix.** Hoist blocked_tags to a module-level frozenset constant, analogous to _SVG_FORBIDDEN_TAGS, and name it _EPUB_FORBIDDEN_TAGS.

#### 🟡 8. get_epub_asset_for_viewer in media.py uses a locally defined ready_states set that duplicates READABLE_PROCESSING_STATUSES from capabilities.py
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/media.py:2670-2675` · `python/nexus/services/capabilities.py:6-12`  

**Superseded by:** `docs/cutovers/media-document-readiness-hard-cutover.md`.

**Current contract.** EPUB asset serving must use the document-readiness owner
and treat only `ready_for_reading` as readable. Do not recreate a local
`ready_states` set and do not reintroduce old media processing states.


<a id="py-content-indexing"></a>
## Content indexing / chunks  · `py-content-indexing`
*8 issues (3 High)*  

> **Verdict.** content_indexing.py is a clear god file at 1903 lines that mixes at least five unrelated concerns in one module: the index run state machine (DB inserts, transitions, and deactivation), the chunking algorithm, per-source-kind block builders, the index state CRUD layer, and a full selector validation suite. The core rebuild_media_content_index function alone runs 594 lines and executes unrelated phases (chunk computation, embedding dispatch, and serialized DB writes for six separate tables) in a single undivided body. Beyond the god-file problem, the embedding_config_hash formula is copy-pasted three times outside the service that owns it, the PDF locator-building logic is duplicated between ingest_pdf.py and the repair path inside content_indexing.py, oracle.py reaches into semantic_chunks internals rather than calling the public build_text_embedding path, and a pure one-liner passthrough wrapper in transcripts.py adds indirection with no value.


#### 🔴 1. Split content_indexing.py god file into five focused modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/content_indexing.py:1-1903`  

**Problem.** content_indexing.py is 1903 lines and mixes five clearly distinct concerns in one file: (1) the chunking algorithm (_block_pieces, _chunk_text, _chunk_locator, _separator_before, _same_locator_anchor — lines 1744-1880); (2) a per-source-kind block builder that constructs IndexableBlock lists from fragment rows, epub nav, and transcript segments (rebuild_fragment_content_index, rebuild_transcript_content_index, _repair_ready_transcript_content_index, _repair_ready_pdf_content_index — lines 672-1203); (3) the index run state machine that drives the content_index_runs table through indexing→embedding→ready/failed transitions (rebuild_media_content_index — lines 75-669); (4) the index state CRUD layer (mark_content_index_failed, deactivate_media_content_index, delete_media_content_index, _set_index_state — lines 1205-1507); and (5) a full selector validation suite covering all four source kinds (_validate_source_snapshot, _validate_blocks, _validate_selector, and four sub-validators — lines 1509-1741). None of these concerns need to share a file; they have completely separate caller populations.

**Fix.** Extract into five modules: (a) content_chunk_algorithm.py — _block_pieces, _chunk_text, _chunk_locator, _separator_before, _same_locator_anchor, plus CHUNK_MAX_TOKENS and CHUNK_OVERLAP_TOKENS; (b) index_block_builders.py — rebuild_fragment_content_index, rebuild_transcript_content_index, the two private _repair_ready_* helpers, and repair_ready_media_content_index_now (these all translate source-specific data into IndexableBlock lists and are their own concern); (c) content_index_run_store.py — rebuild_media_content_index (the DB write pipeline for runs, snapshots, blocks, evidence spans, chunks, chunk parts, embeddings) plus _set_index_state; (d) content_index_state.py — mark_content_index_failed, deactivate_media_content_index, delete_media_content_index; (e) content_selector_validators.py — the full validation suite. The public contracts remain the same named functions; existing callers need import-path updates only.

#### 🔴 2. Collapse four copies of the embedding_config_hash formula into one function
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/content_indexing.py:92-94` · `python/nexus/services/podcasts/transcripts.py:73-75` · `python/nexus/services/podcasts/transcripts.py:1551-1553` · `python/nexus/tasks/reconcile_stale_ingest_media.py:300-302`  

**Problem.** The formula `hashlib.sha256(f"{embedding_provider}:{embedding_model}:{dimensions}:{CHUNKER_VERSION}".encode()).hexdigest()` is copy-pasted identically in four places across three files. All four sites also import CHUNKER_VERSION from content_indexing and call current_transcript_embedding_model / current_transcript_embedding_provider independently. If the hash formula changes (e.g. adding a new component), all four copies must be updated in sync. CHUNKER_VERSION leaking as a public import to reconcile_stale_ingest_media and transcripts is the direct cause — callers are forced to replicate the formula because no function encapsulates it.

**Fix.** Add `current_embedding_config_hash() -> str` to content_indexing.py (or a new module if the god-file split above is applied). It reads the embedding model, provider, dimensions, and CHUNKER_VERSION internally and returns the hexdigest. Remove the CHUNKER_VERSION export from content_indexing.py's public surface. Update all four call sites to call current_embedding_config_hash(). After the split this function can live in content_chunk_algorithm.py alongside CHUNKER_VERSION.

#### 🔴 3. Deduplicate PDF locator and block builder duplicated between ingest_pdf.py and the repair path
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/tasks/ingest_pdf.py:259-335` · `python/nexus/services/content_indexing.py:1104-1172`  

**Problem.** Both ingest_pdf.py (_index_pdf_text, lines 259-335) and content_indexing.py (_repair_ready_pdf_content_index, lines 1104-1172) independently build the same PDF locator and block structure: both create a dict with kind=pdf_text, version=1, source_fingerprint, page_number, physical_page_number, page_label, plain_text offsets, page_text offsets, text_quote, and an optional geometry sub-dict; both create a selector with kind=pdf_text_quote; and both call rebuild_media_content_index with the same SourceSnapshotSpec fields. The ingest path adds an extra extraction key in the locator (recording OCR method and engine) that the repair path omits, silently producing different locator shapes for the same media depending on how the index was built.

**Fix.** Move the PDF block-building logic into a canonical function, e.g. `build_pdf_index_blocks(plain_text, page_spans, *, source_fingerprint, extraction_result=None) -> list[IndexableBlock]`, placed in the proposed index_block_builders.py. Both ingest_pdf.py and _repair_ready_pdf_content_index call this function. The extraction metadata should be included in both paths where available, or explicitly omitted with None in the repair path, so the two paths produce structurally identical locators. Remove _text_quote from ingest_pdf.py and use the one from content_indexing.py (which is already the canonical owner).

#### 🟠 4. Inline the one-liner _rebuild_transcript_content_index_for_version passthrough wrapper
`Medium` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `python/nexus/services/podcasts/transcripts.py:2189-2203`  

**Problem.** _rebuild_transcript_content_index_for_version (lines 2189-2203) is a pure passthrough: it accepts the same four keyword arguments as rebuild_transcript_content_index and calls it with no transformation. It adds a private-symbol layer with no hiding of complexity, and the two call sites (lines 1428 and 1656) that go through it could call rebuild_transcript_content_index directly.

**Fix.** Delete _rebuild_transcript_content_index_for_version. Update the two call sites (transcripts.py:1428 and transcripts.py:1656) and the one indirect reference via podcasts/sync.py:69 to call rebuild_transcript_content_index directly. The podcasts/sync.py import of the wrapper should be replaced with an import of the canonical function.

#### 🟠 5. oracle.py reaches into semantic_chunks internals by calling build_deterministic_hash_embedding directly
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/oracle.py:53` · `python/nexus/services/oracle.py:1089-1096`  

**Problem.** _build_query_embedding_for_model in oracle.py (lines 1083-1121) imports build_deterministic_hash_embedding and calls it directly after checking for fixture/test model names (lines 1089-1096). This replicates the provider-routing logic that semantic_chunks.py already encapsulates in build_text_embeddings (lines 306-311): the public function already dispatches to build_deterministic_hash_embedding for fixture and test providers. oracle.py bypasses the public entry point to access an internal, making it a second owner of the routing logic.

**Fix.** Add `build_text_embedding_for_model(text: str, *, model_name: str) -> tuple[str, list[float]]` to semantic_chunks.py. This function accepts an explicit model name (needed when the caller must match a stored corpus model that may differ from the current configured model), performs the same fixture/test/openai dispatch, and raises if the returned model doesn't match. oracle.py's _build_query_embedding_for_model collapses to a call of this new function. Remove the import of build_deterministic_hash_embedding from oracle.py.

#### 🟠 6. rebuild_fragment_content_index mutates fragments.html_sanitized during index construction
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/services/content_indexing.py:723-740`  

**Problem.** Inside the web_article branch of rebuild_fragment_content_index (lines 723-740), the function calls add_heading_anchors and, if the result differs from the stored value, issues an UPDATE fragments SET html_sanitized = ... against the fragments table. This is a content transformation and persistence concern that has nothing to do with building an evidence index. The indexing function now has two unrelated jobs: (1) enriching the fragment's HTML in-place as a side effect and (2) building content blocks. This means a caller that calls rebuild_fragment_content_index expecting a pure index rebuild silently also mutates the source document representation.

**Fix.** Extract the heading-anchor enrichment step into the web article ingestion path (ingest_web_article.py or web_article_structure.py), where the fragment's html_sanitized is set during initial processing. The call to add_heading_anchors should happen once at ingest time, not as a side effect of every index rebuild. rebuild_fragment_content_index should receive already-anchored html_sanitized and treat it as read-only input.

#### 🟡 7. Dead 'else web_text' branch in rebuild_fragment_content_index
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `python/nexus/services/content_indexing.py:814`  

**Problem.** Line 814 assigns `locator_kind = "epub_text" if source_kind == "epub" else "web_text"`. This else branch can never be reached: the only source_kinds accepted by rebuild_fragment_content_index are "web_article" and "epub" (confirmed by all call sites and the repair_ready_media_content_index_now guard at line 979). The web_article path issues a `continue` before reaching line 814, so the else branch would only fire for a hypothetical third source_kind that does not exist. The dead branch causes reader confusion about whether some other source_kind might use web_text locators.

**Fix.** Replace line 814 with the unconditional `locator_kind = "epub_text"`. Add a guard at the top of the else branch (after the web_article continue) asserting `source_kind == "epub"` to make the assumption explicit and fail fast if a new source_kind is accidentally routed here.

#### 🟡 8. _text_quote duplicated between content_indexing.py and ingest_pdf.py
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/content_indexing.py:1882-1887` · `python/nexus/tasks/ingest_pdf.py:411-416`  

**Problem.** The _text_quote helper is defined identically in both files. Since ingest_pdf.py already calls rebuild_media_content_index from content_indexing.py, it is already coupled to that module. Having a private copy in the task is pure duplication. (The implementations are functionally equivalent; the extra min() call in content_indexing.py is no-op in Python string slicing.)

**Fix.** Expose _text_quote as a public function (text_quote) in content_indexing.py and have ingest_pdf.py import and call it. After the god-file split, this helper belongs in the proposed index_block_builders.py or content_chunk_algorithm.py since both PDF paths need it.


<a id="py-notes"></a>
## Notes service  · `py-notes`
*10 issues (4 High)*  

> **Verdict.** notes.py is a god file at 1888 lines that fuses at least four distinct ownership concerns: page/block CRUD operations, ProseMirror document transformation (text/markdown/split/merge/inline-ref extraction), object-link graph maintenance (_sync_inline_reference_links, _copy_split_note_about_links, _transfer_note_block_relationships, _delete_object_edges, _has_duplicate_unlocated_link), and daily-note lifecycle orchestration. schemas/notes.py compounds the problem by co-locating unrelated schema families—notes, object-links, and pinned-object-refs—in a single file, causing wide surface bleed into non-notes services. The worst rot is the 800+ line blob of link-graph bookkeeping and PM transformation logic that is embedded inside the notes service rather than owned by dedicated modules.


#### 🔴 1. Split notes.py god file: ProseMirror transformation owns a separate module
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/notes.py:65-203` · `python/nexus/services/notes.py:1297-1395`  

**Problem.** notes.py contains an entire ProseMirror document transformation library: pm_doc_from_text (line 65), pm_doc_from_markdown_projection (lines 72-94), _append_text_and_break_nodes (lines 97-102), text_from_pm_json (lines 105-135), markdown_from_pm_json (lines 138-203), _set_block_body_pm_json (lines 1297-1300), _split_pm_json (lines 1303-1339), _merge_pm_json (lines 1342-1362), _pm_content/pm_with_content/_pm_split_text (lines 1365-1395). These are pure, stateless document transformers with no db, no Session, no domain knowledge. They live in a service file only by accident. Externally, vault.py imports pm_doc_from_text directly from notes.py (vault.py:44) because there is nowhere better to get it—a clear ownership violation.

**Fix.** Create python/nexus/services/note_pm.py (or note_pm_doc.py) that owns all ProseMirror transformation logic. Public surface: pm_doc_from_text, pm_doc_from_markdown_projection, text_from_pm_json, markdown_from_pm_json, split_pm_doc, merge_pm_doc. _set_block_body_pm_json becomes a thin internal helper in notes.py calling into note_pm. vault.py imports from note_pm, not from notes. This module has zero db dependencies—it is pure Python and trivially testable.

#### 🔴 2. Split notes.py god file: object-link graph maintenance owns a separate module
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/notes.py:1398-1444` · `python/nexus/services/notes.py:1447-1515` · `python/nexus/services/notes.py:1518-1526` · `python/nexus/services/notes.py:1529-1581` · `python/nexus/services/notes.py:1584-1649` · `python/nexus/services/notes.py:1635-1649` · `python/nexus/services/notes.py:1652-1685` · `python/nexus/services/notes.py:1851-1857`  

**Problem.** 450+ lines in notes.py own the entire object-link graph lifecycle for note blocks: _inline_object_refs_from_pm_json, _sync_inline_reference_links, _is_managed_note_body_link, _copy_split_note_about_links, _transfer_note_block_relationships, _replacement_link_endpoints, _has_duplicate_unlocated_link, _delete_object_edges. This is a parallel duplicate of the ownership that belongs to the object_links service (object_links.py already has its own _duplicate_unlocated_link_id at line 189, which implements the same symmetrical pair check). The link-graph concern is completely unrelated to page/block CRUD.

**Fix.** Move the note-block link graph management into a new module python/nexus/services/note_block_links.py with a small public surface: sync_inline_reference_links(db, viewer_id, block), copy_note_about_links(db, viewer_id, source_id, target_id), transfer_note_block_relationships(db, viewer_id, source_id, target_id), delete_object_edges(db, object_type, object_id). Consolidate _has_duplicate_unlocated_link with _duplicate_unlocated_link_id from object_links.py—they implement the same check and can share one function.

#### 🔴 3. Duplicate duplicate-link detection logic across notes.py and object_links.py
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/services/notes.py:1652-1685` · `python/nexus/services/object_links.py:189-222`  

**Problem.** _has_duplicate_unlocated_link in notes.py (lines 1652-1685) and _duplicate_unlocated_link_id in object_links.py (lines 189-222) perform identical checks: given (viewer_id, relation_type, a_type, a_id, b_type, b_id) they both query ObjectLink checking symmetrical pairs with null locators and an optional exclude_id filter. The only difference is the return type (bool vs UUID | None). This is the same capability duplicated across two modules, violating one-owner-per-concern.

**Fix.** Expose one function from object_links.py (or the proposed note_block_links.py) with the richer return (UUID | None), which subsumes the boolean variant. Remove _has_duplicate_unlocated_link from notes.py and replace its two call sites with calls to the canonical implementation.

#### 🔴 4. schemas/notes.py bundles unrelated schema families (object-links, pinned-refs)
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/schemas/notes.py:474-509` · `python/nexus/schemas/notes.py:512-556`  

**Problem.** schemas/notes.py contains ObjectLinkOut, CreateObjectLinkRequest, UpdateObjectLinkRequest (lines 474-509) and PinnedObjectRefOut, CreatePinnedObjectRefRequest, UpdatePinnedObjectRefRequest (lines 512-556). These are consumed by object_links.py, object_links routes, pinned_objects routes, and object_refs.py—none of which are notes-domain code. They live in notes.py only for historical co-location reasons, forcing every object-link or pinned-ref caller to import from the notes schema module.

**Fix.** Create python/nexus/schemas/object_links.py for ObjectLinkOut, CreateObjectLinkRequest, UpdateObjectLinkRequest, OBJECT_LINK_RELATIONS and python/nexus/schemas/pinned_refs.py for PinnedObjectRefOut, CreatePinnedObjectRefRequest, UpdatePinnedObjectRefRequest. Relocate OBJECT_TYPES, OBJECT_TYPE_VALUES, ObjectRef, HydratedObjectRef to a shared python/nexus/schemas/object_refs.py if they are not note-specific (they are already used by object_links.py, object_refs.py, contributors.py). Update all imports.

#### 🟠 5. create_note_block and _create_note_block_without_commit duplicate body/link construction logic
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/notes.py:640-723` · `python/nexus/services/notes.py:1109-1176`  

**Problem.** create_note_block (lines 640-723) and _create_note_block_without_commit (lines 1109-1176) contain near-identical logic: resolving page, validating position anchor, computing body_pm_json/body_text/body_markdown, constructing a NoteBlock, flushing, inserting in order, creating ObjectLink for linked_object, syncing inline reference links, and projecting to search. The only meaningful difference is that create_note_block calls db.commit() and db.refresh(), while the private variant defers. The body construction logic at lines 666-672 and 1127-1133 is word-for-word identical.

**Fix.** Keep only _create_note_block_without_commit as the canonical implementation. Make create_note_block a thin wrapper: call _create_note_block_without_commit then db.commit() + db.refresh() + return _block_out(). This eliminates one copy of the body-construction expression, the ObjectLink insertion, and the search projection.

#### 🟠 6. set_highlight_note_body bypasses _set_block_body_pm_json, open-coding the triple assignment
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/notes.py:1089-1093` · `python/nexus/services/notes.py:1297-1300`  

**Problem.** set_highlight_note_body at lines 1091-1093 manually sets body_pm_json, body_markdown, and body_text on the existing block without going through _set_block_body_pm_json. This pattern also diverges: it uses the raw normalized string as body_markdown rather than calling markdown_from_pm_json(body_pm_json), which is the canonical derivation elsewhere. Any future change to body triple synchronization must be applied in two places.

**Fix.** Replace lines 1089-1093 with a call to _set_block_body_pm_json(existing, body_pm_json). If the plain-text shortcut (body_markdown = normalized) is intentional for the highlight note body case, document it explicitly or derive consistently via markdown_from_pm_json.

#### 🟠 7. _resolve_daily_page_with_retry duplicates the retry loop structure of _with_serialization_retry
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/notes.py:1200-1231` · `python/nexus/services/notes.py:1234-1246`  

**Problem.** _resolve_daily_page_with_retry (lines 1200-1231) and _with_serialization_retry (lines 1234-1246) both implement a for-attempt-in-range(3) loop with use_serializable_if_available, rollback on OperationalError with is_serialization_failure check, and AssertionError after exhaustion. _resolve_daily_page_with_retry adds one extra catch (IntegrityError for the daily unique conflict) but is otherwise structurally identical. The commit: bool=True parameter in _resolve_daily_page_with_retry (line 1206) is also a test-seam smell—it is only False in quick_capture_to_daily, which re-calls db.commit() itself.

**Fix.** Refactor _resolve_daily_page_with_retry to use _with_serialization_retry, wrapping _resolve_daily_page_once in a lambda that catches IntegrityError for the daily conflict internally and re-raises on the third attempt. Remove the commit: bool parameter—callers that previously relied on commit=False should call db.commit() themselves, making transaction ownership explicit.

#### 🟠 8. pm_doc_from_text is a public export from notes.py used by vault.py — wrong owner
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/notes.py:65-69` · `python/nexus/services/vault.py:44` · `python/nexus/services/vault.py:668`  

**Problem.** vault.py imports pm_doc_from_text directly from notes.py (vault.py line 44). This crosses a service boundary: vault.py is not a notes-domain caller but an import-from-vault file, bypassing the notes service interface. The function pm_doc_from_text is a pure document transformation helper with no notes-service identity; it should live in a shared pm module, not be leaked from the notes service.

**Fix.** Move pm_doc_from_text (and the full ProseMirror transformation family) to python/nexus/services/note_pm.py. vault.py imports from note_pm. notes.py imports what it needs from note_pm. The notes service stops being a utility library for other services.

#### 🟠 9. vault.py directly constructs NoteBlock with open-coded body triple, bypassing notes service
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/vault.py:661-673`  

**Problem.** vault.py at lines 661-673 directly constructs a NoteBlock row with body_pm_json, body_markdown, and body_text fields set manually (body_markdown=text_body, body_text=text_body—not derived from the canonical markdown_from_pm_json). This bypasses the notes service, owns a notes-domain invariant (block body triple consistency), and duplicates creation logic that _create_note_block_without_commit already encapsulates. Another service is writing directly to notes service tables.

**Fix.** Replace the direct NoteBlock construction in vault.py with a call to notes service's _create_note_block_without_commit (or expose a create_note_block_without_commit public function). This keeps notes-domain invariants in the notes service. vault.py must not write directly to NoteBlock rows.

#### 🟡 10. Note PM body validation lives in schemas/notes.py but is also driven by service-layer business rules
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/schemas/notes.py:270-415`  

**Problem.** validate_note_body_pm_json and its helpers (_validate_pm_node, _validate_pm_marks, _validate_pm_attrs, _validate_pm_child_types) span 145 lines inside the schema module. They reference OBJECT_TYPE_VALUES and NOTE_BLOCK_KIND_VALUES for domain-semantic validation (not just shape validation). This is business-rule validation embedded in the schema layer. If the note_pm module described above is created, this validator is better co-located there or kept in a dedicated note_pm_validation.py that the schema file calls.

**Fix.** When creating note_pm.py, move validate_note_body_pm_json and its private helpers there. schemas/notes.py calls validate_note_body_pm_json from note_pm. This keeps the schema layer thin (shape only) and puts domain validation with the domain transformer.


<a id="py-oracle"></a>
## Oracle service  · `py-oracle`
*10 issues (2 High)*  

> **Verdict.** oracle.py (1838 lines, 49 functions) is a god file mixing at least five unrelated concerns in a single module: CRUD/query operations, rate-limit enforcement, corpus readiness validation, vector-retrieval and embedding coordination, LLM prompt construction and output parsing, and SSE event persistence. The worst rot is in execute_reading (lines 614-895, 282 lines) which sequences all of these concerns in one async function body with 23 commit/flush/rollback calls spread across it. Secondary rot includes a private `_stable_citation_key` that duplicates the public `nexus.hashing.stable_json_hash`, a dead legacy image-URL rewrite branch, corpus validation logic duplicated nearly verbatim in the corpus build script, and a raw string error code (E_ORACLE_CORPUS_INCOMPLETE) that bypasses the ApiErrorCode enum.


#### 🔴 1. oracle.py is a god file: split into corpus, retrieval, generation, and CRUD modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/oracle.py:1-1838`  

**Problem.** oracle.py mixes five unrelated concerns in one 1838-line file: (1) reading CRUD and query (create_reading, get_reading_detail, list_all_readings, compute_concordance, lines 148-530); (2) pre-enqueue controls and rate limiting (lines 533-547); (3) corpus readiness validation (_ensure_corpus_seed_ready, _active_corpus_set_version_id, lines 215-316); (4) vector retrieval and embedding orchestration (_build_query_embedding_for_model, _retrieve_corpus_passages, _retrieve_user_library_passages, _retrieve_user_content_chunks*, _pick_plate, lines 1083-1573); (5) LLM prompt building and output parsing (_build_llm_request, _parse_llm_output, _contains_forbidden_citation_output, lines 1578-1838). The module docstring itself says 'Retrieval, prompt building, LLM call, citation persistence, and SSE event emission are all linear and explicit here' — which is precisely the god-file violation. cleanliness.md §5 requires splitting files that mix unrelated concerns.

**Fix.** Decompose into four focused modules, each with a narrow typed public contract:

1. `python/nexus/services/oracle_readings.py` — owns the reading lifecycle: create_reading, get_reading_detail, list_all_readings, compute_concordance, assert_reading_owner, get_reading_events, is_reading_terminal, fail_reading_after_worker_exception. Public surface: named functions taking (db, *, viewer_id, reading_id, ...) and returning typed schema outputs.

2. `python/nexus/services/oracle_corpus.py` — owns corpus validation and plate selection: _active_corpus_set_version_id, _ensure_corpus_seed_ready, _pick_plate, _corpus_embedding_model. Exposes: `get_active_corpus(db) -> CorpusContext` (a dataclass holding corpus_set_version_id and embedding_model), `pick_plate(db, corpus_context, query_embedding) -> OracleCorpusImage`.

3. `python/nexus/services/oracle_retrieval.py` — owns semantic retrieval: _build_query_embedding_for_model, _retrieve_corpus_passages, _retrieve_user_library_passages, _retrieve_user_content_chunks*, _candidate_from_content_chunk_row, source-ref builders. Exposes: `retrieve_candidates(db, corpus_context, question, viewer_id) -> list[Candidate]`.

4. `python/nexus/services/oracle_generation.py` — owns LLM call, prompt, and output parsing: _build_llm_request, _parse_llm_output, _valid_argument, _contains_forbidden_citation_output, _provider_request_hash, _estimate_llm_request_tokens, _usage_total_tokens. Exposes: `build_request(question, candidates) -> LLMRequest`, `parse_response(text, candidates) -> ParsedReading | None`.

The existing oracle.py becomes `execute_reading` orchestrator only, calling into those four services.

#### 🔴 2. execute_reading is a 282-line function running six unrelated phases in one body
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/oracle.py:614-895`  

**Problem.** execute_reading sequences six distinct phases inline with no internal abstraction: (1) idempotency guard, (2) platform LLM availability check, (3) rate limiter inflight acquire, (4) corpus seed readiness check and embedding/plate/retrieval, (5) token budget reservation and LLM call, (6) result persistence and SSE event emission — each phase guarded by its own try/except block and interleaved with 23 db.commit/flush/rollback calls. The function result type is dict[str, Any] with varying key shapes ('status', 'error_code', 'noop', 'folio_number', 'input_tokens', 'output_tokens') rather than a typed result. cleanliness.md §5 requires splitting functions that run unrelated phases in one body.

**Fix.** Extract phases into focused helpers: `_acquire_resources(rate_limiter, viewer_id, reading_id, estimated_tokens) -> ResourceLease` for rate-limit acquisition and release; `_retrieve_and_build(db, corpus_context, question, viewer_id) -> tuple[OracleCorpusImage, list[Candidate]]` for retrieval; `_call_llm(router, api_key, request) -> ParsedReading` for the LLM call. Define a typed result dataclass (e.g. `ReadingResult` with status: Literal['complete','failed','noop'] fields) instead of dict[str, Any]. execute_reading becomes a thin sequencer over these named steps.

#### 🟠 3. _stable_citation_key duplicates nexus.hashing.stable_json_hash
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/oracle.py:1507-1509` · `python/nexus/hashing.py:10-12`  

**Problem.** _stable_citation_key (oracle.py:1507) is character-for-character identical to stable_json_hash in nexus/hashing.py: both do `json.dumps(payload, sort_keys=True, separators=(',', ':'), default=str)` followed by `hashlib.sha256(...).hexdigest()`. oracle.py already imports from nexus.hashing at line 40 (used only for _provider_request_hash at line 1664) but defines its own duplicate. cleanliness.md §4 requires collapsing repeated logic to a single owner.

**Fix.** Delete _stable_citation_key. Replace both call sites (lines 1403 and 1459) with `stable_json_hash(...)` which is already imported. The payload shapes are dicts that will serialize identically.

#### 🟠 4. Corpus readiness validation logic duplicated between oracle service and build_corpus script
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`  
**Where:** `python/nexus/services/oracle.py:234-309` · `scripts/oracle/build_corpus.py:379-452`  

**Problem.** _ensure_corpus_seed_ready (oracle.py:234-309) and _validate_corpus_counts (build_corpus.py:379-452) execute nearly identical 6-count SQLAlchemy queries over OracleCorpusSetVersion/OracleCorpusWork/OracleCorpusPassage/OracleCorpusImage, check the same work/passage/image/embedding/safe-image thresholds, and apply the same logic. The build script even imports ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS/PASSAGES/IMAGES from oracle.py (build_corpus.py:36-39). This means the same query is maintained in two places; a change to the corpus readiness rules must be applied in both. cleanliness.md §4 requires collapsing repeated logic to a single owner.

**Fix.** Move the readiness query and threshold check into a single function in the service (or the proposed oracle_corpus.py module): `check_corpus_readiness(db, corpus_set_version_id) -> CorpusReadinessReport` returning a typed result. The build script calls this function and formats its own error output from the report; the service calls it for the gate check. The build script stops reimplementing the query.

#### 🟠 5. E_ORACLE_CORPUS_INCOMPLETE used as a raw string literal, bypassing ApiErrorCode enum
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `errors.md`  
**Where:** `python/nexus/services/oracle.py:658` · `python/nexus/services/oracle.py:660` · `python/nexus/services/oracle.py:1026`  

**Problem.** E_ORACLE_CORPUS_INCOMPLETE is used as a bare string at three sites in oracle.py but is not a member of the ApiErrorCode enum in nexus/errors.py. The other error codes passed to _fail() use ApiErrorCode enum members or their .value strings. _oracle_failure_message dispatches on this string at line 1026. This makes the set of valid error codes non-exhaustive in the type system: a typo in the string would silently fall through to ORACLE_UNEXPECTED_FAILURE_MESSAGE. cleanliness.md §9 requires making illegal states unrepresentable.

**Fix.** Add E_ORACLE_CORPUS_INCOMPLETE = 'E_ORACLE_CORPUS_INCOMPLETE' to ApiErrorCode in nexus/errors.py. Replace all three raw string usages with ApiErrorCode.E_ORACLE_CORPUS_INCOMPLETE and ApiErrorCode.E_ORACLE_CORPUS_INCOMPLETE.value respectively. Map it in ERROR_CODE_TO_STATUS with an appropriate HTTP status (503 or 500).

#### 🟡 6. _corpus_embedding_model queried redundantly inside _retrieve_corpus_passages and _pick_plate after already being fetched in execute_reading
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/oracle.py:663-666` · `python/nexus/services/oracle.py:1134-1142` · `python/nexus/services/oracle.py:1530-1538`  

**Problem.** execute_reading calls _corpus_embedding_model at line 663 and stores the result in corpus_query_embedding_model. Then _retrieve_corpus_passages (called at line 685) calls _corpus_embedding_model again at line 1134 and re-verifies the same equality check. _pick_plate (called at line 671) does the same at line 1530. This is three DB round-trips for the same value within one request, and two downstream duplicates of the already-proven equality check. The caller already verified the model; the internal re-verification is dead defensive code.

**Fix.** Remove the _corpus_embedding_model call inside _retrieve_corpus_passages and _pick_plate. Accept query_embedding_model as a trusted parameter (already done) and remove the redundant internal re-fetch. The single fetch in execute_reading is sufficient; the two downstream equality re-checks add complexity without safety.

#### 🟡 7. create_reading strips and re-validates question length already normalized by the Pydantic schema
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/oracle.py:155-160` · `python/nexus/schemas/oracle.py:13-16`  

**Problem.** OracleReadingCreateRequest uses ConfigDict(str_strip_whitespace=True) and Field(min_length=1, max_length=280), so by the time body.question reaches oracle_service.create_reading in the route handler, it is already stripped and validated. The service then strips again (line 155) and raises ApiError for empty/too-long questions (lines 156-160), duplicating validation that is already enforced at the transport boundary. cleanliness.md §4 and §6 require parsing/validating at the boundary and passing typed values inward.

**Fix.** Remove the strip and length guard from create_reading (lines 155-160). The route handler already guaranteed a valid, stripped question via the Pydantic schema. The service may keep a single-line `cleaned = question` assignment if the variable name is used below, but the guard is redundant.

#### 🟡 8. mint_stream_token returns untyped dict, forcing str() coercions in route handler
`Low` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §8`  
**Where:** `python/nexus/api/routes/oracle.py:34-44` · `python/nexus/auth/stream_token.py:43`  

**Problem.** mint_stream_token returns `dict` (untyped), so the route handler must coerce each field with str() at lines 35, 41, and 44 to satisfy type expectations. This is defensive noise in a thin route handler that should just shape data. The token, stream_base_url, and expires_at are always strings; the coercions exist only to compensate for the missing return type. cleanliness.md §9 requires typing output values so downstream guards become unnecessary.

**Fix.** Change mint_stream_token to return a TypedDict or dataclass (e.g. StreamToken with token: str, stream_base_url: str, expires_at: str). Remove the three str() wrappers in the route handler.

#### 🟡 9. Empty oracle.md module doc — no design contract to verify against
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/oracle.md`  

**Problem.** docs/modules/oracle.md is completely empty (0 bytes). The module doc is the intended design used to flag drift; its absence means no architectural intent is captured for a 1838-line service. cleanliness.md §3 treats stale or missing docs as a lead to investigate.

**Fix.** Write a minimal oracle.md capturing: the oracle's public interface (listed functions and their callers), the reading lifecycle state machine (pending → streaming → complete/failed), which modules are permitted to call which oracle functions, and the corpus readiness contract. This creates a baseline for future audits and makes the god-file split easier to reason about.

#### 🟡 10. Dead legacy image URL rewrite branch in _oracle_image_proxy_url
`Low` · `Medium-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`  
**Where:** `python/nexus/services/oracle.py:985-990`  

**Problem.** _oracle_image_proxy_url has a branch (line 988) that converts '/media/image?url=' to '/api/media/image?url='. The corpus build script (scripts/oracle/build_corpus.py:311) stores resolved Wikimedia asset URLs as source_url — never a proxy path. No code path writes a '/media/image?url=' value into OracleCorpusImage.source_url; this branch can only fire if an image was seeded with the old proxy path. cleanliness.md §3 requires removing branches kept only for old storage formats that no longer exist.

**Fix.** Verify via a DB query that no existing corpus image has source_url starting with '/media/image?url='. If none exist, remove lines 988-989. The function reduces to: if already proxied, return; else proxy-encode.


<a id="py-chat-runs"></a>
## Chat runs service  · `py-chat-runs`
*9 issues (2 High)*  

> **Verdict.** The overall satellite decomposition (finalize, idempotency, access, event_store, validation, message_prep, usage, response) is directionally correct, but `chat_runs.py` remains a 1611-line god file whose `_execute_chat_run` function (541 lines) mixes LLM streaming, tool dispatch for four distinct tools, citation indexing, and run finalization inside a single body. The worst rot is the tool-dispatch god function: it owns four unrelated tool adapters inline, duplicates the search event-emission pattern twice, and houses private citation-persistence helpers that tests access directly as production seams. Secondary issues are a triple resolve_api_key call per run creation, duplicated message+run creation logic between create_chat_run and retry_failed_assistant_response, and the tool-arg parser for app_search living in the wrong module.


#### 🔴 1. Split _execute_chat_run: extract tool-dispatch orchestrator into chat_run_tool_dispatch.py
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/chat_runs.py:1070-1611` · `python/nexus/services/chat_runs.py:1224-1436`  

**Problem.** `_execute_chat_run` is 541 lines and runs five unrelated phases in one body: (1) run-state pre-checks and rate-limit acquisition, (2) context assembly, (3) LLM streaming loop, (4) inline dispatch for four tools (app_search, web_search, read_resource, inspect_resource) each with their own persistence side-effects, and (5) post-stream outcome classification and finalization. Phases 3 and 4 alone span roughly 240 lines. This violates the rule against functions that run unrelated phases and the service rule that each service owns one capability end-to-end with a small interface.

**Fix.** Extract a new module `chat_run_tool_dispatch.py` that owns per-tool-call execution and persistence for all four tools. Its public interface is a single async function `dispatch_tool_call(db, run, tc, *, citation_n_next, tool_call_index, viewer_id, web_search_provider) -> ToolCallResult` returning a named dataclass with fields `tool_result: ToolResult`, `next_citation_n: int`. Each tool adapter (app_search, web_search, read_resource, inspect_resource) is a private helper inside that module. The private helpers `_persist_attached_citations`, `_persist_tool_call_trace`, `_persist_read_evidence_citation`, `_assign_citation_ordinals`, and `_emit_citation_index` move into this module. The streaming loop in `_execute_chat_run` then calls `dispatch_tool_call(...)` per tool call. `_execute_chat_run` shrinks to coherent orchestration of roughly 200 lines.

#### 🔴 2. Move _app_search_scopes_from_tool_args to app_search.py; remove production test seam
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §11`  
**Where:** `python/nexus/services/chat_runs.py:201-222` · `python/nexus/services/agent_tools/app_search.py:148-162` · `python/nexus/tests/test_chat_runs.py:15` · `python/nexus/tests/test_chat_runs.py:1040-1078`  

**Problem.** `_app_search_scopes_from_tool_args` parses the `scopes`/`scope` field from LLM tool arguments and produces a `(scopes, forced_error)` pair fed directly to `execute_app_search`'s `forced_error` parameter. This parsing logic belongs to the app_search capability, not the run orchestrator. It lives in `chat_runs.py` and tests import the private symbol directly from `chat_runs` — a production seam kept only for tests. `execute_app_search` already accepts `forced_error` to handle bad input gracefully; the parser belongs alongside that contract.

**Fix.** Move `_app_search_scopes_from_tool_args` into `nexus/services/agent_tools/app_search.py` as a public function `parse_app_search_tool_args(args) -> tuple[list[str], str | None]`. Update `chat_runs.py` to import and call it from `app_search`. Update tests to import it from `nexus.services.agent_tools.app_search`.

#### 🟠 3. Collapse duplicate message+run creation between create_chat_run and retry_failed_assistant_response
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §5`  
**Where:** `python/nexus/services/chat_runs.py:723-773` · `python/nexus/services/chat_runs.py:842-924`  

**Problem.** `create_chat_run` (lines 723-773) and `retry_failed_assistant_response` (lines 842-924) each independently create a user Message, an assistant Message, a ChatRun with the same 8-field constructor, append a 'meta' event with the same shape, and call `enqueue_job` with identical kind/priority/max_attempts/dedupe_key patterns. The retry message creation also near-duplicates `prepare_messages` in `chat_run_message_prep.py` (user message + ensure_branch_metadata + assistant message + persist_active_leaf), differing only in skipping conversation-title derivation.

**Fix.** Extract a private helper `_create_run_and_enqueue(db, *, owner_user_id, conversation_id, user_message_id, assistant_message_id, model, idempotency_key, payload_hash, reasoning, key_mode, job_payload) -> ChatRun` that handles ChatRun construction, meta event, and enqueue. Both callers use it. For the retry message creation, add an optional `clone_from: Message` parameter to `prepare_messages` in `chat_run_message_prep.py` (or a separate `prepare_retry_messages` function) that clones the source user message, skipping title derivation.

#### 🟠 4. Triple resolve_api_key and double get_model_by_id per run creation: collapse to one each
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/chat_runs.py:685` · `python/nexus/services/chat_runs.py:690-699` · `python/nexus/services/chat_run_validation.py:49` · `python/nexus/services/chat_run_validation.py:64`  

**Problem.** For a single `create_chat_run` call, `get_model_by_id` is called twice (line 685 in `create_chat_run`, then line 49 inside `validate_pre_phase`) and `resolve_api_key` is called twice (line 690 in `create_chat_run` to derive `use_platform_key`, then line 64 inside `validate_pre_phase` to validate key existence). The `validate_pre_phase` function returns a `Model` but `create_chat_run` ignores it. This is two redundant DB/service round-trips on the hot HTTP request path.

**Fix.** Pass the already-loaded `model` and `use_platform_key` flag into `validate_pre_phase` as parameters instead of having it re-derive them internally. Remove the `get_model_by_id` and `resolve_api_key` calls from inside `validate_pre_phase`. Signature becomes `validate_pre_phase(db, viewer_id, ..., model: Model, use_platform_key: bool) -> None`. The worker's separate `resolve_api_key` at execution time (line 1109) is correct and intentional.

#### 🟠 5. ERROR_CODE_TO_MESSAGE and _max_output_tokens_for_reasoning re-exported from chat_runs.py hide their true owners
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `python/nexus/services/chat_runs.py:85-94` · `python/nexus/tests/test_openai_reasoning_contracts.py:17-18`  

**Problem.** `chat_runs.py` imports and thereby re-exports `ERROR_CODE_TO_MESSAGE`, `MAX_ASSISTANT_CONTENT_LENGTH`, `TRUNCATION_NOTICE`, and `dummy_resolved_key` from `chat_run_finalize.py`. Tests import `ERROR_CODE_TO_MESSAGE` and the private `_max_output_tokens_for_reasoning` directly from `chat_runs` rather than from their owning module. This is a barrel re-export that hides where symbols live, and `_max_output_tokens_for_reasoning` is a private symbol exposed as a test seam.

**Fix.** Update `test_openai_reasoning_contracts.py` to import `ERROR_CODE_TO_MESSAGE` from `nexus.services.chat_run_finalize` directly. Move `_max_output_tokens_for_reasoning` to `chat_prompt.py` alongside other token-budget helpers and make it public; tests import it there. Neither symbol should be discoverable via `chat_runs`.

#### 🟠 6. Tests import private helpers from chat_runs.py as production seams (_emit_citation_index, _persist_attached_citations, _persist_read_evidence_citation, _retrieval_row_to_uri)
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`  
**Where:** `python/nexus/tests/test_chat_runs.py:1669` · `python/nexus/tests/test_chat_runs.py:1787` · `python/nexus/tests/test_attached_citations.py:261` · `python/nexus/tests/test_attached_citations.py:463` · `python/nexus/tests/test_attached_citations.py:638` · `python/nexus/tests/test_chat_runs.py:15-16`  

**Problem.** Multiple test files directly import private symbols from `chat_runs.py` (`_emit_citation_index`, `_persist_attached_citations`, `_persist_read_evidence_citation`, `_retrieval_row_to_uri`). These are production seams: tests call internal functions by name rather than exercising observable behavior through the public service interface. This couples tests to implementation internals and prevents safe refactoring of `_execute_chat_run`.

**Fix.** After moving these helpers to their owning module (`chat_run_tool_dispatch.py` per the god-file split above), expose them as public functions from that module. Tests in `test_attached_citations.py` import from the owning module. `_retrieval_row_to_uri` and `_result_ref_resource_id` become public in `chat_run_tool_dispatch.py`.

#### 🟡 7. assert_chat_run_owner is a one-liner indirection wrapper
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `python/nexus/services/chat_runs.py:1010-1011` · `python/nexus/api/routes/stream.py:86`  

**Problem.** `assert_chat_run_owner` at line 1010 is a one-line wrapper that calls `get_run_for_owner` and discards the result. The caller in `stream.py` could call `get_run_for_owner` directly; the raised `NotFoundError` is the observable contract. This is pure renaming indirection.

**Fix.** Delete `assert_chat_run_owner`. Update `stream.py` to call `get_run_for_owner(db, viewer_id, run_id)` directly from `nexus.services.chat_run_access`.

#### 🟡 8. docs/modules/chat.md is empty — missing design doc creates no ownership anchor
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/chat.md`  

**Problem.** The module documentation file is empty (0 bytes). The codebase has a 1611-line service plus 10+ satellite modules and two adapters, but no design document establishes ownership boundaries, public contracts, or intended decomposition. The file exists as a placeholder but was never written, making it impossible to validate code drift against intent.

**Fix.** Write `docs/modules/chat.md` documenting: (1) the one-run-per-send durable execution model, (2) the public service boundary functions, (3) which satellite module owns which sub-capability, and (4) the boundary contract: routes and tasks call only the public service; tool dispatch, citation persistence, and streaming are internal to the service cluster.

#### 🟡 9. status filter in list_chat_runs_for_conversation accepts raw str and validates inline: use a typed Literal
`Low` · `Medium-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §8`  
**Where:** `python/nexus/services/chat_runs.py:934-950` · `python/nexus/api/routes/chat_runs.py:48`  

**Problem.** `list_chat_runs_for_conversation` accepts `status: str` and validates it with an inline if/elif/else chain. The valid set is implicit in the service body. An unknown status string is a representable illegal state that requires the guard to remain forever.

**Fix.** Define `ChatRunStatusFilter = Literal["active", "queued", "running", "complete", "error", "cancelled"]` in the schemas module. Change the route parameter to `Annotated[ChatRunStatusFilter, Query()]` so FastAPI validates at the edge. Remove the `else: raise ApiError` branch from the service.


<a id="py-context-assembler"></a>
## Context assembler / retrieval / citations  · `py-context-assembler`
*8 issues (2 High)*  

> **Verdict.** context_assembler.py (918 lines, 19 top-level symbols) is the dominant rot: it conflates prompt-block rendering, raw-SQL DB reads (messages, tool calls, retrieval refs), raw-SQL DB writes (chat_prompt_assemblies upsert), resource attachment logic, and high-level assembly orchestration into one file. The remaining files in the slice are reasonably clean — prompt_budget.py, retrieval_citation.py, resource_loaders.py, and resource_resolver.py each have a clear single concern — but retrieval_citation.py carries a 130-line result_ref_json() method that re-assembles field shapes already encoded by the RetrievalResultRef discriminated union in retrieval.py, creating a parallel serialization path. The speculative budget lanes in prompt_budget.py (7 of 11 lanes are never assigned in production code) and the zero-byte module docs are secondary rot.


#### 🔴 1. context_assembler.py is a god file: mixes orchestration, DB reads, DB writes, block rendering, and resource attachment
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/services/context_assembler.py:1-918` · `python/nexus/services/context_assembler.py:355-453 (persist_prompt_assembly — raw SQL write)` · `python/nexus/services/context_assembler.py:680-744 (load_recent_history_units — raw SQL read)` · `python/nexus/services/context_assembler.py:747-818 (_load_tool_events + _tool_retrieval_refs — raw SQL reads)` · `python/nexus/services/context_assembler.py:565-677 (_build_resources_block + _materialize_attached_citation + _render_resource — resource attachment and XML rendering)`  

**Problem.** The file owns five distinct concerns simultaneously. (1) High-level orchestration: assemble_chat_context (lines 107–352) drives the whole assembly pipeline. (2) Persistence: persist_prompt_assembly issues raw SQL INSERT/UPDATE against chat_prompt_assemblies — this is a DAL write that belongs to the same module as chat_run_prompt_tracking.py, which already owns related reads from that table. (3) History loading: load_recent_history_units issues raw SQL against messages and returns typed HistoryUnit values; it is only called once, internally. (4) Tool-event loading: _load_tool_events and _tool_retrieval_refs issue raw SQL against message_tool_calls and message_retrievals to produce serialized event dicts for replay; this is a read concern unrelated to assembly. (5) Resource block building: _build_resources_block queries conversation_references, calls into resource_resolver, calls get_search_result for citation materialisation, and renders XML — three different concerns bundled with the assembly step. layers.md requires services to contain no HTTP or framework types and to own real business logic; these SQL blocks are DAL-layer operations mixed into a service. cleanliness.md §5 requires splitting files that mix unrelated concerns.

**Fix.** Split into four focused units: (a) Keep context_assembler.py as a thin orchestrator that calls the four units below and returns ContextAssembly; remove all SQL and rendering from it. (b) Create python/nexus/services/prompt_assembly_store.py — owns persist_prompt_assembly (move the SQL upsert there) and merge with the existing chat_run_prompt_tracking.py, which already queries the same chat_prompt_assemblies table; public contract: persist(db, run, assembly) -> None. (c) Create python/nexus/services/conversation_history.py (or add to existing conversation_branches.py) — owns load_recent_history_units with its SQL; public contract: load_history_units(db, conversation_id, before_seq, path_message_ids) -> list[HistoryUnit]. (d) Create python/nexus/services/tool_event_reader.py — owns _load_tool_events and _tool_retrieval_refs; public contract: load_tool_events(db, assistant_message_id) -> tuple[list[...], list[...]]. (e) Move _build_resources_block, _materialize_attached_citation, and _render_resource into resource_resolver.py or a new python/nexus/services/attached_resources.py; public contract: build_resources_block(db, conversation_id, viewer_id) -> tuple[PromptBlock | None, Mapping, tuple[RetrievalCitation, ...]].

#### 🔴 2. persist_prompt_assembly duplicates DAL ownership already held by chat_run_prompt_tracking.py
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §4`, `layers.md`  
**Where:** `python/nexus/services/context_assembler.py:355-453` · `python/nexus/services/chat_run_prompt_tracking.py:1-100`  

**Problem.** persist_prompt_assembly in context_assembler.py issues raw SQL INSERT/UPDATE against chat_prompt_assemblies (lines 381–453). chat_run_prompt_tracking.py already owns reads from the same table (lines 14–30: prompt_assembly_metadata, and the reconcile function at lines 34–100). Two modules mutate/read the same table — cleanliness.md §6 says to collapse to one canonical owner. The split creates a confusing ownership boundary: writing assembly rows lives in context_assembler.py while reading them lives in chat_run_prompt_tracking.py.

**Fix.** Move persist_prompt_assembly into chat_run_prompt_tracking.py (or rename that module to prompt_assembly_store.py to better reflect its scope). The new module becomes the single owner of all read and write operations against chat_prompt_assemblies. context_assembler.py calls it by its public function name only.

#### 🟠 3. Private functions _build_reader_selection_block and _build_resources_block are used as production seams by tests
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`  
**Where:** `python/nexus/services/context_assembler.py:506-548 (_build_reader_selection_block)` · `python/nexus/services/context_assembler.py:565-603 (_build_resources_block)` · `python/tests/test_reader_selection.py:20 (imports _build_reader_selection_block)` · `python/tests/test_attached_citations.py:250 (calls context_assembler._build_resources_block)`  

**Problem.** Two private functions with leading underscores are directly imported and invoked by tests. cleanliness.md §11 prohibits production seams kept only for tests — test-only exports and fake injection points must be eliminated. The tests bypass the true public surface (assemble_chat_context) to exercise these internals. When these functions move to their own modules (as recommended in the god-file split), the access pattern should be cleaned up simultaneously: the new owning module should expose a public function, and tests should call that public function rather than accessing a private helper.

**Fix.** As part of the god-file split, promote _build_reader_selection_block and _build_resources_block to named public functions in their new owning modules (e.g. build_reader_selection_block in a reader_context module, build_resources_block in attached_resources.py). Rewrite tests to call those public entry points rather than reaching into context_assembler privates.

#### 🟠 4. RetrievalCitation.result_ref_json() re-assembles the same shape already encoded by the RetrievalResultRef discriminated union
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/retrieval_citation.py:66-192 (result_ref_json method)` · `python/nexus/schemas/retrieval.py:433-449 (RetrievalResultRef union)` · `python/nexus/services/retrieval_citation.py:354 (retrieval_result_ref_json(citation.result_ref_json()))`  

**Problem.** RetrievalCitation stores self.result_ref as dict(payload) — the complete original search-result payload (line 212: result_ref = dict(payload)). result_ref_json() then reconstructs the per-type field shape by manually dispatching on self.result_type in a 130-line if/elif chain. This reconstructed dict is then passed to retrieval_result_ref_json() (line 354) which runs it through the RetrievalResultRef Pydantic discriminated union again — so the shape is validated twice. The RetrievalResultRef union in retrieval.py already specifies the canonical shape for each type including field constraints. The manual reconstruction in result_ref_json() is a duplicate owner of that shape. Any field added to a RetrievalResultRef variant must also be added to result_ref_json() — a two-site maintenance burden per cleanliness.md §4.

**Fix.** Replace result_ref_json() with a call to retrieval_result_ref_json(self.result_ref) directly, relying on the Pydantic union to validate and normalize the stored payload. For the few types where result_ref_json adds derived fields not in self.result_ref (e.g. evidence_span: re-resolving evidence_span_id or media_id), push that derivation into citation_from_search_result at construction time so self.result_ref is always the complete canonical dict. Then insert_retrieval_row becomes retrieval_result_ref_json(citation.result_ref) and the 130-line method disappears.

#### 🟠 5. Seven speculative budget lanes in prompt_budget.py are never assigned in production code
`Medium` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `simplicity.md`  
**Where:** `python/nexus/services/prompt_budget.py:15-27 (BudgetLane literal)` · `python/nexus/services/prompt_budget.py:32-44 (LANE_ORDER tuple)` · `python/nexus/services/prompt_budget.py:17-24 (scope, artifact_context, state_snapshot, retrieved_evidence, web_evidence, memory, pointer_refs)`  

**Problem.** BudgetLane is a Literal with 11 values. A search of all production service code confirms that only four lane values are actually assigned in production: system, attached_context, recent_history, and current_user. The seven remaining lanes — scope, artifact_context, state_snapshot, retrieved_evidence, web_evidence, memory, pointer_refs — appear only in tests (test_prompt_budget.py:154, test_chat_prompt.py:40/47) and in the lane definitions themselves. They are not assigned anywhere in nexus/services/. allocate_budget iterates over all 11 lanes via LANE_ORDER on every call, initializing empty breakdown entries for lanes that will never be populated. This is speculative API surface per simplicity.md: 'Do not add speculative API surface. Do not add optional parameters, options, or flags until a real call site needs them.'

**Fix.** Remove the seven unused lane values from the BudgetLane Literal and LANE_ORDER tuple, reducing both to only the four lanes in active use. Update test_prompt_budget.py and test_chat_prompt.py to use valid lanes. The allocate_budget function will be simpler, and adding a new lane in the future requires an intentional, auditable change.

#### 🟡 6. Seven near-identical start/end range validators in retrieval.py are copy-pasted across locator types
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/schemas/retrieval.py:463-467 (WebTextOffsetsLocator.validate_offsets)` · `python/nexus/schemas/retrieval.py:481-486 (EpubFragmentOffsetsLocator.validate_offsets)` · `python/nexus/schemas/retrieval.py:498-502 (NoteBlockOffsetsLocator.validate_offsets)` · `python/nexus/schemas/retrieval.py:541-545 (TranscriptTimeRangeLocator.validate_time_range)` · `python/nexus/schemas/retrieval.py:557-561 (AudioTimeRangeLocator.validate_time_range)` · `python/nexus/schemas/retrieval.py:573-577 (VideoTimeRangeLocator.validate_time_range)` · `python/nexus/schemas/retrieval.py:589-594 (MessageOffsetsLocator.validate_offsets)`  

**Problem.** All seven locator model validators implement the same invariant — end > start — using near-identical bodies. The only variation is the field names (start_offset/end_offset vs t_start_ms/t_end_ms) and the error message. cleanliness.md §4 says to collapse validators to a single owner when the same validation is repeated in more than one place. This is a large enough repeated structure (7 sites) that a change to the invariant (e.g. allowing zero-length ranges) requires editing all seven validators.

**Fix.** Extract a module-level helper validate_range(start: int, end: int, label: str) -> None that raises ValueError if end <= start. Each validator becomes a one-liner delegating to validate_range. This is a small cleanup that makes the invariant explicit and single-sited.

#### 🟡 7. Module docs for chat.md and oracle.md are empty — doc/code drift has no anchor
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/chat.md` · `docs/modules/oracle.md`  

**Problem.** Both module doc files exist (0 bytes each) and are referenced as the 'intended design' anchor for this slice. With no content, there is no way to detect drift between the intended design and the current implementation — every code smell the audit surfaced had to be inferred from code alone. cleanliness.md §3 treats a stale doc as a lead: the absence of content here means architectural intentions are invisible. This is compounded by context_assembler.py mixing multiple concerns with no authoritative doc to adjudicate which concern it is supposed to own.

**Fix.** Write a short module doc for each file: chat.md should describe what assemble_chat_context owns (the orchestration boundary), what it calls, and what it must not own (persistence, raw SQL); oracle.md should describe the retrieval/citation pipeline. Even 5–10 lines per file give the next engineer a baseline to detect drift.

#### 🟡 8. load_recent_history_units is a public symbol with no external callers — should be private
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `python/nexus/services/context_assembler.py:680-744`  

**Problem.** load_recent_history_units has a public name (no leading underscore) but is only ever called in one place: line 137 of assemble_chat_context in the same file. There are no external callers across the codebase. A public name inflates the module's public surface area, implying external consumption that does not exist. cleanliness.md §6 says to shrink every module's public surface to what is actually called.

**Fix.** Rename to _load_recent_history_units. If the history-loading function is later moved to its own module per the god-file split recommendation, it can become public at that point when its contract is truly being consumed externally.


<a id="py-vault"></a>
## Vault / BYOK / keys  · `py-vault`
*11 issues (2 High)*  

> **Verdict.** vault.py (1388 lines) is the most severe god file in this slice: it conflates four unrelated concerns in one module — export/download orchestration, filesystem I/O, highlight mutation (with its own duplicated locking and conflict-detection helpers), and Markdown serialization/parsing. The BYOK files (crypto.py, user_keys.py, api_key_resolver.py, keys.py) are mostly clean and well-layered, but carry a duplicated API-key validation, a duplicate fingerprint field in the response schema, an untyped key_mode string, a hollow one-use wrapper in crypto.py, and a misplaced get_model_by_id helper in the resolver. The module doc (byok.md) is empty, so no design-drift can be verified from it.


#### 🔴 1. vault.py is a god file mixing filesystem I/O, highlight mutation, page mutation, and Markdown serialization
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/services/vault.py:1-1388`  

**Problem.** vault.py runs 1388 lines and owns four distinct, unrelated capabilities in one module: (1) export/sync/watch orchestration and filesystem write operations (_write_text, _write_bytes, _write_source_files, _remove_old_handle_files, export_vault, sync_vault, watch_vault); (2) Markdown frontmatter serialization and parsing (_read_frontmatter, _write_frontmatter, handle utilities, hash utilities); (3) highlight mutation logic (_create_fragment_highlight, _apply_highlight_changes, _sync_highlight_content, _lock_fragment_row_for_highlight_write, _fragment_highlight_span_conflict_exists); and (4) page/note-block mutation logic (_sync_page_content, _sync_page_body, _sync_marked_page_blocks, _create_page_body). Each of these is a separate concern with separate collaborators, different test surfaces, and different ownership.

**Fix.** Split into four modules: (a) vault_fs.py — filesystem orchestration only (export_vault, sync_vault, watch_vault, _write_text, _write_bytes, _write_source_files, _remove_old_handle_files); (b) vault_markdown.py — pure stateless helpers (_read_frontmatter, _write_frontmatter, _slug, handle functions, hash functions, _conflict_path, _conflict_markdown, _editable_vault_path); (c) move highlight-mutation operations into services/highlights.py as one public function create_or_update_highlight_from_vault(db, viewer_id, metadata, body) -> tuple[bool, str | None], deleting the private duplicates from vault; (d) move page-mutation operations into services/notes.py as one public function sync_page_from_vault(db, viewer_id, metadata, body, fallback_title) -> tuple[bool, str | None]. vault_service (the public interface) becomes a thin orchestrator calling vault_markdown + highlights + notes. The public surface of the two new helpers in highlights and notes is one named command each, with a typed object param.

#### 🔴 2. vault.py duplicates _lock_fragment_row_for_highlight_write and _fragment_highlight_span_conflict_exists from highlights.py
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/vault.py:357-388` · `python/nexus/services/highlights.py:66-73` · `python/nexus/services/highlights.py:376-399`  

**Problem.** vault.py defines its own _lock_fragment_row_for_highlight_write (line 357) and _fragment_highlight_span_conflict_exists (line 366). highlights.py defines the same logic at lines 66-73 (_lock_fragment_row_for_highlight_write_or_404) and 376-399 (_fragment_highlight_span_conflict_exists). The vault version of the locking function uses raw text SQL while the highlights version uses the SQLAlchemy select API, which means there are now two different implementations of the same critical write serialization invariant. Any fix to one does not propagate to the other.

**Fix.** Delete both private helpers from vault.py. Expose them as package-internal helpers in highlights.py (rename without the _or_404 suffix where needed and make them importable), or factor the vault highlight mutation entirely into highlights.py as described in the god-file split above.

#### 🟠 3. API key format validation duplicated between UserApiKeyCreate schema and upsert_user_key service
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`  
**Where:** `python/nexus/schemas/keys.py:114-132` · `python/nexus/services/user_keys.py:159-164`  

**Problem.** UserApiKeyCreate.validate_api_key_format (schema, lines 114-132) strips whitespace, rejects keys shorter than 20 chars, and rejects keys containing internal whitespace. upsert_user_key (service, lines 159-164) repeats the same three checks verbatim with a comment acknowledging the schema already validated. This is dangerous duplication: the two copies can drift, and a future caller bypassing the schema would silently pass corrupt data through the service. Provider validation is similarly duplicated: the schema validator (line 105-110) and the service (lines 152-157) both check VALID_PROVIDERS.

**Fix.** The schema is the boundary parser; let it own the validation entirely. Remove the redundant strip/length/whitespace checks and the provider re-validation from upsert_user_key. Add a single comment in the service noting that api_key and provider are already validated by the schema. Keep only the encryption call and DB write in the service.

#### 🟠 4. UserApiKeyOut exposes both fingerprint and key_fingerprint as separate fields for the same value
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/schemas/keys.py:76-77` · `python/nexus/services/user_keys.py:61-62`  

**Problem.** UserApiKeyOut declares both fingerprint: str | None and key_fingerprint: str | None (schema lines 76-77). The service always sets them to the same value (user_keys.py lines 61-62). This exposes two interchangeable duplicate fields for the same concept in the public API contract. Any client reading either field gets the same value; there is no semantic distinction between them.

**Fix.** Remove one of the two fields. key_fingerprint matches the DB column name and is the more descriptive choice. Remove fingerprint from UserApiKeyOut. Update the service to only set key_fingerprint. This is a breaking change to the API response shape — coordinate with any clients reading the fingerprint field.

#### 🟠 5. get_model_by_id is misplaced in api_key_resolver: it owns no key-resolution concern
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/api_key_resolver.py:157-159`  

**Problem.** get_model_by_id(db, model_id) at line 157 of api_key_resolver.py is a one-line wrapper over db.get(Model, model_id). It has no relationship to API key resolution. It is imported by chat_runs.py and chat_run_validation.py purely because it happened to be convenient. Meanwhile, chat_run_finalize.py and tasks/chat_run.py call db.get(Model, ...) directly without going through this function, so even within the chat module it is not consistently used.

**Fix.** Delete get_model_by_id from api_key_resolver.py. Callers that use it (chat_runs.py line 685, chat_run_validation.py line 49) should either inline db.get(Model, model_id) directly or move the helper to the services/models.py module which already owns the model registry capability.

#### 🟠 6. key_mode parameter is an untyped str, making the three-way branch in resolve_api_key non-exhaustive
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §10`  
**Where:** `python/nexus/services/api_key_resolver.py:48` · `python/nexus/services/api_key_resolver.py:100-130`  

**Problem.** resolve_api_key accepts key_mode: str (line 48). The resolution logic branches on 'byok_only', 'platform_only', and falls to else: # auto for all other values (line 130). Any string value other than the two explicit ones silently behaves as 'auto'. There is no Literal type or exhaustiveness guard, so a typo or future addition is silently misrouted.

**Fix.** Introduce KeyMode = Literal['byok_only', 'platform_only', 'auto'] in schemas/keys.py or llm_catalog.py and change the parameter to key_mode: KeyMode. Replace the else branch with elif key_mode == 'auto': ... and add a final else: raise defect to make the match exhaustive. Propagate the type to all call sites (chat_runs.py, chat_run_validation.py).

#### 🟠 7. master_key_version or 1 silent fallback treats a structurally invalid NULL as version 1
`Medium` · `High-confidence` · `ErrorHandling` · rules: `cleanliness.md §3`, `cleanliness.md §10`  
**Where:** `python/nexus/services/user_keys.py:248` · `python/nexus/services/user_keys.py:447`  

**Problem.** In both test_user_key and decrypt_user_api_key_material, the code passes key.master_key_version or 1 to decrypt_api_key. A NULL master_key_version means the row is structurally incomplete (revoke wipes it to NULL), but for a non-revoked row it would indicate a data defect. Silently treating NULL as version 1 masks a potential data corruption scenario rather than failing fast.

**Fix.** In both call sites, explicitly guard: if key.master_key_version is None, treat this as a decryption failure (log a warning and return None / mark invalid) rather than silently assuming version 1. The path for revoked keys is already guarded before reaching the decryption call, so the None case for a live key is a defect.

#### 🟡 8. require_master_key is a one-use public wrapper that only delegates to _get_master_key
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `python/nexus/services/crypto.py:75-87`  

**Problem.** require_master_key() (lines 75-87) is a public function whose entire body is return _get_master_key(). It has no additional logic and both encrypt_secretbox and decrypt_secretbox call require_master_key directly. The docstring restates what _get_master_key already documents. This is a hollow wrapper kept for no reason.

**Fix.** Remove require_master_key. Make _get_master_key public by renaming it get_master_key (or simply leave it private and call it directly from encrypt_secretbox and decrypt_secretbox). The LRU-cache and validation already live in _get_master_key.

#### 🟡 9. api_key_resolver.py uses legacy db.query() style while user_keys.py uses the modern db.scalars() style
`Low` · `High-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`  
**Where:** `python/nexus/services/api_key_resolver.py:83-90`  

**Problem.** api_key_resolver.py uses db.query(UserApiKey).filter(...).first() (line 83) — the SQLAlchemy 1.x legacy query API — while the adjacent user_keys.py module consistently uses db.scalars(select(...)).first(). This dual old/new code path mixes ORM styles in the same domain.

**Fix.** Replace the db.query(...).filter(...).first() call in resolve_api_key with select(UserApiKey).where(...) consumed through db.scalars(...).first(), matching the style in user_keys.py.

#### 🟡 10. byok.md module doc is empty — no design specification exists to verify against
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/byok.md:1`  

**Problem.** docs/modules/byok.md has zero content (0 lines). The file exists but contains no specification of the intended design, capabilities, ownership model, or public contract for the BYOK system. This makes it impossible to verify whether the implementation drifts from intent and violates the expectation that module docs describe the authoritative design.

**Fix.** Either write the module doc to describe the intended BYOK architecture (key lifecycle, encryption contract, resolution modes, ownership boundaries between crypto/user_keys/api_key_resolver), or delete the empty file so it does not imply documentation that does not exist.

#### 🟡 11. schemas/keys.py mixes BYOK-key schemas with model-registry schema (ModelOut)
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `python/nexus/schemas/keys.py:36-54`  

**Problem.** schemas/keys.py bundles ModelOut (an LLM model registry response type used by the /models endpoint and services/models.py) alongside UserApiKeyOut and UserApiKeyCreate (BYOK key management types). These are different capabilities with different owners. The file name and module comment both indicate it is a keys/BYOK schema file, but the model registry type lives here because it was convenient at the time.

**Fix.** Move ModelOut (and the model-catalog imports LLMProvider, ModelAvailableVia, ModelTier, ReasoningMode that are only used in ModelOut) to a dedicated schemas/models.py. Update the two importers: services/models.py and api/routes/models.py. This shrinks schemas/keys.py to its true scope.


<a id="py-conversations"></a>
## Conversations service  · `py-conversations`
*11 issues (2 High)*  

> **Verdict.** The conversations service (conversations.py, 1038 lines) is a moderate god file mixing four distinct capabilities: conversation CRUD, message listing with branch-path resolution, retrieval/rerank ledger read queries, and the shared delete-cascade infrastructure used by both itself and conversation_branches. The schema file (conversation.py, 724 lines) is worse: it co-locates conversation/message output shapes, all SSE event payload validators and their dispatch function, chat-run request/response schemas, branch-graph output types, and the full retrieval-result validator logic — schemas for at least five separate bounded contexts in one file. The worst rot is in conversation.py (schemas): the duplicated validate_ref_type_parity validator body is a dangerous near-identical copy, and the placement of chat-run/branch/SSE types in what is nominally a "conversation schema" file makes its public surface enormous and unclear.


#### 🔴 1. conversation.py schema file mixes five unrelated bounded contexts
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/schemas/conversation.py:1-725`  

**Problem.** The file conflates: (1) conversation/message output shapes (ConversationOut, MessageOut, PageInfo), (2) retrieval and rerank ledger shapes (MessageRetrievalOut, MessageRetrievalCandidateLedgerOut, MessageRerankLedgerOut) and their validator logic, (3) all SSE chat-run event payload schemas (ChatRunMetaEventPayload through ChatRunReferenceAddedEventPayload) plus the dispatch function chat_run_event_payload_json, (4) chat-run request/response schemas (ChatRunCreateRequest, ChatRunOut, ChatRunResponse, ChatRunEventOut, ReaderContextHint, ReaderSelectionRequest), and (5) branch-graph output types (BranchAnchorRequest variants, ForkOptionOut, BranchGraphNodeOut, BranchGraphEdgeOut, BranchGraphOut, ConversationTreeOut, ConversationForksOut). Importers across chat_runs.py, chat_run_response.py, chat_run_message_prep.py, conversation_branches.py, stream.py, tasks/chat_run.py, and chat_run_idempotency.py all depend on this single mega-module, making its public surface untraceable and changes risky.

**Fix.** Split into at minimum four schema modules: (a) schemas/conversation_schemas.py — ConversationOut, MessageOut, MessageDocument* blocks, PageInfo, MessagePageInfo; (b) schemas/chat_run_schemas.py — ChatRunCreateRequest, ChatRunOut, ChatRunResponse, ChatRunEventOut, ChatRunDoneEventPayload and all other SSE payload classes, chat_run_event_payload_json, ReaderContextHint, ReaderSelectionRequest, KEY_MODES, REASONING_MODES, MAX_MESSAGE_CONTENT_LENGTH; (c) schemas/branch_schemas.py — BranchAnchorRequest variants, ForkOptionOut, BranchGraphNodeOut/EdgeOut/Out, ConversationTreeOut, ConversationForksOut, SetActivePathRequest, RenameBranchRequest; (d) schemas/retrieval_schemas.py — MessageRetrievalOut, MessageRetrievalCandidateLedgerOut, MessageRerankLedgerOut, and the shared validate_ref_type_parity logic as a private helper function called by both retrieval schemas. Each schema module's public contract becomes obvious; importers update to import from the owning module.

#### 🔴 2. Duplicated validate_ref_type_parity validator body across MessageDocumentRetrievalResultBlock and MessageRetrievalOut
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/schemas/conversation.py:143-169` · `python/nexus/schemas/conversation.py:239-265`  

**Problem.** The entire validate_ref_type_parity validator — checking context_ref.type matches result_type (with episode/video special case), result_ref.type matches result_type, source_version parity, and locator parity via full model_dump comparison — is copy-pasted identically in both MessageDocumentRetrievalResultBlock (lines 143-169) and MessageRetrievalOut (lines 239-265). Any change to the parity rules must be applied in two places. The two schemas represent the same domain invariant (retrieval result type coherence) for different use cases (message document block vs. persisted retrieval row).

**Fix.** Extract a module-private function _validate_retrieval_ref_type_parity(result_type, context_ref, result_ref, source_version, locator) -> None that raises ValueError for each failure case. Both validators call this function. This is the single owner of the coherence rule.

#### 🟠 3. Cursor encoding/decoding logic duplicated between conversations and conversation_references services
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/conversations.py:77-128` · `python/nexus/services/conversation_references.py:63-87`  

**Problem.** conversation_references.py implements its own _decode_cursor_clause (lines 63-82) and _encode_cursor (lines 85-87) with identical base64url/JSON encode-decode logic, identical error handling (catch ValueError/KeyError/TypeError, raise InvalidRequestError with E_INVALID_CURSOR), and an identical SQL fragment ('AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)'). conversations.py owns the canonical implementation via _encode_cursor/_decode_cursor and encode_conversation_cursor/decode_conversation_cursor/_conversation_cursor_clause. The service doc comment in conversation_references.py even acknowledges this: 'Pagination defaults mirror nexus.services.conversations. Kept local so this service does not depend on conversation list internals.' The duplication creates a split ownership of the cursor contract.

**Fix.** Expose encode_conversation_cursor, decode_conversation_cursor, and _conversation_cursor_clause (or a renamed public variant) from conversations.py as the single owner. conversation_references.py imports and uses them. The comment about 'not depending on conversation list internals' is the wrong goal — the cursor format is a shared contract, not an internal detail. Alternatively, extract a small nexus/pagination.py module with the base64url codec and the conversation-cursor SQL clause, owned by neither service.

#### 🟠 4. Scope validation duplicated between list_conversations route handler and service
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/api/routes/conversations.py:87-93` · `python/nexus/services/conversations.py:386-390`  

**Problem.** The route handler list_conversations (routes/conversations.py:87-93) validates scope in {'mine','all','shared'} and raises InvalidRequestError with the same message as the service function list_conversations (services/conversations.py:386-390). Both checks raise the same error code and nearly identical message strings. The rule is owned by neither layer cleanly; changing allowed scopes requires updating both files. The service guard becomes unreachable in practice because the route guard fires first.

**Fix.** Remove the scope validation from the route handler (routes/conversations.py:87-93). The service is the canonical owner of VALID_SCOPES and already raises InvalidRequestError(E_INVALID_REQUEST) on invalid scope. The route may still default None scope to 'mine' but should not duplicate the membership check.

#### 🟠 5. conversations.py route file hosts routes for branches, shares, and chat-run retry alongside conversations/messages
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `layers.md`  
**Where:** `python/nexus/api/routes/conversations.py:160-238` · `python/nexus/api/routes/conversations.py:268-313` · `python/nexus/api/routes/conversations.py:416-429`  

**Problem.** The 450-line routes/conversations.py file registers 16 handlers spanning five capabilities: core conversation CRUD (list, create, get, delete), conversation branches/paths (get_conversation_tree, set_conversation_active_path, list/rename/delete forks), conversation shares (get/set shares), message operations (list_messages, delete_message), retrieval ledgers (list_message_retrieval_candidate_ledgers, list_message_rerank_ledgers), and chat-run retry (retry_failed_assistant_response). It imports from five different services (conversations, conversation_branches, conversation_references, shares, chat_runs). This violates the single-concern rule for transport boundary files.

**Fix.** Split the router into: (a) api/routes/conversations.py — conversation CRUD only (list, create, get, delete); (b) api/routes/conversation_branches.py — branch/path endpoints (tree, active-path, forks CRUD); (c) api/routes/conversation_shares.py — shares GET/PUT; (d) api/routes/messages.py — message list, delete, retrieval ledgers, rerank ledgers, retry. Each file imports only the services it directly delegates to. This mirrors the existing pattern where conversation_references.py already has its own route file.

#### 🟠 6. list_messages function body runs three unrelated phases in one function with unsafe has_older reference
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`  
**Where:** `python/nexus/services/conversations.py:528-620`  

**Problem.** list_messages (93 lines) runs: (1) visibility auth check, (2) path resolution (_selected_path_message_rows — a 50-line recursive CTE), (3) three distinct windowing/pagination modes (forward cursor, before_cursor, latest-window), and (4) assembling MessageOut objects with retryable-message decoration. The branching windowing logic sets has_older in two separate branches (lines 571, 575) that share the same variable name, then reads it unconditionally at line 613 — if neither before_cursor nor window=='latest' is active, has_older is undefined and the reference at line 613 would raise NameError. Additionally, the message-rows-to-MessageOut mapping at lines 593-610 uses positional row indices (row[0] through row[12]) with no named RowMapping, making the column-to-field mapping fragile.

**Fix.** Extract: (a) _apply_message_window(rows, limit, cursor, before_cursor, window) -> tuple[list[Row], str|None, str|None, bool] that handles all three windowing branches and explicitly returns has_older, next_cursor, before_cursor_out; (b) _row_to_message_out(row, retryable_ids) using a named tuple or TypedDict for the SQL columns so the index magic is centralized and documented. Fix the has_older undefined-name risk by initializing has_older = False before the branch or restructuring the three branches to each assign it.

#### 🟠 7. conversations.py service hosts retrieval/rerank ledger query capability that belongs to a retrieval or chat-run service
`Medium` · `Medium-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/conversations.py:639-758`  

**Problem.** list_message_retrieval_candidate_ledgers (lines 639-678) and list_message_rerank_ledgers (lines 719-758) deal with retrieval pipeline observability: they join MessageToolCall, MessageRetrievalCandidateLedger, MessageRetrieval, and MessageRerankLedger — DB models entirely outside the conversation/message domain — and produce detailed retrieval-pipeline output shapes. The only connection to the conversations service is the initial _get_message_for_visible_read_or_404 visibility check. These capabilities are unrelated to conversation/message CRUD and belong logically to whatever service owns message retrieval observability. The conversations.py service already has 1038 lines.

**Fix.** Move list_message_retrieval_candidate_ledgers, list_message_rerank_ledgers, and _retrieval_candidate_ledger_to_out into a retrieval observability service (e.g., services/message_retrievals.py). The visibility check can call get_conversation_for_visible_read_or_404 imported from conversations, which is already the public API for that predicate. The route handlers in api/routes/conversations.py continue calling the new service with the same signature.

#### 🟡 8. Pagination limit clamping logic duplicated between conversations and conversation_references services
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/conversations.py:136-138` · `python/nexus/services/conversation_references.py:332`  

**Problem.** conversations.py defines clamp_limit(limit) -> int (line 136-138) that returns min(max(limit, MIN_LIMIT), MAX_LIMIT). conversation_references.py inlines the identical expression limit = min(max(limit, _MIN_LIMIT), _MAX_LIMIT) at line 332 rather than calling the canonical function. Both services share the same numeric bounds (1, 100) but manage them independently with separate named constants (_DEFAULT_LIMIT, _MIN_LIMIT, _MAX_LIMIT).

**Fix.** conversation_references.py should import clamp_limit from conversations (or from the shared pagination module proposed above) and call it rather than repeating the inline expression.

#### 🟡 9. conversation_references _require_owner duplicates ownership-check pattern from conversations service with divergent error semantics
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/conversation_references.py:90-96` · `python/nexus/services/conversations.py:174-186`  

**Problem.** conversation_references._require_owner (lines 90-96) and conversations.get_conversation_for_owner_write_or_404 (lines 174-186) both load a Conversation and enforce owner-only access. They differ in one semantic detail: _require_owner calls can_read_conversation first and raises NotFoundError for invisible conversations, then raises a distinct ForbiddenError(E_OWNER_REQUIRED) when the conversation is visible but not owned. get_conversation_for_owner_write_or_404 does not call can_read_conversation and raises NotFoundError for both missing and non-owned cases (masking ownership). The references service intentionally chose the two-step pattern to expose a 403 to owners of shared conversations — a valid difference — but this intent is not documented, and there is no single owned location for the canonical 'owner write access' predicate.

**Fix.** Document the intentional semantic difference in a comment on _require_owner. If the two-step (read-check then owner-check) pattern is also desired for branches or shares, export a canonical get_conversation_for_owner_write_or_403 from conversations.py so downstream callers share the implementation. Do not merge the two if the error semantics genuinely differ for product reasons.

#### 🟡 10. docs/modules/chat.md is effectively empty — stale doc points at dead design intent
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`, `cleanliness.md §13`  
**Where:** `docs/modules/chat.md:1`  

**Problem.** The module doc designated as the authoritative design for the conversations service slice is a 1-line empty file. It provides no intended design specification to compare against the implementation, cannot flag drift, and signals an abandoned documentation effort. The conversations.py service docstring provides more intent than the module doc.

**Fix.** Either populate chat.md with the intended design (capability decomposition, public contract, access control model, pagination design) or delete it. An empty doc misleads reviewers into thinking there is a spec when there is none.

#### 🟡 11. Public cursor encode/decode functions exported but used only internally within conversations.py
`Low` · `Medium-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `python/nexus/services/conversations.py:102-117`  

**Problem.** encode_conversation_cursor, decode_conversation_cursor, encode_message_cursor, and decode_message_cursor are public (no underscore prefix) and show no callers outside conversations.py itself (grep confirms they are not imported by any other module). They are effectively internal helpers. Making them public expands the module's surface unnecessarily and implies callers may rely on them.

**Fix.** Prefix with underscore (_encode_conversation_cursor etc.) to mark as internal, or move them to the proposed shared pagination module if the deduplication work above is done. Confirm no callers exist in tests before renaming (test_conversations.py imports derive_conversation_title/DEFAULT_CONVERSATION_TITLE but not the cursor functions).


<a id="py-conversation-branches"></a>
## Conversation branches  · `py-conversation-branches`
*7 issues (2 High)*  

> **Verdict.** conversation_branches.py is a 1131-line god file that owns at least four unrelated concerns: branch-anchor validation, active-path persistence and retrieval, ForkOptionOut assembly (in two competing loading strategies), and branch-graph construction. The worst rot is the interplay between this file and conversations.py: the recursive subtree CTE is copied verbatim in both modules; the active-leaf resolution logic appears three times across both files; and two separately-maintained functions produce the same ForkOptionOut type with overlapping but divergent loading strategies. The optional pre-loaded messages parameters create hidden dual code paths inside three public functions. Together these issues mean the same state is derived and queried by multiple independent owners, in direct violation of the one-concern-one-owner rule.


#### 🔴 1. God file: conversation_branches.py mixes four unrelated concerns
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/conversation_branches.py:1-1132`  

**Problem.** The 1131-line file conflates (a) branch-anchor input validation (lines 40-174), (b) active-path persistence and retrieval as a viewer-specific cursor (lines 177-535), (c) ForkOptionOut assembly in two competing data-loading strategies (lines 659-977 and lines 1024-1077), and (d) branch-graph construction including the DFS visit algorithm (lines 759-838). Services §8 requires each service to own one capability end-to-end with a small semantic interface; this file owns at least four.

**Fix.** Split into three modules: (1) `branch_anchor.py` — pure validation helpers `branch_anchor_for_message` and `_validated_assistant_selection_anchor`, no DB access, no SQLAlchemy Session; (2) `active_path.py` — owns the `ConversationActivePath` table: `active_leaf_for_viewer`, `active_path_message_ids`, `persist_active_leaf`, `_persist_active_leaf`, and the corresponding read from `_active_leaf_for_viewer_from_loaded`; exposes a small public interface: `get_active_leaf(db, *, viewer_id, conversation_id) -> UUID | None` and `set_active_leaf(db, *, viewer_id, conversation_id, leaf_message_id) -> None`; (3) keep `conversation_branches.py` for branch CRUD and graph construction but eliminate the dual-loading strategies and the two ForkOptionOut constructors (see separate issues).

#### 🔴 2. Duplicate recursive subtree CTE: branch_subtree_message_ids vs _message_subtree_ids
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/conversation_branches.py:602-627` · `python/nexus/services/conversations.py:992-1010`  

**Problem.** `branch_subtree_message_ids` (conversation_branches.py:602-627) and `_message_subtree_ids` (conversations.py:992-1010) execute an identical recursive CTE (`WITH RECURSIVE subtree AS (SELECT id FROM messages ... UNION ALL SELECT child.id ...)`) with only the parameter name differing (`root_message_id` vs `message_id`). Two modules independently own the same tree-walk query against the same table. If the schema changes (e.g., conversation_id scoping tightened), both must be updated.

**Fix.** Move one canonical public function `message_subtree_ids(db, *, conversation_id, root_message_id) -> list[UUID]` into a shared low-level module (e.g., `nexus/db/queries.py` or `nexus/services/message_tree.py`). Both `delete_message` in conversations.py and `delete_branch` in conversation_branches.py call it. Delete whichever copy becomes unreachable.

#### 🟠 3. Duplicate fork-status decision logic: _fork_status_from_loaded vs _fork_status
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/services/conversation_branches.py:918-932` · `python/nexus/services/conversation_branches.py:1080-1097`  

**Problem.** `_fork_status_from_loaded` and `_fork_status` implement the same five-branch decision tree (None -> pending, run cancelled -> cancelled, message.status pending/error/complete -> same) with the only difference being how run status is obtained: one accepts a pre-loaded `Mapping[UUID, str]`, the other issues a bare DB scalar per call. The same logic is duplicated inline in both, so any change to the status precedence rules must be applied twice.

**Fix.** Keep one private function `_fork_status_from_status(assistant_message: Message | None, run_status: str | None) -> Literal[...]` that takes the already-resolved `run_status` as a plain string. Both call sites supply that value: the batch path does `run_status_by_assistant_id.get(assistant_message.id)`, the per-message path does a single DB scalar. Delete `_fork_status` and `_fork_status_from_loaded`; both callers call the unified helper.

#### 🟠 4. Active-leaf resolution logic duplicated across three sites
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/conversation_branches.py:496-518` · `python/nexus/services/conversation_branches.py:302-318` · `python/nexus/services/conversations.py:762-812`  

**Problem.** The rule 'look up the viewer's stored active leaf, validate it still exists in this conversation, fall back to the conversation's last message' is implemented three times: `active_leaf_for_viewer` (conversation_branches.py:496-518), `_active_leaf_for_viewer_from_loaded` (conversation_branches.py:302-318), and `_selected_path_message_rows` in conversations.py (lines 762-783). The last one is raw SQL doing the same join-validation inline. Any change to fall-back behavior (e.g., fall back to last user message rather than last message) requires three edits.

**Fix.** Establish a single `get_active_leaf_for_viewer(db, *, viewer_id, conversation_id, messages_by_id=None) -> UUID | None` in the future `active_path.py` module (see god-file issue). The `messages_by_id` parameter eliminates the re-query when the caller already holds the loaded messages. `_selected_path_message_rows` in conversations.py should call this shared function instead of reimplementing the lookup inline, which will also allow the raw SQL there to be replaced by ORM calls.

#### 🟠 5. Two competing ForkOptionOut constructors with N+1 loading in list_forks
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/services/conversation_branches.py:948-977` · `python/nexus/services/conversation_branches.py:1024-1077` · `python/nexus/services/conversation_branches.py:361-368`  

**Problem.** `_fork_option_from_loaded` (lines 948-977) and `_fork_option_for_user_message` (lines 1024-1077) both construct the same `ForkOptionOut` type, but `_fork_option_for_user_message` issues individual DB queries per branch (branch lookup, assistant message lookup, subtree CTE) which is called in a loop at lines 361-368 inside `list_forks` — a classic N+1. `rename_branch` similarly calls it for a single result but still executes three queries for that one record. The duplicated constructor also means two diverging paths for assembling the same output type.

**Fix.** Eliminate `_fork_option_for_user_message`. Refactor `list_forks` to use the bulk-loading path already implemented in `fork_options_by_parent` — load all messages for the conversation once, load all branches for those user messages once via `_branches_by_user_message_id`, compute subtree counts via `_subtree_metadata`, then construct all `ForkOptionOut` via `_fork_option_from_loaded`. `rename_branch` can likewise do a single reload of the affected branch's user message and call the shared assembler.

#### 🟠 6. Dual-loading optional parameter anti-pattern in three public functions
`Medium` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §5`  
**Where:** `python/nexus/services/conversation_branches.py:665` · `python/nexus/services/conversation_branches.py:729` · `python/nexus/services/conversation_branches.py:764`  

**Problem.** `fork_options_by_parent`, `build_path_cache_by_leaf_id`, and `build_branch_graph` each accept an optional pre-loaded messages collection (`messages: Sequence[Message] | None = None` or `messages_by_id: Mapping[UUID, Message] | None = None`). Each function then has an internal branch: if the caller supplied messages use them, otherwise load from DB. This doubles the effective code paths inside each function body, adds implicit coupling between callers (who must know to pass messages for efficiency), and makes the functions harder to test and reason about.

**Fix.** Remove the optional parameters. `get_conversation_tree` (the only caller that benefits from passing pre-loaded data) should load messages once and pass them to each helper as a required argument. Callers that need isolated use call `_conversation_messages` themselves before calling the helper. This makes data flow explicit and eliminates the hidden branch in each function.

#### 🟡 7. Rendering concern leaks into branch service via conversations.py imports
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/conversation_branches.py:31-36` · `python/nexus/services/conversation_branches.py:1100-1118`  

**Problem.** `conversation_branches.py` imports `conversation_to_out`, `message_to_out`, and `retryable_assistant_message_ids` from `conversations.py` (lines 31-36) and uses them in `_message_outs_by_id` (lines 1100-1118) and `get_conversation_tree` (line 274). This means the branch module — which should own branch-tree traversal state — also drives message serialization, which is conversations.py's concern. The circular dependency risk is low now but the coupling is unnecessary: `get_conversation_tree` returns `ConversationTreeOut` which contains `selected_path: list[MessageOut]`, forcing branches to call into the conversations rendering layer.

**Fix.** Move `_message_outs_by_id` and the call to `conversation_to_out` out of `get_conversation_tree` into a thin assembler in the route handler or a dedicated response-assembly helper that both concerns can call independently. Alternatively, have `get_conversation_tree` return a typed intermediate result containing raw `Message` objects and let the route handler (or a dedicated mapper) call `message_to_out` and `conversation_to_out`. This keeps branch logic free of rendering imports.


<a id="py-contributors"></a>
## Contributors service  · `py-contributors`
*8 issues (2 High)*  

> **Verdict.** The contributors service is a moderate god file (1107 lines) mixing three distinct concerns in one module: contributor identity management (CRUD, aliases, external IDs), contributor visibility/search (CTE-heavy read queries), and a full cross-domain tombstone-blocking scan that reaches directly into chat/AI tables (message_retrievals, message_tool_calls, chat_prompt_assemblies). The route handler is clean and thin. The schema file is healthy DTO-only with one exception: `contributor_credit_write_payload` is a write-path transform function that belongs in the credits service, not in DTOs. The worst rot is the AI-domain SQL embedded inside the contributor tombstone path — the `_persisted_contributor_ref_exists` and `_json_contains_contributor_ref_sql` cluster violates layers.md by reaching into tables owned by the retrieval/chat domain, and the 9-variant OR chain in `_json_contains_contributor_ref_sql` is a legacy-format accumulation that should be consolidated.


#### 🔴 1. Cross-domain AI table access inside tombstone check violates service boundaries
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/contributors.py:959-1073`  

**Problem.** `_persisted_contributor_ref_exists` (lines 959–1000) queries `message_retrievals`, `message_tool_calls`, and `chat_prompt_assemblies` directly from inside the contributors service. These tables are owned by the retrieval/chat domain (`retrieval_citation.py`, `chat_run_prompt_tracking.py`, `chat_run_message_blocks.py`). According to cleanliness.md §8, other modules must call only the public service/API of the owning service — never another module's tables. The contributors service has no business knowing about AI conversation ref formats.

**Fix.** Move the capability `contributor_is_referenced_in_chat_context(contributor_id, contributor_handle)` to the service that owns those tables (e.g., `retrieval_citation.py` or a new `chat_object_refs.py`). Expose it as one named query that returns a bool. The contributors service calls it with `(contributor.id, contributor.handle)` and interprets the result without knowing any internal ref formats. The 9-variant `_json_contains_contributor_ref_sql` and `_json_array_contains_contributor_ref_sql` helpers move with it.

#### 🔴 2. 9-variant OR chain in `_json_contains_contributor_ref_sql` is a legacy-format accumulation
`High` · `High-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §4`  
**Where:** `python/nexus/services/contributors.py:1013-1072`  

**Problem.** `_json_contains_contributor_ref_sql` matches 9 distinct JSON shapes for the same logical concept (a contributor reference). The shapes include `{type, id: uuid}`, `{type, id: handle}`, `{type, id: resource_ref}`, `{type, contributor_handle}`, `{type, handle}`, `{objectType, objectId}`, `{result_type, source_id: uuid/handle/resource_ref}`, and nested `context_ref` wrappers. This is exactly a migration-era multi-format fan-out kept alive by a silent fallback pattern. Each variant represents an old serialization format that should have been canonicalized when the schema was unified. Continuing to accumulate formats here makes the predicate increasingly expensive and untestable.

**Fix.** Audit which ref formats are still actively written to these columns in new rows. Drop the formats that are no longer emitted. Define a canonical `ContributorRef` JSON schema and migrate or drop legacy rows. Until migration is complete, the predicate logic belongs in the AI/retrieval service (see previous finding) and should be documented with which source produces each format, so dead ones can be pruned as confirmed.

#### 🟠 3. `contributor_credit_write_payload` transform function misplaced in DTO schema module
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/schemas/contributors.py:158-177` · `python/nexus/schemas/podcast.py:41`  

**Problem.** `contributor_credit_write_payload` is a write-path filter function living in the DTO schema module (`schemas/contributors.py`). Schema modules should only hold data shapes (Pydantic models and Literals), not business-logic transforms. The function strips fields from a raw dict before passing it to the credit write layer, which is a service-layer concern belonging to `contributor_credits.py`.

**Fix.** Move `contributor_credit_write_payload` to `contributor_credits.py` where the write path lives. Update the one caller in `schemas/podcast.py` to import it from the service module. The schema module becomes a pure DTO file.

#### 🟠 4. Duplicated `CONTRIBUTOR_ROLES` / `CONTRIBUTOR_RESOLUTION_STATUSES` sets mirror Literal types in schema
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`  
**Where:** `python/nexus/services/contributor_credits.py:23-42` · `python/nexus/schemas/contributors.py:20-39`  

**Problem.** `CONTRIBUTOR_ROLES` (set, 12 members) and `CONTRIBUTOR_RESOLUTION_STATUSES` (set, 4 members) in `contributor_credits.py` duplicate the information already expressed by `ContributorRole` (Literal, 12 members) and `ContributorResolutionStatus` (Literal, 4 members) in `schemas/contributors.py`. Any time a role or status is added it must be updated in two places. The normalize functions use the set for membership testing, which duplicates the type's information.

**Fix.** Derive the runtime sets from the Literal types using `typing.get_args(ContributorRole)` and `typing.get_args(ContributorResolutionStatus)` at module load time, or inline the membership test against the schema's `__args__`. Delete the hand-maintained sets. This eliminates the dual-maintenance surface.

#### 🟠 5. Three near-identical `_load_visible_contributor_by_*` loaders with duplicated CTE expansion
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/contributors.py:699-722` · `python/nexus/services/contributors.py:725-750` · `python/nexus/services/contributors.py:753-804`  

**Problem.** `_load_visible_contributor_by_handle` (lines 699–722) and `_load_visible_contributor_by_id` (lines 725–750) both expand `_visible_contributor_ctes_sql()` and execute a query that differs only by the WHERE predicate (`c.handle = :contributor_handle` vs `c.id = :contributor_id`). The result in both cases is the contributor's UUID, then a second `db.get` call to load the ORM object. The pattern is repeated identically: build the CTE, SELECT c.id, raise NotFoundError if None, db.get, raise NotFoundError if None. This is the same state machine written twice with different bind params.

**Fix.** Collapse to one private helper `_load_visible_contributor(db, viewer_id, *, handle=None, contributor_id=None)` that builds the predicate based on which key is provided, or split into two thin one-liners that share a common `_visible_contributor_id_query(db, viewer_id, predicate_sql, params)` executor that runs the CTE and returns the UUID or raises NotFoundError.

#### 🟡 6. ACTIVE_STATUSES constant defined once in contributors.py but the same pair is hardcoded 10+ times in contributor_credits.py SQL strings
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/contributors.py:42` · `python/nexus/services/contributor_credits.py:236` · `python/nexus/services/contributor_credits.py:275` · `python/nexus/services/contributor_credits.py:341` · `python/nexus/services/contributor_credits.py:593` · `python/nexus/services/contributor_credits.py:703` · `python/nexus/services/contributor_credits.py:721` · `python/nexus/services/contributor_credits.py:774` · `python/nexus/services/contributor_credits.py:882` · `python/nexus/services/contributor_credits.py:898`  

**Problem.** The pair `('unverified', 'verified')` meaning "active contributor statuses" is the single most repeated value across both contributor service files — appearing once as a named constant `ACTIVE_STATUSES` in `contributors.py` and 9 times as a literal SQL string in `contributor_credits.py`. If a new active status is ever introduced, all 9 SQL string sites must be found and updated manually.

**Fix.** Move `ACTIVE_STATUSES` to a shared location accessible to both modules (e.g., the schema module as a module-level constant derived from the Literal, or a small `contributor_constants.py`). Substitute it into the SQL strings in `contributor_credits.py` using parameterization where possible, or at minimum via a single string constant that feeds all sites.

#### 🟡 7. `get_contributor_by_handle` has split visibility logic with two code paths
`Low` · `Medium-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §6`  
**Where:** `python/nexus/services/contributors.py:46-56`  

**Problem.** `get_contributor_by_handle` branches on `viewer_id is not None` to call either `_load_visible_contributor_by_handle` (viewer-filtered CTE) or `_load_active_contributor_by_handle` (no visibility filter). The second path (no viewer) is called only from `split_contributor` and `tombstone_contributor`, which are curator-only admin operations. The public-facing route handler always supplies a viewer. This dual-path complicates the visibility model: one path enforces the contributor-visibility CTE and the other silently bypasses it.

**Fix.** Remove `viewer_id: UUID | None = None` from the public signature. Admin operations (`split_contributor`, `tombstone_contributor`) that need the unrestricted load should call `_load_active_contributor_by_handle` directly (they already do). The public `get_contributor_by_handle` becomes a single-path function that always enforces visibility. This makes illegal states (unauthenticated contributor fetch) unrepresentable.

#### 🟡 8. `list_contributor_works` uses multiple positional parameters at a service boundary
`Low` · `Medium-confidence` · `Other` · rules: `function-parameters.md`, `cleanliness.md §8`  
**Where:** `python/nexus/services/contributors.py:59-68`  

**Problem.** The public function `list_contributor_works(db, viewer_id, contributor_handle, *, role, content_kind, q, limit)` accepts `viewer_id` and `contributor_handle` as positional parameters while the remaining four are keyword-only. Per function-parameters.md and cleanliness.md §8, service boundaries should use a single named-parameter object to avoid callers needing to remember argument order and to allow extension without breaking callers.

**Fix.** Make `viewer_id` keyword-only (add `*` before it, or keep only `db` as positional). Ideally introduce a `ListContributorWorksQuery` dataclass or keyword-only signature `(db, *, viewer_id, contributor_handle, role, content_kind, q, limit)` consistent with the pattern used in other services.


<a id="py-contributor-credits"></a>
## Contributor credits  · `py-contributor-credits`
*8 issues (2 High)*  

> **Verdict.** contributor_credits.py (943 lines) is a god file that conflates three distinct capabilities: (1) credit write/replace operations for multiple entity types, (2) credit batch reads for hydrating API responses, and (3) contributor identity resolution and creation — including race-condition handling, external-ID attachment, alias confirmation, and handle generation. The contributor identity sub-pipeline (lines 570–927) belongs in contributors.py, which already owns contributor reads, mutations, and identity curation; it imports normalize_contributor_name, normalize_contributor_role, unique_contributor_handle_for_name, and CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES from contributor_credits.py, inverting the correct ownership. Additional rot: two parallel constants for the same "curated source" set, raw dict[str, Any] payloads with dual camelCase/snake_case key lookups leaking transport shapes deep into service internals, a duplicated INSERT INTO contributor_external_ids SQL block, a duplicated COUNT(*) post-delete verification with no transactional value, and a local _integrity_constraint_name wrapper that adds a string-scan fallback on top of the already-adequate db.errors helper.


#### 🔴 1. Split contributor identity resolution out of contributor_credits.py into contributors.py
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/contributor_credits.py:570-927` · `python/nexus/services/contributors.py:35-40`  

**Problem.** contributor_credits.py contains the entire contributor identity resolution and creation sub-pipeline: _resolve_or_create_contributor (lines 570-687), _resolve_explicit_contributor (690-726), _extract_external_id (729-758), _resolve_confirmed_alias (761-785), _create_unverified_contributor (788-847), unique_contributor_handle_for_name (850-860), _handle_for_name (863-866), _select_contributor_by_external_id (869-888), _select_contributor_by_handle (891-903), _is_contributor_identity_race/_is_contributor_handle_conflict/_is_contributor_external_id_conflict/_integrity_constraint_name (906-927). This is the contributor entity lifecycle — creation, alias lookup, external ID attachment, race-condition handling — which is already the stated responsibility of contributors.py. In fact, contributors.py already imports normalize_contributor_name, normalize_contributor_role, unique_contributor_handle_for_name, and CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES from contributor_credits.py, reversing the correct dependency direction. contributors.py is the owner of contributor entity state; contributor_credits.py should only call a public create-or-resolve function from the correct owner.

**Fix.** Move the entire identity resolution sub-pipeline (lines 570-927) into contributors.py. Expose one public function — e.g. resolve_or_create_contributor(db, credited_name, credit_dict) -> tuple[UUID, str] — or, better, replace the raw dict parameter with a typed dataclass (see Types issue below) so the internal helpers disappear as separate public symbols. contributor_credits.py should call contributors.resolve_or_create_contributor(...) at its one call site (_insert_credits line 489). This eliminates the import inversion: contributors.py will no longer import from contributor_credits.py; contributor_credits.py will import the single resolve function from contributors.py.

#### 🔴 2. Replace raw dict[str, Any] credit parameter with a typed dataclass at service boundaries
`High` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/contributor_credits.py:87-94` · `python/nexus/services/contributor_credits.py:188-195` · `python/nexus/services/contributor_credits.py:198-205` · `python/nexus/services/contributor_credits.py:362-365` · `python/nexus/services/contributor_credits.py:446-453` · `python/nexus/services/contributor_credits.py:457` · `python/nexus/services/contributor_credits.py:561` · `python/nexus/services/contributor_credits.py:691` · `python/nexus/services/contributor_credits.py:711` · `python/nexus/services/contributor_credits.py:729-738`  

**Problem.** All public write functions accept credits: list[dict[str, Any]], and every internal helper that operates on a credit dict must perform dual camelCase/snake_case lookups (credit.get("contributor_id") or credit.get("contributorId"); credit.get("source_ref") or credit.get("sourceRef"); credit.get("external_id") or credit.get("externalId"); credit.get("external_ids") or credit.get("externalIds"); credit.get("contributor_handle") or credit.get("contributorHandle")). This means raw transport shapes (both wire forms) propagate unchecked from callers all the way through _insert_credits, _resolve_or_create_contributor, _resolve_explicit_contributor, _extract_external_id, and _create_unverified_contributor. The schema already defines ContributorCreditIn (schemas/contributors.py:132-155) for validated inbound credits; the service is bypassing it.

**Fix.** Parse credits at each public entry point using ContributorCreditIn (or a purpose-built dataclass for write payloads). Pass the parsed typed object inward. All internal helpers receive the typed form; dual-key lookups disappear. _extract_external_id and _resolve_explicit_contributor become simple attribute accesses. This also eliminates the camelCase fallbacks in _source_ref (line 561) and _extract_external_id (lines 731-738).

#### 🟠 3. Collapse CONFIRMED_ALIAS_SOURCES and PRESERVED_MEDIA_AUTHOR_CREDIT_SOURCES — two constants with identical values
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/contributor_credits.py:55` · `python/nexus/services/contributor_credits.py:56`  

**Problem.** CONFIRMED_ALIAS_SOURCES = {"manual", "curated", "user"} (line 55) and PRESERVED_MEDIA_AUTHOR_CREDIT_SOURCES = frozenset({"manual", "curated", "user"}) (line 56) contain exactly the same three strings. They differ only in type (set vs frozenset) and are used independently in alias confirmation (lines 349, 782) vs machine-derived credit deletion (lines 113, 157, 174). Having two constants for the same semantic set means any future addition to "curated sources" must be applied in two places. The semantic intent — 'sources that are human/curator-authored' — is identical; the divergence in usage context does not justify two distinct names for the same value.

**Fix.** Define one frozenset constant, e.g. CURATED_CREDIT_SOURCES = frozenset({"manual", "curated", "user"}), and use it in all four locations. The alias-confirmation queries can pass it directly; the machine-derived deletion guard uses it as PRESERVED_MEDIA_AUTHOR_CREDIT_SOURCES was used. Delete the duplicate.

#### 🟠 4. Duplicated INSERT INTO contributor_external_ids SQL block in race-condition fallback path
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/contributor_credits.py:605-631` · `python/nexus/services/contributor_credits.py:646-673`  

**Problem.** The INSERT INTO contributor_external_ids statement appears twice within _resolve_or_create_contributor: once in the optimistic path (lines 605-631) and once in the race-condition fallback path (lines 646-673). The SQL text, bound parameters, and dict shape are identical. The only difference between the two calls is the value of contributor_id (the newly created contributor vs the one found by handle after the handle conflict).

**Fix.** Extract a private helper _attach_external_id(db, contributor_id, authority, external_key, external_url, source) -> None that executes the INSERT. Call it from both sites. This removes ~25 lines of identical SQL.

#### 🟠 5. normalize_contributor_role, normalize_contributor_name, unique_contributor_handle_for_name, and CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES are domain utilities whose ownership is split across files
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `python/nexus/services/contributor_credits.py:23-84` · `python/nexus/services/contributors.py:35-40` · `python/nexus/services/search.py:71` · `python/nexus/services/agent_tools/app_search.py:35`  

**Problem.** normalize_contributor_role, normalize_contributor_name, display_contributor_name, unique_contributor_handle_for_name, and CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES are all contributor-entity domain logic, not credit-write logic. They are defined in contributor_credits.py but are imported by contributors.py, services/search.py, and services/agent_tools/app_search.py. These callers are consuming contributor-domain utilities from a module whose stated purpose is 'contributor-credit normalization, writes, and batch reads'. When the contributor identity resolution sub-pipeline is moved to contributors.py (see first issue), these symbols move with it naturally. As long as they remain in contributor_credits.py, every new consumer of contributor-entity logic must reach across into the credits module.

**Fix.** As part of the god-file split, relocate CONTRIBUTOR_ROLES, CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES, normalize_contributor_role, normalize_contributor_name, display_contributor_name, and unique_contributor_handle_for_name to contributors.py (or a contributors_util.py pure-helper module if contributors.py becomes too large). contributor_credits.py then imports what it needs from there, reversing the current inversion.

#### 🟡 6. Post-delete verification SELECT COUNT(*) adds no safety in the same transaction
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §7`  
**Where:** `python/nexus/services/contributor_credits.py:402-413`  

**Problem.** After DELETE FROM contributor_credits WHERE id = ANY(:existing_ids) (line 393-401), the code immediately issues SELECT count(*) FROM contributor_credits WHERE id = ANY(:existing_ids) (line 402-411) and raises RuntimeError if the count is not zero. Within the same SQLAlchemy Session/transaction, the SELECT will always see the DELETE's effect (PostgreSQL read-your-writes). This count check can never detect a real failure: if the DELETE silently missed rows, the subsequent SELECT would still return zero because the deleted rows are gone from the transaction's view. The check also imposes an extra round-trip on every replace operation.

**Fix.** Delete lines 402-413. If transactional deletion correctness is a concern, the check is not an effective guard anyway; rely on the DB constraint (unique IDs) and PostgreSQL's DELETE guarantees.

#### 🟡 7. str(credit.get('source') or 'local') default fallback duplicated three times inside _resolve_or_create_contributor and _create_unverified_contributor
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/services/contributor_credits.py:629` · `python/nexus/services/contributor_credits.py:671` · `python/nexus/services/contributor_credits.py:837`  

**Problem.** The expression str(credit.get("source") or "local") appears identically on lines 629, 671, and 837, all within the contributor creation / external-ID attachment flow. _normalize_credit_source already encapsulates this logic (line 556-557) but is not used at these three sites.

**Fix.** Replace lines 629, 671, and 837 with _normalize_credit_source(credit.get("source")). If the typed-credit refactor (Types issue) is done first, all three disappear automatically since the credit source would already be normalized at the boundary.

#### 🟡 8. Local _integrity_constraint_name wrapper extends db.errors.integrity_constraint_name with string-scan fallback that is its own dead branch
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §3`  
**Where:** `python/nexus/services/contributor_credits.py:918-927`  

**Problem.** _integrity_constraint_name (lines 918-927) wraps the canonical integrity_constraint_name from db.errors, then adds a string-scan fallback that parses constraint names from the exception message text. The docstring on integrity_constraint_name (db/errors.py:8-14) explicitly notes 'Callers that must also recognise a constraint from the error text... keep that fallback at their own call site.' The fallback was presumably added because an older psycopg version or driver did not populate diag.constraint_name reliably. If the driver now consistently populates diag (as the module doc implies psycopg does), the string-scan branches are dead. Even if they are still reachable, the wrapper is a one-use indirection that merely adds a local name for a module-level import plus two string checks.

**Fix.** If psycopg reliably populates diag.constraint_name (verify with the driver version in use), delete the string-scan fallback and inline calls to integrity_constraint_name directly at the three call sites, eliminating the wrapper. If the fallback must remain, move it into db/errors.py as part of integrity_constraint_name so all callers benefit, and delete the local wrapper.


<a id="py-browse"></a>
## Browse / discovery  · `py-browse`
*8 issues (3 High)*  

> **Verdict.** browse.py (865 lines) is a god file: it owns the YouTube Data API HTTP transport layer (retry loop, credential wiring, response parsing), Gutenberg catalog search query (which duplicates ownership with gutenberg.py), cursor encode/decode, and four independent browse section pipelines. The worst rot is the embedded YouTube provider — a full retry-with-backoff HTTP client duplicated structurally from podcasts/provider.py — living inside a service that also owns domain orchestration and response shaping. url_normalize.py contains a seam kept only for tests (_is_test_environment that reads os.environ directly rather than via Settings), and the route handler re-states the BrowseSectionType literal rather than importing it.


#### 🔴 1. Extract YouTube Data API HTTP client out of browse.py into its own provider module
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/browse.py:782-836 (_get_json with retry/backoff loop)` · `python/nexus/services/browse.py:587-644 (_search_video_rows with credential check, param building, response parsing)` · `python/nexus/services/browse.py:38-41 (_BROWSE_PROVIDER_MAX_ATTEMPTS, _BROWSE_PROVIDER_RETRYABLE_STATUS_CODES, _BROWSE_PROVIDER_BACKOFF_SECONDS, _BROWSE_PROVIDER_TIMEOUT)`  

**Problem.** browse.py contains a full YouTube Data API HTTP adapter: credential guard, request parameter construction, a retry-with-exponential-backoff loop, and JSON response parsing. This is transport-layer logic living inside a domain service. The `_get_json` helper and its constants (_BROWSE_PROVIDER_MAX_ATTEMPTS, _BROWSE_PROVIDER_BACKOFF_SECONDS, _BROWSE_PROVIDER_RETRYABLE_STATUS_CODES, _BROWSE_PROVIDER_TIMEOUT) are a structurally near-identical copy of PodcastIndexClient._get_json in python/nexus/services/podcasts/provider.py:73-138. Per cleanliness §8, edge adapters must translate/invoke but must not mix with business logic; per §5, a file mixing routing, transport parsing, and business logic must be split.

**Fix.** Create python/nexus/services/youtube_data_provider.py (or youtube_data/provider.py) modelled after podcasts/provider.py. It should own: the YouTubeDataClient class with _get_json retry logic (consolidating _BROWSE_PROVIDER_* constants into YOUTUBE_DATA_PROVIDER_* equivalents), credential wiring from settings, and search_videos(query, limit, page_token) -> (list[VideoResult], next_page_token | None) returning typed output, not raw dicts. browse.py's _search_video_rows and _attach_existing_video_contributors become thin callers of this client. The retry loop in browse.py is then deleted and the duplicated constants removed.

#### 🔴 2. Move _search_project_gutenberg_rows out of browse.py into gutenberg.py to unify Gutenberg ownership
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/services/browse.py:459-584 (_search_project_gutenberg_rows)` · `python/nexus/services/gutenberg.py:1-197`  

**Problem.** gutenberg.py is the declared owner of all Project Gutenberg catalog logic (download, parse, sync), yet the query that reads from the project_gutenberg_catalog table for browse search lives in browse.py. The 125-line _search_project_gutenberg_rows function reaches directly into project_gutenberg_catalog and contributor_credits tables and builds a JOIN that duplicates schema knowledge already owned by gutenberg.py. Two modules can now independently evolve queries against the same table, violating the one-concern-one-owner rule. The browse tests even patch browse_service._search_project_gutenberg_rows directly (test_browse.py:247), which is a production seam kept for testing.

**Fix.** Add a search_catalog(db, query, *, limit, offset) -> list[GutenbergSearchResult] function to gutenberg.py, where GutenbergSearchResult is a typed dataclass or Pydantic model (not dict[str, object]). Move the SQL query and result-shaping into that function. browse.py calls gutenberg.search_catalog and maps the typed result to its own response shape. The test patch target then moves to gutenberg.search_catalog, eliminating the private seam on browse.py internals.

#### 🔴 3. Duplicate retry-with-backoff HTTP client loop: browse.py _get_json vs podcasts/provider.py _get_json
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/browse.py:782-836` · `python/nexus/services/podcasts/provider.py:73-138`  

**Problem.** Both functions implement the same retry-with-backoff pattern: iterate up to MAX_ATTEMPTS, catch HTTPStatusError and check against a set of RETRYABLE_STATUS_CODES, sleep BACKOFF_SECONDS[attempt_index], catch TimeoutException/NetworkError and retry, catch HTTPError/ValueError/ApiError and break, raise ApiError on exhaustion. The podcast version additionally handles Retry-After headers (a more correct implementation) while the browse version silently ignores them. Two independent implementations of the same mechanism will drift and one is already less correct.

**Fix.** If the YouTube provider is extracted (see above), both providers can share a common _get_json_with_retry(url, *, headers, params, max_attempts, retryable_codes, backoff_seconds, provider_name) in a shared http_client utility, or each provider encapsulates its own retry via a base class. The browse version's missing Retry-After handling is a correctness gap that should be fixed in the consolidated version.

#### 🟠 4. Duplicate YouTube watch URL construction: browse.py vs youtube_identity.py
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `python/nexus/services/browse.py:44 (_YOUTUBE_WATCH_URL template) and :636` · `python/nexus/services/youtube_identity.py:40 (watch_url = f'https://www.youtube.com/watch?v={provider_video_id}')`  

**Problem.** youtube_identity.py is the canonical owner of YouTube URL construction (it also exposes classify_youtube_provider_video_id that returns a YouTubeIdentity with watch_url). browse.py defines a separate _YOUTUBE_WATCH_URL constant and builds watch_url independently, bypassing the existing owner. This creates two sources of truth for the same URL format.

**Fix.** In browse.py's _search_video_rows (or the new YouTubeDataClient), call classify_youtube_provider_video_id(video_id) from youtube_identity.py to produce watch_url. The _YOUTUBE_WATCH_URL constant in browse.py is then deleted. The YouTubeIdentity.watch_url field becomes the single source of truth.

#### 🟠 5. _is_test_environment in url_normalize.py bypasses Settings and is a legacy env-check seam
`Medium` · `High-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §7`, `layers.md`  
**Where:** `python/nexus/services/url_normalize.py:53-58 (_is_test_environment)` · `python/nexus/services/url_normalize.py:84-97 (_is_blocked_hostname, test-env branch)`  

**Problem.** url_normalize.py reads os.environ directly with os.environ.get('NEXUS_ENV') instead of going through the Settings object, which already exposes settings.nexus_env as an Environment enum (config.py:78). This duplicates environment resolution. More critically, the test-allowlist for localhost/127.0.0.1 is a production seam kept only for test fixture servers — it makes the validation function's behavior depend on a runtime environment variable rather than being a pure function. Per cleanliness §3 this is the kind of hidden compat branch that must be removed; per §8 test-only injection points should not exist in production code.

**Fix.** Remove _is_test_environment() and the os import. Change validate_requested_url to accept an optional allow_local: bool = False parameter (or an explicit set of allowed_hostnames), so callers (tests) pass the allowlist explicitly. The function is then a pure validator. Test fixtures that need to pass localhost URLs call validate_requested_url(url, allow_local=True). The environment check disappears from production code.

#### 🟠 6. All browse section result shapes use untyped dict[str, object] at every layer boundary
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §8`  
**Where:** `python/nexus/services/browse.py:55 (browse_content return type)` · `python/nexus/services/browse.py:113 (_browse_section return type)` · `python/nexus/services/browse.py:357-456 (_search_nexus_document_rows returns list[dict[str, object]])` · `python/nexus/services/browse.py:465-584 (_search_project_gutenberg_rows returns list[dict[str, object]])` · `python/nexus/services/browse.py:592-644 (_search_video_rows returns tuple[list[dict[str, object]], str | None])` · `python/nexus/services/browse.py:698-729 (_to_podcast_result, _to_podcast_episode_result return dict[str, object])`  

**Problem.** Every internal function in browse.py passes results as dict[str, object], losing all type information at section boundaries. Fields like media_id, provider_video_id, watch_url, etc. are accessed with dict.get() and require defensive _string_or_none coercions throughout. Illegal states (missing required fields, wrong field types) cannot be caught statically. Per cleanliness §9, illegal states should be unrepresentable; the downstream guards (isinstance checks, _string_or_none calls) that exist only because the dict type is too wide should be eliminated.

**Fix.** Define typed dataclasses or Pydantic models: NexusDocumentResult, GutenbergDocumentResult, VideoResult, PodcastResult, PodcastEpisodeResult. Each internal search function returns its typed list. The _to_podcast_result and _to_podcast_episode_result converters become typed transformations. _string_or_none and isinstance guards inside mapping functions are then unnecessary and can be removed. The public browse_content return can remain dict for the JSON boundary but internal pipeline functions should be fully typed.

#### 🟠 7. Tests patch private internals of browse.py (_search_nexus_document_rows, _search_project_gutenberg_rows, _search_video_rows)
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`  
**Where:** `python/tests/test_browse.py:244 (monkeypatch.setattr browse_service, '_search_nexus_document_rows')` · `python/tests/test_browse.py:247 (monkeypatch.setattr browse_service, '_search_project_gutenberg_rows')` · `python/tests/test_browse.py:250 (monkeypatch.setattr browse_service, '_search_video_rows')`  

**Problem.** Test code patches private functions (_search_nexus_document_rows, _search_project_gutenberg_rows, _search_video_rows) inside browse.py to inject fake data. Per cleanliness §11, tests must not mock internal modules and inspect wiring; production seams kept only for tests should be removed. These patches exist because the provider integrations (YouTube Data API, Gutenberg SQL) are embedded in browse.py rather than behind injectable boundaries.

**Fix.** Once YouTube search and Gutenberg catalog search are extracted to provider/service objects (see earlier findings), tests inject fakes at the provider object level or pass a stub through a parameter. The monkeypatching of private browse.py internals is then replaced by behavior tests against the route endpoint with real DB state for Gutenberg/Nexus results and a stub provider for YouTube.

#### 🟡 8. Route handler re-declares BrowseSectionType literal instead of importing from browse service
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/api/routes/browse.py:22-25` · `python/nexus/services/browse.py:28-35 (BrowseSectionType, BROWSE_SECTION_TYPES)`  

**Problem.** The route handler duplicates the Literal['documents', 'videos', 'podcasts', 'podcast_episodes'] type inline rather than importing BrowseSectionType from the browse service. If a new section type is added, two sites must be updated in sync.

**Fix.** Import BrowseSectionType from nexus.services.browse and use it as the type annotation for the page_type query parameter. The inline Literal in the route is then deleted.


<a id="py-highlights-reader"></a>
## Highlights & reader (backend)  · `py-highlights-reader`
*9 issues (2 High)*  

> **Verdict.** The highlights slice is mostly well-decomposed — the PDF geometry, quote-match, locking, and readiness concerns are in clean separate modules. The biggest rot is a triply-duplicated fragment-highlight write primitive (fragment row locking + span-conflict detection + offset validation/derivation) that lives independently in highlights.py AND vault.py instead of one canonical owner. There is also a clear ownership-layer violation: highlights.py's update_highlight contains an inline PDF color-only update path that belongs entirely in pdf_highlights.py, held together by a deferred import that signals the circular tension. The highlights route handler additionally contains three near-identical copies of mine_only query-param parsing that belong as a single typed FastAPI Query parameter. The module docs for highlight.md and pdf.md are empty (1 line each), which is a stale-doc/missing-contract gap.


#### 🔴 1. Duplicate fragment-highlight write primitives across highlights.py and vault.py
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/highlights.py:66-73 (_lock_fragment_row_for_highlight_write_or_404)` · `python/nexus/services/highlights.py:376-399 (_fragment_highlight_span_conflict_exists)` · `python/nexus/services/highlights.py:82-91 (validate_offsets_or_400)` · `python/nexus/services/highlights.py:94-106 (derive_exact_prefix_suffix)` · `python/nexus/services/vault.py:357-364 (_lock_fragment_row_for_highlight_write)` · `python/nexus/services/vault.py:366-391 (_fragment_highlight_span_conflict_exists)` · `python/nexus/services/vault.py:37-40 (imports validate_offsets_or_400, derive_exact_prefix_suffix, map_integrity_error)`  

**Problem.** Four fragment-highlight write primitives — fragment row locking, span conflict detection, offset validation, and exact/prefix/suffix derivation — exist in two independent copies. highlights.py defines the canonical versions; vault.py reimplements _lock_fragment_row_for_highlight_write (same semantics, different SQL form) and _fragment_highlight_span_conflict_exists (structurally identical query), while importing the other three directly from highlights.py. The duplicated locking and conflict detection could diverge silently, creating invisible inconsistency in how vault writes serialize and deduplicate highlights.

**Fix.** Extract a private module `python/nexus/services/highlight_fragment_write.py` (or a private subpackage) that owns: (1) fragment row locking with FOR UPDATE, (2) span conflict detection, (3) offset validation, (4) exact/prefix/suffix derivation, (5) integrity error mapping. Both highlights.py and vault.py import only from this single canonical owner. The module has no route or HTTP imports — pure domain + SQLAlchemy. vault.py drops its reimplemented copies.

#### 🔴 2. highlights.py owns a PDF color-only update path that belongs in pdf_highlights.py
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/highlights.py:615-665 (update_highlight, PDF color-only branch lines 652-665)` · `python/nexus/services/highlights.py:638 (deferred import of update_pdf_highlight_bounds)`  

**Problem.** update_highlight in highlights.py is split into three phases that span two modules. The PDF geometry update path is delegated via a deferred local import (line 638) to pdf_highlights.update_pdf_highlight_bounds. But the PDF color-only update (lines 652-665) is implemented inline in highlights.py, writing to the Highlight row and calling _require_media_ready_for_highlight. This means pdf_highlights.py does not own the full PDF highlight mutation lifecycle — highlights.py holds a PDF-specific write path that the deferred import signals is unwanted there. The deferred import is a code smell that reveals the circular pressure: highlights.py must know about pdf_highlights, and pdf_highlights already imports project_highlight and require_media_ready_or_409 from highlights.

**Fix.** Move the PDF color-only update path into pdf_highlights.py as an `update_pdf_highlight_color(db, viewer_id, highlight, new_color) -> TypedHighlightOut` function. update_highlight in highlights.py becomes a pure dispatcher: validate anchor-kind mismatch, then call pdf_highlights.update_pdf_highlight_bounds or pdf_highlights.update_pdf_highlight_color for PDFs, and handle the fragment path inline. Convert the deferred import to a top-level import. pdf_highlights.py owns all PDF highlight writes end-to-end.

#### 🟠 3. Three near-identical mine_only query-param parse blocks in route handler
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/api/routes/highlights.py:53-59 (list_highlights handler)` · `python/nexus/api/routes/highlights.py:78-84 (list_media_highlights handler)` · `python/nexus/api/routes/highlights.py:137-140 (list_pdf_highlights handler)`  

**Problem.** The same mine_only boolean query-parameter parsing pattern — read raw string, validate against ('true','false'), raise ApiError if invalid, compare to 'true' — is copy-pasted verbatim in three separate route handlers. Other route files in the codebase (notes.py, libraries.py, media.py) use FastAPI's typed Query() parameter injection, which eliminates this entire parse+validate block and is the established pattern.

**Fix.** Replace all three mine_only parse blocks with a single FastAPI Query parameter: `mine_only: Annotated[bool, Query()] = True`. FastAPI handles string-to-bool coercion and will produce a 422 on invalid input automatically. Remove the raw Request import from the three affected handlers.

#### 🟠 4. Deferred local imports of pdf_highlights in both highlights.py and highlights route handler
`Medium` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §6`  
**Where:** `python/nexus/services/highlights.py:638 (from nexus.services.pdf_highlights import update_pdf_highlight_bounds)` · `python/nexus/api/routes/highlights.py:108 (from nexus.services.pdf_highlights import create_pdf_highlight as svc_create)` · `python/nexus/api/routes/highlights.py:127 (from nexus.services.pdf_highlights import list_pdf_highlights as svc_list)`  

**Problem.** Three deferred (inside-function) imports are used in highlights.py and the highlights route handler. Deferred imports are a smell indicating either a circular import that was papared over at a cost, or an import that simply was not moved to the module top. The route handler case (lines 108, 127) is straightforward: there is no circular import reason — the functions are in a separate service module and the route handler already imports from nexus.services.pdf_highlights is not done at top level. The highlights.py case (line 638) points to the deeper PDF color-only ownership issue described above.

**Fix.** After resolving the ownership issue (move PDF color-only path to pdf_highlights), convert all three deferred imports to top-level imports. The route handler should import create_pdf_highlight and list_pdf_highlights from nexus.services.pdf_highlights at module top like other service imports.

#### 🟠 5. highlights.py leaks fragment-text helpers (validate_offsets_or_400, derive_exact_prefix_suffix, map_integrity_error) as public cross-module API used by vault.py
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `python/nexus/services/highlights.py:82-133 (validate_offsets_or_400, derive_exact_prefix_suffix, map_integrity_error — public functions with no leading underscore)` · `python/nexus/services/vault.py:37-40 (imports these three symbols from highlights)`  

**Problem.** validate_offsets_or_400, derive_exact_prefix_suffix, and map_integrity_error are utility helpers for the fragment-highlight write protocol. They are defined in highlights.py but consumed by vault.py, which is a separate service. This means highlights.py's public surface includes domain-internal helpers that belong to a shared write primitive, not to the highlight service's public API. vault.py is importing private helpers from another module's internals (cleanliness §6 violation). If highlights.py is refactored, vault.py breaks silently.

**Fix.** Move these three helpers into the shared `highlight_fragment_write.py` module (recommended in finding #1). Both highlights.py and vault.py import them from that canonical owner. highlights.py's public surface shrinks to named commands and queries only (create_highlight_for_fragment, list_highlights_for_fragment, list_highlights_for_media, get_highlight, update_highlight, delete_highlight) and the projection functions used by pdf_highlights.

#### 🟡 6. Duplicate TypeAdapter(ReaderResumeState) instantiation in reader.py and media.py route handler
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/services/reader.py:23 (READER_RESUME_STATE_ADAPTER = TypeAdapter(ReaderResumeState))` · `python/nexus/api/routes/media.py:60 (_READER_RESUME_STATE_ADAPTER = TypeAdapter(ReaderResumeState))`  

**Problem.** TypeAdapter(ReaderResumeState) is constructed independently in both reader.py (as a module-level constant) and in the media.py route handler (as a module-level private). The media route handler uses its own adapter for parsing the raw PUT body (_reader_resume_state_body, lines 63-83) rather than delegating validation to the reader service. This means the transport-layer deserialization for reader resume state is owned by the route handler rather than the service.

**Fix.** The reader service should expose a single parse function, e.g., `parse_reader_resume_state(payload: object) -> ReaderResumeState | None`, that wraps READER_RESUME_STATE_ADAPTER.validate_python with appropriate error mapping. The media route handler drops _READER_RESUME_STATE_ADAPTER and delegates to the service's parse function. The route handler retains only the JSON decode step (transport-layer parsing) before calling the service.

#### 🟡 7. _compute_write_time_match returns an untyped dict; MatchResult and PendingWriteOutcome fields are re-keyed inconsistently
`Low` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §7`  
**Where:** `python/nexus/services/pdf_highlights.py:100-172 (_compute_write_time_match returns dict)` · `python/nexus/services/pdf_highlights.py:164-171 (re-keys MatchResult fields via match_result_to_persistence_fields then renames again)` · `python/nexus/services/pdf_quote_match_policy.py:37-58 (PendingWriteOutcome mirrors MatchResult structure)`  

**Problem.** _compute_write_time_match returns `-> dict` with keys match_status, match_version, start_offset, end_offset, prefix, suffix. This is an untyped intermediary. The function also performs a redundant key rename: it calls match_result_to_persistence_fields(result) which renames result.status -> plain_text_match_status etc., then immediately re-renames those keys back to the shorter names used in the dict. PendingWriteOutcome in pdf_quote_match_policy.py has the same six fields as MatchResult but exists as a separate type — callers then unpack both into the same dict shape in _compute_write_time_match anyway.

**Fix.** Define a typed dataclass `MatchPersistenceFields` with the exact fields needed for persistence (match_status, match_version, start_offset, end_offset, prefix, suffix) and make _compute_write_time_match return it. Remove match_result_to_persistence_fields (it becomes an inline conversion to MatchPersistenceFields). PendingWriteOutcome can either be removed (return MatchPersistenceFields with status='pending' directly) or converted to a MatchPersistenceFields factory. This eliminates the double-rename indirection and gives callers a typed return.

#### 🟡 8. Module docs for highlight.md and pdf.md are empty — no intended design is documented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/highlight.md (1 line, empty)` · `docs/modules/pdf.md (1 line, empty)`  

**Problem.** Both module docs referenced by this slice contain only a single blank line. The audit process treats these docs as the intended design specification for their respective service slices. An empty doc makes it impossible to detect doc-code drift in either direction, and signals that the documentation has never been written or was deleted without being replaced.

**Fix.** Write brief module docs for highlight.md (covering: highlight anchor kinds, ownership boundary, visibility model, public API surface) and pdf.md (covering: geometry canonicalization, duplicate detection protocol, write-time quote match, locking contract). These docs should be tight enough to make future drift obvious.

#### 🟡 9. PdfQuoteMatchInternalError raised by policy helper is never caught — type exists but provides no value
`Low` · `Medium-confidence` · `ErrorHandling` · rules: `cleanliness.md §10`, `cleanliness.md §2`  
**Where:** `python/nexus/services/pdf_quote_match_policy.py:24-30 (PdfQuoteMatchInternalError class definition)` · `python/nexus/services/pdf_quote_match_policy.py:113-120 (raised in handle_unclassified_exception)` · `python/nexus/services/pdf_highlights.py:155-162 (handle_unclassified_exception call with raise-unreachable comment)`  

**Problem.** PdfQuoteMatchInternalError is raised by handle_unclassified_exception but never caught anywhere in the codebase — grep finds zero catch sites. The comment in pdf_highlights.py line 162 reads 'raise  # unreachable, handle_unclassified_exception always raises', which means the caller expects the exception to propagate all the way to the FastAPI global handler. The custom exception class adds no semantic capture point and no caller-side handling; the structured diagnostics it carries are never read programmatically. It provides no more value than the original exception would after being logged.

**Fix.** If no caller needs to distinguish this from a generic exception, remove PdfQuoteMatchInternalError and have handle_unclassified_exception re-raise the original exception after logging (or raise a standard RuntimeError). If the intent is that a future enrichment service will catch it, document that contract explicitly and add a catch point. Either way eliminate the never-caught custom class as dead code (cleanliness §2).


<a id="py-pdf-ingest"></a>
## PDF ingest  · `py-pdf-ingest`
*6 issues (1 High current, 1 High superseded)*

> **Verdict.** The PDF ingest slice is reasonably decomposed across five files. The earlier processing-state ownership finding is superseded: `tasks/ingest_pdf.py` now routes failed and ready-for-reading transitions through `media_processing_state.py`. The current serious problem is the block-assembly pipeline for building PDF content-index entries (locators, selectors, IndexableBlock construction, SourceSnapshotSpec), which remains duplicated between `tasks/ingest_pdf._index_pdf_evidence` and `content_indexing._repair_ready_pdf_content_index`, including a private `_text_quote` helper defined identically in both files with a subtle behavioural divergence. The module doc (`docs/modules/pdf.md`) is empty — no authoritative design is recorded, which is itself a doc-drift finding. The remaining files (`pdf_locking.py`, `pdf_readiness.py`) are focused and clean.


#### ✅ 1. ingest_pdf task bypasses media_processing_state for all state transitions
`Superseded` · was `High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`
**Where:** `python/nexus/tasks/ingest_pdf.py:84-89` · `python/nexus/tasks/ingest_pdf.py:109-119` · `python/nexus/tasks/ingest_pdf.py:149-158` · `python/nexus/tasks/ingest_pdf.py:205-211` · `python/nexus/tasks/ingest_pdf.py:392-396` · `python/nexus/services/media_processing_state.py:14-43`  

**Problem.** Superseded by the media-document readiness cutover. The task previously mutated the six-field failure-state tuple (processing_status, failure_stage, last_error_code, last_error_message, failed_at, updated_at) directly. The current implementation routes processing failure and ready-for-reading completion through `media_processing_state.py`, so this is no longer a current ownership-layering defect.

**Fix.** Add `mark_ready` (or `mark_ready_for_reading`) to `media_processing_state` that accepts the optional `last_error_code` parameter for the text-unavailable case. Add `mark_extract_failed` for the extract failure path. Replace every direct field-mutation block in `ingest_pdf.py` with calls to those helpers. The embed-failure path (line 392) which sets only `failure_stage` and `last_error_code` without transitioning `processing_status` should also become a named transition in `media_processing_state` (e.g. `mark_embed_failed`). Define `ApiErrorCode.E_PDF_TEXT_UNAVAILABLE` in `nexus/errors.py` and use it instead of the bare string.

#### 🔴 2. PDF block-assembly pipeline duplicated between ingest_pdf task and content_indexing repair path
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `python/nexus/tasks/ingest_pdf.py:225-409` · `python/nexus/services/content_indexing.py:1074-1202`  

**Problem.** The logic that assembles `IndexableBlock` list, `SourceSnapshotSpec`, locator dict, selector dict, and calls `rebuild_media_content_index` for a PDF is written in full twice. `_index_pdf_evidence` in the task file (185 lines) and `_repair_ready_pdf_content_index` in `content_indexing.py` (130 lines) build identical structures. The private helper `_text_quote` is defined identically in both files with one subtle behavioural difference: the task version at line 415 uses `text_value[end_offset : end_offset + 64]` (may run past end-of-string without clamping), while the content_indexing version at line 1886 uses `text_value[end_offset : min(len(text_value), end_offset + 64)]` (clamped). Beyond the bug risk, any locator schema change must be applied in two places, and the OCR fields (`ocr_engine`, `ocr_engine_version`, `ocr_confidence`, `extraction_method`) present in the task path are absent from the repair path, producing structurally different index entries for the same media.

**Fix.** Move `_index_pdf_evidence` (the authoritative version, since it has the live extraction result) into `content_indexing.py` or into a new `pdf_content_index.py` adapter module that owns the PDF-specific block assembly. Expose a single public function, e.g. `index_pdf_content(db, media_id, extraction_result | None, *, reason) -> ContentIndexResult`, and have both `ingest_pdf` task and the repair path call it. Delete `_repair_ready_pdf_content_index` and replace its call site with the unified function. Delete the duplicate `_text_quote` in the task file and use the one in `content_indexing` (or promote it to a shared utility). The unified builder should always include OCR fields, defaulting to None when rebuilding from stored artifacts.

#### 🟠 3. retry_for_viewer_unified dispatch table lives in pdf_lifecycle instead of a shared lifecycle router
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/services/pdf_lifecycle.py:44-70`  

**Problem.** `retry_for_viewer_unified` in `pdf_lifecycle.py` is a multi-kind dispatch function that conditionally delegates to `web_article_lifecycle`, `podcasts.transcripts`, and `epub_lifecycle` based on `media.kind`. It has no intrinsic relationship to PDF logic; it lives in the PDF module only because the route needed a single entry point. The PDF module thereby owns the routing table for all media kinds. This means a change to any other kind's retry logic requires touching the PDF lifecycle file.

**Fix.** Move `retry_for_viewer_unified` to a shared `media_lifecycle.py` (or a thin route-level helper in `media.py`) that imports each kind's retry function directly. The route already has the `from nexus.services.pdf_lifecycle import retry_for_viewer_unified` as a local import; the route handler itself could host this four-branch dispatch inline since it is thin glue, or a new `media_lifecycle.py` can own it. Either way, `pdf_lifecycle.py` should expose only `confirm_pdf_ingest` and `retry_pdf_ingest_for_viewer`.

#### 🟠 4. media.py duplicates the PDF text-rebuild + enqueue sequence owned by pdf_lifecycle
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `python/nexus/services/media.py:575-587` · `python/nexus/services/pdf_lifecycle.py:261-311`  

**Problem.** `media.py:refresh_source_for_viewer` (lines 575–587) manually calls `invalidate_pdf_quote_match_metadata`, `delete_pdf_text_artifacts`, `_reset_media_for_reingest`, and then directly enqueues `ingest_pdf` with `embedding_only=False`. This is the same sequence as `pdf_lifecycle._retry_pdf_text_rebuild` (minus the file-integrity check and the `begin_extraction` state transition). There are now two callers that perform overlapping PDF text-rebuild sequences without going through the PDF lifecycle service, violating the rule that one concern has one owner.

**Fix.** Extract a public function `rebuild_pdf_text(db, media, *, request_id) -> None` (or reuse `_retry_pdf_text_rebuild`) in `pdf_lifecycle.py` that owns the full sequence: validate source integrity if needed, invalidate quote-match metadata, delete text artifacts, transition state, enqueue job. Have `media.py:refresh_source_for_viewer` call it instead of assembling the sequence inline.

#### 🟡 5. docs/modules/pdf.md is empty — no design intent is recorded
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/pdf.md:1`  

**Problem.** The module documentation file exists but is completely empty (0 bytes). The PDF ingest slice is non-trivial: it spans five service/task files with distinct ownership boundaries (extraction, lifecycle, locking, readiness, task worker). Without a doc, ownership boundaries are only discoverable by reading all five files, and the intended design cannot be verified against the code.

**Fix.** Write a brief module doc for `pdf.md` that describes: (1) what each of the five files owns, (2) the public contract of each (entry points, typed inputs/outputs, typed errors), and (3) the write-lock ordering contract owned by `pdf_locking.py`. This is a precondition for the other refactors above to be validated against intent.

#### 🟡 6. Task file exposes run_pdf_ingest_sync as a public seam used only by scripts and tests
`Low` · `Medium-confidence` · `PublicSurface` · rules: `cleanliness.md §11`, `cleanliness.md §7`  
**Where:** `python/nexus/tasks/ingest_pdf.py:447-457` · `python/scripts/seed_e2e_data.py:57` · `python/tests/test_pdf_ingest.py:24`  

**Problem.** `run_pdf_ingest_sync` is a public function in the task module that wraps `extract_pdf_artifacts` with an optional storage_client parameter. Its only callers outside the module are seed scripts and tests. The function exists as a test/script seam for running extraction without the full worker lifecycle. `extract_pdf_artifacts` in `pdf_ingest.py` is already directly importable by scripts that need synchronous extraction.

**Fix.** Delete `run_pdf_ingest_sync` from `tasks/ingest_pdf.py`. Update `seed_e2e_data.py` to import and call `extract_pdf_artifacts` from `nexus.services.pdf_ingest` directly. Update `test_pdf_ingest.py` to do the same. This removes a production seam kept only for non-production callers.


<a id="py-web-article"></a>
## Web article / image proxy / HTML sanitize  · `py-web-article`
*8 issues (2 High)*  

> **Verdict.** The slice is broadly sound — each file has a clear stated purpose and the core security logic is self-contained — but there are four concrete problems. First, `image_proxy.py` conflates an SSRF-validation library with an image-specific proxy service: the URL/DNS validators are already imported directly by `media.py`'s `_download_remote_file`, making the module serve two masters. Second, `ingest_web_article.py` duplicates the web-article artifact teardown logic already owned by `web_article_lifecycle._delete_web_article_artifacts`, giving two owners for the same mutation. Third, `sanitize_html.py` hard-codes the HTTP route path `/media/image?url=` as `IMAGE_PROXY_URL`, leaking routing knowledge into a service layer; `oracle.py` independently defines `ORACLE_IMAGE_PROXY_PATH = \"/api/media/image\"` and a legacy fallback branch for the same path pattern, so three locations now co-own this one constant. Finally, `image_proxy.py` exposes nine internal helpers (`validate_content_type`, `sniff_magic_bytes`, `validate_and_decode_image`, `fetch_with_redirect`, `compute_etag`, `etags_match`, `is_private_ip`, `normalize_image_url`, `ImageCache`) as importable public names without an `__all__`, yet they are only called from tests and from `fetch_image` itself, bloating the public surface and creating test seams on implementation details.


#### 🔴 1. SSRF validators are public API of image_proxy.py but are actually general network utilities used by unrelated code
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/image_proxy.py:242` · `python/nexus/services/image_proxy.py:291` · `python/nexus/services/image_proxy.py:315` · `python/nexus/services/image_proxy.py:341` · `python/nexus/services/media.py:963-981`  

**Problem.** `media.py:_download_remote_file` (line 963) does a deferred import from `image_proxy` to borrow `validate_url`, `check_hostname_denylist`, and `validate_dns_resolution` for PDF/EPUB fetching. This means the image proxy module is simultaneously the owner of image caching/fetching logic AND a general SSRF-protection library for all remote file downloads. Any future caller of remote-file download must also import from `image_proxy`, coupling unrelated capabilities. cleanliness §6 says one concern one owner; §8 says services own a capability end-to-end and other modules call only the public service, never another module's private helpers.

**Fix.** Extract `validate_url`, `check_hostname_denylist`, `validate_dns_resolution`, and `is_private_ip` (plus their constants `ALLOWED_SCHEMES`, `ALLOWED_PORTS`, `HOSTNAME_DENYLIST_EXACT`, `HOSTNAME_DENYLIST_SUFFIXES`) into a new `nexus/services/ssrf_guard.py` module. Its single public contract: `validate_outbound_url(url: str) -> tuple[str, str]` (normalized_url, hostname) — the port is never used by callers. Both `image_proxy.py` and `media.py:_download_remote_file` then import from `ssrf_guard`. `image_proxy.py` remains the sole owner of image caching, content validation, and the `fetch_image` entry point.

#### 🔴 2. ingest_web_article.py duplicates artifact teardown logic already owned by web_article_lifecycle._delete_web_article_artifacts
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/tasks/ingest_web_article.py:257-286` · `python/nexus/services/web_article_lifecycle.py:121-146`  

**Problem.** `_do_ingest` (step 8, lines 257-286) manually deletes highlights via fragment anchors, fragment_blocks, fragments, and contributor_credits using raw SQL. `web_article_lifecycle._delete_web_article_artifacts` (lines 121-146) does exactly the same set of deletions using the ORM + one raw SQL for contributor_credits. The two implementations diverge in minor ways (ORM vs raw SQL, guard on `fragment_ids` before deleting highlights) so they can silently drift. The retry path (lifecycle) and the fresh-ingest path (task) should use the same artifact-teardown logic, but they don't. cleanliness §4: collapse repeated mutation flows to a single owner.

**Fix.** Make `_delete_web_article_artifacts` public (rename to `delete_web_article_artifacts`) in `web_article_lifecycle.py` and call it from `_do_ingest` in place of the inline SQL block. If `ingest_web_article.py` is not meant to depend on `web_article_lifecycle`, move the function to a shared helper (e.g. `web_article_structure.py` or a new `web_article_artifacts.py`). Whichever module owns it, it must be the only implementation of this teardown.

#### 🟠 3. IMAGE_PROXY_URL route path is hard-coded in sanitize_html.py, leaking routing knowledge into the service layer; oracle.py independently duplicates the same constant with a legacy fallback
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §4`, `layers.md`  
**Where:** `python/nexus/services/sanitize_html.py:85` · `python/nexus/services/sanitize_html.py:317` · `python/nexus/services/oracle.py:97` · `python/nexus/services/oracle.py:986-990` · `python/nexus/api/routes/media.py:91`  

**Problem.** `sanitize_html.py` defines `IMAGE_PROXY_URL = "/media/image?url={encoded_url}"` (line 85) and uses it to rewrite image `src` attributes. This embeds an HTTP route path in a service-layer HTML transformer. The actual route is declared at `api/routes/media.py:91`. `oracle.py` independently declares `ORACLE_IMAGE_PROXY_PATH = "/api/media/image"` (line 97) with a legacy path fallback (`/media/image?url=`) in `_oracle_image_proxy_url` (lines 986-990) — three locations now jointly define or consume this one path string, and they differ in the `/api` prefix. layers.md: services must not contain routing/transport knowledge. cleanliness §4: constant must have one owner.

**Fix.** Define one constant — e.g. `IMAGE_PROXY_RELATIVE_PATH = "/media/image"` — in a single place (a dedicated `nexus/services/image_proxy.py` constant or a `nexus/routing_constants.py`). `sanitize_html.py` imports it. `oracle.py` imports it and prepends `/api` for its SSE path. Remove the legacy branch in `_oracle_image_proxy_url` that pattern-matches `/media/image?url=` (that path is already caught by the first guard or is stale). This collapses three owners to one.

#### 🟠 4. image_proxy.py exposes an oversized public surface of implementation helpers that are only called internally or from tests
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`, `cleanliness.md §11`  
**Where:** `python/nexus/services/image_proxy.py:381` · `python/nexus/services/image_proxy.py:398` · `python/nexus/services/image_proxy.py:415` · `python/nexus/services/image_proxy.py:496` · `python/nexus/services/image_proxy.py:587` · `python/nexus/services/image_proxy.py:593` · `python/nexus/services/image_proxy.py:128` · `python/tests/test_image_proxy.py:18-32`  

**Problem.** The functions `validate_content_type`, `sniff_magic_bytes`, `validate_and_decode_image`, `fetch_with_redirect`, `compute_etag`, `etags_match`, and the `ImageCache` class are all importable from `image_proxy.py` and are imported by name in tests. None are called from production code outside the module itself — the only production callers are `media.py` (which imports the SSRF validators, addressed above) and the route handler (which calls only `fetch_image`). Exposing these as importable names creates test seams on implementation internals rather than behavior. cleanliness §6: shrink public surface to what is actually called. §11: tests that mock internal helpers and inspect wiring should be replaced with behavior tests at the true owner.

**Fix.** Prefix all implementation helpers with a leading underscore: `_validate_content_type`, `_sniff_magic_bytes`, `_validate_and_decode_image`, `_fetch_with_redirect`, `_compute_etag`, `_etags_match`, `_ImageCache`. Declare `__all__ = ["fetch_image", "ImageResponse"]`. Refactor tests in `test_image_proxy.py` that import internal symbols (`validate_content_type`, `sniff_magic_bytes`, etc.) to exercise behavior through `fetch_image` or dedicated unit tests for the SSRF validators (which will live in `ssrf_guard.py` after the extraction above). Tests for `ImageCache` internals (entry count, byte budget eviction) can remain as unit tests on the class, but it should be accessed only via a module-internal instance.

#### 🟠 5. run_ingest_sync in ingest_web_article.py is a test/dev-mode seam kept in production code
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`, `cleanliness.md §5`  
**Where:** `python/nexus/tasks/ingest_web_article.py:542-561`  

**Problem.** `run_ingest_sync` (lines 542-561) is a thin wrapper around `_do_ingest` that exists, per its own docstring, "for tests and dev mode". It is imported by more than a dozen test files, two live-provider test files, a seed script, and `test_web_article_highlight_e2e.py`. It bypasses the worker queue and session management in `ingest_web_article`, giving tests a different execution path than production. This is a test-only production seam. cleanliness §11 says "Remove production seams kept only for tests."

**Fix.** Remove `run_ingest_sync` from `ingest_web_article.py`. Tests that need to run ingestion synchronously should call `_do_ingest` directly after making it package-private (prefix `_`), or better: create a test fixture that enqueues and drains the job queue in-process. For the seed script, move to calling the job queue with a synchronous drain, matching production behavior.

#### 🟠 6. validate_and_decode_image mutates global Pillow state (Image.MAX_IMAGE_PIXELS and warnings filter) on every call
`Medium` · `High-confidence` · `Other` · rules: `cleanliness.md §8`, `cleanliness.md §5`  
**Where:** `python/nexus/services/image_proxy.py:429-432`  

**Problem.** `validate_and_decode_image` sets `Image.MAX_IMAGE_PIXELS` (a global Pillow constant) and calls `warnings.filterwarnings("error", ...)` (which mutates the process-wide warnings registry) on every invocation. This causes unintended side-effects for any other code in the process that uses Pillow or the warnings module. It also makes the function non-idempotent and not thread-safe. The correct approach is to set these once at module load time or at startup, not per-call.

**Fix.** Move `Image.MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION` and `warnings.filterwarnings("error", category=Image.DecompressionBombWarning)` to module-level initialization in `image_proxy.py` (immediately after the `from PIL import Image` import). Remove them from the body of `validate_and_decode_image`.

#### 🟠 7. ingest_web_article._do_ingest mixes orchestration, idempotency repair, deduplication, persistence, and content indexing in one 250-line function
`Medium` · `Medium-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/tasks/ingest_web_article.py:108-368`  

**Problem.** `_do_ingest` runs six distinct phases in a single 260-line function body: (1) idempotency/repair check including a multi-table SQL query, (2) status transition to `extracting`, (3) Node subprocess invocation, (4) atomic deduplication by canonical URL, (5) HTML sanitization and block preparation, (6) fragment persistence and media metadata update, and (7) content index rebuild with its own error handling and partial-failure state machine. The comment sequence jumps from "Step 6" to "Step 8" (step 7 is missing), indicating this function has already been through untracked edits. Each phase has its own `db.commit()` call and its own `except` block, making the control flow extremely hard to reason about. cleanliness §5: split functions that run unrelated phases in one body.

**Fix.** Decompose `_do_ingest` into named private functions, each owning one phase: `_check_idempotency(db, media_id) -> str | None` (returns early-exit reason or None); `_mark_extracting(db, media_id)` (status transition); `_run_extraction(url) -> IngestResult | IngestError`; `_deduplicate(db, media_id, canonical_url, actor_user_id) -> str` (returns 'success' | 'duplicate' | 'media_gone'); `_persist_fragment(db, media_id, prepared, ingest_result, now)` (all DB writes for the fragment); `_rebuild_index(db, media_id, fragment_id, language)` (index rebuild with error handling). `_do_ingest` becomes a thin sequencer of five calls. This directly enables the artifact-teardown deduplication fix above.

#### 🟡 8. Module doc for web-article is empty — the intended design is undocumented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/web-article.md`  

**Problem.** The module doc `docs/modules/web-article.md` is a 0-byte file. The file exists and is referenced as the design document for this slice, but it contains no content. This makes it impossible to audit intent vs. implementation drift, and every future engineer reading the code has no canonical description of ownership, public contracts, or lifecycle. cleanliness §3 treats a stale doc as a lead.

**Fix.** Write the module doc describing: (1) the five files in this slice and what each owns; (2) the one public entry point per capability (`fetch_image`, `sanitize_html`, `prepare_web_article_fragment`, `retry_web_article_for_viewer`, `ingest_web_article`); (3) the SSRF guard boundary; (4) the ingest lifecycle state machine and idempotency contract.


<a id="py-metadata-social"></a>
## Metadata enrichment & social identity  · `py-metadata-social`
*5 issues (2 High)*  

> **Verdict.** The slice is mostly clean, with three concentrated problems. x_api.py is a god file mixing three unrelated concerns (API client/transport, domain snapshot parsing, and HTML rendering), which violates the services rule requiring single capability ownership. Dispatch of the enrich_metadata job is duplicated across four independent code sites (enrich_metadata.py, media.py, podcasts/transcripts.py, and metadata_lifecycle.py), each re-implementing the same fire-and-forget enqueue pattern. Additionally, the X username validation regex is duplicated verbatim between x_api.py and x_identity.py. The identity files (x_identity.py, youtube_identity.py) and metadata_enrichment.py / metadata_lifecycle.py are focused and clean.


#### 🔴 1. Split x_api.py: HTML rendering is a separate concern from API transport and snapshot parsing
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/x_api.py:240-754`  

**Problem.** x_api.py mixes three entirely different responsibilities in one 753-line file: (1) X API HTTP transport and pagination (fetch_author_thread_snapshot, _get_json, _XPayloadAccumulator, _thread_search_params), (2) payload parsing into typed snapshots (_parse_post, _parse_posts, _parse_references, _parse_url_entities, _parse_users, _parse_media, _select_author_thread_posts, _merge_*), and (3) HTML rendering of X posts for storage (render_author_thread_fragment_html, render_single_post_html, _render_post_article, _render_quote_block, _render_links, _render_media, _paragraph, _esc, _attr). Rendering logic is completely unrelated to API transport: it depends on app_public_url, knows about quoted_media_ids (DB-level UUIDs), and emits stored HTML. This violates cleanliness.md §5 (split files mixing unrelated concerns) and §8 (services own a capability end-to-end). The metadata helpers thread_title, thread_description, post_title, post_description also do not belong with the HTTP client.

**Fix.** Extract rendering into a new module, e.g. nexus/services/x_rendering.py. Its public contract: render_author_thread_fragment_html(snapshot, *, quoted_media_ids, app_public_url) -> list[tuple[XPostSnapshot, str]] and render_single_post_html(post, *, users, media) -> str, plus thread_title, thread_description, post_title, post_description. Keep x_api.py as the pure API client: fetch_author_thread_snapshot (transport + pagination) and the parsing/accumulation internals. The snapshot dataclasses (XAuthorThreadSnapshot, XPostSnapshot, etc.) can stay in x_api.py or move to a nexus/services/x_types.py module if other code needs them independently. The metadata derivation helpers (thread_title etc.) belong in x_rendering.py since they derive presentation values from snapshots.

#### 🔴 2. Duplicated enrich_metadata dispatch logic across four sites
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `python/nexus/tasks/enrich_metadata.py:349-368` · `python/nexus/services/media.py:2393-2427` · `python/nexus/services/podcasts/transcripts.py:960-978` · `python/nexus/services/metadata_lifecycle.py:45-50`  

**Problem.** The fire-and-forget pattern of enqueuing an enrich_metadata job (enqueue_job with kind='enrich_metadata', payload={'media_id':..., 'request_id':...}, max_attempts=1) is implemented independently in four places. enrich_metadata.py defines dispatch_enrich_metadata (its own session). media.py defines two private variants: _try_enrich_dispatch (own session) and _try_enrich_dispatch_with_session (shared session). podcasts/transcripts.py has an inline enqueue_job call. metadata_lifecycle.py has yet another inline enqueue_job. Each site differs subtly in error handling and session management. This violates cleanliness.md §4 (collapse repeated logic to one owner) and module-apis.md (expose each capability in one primary form).

**Fix.** Designate dispatch_enrich_metadata in enrich_metadata.py (the job's owner) as the single canonical dispatch function. Add a session-passing overload or a second function dispatch_enrich_metadata_with_session(db, media_id, request_id) for callers that already hold a session. Delete _try_enrich_dispatch, _try_enrich_dispatch_with_session from media.py, and inline the logic in podcasts/transcripts.py. All callers import only from nexus.tasks.enrich_metadata. This collapses the error-handling variants to one verified implementation.

#### 🟠 3. Duplicated X username validation regex between x_api.py and x_identity.py
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/x_api.py:40` · `python/nexus/services/x_identity.py:17`  

**Problem.** _USERNAME_RE = re.compile(r'^[A-Za-z0-9_]{1,15}$') is defined verbatim in both x_api.py (line 40) and x_identity.py (line 17). The pattern is non-trivial (X's username contract) and dangerous to diverge. x_identity.py also uses it in _extract_username (the URL-identity path), while x_api.py uses its own copy in _normalize_username (the API client path). If the pattern ever needs to change, it requires two edits.

**Fix.** x_identity.py is the canonical home for X URL and identity rules. Move the regex definition there, rename it to something slightly more descriptive (_X_USERNAME_RE), and import it in x_api.py as: from nexus.services.x_identity import _X_USERNAME_RE. Alternatively, if the coupling is undesirable, expose a public validate_x_username(username: str) -> str | None helper from x_identity.py and call it from x_api._normalize_username.

#### 🟡 4. merge_enrichment re-validates already-validated enrichment dict with isinstance/strip guards
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/services/metadata_enrichment.py:465-528` · `python/nexus/services/metadata_enrichment.py:42-91`  

**Problem.** validate_structured_enrichment at line 449 runs the full Pydantic MetadataEnrichmentOutput validation (non-empty strings, valid date/language format, non-empty authors) and returns only non-None fields. Yet merge_enrichment at line 465 re-checks isinstance(title, str) and title.strip() for every field (lines 478-520). These guards are redundant for any dict that passed through validate_structured_enrichment, creating a second, weaker validator on the same data. This duplicates the ownership of the invariant check.

**Fix.** Trust the validated dict returned by validate_structured_enrichment and remove the redundant isinstance / strip guards in merge_enrichment. The function's contract already states it receives an already-validated enrichment dict. Optionally make this explicit by accepting a MetadataEnrichmentOutput typed object rather than a raw dict.

#### 🟡 5. get_content_sample pulls settings globally instead of accepting them as a parameter
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §6`, `cleanliness.md §7`, `layers.md`  
**Where:** `python/nexus/services/metadata_enrichment.py:145-148`  

**Problem.** get_content_sample(db, media) calls get_settings() internally at line 147 to read metadata_enrichment_max_content_chars. This hides a dependency: callers cannot override or inject the limit, and the function cannot be tested without patching the global settings. layers.md requires service dependencies to be explicit (function parameters, not globals). The single caller — enrich_metadata.py — already holds a settings object.

**Fix.** Add a max_chars: int parameter to get_content_sample and pass settings.metadata_enrichment_max_content_chars at the call site in enrich_metadata.py. Remove the get_settings() import from metadata_enrichment.py.


<a id="py-billing"></a>
## Billing / rate limit / entitlements  · `py-billing`
*11 issues (3 High)*  

> **Verdict.** The billing/rate-limit slice has one clear god file: rate_limit.py (845 lines) mixes two completely unrelated concerns — per-request flow control (RPM and concurrency) and the entire token-budget accounting subsystem (reserve/commit/release/charge, daily usage rows, expiry, advisory locking). The remaining files are mostly well-scoped, but billing.py blends Stripe SDK wiring directly with business-logic reads and the webhook parsing inlined inside the service, and two parallel schema types (BillingEntitlementsOut / BillingAccountOut) duplicate a large field set. The module doc (billing-plans.md) is an empty file, so every documented design claim must be inferred from code alone. The worst rot is the god-file split and the entitlements-lookup duplication inside the token-budget methods.


#### 🔴 1. Split rate_limit.py: RPM/concurrency flow-control is unrelated to token-budget accounting
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/rate_limit.py:1-845` · `python/nexus/services/rate_limit.py:48-201 (RPM + inflight slots)` · `python/nexus/services/rate_limit.py:203-574 (token budget reserve/commit/release/charge)`  

**Problem.** rate_limit.py is 845 lines and owns two entirely separate capabilities. Lines 48-201 implement per-minute request counting and concurrent-inflight slot management against rate_limit_request_log and rate_limit_inflight tables. Lines 203-574 implement a full token-budget accounting subsystem against token_budget_daily_usage, token_budget_reservations, and token_budget_charges tables, including advisory locking, reservation TTL expiry, idempotent charges, and entitlement policy checks. These two capabilities have different callers (RPM/inflight: stream_tokens route + chat_run_validation; token budget: oracle service + chat_runs service), different persistence tables, different error codes, and different lifecycles. Combining them in one class violates the one-capability-per-service rule.

**Fix.** Extract a TokenBudgetService (or token_budget.py) owning all token-budget state: reserve_token_budget, commit_token_budget, release_token_budget, charge_token_budget, and all private helpers (_load_budget_totals_for_update, _ensure_daily_usage_row, _select_daily_usage_for_update, _expire_reservations, _token_budget_charge_exists, _insert_token_budget_charge). Keep RateLimiter in rate_limit.py owning only check_rpm_limit, check_concurrent_limit, acquire_inflight_slot, and release_inflight_slot. Both services can share the _db_swallow/_db_strict session-context helpers and _advisory_lock_key by moving them to a private db_helpers module, or duplicating the small helpers. Both expose their own get_/set_ singletons initialized at app startup. Public contract for TokenBudgetService: named methods with (user_id, reservation_id?, tokens?) parameters, typed ApiError on budget exceeded.

#### 🔴 2. Entitlements + usage re-fetched independently in check_token_budget and reserve_token_budget
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`  
**Where:** `python/nexus/services/rate_limit.py:222-226 (check_token_budget: get_effective_entitlements + get_platform_token_usage)` · `python/nexus/services/rate_limit.py:343-346 (reserve_token_budget: same two calls)` · `python/nexus/services/rate_limit.py:229-248 (check_token_budget: plan-limit enforcement logic)` · `python/nexus/services/rate_limit.py:347-366 (reserve_token_budget: same enforcement logic, different error message)`  

**Problem.** Both check_token_budget (lines 222-248) and reserve_token_budget (lines 343-366) independently call get_effective_entitlements(db, user_id) and get_platform_token_usage(db, user_id, period_start, period_end), then re-implement the same enforcement logic (can_use_platform_llm guard, monthly_limit None/zero/exceeded checks). The only difference is that reserve_token_budget additionally adds est_tokens to the running total. This is duplicated business logic: if the policy changes (e.g., the error message, the comparison operator, the `monthly_limit <= 0` edge case) it must be updated in two places. The `monthly_limit <= 0` branch in check_token_budget also contradicts the schema constraint (ge=0) and does not appear in reserve_token_budget.

**Fix.** Extract a private _check_platform_budget(db, user_id, est_tokens=0) helper that performs the entitlements read, usage read, and all enforcement checks in one place. check_token_budget calls it with est_tokens=0; reserve_token_budget calls it with est_tokens=int(est_tokens) before inserting the reservation row. The helper raises the appropriate ApiError and returns (entitlements, monthly_usage) for the caller to use. This collapses the duplicated policy to a single owner.

#### 🔴 3. billing.py mixes Stripe SDK wiring with domain reads and webhook parsing
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/billing.py:84-163 (create_checkout_session, create_customer_portal_session: inline Stripe SDK calls)` · `python/nexus/services/billing.py:166-204 (process_stripe_webhook: event parsing, dedup, dispatch, Stripe SDK)` · `python/nexus/services/billing.py:207-251 (get_platform_token_usage, get_transcription_usage: plain DB reads unrelated to Stripe)` · `python/nexus/services/billing.py:253-276 (price/plan mapping private helpers)` · `python/nexus/services/billing.py:95 and 158: stripe.api_key = settings.stripe_secret_key set inline per-call)`  

**Problem.** billing.py combines three unrelated concerns: (1) a domain read (get_billing_account) that aggregates entitlements + usage into a UI response; (2) Stripe session creation and portal redirection — full vendor SDK wiring with api_key assignment inside the functions, not at startup; (3) webhook ingestion including signature verification, event dedup against StripeWebhookEvent, payload normalization (the hasattr to_dict_recursive/to_dict ladder), and subscription state sync. The usage query functions (get_platform_token_usage, get_transcription_usage) belong to the token-budget domain, not to Stripe billing. stripe.api_key is mutated twice as a side-effect inside function bodies, which is not thread-safe when the key could theoretically rotate.

**Fix.** Split into three units: (a) billing_account.py — get_billing_account assembling the UI-facing BillingAccountOut by calling entitlements + usage reads; (b) stripe_client.py (or stripe_gateway.py) — owns api_key initialization once at startup, exposes create_checkout_session, create_customer_portal_session, process_stripe_webhook, _sync_checkout_session, _sync_subscription, _price_id_for_plan, _plan_for_price_id, _stripe_timestamp; (c) usage_queries.py (or move into token_budget.py after the god-file split) — get_platform_token_usage, get_transcription_usage. Move stripe.api_key assignment to app startup alongside the RateLimiter initialization.

#### 🟠 4. BillingAccountOut duplicates almost all fields of BillingEntitlementsOut
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `python/nexus/schemas/billing.py:22-38 (BillingEntitlementsOut)` · `python/nexus/schemas/billing.py:50-65 (BillingAccountOut)`  

**Problem.** BillingAccountOut repeats billing_plan_tier, billing_status, subscription_current_period_start, subscription_current_period_end, can_manage_billing, entitlement_plan_tier, entitlement_source, entitlement_expires_at, can_share, can_use_platform_llm, can_transcribe — effectively the entire content of BillingEntitlementsOut — and adds billing_enabled, cancel_at_period_end, ai_token_usage, and transcription_usage. The two types expose duplicate APIs for the same entitlements state. Any change to entitlement field names or types must be applied in both places.

**Fix.** Make BillingAccountOut embed BillingEntitlementsOut as a named field (entitlements: BillingEntitlementsOut) and add only the fields unique to the account view: billing_enabled, cancel_at_period_end, ai_token_usage, transcription_usage. This makes the boundary clear: entitlements fields come from a single authoritative type, account fields wrap them with usage data.

#### 🟠 5. get_platform_token_usage and get_transcription_usage are public exports on the wrong module
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `python/nexus/services/billing.py:207-228 (get_platform_token_usage)` · `python/nexus/services/billing.py:230-250 (get_transcription_usage)` · `python/nexus/services/rate_limit.py:16: from nexus.services.billing import get_platform_token_usage` · `python/nexus/services/podcasts/transcripts.py:32: from nexus.services.billing import get_transcription_usage`  

**Problem.** get_platform_token_usage and get_transcription_usage are usage-accounting reads that are imported by rate_limit.py (token budget enforcement) and podcasts/transcripts.py (transcription quota checks). They live in billing.py, which is primarily a Stripe-facing module. This places the token and transcription usage queries in a module that also configures the Stripe SDK, creating an ownership muddle: callers outside the Stripe domain import from the Stripe billing file. The rule is one concern one owner; billing.py owns Stripe integration, not generic usage accounting.

**Fix.** Move get_platform_token_usage and get_transcription_usage to a dedicated usage_queries.py (or into the proposed token_budget.py service). Update imports in rate_limit.py and podcasts/transcripts.py accordingly. billing.py should import them from there if it still needs them for get_billing_account.

#### 🟠 6. Stripe SDK wired via mutable global (stripe.api_key) inside function bodies
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/billing.py:95` · `python/nexus/services/billing.py:158`  

**Problem.** stripe.api_key is assigned inside create_checkout_session (line 95) and create_customer_portal_session (line 158). Mutating a global per call is not safe if the key can change, and it buries the provider wiring inside individual service function bodies rather than at the boundary where the Stripe client is initialized. This violates the rule that provider-specific wiring should sit behind a driver or client service, not be scattered through business-logic functions.

**Fix.** Set stripe.api_key once at application startup (alongside the RateLimiter and session factory initialization in app.py). If multiple keys are theoretically possible, wrap the stripe SDK in a thin StripeClient class that takes the key at construction and exposes create_checkout_session, create_portal_session, construct_webhook_event as methods. Business-logic functions receive the pre-configured client, never set globals.

#### 🟠 7. Global mutable singleton for RateLimiter violates explicit-dependency rule
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §8`, `layers.md (service dependencies must be explicit)`  
**Where:** `python/nexus/services/rate_limit.py:831-845 (_rate_limiter global, get_rate_limiter, set_rate_limiter)` · `python/nexus/services/oracle.py:51: from nexus.services.rate_limit import get_rate_limiter` · `python/nexus/services/chat_runs.py:127: from nexus.services.rate_limit import get_rate_limiter` · `python/nexus/services/chat_run_validation.py:27: from nexus.services.rate_limit import get_rate_limiter`  

**Problem.** RateLimiter is accessed via a process-global get_rate_limiter()/set_rate_limiter() pair. layers.md states service dependencies must be explicit (function parameters, not globals). The global makes the dependency invisible in function signatures of oracle.py, chat_runs.py, and chat_run_validation.py, complicates testing (tests must call set_rate_limiter or monkeypatch), and introduces a class of initialization-order bugs (get_rate_limiter() returns a no-backend stub if called before set_rate_limiter).

**Fix.** Inject RateLimiter (and the proposed TokenBudgetService) as explicit constructor or function parameters into the service functions that need them. At the FastAPI layer, expose them as FastAPI dependencies (Depends) or app.state attributes so callers receive them explicitly. Remove get_rate_limiter/set_rate_limiter and the module-level _rate_limiter global.

#### 🟠 8. Stripe webhook payload normalization is a legacy-compat shim kept inside the service
`Medium` · `Medium-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §6`  
**Where:** `python/nexus/services/billing.py:188-192`  

**Problem.** The to_dict_recursive/to_dict dual-branch (lines 188-192) exists to handle two different Stripe SDK versions that returned objects with different deserialization methods. The project pin is stripe>=12.0.0 (pyproject.toml line 24). In Stripe SDK v12+, event data objects returned by Webhook.construct_event are plain dicts or StripeObject instances that serialize via to_dict_recursive; the older to_dict path is a compat shim for pre-v7 or pre-v10 SDK. Shipping both branches keeps dead behavior alive and obscures the actual SDK contract.

**Fix.** Remove the hasattr branching. Pin to the single deserialization method appropriate for stripe>=12.0.0. If the object from construct_event is already a dict (which is the case for stripe>=5 with parse_as_dict=True or with thin-event payloads), no conversion is needed. Verify against the pinned SDK version and collapse to a single path.

#### 🟡 9. billing_status exposed as bare str despite a known finite set of values
`Low` · `High-confidence` · `Types` · rules: `cleanliness.md §9`  
**Where:** `python/nexus/schemas/billing.py:24 (BillingEntitlementsOut.billing_status: str)` · `python/nexus/schemas/billing.py:53 (BillingAccountOut.billing_status: str)` · `python/nexus/db/models.py:4998-5011 (CheckConstraint listing 8 valid values + NULL)`  

**Problem.** The DB model enforces a finite set of subscription_status values via a CheckConstraint ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', or NULL, mapped to 'free'). billing_entitlements.py (line 37-39) passes this through as a bare str into BillingEntitlementsOut. The schema types it as str, making illegal states representable and forcing every consumer to guess the valid values. Downstream guards for unknown statuses can never be exhaustively checked.

**Fix.** Define a BillingStatus Literal type in schemas/billing.py with the values matching the DB constraint (plus 'free' for the null/absent case). Type BillingEntitlementsOut.billing_status and BillingAccountOut.billing_status as BillingStatus. This makes the union exhaustive and removes the need for any defensive str-comparison guards elsewhere.

#### 🟡 10. capabilities.py belongs to the media slice, not billing — misassigned to this audit slice
`Low` · `High-confidence` · `Naming` · rules: `cleanliness.md §6`, `cleanliness.md §12`  
**Where:** `python/nexus/services/capabilities.py:1-176`  

**Problem.** capabilities.py derives media-item capabilities (can_read, can_play, can_highlight, can_quote, etc.) from MediaKind, ProcessingStatus, and TranscriptState. It imports from nexus.db.models (media domain) and nexus.schemas.media. It has no connection to billing, rate limits, or entitlements. Its name collides conceptually with billing entitlements (which also confers capabilities like can_share, can_use_platform_llm), creating naming confusion. It is used only by nexus.services.media and nexus.services.reader_navigation/epub_read.

**Fix.** Rename capabilities.py to media_capabilities.py (or move it under a media/ sub-package alongside the other media services) to make its domain clear and eliminate the name collision with billing entitlement capabilities. No logic changes required.

#### 🟡 11. Empty billing-plans.md module doc means design intent is undocumented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/billing-plans.md`  

**Problem.** billing-plans.md is an empty file (0 bytes). It was presumably created as a placeholder for documenting the billing/entitlements design but was never filled in. The absence of a module doc means there is no authoritative statement of what billing_entitlements.py owns versus billing.py, what the plan-tier hierarchy means, or how overrides interact with subscriptions. This makes it impossible to audit design drift and easy for future contributors to add duplicate code paths.

**Fix.** Write the module doc or delete the file. If the file remains empty it should be removed to avoid false confidence that a design doc exists. The minimum useful doc would state: the plan-tier hierarchy (free < plus < ai_plus < ai_pro), the two entitlement sources (subscription vs internal_grant), quota override semantics, and which module owns what (billing.py = Stripe integration; billing_entitlements.py = effective-plan derivation and override CRUD; rate_limit/token_budget = enforcement).


<a id="py-object-refs"></a>
## Object refs & links  · `py-object-refs`
*6 issues (4 High)*  

> **Verdict.** object_refs.py is a god file at 750 lines that owns four distinct capabilities under one roof: per-object-type hydration with access control, full-text search across 11 object types, pinned-refs CRUD, and an LLM context rendering function that has no callers. The worst rot is the combination of the god file and a duplicated podcast visibility predicate written inline three times inside the same file (and repeated across search.py and contributors.py with no canonical owner). object_links.py and the route files are clean thin layers. services/models.py is unrelated to this slice and is clean.


#### 🔴 1. Split object_refs.py: separate hydration, search, pinned-refs, and context rendering into owned modules
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/object_refs.py:1-751`  

**Problem.** object_refs.py mixes four unrelated capabilities in 750 lines: (1) hydrate_object_ref — per-type DB fetch + access check, (2) search_object_refs — full-text search across 11 object types with type-specific visibility SQL, (3) pin_object_ref / list_pinned_object_refs / update_pinned_object_ref / unpin_object_ref — CRUD for the PinnedObjectRef table, and (4) render_object_context — LLM XML context rendering. Each capability has a different axis of change, different owners, and different dependencies. The file violates the one-concern-one-owner rule and makes the public surface of the 'object refs' module arbitrarily large.

**Fix.** Decompose into three services: (1) Keep python/nexus/services/object_refs.py as the hydration service, owning only hydrate_object_ref and the per-type access-checked fetch logic. Public contract: hydrate_object_ref(db, viewer_id, ref) -> HydratedObjectRef. (2) Create python/nexus/services/pinned_refs.py owning PinObjectRefInput, UpdatePinnedObjectRefPatch, and all pin_*/list_pinned_*/update_pinned_*/unpin_* functions plus _pinned_out and _next_pin_order_key. It imports hydrate_object_ref from the hydration service. (3) Create python/nexus/services/object_ref_search.py owning search_object_refs, with its own type-specific query logic. render_object_context should either be deleted (it has no callers) or moved to a dedicated LLM context service. The route files pinned_objects.py and object_refs.py update their imports accordingly.

#### 🔴 2. Delete dead render_object_context function
`High` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §13`  
**Where:** `python/nexus/services/object_refs.py:710-751`  

**Problem.** render_object_context is defined at line 710 but has zero callers anywhere in the repository (confirmed by exhaustive grep). It imports xml.sax.saxutils.escape, note_outline_markdown, and ordered_note_blocks_for_page solely for this function, adding import weight and surface area to the service for dead capability.

**Fix.** Delete render_object_context (lines 710-751) and the xml.sax.saxutils import at line 8. Also remove the imports of note_outline_markdown and ordered_note_blocks_for_page (lines 39-42) if they have no other callers in this file, which they do not.

#### 🔴 3. Canonicalize podcast visibility predicate — duplicated 3x in object_refs.py alone
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/object_refs.py:152-166` · `python/nexus/services/object_refs.py:312-335` · `python/nexus/services/object_refs.py:410-421` · `python/nexus/services/search.py:886-898` · `python/nexus/services/contributors.py:758-778`  

**Problem.** The podcast visibility predicate — 'viewer has an active subscription OR viewer is a member of a library that has the podcast' — is written as inline SQL in at least 5 places with no canonical helper. Inside object_refs.py alone it appears three times: in hydrate_object_ref for podcast (lines 152-166), in search_object_refs for podcast (lines 312-335), and in the visible_contributor_object_links CTE within the contributor search (lines 410-421). The same pattern appears in search.py and contributors.py. This violates the 'single owner per derived state' rule: any change to podcast visibility semantics must be made in all copies.

**Fix.** Add a visible_podcast_ids_cte_sql() function to python/nexus/auth/permissions.py alongside the existing visible_media_ids_cte_sql(). It should return the canonical two-path SQL (active subscription UNION library membership). Replace all inline copies with a reference to this helper, exactly as visible_media_ids_cte_sql() is already used in object_refs.py for media.

#### 🔴 4. evidence_span search uses an incorrect, weaker visible_media CTE that diverges from the canonical definition
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/object_refs.py:553-557` · `python/nexus/auth/permissions.py:99-134`  

**Problem.** The evidence_span block inside search_object_refs (lines 550-578) builds its own inline visible_media CTE: 'SELECT media_id FROM library_entries le JOIN memberships m ON m.library_id = le.library_id WHERE m.user_id = :viewer_id'. This covers only the non-default library path. The canonical visible_media_ids_cte_sql() in permissions.py covers three paths: non-default library, default-library intrinsic, and default-library closure edge. The weaker inline version will miss media that is visible to the viewer via default-library intrinsic or closure-edge paths, causing evidence_span search results to be silently incomplete for those viewers.

**Fix.** Replace the inline visible_media CTE in the evidence_span search block (lines 552-557) with the canonical f-string interpolation pattern already used elsewhere in the same function: WITH visible_media AS ({visible_media_ids_cte_sql()}). This makes evidence_span visibility consistent with media, content_chunk, and fragment visibility in the same function.

#### 🟠 5. OBJECT_TYPES Literal and OBJECT_TYPE_VALUES set are a parallel, duplicated registry
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`, `module-apis.md`  
**Where:** `python/nexus/schemas/notes.py:9-21` · `python/nexus/schemas/notes.py:32-44`  

**Problem.** OBJECT_TYPES is a Pydantic Literal type (lines 9-21) and OBJECT_TYPE_VALUES is a plain set containing the same 11 strings (lines 32-44). Both represent the exact same domain concept. Any new object type must be added to both. The set exists only because route handlers need runtime membership testing (object_type not in OBJECT_TYPE_VALUES) — but Pydantic's Literal-based ObjectRef validation already rejects invalid types at parse time, making the set redundant at the route boundary where ObjectRef is validated.

**Fix.** Delete OBJECT_TYPE_VALUES. Where routes currently do 'if object_type not in OBJECT_TYPE_VALUES: raise ApiError(...)' before constructing an ObjectRef, replace with a try/except around ObjectRef.model_validate(...) or use typing.get_args(OBJECT_TYPES) to derive the set programmatically — never maintain a parallel hand-written set.

#### 🟠 6. UpdateObjectLinkPatch encodes a transport concern (model_fields_set) inside the service input type
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/services/object_links.py:36-42` · `python/nexus/api/routes/object_links.py:98-99`  

**Problem.** UpdateObjectLinkPatch carries two boolean sentinel fields set_a_order_key and set_b_order_key (lines 41-42) whose sole purpose is to tell the service whether the HTTP client explicitly included a_order_key or b_order_key in the request body. The route handler sets them via 'a_order_key' in request.model_fields_set (lines 98-99), which is a FastAPI/Pydantic-specific transport concept. The service layer must not model HTTP partial-update semantics; it should receive a typed domain command.

**Fix.** Replace the boolean sentinels with typed optional semantics at the service boundary. Use a sentinel value (e.g. a UNSET singleton or a separate cleared/set wrapper) or restructure so the route explicitly passes None when the field is absent and the service always treats None as 'do not update'. The route translates the model_fields_set check to a concrete typed value before crossing the service boundary, keeping transport concerns in the adapter.


<a id="py-upload-storage"></a>
## Upload / storage / ingest recovery  · `py-upload-storage`
*5 issues (2 High)*  

> **Verdict.** The slice is mostly well-structured but has two substantive problems. The most significant is that `upload.py:confirm_ingest` is a 317-line, 18-commit-point function that fuses three unrelated phases (concurrency-claim, file validation+hashing, and deduplication+commit) into a single body, making it the dominant god-function in the slice. Second, there is a near-identical streaming/hashing/size-checking loop duplicated between `upload.py:_read_validated_upload_object` (lines 552-602) and `file_ingest_validation.py:validate_file_source_integrity` (lines 74-105); the owner module `file_ingest_validation.py` already exists for exactly this logic but `upload.py` carries its own copy rather than calling the shared primitive. The remaining files (`storage/client.py`, `storage/paths.py`, `ingest_recovery.py`, `bootstrap.py`, `internal_ingest.py`) are clean and well-scoped.


#### 🔴 1. confirm_ingest fuses three unrelated phases in one 317-line function body
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/services/upload.py:172-489`  

**Problem.** `confirm_ingest` runs three distinct, independently-owned phases in a single function: (1) concurrency-claim acquisition (lines 198-252 — SET processing_started_at, multiple rollback/early-return guards); (2) file streaming, signature validation, and SHA-256 computation (lines 254-380 — reads staging object twice, checks integrity, copies to final path); (3) deduplication and final DB commit (lines 382-489 — hash lookup, IntegrityError recovery, storage cleanup dispatch). Each phase has its own transaction boundary, its own failure modes, and its own cleanup helpers. The function has 8 explicit `db.commit()` or `db.rollback()` calls and 6 distinct `_delete_upload_object` call sites. No caller needs the phases bundled — `pdf_lifecycle` and `epub_lifecycle` both delegate to this function and then add their own dispatch phase on top, proving the concerns are already conceptually separate.

**Fix.** Split into three private helpers and a thin coordinator: (a) `_claim_upload_confirmation(db, media_id, viewer_id) -> UploadClaim` — acquires the processing_started_at lock, performs all early-exit checks, returns a typed value object carrying `storage_path`, `declared_size`, `kind`, `ext`, `final_storage_path`; raises ConflictError / ForbiddenError / NotFoundError as now. (b) `_stream_validate_and_copy(storage_client, claim) -> StreamResult` — reads staging, validates, copies to final path, re-validates for integrity, returns `(computed_sha, total_bytes)`; handles StorageError by calling `_clear_upload_confirmation_claim` and re-raising typed errors. (c) `_finalize_deduplicated(db, storage_client, media, claim, sha, size) -> dict` — does hash lookup + IntegrityError retry loop + DB commit + staging cleanup. The public `confirm_ingest` calls (a), (b), (c) in sequence; each helper is testable independently. This decomposition also removes the need for `_read_validated_upload_object` as a separate private (see duplication issue below).

#### 🔴 2. Streaming + hashing loop duplicated between upload.py and file_ingest_validation.py
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/services/upload.py:552-602` · `python/nexus/services/file_ingest_validation.py:50-105`  

**Problem.** `upload.py:_read_validated_upload_object` (lines 552-602) and `file_ingest_validation.py:validate_file_source_integrity` (lines 74-105) contain structurally identical streaming loops: both create a `hashlib.sha256()` hasher, accumulate `total_bytes`, guard on the first chunk with `has_valid_file_signature`, check `total_bytes > max_size`, and call `hasher.update(chunk)`. The max-size selection expression `settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes` is written four times across the two files (upload.py:260, 340; file_ingest_validation.py:37, 73). `upload.py` already imports `has_valid_file_signature` from `file_ingest_validation`, confirming the correct ownership boundary exists but is not being respected. The only structural difference is that `_read_validated_upload_object` also validates the declared-size pre-condition and returns `(sha, bytes)` rather than raising on mismatch, while `validate_file_source_integrity` accepts a pre-fetched `MediaFile` and an optional `expected_sha256` check.

**Fix.** Consolidate into a single function in `file_ingest_validation.py`. Expose a primitive `stream_hash_object(storage_client, path, kind, max_size, *, declared_size: int | None = None, expected_sha256: str | None = None) -> tuple[str, int]` that performs: head_object existence/size check (including optional declared_size equality); streaming loop with magic-byte check, max-size guard, and hashing; optional expected_sha256 comparison; returns `(hexdigest, total_bytes)`. Also expose a helper `get_max_size_for_kind(kind: str, settings) -> int` to eliminate the four copies of the ternary. `_read_validated_upload_object` in `upload.py` is then deleted and its two call sites replaced with calls to the shared primitive. `validate_file_source_integrity` similarly delegates to the primitive.

#### 🟠 3. enqueue_stale_ingest_reconcile swallows enqueue failure behind a bool return
`Medium` · `High-confidence` · `ErrorHandling` · rules: `cleanliness.md §10`, `cleanliness.md §8`  
**Where:** `python/nexus/services/ingest_recovery.py:52-73` · `python/nexus/api/routes/internal_ingest.py:26-31`  

**Problem.** `enqueue_stale_ingest_reconcile` catches `SQLAlchemyError`, logs it, and returns `False`; the route then checks `if not enqueued` and raises `ApiError(E_INTERNAL, ...)`. This is a two-step error-swallow-then-re-raise pattern. The service knows the error is fatal for the caller's intent (the route immediately converts `False` to a 500), yet it swallows the exception and forces the caller to reconstruct the error semantics from a boolean. The `SQLAlchemyError` detail is also permanently lost at the route boundary. Per cleanliness §10, catch-alls belong only at real boundaries and must map errors explicitly; a service function is not a boundary.

**Fix.** Remove the `try/except` from `enqueue_stale_ingest_reconcile` and let `SQLAlchemyError` propagate. Add a single catch at the route boundary in `internal_ingest.py` that maps `SQLAlchemyError` to `ApiError(E_INTERNAL, ...)`. The function signature changes from `bool` to `None` (raises on failure). This gives the caller the original exception detail and removes the dead boolean-check pattern.

#### 🟠 4. storage_client parameters are untyped (bare Any) in file_ingest_validation and upload helpers
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §8`  
**Where:** `python/nexus/services/file_ingest_validation.py:51` · `python/nexus/services/upload.py:500` · `python/nexus/services/upload.py:515` · `python/nexus/services/upload.py:535` · `python/nexus/services/upload.py:552-553`  

**Problem.** All four private helpers in `upload.py` (`_delete_upload_object`, `_delete_duplicate_upload_loser`, `_mark_failed_and_delete_upload_by_id`, `_read_validated_upload_object`) and the public `validate_file_source_integrity` in `file_ingest_validation.py` declare `storage_client` without a type annotation (implicitly `Any`). `StorageClientBase` exists in `storage/client.py` specifically for this purpose and is already used in `vault.py`, `media.py`, and `media_deletion.py` for the same pattern. The missing annotations allow a caller to pass any object, breaking the typed public contract rule.

**Fix.** Annotate `storage_client: StorageClientBase` in all five locations. Import `StorageClientBase` from `nexus.storage.client` (it is already imported in those modules via `StorageError` or `get_storage_client`).

#### 🟡 5. get_signed_download_url belongs to a media-access service, not the upload service
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/upload.py:605-657`  

**Problem.** `get_signed_download_url` is a read operation that checks media visibility (`can_read_media`) and generates a signed download URL. It does not participate in the upload lifecycle (no staging paths, no pending state, no SHA computation). Its placement in `upload.py` violates the ownership rule: `upload.py` declares itself as handling 'upload initialization, ingest confirmation, and signed URL generation' (docstring line 4) — the URL-generation concern is a read-access capability, not an upload concern. The function is the only caller of `can_read_media` in `upload.py`, which is otherwise write/mutation-only.

**Fix.** Move `get_signed_download_url` to `nexus/services/media.py` (which already imports `can_read_media` and owns media-read capabilities) or to a dedicated `nexus/services/media_files.py` if the surface grows. Update the single call site in `api/routes/media.py:698` to import from the new owner. Remove the `can_read_media` import from `upload.py`.


<a id="py-command-palette"></a>
## Command palette (backend)  · `py-command-palette`
*4 issues (1 High)*  

> **Verdict.** The command palette backend is a compact two-file slice (service + schemas) with a clean public surface — two named operations, proper separation from route handler, and thorough integration tests. The worst concern is that `_canonicalize_target_href` (lines 306-392) embeds a hard-coded route allowlist inside the frecency/history service, coupling URL routing policy to usage-history logic in the same file. A secondary concern is that the public service functions accept `target_kind: str` and `source: str` even though the schema file already defines precise `Literal` types, making illegal inputs representable inside the service boundary. Two smaller dead-code / defensive-guard issues exist but are low priority.


#### 🔴 1. URL allowlist policy embedded inside the usage-history service
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/command_palette.py:306-392` · `python/nexus/services/command_palette.py:395-455`  

**Problem.** `_canonicalize_target_href` (87 lines) and `_canonicalize_browse_target_href` together encode the complete set of allowed application routes — which paths are valid, which sub-paths are blocked (e.g. `/conversations/new`, `/podcasts/subscriptions`), and what query-parameter shapes are accepted for `/browse`. This is route-allowlist policy, not usage-history business logic. The same file owns frecency math, timestamp serialisation, DB mutation, and now a URL routing table. The concern will only grow as the app adds routes: every new navigable destination requires editing the usage-history service. `_canonicalize_browse_target_href` also accepts an untyped `parsed_result` parameter (`SplitResult` from `urllib.parse`), passing a library-internal object across a private function boundary rather than the resolved string values.

**Fix.** Extract the URL canonicalization concern into a thin module (e.g. `nexus/services/palette_href_canon.py` or a sibling `palette_routes.py`). Its single public function should be `canonicalize_palette_href(href: str) -> str`, raising `InvalidRequestError` on unsupported inputs. The command_palette service imports only that one function. The browse normalization helpers (`_normalize_browse_query`, `_normalize_browse_visible_types`, `_canonicalize_browse_target_href`) and the route table move with it. Fix the untyped parameter: pass `parsed.query: str` explicitly rather than the whole `SplitResult`.

#### 🟠 2. Service accepts `str` for `target_kind` and `source` after the schema already defines exact Literal types
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §6`  
**Where:** `python/nexus/schemas/command_palette.py:8-9` · `python/nexus/services/command_palette.py:92` · `python/nexus/services/command_palette.py:95` · `python/nexus/services/command_palette.py:136` · `python/nexus/services/command_palette.py:139` · `python/nexus/services/command_palette.py:221` · `python/nexus/services/command_palette.py:236`  

**Problem.** `CommandPaletteSource` (`Literal["static", "workspace", "recent", "oracle", "search", "ai"]`) and `CommandPaletteTargetKind` (`Literal["href", "action", "prefill"]`) are defined in `schemas/command_palette.py` and used correctly on the request schema. However, every internal function in `services/command_palette.py` — `record_selection_for_viewer`, `_record_selection_once`, `_normalize_target_key`, `_normalize_target_href` — widens the parameter types back to bare `str`. This means the service's internal boundary can receive unexpected string values (e.g. a new kind added to the DB constraint but not the Literal) without a type error. The Literal types already exist; the service is simply not using them.

**Fix.** Import `CommandPaletteTargetKind` and `CommandPaletteSource` from `nexus.schemas.command_palette` and annotate `target_kind` and `source` parameters with these types throughout the service and its private helpers. The route handler already passes values from the validated request model, so no runtime behaviour changes; the improvement is purely at the type boundary, making illegal states unrepresentable inside the service.

#### 🟡 3. Redundant `target_href is None` guard after DB query already filters out NULLs
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §9`  
**Where:** `python/nexus/services/command_palette.py:42` · `python/nexus/services/command_palette.py:53`  

**Problem.** In `get_history_for_viewer`, the DB query at line 42 filters with `CommandPaletteUsage.target_href.is_not(None)`, so `destination_rows` can only contain rows where `target_href` is non-NULL. The immediately following loop at line 53 re-checks `if row.target_href is None` before appending. Since the DB constraint guarantees the column is non-NULL whenever `target_kind == 'href'` (enforced by `ck_command_palette_usages_target_href`), and the query already excludes all NULL rows, the `is None` branch in the loop can never be taken. `CommandPaletteHistoryRecentOut.target_href` is already typed as `str`, confirming the non-optional contract.

**Fix.** Remove the `if row.target_href is None` branch from the loop body at line 53. The loop guard becomes simply `if row.target_key in seen_recent_targets: continue`. This removes a dead branch and lets the type checker infer `row.target_href: str` inside the loop without a None check.

#### 🟡 4. Bare `except IntegrityError` retry has no constraint discrimination
`Low` · `Medium-confidence` · `ErrorHandling` · rules: `cleanliness.md §10`, `errors.md`  
**Where:** `python/nexus/services/command_palette.py:115-126`  

**Problem.** In `record_selection_for_viewer`, an `IntegrityError` on the first `_record_selection_once` call triggers an unconditional retry with the same arguments. There is no check that the error was caused by the unique constraint `uq_command_palette_usages_user_query_target` (a race on concurrent inserts). Any other integrity violation — e.g. the `ck_command_palette_usages_target_kind` or `ck_command_palette_usages_source` check constraints — would cause the same error to be silently swallowed by the first except branch and then re-raised by the second call, producing a confusing double-fault. Compare how other services in the codebase (e.g. `notes.py:_is_daily_unique_conflict`, `contributor_credits.py:_integrity_constraint_name`) discriminate the constraint before retrying.

**Fix.** Add a helper such as `_is_usage_race_conflict(exc: IntegrityError) -> bool` that inspects `exc.orig` for the `uq_command_palette_usages_user_query_target` constraint name. In the except block, re-raise if the constraint is not the race condition. This is consistent with the pattern the rest of the codebase follows and avoids masking other integrity errors.


<a id="py-db-models"></a>
## DB models god file  · `py-db-models`
*6 issues (2 High)*  

> **Verdict.** models.py is a textbook god file: 6,401 lines, 130 classes (62 ORM tables, 28 enum types, and infrastructure helpers) spanning at least 10 distinct business capabilities — media ingest, podcasts, highlights, chat/LLM, billing, library intelligence, EPUB, oracle, notes, and auth. The rules explicitly call out this file as the Models layer, but every rule in cleanliness.md §4, §5, and §6 is violated by this single-file design: unrelated concerns share one namespace, enum types that belong to their owning domain are mixed into a global soup, enum string values are duplicated across multiple CHECK constraints with no single authoritative definition, and 18 enum classes defined mid-file after line 3,500 are never imported or used outside the file yet share the same public surface as the enums that are actively consumed by 95 other files. The worst rot is the wholesale mixing of completely unrelated capability domains and the parallel enum-vs-CHECK-constraint duplication pattern throughout.


#### 🔴 1. Split models.py into per-domain sub-modules under python/nexus/db/
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/db/models.py:1-6401`  

**Problem.** A single 6,401-line file contains 62 ORM table classes spanning at least 10 unrelated business capabilities: (1) media ingest and processing (Media, Fragment, MediaFile, ProcessingStatus, FailureStage, MediaKind, lines ~744-946), (2) podcast-specific tables (Podcast, PodcastEpisode, PodcastListeningState, PodcastTranscriptionJob, lines ~2013-3249), (3) highlights and PDF geometry (Highlight, HighlightFragmentAnchor, HighlightPdfAnchor, lines ~3256-3515), (4) chat and LLM infrastructure (Conversation, Message, ChatRun, Model, lines ~3692-4889), (5) billing and auth (BillingAccount, UserApiKey, ExtensionSession, AuthHandoffCode, lines ~4892-5305), (6) library intelligence (LibraryIntelligenceArtifact, LibraryIntelligenceVersion, LibraryIntelligenceClaim, lines ~1567-2007), (7) EPUB reader (EpubTocNode, EpubNavLocation, EpubFragmentSource, EpubResource, lines ~5528-5703), (8) oracle corpus (OracleCorpusSetVersion, OracleReading, OracleReadingEvent, lines ~6015-6401), (9) notes and pages (Page, NoteBlock, DailyNotePage, lines ~213-358), and (10) user-facing state (ReaderProfile, WorkspaceSession, CommandPaletteUsage, lines ~5791-6013). Every one of these is a separate ownership domain serviced by dedicated service files. Placing all table classes in one file means any change anywhere requires importing and loading the entire schema graph, and the module's public surface is 130 symbols when most callers need fewer than ten.

**Fix.** Create domain sub-modules under python/nexus/db/: media_models.py (Media, Fragment, MediaFile, MediaKind, ProcessingStatus, FailureStage), podcast_models.py (Podcast, PodcastEpisode, PodcastListeningState, PodcastTranscriptionJob, PodcastTranscriptVersion, PodcastTranscriptSegment, PodcastTranscriptionUsageDaily, PodcastTranscriptRequestAudit, MediaTranscriptState, TranscriptState, TranscriptCoverage, SemanticStatus), highlight_models.py (Highlight, HighlightFragmentAnchor, HighlightPdfAnchor, HighlightPdfQuad, PdfPageTextSpan), chat_models.py (Conversation, ConversationReference, ConversationShare, Message, MessageLLM, MessageToolCall, MessageRetrieval, MessageRetrievalCandidateLedger, MessageRerankLedger, ChatRun, ChatPromptAssembly, ChatRunEvent, ConversationActivePath, ConversationBranch, ConversationMedia, Model), billing_models.py (BillingAccount, BillingEntitlementOverride, BillingEntitlementOverrideEvent, StripeWebhookEvent, UserApiKey), auth_models.py (User, ExtensionSession, AuthHandoffCode), library_models.py (Library, Membership, LibraryEntry, LibraryInvitation, LibrarySourceSetVersion, LibrarySourceSetItem, LibraryIntelligenceArtifact, LibraryIntelligenceVersion, LibraryIntelligenceSection, LibraryIntelligenceNode, LibraryIntelligenceClaim, LibraryIntelligenceEvidence, LibraryIntelligenceBuild, DefaultLibraryIntrinsic, DefaultLibraryClosureEdge, DefaultLibraryBackfillJob), epub_models.py (EpubTocNode, EpubNavLocation, EpubFragmentSource, EpubResource), content_index_models.py (ContentIndexRun, SourceSnapshot, ContentBlock, ContentChunk, ContentChunkPart, ContentEmbedding, EvidenceSpan, MediaContentIndexState, FragmentBlock), oracle_models.py (OracleCorpusSetVersion, OracleCorpusWork, OracleCorpusPassage, OracleCorpusImage, OracleReading, OracleReadingPassage, OracleReadingEvent), and notes_models.py (Page, DailyNotePage, NoteBlock, ObjectLink, ObjectSearchDocument, ObjectSearchEmbedding). Keep python/nexus/db/models.py as a thin re-export shim only while callers are migrated, then delete it. Keeping Base and PGVector in a python/nexus/db/base.py ensures all sub-modules share the same DeclarativeBase.

#### 🔴 2. 18 enum classes defined mid-file after line 3,520 are never imported by any caller — dead public surface
`High` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §6`  
**Where:** `python/nexus/db/models.py:3523-3691`  

**Problem.** The classes SharingMode, MessageRole, MessageStatus, BranchAnchorKind, LLMProvider, KeyModeRequested, KeyModeUsed, ApiKeyStatus, ContextTargetType, MessageToolStatus, ChatRunStatus, ChatRunEventType, AppSearchResultType, AssistantClaimSupportStatus, AssistantClaimVerifierStatus, AssistantEvidenceRole, and RetrievalEvidenceStatus are all defined in models.py lines 3,523–3,691. A codebase-wide grep confirms that none of them are ever imported from models.py — no file contains 'from nexus.db.models import SharingMode' (or any of the others in this block). The check constraints on the corresponding tables (e.g., ck_conversations_sharing at line 3,722, ck_messages_role at line 3,927, ck_message_llm_provider at line 4,114) encode the valid values independently as inline string literals, meaning the enum classes provide zero enforcement at runtime. These classes exist solely as documentation that has drifted from actual usage: LLMProvider is redefined as a type alias in llm_catalog.py (line 8), which is where all production code imports it from. The 18 classes add noise to the module's public surface without being part of any executed code path.

**Fix.** Delete all 18 enum classes (SharingMode through RetrievalEvidenceStatus) from models.py. For the few cases where a typed constant is still useful (e.g., request_reason values — see separate Duplication issue), define a single canonical Literal or StrEnum in the owning service module (e.g., nexus/services/chat_runs.py or a shared nexus/domain/enums.py). Do not replace them with new enum classes in models.py; the CHECK constraints are the enforcement mechanism for the DB layer, and the service layer should own typed domain constants.

#### 🟠 3. request_reason valid values duplicated in four separate CHECK constraints with a divergent subset
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`  
**Where:** `python/nexus/db/models.py:2502-2506 (PodcastTranscriptionJob)` · `python/nexus/db/models.py:2589-2593 (PodcastTranscriptVersion)` · `python/nexus/db/models.py:3165-3169 (MediaTranscriptState.last_request_reason)` · `python/nexus/db/models.py:3224-3226 (PodcastTranscriptRequestAudit)`  

**Problem.** The set of valid transcript request reasons is copied verbatim into four different CHECK constraints. Two of them include 'rss_feed' (lines 2503, 2590); the other two omit it (lines 3166, 3225). This divergence means the database itself enforces a different domain on MediaTranscriptState and PodcastTranscriptRequestAudit than on PodcastTranscriptionJob and PodcastTranscriptVersion. If a new reason is added, all four constraints must be updated in sync — a classic fan-out duplication bug. The same issue exists for the provider constraint string 'openai', 'anthropic', 'gemini', 'deepseek', which appears on three tables (lines 3851, 4114, 4927) with no shared definition.

**Fix.** For the request_reason set: document the canonical set as a comment constant above the first table that uses it, and ensure the constraint text is identical across all four tables (decide whether 'rss_feed' belongs in the full set or only in ingest-facing tables, then apply consistently). For the provider set: same approach — define one comment/constant for the canonical provider list and reference it in all three constraints. In a subsequent pass, consider whether these should be PostgreSQL enum types (like processing_status and failure_stage already are) so the DB enforces the single definition directly.

#### 🟠 4. 10 enum classes declared at the top of models.py are never used as SQLAlchemy column types — they live only in CHECK constraints
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/db/models.py:134-167 (MembershipRole, LibraryInvitationRole, LibraryInvitationStatus, DefaultLibraryBackfillJobStatus)`  

**Problem.** Four enum classes at lines 134–167 (MembershipRole, LibraryInvitationRole, LibraryInvitationStatus, DefaultLibraryBackfillJobStatus) exist in the file but are never passed to a SQLAlchemy Enum() column type, never used as a server_default value, and never imported by any service or schema file. Their valid values are independently re-encoded in inline CHECK constraint strings: ck_memberships_role ('admin', 'member') at line 735, ck_library_invitations_role at line 5350, ck_library_invitations_status at line 5354, ck_default_library_backfill_jobs_status at line 5508. The enum class and the check constraint independently enumerate the same values, so changing one does not update the other — the dual definition is always potentially inconsistent.

**Fix.** Delete MembershipRole, LibraryInvitationRole, LibraryInvitationStatus, and DefaultLibraryBackfillJobStatus from models.py; the CHECK constraints are the authoritative enforcement mechanism. If callers need a typed constant for these values, define it in the owning service file (e.g., nexus/services/libraries.py) as a Literal type or a small StrEnum that lives next to the business logic, not in the schema layer.

#### 🟠 5. Media table carries 27 columns mixing five distinct sub-concerns in a single class
`Medium` · `Medium-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §9`  
**Where:** `python/nexus/db/models.py:745-945`  

**Problem.** The Media class at lines 745–945 carries columns for: (a) core identity (id, kind, title, canonical_source_url), (b) processing lifecycle (processing_status, failure_stage, last_error_code, last_error_message, processing_attempts, processing_started_at, processing_completed_at, failed_at), (c) URL and file identity (requested_url, canonical_url, file_sha256, external_playback_url), (d) provider identity (provider, provider_id), (e) PDF text readiness (plain_text, page_count), and (f) document metadata enrichment (published_date, publisher, language, description, metadata_enriched_at). The lifecycle fields are already partially extracted into MediaContentIndexState and MediaTranscriptState satellite tables, but the main processing lifecycle fields (b) remain on Media itself and are also duplicated on several satellite tables (e.g., PodcastTranscriptionJob at lines 2454–2508 duplicates status/attempts/started_at/completed_at/error_code). The plain_text column stores full extracted text inline on the Media row, which is an unusual design that mixes artifact storage with table identity. The 14 relationship back-references to other tables (fragments, library_entries, media_file, podcast_episode, etc.) make this a hub node that many domains pull into their session unnecessarily.

**Fix.** This is a lower-priority structural note: the Media table design is a deliberate architectural choice (shared global identity row for all media kinds). The more actionable sub-task is to verify that plain_text (the full PDF text) does not create problematic row sizes and consider moving it to a MediaPlainText satellite table alongside MediaFile. The processing-lifecycle columns should be reviewed for whether they duplicate data already in MediaContentIndexState, and if so, one should be designated canonical and the other dropped.

#### 🟡 6. Enums scattered in two disconnected blocks (lines 58–167 and 3,523–3,691) instead of co-located with their owning tables
`Low` · `High-confidence` · `Naming` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `python/nexus/db/models.py:53-167` · `python/nexus/db/models.py:3518-3691`  

**Problem.** All enums are dumped into two monolithic blocks rather than placed near the table they describe. The first block (lines 53–167) contains ProcessingStatus and FailureStage (media ingest), TranscriptState/TranscriptCoverage/SemanticStatus (podcast transcript), MembershipRole (library), LibraryInvitationRole/LibraryInvitationStatus (library sharing), and DefaultLibraryBackfillJobStatus (library closure) — five different domains in one block. The second block (lines 3,518–3,691) dumps 18 enum classes that are all dead code. When the god file is split into domain sub-modules (see primary issue), each enum should live in the same file as its table, which naturally resolves the layout problem.

**Fix.** Resolve as a consequence of the god-file split: move each enum class into the domain sub-module file that owns the table it relates to. No standalone enum file is needed.


<a id="py-db-infra"></a>
## DB infrastructure  · `py-db-infra`
*6 issues (0 High)*  

> **Verdict.** The DB infra slice is lean and well-decomposed overall — each file has a clear single concern, none is a god file, and the public surfaces are small. The most substantive issues are: (1) a duplicate connection-URL translation in listen.py that belongs in the engine layer; (2) `session.py` mixing framework-coupled concerns (FastAPI `Request`, ASGI state key) with pure DB helpers (transaction, use_serializable_if_available), creating unnecessary coupling to FastAPI in every caller that only needs the pure helpers; and (3) `track_request_db_session` and `release_connection` are public but have no external callers and exist solely as internal helpers of `get_db` / `release_tracked_request_db_sessions`.


#### 🟠 1. listen.py duplicates database URL prefix translation owned by engine.py
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/db/listen.py:257-263` · `python/nexus/db/engine.py:15-60`  

**Problem.** `_connect()` in listen.py calls `get_settings().database_url.replace('postgresql+psycopg://', 'postgresql://', 1)` to strip the SQLAlchemy driver prefix before passing the URL to psycopg. This is a second place that understands the URL format; engine.py already owns all DB connection concerns. Any future change to the URL scheme (e.g., a different driver prefix) must be updated in two places.

**Fix.** Add a small helper to engine.py, e.g. `def raw_postgres_url() -> str`, that strips the SQLAlchemy prefix and is called by both engine.py (if needed) and listen.py. Alternatively, expose the setting already coerced to bare libpq format so no stripping is needed at call sites. Keep the logic in exactly one module.

#### 🟠 2. session.py mixes FastAPI-coupled request wiring with pure DB helpers, inflating every caller's import surface
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/db/session.py:12` · `python/nexus/db/session.py:52-99` · `python/nexus/db/session.py:17`  

**Problem.** `session.py` imports `from fastapi import Request` and defines `get_db` (a FastAPI Depends generator), `track_request_db_session`, `release_tracked_request_db_sessions`, and the `REQUEST_DB_SESSIONS_STATE_KEY` constant — all of which are specific to FastAPI/ASGI request lifecycle. These sit in the same module as pure DB helpers (`transaction`, `use_serializable_if_available`, `get_session_factory`) that have nothing to do with HTTP. Any service or task that needs only `transaction` must still import a module that pulls in FastAPI. This violates the rule that services must not import framework types and that each concern has one owner.

**Fix.** Split session.py into two files: `nexus/db/session.py` retains only the pure helpers (`create_session_factory`, `get_session_factory`, `transaction`, `use_serializable_if_available`); move `get_db`, `track_request_db_session`, `release_connection`, `release_tracked_request_db_sessions`, and `REQUEST_DB_SESSIONS_STATE_KEY` into `nexus/db/request_session.py` (or co-locate with the middleware in `nexus/middleware/db_session.py`). The middleware already imports only `release_tracked_request_db_sessions`; consolidating request-lifecycle session management there is the natural home.

#### 🟡 3. track_request_db_session and release_connection are public but have no callers outside session.py — oversized public surface
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `python/nexus/db/session.py:72-85`  

**Problem.** `track_request_db_session` is called only by `get_db` inside session.py itself; `release_connection` is called only by `release_tracked_request_db_sessions` inside session.py. Both are public (no leading underscore) and appear in the import path that external tests use via `REQUEST_DB_SESSIONS_STATE_KEY`. No production module outside session.py imports or calls either function. They should be private helpers (`_track_request_db_session`, `_release_connection`) to shrink the public surface and signal that they are implementation details.

**Fix.** Prefix both with `_` to make them private. Verify no test directly imports them (none do — tests only import `REQUEST_DB_SESSIONS_STATE_KEY`).

#### 🟡 4. create_session_factory uses engine: Any parameter instead of a typed Engine union
`Low` · `High-confidence` · `Types` · rules: `cleanliness.md §9`  
**Where:** `python/nexus/db/session.py:20`  

**Problem.** `create_session_factory(engine: Any = None)` accepts `Any` for the engine parameter. The only non-default caller is `nexus/services/podcasts/transcripts.py:1164`, which extracts a bound engine from `db.get_bind()` (itself deprecated in SQLAlchemy 2.x) and passes it directly. The `Any` type hides that this is always an `Engine` or `Connection`, making illegal usages undetectable by the type-checker.

**Fix.** Type the parameter as `Engine | None = None`. The transcripts.py caller also uses `db.get_bind()` (deprecated); both sites should be updated together to use `db.get_bind()` only if truly needed, or to pass the engine from an explicit dependency rather than extracting it from a live session.

#### 🟡 5. use_serializable_if_available calls deprecated db.get_bind() and silently swallows the no-transaction guard
`Low` · `Medium-confidence` · `ErrorHandling` · rules: `cleanliness.md §10`, `cleanliness.md §9`  
**Where:** `python/nexus/db/session.py:102-106`  

**Problem.** `db.get_bind()` is deprecated since SQLAlchemy 1.4 and removed in 2.0-style usage; the code uses `getattr(bind, 'in_transaction', lambda: False)()` as a silent fallback for whatever `get_bind()` returns. If `get_bind()` fails or returns something unexpected, the isolation-level upgrade is silently skipped rather than raising. This is the kind of silent fallback that cleanliness §10 forbids — it swallows failure rather than failing fast.

**Fix.** Replace `db.get_bind()` with `db.get_bind()` only if the project is confirmed on SQLAlchemy 1.x, or migrate to the 2.x equivalent (`db.connection()` to check transaction state). Remove the `getattr` fallback and let unexpected states raise explicitly. Four call sites (`bootstrap.py`, `stream_token.py`, `worker.py`, `notes.py`) should be audited for whether the SERIALIZABLE upgrade is still needed under the actual pooling configuration.

#### 🟡 6. STREAM_LISTEN_MAX_CONNECTIONS is a hardcoded module constant rather than a configurable setting
`Low` · `Medium-confidence` · `Other` · rules: `cleanliness.md §8`  
**Where:** `python/nexus/db/listen.py:36` · `python/nexus/db/listen.py:254`  

**Problem.** All other DB capacity knobs (`database_pool_size`, `database_max_overflow`, `database_pool_timeout_seconds`, etc.) are configured via `Settings` and can be tuned per deployment. `STREAM_LISTEN_MAX_CONNECTIONS = 64` is a bare module constant that feeds the process-local singleton `_listen_manager`. Operators cannot tune the SSE listener cap without a code change, inconsistent with every other pool limit in the codebase.

**Fix.** Add `stream_listen_max_connections: int = Field(default=64, alias='STREAM_LISTEN_MAX_CONNECTIONS')` to `Settings`. Pass `get_settings().stream_listen_max_connections` when constructing `_listen_manager` in the module initialiser or via the application startup hook.


<a id="py-jobs"></a>
## Jobs / worker / registry  · `py-jobs`
*10 issues (2 High)*  

> **Verdict.** The jobs slice has three high-severity problems. The worst is reconcile_stale_ingest_media.py: a 356-line god function mixing four unrelated repair phases (pending upload cleanup, stale ingest requeue, content index repair, semantic index repair) in a single transaction body with its own raw session lifecycle. Second, queue.py contains three pairs of near-identical SQL blocks — the `allowed_kinds` branching pattern is duplicated verbatim across `claim_next_job`, `dead_letter_expired_job`, and `_wait_for_job_notification` (~330 lines of duplicate SQL). Third, registry.py conflates job policy declarations, payload-parsing transport adapters, and registry construction in one 400-line file, making the job system's public contract unclear. These are the priority targets; remaining issues are medium or low.


#### 🔴 1. Split reconcile_stale_ingest_media_job: four unrelated repair phases in one 356-line god function
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/tasks/reconcile_stale_ingest_media.py:72-427`  

**Problem.** The public entry point `reconcile_stale_ingest_media_job` runs four completely unrelated repair phases in a single 356-line function body under one raw session lifecycle: (1) pending-upload cleanup (lines 93-125), (2) stale extracting-media requeue/fail (lines 127-206), (3) content-index state repair (lines 211-291), and (4) semantic transcript index repair (lines 293-378). Each phase queries different tables, applies different business rules, calls different services, and could independently fail or be independently scheduled. They are joined only by the accident of sharing a periodic scheduler slot and a combined log message. The function also manages its own raw `db = session_factory()` with a manual `finally: db.close()` rather than using the context-manager form (`with session_factory() as db:`), making rollback behavior on partial failure inconsistent across phases.

**Fix.** Extract each phase into its own named task function with a clean signature: `cleanup_pending_uploads(db)`, `reconcile_stale_extracting_media(db)`, `repair_stale_content_indexes(db)`, `repair_stale_semantic_indexes(db)`. Register each as its own periodic job kind in the registry (or call all four from a thin coordinator function that loops with explicit commits). Each sub-function receives a `db: Session` parameter rather than constructing its own session, moving session lifecycle to the caller. The coordinator can aggregate the result dict. This lowers the function from 356 lines to four functions of ~60-80 lines each with clear single-phase contracts.

#### 🔴 2. Collapse duplicated allowed_kinds SQL branching in queue.py and worker.py
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §5`  
**Where:** `python/nexus/jobs/queue.py:201-331 (claim_next_job, two near-identical SQL blocks)` · `python/nexus/jobs/queue.py:334-427 (dead_letter_expired_job, two near-identical SQL blocks)` · `python/nexus/jobs/worker.py:395-521 (_wait_for_job_notification, two near-identical SQL blocks)`  

**Problem.** Three functions each contain a pair of almost-identical SQL statements: one for the `allowed_kinds is None` case and one for the `allowed_kinds` case. The only difference between the pair members is the addition of `AND kind = ANY(:allowed_kinds)` predicates. This pattern is repeated in `claim_next_job` (lines 218-271 vs 273-328, ~110 lines each), `dead_letter_expired_job` (lines 348-383 vs 385-423, ~38 lines each), and `_wait_for_job_notification` (lines 398-455 vs 457-521, ~58 lines each). Any change to the query logic requires applying it twice per function, three times across the file pair. Total duplicated SQL surface is approximately 330 lines.

**Fix.** Parameterise each query with an optional `kind = ANY(:allowed_kinds)` clause inserted conditionally into the SQL string, or use SQLAlchemy's `and_()` / `.where()` to build the predicate. In Python: build a `kind_filter` snippet (either `''` or `'AND kind = ANY(:allowed_kinds)'`) and format it into a single SQL template; include the `allowed_kinds` param only when non-None. For `claim_next_job` and `dead_letter_expired_job` this collapses each if/else to a single `db.execute(...)` call with a computed params dict. For `_wait_for_job_notification` a helper that returns `(has_due_job, seconds_until_next_job)` given an optional kinds list eliminates the repeated 60-line block.

#### 🟠 3. Split registry.py: separate job policy declarations from payload-parsing adapters
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/jobs/registry.py:78-223 (_build_default_registry with all JobDefinition entries)` · `python/nexus/jobs/registry.py:226-401 (all _run_* and _dead_letter_* adapter shims)`  

**Problem.** registry.py mixes two distinct concerns in 400 lines: (a) job policy declarations — the `JobDefinition` dataclass and the dict mapping kind → policy (max_attempts, retry delays, lease, periodic schedule, handlers), which is wiring/configuration; and (b) payload-parsing transport adapters — the 17 private `_run_*` functions and one `_dead_letter_*` function, each of which unpacks raw `Mapping[str, Any]` payload into typed arguments and dispatches to the real task. The `_run_*` functions are the edge-adapter layer (transport parsing at the boundary), while the `JobDefinition` table is pure configuration. Mixing them makes it hard to see which policy belongs to which job and prevents the registry's public surface from being a plain data structure.

**Fix.** Keep `JobDefinition`, `get_default_registry`, `get_task_contract_version`, `periodic_slot_start`, and `periodic_dedupe_key` in `registry.py` as the policy/config module. Move the `_run_*` and `_dead_letter_*` shims into each task's own module (e.g., `nexus/tasks/ingest_web_article.py` gains a `handle_job(payload)` function). The `JobDefinition` in `_build_default_registry` then references `ingest_web_article.handle_job` directly, eliminating the indirection layer in registry.py entirely. This also means each task owns its own payload contract, which is the right ownership boundary.

#### 🟠 4. Dead status constants PENDING, RUNNING, SUCCEEDED, TERMINAL_STATUSES exported but never imported or used in Python logic
`Medium` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §13`  
**Where:** `python/nexus/jobs/queue.py:18-24`  

**Problem.** `PENDING = 'pending'`, `RUNNING = 'running'`, `SUCCEEDED = 'succeeded'`, and `TERMINAL_STATUSES = frozenset({SUCCEEDED, DEAD})` are defined as module-level exports. None of them are imported anywhere outside queue.py. `PENDING`, `RUNNING`, and `SUCCEEDED` are only referenced by the `TERMINAL_STATUSES` definition; `TERMINAL_STATUSES` is never referenced at all. All queue state transitions use the string literals directly inside SQL strings. Only `DEAD` and `FAILED` are used in Python logic (in `fail_job`). The four unused names are dead exports that widen the public surface without being called.

**Fix.** Delete `PENDING`, `RUNNING`, `SUCCEEDED`, and `TERMINAL_STATUSES`. Retain `DEAD` and `FAILED` since they are used in `fail_job` at lines 547, 551, and 582. If a typed status enum is wanted in the future, introduce a proper `JobStatus` enum and replace the SQL string literals too; half-measures (constants that are not used) add noise.

#### 🟠 5. Task handlers bypass the worker's injected session_factory by calling global get_session_factory()
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `docs/rules/layers.md (Service dependencies must be explicit — function parameters, not globals)`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/tasks/reconcile_stale_ingest_media.py:89-90` · `python/nexus/tasks/prune_background_jobs.py:16` · `python/nexus/jobs/worker.py:42-71 (JobWorker.__init__ accepts session_factory)`  

**Problem.** `JobWorker` accepts an injectable `session_factory` parameter specifically to support testing and to keep the worker's DB dependency explicit. However, every task handler (all 17 registered kinds across all task files) acquires its own DB session by calling the global `get_session_factory()` rather than using the injected factory. The injected `session_factory` is therefore only used for the worker's own claim/heartbeat/complete operations. This means the worker's dependency injection is incoherent: it looks injectable but the actual work bypasses it. Tests work around this by patching `nexus.tasks.foo.get_session_factory` at import time, creating a production seam maintained only for tests.

**Fix.** Thread `session_factory: Callable[[], Session]` through task handler signatures as an explicit parameter (aligning with the `JobHandler` type which already accepts `**kwargs`). The worker calls `definition.handler(payload=claimed.payload, session_factory=self.session_factory)`. Each task unpacks it: `def reconcile_stale_ingest_media_job(*, request_id, session_factory)`. This removes the global `get_session_factory()` call from task bodies, eliminates the test-only patch seam, and makes the dependency boundary explicit as layers.md requires. The `JobHandler` type alias should be updated to `Callable[..., Mapping[str, Any] | None]` or typed with a Protocol.

#### 🟠 6. run_once runs five unrelated lifecycle phases in one 169-line function body
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`  
**Where:** `python/nexus/jobs/worker.py:73-241`  

**Problem.** `run_once` runs five sequential phases in a single 169-line function: (1) dead-letter expired jobs (lines 75-89), (2) claim and commit the next job (lines 91-100), (3) resolve the handler and fail-fast if kind is unknown (lines 102-120), (4) start heartbeat and verify ownership (lines 122-137), (5) invoke handler, interpret result, apply success/fail/dead-letter transition (lines 139-241). Each phase has independent error semantics and transaction boundaries. The mixture makes the control flow difficult to follow and means changes to any one phase must be reasoned against the full 169-line body.

**Fix.** Extract phases 1 and 2 into `_drain_dead_letters(db) -> bool` and `_claim_job() -> JobRow | None`, each a private method or module-level function. Extract phases 4-5 into `_execute_job(claimed, definition) -> None` covering heartbeat-start through success/fail dispatch. `run_once` becomes a 20-30 line coordinator that calls these in sequence. The dead-letter path inside the handler result check (lines 161-165 and 225-229) is already handled by `_handle_dead_letter`; the duplication of that call site within the function can be collapsed with a helper.

#### 🟠 7. _wait_for_job_notification embeds raw psycopg driver access and two 60-line near-identical SQL blocks in one 176-line method
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `python/nexus/jobs/worker.py:383-558`  

**Problem.** `_wait_for_job_notification` is a 176-line method that handles AUTOCOMMIT connection management, raw psycopg driver access (`driver_connection.notifies(...)`), and two near-identical SQL blocks for next-job timing (with and without `allowed_kinds` filter). The method mixes transport-level concerns (LISTEN/UNLISTEN/psycopg notify loop) with business concerns (checking whether due jobs exist) in a single body. The SQL duplication is the same `allowed_kinds` branching problem as in queue.py.

**Fix.** Extract the two SQL blocks into a single `_query_next_job_timing(db, allowed_kinds) -> tuple[bool, float | None]` private function that applies the kind filter when non-None. Extract the psycopg LISTEN/notify loop into a `_listen_for_notify(driver_connection, allowed_kinds, deadline, stop_event) -> None` private function. `_wait_for_job_notification` becomes a ~30-line orchestrator that opens the AUTOCOMMIT connection, calls both helpers, and handles the fallback `stop_event.wait(timeout)` on exception.

#### 🟠 8. registry.py _build_default_registry is lru_cache-frozen with schedule settings baked in at first call
`Medium` · `Medium-confidence` · `Types` · rules: `cleanliness.md §3`, `cleanliness.md §7`  
**Where:** `python/nexus/jobs/registry.py:77-223`  

**Problem.** `_build_default_registry` is decorated with `@lru_cache(maxsize=1)`. It reads `settings.podcast_active_poll_schedule_seconds`, `settings.ingest_reconcile_schedule_seconds`, `settings.sync_gutenberg_catalog_schedule_seconds`, and `settings.background_job_prune_schedule_seconds` to set `periodic_interval_seconds` on four `JobDefinition`s. `get_settings()` is itself `@lru_cache`-decorated, so in production the baking is harmless. However, in tests that override settings between calls, the first call freezes schedule intervals for the process lifetime. The double-lru_cache coupling is fragile and hides the fact that the registry is effectively a module-level singleton whose periodic intervals depend on environment variables.

**Fix.** Either read the schedule values from settings at call time inside `get_default_registry` (without `lru_cache` on the inner builder), or make `periodic_interval_seconds` a property that reads settings lazily. The simpler fix: remove the `lru_cache` from `_build_default_registry` (retain it on `get_task_contract_version` where stability is required). Since `get_settings()` is already cached, there is no performance cost to re-reading settings on each registry access.

#### 🟡 9. Unreachable AssertionError at end of run_scheduler_once retry loop
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `python/nexus/jobs/worker.py:317`  

**Problem.** `raise AssertionError('Worker scheduler retry loop exhausted')` at line 317 is unreachable. The `for attempt in range(3)` loop can only exit normally (without `return` or `raise`) if all three iterations execute `continue`, which requires `attempt < 2 and is_serialization_failure(exc)`. On `attempt == 2`, the condition `attempt < 2` is False, so the `except OperationalError` block re-raises. The loop therefore always exits via `return inserted` (success) or `raise` (re-raised error). The AssertionError line can never be reached.

**Fix.** Delete line 317. If a defensive guard is wanted, restructure as an explicit `for attempt in range(3): ... else: raise AssertionError(...)` (using Python's `for...else` construct where `else` fires only on normal loop exit without `break`), but even that is not needed since the logic is already correct without it.

#### 🟡 10. enqueue_unique_job pre-check SELECT is a silent race-prone fast path that obscures the real uniqueness logic
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §4`  
**Where:** `python/nexus/jobs/queue.py:157-166`  

**Problem.** `enqueue_unique_job` opens with an unguarded `SELECT ... WHERE dedupe_key = :dedupe_key` before the savepoint INSERT. This pre-check is not inside a transaction and races with concurrent inserters. The correct uniqueness enforcement is the UNIQUE index + `IntegrityError` catch at lines 168-198. The pre-check's only effect is to return an existing row slightly earlier on the common (non-racing) path, but it duplicates the existing-row lookup that the `IntegrityError` path already performs via `existing_after_conflict`. The two code paths derive the same result from the same query, which is the definition of redundant logic.

**Fix.** Remove the pre-check SELECT (lines 157-166). The savepoint INSERT + IntegrityError catch already handles both the non-duplicate case and the concurrent-race case correctly. If the common-path performance benefit of avoiding a write attempt is desired, keep the pre-check but document clearly that it is a read-path optimisation and not the uniqueness enforcement. In that case rename the result variable (`optimistic_existing`) to make the race-prone nature explicit.


<a id="py-ingest-tasks"></a>
## Ingest tasks (video/podcast)  · `py-ingest-tasks`
*9 issues (4 High)*  

> **Verdict.** The four podcast task files (podcast_reindex_semantic.py, podcast_transcribe_episode.py, podcast_active_subscription_poll.py, podcast_sync_subscription.py) are clean thin dispatchers — they do input validation, open a session, delegate entirely to a service, and close the session. The real rot is concentrated in ingest_youtube_video.py (697 lines), which mixes three unrelated concerns — vendor HTTP I/O (YouTube Data API), domain persistence of transcript versions/segments/state, and the job entry-point orchestration — and duplicates four private functions that already exist in services/podcasts/transcripts.py, including one with a missing advisory lock that creates a race condition in transcript version allocation.


#### 🔴 1. ingest_youtube_video.py is a god file mixing HTTP adapter, persistence, and orchestration
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/tasks/ingest_youtube_video.py:1-697`  

**Problem.** The file contains five distinct concerns in a single 697-line module: (1) job entry point / orchestration (_do_ingest, lines 61-309), (2) YouTube Data API HTTP adapter (_fetch_youtube_metadata, lines 343-413), (3) YouTube metadata persistence (_persist_youtube_metadata, lines 416-457), (4) podcast_transcript_versions creation (_create_transcript_version, lines 460-520), (5) podcast_transcript_segments insertion (_insert_transcript_segments, lines 523-568), and (6) media_transcript_states upsert (_upsert_media_transcript_state, lines 616-697). Layers.md mandates that services hold business logic and edge adapters only translate; the YouTube Data API client and all persistence helpers belong in a service, not a task file.

**Fix.** Extract three units: (a) a `YouTubeMetadataClient` (or extend `youtube_transcripts.py` as a `youtube_data.py` service) that owns the HTTP call and response parsing for the YouTube Data API — it returns a typed `YoutubeMetadata` result, never raw dicts; (b) move `_persist_youtube_metadata` into the existing `services/metadata_enrichment.py` or `services/media.py` as an owned mutation (it already calls `replace_media_contributor_credits` from a service); (c) move `_create_transcript_version`, `_insert_transcript_segments`, and `_upsert_media_transcript_state` to `services/podcasts/transcripts.py` (see Duplication issues below). After extraction, `ingest_youtube_video.py` should be a thin task that: UUID-validates, opens a session, calls a single service function (analogous to how `podcast_transcribe_episode.py` calls `run_podcast_transcription_now`), and closes the session.

#### 🔴 2. Duplicate media_transcript_states upsert: _upsert_media_transcript_state vs _set_media_transcript_state
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/tasks/ingest_youtube_video.py:616-697` · `python/nexus/services/podcasts/transcripts.py:1757-1842`  

**Problem.** `_upsert_media_transcript_state` in the task file and `_set_media_transcript_state` in the service perform the same SELECT-then-INSERT-or-UPDATE on `media_transcript_states`. Both check for an existing row and branch into INSERT vs UPDATE. They differ only in parameter names and in that the task version raises RuntimeError on rowcount != 1 while the service version does not. There are now two owners of the same invariant and the task version is called 4 times (lines 97, 196, 216, 248, 602) within the task's own private logic — logic that should not exist there at all.

**Fix.** Delete `_upsert_media_transcript_state` from `ingest_youtube_video.py`. Move the ingest orchestration into `services/podcasts/transcripts.py` (or a new `services/youtube_video_ingest.py` service) and call `_set_media_transcript_state` there. If the rowcount assertion is correct, add it to the service version so the invariant has one owner.

#### 🔴 3. Duplicate podcast_transcript_versions creation without advisory lock (race condition)
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `python/nexus/tasks/ingest_youtube_video.py:460-520` · `python/nexus/services/podcasts/transcripts.py:2068-2139`  

**Problem.** `_create_transcript_version` in the task and `_create_next_transcript_version` in the service both deactivate existing versions then INSERT a new one with `COALESCE(MAX(version_no), 0) + 1`. The service version acquires `pg_advisory_xact_lock(hashtext('podcast-transcript-version:{media_id}'))` (line 2079) before allocating the version number to prevent concurrent duplicate assignments. The task version does not acquire this lock, so concurrent YouTube ingest retries for the same media item can produce duplicate `version_no` values.

**Fix.** Delete `_create_transcript_version` from `ingest_youtube_video.py` entirely. Route YouTube ingest through a new service function in `services/` that calls `_create_next_transcript_version` (which already has the lock). This also eliminates the race condition.

#### 🔴 4. YouTube Data API HTTP client embedded in task file instead of a service
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §8`, `layers.md`  
**Where:** `python/nexus/tasks/ingest_youtube_video.py:343-413`  

**Problem.** `_fetch_youtube_metadata` (lines 343-413) makes raw `httpx.get` calls to `settings.youtube_data_base_url/videos`, parses the response payload, and returns a dict. This is a vendor SDK / HTTP adapter that lives in a task file, violating the layering rule that edge adapters belong at the edge and services own capabilities. Compare: `services/youtube_transcripts.py` correctly isolates the YouTube transcript provider behind a service boundary. The YouTube Data API is also called separately from `services/browse.py` (line 611) for video search, which uses the same API key and base URL setting — a second uncoordinated caller of the same external resource.

**Fix.** Create `services/youtube_data.py` that owns all YouTube Data API interactions (both video metadata lookup and search). Expose typed functions: `fetch_youtube_video_metadata(provider_video_id) -> YoutubeVideoMetadata | None` and `search_youtube_videos(...) -> ...`. Move the HTTP call from `ingest_youtube_video.py:343-413` into this service. Update `browse.py` to call the same service function. The task and any future callers only call the typed service function — they never hold the API key or construct URLs.

#### 🟠 5. Duplicate podcast_transcript_segments insertion: _insert_transcript_segments vs _insert_transcript_segments_for_version
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `python/nexus/tasks/ingest_youtube_video.py:523-567` · `python/nexus/services/podcasts/transcripts.py:2142-2186`  

**Problem.** Both functions execute the same `INSERT INTO podcast_transcript_segments` loop row-by-row with identical column lists and parameter shapes. There is one canonical implementation in the service and a duplicated one in the task. They are functionally identical — the only difference is the function name.

**Fix.** Delete `_insert_transcript_segments` from `ingest_youtube_video.py`. After the broader refactor (see GodFile issue), call `_insert_transcript_segments_for_version` from the service.

#### 🟠 6. run_ingest_sync is a test seam on the task's public surface
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`  
**Where:** `python/nexus/tasks/ingest_youtube_video.py:51-58`  

**Problem.** `run_ingest_sync` (lines 51-58) is a public function on the task module whose only callers are tests (`tests/test_ingest_youtube_video.py` and `tests/real_media/`) and a live-provider test (`tests/live_providers/test_video_transcript_live.py`). Its body is a one-line delegation to the private `_do_ingest`. It exists to give tests a session-injecting entry point that bypasses the job handler. Cleanliness §11 prohibits production seams kept only for tests.

**Fix.** After moving the ingest logic into a proper service function (e.g., `services/youtube_video_ingest.py::run_youtube_video_ingest(db, media_id, actor_user_id, ...)`), tests can call that service function directly with an injected session. Delete `run_ingest_sync` from the task file.

#### 🟡 7. run_podcast_active_subscription_poll_now is a test seam on a task file
`Low` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`  
**Where:** `python/nexus/tasks/podcast_active_subscription_poll.py:48-65`  

**Problem.** `run_podcast_active_subscription_poll_now` (lines 48-65) is a public function in a task file whose only external callers are integration tests (`tests/test_podcasts.py:4458-4462`). The function owns the `sync_lease_seconds` default derivation from settings, then delegates to the service. The file comment acknowledges it is shared by tests. This is a production seam kept only for tests.

**Fix.** Move the `sync_lease_seconds` settings derivation into `services/podcasts/sync.py::run_scheduled_active_subscription_poll` itself (as a defaulted parameter or computed internally), making the service fully self-contained. Tests can then call the service directly. Delete `run_podcast_active_subscription_poll_now` from the task file.

#### 🟡 8. _rebuild_transcript_content_index_for_version is a one-use hollow wrapper
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `python/nexus/services/podcasts/transcripts.py:2189-2203`  

**Problem.** `_rebuild_transcript_content_index_for_version` (lines 2189-2203) is a private function that does nothing except call `rebuild_transcript_content_index` with the same parameters in the same order, adding no logic or error handling. It is a hollow pass-through wrapper.

**Fix.** Inline the three call sites (`run_podcast_transcription_now` line 1428, `repair_podcast_transcript_semantic_index_now` line 1656) to call `rebuild_transcript_content_index` directly. Delete `_rebuild_transcript_content_index_for_version`.

#### 🟡 9. Module docs for video and podcast are empty — design intent is undocumented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `python/nexus/tasks/../../../docs/modules/video.md` · `python/nexus/tasks/../../../docs/modules/podcast.md`  

**Problem.** Both `docs/modules/video.md` and `docs/modules/podcast.md` are empty files (1 line, no content). The audit instructions treat module docs as the intended design to compare code against. With no design intent recorded, there is no authoritative boundary to enforce, making it impossible to detect further drift between what the code does and what it should own.

**Fix.** Write module docs that capture: (a) what each module owns (ingest pipeline stages, state machine, provider boundaries), (b) the public contract of each service, (c) which tables each module owns, and (d) which other modules may call into it. This unblocks future audit correctness checks.


<a id="py-auth"></a>
## Auth (backend)  · `py-auth`
*6 issues (2 High)*  

> **Verdict.** The auth slice is generally clean at the macro level — middleware, permissions, verifier, and the extension/handoff services are each focused. The two high-value issues are: (1) `nexus/auth/stream_token.py` is a full service (DB retries, JTI persistence, JWT signing and verification) housed in the auth adapter layer rather than `nexus/services/`, and (2) the SSE tail loop is duplicated nearly verbatim twice inside `stream.py` and the `STREAM_IDLE_TTL_SECONDS`/`KEEPALIVE_INTERVAL_SECONDS` constants and the `_format_sse_event` helper are re-declared in `media_events.py`, pointing to a missing shared SSE utility. A smaller but concrete cleanliness violation is the dead middleware bypass entries for `/stream/conversations/` paths that no longer have any registered route handlers.


#### 🔴 1. stream_token.py is a full service living in the auth adapter layer
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §8`, `layers.md (Services hold business logic, no HTTP/framework types)`  
**Where:** `python/nexus/auth/stream_token.py:1-217` · `python/nexus/api/routes/stream_tokens.py:15` · `python/nexus/api/routes/oracle.py:10`  

**Problem.** stream_token.py lives at nexus/auth/ alongside framework-facing adapters (middleware, verifier), but it owns a full service capability: JWT signing key decoding, token minting, token verification, JTI replay-prevention DB writes with a serializable-isolation retry loop, and integrity-conflict detection. The auth/ package is the adapter boundary (JWT parsing, header extraction); real business logic and owned persistence belong in nexus/services/. Having DB retries and raw SQL inside the auth layer breaks the layers.md rule that services hold business logic and no HTTP/framework types. Route handlers in stream_tokens.py and oracle.py import directly from nexus.auth.stream_token rather than from a service.

**Fix.** Move stream_token.py to nexus/services/stream_tokens.py (or nexus/services/stream_token.py). Expose a clean public interface: `mint_stream_token(user_id: UUID) -> StreamTokenResult` (named dataclass/TypedDict, not bare dict), and `verify_stream_token(token: str) -> tuple[UUID, str]`. Keep the JTI-claim retry/persistence as internal service logic. Update imports in stream_tokens.py route, oracle.py route, and stream.py route.

#### 🔴 2. Dead auth-bypass entries in middleware for removed /stream/conversations/ routes
`High` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2 (dead branches kept for routes that no longer exist)`, `cleanliness.md §3 (finished-era code)`  
**Where:** `python/nexus/auth/middleware.py:149-152` · `python/tests/test_conversations.py:941-962`  

**Problem.** Lines 149-152 of middleware.py bypass Supabase auth for paths starting with `/stream/conversations/` and ending with `/messages`, and for `/stream/conversations/messages`. The test class `TestRemovedStreamingRoutesReturnNotFound` (test_conversations.py:941) documents that these routes were explicitly removed and now return 404. No handler registers these paths anywhere in the codebase. The bypass entries are dead guards for a removed route set, kept after the deletion of the original streaming endpoints.

**Fix.** Delete lines 149-152 from AuthMiddleware.dispatch (the two conditions matching /stream/conversations/ paths). Delete the `TestRemovedStreamingRoutesReturnNotFound` test class from test_conversations.py as it exists only to prove a dead format stays dead (cleanliness.md §11).

#### 🟠 3. Bearer token extraction repeated in three places without a shared helper
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4 (collapse repeated logic to one owner)`, `cleanliness.md §7 (remove one-use copies only when they hide real complexity)`  
**Where:** `python/nexus/auth/extension.py:19-23` · `python/nexus/api/routes/extension_sessions.py:42-45` · `python/nexus/api/routes/stream.py:38-47`  

**Problem.** Three call sites independently implement the same bearer token extraction pattern: check `authorization.lower().startswith("bearer ")`, slice `authorization[7:].strip()`, raise or return on empty token. This is the same parsing logic the middleware already encapsulates in `_extract_bearer_token`. Any change to the parsing rule (e.g., case normalization, empty-token handling) must be made in three places.

**Fix.** Extract `_parse_bearer_token(header_value: str | None) -> str` to a shared private helper in nexus/auth/middleware.py (or a new nexus/auth/_parse.py). It should raise ApiError(E_UNAUTHENTICATED) on missing/malformed input and return the raw token string on success. Replace all three call sites with a call to this helper.

#### 🟠 4. SSE tail-loop logic duplicated twice inside stream.py; constants and format helper re-declared in media_events.py
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4 (collapse repeated logic, identical branches)`, `cleanliness.md §5 (split functions running unrelated phases)`  
**Where:** `python/nexus/api/routes/stream.py:100-147` · `python/nexus/api/routes/stream.py:204-242` · `python/nexus/api/routes/media_events.py:30-31` · `python/nexus/api/routes/media_events.py:131-133`  

**Problem.** `_tail_chat_run_events` (stream.py:100-147, ~48 lines) and `_tail_oracle_reading_events` (stream.py:204-242, ~39 lines) are structurally near-identical: both loop over listener.notifications(), check disconnect, call run_in_threadpool to read events, yield _format_sse_event, track close_reason, emit keepalives, and close the listener in a finally block. Only the service call and event schema differ. Additionally, `STREAM_IDLE_TTL_SECONDS`, `KEEPALIVE_INTERVAL_SECONDS`, and `_format_sse_event` are copy-declared in both stream.py and media_events.py. The two `_format_sse_event` signatures differ only in the optional `seq` (id) field.

**Fix.** Extract a shared `_tail_sse_events` generic coroutine or async context-manager in a new nexus/api/routes/_sse.py module. It should accept a `read_fn: Callable[[int], Awaitable[tuple[list[T], bool]]]`, a listener, and cursor/request parameters, yielding SSE frames. Export the shared constants and a single `format_sse_event(event_type, payload, seq=None)` helper. `stream.py` and `media_events.py` call this shared utility. This collapses the duplicated loop, the duplicated constants, and the mismatched format helpers into one place.

#### 🟡 5. SHA-256 token hashing re-implemented in extension_sessions.py and auth_handoff_codes.py
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4 (same logic, two owners)`, `cleanliness.md §7 (inline only when the copy is truly local and small)`  
**Where:** `python/nexus/services/extension_sessions.py:66-67` · `python/nexus/services/auth_handoff_codes.py:73-74`  

**Problem.** Both services define a private `_hash`/`_hash_extension_token` function that is identical: `hashlib.sha256(value.encode('utf-8')).hexdigest()`. nexus/hashing.py already exists as a shared hashing module but it only exposes `stable_json_hash`. The two `_hash` implementations are not semantically distinct; they both apply raw SHA-256 to a UTF-8 string.

**Fix.** Add `def sha256_hex(value: str) -> str` to nexus/hashing.py. Replace both `_hash` / `_hash_extension_token` private functions with imports from nexus.hashing. This gives one owner for the primitive and removes the duplication risk (e.g., if salt or encoding strategy changes).

#### 🟡 6. mint_stream_token returns an untyped bare dict, forcing string-keyed access at every call site
`Low` · `High-confidence` · `Types` · rules: `cleanliness.md §9 (make illegal states unrepresentable)`, `cleanliness.md §8 (typed inputs/outputs at service boundaries)`  
**Where:** `python/nexus/auth/stream_token.py:43` · `python/nexus/api/routes/oracle.py:34-44` · `python/nexus/api/routes/stream_tokens.py:41-42`  

**Problem.** `mint_stream_token` is annotated `-> dict` and callers access `stream_token["token"]`, `stream_token["stream_base_url"]`, `stream_token["expires_at"]` by string key (oracle.py:35,41,44). Any key rename or addition silently passes type checking. oracle.py also applies `.rstrip("/")` and `str()` casts on values, indicating the caller cannot trust the types.

**Fix.** Define a `StreamTokenResult` dataclass or TypedDict with fields `token: str`, `stream_base_url: str`, `expires_at: str` in the stream_token module (or its new services home). Change `mint_stream_token` to return it. Callers use attribute access instead of string subscripts, and type errors become compile-time.


<a id="py-app-infra"></a>
## App bootstrap / config / infra  · `py-app-infra`
*7 issues (1 High)*  

> **Verdict.** The slice is overall clean in the small modules (coerce.py, hashing.py, text.py, timestamps.py, retry_after.py, seq.py, errors.py, responses.py, middleware files, cli.py, llm_catalog.py) — each is narrow and well-formed. The worst rot is in config.py (693 lines, 115 fields, a single 229-line validator that owns every subsystem's validation rules) which is a classic god file, and a secondary duplication issue between real_media_provider_fixtures_requested() and settings.real_media_provider_fixtures that creates two access paths for the same boolean. app.py has an extracted CORS validation that duplicates urlparse work across two branches and a test-only seam (skip_auth_middleware) kept in production. services/redact.py is misplaced in the services/ directory despite being a stateless cross-cutting log-guard utility.


#### 🔴 1. config.py is a god file: 115 fields and a 229-line mega-validator mixing 12+ subsystem concerns
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/config.py:66-693` · `python/nexus/config.py:402-631`  

**Problem.** The single Settings class contains 115 Field declarations covering auth, database, R2 storage, EPUB limits, podcasts, billing/Stripe, worker runtime, ingest recovery, background jobs, LLM providers, transcript embeddings, metadata enrichment, stream tokens, CORS, rate limiting, and key encryption. The validate_required_settings method is 229 lines validating all 12+ subsystems in one body. This violates the one-concern-one-owner rule and creates a massive blast radius for any subsystem change. Additionally, the TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS constant at line 28 couples the config module to the pgvector schema, and DEFAULT_WORKER_ALLOWED_JOB_KINDS at line 29 is only ever referenced in the field default — it has no external consumers.

**Fix.** Keep a minimal CoreSettings (nexus_env, database_url, pool settings, nexus_internal_secret) and extract per-subsystem config dataclasses or nested settings groups: AuthSettings (supabase_*), StorageSettings (r2_*, max_*_bytes, signed_url_expiry), PodcastSettings (podcast_*), BillingSettings (stripe_*, billing_*), WorkerSettings (worker_*), IngestSettings (ingest_*, epub_*), LLMSettings (openai_*, anthropic_*, gemini_*, deepseek_*, llm_*, enable_*), StreamSettings (stream_*), MetadataSettings (metadata_enrichment_*). Each group carries its own model_validator. The top-level get_settings() returns a composited Settings that imports and embeds the subsystem configs. This shrinks any one file to under 100 lines and makes cross-subsystem field discovery impossible. Move TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS to the semantic_chunks service that owns the schema constraint. Inline DEFAULT_WORKER_ALLOWED_JOB_KINDS as the literal string in the Field default.

#### 🟠 2. Duplicate access paths for real_media_provider_fixtures: settings field vs os.environ re-read
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `python/nexus/config.py:687-688` · `python/nexus/services/youtube_transcripts.py:11` · `python/nexus/services/podcasts/sync.py:22` · `python/nexus/services/node_ingest.py:88` · `python/nexus/services/rss_transcript_fetch.py:13` · `python/nexus/services/podcasts/provider.py:16`  

**Problem.** real_media_provider_fixtures_requested() at config.py:687 reads os.environ.get('REAL_MEDIA_PROVIDER_FIXTURES') directly, bypassing the cached settings object. The Settings class already exposes the same value as settings.real_media_provider_fixtures (line 155). Five callers import and use real_media_provider_fixtures_requested() while other callers (tasks/chat_run.py:62, tasks/ingest_youtube_video.py:345, llm_catalog.py:195) correctly use settings.real_media_provider_fixtures. This creates two access paths for one boolean that can return different values if Settings is overridden in tests but the env var is not.

**Fix.** Delete real_media_provider_fixtures_requested(). Update the five callers to call get_settings().real_media_provider_fixtures instead. The function adds no value over settings.real_media_provider_fixtures and risks divergence with the cached settings object.

#### 🟠 3. app.py validate_required_settings has a silent mutation fallback that violates fail-fast rules
`Medium` · `High-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §10`  
**Where:** `python/nexus/config.py:557-577`  

**Problem.** When PODCASTS_ENABLED=true but podcast_index_api_key/secret are missing in local/test, the validator silently sets self.podcasts_enabled = False (line 577) instead of starting without podcasts or requiring explicit opt-out. This is a silent fallback that hides misconfiguration. The mutation also uses a deferred import (import logging at line 570) which is non-idiomatic in a Pydantic validator and suggests the code was added as a patch. The rule says 'remove silent fallbacks that keep old behavior alive — fail fast'.

**Fix.** Remove the mutation. Either require the operator to explicitly set PODCASTS_ENABLED=false when credentials are absent (fail with a clear error in all envs), or accept that the flag is always respected as-is and enforce credentials only when the flag is true. Move the stdlib logging import to the top of the file. The current pattern hides a config mistake behind a silent mode change that persists for the process lifetime.

#### 🟡 4. app.py CORS startup validation duplicates urlparse work across two branches
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `python/nexus/app.py:318-368`  

**Problem.** The CORS setup block in create_app() computes urlparse(settings.app_public_url) and urlparse(settings.effective_stream_base_url) twice — once in the cors_origins-truthy branch (lines 320-321) and once in the falsy branch (lines 348-349). Both branches execute the identical cross-origin check. The condition (app_url.scheme, app_url.hostname, app_url.port) != (stream_url.scheme, stream_url.hostname, stream_url.port) is written in full in both places.

**Fix.** Extract a helper or compute the three variables before the if/else: app_url = urlparse(settings.app_public_url); stream_url = urlparse(settings.effective_stream_base_url); is_cross_origin = (app_url.scheme, app_url.hostname, app_url.port) != (stream_url.scheme, stream_url.hostname, stream_url.port). Then use is_cross_origin in both branches. This halves the URL parsing work and removes the code duplication.

#### 🟡 5. create_app has a test-only seam (skip_auth_middleware) kept in production code
`Low` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`  
**Where:** `python/nexus/app.py:223-292`  

**Problem.** The skip_auth_middleware parameter (defaulting to False) is explicitly documented as 'for testing' and is only ever passed as True from test files. This is a test-only injection point kept in production code, which cleanliness rule §11 says to remove. Production code must never branch on a test flag.

**Fix.** Remove skip_auth_middleware from create_app. Tests that need an app without auth should configure a test verifier that always passes (e.g. a stub SupabaseJwksVerifier), or override the verifier via a fixture. The test conftest already calls _create_app via a wrapper — that wrapper can inject a test verifier instead. This removes the flag branch from production and tests the real middleware wiring.

#### 🟡 6. services/redact.py is misplaced: it is a stateless log-guard utility, not a service
`Low` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `python/nexus/services/redact.py:1-89` · `python/nexus/middleware/request_id.py:24` · `python/nexus/auth/stream_token.py:18`  

**Problem.** redact.py is a pure stateless function (safe_kv) that validates log key names. It owns no capability, has no state, no DB dependency, no lifecycle — it reads os.environ once per call. Yet it lives in services/, which per cleanliness rule §8 is for capability-oriented modules that own state, invariants, persistence, and provider wiring. Placing it there forces middleware and auth modules to import from services/, blurring the layer boundary (layers.md says services must not import from route handlers or middleware, but the reverse is also a sign of misplaced ownership).

**Fix.** Move safe_kv and its constants (FORBIDDEN_KEYS, REDACTED_SUFFIXES, REDACTED_LOG_VALUE) into nexus/logging.py, which already owns all log context utilities. Update the five importing modules (request_id.py, stream_token.py, rate_limit.py, chat_runs.py, user_keys.py, enrich_metadata.py, chat_run_idempotency.py) to import from nexus.logging. Delete python/nexus/services/redact.py.

#### 🟡 7. me.py route imports raw ORM model WorkspaceSession and serializes it inline
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `layers.md`  
**Where:** `python/nexus/api/routes/me.py:12` · `python/nexus/api/routes/me.py:27-31`  

**Problem.** me.py imports the WorkspaceSession SQLAlchemy model directly (line 12) and defines _workspace_session_payload to extract two fields into a plain dict. This means the route handler knows the ORM model's internal structure (.state, .updated_at). The workspace_sessions service already returns WorkspaceSession objects, so the serialization responsibility leaks into the route. There is no typed output schema for this response shape.

**Fix.** Add a WorkspaceSessionOut Pydantic model to nexus/schemas/workspace_session.py with state and updated_at fields. Update the workspace_sessions service to return WorkspaceSessionOut (or have it accept a WorkspaceSession and return WorkspaceSessionOut). Remove the _workspace_session_payload helper from me.py and the direct ORM import. The route then calls model.model_dump(mode='json') like all other routes.


# Part B — Frontend (`apps/web`)


<a id="fe-media-pane"></a>
## MediaPaneBody god component  · `fe-media-pane`
*9 issues (2 High)*  

> **Verdict.** MediaPaneBody.tsx is a 5030-line god component that simultaneously owns: initial media loading, EPUB navigation and section fetching, web-article fragment loading, transcript provisioning polling, resume-state reading and writing, three separate scroll-restoration state machines, highlight loading with a manual version-guard, highlight CRUD mutations, selection capture and popover lifecycle, PDF controls state, quote-to-chat state (pending quote, secondary chat, surface reveal), focus-mode keyboard bindings, reader theme management, pane chrome injection (toolbar, header options, fixed ruler), overview-ruler activation routing, and the full JSX render tree that branches across six media types. There is no single extractable concern here; the component mixes data fetching, business logic, DOM side effects, and rendering for every reader type it supports. The worst rot is the unbounded accumulation of state (37 useState, 46 useEffect, 55 useCallback, 29 useMemo) that belongs to at least four distinct behavioral units, and the three structurally identical scroll-retry loops inlined inside useEffect bodies rather than extracted to a shared primitive.


#### 🔴 1. MediaPaneBody is a 5030-line god component mixing all reader concerns
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:407-5030`  

**Problem.** A single React component owns: media loading and polling (lines 1100-1288), EPUB navigation + section fetching + restore state machine (1290-2031), web-article navigation (1479-1512), transcript fragment management (539-544, 797-827), three independent scroll-restoration loops (1549-2031, 2353-2451), highlight loading with manual version counter (2037-2114), highlight CRUD mutations (2740-3083), text selection capture + popover orchestration (622-695, 2622-2731), quote-to-chat state machine (3084-3710), PDF controls state (559-562, 3328-3407), focus-mode keyboard bindings (3409-3460), pane chrome injection (3740-4159), overview-ruler activation routing (4359-4477), and a branching JSX render tree covering 6 media types (4714-5030). This violates the rule that god files must be split along unrelated concern boundaries, and that each service must own a capability end-to-end with a small public interface.

**Fix.** Extract the following custom hooks and sub-components, each with a clearly typed boundary: (1) `useMediaData(mediaId)` — media fetch, fragment fetch, processing-status subscription, metadata retry polling. Exposes `{ media, fragments, loading, error, retryMetadata, retryProcessing, refreshSource }`. (2) `useEpubReader(mediaId, navResource, resumeState, target)` — EPUB navigation state, active section, restore phase/request, section fetch. Exposes `{ sections, toc, activeSectionId, activeSection, sectionLoading, error, navigateToSection }`. (3) `useReaderRestore(contentRef, cursorRef, activeContent, ...)` — the three scroll-restoration loops and persist-on-scroll logic. Exposes `{ restorePhase, textRestoreSettled, cancelRestore }`. (4) `useHighlightState(mediaId, activeContent, isPdf)` — highlight loading (with version guard), all CRUD callbacks, selection capture, selection publish/clear. Exposes `{ highlights, mediaHighlights, selection, isCreating, createHighlight, updateHighlight, deleteHighlight, refreshMediaHighlights, handleContentClick, handleContentPointerOver, handleContentPointerOut, handleSelectionChange }`. (5) `useDocChatState(mediaId, capabilities, highlights, mediaHighlights)` — pending quote, secondary chat, openDocChat, quoteHighlightToNewChat/ExtantChat, openChatInSecondary, startChatInSecondary. Exposes a single `docChat` object. MediaPaneBody becomes a thin composer that calls these hooks and passes typed props to the existing leaf components.

#### 🔴 2. Three structurally identical RAF scroll-retry loops duplicated inline
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:1709-1773` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:1945-2019` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:2382-2440`  

**Problem.** Three useEffect bodies each independently implement a `let rafId / let attempts / const attemptScroll / window.requestAnimationFrame` retry loop with a `releaseChromeLock` pattern. All three share the same structure: acquire mobile-chrome lock, retry up to N frames until a target is found, release lock on success or exhaustion. The literal code is nearly identical: lines 1709-1773 (canonical text restore, maxAttempts=96), lines 1945-2019 (EPUB anchor fallback, MAX_ATTEMPTS=96), lines 2382-2440 (web-section anchor scroll, maxAttempts=48). The only variation is the target-finding predicate and the fallback behavior.

**Fix.** Extract a utility function `attemptScrollWithRetry({ findTarget, onSuccess, onGiveUp, maxAttempts, paneMobileChrome, lockKey })` that owns the RAF loop and chrome-lock lifecycle. Each of the three call sites provides its specific `findTarget` predicate and `onSuccess`/`onGiveUp` callbacks. The three useEffects collapse to three lines of setup + one call.

#### 🟠 3. TranscriptContentPanel re-implements buildReaderSurfaceStyle inline
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `docs/rules/module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx:55-67` · `apps/web/src/lib/reader/readerSurfaceStyle.ts:1-16`  

**Problem.** TranscriptContentPanel computes `readerFontFamily`, `readerSurfaceStyle`, and `readerSurfaceClassName` from `useReaderContext().profile` by hand (lines 55-67), manually inlining the font-stack strings and CSS variable names. The canonical owner for this derivation already exists at `readerSurfaceStyle.ts` and is used correctly in MediaPaneBody (line 3361). TranscriptContentPanel does not import or call `buildReaderSurfaceStyle`, so the font-stack literal and variable names are duplicated. A change to the font list or CSS variable name must be made in two places.

**Fix.** TranscriptContentPanel should import and call `buildReaderSurfaceStyle(profile)` instead of re-deriving the same CSSProperties object. The `readerSurfaceClassName` computation (identical to MediaPaneBody:3362-3366) should also be extracted into a helper (e.g., `buildReaderSurfaceClassName(theme, styles)`) in `readerSurfaceStyle.ts` or a sibling so both call sites share one owner.

#### 🟠 4. TranscriptStatePanel owns API fetches and fragment loading that cross ownership with MediaPaneBody
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `docs/rules/layers.md`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx:91-123` · `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx:113-115` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:1161-1196`  

**Problem.** TranscriptStatePanel independently calls `apiFetch('/api/media/{id}')` and `apiFetch('/api/media/{id}/fragments')` inside `refreshTranscriptState` (lines 91-123) and communicates the result upward through the `onTranscriptStateChange` callback into MediaPaneBody's `setMedia`/`setFragments`. MediaPaneBody also owns its own `setFragments` and media-fetch path (lines 1100-1159) and a separate `webFragmentsResource` for web-article fragments (lines 1207-1227). This means fragment state has two owners: the TranscriptStatePanel can write to it via the callback, and MediaPaneBody writes to it directly. The `TranscriptCapabilities` type (TranscriptStatePanel:23-30) and the `Media['capabilities']` type in MediaPaneBody are structurally the same capability set typed twice.

**Fix.** Move all API data fetching for transcript state and fragments into MediaPaneBody (or the proposed `useMediaData` hook). TranscriptStatePanel should receive `transcriptState`, `transcriptCoverage`, `capabilities`, and an `onRequestTranscript` command — it should never call `apiFetch` directly. The `refreshTranscriptState` callback that fetches fragments should live in the parent hook and be passed down as a typed command. This gives fragment state a single owner. The `TranscriptCapabilities` type in TranscriptStatePanel should be removed; the component should reference `Media['capabilities']` or a shared type from the media module.

#### 🟠 5. docs/modules/video.md and docs/modules/epub.md are empty stubs despite active code
`Medium` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`, `cleanliness.md §13`  
**Where:** `docs/modules/video.md` · `docs/modules/epub.md`  

**Problem.** Both module documentation files are completely empty (0 lines). The reader-implementation.md names them as the design source for EPUB and video reader surfaces. MediaPaneBody.tsx contains substantial EPUB restore, section navigation, and internal-link resolution logic (epubRestore.ts, epubHelpers.ts, lines 800-1465) and video embed/iframe logic (TranscriptPlaybackPanel.tsx). Engineers reading the module docs get no design context, constraints, or ownership boundaries — they fall back to reading the 5030-line god component to understand intent.

**Fix.** Either fill video.md and epub.md with the relevant subset of reader-implementation.md constraints (EPUB restore order, section navigation rules, internal-link contract; video embed allowlist, seek model) or delete the files and consolidate their content into reader-implementation.md so there is one authoritative place. Having named-but-empty doc files is worse than having no doc files because they create false expectation.

#### 🟠 6. Highlight version counter managed as a bare mutable ref across 8 scattered mutations
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:568-569` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:2040` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:2779` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:2809` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:2935` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:3006`  

**Problem.** `highlightVersionRef` is a `useRef<number>(0)` declared at line 569 that is incremented (`++highlightVersionRef.current`) in five separate closures: the load-highlights effect (line 2040), handleCreateHighlight (lines 2779, 2809), the edit-bounds effect (line 2935), and applyHighlightMutation (line 3006). Each consumer manually checks `version !== highlightVersionRef.current` to detect staleness. The invariant — "only the most recent fetch/mutation wins" — is spread across 8 call sites rather than owned by a single highlight-state unit.

**Fix.** This is the ownership boundary violation that `useHighlightState` (described in issue 1) would fix. Encapsulating `highlightVersionRef`, `highlights`, `mediaHighlights`, the load-on-fragment-change effect, and all mutation callbacks inside one hook eliminates the distributed counter management and makes the staleness invariant enforced in one place.

#### 🟡 7. normalizeTrackChapters called redundantly in both TranscriptPlaybackPanel and TranscriptContentPanel for the same chapters prop
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx:256-259` · `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx:68`  

**Problem.** Both TranscriptPlaybackPanel and TranscriptContentPanel receive the same `chapters: TranscriptChapter[]` prop (both ultimately sourced from `media.chapters ?? []` in MediaPaneBody) and each independently calls `normalizeTrackChapters(chapters)` to produce normalized chapters for rendering. Since both components are rendered together inside the transcript pane, the normalization runs twice on the same input.

**Fix.** Normalize `chapters` once in MediaPaneBody (or in the proposed `useMediaData` hook) and pass `normalizedChapters: GlobalPlayerChapter[]` to both panels. This collapses two normalization calls to one and removes `normalizeTrackChapters` as a direct dependency from both child components.

#### 🟡 8. Media interface defined twice: once in MediaPaneBody.tsx, once in mediaFormatting.ts
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `docs/rules/module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:191-220` · `apps/web/src/app/(authenticated)/media/[id]/mediaFormatting.ts:4-7`  

**Problem.** Two `Media` interfaces exist in the same route folder: `mediaFormatting.ts` defines `interface Media { title, contributors }` (lines 4-7), and MediaPaneBody.tsx exports `interface Media extends MediaProcessingSnapshot { ... }` with dozens of additional fields (lines 191-220). `buildCompactMediaPaneTitle` in mediaFormatting.ts uses `Pick<Media, 'title' | 'contributors'>` from its own narrower definition, while page.tsx imports the full `Media` from MediaPaneBody. There are two independently named `Media` interfaces in the same folder.

**Fix.** Remove the `interface Media` from mediaFormatting.ts. Change `buildCompactMediaPaneTitle` to accept `Pick<Media, 'title' | 'contributors'>` where `Media` is imported from a shared media types module (or from MediaPaneBody until the type moves to a lib location). This eliminates the duplicate definition.

#### 🟡 9. Inline readerSurfaceClassName computation not shared with buildReaderSurfaceStyle
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `docs/rules/module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:3362-3366` · `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx:65-67`  

**Problem.** Both MediaPaneBody and TranscriptContentPanel independently compute `readerSurfaceClassName` as `${styles.readerContentRoot} ${theme === 'dark' ? styles.readerThemeDark : styles.readerThemeLight}`. This logic is not part of `buildReaderSurfaceStyle` in `readerSurfaceStyle.ts`, so the theme-to-CSS-class mapping lives in two call sites. Changing the class names or theme logic requires editing both files.

**Fix.** Add a `buildReaderSurfaceClassName(theme, styles)` helper to `readerSurfaceStyle.ts` (or accept the CSS module tokens as parameters) so the theme-to-class mapping has one owner.


<a id="fe-pdf-reader"></a>
## PdfReader god component  · `fe-pdf-reader`
*8 issues (3 High)*  

> **Verdict.** PdfReader.tsx is a 2,369-line god component that fuses six distinct concerns into a single function body with 13 useState declarations, 28+ useRef declarations, and 40+ useCallback/useMemo hooks. The worst rot is the monolithic viewer-lifecycle + highlight-CRUD + selection-capture + resume-publish + overlay-render + mobile-chrome pipeline all running inside one component. The public API surface is inflated with a standalone PdfHighlightOut type that structurally duplicates PdfHighlight from lib/highlights/api.ts, and a MOBILE_SELECTION_STABILIZATION_DELAY_MS constant is independently declared in both PdfReader.tsx and MediaPaneBody.tsx at the same value. The module doc (reader-implementation.md) correctly describes the intended architecture but the actual implementation has not been decomposed accordingly.


#### 🔴 1. Split PdfReader god component into focused hooks and a thin render shell
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/components/PdfReader.tsx:475-2369`  

**Problem.** The entire default export PdfReader is 1,895 lines of inline logic covering at least six unrelated concerns: (1) PDF.js viewer lifecycle — initializeViewerIfNeeded, attachDocumentToViewer, teardownViewer, openDocument, replaceDocument (lines 1053–1401); (2) signed-URL fetch + expiry recovery — loadSignedUrlAccess, signedUrlResource, requestSignedUrlRecovery, recoverAndRenderRef (lines 294–312, 565–568, 1383–1401, 1962–2021); (3) page-highlight fetch + CRUD — loadPageHighlights, pageHighlightsResource, handleCreateHighlight with inline apiFetch calls at lines 1628 and 1655; (4) text-layer selection capture — syncSelectionFromWindow, resolveTextLayerRootFromRange, buildSelectionQuads, buildAreaSelectionQuads, mobile timer management (lines 1403–1565); (5) highlight overlay DOM mutation — projectedHighlightRects useMemo + the DOM-writing useEffect at lines 2114–2190; (6) resume locator publishing — publishResumeLocator, readCurrentPageProgression, applyStartPageProgression, scroll listener at lines 599–824. Each concern owns its own state, refs, and timers but they are all entangled in one component body.

**Fix.** Decompose into: (a) usePdfViewerLifecycle(mediaId, containerRef, contentRef) — owns PdfJs/PdfJsViewer loading, EventBus wiring, document open/replace/destroy, run-counter cancellation, exposes { viewer, eventBus, runRef, teardown }; (b) usePdfSignedUrl(mediaId) — owns the signed-URL fetch (useAsyncResource), expiry tracking, recovery token; (c) usePdfPageHighlights(mediaId, pageNumber, refreshToken) — owns the per-page highlight fetch and CRUD mutations, exposing { highlights, handleCreate, mutate }; (d) usePdfSelectionCapture(viewerState) — owns selectionchange + polling, text-layer root resolution, quad building, mobile timer, exposing { selection, clearSelection }; (e) usePdfHighlightOverlay(pageElement, projectedRects, handlers) — owns the DOM overlay layer creation/removal; (f) usePdfResume(containerRef, pageNumberRef, zoomRef, numPages) — owns scroll listener, progression math, onResumeStateChange publishing. PdfReader.tsx becomes a thin shell that composes these hooks and renders the viewport div, SelectionPopover, and status notices.

#### 🔴 2. Consolidate PdfHighlightOut into PdfHighlight from lib/highlights/api.ts
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/components/PdfReader.tsx:70-95` · `apps/web/src/lib/highlights/api.ts:53-60`  

**Problem.** PdfHighlightOut (exported from PdfReader.tsx, lines 70–95) and PdfHighlight (exported from lib/highlights/api.ts, lines 53–60) are structurally identical: both carry `id`, the same `anchor: { type: 'pdf_page_geometry', media_id, page_number, quads }`, `source_version?`, `color`, `exact`, `prefix`, `suffix`, `created_at`, `updated_at`, `author_user_id`, `is_owner`, `linked_conversations?`, and `linked_note_blocks?`. The only structural difference is that PdfHighlightOut inlines the note-block shape anonymously whereas PdfHighlight inherits it from HighlightLinkedNoteBlock, but both shapes are field-for-field identical. MediaPaneBody.tsx must import PdfHighlightOut from the component file (line 30) and separately import PdfHighlight-related utilities from lib/highlights/api.ts, creating two parallel type identities for the same API object.

**Fix.** Delete PdfHighlightOut. Replace all usages in PdfReader.tsx and MediaPaneBody.tsx with PdfHighlight from @/lib/highlights/api. The linked_note_blocks field is already typed as HighlightLinkedNoteBlock[] there. Update loadPageHighlights return type and handleCreateHighlight to use PdfHighlight. This removes the export of PdfHighlightOut from the component file, shrinking its public surface.

#### 🔴 3. Move PDF highlight fetch and CRUD mutations out of the component into lib/highlights/api.ts
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/components/PdfReader.tsx:314-328` · `apps/web/src/components/PdfReader.tsx:1623-1668` · `apps/web/src/lib/highlights/api.ts:102-163`  

**Problem.** loadPageHighlights (PdfReader.tsx:314–328) fetches `/api/media/{id}/pdf-highlights` using apiFetch with inline response typing via PdfHighlightListResponse and PdfHighlightCreateResponse. The create and patch paths inside handleCreateHighlight (PdfReader.tsx:1628 and 1655) also call apiFetch inline with JSON bodies. lib/highlights/api.ts already owns createHighlight, updateHighlight, deleteHighlight, fetchHighlights, and fetchMediaHighlights; it is the designated owner for all highlight API calls but has no PDF per-page fetch or PDF create/patch functions. Business logic (which quads to use, area vs. text fallback) is thus entangled with transport in the component body.

**Fix.** Add fetchPdfPageHighlights(mediaId, pageNumber, signal): Promise<PdfHighlight[]>, createPdfHighlight(mediaId, params), and patchPdfHighlightAnchor(highlightId, params) to lib/highlights/api.ts using PdfHighlight as the return type. Remove loadPageHighlights, PdfHighlightListResponse, and PdfHighlightCreateResponse from PdfReader.tsx. The inline apiFetch calls in handleCreateHighlight (lines 1628 and 1655) delegate to the new api.ts functions.

#### 🟠 4. Remove duplicate MOBILE_SELECTION_STABILIZATION_DELAY_MS constant
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/components/PdfReader.tsx:221` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:340`  

**Problem.** MOBILE_SELECTION_STABILIZATION_DELAY_MS = 180 is independently declared in both PdfReader.tsx (line 221) and MediaPaneBody.tsx (line 340). Both files use it in structurally identical mobile selection debounce patterns. Two owners for the same constant value means they can silently diverge.

**Fix.** Move MOBILE_SELECTION_STABILIZATION_DELAY_MS to a shared module such as lib/ui/selectionConstants.ts, or co-locate it with the mobile selection hook if the selection-capture concern is extracted as recommended in the god-file issue. Import from one canonical source in both files.

#### 🟠 5. markPageSurfaceForTesting is a production seam kept only for tests
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`  
**Where:** `apps/web/src/components/PdfReader.tsx:836-896` · `apps/web/src/components/PdfReader.tsx:1231-1234` · `apps/web/src/components/PdfReader.tsx:1253`  

**Problem.** markPageSurfaceForTesting (lines 836–896) is a 60-line useCallback that on every pagesloaded and pagerendered event writes data-testid attributes to PDF page DOM elements and sets data-nexus-page-scale, data-nexus-page-rotation, data-nexus-page-viewport-width, data-nexus-page-viewport-height, and data-nexus-page-dpi-scale attributes. These DOM attribute writes run in production on every page render cycle. The function name and the data-testid pattern make the testing purpose explicit. This is a production seam kept only so that tests can read internal geometry without accessing component refs.

**Fix.** Remove markPageSurfaceForTesting and its two call sites (lines 1231–1234 and 1253). If E2E or browser tests need page geometry, refactor them to assert on observable rendered behavior (canvas bounds, scroll position, highlight overlay position) rather than on internal geometry attributes written by the component. If the data-nexus-* attributes are used for coordinate-transform assertions in tests, move those assertions to unit tests of the coordinate-transform utilities which already live in lib/highlights/coordinateTransforms.ts.

#### 🟠 6. Domain types exported from a rendering component inflate its public surface and violate ownership
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/components/PdfReader.tsx:97-147` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:30-35`  

**Problem.** PdfHighlightNavigationRequest, PdfTemporaryHighlight, PdfReaderControlsState, PdfReaderControlActions, and PdfReaderIntrinsicWidthState are all exported from PdfReader.tsx (lines 97–147). MediaPaneBody.tsx imports four of them from the component file (lines 31–34). Domain-level and interface-contract types (what a highlight navigation request carries, what the controls state shape is) should not be owned by a rendering component. Having MediaPaneBody reach into a rendering component's exports for domain types is a layering violation that locks the split order: you cannot extract the hooks without also updating MediaPaneBody's imports.

**Fix.** Move PdfHighlightNavigationRequest, PdfTemporaryHighlight, PdfReaderControlsState, PdfReaderControlActions, and PdfReaderIntrinsicWidthState to lib/reader/pdfReaderTypes.ts. PdfHighlightOut should be consolidated with PdfHighlight in lib/highlights/api.ts (see the Duplication issue). PdfReader.tsx should export only its default component function.

#### 🟠 7. loadSignedUrlAccess and signedUrlAccessFromResponse are transport-layer functions living in a rendering component
`Medium` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `layers.md`  
**Where:** `apps/web/src/components/PdfReader.tsx:57-68` · `apps/web/src/components/PdfReader.tsx:294-312`  

**Problem.** PdfFileAccessResponse, SignedUrlAccess, signedUrlAccessFromResponse, and loadSignedUrlAccess are module-scope types and functions in PdfReader.tsx that parse the /api/media/{id}/file response envelope and map it to a typed value. Per layers.md, edge adapters (API fetch + response parsing) must not live inside rendering components. These are transport-layer concerns that belong alongside the other API fetch functions.

**Fix.** Move PdfFileAccessResponse, SignedUrlAccess, signedUrlAccessFromResponse, and loadSignedUrlAccess to a new lib/media/pdfAccess.ts (or extend an existing media API module). Import SignedUrlAccess and loadSignedUrlAccess in the viewer lifecycle hook rather than in the component file.

#### 🟡 8. recoverAndRenderRef is a staging ref that papers over a forward-reference only
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `apps/web/src/components/PdfReader.tsx:1109-1112` · `apps/web/src/components/PdfReader.tsx:1264` · `apps/web/src/components/PdfReader.tsx:1300` · `apps/web/src/components/PdfReader.tsx:1397-1401`  

**Problem.** recoverAndRenderRef (line 1109) is a useRef holding a reference to requestSignedUrlRecovery so that the event handlers inside initializeViewerIfNeeded (lines 1264 and 1300) can call it without a stale closure. It exists solely to route around the circular dependency between initializeViewerIfNeeded (which closes over its runId parameter) and requestSignedUrlRecovery (which is defined later). The ref is set via a useEffect at lines 1397–1401 that runs after every change to requestSignedUrlRecovery and clears on unmount. This is three moving parts (ref declaration, useEffect to keep it current, null-guard at call sites) that hide a single stable callback.

**Fix.** When extracting usePdfViewerLifecycle as recommended in the god-file issue, accept onSignedUrlExpired as a stable callback parameter. The hook stores it in its own latest-value ref internally. The recoverAndRenderRef, its setter useEffect, and the null-guards can then all be deleted.


<a id="fe-workspace-store"></a>
## Workspace store & pane routing  · `fe-workspace-store`
*9 issues (3 High)*  

> **Verdict.** store.tsx (1337 lines, now 1247 after a count recheck) is a god file: it owns the reducer, all 14 action handlers, the React Provider component, URL sync, event-listener registration, title-hint buffering, title-cache pruning, title resolution, two exported hook wrappers, and the deep-link merge algorithm. Title management alone accounts for roughly 250 lines of mixed state, effects, and exported types that have nothing to do with pane navigation. The go_back and go_forward reducer arms are the worst duplication: identical 7-field href-transition logic is inlined twice instead of delegating to the already-present applyPaneHrefTransition. Module docs (workspace.md, panes-tabs.md) are empty, so every drift finding is relative to cleanliness.md rules alone. The pane files (paneRouteModel, paneRuntime, paneSecondaryModel, paneIdentity) are cleanly scoped; the rot is concentrated in store.tsx and the schema.ts sanitizer which duplicates a secondary-pane consistency walk already present in store.tsx.


#### 🔴 1. store.tsx is a god file: split pane-title management into its own unit
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/lib/workspace/store.tsx:790-862` · `apps/web/src/lib/workspace/store.tsx:932-934` · `apps/web/src/lib/workspace/store.tsx:937` · `apps/web/src/lib/workspace/store.tsx:964-1116` · `apps/web/src/lib/workspace/store.tsx:1246-1273`  

**Problem.** store.tsx mixes pane navigation (reducer + dispatch) with an independent pane-title management subsystem. The title subsystem owns its own state (runtimeTitleByPaneId, pendingTitleHintByResourceKeyRef), three effects (cache pruning, pending-hint application, hint publication), two exported types (WorkspacePaneTitleRecord, WorkspacePaneTitleDescriptor), one exported type alias (WorkspacePaneTitleSource), one exported pure function (resolveWorkspacePaneTitle), and two internal helpers (upsertPaneTitleRecord, publishPaneTitleHint). All of this is unrelated to the navigation reducer and has callers outside the store (WorkspaceHost.tsx and CommandPalette.tsx import resolveWorkspacePaneTitle and WorkspacePaneTitleDescriptor directly). The navigation store should know nothing about title resolution.

**Fix.** Extract a dedicated usePaneTitleStore hook (or a usePaneTitles hook) into apps/web/src/lib/workspace/paneTitles.ts. It owns: the runtimeTitleByPaneId Map state, the pendingTitleHintByResourceKeyRef, upsertPaneTitleRecord, publishPaneTitleHint, publishPaneTitle, and the three related effects. The exported pure function resolveWorkspacePaneTitle and its types (WorkspacePaneTitleRecord, WorkspacePaneTitleDescriptor, WorkspacePaneTitleSource) move to apps/web/src/lib/workspace/paneTitleResolver.ts (or co-locate with the hook). store.tsx receives a publishPaneTitle callback and a runtimeTitleByPaneId ref from the hook, keeping only the navigation surface. WorkspaceStoreProvider wires them together. WorkspaceHost and CommandPalette import from the new module, not from store.

#### 🔴 2. store.tsx is a god file: extract the event-listener and URL-sync bridge into a dedicated hook
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/workspace/store.tsx:991-1054` · `apps/web/src/lib/workspace/store.tsx:1118-1129`  

**Problem.** store.tsx contains two effects with no relationship to pane-state reduction: (1) an event-listener registration effect that subscribes to window CustomEvents and postMessage for open-pane intents, drains a startup queue, and toggles paneGraphReady (lines 1007-1054); (2) a URL sync effect that reflects the active pane href into window.history.replaceState (lines 1118-1129). Both are transport-layer I/O that belong at the application boundary, not inside the state module. Mixing them here means store.tsx controls three orthogonal lifecycles: state, title caching, and I/O.

**Fix.** Extract a useWorkspaceUrlSync hook into apps/web/src/lib/workspace/useWorkspaceUrlSync.ts owning the URL-sync effect. Extract a useWorkspacePaneOpenEvents hook into apps/web/src/lib/workspace/useWorkspacePaneOpenEvents.ts owning the CustomEvent/postMessage subscription, queue drain, and setPaneGraphReady lifecycle. Both hooks accept a stable dispatch callback and workspacePrimaryMetrics. WorkspaceStoreProvider calls them after dispatch is available. The buildPaneForOpen and findPaneIdForOpen helpers (store.tsx:765-788) should move to whichever module owns the open-pane command, or to schema.ts if they are pure state constructors.

#### 🔴 3. go_back_pane and go_forward_pane inline the same href-transition logic instead of using applyPaneHrefTransition
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/lib/workspace/store.tsx:429-454` · `apps/web/src/lib/workspace/store.tsx:473-498` · `apps/web/src/lib/workspace/store.tsx:178-209`  

**Problem.** applyPaneHrefTransition (lines 178-209) already encapsulates: same-resource detection, width transition, secondary-pane preservation/drop, and history-mode branching. The go_back_pane and go_forward_pane arms (lines 429-454 and 473-498) each re-implement the same preserveResource/resolvePaneTransitionWidth/paneRouteAllowsSecondaryGroup tri-part pattern inline, identically, differing only in the history splice expression. The duplicated block is seven fields each, and each site had to be kept in sync with applyPaneHrefTransition.

**Fix.** Extend applyPaneHrefTransition with an optional history override parameter, or add a dedicated applyPaneHistoryNavigation helper that wraps applyPaneHrefTransition and accepts the target href and direction ('back'|'forward'). Both go_back_pane and go_forward_pane arms then become: (1) extract the target href from history, (2) call the shared helper, (3) splice the history array. This eliminates the three-field duplication and ensures future changes to the width-transition or secondary-pane rules propagate consistently.

#### 🟠 4. Secondary-pane consistency walk is duplicated between schema.ts and store.tsx
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/workspace/schema.ts:86-96` · `apps/web/src/lib/workspace/store.tsx:121-138`  

**Problem.** createWorkspaceStateFromPrimaryPanes in schema.ts (lines 86-96) and the private createWorkspaceState in store.tsx (lines 121-138) both walk primaryPanes to verify that each pane's attachedSecondaryPaneId has a matching secondaryPane record with the correct parentPrimaryPaneId, nulling out orphaned references and rebuilding secondaryPanesById. The store's wrapper adds a previous-state merge step but the core secondary-pane integrity walk is identical. Having two implementations means a change to the integrity rule must be applied in both places.

**Fix.** Delete createWorkspaceState from store.tsx. Callers that need the previous-state merge for secondary panes should either (a) pass the merged secondaryPanesById directly to createWorkspaceStateFromPrimaryPanes, or (b) the merge step becomes a one-liner before the call. The single owner of the secondary-pane consistency walk is schema.ts.

#### 🟠 5. mergeRestoredWorkspaceWithDeepLink is exported from store.tsx but is only called internally and from tests
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §2`  
**Where:** `apps/web/src/lib/workspace/store.tsx:225-298` · `apps/web/src/lib/workspace/store.test.tsx:10`  

**Problem.** mergeRestoredWorkspaceWithDeepLink is exported (line 225) but has exactly one non-test call site: inside WorkspaceStoreProvider at line 944 of store.tsx itself. The only reason it is exported is to make it directly testable. This is a production seam kept for tests, which cleanliness.md §11 calls out as a violation. The function belongs to the restore phase and is a private implementation detail of the provider.

**Fix.** Remove the export keyword. Test the deep-link merge behavior through the store's public surface (WorkspaceStoreProvider behavior under test), or move the tests to drive the applyRestoredState callback indirectly. If the function must remain unit-testable as a pure function, move it to a dedicated restore.ts module in lib/workspace and export it only from there with a narrow tested contract.

#### 🟠 6. WorkspaceStoreValue and WorkspaceHostStoreValue interfaces are unexported but form a split public contract
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/lib/workspace/store.tsx:868-906` · `apps/web/src/lib/workspace/store.tsx:908-910` · `apps/web/src/lib/workspace/store.tsx:1323-1337`  

**Problem.** Two hooks (useWorkspaceStore, useWorkspaceHostStore) are exported but return types inferred from unexported interfaces (WorkspaceStoreValue, WorkspaceHostStoreValue). Callers that need to type a variable holding the hook's return value must use ReturnType<typeof useWorkspaceStore>, which is awkward. More importantly, the split into two hooks exposes two interchangeable APIs for the same context value — WorkspaceHostStoreValue extends WorkspaceStoreValue and adds only dropSecondaryPane. This is a near-duplicate capability exposure that module-apis.md forbids.

**Fix.** Export a single hook and a single type. Since dropSecondaryPane is a host-internal concern used only by WorkspaceHost.tsx, move it out of the public hook into a separate non-hook mechanism (e.g., WorkspaceHost calls dispatch directly via a ref, or WorkspaceStoreProvider exposes a dropSecondaryPane callback through a secondary context that only WorkspaceHost imports). Then there is one public hook, one public interface type, one context.

#### 🟡 7. schema.ts and paneSecondaryModel.ts are marked 'use client' but contain no client-only APIs
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §1`, `layers.md`  
**Where:** `apps/web/src/lib/workspace/schema.ts:1` · `apps/web/src/lib/panes/paneSecondaryModel.ts:1` · `apps/web/src/lib/panes/paneRouteModel.ts:1`  

**Problem.** schema.ts, paneSecondaryModel.ts, and paneRouteModel.ts are pure data/logic modules with no browser globals, hooks, or event listeners. The 'use client' directive forces the entire Next.js bundler to treat these modules as client-only, preventing server components from importing them directly (e.g. for SSR-time URL parsing or static title resolution). sessionSync.ts is correctly marked 'use client' because it accesses browser APIs indirectly, but the other three have no such need.

**Fix.** Remove 'use client' from schema.ts, paneSecondaryModel.ts, and paneRouteModel.ts. They are isomorphic pure modules. Any file that actually uses browser APIs (store.tsx, openInAppPane.ts, paneRuntime.tsx, paneRouteRegistry.tsx) should keep or add the directive as appropriate.

#### 🟡 8. openInAppPane.ts sanitizes detail twice: once on enqueue and once on consume
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/lib/panes/openInAppPane.ts:61-73` · `apps/web/src/lib/panes/openInAppPane.ts:83-92`  

**Problem.** enqueuePendingPaneOpen (lines 61-73) calls sanitizeOpenPaneDetail on the incoming detail before pushing it to the queue. consumePendingPaneOpenQueue (lines 83-92) then calls sanitizeOpenPaneDetail again on every queued item when reading back. Since items can only enter the queue through enqueuePendingPaneOpen which already validated them, the second sanitize pass is redundant defensive re-validation of already-clean data.

**Fix.** The consume function should trust items already in the queue and perform a simple type cast, or the queue should be typed as OpenInAppPaneDetail[] and the second sanitize pass removed. Keep sanitization at the single entry point (enqueuePendingPaneOpen).

#### 🟡 9. Empty module docs for workspace.md and panes-tabs.md mean architectural intent is undocumented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/workspace.md` · `docs/modules/panes-tabs.md`  

**Problem.** Both module documentation files referenced in the audit slice are empty (one line each). The store slice is 1337 lines of non-trivial state machine, session sync, and routing model code. Without a module doc, there is no authoritative statement of ownership boundaries, what belongs in the workspace module vs. the panes module, or what the intended public contract of store.tsx is. Future engineers have no design reference to check code against, which is how god-file drift compounds.

**Fix.** Write workspace.md to document: (1) what WorkspaceState owns, (2) the pane reducer's responsibility boundary, (3) where session sync lives and why, (4) what belongs in schema.ts vs store.tsx. Write panes-tabs.md to document: (1) paneRouteModel as the route table, (2) paneRouteRegistry as the render binding layer, (3) paneRuntime as the per-pane context, (4) the secondary-pane group/surface model. These docs then serve as the contract against which future changes are validated.


<a id="fe-workspace-host"></a>
## Workspace host & pane shell  · `fe-workspace-host`
*11 issues (3 High)*  

> **Verdict.** WorkspaceHost.tsx (1194 lines) is a god file: it conflates five distinct concerns — pane publication-record management (upsert/prune for three independent record types), secondary-surface lifecycle orchestration, pane-canvas/focus/keybinding orchestration, pane descriptor assembly, and top-level render layout — all in one component body with 15+ helpers, 5 state/ref clusters, and 7 useEffect blocks. PaneShell.tsx (689 lines) mixes a mobile-chrome scroll-hide state machine, reduced-motion subscription, chrome-override context, resize wiring, and clipboard logic with the layout render. The module docs for workspace.md and panes-tabs.md are both empty (single blank line each), leaving the intended design undocumented. The worst rot is the publication-record subsystem (400+ lines of duplicated prune/upsert/get/normalize/equality helpers across three parallel tracks) sitting inside a single component function, plus the duplicated arePaneSecondaryPublicationsEqual between WorkspaceHost.tsx and PaneSecondary.tsx.


#### 🔴 1. WorkspaceHost: publication-record management is a hidden service embedded in a component
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/components/workspace/WorkspaceHost.tsx:90-103` · `apps/web/src/components/workspace/WorkspaceHost.tsx:327-540` · `apps/web/src/components/workspace/WorkspaceHost.tsx:644-770`  

**Problem.** WorkspaceHost.tsx contains three independent publication-record subsystems (runtime layout, secondary surface, fixed chrome), each with its own interface, upsert/delete reducer, normalize validator, equality checker, get accessor, and prune function — roughly 215 lines of pure data-management logic — plus the useState and useEffect wiring to drive them (another 90 lines), all inside the component body. This is a capability that owns state, invariants, and lifecycle rules; it belongs behind a hook boundary, not embedded in a render function.

**Fix.** Extract a `usePanePublicationRegistry` hook (or three narrower hooks: `useRuntimeLayoutRegistry`, `useSecondaryPublicationRegistry`, `useFixedChromePublicationRegistry`) that each own their Map state, the upsert/prune reducers, and the publish/get callbacks. Each hook accepts `currentResourceKeyByPaneId: Map<string, string>` and returns the typed get-accessor and publish callback. WorkspaceHost calls the hooks and composes their outputs into the pane build pass. The helpers (upsertOrDeletePaneLayoutRecord, prunePaneSecondaryPublicationRecords, etc.) become private to their hook module. Public contract: `{ publishLayout, getLayout }`, `{ publishSecondary, getSecondary }`, `{ publishFixedChrome, getFixedChrome }` — each taking/returning typed values already defined.

#### 🔴 2. WorkspaceHost: secondary-surface lifecycle orchestration mixes three unrelated concerns in one component
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/workspace/WorkspaceHost.tsx:848-886` · `apps/web/src/components/workspace/WorkspaceHost.tsx:912-946` · `apps/web/src/components/workspace/WorkspaceHost.tsx:948-985`  

**Problem.** The component body contains three distinct secondary-surface orchestration concerns: (1) a pending-secondary-surface queue effect that drains deferred requestSecondarySurface calls after navigation (lines 848-886); (2) an effect that drops or resets attached secondary panes whose group no longer matches the current publication (lines 912-946); (3) canUsePublishedSecondarySurface guard plus handleRequestSecondarySurface/handleSetSecondarySurface wrappers that enforce publication membership before dispatching (lines 948-985). Together these are 130+ lines of secondary-surface lifecycle policy living in a render component.

**Fix.** Extract a `useSecondarySurfaceOrchestrator` hook owning: the pendingSecondarySurfaceByResourceKeyRef queue and its drain effect; the group-mismatch drop/surface-correction effect; and the canUse, handleRequest, handleSet guards. The hook accepts `{ panes, primaryPanes, state, currentResourceKeyByPaneId, secondaryPublicationByPaneId, requestSecondarySurface, setSecondarySurface, dropSecondaryPane }` and returns `{ handleRequestSecondarySurface, handleSetSecondarySurface, openPaneWithPendingSecondary }`. WorkspaceHost calls it and passes outputs straight to PaneRuntimeFrame.

#### 🔴 3. PaneShell: 180-line mobile-chrome scroll-hide state machine is an unrelated embedded concern
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/workspace/PaneShell.tsx:260-442`  

**Problem.** PaneShell.tsx contains a self-contained mobile-chrome visibility state machine: mobileChromeHidden state, mobileChromeVisibleLocksRef lock map, scroll delta tracking, direction-change hysteresis, reduced-motion subscription (with deprecated addListener/removeListener fallback), ResizeObserver for chrome-height measurement, showMobileChromeNow, handleDocumentScroll, and acquireMobileChromeVisibleLock. This 180-line scroll-reveal controller has nothing to do with pane-shell layout structure and is not exposed via the component's props contract.

**Fix.** Extract `useMobileChromeVisibility({ isMobileDocumentPane, chromeRef })` returning `{ mobileChromeHidden, mobileChromeHeight, mobileChromeController, effectiveMobileChromeHidden }`. PaneShell calls the hook and uses its outputs for CSS class and style application. This also isolates the deprecated addListener removal (see LegacyCompat issue).

#### 🟠 4. WorkspaceHost: pane-chrome focus management and keybinding handler should be a hook
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/workspace/WorkspaceHost.tsx:655-656` · `apps/web/src/components/workspace/WorkspaceHost.tsx:1013-1087`  

**Problem.** The paneWrapRefById Map ref, pendingPaneChromeFocusPaneIdRef, the focus-on-activate effect (lines 1013-1032), handleActivatePane with its DOM focus-walk logic (lines 1038-1061), and the document keydown keybinding listener for pane-next/pane-previous (lines 1063-1087) are intertwined in the component body. Together they are ~75 lines of imperative DOM/focus/keyboard logic with no rendering output.

**Fix.** Extract a `usePaneChromeFocus` hook that owns paneWrapRefById, pendingPaneChromeFocusPaneIdRef, the focus-correction effect, the keybinding listener, and returns `{ paneWrapRef, handleActivatePane }`. The ref-callback pattern used in the JSX (setting/deleting from paneWrapRefById.current) becomes a stable ref-setter returned from the hook.

#### 🟠 5. arePaneSecondaryPublicationsEqual duplicated across WorkspaceHost.tsx and PaneSecondary.tsx
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/workspace/WorkspaceHost.tsx:382-401` · `apps/web/src/components/workspace/PaneSecondary.tsx:31-52`  

**Problem.** Both files define an identical function `arePaneSecondaryPublicationsEqual` with the same signature and the same field-by-field comparison logic (groupId, defaultSurfaceId, surfaces length, per-surface id/body/mobileBody). The canonical owner is PaneSecondary.tsx where the PaneSecondaryPublication type is defined. WorkspaceHost imports PaneSecondaryPublication from that module but re-defines the equality function locally.

**Fix.** Export `arePaneSecondaryPublicationsEqual` from PaneSecondary.tsx and delete the duplicate in WorkspaceHost.tsx. WorkspaceHost's normalizePaneSecondaryPublication and upsertOrDeletePaneSecondaryPublicationRecord import and use the shared function.

#### 🟠 6. Three structurally identical prune functions should collapse to one generic helper
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/workspace/WorkspaceHost.tsx:497-510` · `apps/web/src/components/workspace/WorkspaceHost.tsx:512-525` · `apps/web/src/components/workspace/WorkspaceHost.tsx:527-540`  

**Problem.** pruneRuntimePaneLayoutRecords, prunePaneSecondaryPublicationRecords, and prunePaneFixedChromePublicationRecords are structurally identical: all iterate Map<string, { resourceKey: string }>, delete entries whose resourceKey no longer matches, and return the (possibly same) map. The only difference is the generic type parameter.

**Fix.** Replace all three with a single generic `pruneRecordsByResourceKey<T extends { resourceKey: string }>(current: Map<string, T>, live: Map<string, string>): Map<string, T>` and delete the three typed duplicates. All three useEffect prune calls in WorkspaceHost use this single function.

#### 🟠 7. PaneShell: deprecated MediaQueryList.addListener/removeListener fallback should be removed
`Medium` · `High-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`  
**Where:** `apps/web/src/components/workspace/PaneShell.tsx:338-349`  

**Problem.** The reduced-motion effect branches to mediaQuery.addListener(update) / mediaQuery.removeListener(update) as a fallback when addEventListener is unavailable. These methods were removed from all modern browsers and are deprecated in remaining ones. This branch can never trigger in any supported environment and carries the deprecated API call.

**Fix.** Delete the addListener/removeListener branch (lines 344-349). The addEventListener/removeEventListener path already covers all supported browsers. Apply this deletion when extracting useMobileChromeVisibility.

#### 🟠 8. Module docs for workspace.md and panes-tabs.md are empty — design intent is absent
`Medium` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/workspace.md` · `docs/modules/panes-tabs.md`  

**Problem.** Both module documentation files exist but contain only a single blank line. There is no authoritative design description of what WorkspaceHost, PaneShell, or the pane-strip own, what their boundaries are, or what their public contracts are. The absence of design intent means code drift cannot be detected, and the god-file problems documented above have no spec to align against.

**Fix.** Write the module docs alongside the god-file split recommended above. workspace.md should describe WorkspaceHost's role as a thin pane-layout orchestrator and what it delegates. panes-tabs.md should describe PaneShell as a layout container, the tabstrip as an independent navigation UI, and the mobile-chrome behavior as a scroll-reveal controller.

#### 🟡 9. PaneShell: copyText/fallbackCopyText inline clipboard utility uses deprecated execCommand
`Low` · `High-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/workspace/PaneShell.tsx:49-68` · `apps/web/src/components/workspace/PaneShell.tsx:462-467`  

**Problem.** fallbackCopyText uses the deprecated document.execCommand('copy'). This is a private file-scope helper used only for the 'Copy pane link' option. Three other clipboard-write sites in the codebase (ReaderCitation.tsx:121, MarkdownMessage.tsx:81) use navigator.clipboard.writeText directly without the execCommand fallback, confirming the fallback is not used elsewhere and can be removed.

**Fix.** Delete fallbackCopyText. In copyPaneLink, inline navigator.clipboard.writeText(link) directly — the helper is too thin to justify its own function. The deprecated execCommand path is not needed in any supported browser environment.

#### 🟡 10. handleClosePane is a one-line passthrough wrapper that adds no value
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `apps/web/src/components/workspace/WorkspaceHost.tsx:1090-1095`  

**Problem.** handleClosePane is a useCallback wrapper around closePane(paneId) with no transformation or guard. It adds a level of indirection and a dependency array entry without hiding any complexity.

**Fix.** Delete handleClosePane and pass closePane directly to WorkspacePaneStrip as `onClosePane={closePane}`.

#### 🟡 11. PaneRuntimeFrame is a file-private component that only wraps context provider wiring
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/workspace/WorkspaceHost.tsx:166-301`  

**Problem.** PaneRuntimeFrame is a 135-line memo-wrapped component whose body consists entirely of useCallback adapters that rename arguments and provide paneId/resourceKey closure, then renders PaneRuntimeProvider > PaneSecondaryContext.Provider > PaneFixedChromeContext.Provider > PaneRouteBoundary. It is used in exactly one place (line 1129). The memo boundary may provide render-isolation benefit but is not documented as such.

**Fix.** Evaluate whether the memo boundary is load-bearing. If yes, document why with a comment. If no, inline the adapter callbacks at the call site and remove PaneRuntimeFrame as a separate construct. Either way the publish-callback adapters should be derived from the hooks recommended above, reducing the parameter list from 14 props to the outputs of `useSecondarySurfaceOrchestrator` and the publication registries.


<a id="fe-player"></a>
## Global player  · `fe-player`
*10 issues (2 High)*  

> **Verdict.** globalPlayer.tsx (1284 lines) is a god file that collapses four distinct concerns into one React context provider: (1) Web Audio API graph lifecycle and silence-trimming DSP, (2) playback queue state management and API mutations, (3) track/seek/volume/playback-rate control, and (4) React context wiring. GlobalPlayerFooter.tsx (722 lines) compounds the problem by rendering two completely separate layouts (mobile bottom-sheet and desktop footer bar) in a single component body, with the seek bar and skip/play/pause controls duplicated verbatim for each layout. These are the two highest-priority splits. The module docs for player.md and podcast.md are empty, so there is no authoritative design to drift from, but the code itself reveals the ownership problems clearly.


#### 🔴 1. globalPlayer.tsx is a god file mixing audio graph DSP, queue management, track control, and context wiring
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/lib/player/globalPlayer.tsx:1-1284` · `apps/web/src/lib/player/globalPlayer.tsx:219-411` · `apps/web/src/lib/player/globalPlayer.tsx:687-884`  

**Problem.** The 1284-line GlobalPlayerProvider body is responsible for at least four unrelated concerns in a single function body: (1) Web Audio API graph construction, wiring, and silence-trimming DSP (roughly 200 lines of refs, callbacks, and RAF loop: lines 219-479); (2) playback queue state management and API mutations — refreshQueue, addToQueue, removeFromQueue, reorderQueue, clearQueue, playQueueItem, playNextInQueue, playPreviousInQueue, currentQueueIndex, currentQueueItemId, upcomingQueueCount, hasNextInQueue, hasPreviousInQueue (roughly 200 lines: 687-884); (3) core playback control — setTrack, clearTrack, play, pause, retryPlayback, seekToMs, skipBySeconds, setVolume, setPlaybackRate, setAudioEffects plus their associated audio-element event listeners (lines 489-1108); (4) React context assembly and re-export (lines 1188-1284). These concerns have completely different dependencies, lifecycles, and state. Splitting them would let each unit be read, tested, and changed in isolation.

**Fix.** Extract three focused hooks: (1) `useAudioEffectsGraph(audioElementRef)` — owns all Web Audio API node refs, ensureAudioEffectsGraph, configureAudioEffectsGraph, markAudioEffectsUnavailable, resetAudioGraphNodes, applyUserPlaybackRateToAudio, startSilenceTrimming, stopSilenceTrimming, isSilenceTrimming, silenceTimeSavedSeconds, audioEffectsAvailable, and the AudioContext lifecycle cleanup effect. Returns a typed interface `{ ensureAndResume, apply, stop, isTrimming, timeSaved, available }`. (2) `usePlaybackQueue(track, playTrack)` — owns queueItems state, refreshQueue, addToQueue, removeFromQueue, reorderQueue, clearQueue, playQueueItem, playNextInQueue, playPreviousInQueue, currentQueueIndex, currentQueueItemId, upcomingQueueCount, hasNextInQueue, hasPreviousInQueue, and the PLAYBACK_QUEUE_UPDATED_EVENT listener. Returns a typed `QueueControls` interface. (3) `useAudioElementListeners(audioElement, deps)` — owns the large addEventListener/removeEventListener effect block. GlobalPlayerProvider then becomes a thin compositor: it calls these three hooks and the existing useListeningStatePersistence/useMediaSessionAdapter/usePlayerKeyboardShortcuts hooks, then assembles the context value.

#### 🔴 2. GlobalPlayerFooter.tsx is a god file: mobile bottom-sheet and desktop footer are two distinct UI components sharing one body
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §4`  
**Where:** `apps/web/src/components/GlobalPlayerFooter.tsx:261-499` · `apps/web/src/components/GlobalPlayerFooter.tsx:502-708`  

**Problem.** The 722-line default export renders entirely different UI trees for mobile (mini-bar + expanded bottom sheet) and desktop (full footer bar + more popover) inside a single isMobile branch. The seek bar (seekTrack + chapterTicks + seekSlider) is duplicated verbatim at lines 360-385 (mobile expanded) and 563-588 (desktop). The play/pause button is duplicated at lines 295-300, 418-423, and 546-551. Skip-back and skip-forward buttons are duplicated across lines 305, 410-414, 427-431, 536-541, and 555-560. The EffectsPanel sub-component is rendered in two separate conditional branches (lines 488-496 and 697-705). Altogether these two layouts are 250+ lines each with significant internal repetition.

**Fix.** Extract: (1) A `PlayerSeekBar` component taking `{ durationSafe, currentSafe, bufferedSafe, chapterMarkers, onSeek }` props — the single source of truth for the seek-track/chapter-ticks/slider block. (2) A `PlayerTransportControls` component taking `{ isPlaying, play, pause, onSkipBack, onSkipForward, onPrevious, onNext, hasNext }` props. (3) Split `GlobalPlayerFooterMobile` and `GlobalPlayerFooterDesktop` (or `GlobalPlayerMiniBar` / `GlobalPlayerExpandedSheet` / `GlobalPlayerDesktopBar`) as separate components. The outer `GlobalPlayerFooter` becomes a thin dispatcher that reads `useIsMobileViewport` and renders the appropriate component. Each sub-component calls `useGlobalPlayer()` itself for its slice of state rather than receiving a flat props list.

#### 🟠 3. Duplicate normalizeTrackText / normalize helpers across globalPlayer.tsx and mediaSession.ts
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/player/globalPlayer.tsx:160-166` · `apps/web/src/lib/player/mediaSession.ts:53-57`  

**Problem.** Both files contain an identical private function: trim a string and return undefined for empty/non-string values. globalPlayer.tsx calls it `normalizeTrackText` (line 160) and uses it to normalize track metadata before storing it in state. mediaSession.ts calls it `normalize` (line 53) and uses it for the same purpose when building MediaMetadata. The bodies are character-for-character the same.

**Fix.** Extract a shared `normalizeTrackString(value: string | null | undefined): string | undefined` to a small utility file (e.g., `apps/web/src/lib/player/trackTextUtils.ts` or inline in `chapters.ts` which already has the chapter-string normalization). Delete the local copies in both files.

#### 🟠 4. Volume persistence is written in two separate places inside GlobalPlayerProvider
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/player/globalPlayer.tsx:645-658` · `apps/web/src/lib/player/globalPlayer.tsx:1033-1040`  

**Problem.** The `setVolume` callback (line 651-654) writes to localStorage when the app calls `setVolume()`. The `handleVolumeChange` audio event handler (line 1033-1040) also writes to localStorage when the browser's volume control changes. Both call `window.localStorage.setItem(VOLUME_STORAGE_KEY, ...)` with the same normalization. There is no single owner for "volume changed, persist it". If the normalization or key ever changes, both sites must be updated.

**Fix.** Extract a `persistVolume(normalized: number): void` private helper that owns the single write, and call it from both sites. Alternatively, react only to the audio element's `volumechange` event (the browser fires it from programmatic changes too), eliminating the write in `setVolume` entirely.

#### 🟠 5. play() and retryPlayback() duplicate the AudioContext-resume + silenceTrim-start preamble
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/player/globalPlayer.tsx:567-581` · `apps/web/src/lib/player/globalPlayer.tsx:588-608`  

**Problem.** Both `play` (lines 567-581) and `retryPlayback` (lines 588-608) contain the same three-step preamble: (1) call `ensureAudioEffectsGraph()`, (2) resume the AudioContext if suspended, (3) call `startSilenceTrimming()` if silence-trim is active and effects are available. The only difference is that `retryPlayback` also calls `audio.load()` first. This preamble is also repeated a third time in the `requestVersion` effect at lines 1128-1134.

**Fix.** Extract a private `beginPlayback(audio: HTMLAudioElement): void` helper that encapsulates the three-step preamble, and have `play`, `retryPlayback`, and the autoplay branch in the requestVersion effect all call it. If the audio-graph extraction (issue #1) is done first, `beginPlayback` becomes a method on the new hook, removing the need for the duplication entirely.

#### 🟠 6. GlobalPlayerChapterMarker is a presentation-layer type defined and leaked through the service-layer context
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `cleanliness.md §9`  
**Where:** `apps/web/src/lib/player/globalPlayer.tsx:80-82` · `apps/web/src/lib/player/globalPlayer.tsx:108` · `apps/web/src/lib/player/globalPlayer.tsx:855-865`  

**Problem.** `GlobalPlayerChapterMarker` (line 80-82) adds a `leftPercent: number` field — a CSS percentage derived from chapter start time and track duration — to the public `chapterMarkers` array exposed in the context interface (line 108). This is a rendering detail (`left: ${chapter.leftPercent}%`) that belongs in the footer component, not in the player service contract. The context is now responsible for pre-computing a layout value. Only `GlobalPlayerFooter.tsx` consumes `chapterMarkers` and `leftPercent` (lines 184, 362-372, 565-575). The interface type is not exported, so it is invisible to callers; they receive an anonymous intersection that includes a CSS property.

**Fix.** Remove `chapterMarkers` (and `GlobalPlayerChapterMarker`) from `GlobalPlayerContextValue`. Expose only `track` (which already has `chapters`), `currentTimeSeconds`, and `durationSeconds`. Move the `leftPercent` derivation into `GlobalPlayerFooter` as a local `useMemo`. This shrinks the public surface and keeps CSS-layout concerns in the component layer.

#### 🟡 7. selectedPlaybackRateOption is a presentation-derived value in the service contract
`Low` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/lib/player/globalPlayer.tsx:110` · `apps/web/src/lib/player/globalPlayer.tsx:867-872`  

**Problem.** `selectedPlaybackRateOption` (context line 110, derived at lines 867-872) is the `SubscriptionPlaybackSpeedOption` that is closest to the current `playbackRate`, used only to populate the `<Select>` value in `GlobalPlayerFooter`. Its only consumer is the footer's two `<Select value={...}>` elements (lines 451, 630). The context already exposes `playbackRate: number`. Deriving the UI-select value inside the player service couples the service to the subscription-speed dropdown's options.

**Fix.** Remove `selectedPlaybackRateOption` from `GlobalPlayerContextValue`. In `GlobalPlayerFooter`, derive the select value locally from `playbackRate` using a one-liner: `const selectedSpeedOption = SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.includes(playbackRate as SubscriptionPlaybackSpeedOption) ? playbackRate : 1`.

#### 🟡 8. EffectsPanel prop types use ReturnType<typeof useGlobalPlayer>[...] instead of explicit types
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §9`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/GlobalPlayerFooter.tsx:44-46`  

**Problem.** The `EffectsPanel` component's props are typed as `ReturnType<typeof useGlobalPlayer>['audioEffects']` and `ReturnType<typeof useGlobalPlayer>['setAudioEffects']` (lines 44 and 46). This creates a structural coupling: `EffectsPanel`'s signature is now defined by the hook's return type rather than by what the panel actually needs. Any change to the context interface silently changes `EffectsPanel`'s contract.

**Fix.** Replace the `ReturnType<typeof useGlobalPlayer>[...]` lookups with explicit types: `audioEffects: AudioEffectsState` and `setAudioEffects: (partial: Partial<AudioEffectsState>) => void`. Both are already importable from `@/lib/player/audioEffects`.

#### 🟡 9. Empty module docs for player.md and podcast.md leave slice without authoritative design contract
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/player.md` · `docs/modules/podcast.md`  

**Problem.** Both module docs are zero bytes. There is no documented ownership contract for the global player capability or for the podcast feature slice. This makes it impossible to audit for doc drift, and means any engineer must read 1200+ lines of implementation to understand intended boundaries.

**Fix.** Write brief module docs (one page each) that describe: the player's public surface (what other modules may call vs. what is internal), which state the player owns end-to-end, and the intended split between the audio-effects concern, queue concern, and track-control concern. The podcast doc should describe the handshake between usePodcastTrackSeeding and the player's setTrack API.

#### 🟡 10. reorderQueueItems is a one-use private helper that could be inlined into reorderQueue
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `apps/web/src/lib/player/globalPlayer.tsx:734-748` · `apps/web/src/lib/player/globalPlayer.tsx:750-766`  

**Problem.** `reorderQueueItems` (lines 734-748) is a `useCallback`-wrapped helper called in exactly one place: inside `reorderQueue` (line 753). It is not exposed on the context. The wrapper adds a `useCallback` + dependency-array maintenance cost with no reuse benefit. Its only job is to derive the optimistic local state for `reorderQueue`'s optimistic update — logic that is simple enough to inline.

**Fix.** Inline the Map-based optimistic reorder logic directly into `reorderQueue` and delete `reorderQueueItems`. This removes one `useCallback` and one entry from `reorderQueue`'s dependency array.


<a id="fe-chat"></a>
## Chat surface & hooks  · `fe-chat`
*8 issues (1 High)*  

> **Verdict.** The chat surface slice is generally well-decomposed — the engine/view/adapter pattern (useConversation + ChatSurface + Conversation/ReaderChatDetail) is architecturally sound, and the supporting hooks have clear single concerns. The primary problem is that useConversation.ts is a 852-line god hook mixing five distinct concerns (history loading, conversation identity & lifecycle, branch state management, active-run resumption, and scroll-ref forwarding) in one body. Secondary issues are a dead export in useChatMessageUpdates, a local re-derivation of message text that duplicates the canonical function from types.ts, a module-scope mutable cache in useChatModels that escapes the hook's own lifecycle, and the engine hook importing from a component-layer module (Feedback) when only a pure utility is needed.


#### 🔴 1. useConversation.ts is a god hook mixing five unrelated concerns in one body
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/components/chat/useConversation.ts:1-852`  

**Problem.** At 852 lines, useConversation conflates: (1) conversation identity and create-on-first-send (lines 154, 586–616); (2) linear history load and pagination (lines 365–411, 558–580); (3) branch/tree state and all branch mutations — switch, reload, draft, path-cache (lines 166–177, 310–346, 690–822); (4) active-run resumption fetch loop and its single-flight guard (lines 195–308, 476–534); and (5) scroll-ref ownership and captureAnchor forwarding (lines 152, 570, 722, 749, 760). These are unrelated phases with different lifecycles, different API callsites, and different re-render triggers. Mixing them forces every caller to carry the full surface, and changes to branching logic risk regressing linear-mode behaviour and vice versa.

**Fix.** Split into focused hooks with narrow public contracts: (a) useConversationIdentity({ conversationId, initialReferences }) → { conversationId, resolveConversation } — owns create-on-send and attachment tracking; (b) useConversationHistory({ conversationId, branching }) → { messages, olderCursor, loadOlder, loading, error, title } — owns history fetch, pagination, and tree application; (c) useBranchState({ conversationId, messages, tailChatRun }) → UseConversationBranch — owns fork options, path-cache, switchToLeaf/switchToFork, activeLeafMessageId; (d) keep useChatRunTail as-is for streaming; (e) remove scrollRef from useConversation entirely — the adapter (Conversation.tsx, ReaderChatDetail.tsx) holds a local ref and passes it directly to ChatSurface forwardRef; useConversation has no business owning scroll state. The public contract of useConversation becomes a thin composition of the above four, or Conversation.tsx and ReaderChatDetail.tsx call the sub-hooks directly.

#### 🟠 2. handleOptimisticMessages is exported from useChatMessageUpdates but never called
`Medium` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `apps/web/src/components/chat/useChatMessageUpdates.ts:196-201` · `apps/web/src/components/chat/useChatMessageUpdates.ts:415`  

**Problem.** useChatMessageUpdates defines and returns handleOptimisticMessages (a callback that appends a user+assistant pair). No caller in production code — useChatRunTail, useConversation, or any component — destructures or calls it. The optimistic seeding is done directly in useConversation.onChatRunCreated (line 648: setMessages([runData.user_message, runData.assistant_message])). The exported symbol is dead.

**Fix.** Delete handleOptimisticMessages from useChatMessageUpdates entirely. Remove it from the returned object at line 415. The optimistic seeding path in useConversation already handles this concern directly and does not need a hook-level helper.

#### 🟠 3. AssistantMessage.tsx duplicates the assistantMessageText extraction already in types.ts
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/chat/AssistantMessage.tsx:232-237` · `apps/web/src/lib/conversations/types.ts:194-201`  

**Problem.** AssistantMessage.tsx defines a private function assistantMessageText (lines 232–237) that filters message_document.blocks for type 'text' and joins with '\n\n'. This is character-for-character identical to the exported conversationMessageText in lib/conversations/types.ts. Two owners now define the same derivation; a future format change would need to touch both.

**Fix.** Delete assistantMessageText from AssistantMessage.tsx. Replace its three call-sites in the same file with the already-imported conversationMessageText from @/lib/conversations/types. The types module is the single owner of this extraction.

#### 🟠 4. useChatModels leaks module-scope mutable cache that bypasses hook lifecycle
`Medium` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §8`  
**Where:** `apps/web/src/components/chat/useChatModels.ts:37-52` · `apps/web/src/components/chat/useChatModels.ts:115-127`  

**Problem.** cachedModels and modelLoadPromise are module-scope mutable variables (lines 37–38). The hook initialises its useState from cachedModels (line 116), then also drives useAsyncResource with cacheKey: cachedModels ? null : 'chat-composer-models' (line 124). This creates two parallel caching layers for the same data: the module-scope singleton and useAsyncResource's internal cache. The module-scope cache never invalidates (models could go stale across test suites or if the user changes BYOK keys at runtime). The described justification — surviving composer remounts — would be correctly served by a React context or SWR-style deduplicated fetch, not a module global.

**Fix.** Replace the module-scope cachedModels/modelLoadPromise singleton with a React context provider (e.g. ChatModelsProvider) placed above the composer tree. The provider owns the single fetch, caches the result for its subtree lifetime, and invalidates naturally on unmount. useChatModels reads from context. This eliminates the dual-cache and the lifecycle bypass. If a context is considered too heavy, at minimum remove the useAsyncResource layer and rely solely on the module-scope cache — do not maintain two caches for the same resource.

#### 🟠 5. scrollRef is owned and forwarded by the engine hook rather than by the adapter
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/components/chat/useConversation.ts:152` · `apps/web/src/components/chat/useConversation.ts:138` · `apps/web/src/components/chat/useConversation.ts:850` · `apps/web/src/components/chat/Conversation.tsx:398` · `apps/web/src/components/chat/ReaderChatDetail.tsx:128`  

**Problem.** useConversation allocates a scrollRef (line 152) typed as RefObject<ChatScrollHandle | null>, exposes it in its public interface (line 138, 850), and calls scrollRef.current?.captureAnchor(...) inside loadOlder and switchToLeaf. The scroll surface (useChatScroll / ChatSurface) is a view concern; the engine hook calling imperative scroll methods through a ref it holds is a layering violation — the engine should emit events or callbacks that the adapter translates into scroll commands, not hold the scroll handle directly.

**Fix.** Move the scrollRef out of useConversation. The adapters (Conversation.tsx, ReaderChatDetail.tsx) create a local scrollRef and pass it as ref to ChatSurface as they already do. Where loadOlder and switchToLeaf need to captureAnchor before changing messages, accept an optional onBeforeMessagesChange callback or have the adapter pass captureAnchor as a callback into the relevant options. This keeps scroll as a view concern and the engine as a pure state machine.

#### 🟡 6. useConversation imports from a component-layer module (Feedback) for a pure utility
`Low` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `layers.md`  
**Where:** `apps/web/src/components/chat/useConversation.ts:45`  

**Problem.** useConversation imports toFeedback and the FeedbackContent type from @/components/feedback/Feedback, which is a component-layer module (it also exports FeedbackProvider, FeedbackNotice, and other React components). The engine hook should not depend on the component layer. This creates a downward dependency cycle risk and violates the rule that domain/service APIs should not import UI transport.

**Fix.** Move toFeedback and FeedbackContent to a shared lib module such as @/lib/feedback or @/lib/errors. Both are pure utilities (no React component state). Then remove the @/components/feedback/Feedback import from useConversation. This is a minor move but keeps the engine hook free of component-layer dependencies.

#### 🟡 7. activeRunId is tracked in useChatRunTail but never consumed by any production caller
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `apps/web/src/components/chat/useChatRunTail.ts:79` · `apps/web/src/components/chat/useChatRunTail.ts:443`  

**Problem.** useChatRunTail maintains a useState activeRunId (line 79) and includes it in its return value (line 443). useConversation destructures only { tailChatRun, abortAll } from the hook (line 237). No production component reads activeRunId. It appears only in test fixtures. The state update still runs on every stream lifecycle transition, triggering unnecessary re-renders.

**Fix.** Remove the activeRunId useState and its setter from useChatRunTail. Remove activeRunId from the returned object. If an active-run indicator is needed in the future, add it back at that time. Remove the corresponding assertions in test fixtures that check activeRunId: null as a structural assertion (cleanliness.md §11).

#### 🟡 8. docs/modules/chat.md is an empty stub — module doc contract is unspecified
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/chat.md`  

**Problem.** chat.md exists but is completely empty (0 bytes). The chat surface is the most complex slice in the frontend, covering engine/view/adapter decomposition, two history-load modes (branching/linear), streaming run lifecycle, scroll ownership, and two adapter contexts (pane and reader). The absence of a module doc means drift between intended and actual design cannot be detected systematically, and new engineers have no authoritative design to validate against.

**Fix.** Write a module doc that captures: the intended engine/view/adapter split; which hooks own which concerns (useConversation as engine, useChatScroll as view, Conversation/ReaderChatDetail as adapters); the branching vs. linear mode contract; ownership of scroll (view only); and the intended public surface of useConversation. This becomes the reference for future audit passes.


<a id="fe-forks"></a>
## Conversation forks & branching (FE)  · `fe-forks`
*7 issues (2 High)*  

> **Verdict.** The slice is generally well-decomposed — the tree utilities, mutations, and rendering each have clear files — but three real problems stand out. First, the "is a fork on the active path" predicate is implemented twice in independent places (ForkNodeRow and useForkPanel) instead of being the single function that already exists in branching.ts. Second, `graphNodeSearchText` in ForkGraphOverview duplicates `forkSearchText` in forkTree.ts with identical logic against structurally identical node shapes, giving the codebase two owners for the same computation. Third, `useForkPanel` makes raw `apiFetch` PATCH/DELETE calls directly against the forks API endpoint, embedding transport details and URL construction inside what is supposed to be a UI state hook; that belongs in a dedicated fork-API module or the hook's own boundary. The module doc (docs/modules/chat.md) is completely empty, so no design intent can be checked against it — that is a doc-drift finding in itself. Everything else (ForkNodeRow coupling to `treeItemDomId`/`toForkOption` being imported by useForkTreeKeyNav, the `idsToReplace` redundancy in branching.ts) is lower-severity indirection or minor duplication.


#### 🔴 1. Duplicate 'is fork on active path' predicate in ForkNodeRow and useForkPanel
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/chat/ForkNodeRow.tsx:75-80` · `apps/web/src/components/chat/useForkPanel.ts:145-150` · `apps/web/src/lib/conversations/branching.ts:104-121`  

**Problem.** The three-part check `selectedIds.has(leaf_message_id) || selectedIds.has(user_message_id) || (assistant_message_id ? selectedIds.has(assistant_message_id) : false)` is written verbatim in two separate places: ForkNodeRow lines 75-80 (as `activeInPath`) and useForkPanel lines 145-150 (inside `requestDeleteFork`). The canonical implementation of this exact logic already exists in `branching.ts:activeForkOptionsForPath` (lines 108-120), which computes the same boolean per fork. Having three independent implementations of the same predicate means a future change to the 'active path' rule (e.g. adding another ID to check) must be applied in three places.

**Fix.** Extract a named helper `isForkOnPath(fork: Pick<ForkOption, 'leaf_message_id' | 'user_message_id' | 'assistant_message_id'>, pathIds: Set<string>): boolean` into `branching.ts` and have `activeForkOptionsForPath`, `ForkNodeRow`, and `useForkPanel.requestDeleteFork` all call it. The `ForkNodeRow.activeInPath` then becomes `node.active || isForkOnPath(node, selectedPathMessageIds)` and the guard in `requestDeleteFork` becomes `fork.active || isForkOnPath(fork, selectedPathMessageIds)`.

#### 🔴 2. Duplicate node search-text logic: graphNodeSearchText in ForkGraphOverview vs forkSearchText in forkTree.ts
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `apps/web/src/components/chat/ForkGraphOverview.tsx:129-140` · `apps/web/src/lib/conversations/forkTree.ts:121-132`  

**Problem.** `graphNodeSearchText` (ForkGraphOverview, lines 129-140) and `forkSearchText` (forkTree.ts, lines 121-132) produce identical output from structurally identical inputs: both join `[title, preview, branch_anchor_preview, status, String(message_count)]`, filter falsy, join with space, and call `.toLowerCase()`. `BranchGraphNode` and `ConversationForkNode` (which extends `ForkOption`) share the same field names for all five fields. There are now two owners for the same text-matching computation, and they can silently diverge.

**Fix.** Move the search-text function to `forkTree.ts` (or a shared `forkSearch.ts`), give it a generic enough signature to accept either node type (a `Pick<>` of the five shared fields), and delete `graphNodeSearchText` from ForkGraphOverview. Import and call the single function from both ForkNodeRow and ForkGraphOverview.

#### 🟠 3. useForkPanel makes raw apiFetch PATCH/DELETE calls with inline URL construction
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/components/chat/useForkPanel.ts:126-128` · `apps/web/src/components/chat/useForkPanel.ts:166-168`  

**Problem.** `useForkPanel` is a UI state hook (managing editing, deletion, search, expand state), but it also owns transport details: it builds the API URL string directly inside `saveRename` and `confirmDeleteFork` and calls `apiFetch` with raw `PATCH`/`DELETE`. Per cleanliness §8, edge adapters should parse/validate/invoke but not own business rules, and hooks like this should not hold raw HTTP details. If the API path or method convention changes, the mutation code must be updated inside the state hook rather than in one transport adapter.

**Fix.** Introduce a thin `forkApi` module (e.g. `apps/web/src/lib/conversations/forkApi.ts`) that exposes named async functions: `renameFork(conversationId, forkId, title)` and `deleteFork(conversationId, forkId)`. These own the URL construction and `apiFetch` calls. `useForkPanel` calls only those named functions, holding no raw URL strings or HTTP method literals.

#### 🟠 4. treeItemDomId and toForkOption exported from a rendering component (ForkNodeRow) and imported by a logic hook (useForkTreeKeyNav)
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/chat/ForkNodeRow.tsx:18-25` · `apps/web/src/components/chat/useForkTreeKeyNav.ts:11`  

**Problem.** `useForkTreeKeyNav` imports `treeItemDomId` and `toForkOption` directly from `ForkNodeRow.tsx`, a React rendering component. This creates a dependency from a logic hook into a rendering file, inverting the usual layer direction. `treeItemDomId` is a pure ID-generation function and `toForkOption` is a simple type projection; neither belongs in the rendering component's exported surface. The coupling means the rendering component becomes a de-facto shared utility module.

**Fix.** Move `treeItemDomId` and `toForkOption` to `forkTree.ts` (which already owns `ConversationForkNode` and `ForkOption`) or a small `forkDom.ts` utility. Both `ForkNodeRow` and `useForkTreeKeyNav` then import from the library file, eliminating the hook-to-component dependency.

#### 🟡 5. selectedPathAfterRun has a redundant set union — idsToReplace default is always merged again
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/conversations/branching.ts:15-24`  

**Problem.** The default value of `idsToReplace` (lines 15-18) is already `[runData.user_message.id, runData.assistant_message.id]`. The body then unconditionally constructs `replaceIds` by spreading `idsToReplace` and also appending `runData.user_message.id` and `runData.assistant_message.id` again (lines 20-24). When the default is used, the two IDs appear twice in the spread; when an explicit `idsToReplace` is passed (as in the reconcile path of `useChatRunTail` at line 237-244 which includes both original and current IDs plus the final response IDs), the run-message IDs are added a second time unnecessarily. The intent is clear — always include the current run's IDs — but the implementation is misleading.

**Fix.** Remove the duplication by either: (a) keeping the default as-is and in the body just doing `const replaceIds = new Set(idsToReplace)` (callers who need to add additional IDs pass them explicitly), or (b) removing the default parameter entirely and always requiring the caller to pass the ID list. Option (a) is the minimal change that preserves current behavior and removes the confusing double-add.

#### 🟡 6. Module doc docs/modules/chat.md is empty — no design intent documented for the forks/branching subsystem
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`, `cleanliness.md §13`  
**Where:** `docs/modules/chat.md`  

**Problem.** The module documentation file for the chat module is a zero-byte file. The forks and branching subsystem (useForkPanel, branching.ts, forkTree.ts, ConversationForksPanel, ForkGraphOverview) has real architectural decisions — dual-view (tree/graph), search, fork mutations, path derivation — none of which are documented. This makes it impossible to audit code against intended design, and it was the authoritative design reference for this audit.

**Fix.** Write a concise module doc that covers: the two data representations (ForkOption tree vs BranchGraph), the ownership boundary between branching.ts (path derivation, active-flag computation) and forkTree.ts (tree building, flattening, filtering), the search flow (local filter vs server search), and the public contracts of useForkPanel and ConversationForksPanel.

#### 🟡 7. ForkNodeRow and ForkTreeView both import styles from ConversationForksPanel.module.css
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`  
**Where:** `apps/web/src/components/chat/ForkNodeRow.tsx:16` · `apps/web/src/components/chat/ForkTreeView.tsx:10`  

**Problem.** Both `ForkNodeRow.tsx` and `ForkTreeView.tsx` import styles from `ConversationForksPanel.module.css`, a file named after the panel component, not after the subcomponents. This gives the panel's CSS file three consumers and makes it a shared stylesheet owned by the wrong file. Style class names like `node`, `chevron`, `nodeBody`, `deleteConfirm`, `childGroup`, `tree`, `empty` that belong to the row and tree components are defined in the panel's CSS file, creating an implicit coupling.

**Fix.** Move the row-level class names (`node`, `chevron`, `nodeBody`, `titleButton`, `titleText`, `pathBadge`, `anchor`, `meta`, `actions`, `deleteConfirm`, `childGroup`) into a `ForkNodeRow.module.css` and the tree-container class names (`tree`, `empty`) into a `ForkTreeView.module.css`. `ConversationForksPanel.module.css` retains only the panel-level layout classes (`panel`, `viewToggle`, `searchRow`, `liveCount`, `error`).


<a id="fe-reader"></a>
## Reader surface (FE)  · `fe-reader`
*7 issues (1 High)*  

> **Verdict.** The reader surface slice is mostly well-decomposed: each hook owns a single, clear capability, the type system for resume state is strict and disciplined, and the two highlight surfaces (ruler vs secondary) are correctly kept as independent instruments. The worst rot is in ReaderHighlightsSurface.tsx (830 lines), which mixes layout engine logic, note key management, row rendering, scrolling, and mutation feedback into one component body — a classic god-file by the rules. The second systemic issue is a scroll-parent tracking pattern (findScrollParent + rAF-debounced syncScrollState/syncViewportState) duplicated verbatim across useAnchoredHighlightProjection and ReaderOverviewRuler, with findScrollParent itself mishoused inside a hook file and re-exported from there. Smaller findings: dead load export surfaces on both useReaderProfile and useReaderResumeState; the per-field update helpers on useReaderProfile are a duplicate API on top of save; and is_owner is unnecessarily optional in AnchoredHighlightRow when the underlying Highlight type makes it required.


#### 🔴 1. ReaderHighlightsSurface is a god component: layout engine, note key registry, mutation feedback, and rendering mixed in one 830-line body
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:1-830`  

**Problem.** The component simultaneously owns: (1) a desktop layout engine that aligns rows to their DOM anchors and tracks overflow (alignRows, rowHeights, overflowCount, alignedRows state, useLayoutEffect measuring loop, ResizeObserver); (2) a mobile viewport-visible highlight state machine (mobileHighlightsState useMemo, aboveCount/belowCount/nearestAboveId/nearestBelowId); (3) a note editor key registry across two Maps (draftNoteEditorKeysRef, noteEditorKeysByBlockIdRef) with a garbage-collection effect and getDraftNoteEditorKey/getNoteEditorKey helpers that encode a draft-to-saved key promotion protocol; (4) reader scroll interaction (revealHighlightInReader with scroll-padding arithmetic); (5) mutation feedback with component-global deleting/changingColor boolean flags (see lines 112-113) that prevent concurrent mutation on any highlight while any other is being mutated; and (6) the full renderRow callback stitching all of the above together. These are unrelated concerns with no shared invariants.

**Fix.** Extract three units: (a) useHighlightRowLayout — a hook owning the desktop alignment engine (alignRows, rowHeights, overflowCount, alignedRows) and the ResizeObserver; it receives projections/orderedHighlights/rowRefs/containerRef and returns alignedRows/overflowCount; (b) useNoteEditorKeys — a hook owning draftNoteEditorKeysRef/noteEditorKeysByBlockIdRef and exposing getDraftNoteEditorKey/getNoteEditorKey/handleNoteSave; it receives the highlights list and runs the GC effect; (c) HighlightRow (or inline into ItemCard call site) — a component responsible only for rendering a single highlight row, accepting isFocused, the highlight, and action callbacks. The parent component (ReaderHighlightsSurface) then becomes a thin dispatcher: call the two hooks, compose mobile vs desktop branch, map alignedRows to HighlightRow. The mutation flags (deleting, changingColor) should be per-highlight-id Maps if needed, or move into HighlightRow state if each row is independent.

#### 🟠 2. Scroll-parent tracking logic duplicated between useAnchoredHighlightProjection and ReaderOverviewRuler
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/reader/useAnchoredHighlightProjection.ts:216-230 (syncViewportState)` · `apps/web/src/components/reader/useAnchoredHighlightProjection.ts:365-392 (scroll useEffect)` · `apps/web/src/components/reader/useAnchoredHighlightProjection.ts:394-412 (ResizeObserver useEffect)` · `apps/web/src/components/reader/ReaderOverviewRuler.tsx:87-103 (syncScrollState)` · `apps/web/src/components/reader/ReaderOverviewRuler.tsx:105-145 (scroll + resize useEffects)`  

**Problem.** Both files independently implement: a memoized scroll-state sync callback that bails out when values are unchanged (syncViewportState/syncScrollState); an rAF-gated scroll event listener that deduplicates frames via a frameRef; a ResizeObserver on the scroll parent to trigger re-sync. The logic is structurally identical — only the tracked fields differ (scrollTop+clientHeight vs scrollTop+scrollHeight+clientHeight). The projection hook uses 3 effects for this; the ruler uses 2. This is large, stateful duplication that is easy to get wrong independently (e.g. the ruler's ResizeObserver observes only the scroll parent, the projection hook also observes the content element).

**Fix.** Extract a useScrollState(contentRef, fields) hook into a shared utility (e.g. apps/web/src/components/reader/useScrollState.ts or apps/web/src/lib/reader/useScrollState.ts). It accepts a contentRef and a field selector (scrollTop+clientHeight or scrollTop+scrollHeight+clientHeight), attaches the passive scroll listener with rAF deduplication and the ResizeObserver, and returns the current scroll state. Both useAnchoredHighlightProjection and ReaderOverviewRuler call this hook instead of duplicating the pattern.

#### 🟠 3. findScrollParent is a general DOM utility exported from a hook implementation file, creating a wrong-layer import
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/reader/useAnchoredHighlightProjection.ts:57-67 (definition)` · `apps/web/src/components/reader/ReaderOverviewRuler.tsx:22 (import from hook file)` · `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:31 (import from hook file)`  

**Problem.** findScrollParent is a pure stateless DOM utility. It lives inside useAnchoredHighlightProjection.ts, which is a hook implementation file. Both ReaderOverviewRuler.tsx and ReaderHighlightsSurface.tsx import it from there, crossing into a private hook file to consume an incidental utility. The hook file's public contract is useAnchoredHighlightProjection and its return types — findScrollParent is not part of that contract and its presence as an export on a hook file is an accidental coupling.

**Fix.** Move findScrollParent to a dedicated DOM utility module, e.g. apps/web/src/lib/dom/scrollParent.ts or apps/web/src/components/reader/scrollParent.ts. All three callers update their import. If the useScrollState hook from the duplication fix is extracted, it can own the internal call to findScrollParent, further narrowing the surface.

#### 🟠 4. useReaderProfile exposes a duplicate API: five per-field updaters alongside the generic save
`Medium` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/lib/reader/useReaderProfile.ts:87-127 (updateTheme, updateFontFamily, updateFontSize, updateLineHeight, updateColumnWidth)` · `apps/web/src/lib/reader/ReaderContext.tsx:19-23 (same five in context interface)`  

**Problem.** useReaderProfile returns save(updates: Partial<ReaderProfile>) as the canonical way to update the profile, plus five single-field wrappers: updateTheme, updateFontFamily, updateFontSize, updateLineHeight, updateColumnWidth. Each wrapper is exactly one line: save({ field }). ReaderContext re-exposes all five through its interface. This is five redundant aliases for save that do not hide any complexity. Notably, focus_mode and hyphenation have no per-field helpers — making the set inconsistent — and callers use save({ focus_mode }) and save({ hyphenation }) directly anyway (MediaPaneBody line 3432, SettingsReaderPaneBody line 177).

**Fix.** Delete the five per-field helpers from useReaderProfile and from ReaderContext's interface. All callers — SettingsReaderPaneBody and MediaPaneBody — already call the generic save variant for focus_mode and hyphenation, so they can adopt save for the remaining five fields with a trivial update. This reduces the public surface from eight items to three (profile, save, load state flags).

#### 🟡 5. AnchoredHighlightRow.is_owner is typed as optional (boolean | undefined) despite Highlight.is_owner being required (boolean)
`Low` · `High-confidence` · `Types` · rules: `cleanliness.md §9`  
**Where:** `apps/web/src/components/reader/useAnchoredHighlightProjection.ts:49 (is_owner?: boolean)` · `apps/web/src/lib/highlights/api.ts:37 (is_owner: boolean, required)` · `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:505 (highlight.is_owner === false guard)` · `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:559 (highlight.is_owner !== false guard)`  

**Problem.** Highlight.is_owner is boolean (always present from the API). toAnchoredHighlightRow.ts copies it through Pick<Highlight, ..., 'is_owner', ...>, so every AnchoredHighlightRow produced by the two factory functions always has is_owner set. Nevertheless AnchoredHighlightRow declares is_owner?: boolean, meaning undefined is a legal value in the type. ReaderHighlightsSurface defends against this with is_owner !== false and is_owner === false triple-value guards. If is_owner is never actually undefined at runtime, the optional typing is misleading and the guards produce dead branches.

**Fix.** Change AnchoredHighlightRow.is_owner from is_owner?: boolean to is_owner: boolean. Update ReaderHighlightsSurface's three guards to use !highlight.is_owner / highlight.is_owner. This makes illegal states unrepresentable and removes the triple-equality guards that exist only because of the type uncertainty.

#### 🟡 6. load is a dead export on both useReaderProfile and useReaderResumeState public surfaces
`Low` · `Medium-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/reader/useReaderProfile.ts:121 (load in return)` · `apps/web/src/lib/reader/useReaderResumeState.ts:195 (load in return)`  

**Problem.** useReaderProfile returns load but ReaderContext — the only consumer of useReaderProfile — does not include load in its interface or forward it to any caller. No code outside lib/reader/ calls load from useReaderProfile. Similarly, useReaderResumeState returns load, but MediaPaneBody (the only caller) only destructures state, loading, and save — load is never used externally. In both cases, the hook triggers loading via a useEffect on mount/mediaId change, making the external load handle redundant.

**Fix.** Remove load from the return value of useReaderProfile and useReaderResumeState. Keep the internal load callback but do not expose it. If a forced-reload capability is ever needed, expose a named reload() function at that time with a documented use case.

#### 🟡 7. Component-global deleting/changingColor flags incorrectly block mutation on all highlights when only one is being mutated
`Low` · `Medium-confidence` · `Other` · rules: `cleanliness.md §5`, `cleanliness.md §9`  
**Where:** `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:112-113 (state declarations)` · `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:505 (deleting guard across all highlights)` · `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:530-531 (changingColor guard across all highlights)`  

**Problem.** deleting and changingColor are single boolean flags at the component level. When the user deletes or changes the color on highlight A, the flag also disables delete/color-change on highlight B, C, D. This is a semantic overreach: the lock should be per-highlight-id, not global. The current shape also means these flags are woven into the renderRow callback's dependency array (lines 677-678), triggering a full re-render of all rows whenever one mutation starts or finishes.

**Fix.** Change deleting and changingColor from boolean to Map<string, boolean> (keyed by highlight id), or move them into per-row state if rows are extracted into HighlightRow components (see god-file issue). Each mutation reads/writes only its own highlight's entry, eliminating cross-highlight blocking and shrinking the renderRow dependency surface.


<a id="fe-highlights"></a>
## Highlights (FE)  · `fe-highlights`
*6 issues (1 High)*  

> **Verdict.** The individual highlight library files (canonicalCursor.ts, canonicalText.ts, segmenter.ts, applySegments.ts, selectionToOffsets.ts, pdfPageViewport.ts) are well-scoped, single-concern modules with clean public contracts. The god-file risk in this slice is moderate rather than severe. The worst rot is concentrated in two places: (1) highlights/api.ts imports from lib/notes/api and bakes note-mutation orchestration alongside HTTP fetch functions, mixing transport and business-operation concerns; and (2) useHighlightInteraction.ts accumulates the hook, four DOM utility functions, and a focus-reconciliation helper that belong to different concerns — the module's public surface is larger than it needs to be. A secondary issue is that selectionToOffsets.ts exports selectionIntersectsCodeBlock and the MIN/MAX constants solely for tests, inflating the surface needlessly.


#### 🔴 1. highlights/api.ts mixes HTTP transport with note-mutation orchestration
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/lib/highlights/api.ts:1-204` · `apps/web/src/lib/highlights/api.ts:7-10` · `apps/web/src/lib/highlights/api.ts:165-204`  

**Problem.** api.ts imports createNoteBlock, updateNoteBlock, and deleteNoteBlock from lib/notes/api (line 7-10) and implements saveHighlightNote (lines 165-190) and deleteHighlightNote (lines 192-197), which are multi-step mutation orchestration flows that call notes API primitives, enforce a revision invariant (requiredRevision, line 199-204), and reshape the response into HighlightLinkedNoteBlock. These are business operations, not transport functions. The rule is that edge adapters parse/validate/translate and invoke a service; they must not own business rules. List-update helpers patchHighlightLinkedNoteBlock (lines 206-238) and removeHighlightLinkedNoteBlock (lines 240-262) also live in the same file as fetch functions, conflating state-management utilities with transport.

**Fix.** Split api.ts into two modules: (1) highlights/transport.ts — fetchHighlights, fetchMediaHighlights, createHighlight, updateHighlight, deleteHighlight. These are thin HTTP calls returning typed values. (2) highlights/noteOperations.ts (or co-locate with the notes module) — saveHighlightNote, deleteHighlightNote, requiredRevision, and the two list-update helpers. The note-save flow crosses the highlights/notes boundary and should live close to where the notes module exposes its mutation operations. Each module should expose only what callers actually import.

#### 🟠 2. useHighlightInteraction.ts mixes a hook with four unrelated DOM utility functions
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/highlights/useHighlightInteraction.ts:261-295` · `apps/web/src/lib/highlights/useHighlightInteraction.ts:310-326` · `apps/web/src/lib/highlights/useHighlightInteraction.ts:339-352`  

**Problem.** The file exports the useHighlightInteraction hook plus four standalone DOM utility functions (parseHighlightElement, findHighlightElement, applyFocusClass, reconcileFocusAfterRefetch) that have no dependency on the hook's state. These utilities are called directly by MediaPaneBody (lines 70-73 in MediaPaneBody.tsx) in contexts that have nothing to do with the hook. applyFocusClass imperatively mutates the DOM to apply CSS classes — a side-effect mechanism that is conceptually distinct from the focus state machine owned by the hook. The module's public surface conflates three things: (a) the focus state machine (hook), (b) DOM attribute parsing helpers, and (c) DOM mutation for visual feedback.

**Fix.** Extract parseHighlightElement, findHighlightElement into a small highlights/domUtils.ts (they parse data attributes from rendered HTML, a pure DOM read). Move applyFocusClass there too, since it is a DOM-mutation utility called independently. reconcileFocusAfterRefetch is a pure function over IDs and belongs either in domUtils.ts or inlined at its single call site in MediaPaneBody. The hook file should export only useHighlightInteraction and the types it requires.

#### 🟡 3. normalizeHighlights exported from applySegments.ts is an orphaned public symbol
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/highlights/applySegments.ts:90-100`  

**Problem.** normalizeHighlights is exported (line 90) and tested directly (applySegments.test.ts line 22, 404-436), but it is only ever called from within applyHighlightsToHtml (line 447 in the same file). No external caller imports it — grep shows it is only referenced inside applySegments.ts and its test file. Exporting it inflates the public surface and invites callers to bypass the main entry point.

**Fix.** Make normalizeHighlights unexported (remove the export keyword). The test for it at lines 404-436 of applySegments.test.ts is testing an internal implementation step; it should be removed or replaced with a test that asserts the effect through applyHighlightsToHtml. This aligns with cleanliness.md §13 (confirm truly unused before flagging) — it is exported but has no real consumer.

#### 🟡 4. selectionToOffsets.ts exports selectionIntersectsCodeBlock and MIN/MAX constants used only by tests
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §2`, `cleanliness.md §6`, `cleanliness.md §11`  
**Where:** `apps/web/src/lib/highlights/selectionToOffsets.ts:69-74` · `apps/web/src/lib/highlights/selectionToOffsets.ts:138-154` · `apps/web/src/lib/highlights/selectionToOffsets.test.ts:69-75`  

**Problem.** MIN_HIGHLIGHT_LENGTH (line 69) and MAX_HIGHLIGHT_LENGTH (line 74) are exported but consumed only inside selectionToOffsets.ts and the test file. The test at lines 69-75 of selectionToOffsets.test.ts asserts the literal values (MIN is 2, MAX is 2000) — this restates implementation constants rather than testing observable behavior, exactly the pattern cleanliness.md §11 flags. selectionIntersectsCodeBlock (line 138) is exported and tested directly but its only production call is from selectionToOffsets (line 337 in the same file). Exporting these inflates the module surface and creates a seam kept alive by tests.

**Fix.** Remove the export from MIN_HIGHLIGHT_LENGTH, MAX_HIGHLIGHT_LENGTH, and selectionIntersectsCodeBlock. Delete the tests that assert the constant literals. The selectionIntersectsCodeBlock tests that verify behavior (code/pre rejection) should be rewritten as end-to-end selectionToOffsets tests with a mocked cursor containing pre/code ancestors, so the behavior is exercised through the public function.

#### 🟡 5. resolveDirectTextNodeMatch function is misplaced under the JSDoc for selectionToOffsets
`Low` · `High-confidence` · `Naming` · rules: `cleanliness.md §1`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/highlights/selectionToOffsets.ts:156-188`  

**Problem.** The JSDoc block at lines 156-172 documents selectionToOffsets (the main public entry point), but the function declaration that immediately follows it is resolveDirectTextNodeMatch (line 173), a private helper. This is a structural error: the JSDoc and the function it documents are separated by an accidental interleaving. The exported selectionToOffsets function at line 190 has no JSDoc of its own because the doc was severed from it. This creates confusion about what the JSDoc describes.

**Fix.** Move the resolveDirectTextNodeMatch function definition to the Helpers section (before line 128, alongside isInsideCodeBlock and findFirstNonWhitespace/findLastNonWhitespace). The JSDoc block starting at line 156 should immediately precede export function selectionToOffsets at line 190.

#### 🟡 6. highlight.md module doc is empty — no intended design is documented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/highlight.md`  

**Problem.** docs/modules/highlight.md is a zero-byte file. The module doc is supposed to record the intended design so that code drift can be detected in both directions. The highlights library is substantive (nine files, a rich algorithm pipeline from selection to DOM mutation), yet there is no design record. The reader-implementation.md covers high-level architecture but does not substitute for the per-module contract description. A stale/empty doc is a lead that the intended design was never written or was deleted.

**Fix.** Write the highlight module doc covering: the pipeline (selection -> selectionToOffsets -> canonicalCursor -> segmenter -> applySegments), the two-reader split (reflowable vs PDF), the public contract of each file, what callers may import and what is internal, and the boundary between the highlights library and its consumers (MediaPaneBody, PdfReader). This prevents future drift from going undetected.


<a id="fe-api-sse"></a>
## API client & SSE (FE)  · `fe-api-sse`
*7 issues (2 High)*  

> **Verdict.** The slice is mostly well-factored — SSE parsing is correctly separated from event typing, and the BFF proxy pattern is sound — but three real problems emerge. proxy.ts (601 lines) runs two distinct proxy flows (cookie-auth and extension-bearer-auth) in the same file with a large duplicated fetch-and-respond core; that duplication, combined with a third independent implementation of the same fetch-timeout-abort pattern in server.ts (including a separate copy of the 30 000 ms constant), shows the fetch-to-FastAPI capability has three owners instead of one. client.ts bakes a hard navigation side-effect (window.location.assign to /login) directly into the transport layer function parseApiResponse, violating the boundary rule that edge adapters translate and invoke but do not own business rules. The sse/ folder also contains requests.ts, which holds outbound chat request types that belong to the conversations domain, not the SSE wire-parsing layer.


#### 🔴 1. proxyToFastAPIWithDeps and proxyExtensionToFastAPI duplicate the core fetch-and-respond body
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `apps/web/src/lib/api/proxy.ts:413-479` · `apps/web/src/lib/api/proxy.ts:555-600`  

**Problem.** Both proxy functions independently execute: (1) read the request body as ArrayBuffer for non-GET/HEAD; (2) call createTimedFetchController; (3) call fetch with the method, headers, body, and abort signal; (4) extract and validate the backend request-id header; (5) call readProxiedBody; (6) catch AbortError and decide between 499 and 504; (7) catch other errors and return 502; (8) call ctl.cleanup() in finally. The only material differences are the response-header filtering strategy (full allowlist vs content-type only) and whether to attach rotated cookies. This is roughly 65 lines of near-identical logic repeated verbatim. The two proxy paths — cookie-auth (browser) and bearer-auth (extension) — share this entire fetch-execute-respond contract, making it dangerous to update one without the other.

**Fix.** Extract a private async function executeFastAPIFetch(url: string, method: string, headers: Headers, body: ArrayBuffer | undefined, requestId: string, clientSignal: AbortSignal, fetchFn: typeof fetch): Promise<{ response: Response; timedOut: boolean } | 'client_aborted'> that handles the timed fetch, abort classification, and error cases, returning a discriminated result. proxyToFastAPIWithDeps and proxyExtensionToFastAPI call it and then handle response-header filtering and cookie rotation according to their own rules. The function can stay private inside proxy.ts; the split eliminates the duplication without creating a new public module.

#### 🔴 2. parseApiResponse navigates to /login — business-rule side effect inside the transport adapter
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/lib/api/client.ts:122-136`  

**Problem.** parseApiResponse, which is a transport-layer function that parses HTTP responses, calls window.location.assign to redirect the browser to /login when it receives a 401 E_UNAUTHENTICATED response. This is a routing/navigation decision — a business rule about what happens after an auth failure — embedded in the HTTP adapter. The edge adapter rule is explicit: edge adapters parse, translate, and invoke; they must not own business rules. Any caller that catches ApiError and wants to present a custom 401 flow (e.g. an inline re-auth dialog) cannot because the redirect fires unconditionally before the error is even thrown to the caller. It also makes the function impossible to test in isolation without mocking window.location.

**Fix.** Remove the window.location.assign block from parseApiResponse entirely. throw ApiError(401, ...) as usual. The navigation side effect belongs at the app boundary: add a top-level React error boundary or a shared useEffect in the app shell that listens for unhandled ApiError with status 401 and performs the redirect once, in one place. Alternatively, accept an optional onUnauthenticated callback in apiFetch and let each call site decide. Either approach keeps the transport function pure.

#### 🟠 3. FASTAPI_FETCH_TIMEOUT_MS constant defined independently in proxy.ts and server.ts
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/api/proxy.ts:33` · `apps/web/src/lib/api/server.ts:10`  

**Problem.** Both files declare `const FASTAPI_FETCH_TIMEOUT_MS = 30_000` independently. If the timeout is tuned in one file, the other silently keeps the old value, creating a split-brain timeout policy across the two FastAPI call paths.

**Fix.** Export the constant from a single source — the natural home is apps/web/src/lib/api/internal-config.ts alongside the FastAPI base-URL and secret config, or a dedicated apps/web/src/lib/api/constants.ts. Both proxy.ts and server.ts import it from there.

#### 🟠 4. requests.ts (outbound chat request types) is misplaced inside the sse/ wire-parsing folder
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §12`  
**Where:** `apps/web/src/lib/api/sse/requests.ts:1-27`  

**Problem.** The sse/ directory owns SSE wire-framing: inbound event types, decoders, locator types, citation types, and guard helpers. requests.ts contains ChatRunCreateRequest, ReaderContextHintInput, and ReaderSelectionInput — these are outbound HTTP request body types for the chat-run endpoint. They have nothing to do with SSE parsing. The file imports from @/lib/conversations/types (a domain module), not from anything SSE-specific. Its consumers (conversations/chatRunBody.ts, components/chat/ChatComposer.tsx, components/chat/useChatModels.ts) are domain/UI modules. Placing these types in sse/ hides their true ownership and forces every consumer to import from the SSE transport layer to get a plain request-body type.

**Fix.** Move requests.ts to apps/web/src/lib/conversations/requests.ts or inline its types into apps/web/src/lib/conversations/chatRunBody.ts, which is already the canonical assembler of the ChatRunCreateRequest. Update the six import sites accordingly. The sse/ folder should contain only inbound SSE wire types and parsers.

#### 🟠 5. sse-client.ts classifies fatal SSE errors by pattern-matching error message strings
`Medium` · `High-confidence` · `ErrorHandling` · rules: `cleanliness.md §10`, `errors.md`, `control-flow.md`  
**Where:** `apps/web/src/lib/api/sse-client.ts:141-149`  

**Problem.** The reconnect-or-fatal decision in the catch block matches err.message against four hard-coded prefix strings: 'SSE event exceeds maximum size', 'Failed to parse SSE ', 'Invalid SSE payload', 'Unknown SSE event type'. These strings are set by sse-stream.ts and events.ts; if either is refactored the coupling silently breaks and previously-fatal errors become retried indefinitely. Error classification by string matching is explicitly warned against by the rules: 'Handle errors by name.' This is also fragile against message text changes during i18n or refactoring.

**Fix.** Introduce a typed SSEFatalError class (or a discriminant property isFatal: true on Error subclasses) in sse-stream.ts and events.ts. Throw SSEFatalError from processJsonEvent and toChatSSEEvent when the error is non-recoverable. In sse-client.ts check `err instanceof SSEFatalError` instead of string prefixes. This eliminates the string-coupling and makes the fatal/retryable boundary explicit and safe to refactor.

#### 🟡 6. isOptionalRecord exported from guards.ts but has no callers — dead export
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §13`  
**Where:** `apps/web/src/lib/api/sse/guards.ts:15-17`  

**Problem.** isOptionalRecord is exported from guards.ts but is not imported anywhere in the codebase (confirmed by exhaustive grep). It is reachable only as a dead export.

**Fix.** Delete the function. If a future caller needs it, it can be added at that point.

#### 🟡 7. stale comment in sse-stream.ts references non-existent sse.ts
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`, `cleanliness.md §12`  
**Where:** `apps/web/src/lib/api/sse-stream.ts:7`  

**Problem.** The module comment says 'application's event shapes — that lives in sse.ts's toChatSSEEvent'. The file sse.ts does not exist; the function lives in sse/events.ts. The stale reference is a documentation drift from a past rename.

**Fix.** Update the comment to reference 'sse/events.ts's toChatSSEEvent'.


<a id="fe-notes"></a>
## Notes (FE)  · `fe-notes`
*10 issues (1 High)*  

> **Verdict.** PagePaneBody.tsx is the dominant god-file in this slice: it fuses page-load orchestration, draft-persistence encoding/decoding, conflict resolution state, title editing, block-diff computation, and ProseMirror document wiring into a single 756-line component. Several smaller but concrete violations compound the problem: (1) `saveLabelForStatus`, `newBlockId`, and the `openObject` resolution flow are each duplicated verbatim between PagePaneBody and HighlightNoteEditor; (2) the `paragraphFromText` helper is defined independently in both `commands.ts` and `schema.ts` despite commands.ts importing from schema.ts; (3) `nodeJsonRecord` in PagePaneBody is a private duplicate of `prosemirrorNodeJson` in schema.ts; (4) `NOTE_LAYOUT_MEASURE_DELAY_MS` is housed in `useNoteEditorSession` but is unrelated to autosave — a foreign constant in the wrong module. The library files (commands.ts, schema.ts, useNoteEditorSession.ts, api.ts) are individually clean and well-scoped; the rot concentrates in the page-level component.


#### 🔴 1. PagePaneBody is a god component: split document-state service from render
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:1-756`  

**Problem.** PagePaneBody.tsx mixes five distinct concerns in one 756-line component: (a) async data loading and cache management via useAsyncResource; (b) ProseMirror document serialisation to persistence format (`readDraftBlocksForPersistence`, `deletedRootBlockIdsForPersistence`, `draftBlockChanged`, `pageDraftMetadataFromStorage`, `flatBlockIds`, `flatBlockParentIds`, `flatBlockRevisions`, `draftBlocksById`); (c) conflict/error UI state and conflict-resolution workflows (`discardLocalDraft`, `overwriteWithLocalDraft`, `loadServerDocument`, `applyLoadedEditorResource`); (d) title-save side-effect; (e) pane-chrome / router wiring. The persistence helpers alone are 180 lines and are already `export`ed, signalling they belong elsewhere. The conflict-resolution callbacks each re-implement the full page-reload sequence (50 lines each, nearly identical). All mutable block-revision bookkeeping (six ref variables) is owned entirely by this component, making it impossible to test the save diffing logic in isolation.

**Fix.** Extract a `useNotePageDocument` hook (or similarly named) into `apps/web/src/lib/notes/useNotePageDocument.ts` that owns: the six block-revision refs, `readDraftBlocksForPersistence`, `deletedRootBlockIdsForPersistence`, and all related helpers; `applyLoadedEditorResource`; `loadServerDocument`; `saveDoc`; and `discardLocalDraft`/`overwriteWithLocalDraft`. Its public interface: `{ initialDoc, page, saveStatus, titleDraft, conflictAction, onDocChange, onBlurFlush, discardLocalDraft, overwriteWithLocalDraft, saveTitle }`. Move the persistence pure functions (`readDraftBlocksForPersistence`, `deletedRootBlockIdsForPersistence`, etc.) to `apps/web/src/lib/notes/noteDocumentPersistence.ts` so they can be unit-tested without a React component. PagePaneBody then becomes a thin renderer: load data, render title input, pass callbacks to ProseMirrorOutlineEditor.

#### 🟠 2. saveLabelForStatus duplicated between PagePaneBody and HighlightNoteEditor
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:556-562` · `apps/web/src/components/notes/HighlightNoteEditor.tsx:324-331`  

**Problem.** Two near-identical private functions `saveLabelForStatus(status: NoteEditorSessionStatus): string` exist in both files. The only semantic difference is the 'saved' branch: PagePaneBody returns `"Saved"` for the default case, HighlightNoteEditor returns `""` for `"saved"` and `""` for the default. Both map the same enumerated status type that is owned by `useNoteEditorSession`. Having two derivers of the same value violates the single-owner rule.

**Fix.** Export a `saveLabelForStatus` function from `apps/web/src/lib/notes/useNoteEditorSession.ts` (the owner of `NoteEditorSessionStatus`) and delete the local copies. Unify the `"saved"` branch behaviour: returning `"Saved"` in HighlightNoteEditor is fine and the empty-string treatment should be moved to the call site where it is conditionally rendered.

#### 🟠 3. paragraphFromText defined in both commands.ts and schema.ts
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/notes/prosemirror/commands.ts:32-34` · `apps/web/src/lib/notes/prosemirror/schema.ts:246-252`  

**Problem.** `paragraphFromText` is defined as a private function in `commands.ts` (line 32) and as a public export in `schema.ts` (line 246). Both do exactly the same thing: `outlineSchema.nodes.paragraph.create(null, text ? outlineSchema.text(text) : null)`. `commands.ts` already imports from `schema.ts` (line 6), so it could simply import the exported version instead of defining its own.

**Fix.** Delete `paragraphFromText` from `commands.ts` and import the already-exported version from `schema.ts`. One owner, one definition.

#### 🟠 4. openObject navigation callback duplicated between PagePaneBody and HighlightNoteEditor
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:438-454` · `apps/web/src/components/notes/HighlightNoteEditor.tsx:235-250`  

**Problem.** Both components implement an `openObject` callback with identical logic: guard with `isObjectType`, call `resolveObjectRefs([{ objectType, objectId }])`, extract `resolved?.route`, handle error, then navigate. The only difference is how they navigate (one uses `router.push` or `openInNewPaneCommand`, the other calls `onOpenLink`). The resolution step — validate type, fetch route, handle error — is the duplicated business logic.

**Fix.** Extract a `resolveObjectRefRoute(objectType: string, objectId: string): Promise<string | null>` helper into `apps/web/src/lib/objectRefs.ts` (or a wrapper exported from there). Each call site retains only the navigation step. Alternatively, expose `onOpenObject` as a hook `useOpenNoteObject(navigate)` in a shared notes UI hook file that both components import.

#### 🟠 5. readDraftBlocksForPersistence and deletedRootBlockIdsForPersistence are exported from a render component to enable tests — production seam
`Medium` · `High-confidence` · `Tests` · rules: `cleanliness.md §11`, `cleanliness.md §5`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:576-629` · `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.test.tsx:9-10`  

**Problem.** `readDraftBlocksForPersistence` and `deletedRootBlockIdsForPersistence` are pure functions that encode document diffing logic. They are `export`ed from PagePaneBody.tsx solely because the test file imports them directly. A render component should not export business-logic helpers to satisfy tests — this is a production seam kept alive for testing purposes (cleanliness.md §11). The helpers also have no callers outside the component itself and its test file.

**Fix.** Move these functions (and the other pure helpers: `draftBlockChanged`, `pageDraftMetadataFromStorage`, `flatBlockIds`, `flatBlockParentIds`, `flatBlockRevisions`) to `apps/web/src/lib/notes/noteDocumentPersistence.ts`. Export them from there. Update the test to import from the library file. PagePaneBody.tsx no longer needs to export anything other than the default component.

#### 🟠 6. Dual camelCase/snake_case field normalisation in api.ts is a legacy-compat shim
`Medium` · `Medium-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/notes/api.ts:128-163`  

**Problem.** `normalizeBlock` checks both `raw.pageId ?? raw.page_id`, `raw.parentBlockId ?? raw.parent_block_id`, `raw.blockKind ?? raw.block_kind`, `raw.bodyPmJson ?? raw.body_pm_json`, `raw.bodyMarkdown ?? raw.body_markdown`, `raw.createdAt ?? raw.created_at`, `raw.updatedAt ?? raw.updated_at`. This dual-key pattern is a migration-era compatibility shim: the API was either transitioning from snake_case to camelCase or vice versa. The `saveNotePageDocument` serialisation (lines 296–312) always sends snake_case to the server. If the server now returns a single casing, the fallback branch is dead code. If both casings are still possible, this is an unresolved dual-format state that should be resolved at the transport boundary.

**Fix.** Confirm with the FastAPI response schema which casing the server currently returns. If the server has settled on one format, remove all fallback branches in `normalizeBlock` and `normalizePageSummary`. If the server is inconsistent, fix it there and remove the shim here. Either way, eliminate the dual-key lookups so the boundary parse is explicit and single-path.

#### 🟡 7. nodeJsonRecord in PagePaneBody duplicates prosemirrorNodeJson in schema.ts
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:568-574` · `apps/web/src/lib/notes/prosemirror/schema.ts:10-15`  

**Problem.** `nodeJsonRecord` in PagePaneBody is identical to the private `prosemirrorNodeJson` in schema.ts: both call `node.toJSON()`, assert `isRecord`, and throw on failure. The schema version is private; the page version is a private local copy. Because the persistence helpers are candidates for extraction to a shared module, this duplication should be resolved before that refactor.

**Fix.** Export `prosemirrorNodeJson` from `schema.ts` (or name it `nodeToJsonRecord`), delete `nodeJsonRecord` from PagePaneBody, and import the shared version. If the persistence helpers move to a separate module, this shared utility moves with schema.ts.

#### 🟡 8. newBlockId wrapper function duplicated in PagePaneBody and HighlightNoteEditor
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:552-554` · `apps/web/src/components/notes/HighlightNoteEditor.tsx:296-298`  

**Problem.** Both files define `function newBlockId(): string { return createRandomId(); }` — a one-liner wrapper that renames `createRandomId`. The function adds no complexity; its only purpose is aliasing.

**Fix.** Delete both `newBlockId` wrappers and pass `createRandomId` directly at each call site (e.g., `createBlockId={createRandomId}`), or export a single `newNoteBlockId` from a shared notes utilities file if the name is important for readability.

#### 🟡 9. NOTE_LAYOUT_MEASURE_DELAY_MS is a foreign constant in useNoteEditorSession
`Low` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/lib/notes/useNoteEditorSession.ts:11` · `apps/web/src/components/reader/ReaderHighlightsSurface.tsx:26`  

**Problem.** `NOTE_LAYOUT_MEASURE_DELAY_MS` (100 ms) is a layout measurement debounce constant used exclusively by `ReaderHighlightsSurface` — a reader component unrelated to autosave. It is housed in `useNoteEditorSession.ts` alongside `NOTE_AUTOSAVE_IDLE_DELAY_MS` and `NOTE_AUTOSAVE_MAX_WAIT_MS`, creating a false coupling: the reader must import from the note-autosave module to get a timing constant. This violates the principle that a module's public surface should contain only what its callers actually need from that capability.

**Fix.** Move `NOTE_LAYOUT_MEASURE_DELAY_MS` to `ReaderHighlightsSurface.tsx` as a module-local constant (it has a single caller), or to a `readerConstants.ts` file if other reader components share it. Remove the export from `useNoteEditorSession.ts`.

#### 🟡 10. object_embed toDOM emits redundant duplicate data attributes
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/lib/notes/prosemirror/schema.ts:155-158`  

**Problem.** The `object_embed` node's `toDOM` serialisation emits both `data-object-type`/`data-object-id` and `data-object-embed-type`/`data-object-embed-id` with identical values. The `parseDOM` selector uses only `data-object-embed-type`/`data-object-embed-id`. The click handler in ProseMirrorOutlineEditor queries `[data-object-type][data-object-id]`, which is used by `object_ref` elements. The two extra attributes (`data-object-type` and `data-object-id`) on `object_embed` are either redundant or they cause embed clicks to be misrouted through the `objectRef` handler path.

**Fix.** Decide whether `object_embed` should share the `[data-object-type][data-object-id]` click-handling path with `object_ref`, or have its own. If yes, remove `data-object-embed-type`/`data-object-embed-id` (and update `parseDOM`). If no, remove `data-object-type`/`data-object-id` from `object_embed.toDOM`. Either way, eliminate the redundant pair.


<a id="fe-podcast-panes"></a>
## Podcast panes (FE)  · `fe-podcast-panes`
*9 issues (2 High)*  

> **Verdict.** PodcastDetailPaneBody.tsx is a 2099-line god file that unifies unrelated concerns — podcast data fetching, episode data fetching, episode transcript request/forecast/polling, episode library membership, podcast library membership, subscription management, mark-played state, mobile drawer layout, and inline settings modal rendering — into one component body. The worst rot is there: 73 hook calls, 15+ async action handlers, two parallel load paths (useAsyncResource and a manual load() callback), and inline replication of a settings modal that already exists as a standalone component (PodcastSubscriptionSettingsModal). PodcastsPaneBody.tsx (764 lines) duplicates the same subscribe/unsubscribe/library-management mutation flows already written in PodcastDetailPaneBody, without using the existing useLibraryMembership hook. Both module docs are empty, so there is no design contract to drift from, but that absence is itself a finding.


#### 🔴 1. Split PodcastDetailPaneBody: separate episode list, subscription header, transcript machine, and layout shell
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:103-2099`  

**Problem.** At 2099 lines and 73 hook calls, PodcastDetailPaneBody.tsx mixes at least seven unrelated concerns in one component body: (1) podcast detail + subscription data loading (useAsyncResource + a manual load() imperative reload, lines 291-442); (2) episode list fetching and pagination (lines 552-590); (3) podcast and episode library membership state machines (lines 227-286, 498-550, 622-671); (4) episode completion marking with optimistic update (lines 917-998, 1033-1088); (5) transcript request/forecast/batch-request/polling state machine (~350 lines, 1161-1400); (6) mobile drawer + keyboard trap (lines 477-496, 2069-2097); (7) inline settings modal rendering (lines 1999-2067) even though PodcastSubscriptionSettingsModal already exists as a component used by PodcastsPaneBody. The single component holds 15+ async action handlers and accumulates a single error state that is shared across all of them, making error provenance impossible to trace.

**Fix.** Decompose into focused units with small public contracts:
- `usePodcastDetail(podcastId)` — owns the podcast+subscription+episode fetch, caching, and reload trigger; exposes `{ detail, episodes, loading, error, reload }`.
- `usePodcastLibraryMembership(podcastId)` — owns the podcast-level library fetch, add, remove flows; modeled after the existing `useLibraryMembership` hook.
- `useEpisodeLibraries(mediaId | null)` — owns per-episode library membership, delegating to the existing `useLibraryMembership` pattern.
- `useEpisodeCompletion(episodes, episodeStateFilter)` — owns mark-played / mark-all-played optimistic mutations.
- `useTranscriptMachine(episodes, transcriptionAllowed)` — owns forecast polling, single-request, and batch-request flows; exposes `{ forecastByMediaId, requestTranscript, batchRequest, reasonByMediaId, setReason }`.
- `EpisodeListPane` — pure rendering of the filtered/sorted episode list, accepting the above states as props.
- `PodcastHeaderPane` — renders the subscription header (PodcastSummaryCard, subscribe/unsubscribe actions).
- `PodcastDetailPaneBody` — thin layout shell that composes the above and delegates the mobile drawer; its JSX should shrink to ~100 lines.

#### 🔴 2. Duplicate podcast subscription mutation flows in PodcastsPaneBody and PodcastDetailPaneBody
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx:262-432` · `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:227-748`  

**Problem.** Both pane bodies independently implement the same mutation flows with nearly identical structure: `loadPodcastLibraries` (PodcastsPaneBody:262, PodcastDetailPaneBody:227), `handleAddPodcastToLibrary` (PodcastsPaneBody:289, PodcastDetailPaneBody:622), `handleRemovePodcastFromLibrary` (PodcastsPaneBody:338, PodcastDetailPaneBody:648), `handleUnsubscribe` (PodcastsPaneBody:376, PodcastDetailPaneBody:708), and `handleRefreshSync` (PodcastsPaneBody:412, PodcastDetailPaneBody:674). Each copy maintains its own busy-key tracking, error state, and optimistic update logic. Both also call `fetchPodcastLibraries`, `addPodcastToLibrary`, `removePodcastFromLibrary`, `unsubscribeFromPodcast`, `refreshPodcastSubscriptionSync`, and `buildPodcastUnsubscribeConfirmation` directly. The flows differ only in how they patch their local rows (list vs single record), not in the mutation logic.

**Fix.** Extract a `usePodcastSubscriptionActions(podcastId, { onUnsubscribed, onSynced, onLibraryChanged })` hook that owns all mutation flows and their busy/error state. Expose a small typed interface: `{ subscribe, unsubscribe, refreshSync, addToLibrary, removeFromLibrary, loadLibraries, libraries, librariesLoading, busy, error }`. Both pane bodies call only this hook and handle local row patching in their callbacks. Move the mutation implementations out of both components and delete all four duplicated `handleXxx` and `loadPodcastLibraries` definitions.

#### 🟠 3. Inline modal in PodcastDetailPaneBody duplicates the already-extracted PodcastSubscriptionSettingsModal component
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:1999-2067` · `apps/web/src/app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal.tsx:14-83`  

**Problem.** PodcastSubscriptionSettingsModal.tsx is a dedicated component for the subscription settings modal, used by PodcastsPaneBody.tsx:761. PodcastDetailPaneBody.tsx does not use it — instead it re-implements the same modal inline (lines 1999-2067), with the same fields (default playback speed select, auto-queue checkbox), the same hook state from `usePodcastSubscriptionSettingsModal`, and the same actions. The two modal implementations differ only in minor copy ('Save subscription settings' vs 'Save', 'Close' vs 'Cancel', one extra description paragraph). Two implementations of the same modal with the same backing state machine violate cleanliness §4.

**Fix.** Replace the inline modal block in PodcastDetailPaneBody (lines 1999-2067) with `<PodcastSubscriptionSettingsModal settingsRow={...} settingsModal={settingsModal} />`. Reconcile the minor copy differences inside PodcastSubscriptionSettingsModal (add an optional `descriptionExtra` slot or accept the podcast title directly). Delete the 68-line inline block.

#### 🟠 4. PodcastDetailPaneBody bypasses the existing useLibraryMembership hook for episode library state
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:150-155,259-285,498-549` · `apps/web/src/lib/media/useLibraryMembership.ts:30-129`  

**Problem.** `useLibraryMembership` at `src/lib/media/useLibraryMembership.ts` already owns the per-media library fetch, add, and remove flow with busy and error tracking. PodcastDetailPaneBody instead maintains its own parallel implementation: `episodeLibrariesById` (Record keyed by mediaId), `loadingEpisodeLibraryMediaIds` (a string-id set), `loadEpisodeLibraries` (lines 259-285), `handleAddToLibrary` (lines 498-523), and `handleRemoveFromLibrary` (lines 525-549). This duplicates the owned capability without extending it. The only difference is that PodcastDetailPaneBody tracks multiple episodes simultaneously (one panel open at a time), which the hook could handle with a `mediaId` parameter change.

**Fix.** Use `useLibraryMembership(episodeMembershipPanelMediaId)` from `@/lib/media/useLibraryMembership` for the active episode's panel state. When `episodeMembershipPanelMediaId` changes, the hook resets automatically (it already clears on `mediaId` change). Delete `episodeLibrariesById`, `loadingEpisodeLibraryMediaIds`, `loadEpisodeLibraries`, `handleAddToLibrary`, and `handleRemoveFromLibrary` from PodcastDetailPaneBody.

#### 🟠 5. Dual load paths for podcast detail create dead/unreachable imperative load() alongside the useAsyncResource declarative path
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:291-301,368-442`  

**Problem.** Two parallel loading mechanisms drive the same data. `podcastDetailResource` (useAsyncResource, line 368) owns the initial and filter-change loads; its `status` drives `setLoading`/`setError` via a `useEffect` (lines 373-401). A second manual `load()` callback (lines 403-442) re-implements the same fetch+apply logic to support post-mutation reloads (subscribe, refreshSync, batchTranscript). Both paths call `fetchPodcastDetail` and `applyPodcastDetailLoad`, but the manual path maintains its own `loadRequestIdRef` and `podcastDetailCacheKeyRef` stale-check machinery. The overlap means two code paths can be active, and errors from one path can overwrite state from the other. Comments added to `podcastDetailCacheKeyRef.current` (line 301) are a symptom of this complexity.

**Fix.** Consolidate: let `useAsyncResource` own all loads. Expose a `reload()` trigger from the hook or implement a `reloadKey` increment pattern so post-mutation refreshes go through the same path. Delete the manual `load()` callback, `loadRequestIdRef`, `podcastDetailCacheKeyRef`, and the associated stale-check logic (~40 lines). The `applyPodcastDetailLoad` effect (lines 349-366) becomes the single consumer of the resource's `ready` state.

#### 🟡 6. Duplicate podcast artwork initials generation in PodcastsPaneBody and PodcastSummaryCard
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx:626-633` · `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastSummaryCard.tsx:33-40`  

**Problem.** Both components generate podcast artwork initials using an identical inline expression: `title.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "P"`. The logic — split on whitespace, take first two words, extract first character uppercased, fall back to "P" — is not trivially obvious and is large enough to name and deduplicate.

**Fix.** Extract `getPodcastInitials(title: string): string` into a shared location (e.g. a new `src/lib/podcast/formatters.ts` or alongside the existing `podcastSubscriptions.ts` helpers). Both components call the function. This removes 8 duplicated lines and gives the pattern a name and a test site.

#### 🟡 7. refreshEpisodeState is a one-line wrapper around refreshEpisodeStates with no added value
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:791-796`  

**Problem.** `refreshEpisodeState(mediaId)` (lines 791-795) is a `useCallback` that does exactly one thing: call `refreshEpisodeStates([mediaId])`. It wraps a single-element array construction. Both names are nearly identical. The only caller is `handleRequestTranscript` (line 1378), which could call `refreshEpisodeStates` directly.

**Fix.** Delete `refreshEpisodeState`. Replace the call at line 1378 with `await refreshEpisodeStates([mediaId])`.

#### 🟡 8. Module docs for podcast and player are empty — intended design is undocumented
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`, `cleanliness.md §12`  
**Where:** `docs/modules/podcast.md` · `docs/modules/player.md`  

**Problem.** Both module docs contain zero content (single blank line). The audit instruction cites these files as the intended design. Their absence means there is no documented boundary for what the podcast pane or player module owns, making ownership and layering violations invisible to future contributors.

**Fix.** Write minimal module docs: for podcast.md, describe what the podcast pane module owns (subscription lifecycle, episode list, transcript requesting, library membership for podcasts and episodes) and what it does NOT own (generic media library CRUD, player state). For player.md, describe the global player's public contract. These docs should then immediately surface the violations found in this audit (e.g. episode library membership should delegate to the media library module rather than re-implementing it).

#### 🟡 9. getPodcastSubscriptionSyncPatch and getPodcastSubscriptionSettingsPatch are thin property-renaming helpers below the inline threshold
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/podcasts/podcastSubscriptions.ts:204-227`  

**Problem.** `getPodcastSubscriptionSyncPatch` (4 lines) picks four snake_case fields from a response object and returns them as-is. `getPodcastSubscriptionSettingsPatch` (7 lines) picks two fields and adds a single null-coalesce on `updated_at`. Both functions are helpers that only rename/subset properties, adding no domain logic. Callers spread the result directly into state. cleanliness §7 says to inline one-use helpers that only rename property access unless they hide real complexity.

**Fix.** Inline the body of each function at their call sites (PodcastsPaneBody:107,422 and PodcastDetailPaneBody:198,691). Delete both exported functions. If the spreading is considered meaningful, move these pure derivations inside the hooks/components that use them rather than exporting them as public API from podcastSubscriptions.ts.


<a id="fe-library-panes"></a>
## Library panes (FE)  · `fe-library-panes`
*8 issues (2 High)*  

> **Verdict.** LibraryPaneBody.tsx is a 1143-line god file that mixes at least six distinct concerns inside a single component function: data fetching and cache management, library entry list rendering (two separate item types), media processing mutation orchestration, library membership panel state, edit dialog state + all CRUD mutations, and secondary pane wiring. The worst rot is the complete duplication of the edit-dialog mutation suite (openEditDialog / closeEditDialog / handleRename / handleUpdateMemberRole / handleRemoveMember / handleCreateInvite / handleSearchUsers / handleRevokeInvite / handleDeleteFromDialog) between LibraryPaneBody and LibrariesPaneBody; these eight handlers are nearly identical in both files and call the same API endpoints with the same logic. A secondary problem is the duplicate LibrarySummary type in both LibraryMultiSelectPicker.tsx and mediaLibraries.ts, and the duplicate anchored-dropdown positioning logic shared by LibraryMembershipPanel and LibraryMultiSelectPicker.


#### 🔴 1. Split LibraryPaneBody god file: extract entry list, media processing, library-panel, and edit-dialog concerns
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:170-1143`  

**Problem.** The 1143-line component mixes: (1) data fetching (lines 185-250), (2) library membership panel state machine (9 state variables + open/close/add/remove handlers, lines 208-462), (3) media processing mutation orchestration (runMediaProcessingMutation, handleRetryProcessing, handleRefreshSource, handleDeleteMedia, lines 465-571), (4) library-level delete and the complete edit-dialog CRUD suite (lines 573-715), (5) secondary pane wiring (lines 789-835), and (6) two separate renderItem bodies for podcast and media entries (lines 904-1119). The top-level function signature owns all of these unrelated phases simultaneously.

**Fix.** Decompose into: (a) a useLibraryEditDialog hook (owns editOpen, editMembers, editInvites, openEditDialog, closeEditDialog, handleRename, handleUpdateMemberRole, handleRemoveMember, handleCreateInvite, handleSearchUsers, handleRevokeInvite, handleDeleteFromDialog — accepts libraryId + onAfterDelete callback, returns the state and handler bundle); (b) a useLibraryMembershipPanel hook (owns the 6 libraryPanel* state vars + openLibraryPanel / closeLibraryPanel / handleAddToLibrary / handleRemoveFromLibrary — accepts libraryId + entries + onEntriesChange); (c) a LibraryMediaRow component (owns the per-media-item rendering with its inline statusLabel/publishedDate/metaParts logic); (d) a LibraryPodcastRow component (owns per-podcast rendering). The remaining LibraryPaneBody then becomes a thin orchestrator: fetch data, compose the hooks, render the two row types.

#### 🔴 2. Collapse duplicated library edit-dialog mutation suite in LibrariesPaneBody and LibraryPaneBody
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx:134-256` · `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:599-715`  

**Problem.** Both files independently implement openEditDialog, closeEditDialog, handleRename, handleUpdateMemberRole, handleRemoveMember, handleCreateInvite, handleRevokeInvite, handleSearchUsers, and handleDeleteFromDialog. The eight handlers issue identical apiFetch calls to /api/libraries/{id}/members, /api/libraries/{id}/invites, /api/libraries/invites/{id}, and /api/libraries/{id}. The invitee-type detection logic (isEmail = inviteeIdentifier.includes('@'), then conditional invitee_email vs invitee_user_id spread) is copied verbatim between the two files (LibrariesPaneBody.tsx:202-210, LibraryPaneBody.tsx:667-675).

**Fix.** Extract a useLibraryEditDialog(libraryId, options) hook into apps/web/src/lib/libraries/useLibraryEditDialog.ts. It owns the local state (editOpen, editMembers, editInvites) and all handlers, and accepts an onDeleted callback so LibrariesPaneBody can remove the deleted item from its list while LibraryPaneBody can navigate away. Both pane bodies become: const editDialog = useLibraryEditDialog(library.id, { onDeleted }). The isEmail detection belongs inside the hook's handleCreateInvite, not duplicated at the call sites.

#### 🟠 3. Duplicate LibrarySummary type defined in both LibraryMultiSelectPicker and mediaLibraries
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/components/LibraryMultiSelectPicker.tsx:21-25` · `apps/web/src/lib/media/mediaLibraries.ts:12-17`  

**Problem.** LibraryMultiSelectPicker exports LibrarySummary { id, name, color? } while mediaLibraries exports LibrarySummary { id, name, is_default, color? } — two structurally near-identical types with the same name living in different modules. Callers of LibraryMultiSelectPicker (AddContentTray, ShareCapture, PodcastDetailPaneBody, BrowsePaneBody) fetch libraries via useNonDefaultLibraries which returns LibraryTargetPickerItem[] and then remap to the component's LibrarySummary, discarding fields. This is a split type contract for the same logical concept.

**Fix.** Canonicalize one LibrarySummary in apps/web/src/lib/libraries/ (or in mediaLibraries.ts as the existing data-fetch owner) and have LibraryMultiSelectPicker import that type. The component's LibrarySummary should be the single definition; mediaLibraries.ts's LibrarySummary is the response-mapping type and can be inlined or aliased. Callers currently doing .map((lib) => ({id: lib.id, name: lib.name, color: lib.color})) can pass LibrarySummary[] directly once the types are unified.

#### 🟠 4. Duplicated anchored-dropdown positioning logic in LibraryMembershipPanel and LibraryMultiSelectPicker
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/LibraryMembershipPanel.tsx:105-125` · `apps/web/src/components/LibraryMultiSelectPicker.tsx:347-373`  

**Problem.** Both components independently implement the same anchored-panel positioning pattern: a useState for { top, left, width }, an updatePanelStyle function that reads anchorEl.getBoundingClientRect(), clamps to viewport with maxLeft = window.innerWidth - width - 8, and registers/deregisters resize and scroll listeners. The positioning math (rect.bottom + 6, Math.max(8, Math.min(rect.left, maxLeft))) is identical.

**Fix.** Extract a useAnchoredPanel(anchorEl, options) hook that owns the panelStyle state and the event listener lifecycle, returning panelStyle. Both components replace their useEffect blocks with a single hook call. If ActionMenu.tsx already has similar logic (it does at line 117), consider whether a shared useAnchoredPanel lives in apps/web/src/lib/ui/ alongside useDismissOnOutsideOrEscape.

#### 🟠 5. Library-membership mutation logic scattered: podcast add/remove owned by LibraryPaneBody instead of a service
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:356-362` · `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:422-428`  

**Problem.** Podcast library membership mutations (POST /api/libraries/{id}/podcasts, DELETE /api/libraries/{id}/podcasts/{podcastId}) are issued as raw apiFetch calls inside LibraryPaneBody's handleAddToLibrary and handleRemoveFromLibrary. The parallel media operations for the same panel go through mediaLibraries.ts helpers (addMediaToLibrary, removeMediaFromLibrary), but the podcast equivalents are inlined at the call site with no shared owner. If podcast library mutations need to change, there is no single place to update.

**Fix.** Add addPodcastToLibrary(podcastId, libraryId) and removePodcastFromLibrary(podcastId, libraryId) to a canonical location — either apps/web/src/app/(authenticated)/podcasts/podcastSubscriptions.ts (which already owns podcast library fetching) or a new apps/web/src/lib/libraries/podcastLibraries.ts. LibraryPaneBody (and future callers) then call the named function rather than raw apiFetch.

#### 🟠 6. runMediaProcessingMutation re-implements logic already owned by useDocumentActions
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:465-541` · `apps/web/src/lib/media/useDocumentActions.ts:85-122`  

**Problem.** LibraryPaneBody defines a runMediaProcessingMutation helper that retries or refreshes a media item (calling retryMediaSource or POST /api/media/{id}/refresh, then showing success/error feedback). useDocumentActions.ts already owns handleRetry and handleRefresh with the same calls, the same feedback strings ('Processing retry started.', 'Source refresh started.'), and the same busy-flag pattern. The library version additionally updates local entry state afterward, but the core API call and feedback logic is duplicated. The endpoint discriminator (args.endpoint === '/retry') is an especially telling smell — it strings-dispatches to two different client functions.

**Fix.** Refactor runMediaProcessingMutation to call the shared retry/refresh helpers from useDocumentActions or retryClient.ts. The local-state patch (setting processing_status to 'extracting', patching capabilities) is the only piece unique to LibraryPaneBody; keep that in a callback passed to a shared hook, or apply it in the handleRetryProcessing/handleRefreshSource callers. Remove the endpoint string-dispatch entirely.

#### 🟡 7. LibraryMultiSelectPicker injects a runtime <style> tag to work around missing CSS module
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §1`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/LibraryMultiSelectPicker.tsx:137-143` · `apps/web/src/components/LibraryMultiSelectPicker.tsx:414` · `apps/web/src/components/LibraryMultiSelectPicker.tsx:497`  

**Problem.** STYLE_BLOCK is a raw CSS string injected via <style>{STYLE_BLOCK}</style> inside two render paths (DropdownPicker and ModalPicker). This is a workaround: the component uses inline CSSProperties for most styling but falls back to a runtime style injection for hover/focus/disabled states that cannot be expressed inline. The result is that styles are duplicated into the DOM once per rendered picker instance, and the class names (lib-multi-item, lib-multi-trigger-label, lib-multi-search-input) are global strings with no scoping.

**Fix.** Move styles to a LibraryMultiSelectPicker.module.css file alongside the component, replacing the STYLE_BLOCK constant and the two <style> tags. Inline CSSProperties constants (PANEL_STYLE, LIST_STYLE, ITEM_STYLE, etc.) can also migrate to CSS classes, removing ~80 lines of style object declarations.

#### 🟡 8. Local Library interface defined twice instead of sharing a canonical type
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`  
**Where:** `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx:29-37` · `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:79-86`  

**Problem.** Both pane bodies define a local interface Library with overlapping fields (id, name, is_default, role, owner_user_id). LibrariesPaneBody adds created_at and updated_at; LibraryPaneBody omits them. These represent the same API response shape but are independently maintained. If a new field is added to the backend response, both interfaces must be updated separately.

**Fix.** Define a canonical Library type in apps/web/src/lib/libraries/ (e.g., a types.ts file). LibrariesPaneBody uses the superset (with created_at/updated_at); LibraryPaneBody can use the same type or a Pick. This also gives a natural home for LibraryEntry, LibraryMediaEntry, LibraryPodcastEntry, and LibraryPodcastSubscription, which are currently defined only inside LibraryPaneBody.tsx.


<a id="fe-search"></a>
## Search (FE)  · `fe-search`
*8 issues (1 High)*  

> **Verdict.** The search slice is generally well-structured — the boundary parsing, view-model adaptation, and rendering layers are clearly separated. The most significant problem is that resultRowAdapter.ts conflates two unrelated concerns (HTTP transport + query param serialization with view-model derivation), which creates an over-wide public surface. A secondary problem is that URL param parsing and search-href construction live entirely inside the rendering component (SearchPaneBody) rather than in the owning lib. The remaining issues are smaller: a dead CSS class, duplicated type-toggle logic, an overly broad union type, and internal-only interfaces that are publicly exported.


#### 🔴 1. resultRowAdapter.ts mixes HTTP transport with view-model derivation
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/lib/search/resultRowAdapter.ts:1-301` · `apps/web/src/lib/search/resultRowAdapter.ts:13-56 (buildSearchQueryParams — transport concern)` · `apps/web/src/lib/search/resultRowAdapter.ts:58-262 (sanitizeSnippet, parseSnippetSegments, buildSourceMeta, buildPrimaryText, getContributorCredits, adaptSearchResultRow — view-model derivation)`  

**Problem.** resultRowAdapter.ts is responsible for two entirely separate concerns: (1) building the search API query-string and issuing the HTTP request (fetchSearchResultPage + buildSearchQueryParams), and (2) deriving the view-model from the normalized API result (adaptSearchResultRow, buildPrimaryText, buildSourceMeta, getContributorCredits, parseSnippetSegments, sanitizeSnippet). These phases have different change reasons, different test surfaces, and different ownership. The HTTP layer is called directly from both SearchPaneBody and CommandPalette, but the view-model helpers are never needed outside this file. Mixing them prevents each concern from being reasoned about in isolation.

**Fix.** Split into two files. Keep resultRowAdapter.ts as a pure stateless module exporting only adaptSearchResultRow (or rename to searchViewModel.ts). Extract fetchSearchResultPage + buildSearchQueryParams into a new searchApi.ts (or searchClient.ts) that owns the HTTP transport concern exclusively. The public contract of searchApi.ts is fetchSearchResultPage({...}: FetchSearchResultPageInput): Promise<SearchResultPage>. The view-model file's public contract is adaptSearchResultRow(result: SearchApiResult): SearchResultRowViewModel. normalizeSearchResult stays in its own file and is called by fetchSearchResultPage at the boundary. This matches cleanliness §8: edge adapters translate at the edge, view-model derivation is a separate stateless helper.

#### 🟠 2. URL param parsing and search-href construction belong in lib/search, not in the rendering component
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx:81-154 (parseSelectedTypes, parseCommaList, parseContributorHandles, buildSearchHref)` · `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx:37-79 (SEARCH_TYPE_LABELS, SEARCH_ROLE_FILTERS, SEARCH_CONTENT_KIND_FILTERS)`  

**Problem.** The logic that serializes and deserializes the search URL (parseSelectedTypes, parseCommaList, buildSearchHref) and the canonical label maps (SEARCH_TYPE_LABELS, SEARCH_ROLE_FILTERS, SEARCH_CONTENT_KIND_FILTERS) live inside the rendering component. Per layers.md and cleanliness §6, business/domain logic should live in the owning unit (lib/search/), not in a rendering file. If a second surface (e.g., a future deep-link generator or a server-side redirect) needs to produce or parse search URLs, it would have to duplicate this logic or import from a component file.

**Fix.** Move parseSelectedTypes, parseCommaList, buildSearchHref, SEARCH_TYPE_LABELS, SEARCH_ROLE_FILTERS, and SEARCH_CONTENT_KIND_FILTERS into a new lib/search/searchParams.ts. SearchPaneBody imports them from there. The public contract is: parseSearchParams(params: URLSearchParams): SearchFilterState and buildSearchHref(state: SearchFilterState): string. This keeps the rendering component as a thin dispatcher and puts URL-shape knowledge where it belongs.

#### 🟠 3. SearchMediaResult union type conflates three distinct API shapes under one interface
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §5`  
**Where:** `apps/web/src/lib/search/types.ts:49-52 (SearchMediaResult covers type: 'media' | 'episode' | 'video')` · `apps/web/src/lib/search/normalizeSearchResult.ts:189-232 (separate switch cases for 'media', 'episode'/'video')` · `apps/web/src/lib/search/resultRowAdapter.ts:196-199 (getContributorCredits checks for all three separately)`  

**Problem.** SearchMediaResult declares type as 'media' | 'episode' | 'video', which means the type field is not a discriminant — a consumer cannot narrow to a single variant. The normalizer already treats 'media' differently from 'episode'/'video' (line 191 vs 212 checks context_ref.type). This union on a single interface is an under-discriminated type: consumers must reconstruct the discrimination by hand, violating cleanliness §9.

**Fix.** Split into three single-type interfaces: SearchMediaItemResult (type: 'media'), SearchEpisodeResult (type: 'episode'), SearchVideoResult (type: 'video'). They can share a SearchMediaBackedResult base interface with the source: SearchSourceMetadata field. Update the SearchApiResult union accordingly. This makes all switch/if-chains on type exhaustive and removes the need for hand-reconstructed narrowing.

#### 🟡 4. Dead .askLink CSS class in SearchResultRow.module.css
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`  
**Where:** `apps/web/src/components/search/SearchResultRow.module.css:56-67 (.askLink, .askLink:hover)`  

**Problem.** The .askLink and .askLink:hover rules are defined in SearchResultRow.module.css but the class is never applied anywhere in SearchResultRow.tsx or any other file. This is dead CSS.

**Fix.** Delete lines 56-67 from SearchResultRow.module.css.

#### 🟡 5. toggleType duplicates the toggleValue helper rather than using it
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx:156-163 (toggleValue)` · `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx:264-279 (toggleType — inlines equivalent add/remove logic)`  

**Problem.** toggleValue (line 156) handles toggling a string in an array with deduplication. toggleType (line 264) implements the same add/remove/dedup pattern inline instead of calling toggleValue, and then additionally re-orders via ALL_SEARCH_TYPES.filter. The dedup step inside toggleType (lines 267-269) is equivalent to toggleValue's logic — if toggleValue were used for the add branch, the dedup filter at line 273 would still be needed for ordering, but the inline add-and-dedup at 267-269 would be eliminated.

**Fix.** Replace the add-branch of toggleType with toggleValue(selectedTypes, type) so the dedup logic is not duplicated. The re-ordering step (ALL_SEARCH_TYPES.filter) is the only type-specific logic and should remain.

#### 🟡 6. Internal-only types exported from types.ts inflate public surface
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/lib/search/types.ts:23 (SearchSourceMetadata — only used in normalizeSearchResult.ts and resultRowAdapter.ts)` · `apps/web/src/lib/search/types.ts:31 (SearchBaseResult — never imported outside lib/search/)` · `apps/web/src/lib/search/types.ts:49-163 (SearchMediaResult, SearchPodcastResult, … all individual sub-types — never imported outside lib/search/)` · `apps/web/src/lib/search/types.ts:151 (SearchApiResult union — only consumed inside lib/search/)` · `apps/web/src/lib/search/types.ts:165 (SearchResponseShape — only consumed inside resultRowAdapter.ts)`  

**Problem.** types.ts exports twelve internal interfaces (SearchBaseResult, SearchSourceMetadata, SearchMediaResult and all nine other sub-types, SearchApiResult, SearchResponseShape) that are consumed only within lib/search/ itself. External callers only ever import SearchResultRowViewModel, SearchType, ALL_SEARCH_TYPES, FetchSearchResultPageInput, and SearchResultPage. Exporting internal types widens the module's public contract and couples external code to internal structure if they are accidentally used.

**Fix.** Remove the export keyword from SearchBaseResult, SearchSourceMetadata, SearchMediaResult, SearchPodcastResult, SearchContributorResult, SearchContentChunkResult, SearchFragmentResult, SearchNoteBlockResult, SearchHighlightResult, SearchPageResult, SearchMessageResult, SearchEvidenceSpanResult, SearchConversationResult, SearchWebResult, SearchApiResult, and SearchResponseShape. Keep only SearchType, ALL_SEARCH_TYPES, SearchResultRowViewModel, FetchSearchResultPageInput, and SearchResultPage as public exports. If normalizeSearchResult needs to remain exported for tests, consider keeping SearchApiResult exported, but the rest can be internal.

#### 🟡 7. normalizeSearchResult is exported but has only one internal caller
`Low` · `High-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/search/normalizeSearchResult.ts:130 (export function normalizeSearchResult)` · `apps/web/src/lib/search/resultRowAdapter.ts:256 (only caller)`  

**Problem.** normalizeSearchResult is exported but its only production caller is resultRowAdapter.ts within the same lib/search/ folder. The export exists, but no external module imports it. Per cleanliness §6, the public surface should be shrunk to what is actually called externally.

**Fix.** Remove the export keyword from normalizeSearchResult. It becomes a module-private helper called by fetchSearchResultPage. If a test needs it directly, consider whether the behavior is already covered by the fetchSearchResultPage integration tests in resultRowAdapter.test.ts — if so, no test-only export seam is needed.

#### 🟡 8. page.tsx wrapper adds no value — thin passthrough component
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/search/page.tsx:1-7`  

**Problem.** page.tsx is a 7-line file that contains only a default export wrapping SearchPaneBody in a fragment with no added props, layout, metadata, or logic. It is a pure passthrough. The 'use client' directive is redundant since SearchPaneBody already carries it. This level of indirection adds file-system noise without hiding any real complexity.

**Fix.** Inline the page content: either rename SearchPaneBody.tsx to page.tsx and remove the wrapper, or keep SearchPaneBody.tsx for naming clarity and remove the 'use client' directive from page.tsx (since it inherits it from the child). If Next.js requires a page.tsx entry point, the wrapper is justified but should at minimum not declare 'use client' itself — the directive is redundant.


<a id="fe-command-palette"></a>
## Command palette (FE)  · `fe-command-palette`
*7 issues (1 High)*  

> **Verdict.** CommandPalette.tsx is a moderate god file — 568 lines mixing five distinct concerns in one component body: open/close lifecycle and URL-param parsing, two independent data-fetch pipelines (palette history with debounce, oracle readings with TTL cache), command assembly from six sources, action execution dispatch, and global keybinding interception. The shell components and pure logic helpers are clean. The worst rot is in CommandPalette.tsx itself, with secondary issues around a legacy dual-format oracle response type and duplicated view-flattening logic.


#### 🔴 1. CommandPalette.tsx mixes five unrelated concerns in one component body
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/components/CommandPalette.tsx:79-568`  

**Problem.** The single 568-line component owns: (1) open/close state and URL-param boot logic (lines 82–192), (2) palette-history fetch pipeline with debounce (lines 105–143), (3) oracle-readings fetch pipeline with TTL and version ref (lines 145–170), (4) command assembly from six sources — workspace panes, history rows, oracle rows, static commands, search results — including per-source Android shell filtering and frecency injection (lines 242–349), and (5) global keybinding interception and action dispatch (lines 508–536). These phases have completely independent lifecycles and dependencies. The component has 9 useEffect calls and 29 total hook usages.

**Fix.** Extract into three focused units: (a) a `useCommandPaletteData` hook (owns history fetch with debounce, oracle fetch with TTL, search fetch with debounce — returns `{ historyRows, frecencyBoosts, oracleRows, searchResults, searchLoading }`); (b) a `useCommandPaletteCommands` hook (owns command assembly from all sources plus Android filtering — accepts the data hook's outputs plus workspace state, returns the final `PaletteView`); (c) keep `CommandPalette` as a thin orchestrator that calls both hooks, manages open/close state + URL params, handles action execution, and renders the correct shell. Action execution can also move to a dedicated `executeCommandAction` pure function.

#### 🟠 2. OracleReadingsResponse union type is a legacy-compat shim for a response format no longer returned
`Medium` · `High-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §9`  
**Where:** `apps/web/src/components/CommandPalette.tsx:67` · `apps/web/src/components/CommandPalette.tsx:75-77`  

**Problem.** The type `OracleReadingsResponse = { data: OracleReadingSummary[] } | OracleReadingSummary[]` (line 67) and its normalizer `oracleReadingsFromResponse` (lines 75-77) exist to handle a bare-array response shape. Every other caller of `/api/oracle/readings` in the codebase (OracleAlephGrid.tsx:23, AtlasPaneBody.tsx:243) types the response as `{ data: OracleSummary[] }` with no fallback for the array form. The API route at `app/api/oracle/readings/route.ts` is a simple proxy and does not produce a bare array. The union type is a legacy compat shim that keeps a dead response format alive.

**Fix.** Remove the `OracleReadingsResponse` union type and `oracleReadingsFromResponse` function. Type the `useApiResource` call as `{ data: OracleReadingSummary[] }` and read `oracleResource.data.data` directly, consistent with all other oracle callers.

#### 🟠 3. flattenView logic duplicated between PaletteBody and PaletteDesktopShell
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/palette/PaletteBody.tsx:22-25` · `apps/web/src/components/palette/PaletteDesktopShell.tsx:42-44`  

**Problem.** `PaletteBody.tsx` defines and uses the private helper `flattenView` (lines 22-25). `PaletteDesktopShell.tsx` contains an identical inline copy (lines 42-44: `view.state === 'resting' ? view.groups.flatMap(...) : view.results`). There is now one implementation of the same derived-state logic in two places.

**Fix.** Move `flattenView` to `apps/web/src/components/palette/types.ts` or export it from `PaletteBody.tsx` (or a new shared `paletteUtils.ts`), then import it in `PaletteDesktopShell.tsx` to eliminate the duplicate.

#### 🟡 4. Section label mapping duplicated across commandRanking.ts and PaletteRow.tsx
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/components/command-palette/commandRanking.ts:3-10` · `apps/web/src/components/palette/PaletteRow.tsx:18-25`  

**Problem.** `RESTING_SECTIONS` in `commandRanking.ts` (lines 3-10) maps section IDs to human labels for group headings. `SECTION_TAGS` in `PaletteRow.tsx` (lines 18-25) maps the same section IDs to the same (or overlapping) human labels for inline row tags. The label for `open-tabs` is `Open tabs` in both; `recent` is `Recent` in both; `navigate` is `Go to` in both; `settings` is `Settings` in both. The section ID namespace is the authoritative source but it is replicated in two places.

**Fix.** Define a single `PALETTE_SECTIONS` map in `types.ts` (or a new `paletteSections.ts`) keyed by section ID with both `label` (group heading) and `tag` (row tag, which may differ). Both `commandRanking.ts` and `PaletteRow.tsx` import from it, eliminating the parallel maps.

#### 🟡 5. canOpenConversation is always true — dead option in getAskAiPinnedCommand
`Low` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/command-palette/commandProviders.ts:7-15` · `apps/web/src/components/CommandPalette.tsx:354`  

**Problem.** The only call site for `getAskAiPinnedCommand` passes `canOpenConversation: true` unconditionally (CommandPalette.tsx:354). The guard `if (!canOpenConversation) return null` (commandProviders.ts:15) is therefore an unreachable branch. The parameter appears speculative — there is no code path that could pass `false` to this function.

**Fix.** Remove the `canOpenConversation` parameter and its guard from `getAskAiPinnedCommand`. Update the call site and the tests that exercise `canOpenConversation: false`. The test at `commandProviders.test.ts:47` testing the false branch becomes a test of a dead state and should also be deleted per cleanliness rule §2/§11.

#### 🟡 6. panes-tabs.md module doc is a stub with no content
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §3`  
**Where:** `docs/modules/panes-tabs.md`  

**Problem.** The module doc assigned to this slice (`docs/modules/panes-tabs.md`) contains only a single blank line. There is no intended design documented. This means there is no authoritative specification to audit against, and no way to detect design drift in the command palette, pane system, or tab management code.

**Fix.** Either write the intended design for the command palette / pane tab system in this file, or delete it if no longer relevant. A stub doc is worse than no doc because it implies documentation exists.

#### 🟡 7. create-library static command points to /libraries navigation href, not a create action
`Low` · `Medium-confidence` · `Naming` · rules: `cleanliness.md §12`, `cleanliness.md §9`  
**Where:** `apps/web/src/components/command-palette/staticCommands.ts:192-201`  

**Problem.** The command `create-library` (id `create-library`, title `New library`) has `target: { kind: 'href', href: '/libraries', externalShell: false }` — it navigates to the libraries list rather than triggering a create action. The `sectionId: 'create'` placement and the `id`/`title` both assert it creates a library, but the action is merely navigation. This is misleading to readers of the code and to users who expect a create affordance.

**Fix.** Either rename the command to `nav-libraries` (with an appropriate title and `sectionId: 'navigate'`) if no create endpoint exists, or wire it to an actual create action (`actionId: 'create-library'`) with a corresponding handler in `executeCommand`. The current state misrepresents behavior.


<a id="fe-browse"></a>
## Browse & add content (FE)  · `fe-browse`
*7 issues (2 High)*  

> **Verdict.** BrowsePaneBody.tsx is a clear god file at 764 lines: it co-locates four distinct async action flows (ensureAndOpenPodcast, followPodcast, addAndOpenResult, loadMore), search-state derivation, and the full inline render of four separate result-type row layouts. The worst rot is the co-mingling of raw API transport logic (direct apiFetch to /api/podcasts/ensure with hand-built JSON bodies) with rendering inside a single component, and a repeated library-picker shape transformation scattered across AddContentTray and BrowsePaneBody. browseState.ts and BrowseTypeFilters.tsx are clean and well-scoped; OpmlImportPanel is a minor layering violation.


#### 🔴 1. Split BrowsePaneBody: extract action flows and result-row renderers
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx:1-764`  

**Problem.** BrowsePaneBody.tsx is 764 lines and mixes four unrelated concerns in one body: (1) search-query/section state management and the polling/loading lifecycle; (2) three async action flows (ensureAndOpenPodcast, followPodcast, addAndOpenResult) each with their own apiFetch calls, busy-key tracking, and section-state patches; (3) a loadMore paginator with its own apiFetch call; and (4) the full inline JSX render of four separate result-type row layouts (documents, videos, podcasts, episodes), each 60-100 lines long. cleanliness §5 requires splitting files that mix routing, transport, business logic, mutation, and rendering.

**Fix.** Decompose into: (a) a custom hook `useBrowseActions` (new file `useBrowseActions.ts`) that owns all four async flows plus their busy-key and section-patch logic, exporting named commands {ensureAndOpenPodcast, followPodcast, addAndOpenResult, loadMore} and error state; (b) four small result-row components `BrowseDocumentRow.tsx`, `BrowseVideoRow.tsx`, `BrowsePodcastRow.tsx`, `BrowseEpisodeRow.tsx`, each accepting its typed result plus action callbacks; (c) BrowsePaneBody itself reduced to a thin layout that wires search-form state, the useApiResource call, the useEffect that drives normalizeSections, and renders the section list via the row components. Public contract for the hook: `useBrowseActions({ sections, setSections, openInNewPane }): { ensureAndOpenPodcast, followPodcast, addAndOpenResult, loadMore, actionError, busyKeys }`.

#### 🔴 2. Move ensureAndOpenPodcast's raw API call into a podcast client module
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx:164-186` · `apps/web/src/app/(authenticated)/podcasts/podcastSubscriptions.ts`  

**Problem.** BrowsePaneBody calls `apiFetch('/api/podcasts/ensure', { method: 'POST', body: JSON.stringify({...}) })` directly at line 164, constructing a raw JSON payload including `toPodcastContributorInputs` serialization. This places HTTP transport logic, payload construction, and contributor serialization inside a render component. The podcast subscription module `podcastSubscriptions.ts` already owns all other podcast-API calls; this is the only podcast mutation that escapes to the consumer. layers.md §BFF: route handlers forward and attach auth; business logic belongs in services; client-side product data calls use `/api/*` routes only through a typed client function, not raw fetch inline.

**Fix.** Add a function `ensurePodcast(input: EnsurePodcastInput): Promise<{ podcast_id: string }>` to `podcastSubscriptions.ts`, where `EnsurePodcastInput` accepts already-typed fields (title, contributors as ContributorCredit[], feed_url, etc.). Move the `toPodcastContributorInputs` serialization and the `apiFetch` call into that function. BrowsePaneBody (or the extracted `useBrowseActions` hook) calls only `ensurePodcast(...)` — no raw fetch, no JSON.stringify, no contributor re-serialization.

#### 🟠 3. Move OpmlImportPanel's raw apiFetch call into a typed podcast client function
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/components/OpmlImportPanel.tsx:47-58`  

**Problem.** OpmlImportPanel calls `apiFetch('/api/podcasts/import/opml', { method: 'POST', body: JSON.stringify({opml, default_library_ids, per_feed_library_ids}) })` directly in the component and owns the `PodcastOpmlImportResult` type inline. A UI panel component is not the right owner of HTTP transport shape or response type. `podcastSubscriptions.ts` owns the podcast capability end-to-end and should own this call.

**Fix.** Add `importOpmlSubscriptions({ opml, defaultLibraryIds }: OpmlImportInput): Promise<PodcastOpmlImportResult>` to `podcastSubscriptions.ts`, with `PodcastOpmlImportResult` defined there. OpmlImportPanel imports and calls that function, keeping zero knowledge of the URL, method, or JSON shape.

#### 🟠 4. Collapsed library picker shape transformation duplicated three times
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx:100-106` · `apps/web/src/components/AddContentTray.tsx:486-490` · `apps/web/src/components/AddContentTray.tsx:593-597`  

**Problem.** The same `libraryPicker.libraries.map(library => ({ id: library.id, name: library.name, color: library.color }))` transformation is written identically in three places: once in BrowsePaneBody (via a `useMemo`) and twice inside AddContentTray's JSX render. This is the same derived-state calculation in multiple owners — cleanliness §4 mandates collapsing repeated derivations to one owner.

**Fix.** Expose a pre-shaped field from `useNonDefaultLibraries` directly, e.g. `pickerItems: LibraryPickerItem[]` (the `{id,name,color}` slice), computed once inside the hook. Consumers destructure `pickerItems` and pass it directly to `LibraryMultiSelectPicker` without any local mapping. Remove the three mapping call sites and the `pickerLibraries` memo in BrowsePaneBody.

#### 🟡 5. emptySections passed as non-lazy initializer to useState
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §1`  
**Where:** `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx:69`  

**Problem.** Line 69 passes the `emptySections` function reference directly as the `useState` initial state: `useState<...>(emptySections)`. React interprets a function as a lazy initializer and will call it — this works correctly in practice — but the intent is ambiguous and inconsistent with the two explicit `emptySections()` calls on lines 128 and 142. A reader cannot tell if it is intentional lazy initialization or a bug where the function object was meant to be the state value.

**Fix.** Make the lazy-initializer pattern explicit: `useState<Record<BrowseSectionType, BrowseSectionData>>(emptySections)` is already correct React idiom, but add a brief inline comment `// lazy initializer` or simply change to `useState(() => emptySections())` to be unambiguous.

#### 🟡 6. BrowseTypeFilters uses O(n²) indexOf uniqueness filter
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §1`  
**Where:** `apps/web/src/app/(authenticated)/browse/BrowseTypeFilters.tsx:24-28`  

**Problem.** When adding a type the onChange handler computes `[...visibleTypes, type].filter((value, index, values) => values.indexOf(value) === index)` — an O(n²) uniqueness pass. The array is at most 4 elements so this is harmless in practice, but the pattern is needlessly indirect when a Set already exists (`selectedTypeSet`) in the same render.

**Fix.** Replace with `onChange(BROWSE_TYPES.filter(t => selectedTypeSet.has(t) || t === type))` which preserves canonical order from BROWSE_TYPES, is O(n), and does not need a post-filter dedup pass.

#### 🟡 7. isProjectGutenbergDocument double-derives source label as a fallback
`Low` · `Medium-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §9`  
**Where:** `apps/web/src/app/(authenticated)/browse/browseState.ts:202-209`  

**Problem.** `isProjectGutenbergDocument` checks `result.source_type === 'project_gutenberg'` first (line 205), then falls back to `getDocumentSourceLabel(result) === 'Project Gutenberg'` (line 208). But `getDocumentSourceLabel` itself returns `'Project Gutenberg'` only when `source_type === 'project_gutenberg'` (line 193) — meaning the second branch is unreachable given the first already covers it. The fallback is dead code.

**Fix.** Simplify `isProjectGutenbergDocument` to `return result.source_type === 'project_gutenberg'` and delete the `getDocumentSourceLabel` fallback call. This eliminates unreachable code and removes the confusing double-derivation.


<a id="fe-oracle"></a>
## Oracle panes (FE)  · `fe-oracle`
*10 issues (2 High)*  

> **Verdict.** OracleReadingPaneBody.tsx (762 lines) and AtlasPaneBody.tsx (622 lines) are both god files: each conflates SSE/canvas transport concerns, a domain state machine or interaction engine, data fetching, and JSX rendering in a single component. The worst rot is OracleReadingPaneBody, which additionally embeds inline SSE payload parsing, a colophon date formatter, and duplicated oracle-creation mutation logic that already lives in OracleLandingPaneBody. Shared types (ConcordanceEntry, OracleSummary) and UI primitives (FleuronBreak) are independently copy-pasted instead of having a single owner, and two incompatible deterministic hash algorithms exist for the same purpose.


#### 🔴 1. Split OracleReadingPaneBody: separate state machine + SSE transport from rendering
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx:1-762`  

**Problem.** The 762-line file mixes at least five unrelated concerns in one component: (1) SSE transport parsing — stringPayloadValue, nullableStringPayloadValue, parseImagePayload, parsePassagePayload, decodeOracleStreamEvent (lines 118–314); (2) a streaming orchestrator with reconnect logic — streamEventsWithReconnect (lines 316–373); (3) the reading state machine — ReadingState, initialState, applyEvent, stateFromDetail (lines 73–226); (4) a colophon date formatter — MONTHS, ORDINAL_ONES, ORDINAL_TEENS, ordinalEnglish (lines 386–408); and (5) full JSX rendering (lines 591–762). The component also owns its own data fetch (loadReadingDetail), retry mutation, and error feedback derivation. None of these phases are isolated; a change to the SSE wire format, the retry flow, or the colophon layout requires reading and touching the same file.

**Fix.** Extract three modules: (a) `useOracleReading(readingId, initialDetail)` — a custom hook that owns ReadingState, the state machine (applyEvent, stateFromDetail, initialState), the detail fetch, and the SSE subscription; its public surface is `{ state, loadError, retryLoad, retryFailedReading, retrying }`. (b) `oracleStreamDecode.ts` — pure functions for SSE decode: stringPayloadValue, nullableStringPayloadValue, parseImagePayload, parsePassagePayload, decodeOracleStreamEvent, OracleStreamParseError. (c) `colophonDate.ts` — pure function `formatColophonDate(isoString): string`. OracleReadingPaneBody becomes a thin renderer that calls useOracleReading and maps its output to JSX, under ~200 lines.

#### 🔴 2. Split AtlasPaneBody: extract canvas engine and interaction state into a dedicated hook
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx:237-598`  

**Problem.** AtlasPaneBody's main component function owns: 11 useRef instances for canvas/drag/selection state (lines 255–274), a canvas geometry resolver (lines 291–311), a ResizeObserver binding, a prefers-reduced-motion listener, a continuous requestAnimationFrame render loop (lines 338–383), a pointer hit-test (lines 386–411), pointer event handlers for drag-rotate and tap-to-select (lines 451–509), focused-star derivation, and JSX layout — all in one function body. Canvas drawing primitives (drawDome, drawCardinal, drawStars, drawConstellation) are file-local functions but embedded in the same 622-line file. The AtlasConcordancePeerLoader render-null helper is also defined in this file (lines 600–623).

**Fix.** Extract `useCelestialCanvas({ stars, onSelectStar })` — a hook owning all refs, the RAF loop, ResizeObserver, pointer handlers, hover/selection state, and geometry; its public surface is `{ canvasRef, containerRef, hoveredId, selectedId, focused, onPointerDown, onPointerMove, onPointerUp, onPointerLeave }`. Move drawDome/drawCardinal/drawStars/drawConstellation to a co-located `atlasRenderer.ts` (pure canvas functions, no React). Move `AtlasConcordancePeerLoader` to its own file. AtlasPaneBody then becomes a thin JSX shell that calls useApiResource, the extracted hook, and renders the canvas/label/legend.

#### 🟠 3. Duplicate ConcordanceEntry type — two independent interface definitions for the same API shape
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/app/(oracle)/oracle/OracleConcordance.tsx:16-24` · `apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx:29-37`  

**Problem.** ConcordanceEntry is declared twice with the same seven fields and identical types. Both interfaces describe the `/api/oracle/readings/{id}/concordance` response shape. OracleConcordance uses it for reading-page concordance rendering; AtlasPaneBody uses it in AtlasConcordancePeerLoader for constellation peer resolution. Two owners for the same API contract means a wire-format change requires two independent edits.

**Fix.** Define ConcordanceEntry once in `apps/web/src/app/(oracle)/oracle/types.ts` (which already holds OracleCreateResponse) and import it in both consumers. This is the natural shared-types boundary for the oracle module.

#### 🟠 4. Duplicate OracleSummary type — two incompatible declarations for the readings list shape
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `apps/web/src/app/(oracle)/oracle/OracleAlephGrid.tsx:10-19` · `apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx:23-27`  

**Problem.** OracleSummary is declared independently in OracleAlephGrid (standalone interface, 8 fields) and in AtlasPaneBody (extends FolioStarInput, adds plate_thumbnail_url/plate_alt_text/question_text). Both describe the same `/api/oracle/readings` list item from the same backend endpoint. They diverge in their base: the Atlas version inherits FolioStarInput fields; the Aleph version re-declares them. A field addition to the API shape requires two edits; the extension vs. standalone split creates silent inconsistency.

**Fix.** Consolidate into one exported OracleSummary in `oracle/types.ts` that includes all fields (id, folio_number, folio_motto, folio_theme, status, plate_thumbnail_url, plate_alt_text, question_text). Have FolioStarInput in projection.ts remain the pure math input type; OracleSummary satisfies it structurally without needing inheritance.

#### 🟠 5. Two incompatible deterministic hash functions for the same purpose
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(oracle)/oracle/IlluminatedCapital.tsx:52-59` · `apps/web/src/app/(oracle)/oracle/atlas/projection.ts:61-71`  

**Problem.** IlluminatedCapital defines an unnamed djb2-variant hash (`h = ((h << 5) - h + charCodeAt) | 0`) to pick a decorative motif deterministically from a seed string. projection.ts defines and exports FNV-1a (`fnv1a`) for the same purpose: stable, deterministic, collision-tolerant string-to-integer mapping for visual placement. Two hash algorithms exist for identical requirements; IlluminatedCapital's version is private and undocumented.

**Fix.** Export fnv1a from projection.ts (it is already exported) and use it in IlluminatedCapital's pickMotif, replacing the inline djb2 implementation. If fnv1a lives in the atlas-private projection module is a concern, move it to a shared `lib/fnv1a.ts` that both can import.

#### 🟠 6. Oracle reading creation duplicated across OracleLandingPaneBody and OracleReadingPaneBody
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `apps/web/src/app/(oracle)/oracle/OracleLandingPaneBody.tsx:41-46` · `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx:484-491`  

**Problem.** Both OracleLandingPaneBody (new question submission) and OracleReadingPaneBody (retry of failed reading) contain inline POST to `/api/oracle/readings` with `apiFetch`, JSON.stringify body, and router.push to the new reading. This is the same mutation flow in two places. If the API path, request shape, or redirect behaviour changes, both must be updated. The retry path in OracleReadingPaneBody also manages its own loading/error state (retryingReading, retryError) that mirrors what the landing form already does.

**Fix.** Extract `createOracleReading(question: string): Promise<string>` (returns reading_id) to a shared helper in `oracle/oracleApi.ts`. Both components call this one function; each manages its own local submitting/error state around it. This collapses the mutation to a single owner.

#### 🟠 7. ReadingDetail exported from a UI component file to satisfy server-layer consumption
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx:56-71` · `apps/web/src/app/(oracle)/oracle/[readingId]/page.tsx:2`  

**Problem.** ReadingDetail is defined inside OracleReadingPaneBody.tsx (a client component) and exported so that page.tsx (a server component / RSC) can use it as the return type of fetchInitialReading. This inverts the dependency: the server layer imports a type from a client UI file. The type also crosses the client/server boundary in the component prop. The cleanliness rule requires that transport shapes parsed at the boundary live in boundary or shared modules, not inside UI components.

**Fix.** Move ReadingDetail (and ImagePayload, PassagePayload if they are boundary shapes) to `oracle/types.ts`. page.tsx and OracleReadingPaneBody both import from types.ts. OracleReadingPaneBody's internal ReadingState remains private.

#### 🟡 8. Duplicate FleuronBreak component — defined independently in two files
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx:411-417` · `apps/web/src/app/(oracle)/oracle/OracleConcordance.tsx:8-14`  

**Problem.** The FleuronBreak component (a decorative ❦ glyph divider) is defined identically in both OracleReadingPaneBody and OracleConcordance. It is used four times in OracleReadingPaneBody and once in OracleConcordance. Any visual change (glyph, class name) needs two edits.

**Fix.** Extract FleuronBreak to `apps/web/src/app/(oracle)/oracle/FleuronBreak.tsx` and import it in both consumers.

#### 🟡 9. AtlasConcordancePeerLoader embedded in AtlasPaneBody rather than its own file
`Low` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx:600-623`  

**Problem.** AtlasConcordancePeerLoader is a render-null data-loader component defined at the bottom of AtlasPaneBody.tsx. It fetches the concordance for the selected star and lifts peer IDs up via a callback. It is a distinct concern from the canvas rendering; burying it at the bottom of a 622-line file hides its existence and makes it untestable independently.

**Fix.** Move AtlasConcordancePeerLoader to its own file `AtlasConcordancePeerLoader.tsx`. This also makes the ConcordanceEntry type (which it uses) migrate naturally to oracle/types.ts as noted in the duplication finding.

#### 🟡 10. useStickyHeadline exported from a Shell layout component instead of a hooks module
`Low` · `Medium-confidence` · `PublicSurface` · rules: `cleanliness.md §6`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(oracle)/OracleShell.tsx:21-40` · `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx:19` · `apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx:10`  

**Problem.** useStickyHeadline is a hook exported from OracleShell.tsx, a layout/shell component file. Two deep sub-tree components (OracleReadingPaneBody, AtlasPaneBody) import the hook from the parent layout file. This makes OracleShell carry two concerns: shell layout rendering and hook export. It also creates a coupling where child components must import from the layout level, revealing internals of the context.

**Fix.** Extract HeadlineContext and useStickyHeadline to a co-located `OracleShellContext.ts` (or `useStickyHeadline.ts`). OracleShell imports and provides it; children import from the context/hook file. This shrinks OracleShell to a pure renderer and makes the public surface of the context explicit.


<a id="fe-settings"></a>
## Settings panes & local vault (FE)  · `fe-settings`
*10 issues (2 High)*  

> **Verdict.** The settings panes are individually thin and focused — they are not god files. The real rot sits in two places: (1) the vault sync logic is duplicated across SettingsLocalVaultPaneBody and LocalVaultAutoSync with no shared hook owning the core operation, and (2) several private helper functions (statusLabel, statusVariant, formatDate/formatDateRange) are re-declared independently in three separate pane files. Additionally, setPasswordAction and changePasswordAction in password-actions.ts are byte-for-byte identical server functions, and resolveServerActionOrigin in the account actions file re-implements origin resolution that already exists in lib/auth/callback-origin.ts. The module docs for byok.md and billing-plans.md are empty, so no design drift to report — but this is itself a gap.


#### 🔴 1. Vault sync logic duplicated between SettingsLocalVaultPaneBody and LocalVaultAutoSync — extract a useLocalVaultSync hook
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §5`, `cleanliness.md §8`  
**Where:** `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx:181-211 (syncVault callback)` · `apps/web/src/app/(authenticated)/LocalVaultAutoSync.tsx:25-59 (runLocalVaultSync function)`  

**Problem.** Both files independently implement the same vault sync pipeline: check directoryHandle, call hasVaultPermission, call readEditableVaultFiles, POST to /api/vault, call writeVaultPayload, and handle conflicts. SettingsLocalVaultPaneBody also has an exportVault callback (lines 152-179) that duplicates the permission check + GET /api/vault + writeVaultPayload sequence a third time. The permission-check guard (hasVaultPermission → setStatus("needsPermission")) is copy-pasted verbatim at lines 161-164 and 190-193 within the same file. Callers reach directly into localVault.ts primitives rather than through a single owned operation.

**Fix.** Create lib/vault/useLocalVaultSync.ts exporting a single hook: useLocalVaultSync({ directoryHandle, onStatus, onConflicts }). The hook owns the permission check, the readEditableVaultFiles call, the /api/vault fetch (both GET export and POST sync), and writeVaultPayload. It exposes two named commands — sync() and exportOnly() — plus a status field. Both SettingsLocalVaultPaneBody and LocalVaultAutoSync call only these commands; they own no pipeline steps themselves. The module-level cancellation flag and inflight deduplication in LocalVaultAutoSync should move into the hook as internal state.

#### 🔴 2. setPasswordAction and changePasswordAction are byte-for-byte identical server actions
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `apps/web/src/lib/auth/password-actions.ts:55-71 (setPasswordAction)` · `apps/web/src/lib/auth/password-actions.ts:74-91 (changePasswordAction)`  

**Problem.** setPasswordAction and changePasswordAction have identical bodies: they both validate length >= 12, call supabase.auth.updateUser({ password }), and return the same error/success shapes. The Supabase API makes no distinction between "set" and "change" — both go through updateUser. The caller in PasswordRow.tsx (line 47) selects between them only by the UI mode label, not any behavioral difference.

**Fix.** Delete changePasswordAction. Rename setPasswordAction to updatePasswordAction (or keep as setPasswordAction). PasswordRow.tsx calls the single action regardless of mode; the distinction between 'Set password' and 'Change password' is purely a UI label concern, not a server concern.

#### 🟠 3. statusLabel and statusVariant helpers re-declared in three unrelated pane files
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx:59-64 (statusVariant), 93-95 (statusLabel)` · `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx:34-57 (statusLabel, statusVariant)` · `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx:37-51 (statusLabel, statusVariant)`  

**Problem.** All three files independently declare private functions named statusLabel and statusVariant that map a domain enum to a display string and a Pill tone. The billing and vault variants are different domains so they are not direct duplicates of each other, but the API keys pane formatDate (line 66-77) is also a plain date formatter that appears in a different form in the billing pane's formatDateRange (line 59-73). The names collide across files, making the codebase harder to navigate and creating a maintenance surface where a future change to the Pill tone system requires updates in all three places.

**Fix.** For the billing pane: move statusLabel and statusVariant (and planDescription, statusSummary, sourceLabel) into a dedicated lib/billing/display.ts that co-locates with useBillingAccount and planLabel — they are all billing display logic with no rendering dependency. For the keys pane: move statusLabel, statusVariant, formatDate, providerSortRank, providerLabel, providerPlaceholder into lib/byok/display.ts or co-locate them with a useBYOKKeys hook. The vault status helpers are small enough to stay local since the VaultStatus type is pane-private.

#### 🟠 4. PROVIDER_ORDER constant duplicated between SettingsKeysPaneBody and useChatModels
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx:45` · `apps/web/src/components/chat/useChatModels.ts:20`  

**Problem.** Both files declare `const PROVIDER_ORDER = ["openai", "anthropic", "gemini", "deepseek"] as const` independently. This is the canonical provider ordering for the product; it has two owners.

**Fix.** Declare PROVIDER_ORDER once in a shared location, either lib/providers/order.ts or alongside the BYOK key types. Both the keys settings pane and useChatModels import it from there. This is the single source of truth for which providers exist and their display order.

#### 🟠 5. resolveServerActionOrigin in account/actions.ts re-implements origin resolution already owned by lib/auth/callback-origin.ts
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `layers.md`  
**Where:** `apps/web/src/app/(authenticated)/settings/account/actions.ts:12-25 (resolveServerActionOrigin)` · `apps/web/src/lib/auth/callback-origin.ts:54-63 (getForwardedOrigin, normalizeOrigin)`  

**Problem.** resolveServerActionOrigin in the account server action manually reads x-forwarded-host, falls back to host, reads x-forwarded-proto, and assembles an origin with a localhost special-case. lib/auth/callback-origin.ts already owns this logic in getForwardedOrigin and normalizeOrigin, with security-conscious parsing (first value from comma-separated list, URL normalization, rejection of non-http(s) schemes). The account action's version lacks these guards and adds a new localhost fallback path that diverges from the allowlist-based approach in callback-origin.ts.

**Fix.** Expose a server-safe helper from lib/auth/callback-origin.ts (e.g., resolveServerActionOrigin(headers: Headers): string) that wraps the existing logic and is usable from Next.js server actions without requiring a full Request object. Delete the local function in account/actions.ts and call the library helper instead.

#### 🟠 6. SettingsAccountPaneBody uses raw apiFetch inline for display name update but a server action for email update — inconsistent ownership
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx:111-140 (handleDisplayNameSubmit with inline apiFetch PATCH /api/me)` · `apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx:88-109 (handleEmailSubmit delegating to changeEmailAction server action)`  

**Problem.** Email update is correctly delegated to a server action (changeEmailAction in actions.ts) that validates and uses Supabase securely. Display name update calls apiFetch('/api/me', { method: 'PATCH' }) directly from client-side component code, bypassing the server action pattern. This splits the account mutation boundary: some account mutations are gated through server actions, others are direct BFF calls. There is no updateDisplayNameAction co-located with changeEmailAction, which means the component owns the mutation logic inline.

**Fix.** Extract updateDisplayNameAction into the account/actions.ts server action file. It should validate the display name (non-empty, within 80 chars) and call apiFetch server-side (or forward to the FastAPI BFF). The component's handleDisplayNameSubmit becomes a thin startTransition wrapper, consistent with handleEmailSubmit.

#### 🟡 7. PasswordRow renders two structurally identical dialogs for 'Set password' and 'Change password'
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/(authenticated)/settings/identities/PasswordRow.tsx:141-182 (mode === 'set' dialog)` · `apps/web/src/app/(authenticated)/settings/identities/PasswordRow.tsx:184-225 (mode === 'change' dialog)`  

**Problem.** The two Dialog branches for mode === 'set' and mode === 'change' are copy-pasted: same Input props, same error display, same button layout. The only differences are the dialog title string and the button label/pending text ("Setting..." vs "Changing..."). Since the underlying server actions are also identical (see separate finding), this duplication is structural and produces dead branching.

**Fix.** After collapsing setPasswordAction and changePasswordAction into one action, render a single Dialog branch when mode is non-null. Derive the title and button label from mode ("Set password" vs "Change password") using a simple lookup. This reduces the component by ~40 lines.

#### 🟡 8. Module docs for byok.md and billing-plans.md are empty — no design contract to enforce
`Low` · `High-confidence` · `DocDrift` · rules: `cleanliness.md §13`  
**Where:** `docs/modules/byok.md (1 line, empty)` · `docs/modules/billing-plans.md (1 line, empty)`  

**Problem.** Both module docs referenced in the audit spec exist as files but contain no content. They provide no design contract for the BYOK key management capability or the billing plan tier capability. Without them, there is no authoritative definition of what the module owns, what its public contract is, or what the API keys lifecycle looks like — making it impossible to flag code that drifts from the intended design.

**Fix.** Document the intended design for each capability: for byok.md, describe the provider list, key lifecycle states (missing, untested, valid, invalid, revoked), the boundary (frontend reads /api/keys, submits via POST/DELETE/test), and security constraints (no localStorage, clear on submit). For billing-plans.md, describe the plan tier enum, entitlement vs billing plan distinction, the Stripe portal flow, and the upgrade path. This establishes a contract that future audits can enforce.

#### 🟡 9. SettingsKeysPaneBody holds three parallel feedback states (error, formError, formSuccess) with unclear ownership semantics
`Low` · `Medium-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §9`  
**Where:** `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx:99-105 (three useState calls for error, formError, formSuccess)` · `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx:232-236 (three conditional notice renders)`  

**Problem.** The component maintains three separate FeedbackContent | null states: error (list-load failure), formError (action failure from submit/revoke/test), and formSuccess (action success). The distinction between formError and error is subtle — both are shown in the same message area. All three mutation handlers (handleSubmit, handleRevoke, handleTest) clear both formError and formSuccess before operating, then set one of them, meaning they share a single feedback slot but use two state variables. A single structured feedback state would be cleaner and make illegal states (both formError and formSuccess set) unrepresentable.

**Fix.** Replace formError and formSuccess with a single actionFeedback: FeedbackContent | null. Since success and error are mutually exclusive per operation, there is no value in two variables. Alternatively, if a dedicated hook is created for BYOK mutations, it can own this state and expose { feedback, busy, submit, revoke, test } as a typed interface.

#### 🟡 10. ApiKey interface carries both `fingerprint` and `key_fingerprint` — legacy dual-field compat shim in type definition
`Low` · `Medium-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §9`  
**Where:** `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx:33-34 (both fingerprint and key_fingerprint in ApiKey interface)` · `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx:250 (key_fingerprint ?? fingerprint fallback)`  

**Problem.** The ApiKey interface declares two fields for the same concept: fingerprint: string | null and key_fingerprint: string | null. The render code uses key_fingerprint ?? fingerprint, indicating key_fingerprint is the newer field and fingerprint is retained for backward compatibility with an older API response shape. This is a legacy compat shim embedded in the type definition.

**Fix.** If the FastAPI backend has been updated to always return key_fingerprint, remove fingerprint from the interface and the fallback expression. If both fields can still appear (depending on backend version), document which is canonical and consider normalizing at the boundary (parse and pick one field) rather than spreading the fallback through render code.


<a id="fe-auth"></a>
## Auth (FE) + middleware  · `fe-auth`
*9 issues (2 High)*  

> **Verdict.** The auth slice is broadly well-structured: the DAL, session-cookie parser, refresh module, and middleware each own one narrow concern, and the BFF routes are thin. The worst rot clusters in two areas: (1) dead exports in password-actions.ts — signInWithPasswordAction and signUpWithPasswordAction have no production callers, only test references — and (2) pervasive small duplications that together signal ownership gaps: TEMPORARY_REDIRECT and noStore() are re-invented in at least five files, the handoff-code minting HTTP call is duplicated verbatim across two routes, the AUTH_ENDED_FEEDBACK_COOKIE set operation is duplicated across middleware and refresh/route.ts, and the private isRecord guard in identities.ts ignores the shared one in lib/validation.ts. None of these rises to a god-file split, but taken together they indicate the BFF auth surface lacks a thin shared HTTP-utility layer and that password-actions.ts exports an unused parallel API path that should be deleted.


#### 🔴 1. Delete dead signInWithPasswordAction and signUpWithPasswordAction exports
`High` · `High-confidence` · `DeadCode` · rules: `cleanliness.md §2`, `cleanliness.md §13`, `module-apis.md`  
**Where:** `apps/web/src/lib/auth/password-actions.ts:24-40` · `apps/web/src/lib/auth/password-actions.ts:42-53`  

**Problem.** signInWithPasswordAction and signUpWithPasswordAction are exported from password-actions.ts but have zero production callers. The only references are in password-actions.test.ts and two UI test mocks (SettingsAccountPaneBody.test.tsx, PasswordRow.test.tsx). Production password auth goes exclusively through POST /auth/password (password/route.ts). These actions constitute a second, unreachable API for the same capability — a duplicate API violating module-apis.md — and are dead code per cleanliness §2 (reachable only from tests).

**Fix.** Delete signInWithPasswordAction and signUpWithPasswordAction from password-actions.ts. Remove all references to them in password-actions.test.ts and the two UI test mocks. The single live API for password auth is the POST /auth/password BFF route backed by password-flow.ts.

#### 🔴 2. Deduplicate handoff-code minting HTTP call between callback/route.ts and native/google/route.ts
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §8`, `layers.md`  
**Where:** `apps/web/src/app/auth/callback/route.ts:37-86` · `apps/web/src/app/auth/native/google/route.ts:51-101`  

**Problem.** Both callback/route.ts and native/google/route.ts make an identical POST to /auth/handoff-codes with the same headers (Authorization: Bearer, X-Request-ID, conditional X-Nexus-Internal), the same body shape (access_token, refresh_token, challenge), and the same error-collapse logic (timeout/non-2xx both map to the same error string). The logic is duplicated verbatim across 50 lines in two files, including the conditional internalSecret header construction pattern. A drift between the two copies is dangerous because a change to the minting contract (e.g., adding a required header) must be applied in two places.

**Fix.** Extract a mintHandoffCode(args: { accessToken: string; refreshToken: string; challenge: string }) function into lib/auth/internal-fetch.ts or a new lib/auth/handoff.ts. The function should own: building the request headers (including the conditional X-Nexus-Internal), calling boundedAuthFetch, and returning a typed result ({ code: string } | { error: string }). Both routes call this function and map the typed result to their own response shapes.

#### 🟠 3. Duplicate AUTH_ENDED_FEEDBACK_COOKIE cookie-set operation across middleware and refresh route
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/supabase/middleware.ts:61-66` · `apps/web/src/app/auth/refresh/route.ts:42-49`  

**Problem.** The AUTH_ENDED_FEEDBACK_COOKIE is written with identical options (httpOnly: true, maxAge: 60, path: '/', sameSite: 'lax') in two separate places: the middleware's clearAndRedirectToLogin helper and the refresh route's markSessionEnded function. Two owners setting the same cookie with the same options means any change (e.g., adding Secure: true or adjusting maxAge) must be applied in both places. The cookie spec (name, options) has two owners.

**Fix.** Move the cookie-options object to a named constant exported from lib/auth/messages.ts (where the cookie name already lives) or from a new lib/auth/session-ended-feedback.ts. Both the middleware and the refresh route import and use that single constant. Alternatively, export a setSessionEndedFeedbackCookie(response: NextResponse) helper from the messages/session module and call it in both places.

#### 🟡 4. TEMPORARY_REDIRECT constant re-declared in five files
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/auth/refresh/route.ts:17` · `apps/web/src/lib/supabase/middleware.ts:20` · `apps/web/src/app/auth/oauth/route.ts:14` · `apps/web/src/app/auth/handoff/route.ts:21` · `apps/web/src/lib/auth/callback.ts:27`  

**Problem.** The numeric literal 307 is wrapped in a locally-scoped TEMPORARY_REDIRECT constant in every file that issues a redirect. Five independent declarations of the same constant. cleanliness §4 says constants should have one owner; §7 says do not add hollow generic helpers, but a shared HTTP status module is not hollow — it prevents drift between files if a redirect semantic ever needs to change.

**Fix.** Export TEMPORARY_REDIRECT = 307 (and SEE_OTHER = 303, which is also locally duplicated in password/route.ts) from a shared lib/http-status.ts or lib/auth/http.ts. All five files import from that single location. The noStore() helper (independently defined in refresh/route.ts, handoff/route.ts, and password/route.ts) can be co-located there as well to complete the cleanup.

#### 🟡 5. noStore helper independently redefined in three BFF route files
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/app/auth/refresh/route.ts:37-40` · `apps/web/src/app/auth/handoff/route.ts:26-29` · `apps/web/src/app/auth/password/route.ts:20-23`  

**Problem.** Three auth BFF route files each define their own noStore(response) function with an identical body: response.headers.set('Cache-Control', 'no-store'). The handoff variant uses a generic type parameter <T extends Response> while the others accept NextResponse specifically, creating a minor type inconsistency between three copies of the same behavior.

**Fix.** Export a single noStore helper from a shared utility (e.g., lib/auth/http.ts or lib/http.ts) and have all three routes import it. See also the TEMPORARY_REDIRECT deduplication recommendation above — the two fixes are naturally addressed together.

#### 🟡 6. Private isRecord guard in identities.ts duplicates the exported one in lib/validation.ts
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/auth/identities.ts:12-14` · `apps/web/src/lib/validation.ts:5-7`  

**Problem.** identities.ts declares a private function isRecord with a body identical to the exported isRecord in lib/validation.ts. session-cookie.ts correctly imports isRecord from lib/validation.ts, but identities.ts does not. Two identical implementations of the same type guard exist in the same repo, in the same lib/auth/ neighbourhood.

**Fix.** Delete the private isRecord declaration in identities.ts (line 12-14) and add import { isRecord } from '@/lib/validation' at the top, mirroring the pattern already used in session-cookie.ts.

#### 🟡 7. REQUEST_PATH_HEADER string constant defined independently in two modules
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/lib/supabase/middleware.ts:17` · `apps/web/src/lib/auth/dal.ts:13`  

**Problem.** The header name 'x-nexus-request-path' is independently declared as REQUEST_PATH_HEADER in both middleware.ts (which sets it) and dal.ts (which reads it). These two declarations must stay in sync; a rename in one breaks the contract silently.

**Fix.** Export REQUEST_PATH_HEADER from one authoritative location — the most natural owner is lib/auth/dal.ts since dal.ts is the consumer that validates the header contract, or a thin lib/auth/headers.ts shared by both. The middleware imports and sets it from the same source.

#### 🟡 8. signInWithPasswordAction uses bespoke path validation instead of normalizeAuthRedirect
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/auth/password-actions.ts:35-38`  

**Problem.** signInWithPasswordAction validates the nextPath parameter with an ad-hoc check (startsWith('/') && !startsWith('//')). This is a weaker, incomplete subset of normalizeAuthRedirect, which already exists in lib/auth/redirects.ts and is used consistently everywhere else in the auth slice. The bespoke check does not guard against paths that start with /auth/ (which normalizeAuthRedirect rejects) and does not strip query-string injection. Note: this finding is lower priority if signInWithPasswordAction is deleted per the dead-code finding above.

**Fix.** Replace the manual check with normalizeAuthRedirect(nextPath, '/libraries') from lib/auth/redirects.ts, matching every other call site. This is a pure cleanup if the function survives; it becomes moot if the dead-code finding is acted on first.

#### 🟡 9. toPublicAuthErrorMessage contains 19 identity-passthrough branches that add no filtering value
`Low` · `Medium-confidence` · `Indirection` · rules: `cleanliness.md §7`, `cleanliness.md §1`  
**Where:** `apps/web/src/lib/auth/messages.ts:55-129`  

**Problem.** toPublicAuthErrorMessage's primary job is to (a) map known Supabase vendor error strings to safe UI messages, and (b) allowlist already-safe messages so they pass through. Points (b) is implemented as 19 sequential if (trimmed === <knownConstant>) return <knownConstant> branches. Each branch does nothing except return the same value that entered — the only effect is proving the string is in the allowlist. This is a large, fragile, manually-maintained allowlist that must be updated every time a new constant is added. The same semantic can be expressed as a single Set lookup.

**Fix.** Replace the 19 identity-passthrough branches with a pre-built Set<string> containing all known-safe message strings (populated from the exports of messages.ts itself). The check becomes: if (SAFE_AUTH_MESSAGES.has(trimmed)) return trimmed. This removes ~50 lines and makes the contract explicit: everything not in the set (and not matched by the vendor-string patterns below) returns null.


<a id="fe-resource-actions"></a>
## Resource actions, media hooks, UI primitives  · `fe-resource-actions`
*8 issues (1 High)*  

> **Verdict.** The library-membership layer is the worst rot in this slice: three separate modules (useLibraryMembership, PodcastDetailPaneBody, LibraryPaneBody) each re-implement the same fetch-add-remove-patchOptimistic loop against the same four functions from mediaLibraries.ts, with no shared hook to own that interaction. Feedback.tsx is a moderate mixed-concern file — it co-locates the toast-display service, the in-page notice component, the field-level error component, a domain-error-code mapper, and one domain constant that does not belong there. The rest of the slice is generally clean: ui/ primitives are well-scoped single-responsibility components, resourceActions.ts is a cohesive option-builder module, useMediaProcessingStatus.ts owns SSE parsing end-to-end, and ingestionClient.ts has a clean boundary. The capabilities normalizer in resourceActions.ts is private and does not duplicate the SSE-specific parser in useMediaProcessingStatus.ts — they are parallel, not the same concern.


#### 🔴 1. Three-site duplication of library membership fetch/add/remove/patch loop
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`, `module-apis.md`  
**Where:** `apps/web/src/lib/media/useLibraryMembership.ts:46-128` · `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:269-533` · `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:325-439`  

**Problem.** The pattern of (1) calling fetchMediaLibraryMemberships, (2) calling addMediaToLibrary / removeMediaFromLibrary, and (3) calling patchLibraryMembership for optimistic update is implemented three independent times. PodcastDetailPaneBody and LibraryPaneBody import the four raw functions from mediaLibraries.ts directly and repeat the entire loading/busy/optimistic-patch state machine in their own local state, bypassing the useLibraryMembership hook that already owns this behavior. module-apis.md rule: expose each capability in one primary form — there are now two primary forms (the hook and raw direct usage). cleanliness.md §4: collapse repeated mutation flows to one owner.

**Fix.** useLibraryMembership is the canonical owner of the membership CRUD for a single media item. PodcastDetailPaneBody and LibraryPaneBody should call useLibraryMembership (or a minimal variant of it) instead of reaching past it to the raw functions. If PodcastDetailPaneBody needs per-episode membership state keyed by mediaId, extract a usePerItemLibraryMembership(mediaId) variant that wraps the same raw functions with the same state machine, and delete the inlined copies. The public contract of the hook should remain: { libraries, loading, busy, error, loadLibraries, addToLibrary, removeFromLibrary }. mediaLibraries.ts functions remain as the data-layer functions that only the hook calls.

#### 🟠 2. Feedback.tsx mixes toast service, notice component, field component, and domain error mapping
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`  
**Where:** `apps/web/src/components/feedback/Feedback.tsx:1-359`  

**Problem.** One file owns four distinct concerns: (a) the toast-queue service (FeedbackProvider + useFeedback + dismiss/scheduleDismiss logic, lines 130-301), (b) the inline notice component for page-level errors (FeedbackNotice, lines 303-343), (c) the field-level validation error component (FieldFeedback, lines 345-358), and (d) a domain-specific API error-code-to-message mapper (apiErrorTitle, lines 72-110) plus the exported domain constant PDF_PASSWORD_PROTECTED_MESSAGE (line 26). Callers import FeedbackProvider from one place, FeedbackNotice from the same file, FieldFeedback from the same file, toFeedback from the same file, and PDF_PASSWORD_PROTECTED_MESSAGE from the same file — all unrelated callers pulling from one monolithic file.

**Fix.** Split into three files: (1) Feedback.tsx keeps only FeedbackProvider, useFeedback, FeedbackContext, and the internal toast state/timer logic; (2) FeedbackNotice.tsx holds the inline notice and FieldFeedback presentational components; (3) toFeedback.ts (or merge into lib/api/client.ts error types) holds apiErrorTitle and toFeedback, since these are API-layer error mappers not UI components. PDF_PASSWORD_PROTECTED_MESSAGE should move to lib/media/ or be inlined at the two call sites.

#### 🟠 3. MediaActionSubject.capabilities typed as unknown forces redundant runtime normalization
`Medium` · `High-confidence` · `Types` · rules: `cleanliness.md §9`, `cleanliness.md §7`  
**Where:** `apps/web/src/lib/actions/resourceActions.ts:10` · `apps/web/src/lib/actions/resourceActions.ts:20-36`  

**Problem.** MediaActionSubject.capabilities is typed as unknown (line 10), forcing normalizeMediaActionCapabilities to re-validate every field at runtime (lines 20-36). All actual callers (MediaPaneBody:3815, LibraryPaneBody:993, PodcastDetailPaneBody:1597) already hold capabilities as typed booleans from the server response and perform their own capability guards before wiring handlers. The unknown type is an unnecessary escape hatch that forces defensive normalization. The normalized type MediaActionCapabilities uses optional booleans, which is weaker than the already-known boolean values from the server shape.

**Fix.** Replace capabilities?: unknown in MediaActionSubject with the well-known shape: capabilities?: { can_delete?: boolean; can_retry?: boolean; can_refresh_source?: boolean; can_retry_metadata?: boolean }. Delete normalizeMediaActionCapabilities and replace its call site with direct property reads with nullish coalescing to false. This aligns with MediaProcessingSnapshot.capabilities in useMediaProcessingStatus.ts which already carries the same shape typed correctly.

#### 🟠 4. Duplicate capability guard: checked in MediaPaneBody before passing handler and again inside useDocumentActions
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §6`  
**Where:** `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:3822-3848` · `apps/web/src/lib/media/useDocumentActions.ts:86-131`  

**Problem.** MediaPaneBody guards each handler before passing it to mediaResourceOptions — e.g. onRetry: media?.capabilities?.can_retry ? () => { void handleRetryProcessing(); } : undefined (lines 3822-3824). useDocumentActions also re-checks the same capability flag at the start of handleRetry (line 86: !media.capabilities?.can_retry returns early). The capability guard exists twice: once as an outer condition that conditionally provides the callback, and once inside the callback as a defensive early-return. One site redundantly re-checks what the other already enforced.

**Fix.** Remove the per-capability early-return guards inside useDocumentActions (lines 86, 107, 128), since the caller already controls whether the handler is provided by making it undefined when the capability is absent. Alternatively, invert ownership: have useDocumentActions expose capability-gated handlers that are undefined when the capability is absent, and remove the outer capability checks in MediaPaneBody. Either way, pick one owner of the capability gate — the hook is the better owner because it already holds the media object.

#### 🟡 5. retryClient.ts is a trivial pass-through wrapper with no added value
`Low` · `High-confidence` · `Indirection` · rules: `cleanliness.md §7`  
**Where:** `apps/web/src/lib/media/retryClient.ts:1-15` · `apps/web/src/lib/media/retryClient.test.ts`  

**Problem.** retryClient.ts exports two functions (retryMediaSource, retryMediaMetadata) that each make a single apiFetch call with a JSON body. There is no retry logic, no error handling, no state — just a URL template. Its sole purpose is to name two POST calls. The existing test (retryClient.test.ts) only verifies that the right URL and body are passed, which is a structural test of a trivial wrapper.

**Fix.** Move retryMediaSource and retryMediaMetadata into mediaLibraries.ts (which already owns all other media API calls). Delete retryClient.ts and retryClient.test.ts. Update imports in useDocumentActions, PodcastDetailPaneBody, and LibraryPaneBody to the new location. The structural test can be deleted — the behavior is covered through higher-level tests.

#### 🟡 6. PDF_PASSWORD_PROTECTED_MESSAGE domain constant exported from UI feedback file
`Low` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`  
**Where:** `apps/web/src/components/feedback/Feedback.tsx:26` · `apps/web/src/components/PdfReader.tsx:14` · `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:41`  

**Problem.** PDF_PASSWORD_PROTECTED_MESSAGE is a domain string constant about PDF processing. It lives in Feedback.tsx alongside the toast service, but its content is tied to the E_PDF_PASSWORD_REQUIRED error code from the API, not to how toasts look. Two unrelated media components (PdfReader.tsx, MediaPaneBody.tsx) import it from the feedback module, creating an ownership violation: media-domain code depends on a UI-infrastructure file for a domain constant.

**Fix.** Move PDF_PASSWORD_PROTECTED_MESSAGE to lib/media/ (e.g., a mediaErrors.ts) or inline its string literal at the two call sites. Remove the export from Feedback.tsx.

#### 🟡 7. Navbar inlines 9 per-route active-state booleans as repeated derivation
`Low` · `Medium-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §7`  
**Where:** `apps/web/src/components/Navbar.tsx:56-69`  

**Problem.** Navbar computes nine separate boolean constants (librariesActive, browseActive, podcastsActive, chatsActive, todayActive, notesActive, searchActive, oracleActive, settingsActive) by repeated currentPathname === ... || currentPathname.startsWith(...) calls. This is a repeated derivation pattern that inflates the component body and must be manually extended for each new nav item. The notesActive check also includes /pages/ as an alias, introducing implicit route-alias knowledge inside the nav component.

**Fix.** Replace the 9 booleans with a single isRouteActive(currentPathname: string, href: string): boolean helper applied inline when rendering each link. If the /pages/ alias for /notes is authoritative, encode that mapping in paneRouteRegistry.ts (which already owns route metadata) and derive active state from there.

#### 🟡 8. ContextRow exposes 9 className pass-through slots creating an oversized public surface
`Low` · `Medium-confidence` · `PublicSurface` · rules: `cleanliness.md §8`, `module-apis.md`  
**Where:** `apps/web/src/components/ui/ContextRow.tsx:7-32`  

**Problem.** ContextRow accepts 13 props, of which 9 are separate className pass-throughs for internal sub-slots (mainClassName, leadingClassName, contentClassName, titleClassName, descriptionClassName, metaClassName, trailingClassName, actionsClassName, expandedClassName). This exposes internal DOM structure to all callers and widens the public surface far beyond what a deep module would require. It couples callers to the internal layout, making restructuring expensive.

**Fix.** Audit the three callers to determine which className slots are actually used. Remove unused slot overrides. If all nine are needed, consider whether ContextRow earns its place or whether callers should compose their own layout directly without an intermediary. Any slot unused across all callers should be deleted from the interface.


<a id="fe-misc-panes"></a>
## Misc panes & contributors (FE)  · `fe-misc-panes`
*8 issues (3 High)*  

> **Verdict.** PagePaneBody.tsx (755 lines) is the dominant problem in this slice: it is a god file mixing page-document domain logic (block tree traversal, draft serialisation, conflict resolution, localStorage persistence, rev-tracking), session orchestration, and rendering. The draft-state initialisation logic is duplicated across four call sites in the same file. The other two panes (AuthorPaneBody, ConversationsPaneBody) are smaller but carry their own layering smells: AuthorPaneBody owns a full fetch-and-filter state machine that belongs in a dedicated hook, and ConversationsPaneBody calls apiFetch directly for mutations while relying on a resource hook for the initial load. The contributors component directory is clean and well-tested; the only issue there is a legacy dual-handle field on ContributorSummary.


#### 🔴 1. Split PagePaneBody: extract note draft-state logic into a dedicated hook
`High` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:49-111` · `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:119-359`  

**Problem.** PagePaneBody is 755 lines and conflates three unrelated concerns: (1) domain logic for block-tree state — six mutable refs tracking pageRevision, knownBlockIds, knownBlockParentIds, knownBlockRevisions, knownBlockDrafts, and focusedRootParentBlockId, together with all the functions that derive and mutate them; (2) the edit-session lifecycle (saveDoc, draftMetadata, useNoteEditorSession wiring, conflict/error callbacks); and (3) the React rendering layer (title input, status label, conflict action buttons, ProseMirrorOutlineEditor, NoteBacklinks). Rules §5 and §8 require files that mix unrelated phases to be split; §6 requires real behavior to live in the owning unit.

**Fix.** Extract a `useNotePageDraftState` hook (new file: `apps/web/src/lib/notes/useNotePageDraftState.ts`). This hook owns all six `Ref` trackers, `applyPageLoad`, `applyBlockLoad`, `applyStoredDraft`, `applySaveResult`, and the serialisation helpers (`readDraftBlocksForPersistence`, `deletedRootBlockIdsForPersistence`, `draftBlocksById`, `draftBlockChanged`, `flatBlockIds`, `flatBlockParentIds`, `flatBlockRevisions`, `pageDraftMetadataFromStorage`). It exposes a typed interface: `{ applyLoadedResource, applySaveResult, draftMetadata, saveScope }`. PagePaneBody then holds only the editor lifecycle (useNoteEditorSession + useAsyncResource wiring) and the render tree. The two exported persistence functions move out of the route component into the hook's module so that the test file can import them directly from there.

#### 🔴 2. Collapse duplicated block-state initialisation into one function
`High` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §5`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:243-273 (loadServerDocument — no-focus branch)` · `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:243-273 (loadServerDocument — focus branch)` · `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:282-321 (applyLoadedEditorResource — no-focus branch)` · `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:323-354 (applyLoadedEditorResource — focus branch)`  

**Problem.** The six-ref block-state initialisation pattern (`setPage`, `setTitleDraft`, `pageRevisionRef.current`, `focusedRootParentBlockIdRef.current`, `knownBlockIdsRef.current`, `knownBlockParentIdsRef.current`, `knownBlockRevisionsRef.current`, `knownBlockDraftsRef.current`) is copy-pasted across four code paths — `loadServerDocument` (non-focused branch, lines 245–259), `loadServerDocument` (focused branch, lines 262–272), `applyLoadedEditorResource` (non-focused branch, lines 283–296), and `applyLoadedEditorResource` (focused branch, lines 323–332). The only differences are the source of blocks (`loadedPage.blocks` vs. `[block]`) and whether a stored draft is then applied. This is large, dangerous duplication: a change to the ref layout must be made in four places.

**Fix.** In the proposed `useNotePageDraftState` hook, define two private helpers: `applyPageLoad(loadedPage: NotePage): ProseMirrorNode` and `applyBlockLoad(loadedPage: NotePage, block: NoteBlock): ProseMirrorNode`. Each sets all refs and returns the derived document once. `applyLoadedEditorResource` and `loadServerDocument` call the appropriate helper, then handle stored-draft overlay and `setInitialDoc` at a single call site. The stored-draft overlay path (lines 297–319 and 333–353) also duplicates; collapse it into `applyStoredDraft(saveScope, storedMetadata)` that writes all refs and returns `storedDraft.doc`.

#### 🔴 3. Move persistence logic out of the route component into lib/notes
`High` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:49-64 (PersistedDraftBlock, PageDraftMetadata interfaces)` · `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:576-755 (all module-level pure functions)`  

**Problem.** The types `PersistedDraftBlock` and `PageDraftMetadata`, the serialisation functions `readDraftBlocksForPersistence` and `deletedRootBlockIdsForPersistence`, and all supporting pure helpers (`draftBlocksById`, `draftBlockChanged`, `pageDraftMetadataFromStorage`, `flatBlockIds`, `flatBlockParentIds`, `flatBlockRevisions`, `requiredRevision`, `nodeJsonRecord`, `draftBlockKind`) live inside a route component file. They are exported only because the co-located test file imports them, which is a test-seam kept only for tests in a presentation-layer file. These helpers own note-domain logic that is independent of the React component and must be tested at the domain boundary, not at the route.

**Fix.** Move the interfaces and all pure helpers to `apps/web/src/lib/notes/noteDraftPersistence.ts`. The test file `PagePaneBody.test.tsx` imports from that new module path. Remove the `export` keywords from `readDraftBlocksForPersistence` and `deletedRootBlockIdsForPersistence` in the route file (they are deleted from there entirely). A private `requiredRevision` already exists in `apps/web/src/lib/highlights/api.ts` (line 199) — the two should be collapsed into one shared utility in `lib/notes/noteDraftPersistence.ts` or a shared util module.

#### 🟠 4. requiredRevision duplicated across PagePaneBody and lib/highlights/api
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`  
**Where:** `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:750-755` · `apps/web/src/lib/highlights/api.ts:199-204`  

**Problem.** An identical `requiredRevision` guard function (check `typeof revision !== 'number' || !Number.isFinite(revision)`, throw on failure) exists independently in both files. The error messages differ slightly but the logic and purpose are the same.

**Fix.** Define once in `apps/web/src/lib/notes/noteDraftPersistence.ts` (or a shared `lib/notes/noteRevision.ts`) and import from both call sites.

#### 🟠 5. Extract author-works fetch-and-filter state into a dedicated hook in AuthorPaneBody
`Medium` · `High-confidence` · `GodFile` · rules: `cleanliness.md §5`, `cleanliness.md §6`, `cleanliness.md §8`  
**Where:** `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx:78-190`  

**Problem.** AuthorPaneBody owns two separate `useEffect` loops: one that loads contributor metadata and initial works (lines 91–140), and a second that re-fetches works whenever filter state changes (lines 142–190). Together with six state variables, two request-tracking refs, and four module-level utility functions, the component body is a fetch-and-filter state machine embedded in a render function. This violates §5 (unrelated phases in one body) and §8 (the component is not a service owner — it should call a hook).

**Fix.** Extract `useContributorWorksState(handle: string)` into `apps/web/src/lib/contributors/useContributorWorksState.ts`. The hook owns both effects, all six state variables, the two refs, and returns `{ data, loading, error, roleFilter, kindFilter, queryFilter, setRoleFilter, setKindFilter, setQueryFilter }`. The module-level utilities `normalizeFilterValue`, `uniqueSorted`, `workContentKind`, `formatWorkKind`, and `buildWorkMeta` move to `apps/web/src/lib/contributors/formatting.ts` (which already exists) or a new `worksFormatting.ts`. AuthorPaneBody becomes a thin renderer that calls the hook and maps the returned values to JSX.

#### 🟡 6. AuthorPaneBody formats contributor kind inline instead of using the existing formatter
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx:224` · `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx:44-46 (formatContentKind)` · `apps/web/src/lib/contributors/formatting.ts:51-56 (formatContributorRole)`  

**Problem.** Line 224 formats `data.contributor.kind` with an inline `replace(/_/g, ' ')`. The same underscore-to-space transform is also done by the local `formatContentKind` function (line 44) and is structurally identical to `formatContributorRole` in `lib/contributors/formatting.ts`. There are now at least two owners of the same normalization. The `formatContentKind` helper itself is used only within `AuthorPaneBody`, making it a private inline that duplicates the library function.

**Fix.** Extend `formatContributorRole` in `lib/contributors/formatting.ts` to a general `formatUnderscoreLabel(value: string): string` export, or add a `formatContentKind` export there. Delete the local `formatContentKind` from `AuthorPaneBody` and replace both call sites with the single library export.

#### 🟡 7. ContributorSummary carries a legacy contributor_handle alias field
`Low` · `Medium-confidence` · `LegacyCompat` · rules: `cleanliness.md §3`, `cleanliness.md §9`  
**Where:** `apps/web/src/lib/contributors/types.ts:17-18` · `apps/web/src/components/contributors/ContributorChip.tsx:43-45`  

**Problem.** `ContributorSummary` declares both `handle: string` (the primary, non-optional field) and `contributor_handle?: string` (an optional alias). `ContributorChip` resolves the handle by falling through three alternatives: `credit?.contributor_handle`, `contributor?.contributor_handle`, `contributor?.handle`. The optional `contributor_handle` on `ContributorSummary` looks like a migration-era shim kept to satisfy old response shapes. If it is still required for any live API response, the type should document that; if not, it is dead compat code.

**Fix.** Audit API response shapes to confirm whether any endpoint returns `contributor_handle` on a contributor summary payload. If not, remove `contributor_handle?` from `ContributorSummary` and remove the middle branch in `ContributorChip`'s handle-resolution chain. If it is still live, give the field a discriminant or a doc comment so its continued purpose is explicit.

#### 🟡 8. ConversationsPaneBody calls apiFetch directly for mutation while using a resource hook for reads
`Low` · `Medium-confidence` · `OwnershipLayering` · rules: `cleanliness.md §6`, `cleanliness.md §8`, `module-apis.md`  
**Where:** `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx:51-61 (loadMore)` · `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx:64-74 (handleDelete)`  

**Problem.** The component calls `apiFetch` directly for both pagination (`loadMore`) and deletion (`handleDelete`), while using `useApiResource` for the initial load. This means the component owns both the transport detail (raw fetch, URL construction, `URLSearchParams` usage) and the local state update logic. Per §6 and §8, transport concerns should be behind a domain API; the component should call typed functions.

**Fix.** Add `fetchConversations(cursor?: string): Promise<ConversationsResponse>` and `deleteConversation(id: string): Promise<void>` to `apps/web/src/lib/conversations/` (a new `api.ts` or existing module). The component calls those typed functions instead of constructing URLs and calling `apiFetch` directly. The inline `ConversationsResponse` interface moves to `lib/conversations/types.ts`.


<a id="fe-bff-routes"></a>
## BFF proxy routes  · `fe-bff-routes`
*6 issues (0 High)*  

> **Verdict.** All 125 BFF proxy routes are genuinely thin: every one delegates entirely to either `proxyToFastAPI` or `proxyExtensionToFastAPI` with no branching logic, payload reshaping, or validation of their own. The layer rule is respected. The worst issues are in proxy.ts itself — a latent query-string omission in the extension proxy path, a missing test seam for the extension proxy, and copy-pasted test setup — plus a pervasive inconsistency in Next.js route configuration boilerplate (55 of 125 routes silently omit the `dynamic`/`revalidate` declarations that 70 others carry, making the caching contract unclear).


#### 🟠 1. proxyExtensionToFastAPI drops query strings from the upstream URL
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §6`, `cleanliness.md §4`  
**Where:** `apps/web/src/lib/api/proxy.ts:566` · `apps/web/src/lib/api/proxy.ts:292-294`  

**Problem.** proxyToFastAPIWithDeps extracts the query string from the incoming URL at lines 292-294 (`const requestUrl = new URL(request.url); const queryString = requestUrl.search;`) and appends it to the upstream URL (`${deps.config.fastApiBaseUrl}${path}${queryString}`). proxyExtensionToFastAPI does not — it uses `${fastApiBaseUrl}${path}` at line 566 with no query string at all. The two proxy functions implement the same forwarding contract but diverge on this detail. All current extension routes are POST or DELETE (so query params are unused today), but the omission is a latent defect: any future extension GET route or any POST that legitimately uses query params will silently drop them, and the asymmetry between the two functions is a hidden violation of the 'one owner per concern' rule.

**Fix.** Extract the query-string forwarding logic once: `const queryString = new URL(request.url).search;` and apply it in both functions before building the upstream URL. Add a test in proxy.test.ts asserting that proxyExtensionToFastAPI forwards query strings. This is a one-line addition that closes the behavioral gap and brings the two proxy paths to parity.

#### 🟠 2. proxyExtensionToFastAPI is not dependency-injectable, blocking honest unit tests
`Medium` · `High-confidence` · `OwnershipLayering` · rules: `cleanliness.md §8`, `cleanliness.md §11`  
**Where:** `apps/web/src/lib/api/proxy.ts:489-601` · `apps/web/src/lib/api/proxy.ts:260-487` · `apps/web/src/app/api/media/capture/url/route.test.ts:3`  

**Problem.** proxyToFastAPIWithDeps accepts a deps object (readSession, fetch, generateRequestId, config) allowing tests to inject a mock fetch without touching globals. proxyExtensionToFastAPI hardcodes `globalThis.fetch` at line 566 and calls `getInternalApiConfig()` directly with no injection. Tests must spy on `globalThis.fetch` (capture/url/route.test.ts line 3: `vi.spyOn(globalThis, 'fetch')`) and set env vars — a test-seam that lives in production code is the antipattern cleanliness.md §11 explicitly forbids. There is no proxyExtensionToFastAPIWithDeps counterpart, so the extension proxy is inconsistently designed compared to the main proxy.

**Fix.** Create a `proxyExtensionToFastAPIWithDeps` that mirrors the deps pattern of `proxyToFastAPIWithDeps`: accept `{ fetch, generateRequestId, config }` as a parameter. Make `proxyExtensionToFastAPI` a thin wrapper that calls `getInternalApiConfig()` and passes defaults, exactly like `proxyToFastAPI` does. Move the extension proxy tests to use injected deps instead of globalThis spying. This eliminates the global side-channel seam and makes both proxy variants testable at the same level of control.

#### 🟠 3. Inconsistent Next.js route configuration: 55 of 125 routes silently omit dynamic/revalidate declarations
`Medium` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §1`  
**Where:** `apps/web/src/app/api/media/route.ts:4-5` · `apps/web/src/app/api/libraries/route.ts:1-9` · `apps/web/src/app/api/media/[id]/route.ts:1-10` · `apps/web/next.config.ts:1-66`  

**Problem.** 70 of 125 BFF route files export `export const dynamic = 'force-dynamic'` and `export const revalidate = 0` (always together — confirmed by diff of the two sets). The remaining 55 routes export neither. These are all equivalent proxy routes reading auth cookies on every request; there is no behavioral difference between the two groups that would justify different caching semantics. The spread of declarations adds 140 lines of boilerplate across 70 files that says less than 'this is a live proxy route', creates a false impression that the 55 routes without declarations might be cached, and makes every future route addition a decision point with no authoritative guidance. Additionally, in Next.js 15 with `export const runtime = 'nodejs'` and dynamic I/O (reading request cookies), routes are dynamic by default; the declarations may be vestigial.

**Fix.** Decide once in next.config.ts whether all /api/** routes should be `force-dynamic`. If yes, remove the per-file declarations from all 70 routes and add a route-segment config default in next.config.ts (e.g., `headers` or a global route config that pins api routes to dynamic). If the framework does not support a project-wide default, add a lint rule or code comment in a shared location explaining that all api proxy routes are implicitly dynamic. Either way, eliminate the 140-line duplication across 70 files.

#### 🟡 4. Test setup helper (encodeSessionCookie + sessionCookie) copy-pasted across route test files
`Low` · `High-confidence` · `Duplication` · rules: `cleanliness.md §4`, `cleanliness.md §11`  
**Where:** `apps/web/src/app/api/media/[id]/libraries/route.test.ts:6-18` · `apps/web/src/app/api/media/[id]/assets/[...assetKey]/route.test.ts:6-18`  

**Problem.** The `encodeSessionCookie` and `sessionCookie` builder functions (12 lines total) are character-for-character identical in both test files. This is the exact duplication pattern cleanliness.md §4 targets for non-formatting duplication. If the session cookie format changes, both copies must be updated. The proxy.test.ts has its own (slightly richer) variant of the same helpers. The pattern will spread to any future route test that needs a session.

**Fix.** Extract a shared test utility at `apps/web/src/lib/api/test-helpers.ts` (or colocated with proxy.test.ts) exporting `encodeSessionCookie`, `sessionCookie`, and `mockBackendFetch` (which is already defined in proxy.test.ts). Import from there in all route test files. This is the single-owner rule applied to test infrastructure.

#### 🟡 5. proxyExtensionToFastAPI mixes NextResponse.json (error paths) with new Response (success path)
`Low` · `High-confidence` · `Other` · rules: `cleanliness.md §1`  
**Where:** `apps/web/src/lib/api/proxy.ts:498-510` · `apps/web/src/lib/api/proxy.ts:519-529` · `apps/web/src/lib/api/proxy.ts:583`  

**Problem.** Error responses in proxyExtensionToFastAPI are built with `NextResponse.json(...)` (lines 498, 519) while the success response is `new Response(await readProxiedBody(...), ...)` (line 583). proxyToFastAPIWithDeps uses `NextResponse.json` for errors and `new NextResponse(responseBody, ...)` for success, which is consistent. Using plain `Response` for the extension success path is a minor inconsistency that could matter if Next.js response handling treats `NextResponse` differently from `Response` in some middleware or test scenarios.

**Fix.** Align proxyExtensionToFastAPI to use `new NextResponse(...)` for the success path, matching the pattern in proxyToFastAPIWithDeps at line 456. This is a one-line change.

#### 🟡 6. Missing runtime = 'nodejs' on the four proxyExtensionToFastAPI routes
`Low` · `Medium-confidence` · `Other` · rules: `cleanliness.md §1`, `cleanliness.md §12`  
**Where:** `apps/web/src/app/api/extension/session/route.ts:1-6` · `apps/web/src/app/api/media/capture/url/route.ts:1-9` · `apps/web/src/app/api/media/capture/article/route.ts:1-9` · `apps/web/src/app/api/media/capture/file/route.ts:1-9` · `apps/web/next.config.ts:19`  

**Problem.** 121 of 125 routes declare `export const runtime = 'nodejs'`. The four routes using `proxyExtensionToFastAPI` are the only ones without it. next.config.ts carries the comment 'Ensure all routes run in Node.js runtime (not Edge)' but implements no such enforcement — there is no `serverRuntime` or `experimental.runtime` in the config. The proxy.ts imports `NextResponse` from `next/server` and `clearSupabaseAuthCookies` from a server-only module, both of which require the Node.js runtime. For extension routes the session-cookie path is not taken (they use Bearer token auth directly), so the missing declaration is not an active bug. However, the omission is inconsistent with the 121-route norm and contradicts next.config.ts's stated intent.

**Fix.** Add `export const runtime = 'nodejs'` to the four extension proxy routes to match the other 121 routes and fulfill the intent expressed in next.config.ts. If the team decides these routes can legitimately run on the Edge runtime (they have no Node.js-only dependencies), document that decision explicitly and remove the misleading comment from next.config.ts.

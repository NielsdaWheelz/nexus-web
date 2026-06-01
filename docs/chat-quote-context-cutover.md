# Chat Quote-Context & Resource-Read Cutover — Design Spec

Status: implemented in the current cutover branch (hard cutover; no legacy paths, no fallbacks, no backward compatibility)
Owner: chat / conversation surface
Companion: `docs/chat-quote-context-cutover-implementation.md` — the "how" (exact signatures, verified file:line, slices, test matrix). This file is the "what / why." Where they differ, the implementation plan is authoritative on mechanism; this spec is authoritative on the contract.
Scope: `python/nexus/services/{resource_resolver,resource_loaders,context_assembler,chat_prompt,chat_runs,reader_navigation}.py`, `python/nexus/services/agent_tools/*`, `python/nexus/schemas/conversation.py`, the chat-run worker + citation pipeline, and the reader→chat frontend wiring.

---

## 1. Problem

When a user attaches a quote (a highlight) to a chat and asks about it, the assistant receives almost none of the context that exists for that quote. Verified end-to-end against production (conversation `cfaa8b5c…`, assistant message `890a4ebe…`, highlight `c58f6a38…`):

- The highlight is stored with `exact="poolpah"`, `prefix="…still retain the ability to function."`, `suffix="hit the fan. I had the unmitigated temerity to suggest to these"`, anchored to the media *"Skinwalkers and Shapeshifters…"* by **Dan Simmons** (Wabash Magazine, 1998).
- The `<resources>` block was assembled and **did** include the highlight — but the resolver rendered it as the bare word `poolpah`. Prefix, suffix, source identity, and the user's note were all dropped.
- The model made **zero** tool calls. It answered *"I don't have enough context from the saved note alone…"*, then stopped.

### Historical root causes (all confirmed in the pre-cutover source)

1. **Resolver starvation.** `_resolve_highlight_batch` (`resource_resolver.py:355`) does `SELECT id, exact FROM highlights`. No prefix/suffix, no parent media, no note.
2. **Read tool starvation.** `_read_highlight` (`agent_tools/read_resource.py:228`) does `SELECT exact FROM highlights`. The fallback returns the same bare word, so "read it" yields nothing new.
3. **Orphaned quote.** A resolved highlight carries no link to its source media; the model can't tell `poolpah` came from the Dan Simmons essay next to it as `media:f744…`.
4. **Phantom contract.** The system prompt told the model *"Any `<reader_selection>` block is the exact passage the user is currently looking at…"* — but the pre-cutover code never emitted `<reader_selection>`.
5. **Documents were not readable.** `read_resource("media:…")` was rejected `scope_not_readable`; `media` resolved search-only. The only path to a pinned document's text was `app_search` (ranked snippets) — so *"summarise this article"* repeatedly failed in prod.
6. **Attached resources & reads were not citable.** Only `app_search`/`web_search` results got `citation_ordinal`s, `message_retrievals` rows, and a `citation_index` event. Attached `<resources>` carried no `n` and `read_resource` persisted nothing — so a `[1]` the model emitted for an attached quote rendered raw (the attached-reference citations regression).

### Structural defect behind 1–3 and 6

`resource_resolver.py` (resolve) and `agent_tools/read_resource.py` (read) maintain **parallel per-scheme functions** — `_resolve_X` and `_read_X` — each re-issuing its own SQL and re-implementing the same permission check, for all eight readable schemes. The bug had to be present in *both* copies. The divergence is the hazard; this cutover removes it.

---

## 2. Goals

- A quote attached to a chat reaches the model with its **exact** text, **prefix**/**suffix** context, **source identity** (title + author), and the user's **note** when present.
- The same enrichment is returned when the model calls `read_resource` on a quote.
- `<reader_selection>` is a real, emitted block for the passage the user is asking "this"/"the quote" about; the prompt stops describing a block that doesn't exist.
- The model can **read and navigate a pinned document** through a crisp, discriminated tool contract — so "summarise this article" works and the model recovers deterministically after every tool call.
- Attached resources and read **evidence** are **citable**: a `[N]` the model emits resolves to a real chip.
- One data-access layer feeds both resolution and reading; the `_resolve_X`/`_read_X` duplication is eliminated.
- References remain **pointers, not copied payloads** (§5).

## 3. Non-goals

- No change to the three-surface chat architecture or scroll model.
- No change to search ranking, the semantic floor, or the FTS/ANN hybrid.
- No new highlight storage. `exact`/`prefix`/`suffix` already exist; notes already exist as `note_blocks` linked by `object_links(relation_type='note_about')`.
- No web-page *reading* beyond `web_search`.
- **No LLM section summaries.** `inspect_resource` previews are deterministic first-line snippets. If real per-section summaries are ever needed, they belong in **indexed/derived document metadata**, not a chat-time pre-pass hidden in a tool.
- No rules engine / auto-classification / LLM pre-pass.
- Converging the document-read assembly with the *ingestion/indexing* block walk is out of scope (different consumers, different shapes).

---

## 4. Target behaviour

**Quote explanation.** A user highlights `poolpah` in the Dan Simmons essay, quotes it into a chat, and asks "where does this word come from?". The turn context now contains a bind-only selection plus an enriched, numbered reference:

```xml
<reader_selection source="“Skinwalkers and Shapeshifters…” by Dan Simmons">
  <prefix>…still retain the ability to function.</prefix>
  <exact>poolpah</exact>
  <suffix>hit the fan. I had the unmitigated temerity to suggest to these</suffix>
</reader_selection>

<resources>
  <resource uri="highlight:c58f6a38…" n="1" label="Highlight in “Skinwalkers and Shapeshifters…” by Dan Simmons" summary="poolpah" fetch_hint="read_resource(&quot;highlight:c58f6a38…&quot;)">
    <quote source="“Skinwalkers and Shapeshifters…” by Dan Simmons">
      <prefix>…still retain the ability to function.</prefix><exact>poolpah</exact><suffix>hit the fan…</suffix>
    </quote>
  </resource>
  <resource uri="media:f744…" label="“Skinwalkers and Shapeshifters…” by Dan Simmons" summary="web_article · ~3,500 words · 14 sections" fetch_hint="inspect_resource(&quot;media:f744…&quot;) to map; read_resource(&quot;media:f744…&quot;) to read; app_search(scopes=[&quot;media:f744…&quot;], query=…) to search" />
</resources>
```

The model answers from prefix/exact/suffix ("the poolpah hit the fan" — a Vonnegut allusion), optionally reads/searches the source, and cites `[1]` as a real chip. `media:f744…` carries no `n` — it is a pointer, citable only once read (§6.5).

**Holistic task.** "Summarise this article" against a pinned `media:` →
`inspect_resource("media:…")` returns a `document_map` of sections (each with a label, first-line preview, and a read pointer) → the model reads the sections it needs via `read_resource("fragment:…")` (article/EPUB/transcript segments) or `read_resource("page_range:…")` (PDF pages), each returning labelled exact text → it synthesises and cites. No whole-document dump; deterministic recovery at every step.

---

## 5. Invariant: references are pointers, not payloads

- A **reference** (`conversation_references` row) stays a `<scheme>:<uuid>` pointer. We enrich only the **resolved view** computed on read, and only with the quote's *own* intrinsic micro-context (prefix/exact/suffix ≤ ~64–128 chars; a short note). Bulk document text is never inlined — it stays behind `inspect_resource`/`read_resource`/`app_search`.
- A **selection** (`<reader_selection>`) is **turn-scoped, bind-only anchor context**, like `branch_anchor`: sent on the request, rendered, discarded. It is never persisted as a reference and **never itself citable** — the passage it shows is always a highlight that is also an attached `highlight:` reference, so it is cited through that reference (§6.5).

---

## 6. Architecture & final state

### 6.1 One data-access layer: `resource_loaders.py`

`python/nexus/services/resource_loaders.py` — the **single per-scheme loader**. `load_resource_batch(db, parsed, *, viewer_id) -> dict[str, LoadedResource]`: exhaustive scheme dispatch (control-flow.md), one SQL + one permission check per scheme, returning the superset both callers need (identity, body, and for highlights a `LoadedQuote{exact, prefix, suffix, source_label, note}`). `resource_resolver.resolve_batch` and `read_resource.execute_read_resource` both consume it; the `_resolve_X`/`_read_X` pairs are **deleted**. (Full `LoadedResource` field set — including `fragment_idx`, `citation_label`, `message_role/count`, `name/item_count`, `media_kind/word_count/section_count` — in the implementation plan §3.1.) Highlight notes reuse `notes.linked_note_blocks_for_highlights`; `source_label` reuses the media-author `string_agg`. No new storage. This makes resolve/read a *presentation* difference over one source of truth — the divergence that caused the bug becomes structurally impossible.

### 6.2 Shared quote renderer: `chat_quote.py`

`render_quote_block(tag, *, exact, prefix, suffix, source_label, note, offset_status)` owns the shared XML shape. Consumed by `<reader_selection>`, `<resource>`-for-highlight (`<quote>`), and the refactored `<assistant_selection>` branch anchor. New module (avoids the `_render_quote_block` name clash in `x_api.py`). Every leaf is `xml_escape`d inside the renderer (generated-text.md).

### 6.3 `ResolvedResource` gains quote structure

Adds `quote: ResolvedQuote | None` (set for highlights → `<quote>` instead of `<body>`). Citation numbering is deliberately kept out of the resolver/API surface: `_build_resources_block` materializes a citation and passes `n` directly to `_render_resource` only when the durable retrieval row can validate.

### 6.4 `<reader_selection>` is real — and bind-only

- **Schema** (`schemas/conversation.py`): `ReaderSelectionRequest{exact, prefix?, suffix?, media_id?, highlight_id?}` (blank-`exact` rejected), added to `ChatRunCreateRequest`. `ReaderContextHint` unchanged — MECE: ambient doc/library vs. the specific passage.
- **Plumbing (6 hops, through the worker — not 3):** `routes/chat_runs.py` → `create_chat_run` → `_chat_run_job_payload` → **`jobs/registry.py`** → **`tasks/chat_run.py`** → `execute_chat_run` → `assemble_chat_context`. It rides the **job payload** (it is not a `Message` column).
- **Idempotency:** `reader_selection` is **answer-determining by durable identity**, so `compute_payload_hash` includes `media_id` + `highlight_id`. Client-supplied `exact`/`prefix`/`suffix` are ignored for hashing because the worker canonicalizes them from the highlight row. (`reader_context` stays excluded: cosmetic hint. The asymmetry is intentional.) Retry enqueues `{"run_id"}` only and drops the anchor → it renders without `<reader_selection>`; the quote still reaches the model via the enriched `highlight:` reference. Accepted degradation; no `messages` migration.
- **Render:** `_build_reader_selection_block` emits `<reader_selection source=…>` via the shared renderer, in the `attached_context` lane before `<resources>`, and re-checks that the underlying `highlight:` reference is still present before rendering. **Bind-only:** never numbered, never a retrieval.

### 6.5 Citation unification

One ordinal sequence across the turn's **evidence**: attached citable resources, `read_resource` evidence, `app_search`, `web_search`. **Navigation (`inspect_resource` → `document_map`) and the `too_large` redirect get no ordinals.**

- At assembly, the resources block attempts to materialize each resource carrying citable content (a `<quote>` or inline `<body>` — *not* `media`/`library` pointers, *not* the selection). It assigns `n = 1..k` **only when** `get_search_result(...)` yields a validator-passing retrieval payload, carries those `RetrievalCitation`s in-memory on the assembly, and renders `n="…"`. Failed materialization means no `n`; ordinals stay dense.
- Because `message_retrievals.tool_call_id` is **NOT NULL** and `_emit_citation_index` joins through `message_tool_calls`, attached citations need a **synthetic parent `message_tool_calls`** row (`tool_name="attached_resources"`, `tool_call_index=0`, `status="complete"`). Real tool calls start at index 1.
- One synthetic `message_retrievals` row per numbered item, `selected=true`, `citation_ordinal=n`, `result_type` = the scheme's natural type (`highlight`→`highlight`, `span`→`evidence_span`, `chunk`→`content_chunk`, …). Its `result_ref`/`locator`/`source_version` are built by reusing `search.get_search_result(db, type, id, viewer_id)` — the same builder `app_search` uses — so the chip resolves and the reader target is valid.
- The tool ordinal counter starts at `k + 1`; `app_search`/`web_search`/`read_resource` continue the same sequence via the unchanged `_assign_citation_ordinals`.
- `read_resource` **evidence** becomes citable (`quote`/`section`/`page_range`/`full`): each persists a retrieval and gets an `n` in its output when the citation materializes. **`document_map` and `too_large` persist no retrieval and get no `n`.** PDF `page_range` evidence cites via `result_type="media"` — the chip points to the document; the page slice remains the read body. Short podcast/video full reads cite via the existing `episode`/`video` result types, because `get_search_result("media", …)` intentionally excludes those kinds. No `result_type` enum or page-range locator migration.
- `_emit_citation_index` emits the ordinal map plus each row's validated `result_ref` payload so attached/read citations can render live chips over SSE, not only after final message reconciliation.

### 6.6 Readable documents — navigation + evidence stack

A single budget-dependent `read_resource(media)` that silently flips full-text↔outline is a bad agent contract. Replace it with **single-purpose tools, each output a discriminated `kind`**, separating targeting / navigation / evidence:

```
app_search(query, scopes?)   → targeting    "find the paragraph about X"            [exists]
inspect_resource(uri)        → navigation   document map: sections + read pointers   [NEW]
read_resource(uri)           → evidence     exact text for a pointer, labelled kind  [enriched]
```

Synthesis is the model's job over evidence it pulls — not a tool.

- **`inspect_resource(uri)` (NEW, navigation).** Returns `kind="document_map"`: media identity + ordered `sections`, each `{ordinal, label, section_kind, preview, read_uri}`. Per-kind data access lives in a **new neutral core service `media_document_map.py`** (`get_media_document_map_for_viewer` → `MediaDocumentMap`), the **single owner of per-kind media document SQL** (module-apis.md). `MediaNavigationOut` (`schemas/media.py:526`) is a **frontend route DTO** and is **not** widened; `reader_navigation.py` stays the reader adapter (web/epub, 409 for the rest) and is **unchanged**. The core reuses `reader_navigation`'s existing web/epub extraction (no duplication) and owns the new SQL for **pdf** (`pdf_page_text_spans`) and **podcast/video** (active-transcript `fragments` as read units, tagged with `parent_label` = the `podcast_episode_chapters` title — a chapter is **not** a one-fragment section). `inspect_resource` is a thin agent adapter (parse URI, call core, render `document_map`, no SQL). `preview` is a deterministic first-line snippet. Navigation is not evidence → **inspect results are never numbered or citable.**
- **`read_resource(uri)` (evidence, explicit `kind` on every result):**
  - `highlight:` → `kind="quote"` (enriched; §6.1–6.2).
  - `fragment:` → `kind="section"` (`canonical_text`) — the read pointer for article/epub sections and podcast/video transcript segments (active transcript only).
  - `page_range:<media>:<a>-<b>` → `kind="page_range"` (slice `plain_text` by the pages' offsets). **New read-only pointer** for PDFs (no fragment rows); parsed only in `read_resource`, **not** a reference scheme.
  - `media:` short (≤ `READ_DOCUMENT_MAX_CHARS = 50_000`) → `kind="full"` (whole body, explicitly labelled).
  - `media:` over budget → `kind="too_large"` + redirect to `inspect_resource("media:…")`. **Explicit, never a disguised outline.**
- **Gate relaxation.** A media-derived read pointer (`fragment`/`page_range`/`span`/`chunk`) is readable when **its parent media's `media:` URI is in `conversation_references`**, even though `inspect_resource` handed the model a sub-URI that isn't itself a reference. Strictly those schemes; `page`/`note_block`/`conversation`/`message` keep exact-membership. **Authorization is unaffected** — `can_read_media` still gates every read in the loader; this only lets the model open sections of a document it has pinned.
- **Rejection split:** keep `SEARCH_SCOPE_RESOURCE_URI_SCHEMES=("media","library")` for app_search scope validation; add a separate `READ_REJECTED_RESOURCE_URI_SCHEMES=("library",)` for the read gate. `media` becomes readable; `library` stays search-only.
- `_resolve_media_batch`: `summary="{kind} · ~{words} words · {sections} sections"` (pages for PDFs; sections for the document-map units when available); `fetch_hint` advertises `inspect_resource` + `read_resource` + `app_search`; `inline_body` stays `None`. The metrics come from `media_document_map`, not duplicate resolver SQL.

### 6.7 Versioning is deleted

The prompt-version bookkeeping is removed rather than bumped. Today there are four ids — `SYSTEM_PROMPT_VERSION` (`chat_prompt.py:19`), `PROMPT_PLAN_VERSION` (`:18`), `ASSEMBLER_VERSION` (`context_assembler.py:49`), `PROMPT_VERSION` (`chat_run_finalize.py:24`) — that drift from the actual rendered content and couple changes to manual bumps (one even pins a test). **Delete all four constants and their persisted columns** (`chat_prompt_assemblies.prompt_version/assembler_version/prompt_plan_version`, and the finalize `PROMPT_VERSION`). The cache key becomes a **content-only `stable_prefix_hash`** derived from the rendered prefix text — so any prompt change self-heals the provider cache with no version string to bump, and there is no `system-v4`. This is **the one DB migration** in the cutover (dropping the version columns). The system-prompt copy is still rewritten (describe the real `<reader_selection>`, the citable-`n` grammar, and the `inspect_resource`→`read_resource` stack), but its identity is its hash, not a label.

### 6.8 Frontend wiring (highlight-first; no raw-text path)

Every reader→chat quote already **creates a highlight first** (`MediaPaneBody.tsx:4923` → `handleCreateHighlight("yellow")` then `quoteHighlightToNewChat`/`…ExtantChat`); there is no highlight-less quote. So `reader_selection` is derived from that just-created highlight (`exact`/`prefix`/`suffix` are on the `Highlight` object; reuse `buildQuoteSelector`), carrying `highlight_id` + `media_id`. The highlight URI is **still** added as a durable reference; the selection is the transient "this" anchor for the asking turn. Threads through `lib/api/sse/requests.ts`, `chatRunBody.ts`, `ChatComposer.tsx`, `ReaderChatDetail.tsx`. No change to `buildCitations`/`MarkdownMessage`/`readerTarget`.

---

## 7. Capability contract

| Resource | In `<resources>` (resolve) | `read_resource(uri)` | Citable |
|---|---|---|---|
| `highlight:` | `<quote>` (prefix/exact/suffix + `source=` + `<note>`); `summary=exact` | `kind="quote"` (never bare `exact`) | yes (`n`) |
| `media:` | pointer: `label="“Title” by Author"`, size/section `summary`, `fetch_hint=inspect+read+search` | `kind="full"` (short) / `kind="too_large"` redirect (over budget) | `full` only (read) |
| `fragment:` (article/epub section, transcript segment) | label/summary; `inline_body` <1500 | `kind="section"` | yes (`n`) |
| `page_range:<media>:a-b` (PDF, read-only pointer) | — (not a reference scheme) | `kind="page_range"` | yes (`result_type="media"` document chip) |
| `library:` | pointer: name + count; `fetch_hint=app_search` | rejected `scope_not_readable` | n/a |
| `span/chunk/page/note_block/message/conversation` | unchanged label/summary; inline body <1500 for body-bearing schemes | full body with explicit `kind` (conversation is summary-style) | attached inline content only, when `get_search_result` materializes |
| `inspect_resource(media:)` → `document_map` | — | navigation (not a read body) | **no** |
| `<reader_selection>` (turn anchor) | own block: prefix/exact/suffix + `source=` | — | **no** (cite the underlying `highlight:`) |

Permissions unchanged: media-derived → `can_read_media`; highlights → `can_read_highlight`; pages/note_blocks owner-only; conversations/messages → `can_read_conversation`. Missing/forbidden → `missing=True` / `error_code`; never raise (errors.md).

---

## 8. Key decisions

1. **Centralize, don't patch twice.** One `resource_loaders.py` replaces the `_resolve_X`/`_read_X` pairs; the divergence is what let the bug live in two places.
2. **Quote ≠ document.** Highlights render as `<quote>` (intrinsic micro-context, inlined); documents are pointers, opened via the nav/evidence stack.
3. **Selection is a bind-only turn anchor.** Rides the request, discarded after render, never citable. The durable, citable attachment is the `highlight:` reference.
4. **Discriminated read contract, not a budget switch.** `inspect_resource` (navigation) + `read_resource` with explicit `kind` (`quote`/`section`/`page_range`/`full`/`too_large`). No silent full-vs-outline flip; deterministic recovery; tasks verified by tool-traces, not just final answers.
5. **Reuse the existing reader map without widening it.** `reader_navigation.get_media_navigation_for_viewer` stays the frontend web/epub adapter. `inspect_resource` owns an agent-neutral `document_map` through `media_document_map.py`, reusing reader navigation for web/epub and owning the new pdf/podcast/video SQL there.
6. **Cite evidence only.** Attached citable resources + read evidence + searches share one ordinal sequence (synthetic parent tool-call + synthetic retrievals, reusing `get_search_result`/`_emit_citation_index`). Navigation and `too_large` are never citable. PDF `page_range` cites via `result_type="media"` document chip — no enum or locator migration.
7. **Delete versioning, not bump it.** Remove the four version ids + their persisted columns; the content-only `stable_prefix_hash` is the cache identity. This is the cutover's one DB migration.
8. **No LLM summaries in the tool.** Deterministic first-line previews; any real summaries are indexed metadata, not a chat-time pre-pass.
9. **Library not readable.** A document has a canonical ordered body; a library does not.
10. **Ingestion assembly stays separate** from read assembly.

---

## 9. Files

**Backend — new:** `services/resource_loaders.py`; `services/chat_quote.py`; `services/media_document_map.py` (per-kind media document core: map + full read + page slice); `services/agent_tools/inspect_resource.py`; the version-column **drop migration**.
**Backend — edit:** `resource_resolver.py` (delete `_resolve_X`; map from loader; `quote`; media summary/fetch_hint; `READ_REJECTED_…`) · `agent_tools/read_resource.py` (delete `_read_X`; loader; `kind`; media `full`/`too_large` + `page_range` via the core; `page_range:` parse; rejection split; `n`) · `context_assembler.py` (`_build_reader_selection_block`; `chat_quote`; `<quote>`/`n`; number attached at assembly; thread `reader_selection`; drop `ASSEMBLER_VERSION`) · `chat_runs.py` (register `inspect_resource`; synthetic parent tool-call + retrievals; `citation_n_next=k+1`; read evidence citable; retry-safe tool traces; SSE citation-index result payloads; thread `reader_selection`) · `chat_prompt.py` (rewrite system prompt; delete `SYSTEM_PROMPT_VERSION`/`PROMPT_PLAN_VERSION`) · `chat_run_finalize.py` (delete `PROMPT_VERSION`) · `chat_run_idempotency.py` (hash durable `reader_selection` ids) · `schemas/conversation.py` (`ReaderSelectionRequest`, citation-index result payload) · `api/routes/chat_runs.py` · `jobs/registry.py` · `tasks/chat_run.py` · `db/models.py` (drop version columns). **`reader_navigation.py` is NOT edited** (frontend-coupled reader adapter; the core reuses it, one-way).
**Frontend — edit:** `lib/api/sse/requests.ts`, `lib/conversations/chatRunBody.ts`, `components/chat/ChatComposer.tsx`, `components/chat/ReaderChatDetail.tsx`, `app/(authenticated)/media/[id]/MediaPaneBody.tsx` (reuse `lib/highlights/quoteText.buildQuoteSelector`).
**Reuse, unedited:** `search.get_search_result`, `notes.linked_note_blocks_for_highlights`, `permissions.*`.
**Docs:** this file; the implementation plan; update `docs/reader-design-rationale.md` (reader→chat selection contract).

---

## 10. Acceptance criteria

Real DB, assert through public surfaces, no implementation mocks (testing_standards.md). Full matrix in the implementation plan §11; headline contracts:

- **Resolver/read:** `highlight:` resolves/reads as an enriched quote (prefix/exact/suffix + source + note), not bare `exact`. `media:` summary reports size/sections and a stack `fetch_hint`.
- **Stack:** `inspect_resource("media:…")` → `document_map` with per-section read pointers (web/epub heading sections; PDF page ranges; podcast/video **active-transcript** segments) and **no `n`**. `read_resource` returns the right `kind`; short media → `full`; over budget → `too_large` redirect (no silent outline); a media-derived pointer reads only when its parent media is referenced.
- **`<reader_selection>`:** present → a bind-only block with prefix/exact/suffix + source when its underlying `highlight:` reference is still attached; absent/reference removed → no block; a different durable selection under the same `Idempotency-Key` conflicts, while spoofed client quote text for the same highlight does not.
- **Citations:** an attached highlight cited `[1]` → a `message_retrievals` row (`citation_ordinal=1`) under the synthetic `attached_resources` tool-call + a `citation_index` entry; read evidence continues the sequence; **navigation/`too_large` produce no ordinals**; ordinals unique & monotonic in one turn.
- **Traces:** for summarize/walk tasks, the trace shows `inspect_resource` then `read_resource` on a **pointer the map returned**.
- **Versioning:** the version constants/columns are gone; `stable_prefix_hash` is content-derived; the test that pinned `PROMPT_PLAN_VERSION` is updated, not preserved.
- **Prod parity:** re-running the poolpah question yields a grounded, citable answer — not "I don't have enough context."

---

## 11. Cutover / rollout

Hard cutover: delete the `_resolve_X`/`_read_X` duplication, the no-retrieval `read_resource` path, and the version constants outright — no flag, no dual-write, no shim. **One DB migration:** drop the version columns (§6.7). Deploy code that no longer writes the old non-null columns together with the migration, with app/worker drain or ordered rollout so old workers are not inserting while the columns disappear. No other migration — every field read already exists (`highlights.exact/prefix/suffix`, `contributor_credits`, `object_links`/`note_blocks`, `fragments.idx/canonical_text/t_start_ms`, `media.plain_text/page_count`, `pdf_page_text_spans`, `podcast_episode_chapters`, `media_transcript_states`); synthetic citation rows use existing tables/enums.

Landing order (slices S1–S5 in the implementation plan): **S1** loaders + consolidation + quote enrichment → **S2** navigation+evidence stack (`media_document_map`; `inspect_resource`; discriminated `read_resource`; `page_range`; gate) → **S3** `<reader_selection>` (6-hop + idempotency + frontend) → **S4** citation unification → **S5** system-prompt rewrite + version deletion/migration. Each slice is independently testable; S4 depends on S1+S3, S5 lands last.

# S4 — Citation Unification: Design Note

Status: implemented in the current cutover branch. This note records the validator-driven decisions and the retry/SSE fixes that shape the live S4 contract.

## Goal

A `[N]` the model emits for an **attached `<resources>` item** or a **`read_resource` evidence result** renders as a real citation chip — the same `citation_index` / `message_retrievals` pipeline that already backs `app_search` / `web_search`. One ordinal sequence across the whole turn. This subsumes the attached-reference citation regression.

## Validator Correction Applied

The impl plan said: number citable attached resources at assembly purely by *content type* (has `<quote>`/inline `<body>`), and if `get_search_result` later fails, persist the row "with `media_id`/`source_version`/`locator` NULL (chip + popup, no deep-link)".

That fallback **cannot validate**. `retrieval_result_ref_json` dispatches on `result_type` and the strict variants **require** non-null fields:

- `highlight` → `color`, `exact`, **`source_version` (min_length 1)**, **`locator`**
- `content_chunk` → `source_kind`, **`source_version`**, **`evidence_span_ids`**, **`locator`**
- `fragment` / `note_block` / `message` / `evidence_span` → **`source_version`** and **`locator`**
- `page` → **`source_version`** (no locator)

`get_search_result(db, viewer_id, result_type, id)` is the only thing that produces a valid `result_ref` + `locator` + `source_version`. When it raises (a highlight with no active content-index run, or no resolvable anchor), **no validator-passing row exists**, so a NULL-field row would be rejected at INSERT.

The frontend chip path keys off persisted retrieval rows + `citation_index` (`apps/web/src/lib/conversations/citations.ts:45`). Rendering `n="1"` before knowing the row is insertable produces the exact raw `[1]` we are fixing. So:

> **Number iff a durable retrieval row materializes.** A resource gets an `n` **only if the same materialization path used for insertion succeeds** for it — `get_search_result(...)` → a `result_ref`/`locator`/`source_version` that passes `retrieval_result_ref_json`. The decision and the validated payload are computed **together, at assembly time**, and the payload is carried **in-memory** to the insert (never rebuilt later from resolver state). For a **highlight**, the strict `HighlightRetrievalResultRef` makes a locator mandatory, so **no search anchor ⇒ no attached-highlight `n`**: its `<quote>` is still in the prompt (S1), it just isn't a chip. (This is *not* a global "number iff clickable" rule — `page`/`conversation`-style types can be valid chips with no reader-scroll target; the gate is "a valid row materializes," which for highlight happens to require a locator.)

> **Dense ordinals, no holes.** `n` is the **running index over *materialized* citations**, not the position in the reference list. Three attached highlights where the middle one can't materialize render `[1]`, `[2]` (the two that did), never `[1]`, gap, `[3]`. `citation_n_next = len(attached_citations) + 1`.

We do **not** loosen the retrieval schema in S4. Inventing a half-valid locator-less highlight result-ref (or a `retrieval_status="attached_context"`-without-locator allowance) is a separate product/schema decision; skipping `n` is the clean choice here. Everything else from the plan (synthetic parent tool-call, unchanged `_emit_citation_index`) stands.

## Mechanism

### 1. Assembly — number the citable subset (`context_assembler._build_resources_block`)

References are already ordered `created_at ASC, id ASC`. For each **resolved** resource:

- **Citable-content gate** (cheap, from the resolved view): a highlight `<quote>`, or an inline `<body>` for `span`/`chunk`/`fragment`/`page`/`note_block`/`message`. **Not** `media`/`library` pointers; **not** the `conversation` summary; **not** `<reader_selection>` (bind-only).
- **Citability check** (authoritative): map URI scheme → retrieval `result_type` (`highlight`→`highlight`, `span`→`evidence_span`, `chunk`→`content_chunk`, `fragment`→`fragment`, `page`→`page`, `note_block`→`note_block`, `message`→`message`), call `get_search_result(db, viewer_id, result_type, source_id)`.
  - **Success** → build a `RetrievalCitation` via the shared `citation_from_search_result(...)` (reused from app_search). Assign the next `n`, pass it to `_render_resource`, and append the citation to an in-memory list.
  - **`NotFoundError` / `ValueError`** → do **not** number (no `n`); render quote/body without a chip. `justify-ignore-error` on the narrowed type.

`k` = count of numbered attached resources. `_render_resource(resource, n=...)` emits `n="…"`; no `citation_n` field is added to `ResolvedResource`.

Carry the citations out of assembly on a **new in-memory field** `ContextAssembly.attached_citations: tuple[RetrievalCitation, ...]`. **Not persisted** — the `message_retrievals` rows are the persistence; `assemble_chat_context` and the insert run in the same `_execute_chat_run` call.

### 2. `_execute_chat_run` — synthetic parent + retrieval rows

After `assemble_chat_context`, when `attached_citations` is non-empty (`k ≥ 1`):

- **Synthetic parent `message_tool_calls`** (one per turn): `tool_name="attached_resources"`, `tool_call_index=0` (real tools start at 1), `scope="attached_context"`, `semantic=false`, `requested_types/result_refs/selected_context_refs/provider_request_ids = []`, `status="complete"`. Idempotent on the unique `(assistant_message_id, tool_call_index=0)` (SELECT-first/update-delete stale retrievals as needed).
- **One `message_retrievals` per citation**, `ordinal = 0..k-1`, `selected=true`, `citation_ordinal = n`, `retrieval_status="attached_context"`, `included_in_prompt=true`, all ref/locator/source_version/media_id/evidence_span_id/deep_link/source_title/section_label/exact_snippet from the citation — via the **shared insert helper** (below).
- **`citation_n_next = k + 1`** (was `1`); `tool_call_index_next` stays `0`. Assembly's `n=1..k` and the rows' `citation_ordinal=n` align because both walk the same created_at-ordered list.

`_emit_citation_index` still JOINs `message_tool_calls` and emits any selected row with `citation_ordinal IS NOT NULL`; synthetic rows flow through automatically. It also includes each row's validated result payload for live SSE chips, and the `reference_added` side-effect is idempotent for an already-pinned highlight.

### 3. `read_resource` evidence becomes citable (§4.6)

Evidence kinds — `quote` / `section` / `page_range` / `full` — get one retrieval row + the next ordinal. `too_large` and `inspect_resource`'s `document_map` get **nothing** (navigation, not evidence).

In the read dispatch (`chat_runs`), persist the read tool-call **`RETURNING id`**, and for an evidence result insert one `message_retrievals` (`selected=true`) under it, then:
`start_n = citation_n_next; citation_n_next = _assign_citation_ordinals(db, tool_call_id=<id>, start_ordinal=citation_n_next)` and surface `start_n` as `n` in the read `tool_output()`.

Per kind, the citation materializes from `get_search_result` exactly like the attached path:
- `quote` → `get_search_result("highlight", highlight_id)`.
- `section` → `get_search_result("fragment", fragment_id)`.
- `full` and `page_range` → document-level chip. For ordinary media and PDFs use `get_search_result("media", media_id)`; for podcast/video full reads use `get_search_result("episode"|"video", media_id)` because the `media` result type intentionally filters those kinds out. The page slice is still the read body; the chip points to the document.

Same degradation rule: if `get_search_result` raises (e.g. an un-anchored highlight), the read still returns its body but gets **no** `n`.

`read_resource` exposes the citation target on `ReadResourceResult` (`citation_result_type` + `citation_source_id`, set for evidence kinds) so the dispatch materializes the row without re-parsing the URI.

## Consolidation (reuse, don't duplicate — the cutover theme)

The "turn a `SearchResultOut` into a validated `message_retrievals` row" capability is today **app_search-private** (`AppSearchCitation`, `_citation_from_search_result`, the INSERT inside `persist_app_search_run`). Three callers now need it (app_search, synthetic attached, read evidence), so it gets **one owner**:

- Extract to a shared module (`services/retrieval_citation.py`): `RetrievalCitation` (today `AppSearchCitation`), `citation_from_search_result(...)`, and `insert_retrieval_row(db, *, tool_call_id, ordinal, citation, selected, scope, retrieval_status, included_in_prompt, citation_ordinal=None)`.
- `app_search.persist_app_search_run` calls the shared `insert_retrieval_row` in its loop (behaviour byte-stable — covered by existing `test_agent_app_search`).
- The synthetic-attached and read-evidence paths call the same helper.

No new INSERT is hand-written; every row goes through the one validated path.

## Files

- **new** `services/retrieval_citation.py` — `RetrievalCitation`, `citation_from_search_result`, `insert_retrieval_row` (extracted from app_search).
- `services/agent_tools/app_search.py` — consume the shared helper (delete the moved code).
- `services/context_assembler.py` — `_build_resources_block` materializes citations via `get_search_result` in reference order, increments `n` only on success, renders `_render_resource(resource, n)`, records `ContextAssembly.attached_citations` (in-memory tuple of validated payloads). No `citation_n` field on `ResolvedResource` — `n` is passed to `_render_resource`, keeping it out of the resolver/API surface.
- `services/chat_runs.py` — synthetic parent tool-call + retrieval inserts from `assembly.attached_citations`; `citation_n_next = len(attached_citations)+1`; read-evidence retrieval + ordinal + `n`; retry-safe read/inspect tool-call upsert; `_assign_citation_ordinals` reassigns selected rows densely and clears unselected rows; `citation_index` includes each validated result payload for live SSE chips.
- `services/agent_tools/read_resource.py` — surface `result_type`/`source_id`/page-range on `ReadResourceResult` for evidence kinds.

## Tests

- Attached highlight (poolpah-style, real anchor) cited `[1]` → a `message_retrievals` row `citation_ordinal=1` under the synthetic `attached_resources` tool-call (`tool_call_index=0`), carrying `media_id`+`source_version`+valid `locator` (chip clickable) + a `citation_index` entry.
- Attached span/chunk/fragment inline body → numbered and cited; `media`/`library`/`conversation`/`reader_selection` → **no** `n`.
- A highlight with **no** search anchor → **not** numbered (no row, no raw `[N]`); its `<quote>` still present.
- `read_resource` evidence (`quote`/`section`/`full`/`page_range`) → next ordinal, `n` in output; `too_large` + `inspect_resource` → no ordinal.
- Ordinals unique + monotonic across attached → read → app_search in one turn (`citation_n_next=k+1`), including replay of already-persisted app-search/read tool calls.
- `test_agent_app_search` stays green (shared-helper extraction is behaviour-preserving).

## Decided (reviewer)

The degradation is **"no anchor ⇒ no attached-highlight `n`"** — validator-compliant, no schema loosening in S4. "Every attached quote always gets a chip even without a reader target" is a separate product/schema decision, out of scope here. Tests assert: anchored highlight → `n` + synthetic row + `citation_index` + clickable target; un-anchored highlight → enriched `<quote>` but **no** `n`, **no** synthetic row, and the tool/search ordinals still start at the correct next number; mixed attached → monotonic ordinals, no gaps; `read_resource("highlight:…")` without a materializable retrieval → quote, no `n`.

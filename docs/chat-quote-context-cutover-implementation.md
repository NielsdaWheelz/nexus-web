# Chat Quote-Context & Resource-Read Cutover — Implementation Plan

Status: implemented in the current cutover branch (hard cutover; no legacy paths, no fallbacks, no backward compatibility)
Companion to: `docs/chat-quote-context-cutover.md` (the design spec — the canonical "what" and "why").
This document is the "how": exact module/API design, data contracts, the consolidation map, a verified file-by-file change list, sequenced landable slices, an acceptance/test matrix, and the source-level corrections that shaped the approved design.

This document is retained as the implementation map and acceptance checklist. Where this plan and the design spec disagree, **the design spec is authoritative**; treat any disagreement here as stale implementation-plan text to fix before shipping.

---

## 0. Scope

Five coupled fixes, one cutover (design spec §1 enumerates the root causes):

1. **Resolver/read consolidation** — replace the parallel `_resolve_X`/`_read_X` per-scheme functions with one data-access layer (`resource_loaders.py`). The duplication is the structural defect that let the quote-starvation bug live in two places.
2. **Quote enrichment** — an attached highlight reaches the model as a `<quote>` (prefix/exact/suffix + source title/author + the user's note), not the bare `exact` word. Same enrichment on `read_resource`.
3. **`<reader_selection>` turn anchor** — make real the block the system prompt already describes; thread it like `reader_context`.
4. **Readable documents — navigation + evidence stack** (revised per SME review, §3.5): `inspect_resource` returns a per-kind document map (sections + read pointers, reusing `reader_navigation`); `read_resource` returns exact text for a pointer with an explicit `kind` (`quote`/`section`/`page_range`/`full`/`too_large`) — no silent full-vs-outline switch; `library:` stays search-only.
5. **Citation unification** — attached resources, `read_resource`, `app_search`, `web_search` share one ordinal sequence; attached/read content becomes `[N]`-citable via synthetic `message_retrievals`. This subsumes the attached-reference citation regression ([[project_attached_reference_citations_regression]]).

Non-goals: unchanged from design spec §3 (no chat-architecture change, no search-ranking change, no new highlight storage, no web-page reading, no rules engine, ingestion assembly stays separate). Not repeated here.

---

## 1. Corrections Incorporated From the Original Draft

These are load-bearing source-level corrections that were folded into the current design spec. Keep them here as implementation rationale and guardrails, not as a competing contract.

| # | Original-draft statement | Correction (verified) | Implementation impact |
|---|---|---|---|
| C1 | §6.5/§9: a synthetic `message_retrievals` row per attached resource (lists `result_type, source_id, citation_ordinal, selected, included_in_prompt`). | **`message_retrievals.tool_call_id` is `NOT NULL` with an FK to `message_tool_calls`** (`models.py:4329-4333`), and `_emit_citation_index` reads rows **only via `JOIN message_tool_calls … WHERE assistant_message_id=:amid`** (`chat_runs.py:376`). So synthetic retrievals **require a synthetic parent `message_tool_calls` row**. | Create one synthetic tool-call row per turn (see §4.4). |
| C2 | §6.4/§9: `<reader_selection>` threads "`routes/chat_runs.py` → `create_chat_run` → `assemble_chat_context`." | The real turn-anchor path (`reader_context`) is **6 hops** and runs through the **job worker**: route → `_chat_run_job_payload` → `jobs/registry.py:274` → `tasks/chat_run.py` → `execute_chat_run`/`_execute_chat_run` → `assemble_chat_context`. | Include `python/nexus/jobs/registry.py` and `python/nexus/tasks/chat_run.py`; selection must serialize into the job payload (it is **not** a `Message` column like `branch_anchor`). |
| C3 | §6.6: "Update `SEARCH_SCOPE_RESOURCE_URI_SCHEMES` handling so the rejection applies to `library` only." | `SEARCH_SCOPE_RESOURCE_URI_SCHEMES=("media","library")` (`resource_resolver.py:52`) is **overloaded**: `read_resource.py:145` uses it to reject reads, but `app_search.py:497,511` uses it to validate **search scopes** — `media` must stay a valid search scope. **Removing `media` from it breaks app_search.** | Introduce a **separate** `READ_REJECTED_RESOURCE_URI_SCHEMES=("library",)`; leave the search tuple intact. |
| C4 | §6.6: over-budget media "returns the outline of `fragment:` URIs." | **PDFs have zero `Fragment` rows** — PDF text lives only in `media.plain_text` (`pdf_ingest.py:524`); all other kinds use `fragments.canonical_text`. An over-budget **PDF has no `fragment:` URIs to outline.** | Use the navigation/evidence stack: over-budget `media:` returns `kind="too_large"`; `inspect_resource` maps PDFs to `page_range:` read pointers. |
| C5 | §6.6: outline `fragment:` URIs are "already supported." | `read_resource("fragment:UUID")` is gated by a `conversation_references` membership check (`read_resource.py:99`). A pinned **media** inserts only the `media:UUID` reference, **not** per-fragment URIs — so a map's fragment reads would be **rejected `not_in_references`** without a gate change. | Implement the decided media-parent gate relaxation for `fragment`/`page_range`/`span`/`chunk` (§3.5, §6). |
| C6 | §6.5: highlight synthetic row "reuses the existing table." | A citable highlight's `result_ref`/`locator`/`source_version` **cannot be derived from the `highlights` table** (resolver only has `id, exact`). They come from the search single-result builder. **Reuse `get_search_result(db, "highlight", id, viewer_id)`** (`search.py:821`) to build a validated locator + source_version + `result_ref`; otherwise the strict `retrieval_result_ref_json` validator rejects the row and `readerTargetFromRetrieval` returns null. | The riskiest path; §4.5 specifies it. |
| C7 | §6.1: `LoadedResource{uri,kind,title,source_label,body,quote,missing}`. | That shape **can't reconstruct** several existing presenter outputs: `fragment_idx` (label "fragment {idx+1}"), `citation_label` (span), `message_count`/`message_role`, library `name`/`item_count`, and §6.6's own `media_kind`/`word_count`/`section_count`. | Corrected `LoadedResource` in §3.1. |
| C8 | §6.7: bump `chat_prompt.py:29` (`system-v4`); bump `assembler_version`/`prompt_plan_version` "as appropriate." | `SYSTEM_PROMPT_VERSION` is at **`chat_prompt.py:19`**, not 29, and there are **four** drift-prone version ids (`SYSTEM_PROMPT_VERSION`, `PROMPT_PLAN_VERSION`, `ASSEMBLER_VERSION`, `PROMPT_VERSION`), one of which pins `test_openai_reasoning_contracts.py:296`. **Resolved by O3 — delete all four + their persisted columns; no `system-v4`.** The cache key becomes a content-only `stable_prefix_hash`. | §7 versioning removal (the cutover's one DB migration). |
| C9 | §6.8/frontend: "live, not-yet-saved selection." | Every reader→chat quote path **creates a Highlight first** (`MediaPaneBody.tsx:4923` calls `handleCreateHighlight("yellow")` then `quoteHighlightToNewChat`). There is no highlight-less quote. And the current path sends a `highlight:` **URI reference**, not a selection — `reader_selection` is **net-new** wiring layered beside it. | `buildQuoteSelector(highlight)` is the reuse; no new selector. |
| C10 | §7 contract table marks `<reader_selection>` **citable (`n`)**, while §5/`:81` says it is transient and never stored. | A durable citation chip needs a persisted retrieval target; a transient turn-anchor has none. Since the selection is **always** a highlight that is also an attached `highlight:` reference (C9), the passage is cited through that reference. **`<reader_selection>` is bind-only — never numbered, never a synthetic retrieval.** | §4.3 fix; the current design spec already reflects this. |
| C11 | §6.4: `reader_selection` "passed through exactly like `reader_context`." | `reader_context` is **excluded** from `compute_payload_hash` (`chat_run_idempotency.py:21-35`, verified). Copying that for `reader_selection` is **wrong**: the selection is answer-determining, so a different selection replayed under the same `Idempotency-Key` must conflict, not silently return the cached run. | **Add `reader_selection` to `compute_payload_hash`** (§3.4). Retry path carries `{"run_id"}` only and drops turn anchors → retry renders without `<reader_selection>`; the quote still reaches the model via the enriched `highlight:` reference (S1). Documented degradation; no `messages` migration. |

Minor name collisions to avoid: a shared `render_quote_block` would collide with `x_api.py:668 _render_quote_block` (HTML quote-tweets — unrelated); put the shared renderer in a new `chat_quote.py` (§3.2). `MediaKind` is `podcast_episode`, not `podcast` (`models.py:94-101`); the read branch is `pdf` vs. everything-else.

---

## 2. Architecture & final state

```
                    ┌─────────────────────────────────────────────┐
                    │ resource_loaders.py  (NEW — single source)  │
                    │  load_resource_batch(db, parsed, viewer_id) │
                    │     → dict[uri, LoadedResource]             │
                    │  load_media_document(db, media_id)          │
                    │     → DocumentRead                          │
                    └───────────────┬───────────────┬─────────────┘
              presentation: resolve │               │ presentation: read
                    ┌───────────────▼──┐      ┌─────▼──────────────────┐
                    │ resource_resolver│      │ agent_tools/read_      │
                    │  resolve_batch   │      │ resource.execute_read_ │
                    │  → ResolvedResource    │ resource → ReadResourceResult
                    │   (+quote)             │   (quote/section/page_range/full/too_large)
                    └───────┬──────────┘      └─────────┬──────────────┘
            <resources> + n │                           │ read result + n
                            │      inspect_resource wraps reader_navigation
                            │      → document_map (navigation, no n)
                    ┌───────▼───────────────────────────▼──────────────┐
                    │ context_assembler.assemble_chat_context           │
                    │  lanes: reader_context_hint → reader_selection →  │
                    │         branch_anchor → <resources(n)>            │
                    │  chat_quote.render_quote_block  (shared)          │
                    │  records materialized attached citations           │
                    │  on the assembly → k = #citable attached          │
                    └───────────────────────┬───────────────────────────┘
                                            │ k
                    ┌───────────────────────▼───────────────────────────┐
                    │ chat_runs._execute_chat_run                        │
                    │  • synthetic message_tool_calls (index 0)          │
                    │  • synthetic message_retrievals (n=1..k, selected) │
                    │  • citation_n_next = k+1   (was hardcoded 1)       │
                    │  • app_search/web_search/read_resource continue    │
                    │    the same sequence; read_resource now citable    │
                    │  • _emit_citation_index emits ordinals + results   │
                    └───────────────────────┬───────────────────────────┘
                                            │ citation_index event + retrieval_result blocks
                    ┌───────────────────────▼───────────────────────────┐
                    │ Frontend: buildCitations joins by                  │
                    │ (tool_call_id, ordinal); [N] → ReaderCitation chip │
                    └────────────────────────────────────────────────────┘
```

**Final state, one line per fix.** (1) One per-scheme data layer; `_resolve_X`/`_read_X` deleted. (2) Highlights resolve/read as enriched `<quote>`. (3) `<reader_selection>` is emitted for the turn's passage. (4) `media:` is readable; `library:` search-only. (5) Every citable surface shares one ordinal sequence; attached/read content is `[N]`-citable through synthetic retrievals and live SSE citation-index result payloads.

---

## 3. Module & API design (backend)

### 3.1 `python/nexus/services/resource_loaders.py` (NEW) — the single data-access layer

```python
ResourceUriScheme = Literal[  # re-exported from resource_resolver (unchanged set)
    "media","library","span","chunk","highlight","page","note_block","fragment","conversation","message"]

@dataclass(frozen=True)
class LoadedQuote:
    exact: str
    prefix: str                  # highlights.prefix is NOT NULL (may be "")
    suffix: str                  # highlights.suffix is NOT NULL (may be "")
    source_label: str | None     # "“Title” by Author"
    note: str | None             # joined note_blocks text, or None

@dataclass(frozen=True)
class LoadedResource:
    uri: str
    kind: ResourceUriScheme
    missing: bool
    body: str | None             # span_text / chunk_text / canonical_text / description / body_text / message content
    quote: LoadedQuote | None    # highlight only
    # identity / presenter inputs (C7 — superset of what BOTH resolve and read need):
    title: str | None            # media/span/chunk/fragment source title; page title; conversation title
    source_label: str | None     # "“Title” by Author" for media-derived
    name: str | None             # library name (distinct from media title)
    fragment_idx: int | None     # fragment label "fragment {idx+1}"
    citation_label: str | None   # evidence_span label
    message_role: str | None     # message "{role}: …"
    message_count: int | None    # conversation summary / read body
    item_count: int | None       # library "{name} ({count} items)"
    media_kind: str | None       # media summary "kind · ~N words · M sections"
    word_count: int | None       # media summary
    section_count: int | None    # media summary (= document-map sections; pages for PDF)

def load_resource_batch(
    db: Session, parsed: list[ParsedResourceUri], *, viewer_id: UUID
) -> dict[str, LoadedResource]: ...
#   one SQL per scheme (batch `= ANY(:ids)`), one permission check per scheme,
#   EXHAUSTIVE match on scheme (control-flow.md). Missing/forbidden → LoadedResource(missing=True);
#   never raises (errors.md). read_resource calls with a 1-element list.

@dataclass(frozen=True)
class MediaDocumentSummary:
    section_count: int | None
    word_count: int | None

def load_media_document_summary(db: Session, viewer_id: UUID, media_id: UUID) -> MediaDocumentSummary | None: ...
#   Prompt-facing media metrics live in media_document_map.py so resolver summaries
#   cannot drift from inspect_resource/read_resource ownership.

@dataclass(frozen=True)
class DocumentRead:
    media_id: UUID
    kind: str
    title: str
    body: str
    char_count: int

def load_media_document(db: Session, viewer_id: UUID, media_id: UUID) -> DocumentRead | None: ...
#   TYPED body assembly per MediaKind. Navigation maps and section read pointers
#   belong to the same media_document_map core, not resource_loaders.
#   • web_article | epub: rows = fragments WHERE media_id ORDER BY idx;
#       body="\n\n".join(canonical_text).
#   • podcast_episode | video: rows = fragments WHERE media_id
#       AND transcript_version_id = media_transcript_states.active_transcript_version_id
#       ORDER BY t_start_ms NULLS LAST, idx  — ACTIVE transcript ONLY; never mix
#       versions (models.py:3105-3188).
#   • pdf: body=media.plain_text. PDF sectioning/page ranges come from
#       read_page_range over pdf_page_text_spans.
```

Reuse (no re-implementation): `parse_resource_uri`/`ParsedResourceUri` (`resource_resolver.py:81`), `linked_note_blocks_for_highlights(db, viewer_id, ids)` (`notes.py:989`) for the note, the media author `string_agg(DISTINCT cc.credited_name … role='author')` (`resource_resolver.py:186-194`) for `source_label`, `permissions._resolve_typed_highlight_media_id` (`permissions.py:233`) to get the highlight's validated parent media, `vault._load_fragments` idiom for ordered fragments, `epub_read._compute_word_count` (`epub_read.py:45`) for words, `epub_ingest._fallback_fragment_label`/`resource_resolver._first_line` for section labels.

**Highlight loader** is the one with new SQL: `highlights` (`exact,prefix,suffix,anchor_*`) → validated `media_id` → author `string_agg` → `linked_note_blocks_for_highlights`. Permission: `can_read_highlight(db, viewer_id, id)` (by id, as today).

### 3.2 `python/nexus/services/chat_quote.py` (NEW) — shared quote renderer

```python
def render_quote_block(tag, *, exact, prefix=None, suffix=None, source_label=None,
                       note=None, offset_status=None) -> str:
    # <tag source="…"> optional prefix, mandatory exact, optional suffix/note/status </tag>
```

Consumers (consolidation, §5): `<reader_selection>` (new), `<resource>`-for-highlight (`<quote>` in `_render_resource`), `<assistant_selection>` (refactor `_render_branch_anchor_block`, `context_assembler.py:538`, preserving `<offset_status>` ordering). New module (not `context_assembler`) to avoid the `render_quote_block` name clash with `x_api.py`.

### 3.3 `ResolvedResource` gains structure (`resource_resolver.py:71`)

```python
@dataclass(frozen=True)
class ResolvedResource:
    uri: str; label: str; summary: str; inline_body: str | None; fetch_hint: str
    quote: ResolvedQuote | None = None    # NEW — set for highlights
    missing: bool = False
```
`_render_resource(resource, n=None)` (`context_assembler.py`): emit `<quote source=…>…</quote>` when `quote`, else `<body>` when `inline_body`, else self-closing; emit `n="…"` only when assembly has already materialized a valid citation.

### 3.4 `ReaderSelectionRequest` (`schemas/conversation.py`) — turn anchor

```python
class ReaderSelectionRequest(BaseModel):
    exact: str = Field(..., min_length=1, max_length=20000)
    prefix: str | None = Field(default=None, max_length=1000)
    suffix: str | None = Field(default=None, max_length=1000)
    media_id: UUID | None = None
    highlight_id: UUID | None = None
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")              # parity with AssistantSelectionBranchAnchorRequest:501
    def _exact_not_blank(self): ...             # reject whitespace-only exact
```
Add `reader_selection: ReaderSelectionRequest | None = None` to `ChatRunCreateRequest` (after `reader_context`, `conversation.py:623`). `ReaderContextHint` unchanged — MECE: ambient doc/library (`reader_context`) vs. the specific passage (`reader_selection`). **Not** persisted (not a `Message` column; not the dormant `message_context_items` table).

**Bind-only + idempotency (C10, C11).** `<reader_selection>` only resolves pronouns ("this"/"the quote"); it is never numbered or turned into a retrieval — the passage is cited via its attached `highlight:` reference. Because the selection *is* answer-determining, `compute_payload_hash` includes the durable selection identity (`media_id` + `highlight_id`) and ignores client quote text that the worker canonicalizes from the row. `reader_context` stays excluded (a cosmetic hint, not answer-determining) — the asymmetry is intentional. Retry (`retry_failed_assistant_response`) enqueues `{"run_id"}` only and carries no turn anchor; it renders without `<reader_selection>` and relies on the enriched `highlight:` reference for the quote (accepted degradation; avoids a `messages` column).

### 3.5 Readable documents — navigation + evidence stack (REVISED per SME review)

The earlier "`read_resource(media)` → full body if ≤50k else outline" was withdrawn: a budget-dependent **silent switch** between full text and a bare pointer list is a bad agent contract (a "failure mode disguised as a read"; the model can't predict which it gets). Replaced by a stack of **single-purpose tools, each output a discriminated `kind`**, separating *targeting* / *navigation* / *evidence*:

```
app_search(query, scopes?)      → targeting     ("find the paragraph about X")        [exists]
inspect_resource(uri)           → navigation    (document map: sections + pointers)    [NEW]
read_resource(uri)              → evidence      (exact text for a stable pointer)      [enriched]
```

Synthesis ("summarise this article", "walk the argument") is the **model's** job over evidence it pulls — not a tool. No tool ever mixes navigation, evidence, and synthesis without an explicit `kind`.

**`inspect_resource(uri)` — navigation (NEW tool).** Returns `kind="document_map"`: media identity + an ordered `sections` list, each `{ ordinal, label, section_kind, preview, read_uri }`. The per-kind data access lives in a **new neutral core service `services/media_document_map.py`** — `get_media_document_map_for_viewer(db, viewer_id, media_id) -> MediaDocumentMap` (sections carry `label, section_kind, preview, read_uri, source_version` + optional `fragment_id`, `page_start/page_end`, `t_start_ms/t_end_ms`, `parent_label`). This is the **single owner of per-kind media document SQL**; it also owns `load_media_document` (full read body + counts) and `read_page_range` (PDF slice). **Do not widen `MediaNavigationOut`** — it is a frontend route DTO (`schemas/media.py:526`, `kind = epub | web_article`, mirrored in `apps/web/.../readerNavigation.ts` and consumed as TOC UI). `reader_navigation.py` stays the **reader adapter** (returns `MediaNavigationOut`, still 409s for pdf/podcast/video until the reader UI has a contract for them); it may later call the core, but is unchanged in this cutover. `inspect_resource.py` is the **agent adapter**: it parses the URI, calls the core, renders `document_map`, and owns no per-kind SQL.
- **web_article / epub**: the core reuses the existing extraction (`reader_navigation.get_media_navigation_for_viewer` → heading hierarchy / `epub_nav_locations`, which carry `fragment_id`); `read_uri = fragment:<fragment_id>`. No SQL is duplicated; the core depends on `reader_navigation` (one-way — `reader_navigation` does not import the core).
- **pdf**: the core builds sections from `pdf_page_text_spans` (`page_number`, `page_label`, `start_offset/end_offset` into `media.plain_text`); `read_uri = page_range:<media_id>:<a>-<b>` (page-grouped to ~budget).
- **podcast / video**: the read units are the **active-transcript `fragments`** themselves (`read_uri = fragment:<id>`, which the read tool can actually open), each tagged with `parent_label` = the `podcast_episode_chapters` title whose time range contains it. Active transcript only (`fragments.transcript_version_id = media_transcript_states.active_transcript_version_id`). A chapter is **not** a one-fragment section unless the fragment is the whole chapter (a real time-range read pointer can come later, like `page_range:` for PDF).
- `preview` = `_first_line`/snippet of the section text — **deterministic, not an LLM summary** (keep it cheap; trust the model). Navigation is **not evidence**: inspect results are never numbered and never citable (§4.2). The model cites what it subsequently *reads*.

**`read_resource(uri)` — evidence, explicit `kind` on every result.** `ReadResourceResult` gains a `kind` field, rendered as `<resource uri=… kind=…>`:
- `highlight:` → `kind="quote"` (enriched prefix/exact/suffix + source + note; lever 1).
- `fragment:` → `kind="section"` (`canonical_text`).
- `page_range:<media>:<a>-<b>` → `kind="page_range"` (slice `plain_text` by the pages' offsets). **NEW read-only pointer** (parsed by `read_resource`; *not* added to `RESOURCE_URI_SCHEMES`/references). PDF pages have no fragment rows, so this is the PDF evidence unit.
- `media:` short doc (≤ `READ_DOCUMENT_MAX_CHARS`) → `kind="full"` (whole body, **explicitly** labelled).
- `media:` over budget → `kind="too_large"` + "call `inspect_resource("media:…")` for the section map, then read sections." An **explicit redirect**, never a disguised outline. (`READ_DOCUMENT_MAX_CHARS = 50_000`, next to `INLINE_THRESHOLD_CHARS`.)

**Stable pointers & citation.** Reuse `highlight:`/`fragment:` (real, citable). `page_range:` is a read-only pointer: its citation uses `result_type="media"` (the chip points at the document; no `result_type` enum or page-range locator migration). Reads are citable (`full`→media; `section`→fragment; `page_range`→media document chip; `quote`→highlight). **inspect (navigation) is not citable.** This keeps every citable thing mapped to a durable retrieval row + stable URI, and gives deterministic recovery: *map → I know exactly what to read → read returns labelled exact text*.

**Gate relaxation (DECIDED O2 — retained, now central to nav→read).** `read_resource`'s membership check (`read_resource.py:99-119`) is widened so a **media-derived** read pointer (`fragment`, `page_range`, `span`, `chunk`) is readable when **its parent media's `media:` URI is in `conversation_references`**, even though `inspect_resource` handed the model a sub-URI that isn't itself a reference. Strictly those schemes; `page`/`note_block`/`conversation`/`message` keep exact-membership. **Authorization is unaffected** — `can_read_media` still gates every read in the loader; this only lets the model open sections of a document it has already pinned. Implement: on a non-referenced media-derived URI, resolve its parent `media_id` and check `media:<parent>` membership before dispatch.

**Rejection split (C3):** `READ_REJECTED_RESOURCE_URI_SCHEMES=("library",)`; `read_resource.py:145` → `if parsed.scheme in READ_REJECTED_…`; add `media` + `page_range` dispatch branches; update the tool description (`read_resource.py:42-45`). `SEARCH_SCOPE_RESOURCE_URI_SCHEMES` unchanged.

**`_resolve_media_batch` (`resource_resolver.py:173`):** `summary="{kind} · ~{words:,} words · {sections} sections"` (PDF → `pages`); `fetch_hint='inspect_resource("{uri}") to map; read_resource("{uri}") to read; app_search(scopes=["{uri}"], query=…) to search'`; `inline_body` stays `None`.

### 3.6 Citation unification — see §4 (the riskiest mechanism, broken out).

### 3.7 Prompt update + versioning removal (`chat_prompt.py` + `render_system_prompt_block`) — see §7.

---

## 4. Citation unification — exact mechanism

This is the part with the most failure modes; every field below was checked against `models.py`, the schema validators, and `_emit_citation_index`.

### 4.1 Two counters (don't conflate)

In `_execute_chat_run` (`chat_runs.py:1009-1010`): `citation_n_next` (1-based citation ordinal, the `[N]`) and `tool_call_index_next` (0-based `message_tool_calls.tool_call_index`, incremented to 1+ before each real tool dispatch at `:1086`). They are independent.

### 4.2 The rule for which resources get an `n`

A resource is numbered **iff it carries citable content in-prompt**: a `<quote>` (highlight) or an inline `<body>` (span/chunk/page/note_block/fragment/message under the 1500-char threshold). **Media/library pointers carry neither → no `n`, not citable until read** (matches contract table; design spec §7). This keeps "pointer ≠ payload."

### 4.3 Numbering happens at assembly time; the count crosses one boundary

`context_assembler._build_resources_block` (`:486-518`) already orders references `created_at ASC, id ASC`. Attempt materialization in that fixed order; assign `n=1..k` only to successful materializations, render `n="…"`, and carry the resulting `RetrievalCitation`s on an **in-memory** `ContextAssembly.attached_citations` field. Nothing new is persisted by prompt assembly; the synthetic `message_retrievals` rows are the persistence boundary. The `<reader_selection>` block is **bind-only and never numbered** (C10): the passage it shows is always a highlight that is *also* an attached `highlight:` reference (C9), so it is cited through that reference's `n` when that reference materializes, not its own. `k` (= count of numbered **attached resources**, selection excluded) is read directly from `assembly.attached_citations` in `_execute_chat_run` (it holds `assembly` in scope at `:966-975`).

Then **change `chat_runs.py:1009` from `citation_n_next = 1` to `citation_n_next = k + 1`.** `tool_call_index_next` stays `0`. The two `_assign_citation_ordinals` call sites (`:1111`, `:1155`) thread the counter unchanged; `read_resource` gains the same two lines (§4.6).

### 4.4 Synthetic parent `message_tool_calls` (one per turn, only if k ≥ 1)

| column | value | why |
|---|---|---|
| conversation_id / user_message_id / assistant_message_id | from `run` | `assistant_message_id` mandatory for the `_emit_citation_index` JOIN (C1) |
| tool_name | `"attached_resources"` | 1–128 chars |
| **tool_call_index** | **`0`** | reserved; real tools start at 1; satisfies `uix_message_tool_calls_assistant_index` |
| scope | `"attached_context"` | 1–256 |
| requested_types / result_refs / selected_context_refs / provider_request_ids | `[]` | JSONB arrays, NOT NULL |
| semantic / status | `false` / `"complete"` | |

Because finalize orders blocks `tool_call_index ASC, ordinal ASC` (`chat_run_message_blocks.py`), index 0 places attached citations first → `n=1..k`, clean.

### 4.5 Synthetic `message_retrievals` — per citable attached item

Insert one row per numbered item under the synthetic parent, `ordinal = 0..k-1`, `selected = true` (required — `_assign_citation_ordinals` only numbers `selected=true`), `citation_ordinal` set directly to the assembly-assigned `n` (or left NULL and stamped by `_assign_citation_ordinals(start_ordinal=1)`; either is valid). Mandatory columns and per-type specifics:

- **highlight** (full reader target): `result_type="highlight"`, `source_id=<uuid>`, `retrieval_status="attached_context"`, `included_in_prompt=true`. `context_ref` via `retrieval_context_ref_json({"type":"highlight","id":…})`. **`result_ref`, `locator`, `source_version`, `media_id`, `evidence_span_id`, `deep_link` must come from `get_search_result(db, "highlight", id, viewer_id)`** (`search.py:821`) mapped through the same `_citation_from_search_result` shape app_search uses (C6) — the resolver can't build a valid `HighlightRetrievalResultRef` (it requires `color, exact, source_version, locator`). `source_title`/`exact_snippet`/`section_label` set for the popup.
- **span/chunk/fragment/page/note_block/message** (attached, inline-body, citable): `result_type` = the natural type (`span`→`evidence_span`, `chunk`→`content_chunk`, else same). For reader-target types reuse `get_search_result(db, type, id, viewer_id)` to fill `locator`/`source_version`/`result_ref`; `page`/`note_block`/`conversation`/`message` have no reader target by their `result_ref` rule → chip + popup only (no deep-link), which is correct.
- **No `media` synthetic row** (not citable until read; §4.2).

Hard constraints that gate the insert (all verified): `tool_call_id` NOT NULL FK (C1); `result_type` CHECK enum has no generic bucket → use the concrete type; `source_id` 1–128 (a UUID is 36); `context_ref`/`result_ref` NOT NULL `jsonb_typeof='object'` and pass `retrieval_context_ref_json`/`retrieval_result_ref_json`; `uix_message_retrievals_tool_call_ordinal` → distinct `ordinal`; `citation_ordinal > 0`.

Frontend works unchanged iff the row carries `tool_call_id`, `ordinal`, `citation_ordinal` (chip) + `media_id`, `source_version`, valid `locator` (clickable target) — verified against `buildCitations` (`citations.ts:55-83`) and `readerTargetFromRetrieval` (`readerTarget.ts:44-74`).

### 4.6 `read_resource` **evidence** becomes citable (navigation does not)

Only **evidence** read results are citable — `kind ∈ {quote, section, page_range, full}`. The **`too_large` redirect** and **`inspect_resource`'s `document_map`** persist **no** `message_retrievals` and get **no** `n` (they are navigation, not evidence). `read_resource` persists an idempotent tool-call trace and, **for evidence kinds only**, inserts one `message_retrievals` row (`ordinal=0`, `selected=true`, `result_type` = the scheme's natural type — `page_range`/ordinary `full` → `result_type="media"` document chip; podcast/video `full` → `episode`/`video`; reader-target fields from `get_search_result` where applicable). At the call site, materialize at `citation_n_next`, increment only on success, and surface that `n` in the evidence `tool_output()`. For `too_large`/navigation, persist the tool-call row (trace) but no retrieval and no `n`. The old "no message_retrievals" behavior/docstring is deleted (hard cutover).

### 4.7 `_emit_citation_index` / finalize / blocks

`_emit_citation_index` and `_retrieval_result_blocks_for_message` are driven by the `assistant_message_id` JOIN + `citation_ordinal IS NOT NULL`; synthetic rows appear automatically and serialize with `citation_ordinal`. The citation-index SSE payload also includes each validated `result_ref` so live clients can synthesize retrievals for attached/read citations before final message reconciliation. The `reference_added` side-effect is idempotent for an already-pinned highlight (`insert_reference_if_absent` returns None).

---

## 5. Consolidation / dedup map (the "reuse, centralize" deliverable)

| Duplication today | Action | Evidence |
|---|---|---|
| `_resolve_X` (10) + `_read_X` (8) parallel per-scheme SQL + permission checks | **Delete all**, replace with `load_resource_batch` (one SQL + one permission per scheme). Resolver/read become thin presenters. | `resource_resolver.py:173-589`, `read_resource.py:184-373`; the bug existed in both `_resolve_highlight_batch:363` and `_read_highlight:236`. |
| Permission checks copy-pasted across both layers (`can_read_media` ×4, owner `user_id` ×2, `can_read_conversation` ×2, `can_read_highlight`) | Centralize in the loader (one check per scheme). | per-scheme dup confirmed across both files |
| Prefix/exact/suffix rendering in `_render_branch_anchor_block` (+ the lone `<exact>` in app_search `_render_highlight_block`) | Centralize in `chat_quote.render_quote_block`; rewire branch anchor; reader_selection + highlight `<quote>` consume it. | `context_assembler.py:538-555`; `app_search.py:1282-1295` |
| Media author aggregation SQL | Reuse the one `string_agg(DISTINCT cc.credited_name … role='author')` for media label, highlight/quote `source_label`, span/chunk/fragment titles. | `resource_resolver.py:186-194` |
| Highlight→reader-target locator/source_version derivation | **Reuse `get_search_result`** instead of re-deriving locators in a new place; same builder app_search uses. | `search.py:821,1145-1288`; `app_search.py:700-760` |
| Highlight note lookup | Reuse `linked_note_blocks_for_highlights` (already used by `highlights.py:35,293`). | `notes.py:989` |
| Ordered-fragment load + word count + section label | Reuse `vault._load_fragments` idiom, `epub_read._compute_word_count`, `_fallback_fragment_label`/`_first_line`. | `vault.py:607`, `epub_read.py:45`, `epub_ingest.py:1979` |
| Overloaded `SEARCH_SCOPE_RESOURCE_URI_SCHEMES` (search-scope vs. read-reject) | **Split** the meanings: keep the search tuple, add `READ_REJECTED_RESOURCE_URI_SCHEMES`. | C3 |
| Frontend quote selector | Reuse `buildQuoteSelector(highlight)` (already called at `MediaPaneBody.tsx:4298`); no new selector. | `quoteText.ts:4` |
| Citation ordinal assignment | Reuse `_assign_citation_ordinals` unchanged for synthetic + read + tool sources. | `chat_runs.py:225` |

---

## 6. Resolved decisions

All forks are decided (user, this session). The original O1/O2 framing assumed a single dual-mode `read_resource(media)`; the SME review replaced that with the navigation+evidence stack (§3.5), which reshapes O1 and keeps O2:

- **Media reads → discriminated stack, not a budget switch (supersedes O1).** `inspect_resource` (navigation, document map with per-section pointers) + `read_resource` with an explicit `kind` (`quote`/`section`/`page_range`/`full`/`too_large`). A short doc reads `kind="full"`; an over-budget doc reads `kind="too_large"` and is redirected to `inspect_resource` — never a silent outline. PDFs map via `pdf_page_text_spans` and read via `page_range:` pointers. §3.5.
- **O2 — gate relaxation: DECIDED (retained, now central).** A media-derived read pointer (`fragment`/`page_range`/`span`/`chunk`) is readable when its parent media is referenced; `can_read_media` still enforces authorization. This is what makes `inspect_resource`→`read_resource` work. §3.5.
- **O3 — versioning: KILLED (decided).** No `system-v4`/`v2` bumps. Delete the four version identifiers (`SYSTEM_PROMPT_VERSION`, `PROMPT_PLAN_VERSION`, `ASSEMBLER_VERSION`, `PROMPT_VERSION`) and their persisted columns; keep a content-only `stable_prefix_hash` as the cache key. Dead ceremony for a one-user prototype — the prompt content hash already changes when the text changes. §7.

Other taken defaults: synthetic parent tool-call at `tool_call_index=0` named `attached_resources`; un-read `media`/`library` not citable; `inspect_resource` (navigation) not citable; shared renderer in new `chat_quote.py`; `<reader_selection>` bind-only (C10); `reader_selection` in the idempotency hash (C11).

---

## 7. Prompt update + versioning removal

**Edit** `render_system_prompt_block` (`chat_prompt.py:65-84`) — deltas: (b) "each citable resource and each citable tool result is numbered with an `n` attribute; a `<resources>` highlight carries a `<quote>` with the passage and its context"; (c) describe the **stack** explicitly — "`app_search` finds passages; `inspect_resource("media:…")` returns a document map of sections with read pointers; `read_resource(uri)` returns exact text for a pointer and labels what it returned with `kind` (`quote`/`section`/`page_range`/`full`/`too_large`)"; keep the strict "never invent an [N]" grammar, now spanning citable resources+reads+searches; the existing `<reader_selection>` sentence (`:77`) stays (now backed by a real block). No version label on the prompt.

**Versioning removed (decided — single-user prototype, no legacy).** Delete all four version identifiers: `SYSTEM_PROMPT_VERSION` (`chat_prompt.py:19`), `PROMPT_PLAN_VERSION` (`chat_prompt.py:18`), `ASSEMBLER_VERSION` (`context_assembler.py:49`), `PROMPT_VERSION` (`chat_run_finalize.py:24`). The prompt **content** already drives cache correctness, so:
- **Keep the prompt cache; make it content-only (DECIDED — user).** `stable_prefix_hash` stays (it *is* the OpenAI `prompt_cache_key`, `chat_prompt.py:176`) but is computed from block content hashes alone — drop the `version` field from `build_prompt_plan` (`chat_prompt.py:110-116`) and the `*_version` fields from `_cache_identity` (`context_assembler.py:768`). A prompt-text change re-warms the cache on first call, exactly as a bump would have. The hash is **not** removed — losing prompt caching would be a real cost for no benefit.
- **Drop the dead provenance columns** in the cutover migration: `prompt_version`, `prompt_plan_version`, `assembler_version` on `chat_prompt_assemblies` (+ mirrored `message_llm` columns where present); update `persist_prompt_assembly` and `chat_run_finalize` to stop writing them. Keep `stable_prefix_hash` (content hash; provenance + cache key). This is the one DB migration in the cutover — justified by "no legacy, no backward compatibility."

**Test fallout:** delete `test_openai_reasoning_contracts.py:296` (`prompt_plan_version` assertion); its `stable_prefix_hash` equality invariant (`:297`) stays. `test_chat_prompt.py:17-23` — keep the content asserts (`<resources>`, `read_resource`, `app_search`; add `<reader_selection>`, `inspect_resource`, citable-`n`), drop any version assertion; update the `"pinned"` negative assert (`:23`) if the copy says "pinned document".

---

## 8. Files (exhaustive, verified)

**Backend — new:** `services/resource_loaders.py` (the 10-scheme loader, `LoadedResource`/`LoadedQuote`; **not** media full-read — that moves to the core); `services/chat_quote.py` (shared renderer); **`services/media_document_map.py`** (NEW core: `MediaDocumentMap`/`DocumentMapSection`, `get_media_document_map_for_viewer`, `load_media_document`, `read_page_range` — single owner of per-kind media document SQL; reuses `reader_navigation` for web/epub, owns new pdf/podcast/video SQL); **`services/agent_tools/inspect_resource.py`** (agent adapter: `INSPECT_RESOURCE_TOOL_DEFINITION`, `execute_inspect_resource` → `kind="document_map"`, no per-kind SQL).

**Backend — edit:**
- `services/resource_resolver.py` — delete `_resolve_X` bodies; map `LoadedResource→ResolvedResource`; add `quote`; media summary/fetch_hint (advertise `inspect_resource`+`read_resource`+`app_search`); add `READ_REJECTED_RESOURCE_URI_SCHEMES`; leave `page_range:<media>:<a>-<b>` parsing to `read_resource` only.
- `services/reader_navigation.py` — **UNCHANGED.** It stays the reader-facing adapter (`get_media_navigation_for_viewer` → `MediaNavigationOut`, web/epub only, 409 for the rest). `MediaNavigationOut` is a frontend route DTO and is **not** widened. The new `media_document_map` core *reuses* this function for web/epub section data; `reader_navigation` does not import the core (no cycle).
- `services/agent_tools/read_resource.py` — (S1 done: `_read_X` deleted, loader-backed, highlight → `kind="quote"`). S2: **media + page_range read kinds** via the core — `media:` short → `kind="full"` (`media_document_map.load_media_document`), over budget → `kind="too_large"` redirect; `page_range:<media>:<a>-<b>` → `kind="page_range"` (`media_document_map.read_page_range`, slices `plain_text`); split rejection (library-only, `READ_REJECTED_RESOURCE_URI_SCHEMES`); gate relaxation for media-derived pointers; carry `n` in `tool_output` (S4); update tool description.
- `services/chat_runs.py` (tools) — register `inspect_resource` in `_CHAT_TOOL_SPECS` (`:154`); add dispatch branch + `_persist_inspect_resource_tool_call` (navigation → **not** citable, no retrieval rows). (Plus the citation/reader_selection edits below.)
- `services/context_assembler.py` — `_build_reader_selection_block` (new); rewire `_render_branch_anchor_block` to `chat_quote`; `_render_resource` → `<quote>`/`n`; number citable attached resources in `_build_resources_block` + record on assembly; thread `reader_selection` param; **delete `ASSEMBLER_VERSION`** + drop `*_version` from `_cache_identity` (`:768`).
- `services/chat_runs.py` — synthetic parent tool-call + synthetic retrievals (`get_search_result` reuse); `citation_n_next = k+1`; read_resource citable (tool trace, retrieval materialization, `n` in output); retry-safe read/inspect trace upsert; app-search ordinal reassignment; citation-index result payloads; thread `reader_selection` through `create_chat_run`/`_chat_run_job_payload`/`execute_chat_run`/`_execute_chat_run` → `assemble_chat_context`.
- `schemas/conversation.py` — `ReaderSelectionRequest` (+blank validator); field on `ChatRunCreateRequest`.
- **`services/chat_run_idempotency.py`** — include durable `reader_selection` ids in `compute_payload_hash` (C11; answer-determining).
- `api/routes/chat_runs.py` — pass `reader_selection` (`:29`).
- **`jobs/registry.py`** — `payload.get("reader_selection")` → task (C2).
- **`tasks/chat_run.py`** — validate + pass `reader_selection` (C2).
- `services/chat_prompt.py` — prompt body; **delete `SYSTEM_PROMPT_VERSION`+`PROMPT_PLAN_VERSION`**; content-only `stable_prefix_hash` (drop `version` from `build_prompt_plan`).
- **`services/chat_run_finalize.py`** — delete `PROMPT_VERSION` (`:24`); stop persisting `*_version` columns (`:200-201`).
- **migration (the one DB change)** — drop `prompt_version`/`prompt_plan_version`/`assembler_version` from `chat_prompt_assemblies` + `message_llm` (§7).

**Frontend — edit:** `lib/api/sse/requests.ts` (`ReaderSelectionInput` + field); `lib/conversations/chatRunBody.ts` (thread `readerSelection`); `components/chat/ChatComposer.tsx` (prop+pass+dep); `components/chat/ReaderChatDetail.tsx` (build+pass); `app/(authenticated)/media/[id]/MediaPaneBody.tsx` (`secondaryChat` carries a `ReaderSelectionInput` derived from the **just-created highlight** via `buildQuoteSelector` on both `quoteHighlightToNewChat`/`quoteHighlightToExtantChat` — quote-to-chat is always highlight-first, C9; there is no separate raw-text path). **No change** to `buildCitations`/`MarkdownMessage`/`readerTarget` (verified).

**Reuse, not edited:** `search.get_search_result`, `notes.linked_note_blocks_for_highlights`, `permissions.*`, `vault._load_fragments`, `epub_read._compute_word_count`, `epub_ingest._fallback_fragment_label`, `lib/highlights/quoteText.buildQuoteSelector`.

**Docs:** this file; `docs/chat-quote-context-cutover.md`; update `docs/reader-design-rationale.md` (reader→chat selection contract).

---

## 9. Work breakdown (landable slices)

Each slice is a PR-sized, independently testable unit. Dependencies noted.

- **S1 — Loaders + consolidation + quote enrichment.** New `resource_loaders.py`; `resolve_batch`/`read_resource` consume it; delete `_resolve_X`/`_read_X`; highlight resolves/reads as enriched `<quote>` (via `chat_quote`, which S1 introduces). *No deps.* Behavior change: enriched highlights. (Design spec slice 1.)
- **S2 — Navigation + evidence stack (documents).** Add neutral `media_document_map.py` for agent maps; keep `reader_navigation.get_media_navigation_for_viewer` unchanged and reuse it for web/epub; new `inspect_resource` tool (navigation, `kind="document_map"`, not citable); `read_resource` discriminated `kind` (`quote`/`section`/`page_range`/`full`/`too_large`); `page_range:` pointer parse+read; gate relaxation for media-derived reads (O2); split rejection set (C3); `_resolve_media_batch` summary/fetch_hint. *Depends: S1.* (Can sub-split: S2a media_document_map+inspect_resource; S2b read_resource kinds+page_range+gate.)
- **S3 — `<reader_selection>` turn anchor.** `ReaderSelectionRequest` + field; 6-hop plumbing incl. `jobs/registry.py` + `tasks/chat_run.py` (C2); `_build_reader_selection_block` using `chat_quote`; frontend wiring. *Depends: S1 for `chat_quote` only.*
- **S4 — Citation unification.** Number citable attached resources at assembly; synthetic parent tool-call + retrievals (C1, C6); `citation_n_next=k+1`; read_resource evidence citable; `reader_selection` remains bind-only and unnumbered; `_render_resource` emits `n` only for citable resources. *Depends: S1 (resolved resources), S3 (selection block present but not numbered).*
- **S5 — prompt update + versioning removal.** §7: prompt deltas (citable resources, inspect→read stack, real `<reader_selection>`); delete the four version ids; content-only `stable_prefix_hash`; drop the dead version columns (the one migration). *Depends: S3 + S4 (prompt describes them).* Land last.

Order: S1 → (S2 ∥ S3) → S4 → S5.

---

## 10. Capability contract

Unchanged from design spec §7 (the resource×{resolve, read, citable} table) with these implementation-level refinements (see `chat-quote-context-cutover-s4-design.md`): a highlight is citable **only when `get_search_result` materializes a valid locator-backed row** (active content-index run + a valid anchor). The strict `HighlightRetrievalResultRef` (`schemas/retrieval.py:283`) requires `source_version`+`locator`, so a NULL-field "chip without deep-link" row **cannot validate** — therefore an un-anchored highlight is **not numbered** (no `n`, no synthetic row); its enriched `<quote>` still renders (S1). Ordinals are the running index over *materialized* citations (dense, no holes). `media`/`library` are **not** citable until read (media) / never (library). `page`/`note_block`/`conversation`/`message` citations render chip+popup, no reader scroll (their `result_ref` carries no locator — unchanged behavior). Permission semantics and the never-raise contract are preserved end to end (loader returns `missing=True`, never throws).

---

## 11. Acceptance criteria & test matrix

Extends design spec §10; real DB, assert through public surfaces, no implementation mocks (testing_standards.md).

| Suite | Assertions |
|---|---|
| `test_resource_resolver.py` | highlight → `quote{prefix,exact,suffix}`, `source_label`=title+author, `note` when an `object_links(note_about)` note exists, `summary==exact`; media → `"kind · ~N words · M sections"` summary + read+search `fetch_hint`. (Replaces `test_resolve_highlight_inlines_text`.) |
| `test_read_resource_tool.py` | `read_resource("highlight:…")` → `kind="quote"`, enriched, not bare `exact`; `read_resource("media:…")` short → `kind="full"` body; over budget → `kind="too_large"` redirect (no silent outline); `read_resource("fragment:…")` → `kind="section"`; `read_resource("page_range:<pdf>:a-b")` → `kind="page_range"` sliced from `plain_text`; a media-derived pointer is readable when its **parent media is referenced** but not otherwise (gate, O2); `library:` still `scope_not_readable`. (Replaces `test_read_resource_highlight_returns_exact_text`; updates media-rejection test at `:82-104`.) |
| `test_inspect_resource_tool.py` (new) | `inspect_resource("media:…")` → `kind="document_map"` with ordered sections each carrying a `read_uri`; web_article/epub use heading/nav sections; **podcast/video sections are from the ACTIVE transcript only**; PDF sections are page ranges; inspect results carry **no `n`** (navigation, not citable). |
| `test_chat_prompt.py` | prompt mentions `<reader_selection>`, citable-`n` grammar, and the inspect→read stack; manifest exposes no raw text; `stable_prefix_hash` changes when the prompt text changes. (No version asserts — versioning removed.) |
| `test_reader_selection.py` (new) | request with `reader_selection` → a `<reader_selection source=…>` block with prefix/exact/suffix; absent → no block; blank `exact` rejected at schema. |
| citation tests | attached highlight cited `[1]` → a `message_retrievals` row `citation_ordinal=1` under the synthetic `attached_resources` tool-call + a `citation_index` entry; `read_resource` result gets the next ordinal; ordinals unique & monotonic across attached + read + search in one turn; a synthetic highlight row carries `media_id`+`source_version`+`locator` (chip is clickable). |
| `test_openai_reasoning_contracts.py` | **delete the `prompt_plan_version` assertion (`:296`)** — the field is removed; the `stable_prefix_hash` equality invariant (`:297`) stays. |
| e2e `quote-attach-references.spec.ts`, `pdf-reader.spec.ts` | quoting a highlight then asking sends `reader_selection`; assistant `[N]` renders as a chip (no raw `[1]`); "summarise this article" against a pinned media → grounded summary (chat-readiness helper gates on a runnable model, else skip). |
| Tool-trace assertions (not just final answer) | For "summarise/walk this document": the run's `message_tool_calls` trace shows `inspect_resource` then `read_resource` on a **pointer the map returned** (deterministic recovery), and the over-budget `read_resource("media:…")` returns `kind="too_large"` rather than a silent partial. Verifies the contract behaviourally, per the SME "do traces show intended behaviour" check. |
| Manual prod parity | re-running the poolpah question (conv `cfaa8b5c…`) yields an answer grounded in the surrounding passage / a read of the source with a resolvable citation — not "I don't have enough context." |

---

## 12. Risks & mitigations

1. **Highlight reader-target derivation (highest).** `get_search_result` raises `NotFoundError` when there's no active content-index run or no usable anchor, and the strict `HighlightRetrievalResultRef` requires `source_version`+`locator`, so a NULL-field row **cannot validate**. Mitigation (S4 design note — supersedes the old "persist with NULL fields" idea): **number iff a durable row materializes** — on failure the highlight is **not numbered** (no `n`, no synthetic row); its enriched `<quote>` still renders, and ordinals stay dense (running index over materialized citations). Cover both branches in tests.
2. **Overloaded constant (C3).** Naively editing `SEARCH_SCOPE_RESOURCE_URI_SCHEMES` silently breaks `app_search` scope validation. Mitigation: the separate read-reject set; a test that `app_search(scopes=["media:…"])` still validates.
3. **Ordinal collisions / idempotency.** Synthetic insert + `citation_n_next=k+1` must be retry-safe. Mitigation: `_assign_citation_ordinals` rewrites the dense selected ordinal set on every replay and clears stale unselected ordinals; synthetic/read/inspect tool-call rows are idempotent on `(assistant_message_id, tool_call_index)` and retrieval rows are upserted by `(tool_call_id, ordinal)`.
4. **Document-map ownership.** Widening the frontend `MediaNavigationOut` would couple agent output to route DTOs and force pdf/podcast/video into a 409-oriented reader API. Mitigation: keep `reader_navigation` byte-stable; put agent maps in neutral `media_document_map.py`, with one-way reuse of web/epub reader navigation.
5. **`page_range:` pointer grammar.** It breaks the `<scheme>:<uuid>` assumption (composite id, non-UUID tail). Mitigation: parse it only inside `read_resource` (read-only pointer); do **not** add it to `RESOURCE_URI_SCHEMES`/references; cite via `result_type="media"` document chip (no enum or locator migration).
6. **Prompt asserts (C8/§7).** The `"pinned"` negative assert + literal-substring asserts will trip; update in the S5 PR.

---

## 13. Rollout

Hard cutover (design spec §11): delete the `_resolve_X`/`_read_X` duplication, the no-retrieval `read_resource` path, and the four version identifiers outright — no flag, no dual-write, no shim. **One DB migration**: drop the dead `*_version` provenance columns (§7). Deploy with app/worker drain or ordered rollout so old workers are not inserting into the removed non-null columns while the migration lands. The prompt cache is content-derived, so the prompt-text change re-warms it on first call. Otherwise no schema change — every field read already exists (`highlights.exact/prefix/suffix`, `contributor_credits`, `object_links`/`note_blocks`, `fragments.idx/canonical_text`, `media.plain_text/page_count`); synthetic rows use existing tables/enums (`result_type`, `retrieval_status='attached_context'`, `citation_ordinal`).

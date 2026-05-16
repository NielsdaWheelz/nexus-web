# chat unified components hard cutover

This document owns the target state for source-grounded chat, retrieval-result
rendering, quote-to-chat, evidence objects, and generated research artifacts.

The cutover is hard. There is no legacy chat rendering path, no compatibility
mode, no shadow fallback, and no model-minted citation behavior.

## product thesis

Nexus is a reader-native research workspace. Chat returns durable evidence
objects and generated artifacts, not just prose with decorative links.

Every source-backed answer must be auditable:

- the user can see what was searched
- the user can see what was used
- the user can see what was rejected or ignored when relevant
- every factual claim is mapped to exact evidence or marked unsupported
- every evidence object opens the original source at the exact location
- provenance survives saving, exporting, branching, copying, and transforming

## incumbent bar

Nexus must meet or exceed the combined bar set by these product classes:

- NotebookLM: source-grounded notebooks, source selection, inline citations,
  source guides, generated study artifacts, audio/video overviews.
- Perplexity: dense answer-first citation UX, source lists, follow-up research
  loops, web freshness.
- ChatGPT Projects and Deep Research: project files, connectors, long-running
  cited reports, exportable research outputs.
- Claude Projects and Artifacts: project knowledge, generated components,
  structured visual outputs, source-aware research.
- Readwise Reader and Ghostreader: AI available directly from the active
  reading selection.
- Elicit, Scite, Consensus, Semantic Scholar: claim/evidence workflows,
  extraction tables, citation stance, scholarly metadata, paper graph context.
- LiquidText and MarginNote: excerpts as movable evidence objects with
  bidirectional links to exact source context.
- Glean, Notion AI, and enterprise search systems: permission-aware connectors,
  knowledge graph context, source transparency, indexing status.

Nexus must not copy any single product surface. The target is a unified system
where reader anchors, note objects, retrieval evidence, generated artifacts,
and chat claims share one provenance model.

## non-negotiable rules

- Chat never renders untyped retrieval JSON directly.
- Chat never trusts citation labels generated in assistant prose.
- The backend owns retrieval, evidence selection, claim extraction, claim
  verification, source manifests, and durable citation IDs.
- The frontend owns presentation and interaction only.
- Every rendered citation is backed by a persisted evidence object or a
  persisted web-result object.
- Every persisted evidence object has a stable source reference and a stable
  source-version reference.
- Search result schemas and chat retrieval schemas use the same discriminated
  result model.
- Generated artifacts are structured data with evidence references. They are
  not markdown blobs with pasted links.
- Reader selection context is transient until the user sends it, saves it, or
  creates a highlight.
- Highlight projection remains reader-owned and derived from current geometry.
  Projection state is not persisted.
- Empty, partial, stale, or unreadable retrieval is explicit UI state.
- Unsupported claims are removed from final grounded answers or labeled as
  unsupported. They are never silently cited.
- Source access failures are visible. The system never falls back to a generic
  answer while implying source grounding.

## target behavior

### chat answers

Assistant answers render as a typed message document:

- answer blocks
- claim blocks
- inline citation chips
- retrieval result blocks
- evidence cards
- generated artifact previews
- follow-up prompts
- source manifest
- verification summary

Each factual claim has one of these support states:

- `supported`
- `partially_supported`
- `contradicted`
- `not_enough_evidence`
- `out_of_scope`
- `not_source_grounded`

Supported and partially supported claims include exact evidence references.
Contradicted claims include both the claim evidence and the conflicting
evidence. Out-of-scope and not-enough-evidence claims render as explicit answer
limitations.

The assistant response is allowed to contain uncited writing only for:

- transitions
- summaries of the user's request
- instructions about next steps
- clearly marked uncertainty
- non-factual UI narration

### inline citations

Inline citations are claim-level. The citation appears immediately after the
claim it supports.

Activating a citation opens a hover card or sheet with:

- source title
- object type
- exact quote or transcript segment
- prefix and suffix when available
- page, section, paragraph, timestamp, or bbox location
- source version
- support role
- confidence or verification state
- actions: open in context, save quote, copy citation, ask about this

Opening in context routes to:

- web article fragment and text selection
- EPUB section and text offsets
- PDF page, zoom target, and projected geometry
- transcript segment and timestamp
- audio/video playback position
- note block or page
- message in conversation
- external web source

### retrieval result blocks

When chat searches, retrieval results render inline before or beside the answer
when the results are user-relevant. This includes:

- media cards
- evidence snippet cards
- highlight cards
- fragment cards
- note cards
- page cards
- podcast cards
- episode cards
- video cards
- transcript cards
- contributor cards
- conversation message cards
- external web result cards

Each result card exposes:

- type icon
- title
- source label
- exact snippet or summary
- metadata
- score/selection state when useful
- source status
- open action
- ask action
- save/link action where applicable

Selected evidence used in the final answer is visually distinct from merely
found results.

### source manifest

Every answer that runs retrieval includes a source manifest. The manifest is a
collapsible structured panel with:

- query or query hash according to privacy rules
- source scope
- source filters
- tool calls
- searched result types
- candidate count
- selected count
- included-in-prompt count
- excluded-by-budget count
- excluded-by-scope count
- stale/unreadable count
- web search mode
- index versions
- retrieval latency

The manifest is not a debugging-only surface. It is user-facing trust UI.

### quote-to-chat

Quote-to-chat is available from:

- active reader selection
- highlight row
- note block
- page
- search result
- citation hover card
- transcript segment
- PDF selection geometry
- EPUB fragment
- assistant answer selection
- generated artifact cell or claim

Quote-to-chat opens the local reader assistant when the user is in a reader
context. It opens full chat only when the user explicitly chooses full chat or
starts outside a reader context.

Quote-to-chat attaches a typed context item. It does not create a persistent
highlight unless the user explicitly saves a highlight.

### source filters

Before sending, the user can scope chat to:

- all visible sources
- a media item
- a library
- selected sources
- selected notes/pages
- selected tags
- selected contributors
- date ranges
- media kinds
- current reader location
- current note/page
- explicit exclusions

The composer must show active scope and attached context as removable chips.
The model must receive the same scope reflected in the UI.

### generated artifacts

The system supports these artifact types:

- briefing document
- study guide
- FAQ
- timeline
- comparison table
- extraction table
- claim table
- contradiction report
- source map
- concept map
- outline
- flashcards
- quiz
- audio overview script
- audio overview
- video or slide overview manifest
- bibliography
- citation audit

Every generated artifact is structured. Every factual cell, bullet, node,
timeline event, quiz answer, and audio/video segment carries evidence refs.

Artifact provenance survives:

- saving to notes
- copying
- exporting to markdown, HTML, PDF, CSV, or JSON
- export ledgers visible from the artifact viewer
- branching a chat
- asking follow-up questions about the artifact

### audio and video

Audio/video media are indexed as timestamped documents:

- immutable transcript segment IDs
- start and end timestamps
- speaker labels when available
- confidence when available
- paragraph/grouping metadata
- source media ID
- transcript version

Audio/video citations open at the exact playback timestamp and highlight the
transcript segment.

Generated audio/video overviews require a source manifest and a transcript.
The generated overview transcript has evidence refs per segment. If the
overview includes uncited synthesis, it is labeled as synthesis.

### notes and highlights

Notes, pages, highlights, fragments, and evidence snippets are first-class
objects in search and chat.

Highlights are searchable directly. Fragment/evidence search is distinct from
highlight search:

- a fragment is source text
- a highlight is a user-created annotation over source text
- a note block is user-authored text
- a page is a user-authored container
- a content chunk is an indexed retrieval unit
- an evidence span is an exact locatable source span

Note cards show linked highlight excerpts when they exist. Highlight cards show
linked notes and linked conversations.

### scholarly evidence

When bibliographic metadata exists, evidence cards include:

- authors
- year
- title
- venue/publisher
- DOI/ISBN/URL where available
- citation style exports
- source quality flags
- retraction/correction flags when known
- citation graph context when available

Scholarly claim evidence can include stance:

- supports
- contradicts
- mentions
- background
- method
- limitation

Stance is always attached to exact evidence, not only to the whole source.

## information architecture

### core objects

The target system has these durable object concepts:

- `source`: imported or connected source material
- `media`: readable/listenable/watchable source object
- `source_version`: immutable parse/index source version
- `source_element`: structured parsed element
- `fragment`: readable text unit
- `content_chunk`: retrieval unit
- `evidence_span`: exact source span with locator
- `highlight`: user annotation anchored to source
- `note_page`: user-authored page
- `note_block`: user-authored block
- `message_context_item`: context attached to a user message
- `message_retrieval`: retrieved result attached to an assistant message
- `message_claim`: atomic assistant claim
- `message_claim_evidence`: claim-to-evidence mapping
- `artifact`: generated structured output
- `artifact_part`: cited part of a generated artifact
- `source_manifest`: retrieval/search manifest for an answer or artifact
- `conversation_memory_item`: durable memory with provenance

Existing names can remain only where they match this model. Old ambiguous
shapes must be migrated or removed during cutover.

### source elements

Ingestion emits normalized elements:

- heading
- paragraph
- list
- table
- figure
- caption
- footnote
- quote
- code
- formula
- transcript_segment
- slide
- image_region
- page_image
- metadata

Each element has:

- stable ID
- source version ID
- media ID when applicable
- text content when applicable
- display content when applicable
- element type
- order
- parent/child relations
- page/section/timestamp geometry when applicable
- parser confidence
- checksum

Chunks are derived from elements. Chunks do not replace elements.

### retrieval result union

`SearchResultOut`, `MessageRetrievalOut.result_ref`, SSE tool results, and
frontend retrieval cards use one discriminated union:

- `media`
- `podcast`
- `episode`
- `video`
- `content_chunk`
- `evidence_span`
- `fragment`
- `highlight`
- `page`
- `note_block`
- `message`
- `conversation`
- `contributor`
- `web_result`
- `artifact`
- `artifact_part`

Each variant owns its required fields. Optional loose JSON is not allowed for
frontend-rendered data.

### locator union

Every locatable evidence object has one canonical locator:

- `web_text_offsets`
- `epub_fragment_offsets`
- `pdf_page_geometry`
- `transcript_time_range`
- `audio_time_range`
- `video_time_range`
- `note_block_offsets`
- `message_offsets`
- `external_url`
- `artifact_part_ref`

Each locator includes enough data for both:

- a stable deep link
- an in-reader visual projection

## architecture

### layers

Backend services own:

- ingestion normalization
- source versioning
- indexing
- retrieval planning
- search execution
- reranking
- evidence selection
- prompt assembly
- claim extraction
- claim verification
- source manifests
- generated artifact structure
- memory updates

Next.js BFF routes own:

- auth/session transport
- proxying to FastAPI
- response streaming bridge where already established

Frontend components own:

- rendering typed message documents
- citation interactions
- result cards
- source panels
- reader pulses
- composer scope controls
- artifact viewers

Frontend components do not infer support status, invent citations, or repair
backend evidence shapes.

### retrieval pipeline

The target pipeline is:

1. classify request
2. determine source scope
3. plan retrieval
4. execute hybrid retrieval
5. expand through graph/context when useful
6. rerank candidates
7. resolve locators
8. select evidence
9. assemble prompt from selected evidence
10. generate structured answer draft
11. extract claims
12. verify claims against evidence
13. remove or mark unsupported claims
14. persist answer, claims, evidence, manifest, tool calls
15. stream typed UI events
16. refresh durable memory only from verified data

Simple lookup requests use a short path. Complex synthesis requests use the
full path.

### retrieval modes

Retrieval modes:

- `lookup`: exact object/title/quote lookup
- `evidence`: find relevant source spans
- `synthesis`: compare multiple sources
- `audit`: verify claims/citations
- `artifact`: build structured output
- `reader`: current reader location and selection
- `memory`: conversation/user memory lookup
- `web`: public web retrieval
- `connector`: external connected source retrieval

The planner chooses a mode explicitly and persists the choice.

### hybrid retrieval

Hybrid retrieval is the default:

- keyword/BM25 for exact terms, titles, names, dates, URLs, and quotes
- dense embeddings for semantic recall
- metadata filters for scope, media kind, author, source type, date, tags
- recency and source-version constraints
- permission filtering before ranking
- result fusion
- reranking

Dense-only search is not an accepted default.

### reranking

Reranking is required for generated answers that cite sources.

Candidate retrieval can be broad. Prompt inclusion must be narrow and ranked.

The reranker input includes:

- user query
- rewritten query when applicable
- candidate snippet
- source title
- source type
- metadata
- surrounding context
- exact quote candidates

Reranker output includes:

- score
- reason code
- selected/not selected
- claim relevance where available

### late interaction and visual retrieval

Late-interaction retrieval is the target high-precision path for:

- exact passage lookup
- scanned PDFs
- layout-heavy PDFs
- slides
- figures/tables
- screenshots
- diagrams
- visually meaningful pages

Visual retrieval supplements text retrieval. It does not replace source text or
locators.

### graph retrieval

Graph retrieval stores grounded relationships:

- entity to source
- source to source
- claim to evidence
- note to highlight
- highlight to conversation
- contributor to work
- concept to fragment
- contradiction relationships

Every graph edge has provenance. Graph edges without source provenance are not
eligible for grounded answers.

Graph traversal expands candidate context after seed retrieval. It is not the
first-stage retrieval default.

### claim verification

Claim verification is mandatory for source-grounded answers.

The verifier receives:

- answer draft
- extracted claims
- selected evidence
- source manifest
- scope constraints

The verifier emits:

- claim support status
- evidence refs
- contradiction refs
- unsupported reason
- answer offset range
- confidence

The final answer is constructed from verified claims. The verifier output is
persisted and rendered.

### structured answers

Assistant messages store structured content. Markdown is a presentation format,
not the source of truth.

The structured message document supports:

- text blocks
- claim blocks
- citation refs
- retrieval result blocks
- artifact embeds
- callouts
- tables
- timelines
- lists
- code blocks
- follow-up actions

The client renders this structure directly. Markdown parsing is retained only
inside text/code blocks where the backend has explicitly marked content as
markdown.

## frontend final state

### message rendering

`MessageRow` routes by message role and renders one unified message document.

The assistant path contains:

- `AssistantMessage`
- `AssistantAnswer`
- `AssistantRetrievalResults`
- `AssistantSourceManifest`
- `AssistantEvidenceDisclosure`
- `AssistantArtifactEmbed`
- `CitationChip`
- `EvidenceCard`

No component renders legacy source chips from ad hoc arrays.

### composer

The composer includes:

- model selector
- reasoning selector
- source mode selector
- web search mode
- source scope chips
- attached context rail
- selected-source count
- evidence/quote-first mode toggle
- artifact intent selector when applicable
- send button

The composer payload exactly matches visible scope and context.

### source panel

The conversation source panel includes:

- active scope
- pending contexts
- persisted message contexts
- retrieval manifests
- selected sources
- source filters
- memory sources
- citation audit status
- fork graph where applicable

The source panel is not a debug panel. It is the primary trust surface.

### cards and pills

All object cards share a visual grammar:

- icon or type marker
- title
- source label
- snippet
- location
- metadata
- status
- actions

Pills are for compact selected context. Cards are for inspectable evidence.
Nested cards are not allowed.

### reader integration

Reader citation activation uses a single typed event:

- media ID
- locator
- snippet
- source version
- highlight behavior
- focus behavior

Reader components resolve visual projection from the locator and current
rendered geometry.

## backend final state

### APIs

Required API surfaces:

- `GET /search`
- `POST /search/resolve`
- `GET /search/results/{id}` where needed for durable result refs
- `POST /chat-runs`
- `GET /chat-runs/{id}`
- `GET /chat-runs/{id}/events`
- `GET /conversations/{id}/messages`
- `GET /conversations/{id}/source-manifests`
- `POST /message-context-items`
- `GET /media/{id}/reader-state`
- `PUT /media/{id}/reader-state`
- `GET /media/{id}/evidence/{evidence_span_id}`
- `POST /artifacts`
- `GET /artifacts/{id}`
- `GET /artifacts/{id}/exports`
- `POST /artifacts/{id}/ask`

All APIs that return frontend-rendered evidence use strict schemas.

### database

The cutover requires schema support for:

- source versions
- source elements
- direct highlight search
- direct fragment search
- artifact records
- artifact parts
- source manifests
- retrieval candidate ledgers
- rerank ledgers
- claim verification ledgers
- citation audit ledgers
- artifact export ledgers

Existing tables can be reused only when they carry the full contract.

### streaming

SSE event types:

- `meta`
- `tool_call`
- `retrieval_result`
- `source_manifest_delta`
- `artifact_delta`
- `claim`
- `claim_evidence`
- `delta`
- `done`

Citations are not a standalone event. They stream as `claim` and
`claim_evidence` events bound to verified claims.

Tool events use one status enum:

- `pending`
- `running`
- `complete`
- `error`
- `cancelled`

`started` is removed.

### prompt assembly

Prompt assembly includes:

- system rules
- source scope
- attached contexts
- selected retrieval evidence
- source manifest summary
- relevant memory
- recent conversation path
- artifact instructions
- output schema

Prompt assembly excludes:

- unreadable sources
- stale source versions
- unsupported memory
- unverified graph facts
- hidden frontend-only state

## file ownership

### backend

Expected backend ownership areas:

- `python/nexus/schemas/search.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/schemas/artifacts.py`
- `python/nexus/services/search.py`
- `python/nexus/services/object_search.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/agent_tools/web_search.py`
- `python/nexus/services/retrieval_planner.py`
- `python/nexus/services/context_lookup.py`
- `python/nexus/services/context_rendering.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/locator_resolver.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/notes.py`
- `python/nexus/api/routes/search.py`
- `python/nexus/api/routes/chat_runs.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/message_context_items.py`
- `python/nexus/api/routes/media.py`
- `migrations/alembic/versions/*`

### frontend

Expected frontend ownership areas:

- `apps/web/src/lib/api/sse.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/chat/citations.ts`
- `apps/web/src/lib/search/resultRowAdapter.ts`
- `apps/web/src/lib/messageContextItems.ts`
- `apps/web/src/lib/objectRefs.ts`
- `apps/web/src/components/chat/*`
- `apps/web/src/components/search/SearchResultRow.tsx`
- `apps/web/src/components/ConversationContextPane.tsx`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/ui/ReaderCitation.tsx`
- `apps/web/src/components/ui/HighlightSnippet.tsx`
- `apps/web/src/app/(authenticated)/conversations/*`
- `apps/web/src/app/(authenticated)/search/*`
- `apps/web/src/app/(authenticated)/media/[id]/*`
- `apps/web/src/components/reader/*`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/HtmlRenderer.tsx`

### tests

Expected test ownership areas:

- `python/tests/test_search.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_context_lookup.py`
- `python/tests/test_context_assembler.py`
- `python/tests/test_chat_runs.py`
- `python/tests/real_media/*`
- `apps/web/src/components/chat/*.test.tsx`
- `apps/web/src/__tests__/components/*Chat*.test.tsx`
- `apps/web/src/lib/search/resultRowAdapter.test.ts`
- `apps/web/src/lib/api/sse.test.ts`
- `e2e/tests/search.spec.ts`
- `e2e/tests/real-media/search-evidence.spec.ts`
- `e2e/tests/real-media/context-chat-citations.spec.ts`
- `e2e/tests/real-media/quote-to-chat.spec.ts`
- new E2E tests for page/note/highlight/artifact provenance

## cutover sequence

### phase 1: schemas and contracts

- define unified retrieval result union
- define unified locator union
- define structured assistant message document
- define source manifest schema
- define artifact schema
- define strict SSE event schemas
- remove loose frontend `result_ref` assumptions

Exit criteria:

- backend and frontend share equivalent discriminants
- schema tests reject unknown result variants
- old ad hoc citation chips cannot compile

### phase 2: ingestion and index readiness

- normalize source elements
- add source versions where missing
- add direct highlight search
- add direct fragment search
- add page/note result parity for chat app search
- preserve PDF bbox/page image metadata
- preserve transcript timestamps and speaker labels

Exit criteria:

- PDF, EPUB, web, video, podcast, page, note, highlight, fragment fixtures all
  produce locatable evidence
- search can return every target result type
- stale source versions are rejected in context lookup

### phase 3: retrieval and manifests

- implement hybrid retrieval everywhere
- add rerank ledgers
- add retrieval candidate ledgers
- add source manifests
- expose retrieval results over SSE
- make source manifests visible in chat

Exit criteria:

- every chat search produces a manifest
- every selected result explains why it was selected
- every rejected result has a reason code when surfaced

### phase 4: structured answer and verification

- generate structured answer drafts
- extract claims
- verify claims
- persist claims and claim evidence
- construct final answer from verified claims
- render unsupported/contradicted states

Exit criteria:

- no assistant claim citation exists without persisted claim evidence
- unsupported factual claims are absent or marked unsupported
- citation audit tests pass for all media kinds

### phase 5: frontend hard switch

- replace assistant markdown-only rendering with structured message rendering
- render retrieval result cards
- render source manifests
- render evidence cards
- render artifact embeds
- remove legacy source chip behavior
- remove fallback parsing of model citation syntax

Exit criteria:

- no production path renders `<<cite:n>>` placeholders as source of truth
- no production path renders untyped retrieval JSON
- UI matrix tests pass for all result variants

### phase 6: generated artifacts

- implement artifact persistence
- implement artifact evidence refs
- implement artifact viewers
- implement artifact export
- implement artifact export ledger viewer
- implement artifact ask/follow-up

Exit criteria:

- every factual artifact part has evidence refs
- exported artifacts include citation manifests
- export ledgers show format, artifact version, content hash, manifest hash,
  viewer, and export time
- artifact follow-up preserves provenance

### phase 7: real-media acceptance

- expand real-media fixtures for every result type
- add PDF/EPUB/transcript assistant citation round trips
- add note/page/highlight search-to-chat round trips
- add artifact provenance round trips
- add audio/video timestamp citation round trips

Exit criteria:

- `make test-real-media` proves search -> chat -> answer -> citation -> reader
  for web, PDF, EPUB, video, podcast, notes, pages, highlights, fragments
- `make verify-full` passes

## acceptance criteria

### search

- Search returns typed results for every supported object type.
- Search returns direct highlight results.
- Search returns direct fragment results.
- Search returns page results in UI and chat.
- Search result cards can attach context to chat.
- Evidence results preserve evidence span IDs.
- Every locatable result opens the source at exact context.

### chat retrieval

- General chat can search media, pages, notes, highlights, fragments,
  messages, contributors, podcasts, episodes, videos, and web results.
- Scoped media/library chat searches scoped evidence by default.
- Retrieval manifests render for searched answers.
- Tool results stream as typed retrieval-result events.
- Selected retrievals render as evidence cards.

### citations

- Every factual supported claim has at least one citation.
- Every citation opens an evidence card.
- Every evidence card opens exact source context.
- Citation hover cards show exact quote and location.
- Citation exports preserve stable source refs.
- Citation audits detect missing, stale, and unsupported citations.

### quote-to-chat

- Reader selection opens reader assistant on desktop.
- Reader selection opens mobile sheet on mobile.
- Highlight row ask attaches highlight context.
- Search result ask attaches result context.
- Citation ask attaches cited evidence context.
- Artifact cell ask attaches artifact part context.
- No ask flow creates highlights implicitly.

### generated artifacts

- Tables preserve cell-level evidence.
- Timelines preserve event-level evidence.
- Briefs preserve paragraph or claim-level evidence.
- Audio/video overview scripts preserve segment-level evidence.
- Exports include citation manifests.
- Artifact viewers show durable export ledgers.
- Saved artifacts remain inspectable after source updates.

### trust and failure states

- No-source answers state that no source was found.
- Stale-source evidence is rejected or labeled stale.
- OCR/parse low-confidence evidence is labeled.
- Contradictions are surfaced.
- Source access failures are visible.
- Retrieval empty states are specific to scope and filters.

### performance

- Simple lookup feels interactive.
- Search result streaming begins before final answer generation when retrieval
  has results.
- Long-running research surfaces progress and partial manifests.
- Reranking and verification are budgeted and observable.

### accessibility

- Citation chips are keyboard accessible.
- Evidence cards have accessible names.
- Source cards expose type, title, snippet, and action labels.
- Reader activation does not trap focus.
- Mobile sheets preserve focus and scroll state.

## non-goals

- No generic autonomous web agent for arbitrary browser actions.
- No silent cross-user source sharing.
- No unsupported citation style generator without source metadata.
- No image generation for source artifacts before text/evidence provenance is
  complete.
- No graph-only answer mode.
- No model-generated bibliography entries without verified metadata.
- No attempt to preserve old chat message rendering behavior.
- No compatibility with old ad hoc citation placeholders after cutover.

## key decisions

- Evidence objects are the core product primitive.
- Structured assistant messages replace markdown as source of truth.
- Search and chat retrieval share one result union.
- Claim verification is part of answer generation, not an optional audit.
- Source manifests are user-facing.
- Generated artifacts are structured and cited.
- Reader locators are canonical and persisted; reader projection is derived.
- Hybrid retrieval is the default retrieval baseline.
- Graph retrieval expands context; it does not replace search.
- Visual retrieval is required for layout-heavy sources.
- Durable memory must carry provenance and deletion semantics.

## open design questions

- Which late-interaction model is practical for local/prod indexing first?
- Which parser becomes the canonical PDF/layout parser?
- Which citation style exports are first-class at launch?
- Which generated artifacts ship in the first artifact cutover?
- Which connector sources are in scope after local/imported media parity?
- Which source quality/retraction providers are acceptable for scholarly flags?
- Whether audio/video overview generation belongs in the worker queue or a
  dedicated long-running artifact pipeline.

These questions do not block the hard cutover contract. They affect sequencing.

## references

- NotebookLM source-grounded model, source types, and artifacts:
  `https://support.google.com/notebooklm/answer/16215270`
- NotebookLM Audio Overviews:
  `https://blog.google/technology/ai/notebooklm-audio-overviews/`
- Claude citations API:
  `https://docs.claude.com/en/docs/build-with-claude/citations`
- OpenAI connectors and deep research:
  `https://help.openai.com/en/articles/11487775-connectors-in-chatgpt.webp`
  and `https://help.openai.com/articles/10500283`
- Readwise Ghostreader:
  `https://docs.readwise.io/reader/guides/ghostreader/overview`
- Microsoft GraphRAG:
  `https://microsoft.github.io/graphrag/query/overview/`
- Self-RAG:
  `https://arxiv.org/abs/2310.11511`
- Agentic RAG survey:
  `https://arxiv.org/abs/2501.09136`
- RAGAS metrics:
  `https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/`

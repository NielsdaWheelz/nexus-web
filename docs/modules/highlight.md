# Highlight Module

## Scope

The highlight module owns durable user selections for readable media. It owns
highlight rows, typed anchors, the stored `exact`/`prefix`/`suffix` quote
triple, highlight CRUD, highlight-note attachment commands, and the public
read contracts other modules consume.

Backend owners are `python/nexus/services/highlights.py`,
`python/nexus/services/pdf_highlights.py`,
`python/nexus/services/pdf_highlight_geometry.py`,
`python/nexus/api/routes/highlights.py`, and the highlight schemas under
`python/nexus/schemas/highlights.py`.

Frontend owners are `apps/web/src/lib/highlights/*` and
`apps/web/src/components/highlights/*`. Reader-specific highlight presentation
lives in the reader module, and chat run assembly lives in the chat module.

The highlight module does not own Resource Inspector/Companion chrome, Document
Map aggregation, reader projection state, chat citations, source-authored
apparatus, or the resource graph table.

## Durable Model And Resource Identity

Every highlight is a `highlight:<id>` resource. The `highlights` row carries
the viewer/user, media, color, typed anchor kind, and canonical quote fields.
Typed anchor rows hold the locator payload:

- `highlight_fragment_anchors` stores reflowable fragment codepoint ranges.
- `highlight_pdf_anchors` stores PDF page/text-layer match state.
- `highlight_pdf_quads` stores canonical page-space geometry for PDF
  highlights.

`exact`, `prefix`, and `suffix` are persisted with the highlight because they
are the durable quote contract. Fragment highlights derive them from canonical
fragment text using codepoint offsets. PDF highlights derive them from the text
layer when a unique text match exists. A PDF highlight may have an empty
`exact`; that is a first-class geometry-only highlight state, not a failed row.

Visibility follows the same media/library visibility predicate used by the
media owner. Authors can mutate their own highlights; readable shared
highlights can be listed and opened according to the canonical permissions
path.

A fresh reader selection becomes a durable Highlight only as a side effect of
a confirmed **Link** (see [Universal Link authoring](../cutovers/universal-link-authoring-hard-cutover.md)):
the Link service creates the Highlight, canonicalizes the endpoints, and
creates or reuses the Link in one transaction, so cancelling the Link dialog
writes nothing. An existing Highlight is reused as a Link source or target and
is never deleted by Link creation or Undo — Undo removes only the Link row.
Highlights remain first-class resources outside of Link: a highlight is also
the durable identity `reader_selection`/quote-to-chat binds to, independent of
whether it is ever linked.

## Anchor Contracts

Reflowable anchors use canonical codepoint offsets, not DOM ranges. The browser
maps selections to offsets with the highlight cursor helpers, and the backend
validates offsets against the stored fragment text before writing.

PDF anchors use page-space coordinates and text-layer match metadata. Geometry
is canonical; rendered viewport coordinates are derived presentation state.
PDF writes serialize through the PDF highlight geometry owner so duplicate and
match-state decisions are made against current anchor rows.

Reader projection is not persisted. The reader may derive visible row anchors
from rendered DOM segments or PDF viewport transforms, but that state belongs to
the reader surface and is recalculated from durable highlight anchors.

`highlight_fragment_anchors.fragment_id` is a disposable locator cache, not a
foreign key: the FK constraint is dropped, and media-wide reads use a LEFT
JOIN so a missing cache row is detected and repaired by re-resolving the
stored quote rather than cascading the highlight away. `highlight_pdf_anchors`
and `highlight_pdf_quads` are non-cascading by the same rule. The destructive
`trg_highlight_fragment_anchor_delete_core` trigger and
`delete_fragment_highlight_after_anchor_delete()` are removed; nothing in the
database deletes a Highlight as a side effect of deleting something else.

Passage identity for a non-Highlight Link endpoint (a search-derived passage
candidate, or an existing apparatus/index row) is a separate table,
`passage_anchors` — user-owned, keyed by owner (`media`/`note_block`) plus an
immutable `anchor_key` hash of the normalized quote, with a replaceable
`locator_hint`. It shares the highlight module's quote-matching primitives
(`services/text_quote.py`, `services/pdf_quote_match.py`, and the shared
`services/locator_resolver.py` that both Highlights and passage anchors call)
but is not a highlight row and never becomes a visible Highlight on its own —
a search-derived PDF passage in particular is a passage anchor, never a
geometry-only Highlight.

## Read Paths

There are two read scopes:

- Per-fragment and per-page highlight reads feed inline highlight rendering and
  visible-row projection for the active reader location.
- Media-wide reads feed cross-fragment experiences such as Evidence highlight
  facts, linked note/chat summaries, markers, and quote-to-chat lookup.

The browser reader consumes media-wide highlight data through
`GET /media/{id}/document-map`, whose aggregate response is owned by the reader
Document Map service. That endpoint may include highlight payloads, but it is a
read model only. It must not become the mutation API.

The standalone highlight list routes remain highlight-owned because other
callers may need highlight reads without the full Document Map aggregate.

## Mutations And Notes

Highlight creation, update, delete, color changes, and note attachment flow
through the highlight routes and service owners. Fragment offset updates
recompute the quote triple. PDF geometry updates go through the PDF highlight
owner and require the corresponding quote/match-state payload.

Attached notes are note blocks linked to highlights through `resource_edges`
with `origin='highlight_note'`. There is no separate highlight-note table.
Ordinary highlight deletion is explicit and child-first: graph/view-state
attachments (including any `link_note` motif and Link/stance edges naming the
highlight), then PDF quads, then the PDF/fragment anchor, then the highlight
row itself — never a DB cascade. True media/note owner deletion runs the same
explicit cleanup before removing highlight children/root, and always
preserves detached note prose rather than deleting it.

Reindex and source refresh (web, EPUB, transcript-current, podcast
transcription) never delete Highlights or their anchors; only the refreshed
web/EPUB/transcript-current lifecycles used to call explicit highlight-root
deletion on refresh, and that call is removed. An unresolved Highlight after
content changes stays visible in Evidence/Connections rather than
disappearing or silently repointing to the wrong location.

The quick-note composer is a frontend presentation owner. It may create a
highlight and then attach a note in one gesture, but persistence still flows
through the canonical highlight and note paths.

## Reader Presentation

Inline highlight rendering remains separate from the Document Map. Inline
rendering follows the current reader location and active fragment/page data.

Evidence is the Media Resource Inspector's cross-document reader surface for
highlights. It remains a Document Map body: it renders the stored `exact` quote
when available, shows an explicit placeholder for geometry-only PDF highlights,
exposes note/color/delete actions according to caller capability, and shows
linked note/chat summaries from the aggregate read model. Highlight does not
publish the Inspector group or its Companion action.

The wide reader may also project highlight-linked marginalia through
`MarginRail`. Neither Evidence nor the margin owns highlight persistence or
mutation behavior.

The canonical passage/document scope and typed highlight association contract
is
[`reader-evidence-scope-associations-hard-cutover.md`](../cutovers/reader-evidence-scope-associations-hard-cutover.md).

## Quote-To-Chat

Reader quote-to-chat is Highlight-first: a durable Highlight must exist before
launch, and chat launch performs no conversation mutation. The reader offers
**Ask in new chat** and **Ask in existing chat…** on a Highlight; both navigate
to the chat destination and pass a typed launch intent, never a generic subject
send.

On send the server row-locks the Highlight, derives the canonical `exact`,
`prefix`, `suffix`, source label, and `locator` from the stored anchor/quote
fields, and captures them once as an immutable `ReaderSelectionSnapshot` on the
user message (`messages.reader_selection_snapshot`). The request carries only
`reader_selection: { key: {media_id, highlight_id}, revision }`; client-supplied
quote text is rejected. A later edit, move, or deletion of the Highlight cannot
change a sent quote — every read derives from the snapshot, not the live row.
Under the same row lock the server derives the `highlight:<id>` subject and
`media:<id>` companion as `ResourceEdge(kind="context")` rows.

The snapshot is not a durable conversation context ref that gets cited and never
receives a citation ordinal. Citation chips point at the attached
`highlight:<id>` resource or later `read_resource` evidence.

Quote actions require nonblank `exact` text. A geometry-only PDF Highlight (blank
`exact`) is explicitly non-sendable as a quote; it can still exist and be shown.

## Graph Connections And Citations

The resource graph owns durable connections. Highlight-linked notes, linked
conversations, user-authored Links/stances, and chat citations all live in
`resource_edges` under their origin-specific contracts. A `highlight:<id>` is
an ordinary Link source or target — same-document Highlight-to-Highlight Links
are admissible, self-link is not — and Link creation, note attachment, and
removal are owned entirely by `services/resource_graph/user_relations.py`, not
by this module. The highlight module may ask graph services for linked
summaries, but it does not write bespoke connection tables.

`message_retrievals` remains chat telemetry. Citable highlight evidence is
resolved through the `highlight:<id>` resource and graph citation path.

## Composition Rules

- Do not duplicate highlight mutation logic in Evidence or chat code.
- Do not persist rendered DOM geometry as highlight truth.
- Do not infer citations from `reader_selection`; cite the durable
  `highlight:<id>` resource or resolved evidence.
- Do not introduce another highlight-note store. Use note blocks plus
  `resource_edges`.
- Do not make Evidence the owner of highlight CRUD. It is an aggregate read and
  presentation surface.
- Do not delete a Highlight or its anchors from reindex/refresh code, and do
  not add a DB cascade between highlight-family rows; deletion is always
  explicit and child-first.

## Contract Tests

Keep these tests aligned with this module contract:

- `python/tests/test_highlights.py`
- `python/tests/test_highlight_schemas.py`
- `python/tests/test_pdf_highlights_integration.py`
- `python/tests/test_pdf_highlight_geometry.py`
- `python/tests/test_reader_selection.py`
- `python/tests/test_resource_graph_resolve.py`
- `python/tests/test_read_resource_tool.py`
- `python/tests/test_passage_anchors.py`
- `python/tests/test_user_relations.py`
- `apps/web/src/lib/highlights/*.test.ts`
- `apps/web/src/lib/conversations/chatRunBody.test.ts`
- `apps/web/src/components/highlights/*.test.tsx`
- `apps/web/src/components/reader/document-map/EvidencePaneSurface.test.tsx`
- `apps/web/src/components/reader/MarginRail.test.tsx`
- `apps/web/src/__tests__/components/SelectionPopover.test.tsx`
- `apps/web/src/components/chat/QuotedPassageCard.test.tsx`
- `e2e/tests/quote-attach-references.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/universal-linking.spec.ts`

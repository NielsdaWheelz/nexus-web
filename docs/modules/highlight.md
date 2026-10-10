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

Frontend owners are the hosted media pane's `annotations.ts` (reads and
writes), `useAnnotationVerbs.ts` and `SelectionDock.tsx` (the verbs), and
`apps/web/src/lib/highlights/actionIntent.ts` (app-global highlight intents).
Paint and hit-testing live in the reader module, and chat run assembly lives in
the chat module.

The highlight module does not own Resource Inspector chrome, Document
Map aggregation, reader projection state, chat citations, source-authored
apparatus, or the resource graph table.

## Durable Model And Resource Identity

Every highlight is a `highlight:<id>` resource. The `highlights` row carries
the viewer/user, media, color, typed anchor kind, and canonical quote fields.
Typed anchor rows hold the locator payload:

- `highlight_fragment_anchors` stores reflowable fragment codepoint ranges.
- `highlight_pdf_anchors` stores the PDF page, sort position and rect count.
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
a confirmed **Link** (see [connections](connections.md)):
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

`domTextCursor.ts` records the source spans for each canonical codepoint;
`domTextRanges.ts` owns both directions of the mapping. selection, hosted and
public painting, find marks, and margin geometry use that provenance. unicode
normalization can compose or expand source characters: selection takes the
smallest contiguous canonical interval covering the touched source spans.
highlights sharing a source character share its paint, with all ids retained
and the newest highlight on top.

PDF anchors use page-space coordinates. Geometry
is canonical; rendered viewport coordinates are derived presentation state.
PDF writes take a transaction advisory lock on the viewer's exact selection, so
duplicate decisions are made against current anchor rows.

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
(`services/text_quote.py` and the shared
`services/locator_resolver.py` that both Highlights and passage anchors call)
but is not a highlight row and never becomes a visible Highlight on its own —
a search-derived PDF passage in particular is a passage anchor, never a
geometry-only Highlight.

## Read Paths

The browser reader reads every highlight of a media the viewer can see (theirs
and library-mates') once, through `GET /media/{id}/document-map`, whose
aggregate response is owned by the reader Document Map service; each highlight
item carries `is_owner`. That endpoint is a read model only. It must not become
the mutation API. `GET /highlights/{id}` reads one highlight; there are no
per-fragment or per-page list routes.

The pane's `AnnotationStore` projects the map into marks, topmost (newest)
first. A write paints at once from its acknowledgement through a pending ledger
until a map read issued after it settles; a failed read keeps the last map
painted. Before creating, the store looks for the viewer's own highlight of the
exact extent and reuses it (one highlight per user per span); a library-mate's
highlight there never blocks the viewer's own.

Highlight responses are generated wire types (`TypedHighlightOut`); creation is
one typed route, `POST /media/{id}/highlights` with a text or pdf anchor.

## Mutations And Notes

Highlight creation, update, delete, color changes, and note attachment flow
through the highlight routes and service owners. Fragment offset updates
recompute the quote triple. PDF geometry updates go through the PDF highlight
owner and require the selection's `exact` quote.

Attached notes are note blocks linked to highlights through `resource_edges`
with `origin='highlight_note'`. There is no separate highlight-note table.
`PUT /highlights/{highlight_id}/note` accepts exactly `note_block_id`,
`client_mutation_id`, and `body_pm_json`; it has no camel-case or generic `id`
aliases. The frontend converts its camel-case internal values only at this
outgoing transport boundary.
Ordinary highlight deletion is explicit and child-first: graph/view-state
attachments (including any `link_note` motif and user links naming the
highlight), then PDF quads, then the PDF/fragment anchor, then the highlight
row itself — never a DB cascade. True media/note owner deletion runs the same
explicit cleanup before removing highlight children/root, and always
preserves detached note prose rather than deleting it.

Reindex and source refresh (web, EPUB, transcript-current, podcast
transcription) never delete Highlights or their anchors; only the refreshed
web/EPUB/transcript-current lifecycles used to call explicit highlight-root
deletion on refresh, and that call is removed. An unresolved Highlight after
content changes stays visible in Evidence or Connections rather than
disappearing or silently repointing to the wrong location.

The quick-note composer is a frontend presentation owner. It may create a
highlight and then attach a note in one gesture, but persistence still flows
through the canonical highlight and note paths.

the selection Note action focuses the quick-note textbox. enter flushes the
existing save queue and closes only after the latest body is saved; shift+enter
inserts a newline. composition and reference selection retain their enter
handling. editing during submission cancels dismissal, and save failure keeps
the draft open. inline highlight notes retain multiline enter. desktop and
mobile composers own back dismissal throughout the selection-to-editor handoff.

## Learn

**Learn** is Highlight-first. A reader selection is created or reused through
the existing Highlight owner; after that succeeds, the reader pane posts the
durable `highlight:<id>` ref to `POST /artifacts/dossiers/learn`. Popover state
ends normally. Global feedback owns pending/failure state, and success adopts
the standalone Artifact pane.

The Artifact subsystem, not Highlight, canonicalizes the selected text to one
user-owned Idea and records the Highlight as a generation seed. Learning the
same phrase twice reaches the same Idea, so the resolution row, the seed pair
and the head key carry the replay; re-Learn is the recovery path. Highlight
deletion explicitly removes Idea resolution, seed, and any leftover Learn rows
before the Highlight row. Learn creates no Resource Graph Link and Highlight
still publishes no Inspector.

## Reader Presentation

Marks are css custom highlights over the untouched reader dom (pdf: overlay
rects under the text layer); overlapping marks paint as disjoint segments in the
topmost colour. See
[reader-implementation](reader-implementation.md#paint-css-custom-highlights).
A click resolves the marks under the pointer, topmost first. Focus is an
underline and moves no viewport; bounds editing takes the next selection as the
highlight's new extent.

Evidence is the Media Resource Inspector's cross-document reader
surface for highlights. It remains a Document Map body: it renders the stored `exact` quote
when available, shows an explicit placeholder for geometry-only PDF highlights,
mounts the canonical resource menu, and shows linked note/chat summaries from
the aggregate read model. Highlight does not publish the Inspector group or its
inspector action.

Evidence follows the reading position (the group there stays in view; groups
in the visible band are marked), and the document-map rail shows marker
locations across the document. Evidence owns neither highlight persistence nor
mutation behavior.

A fresh reader selection has no Highlight yet: the pane's `SelectionDock` offers
this pre-resource gesture. Materialized Highlights mount `ResourceActionMenu`,
whose snapshot, catalog, planner, and runtime own the same action list in every
representation. Clicking one mark in reader text or a PDF opens that menu at the
click; where marks overlap, a *Highlights here* chooser lists them topmost
first. Rows in Evidence retain their overflow trigger.
The selection actions use the fixed names
**Highlight**, **Note**, **Link**, **Ask**, **Learn**,
**Ask in existing chat…**, and **Share**. `SelectionDock` owns their order: the
direct icon row is **Highlight**, **Note**, **Link**, **Ask**, and the **More**
overflow menu is **Learn**, **Ask in existing chat…**, **Share**. Capability
decides which actions exist and never which tier they land in. Selection actions
are single-flight (`useAnnotationVerbs`): one creation at a time, released after
success or failure so the selection can retry.

The canonical passage/document scope and typed highlight association contract
is
`docs/cutovers/reader-evidence-scope-associations-hard-cutover.md` at `ebd648197`.

## Quote-To-Chat

Reader quote-to-chat is Highlight-first: a durable Highlight must exist before
launch, and chat launch performs no conversation mutation. Fresh selection
offers **Ask** and **Ask in existing chat…**; an existing Highlight offers
**Ask in new chat** and **Ask in existing chat…**. Both navigate to the chat
destination and pass a typed launch intent, never a generic subject send.

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
`highlight:<id>` resource or later `nexus.resource.read` evidence.

Quote actions require nonblank `exact` text. A geometry-only PDF Highlight (blank
`exact`) is explicitly non-sendable as a quote; it can still exist and be shown.

## Graph Connections And Citations

The resource graph owns durable connections. Highlight-linked notes, linked
conversations, neutral user links, machine links and chat citations all live in
`resource_edges` under their origin-specific contracts. A `highlight:<id>` is
an ordinary Link source or target — same-document Highlight-to-Highlight Links
are admissible, self-link is not — and Link creation, note attachment, and
removal are owned entirely by `services/resource_graph/links.py`, not
by this module. the flush-only pair writer is `services/resource_graph/edges.py`;
selection authoring composes it inside the existing graph command transaction.
the highlight module may ask graph services for linked
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
- Do not make Evidence the owner of highlight CRUD. It is an
  aggregate read and presentation surface.
- Do not key a learning Dossier by Highlight occurrence or add a second Learn
  preview surface; the Highlight is provenance for an Idea Artifact.
- Do not delete a Highlight or its anchors from reindex/refresh code, and do
  not add a DB cascade between highlight-family rows; deletion is always
  explicit and child-first.

## verification

manually validate persisted highlight provenance, authorization, and
reader-to-chat behavior when those boundaries change.

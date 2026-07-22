# Incoming Connections + Reader Linked Items Hard Cutover

Status: IMPLEMENTED foundation; product route and surface superseded 2026-07-20
Author: design synthesis, 2026-06-12
Type: hard cutover - one-user prototype, production-grade contracts, no legacy
lanes, no compatibility shims, no fallback readers, no duplicate graph APIs.

## Current state and supersession

The surviving capability is the internal target-centered connection projection
over `resource_edges`. The standalone `/reader-connections` product route and
separate reader Connections/Citations surfaces described below were deleted;
the reader consumes connections through `GET /media/{media_id}/document-map`
and the single `reader-evidence` surface.

The approved
[`reader-evidence-scope-associations-hard-cutover.md`](reader-evidence-scope-associations-hard-cutover.md)
supersedes the anchored/unanchored response partition, source-category
presentation, and nested-object behavior. Route, BFF, and surface instructions
below are historical cutover context, not current implementation guidance.

## 0. North Star

Every durable "this thing points at that thing" fact in Nexus should be visible
from both ends.

When a passage, chunk, highlight, note block, page, media item, message, Library
Intelligence artifact, Oracle reading, contributor, tag, library, podcast, or any
other `ResourceRef` is cited, linked, referenced, attached, mentioned, or used as
context, the user can ask:

```text
What points here?
What does this point to?
Where is that connection anchored?
Can I open the source object?
Can I jump to the exact target if it still resolves?
```

For reader surfaces, the answer is not a generic list buried elsewhere. It is a
reader-tools sidecar view whose rows align with the referenced passage when the
target is anchorable. A PDF passage cited by a Library Intelligence artifact
shows a row beside that passage, and the row opens the artifact. A chat answer
that cited a paragraph, a note block that mentioned a highlight with `@`, and a
manual user link to an evidence span follow the same model.

The internal name is **incoming connections**. "Reverse citations", "backlinks",
"linked items", "cited by", and "referenced by" are UI labels over the same
capability.

## 1. SME Thesis

A subject matter expert would not build a `reverse_citations` table, a
reader-only sidecar store, or another note backlink path. The repo already made
the correct storage decision: durable connections are `resource_edges`, and
position belongs to the target grain (`evidence_span`, `content_chunk`,
`highlight`, `note_block`, etc.), not to the edge.

The missing product layer is a **typed connection read model**:

```text
resource_edges
  -> target expansion for the object or reader context
  -> direction/filter query over edges
  -> endpoint hydration through resource_graph.resolve
  -> reader target reconstruction through target-owned anchors
  -> UI-ready connection rows
```

The goal is not to store more. The goal is to centralize what is currently
spread across exact edge reads, note backlinks, highlight linked-item enrichment,
source-centered citation rendering, and reader sidecar alignment.

The cutover question is:

> Given a set of target `ResourceRef`s, what durable graph edges point to or from
> them, and how should those edges be presented in this product surface?

## 2. Existing Contracts This Extends

### 2.1 Resource graph storage

The base graph contract is already built:

- `resource_edges` is the single directed connection table.
- `ResourceRef` is the one persisted endpoint vocabulary.
- Edge `kind` is stance: `context | supports | contradicts`.
- Edge `origin` is writer ownership. The current vocabulary is owned by
  `python/nexus/services/resource_graph/schemas.py`; historical literals in
  this spec do not widen that closed set.
- Citation rows are `origin='citation'` edges with dense `ordinal` and
  `snapshot`.
- `message_retrievals` stays chat telemetry and points back with
  `cited_edge_id`.
- There are no locator columns on edges.

This spec does not change the table shape.

### 2.2 Source-centered citations

`resource_graph.citations.build_citation_outs(source=...)` is the source-centered
read model for chips inside a message, Oracle reading, or Library Intelligence
artifact. It reads citation edges where the output object is the source and
reconstructs the reader jump from the target.

Incoming connections are the target-centered twin:

```text
source-centered: output -> cited target, render [N] chips in the output
target-centered: cited target <- outputs, render "cited by" rows at the target
```

Both must share edge interpretation. They must not fork citation snapshot,
locator, role, or target-resolution logic.

### 2.3 Notes and backlinks

Notes sync inline `object_ref` and `object_embed` references into
`resource_edges origin='note_body'` from the source `note_block:<id>`.
User graph tags were removed by
`docs/cutovers/user-graph-tags-hard-cutover.md`; `#tag` text is not a graph
edge.
`NoteBacklinks` reads exact edges touching one object and renders the opposite
endpoint.

This cutover keeps the note-body write path. It replaces the exact raw-edge UI
read with the centralized connection read model.

### 2.4 Reader sidecars

The reader already has three relevant sidecar precedents:

- `ReaderHighlightsSurface`: anchor highlights to rendered text/PDF geometry.
- `ReaderApparatusSurface`: anchor source-authored apparatus rows using the same
  projection hook.
- `NoteBacklinks`: render generic object connections, but not anchored to
  passage geometry.

This spec extracts the duplicate anchoring/layout work and adds a new
reader-tools surface for graph connections.

### 2.5 Library Intelligence

Library Intelligence citations are revision-scoped citation edges:

```text
source = library_intelligence_revision:<revision_id>
target = evidence_span:<span_id>
origin = citation
ordinal = N
snapshot = display card + deep link
```

The target-centered reader row opens the exact generated revision that cited the
passage. The stable artifact head remains a latest/current alias, not the source
identity for generated LI citation rows.

### 2.6 Source-authored apparatus

Reader apparatus is source-authored document structure, not generated evidence.
It remains in `reader_apparatus_*` tables and `ReaderApparatusSurface`. This
cutover does not fold document footnotes/endnotes/bibliography into
`resource_edges`.

If a future product explicitly exports apparatus items into the graph, that will
be a separate graph-origin and scheme decision. This cutover only ensures the
reader-sidecar machinery can be shared.

## 3. Goals

G1. **One product connection read model.** Replace raw exact-edge product reads
with a hydrated connection query that can serve backlinks, cited-by rows,
linked-items sidecars, and object connections.

G2. **Exact and rollup target support.** Exact `evidence_span:<id>` cited-by
works, and parent surfaces such as `media:<id>`, `page:<id>`, and
`note_block:<id>` can roll up connections to their current child targets.

G3. **Reader-aligned linked items.** Media readers expose incoming/outgoing graph
connections in `reader-tools`, aligned with the referenced passage when the
target has a reader anchor.

G4. **No new storage.** Do not add a reverse table, cache table, locator sidecar,
metadata bag, relation verb system, or compatibility route.

G5. **No edge locators.** Reader activation continues to be reconstructed from
the target object through existing resolver/locator owners.

G6. **Centralized UI primitives.** Consolidate duplicated row-alignment and
connection-card behavior instead of cloning `ReaderHighlightsSurface`,
`ReaderApparatusSurface`, and `NoteBacklinks` patterns again.

G7. **A single frontend graph client.** Product UI calls one connection read
client; raw `listEdgesForRef` stops being a product surface helper.

G8. **Hard cleanup.** Delete superseded product read paths in the same cutover.
No dual-read, dual-render, or old helper fallback.

G9. **Prototype-simple, production-grade.** Single-user scope reduces
pagination/permission complexity, not invariants. Backend still owns visibility,
hydration, target expansion, and stale-target classification.

## 4. Non-goals

N1. No graph visualization, force-directed map, global knowledge graph browser,
or recommendation engine.

N2. No historical resolver. If a cited span no longer resolves, show the citation
snapshot and mark the row as non-jumpable.

N3. No source-versioned historical resolver for deleted targets. Library
Intelligence generated revisions are the explicit durable-artifact carveout.

N4. No occurrence-level note backlink storage. A note body edge means "this block
currently references X", not "this block has three mentions at offsets A/B/C".
Occurrence offsets can be parsed from current ProseMirror JSON later if needed.

N5. No source-authored apparatus graph export.

N6. No user-facing relation taxonomy. "mentions", "cites", "links", "attaches",
"contains", and "tags" remain product labels derived from `origin`, endpoint
schemes, and `kind`.

N7. No direct browser-to-FastAPI product calls. Next.js BFF routes stay the
browser boundary.

N8. No route-layer business logic. FastAPI routes parse and dispatch; services
own behavior.

N9. No speculative index migration. Add indexes only if the concrete query plan
needs them after implementation tests/EXPLAIN. The existing target-side
`resource_edges` index is the first path.

## 5. Terms

`Connection`

A durable `resource_edges` row plus hydrated endpoint presentation.

`Incoming`

Edges whose `target_ref` is in the requested target set. This powers "cited by",
"referenced by", and "linked from".

`Outgoing`

Edges whose `source_ref` is in the requested source set. This powers "links to",
"cites", and "uses as context".

`Exact target`

Only the requested `ResourceRef`.

`Rollup target`

The requested `ResourceRef` plus current child/owned refs that represent its
passages, chunks, highlights, blocks, or fragments.

`Reader anchored row`

A connection row whose target can be projected into the rendered reader surface
with a text/PDF/transcript/note locator.

`Unanchored row`

A connection row that is still real but cannot be placed next to a rendered
passage in the current view.

## 6. Target Behavior

### 6.1 Exact cited-by

Request:

```text
target = evidence_span:SPAN
direction = incoming
origin = citation
```

Response:

- LI artifacts, messages, Oracle readings, or other outputs that cite the span.
- Each row includes edge id, source ref, source label, source route, citation
  ordinal, role/kind, snapshot, target ref, target reader jump if still current,
  and stale/missing status.

### 6.2 Media reader linked items

Opening a media reader fetches a reader connection projection for the media:

```text
media:M
  roll up to current evidence spans/content chunks/fragments/highlights
  query incoming and selected outgoing edges
  project rows to reader anchors
```

The sidecar has a `Connections` or `Linked` reader-tools tab. Rows are vertically
aligned with the target passage on desktop and flow in document order on mobile.
Rows can be filtered by source category:

- AI citations: chat, Oracle, Library Intelligence.
- Notes: `note_body`, `highlight_note`.
- User links: `origin=user`.
- Suggestions: `origin=synapse`, if enabled.

The first implementation can ship one combined list with origin chips. The row
model must already support filtering; the UI can add controls without changing
the API.

### 6.3 PDF LI cited-by example

Given:

```text
library_intelligence_revision:R -> evidence_span:S
origin = citation
ordinal = 4
snapshot.deep_link = /media/M#evidence-S
```

and `S` resolves to PDF page geometry, the PDF reader sidecar shows a row next
to that page region:

```text
Library Intelligence
This artifact cites this passage as [4]
Open revision
```

Clicking the row opens the LI artifact surface. Activating the target anchor
pulses/scrolls to the passage if needed.

### 6.4 Chat cited-by

If a chat assistant message cites a passage, the target sidecar row opens the
conversation/message. Conversation context edges created from cited local targets
do not substitute for citation rows: they are context/admission facts and can be
shown separately as "conversation uses this as context" only when requested.

### 6.5 Note `@` and `[[...]]` backlinks

If a note block mentions a media item, highlight, passage, page, tag, or other
resource, the target object shows a connection from the source note block with
`origin='note_body'`.

For an object-level surface this is a normal connection card. For a reader
surface it becomes an anchored row only when the target is a reader-anchorable
object. A note body edge to `media:<id>` is object-level and unanchored; a note
body edge to `highlight:<id>` or `evidence_span:<id>` can align.

### 6.6 Highlights and attached notes

Highlight note attachments remain `highlight:<id> -> note_block:<id>` with
`origin='highlight_note'`. Highlight APIs may keep their typed
`linked_note_blocks` projection, but the underlying reverse lookup should use the
same connection-query machinery.

### 6.7 Stale targets

Citation edges with ordinals outlive deleted/reindexed targets. Incoming
connections must classify target state:

```text
target_status = current | missing | forbidden | unanchorable
```

For `missing`, render source and snapshot but disable reader jump. Do not invent
a historical resolver or fallback text search.

### 6.8 Object pages and panes

Non-reader panes (notes, pages, library, conversation, contributor, podcast)
show the same connection read model in their secondary `connections` surface.
They do not get passage alignment unless they have a first-class rendered
document surface.

## 7. Final Architecture

```text
python/nexus/services/resource_graph/
  refs.py
  resolve.py
  edges.py
  citations.py
  context.py
  connections.py        NEW: direction/filter/batch connection read model
  cleanup.py
  schemas.py            extend with connection read DTOs

python/nexus/services/
  reader_connections.py NEW: media-reader target expansion + anchored rows

python/nexus/api/routes/
  resource_graph.py     connections query route; raw edge GET removed
  reader.py or media.py reader connections route, whichever owns media-reader APIs

apps/web/src/lib/resourceGraph/
  resourceRef.ts
  connections.ts        NEW: product read client
  edges.ts              write/delete only; no product list helper
  citations.ts

apps/web/src/components/connections/
  ConnectionCard.tsx    NEW shared card/presentation
  ConnectionsSurface.tsx NEW object-level list/composer shell

apps/web/src/components/reader/
  AnchoredSidecarSurface.tsx NEW shared sidecar projection/layout primitive
  ReaderConnectionsSurface.tsx NEW graph-linked reader rows
  ReaderHighlightsSurface.tsx  refactor to shared primitive
  ReaderApparatusSurface.tsx   refactor to shared primitive

apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx
  publishes reader connections in reader-tools
```

Feature modules call `resource_graph.connections` for connection reads. They do
not query `resource_edges` directly except inside resource-graph services.

## 8. Backend Capability Contracts

### 8.1 `resource_graph.connections`

Public service API:

```python
class ConnectionDirection(Literal["incoming", "outgoing", "both"]): ...
class ConnectionRollup(Literal["exact", "owner"]): ...

@dataclass(frozen=True, slots=True)
class ConnectionFilters:
    origins: tuple[EdgeOrigin, ...] | None
    kinds: tuple[EdgeKind, ...] | None
    source_schemes: tuple[ResourceScheme, ...] | None
    target_schemes: tuple[ResourceScheme, ...] | None

@dataclass(frozen=True, slots=True)
class ConnectionQuery:
    refs: tuple[ResourceRef, ...]
    direction: ConnectionDirection
    rollup: ConnectionRollup
    filters: ConnectionFilters
    limit: int
    cursor: str | None

def query_connections(
    db: Session,
    *,
    viewer_id: UUID,
    query: ConnectionQuery,
) -> ConnectionPage: ...
```

Rules:

- `refs` must be non-empty and bounded; initial cap: 200 refs.
- `limit` is bounded; initial cap: 100 rows.
- The service expands owner refs before querying.
- The service queries `resource_edges` in batches, never one ref at a time.
- The service hydrates all distinct endpoints through `resolve.load_resource_batch`.
- The service returns missing/forbidden endpoint state explicitly.
- The service does not format UI copy.
- The service does not know about React, panes, or reader sidecar layout.

### 8.2 `ConnectionOut`

Wire shape:

```python
class ConnectionEndpointOut(BaseModel):
    ref: str
    scheme: ResourceScheme
    id: UUID
    label: str | None
    description: str | None
    href: str | None
    missing: bool

class ConnectionCitationOut(BaseModel):
    ordinal: int
    role: EdgeKind
    snapshot: CitationSnapshot
    target_reader: ReaderTargetOut | None
    target_status: Literal["current", "missing", "forbidden", "unanchorable"]

class ConnectionOut(BaseModel):
    edge_id: UUID
    direction: Literal["incoming", "outgoing"]
    kind: EdgeKind
    origin: EdgeOrigin
    source_ref: str
    target_ref: str
    source: ConnectionEndpointOut
    target: ConnectionEndpointOut
    other: ConnectionEndpointOut
    citation: ConnectionCitationOut | None
    created_at: datetime
```

`other` is from the perspective of the requested ref set. For a multi-ref query,
`direction` and `other` are computed per returned edge.

### 8.3 `resource_graph.citations`

Keep source-centered `build_citation_outs`.

Add or expose shared internals so `connections` does not duplicate citation
interpretation:

```python
def citation_reader_target_for_edge(
    db: Session,
    *,
    viewer_id: UUID,
    edge: ResourceEdge,
) -> CitationTargetProjection: ...
```

This helper is not a new public HTTP surface. It centralizes:

- edge ordinal/snapshot validation;
- `reader_target_for_citation_target`;
- stale target classification;
- role/kind mapping;
- deep-link handling.

### 8.4 Target expansion

Owner rollup is service-owned and explicit.

For `media:<id>` include:

- `media:<id>` exact edges;
- current `evidence_span:*` where `owner_kind='media' and owner_id=<id>`;
- current `content_chunk:*` where `owner_kind='media' and owner_id=<id>`;
- `fragment:*` owned by the media;
- `highlight:*` anchored to the media.

For `page:<id>` include:

- `page:<id>` exact edges;
- contained `note_block:*` refs from graph document containment;
- current page-owned `evidence_span:*` and `content_chunk:*`;
- `tag:*` only if directly requested, not automatically from page text.

For `note_block:<id>` include:

- `note_block:<id>` exact edges;
- page-owned evidence spans/chunks whose note locator points at the block;
- highlights only if a direct highlight-note or body edge targets the highlight.

For `library:<id>` include only `library:<id>` exact edges in this cutover.
Library member/media expansion is not automatic because library membership is not
a connection citation target and would create noisy "everything in this library"
backlinks.

For `conversation:<id>`, `message:<id>`, `oracle_reading:<id>`,
`library_intelligence_revision:<id>`, `contributor:<id>`, `podcast:<id>`, and
`tag:<id>`, owner rollup equals exact unless a later spec defines child refs.
For `library_intelligence_artifact:<id>`, owner rollup includes its immutable
`library_intelligence_revision:<id>` children.

### 8.5 `reader_connections`

Product service API:

```python
def list_reader_connections(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    origins: tuple[EdgeOrigin, ...] | None,
    source_schemes: tuple[ResourceScheme, ...] | None,
    limit: int,
    cursor: str | None,
) -> ReaderConnectionPage: ...
```

Responsibilities:

- Assert media visibility.
- Compute media rollup target refs.
- Call `resource_graph.connections.query_connections`.
- Convert connection targets into reader anchors.
- Split rows into `anchored` and `unanchored`.
- Preserve document order where known.
- Preserve graph-created ordering where document order is unknown.

It must not query `resource_edges` directly. It may query media/fragment/highlight
tables to build anchors because those are reader projection facts.

### 8.6 Reader row shape

```python
class ReaderConnectionAnchorOut(BaseModel):
    ref: str
    media_id: UUID
    locator: RetrievalLocator | None
    page_number: int | None
    fragment_id: UUID | None
    highlight_id: UUID | None
    evidence_span_id: UUID | None
    order_key: str | None

class ReaderConnectionRowOut(BaseModel):
    id: str
    connection: ConnectionOut
    anchor: ReaderConnectionAnchorOut | None
    source_category: Literal[
        "chat",
        "library_intelligence",
        "oracle",
        "note",
        "highlight_note",
        "user_link",
        "synapse",
        "system",
        "other",
    ]
    title: str
    subtitle: str | None
    excerpt: str | None
    href: str | None
```

`id` is stable and deterministic:

```text
edge:<edge_id>:target:<target_ref>
```

If one edge is returned because of multiple expanded targets, de-duplicate by
edge id and choose the most precise anchor in this order:

```text
highlight > evidence_span > content_chunk > fragment > media
```

## 9. API Design

### 9.1 Resource graph connection query

Product read route:

```text
POST /api/resource-graph/connections/query
```

FastAPI route:

```text
POST /resource-graph/connections/query
```

Request:

```json
{
  "refs": ["evidence_span:00000000-0000-4000-8000-000000000000"],
  "direction": "incoming",
  "rollup": "exact",
  "filters": {
    "origins": ["citation"],
    "kinds": null,
    "source_schemes": ["message", "library_intelligence_revision"],
    "target_schemes": null
  },
  "limit": 50,
  "cursor": null
}
```

Response:

```json
{
  "data": {
    "items": [],
    "next_cursor": null
  }
}
```

Rules:

- This is the only product read route for graph connections.
- Delete `GET /resource-graph/edges?ref=...` as a product read in the hard
  cutover.
- Keep `POST /resource-graph/edges` and `DELETE /resource-graph/edges/{edge_id}`
  for user-created edge writes.
- Do not add `/object-links`, `/object-graph`, `/backlinks`, or
  `/reverse-citations` routes.

### 9.2 Media reader connections

Product route:

```text
GET /api/media/{media_id}/reader-connections?origin=citation&origin=note_body&limit=100&cursor=...
```

FastAPI route:

```text
GET /media/{media_id}/reader-connections
```

Response:

```json
{
  "data": {
    "anchored": [],
    "unanchored": [],
    "next_cursor": null
  }
}
```

This route exists because the browser must not compute media target expansion or
reader anchors. It is not a second graph read API; it is a media-reader
projection over `resource_graph.connections`.

### 9.3 Object connections

Notes/pages/library/conversation/contributor/podcast panes call
`/resource-graph/connections/query` directly through the frontend client. There
is no bespoke `/notes/{id}/backlinks` route.

### 9.4 Frontend clients

```text
apps/web/src/lib/resourceGraph/connections.ts
  queryConnections(input, options)

apps/web/src/lib/media/readerConnections.ts
  listReaderConnections(mediaId, filters, options)
```

`apps/web/src/lib/resourceGraph/edges.ts` keeps create/delete helpers. Its
`listEdgesForRef` export is deleted, and tests move to `connections.ts`.

## 10. Frontend Architecture

### 10.1 Shared anchored sidecar primitive

Create one shared row-projection/layout component:

```text
apps/web/src/components/reader/AnchoredSidecarSurface.tsx
apps/web/src/components/reader/AnchoredSidecarSurface.module.css
```

It owns:

- `useAnchoredHighlightProjection` integration or the renamed generic hook;
- desktop absolute row placement;
- mobile normal flow;
- row collision avoidance;
- overflow/unanchored row grouping;
- empty/loading/error shell;
- keyboard focus and row activation affordances.

`ReaderHighlightsSurface`, `ReaderApparatusSurface`, and
`ReaderConnectionsSurface` become domain adapters that provide rows and card
renderers.

No third sidecar alignment implementation is allowed.

### 10.2 Rename/generalize projection types

Current names are highlight-specific:

```text
AnchoredHighlightRow
useAnchoredHighlightProjection
toAnchoredHighlightRow
```

Hard-cutover target names:

```text
AnchoredReaderRow
useAnchoredReaderProjection
toAnchoredHighlightRow      remains highlight adapter only
toAnchoredApparatusRow      remains apparatus adapter only
toAnchoredConnectionRow     new connection adapter
```

Existing imports move in the same cutover. No alias exports.

### 10.3 Shared connection presentation

Create:

```text
apps/web/src/components/connections/ConnectionCard.tsx
apps/web/src/components/connections/ConnectionsSurface.tsx
apps/web/src/components/connections/ConnectionComposer.tsx
```

Move reusable card/list/composer logic out of `NoteBacklinks`. The note/page
surface becomes a thin adapter over `ConnectionsSurface`.

Presentation rules:

- Show source category icon/label.
- Show source title.
- Show edge origin/kind as compact metadata.
- For citations, show ordinal and snapshot excerpt.
- For user links, show verbless connection metadata.
- For note-body refs, label as "Mentioned in note".
- For highlight-note refs, label as "Attached note".
- For stale citation targets, show "Source no longer resolves" style copy and
  disable target jump.

Do not put feature explanations or keyboard shortcut text in the app.

### 10.4 Reader connections surface

```text
apps/web/src/components/reader/ReaderConnectionsSurface.tsx
```

Props:

```ts
interface ReaderConnectionsSurfaceProps {
  contentRef: React.RefObject<HTMLElement | null>;
  rows: ReaderConnectionRow[];
  loading: boolean;
  error: FeedbackContent | null;
  onOpenSource: (row: ReaderConnectionRow, event?: React.MouseEvent) => void;
  onActivateTarget: (row: ReaderConnectionRow) => void;
  measureKey: string;
  layoutVersion: number;
}
```

`MediaPaneBody` owns fetching and route activation, following the pattern it
already uses for highlights/apparatus.

### 10.5 Pane model

`paneSecondaryModel.ts` already has `connections` in the reader-tools group.
Use that surface id for object-level media connections, or add a reader-specific
`reader-connections` id only if current `connections` cannot be made
reader-tool-scoped without breaking non-reader panes.

Preferred final shape:

```text
reader-tools:
  reader-highlights
  reader-contents
  reader-connections
  reader-apparatus
  reader-doc-chat

generic object panes:
  connections
```

Avoid overloading one id with different semantics across pane families.

## 11. Composition With Existing Systems

### 11.1 Chat

Chat continues to write citation edges through `resource_graph.citations`.
Incoming connection reads can show:

- source message;
- parent conversation;
- citation ordinal;
- snapshot excerpt/title;
- target reader jump.

Do not use conversation context edges as a proxy for citations. Context edges are
also connections and may appear under a separate filter.

### 11.2 Library Intelligence

LI generated citations source from `library_intelligence_revision:<revision_id>`.
Promote only moves `library_intelligence_artifacts.current_revision_id`; it does
not replace, delete, or synthesize citation edges.

Incoming rows for a revision open that exact revision. Artifact-head rows remain
valid only for explicit latest/head links, and owner rollup may include immutable
revision children when the caller asks for owner rollup.

### 11.3 Oracle

Oracle citation edges source from `oracle_reading:<id>`. Public-domain typographic
passages with no `CitationOut` remain typographic and do not appear as cited-by
rows unless they have real citation edges.

### 11.4 Notes

The note editor remains the source of inline object-ref intent. Backend body
sync remains the graph writer.

`NoteBacklinks` is replaced by `ConnectionsSurface`. Existing `@` and `[[...]]`
interactions keep the same write behavior and their read side now uses
`queryConnections`. Plain `#tag` text is not a graph connection.

### 11.5 Highlights

`highlights.project_highlights_with_links` can continue returning typed
`linked_conversations` and `linked_note_blocks` for highlight cards. The
underlying batch lookups should delegate to `resource_graph.connections` or share
its private batching primitives so highlight-specific code does not remain a
second graph reader.

### 11.6 Synapse

Synapse edges are `origin='synapse'`. They are not user links and not citations.
The connection read model can include them behind an explicit origin filter.
Dismiss/accept remains synapse-owned.

### 11.7 Search scope and read-resource admission

Search/admission semantics do not broaden just because connection reads exist.
`resource_graph.context` remains the owner for conversation context refs and
search-scope extraction. `queryConnections` is a presentation read, not an
authorization grant.

### 11.8 Media deletion and reindexing

Existing cleanup rules remain:

- bare edges die with either endpoint;
- citation edges outlive targets and render snapshots.

Reader connection rows must handle missing targets rather than deleting or
repairing citation rows at read time.

When content reindex replaces spans/chunks, old citation edges may become
snapshot-only. This is acceptable and must be visible as stale/non-jumpable.

### 11.9 Resource resolution and pane routing

All endpoints hydrate through `resource_graph.resolve`. Frontend routes derive
from resolved endpoint hrefs or pane route table helpers, not per-surface string
building.

## 12. Duplicate Pattern Consolidation

This cutover must remove or consolidate these repeated patterns.

### 12.1 Raw exact edge reads

Current pattern:

```text
listEdgesForRef(ref)
GET /resource-graph/edges?ref=...
NoteBacklinks local opposite-endpoint mapping
```

Final pattern:

```text
queryConnections({ refs, direction, rollup, filters })
ConnectionOut.other
ConnectionsSurface
```

### 12.2 Source-centered citation-only reconstruction

Current pattern:

```text
build_citation_outs(source) privately reconstructs reader target
reverse/cited-by would otherwise duplicate the same reconstruction
```

Final pattern:

```text
shared citation-edge projection helper
build_citation_outs(source)
queryConnections(targets)
```

### 12.3 Highlight linked-item enrichment

Current pattern:

```text
highlights.py batches linked conversations
highlight_notes.py batches attached note blocks
NoteBacklinks separately lists graph edges
```

Final pattern:

```text
resource_graph.connections owns edge batching + endpoint hydration
highlight services keep typed output adapters only
```

### 12.4 Reader sidecar alignment

Current pattern:

```text
ReaderHighlightsSurface.alignRows
ReaderApparatusSurface.alignRows
shared hook but duplicated collision/layout shell
```

Final pattern:

```text
AnchoredSidecarSurface
domain adapters for highlights/apparatus/connections
```

### 12.5 Connection cards

Current pattern:

```text
NoteBacklinks owns card/list/composer behavior
ReaderHighlightsSurface embeds linked item chips
future reader connections would need another card shape
```

Final pattern:

```text
components/connections/*
NoteBacklinks replaced or reduced to adapter
ReaderConnectionsSurface reuses ConnectionCard
```

## 13. Files

### 13.1 Backend add/change

```text
python/nexus/services/resource_graph/connections.py      NEW
python/nexus/services/resource_graph/schemas.py          add connection DTOs
python/nexus/services/resource_graph/citations.py        shared citation projection
python/nexus/services/resource_graph/resolve.py          expose needed reader target types
python/nexus/services/reader_connections.py              NEW
python/nexus/api/routes/resource_graph.py                connections query route
python/nexus/api/routes/media.py or reader.py            media reader connections route
python/nexus/schemas/resource_graph.py                   wire schemas
python/nexus/schemas/reader.py or media.py               reader connection schemas
```

### 13.2 Frontend add/change

```text
apps/web/src/lib/resourceGraph/connections.ts            NEW
apps/web/src/lib/resourceGraph/edges.ts                  remove list helper
apps/web/src/lib/resourceGraph/resourceRef.ts            no alias schemes
apps/web/src/lib/media/readerConnections.ts              NEW if media-local client is preferred
apps/web/src/components/connections/ConnectionCard.tsx   NEW
apps/web/src/components/connections/ConnectionsSurface.tsx NEW
apps/web/src/components/connections/ConnectionComposer.tsx NEW
apps/web/src/components/notes/NoteBacklinks.tsx          replace/thin adapter
apps/web/src/components/reader/AnchoredSidecarSurface.tsx NEW
apps/web/src/components/reader/useAnchoredReaderProjection.ts rename/generalize
apps/web/src/components/reader/ReaderConnectionsSurface.tsx NEW
apps/web/src/components/reader/ReaderHighlightsSurface.tsx refactor
apps/web/src/components/reader/ReaderApparatusSurface.tsx refactor
apps/web/src/lib/panes/paneSecondaryModel.ts             add/confirm reader-connections
apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx publish/fetch surface
apps/web/src/app/api/resource-graph/connections/query/route.ts NEW
apps/web/src/app/api/media/[id]/reader-connections/route.ts NEW
```

### 13.3 Tests

```text
python/tests/test_resource_graph_connections.py          NEW
python/tests/test_resource_graph_routes.py               route contract updates
python/tests/test_chat_runs.py                           cited-by source behavior
python/tests/test_library_intelligence.py                LI artifact cited-by
python/tests/test_notes.py                               note_body incoming refs
python/tests/test_highlights.py                          highlight attached notes via shared path
python/tests/test_media_deletion.py                      stale citation rows

apps/web/src/lib/resourceGraph/connections.test.ts       NEW
apps/web/src/components/connections/ConnectionsSurface.test.tsx NEW
apps/web/src/components/reader/AnchoredSidecarSurface.test.tsx NEW
apps/web/src/components/reader/ReaderConnectionsSurface.test.tsx NEW
apps/web/src/components/reader/ReaderHighlightsSurface.test.tsx update
apps/web/src/components/reader/ReaderApparatusSurface.test.tsx update
apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx update

e2e/tests/pdf-reader.spec.ts                             reader connections sidecar
e2e/tests/non-pdf-linked-items.spec.ts                   web/epub connection rows
e2e/tests/real-media/context-chat-citations.spec.ts      real media citation backlinks
```

### 13.4 Negative gates

Update `python/tests/test_cutover_negative_gates.py` to prevent:

- `/object-links` resurrection;
- `/object-graph` creation;
- `reverse_citations` tables/routes/services;
- frontend `listEdgesForRef` product usage;
- a third reader row alignment implementation;
- direct `resource_edges` queries outside `services/resource_graph/*`, except
  migrations and documented DB constraint tests.

## 14. Key Decisions

D1. **Incoming connections are not a new storage concept.** They are a read model
over `resource_edges`.

D2. **Product reads use `connections`, writes use `edges`.** This separates
hydrated presentation from row creation/deletion without duplicating read APIs.

D3. **Reader anchored rows are media-reader projections.** The generic graph
query does not know about DOM layout or sidecars.

D4. **Rollup expansion is backend-owned.** The frontend never guesses which
spans/chunks/highlights belong to a media item or note block.

D5. **Citation snapshots are display-only.** They keep cards useful after target
loss. They are not a resolver fallback.

D6. **LI generated backlinks are revision-scoped.** Artifact identity is the
latest/head alias; immutable revision refs own generated citation backlinks.

D7. **Note body backlinks are block-level, not occurrence-level.** The edge is a
durable reference fact; inline positions remain inside PM JSON.

D8. **Source-authored apparatus stays separate.** Shared sidecar layout is fine;
shared citation storage is not.

D9. **No broad library rollup.** Library membership is not the same as "this
library object is cited".

D10. **No user-facing edge verbs.** `origin`, `kind`, and endpoint schemes define
behavior; UI copy translates them.

## 15. Implementation Sequence

S1. Backend connection read model:

- add `resource_graph.connections`;
- add internal DTOs and query tests;
- cover exact incoming/outgoing/both;
- cover filters, limits, cursor ordering, and endpoint hydration.

S2. Target expansion:

- implement `rollup='owner'` for media/page/note_block;
- add tests for current content index refs, highlights, fragments, and missing
  targets;
- prove no broad library/conversation expansion.

S3. Citation projection sharing:

- extract shared edge-to-citation-target helper from `citations.py`;
- make source-centered `build_citation_outs` and target-centered connections use
  the same helper;
- test stale target classification.

S4. API cutover:

- add `POST /resource-graph/connections/query`;
- remove product `GET /resource-graph/edges`;
- keep `POST/DELETE /resource-graph/edges`;
- add Next.js BFF proxy route;
- update frontend clients and tests.

S5. Object connections UI:

- extract `components/connections/*` from `NoteBacklinks`;
- migrate note/page/media object connection surfaces to `queryConnections`;
- delete `listEdgesForRef` frontend product helper.

S6. Anchored sidecar primitive:

- create `AnchoredSidecarSurface`;
- rename/generalize projection hook/types;
- refactor highlights and apparatus to use it without behavior drift.

S7. Reader connections:

- add backend `reader_connections`;
- add media reader route and BFF proxy;
- add `ReaderConnectionsSurface`;
- publish it from `MediaPaneBody` under reader-tools.

S8. Integration and hard cleanup:

- delete old duplicated helpers/imports;
- add negative gates;
- update docs/module maps;
- run targeted backend/frontend/e2e verification.

## 16. Acceptance Criteria

### 16.1 Data and backend

AC1. No new persisted reverse-citation, backlink, object-link, object-graph, or
connection-cache table exists.

AC2. `resource_graph.connections.query_connections` returns incoming, outgoing,
and both-direction hydrated rows for exact refs.

AC3. Owner rollup for media includes current media-owned evidence spans/chunks,
fragments, and highlights without returning unrelated library members.

AC4. Owner rollup for pages and note blocks includes page-owned note evidence and
block-level refs.

AC5. Citation connection rows use the same target-reader reconstruction as
`build_citation_outs`.

AC6. Stale citation targets render snapshot data and classify as non-jumpable.

AC7. Permission/visibility checks happen through `resource_graph.resolve` and
route-level viewer auth, not frontend filtering.

AC8. No non-resource-graph service performs direct `resource_edges` connection
read SQL except documented migration/constraint tests.

### 16.2 API

AC9. `POST /resource-graph/connections/query` is the only product graph
connection read route.

AC10. `GET /resource-graph/edges?ref=...` is deleted in the same cutover; raw
edge listing does not remain as a product or compatibility read lane.

AC11. `POST /resource-graph/edges` and `DELETE /resource-graph/edges/{edge_id}`
continue to handle user edge writes/deletes only.

AC12. `GET /media/{id}/reader-connections` returns anchored and unanchored rows
and delegates to the connection read model.

### 16.3 Frontend

AC13. `NoteBacklinks` no longer owns graph querying or custom card logic; it is
deleted or reduced to a thin compatibility-free adapter around
`ConnectionsSurface`.

AC14. `listEdgesForRef` is removed from the frontend graph client.

AC15. Highlights, apparatus, and reader connections use one shared anchored
sidecar layout primitive.

AC16. The reader-tools group exposes a reader connections surface on media panes.

AC17. Reader connection rows align to PDF/page/text anchors when targets resolve,
and unanchored rows remain visible in a separate flow.

AC18. Row click opens the source object: LI artifact, conversation/message, note
block/page, Oracle reading, or linked object.

### 16.4 Product behavior

AC19. A Library Intelligence artifact citing a PDF evidence span appears beside
that span in the PDF reader sidecar.

AC20. A chat message citing a web/EPUB/PDF passage appears as an incoming
connection on that passage.

AC21. A note `@`/`[[...]]`/embed reference appears as an incoming note-body
connection on the target.

AC22. Highlight attached notes still render in highlight rows, and the same
connection is visible through the generic connection surface.

AC23. User links remain verbless and render through the same connection card
component.

AC24. Conversation context edges do not masquerade as citation edges.

### 16.5 Verification

AC25. Backend tests assert API responses, not raw SQL, for route behavior.

AC26. Component tests cover desktop alignment, mobile flow, empty, loading,
error, stale target, and row activation states.

AC27. E2E covers at least one PDF and one non-PDF reader linked-items flow.

AC28. Negative gates fail if legacy routes, duplicate graph services, or raw
frontend edge-list helpers return.

## 17. Targeted Test Plan

Backend:

```text
make test-back PYTEST_ARGS="python/tests/test_resource_graph_connections.py"
make test-back PYTEST_ARGS="python/tests/test_resource_graph_routes.py -k connections"
make test-back PYTEST_ARGS="python/tests/test_library_intelligence.py -k citation"
make test-back PYTEST_ARGS="python/tests/test_chat_runs.py -k citation"
make test-back PYTEST_ARGS="python/tests/test_notes.py -k note_body"
make test-back PYTEST_ARGS="python/tests/test_media_deletion.py -k citation"
```

Frontend:

```text
bun test apps/web/src/lib/resourceGraph/connections.test.ts
bun test apps/web/src/components/connections/ConnectionsSurface.test.tsx
bun test apps/web/src/components/reader/AnchoredSidecarSurface.test.tsx
bun test apps/web/src/components/reader/ReaderConnectionsSurface.test.tsx
bun test apps/web/src/app/'(authenticated)'/media/'[id]'/MediaPaneBody.test.tsx
```

E2E:

```text
bunx playwright test e2e/tests/pdf-reader.spec.ts -g "connections"
bunx playwright test e2e/tests/non-pdf-linked-items.spec.ts -g "connections"
bunx playwright test e2e/tests/real-media/context-chat-citations.spec.ts
```

Final broad confidence, if requested:

```text
make verify
```

## 18. Documentation Updates

Update after implementation:

- `docs/architecture.md`: resource graph read model, reader connections surface,
  LI doc drift.
- `docs/modules/reader-implementation.md`: reader-tools `reader-connections`.
- `docs/modules/chat.md`: target-centered citation visibility.
- `docs/modules/library.md`: LI revision-scoped cited-by behavior.
- `docs/cutovers/resource-provenance-graph-hard-cutover.md`: amend G9 to point
  at `connections` as the product read model, with `edges` as row write/delete.
- `docs/cutovers/notes-pages-object-graph-hard-cutover.md`: replace backlink
  wording with connection read model.

## 19. Risks and Mitigations

R1. **Noisy rollups.** Media/page rollup could show too much.
Mitigation: exact origin/source filters, no broad library rollup, and separate
anchored/unanchored groups.

R2. **Stale citation confusion.** Snapshot rows may look current.
Mitigation: explicit target status; disable jumps when missing.

R3. **UI duplication returns.** A third sidecar layout can drift.
Mitigation: negative gate plus shared `AnchoredSidecarSurface`.

R4. **Permission leakage through endpoint hydration.**
Mitigation: hydrate through `resource_graph.resolve`; unresolved endpoints render
missing/forbidden, not raw labels.

R5. **Connection reads become authorization grants.**
Mitigation: keep search/admission in `resource_graph.context`; connections are a
presentation read only.

R6. **Cursor complexity.**
Mitigation: order by `resource_edges.created_at desc, id desc` initially. Add
document-order sorting only inside reader projection for rows that share anchors.

R7. **Chunk/span ambiguity.**
Mitigation: choose most precise resolved anchor; classify ambiguous rows as
unanchored rather than guessing.

## 20. Completion Definition

The cutover is complete when:

1. Product UI reads graph connections only through `connections`.
2. Reader media panes show anchored incoming citation/link/note rows.
3. Notes/pages/media object panes use the same connection surface.
4. Highlights and apparatus share the anchored sidecar primitive.
5. Legacy/raw product read helpers are removed.
6. Negative gates prevent duplicate graph/link/read-model resurrection.
7. Targeted backend, frontend, and E2E tests pass.

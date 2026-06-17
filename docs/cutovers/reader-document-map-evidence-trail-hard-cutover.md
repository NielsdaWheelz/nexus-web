# Reader Document Map / Evidence Trail Hard Cutover

Status: SPEC
Author: design synthesis, 2026-06-16
Type: hard cutover - one-user prototype, production-grade contracts, no legacy
lanes, no compatibility shims, no fallback readers, no duplicate reader-map
APIs.

## 0. One-line

Turn the current peer reader surfaces - Contents, Highlights, Citations,
Connections, and Document chat - into one reader-native **Document Map /
Evidence Trail** instrument, backed by one aggregate read model, one reader
affordance, one desktop overview rail, one mobile sheet path, and one integrated
verification contract.

The cutover does **not** merge storage domains. It merges the product
instrument, API contract, activation model, ordering, marker projection, and UI
grammar while keeping each evidence domain owned by its existing source of
truth.

## 1. North Star

When the user is reading a document, Nexus should answer these questions from
one instrument:

```text
What is in this document?
Where am I?
What have I highlighted?
What source-authored citations, notes, references, or bibliography entries are here?
What notes, chats, generated readings, or other objects point at this passage?
Which chats are attached to this document or evidence?
Can I jump to the exact passage, target, note, citation, or chat?
If a target is stale or approximate, is that status visible?
```

The user-facing model:

- **Document Map** is the top-level reader affordance and tabbed side surface.
- **Evidence Trail** is the evidence-oriented lens inside the Document Map:
  highlights, source-authored apparatus, backlinks, cited-by rows, linked notes,
  and linked chats.
- **Overview rail** is the desktop ambient minimap. It shows document-position
  markers and opens the Document Map; it is not the detail surface.
- **Mobile sheet** is the only mobile detail surface. Mobile has no overview
  rail and no second reader drawer.

The final UX should feel like one instrument with multiple lenses, not five
unrelated sidebars.

## 2. SME Thesis

A subject matter expert would not start by drawing a new graph canvas or adding
a new `evidence_items` table. They would ask:

1. Which system owns each fact?
2. Which stable identity names it?
3. Which locator returns the reader to the source position?
4. Is the fact source-authored, user-authored, graph-authored, or generated?
5. What happens when the target is missing, unsupported, forbidden, or
   unanchorable?
6. Which API proves the instrument is one product contract rather than several
   accidental tabs?

The correct center of gravity is a reader-local aggregate read model:

```text
domain owners
  -> typed ReaderDocumentMapItem rows
  -> document-order and marker-position normalization
  -> one API/BFF/client contract
  -> Document Map tabs and overview rail
  -> existing reader activation and workspace secondary shell
```

For a one-user prototype, this should still be a hard cutover. The reduced user
count lowers scale pressure; it does not justify duplicate APIs, stale sidebars,
best-effort DOM scraping, or hidden fallback behavior.

## 3. Existing Contracts This Extends

### 3.1 Reader secondary surfaces

`apps/web/src/lib/panes/paneSecondaryModel.ts` already groups these surfaces
under `reader-tools`:

- `reader-highlights`
- `reader-contents`
- `reader-connections`
- `reader-apparatus` with user label `Citations`
- `reader-doc-chat`

`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` currently
assembles those surfaces directly and publishes the group with
`usePaneSecondary`.

Final state:

- The user-visible group title is **Document Map**.
- The internal workspace group may remain `reader-tools` if it continues to
  mean "reader secondary group"; no alias group is added.
- If the internal group id is renamed, it is renamed in one hard cutover with no
  state compatibility bridge. Persisted old workspace state is dropped by normal
  workspace schema validation, not migrated.
- Surface order is canonical: Contents, Highlights, Citations, Connections,
  Chat.

### 3.2 Workspace chrome

`docs/modules/workspace.md` defines the composition boundary:

- Desktop may attach a secondary pane and fixed primary chrome.
- Mobile has only the active pane and `MobileSecondaryPaneHost`.
- Mobile secondary content must not introduce another drawer or sheet owner.

Final state:

- Desktop: one `Document Map` toolbar affordance opens the attached secondary
  pane; the overview rail can also open the same instrument.
- Mobile: one `Document Map` menu affordance opens the existing mobile secondary
  sheet.
- No mobile overview rail.
- No reader-only mobile drawer.

### 3.3 Overview ruler

The current `ReaderOverviewRuler` is highlight-only:

- `overviewPositions.ts` maps highlights to document fractions.
- The ruler is labeled "Highlights overview".
- Its top button opens the highlights pane.

Final state:

- Rename and generalize the component to a document-map overview rail.
- It consumes typed markers, not highlight rows.
- It can show lanes for Contents, Highlights, Citations, Connections, and Chat
  where those items have a document position.
- Its open button opens the Document Map instrument, not the old highlights pane.

### 3.4 Anchored sidecar projection

The current reusable projection stack is the right primitive:

- `AnchoredSidecarSurface.tsx`
- `useAnchoredReaderProjection.ts`
- domain adapters in `ReaderHighlightsSurface.tsx`,
  `ReaderApparatusSurface.tsx`, and `ReaderConnectionsSurface.tsx`

Current problem:

- `AnchoredReaderRow` is still highlight-shaped.
- Each surface performs its own row-to-anchor conversion.
- Each surface has separate empty/header/card language, so the product feels
  adjacent rather than unified.

Final state:

- Introduce a generic `AnchoredDocumentMapRow` / `ReaderMapAnchor` shape.
- Keep one projection hook and one aligned sidecar surface.
- Move domain-specific card rendering into lens renderers under the Document Map
  instrument.
- Delete duplicate reader-specific connection/apparatus/highlight wrapper
  patterns that only adapt rows into the same anchored sidecar machinery.

### 3.5 Backend reader routes

`python/nexus/api/routes/reader.py` currently exposes separate reader reads:

- `/media/{media_id}/navigation`
- `/media/{media_id}/apparatus`
- `/media/{media_id}/reader-connections`
- `/media/{media_id}/evidence/{evidence_span_id}`
- reader state and file routes

Final state:

- Add one product aggregate route:
  `GET /media/{media_id}/document-map`
- The browser-side Document Map UI reads only that route for map rows, counts,
  markers, lens availability, and sidecar data.
- Domain services remain the source of truth.
- Domain-specific product routes superseded by the aggregate are deleted when no
  non-Document-Map product consumer remains.
- Routes required for independent capabilities remain:
  - evidence resolution
  - reader state
  - media file
  - highlight CRUD and inline rendering reads
  - generic resource graph query APIs
  - chat/conversation APIs
  - navigation reads needed by document rendering outside the Document Map

There is no dual-read product path where one UI can silently choose either
`/apparatus`, `/reader-connections`, or `/document-map`.

### 3.6 Source-authored apparatus

`reader_apparatus` remains the sole owner of source-authored footnotes,
endnotes, sidenotes, bibliography entries, and in-document source citations.

Final state:

- Apparatus rows appear in the Document Map `Citations` lens.
- The aggregate service calls `reader_apparatus` service functions.
- Apparatus is not written to `resource_edges`.
- Apparatus is not written to `message_retrievals`.
- Apparatus is not treated as generated chat citation evidence.

### 3.7 Resource graph connections

`resource_edges` remains the single storage owner for durable "this points at
that" facts:

- `origin='citation'` for generated citation edges.
- `origin='note_body'` for note references.
- `origin='highlight_note'` for highlight note links.
- `origin='user'`, `origin='synapse'`, `origin='system'` as their current
  semantics define.

Final state:

- The Document Map `Connections` lens is target-centered over current media
  reader refs.
- It uses the same graph connection read model as object-level connections.
- Edges never store locators.
- Reader anchors are reconstructed from target-owned refs such as
  `evidence_span`, `content_chunk`, `fragment`, and `highlight`.

### 3.8 Chat and generated citations

Reader document chat remains an adapter over the shared chat engine. Generated
citations remain graph edges and trust-trail read models.

Final state:

- The `Chat` lens opens or starts document chats through the chat owner.
- Linked chats may also appear as connection rows when the graph says a chat,
  message, generated reading, or context ref points at the current document or
  passage.
- The Document Map may summarize chat threads, but it does not return message
  history or become a chat storage API.
- `reader_selection` stays transient bind-only context; durable quote-to-chat
  context stays `highlight:<id>` or existing context refs.

### 3.9 Agent inspect-resource document map

`python/nexus/services/media_document_map.py` currently owns the prompt-facing
section list used by agent read tools and `inspect_resource`. It is navigation
only and returns read URIs for the agent, not product evidence rows.

Final state:

- Product Document Map and agent read-tool section map are separate
  capabilities.
- If both keep "document map" in names, docs and code must make the distinction
  explicit.
- Preferred cleanup: rename the agent-facing service/types to
  `media_read_map` or `inspect_resource_sections` so "Document Map" names the
  product reader instrument.
- Do not reuse the agent map as the product Evidence Trail. It lacks highlights,
  apparatus, graph rows, chat rows, target status, and sidecar presentation
  semantics.

## 4. Goals

G1. **One reader instrument.** One affordance opens one tabbed Document Map /
Evidence Trail surface on desktop and mobile.

G2. **One aggregate API.** The reader Document Map UI consumes one BFF route and
one FastAPI route for map rows, counts, item ordering, markers, and lens
availability.

G3. **One read model, many owners.** A typed `ReaderDocumentMapItem` union
adapts existing domain outputs. It does not own persistence.

G4. **One document-order contract.** Contents, highlights, citations,
connections, and linked chats use a shared `document_order_key` and optional
`document_fraction`.

G5. **One marker contract.** The desktop overview rail consumes generic
`ReaderDocumentMapMarker` values. It is no longer highlight-only.

G6. **One activation path.** Reader jumps use existing `ReaderSourceTarget`,
`ReaderPulseTarget`, `locator_resolver`, and pane-router behavior. No new
reader-jump system.

G7. **One anchored projection primitive.** Highlights, citations, and
connections share one generic anchored sidecar layout. Domain adapters provide
rows and card renderers.

G8. **Explicit provenance.** Every item declares whether it comes from
navigation, highlights, source-authored apparatus, resource graph, chat, or a
generated evidence edge.

G9. **Explicit target status.** Exact, container-level, missing, forbidden,
unanchorable, stale, unsupported, and partial states are visible in the payload
and UI.

G10. **No widened authorization.** The aggregate service must not reveal a
target, source, chat, note, or generated artifact the viewer could not read
through its owner service.

G11. **Hard cleanup.** Delete or rename superseded reader-specific clients,
surfaces, tests, labels, and docs in the same cutover. No compatibility aliases.

G12. **Integrated proof.** Add tests that prove the product invariant:
"one reader evidence instrument, many typed evidence lenses."

## 5. Non-goals

N1. No global force-directed knowledge graph.

N2. No reference manager, CSL renderer, or bibliography editor.

N3. No new persistence table for all evidence rows.

N4. No source-authored apparatus export into `resource_edges`.

N5. No generated chat citation storage in `reader_apparatus`.

N6. No use of `message_retrievals` as the Document Map source of truth.

N7. No client-side DOM scraping for positions, citations, or backlinks.

N8. No route-time extraction or repair.

N9. No historical resolver for deleted source text. Stale rows show snapshots
where the owner already provides them.

N10. No mobile-specific reader map implementation.

N11. No duplicate "Reader Tools" and "Document Map" product surfaces.

N12. No saved custom map filters.

N13. No LLM-generated document outline in this cutover.

N14. No agent-tool behavior change except optional naming cleanup to avoid
confusion with the product Document Map.

## 6. Terms

`Document Map`

The reader-local product instrument that shows structure and evidence attached
to a document.

`Evidence Trail`

The evidence-oriented interpretation of the Document Map: highlights, notes,
citations, backlinks, generated citations, linked chats, and related objects.

`Lens`

A tab/filter over the same instrument. Canonical lens ids:

- `contents`
- `highlights`
- `citations`
- `connections`
- `chat`

`Document Map item`

A typed row in the aggregate read model. Items may be anchorable or unanchored.

`Document marker`

A small overview-rail marker derived from an anchorable item. Markers are not
the source of truth.

`Anchor`

A target-owned reader locator plus projection metadata. Examples:

- text fragment offsets
- EPUB fragment offsets
- PDF page geometry
- page-level container anchors when exact geometry is unavailable
- highlight anchor
- evidence span resolver output

`Source domain`

The owner that produced the fact:

- `navigation`
- `highlight`
- `reader_apparatus`
- `resource_graph`
- `chat`
- `generated_citation`

`Target status`

The jumpability/truth state of an item or target:

- `exact`: exact target and locator are available.
- `container`: only containing section/page/fragment is available.
- `unanchorable`: the fact is readable but cannot be positioned in the current
  reader.
- `missing`: the target no longer exists.
- `forbidden`: the target exists but the viewer cannot read it.
- `stale`: the source or target changed; snapshot can still be shown.
- `unsupported`: this media kind or source artifact cannot provide the requested
  anchor.
- `partial`: some data is valid, but the owner reports incomplete coverage.

## 7. Target Behavior

### 7.1 Reader toolbar and menu

Desktop:

- The reader toolbar has one `Document Map` affordance.
- The overview rail top action opens the same `Document Map` affordance.
- There is no standalone `Contents` toolbar button after the cutover.
- There is no standalone `Open highlights pane` label after the cutover.

Mobile:

- The reader menu has one `Document Map` option.
- It opens `MobileSecondaryPaneHost` with the same tabs.
- The mobile menu no longer contains separate `Show highlights` and
  `Show contents` options.

Contextual opening:

- Generic affordance opens the `contents` lens when contents exist, otherwise
  the first available lens in canonical order.
- Clicking a highlight marker opens the `highlights` lens focused on that item.
- Clicking a citation marker opens the `citations` lens focused on that item.
- Clicking a connection/chat marker opens the corresponding lens focused on that
  item.

### 7.2 Tabs and order

Canonical order:

1. Contents
2. Highlights
3. Citations
4. Connections
5. Chat

Lens visibility:

- Contents appears when the owner has navigation sections or TOC nodes.
- Highlights appears when highlighting is supported for the media kind, even if
  there are zero highlights, because the lens also owns creation/editing affordance
  context.
- Citations appears only for `reader_apparatus` states `ready` or `partial`.
- Connections appears when the resource graph query succeeds. It may show an
  empty state.
- Chat appears whenever document chat is available for the media item.

Badges:

- Each lens may show a count from the aggregate payload.
- Counts are owner-derived, not recomputed in separate frontend loops.
- Partial/error lens states are visible as subtle status, not swallowed.

### 7.3 Contents lens

The Contents lens:

- Uses canonical reader navigation.
- Preserves nested TOC rendering.
- Shows active section state.
- Jumps through existing reader navigation functions.
- Does not use anchored sidecar projection.
- Provides markers to the overview rail when section positions are available.

### 7.4 Highlights lens

The Highlights lens:

- Shows user highlights in the same Document Map shell.
- Preserves note editing, color updates, delete, quote-to-chat, and linked
  conversation affordances.
- Uses generic anchored sidecar projection on desktop.
- Uses flow layout in the mobile sheet.
- Provides markers to the overview rail for positioned highlights.

Highlight CRUD remains owned by highlight services and routes. The Document Map
read model is not a highlight mutation API.

### 7.5 Citations lens

The Citations lens:

- Shows source-authored apparatus from `reader_apparatus`.
- Uses the label `Citations` for the tab.
- Displays confidence and target status.
- Preserves hover/preview and marker/target activation where supported.
- Keeps source-authored apparatus distinct from generated chat citations.

### 7.6 Connections lens

The Connections lens:

- Shows target-centered graph connections for the current document and its
  current child refs.
- Includes backlinks, note links, cited-by rows, linked highlights, generated
  reading references, manual user links, and synapse/system rows only when they
  are present as readable `resource_edges`.
- Opens the source object through resource graph resolution.
- Jumps to the target passage when anchorable.
- Shows unanchorable/stale/forbidden states honestly.

### 7.7 Chat lens

The Chat lens:

- Lists and opens document chats through the chat owner.
- Starts new document chat through the existing conversation engine.
- Preserves pending quote behavior.
- Uses `ReaderChatDetail`/`DocChatTab` behavior or their renamed Document Map
  equivalents.
- Does not load message history through the Document Map aggregate route.

Linked chats attached to specific passages may appear in Connections or
Highlights as row metadata. Chat history stays in chat APIs.

### 7.8 Overview rail

Desktop overview rail:

- Shows one vertical document rail beside the reader.
- Has a viewport band.
- Shows typed markers by lane/kind:
  - sections
  - highlights
  - citations
  - connections
  - chat/context refs
- Clusters nearby markers.
- Keyboard navigation works across clusters.
- Hover preview shows a compact item summary.
- Click activates the item and opens/focuses the relevant lens.
- The rail is omitted on mobile.

The overview rail is not a second source of truth. It is a projection of
`ReaderDocumentMapMarker` values.

## 8. Capability Contract

### 8.1 Route

FastAPI:

```text
GET /media/{media_id}/document-map
```

Next BFF:

```text
GET /api/media/{id}/document-map
```

The BFF route is a plain proxy through `proxyToFastAPI`. It contains no business
logic, no request rewriting beyond normal proxy behavior, and no fallback to
old routes.

### 8.2 Query parameters

Initial route:

```text
include_unanchored=true|false   default true
limit=N                         default 500, max 1000
```

No lens-specific route params in the initial cutover. The first implementation
loads the complete reader-local map for a single media item. If future scale
requires pagination, it is added as a new explicit contract, not a hidden
fallback to per-lens endpoints.

### 8.3 Response envelope

```json
{
  "data": {
    "media_id": "uuid",
    "media_kind": "web_article",
    "title": "Document title",
    "status": "ready",
    "source_version": {
      "media_updated_at": "2026-06-16T00:00:00Z",
      "content_fingerprint": "..."
    },
    "lenses": [
      {
        "id": "contents",
        "label": "Contents",
        "status": "ready",
        "item_count": 12,
        "anchored_count": 12,
        "unanchored_count": 0
      }
    ],
    "items": [],
    "markers": [],
    "diagnostics": {}
  }
}
```

`status` values:

- `ready`: at least one lens is available and all required owner reads
  succeeded.
- `empty`: media is readable, but there are no map items beyond an empty
  available lens set.
- `partial`: one or more optional owner reads reports partial/failed/unsupported
  state while other items are valid.
- `unsupported`: this media kind cannot support a reader Document Map.
- `failed`: aggregate read failed unexpectedly. The route returns a typed API
  error for defects; `failed` is reserved for owner-reported domain states that
  can be returned safely.

### 8.4 Item union

The response uses a discriminated union. All items share:

```ts
interface ReaderDocumentMapItemBase {
  id: string;
  lens_ids: ReaderDocumentMapLensId[];
  kind: string;
  source_domain:
    | "navigation"
    | "highlight"
    | "reader_apparatus"
    | "resource_graph"
    | "chat"
    | "generated_citation";
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  href: string | null;
  anchor: ReaderDocumentMapAnchor | null;
  document_order_key: string | null;
  document_fraction: number | null;
  target_status: ReaderDocumentMapTargetStatus;
  provenance: ReaderDocumentMapProvenance;
  actions: ReaderDocumentMapAction[];
}
```

`section` item:

```ts
interface ReaderDocumentMapSectionItem extends ReaderDocumentMapItemBase {
  kind: "section";
  source_domain: "navigation";
  section_id: string;
  level: number | null;
  parent_id: string | null;
}
```

`highlight` item:

```ts
interface ReaderDocumentMapHighlightItem extends ReaderDocumentMapItemBase {
  kind: "highlight";
  source_domain: "highlight";
  highlight_id: string;
  color: HighlightColor;
  exact: string;
  note_block_count: number;
  linked_conversation_count: number;
}
```

`apparatus` item:

```ts
interface ReaderDocumentMapApparatusItem extends ReaderDocumentMapItemBase {
  kind: "apparatus";
  source_domain: "reader_apparatus";
  stable_key: string;
  apparatus_kind: ReaderApparatusItemKind;
  confidence: ReaderApparatusConfidence;
  locator_status: ReaderApparatusLocatorStatus;
  target_stable_keys: string[];
}
```

`connection` item:

```ts
interface ReaderDocumentMapConnectionItem extends ReaderDocumentMapItemBase {
  kind: "connection";
  source_domain: "resource_graph" | "generated_citation";
  edge_id: string;
  direction: "incoming" | "outgoing";
  origin: EdgeOrigin;
  edge_kind: EdgeKind;
  source_category: ReaderConnectionSourceCategory;
  other_ref: string;
}
```

`chat_thread` item:

```ts
interface ReaderDocumentMapChatThreadItem extends ReaderDocumentMapItemBase {
  kind: "chat_thread";
  source_domain: "chat";
  conversation_id: string;
  latest_message_at: string | null;
  attached_ref: string | null;
}
```

### 8.5 Anchor contract

```ts
interface ReaderDocumentMapAnchor {
  ref: string;
  media_id: string;
  locator: RetrievalLocator | null;
  page_number: number | null;
  fragment_id: string | null;
  highlight_id: string | null;
  evidence_span_id: string | null;
  order_key: string | null;
  precision: "exact" | "container";
}
```

Rules:

- No edge owns a locator.
- No frontend code invents a locator by scraping DOM geometry.
- PDF exactness comes from stored PDF geometry, native link geometry, or owner
  extraction. Plain text coincidence is not exact.
- `document_fraction` is generated from owner metadata, not rendered DOM.

### 8.6 Marker contract

```ts
interface ReaderDocumentMapMarker {
  id: string;
  item_id: string;
  lens_id: ReaderDocumentMapLensId;
  lane: "contents" | "highlights" | "citations" | "connections" | "chat";
  position: number;
  status: ReaderDocumentMapTargetStatus;
  tone: "neutral" | "highlight" | "citation" | "connection" | "chat" | "warning";
  label: string;
  preview: string | null;
}
```

Rules:

- `position` is clamped to `[0, 1]`.
- Items without a document position do not produce markers.
- Multiple markers can point to the same item when it belongs to multiple
  lenses, but the UI should cluster them rather than draw duplicate indistinct
  ticks.

### 8.7 Lens contract

```ts
type ReaderDocumentMapLensId =
  | "contents"
  | "highlights"
  | "citations"
  | "connections"
  | "chat";

type ReaderDocumentMapLensStatus =
  | "ready"
  | "empty"
  | "partial"
  | "unsupported"
  | "failed";
```

Lens status is owner-derived:

- Contents: reader navigation state.
- Highlights: highlight capability and media support.
- Citations: `reader_apparatus.status`.
- Connections: resource graph query state.
- Chat: chat capability state.

## 9. Backend Architecture

### 9.1 New service

Add:

```text
python/nexus/services/reader_document_map.py
```

Public query:

```python
def get_reader_document_map(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    include_unanchored: bool = True,
    limit: int = 500,
) -> ReaderDocumentMapOut:
    ...
```

The service owns:

- media readability check
- owner read orchestration
- per-domain row adaptation
- document-order normalization
- document-fraction normalization
- lens summaries
- target-status normalization
- final payload validation

The service does not own:

- highlight persistence or mutation
- apparatus extraction or persistence
- resource graph edge storage
- chat message history
- reader navigation extraction
- permissions beyond delegating to owner read functions and the media read gate

### 9.2 Schemas

Add:

```text
python/nexus/schemas/reader_document_map.py
```

or, if the reader schema module remains small enough, add the schema to
`python/nexus/schemas/reader.py`. The preferred final state is a dedicated
schema module to keep the aggregate capability explicit.

Required schema families:

- `ReaderDocumentMapOut`
- `ReaderDocumentMapLensOut`
- `ReaderDocumentMapItemOut`
- item subtypes
- `ReaderDocumentMapAnchorOut`
- `ReaderDocumentMapMarkerOut`
- `ReaderDocumentMapSourceVersionOut`
- `ReaderDocumentMapDiagnosticOut`

### 9.3 Owner adapters

The service should be decomposed by owner:

```text
reader_document_map.py
  get_reader_document_map(...)

reader_document_map_sources/
  navigation.py
  highlights.py
  apparatus.py
  connections.py
  chat.py
  positions.py
  ordering.py
```

If the code remains compact, these can begin as private helpers in the service.
The split becomes mandatory once any helper needs owner-specific tests or
starts importing multiple domain modules.

Adapter rules:

- Adapters translate owner output to `ReaderDocumentMapItemOut`.
- Adapters do not query another owner's private tables directly.
- Adapters do not repair owner data.
- Adapters never silently broaden permissions.
- Adapters preserve owner diagnostics when status is `partial` or `failed`.

### 9.4 Domain owner composition

| Map lens | Owner service | Notes |
|---|---|---|
| Contents | `reader_navigation` | Existing TOC/sections. |
| Highlights | `highlights` | Media-wide projected highlights plus linked note/chat metadata. |
| Citations | `reader_apparatus` | Source-authored only. |
| Connections | `resource_graph.connections` + `reader_connections` anchor logic | Reuse graph query and target-anchor reconstruction. |
| Chat | conversation/chat services | Summary/open/start only; message history stays outside map route. |

### 9.5 Reader connections cleanup

`reader_connections.py` currently combines:

- graph query invocation
- anchor reconstruction
- row presentation
- connection source categorization
- route payload shape

Final state:

- Keep reusable anchor reconstruction and source categorization.
- Move generic target-anchor reconstruction into an owner module usable by
  `reader_document_map`.
- Delete the old `/reader-connections` route and frontend
  `apps/web/src/lib/media/readerConnections.ts` when the Document Map route
  supersedes the product sidecar read.
- Keep generic `/resource-graph/connections/query` for object-level
  connections.

### 9.6 Apparatus cleanup

`reader_apparatus` stays the source owner. Product API exposure changes:

- Existing apparatus service and fixture corpus remain.
- If no external product consumer still needs `GET /media/{media_id}/apparatus`,
  delete that route in the same cutover.
- Apparatus API tests move to the Document Map route for product behavior and
  service/fixture tests for apparatus domain behavior.
- No compatibility BFF route remains under `/api/media/{id}/apparatus`.

### 9.7 Navigation cleanup

Reader navigation remains a first-class reader capability because document
rendering may need it independent of the map sidecar.

Rules:

- Contents lens consumes navigation rows through the aggregate map payload.
- Document rendering may continue to call `/navigation` if needed for section
  loading, active section, or EPUB fragment routing.
- There is no second Contents-specific sidecar API.

### 9.8 Highlight cleanup

Highlight mutation and inline rendering reads remain owned by the highlight
capability.

Rules:

- Document Map reads media-wide highlight rows through the aggregate service.
- Highlight creation, update, delete, note editing, and inline rendering keep
  their existing owner routes.
- If a media-wide highlights endpoint exists only for the overview ruler or
  sidecar listing, replace that consumer with Document Map and delete the
  endpoint only if no other real capability uses it.

### 9.9 Chat cleanup

Document Map does not replace chat.

Rules:

- Chat lens delegates to chat components/services for thread history and send.
- The aggregate route can return thread summaries and attached refs.
- The aggregate route must not return full messages.
- The aggregate route must not become another conversation search endpoint.

### 9.10 Authorization

Required behavior:

- First gate: viewer can read `media:<id>`.
- Owner reads must keep their current permission checks.
- A graph connection row appears only if both the edge and rendered other
  endpoint are readable through resource graph resolution.
- A chat thread appears only if the viewer can read the conversation.
- Forbidden targets return `target_status='forbidden'` only when the existence
  of that target is already permissible to reveal through the owner contract;
  otherwise the row is omitted or marked according to the owner service's
  existing behavior.

## 10. Frontend Architecture

### 10.1 New client contract

Add:

```text
apps/web/src/lib/reader/documentMap.ts
```

It owns:

- TypeScript response types.
- Runtime response validation.
- API fetch wrapper:
  `getReaderDocumentMap(mediaId, options)`.
- Narrow conversion to lens groups and marker lists.
- No React.

Do not parse this payload ad hoc in `MediaPaneBody`.

### 10.2 New instrument component

Add:

```text
apps/web/src/components/reader/ReaderDocumentMapInstrument.tsx
```

or:

```text
apps/web/src/components/reader/document-map/ReaderDocumentMapInstrument.tsx
```

It owns:

- lens tab body composition
- focused item state
- count/status display
- map-row lookup by id
- item activation dispatch
- empty states
- mobile/desktop lens behavior that is specific to the instrument

It does not own:

- workspace shell rendering
- BFF proxying
- highlight mutation logic
- chat message engine
- source extraction

### 10.3 Lens components

Preferred final structure:

```text
apps/web/src/components/reader/document-map/
  ReaderDocumentMapInstrument.tsx
  ReaderDocumentMapContentsLens.tsx
  ReaderDocumentMapHighlightsLens.tsx
  ReaderDocumentMapCitationsLens.tsx
  ReaderDocumentMapConnectionsLens.tsx
  ReaderDocumentMapChatLens.tsx
  ReaderDocumentMapOverviewRail.tsx
  ReaderDocumentMapRowCard.tsx
  documentMapAnchors.ts
  documentMapMarkers.ts
```

Hard cleanup:

- Delete or rename old reader-only surface wrappers when their behavior moves
  into lens components.
- No old `ReaderConnectionsSurface` sidecar path remains if the new
  `Connections` lens owns it.
- No old `ReaderApparatusSurface` product path remains if the new `Citations`
  lens owns it. Domain fixture renderers may keep apparatus-specific names only
  if they are not product sidecar paths.
- `ReaderHighlightsSurface` can survive only if it is the implemented
  Highlights lens component. If so, rename or relocate it so it is clearly part
  of Document Map, not a parallel surface.

### 10.4 MediaPaneBody responsibility after cutover

`MediaPaneBody` should become thinner:

It may own:

- media load state
- reader rendering
- selection/highlight mutation callbacks
- document-map data fetch hook invocation
- publication of one secondary descriptor
- publication of one fixed overview rail
- pane routing and activation integration

It should not own:

- assembling individual reader surface arrays by hand
- computing lens counts and default lens logic inline
- converting domain rows to sidecar rows
- overview marker positioning
- per-lens empty/status copy

If needed, introduce:

```text
apps/web/src/app/(authenticated)/media/[id]/useReaderDocumentMap.ts
```

only if it hides route-level orchestration specific to media panes. Pure map
logic belongs in `apps/web/src/lib/reader/documentMap.ts` or
`components/reader/document-map/*`.

### 10.5 Workspace secondary publication

`paneSecondaryModel.ts` final expectations:

- User-visible group title: `Document Map`.
- Canonical reader lens order.
- No duplicate `reader-tools` and `document-map` groups.
- No stale surface ids if surfaces are renamed.
- Tests assert group membership, order, title, and no old aliases.

`SecondarySurfaceTabs` remains the shared tab contract. Do not build a custom
tab implementation inside the Document Map.

### 10.6 Activation

Document Map item activation routes through existing owners:

- Section item: reader navigation callbacks.
- Highlight item: highlight pulse/focus.
- Apparatus item: existing marker/target activation logic.
- Connection item: `ReaderSourceTarget` or resource graph href.
- Chat item: open document chat detail or full chat pane.

The cutover should centralize activation dispatch in one map-specific function:

```text
activateReaderDocumentMapItem(item, context)
```

This function lives in the frontend reader Document Map layer and delegates to
existing media-pane callbacks. It does not perform DOM queries except through
existing reader pulse/projection helpers.

### 10.7 Overview rail implementation

Replace:

```text
ReaderOverviewRuler
overviewPositions.ts
PositionedHighlight
positionHighlights(...)
```

with:

```text
ReaderDocumentMapOverviewRail
documentMapMarkers.ts
ReaderDocumentMapMarker
positionDocumentMapMarkers(...)
```

or keep filenames only if the exported contract is generic and the old
highlight-only names are removed.

Rules:

- No `onOpenHighlights` prop.
- No `Highlights overview` aria label.
- No marker type that embeds a highlight row directly.
- Marker activation receives `item_id` and lens id.
- Cluster previews are item summaries, not highlight-only previews.

## 11. Duplicate and Repetitive Patterns to Consolidate

### 11.1 Reader sidecar wrappers

Current repeated pattern:

- domain rows
- convert rows to `AnchoredReaderRow`
- create header
- create row card
- pass to `AnchoredSidecarSurface`
- define similar empty/status text

Affected files:

- `ReaderHighlightsSurface.tsx`
- `ReaderApparatusSurface.tsx`
- `ReaderConnectionsSurface.tsx`

Cutover move:

- Extract generic anchor shape.
- Keep one anchored sidecar layout.
- Put lens-specific card rendering behind the Document Map instrument.
- Remove duplicate "surface shell" wrappers that only repeat the same layout.

### 11.2 Row-to-anchor conversions

Current repeated pattern:

- apparatus rows parse locators into anchored rows.
- connection rows parse locators into anchored rows.
- highlights already are anchored rows.

Cutover move:

- Add one `readerDocumentMapAnchorToProjectionRow(...)` helper.
- Ensure PDF geometry parsing, text offset handling, target selector use, and
  order-key behavior are centralized.

### 11.3 Overview positioning

Current repeated pattern:

- `positionHighlights` knows how to place PDF/web/EPUB highlight rows.
- connection/apparatus anchors carry their own order keys and locators.

Cutover move:

- Centralize `document_fraction` calculation in backend where owner metadata is
  available.
- Keep frontend positioning only as validation/projection for markers already
  carrying `document_fraction`.
- Delete highlight-only frontend map positioning once backend positions are
  authoritative.

### 11.4 Reader secondary affordances

Current repeated affordances:

- desktop Contents toolbar button
- mobile Show highlights
- mobile Show contents
- overview ruler Open highlights pane
- implicit secondary tabs

Cutover move:

- One `Document Map` affordance.
- Contextual item/ruler activation may open a specific lens, but no standalone
  old affordance remains.

### 11.5 Product connection rendering

Current related surfaces:

- object-level `ConnectionsSurface`
- reader-level `ReaderConnectionsSurface`
- graph client helpers
- reader connections route/client

Cutover move:

- Object-level `ConnectionsSurface` remains for non-reader resource pages.
- Shared connection row presentation and source-category labels move to one
  module.
- Reader-specific anchored connection display is a Document Map lens.
- Delete `readerConnections.ts` if it is superseded by Document Map.

### 11.6 Agent document map naming

Current duplicate concept:

- `media_document_map.py` is an agent/read-tool section map.
- The product feature is also named Document Map.

Cutover move:

- Prefer renaming the agent service/types to avoid product-name collision.
- At minimum, document the distinction in code comments and architecture docs.

## 12. Hard Cutover Rules

R1. No old reader-tools product affordance remains alongside Document Map.

R2. No old `/api/media/{id}/reader-connections` product read remains if the
Document Map route supersedes it.

R3. No old `/api/media/{id}/apparatus` product read remains if the Document Map
route supersedes it.

R4. No UI silently falls back from Document Map to old per-lens endpoints.

R5. No route-time extraction, route-time repair, or route-time graph
reconstruction beyond normal read-model composition.

R6. No client-side DOM scraping to create citations, connections, or positions.

R7. No edge locators.

R8. No source-authored apparatus in generated citation storage.

R9. No generated chat citation rows in apparatus storage.

R10. No mobile-only implementation fork.

R11. No stale names that imply the old product shape when the file is touched.
Rename or delete `OverviewRuler`, `Open highlights pane`, and sidecar wrappers
whose only job was pre-cutover separation.

R12. No test-only production seams. Tests use public routes/components.

R13. No duplicate parsing or validation of the aggregate payload. One frontend
client validates the API response.

R14. No broad catch/ignore behavior in the aggregate service. Expected owner
states become lens status; defects fail loudly.

## 13. File Plan

### 13.1 Backend add

```text
python/nexus/schemas/reader_document_map.py
python/nexus/services/reader_document_map.py
python/tests/test_reader_document_map_api.py
python/tests/test_reader_document_map_service.py
```

Optional split once service grows:

```text
python/nexus/services/reader_document_map_sources/
  __init__.py
  navigation.py
  highlights.py
  apparatus.py
  connections.py
  chat.py
  positions.py
  ordering.py
```

### 13.2 Backend edit

```text
python/nexus/api/routes/reader.py
python/nexus/services/reader_connections.py
python/nexus/services/reader_apparatus.py
python/nexus/services/highlights.py
python/nexus/services/resource_graph/connections.py
python/nexus/services/resource_graph/resolve.py
python/nexus/services/media_document_map.py
docs/architecture.md
docs/modules/reader-implementation.md
docs/modules/workspace.md
```

### 13.3 Backend delete or rename

Delete if superseded:

```text
GET /media/{media_id}/reader-connections route
GET /media/{media_id}/apparatus route
```

Rename if chosen:

```text
python/nexus/services/media_document_map.py
DocumentMapSection
MediaDocumentMap
get_media_document_map_for_viewer
```

The rename is a naming cleanup for the agent read-tool section map, not a
product behavior change.

### 13.4 Frontend add

```text
apps/web/src/lib/reader/documentMap.ts
apps/web/src/components/reader/document-map/ReaderDocumentMapInstrument.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapContentsLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapHighlightsLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapCitationsLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapConnectionsLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapChatLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapOverviewRail.tsx
apps/web/src/components/reader/document-map/documentMapAnchors.ts
apps/web/src/components/reader/document-map/documentMapMarkers.ts
apps/web/src/app/api/media/[id]/document-map/route.ts
```

### 13.5 Frontend edit

```text
apps/web/src/lib/panes/paneSecondaryModel.ts
apps/web/src/lib/panes/paneSecondaryModel.test.ts
apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx
apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx
apps/web/src/components/workspace/SecondarySurfaceTabs.tsx
apps/web/src/components/workspace/SecondarySurfaceTabs.test.tsx
apps/web/src/components/workspace/MobileSecondaryPaneHost.test.tsx
apps/web/src/components/workspace/SecondaryPaneShell.test.tsx
apps/web/src/lib/workspace/store.test.tsx
apps/web/src/lib/workspace/workspaceRestore.test.ts
apps/web/src/lib/workspace/schema.test.ts
```

### 13.6 Frontend delete or rename

Delete or relocate under `document-map/`:

```text
apps/web/src/components/reader/ReaderOverviewRuler.tsx
apps/web/src/components/reader/ReaderOverviewRuler.module.css
apps/web/src/components/reader/overviewPositions.ts
apps/web/src/components/reader/ReaderConnectionsSurface.tsx
apps/web/src/components/reader/ReaderConnectionsSurface.module.css
apps/web/src/lib/media/readerConnections.ts
apps/web/src/lib/media/readerConnections.test.ts
```

Rename or absorb if still used as lens components:

```text
apps/web/src/components/reader/ReaderHighlightsSurface.tsx
apps/web/src/components/reader/ReaderHighlightsSurface.module.css
apps/web/src/components/reader/ReaderApparatusSurface.tsx
apps/web/src/components/reader/ReaderApparatusSurface.module.css
```

No old component should remain as a parallel product path.

### 13.7 E2E edit/add

```text
e2e/tests/reader-document-map.spec.ts
e2e/tests/reader-overview-ruler.spec.ts   # rename or replace
e2e/tests/reader-pane-tabs.spec.ts        # update to Document Map contract
e2e/tests/workspace.ts                    # update secondary surface typing
```

## 14. API Design Details

### 14.1 Backend ordering

Each item gets:

- `document_order_key`: stable lexical key for ordering within the document.
- `document_fraction`: optional `[0, 1]` position for overview markers.

Ordering by source:

| Source | Order key |
|---|---|
| Section | `section:{ordinal:010d}` |
| Web/transcript fragment highlight | `fragment:{idx:010d}:offset:{start:010d}` |
| EPUB highlight | `section:{ordinal:010d}:offset:{start:010d}` |
| PDF highlight | `pdf:{page:010d}:y:{top}:x:{left}` |
| Apparatus | existing `reader_apparatus.sort_key`, normalized with media position when available |
| Connection | anchor `order_key` from target-owned ref |
| Chat thread | attached target order key, or `chat:{latest_message_at}` when unanchored |

Items with no order key sort after anchored items inside their lens and do not
produce overview markers.

### 14.2 Backend document fractions

Document fraction source by media kind:

- PDF: page number and normalized page geometry.
- EPUB: `reader_navigation` section ordinal and character counts.
- Web article: fragment index and canonical codepoint offsets.
- Transcript/video/podcast: transcript segment time or fragment index when the
  reader supports a transcript-like view.

No frontend DOM geometry is used for whole-document fraction.

### 14.3 Partial owner failures

Owner failures are classified:

- Required owner failed: route returns API error.
- Optional lens owner failed: aggregate status `partial`, lens status `failed`,
  diagnostics include owner name and typed error code.
- Unsupported lens: lens status `unsupported`, lens omitted unless the UI needs
  a diagnosable developer state.

Required owners for a readable media document:

- media readability / permission
- minimal navigation or document span metadata sufficient to define map scope

Optional owners:

- highlights
- apparatus
- connections
- chat thread summaries

### 14.4 Empty states

Examples:

- No highlights: Highlights lens renders empty state and creation affordance
  context where applicable.
- No apparatus: Citations lens omitted if apparatus state is `empty` or
  `unsupported`.
- No connections: Connections lens renders "No connections in this document."
- No chats: Chat lens renders start-new-chat affordance.
- No TOC but readable document: Contents lens can show a single document/root
  row if the reader can still define document span; otherwise omitted.

### 14.5 Source version

The payload includes a source version object so stale UI can be diagnosed:

```ts
interface ReaderDocumentMapSourceVersion {
  media_updated_at: string | null;
  content_fingerprint: string | null;
  apparatus_source_fingerprint: string | null;
  graph_max_updated_at: string | null;
  highlights_max_updated_at: string | null;
}
```

This is diagnostic/versioning metadata, not cache invalidation by itself.

### 14.6 Diagnostics

Diagnostics are structured and small:

```ts
interface ReaderDocumentMapDiagnostics {
  omitted_item_counts: Record<string, number>;
  partial_lenses: string[];
  owner_warnings: Array<{
    owner: string;
    code: string;
    message: string;
  }>;
}
```

No stack traces, SQL text, or sensitive authorization details in payloads.

## 15. UI Design Contract

### 15.1 Visual structure

The Document Map is a work surface, not a marketing panel:

- compact tab row
- dense row lists
- stable counts
- small status pills
- predictable activation buttons
- no nested UI cards inside cards
- no explanatory onboarding copy
- no oversized hero-style text

### 15.2 Accessibility

Required:

- Shared `SecondarySurfaceTabs` tab model.
- `aria-label="Document Map"` on the instrument region.
- Lens tab labels match visible domain names.
- Overview rail has `role="region"` and a non-highlight-only label.
- Rail markers are keyboard reachable.
- Cluster preview is dismissible and not hover-only.
- Item rows have clear button/link semantics.
- Mobile sheet preserves focus behavior from `MobileSecondaryPaneHost`.

### 15.3 Icons

Use lucide icons from the existing workspace icon pattern:

- Document Map affordance: `Map`, `ListTree`, or equivalent existing lucide icon.
- Contents: `ListTree`
- Highlights: `Highlighter`
- Citations: `Quote`
- Connections: `Link2`
- Chat: `MessageSquare` or `FileText` depending on existing icon availability

Do not hand-roll SVGs for these controls.

### 15.4 Copy

Use current, honest labels:

- `Document Map`
- `Contents`
- `Highlights`
- `Citations`
- `Connections`
- `Chat`

Avoid:

- `Reader Tools` as visible product label after cutover.
- `Open highlights pane` for the overview rail.
- `References` when the row is source-authored apparatus or generated
  citations; the domain must be explicit.

## 16. Interaction With Other Systems

### 16.1 Workspace

Document Map is a workspace secondary group publication. It does not create a
new pane type. Pane-local history remains owned by workspace and reader
navigation callbacks.

### 16.2 Pane runtime

Contextual activation requests a specific surface/lens through the existing
secondary-surface request channel. No global singleton reader map state.

### 16.3 Reader rendering

Text/PDF/EPUB readers remain responsible for rendering content and exposing
target attributes needed by projection. The map does not mutate document HTML.

### 16.4 Highlights

Highlight mutation, note editing, linked note blocks, and quote-to-chat stay in
highlight/chat owners. The map reads highlight summaries and positions.

### 16.5 Notes/pages

Note backlinks and note-body refs appear through `resource_edges`. The map does
not parse note bodies directly. Note activation uses existing note pulse and
reader source activation paths.

### 16.6 Resource graph

The map uses target-centered graph reads and endpoint hydration. It does not
create a new relation vocabulary.

### 16.7 Generated intelligence

Library Intelligence and Oracle citations appear as graph citation edges when
they point at the current document or passage. The map opens the generated
artifact/revision through existing hrefs. It does not create a generated-artifact
revision model.

### 16.8 Chat

Document chat remains chat. The map provides entry and context; the chat engine
provides messages, streaming, tool calls, and citations.

### 16.9 Agent tools

Agent `inspect_resource` and read tools keep their prompt-facing section map.
The product Document Map must not depend on agent-tool prompt shapes.

## 17. Implementation Slices

All slices land together as one hard cutover. The sequence is build order, not
compatibility staging.

### S0. Contract tests first

Add failing tests for:

- Document Map API shape.
- Lens order and status.
- Aggregate items from seeded contents/highlights/apparatus/connections/chat.
- Desktop one-affordance behavior.
- Mobile one-sheet behavior.
- Overview rail generic markers.

### S1. Backend aggregate service and schema

- Add `reader_document_map` schema/service.
- Compose navigation, highlights, apparatus, connections, chat summaries.
- Compute order keys and document fractions.
- Add FastAPI route.
- Add BFF route.

### S2. Frontend client and instrument

- Add `lib/reader/documentMap.ts`.
- Add Document Map instrument and lenses.
- Move row rendering and activation into instrument/lens modules.
- Keep domain mutation callbacks passed in from media pane.

### S3. Media pane publication

- Replace inline reader surface assembly in `MediaPaneBody`.
- Publish one Document Map secondary descriptor.
- Replace Contents toolbar button and mobile highlights/contents menu options
  with one Document Map affordance.

### S4. Overview rail

- Replace highlight-only ruler with generic overview rail.
- Feed it aggregate markers.
- Route activation to item/lens focus.
- Rename tests and aria labels.

### S5. Hard cleanup

- Delete superseded BFF/FastAPI reader sidecar reads.
- Delete superseded frontend clients.
- Delete or rename old reader sidecar wrappers.
- Rename agent `media_document_map` if chosen.
- Update docs and source gates to reject old labels/routes.

### S6. Verification

- Run targeted backend tests.
- Run targeted frontend unit/browser tests.
- Run desktop and mobile E2E.
- Run static gates for touched areas.

## 18. Acceptance Criteria

### Product behavior

AC-P1. Desktop reader shows one `Document Map` affordance. No standalone
`Contents` toolbar button remains.

AC-P2. Mobile reader menu shows one `Document Map` option. No separate `Show
highlights` or `Show contents` options remain.

AC-P3. Document Map tabs appear in canonical order: Contents, Highlights,
Citations, Connections, Chat.

AC-P4. Generic Document Map open defaults to Contents when available.

AC-P5. Contextual marker activation opens the matching lens and focuses the
matching item.

AC-P6. Chat lens can start/open document chat without loading message history
through the Document Map API.

### API and backend

AC-B1. `GET /media/{id}/document-map` returns contents, highlights, apparatus,
connections, and chat summaries for a seeded document with all domains present.

AC-B2. Response items use a discriminated union and include source domain,
provenance, target status, order key, and optional document fraction.

AC-B3. The aggregate service does not read graph edges, notes, conversations, or
artifacts the viewer cannot read.

AC-B4. Source-authored apparatus appears only as `source_domain:
"reader_apparatus"` items.

AC-B5. Generated citation/backlink rows appear only through graph connection
items.

AC-B6. Missing/unanchorable/stale targets are represented explicitly, not
discarded silently unless the owner contract requires omission.

AC-B7. FastAPI route is transport-only.

AC-B8. Next BFF route is proxy-only.

### Overview rail

AC-R1. Desktop overview rail is labeled as Document Map or Evidence overview,
not Highlights overview.

AC-R2. Rail markers can represent at least highlights, citations, and
connections in one seeded test.

AC-R3. Rail marker activation opens the Document Map and focuses the item.

AC-R4. Mobile does not mount the overview rail.

### Hard cleanup

AC-C1. No product code calls `/api/media/{id}/reader-connections` after cutover.

AC-C2. No product code calls `/api/media/{id}/apparatus` after cutover if that
route is superseded by Document Map.

AC-C3. No source text contains visible product copy `Reader tools`, `Open
highlights pane`, `Show highlights`, or `Show contents` in reader UI paths.

AC-C4. No old highlight-only overview ruler component remains under its old
contract.

AC-C5. No compatibility alias group or duplicate Document Map group exists.

### Tests

AC-T1. Backend integration test seeds TOC, highlights, linked notes,
source-authored apparatus, incoming citation edges, note-body backlinks, and a
linked document chat, then asserts aggregate payload and permissions.

AC-T2. Frontend browser/component test verifies tab order, counts, keyboard
navigation, row activation, active item preservation, and empty/partial states.

AC-T3. Desktop E2E opens Document Map, moves through every lens, activates at
least one row per populated lens, and observes reader navigation/pulse.

AC-T4. Mobile E2E opens the same instrument in the mobile sheet and verifies
Contents, Highlights, Citations, Connections, and Chat tabs where seeded.

AC-T5. Static source gates reject deleted route/client names and old UI copy.

## 19. Test Plan

Backend:

```bash
cd python && NEXUS_ENV=test uv run pytest -q -m integration tests/test_reader_document_map_api.py
cd python && NEXUS_ENV=test uv run pytest -q -m unit tests/test_reader_document_map_service.py
cd python && NEXUS_ENV=test uv run pytest -q tests/test_reader_connections_routes.py tests/test_reader_apparatus_api.py
```

Frontend:

```bash
cd apps/web && pnpm test -- ReaderDocumentMap
cd apps/web && pnpm test -- MediaPaneBody
cd apps/web && pnpm test -- paneSecondaryModel
cd apps/web && pnpm test -- SecondarySurfaceTabs MobileSecondaryPaneHost SecondaryPaneShell
```

E2E:

```bash
pnpm --dir e2e test reader-document-map.spec.ts
pnpm --dir e2e test reader-pane-tabs.spec.ts
```

Static/source gates:

```bash
rg -n "Open highlights pane|Show highlights|Show contents|Highlights overview" apps/web/src e2e docs
rg -n "reader-connections|readerConnections" apps/web/src python/nexus/api/routes docs
```

The exact commands should be aligned with `make help` before implementation.
Do not run broad `make verify` unless the implementation owner explicitly wants
the full gate.

## 20. Documentation Updates

Update:

- `docs/modules/reader-implementation.md`
- `docs/modules/workspace.md`
- `docs/modules/chat.md`
- `docs/architecture.md`

Required doc changes:

- Document Map is the canonical reader secondary instrument.
- Overview rail is generic desktop fixed chrome.
- Mobile uses `MobileSecondaryPaneHost` only.
- Apparatus remains source-authored and separate from generated citations.
- Connections remain graph-owned.
- Chat remains chat-owned.
- Agent read-tool section map is explicitly not the product Document Map.

## 21. Key Decisions

D1. The final product surface is called `Document Map`; `Evidence Trail` is the
evidence-oriented lens/framing, not a separate surface.

D2. Storage domains are not merged.

D3. Product reader sidecar data comes from one aggregate API.

D4. The aggregate API is a read model, not persistence.

D5. The overview rail becomes generic and marker-driven.

D6. Mobile gets the same Document Map through the existing workspace secondary
sheet.

D7. Source-authored apparatus and generated citations stay separate even when
both appear under the user-visible word "Citations".

D8. Graph connections are target-centered for the reader; edge locators remain
forbidden.

D9. Chat is integrated as a lens and linked evidence source, not converted into
annotations.

D10. The implementation deletes old sidecar clients/routes/surface wrappers when
the aggregate route supersedes them.

## 22. Risks and Mitigations

Risk: The aggregate endpoint becomes a god service.

Mitigation: Keep domain adapters thin and owner-specific. Split
`reader_document_map_sources/*` when helpers grow.

Risk: The map duplicates owner truth.

Mitigation: The aggregate never persists rows and never mutates owner data.

Risk: The UI hides important domain distinctions.

Mitigation: Every item carries `source_domain`, provenance, confidence/status,
and domain-specific rendering.

Risk: The overview rail becomes visually noisy.

Mitigation: Use lanes, clustering, filters through active lens, and compact
previews. Do not show unpositioned items on the rail.

Risk: Deleting old endpoints breaks non-obvious consumers.

Mitigation: Grep and tests first. Delete only when all product consumers have
moved. If a domain capability genuinely needs a route, keep it as the canonical
domain route and make clear it is not a reader sidecar fallback.

Risk: Chat summaries tempt the aggregate into chat history.

Mitigation: Hard response contract forbids full messages. Chat lens delegates to
chat APIs.

## 23. Done Means

Done means a reader has one product instrument for document structure and
evidence. The code has one aggregate map read path, one visible affordance, one
overview rail contract, one mobile sheet path, one integrated test story, and no
old reader sidecar fallback lanes.

The final state should be boring to reason about:

```text
MediaPaneBody
  -> getReaderDocumentMap
  -> ReaderDocumentMapInstrument
  -> workspace secondary shell / mobile sheet
  -> ReaderDocumentMapOverviewRail on desktop

reader_document_map service
  -> reader_navigation
  -> highlights
  -> reader_apparatus
  -> resource_graph connections
  -> chat summaries
```

Every row still knows its owner. The user no longer has to.

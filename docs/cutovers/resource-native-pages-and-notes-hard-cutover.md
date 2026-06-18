# Resource-Native Pages and Notes Hard Cutover

## Status

SPECIFICATION - supersedes the page-document aggregate direction in
`docs/cutovers/notes-pages-object-graph-hard-cutover.md`.

That earlier cutover was a useful bridge from row-owned note trees to graph-owned
containment. The target model is now stricter:

- pages and notes are peer `ResourceRef` items;
- pages have title only;
- notes have one canonical body only;
- all association, ordering, attachment, backlink, context, citation, and
  collection behavior is graph behavior;
- page-vs-note distinction is a UX affordance, not a backend aggregate boundary.

## Type

Hard cutover. No dual-write, no dual-read, no compatibility route, no fallback
to page-document commands, no old payload aliases, no storage shims, no
backward-compatible block-kind or document-version fields.

This is not a migration bridge and not a generic graph database migration. It is
a contract correction: Nexus stores resource items and edges, then exposes
capabilities through one service-owned policy layer.

## Precedents and Repo Rules

- `docs/cutovers/resource-graph-product-spine-hard-cutover.md` establishes
  `resource_edges` as the product-spine connection table.
- `docs/cutovers/notes-pages-object-graph-hard-cutover.md` already proved that
  parentage/order do not belong on `note_blocks`; this cutover removes the
  remaining page-document special case.
- `docs/cutovers/media-document-readiness-hard-cutover.md` is the local pattern
  for capability projection: public behavior asks "what can this resource do?"
  instead of making one overloaded status or type answer every question.
- `docs/rules/cleanliness.md` requires one owner per concern and no fallback
  lanes.
- `docs/rules/cleanliness.md` requires one primary API per capability.
- `docs/rules/layers.md` keeps BFF/routes thin and puts business behavior in
  services.
- `docs/rules/database.md` requires explicit cleanup, SELECT-then-write, and
  serializable retry boundaries for sequential-equivalence mutations.

## North Star

Nexus has one resource graph. Pages and notes are just two resource item shapes
inside it.

```text
page:<id>       title resource
note_block:<id> body resource
media:<id>      document/media resource
highlight:<id>  quote resource
...
```

Any resource can organize, link to, attach, cite, support, contradict, embed, or
contextualize another resource through graph-owned connection facts. The product
may render pages as collection surfaces and notes as writing surfaces, but the
backend must not encode "page owns note document" as a special aggregate.

The Roam-style invariant:

> A page is a titled node. A note is a bodied node. A page collecting notes is
> just ordered outgoing edges. A note collecting pages, notes, media, or
> highlights is the same mechanism.

## SME Thesis

A subject matter expert would not keep `Page.document_version`,
`Page.description`, `PageDocumentMutation`, `PatchPageDocumentRequest`,
`resource_graph.documents`, `note_containment`, or `NoteBlock.block_kind` as
production concepts after accepting this model.

Those names encode a page-special document aggregate. They make pages act like a
document container while notes act like children. That is the wrong ontology.

The professional model is:

- `ResourceRef` is the identity grammar.
- Resource item tables own only intrinsic resource payload.
- `resource_edges` owns all relationships and ordered adjacency.
- A generic resource version service owns concurrency by resource lane.
- A generic resource mutation ledger owns idempotency by resource lane.
- A resource capability registry owns read/link/cite/attach/search/context
  behavior.
- Search and prompt assembly consume capability decisions, not scattered
  allowlists or open graph traversal.

## Current Head Facts

Current code still has the old aggregate:

- `pages.description` and `pages.document_version` live on `Page`.
- `page_document_mutations` is a page-specific idempotency ledger.
- `note_blocks.block_kind`, `body_pm_json`, `body_markdown`, and `body_text`
  live on `NoteBlock`.
- `resource_edges.origin='note_containment'` stores ordered page/block document
  structure.
- `resource_graph.documents` loads and mutates `PageDocument`.
- `notes.py` owns `patch_page_document`, full-page command validation, page
  version conflict checks, body writes, containment rewrites, highlight-note
  mutations, quick capture, and response projection.
- Frontend `PagePaneBody` and `pageDocumentPersistence.ts` assemble page-document
  commands with `baseDocumentVersion`, `blockKind`, `sourceOrderKey`,
  `parentBlockId`, `collapsed`, and `bodyPmJson`.
- Search, read, context, and citation behavior rely on several local lists:
  `_READABLE_SCHEMES`, `_CITABLE_RESULT_TYPE`, `SEARCH_SCOPE_SCHEMES`,
  `APP_SEARCH_SCOPE_TARGET_SCHEMES`, `NOTE_MEDIA_SCOPE_ORIGINS`,
  `CONVERSATION_CONTEXT_SCOPE_ORIGINS`, frontend connection origin lists, and
  note/page result-specific unions.

Those are the seams this cutover removes or centralizes.

## Goals

G1. Make pages title-only resource items.

G2. Make notes body-only resource items.

G3. Delete the page-document aggregate from storage, service, API, frontend, and
tests.

G4. Delete note block kind as a row-level concept. The note body editor schema
may represent code, embeds, tasks, images, marks, and references, but the row
does not have a type.

G5. Replace `note_containment` with generic ordered adjacency over
`resource_edges`.

G6. Allow any supported resource item to be a collection source when its
capability policy allows ordered outgoing edges.

G7. Keep resource concurrency, but move it out of pages and into generic
resource/lane versioning.

G8. Keep idempotency, but move it out of page-document mutations and into
generic resource/lane mutation records.

G9. Consolidate item capability policy so linkable/readable/citable/attachable/
contextable/searchable/expandable behavior has one owner.

G10. Keep page search conservative during the cutover: page result means title
match only. First-level expansion of linked items is a named future policy, not
implicit graph traversal.

G11. Preserve evidence-grade AI behavior by making note/page reads, search
results, and citations flow through shared item capability and retrieval
contracts.

G12. Delete every legacy branch, alias, and test that exists only to keep the
page-document model alive.

## Non-Goals

- No graph database.
- No RDF/JSON-LD runtime store.
- No open-ended graph traversal for search or prompt assembly.
- No multi-user collaborative editing.
- No CRDT implementation.
- No page-body field.
- No note-row kind field.
- No old page-document API compatibility.
- No fallback to `note_containment`.
- No relation verbs such as `contains`, `embeds`, `references`,
  `tagged_with`, or `attaches`.
- No user-controllable recursive expansion until a separate expansion policy is
  specified and tested.
- No broad redesign of media ingestion, Library Intelligence, Oracle, or chat
  beyond their item-capability integration points.

## Final Ontology

### Resource Items

A resource item is an addressable thing with a `ResourceRef`.

`page:<id>`:

- intrinsic payload: title;
- no body;
- no description;
- no document version;
- no child list;
- no containment semantics.

`note_block:<id>`:

- intrinsic payload: one canonical body;
- no block kind;
- no parent;
- no order;
- no collapsed state;
- no page ownership.

Other resource schemes keep their existing intrinsic owners. This cutover does
not fold media, libraries, highlights, messages, contributors, podcasts, or
generated artifacts into one table.

### Resource Edges

`resource_edges` remains the durable connection table, but ordered collection
behavior is generic.

An ordered collection is:

```text
source_ref -> target_ref
kind = context
origin = user or another owning writer
source_order_key = ordered position under source_ref
ordinal = null
snapshot = null except origins that explicitly own snapshots
```

Rules:

- `source_order_key` orders targets in the source resource's outgoing adjacency.
- `source_order_key` is not page-specific.
- `source_order_key` is not note-specific.
- The same target may appear under many sources.
- A note may appear under many pages.
- A note may appear under many notes.
- A page may appear under a note.
- A media item may appear under a page or note.
- Cycles are allowed at the graph level. Rendering and expansion policy decide
  traversal behavior and must dedupe.
- Single-parent checks are deleted.
- `target_order_key` remains forbidden unless a separate multi-endpoint
  occurrence policy ships.

### Resource Versions

Concurrency is still required, but versions belong to resource lanes, not
`pages`.

Add or adapt a generic owner:

```text
resource_versions(
  id uuid primary key,
  user_id uuid not null,
  resource_scheme text not null,
  resource_id uuid not null,
  lane text not null,
  version integer not null,
  content_hash text null,
  updated_at timestamptz not null,
  unique(user_id, resource_scheme, resource_id, lane)
)
```

Required lanes:

- `title` for `page`;
- `body` for `note_block`;
- `outgoing_edges` for ordered adjacency of any capable source resource.

Optional future lanes:

- `view_state`;
- `metadata`;
- `generated_projection`.

Rules:

- A mutation declares the resource lanes it intends to change and their base
  versions.
- A stale lane version returns a typed conflict with current lane versions and
  current resource projection.
- Versions are service-owned protocol state, not resource payload.
- No page row stores document concurrency.

### Resource Mutations

Replace `page_document_mutations` with a generic idempotency ledger:

```text
resource_mutations(
  id uuid primary key,
  user_id uuid not null,
  mutation_scope text not null,
  client_mutation_id text not null,
  request_hash text not null,
  changed_lanes jsonb not null,
  response_json jsonb not null,
  created_at timestamptz not null,
  unique(user_id, mutation_scope, client_mutation_id)
)
```

`mutation_scope` examples:

- `resource:page:<id>:title`;
- `resource:note_block:<id>:body`;
- `resource:<scheme>:<id>:outgoing_edges`;
- `resource_surface:<scheme>:<id>` for a compound UX save that updates body/title
  plus adjacency in one serializable transaction.

Rules:

- Replay with the same request hash returns the recorded response.
- Replay with a different request hash returns idempotency conflict.
- The ledger is generic and must not mention pages or notes in table names.

## Final Data Model

### `pages`

Keep:

- `id`;
- `user_id`;
- `title`;
- `created_at`;
- `updated_at`.

Drop:

- `description`;
- `document_version`.

### `note_blocks`

Keep:

- `id`;
- `user_id`;
- `body_pm_json`;
- `body_text`;
- `created_at`;
- `updated_at`.

Drop:

- `block_kind`;
- `body_markdown`, unless a separate export-cache owner can justify it. Default
  cutover deletes the column and derives markdown on demand.

Rules:

- `body_pm_json` is the canonical lossless editor body while ProseMirror is the
  editor.
- `body_text` is a generated projection for search, snippets, prompt rendering,
  and low-cost resolution.
- Markdown is interchange/export text, not canonical storage.
- Every note uses the same body schema and the same editor.

### `resource_edges`

Keep:

- `id`;
- `user_id`;
- `kind`;
- `origin`;
- source scheme/id;
- target scheme/id;
- `source_order_key`;
- `target_order_key` as reserved/forbidden;
- `ordinal`;
- `snapshot`;
- `created_at`.

Change:

- remove `note_containment` from `EdgeOrigin`;
- remove note-containment DB checks and partial indexes;
- allow `source_order_key` for generic ordered adjacency according to the edge
  policy registry;
- delete uniqueness that enforces a single containment parent;
- keep duplicate prevention scoped to the edge shape, writer, and ordered
  adjacency contract.

Required indexes:

- lookup by `(user_id, source_scheme, source_id, source_order_key, id)` for
  ordered adjacency;
- lookup by `(user_id, target_scheme, target_id, created_at, id)` for incoming
  connections;
- origin/kind/source/target indexes only when a production query needs them.

### View State

Do not store collapse/focus state on pages, notes, or edges as resource truth.

Use a surface-specific view-state owner:

```text
resource_view_states(
  id uuid primary key,
  user_id uuid not null,
  surface_scheme text not null,
  surface_id uuid not null,
  edge_id uuid null,
  target_scheme text null,
  target_id uuid null,
  state jsonb not null,
  updated_at timestamptz not null
)
```

Rules:

- View state is keyed by surface and optionally edge occurrence.
- Deleting an edge deletes or invalidates its edge-specific view state through
  explicit cleanup.
- View state never affects search, citation, or graph semantics.

## Capability Contract

Add one backend service:

```text
python/nexus/services/resource_items/
  __init__.py
  capabilities.py
  registry.py
  resolve.py
  read.py
  citations.py
  search.py
  expansion.py
  mutations.py
```

This package owns item-level product behavior. It does not replace the domain
owners for media, notes, pages, highlights, contributors, or generated artifacts.
It delegates per-scheme reads to existing owners and centralizes the public
capability contract.

### Resource Item Capability

Each `ResourceScheme` has one policy entry:

```python
@dataclass(frozen=True, slots=True)
class ResourceItemCapability:
    scheme: ResourceScheme
    intrinsic_owner: str
    route: Callable[[ResourceRef], str | None]
    label: Callable[[LoadedResource], str]
    summary: Callable[[LoadedResource], str]
    readable: Literal["none", "inline", "document", "exact"]
    citable: Literal["never", "search_result", "direct_snapshot"]
    attachable: bool
    linkable: bool
    adjacency_source: bool
    adjacency_target: bool
    search_result_type: str | None
    search_scope: Literal["none", "direct", "conversation_only"]
    prompt_render: Literal["none", "label", "inline_body", "quote"]
    expansion: Literal["none", "explicit_first_level", "future_policy"]
```

Required helper surface:

- `get_resource_capability(ref: ResourceRef) -> ResourceItemCapability`
- `resolve_resource_items(db, viewer_id, refs) -> list[ResolvedResourceItem]`
- `assert_resource_visible(db, viewer_id, ref) -> None`
- `read_resource_item(db, viewer_id, ref) -> ResourceReadResult`
- `citation_for_resource_item(db, viewer_id, ref) -> RetrievalCitation | None`
- `search_result_for_resource_item(db, viewer_id, ref) -> SearchResultOut | None`
- `ordered_adjacency_for_source(db, viewer_id, source_ref) -> list[EdgeOut]`
- `replace_ordered_adjacency(...) -> ResourceMutationResult`
- `expand_resource_for_context(..., policy) -> list[ResourceRef]`

### Lists to Delete or Fold Into the Registry

Backend:

- `_READABLE_SCHEMES` in `agent_tools/read_resource.py`;
- `_SCOPE_NOT_READABLE_SCHEMES` in `agent_tools/read_resource.py`;
- `_CITABLE_RESULT_TYPE` in `context_assembler.py`;
- `SEARCH_SCOPE_SCHEMES` in `resource_graph/refs.py`;
- `APP_SEARCH_SCOPE_TARGET_SCHEMES` in `resource_graph/policy.py`;
- `NOTE_MEDIA_SCOPE_ORIGINS` as a search decision;
- `CONVERSATION_CONTEXT_SCOPE_ORIGINS` as a scattered list outside the graph
  policy/capability layer;
- result-type-specific citable/readable branches in `read_resource`,
  `_present_read`, `context_assembler`, and `chat_runs` where they duplicate
  capability facts.

Frontend:

- duplicate `ObjectType` and `ResourceScheme` lists when they drift from backend
  `ResourceScheme`;
- hard-coded note block kind lists;
- connection panel origin lists not derived from one surface policy;
- ad hoc resource chip behavior in search, chat, panes, and connections.

The registry is not a runtime plugin system. It is a closed, typed compile-time
contract with tests that require one policy per scheme.

## Edge Policy Contract

Keep `resource_graph.policy`, but narrow its purpose:

- It owns edge shape and writer invariants.
- It does not own "is this item readable?".
- It does not own "can app_search scope to this?".
- It does not own prompt rendering.

`origin` remains writer/provenance, not relation type. `note_containment` is
deleted because it encodes a page-document relation. Other origins remain if
they still name real writers:

- `user` for user-created explicit links and ordered adjacency;
- `note_body` for links derived from canonical note body;
- `highlight_note` for highlight-owned attached note edges, unless folded into
  user adjacency by a separate product decision;
- `citation` for ordinal/snapshot citation edges;
- `system` for system-attached context edges;
- `synapse` for machine-proposed connections.

Rules:

- Product relation words never become `kind`.
- `kind` remains `context | supports | contradicts`.
- Ordered adjacency uses `source_order_key`, not a new relation kind.
- Public unordered connection create stays user-origin and cannot set snapshots
  or ordinals.
- Ordered adjacency writes go through a named resource adjacency service, not the
  generic public edge create route.

## Target Behavior

### Page Behavior

- Creating a page creates a page item with title only.
- Renaming a page changes only the page title lane.
- Opening a page shows its title and an ordered surface of outgoing adjacency
  items.
- Adding a note to a page creates or links a `note_block` item and writes an
  ordered `page -> note_block` edge.
- Adding media, highlights, pages, conversations, messages, or other
  supported refs to a page writes ordered outgoing edges when capability permits.
- A page can appear inside another page or note like any other resource item.
- Page search matches title only in this cutover.
- Page prompt context renders title only in this cutover.

### Note Behavior

- Creating a note creates a note item with one canonical body.
- Editing a note changes only its body lane.
- The note body can contain inline refs, embeds, code, images, tasks, or
  future editor constructs through the body schema.
- Inline refs/embeds replace-set `origin=note_body` edges from the note to
  referenced resources.
- A note can also have explicit ordered outgoing adjacency independent of its
  inline body refs.
- A note can appear in any number of page or note surfaces.
- Note search matches body text through the shared content/evidence index.
- Note read returns exact body text and can be citable when the item capability
  says note bodies are citable.

### Highlight Notes

Highlight notes are ordinary note items related to a highlight.

The highlight UX may create or focus a note, but storage remains:

```text
highlight:<id> -> note_block:<id>
```

with the owning origin selected by edge policy. The note itself has no
highlight-specific row shape, kind, or parent.

### Backlinks and Connections

Backlinks are read models over `resource_edges`.

- Store forward edges once.
- Compute incoming/outgoing connections from graph queries.
- Render connections through `resource_graph.connections` plus item capability
  hydration.
- Do not create backlink tables.
- Do not make backlinks authoritative.

### Search

Immediate cutover:

- `page` search: title only.
- `note_block` search: body only.
- `media`, `highlight`, `fragment`, `content_chunk`, `message`, `conversation`,
  `contributor`, and generated artifact search keep their existing owners
  unless explicitly changed.
- Attached page context does not implicitly search linked items.
- Attached note context does not implicitly search linked items.
- Ordered adjacency does not widen search scope by default.

Future explicit expansion:

- Capability registry may allow first-level expansion for selected surfaces.
- Expansion must specify max depth, edge filters, dedupe, cycle handling, budget,
  ordering, and user control.
- Expansion must be testable and visible in prompt/search ledger output.
- No caller may traverse graph edges ad hoc.

### Citations and Reads

Every citable item path goes through the same capability contract:

- search result to retrieval citation;
- attached context citation;
- `read_resource` citation;
- prompt rendering citation;
- frontend citation activation.

Rules:

- If an item is readable but non-citable, the registry says so.
- If an item is citable, the registry names the result type and locator contract.
- `read_resource` does not maintain its own readable/citable scheme list.
- `_present_read` does not decide citability from local scheme branches.
- `context_assembler` does not maintain `_CITABLE_RESULT_TYPE`.
- `chat_runs` does not infer citation targets through parallel result-type maps.

## API Design

### Backend Service API

Add semantic commands and queries. Names below are illustrative but the behavior
is required.

```python
resolve_resource_items(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
) -> list[ResolvedResourceItem]

read_resource_item(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
) -> ResourceReadResult

get_resource_surface(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
) -> ResourceSurface

mutate_resource_surface(
    db: Session,
    *,
    viewer_id: UUID,
    command: ResourceSurfaceMutation,
) -> ResourceSurfaceMutationResult

update_resource_body(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    body: ResourceBodyInput,
    base_version: int,
    client_mutation_id: str,
) -> ResourceBodyMutationResult

update_page_title(
    db: Session,
    *,
    viewer_id: UUID,
    page_id: UUID,
    title: str,
    base_version: int,
    client_mutation_id: str,
) -> ResourceTitleMutationResult
```

### HTTP Routes

Routes stay thin. They parse refs, validate payloads, call services, and return
response envelopes.

Preferred route family:

```text
POST /api/resource-items/resolve
GET  /api/resource-items/{resource_ref}
GET  /api/resource-items/{resource_ref}/surface
PATCH /api/resource-items/{resource_ref}/title
PATCH /api/resource-items/{resource_ref}/body
PUT  /api/resource-items/{resource_ref}/adjacency
POST /api/resource-items/{resource_ref}/mutations
```

Compatibility routes are deleted, not aliased:

- delete page-document patch route;
- delete page-document get route;
- delete block-kind payloads;
- delete `baseDocumentVersion` page-specific naming;
- delete page-document mutation response shape.

Existing product routes may remain only when they name a real product workflow:

- highlight quick note route can remain if it delegates to resource item body
  and adjacency services;
- daily note route can remain if it resolves/creates a page item for a local
  date and delegates to generic item mutation;
- share capture route can remain if it creates a note item or page item through
  generic services.

### Frontend API

Replace page-document DTOs with resource surface DTOs.

Delete:

- `NoteBlockKind`;
- `blockKind`;
- `documentVersion` on `NotePage`;
- `baseDocumentVersion`;
- `SaveNotePageDocument*`;
- `pageDocumentPersistence` as page-document command planning.

Introduce:

```ts
interface ResourceItem {
  ref: string;
  label: string;
  summary: string;
  route: string | null;
  capabilities: ResourceItemCapabilities;
  versionByLane: Record<string, number>;
}

interface ResourceSurface {
  source: ResourceItem;
  orderedItems: ResourceSurfaceItem[];
}

interface ResourceSurfaceItem {
  edgeId: string;
  target: ResourceItem;
  sourceOrderKey: string;
  viewState?: Record<string, unknown>;
}

interface SaveResourceSurfaceInput {
  clientMutationId: string;
  baseVersions: Array<{ ref: string; lane: string; version: number }>;
  title?: string;
  bodyPmJson?: Record<string, unknown>;
  orderedTargets?: Array<{ ref: string; sourceOrderKey: string }>;
  deletedEdgeIds?: string[];
}
```

Frontend editor rules:

- The page surface and note surface use the same resource surface model.
- The note editor always writes the same body shape.
- There is no visual state that requires a note row kind.
- Code blocks, embeds, refs, tasks, images, and headings are body nodes or marks.
- Local draft persistence stores resource refs, lane versions, body JSON, and
  ordered target refs, not page-document blocks.

## Backend Architecture

### Services to Keep and Adapt

`resource_graph.refs`:

- remains the pure `ResourceRef` grammar owner;
- remove search-scope constants from this module once `resource_items`
  capability registry exists.

`resource_graph.edges`:

- remains generic edge writer;
- keep flush-only behavior;
- delegate shape policy to `resource_graph.policy`;
- no page-document special cases.

`resource_graph.policy`:

- remains edge shape policy;
- remove `note_containment`;
- define source-order policy for generic ordered adjacency.

`resource_graph.connections`:

- remains graph read model for incoming/outgoing connections;
- use `resource_items.resolve` for target/source hydration.

`resource_graph.cleanup`:

- remains polymorphic edge cleanup owner;
- add explicit cleanup for generic resource versions, mutations, view states, and
  ordered adjacency.

`resource_graph.resolve`:

- either becomes an internal adapter under `resource_items.resolve` or is folded
  into that package;
- no parallel presentation logic.

`note_indexing`:

- remains projection owner for note body indexing;
- no page-document traversal;
- index note items by body;
- optionally index page title through page search owner.

`content_indexing`:

- remains shared content/evidence projection owner;
- no page-document assumptions.

### Services to Delete or Replace

Delete:

- `resource_graph.documents`;
- `PageDocument` dataclasses;
- `OrderedChildBlock`;
- `DocumentBlock`;
- page document mutation helpers;
- note-containment cycle/single-parent helpers;
- page-document command builders.

Replace:

- `notes.py` as a page-document god service with smaller owners:
  - `pages.py` for page item title lifecycle;
  - `note_bodies.py` for note body lifecycle and body-derived edge sync;
  - `resource_items.mutations` for generic versions/idempotency;
  - `resource_items.surfaces` or `resource_graph.adjacency` for ordered outgoing
    edges.

### Routes

`python/nexus/api/routes/notes.py` should stop owning page-document routes. It
may keep simple page/note convenience routes only if they are thin wrappers over
resource item services and use current names.

`python/nexus/api/routes/resource_graph.py` should not grow item behavior.
Graph routes manage edge/query concerns. Resource item routes manage item
capabilities and surface mutations.

`python/nexus/api/routes/conversation_context.py` should consume item capability
for attachability and prompt behavior, not local scheme lists.

### Schemas

`python/nexus/schemas/notes.py` should shrink:

- page create/update title schemas;
- note body schemas;
- body PM JSON validation.

Delete from notes schemas:

- `NOTE_BLOCK_KINDS`;
- `NoteBlockOut.block_kind`;
- `NotePageSummaryOut.description`;
- `NotePageSummaryOut.document_version`;
- `PatchPageDocumentRequest`;
- `PatchPageDocumentResponse`;
- `PageDocumentBlockRequest`;
- `PageDocumentContainmentRequest`;
- `PageDocumentParentRef`;
- `PageDocumentChildRequest`.

Add resource item schemas in a new module:

```text
python/nexus/schemas/resource_items.py
```

## Composition With Existing Systems

### Chat Context

Conversation context refs remain graph edges from `conversation:<id>` to a
target ref. The context service asks `resource_items` whether a target is
attachable, readable, prompt-renderable, citable, and searchable.

Prompt rendering uses `resource_items.read/resolve`, not a local renderer per
scheme.

### `read_resource`

`read_resource` becomes a thin tool wrapper:

- parse URI;
- check conversation admission;
- call `resource_items.read_resource_item`;
- return the standardized read result;
- attach citation metadata if `resource_items.citations` supplies it.

### `app_search`

`app_search` keeps search orchestration but uses item capability for:

- explicit scope eligibility;
- default conversation scope discovery;
- page/note context behavior;
- expansion policy when it eventually ships.

No search code may traverse graph edges directly except through named scope or
expansion helpers.

### Search Result Projection

`schemas.search.SEARCH_RESULT_TYPES` remains the result-type authority until the
resource item registry replaces or feeds it.

Every result type must map to:

- a `ResourceRef`;
- a capability policy;
- a route;
- a citable locator policy when citable;
- a prompt/read behavior.

### Retrieval and Citations

`retrieval_citation.py` remains the single validated telemetry row writer.
`resource_graph.citations` remains the graph citation edge writer.

This cutover removes duplicated citable-result maps and makes both writers
consume `resource_items.citations`.

### Library Intelligence and Oracle

Generated artifacts remain durable resources. Their current citation behavior is
not changed except that readable/citable/prompt behavior must be declared in the
capability registry.

Library Intelligence must not start traversing user note/page adjacency unless a
product policy says those resources are in scope.

### Synapse

Synapse scans capable resource items. It asks `resource_items` whether a ref is
scannable/readable and uses graph edges for suggestions. It must not rely on
page-document containment.

### Highlights

Highlights remain quote resources. Highlight notes are ordinary notes connected
by graph edges. Highlight sidebars resolve note items through `resource_items`,
not a highlight-specific note DTO with body-kind assumptions.

### Vault / Import / Export

Vault import/export must serialize resource items and edges:

- pages as title items;
- notes as body items;
- ordered adjacency as graph edges;
- body-derived refs as graph edges or regenerable projections from body;
- versions/mutations are not portable content unless explicitly included as
sync metadata.

Markdown export is derived from canonical body JSON.

## Migration Plan

### M1. Add Generic Infrastructure

- Add `resource_versions`.
- Add `resource_mutations`.
- Add optional `resource_view_states`.
- Add `resource_items` capability registry.
- Add resource item schemas.
- Add tests proving every `ResourceScheme` has one capability entry.

### M2. Remove Page Payload Drift

- Drop `pages.description`.
- Move `pages.document_version` into `resource_versions(page, title)` and
  `resource_versions(page, outgoing_edges)` as needed.
- Remove page description from search, read, resolve, object refs, tests, and
  frontend DTOs.
- Page search becomes title-only.

### M3. Remove Note Kind and Markdown Storage

- Drop `note_blocks.block_kind`.
- Drop `note_blocks.body_markdown` unless a justified export cache remains under
  a different owner.
- Keep `body_pm_json`.
- Keep `body_text` as generated projection.
- Remove note kind unions from backend and frontend.
- Remove editor logic that persists row-level kind.
- Represent all visual/content differences inside PM body schema.

### M4. Replace Page Document Aggregate

- Add generic ordered adjacency service.
- Backfill `origin='note_containment'` edges to generic ordered `user` adjacency
  or the selected ordered-adjacency origin.
- Preserve order keys.
- Preserve edge ids only if doing so does not keep old origin semantics. If edge
  ids must change, update dependent view-state/projection rows in the same
  migration.
- Delete single-parent constraints.
- Delete cycle checks as graph invariants.
- Delete `resource_graph.documents`.
- Delete page-document API routes and schemas.
- Replace frontend persistence with resource surface persistence.

### M5. Consolidate Capability Lists

- Fold readable/citable/search-scope/prompt-render lists into
  `resource_items.capabilities`.
- Make `read_resource`, `context_assembler`, `app_search`, search projection, and
  frontend item chips consume the registry.
- Keep edge shape policy separate from item capability policy.

### M6. Rebuild Tests and Negative Gates

- Delete tests that only prove page-document compatibility.
- Add negative tests for forbidden old names and old columns.
- Add behavior tests for resource parity.
- Add migration tests for hard deletes/backfills.

## Acceptance Criteria

AC1. `pages` has no `description`.

AC2. `pages` has no `document_version`.

AC3. No production code references `Page.document_version`,
`base_document_version`, `documentVersion`, or page-document version names.

AC4. `resource_versions` owns title/body/outgoing-edge concurrency.

AC5. `page_document_mutations` does not exist.

AC6. `resource_mutations` owns idempotency for resource item and adjacency
mutations.

AC7. `note_blocks` has no `block_kind`.

AC8. No backend or frontend production code has `NoteBlockKind`,
`NOTE_BLOCK_KINDS`, `blockKind`, or `block_kind` except negative gates or
historical docs.

AC9. `note_blocks.body_pm_json` is the canonical note body while ProseMirror is
the editor.

AC10. `note_blocks.body_text` is generated only from the canonical body.

AC11. `note_blocks.body_markdown` is deleted, or if retained, renamed/reowned as
a generated export cache with tests proving it is never write authority.

AC12. `resource_edges.origin` no longer allows `note_containment`.

AC13. No production code references `note_containment` except migration history
and negative tests.

AC14. Ordered adjacency works from any capable source resource to any capable
target resource.

AC15. The same note can be linked from two pages without conflict.

AC16. The same note can be linked from a page and a note without conflict.

AC17. A page can link to a page, note, media item, highlight, conversation,
message, or other capability-allowed resource.

AC18. A note can link to the same capability-allowed targets.

AC19. Deleting a page deletes or cleans its outgoing ordered adjacency, versions,
mutations, and view state through explicit application cleanup.

AC20. Deleting a note deletes or cleans its outgoing adjacency, incoming
non-snapshot edges according to graph cleanup policy, versions, mutations, body
projections, and view state.

AC21. Page search matches title only.

AC22. Note search matches body text through the shared content/evidence pipeline.

AC23. Page prompt context renders title only unless an explicit expansion policy
is selected.

AC24. Note prompt context renders note body only unless an explicit expansion
policy is selected.

AC25. No search code performs open graph traversal.

AC26. No page-linked item affects search scope until a named expansion/scope
policy says it does.

AC27. `read_resource`, attached context citation materialization, search result
citation materialization, and prompt rendering consume the same resource item
capability registry.

AC28. Every `ResourceScheme` has exactly one item capability policy entry.

AC29. Every `ResourceScheme` has a tested decision for linkable, attachable,
readable, citable, searchable, prompt-renderable, adjacency-source,
adjacency-target, and expandable.

AC30. Edge shape policy remains separate from item capability policy.

AC31. Public unordered connection create cannot create citations, snapshots, or
system/machine edges.

AC32. Ordered adjacency writes go through the resource adjacency service and
enforce source/target capabilities.

AC33. Frontend and backend resource scheme vocabularies cannot drift silently.

AC34. Frontend page and note surfaces use the same resource surface persistence
model.

AC35. The editor saves one note body shape everywhere.

AC36. Highlight notes are ordinary note items linked to highlights.

AC37. Daily notes are ordinary page items linked to a local date identity.

AC38. Vault import/export serializes resource items and edges without
page-document payloads.

AC39. Tests fail if old page-document route names, DTO names, columns, or
services are reintroduced.

AC40. The implementation has no compatibility branch for old page-document
payloads.

## Negative Gates

Add or update `python/tests/test_cutover_negative_gates.py` and frontend guard
tests to reject:

- `Page.description`;
- `Page.document_version`;
- `page_document_mutations`;
- `PatchPageDocumentRequest`;
- `PatchPageDocumentResponse`;
- `PageDocument`;
- `resource_graph.documents`;
- `note_containment`;
- `NoteBlock.block_kind`;
- `NoteBlock.body_markdown` unless retained under a new explicit export-cache
  owner;
- `NoteBlockKind`;
- `blockKind`;
- `baseDocumentVersion`;
- `/notes/pages/{id}/document`;
- page-document persistence helpers;
- route handlers containing graph invariants;
- search code importing resource graph policy constants directly when it should
  consume item capabilities.

## Test Plan

Backend targeted tests:

```text
python/tests/test_migrations.py
python/tests/test_resource_items.py
python/tests/test_resource_item_capabilities.py
python/tests/test_resource_versions.py
python/tests/test_resource_mutations.py
python/tests/test_resource_adjacency.py
python/tests/test_resource_graph_edges.py
python/tests/test_resource_graph_policy.py
python/tests/test_resource_graph_connections.py
python/tests/test_notes.py
python/tests/test_search_scope_matrix.py
python/tests/test_agent_app_search.py
python/tests/test_read_resource_tool.py
python/tests/test_attached_citations.py
python/tests/test_chat_runs.py
python/tests/test_highlights.py
python/tests/test_vault.py
python/tests/test_cutover_negative_gates.py
```

Frontend targeted tests:

```text
apps/web/src/lib/resourceGraph/contractParity.test.ts
apps/web/src/lib/resourceItems/*
apps/web/src/lib/notes/api.test.ts
apps/web/src/lib/notes/prosemirror/schema.test.ts
apps/web/src/lib/notes/resourceSurfacePersistence.test.ts
apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.test.tsx
apps/web/src/components/notes/HighlightNoteEditor.test.tsx
apps/web/src/components/connections/ConnectionsSurface.test.tsx
apps/web/src/lib/search/normalizeSearchResult.test.ts
apps/web/src/lib/api/sse/citations.test.ts
e2e/tests/notes.spec.ts
```

Required behavior fixtures:

- page title-only create/rename/search/read;
- note body create/edit/search/read/cite;
- page links same note also linked by another page;
- note links note/page/media/highlight;
- ordered adjacency reorder under page;
- ordered adjacency reorder under note;
- delete page leaves linked note alive;
- delete note cleans body-derived refs and ordered adjacency;
- stale body version conflict;
- stale outgoing-edge version conflict;
- idempotent mutation replay;
- replay hash mismatch;
- page context does not include linked items;
- future expansion disabled by default;
- all ResourceSchemes have capability entries.

## Files to Touch

Docs:

- `docs/architecture.md`
- `docs/cutovers/resource-native-pages-and-notes-hard-cutover.md`
- `docs/cutovers/notes-pages-object-graph-hard-cutover.md` only to mark
  superseded by this spec, not to preserve old behavior
- `docs/cutovers/resource-graph-product-spine-hard-cutover.md`
- `docs/modules/library.md` if Library Intelligence scope language mentions
  notes/pages

Migrations/models:

- `migrations/alembic/versions/*`
- `python/nexus/db/models.py`
- `python/tests/utils/db.py`

Backend services:

- `python/nexus/services/resource_items/*`
- `python/nexus/services/resource_graph/refs.py`
- `python/nexus/services/resource_graph/policy.py`
- `python/nexus/services/resource_graph/edges.py`
- `python/nexus/services/resource_graph/connections.py`
- `python/nexus/services/resource_graph/context.py`
- `python/nexus/services/resource_graph/cleanup.py`
- delete or empty `python/nexus/services/resource_graph/documents.py`
- `python/nexus/services/notes.py`
- new `python/nexus/services/pages.py`
- new `python/nexus/services/note_bodies.py`
- `python/nexus/services/note_indexing.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/search/scope.py`
- `python/nexus/services/search/retrievers/notes.py`
- `python/nexus/services/search/service.py`
- `python/nexus/services/search/projection.py`
- `python/nexus/services/retrieval_citation.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/vault.py`
- `python/nexus/services/synapse.py`

Backend schemas/routes:

- `python/nexus/schemas/notes.py`
- `python/nexus/schemas/resource_items.py`
- `python/nexus/schemas/resource_graph.py`
- `python/nexus/schemas/retrieval.py`
- `python/nexus/schemas/search.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/schemas/highlights.py`
- `python/nexus/api/routes/notes.py`
- `python/nexus/api/routes/resource_items.py`
- `python/nexus/api/routes/resource_graph.py`
- `python/nexus/api/routes/conversation_context.py`
- `python/nexus/api/routes/highlights.py`

Frontend:

- `apps/web/src/lib/resourceGraph/resourceRef.ts`
- `apps/web/src/lib/resourceGraph/edges.ts`
- `apps/web/src/lib/resourceGraph/connections.ts`
- `apps/web/src/lib/resourceItems/*`
- `apps/web/src/lib/notes/api.ts`
- delete or replace `apps/web/src/lib/notes/pageDocumentPersistence.ts`
- `apps/web/src/lib/notes/prosemirror/schema.ts`
- `apps/web/src/lib/notes/prosemirror/commands.ts`
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`
- `apps/web/src/components/QuickNotePanel.tsx`
- `apps/web/src/components/notes/HighlightNoteEditor.tsx`
- `apps/web/src/components/highlights/HighlightQuickNoteComposer.tsx`
- `apps/web/src/components/reader/ReaderHighlightsSurface.tsx`
- `apps/web/src/components/connections/ConnectionsSurface.tsx`
- `apps/web/src/lib/objectRefs.ts`
- `apps/web/src/lib/search/*`
- `apps/web/src/lib/api/sse/citations.ts`
- `apps/web/src/lib/conversations/*`
- `apps/web/src/lib/panes/paneRouteModel.ts`

## Key Decisions

D1. Page and note are backend peers. UX may privilege pages as collection
surfaces, but services must not.

D2. Page has title only.

D3. Note has one body only. No row kind.

D4. ProseMirror JSON is the canonical note body while ProseMirror is the editor.

D5. Plain text is a generated projection and may be stored for performance.

D6. Markdown is derived interchange/export text, not canonical storage.

D7. Ordered adjacency is generic and graph-owned.

D8. `note_containment` is deleted.

D9. Versions are generic resource/lane protocol state.

D10. Idempotency is generic resource/lane mutation state.

D11. First-level linked-item expansion is not part of default page search or
prompt context.

D12. Resource item capabilities are centralized before broadening behavior.

D13. Search remains default-deny and policy-driven.

D14. Edge shape policy and item capability policy are separate owners.

D15. Historical docs can mention old concepts, but current architecture docs and
production tests must not present them as live contracts.

## Implementation Order

1. Land `resource_items` capability registry and tests without behavior changes.
2. Add generic resource versions/mutations.
3. Remove page description.
4. Move page document version reads/writes to generic versions.
5. Remove note block kind from body save/load/editor persistence.
6. Remove stored markdown or reown it as an export cache.
7. Add generic ordered adjacency service.
8. Migrate `note_containment` to generic ordered adjacency.
9. Delete page-document APIs/services/frontend persistence.
10. Route pages, notes, highlight notes, quick capture, and daily notes through
    resource item services.
11. Consolidate read/citation/search/context capability lists.
12. Update docs and negative gates.

Do not split steps by "old and new both work". Each landed PR should remove the
old contract for the surface it cuts over.

## Done Means

The backend no longer knows that pages own note documents.

A page can collect resources. A note can collect resources. Both do so through
the same ordered adjacency capability. Page title, note body, and graph
adjacency have separate generic concurrency lanes. Search, read, cite, attach,
context, and render decisions are declared once per resource scheme.

There is no page-document aggregate left to route around.

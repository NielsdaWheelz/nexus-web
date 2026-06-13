# Notes & Pages on Resource Graph Hard Cutover

## Status

IMPLEMENTATION - final page-document command path, public block mutation route
cutover, graph-backed writing UX, and visible local draft recovery are in place.
Validated against merged `main` after the resource provenance graph cutover. The
graph/schema foundation, backend containment runtime, evidence/citation,
note-only retrieval, graph-backed tags, quick capture, silent autosave, shared
editor-session persistence, low-chrome connections, graph-backed attachments,
versioned local draft recovery, final versioned document command, highlight-note
product route, and focused page-document E2E acceptance flow are in place.

Current hard-cutover state:

- Public `/api/notes/blocks` mutation routes, frontend mutation clients, legacy
  service-level block mutation helpers, and their request DTOs have been
  removed. `GET /api/notes/blocks/{blockId}` remains as a read-only resource
  resolver path for block panes and object-ref resolution. Page/block edits
  persist through the versioned page-document command path; highlight notes
  write through `/api/highlights/{highlightId}/note`; quick-note empty-delete
  writes through the page document command helper.
- `#tag` persistence exists through graph-backed body parsing, and the editor
  now exposes first-class `#` autocomplete backed by type-filtered object-ref
  search.
- File attachments are graph-backed; URL-only paste in the writing surface now
  ingests URLs through the same media intake path and inserts media embeds.
- Draft storage uses a strict versioned local envelope with durable sequence and
  `clientMutationId`. Page drafts, highlight-note drafts, and quick-note drafts
  now surface one visible recovery affordance with explicit save/retry and
  discard actions; quick-note recovery uses a stable daily draft key and saves
  with the recovered block id.
- `notes.py` no longer carries function-local imports from
  `resource_graph.edges`; highlight-note read projection lives in
  `nexus.services.highlight_notes` so read paths do not route through the notes
  write service to paper over cycles.

Current base:

```text
main head: 6bf4a71a Make note connections editable
base spec: docs/cutovers/resource-provenance-graph-hard-cutover.md
base migration: migrations/alembic/versions/0147_resource_provenance_graph.py
foundation migration: migrations/alembic/versions/0148_notes_pages_resource_graph_order.py
```

The merged base introduced `resource_graph` and `resource_edges` and dropped
`object_links`, `conversation_references`, `oracle_reading_passages`, and
`library_intelligence_citations`. This notes/pages cutover extends that link
model with the columns and origins needed for ordered documents. It must not
introduce `object_graph_edges`, a parallel `object_graph` service, or a second
containment/link table.

This spec is also an explicit revision to the resource graph contract. Rev 4
said "Position is never edge payload." That remains correct for citations,
locators, and body-local character offsets, but it is too broad for ordered
adjacency. A note document's order is the connection's position in the source
and target adjacency lists, so `source_order_key` and `target_order_key` belong
on `resource_edges`.

## Type

Hard cutover target. No dual-write, no compatibility shim, no old route alias,
no runtime fallback to the old page/block structure columns. Current
implementation has removed the old structure-column fallback, public block
mutation routes, legacy service-level mutators, and silent draft replay paths.

## Reviewed Base State

Merged `main` currently contains:

- `docs/cutovers/resource-provenance-graph-hard-cutover.md`
- `migrations/alembic/versions/0147_resource_provenance_graph.py`
- `python/nexus/db/models.py` changes replacing `ObjectLink` with
  `ResourceEdge`
- `python/nexus/services/resource_graph/__init__.py`
- `python/tests/test_migrations.py` updates

The base table shape is:

```text
resource_edges(
  id,
  user_id,
  kind,
  origin,
  source_scheme,
  source_id,
  target_scheme,
  target_id,
  ordinal,
  snapshot,
  created_at
)
```

The notes/pages amendment is:

```text
resource_edges(
  ...
  source_order_key null,
  target_order_key null
)
```

and new graph vocabulary:

```text
origin += note_containment
scheme += tag
```

The base also needs one uniqueness correction before notes build on it:

- the bare-pair uniqueness must include `user_id` and `origin`, otherwise a
  `note_body` edge, a user edge, and a containment edge between the same two
  resources can block each other.

Implementation must land as the next migration after `0147` unless the merged
resource-graph migration is deliberately rewritten before publication. Do not
refer to `0145_resource_provenance_graph.py` as the notes base; `0145` is not
the merged resource graph head.

## North Star

Notes should feel like Apple Notes for capture and editing, Roam Research for
block structure and references, and Nexus for evidence-grade AI context.

The user experience should be quiet and instant. The storage model should be one
strict graph:

- page rows own page identity and title;
- block rows own stable block identity and body;
- `resource_edges` own containment, references, annotations, tags, attachments,
  citations, user links, and order;
- projections own search, evidence, backlinks, and citation read models;
- view state owns collapse/focus/pane behavior.

## SME Thesis

A subject matter expert would not create a second containment table after the
resource provenance cutover has landed. The whole point of the link refactor is
that links are the system's connection model. Parentage, tree shape, and order
are connection facts, so they belong in `resource_edges`.

The base graph's "flat edge" discipline is still right:

- no relation verbs;
- no metadata bag;
- no locator columns;
- no sidecar tables;
- no compatibility aliases.

But order is not metadata and it is not a locator. Order is the connection's
position in each endpoint's adjacency list. For notes/pages, the minimal
professional extension is to add directional order columns to the link model and
use `origin=note_containment` for page/block tree edges.

## SME Moves

- Keep one canonical link table: `resource_edges`.
- Add the necessary directional order columns there.
- Add `origin=note_containment` as the sole writer for page/block containment.
- Keep `kind` as stance only:
  - `context`;
  - `supports`;
  - `contradicts`.
- Do not add `contains`, `references`, `embeds`, `annotates`, `tagged_with`, or
  `attaches` as edge kinds.
- Represent those product concepts with endpoint schemes plus `origin`.
- Source block-local references from `note_block:<id>`, not the whole page.
- Let the editor send document intent; let the backend compute graph changes.
- Fix UX after the graph/data model so the UI does not calcify the old schema.

## Goals

- Deliver Apple Notes level capture:
  - instant page creation;
  - instant quick capture;
  - silent autosave;
  - local draft recovery;
  - low chrome editor;
  - failure UI only when something needs attention.
- Preserve Roam-style structure:
  - stable block ids;
  - nested bullets;
  - indent/outdent;
  - split/join;
  - block references;
  - transclusion-ready block identity;
  - backlinks.
- Move page/block structure out of rows:
  - no `NoteBlock.page_id`;
  - no `NoteBlock.parent_block_id`;
  - no `NoteBlock.order_key`;
  - no `NoteBlock.collapsed`.
- Use `resource_edges` for:
  - containment;
  - note body references;
  - highlight note attachments;
  - user links;
  - citation edges;
  - tags;
  - attachments.
- Introduce one notes document capability inside the graph service layer:
  - ordered containment;
  - document loading;
  - document patching;
  - cycle checks;
  - transclusion rules;
  - projection invalidation.
- Preserve the evidence pipeline:
  - `content_blocks`;
  - `content_chunks`;
  - `content_index_states`;
  - `evidence_spans`;
  - note/page search and citation resolution.

## Non-Goals

- No CRDT or multi-user collaboration layer.
- No offline sync beyond local draft recovery.
- No graph visualization.
- No compatibility with old object-link API shapes.
- No second generic resource edge table.
- No old note block structural columns left for fallback.
- No generic metadata escape hatch.
- No locator columns on `resource_edges`.

## Final Layering

```text
Frontend editor
  -> notes product API
    -> notes service
      -> resource_graph.documents  ordered page/block graph commands
      -> resource_graph.edges      references, tags, attachments, highlight notes
      -> note_indexing             content/evidence projections
```

`resource_graph` remains the graph owner. Notes adds document-specific graph
commands under that owner instead of creating a new service.

## Target Mental Model

### Resource

Anything addressable is a `ResourceRef`.

Examples:

- `page:<id>`;
- `note_block:<id>`;
- `media:<id>`;
- `highlight:<id>`;
- `evidence_span:<id>`;
- `content_chunk:<id>`;
- `conversation:<id>`;
- `message:<id>`;
- `library:<id>`;
- `tag:<id>`.

### Page

A page is a named writing space and document root.

It owns:

- `id`;
- `user_id`;
- `title`;
- page-level intrinsic metadata;
- timestamps.

It does not own:

- block membership;
- block parentage;
- sibling order;
- backlinks;
- tags;
- attachments;
- evidence rows.

### Block

A block is a stable content object.

It owns:

- `id`;
- `user_id`;
- body document;
- body markdown/text projections;
- block kind only when the kind changes authoring semantics;
- timestamps.

It does not own:

- page membership;
- parent block;
- sibling order;
- collapsed state;
- references;
- attachments;
- annotation target.

### Resource Edge

A resource edge connects one resource to another.

It owns:

- source resource;
- target resource;
- stance `kind`;
- writer `origin`;
- optional directional order;
- optional citation ordinal and snapshot.

For notes:

```text
source = parent page or parent block
target = child block
kind = context
origin = note_containment
source_order_key = order of child in parent
target_order_key = order of parent occurrence in child inbound list, if needed
```

### Projection

A projection is rebuildable:

- page document read model;
- backlinks;
- search chunks;
- evidence spans;
- citation targets;
- graph neighborhoods.

### View

View state is UI state over resources:

- active pane;
- focused block;
- collapsed block in a page context;
- editor selection;
- writing mode.

View state is not block identity and not a resource edge.

## Data Model

### `resource_edges`

Extend the merged base table.

Columns after this cutover:

```text
id uuid primary key
user_id uuid not null
kind text not null
origin text not null
source_scheme text not null
source_id uuid not null
target_scheme text not null
target_id uuid not null
source_order_key text null
target_order_key text null
ordinal integer null
snapshot jsonb null
created_at timestamptz not null default now()
```

Keep:

- `kind in ('context', 'supports', 'contradicts')`;
- `ordinal is null or snapshot is not null`;
- no `updated_at`;
- no metadata;
- no locators.

Add:

- `origin = 'note_containment'`;
- `scheme = 'tag'`;
- order-key length checks:
  - `source_order_key` null or 1..64 chars;
  - `target_order_key` null or 1..64 chars.
- origin-specific validity checks:
  - ordinals are citation-only; snapshots are citation-only except the later
    `origin=synapse` rationale snapshot carveout;
  - citation edges cannot carry order keys;
  - containment edges must be `kind=context`, `page|note_block -> note_block`,
    and have `source_order_key`;
  - highlight note edges must be `kind=context`, `highlight -> note_block`, and
    carry no order keys or citation payload.

Revise uniqueness and indexes:

```text
unique(user_id, source_scheme, source_id, ordinal)
  where ordinal is not null

unique(user_id, origin, source_scheme, source_id, target_scheme, target_id)
  where ordinal is null

unique(user_id, source_scheme, source_id, source_order_key)
  where origin = 'note_containment' and source_order_key is not null

unique(user_id, target_scheme, target_id, target_order_key)
  where origin = 'note_containment' and target_order_key is not null

unique(user_id, target_scheme, target_id)
  where origin = 'note_containment'

index(user_id, origin, source_scheme, source_id, source_order_key, id)

index(user_id, origin, target_scheme, target_id, target_order_key, id)
```

The current `0147` `uq_resource_edges_context_pair` must not remain as
`(source_scheme, source_id, target_scheme, target_id) where ordinal is null`.
It is too broad for notes because it prevents different writers from expressing
different facts over the same pair.

The service code must change with the schema. `resource_graph.edges.create_edge`,
`replace_edges_for_origin`, collision checks, and tests must become
origin-aware. A `note_body`, `user`, `highlight_note`, and `note_containment`
edge over the same endpoint pair are distinct facts when their origins differ.
High-level APIs may still apply narrower semantic idempotency, such as
deduping explicit `origin=user` links in both directions, but that behavior must
live in the owning service path and not in a broad database constraint or
origin-blind helper.

### Edge Origins For Notes

Use origins as writer/invariant owners:

| Origin | Source | Target | Meaning |
|---|---|---|---|
| `note_containment` | `page` or `note_block` | `note_block` | ordered document containment |
| `note_body` | `note_block` or `page` | any linkable resource | body-derived ref/tag/embed/attachment projection |
| `highlight_note` | `highlight` | `note_block` | highlight's attached note |
| `user` | any linkable resource | any linkable resource | explicit user link/assertion |
| `citation` | output resource | cited target | rendered citation |
| `system` | system-owned source | target | system connection where needed |

### Containment Edge Rules

For `origin=note_containment`:

- `kind` must be `context`.
- `source_scheme` must be `page` or `note_block`.
- `target_scheme` must be `note_block`.
- `source_id,target_id` cannot point to the same block.
- `source_order_key` is required.
- `target_order_key` is reserved for future ordered inbound occurrence lists.
- duplicate target under the same source is invalid.
- duplicate `source_order_key` under the same source is invalid.
- duplicate `target_order_key` under the same target is invalid when
  `target_order_key` is present.
- cycles are invalid.
- this cutover enforces one containment edge per block. Multiple containment
  edges for the same block are a future transclusion phase and require
  occurrence-edge ids in every page/search/citation/API projection first.

Cycle checks are service-owned, not database-owned.

### Occurrence Identity

A block is a content object with exactly one document occurrence in this
cutover. The occurrence identity for future transclusion is the
`resource_edges.id` of the `origin=note_containment` edge that places the block
in a parent context.

Rules:

- Every block has one occurrence edge in its page context.
- Page rendering, search projections, citation activation, vault export, and
  backlinks may identify a block by `(page_id, block_id)` while the
  single-occurrence invariant holds.
- Before transclusion ships, those projections must carry enough context to
  distinguish occurrences:
  - page root id;
  - parent ref;
  - containment edge id;
  - block id.
- Search result dedupe cannot use `note_block.id` alone after transclusion.
- Citation activation may fall back to the block's current page context only
  while the target has exactly one containment occurrence.

### Reference Edges

Inline block references, page references, object refs, tags, and inline
attachments sync from parsed block bodies into `resource_edges`.

For block-local body refs:

```text
source = note_block:<block_id>
target = <referenced resource>
kind = context
origin = note_body
```

For page-level refs:

```text
source = page:<page_id>
target = <referenced resource>
kind = context
origin = note_body
```

The block body owns inline occurrence positions. The edge stores durable
connectedness, not character offsets.

### Annotation Edges

Highlight quick notes use the merged resource graph model:

```text
source = highlight:<highlight_id>
target = note_block:<block_id>
kind = context
origin = highlight_note
```

This is the product's annotation edge. Do not add `annotates` as a `kind`.

### Tag Edges

Tags are resources.

Add a `tags` table in this cutover:

```text
id uuid primary key
user_id uuid not null
name text not null
slug text not null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Extend `ResourceScheme` with `tag`.

Inline `#tag` creates:

```text
source = note_block:<block_id>
target = tag:<tag_id>
kind = context
origin = note_body
```

Explicit page tags create:

```text
source = page:<page_id>
target = tag:<tag_id>
kind = context
origin = user
```

### Attachment Edges

Attachments are resources, usually `media:<id>`.

Inline attachment:

```text
source = note_block:<block_id>
target = media:<media_id>
kind = context
origin = note_body
```

Explicit page/block attachment:

```text
source = page:<page_id> | note_block:<block_id>
target = media:<media_id>
kind = context
origin = user
source_order_key = optional attachment order if rendered outside the body
```

Do not add `attaches` as a `kind`.

### `pages`

Keep as page identity.

Required columns:

- `id`;
- `user_id`;
- `title`;
- `created_at`;
- `updated_at`.

No tree columns are added here.

### `note_blocks`

Cut to content identity.

Required columns:

- `id`;
- `user_id`;
- `block_kind`;
- `body_pm_json`;
- `body_markdown`;
- `body_text`;
- `created_at`;
- `updated_at`.

Drop:

- `page_id`;
- `parent_block_id`;
- `order_key`;
- `collapsed`.

### `note_view_states`

Add this for persisted outline view state.

Columns:

```text
id uuid primary key default gen_random_uuid()
user_id uuid not null
context_source_scheme text not null
context_source_id uuid not null
target_block_id uuid not null
collapsed boolean not null default false
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Unique key:

```text
(user_id, context_source_scheme, context_source_id, target_block_id)
```

Collapsed state does not belong on `note_blocks` or `resource_edges`.

## Backend Architecture

### Extend `resource_graph`

Add document-oriented graph commands under:

```text
python/nexus/services/resource_graph/documents.py
```

This module owns:

- ordered page document loading;
- containment mutation;
- cycle checks;
- transclusion rules;
- block body replace integration;
- note-body edge sync;
- projection invalidation hooks.

It composes with:

- `resource_graph.refs`;
- `resource_graph.edges`;
- `resource_graph.resolve`;
- `resource_graph.cleanup`;
- `note_indexing`.

It must not import `notes.py`. If existing note/link helpers are needed by both
`resource_graph.resolve` and notes product flows, move them into the graph owner
or expose a small typed public function from the owning module. Do not add new
function-local imports to paper over cycles.

Do not create `python/nexus/services/object_graph`.

### Product Notes Service

`python/nexus/services/notes.py` owns:

- page creation;
- page title mutation;
- daily note behavior;
- quick capture behavior;
- product response shaping.

It delegates graph/document structure to `resource_graph.documents`.

### Capability Contract

Required public functions:

```python
def load_page_document(
    db: Session,
    *,
    user_id: UUID,
    page_id: UUID,
) -> PageDocument: ...

def patch_page_document(
    db: Session,
    *,
    user_id: UUID,
    page_id: UUID,
    command: PatchPageDocumentCommand,
) -> PatchPageDocumentResult: ...

def set_children(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    children: Sequence[OrderedChildBlock],
) -> None: ...

def move_block(
    db: Session,
    *,
    user_id: UUID,
    block_id: UUID,
    from_parent: ResourceRef,
    to_parent: ResourceRef,
    source_order_key: str,
) -> None: ...

def unlink_block_occurrence(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    block_id: UUID,
) -> None: ...

def delete_block_subtree(
    db: Session,
    *,
    user_id: UUID,
    root_block_id: UUID,
    parent_context: ResourceRef | None,
) -> None: ...

def sync_block_body_edges(
    db: Session,
    *,
    user_id: UUID,
    block_id: UUID,
    parsed_refs: Sequence[ParsedBlockReference],
) -> None: ...
```

Rules:

- Mutators do not commit unless the route wrapper is the sole caller.
- Mutators SELECT before mutate.
- Page patch runs in one transaction.
- Routes do not query or mutate `resource_edges` directly.
- `notes.py` may translate notes-shaped editor commands, but containment DML and
  graph invariants live in `resource_graph.documents`.

### Resource Resolution

`resource_graph.resolve` and `read_resource` must understand graph-backed notes:

- resolving `page:<id>` can include the ordered page document when a caller asks
  for body context;
- resolving `note_block:<id>` can include the block body plus occurrence/page
  context when known;
- resolving page-owned `evidence_span` and `content_chunk` targets must not be
  limited to media-owned joins;
- target validation for `create_edge(origin=citation)` must accept valid
  note/page-owned evidence resources;
- the graph service remains the owner of these conversions, not chat, Oracle,
  or a UI adapter.

## Document Patch Contract

The editor sends an authoring document command. The backend computes graph
changes.

This is the final document command. The old changed-block request shape is not
accepted by the page document route.

Request:

```json
{
  "client_mutation_id": "uuid",
  "base_document_version": "opaque version from the last document read",
  "title": "optional title",
  "blocks": [
    {
      "id": "uuid",
      "block_kind": "paragraph",
      "body_pm_json": {}
    }
  ],
  "containment": [
    {
      "parent": { "scheme": "page", "id": "uuid" },
      "children": [
        { "block_id": "uuid", "source_order_key": "a0", "collapsed": false }
      ]
    },
    {
      "parent": { "scheme": "note_block", "id": "uuid" },
      "children": [
        { "block_id": "uuid", "source_order_key": "a0", "collapsed": false }
      ]
    }
  ],
  "deleted_block_ids": ["uuid"]
}
```

Response:

```json
{
  "client_mutation_id": "uuid",
  "page": {},
  "document_version": "opaque committed version",
  "changed_block_ids": ["uuid"],
  "changed_edge_ids": ["uuid"],
  "reindex_job_id": "uuid",
  "focused_block": {}
}
```

Rules:

- The command is authoritative for the edited page context.
- The service diffs current containment edges against the command.
- The service updates block bodies and graph edges in one transaction.
- The service parses changed block bodies and replace-sets `origin=note_body`.
- The service schedules page reindex once per committed document mutation.
- `client_mutation_id` supports retry idempotency. It is not a compatibility
  path.
- `base_document_version` is a real service-owned document version, not a
  placeholder. The implementation may use a page document version column or a
  deterministic graph-document digest, but it must be returned by document reads
  and advanced only by committed document mutations.
- Full-page editor patches send `base_document_version`. A stale version returns
  a typed conflict response with the latest document; it does not silently merge.
- Quick capture loads the current daily page document and writes through this
  command with the current `base_document_version`. It is caller-block-id
  idempotent: the client sends the durable block id plus `client_mutation_id`;
  retrying that block id updates the same daily block instead of appending a
  duplicate.

## API Design

### Notes Product API

Keep product routes notes-shaped:

```text
GET    /api/notes/pages
POST   /api/notes/pages
GET    /api/notes/pages/{pageId}
PATCH  /api/notes/pages/{pageId}
DELETE /api/notes/pages/{pageId}
GET    /api/notes/pages/{pageId}/document
PATCH  /api/notes/pages/{pageId}/document
GET    /api/notes/daily
POST   /api/notes/quick-capture
GET    /api/notes/blocks/{blockId}
```

These routes call `notes` and `resource_graph.documents`. They do not expose
storage rows.

`POST /api/notes/quick-capture` accepts `id`, `client_mutation_id`,
`local_date`, and either `body_pm_json` or `body_markdown`. The route resolves
the daily page and delegates to the graph-backed document patch command; it does
not write `resource_edges` directly.

`GET /api/notes/blocks/{blockId}` is read-only. It exists for resource
resolution and block-pane hydration only. Public block creation, update,
delete, move, split, and merge routes are not part of the cutover contract.

Highlight note capture uses a highlight-shaped product route:

```text
PUT    /api/highlights/{highlightId}/note
DELETE /api/highlights/{highlightId}/note
```

The route validates highlight visibility, synthesizes a page document command,
and writes the `origin=highlight_note` edge inside the same document mutation
transaction. It does not call public block mutation APIs.

Object-ref search supports optional repeated `type=` filters:

```text
GET /api/object-refs/search?q=sot&type=tag
```

The editor uses this for `#` tag autocomplete and `[[` page/block autocomplete
so correctness is owned by the search service rather than client-side result
filtering.

### Resource Graph API

Use the merged resource graph route vocabulary:

```text
GET    /api/resource-graph/edges
POST   /api/resource-graph/edges
DELETE /api/resource-graph/edges/{edgeId}
POST   /api/resource-graph/resolve
```

The FastAPI route, Next.js BFF proxy, frontend client, and shared TypeScript
types must all expose the same schema:

- internal `EdgeCreate` accepts `source_order_key` and `target_order_key`;
- `EdgeOut` returns `source_order_key` and `target_order_key`;
- the frontend BFF supports `GET`, `POST`, `DELETE`, and `resolve`;
- browser code calls same-origin `/api/*` routes only.

Do not add:

```text
/api/object-graph/*
```

Do not keep:

```text
/api/object-links/*
```

The public edge route should not let arbitrary clients create
`origin=note_containment` or write order keys; ordered adjacency belongs to
notes document commands, not generic user links.

## UX Target Behavior

### Page Editor

- Opening a page focuses the title or first empty block depending on context.
- New pages open immediately with a provisional empty block.
- The title is plain text, not a heavy form.
- The outline has no visible card boundary in writing mode.
- Empty state is a cursor, not an instructional panel.
- Save indicators are hidden unless save fails or draft recovery is active.
- Backlinks and metadata live in secondary chrome, a sidecar, or a command
  surface.

### Capture

There are three capture paths:

- quick note;
- daily note capture;
- highlight/evidence note capture.

All three use the same editor session controller and the same document patch
contract.

Capture can create:

- a new page;
- a new block under an existing page;
- a new block under an existing block;
- a new block attached to a highlight through `origin=highlight_note`;
- a new block linked to a resource through `resource_edges`.

### Silent Autosave

- Autosave is silent in the success path.
- Edits persist after idle delay and on blur/visibility change.
- Local draft state survives refresh until server commit succeeds.
- Saved local drafts surface one visible recovery affordance instead of silently
  replaying; the user can save/retry or discard.
- Save failure uses the same recovery affordance.
- Page editor, quick capture, and highlight note capture share one persistence
  controller.

### Links, Tags, Attachments

- `[[` opens page/block/resource autocomplete.
- `#` opens tag autocomplete.
- Pasted URLs resolve into resources or external snapshots when supported.
- Dropped files become media resources and attach to the block/page.
- Inline chips are lightweight and keyboard-editable.
- The block body owns inline occurrence order; `resource_edges` is the durable
  connected-resource graph.

## Evidence And Search

Preserve the existing content/evidence substrate:

- `content_blocks`;
- `content_chunks`;
- `content_index_states`;
- `evidence_spans`;
- note/page retrievers;
- locator resolution.

Required changes:

- `note_indexing` loads ordered page documents from `resource_graph.documents`.
- Search result citations point at `note_block:<id>` or finer evidence resources.
- Note citation activation opens the page context and focuses the exact block.
- Oracle availability works for note-only corpora.
- Page reindex works when only containment changes.
- Stale object-search references are removed.
- `resource_graph.resolve` resolves page-owned and note-owned
  `evidence_span`/`content_chunk` targets, not only media-owned targets.
- `resource_graph.edges.create_edge` validates citation targets through that
  generalized resolver so graph citation writes can target note evidence.
- `CitationOut` carries enough note/page activation data for note-block and
  page-owned evidence citations; frontend adapters must not degrade these to
  plain hrefs.
- Oracle's searchable-corpus gate counts indexed notes/pages as searchable
  corpus; a user with notes and no media still reaches retrieval.
- Search scope cells use explicit origin/kind allowlists. Containment, body
  refs, tags, attachments, user links, and citation edges must not accidentally
  satisfy the same scope predicate unless that relationship is intentionally
  allowed.
- `agent_tools/app_search.py`, chat citation assembly, Oracle citation
  assembly, and read-resource evidence all consume the same graph-backed
  citation contract.

Projection invalidation:

- block body change schedules affected block/page index;
- containment edge change schedules affected page documents;
- resource-edge change invalidates backlinks/connection views;
- highlight-note edge change invalidates highlight linked-note views.

## Composition With Other Systems

### Workspace And Panes

- Pane routing opens resources and page document projections.
- Page panes request notes document projections.
- Citation panes use `ResourceRef` and optional activation payload.
- Backlink/connection sidebars call `resource_graph`.
- Pane layout remains view state.

### Reader And Citations

- Citation target vocabulary is closed and shared by backend schemas, graph
  resolution, chat/Oracle/app-search emitters, and frontend adapters.
- The cutover citation target set is finest-grain only:
  - `media`;
  - `note_block`;
  - `evidence_span`;
  - `content_chunk`;
  - `external_snapshot`;
  - `oracle_corpus_passage`.
- `page` and `highlight` remain readable/linkable `ResourceRef` object types,
  but they are not citation-chip targets. Page/highlight relationships should be
  expressed as containment/reference/annotation edges, while citations point at
  the finest-grained block/span/chunk/media/snapshot that can be activated.
- Note/page citations activate exact block ids or containment occurrences.
- Page-owned evidence citations activate the page and block occurrence that
  produced the evidence span or chunk.
- Reader target conversion is centralized.
- `resource_edges` supplies citation chips and note backlinks.

### Highlights

- Highlight quick note creates a note block.
- `resource_edges` stores:

```text
source=highlight:<id>
target=note_block:<id>
kind=context
origin=highlight_note
```

- Page containment is separate but still in `resource_edges` with
  `origin=note_containment`.
- Moving the note block in a page does not erase its highlight attachment.

### Media And Attachments

- Media ingestion remains media-owned.
- Attaching media to a block/page creates a `resource_edges` row.
- Inline attachment display order lives in the block body.
- Separate attachment tray order can use `source_order_key` on the attachment
  edge.

### Search And Oracle

- `resource_graph.documents` provides ordered note content.
- `resource_graph.edges` provides relation neighborhoods and citation edges.
- `note_indexing` creates search/evidence rows.
- Oracle context assembly can include note content and resource graph
  neighborhoods.

## Duplicate Code To Consolidate

### Backend

- `NOTE_BLOCK_SIBLING_ORDER`
  - Delete. Replace with resource-edge order constraints and service checks.
- `NoteBlock.page_id`, `parent_block_id`, `order_key`
  - Delete. Replace with `origin=note_containment` edges.
- `NoteBlock.collapsed`
  - Move to `note_view_states`, then delete from `note_blocks`.
- Tree assembly helpers in `notes.py`
  - Replace with `resource_graph.documents.load_page_document`.
- Sibling/order mutation code in `notes.py`
  - Replace direct edge/column mutation with `resource_graph.documents` commands.
- Inline reference syncing in `notes.py`
  - Replace with `origin=note_body` replace-set sync.
- Backlink queries split across old notes/object-link paths
  - Replace with `resource_graph.connections.query_connections`.
- Any lingering `ObjectLink` symbols after the resource graph cutover
  - Delete. Do not recreate.
- Page reindex traversal through old block structural columns
  - Replace with resource graph traversal.
- Vault export/sync traversal through old block structural columns
  - Replace with `resource_graph.documents` document traversal.
- Note/page resource resolution that returns title/description without ordered
  body context
  - Replace with graph document resolution when callers request body context.
- Search/app-search/chat/Oracle citation target assembly
  - Collapse onto the shared graph-backed `CitationOut` contract.

### Frontend

- Save/draft planning inside `PagePaneBody.tsx`
  - Extracted to `apps/web/src/lib/notes/pageDocumentPersistence.ts` so the page
    pane uses the shared editor session controller without exporting component
    internals.
- Separate quick note/page editor/highlight note persistence paths
  - Consolidate through the same document patch client.
- Object reference autocomplete diverging by surface
  - Reuse one resource ref resolver and chip renderer.
- Citation target conversion split across reader/search paths
  - Centralize note/page target conversion.
- Frontend object-link clients
  - Delete after resource-graph clients exist.
- Resource graph client gaps
  - Add BFF/client support for edge create/delete/resolve instead of adding
    one-off feature clients.

## Key Decisions

### Decision 1: Add Columns To The Link Model

Ordered containment belongs in `resource_edges`. Add `source_order_key` and
`target_order_key` to the base link table.

### Decision 2: Containment Is An Origin, Not A Kind

Use `origin=note_containment` with `kind=context`. Do not add `contains` as a
new kind.

### Decision 3: Order Is Directional Edge Data

`source_order_key` orders targets in the source adjacency list.
`target_order_key` orders sources in the target inbound list where useful.

### Decision 4: Blocks Are Identity Plus Body

Blocks are movable and referenceable because parentage/order is externalized into
resource edges.

### Decision 5: Block-Scoped References Source From Blocks

For block-grade backlinks, inline references inside a block produce edges from
`note_block:<block_id>`.

### Decision 6: Tags And Attachments Are Resources

Tags and attachments are not edge kinds. They are targets connected through
ordinary resource edges.

### Decision 7: View State Is Not Content

Collapse/focus/pane state does not belong on `note_blocks` or `resource_edges`.

### Decision 8: Evidence Is A Projection

The graph supplies source content and connections. The content/evidence tables
remain the retrieval substrate.

## Migration Plan

This work starts from merged `main` after the resource-provenance graph cutover.

### Phase 0: Base Contract

Deliverables:

- merged `main` at or after `0147` is the PR base;
- `resource_edges`/`resource_graph` names are accepted;
- this spec has no `object_graph_edges` dependency;
- `resource_edges` amendments are approved:
  - `source_order_key`;
  - `target_order_key`;
  - `origin=note_containment`;
  - `scheme=tag`;
  - bare-pair uniqueness includes `user_id` and `origin`.

### Phase 1: Schema Hard Cut

Deliverables:

- alter `resource_edges` to add order columns;
- alter `resource_edges` origin check to include `note_containment`;
- alter `resource_edges` scheme checks to include `tag`;
- replace the base bare-pair unique index with an origin-aware one;
- add containment order indexes and partial uniqueness;
- create `tags`;
- run a migration preflight over existing note trees:
  - reject cross-user parents;
  - reject page/block user mismatches;
  - reject cross-page parents;
  - reject self-parent rows;
  - reject containment cycles;
- deterministically normalize legacy sibling order into `source_order_key` using
  the same stable render order the old UI already used; if a tree cannot be
  normalized without changing visible parentage, fail the migration with an
  explicit error;
- backfill existing `note_blocks.page_id`, `parent_block_id`, and `order_key`
  into `resource_edges origin=note_containment`;
- drop old note block structural columns;
- drop `NOTE_BLOCK_SIBLING_ORDER`;
- backfill `collapsed` into `note_view_states` and then drop it from
  `note_blocks`.

No runtime compatibility path exists after this phase.

### Phase 2: Resource Graph Documents Service

Deliverables:

- implement `python/nexus/services/resource_graph/documents.py`;
- load ordered page documents from `resource_edges`;
- provide graph-document primitives used by `notes.py` patch orchestration;
- reject cycles;
- enforce single containment occurrence until occurrence ids ship end to end;
- replace-set changed block body refs with `origin=note_body`;
- schedule note indexing.

### Phase 3: Notes Service Cutover

Deliverables:

- page create creates page and initial containment edges;
- document read uses `resource_graph.documents`;
- document patch uses `resource_graph.documents`;
- quick capture uses the same patch path;
- daily note capture uses the same path;
- highlight capture writes `origin=highlight_note`.

### Phase 4: Indexing And Evidence

Deliverables:

- `note_indexing` traverses `origin=note_containment` edges;
- index projections carry containment occurrence context when the same block can
  appear under multiple parents;
- page reindex triggers on containment-only movement;
- graph citation writes accept note/page-owned evidence targets;
- note citations activate exact blocks or occurrences;
- note-only Oracle/search works;
- search scope cells use explicit origin/kind allowlists;
- stale page semantic query path is used or removed.

### Phase 5: Frontend Data Cutover

Deliverables:

- notes API client uses new patch contract;
- resource graph BFF/client supports edge create/delete/resolve and order fields;
- page editor delegates save/draft state to one controller;
- ProseMirror document conversion emits containment command shape;
- object/resource refs use resource graph clients;
- citation target conversion supports note/page/block.

### Phase 6: UX Cutover

Deliverables:

- low chrome page editor;
- silent autosave;
- quick capture;
- daily capture;
- highlight annotation capture;
- links/tags/attachments;
- visible local draft and failure recovery UI.

### Phase 7: Cleanup And Docs

Deliverables:

- update stale notes evidence doc;
- update architecture docs;
- delete old tests and fixtures;
- delete old route clients;
- add grep/head assertions for removed symbols.

## Acceptance Criteria

### Base Compatibility

- No `object_graph_edges` table is introduced.
- No `object_graph` service/package is introduced.
- No `/api/object-graph` route is introduced.
- `resource_edges` is the only persisted graph/link table for containment,
  references, annotations, tags, attachments, user links, and citations.
- `resource_edges` has `source_order_key` and `target_order_key`.
- `resource_edges` has `origin=note_containment`.
- The broad base bare-pair uniqueness is replaced with an origin-aware uniqueness
  rule.
- Resource graph writer helpers are origin-aware; they do not suppress a valid
  `note_body`, `user`, `highlight_note`, or `note_containment` edge merely
  because another origin already connects the same endpoints.
- The resource provenance graph spec is updated to document ordered adjacency as
  the intentional exception to the old "position is never edge payload" wording.

### Data Model

- `note_blocks` no longer has `page_id`, `parent_block_id`, `order_key`, or
  `collapsed`.
- `resource_edges origin=note_containment` is the only persisted source for
  page/block containment and order.
- Page render order is produced from `source_order_key`.
- Invalid containment endpoint combinations are rejected.
- Containment cycles are rejected.
- A block can have only one containment occurrence until occurrence-edge ids are
  carried end to end for transclusion.
- Existing page trees are reconstructed from resource edges after migration.
- Migration tests cover deterministic duplicate sibling order normalization,
  invalid page/block ownership, cross-page parents, self-parent rows, and cycles.
- `note_view_states` owns persisted collapsed state.
- Tags have a real table and `ResourceScheme` support in backend and frontend.

### Backend

- Notes routes do not write `resource_edges` directly.
- `resource_graph.documents` owns containment mutation primitives.
- Page document patch is atomic and rebuilds containment through graph document
  commands.
- Inline refs sync to `resource_edges origin=note_body`.
- Highlight notes sync to `resource_edges origin=highlight_note`.
- Backlinks/connected-resource lists read from `resource_graph`.
- Page reindex works from graph-backed documents.
- `resource_graph.resolve` and `read_resource` can return ordered note/page body
  context when requested.

### Frontend

- Page editor, quick capture, and highlight note capture share one persistence
  controller.
- Resource graph BFF and frontend clients support edge read, create, delete, and
  resolve; only graph-document commands write order fields.
- Autosave is silent in the success path.
- Draft recovery survives refresh until server commit succeeds and requires an
  explicit save/retry or discard decision when a local draft is recovered.
- The editor supports indent, outdent, split, join, link, tag, and attach without
  leaving the writing surface.
- Frontend note DTOs may still carry graph-projected parent/page/order fields
  for the editor protocol, but no frontend path reads old `note_blocks`
  structure columns or writes generic resource-edge order keys.
- Citation click opens the correct page and activates the exact block.

### Evidence/Search

- Note/page content indexes through `content_blocks` and `content_chunks`.
- Search results can cite page/block content.
- Page-owned and note-owned evidence spans/chunks can be graph citation targets.
- Citation adapters activate note/page citations instead of degrading them to
  plain hrefs.
- Oracle availability works for a note-only corpus.
- Search scope tests prove containment, body refs, tags, attachments, user links,
  and citation edges only satisfy intended scope predicates.
- Containment-only movement schedules reindex.
- Stale object-search code paths are deleted.

## Test Plan

Backend:

- `python/tests/test_resource_graph_edges.py`
  - source order;
  - target order;
  - origin-aware uniqueness;
  - same endpoint pair can coexist across `user`, `note_body`,
    `highlight_note`, and `note_containment` where valid;
  - `replace_edges_for_origin` only replace-sets the requested origin;
  - containment order uniqueness;
  - graph citation writes for note/page-owned evidence;
  - note-block and page-owned evidence activation payloads.
- `python/tests/test_resource_graph_documents.py`
  - page roots;
  - nested blocks;
  - reorder;
  - move;
  - unlink;
  - single containment occurrence;
  - cycle rejection.
- `python/tests/test_notes.py`
  - page create;
  - document read;
  - document patch;
  - quick capture;
  - daily capture;
  - inline page refs;
  - inline block refs;
  - tags;
  - attachments;
  - replace-set does not clobber user/highlight/citation/containment edges;
  - graph traversal indexing;
  - reindex after movement;
  - single-occurrence indexing until occurrence ids ship.
- `python/tests/test_oracle.py`
  - note-only availability and retrieval.
- `python/tests/test_search.py`
  - explicit origin/kind allowlists for note containment, note body refs, tags,
    attachments, user links, and citations.
- `python/tests/test_agent_app_search.py`
  - default app-search scopes only use bare context refs;
  - ordinal citation edges do not widen app-search scope.
- `python/tests/test_cutover_negative_gates.py`
  - no runtime `object_graph_edges`;
  - no runtime `NoteBlock.parent_block_id` / `NoteBlock.order_key`;
  - no runtime SQL dependency on dropped `note_blocks` structure columns outside
    historical migration fixtures;
  - no frontend generic resource-edge order writes.
- `python/tests/test_resource_graph_routes.py`
  - graph route schemas expose order fields read-only where appropriate;
  - create/update routes do not accept public order writes.
- `python/tests/test_migrations.py`
  - `0148` preflights, backfill, constraints, indexes, and old-column drop.

Frontend:

- editor session tests for silent autosave, retry, and draft recovery;
- ProseMirror command tests for document patch conversion;
- focused E2E for page creation, nested bullet editing, reload, graph
  containment order, cleanup, block move, backlink, and citation activation.

Migration:

- representative old data:
  - flat page;
  - nested page;
  - reordered siblings;
  - duplicate sibling order values;
  - cross-user parent defect;
  - cross-page parent defect;
  - self-parent defect;
  - cycle defect;
  - inline refs;
  - highlight note;
  - tags;
  - attachments.

Grep/head assertions:

- no runtime `ObjectLink`;
- no runtime `object_links`;
- no runtime `object_graph_edges`;
- no runtime `NoteBlock.parent_block_id`;
- no runtime `NoteBlock.order_key`;
- no runtime SQL reads/writes of dropped `note_blocks` structure columns outside
  historical migration fixtures;
- no frontend generic resource-edge order writes.

## File Impact Map

### Docs

- `docs/cutovers/notes-pages-object-graph-hard-cutover.md`
- `docs/cutovers/notes-pages-evidence-unification-hard-cutover.md`
- `docs/cutovers/resource-provenance-graph-hard-cutover.md` to document the
  ordered-adjacency amendment to the flat edge contract
- `docs/architecture.md`

### Backend Models And Migrations

- `python/nexus/db/models.py`
- next migration after the resource-provenance graph head
- `python/tests/test_migrations.py`

### Backend Services

- `python/nexus/services/resource_graph/documents.py`
- `python/nexus/services/resource_graph/edges.py`
- `python/nexus/services/resource_graph/refs.py`
- `python/nexus/services/resource_graph/schemas.py`
- `python/nexus/services/resource_graph/resolve.py`
- `python/nexus/services/resource_graph/citations.py`
- `python/nexus/services/resource_graph/context.py`
- `python/nexus/services/resource_graph/cleanup.py`
- `python/nexus/services/highlight_access.py`
- `python/nexus/services/notes.py`
- `python/nexus/services/note_indexing.py`
- `python/nexus/tasks/page_reindex.py`
- `python/nexus/services/search/retrievers/notes.py`
- `python/nexus/services/search/scope.py`
- `python/nexus/services/locator_resolver.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/oracle.py`
- `python/nexus/services/vault.py`

### Backend Routes And Schemas

- `python/nexus/api/routes/notes.py`
- `python/nexus/api/routes/highlights.py`
- `python/nexus/schemas/notes.py`
- `python/nexus/schemas/highlights.py`
- `python/nexus/schemas/citation.py`
- `python/nexus/api/routes/resource_graph.py`
- `python/nexus/services/resource_graph/schemas.py`

### Frontend

- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`
- `apps/web/src/app/api/resource-graph/edges/route.ts`
- `apps/web/src/app/api/resource-graph/resolve/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/note/route.ts`
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
- `apps/web/src/lib/notes/pageDocumentPersistence.ts`
- `apps/web/src/lib/notes/prosemirror/commands.ts`
- `apps/web/src/components/QuickNotePanel.tsx`
- highlight quick note/editor components
- notes API client/hooks
- resource graph API client/types
- resource ref autocomplete/chips
- citation target conversion helpers
- reader activation helpers
- pane chrome/layout components

## Production Rules

- No feature flag for the old model.
- No dual write.
- No fallback to note block structure columns.
- No compatibility object-link route.
- No duplicate graph table.
- No route-level graph invariants.
- No origin-blind graph dedupe helper.
- No browser-direct FastAPI product data calls.
- No feature-specific citation target adapters that bypass the shared graph
  citation contract.
- No locator columns on `resource_edges`.
- No metadata bag on `resource_edges`.
- No projection treated as source of truth.
- No SQL cascades for polymorphic graph cleanup.

## Rollout Checklist

- [x] Build on merged `main` after `0147`.
- [x] Land order columns in the next migration after `0147`.
- [x] Add `source_order_key` and `target_order_key` to `resource_edges`.
- [x] Add `origin=note_containment`.
- [x] Add `tag` scheme and `tags` table.
- [x] Replace broad bare-pair uniqueness with origin-aware uniqueness.
- [x] Replace origin-blind resource graph writer dedupe with origin-aware
      service checks.
- [x] Add migration preflight and deterministic sibling order normalization.
- [x] Backfill note block structure into `origin=note_containment` edges.
- [x] Backfill collapsed state into `note_view_states`.
- [x] Drop old note block structural columns.
- [x] Implement `resource_graph.documents`.
- [x] Replace notes tree mutation with resource graph document commands.
- [x] Sync changed block body refs through `origin=note_body`.
- [x] Sync inline `#tag` text into first-class `tag:` resources and
      `origin=note_body` edges.
- [x] Adapt note indexing to containment traversal.
- [x] Enforce single containment occurrence until transclusion carries occurrence
      ids end to end.
- [x] Fix graph citation writes for note/page-owned evidence.
- [x] Fix note-only Oracle availability and retrieval.
- [x] Add explicit search scope origin/kind allowlists.
- [x] Fix note/page citation activation.
- [x] Add resource graph BFF/client support for read, create, delete, and
      resolve.
- [x] Hide autosave success-state chrome; only failure state is visible.
- [x] Route backend daily quick capture through the graph-backed page document
      patch command.
- [x] Make quick capture caller-block-id idempotent and expose it through
      `/api/notes/quick-capture`.
- [x] Consolidate frontend editor persistence onto one write surface. The page
      editor and quick capture use the versioned document command path;
      highlight note save/delete uses a highlight product route that writes via
      the same document mutation machinery; quick-note empty-delete plans a
      page-document deletion instead of calling block mutation APIs.
- [x] Ship low chrome writing surface: success autosave chrome is silent and
      object connections publish through the generic secondary connections surface.
- [x] Add quick/daily/highlight capture over the shared editor session
      controller.
- [x] Replace public `/api/notes/blocks` mutation clients/routes with product
      routes or document-command helpers. Keep only read-only
      `GET /api/notes/blocks/{blockId}` for resource resolution.
- [x] Add first-class `#tag` autocomplete in the writing surface, backed by
      type-filtered object-ref search so tag results are not starved by page or
      block matches.
- [x] Resolve pasted URLs in the writing surface. URL-only paste uses the
      existing media URL intake path and inserts graph-backed media embeds;
      mixed prose still falls through to normal text/markdown paste to avoid
      data loss.
- [x] Add a visible draft recovery affordance for saved local drafts that have
      not committed to the server. Page, highlight-note, and quick-note editors
      use one recovery affordance; quick-note refresh recovery has a stable daily
      draft key and persists with the recovered block id.
- [x] Remove legacy service-level block mutation helpers and migrate tests to
      page-document commands / graph-document fixtures.
- [x] Remove remaining function-local `resource_graph.edges` imports from
      `notes.py` by fixing the service dependency boundary.
- [x] Ship attachment creation/editing through resource graph-backed refs.
- [x] Update stale docs and obsolete test-plan references.
- [x] Run focused backend, frontend, and migration checks.
- [x] Add and run a true E2E acceptance flow for page edit, nested bullet
      persistence, reload, graph containment order, and page cleanup.

## Current Validation Snapshot

The latest focused validation for the notes/pages object-graph hard cutover
passed:

- backend ruff check/format and Python compile on the changed notes, vault,
  graph-document, search, app-search, seed, and focused test files;
- backend integration slice: `test_resource_graph_documents.py`, stale document
  conflict payload, highlight-note attachment/idempotency, highlight resource
  resolution, vault import/export, default conversation note scope, and the full
  search scope matrix: 69 passed;
- migration preflight negatives for `0148` parent user mismatch, parent page
  mismatch, self-parent, and containment cycle: 6 passed;
- `npm --prefix apps/web run typecheck`;
- `npm --prefix apps/web run lint -- --quiet`;
- browser Vitest for the outline editor attachment guard and pane-route
  canonical resource refs: 12 + 8 passed;
- unit Vitest for empty resource-edge resolution: 6 passed;
- residue scans proving the removed service-level mutators have no runtime
  references and public block mutation routes remain deleted.

## Post-Audit Closures

The follow-up audit gaps have been closed in code and tests:

- Note citation activation now preserves `startOffset`/`endOffset` into the
  editor and decorates the exact cited range with codepoint-correct offsets,
  including targets delivered before the editor view mounts.
- Page title edits now use the same debounced `/document` autosave, local draft,
  retry, and discard path as body edits; the legacy blur-only page-title update
  path is no longer used by the editor.
- New-page focus is explicit and one-shot. Creation paths set a pending
  title/body focus handoff; existing page opens do not steal focus.
- Object-ref/tag autocomplete now uses a proper editor/listbox combobox
  contract: stable listbox/option ids, `aria-activedescendant`, active option
  state, ArrowUp/ArrowDown/Home/End, Enter/Tab selection, and Escape dismissal.
- `object_refs.py` searches and hydrates page-owned `content_chunk` and
  `evidence_span` refs through the shared graph resolver, routing them to
  `/notes/{blockId}` instead of media-only paths.
- Chat, Library Intelligence, and Oracle now share reader-source activation for
  media and note citations. Oracle REST detail and streamed passage events
  surface page-owned note citations with `media_id=null` and
  `note_block_offsets` locators.

Additional focused validation after these closures:

- `npm --prefix apps/web run test:browser -- 'src/app/(authenticated)/pages/[pageId]/PagePaneBody.test.tsx'`;
- `npm --prefix apps/web run test:browser -- src/components/notes/ProseMirrorOutlineEditor.test.tsx`;
- `npm --prefix apps/web run test:browser -- 'src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.test.tsx' src/__tests__/components/LibraryIntelligencePane.test.tsx`;
- `npm --prefix apps/web run typecheck`;
- `./scripts/with_test_services.sh bash -lc 'make migrate-test >/tmp/nexus-migrate-test.log && cd python && NEXUS_ENV=test uv run pytest -q tests/test_notes.py::test_object_ref_search_and_hydration_support_page_owned_chunks_and_spans'`;
- `./scripts/with_test_services.sh bash -lc 'make migrate-test >/tmp/nexus-migrate-test.log && cd python && NEXUS_ENV=test uv run pytest -q tests/test_oracle.py::test_execute_reading_page_owned_note_passage_carries_note_citation_out tests/test_oracle.py::test_execute_reading_user_media_passage_carries_citation_out tests/test_oracle.py::test_execute_reading_passage_event_carries_citation_for_user_media tests/test_oracle.py::test_get_reading_detail_degrades_citation_to_none_when_backing_span_is_gone'`.

## Definition Of Done

The cutover is done when a user can open a page, type nested bullets, link to
objects, tag content, attach resources, annotate a highlight, leave the page,
return later, search the content, click a citation, and land on the exact block,
with all page/block structure and cross-resource relationships persisted in
`resource_edges`, and no runtime dependency on old note block parent/order/page
columns.

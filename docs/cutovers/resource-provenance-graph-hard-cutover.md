# Resource Provenance Graph - Hard Cutover

Status: SPEC - not built
Author: design synthesis, 2026-06-07
Type: hard cutover - greenfield, one-user prototype, no production data migration, no fallbacks, no backward compatibility, no compatibility shims

Precedents:
- `docs/rules/cleanliness.md`: one owner per concern, collapse dangerous duplication, typed public contracts, no fallback lanes.
- `docs/rules/layers.md`: routes validate and dispatch; services own business logic.
- `docs/rules/database.md`: no database cascades, explicit cleanup, `SERIALIZABLE` for sequential-equivalence writes.
- `docs/architecture.md`: `resource_uri` is already the vocabulary bridging conversation references, citations, prompt rendering, and read/inspect tools.
- `docs/cutovers/library-intelligence-ai-native-consolidation-hard-cutover.md`: Rev 2 keeps current stores separate in the LI cutover, but names a later provenance-graph cutover as the long-term consolidation path.

---

## 0. North Star

Replace the ad hoc link/reference/citation stores with one typed **Resource Provenance Graph** owner.

The graph owns durable relationships between generated outputs, conversations, retrieved evidence, public resources, workspace objects, and citation targets. It does not flatten everything into today's `object_links` table. It introduces one canonical `ResourceRef`, one base `resource_edges` table, and typed sidecar tables for the distinct invariants that currently live in:

- `conversation_references`
- `message_retrievals`
- `message_retrieval_candidate_ledgers`
- `oracle_reading_passages`
- `object_links`
- new `library_intelligence_citations` from the LI cutover, if that cutover has already landed

The final product has one edge owner, one resolver vocabulary, one citation read-model, one cleanup owner, and one frontend citation adapter. Domain-specific payloads remain typed sidecars, not nullable JSON soup.

---

## 1. SME Thesis

The gold-standard move is not "store all links in `object_links`." That would preserve table-count simplicity while destroying semantic clarity.

The actual shared primitive is:

> A typed edge from one `ResourceRef` to another `ResourceRef`, with edge-kind-specific invariants.

The SME question is always: **what invariant owns this edge?**

| Current thing | Actual invariant | Future edge kind |
|---|---|---|
| `conversation_references` | Conversation admission and prompt context boundary | `context_ref` |
| `message_retrievals` | Retrieved result snapshot, replay, selected/cited state | `retrieval_candidate` plus optional `citation` |
| `message_retrieval_candidate_ledgers` | Candidate/rerank trace and selection explanation | `retrieval_candidate` |
| `oracle_reading_passages` | Generated folio passage plus marginalia/concordance target | `citation` with `oracle_folio` sidecar |
| `object_links` | User-authored workspace relationship between resources | `workspace_link` |
| `library_intelligence_citations` | Artifact citation ordinal to grounded source | `citation` |

Storage consolidation is allowed only after each invariant has a typed home. No table shape drives the design.

---

## 2. Current State

### 2.1 `resource_uri` is the right seed

`resource_resolver.py` already owns `<scheme>:<uuid>`, presentation, missing behavior, and prompt-facing summaries. `resource_loaders.py` owns scheme-specific SQL and permissions. This is the correct foundation, but it is currently scoped to conversation references and prompt assembly.

Current schemes include:

```text
media
library
span
chunk
highlight
page
note_block
fragment
conversation
message
```

The graph cutover promotes this into the canonical persisted reference format for all edges.

### 2.2 `conversation_references` is context, not a generic link

`conversation_references` gates:

- initial conversation references from `POST /conversations`
- `context_assembler._build_resources_block`
- `app_search` default scopes and explicit scope validation
- `read_resource`, `inspect_resource`, and `chat_run_validation` admission checks
- `reference_added` SSE
- reverse "which conversations reference this resource" lists

It must become a typed `context_ref` edge, not a workspace link.

### 2.3 `message_retrievals` is retrieval replay, not just citation

`message_retrievals` stores:

- tool call result ordinal
- result type and source id
- selected flag
- prompt-inclusion state
- citation ordinal
- display snapshot
- locator
- `context_ref` and `result_ref` JSON
- media/evidence span foreign keys
- replay state for message GETs and frontend rendering

`message_retrieval_candidate_ledgers` also points back to `message_retrievals`. The future graph must preserve both candidate trace and selected citation rendering.

### 2.4 `oracle_reading_passages` is generated folio content

An Oracle passage is not a bare citation. It stores:

- phase: `descent`, `ordeal`, `ascent`
- source kind: user media or public domain
- exact snippet
- locator label and locator
- source snapshot
- attribution text
- marginalia text
- deep link

`compute_concordance` uses source/locator equality across readings. The graph must keep generated folio content typed and queryable.

### 2.5 `object_links` is user workspace relationship CRUD

`object_links` currently owns user-facing links with:

- two endpoint object refs
- relation type
- optional endpoint locators
- optional order keys
- metadata
- symmetric duplicate detection for unlocated pairs
- committing CRUD service calls

It is not a suitable owner for machine-generated directed citations. In the final state, it is replaced by `workspace_link` edges under the graph owner.

---

## 3. Goals

G1. **One canonical resource identity.** Every persisted edge uses `ResourceRef`, not per-feature `result_type/source_id`, `resource_uri`, `ObjectRef`, and Oracle source JSON variants.

G2. **One graph owner.** All link/reference/citation/folio/workspace-edge writes go through `services/resource_graph/*`.

G3. **Typed sidecars, no null soup.** Common edge identity is shared; domain-specific payload lives in typed sidecar tables.

G4. **Feature behavior preserved.** Chat replay, app-search scoping, `read_resource` admission, `reference_added`, citation chips, Oracle concordance, Oracle marginalia, and workspace link CRUD all survive with no compatibility layer.

G5. **Current-only resource resolution.** Reader jumps resolve against active content index state. Historical display snapshots are for cards/replay, not hidden fallback reads.

G6. **One citation render contract.** Chat, Oracle, Library Intelligence, attached resources, and read-resource evidence all emit the same `CitationOut` shape to the frontend.

G7. **Hard cleanup.** Delete old stores, old routes, old schemas, old helpers, old tests, and old docs references in the same cutover. No dual-read, dual-write, bridge, backfill, or compatibility shim.

G8. **Prototype-simple, production-grade.** Single-user deployment removes cross-tenant complexity, not correctness. Keep user ownership explicit because it is part of the permission and cleanup model.

---

## 4. Non-goals

N1. No knowledge-graph product UI, graph visualization, recommendations, or semantic graph traversal.

N2. No compatibility with old API shapes.

N3. No backfill of existing local prototype rows. This is greenfield; old rows are dropped.

N4. No historical citation resolver. If a target no longer resolves against current content, the edge remains for display/replay and the jump fails closed.

N5. No distributed/multi-user collaboration semantics. One viewer owns the graph rows. Shared libraries can still be checked through existing resource permissions.

N6. No generic "metadata JSON can mean anything" escape hatch. JSON snapshots are display snapshots only; identity and behavior columns are typed.

N7. No attempt to fold `message_tool_calls`, chat runs, Oracle readings, or Library Intelligence artifacts into the graph. They remain domain parents.

---

## 5. Target Behavior

### 5.1 Chat context

Adding a resource to a conversation creates a `context_ref` edge:

```text
source = conversation:<conversation_id>
target = <resource_ref>
kind = context_ref
```

The conversation owner can list and remove context refs. `app_search` may search only `media:` or `library:` context refs on the conversation. `read_resource` and `inspect_resource` may read only referenced resources unless the tool has a narrower bind-only exception already owned by chat validation.

`reference_added` SSE is still emitted when a citation materializes a new conversation context ref, but the event payload is built from the graph read model.

### 5.2 Chat retrieval and citations

Each `app_search`, `web_search`, attached-resource, or `read_resource` evidence result creates a `retrieval_candidate` edge from the tool call to the retrieved resource target:

```text
source = message_tool_call:<tool_call_id>
target = <resource_ref or external_snapshot>
kind = retrieval_candidate
```

Selected/cited retrieval candidates also get a `citation` edge from the assistant message to the cited target:

```text
source = message:<assistant_message_id>
target = <resource_ref or external_snapshot>
kind = citation
ordinal = dense turn-global N
```

Message replay and the frontend no longer read `message_retrievals`. They read citation edges and retrieval candidate sidecars.

### 5.3 Oracle folios

Oracle writes one `citation` edge per phase, with an Oracle folio sidecar:

```text
source = oracle_reading:<reading_id>
target = <resource_ref or oracle_corpus_passage:<id>>
kind = citation
role = source
phase = descent | ordeal | ascent
```

The citation sidecar provides the shared `CitationOut` fields. The folio sidecar stores marginalia, attribution, and phase-specific Oracle content.

Concordance compares normalized target identity plus locator, not raw Oracle JSON blobs.

### 5.4 Workspace links

User-authored workspace links create `workspace_link` edges:

```text
source = <resource_ref>
target = <resource_ref>
kind = workspace_link
relation = references | embeds | note_about | used_as_context | derived_from | related
```

The graph owner preserves current object-link behavior:

- symmetric duplicate prevention for unlocated undirected links
- directed semantics where relation kind requires direction
- endpoint locators
- endpoint order keys
- editable metadata
- canonical hydration through the resource resolver

### 5.5 Library Intelligence citations

If the AI-native LI cutover has landed, `library_intelligence_citations` is deleted in this graph cutover. LI artifact citations become `citation` edges:

```text
source = library_intelligence_artifact:<artifact_id>
target = evidence_span:<span_id> | content_chunk:<chunk_id> | media:<media_id>
kind = citation
role = supports | contradicts | context
ordinal = N
```

If LI has not landed, this section is skipped and the graph still includes the `library_intelligence_artifact` scheme for future use.

---

## 6. Final Architecture

```text
services/resource_graph/
  refs.py              ResourceRef grammar, parse/format, typed schemes
  resolve.py           batch hydrate refs for prompt/UI/API
  edges.py             base edge create/list/delete, common invariants
  context.py           conversation context refs and admission checks
  retrievals.py        tool-call retrieval candidates, selected state, replay
  citations.py         CitationOut builder and dense ordinal ownership
  folios.py            Oracle folio sidecar on citation edges, concordance target matching
  workspace_links.py   user-authored workspace relation CRUD
  cleanup.py           explicit edge cleanup for deleted resources
  schemas.py           internal dataclasses / typed payloads

api/routes/resource_graph.py
api/routes/conversation_context.py
api/routes/workspace_links.py
api/routes/retrieval_ledgers.py

apps/web/src/lib/resourceGraph/
  resourceRef.ts
  citations.ts
  workspaceLinks.ts
  contextRefs.ts
```

Feature modules call graph public functions. They do not write graph tables directly.

---

## 7. ResourceRef Contract

### 7.1 Canonical schemes

`ResourceRef` replaces the split between `resource_uri`, `ObjectRef`, `result_type/source_id`, and Oracle source JSON.

Initial schemes:

```text
media
library
evidence_span
content_chunk
highlight
page
note_block
fragment
conversation
message
message_tool_call
oracle_reading
oracle_corpus_passage
library_intelligence_artifact
external_snapshot
contributor
podcast
```

Compatibility aliases are not kept. `span:` becomes `evidence_span:` and `chunk:` becomes `content_chunk:` in the final state. This is a hard cutover; all callers move.

### 7.2 Type

```python
ResourceScheme = Literal[
    "media",
    "library",
    "evidence_span",
    "content_chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
    "message_tool_call",
    "oracle_reading",
    "oracle_corpus_passage",
    "library_intelligence_artifact",
    "external_snapshot",
    "contributor",
    "podcast",
]

@dataclass(frozen=True, slots=True)
class ResourceRef:
    scheme: ResourceScheme
    id: UUID

    @property
    def uri(self) -> str: ...
```

### 7.3 Rules

- Resource identity is typed columns in the database, not an unvalidated string.
- The string URI is an API/display format generated from typed columns.
- `parse_resource_ref` returns a typed failure, not `None`.
- Permission checks live in `resource_graph.resolve`, backed by resource-specific loaders.
- Missing/forbidden refs hydrate as `missing=True` for historical display, but writes reject missing targets unless a sidecar explicitly allows external snapshots.

---

## 8. Data Model

### 8.1 `resource_edges`

Base table for every edge.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid not null | single-user owner and cleanup scope |
| `edge_kind` | text not null | `context_ref`, `retrieval_candidate`, `citation`, `workspace_link` |
| `source_scheme` | text not null | `ResourceScheme` check |
| `source_id` | uuid not null | |
| `target_scheme` | text not null | `ResourceScheme` check |
| `target_id` | uuid not null | |
| `source_locator` | jsonb null | endpoint locator, object shape |
| `target_locator` | jsonb null | endpoint locator, object shape |
| `created_at` | timestamptz not null default now() | |
| `updated_at` | timestamptz not null default now() | |

Indexes:

- `(user_id, edge_kind, source_scheme, source_id, created_at, id)`
- `(user_id, edge_kind, target_scheme, target_id, created_at, id)`
- partial unique for `context_ref`: `(source_scheme, source_id, target_scheme, target_id)` where `edge_kind = 'context_ref'`
- partial unique for Oracle folio phase via sidecar, not base
- no generic unique index for citations or retrieval candidates; those are sidecar-owned

### 8.2 `resource_edge_context_refs`

Conversation context sidecar.

| column | type | notes |
|---|---|---|
| `edge_id` | uuid pk/fk `resource_edges.id` | edge kind must be `context_ref` |
| `conversation_id` | uuid not null | equals source id; duplicated for fast joins |
| `added_by` | text not null | `user`, `citation`, `system` |
| `created_at` | timestamptz not null default now() | |

Constraints:

- `unique(conversation_id, edge_id)`
- service asserts `source_scheme = 'conversation'`

### 8.3 `resource_edge_retrieval_candidates`

Retrieval and candidate ledger sidecar.

| column | type | notes |
|---|---|---|
| `edge_id` | uuid pk/fk `resource_edges.id` | edge kind `retrieval_candidate` |
| `tool_call_id` | uuid not null | equals source id |
| `ordinal` | int not null | candidate ordinal in the tool call |
| `result_type` | text not null | canonical search result type at capture time |
| `source_id_text` | text not null | provider/search source id for replay/debug |
| `scope` | text not null | original scope URI or `web`/`attached_context`/`read_resource` |
| `score` | double precision null | |
| `selected` | bool not null default false | |
| `included_in_prompt` | bool not null default false | |
| `selection_status` | text not null | `retrieved`, `selected`, `included_in_prompt`, `excluded_by_budget`, `excluded_by_scope`, `web_result`, `attached_context` |
| `selection_reason` | text null | |
| `display_snapshot` | jsonb not null | title/snippet/source_label/deep_link/card fields only |
| `locator_snapshot` | jsonb null | normalized locator at capture time |
| `created_at` | timestamptz not null default now() | |

Constraints:

- `unique(tool_call_id, ordinal)`
- selected candidates may have zero or one linked citation edge through `resource_edge_citations.retrieval_edge_id`

### 8.4 `resource_edge_citations`

Citation sidecar.

| column | type | notes |
|---|---|---|
| `edge_id` | uuid pk/fk `resource_edges.id` | edge kind `citation` |
| `source_output_scheme` | text not null | `message`, `oracle_reading`, `library_intelligence_artifact` |
| `source_output_id` | uuid not null | duplicated source id for fast queries |
| `ordinal` | int not null | dense within output |
| `role` | text not null | `supports`, `contradicts`, `context`, `source`, `quotation`, `web` |
| `retrieval_edge_id` | uuid null | selected retrieval candidate, if citation came from retrieval |
| `display_snapshot` | jsonb not null | title/snippet/source_label/deep_link/card fields |
| `created_at` | timestamptz not null default now() | |

Constraints:

- `unique(source_output_scheme, source_output_id, ordinal)`
- if `retrieval_edge_id` is not null, it references a `retrieval_candidate` edge
- source output scheme must match base `source_scheme`

### 8.5 `resource_edge_oracle_folios`

Oracle folio sidecar on a citation edge.

| column | type | notes |
|---|---|---|
| `edge_id` | uuid pk/fk `resource_edges.id` | edge kind `citation`; source scheme `oracle_reading` |
| `reading_id` | uuid not null | equals source id |
| `phase` | text not null | `descent`, `ordeal`, `ascent` |
| `source_kind` | text not null | `user_media`, `public_domain` |
| `exact_snippet` | text not null | |
| `locator_label` | text not null | |
| `attribution_text` | text not null | |
| `marginalia_text` | text not null | |
| `display_snapshot` | jsonb not null | minimal source card snapshot |
| `created_at` | timestamptz not null default now() | |

Constraints:

- `unique(reading_id, phase)`
- concordance compares `(target_scheme, target_id, target_locator)` from the base edge

### 8.6 `resource_edge_workspace_links`

User-authored workspace links sidecar.

| column | type | notes |
|---|---|---|
| `edge_id` | uuid pk/fk `resource_edges.id` | edge kind `workspace_link` |
| `relation_type` | text not null | `references`, `embeds`, `note_about`, `used_as_context`, `derived_from`, `related` |
| `directionality` | text not null | `directed`, `undirected` |
| `source_order_key` | text null | |
| `target_order_key` | text null | |
| `metadata` | jsonb not null default `{}` | object only, user display metadata |
| `created_at` | timestamptz not null default now() | |

Indexes/constraints:

- partial unique unlocated undirected pair using least/greatest typed endpoint keys for `directionality = 'undirected'`
- directed duplicate uniqueness is service-owned and relation-specific, not a broad DB trick

### 8.7 `resource_external_snapshots`

Stable target for public web results and other non-local resources.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | referenced by `external_snapshot:<id>` |
| `user_id` | uuid not null | |
| `provider` | text not null | `brave`, `manual`, etc. |
| `url` | text not null | |
| `title` | text not null | |
| `snippet` | text not null | |
| `source_snapshot` | jsonb not null | provider payload subset for replay |
| `created_at` | timestamptz not null default now() | |

This prevents web citations from becoming JSON-only pseudo-resources.

### 8.8 `oracle_corpus_passages`

Stable target for public-domain Oracle passages when they are not already backed by ordinary `media`/`evidence_span` rows.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | referenced by `oracle_corpus_passage:<id>` |
| `corpus_key` | text not null | |
| `work_key` | text not null | |
| `passage_key` | text not null | stable locator key |
| `title` | text not null | |
| `locator_label` | text not null | |
| `text` | text not null | |
| `created_at` | timestamptz not null default now() | |

Unique key: `(corpus_key, work_key, passage_key)`.

---

## 9. Capability Contracts

### 9.1 `resource_graph.refs`

```python
parse_resource_ref(raw: str) -> ResourceRef | ResourceRefParseFailure
format_resource_ref(ref: ResourceRef) -> str
resource_ref_from_parts(scheme: ResourceScheme, id: UUID) -> ResourceRef
assert_resource_ref(raw: str) -> ResourceRef
```

### 9.2 `resource_graph.resolve`

```python
resolve_ref(db, *, viewer_id: UUID, ref: ResourceRef) -> ResolvedResource
resolve_refs(db, *, viewer_id: UUID, refs: Sequence[ResourceRef]) -> list[ResolvedResource]
assert_ref_visible(db, *, viewer_id: UUID, ref: ResourceRef) -> None
```

`ResolvedResource` is the single backend read model for label, summary, inline body, fetch hint, missing state, and permission-sensitive hydration.

### 9.3 `resource_graph.context`

```python
list_context_refs(db, *, viewer_id: UUID, conversation_id: UUID) -> list[ContextRefOut]
add_context_ref_without_commit(db, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef, added_by: ContextAddedBy) -> ContextRefOut
add_context_ref(db, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef, added_by: ContextAddedBy) -> ContextRefOut
remove_context_ref(db, *, viewer_id: UUID, conversation_id: UUID, edge_id: UUID) -> None
is_context_ref(db, *, conversation_id: UUID, target: ResourceRef) -> bool
list_conversations_with_context_ref(db, *, viewer_id: UUID, target: ResourceRef, limit: int, cursor: str | None) -> ConversationPage
search_scope_refs_for_conversation(db, *, conversation_id: UUID) -> list[ResourceRef]
```

`add_context_ref_without_commit` is required so `POST /conversations` and citation write-through can compose atomically.

### 9.4 `resource_graph.retrievals`

```python
record_retrieval_candidate(
    db,
    *,
    viewer_id: UUID,
    tool_call_id: UUID,
    ordinal: int,
    target: ResourceRef,
    capture: RetrievalCapture,
) -> ResourceEdgeId

record_retrieval_candidates_replace_set(
    db,
    *,
    viewer_id: UUID,
    tool_call_id: UUID,
    candidates: Sequence[RetrievalCandidateInput],
) -> list[ResourceEdgeId]

list_retrieval_candidates_for_tool_call(db, *, viewer_id: UUID, tool_call_id: UUID) -> list[RetrievalCandidateOut]
list_retrieval_debug_ledgers(db, *, viewer_id: UUID, tool_call_id: UUID) -> RetrievalLedgerOut
```

This replaces `retrieval_citation.insert_retrieval_row`, `message_retrievals`, and `message_retrieval_candidate_ledgers`.

### 9.5 `resource_graph.citations`

```python
record_citation(
    db,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    target: ResourceRef,
    ordinal: int,
    role: CitationRole,
    display_snapshot: CitationSnapshot,
    retrieval_edge_id: UUID | None = None,
) -> ResourceEdgeId

replace_citations_for_output(
    db,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    citations: Sequence[CitationInput],
) -> list[ResourceEdgeId]

build_citation_outs(db, *, viewer_id: UUID, source: ResourceRef) -> list[CitationOut]
emit_citation_index_event(db, *, run: ChatRun) -> None
```

`CitationOut` is the only backend shape consumed by the frontend citation adapter.

### 9.6 `resource_graph.folios`

```python
replace_oracle_folios(
    db,
    *,
    viewer_id: UUID,
    reading_id: UUID,
    folios: Sequence[OracleFolioInput],
) -> list[OracleFolioOut]

list_oracle_folios(db, *, viewer_id: UUID, reading_id: UUID) -> list[OracleFolioOut]
compute_oracle_concordance(db, *, viewer_id: UUID, reading_id: UUID) -> list[ConcordanceEntryOut]
```

Oracle owns reading generation; graph owns folio persistence and concordance target matching.

### 9.7 `resource_graph.workspace_links`

```python
create_workspace_link(db, *, viewer_id: UUID, input: WorkspaceLinkCreate) -> WorkspaceLinkOut
list_workspace_links(db, *, viewer_id: UUID, subject: ResourceRef | None, target: ResourceRef | None, relation: WorkspaceRelation | None) -> list[WorkspaceLinkOut]
update_workspace_link(db, *, viewer_id: UUID, edge_id: UUID, patch: WorkspaceLinkPatch) -> WorkspaceLinkOut
delete_workspace_link(db, *, viewer_id: UUID, edge_id: UUID) -> None
repoint_workspace_links(db, *, viewer_id: UUID, edge_ids: Sequence[UUID], from_ref: ResourceRef, to_ref: ResourceRef) -> int
```

This replaces `object_links.py` and the contributor split link move path.

### 9.8 `resource_graph.cleanup`

```python
delete_edges_for_deleted_resource(db, *, ref: ResourceRef) -> None
null_or_delete_edges_for_deleted_media(db, *, media_id: UUID) -> None
assert_no_edges_for_deleted_resource(db, *, ref: ResourceRef) -> None
```

Cleanup is explicit application code. No `ON DELETE CASCADE`.

---

## 10. API Design

Old route modules are deleted:

- `api/routes/conversation_references.py`
- `api/routes/object_links.py`
- `api/routes/message_retrievals.py`

New route modules:

### 10.1 Conversation context

| Method | Route | Service | Notes |
|---|---|---|---|
| GET | `/conversations/{id}/context-refs` | `resource_graph.context.list_context_refs` | replaces list conversation references |
| POST | `/conversations/{id}/context-refs` | `resource_graph.context.add_context_ref` | body `{resource_ref}` |
| DELETE | `/conversations/{id}/context-refs/{edge_id}` | `resource_graph.context.remove_context_ref` | |
| GET | `/conversations?has_context_ref=...` | `list_conversations_with_context_ref` | replaces `has_reference` |

### 10.2 Workspace links

| Method | Route | Service | Notes |
|---|---|---|---|
| GET | `/resource-graph/workspace-links` | `workspace_links.list_workspace_links` | filters: `subject`, `target`, `relation` |
| POST | `/resource-graph/workspace-links` | `workspace_links.create_workspace_link` | body has typed refs |
| PATCH | `/resource-graph/workspace-links/{edge_id}` | `workspace_links.update_workspace_link` | |
| DELETE | `/resource-graph/workspace-links/{edge_id}` | `workspace_links.delete_workspace_link` | |

### 10.3 Retrieval ledgers

| Method | Route | Service | Notes |
|---|---|---|---|
| GET | `/resource-graph/retrievals/tool-calls/{tool_call_id}` | `retrievals.list_retrieval_debug_ledgers` | replaces message retrieval debug routes |

### 10.4 Resource resolution

| Method | Route | Service | Notes |
|---|---|---|---|
| POST | `/resource-graph/resolve` | `resolve.resolve_refs` | body `{refs:[...]}` for UI hydration |

No route owns business logic. Routes parse request envelopes, call graph services, and return schemas.

---

## 11. Composition With Existing Systems

### 11.1 Conversations

`conversations.create` calls `add_context_ref_without_commit` for initial refs inside the same transaction that creates the conversation. Conversation delete explicitly deletes graph edges where `source = conversation:<id>` and graph edges tied to its messages/tool calls.

### 11.2 Context assembler

`context_assembler._build_resources_block` reads `resource_graph.context.list_context_refs`. Its `source_refs` point at graph edge IDs, not `conversation_references` row IDs.

### 11.3 `app_search`

`app_search._resolve_scope_uris` becomes `resource_graph.context.search_scope_refs_for_conversation`. The search tool no longer queries `conversation_references` directly.

`app_search` persists retrieval candidates through `resource_graph.retrievals.record_retrieval_candidates_replace_set`.

### 11.4 `web_search`

Web results get `external_snapshot` resources, retrieval candidates, and citation edges. Public web citations no longer live as JSON-only `message_retrievals.result_ref` rows.

### 11.5 `read_resource`

`read_resource` admission calls `resource_graph.context.is_context_ref`, except for any explicit chat-owned bind-only selection path. Evidence reads create retrieval candidates and citation edges through graph services.

### 11.6 `inspect_resource`

`inspect_resource` admission calls graph context checks. It still does not create citations.

### 11.7 Chat runs

`chat_runs._persist_attached_citations`, `_persist_read_evidence_citation`, and `_emit_citation_index` are replaced by calls into `resource_graph.retrievals` and `resource_graph.citations`.

`citation_index` SSE event shape changes from `retrieval_id` to graph `citation_edge_id` plus `retrieval_edge_id` when present. There is no compatibility branch.

### 11.8 Oracle

Oracle generation still owns prompt, model call, reading status, and event emission. Folio persistence moves to `resource_graph.folios.replace_oracle_folios`. `compute_concordance` moves to graph folios.

### 11.9 Library Intelligence

LI artifact generation records artifact citations with `resource_graph.citations.replace_citations_for_output`. The LI-private citation table is deleted if present.

### 11.10 Notes, pins, contributors

`object_refs.py` no longer hydrates `object_links`. It consumes `resource_graph.resolve`. Contributor merge/split paths call `resource_graph.workspace_links.repoint_workspace_links`.

### 11.11 Media deletion and content reindex

`media_deletion.py` and `content_indexing.py` stop deleting `object_links` and nulling `message_retrievals`. They call `resource_graph.cleanup` once. The cleanup service owns every graph edge affected by the deleted resource.

### 11.12 Frontend

Frontend deletes object-link and conversation-reference specific clients. New modules:

- `lib/resourceGraph/resourceRef.ts`
- `lib/resourceGraph/contextRefs.ts`
- `lib/resourceGraph/workspaceLinks.ts`
- `lib/resourceGraph/citations.ts`

`buildCitations` consumes `CitationOut[]`. `ReaderCitation` remains the renderer. Conversation references surfaces become context-ref surfaces.

---

## 12. Duplication Removed

| Duplicate/repetitive pattern | Current locations | New owner |
|---|---|---|
| Resource identity parsing | `resource_resolver`, frontend `resourceKind`, object ref schemas, retrieval result refs | `resource_graph.refs` plus frontend `resourceRef.ts` |
| Resource hydration | `resource_resolver`, `object_refs`, object-link service, conversation references | `resource_graph.resolve` |
| Context admission checks | `conversation_references`, `app_search`, `read_resource`, `inspect_resource`, chat validation | `resource_graph.context` |
| Citable retrieval row materialization | `retrieval_citation`, `chat_runs`, `app_search`, `web_search` | `resource_graph.retrievals` |
| Citation index construction | `chat_runs`, frontend `buildCitations`, future LI adapter, Oracle jump adapter | `resource_graph.citations` + `CitationOut` |
| Generated passage/folio storage | Oracle-local passage persistence and concordance SQL | `resource_graph.folios` on citation edges |
| User link CRUD and hydration | `object_links`, `object_refs`, notes schemas | `resource_graph.workspace_links` |
| Cleanup of refs to deleted media/chunks/spans | `media_deletion`, `content_indexing`, ad hoc SQL | `resource_graph.cleanup` |

---

## 13. Migration Plan

One irreversible Alembic head migration. Greenfield reset; no backfill.

### 13.1 Create

- `resource_edges`
- `resource_edge_context_refs`
- `resource_edge_retrieval_candidates`
- `resource_edge_citations`
- `resource_edge_oracle_folios`
- `resource_edge_workspace_links`
- `resource_external_snapshots`
- `oracle_corpus_passages`

### 13.2 Drop

- `conversation_references`
- `message_retrieval_candidate_ledgers`
- `message_rerank_ledgers` if its only remaining purpose is tied to old retrieval IDs; otherwise rewrite it as a graph sidecar in the same migration
- `message_retrievals`
- `oracle_reading_passages`
- `object_links`
- `library_intelligence_citations` if it exists

### 13.3 Update checks

- Remove old `citation_index` payload assumptions from chat SSE schema if they mention retrieval IDs.
- Remove `resource_uri` route/request schema dependencies outside graph APIs.
- Add `ResourceScheme` checks to graph tables.

### 13.4 No compatibility

No views named like old tables. No insert triggers. No dual-write. No data copy. No route aliases.

---

## 14. Implementation Slices

Because this is broad, implementation can be reviewed in slices, but main must never contain a mixed old/new runtime.

S0. **ResourceRef and resolver contract.**
Add `resource_graph.refs` and `resource_graph.resolve`; update docs and tests. No old storage change yet.

S1. **Graph schema and service owner.**
Add migration and service modules. In a feature branch, wire graph writes for all consumers.

S2. **Conversation context hard cut.**
Replace `conversation_references` consumers with context edges: conversations, context assembler, app_search scope validation, read/inspect admission, highlights reverse lookup, frontend context refs.

S3. **Retrieval/citation hard cut.**
Replace `message_retrievals`, candidate ledgers, `retrieval_citation`, `_emit_citation_index`, frontend citation construction, retrieval debug routes.

S4. **Oracle folio hard cut.**
Move passage persistence and concordance to graph folios on citation edges. Delete old passage model/schema/queries.

S5. **Workspace link hard cut.**
Replace `object_links` CRUD and hydrators with workspace links. Update notes/contributors/media cleanup.

S6. **Library Intelligence citation adoption.**
If LI exists, move artifact citations into graph citations and delete LI-private citation table.

S7. **Delete old symbols and head assertions.**
Drop old routes, schemas, service files, tests, and docs references. Add grep/head assertion tests.

If a slice requires dual-read or dual-write to pass independently, do not land it independently. Squash it into the hard-cut branch.

---

## 15. Files

### 15.1 Add

- `python/nexus/services/resource_graph/__init__.py`
- `python/nexus/services/resource_graph/refs.py`
- `python/nexus/services/resource_graph/resolve.py`
- `python/nexus/services/resource_graph/edges.py`
- `python/nexus/services/resource_graph/context.py`
- `python/nexus/services/resource_graph/retrievals.py`
- `python/nexus/services/resource_graph/citations.py`
- `python/nexus/services/resource_graph/folios.py`
- `python/nexus/services/resource_graph/workspace_links.py`
- `python/nexus/services/resource_graph/cleanup.py`
- `python/nexus/services/resource_graph/schemas.py`
- `python/nexus/schemas/resource_graph.py`
- `python/nexus/api/routes/resource_graph.py`
- `python/nexus/api/routes/conversation_context.py`
- `python/nexus/api/routes/workspace_links.py`
- `python/nexus/api/routes/retrieval_ledgers.py`
- `migrations/alembic/versions/XXXX_resource_provenance_graph.py`
- `apps/web/src/lib/resourceGraph/resourceRef.ts`
- `apps/web/src/lib/resourceGraph/contextRefs.ts`
- `apps/web/src/lib/resourceGraph/workspaceLinks.ts`
- `apps/web/src/lib/resourceGraph/citations.ts`

### 15.2 Modify

- `python/nexus/db/models.py`
- `python/nexus/api/routes/__init__.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/agent_tools/web_search.py`
- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/services/agent_tools/inspect_resource.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/chat_run_message_blocks.py`
- `python/nexus/services/chat_run_prompt_tracking.py`
- `python/nexus/services/oracle.py`
- `python/nexus/services/media_deletion.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/object_refs.py`
- `python/nexus/services/contributors.py`
- `python/nexus/services/search.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/schemas/oracle.py`
- `python/nexus/schemas/notes.py`
- `apps/web/src/lib/api/sse/events.ts`
- `apps/web/src/lib/api/sse/citations.ts`
- `apps/web/src/lib/conversations/citations.ts`
- `apps/web/src/lib/conversations/readerTarget.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/resources/resourceKind.ts`
- `apps/web/src/components/chat/ConversationReferencesSurface.tsx`
- `apps/web/src/components/chat/useConversation.ts`
- `apps/web/src/components/chat/useChatRunTail.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
- `apps/web/src/components/ui/MarkdownMessage.tsx` only if its citation prop shape needs the new adapter type
- `docs/architecture.md`
- `docs/modules/chat.md`
- `docs/modules/oracle.md`
- `docs/modules/library.md`

### 15.3 Delete

- `python/nexus/services/conversation_references.py`
- `python/nexus/services/retrieval_citation.py`
- `python/nexus/services/message_retrievals.py`
- `python/nexus/services/object_links.py`
- `python/nexus/api/routes/conversation_references.py`
- `python/nexus/api/routes/message_retrievals.py`
- `python/nexus/api/routes/object_links.py`
- old object-link schemas in `schemas/notes.py`
- old frontend object-link/conversation-reference clients after replacements land
- tests that only assert old table/route shapes

---

## 16. Key Decisions

D1. **Base edge plus sidecars, not one generic links table.**
This preserves semantics while centralizing ownership.

D2. **`ResourceRef` replaces `ObjectRef` and old URI aliases.**
No `span:`/`chunk:` aliases after the cutover; use `evidence_span:`/`content_chunk:`.

D3. **Workspace links are one edge kind.**
They do not own citations, retrievals, or context admission.

D4. **Retrieval candidates and citations are separate.**
A retrieval can be considered but not cited. A citation can point to an attached resource or read evidence. They are related, not identical.

D5. **Oracle folio is a typed citation sidecar.**
Marginalia and concordance are first-class, not loose JSON metadata, while the clickable source remains a normal citation edge.

D6. **External resources become resources.**
Web search citations target `external_snapshot` rows, not unowned JSON blobs.

D7. **Public-domain Oracle passages become resources.**
They target `oracle_corpus_passage` rows, not opaque source JSON.

D8. **No hidden historical resolver.**
Display snapshots preserve replay; reader jumps use current resolvers and fail closed.

D9. **Graph service owns cleanup.**
Media/content deletion calls one cleanup owner; no scattered `DELETE FROM object_links` or `UPDATE message_retrievals`.

D10. **One-user does not mean untyped.**
The prototype can delete old data and skip migration complexity, but the new model must still be strict.

---

## 17. Acceptance Criteria

### 17.1 Product behavior

AC1. Adding a resource to a conversation creates a context edge and the conversation context surface renders it.

AC2. `app_search` with empty scopes searches media/library context refs only.

AC3. `app_search` with explicit scope rejects a media/library ref that is not attached to the conversation.

AC4. `read_resource` and `inspect_resource` admission use graph context refs.

AC5. Chat `app_search`, `web_search`, attached resources, and `read_resource` evidence all produce citation chips with stable dense ordinals.

AC6. Message reload reconstructs tool call results, retrieval disclosures, and citation chips from graph edges with no `message_retrievals`.

AC7. `reference_added` SSE still fires when a cited local resource becomes conversation context.

AC8. Oracle readings render the same three folios with marginalia, attribution, and clickable jumps.

AC9. Oracle concordance returns shared plate/theme/passage matches using graph folios.

AC10. Workspace link CRUD preserves current visible behavior, including duplicate prevention and ordering.

AC11. Contributor split/link repoint goes through graph workspace link commands.

AC12. Media deletion and content reindex cleanup leave no dangling graph edges that claim active resolvability.

### 17.2 Architecture gates

AC13. Only `services/resource_graph/*` writes graph tables.

AC14. No production code references old table names except the drop migration and head assertion tests.

AC15. No route imports SQLAlchemy graph models directly.

AC16. No `resource_uri` parsing outside `resource_graph.refs` and edge route boundary validation.

AC17. No frontend code manually splits resource refs outside `resourceGraph/resourceRef.ts`.

AC18. No old route modules are registered.

AC19. No compatibility views/triggers/functions exist for old tables.

AC20. Every edge-kind sidecar has tests for illegal state rejection.

---

## 18. Test Plan

### 18.1 Unit tests

- `ResourceRef` parse/format rejects old aliases and malformed UUIDs.
- scheme exhaustive matching with `assert_never`.
- context edge uniqueness and missing-target rejection.
- retrieval candidate replace-set and selected/cited split.
- citation ordinal density per output.
- Oracle folio phase uniqueness and concordance target key.
- workspace link directionality and duplicate prevention.
- cleanup deletes/nulls exact edge kinds for deleted resource targets.

### 18.2 Integration tests

- create conversation with initial refs, list context refs, run app_search scoped to library.
- app_search end-to-end creates retrieval candidates and citation edges.
- web_search citation creates an external snapshot target.
- read_resource evidence creates a citation edge.
- assistant message GET rehydrates citations and retrieval disclosures.
- SSE `citation_index` and `reference_added` fold correctly on the frontend.
- Oracle reading persists folios and computes concordance.
- object/workspace link CRUD through new routes.
- media deletion removes affected graph edges explicitly.

### 18.3 Migration/head assertions

Assert old tables are absent:

```text
conversation_references
message_retrievals
message_retrieval_candidate_ledgers
oracle_reading_passages
object_links
library_intelligence_citations
```

Assert old service/route files are absent or empty-deleted:

```text
conversation_references.py
retrieval_citation.py
message_retrievals.py
object_links.py
```

Grep gates:

```text
\bmessage_retrievals\b
\bconversation_references\b
\boracle_reading_passages\b
\bobject_links\b
\bretrieval_id\b
has_reference
span:
chunk:
```

Allowed mentions: this spec, drop migration, migration tests, changelog entries.

---

## 19. Risks

R1. **Too generic too early.**
Mitigation: sidecars are mandatory. No generic metadata-only edge kinds.

R2. **Losing chat replay fidelity.**
Mitigation: retrieval candidate sidecar keeps display snapshot, locator snapshot, selection state, prompt inclusion, score, and source id text.

R3. **Breaking scope admission.**
Mitigation: context API owns `is_context_ref` and search scope extraction. `app_search`, `read_resource`, and `inspect_resource` stop querying storage directly.

R4. **Breaking Oracle concordance.**
Mitigation: folio sidecar preserves phase and target locator; concordance moves with folio owner.

R5. **ResourceRef churn across frontend and backend.**
Mitigation: one backend type, one frontend parser, no aliases after cutover.

R6. **Graph service becoming a god module.**
Mitigation: graph package split by capability: refs, resolve, context, retrievals, citations, folios, workspace links, cleanup.

R7. **Overbuilding for one user.**
Mitigation: no graph UI, no generic traversal engine, no multi-tenant policy system, no backfill. Only consolidate existing duplicated primitives.

---

## 20. Done Means

The old stores are gone. The product still works.

There is one public backend vocabulary for resources, one graph write owner, one citation read-model, one frontend citation adapter, one context admission owner, one workspace-link owner, one Oracle folio owner, and one cleanup owner.

No feature knows or cares which table used to own its links.

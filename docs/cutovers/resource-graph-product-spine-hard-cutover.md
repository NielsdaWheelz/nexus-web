# Resource Graph Product Spine Hard Cutover

## Status

BUILT - hard cutover implemented after the resource provenance graph,
notes/pages graph order, incoming connections, synapse, and Library
Intelligence revision-resource cutovers.

This spec describes the final hardening pass that makes `resource_edges` the
single product-spine contract for durable resource connections:

- containment;
- backlinks and generic connections;
- citations;
- conversation context refs;
- attachments;
- highlight-note attachments;
- note-body refs and embeds;
- user links;
- machine suggestions that are still positive connection proposals.

## Type

Hard cutover. No legacy code, no dual-write, no dual-read, no compatibility
routes, no fallback tables, no old vocabulary aliases, no backwards-compatible
payload shapes.

This is not a storage migration bridge. It is a contract consolidation pass over
the already-landed graph. Every durable connection either has one explicit edge
shape in `resource_edges` or is not a durable connection.

## Precedents

- `docs/cutovers/resource-provenance-graph-hard-cutover.md` - introduced one
  flat `resource_edges` table and killed sidecar relation vocabulary.
- `docs/cutovers/notes-pages-object-graph-hard-cutover.md` - added ordered note
  containment and explicit search-scope allowlists. Its tag-resource language
  is superseded by `docs/cutovers/user-graph-tags-hard-cutover.md`.
- `docs/cutovers/incoming-connections-reader-sidecar-hard-cutover.md` - made
  incoming reader connections a read model over `resource_edges`.
- `docs/cutovers/search-intent-model-hard-cutover.md` - made
  `services/search/scope.py` the single `scope -> SQL` owner.
- `docs/rules/cleanliness.md` - one owner per concern, no fallback lanes,
  collapse dangerous duplication.
- `docs/local-rules/module-apis.md` - expose each capability in one primary form.
- `docs/rules/database.md` - explicit cleanup, no speculative indexes,
  SELECT-then-write, no DB cascades as application behavior.
- `docs/rules/layers.md` - routes validate and dispatch, services own business
  logic, BFF routes proxy only.

## Current Head Facts

The current head already has most of the intended spine:

- `ResourceEdge` is the SQLAlchemy model for `resource_edges`, with closed
  `kind`, `origin`, source scheme, target scheme, order key, ordinal, and
  snapshot checks in `python/nexus/db/models.py`.
- `python/nexus/services/resource_graph/refs.py` owns the backend
  `ResourceRef` grammar and closed `ResourceScheme` set.
- `python/nexus/services/resource_graph/schemas.py` owns backend
  `EdgeKind` and `EdgeOrigin`.
- `python/nexus/services/resource_graph/edges.py` is the generic edge writer,
  with flush-only mutation, origin-aware bare-pair dedupe, user-link reverse
  dedupe, and service-level shape validation.
- `python/nexus/services/resource_graph/documents.py` owns ordered note/page
  containment behavior and cycle checks.
- `python/nexus/services/resource_graph/context.py` owns conversation context
  ref APIs and search-scope context discovery.
- `python/nexus/services/search/scope.py` already uses explicit origin/kind
  allowlists for note/page/highlight scope cells.
- `apps/web/src/lib/resourceGraph/*` mirrors graph refs, edge kinds, origins,
  and connection API shapes on the client.

The cutover hardens the graph policy across database checks, service validators,
tests, docs, frontend literals, search SQL strings, and context helper
semantics.

## North Star

`resource_edges` is the only durable positive connection contract in Nexus.

Everything else composes around it:

- domain tables own resources and non-connection state;
- graph services own edge writes, shape policy, cleanup, repointing, and
  hydrated connection reads;
- search owns explicit behavior admission over graph facts;
- projections own rebuildable read models;
- UI view state owns pane, collapse, pin, draft, selection, and display state;
- telemetry tables own replay, prompt inclusion, tool traces, and audit trails.

An edge row must answer one question:

> What durable connection does this user-visible product surface claim exists
> between two `ResourceRef`s, and which writer owns that claim?

If a row cannot answer that question, it does not belong in `resource_edges`.

## SME Thesis

A subject matter expert would treat this as a contract-hardening problem, not as
a feature patch and not as a graph-database migration.

The strongest production shape for this one-user prototype is:

- a closed-world relational product graph in Postgres;
- typed `ResourceRef` endpoint vocabulary;
- `origin` as the writer and invariant owner;
- `kind` as stance only;
- one edge-shape policy registry;
- service validators that match database constraints;
- explicit search-scope allowlists;
- behavior tests that fail when a new origin can affect retrieval without a
  policy decision.

The wrong moves are:

- adding another graph table;
- adding `contains`, `references`, `embeds`, `tagged_with`, `attaches`, or
  similar relation verbs;
- adding edge metadata JSON;
- turning search into open graph traversal;
- leaving old context/link vocabularies as parallel contracts;
- making projections authoritative.

## Scope

In scope:

- edge shape policy for all current origins;
- database constraint parity with service validators;
- service validator parity with database constraints;
- typed search-scope allowlists and tests;
- public API shape hardening;
- frontend/backend vocabulary parity;
- context-ref vocabulary cleanup;
- deletion or de-authoring of `conversation_media` as a durable context contract;
- negative gates against second graph/link vocabularies;
- docs updates so current head (`synapse`, order keys, context ordering) is the
  source of truth.

## Goals

G1. Make `resource_edges` the single durable positive connection contract.

G2. Make every edge shape closed, typed, and owned by one writer.

G3. Keep product concepts out of `kind`. `kind` remains stance only.

G4. Make search behavior explicit and default-deny for every graph-derived
scope cell.

G5. Collapse duplicate graph vocabularies and policy fragments to one owner per
concern.

G6. Make database constraints and service validators agree.

G7. Delete or demote every competing context/link table vocabulary.

G8. Keep telemetry, projections, corpus membership, sharing, and view state out
of the graph.

G9. Preserve user-visible behavior while deleting old contracts, not by keeping
compatibility lanes.

G10. Leave a testable contract: adding an origin, scheme, or behavior surface
fails until its policy, API, DB, frontend, and search implications are explicit.

Out of scope:

- multi-user collaboration;
- graph visualization;
- semantic knowledge graph or ontology UI;
- graph database adoption;
- historical citation replay beyond existing snapshots;
- migration/backfill for old local rows beyond hard deletion or greenfield
  migration cleanup;
- changing library corpus membership (`library_entries`);
- changing conversation sharing (`conversation_shares`);
- changing chat telemetry (`message_retrievals`, prompt assemblies, tool calls);
- changing pins, drafts, pane state, or other view state.

## Non-goals

N1. No new persisted graph/link table.

N2. No user-facing relation taxonomy.

N3. No old API route aliases or request-field aliases.

N4. No fallback reads from old tables.

N5. No compatibility tests that preserve old behavior.

N6. No `metadata`, `payload`, `locator`, `relation_type`, or per-feature JSON bag
on `resource_edges`.

N7. No generic "any edge means in search scope" behavior.

N8. No ORM relationship cascade used as application cleanup behavior.

N9. No frontend-only graph vocabulary.

N10. No direct durable connection writes outside graph-owned services.

## Key Decisions

D1. `resource_edges` is the product spine. It owns positive connections, not
domain resource rows, telemetry, projections, view state, or negative memory.

D2. `origin` is the semantic owner. It names who wrote the edge and which
invariants apply.

D3. `kind` is not a relation verb. It stays `context | supports | contradicts`.

D4. Edge order is allowed only when order is a property of the connection
itself. Current allowed cases are note containment `source_order_key` and
conversation context first-attached order.

D5. `target_order_key` stays reserved and forbidden until a concrete
multi-occurrence/transclusion feature ships.

D6. Citation snapshots are display/replay snapshots. They are not locators and
not fallback reads.

D7. Synapse is a real origin, not a side graph. Its suppression table remains
outside `resource_edges` because negative memory is not a positive connection.

D8. Search never asks "is there any edge?" Search asks "is there an edge with
this source/target shape, kind, origin, ordinal nullness, ownership, and scheme?"

D9. `conversation_media` is not a second context contract. It is deleted or
renamed as a rebuildable projection with no product authority.

D10. Frontend graph literals are not allowed to drift from backend literals.

## Capability Contract

### Resource Identity

All edge endpoints are `ResourceRef` values:

```text
<scheme>:<canonical-lowercase-uuid>
```

Backend owner:

- `python/nexus/services/resource_graph/refs.py`

Frontend mirror:

- `apps/web/src/lib/resourceGraph/resourceRef.ts`

Contract:

- every scheme must exist in one backend `ResourceScheme` set;
- every frontend scheme must be generated from or parity-tested against the
  backend set;
- old aliases such as `span:` and `chunk:` are invalid;
- route handlers parse raw strings at the boundary and pass `ResourceRef`
  inward.

### Edge Kind

`EdgeKind` is stance only:

```text
context | supports | contradicts
```

It must never grow verbs for product concepts. Product concepts are expressed by
endpoint schemes plus `origin`.

### Edge Origin

`EdgeOrigin` is the writer/invariant owner:

```text
user
citation
system
note_body
highlight_note
note_containment
synapse
```

Adding an origin is a schema event. It requires:

- migration widening `ck_resource_edges_origin`;
- model update;
- backend `EdgeOrigin` update;
- frontend `EdgeOrigin` update or generation;
- edge-shape policy entry;
- sole writer;
- cleanup/repoint decision;
- search-scope decision;
- connection-rendering decision;
- tests proving behavior.

### Edge Shape Policy

Add one graph-owned policy module:

```text
python/nexus/services/resource_graph/policy.py
```

The policy is code, not a new database table. It is the canonical executable
registry for current edge shapes.

It should expose a small typed surface:

```python
@dataclass(frozen=True, slots=True)
class EdgeShapePolicy:
    origin: EdgeOrigin
    writer: str
    allowed_kinds: tuple[EdgeKind, ...]
    source_schemes: tuple[ResourceScheme, ...] | Literal["any"]
    target_schemes: tuple[ResourceScheme, ...] | Literal["any"]
    ordinal: Literal["forbidden", "citation_required"]
    snapshot: Literal["forbidden", "citation_required", "synapse_required"]
    source_order: Literal["forbidden", "required", "conversation_context_optional"]
    target_order: Literal["forbidden"]
    search_activation: Literal["never", "allowlisted_only"]
```

The public helpers should be semantic:

- `validate_edge_shape(edge: EdgeCreate) -> None`
- `allowed_search_scope_origins(policy_cell: SearchScopePolicy) -> tuple[EdgeOrigin, ...]`
- `edge_origin_requires_owner(origin: EdgeOrigin) -> str`
- `origin_allows_snapshot(origin: EdgeOrigin, ordinal: int | None) -> bool`
- `origin_allows_source_order(edge: EdgeCreate) -> bool`

Do not expose generic policy mutation or runtime registration. This is a closed
compile-time contract.

## Target Behavior

| Product concept | Edge contract | Behavior owner |
|---|---|---|
| Page/block containment | `page|note_block -> note_block`, `kind=context`, `origin=note_containment`, `source_order_key` required | `resource_graph.documents` |
| Backlinks and connection lists | read model over `resource_edges` with explicit filters | `resource_graph.connections` and caller surface policy |
| Message/Oracle/LI citations | output resource -> cited target, `origin=citation`, ordinal + snapshot. For Library Intelligence, the durable output resource is the immutable artifact revision, not the mutable artifact head. | `resource_graph.citations` and feature writers |
| Conversation context refs | `conversation -> target`, `kind=context`, `origin=user|citation|system` | `resource_graph.context` |
| Search scope from graph | explicit origin/kind/scheme/ordinal allowlists | `services/search/scope.py` |
| Highlight note attachment | `highlight -> note_block`, `origin=highlight_note` | highlight-note service path |
| Note-body refs and embeds | `page|note_block -> target`, `origin=note_body`, replace-set | note document/body sync |
| User links | bare user-origin edge, undirected dedupe for user-created links | public resource graph edge API |
| Synapse suggestions | `origin=synapse`, rationale snapshot, no search activation | `services/synapse.py` |
| Suppressions/dismissals | not an edge | synapse negative-memory table |
| Library membership | not an edge | `library_entries` |
| Conversation sharing | not an edge | `conversation_shares` |
| Retrieval replay | not an edge | chat telemetry tables |
| Pane/draft/collapse/pin state | not an edge | owning UI/domain state |

## Final Data Model Rules

`resource_edges` keeps one row per durable positive connection fact. The allowed
columns are:

- `id`;
- `user_id`;
- `kind`;
- `origin`;
- source `ResourceRef` columns;
- target `ResourceRef` columns;
- `source_order_key`;
- `target_order_key`;
- `ordinal`;
- `snapshot`;
- `created_at`.

Rules:

- source and target schemes are closed over `ResourceScheme`;
- source and target cannot be the same resource;
- bare pair uniqueness is scoped by `user_id`, `origin`, source, and target;
- user-origin bare links dedupe in both directions at service level;
- citation ordinals are unique per user/source output;
- ordinal implies `origin='citation'` and `snapshot IS NOT NULL`;
- snapshot implies `origin in ('citation', 'synapse')`;
- order keys are forbidden on citation edges;
- `source_order_key` is allowed only for note containment and bare conversation
  context edges;
- `target_order_key` is forbidden/reserved;
- note containment has one parent per target block and no cycles;
- domain cleanup is explicit through graph cleanup, not database cascade.

## Origin Shape Matrix

### `user`

Purpose:

- explicit user links;
- user-attached conversation context refs;
- user-created attachments where the product explicitly creates a durable
  connection rather than an inline note-body ref.

Shape:

- `ordinal` forbidden;
- `snapshot` forbidden;
- `target_order_key` forbidden;
- `source_order_key` allowed only for bare conversation context refs;
- undirected duplicate dedupe for user bare links remains service behavior;
- no user-facing relation verb.

Search:

- may affect search only when explicitly allowlisted in `search/scope.py`.

### `citation`

Purpose:

- renderable source citation for messages, Oracle readings, Library
  Intelligence artifact revisions, and other generated outputs;
- citation-attached conversation context refs where the cited target becomes a
  resource in the conversation context.

Shape:

- ordinal citation edges require `ordinal >= 1`;
- ordinal citation edges require `snapshot`;
- ordinal citation edges cannot carry order keys;
- bare `conversation -> target` context refs may use `origin='citation'` with
  `source_order_key` for first-attached order;
- non-conversation bare citation edges are rejected unless a specific writer is
  added to the policy.

Search:

- ordinal citations never widen search scope;
- bare conversation citation context refs may widen conversation scope only
  through the explicit conversation-context allowlist.

### `system`

Purpose:

- product-owned context refs where the system attaches a resource to a
  conversation without a user click or citation ordinal.

Shape:

- bare `conversation -> target`, `kind='context'`;
- `source_order_key` allowed for attached order;
- no ordinal;
- no snapshot;
- no target order.

Search:

- same as user/citation conversation context refs, only through the allowlist.

### `note_body`

Purpose:

- replace-set projection of durable refs parsed from note/page/block body
  content, including inline refs, embeds, and inline attachments.

Shape:

- source is `page` or `note_block`, usually `note_block` for block-local refs;
- target is any visible supported resource;
- `kind='context'` unless the parser explicitly supports stance markup later;
- no ordinal;
- no snapshot;
- no order keys;
- written only by body sync code through a graph-owned replace-set.

Search:

- may affect page/note membership in media/library scope through the
  `NOTE_MEDIA_SCOPE_ORIGINS` allowlist;
- must not affect conversation scope unless the source is explicitly attached
  to the conversation.

### `highlight_note`

Purpose:

- highlight to attached note relationship.

Shape:

- source `highlight`;
- target `note_block`;
- `kind='context'`;
- no ordinal;
- no snapshot;
- no order keys.

Search:

- may affect note membership in media/library scope through highlight anchor
  joins and the explicit allowlist.

### `note_containment`

Purpose:

- page/block tree containment and sibling order.

Shape:

- source `page` or `note_block`;
- target `note_block`;
- `kind='context'`;
- `source_order_key` required;
- `target_order_key` forbidden until multi-occurrence transclusion ships;
- no ordinal;
- no snapshot;
- one containment parent per target block;
- no cycles;
- writes go through document graph commands, not generic public edge APIs.

Search:

- never activates search scope by itself;
- containment may be used by note indexing and rendering, but not as evidence
  that a note belongs to a media/library/conversation scope.

### `synapse`

Purpose:

- machine-proposed positive connection suggestions.

Shape:

- writer is `python/nexus/services/synapse.py`;
- source schemes are limited by `SYNAPSE_SOURCE_SCHEMES`;
- target schemes are limited to the engine's produced candidate refs
  (`media`, `note_block`);
- no ordinal;
- no order keys;
- snapshot policy is explicit: every synapse edge carries a rationale snapshot
  with a non-blank `excerpt`; the graph stores the positive suggestion and its
  display rationale together.

Search:

- never activates search scope unless a later spec explicitly allowlists it;
- synapse suggestions can render in connection surfaces as suggestions, not as
  user links and not as citations.

## Search-Scope Contract

Search must never consume "the graph" generically.

Add named policy constants in `python/nexus/services/search/scope.py` or a small
adjacent owner module:

```python
NOTE_MEDIA_SCOPE_ORIGINS = ("user", "note_body", "highlight_note")
CONVERSATION_CONTEXT_SCOPE_ORIGINS = ("user", "citation", "system")
CONTEXT_SCOPE_KIND = "context"
CONVERSATION_SCOPE_TARGET_SCHEMES = ("page", "note_block", "highlight")
APP_SEARCH_SCOPE_TARGET_SCHEMES = ("media", "library")
```

Rules:

- page/note media and library scope use only `kind='context'`,
  `origin IN NOTE_MEDIA_SCOPE_ORIGINS`, viewer ownership, and `ordinal IS NULL`;
- page/note/highlight conversation scope uses only
  `conversation -> target`, `kind='context'`,
  `origin IN CONVERSATION_CONTEXT_SCOPE_ORIGINS`, viewer ownership, and
  `ordinal IS NULL`;
- app-search explicit scopes admit only conversation context refs whose targets
  are in `APP_SEARCH_SCOPE_TARGET_SCHEMES`;
- `note_containment`, `synapse`, ordinal citations, non-context kinds, and
  unrelated schemes must not widen search scope;
- every new `EdgeOrigin` requires an explicit search decision and a failing test
  if unclassified.

## Conversation Context Contract

Conversation context has two policies and they must be named separately:

1. Product context surface:
   - lists bare `kind='context'` edges from `conversation:<id>`;
   - orders by `source_order_key`, then `created_at`, then `id`;
   - allows `origin in ('user', 'citation', 'system')` unless a separate surface
     explicitly asks to show diagnostics.

2. Search-scope expansion:
   - default-deny;
   - only `media`/`library` targets can become app-search scopes;
   - only page/note/highlight targets can scope note/highlight search;
   - only allowed origins count.

Rename broad helpers so they do not look search-safe:

- `is_context_ref` -> `has_conversation_edge_to_target` or
  `admits_resource_for_conversation_read`;
- `list_conversations_with_context_ref` ->
  `list_conversations_with_edge_to_target`;
- `batch_conversations_with_context_ref` ->
  `batch_conversations_with_edge_to_target`.

If broad admission is intentional for read/inspect tools, document and test it
as broader than search. Do not let search or scope code call a broad helper.

`add_context_ref_without_commit` must make its idempotency rule explicit:

- if origin-specific edge identity matters, include `origin` in the existing-row
  lookup;
- if product context wants "one visible target per conversation regardless of
  writer", rename the helper and test that a citation/system edge suppresses a
  duplicate user attach by design.

## `conversation_media` Decision

`conversation_media` is currently a derived table linking conversations to
media. It appears in search scope SQL and delete cleanup, while production code
has no obvious writer in `python/nexus`.

Final state:

- `conversation_media` is not a durable context contract.
- Conversation-media scope derives from `resource_edges` context refs.
- If a materialized table is still needed for performance, it is renamed and
  rebuilt as a projection owned by search, not a product source of truth.
- In the hard cutover, remove `conversation_media` model relationship, cleanup
  code, search SQL dependencies, test fixtures, and migration table if no
  projection is kept.

Do not keep both `conversation_media` and `resource_edges` as equivalent
conversation context sources.

`library_entries` and `conversation_shares` stay. They are corpus membership and
sharing state, not resource graph links.

## API Design

### Public Edge API

Backend:

- `python/nexus/api/routes/resource_graph.py`

Frontend:

- `apps/web/src/lib/resourceGraph/edges.ts`
- `apps/web/src/lib/resourceGraph/connections.ts`

Rules:

- public edge creation accepts only `source_ref`, `target_ref`, and optional
  `kind`;
- backend forces `origin='user'`;
- public edge creation cannot carry `origin`, `ordinal`, `snapshot`,
  `source_order_key`, or `target_order_key`;
- delete through public API is allowed only for `origin='user'`;
- connection query may expose filters for origins/kinds/schemes, but product
  surfaces should pass explicit filters instead of relying on "all origins".

### Conversation Context API

Backend:

- `python/nexus/api/routes/conversation_context.py`
- `python/nexus/api/routes/conversations.py`

Rules:

- route names and schema fields use `context_ref`, not `reference`;
- `CreateConversationRequest.initial_references` is renamed to
  `initial_context_refs`;
- SSE event `reference_added` is renamed to `context_ref_added`;
- frontend hooks and surfaces use context-ref names;
- display copy may say "References" only if it is purely UI text and not a code
  or schema contract.

### Internal Graph APIs

Keep a small semantic public surface:

- `create_user_edge(...)`
- `delete_user_edge(...)`
- `replace_edges_for_origin(...)`
- `record_citation(...)`
- `replace_citations_for_output(...)`
- `add_context_ref_without_commit(...)`
- `remove_context_ref(...)`
- document-specific containment commands in `documents.py`
- `query_connections(...)`
- cleanup/repoint helpers

Do not make generic `create_edge(...)` the easiest path for structural
containment writes. Either keep it private-ish and enforce policy, or add a
typed containment command that performs cycle checks and is the only path used
outside tests.

## Architecture and Composition

### Notes and Pages

Pages and note blocks compose with the graph like this:

- page rows own identity/title;
- note block rows own stable body identity;
- containment edges own page/block tree shape and sibling order;
- note-body edges own parsed refs, embeds, and inline attachments;
- highlight-note edges own highlight attachments;
- note indexing consumes graph-backed containment and body refs as inputs;
- search consumes only explicit allowlisted edge origins.

### Reader Connections

Reader surfaces read connections through `resource_graph.connections`, not by
querying `resource_edges` directly.

Product surfaces must decide which origins they show:

- citations;
- note refs;
- user links;
- highlight notes;
- synapse suggestions;
- containment edges.

"All origins" is diagnostic behavior, not a default reader/sidebar product
surface.

### Chat and App Search

Chat context refs are graph edges. App-search scopes are a policy over those
edges, not open traversal.

Message retrieval telemetry remains in chat tables. Citation rendering uses
citation edges. Replay uses telemetry plus citation edge ids where applicable.

### Library and Corpus Membership

Library membership remains `library_entries`. It is a corpus relation and
permission source, not a graph connection.

Resource graph edges may point to libraries, media, library intelligence
artifact heads, or library intelligence artifact revisions, but they do not
replace corpus membership or freshness ownership.

### Synapse

Synapse writes are formal graph-origin writes, not a side graph. Suppressions
remain a separate negative-memory table because "do not suggest this pair" is
not a positive connection.

Synapse edges can render as suggestions. They do not widen search scope.

## Duplicate Patterns to Consolidate

### Graph Vocabulary Duplication

Pre-cutover pattern:

- backend `ResourceScheme` in `refs.py`;
- frontend `RESOURCE_SCHEMES` in `resourceRef.ts`;
- backend `EdgeKind`/`EdgeOrigin` in `schemas.py`;
- frontend `EdgeKind`/`EdgeOrigin` in `edges.ts`;
- SQLAlchemy CHECKs in `models.py`;
- Alembic constraints in migrations;
- tests partially compare backend literals.

Target:

- backend remains authoritative;
- frontend is generated from backend contract or parity-tested in CI;
- migration/model CHECK text is tested against current backend literals;
- adding a scheme/origin/kind fails until every layer is classified.

### Edge Shape Validation Duplication

Pre-cutover pattern:

- DB checks encode some origin shape;
- `_validate_edge_input` encodes similar but not identical shape;
- tests encode scattered expectations;
- docs encode older variants.

Target:

- `resource_graph.policy` describes shapes;
- `edges.py` delegates validation to policy;
- DB checks mirror policy for impossible states;
- tests run both service-level and direct SQL invalid-shape cases.

### Search Allowlist Duplication

Pre-cutover pattern:

- allowlists are embedded as SQL string fragments in `search/scope.py`;
- tests assert substrings.

Target:

- named allowlist constants/helpers;
- tests assert exact policy values and representative SQL behavior;
- endpoint/product tests prove containment, synapse, ordinal citations, and
  non-context kinds do not widen scope.

### Context Vocabulary Duplication

Pre-cutover pattern:

- route names use context refs;
- create conversation still accepts `initial_references`;
- frontend surfaces/hooks still use "references";
- SSE still has `reference_added`;
- older docs mention `conversation_references`.

Implemented target:

- code and wire contracts use `context_ref`;
- no production code has `conversation_references`;
- "references" survives only as optional display copy.

### Connection Surface Policy Duplication

Pre-cutover pattern:

- generic connection query can return all origins;
- UI surfaces do not always pass explicit origin filters;
- reader classification can fall back to `other`.

Target:

- each surface has an explicit origin/kind policy;
- diagnostic all-origin views are named as diagnostics;
- reader/sidebar surfaces do not accidentally expose containment edges as
  ordinary links.

## Implementation Plan

### S1 - Policy Registry

Files:

- add `python/nexus/services/resource_graph/policy.py`;
- update `python/nexus/services/resource_graph/edges.py`;
- update `python/nexus/services/resource_graph/schemas.py` only if type aliases
  need policy-facing helpers;
- update `python/tests/test_resource_graph_edges.py`;
- update `python/tests/test_resource_graph_policy.py` if created.

Tasks:

- define origin shape policy;
- centralize snapshot/origin/order/ordinal/source/target rules;
- make `_validate_edge_input` call policy helpers;
- reject non-citation/non-synapse snapshots at service boundary;
- enforce required synapse rationale snapshots;
- restrict conversation `source_order_key` to explicit origins
  `user|citation|system`, source `conversation`, `kind=context`, and
  `ordinal IS NULL`;
- keep `target_order_key` forbidden until multi-occurrence blocks ship.

### S2 - Database Constraint Parity

Files:

- `python/nexus/db/models.py`;
- new Alembic migration after `0149`;
- `python/tests/test_migrations.py`.

Tasks:

- add DB CHECKs for source-order shape;
- add DB CHECK to forbid `target_order_key` until enabled;
- assert snapshot origin and synapse shape at head;
- assert `note_containment` and `synapse` both survive origin widening;
- add direct-SQL invalid insert tests for every forbidden shape.

Follow `docs/rules/database.md`: use constraints for true illegal states, not
speculative indexes or application-level correlation.

### S3 - Search Scope Policy

Files:

- `python/nexus/services/search/scope.py`;
- `python/tests/test_search_scope_matrix.py`;
- `python/tests/test_search.py`;
- `python/tests/test_agent_app_search.py`.

Tasks:

- name origin/kind allowlists;
- use constants/helpers in SQL fragment builders;
- add default-deny test for every `EdgeOrigin`;
- strengthen highlight conversation matrix test to assert kind, origin, and
  `ordinal IS NULL`;
- add page-level behavior tests, not only note-block tests;
- add containment-only negative behavior test;
- add synapse, ordinal citation, non-context kind, and unrelated target-scheme
  negative tests for `/search` and `app_search`.

### S4 - Conversation Context Cutover

Files:

- `python/nexus/services/resource_graph/context.py`;
- `python/nexus/api/routes/conversation_context.py`;
- `python/nexus/api/routes/conversations.py`;
- `python/nexus/schemas/conversation.py`;
- frontend conversation hooks/surfaces under `apps/web/src`;
- tests for conversations, context refs, chat SSE, read-resource, and app-search.

Tasks:

- rename broad helpers so they cannot be mistaken for search-scope admission;
- make context-ref idempotency origin-aware or explicitly product-target-aware;
- rename `initial_references` to `initial_context_refs`;
- rename `reference_added` event contracts to `context_ref_added`;
- remove production code references to `conversation_references`;
- update docs and tests to current vocabulary.

### S5 - `conversation_media` Removal or Projection Demotion

Files:

- `python/nexus/db/models.py`;
- Alembic migration;
- `python/nexus/services/search/scope.py`;
- `python/nexus/services/conversations.py`;
- `python/nexus/services/media_deletion.py`;
- tests that seed or clean `conversation_media`.

Tasks:

- replace conversation-media search cells with graph context-ref queries;
- remove model relationship if no projection remains;
- remove cleanup SQL;
- remove direct test fixture inserts;
- if performance requires a table, rename it to a rebuildable projection and
  document its sole rebuild owner.

Acceptance requires no product behavior depending on `conversation_media` as an
authoritative context store.

### S6 - Frontend and Wire Parity

Files:

- `apps/web/src/lib/resourceGraph/resourceRef.ts`;
- `apps/web/src/lib/resourceGraph/edges.ts`;
- `apps/web/src/lib/resourceGraph/connections.ts`;
- backend schemas under `python/nexus/schemas`;
- frontend tests under `apps/web/src/lib/resourceGraph`.

Tasks:

- generate frontend graph vocabularies or add parity tests against a backend
  contract artifact;
- ensure public edge creation cannot send graph-owned fields;
- ensure connection query filters use typed origins/kinds/schemes;
- rename context-ref client vocabulary.

### S7 - Connection Surface Policy

Files:

- `python/nexus/services/resource_graph/connections.py`;
- `python/nexus/services/reader_connections.py`;
- `apps/web/src/components/connections/ConnectionsSurface.tsx`;
- `apps/web/src/lib/media/readerConnections.ts`;
- reader connection route tests.

Tasks:

- add named surface policies for reader, sidebar, connections panel, and
  diagnostics;
- avoid default all-origin reads on product surfaces;
- decide how `note_containment` renders, if at all;
- render `synapse` as suggestions, not user links or citations.

### S8 - Negative Gates and Docs

Files:

- `python/tests/test_cutover_negative_gates.py`;
- this spec;
- older resource graph and notes cutover docs where they are now stale;
- `docs/architecture.md`.

Tasks:

- add gates forbidding new `object_graph_edges`, relation verbs, and second
  durable connection tables;
- add gate for direct positive edge writes outside graph-owned services, with
  explicit allowed test/fixture exceptions;
- add gate for frontend/backend graph vocabulary drift if not generated;
- update `resource-provenance` docs to include `synapse`, current snapshot
  rules, and current order-key rules;
- update stale references to `conversation_references` only where they describe
  current behavior.

## Acceptance Criteria

AC1. `resource_edges` is the only durable positive connection table in current
production code.

AC2. No production code references `object_links`, `conversation_references`,
`object_graph_edges`, relation verbs, or old context-reference stores except in
negative tests or historical docs.

AC3. Every `EdgeOrigin` has one policy entry naming writer, shape, cleanup,
search activation, and rendering decision.

AC4. Service validation rejects every edge shape that the database rejects,
including non-citation/non-synapse snapshots.

AC5. Database CHECKs reject every illegal edge shape that should be impossible
independent of caller.

AC6. `target_order_key` is either fully supported by product code and tests or
forbidden everywhere. For this cutover it is forbidden/reserved.

AC7. `note_containment` writes go through document graph commands with cycle
and single-parent checks.

AC8. Public edge creation remains user-origin only and cannot carry origin,
order, ordinal, or snapshot fields.

AC9. Public edge deletion cannot delete non-user-origin edges.

AC10. Search scope uses named origin/kind policy allowlists, not ad hoc string
fragments.

AC11. `note_containment` edges alone do not make pages or notes searchable in
media, library, conversation, or app-search scopes.

AC12. `synapse` edges do not widen search scope.

AC13. Ordinal citation edges do not widen search scope.

AC14. Non-context kinds do not widen search scope.

AC15. App-search explicit scopes admit only conversation context refs whose
target schemes are `media` or `library`.

AC16. Page, note-block, and highlight conversation search cells all assert
`kind='context'`, allowed origins, viewer ownership, and `ordinal IS NULL`.

AC17. Broad conversation read admission helpers are named and tested separately
from search-scope helpers.

AC18. `conversation_media` is removed as an authoritative context store or
demoted to a named rebuildable projection with no product-source authority.

AC19. Frontend and backend `ResourceScheme`, `EdgeKind`, and `EdgeOrigin`
vocabularies cannot drift silently.

AC20. Reader/sidebar/connection surfaces pass explicit origin/kind policies or
are named diagnostics.

AC21. `synapse` is documented and tested as a first-class origin with explicit
snapshot and search behavior.

AC22. Existing graph cleanup/repoint tests still pass and include all new shape
constraints.

AC23. Migration tests cover current head constraints, not only historical 0148
constraints.

AC24. `docs/architecture.md` names `resource_edges` as the product spine and
does not describe stale context stores as current.

AC25. The cutover leaves no compatibility shims, aliases, or dual-path tests.

## Verification Plan

Targeted suites:

```text
python/tests/test_resource_graph_refs.py
python/tests/test_resource_graph_edges.py
python/tests/test_resource_graph_documents.py
python/tests/test_resource_graph_routes.py
python/tests/test_search_scope_matrix.py
python/tests/test_search.py
python/tests/test_agent_app_search.py
python/tests/test_cutover_negative_gates.py
python/tests/test_migrations.py
```

Additional checks:

- grep production roots for old vocabulary;
- direct-SQL invalid-shape migration tests;
- frontend resource graph unit tests;
- route tests for public edge and context-ref payloads;
- behavior tests for page/note/highlight search scope;
- app-search tests for allowed and rejected context scopes.

Do not use a broad "it compiles" claim as acceptance. The proof is the contract
matrix: every origin, every behavior surface, and every forbidden shape has an
owner and a test.

## Final State

After this cutover:

- `resource_edges` is the single positive connection spine;
- every origin is closed, documented, and policy-owned;
- every search behavior is default-deny and allowlisted;
- containment is structural, but never search-admission by accident;
- citations are renderable edges, not scope admission;
- attachments are edge patterns, not special stores;
- conversation context refs are graph edges, not `conversation_media` or
  `conversation_references`;
- frontend and backend graph vocabulary cannot drift silently;
- projections remain rebuildable;
- telemetry and view state remain outside the graph;
- old graph/link vocabulary is gone from production code.

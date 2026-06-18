# Resource Discovery, Link, Citation Spine Hard Cutover

Status: IMPLEMENTED
Author: Codex
Type: hard cutover
Date: 2026-06-17

## North Star

Every user-visible thing in Nexus has one address, one capability policy, one
search path, one connection path, one citation path, and one activation path.

The product language is:

> Anything I can encounter in Nexus can be found, opened, linked, cited, used as
> chat context, and inspected according to its explicit capabilities.

The architecture is:

```text
ResourceRef
  -> resource item capability policy
  -> resource resolver and activation target
  -> search/result/citation target mapping
  -> resource_edges for durable links, context refs, and generated citations
  -> CitationOut for numbered generated citations
  -> frontend activation through one resource activation adapter
```

This does not mean all resource schemes behave identically. It means all schemes
enter through the same primitives and decline capabilities explicitly. `media`,
`library`, `content_chunk`, `evidence_span`, `highlight`, `note_block`,
`reader_apparatus_item`, `message`, `oracle_reading`,
`library_intelligence_revision`, `contributor`, `podcast`, and
`external_snapshot` are different product objects with different capabilities.
They are not allowed to have different private identity, search, route, or
citation systems.

## Type

Hard cutover. No legacy code, no fallback lists, no dual search paths, no
frontend href fallbacks, no old request aliases, no backwards-compatible payload
shape, no duplicate route resolver, no second citation builder, no graph
traversal without capability policy, and no local scheme allowlists outside the
owner or generated manifest.

If two modules answer the same question, one stops answering it. If a surface
needs a derived local value, it imports the owner helper or consumes the
generated manifest. If the owner helper does not exist, this cutover adds it
instead of authoring another private list.

## Precedents And Repo Rules

- `docs/architecture.md` names `ResourceRef`, `resource_edges`, `SearchQuery`,
  `CitationOut`, `message_retrievals`, and reader apparatus boundaries.
- `docs/cutovers/resource-provenance-graph-hard-cutover.md` establishes
  `resource_edges` as the single durable positive connection/citation/context
  substrate.
- `docs/cutovers/resource-capability-registry-hard-cutover.md` establishes
  `resource_items.capabilities` as the per-scheme capability authority.
- `docs/cutovers/search-intent-model-hard-cutover.md` establishes
  `services/search/` as the search owner, with one `SearchQuery`, one result
  type authority, one scope owner, and one multi-scope executor.
- `docs/cutovers/resource-chat-subject-hard-cutover.md` establishes that
  chat subjects are typed `ResourceRef`s with scheme-specific capabilities.
- `docs/cutovers/notes-pages-evidence-unification-hard-cutover.md` establishes
  the content index as owner-polymorphic evidence storage, now narrowed in live
  code to `media` and `note_block`.
- `docs/cutovers/reader-document-map-evidence-trail-hard-cutover.md` separates
  source-authored reader apparatus from generated assistant citations.
- `docs/rules/cleanliness.md` requires one owner per concern, deletion of
  compatibility lanes, and collapsing dangerous duplication.
- `docs/local-rules/module-apis.md` requires one primary form per capability.
- `docs/rules/keys-and-identities.md` requires the same specific name across
  boundaries when the concept is the same.
- `docs/rules/layers.md` keeps BFF and API routes thin; services own business
  behavior.
- `docs/rules/correctness.md` requires illegal states to be unrepresentable.
- `docs/local-rules/testing_standards.md` requires behavior tests at public owner
  boundaries, plus negative gates for completed hard cutovers.

## SME Thesis

A subject matter expert would not ask "can we make citations, links, search,
references, and chat all use one table?" The right question is:

> Which invariant owns identity, capability, retrieval, connection, citation,
> activation, and display?

The answer:

- identity is `ResourceRef`;
- static product capability is `resource_items.capabilities`;
- runtime visibility and hydration are `resource_graph.resolve` and
  `resource_items.surfaces`;
- durable positive connections are `resource_edges`;
- generated citation numbering is graph-owned citation edges plus `CitationOut`;
- retrieval is `services/search/` consuming one `SearchQuery`;
- chat retrieval rows are `message_retrievals` telemetry, not citations;
- reader apparatus is source-authored document structure, not generated
  citation storage;
- frontend navigation is resource activation, not `href` guessing.

The professional move is to finish the owner boundary:

1. Define one resource target and activation contract.
2. Make search results, citation targets, connection rows, context refs, and
   reader document-map rows all project through that contract.
3. Delete private frontend/backend taxonomies that reconstruct the same answer.
4. Keep scheme-specific differences as explicit capability decisions.

Wrong moves:

- treating `linkable`, `readable`, `searchable`, `citable`, `chat_subject`,
  and `app_search_scope` as synonyms;
- adding `episode:`, `video:`, `author:`, `annotation:`, `pdf:`, or `epub:`
  schemes where existing modeled entities already own identity;
- using `message_retrievals` as citation source of truth;
- keeping `deep_link`/`href` as the app-internal navigation authority;
- letting `app_search` keep private result-type/filter semantics that user
  search cannot express;
- making source-authored footnotes generated citation edges;
- hiding missing resource capabilities behind frontend fallbacks.

## Pre-Implementation Head Facts

### Already Correct Before Cutover

- `python/nexus/services/resource_graph/refs.py` owns a closed backend
  `ResourceRef` grammar.
- `apps/web/src/lib/resourceGraph/resourceRef.ts` mirrors that grammar on the
  frontend.
- `python/nexus/services/resource_items/capabilities.py` owns one capability row
  for every current `ResourceScheme`.
- `python/nexus/services/resource_graph/edges.py` and
  `python/nexus/services/resource_graph/citations.py` own graph writes and
  generated citation numbering/read models.
- `python/nexus/services/resource_graph/connections.py` reads incoming/outgoing
  connections from `resource_edges`.
- `python/nexus/services/search/` owns `/search`, palette search, and the core
  engine consumed by chat `app_search`.
- `python/nexus/services/search/query.py` provides `SearchQuery`.
- `python/nexus/services/search/scope.py` owns the search scope matrix.
- `python/nexus/services/search/batch.py` owns multi-scope search for chat.
- `python/nexus/services/agent_tools/app_search.py` calls the shared search
  engine instead of owning a second search engine.
- `python/nexus/services/retrieval_citation.py` is the validated writer for
  `message_retrievals` telemetry.
- `content_blocks`, `evidence_spans`, `content_chunks`,
  `content_chunk_parts`, `content_embeddings`, and `content_index_states`
  already use `(owner_kind, owner_id)` storage.
- Note bodies index as `note_block` owners through
  `python/nexus/services/note_indexing.py`.
- Chat, Oracle, and Library Intelligence generated citations are already
  conceptually graph citations sourced from generated-output refs.
- Frontend `CitationOut` rendering is mostly centralized through
  `apps/web/src/lib/resourceGraph/citations.ts`,
  `apps/web/src/lib/conversations/citationOut.ts`, and
  `apps/web/src/components/ui/ReaderCitation.tsx`.

### Pre-Cutover Gaps

- Search result types, citation target types, SSE retrieval result types, and
  `ResourceScheme` are related but not governed by one target-mapping owner.
- `SearchResultOut` still uses `deep_link`/`context_ref` as the practical row
  activation contract.
- Frontend search rows adapt to `href`, then `SearchResultRow` renders an
  ordinary link.
- Frontend reader citation activation still flows through
  `ReaderSourceTarget`, which is narrower than the resource vocabulary.
- There are two citation-to-reader paths: graph-built `CitationOut` and older
  telemetry-derived retrieval target helpers.
- Reader document-map citations and connections separately project locators to
  anchors.
- `ConnectionsSurface` and reader-side connections activate resources
  differently.
- Context-ref opening still uses object-ref/resource-kind routing in places
  instead of `ResourceItemOut.route` or a resource activation target.
- The reusable frontend normalizer for generic resource items lives under notes
  API code instead of a resource item owner.
- `app_search` exposes only `query` and `scopes` to the model, but the executor
  still receives internal `planned_types` and `planned_filters`; those are not
  the same public query contract the user search surface uses.
- Active chat dispatch currently biases `app_search` toward `content_chunk` and
  `note_block`, while the tool description names a broader user corpus.
- `SearchQuery` still carries chat-only `result_types` and `storage_kinds`
  overrides.
- `content_chunk` and `evidence_span` search/resolution are still partly
  media-shaped; note-owned chunks surface through `note_block` search instead
  of the generic chunk result path.
- Content-index readiness gates are inconsistent across result types:
  chunks/note chunks/highlights require ready state, but fragments and
  evidence-span search do not uniformly enforce readiness.
- The repair path for ready content indexing is narrower than ingest coverage;
  video transcript ingest can index, but generic repair does not cover the same
  media kinds.
- Source-authored reader apparatus has tables and reader UI, but no
  `ResourceRef` scheme, search result type, capability row, or resource
  activation path.
- User "annotations" are product language for `highlight` plus
  `highlight_note` edges to `note_block`; there is no explicit contract saying
  that no standalone `annotation:` scheme exists.
- `contributor` is the canonical author/person identity, but some frontend pane
  identity paths still return no resource ref for author routes.
- Some docs still mention stale graph concepts such as `tag`, old
  conversation/reference stores, or reader-tool citation tabs.

## Target Behavior

### User-facing behavior

1. Global search, palette search, and chat `app_search` search the same corpus
   through the same `SearchQuery` semantics.
2. A user search result can be opened, linked, attached, cited, or used as chat
   context only according to the resource capability contract.
3. A chat citation chip, Oracle citation chip, LI citation chip, document-map
   citation row, connection row, and search row all activate through the same
   resource activation adapter.
4. A source-authored footnote, endnote, bibliography entry, or in-document
   citation can be searched and opened as a reader apparatus resource when it is
   materialized by the apparatus extractor.
5. A generated assistant citation is never confused with a source-authored
   document citation. They can point at one another through `ResourceRef`
   identity, but they remain different domains.
6. Episodes, videos, web articles, PDFs, and EPUBs are searched and cited through
   `media` plus format/subtype data, not through separate schemes.
7. Authors are `contributor` resources. There is no `author:` scheme.
8. User annotations are `highlight` plus `note_block` attachment. There is no
   `annotation:` scheme until a standalone annotation entity exists.
9. `href` is a derived browser rendering detail, not the resource identity or
   activation authority.
10. If a resource cannot activate, the UI shows an explicit unresolved state
    from the resource owner. It does not guess another route.

### Internal behavior

1. `ResourceRef` remains the only persisted cross-domain identity.
2. `resource_edges` remains the only durable positive connection/citation/context
   table.
3. `message_retrievals` remains chat telemetry and carries `cited_edge_id` only
   as provenance back to graph citation edges.
4. `CitationOut` is produced by the backend from graph edges. No frontend surface
   reconstructs citation targets from retrieval telemetry when `CitationOut`
   exists.
5. `SearchResultOut` carries a resource target, a citation target decision, and
   an activation target produced by the owner mapping.
6. `app_search` converts model arguments into the same public `SearchQuery`
   language as user search. It does not use private result-type or storage-kind
   override channels.
7. The prompt-evidence selection step is chat-owned and happens after search.
   It may filter/rank budgeted evidence, but it does not own search semantics.
8. Content-index owner support is declared through a policy contract. Adding a
   new owner kind updates schema checks, indexers, retrievers, cleanup,
   resolver, frontend parity, and tests in one slice.
9. Reader apparatus rows can become resource items without moving apparatus
   extraction/storage into the graph.

## Goals

G1. Make `ResourceRef` the only app-internal identity for searchable, linkable,
and citable objects.

G2. Add one resource target mapping owner that maps:

- `ResourceRef` scheme;
- search result type;
- search context ref;
- citation target type;
- reader target;
- activation route;
- prompt/read mode.

G3. Make `ResourceActivationOut` the shared activation read model for search,
citations, connections, context refs, resource items, and document-map rows.

G4. Remove `deep_link`/`href` as the source of truth for internal resource
navigation. Keep external URLs and citation snapshots only as display/history.

G5. Remove chat-only `SearchQuery.result_types` and `SearchQuery.storage_kinds`.
`app_search` uses the same public kind/filter/scope contract as user search.

G6. Keep `app_search` as a RAG wrapper, not a second search engine. Its private
work is admission, prompt packing, telemetry, and budgeted evidence selection.

G7. Make citable target selection a backend owner decision, not an ad hoc mapping
in chat, search, LI, Oracle, and frontend code.

G8. Make note-owned chunks and media-owned chunks resolve through one
owner-aware chunk/evidence path wherever the public result type says
`content_chunk` or `evidence_span`.

G9. Make readiness gates consistent for all content-index-backed result types.

G10. Make source-authored reader apparatus first-class enough to search, open,
link, and cite when its rows exist.

G11. Preserve the domain separation between source-authored apparatus and
generated citations.

G12. Centralize frontend resource opening through one activation adapter.

G13. Delete duplicate frontend/backend result/citation/resource taxonomies or
derive them from one generated manifest.

G14. Update negative gates so new local capability lists, citation target maps,
resource-route maps, and app-search result-type lists cannot reappear.

G15. Update `docs/architecture.md` and stale cutover docs after implementation
so completed-era concepts do not remain authoritative.

## Non-Goals

N1. No graph database.

N2. No new durable graph, link, citation, or context table.

N3. No migration compatibility bridge that accepts old API payloads.

N4. No fallback from `href` to guessed resource routes.

N5. No frontend-only capability or route policy.

N6. No attempt to make every resource body-indexed. Some resources are
metadata-searchable, scope-only, or label-only by explicit policy.

N7. No `episode:`, `video:`, `web_article:`, `pdf:`, `epub:`, `author:`, or
`annotation:` schemes unless the data model gains genuinely separate entities.

N8. No source-authored apparatus rows as generated citation edges.

N9. No generated assistant citations stored in reader apparatus tables.

N10. No broad graph traversal for search. Search uses explicit search scopes,
index owners, and retrievers.

N11. No historical resolver that reads deleted/reindexed content from citation
snapshots. Snapshots display; current resolvers activate.

N12. No keeping old `deep_link` fields just because tests use them. If a field
survives, it has a current owner and current meaning.

## Final Architecture

### Ownership map

| Concern | Final owner | Consumers |
|---|---|---|
| Resource identity grammar | `resource_graph.refs` | every backend service |
| Runtime hydration/visibility | `resource_graph.resolve` | resource items, search, citations, read tools |
| Static per-scheme capability | `resource_items.capabilities` | graph, search, chat, reader, frontend manifest |
| Resource item surface | `resource_items.surfaces` | API, frontend, context refs |
| Resource target mapping | `resource_items.targets` | search, citations, connections, document map |
| Resource activation read model | `resource_items.activation` | API, search, citations, frontend |
| Durable graph connections | `resource_graph.edges` | graph writers only |
| Connection reads | `resource_graph.connections` | API, reader, frontend |
| Generated citation writes/reads | `resource_graph.citations` | chat, Oracle, LI, frontend |
| Search query/kinds/scopes | `services/search/` | `/search`, palette, `app_search` |
| Chat retrieval telemetry | `retrieval_citation.py` | chat tools, trust trail |
| Prompt evidence selection | chat/app-search domain | chat only |
| Content indexing | `content_indexing.py` + owner policy | media, notes, future text owners |
| Reader apparatus extraction | `reader_apparatus*` | reader, apparatus resources |
| Frontend resource activation | `apps/web/src/lib/resources/activation.ts` | search, chat, reader, connections |
| Frontend generated capabilities | `apps/web/src/lib/resources/resourceCapabilities.generated.ts` | UI affordances |

`resource_items.targets` and `resource_items.activation` are new owner leaves
under the existing resource item domain. They do not become a second capability
registry. They expose typed helpers built from `ResourceRef`, the capability
registry, resolver output, and existing route/read models.

### Resource target contract

Backend target helpers expose one semantic answer:

```python
@dataclass(frozen=True, slots=True)
class ResourceTarget:
    ref: ResourceRef
    result_type: SearchResultType | None
    citation_target_type: CitationTargetType | None
    readable: bool
    citable: bool
    activation_kind: Literal["reader", "note", "route", "external", "none"]
```

The public API shape is:

```python
class ResourceActivationOut(BaseModel):
    resource_ref: ResourceRefOut
    kind: Literal["reader", "note", "route", "external", "none"]
    href: str | None
    reader: ReaderActivationOut | None
    note: NoteActivationOut | None
    external_url: str | None
    unresolved_reason: str | None
```

Rules:

- `href` is derived from `kind` and the typed target. It is never parsed to
  recover resource identity.
- `external_url` is only for external snapshots and ordinary outbound links.
- `unresolved_reason` is owner-produced. Consumers do not invent fallback copy.
- A target can be routeable but not citable, citable but not searchable, or
  searchable but not readable.

### Capability contract

`ResourceItemCapability` remains the static owner and gains typed sub-policies
instead of more unrelated booleans:

```python
@dataclass(frozen=True, slots=True)
class ResourceItemCapability:
    surface: ResourceSurfacePolicy
    graph: ResourceGraphPolicy
    search: ResourceSearchPolicy
    citation: ResourceCitationPolicy
    read: ResourceReadPolicy
    prompt: ResourcePromptPolicy
    activation: ResourceActivationPolicy
    expansion: ResourceExpansionPolicy
```

The implementation may remain a dataclass in one module, but the public service
must expose named helpers rather than raw call-site boolean reads:

- `resource_can_link(ref)`
- `resource_can_attach(ref)`
- `resource_can_be_chat_subject(ref)`
- `resource_can_be_app_search_scope(ref)`
- `resource_can_activate(ref)`
- `resource_search_target_for_result(result)`
- `resource_citation_target_for_result(result)`
- `resource_activation_for_ref(db, viewer, ref)`
- `resource_owned_child_refs(db, viewer, ref)`
- `resource_index_owner_policy(ref)`

Every `ResourceScheme` has an explicit row. Tests fail on missing policy or
unclassified sub-policy. No call site reads a raw local scheme tuple unless that
tuple is generated by the owner in the same module.

### Scheme decisions

Final scheme/product decisions:

| Product concept | Canonical resource identity | Decision |
|---|---|---|
| Library item / article / PDF / EPUB / video / episode | `media:<id>` | subtype/format is metadata, not a scheme |
| Podcast show | `podcast:<id>` | routeable/attachable/searchable metadata, not a citation target by default |
| Library | `library:<id>` | routeable/search scope, not evidence citation target |
| Content chunk | `content_chunk:<id>` | citable/readable evidence target, owner-aware |
| Evidence span | `evidence_span:<id>` | citable/readable evidence target, owner-aware |
| Fragment | `fragment:<id>` | citable/readable media fragment |
| Page | `page:<id>` | routeable/searchable title/container, citable only as policy says |
| Note body | `note_block:<id>` | searchable/readable/citable note body |
| Highlight | `highlight:<id>` | searchable/readable/citable selection |
| User annotation | `highlight:<id>` + `highlight_note` edge to `note_block:<id>` | no standalone `annotation:` scheme |
| Conversation | `conversation:<id>` | routeable/searchable transcript/container, not evidence citation by default |
| Message | `message:<id>` | readable/citable generated/user message as policy says |
| Oracle reading | `oracle_reading:<id>` | generated-output citation source/chat subject |
| Oracle passage anchor | `oracle_passage_anchor:<id>` | stable citable/concordance target that resolves to current corpus media evidence |
| LI artifact head | `library_intelligence_artifact:<id>` | routeable mutable head, not citation source |
| LI revision | `library_intelligence_revision:<id>` | immutable generated-output citation source |
| External web snapshot | `external_snapshot:<id>` | citable external target, not user-created link target |
| Author/person | `contributor:<id>` | no `author:` scheme |
| Source-authored apparatus item | `reader_apparatus_item:<id>` | new scheme for footnotes/endnotes/bibliography/in-document citations |

Adding `reader_apparatus_item` is the only new scheme in this cutover. It wraps
existing apparatus rows; it does not move apparatus extraction into the graph.
The apparatus row keeps kind/source locator/body. The resource layer gives it
identity, search, activation, link, and citation capability.

### Search contract

`SearchQuery` loses private chat-only overrides:

```python
@dataclass(frozen=True, slots=True)
class SearchQuery:
    text: str
    requested_kinds: frozenset[SearchKind] | None
    formats: tuple[MediaFormat, ...]
    authors: tuple[ContributorHandle, ...]
    roles: tuple[ContributorRole, ...]
    scope: SearchScope
    cursor: str | None
    limit: int
```

No `result_types`. No `storage_kinds`. No model-planned internal result types.
If chat wants narrower evidence, chat filters the shared result stream after
search through `select_prompt_evidence(...)`.

`SearchResultOut` changes from link-first to resource-first:

```python
class SearchResultBaseOut(BaseModel):
    type: SearchResultType
    resource_ref: ResourceRefOut
    activation: ResourceActivationOut
    citation_target: ResourceRefOut | None
    can_attach: bool
    can_cite: bool
    title: str
    snippet: str | None
    source_label: str | None
    score: float
```

`deep_link` is removed as an app-internal navigation field. If external display
is required, it lives in an explicit `external_url` or citation snapshot.

`app_search` behavior:

1. Parse tool args and conversation scopes.
2. Build the same `SearchQuery` user search would build.
3. Call `search()` or `search_scopes()`.
4. Convert results to retrieval telemetry using the target owner.
5. Select prompt evidence under budget.
6. Record `message_retrievals`.
7. Generated answer citations later write `resource_edges`.

### Citation contract

Generated citations are only graph citation edges:

```text
source = message | oracle_reading | library_intelligence_revision
target = citable ResourceRef
origin = citation
ordinal = dense display number
snapshot = display snapshot
```

`CitationOut` is built from edges and includes:

- edge id;
- source ref;
- target ref;
- activation target;
- citation target kind;
- title/snippet/snapshot metadata;
- unresolved state if the current target cannot activate.

Frontend code renders `CitationOut` directly. It never reconstructs a citation
target from `message_retrievals` when a `CitationOut` is available.

### Content index contract

Content index owners are a policy, not a string coincidence:

```python
IndexOwnerKind = Literal["media", "note_block", "reader_apparatus_item"]
```

This cutover does not make every resource body-indexed. It adds a declared
owner policy:

- `media` owns article/PDF/EPUB/video/episode transcript evidence;
- `note_block` owns note body evidence;
- `reader_apparatus_item` owns source-authored apparatus text when materialized;
- metadata-only resources use lexical/metadata retrievers, not chunks.

All content-index-backed retrievers must enforce the same ready-state rule. If
pending state leaves stale rows in place, those rows are excluded consistently
for chunks, evidence spans, fragments, highlights, notes, and apparatus items.

### Frontend activation contract

All internal open actions call one adapter:

```ts
activateResource(target: ResourceActivationOut, options?: ActivateResourceOptions): void
hrefForResourceActivation(target: ResourceActivationOut): string | null
resourceRefForActivation(target: ResourceActivationOut): ResourceRef | null
```

Consumers:

- `SearchResultRow`;
- command palette result rows;
- `ReaderCitation`;
- chat evidence/trust inspector;
- `ConnectionsSurface`;
- reader document-map citations;
- reader document-map connections;
- resource chat context refs;
- LI citation panes;
- Oracle citation panes.

`ReaderSourceTarget` can remain as an internal reader implementation detail, but
it is not the cross-product citation/search/connection activation contract.

## API Design

### Resource item API

Existing:

```text
GET /resource-items/{resource_ref}
```

Final `ResourceItemOut` includes:

- `resource_ref`;
- `title`;
- `summary`;
- `kind_label`;
- `capabilities`;
- `activation`;
- `route` only if still needed as a derived presentation alias;
- `children` only through explicit expansion policy.

Frontend generic resource item types live under
`apps/web/src/lib/resources/`, not under notes.

### Search API

Existing:

```text
GET /search
```

Final route accepts only the public search contract:

- `q`;
- `kinds`;
- `formats`;
- `authors`;
- `roles`;
- `scope`;
- `cursor`;
- `limit`.

Deleted/internal params are rejected at the route edge:

- `types`;
- `content_kinds`;
- `result_types`;
- `storage_kinds`;
- `semantic`;
- any chat-only planned type/filter field.

Response rows are resource-first as described in the search contract.

### Conversation and chat APIs

`POST /chat-runs` accepts `chat_subject` and context refs as `ResourceRef`
strings. `reader_context` is not reintroduced.

`app_search` tool schema uses public query concepts only. The model-facing tool
exposes `query`, `kinds`, `formats`, `authors`, `roles`, and `scopes`; the
executor cannot receive or persist internal result-type/storage-kind overrides.

### Resource graph APIs

`resource_edges` APIs accept `ResourceRef` endpoints and return `ConnectionOut`
with:

- edge identity;
- source/target refs;
- hydrated resource item summaries;
- activation target for the other endpoint;
- citation projection when `origin='citation'`.

No connection response returns a bare `href` without a resource activation
object.

## Files And Owners

### Backend

- `python/nexus/services/resource_graph/refs.py`
  - add `reader_apparatus_item`;
  - keep scheme grammar closed;
  - no aliases for removed/nonexistent schemes.
- `python/nexus/services/resource_items/capabilities.py`
  - expand policy shape;
  - expose typed helpers;
  - remove raw list consumers where possible.
- `python/nexus/services/resource_items/targets.py`
  - new owner for `ResourceRef`/search-result/citation-target mapping.
- `python/nexus/services/resource_items/activation.py`
  - new owner for activation read model.
- `python/nexus/services/resource_items/surfaces.py`
  - include activation and target policy in `ResourceItemOut`.
- `python/nexus/schemas/resource_items.py`
  - define `ResourceActivationOut` and target policy output.
- `python/nexus/schemas/search.py`
  - make rows resource-first;
  - remove app-internal navigation authority.
- `python/nexus/services/search/query.py`
  - remove chat-only internal overrides.
- `python/nexus/services/search/service.py`
  - project through resource target/activation owner.
- `python/nexus/services/search/retrievers/*`
  - return owner-aware target identifiers;
  - stop encoding activation decisions locally.
- `python/nexus/services/search/scope.py`
  - keep scope SQL owner;
  - add apparatus owner cells if searchable.
- `python/nexus/services/agent_tools/app_search.py`
  - use public `SearchQuery`;
  - move evidence narrowing after search;
  - remove internal result-type/storage-kind path.
- `python/nexus/services/retrieval_citation.py`
  - consume resource target mapping for retrieval rows.
- `python/nexus/services/resource_graph/citations.py`
  - include activation in `CitationOut`;
  - keep dense ordinal ownership.
- `python/nexus/services/resource_graph/connections.py`
  - return activation from resource item owner, not local href logic.
- `python/nexus/services/resource_graph/resolve.py`
  - hydrate apparatus resources and owner-aware chunks/spans.
- `python/nexus/services/content_indexing.py`
  - declare index owner policy;
  - enforce ready-state consistency.
- `python/nexus/services/reader_apparatus.py`
  - expose apparatus item resource rows without owning graph/citation behavior.
- `python/nexus/db/models.py`
  - update scheme CHECKs and content owner checks.
- `migrations/alembic/versions/*`
  - update DB CHECK parity and any new apparatus owner/index requirements.

### Frontend

- `apps/web/src/lib/resourceGraph/resourceRef.ts`
  - add `reader_apparatus_item`;
  - no local aliases.
- `apps/web/src/lib/resources/resourceCapabilities.generated.ts`
  - generated capability/activation manifest.
- `apps/web/src/lib/resources/activation.ts`
  - new sole activation adapter.
- `apps/web/src/lib/resources/api.ts`
  - generic resource item fetch/normalize owner.
- `apps/web/src/lib/search/types.ts`
  - resource-first row types.
- `apps/web/src/lib/search/normalizeSearchResult.ts`
  - validate activation and resource refs.
- `apps/web/src/lib/search/searchViewModel.ts`
  - derive row view model from activation, not raw href.
- `apps/web/src/components/search/SearchResultRow.tsx`
  - activate through resource adapter.
- `apps/web/src/components/palette/*`
  - consume same row activation.
- `apps/web/src/lib/conversations/citationOut.ts`
  - mirror backend `CitationOut` with activation.
- `apps/web/src/lib/resourceGraph/citations.ts`
  - no telemetry reconstruction path when `CitationOut` exists.
- `apps/web/src/lib/conversations/readerTarget.ts`
  - reduce to reader-internal helper or delete duplicate cross-product role.
- `apps/web/src/components/ui/ReaderCitation.tsx`
  - render `ResourceActivationOut`.
- `apps/web/src/components/connections/ConnectionsSurface.tsx`
  - remove local scannable scheme/openability policy.
- `apps/web/src/components/reader/document-map/*`
  - use shared activation for citations and connections.
- `apps/web/src/lib/panes/paneRouteModel.ts`
  - route identity derives from resource activation/resource item policy.

### Tests and gates

- `python/tests/test_resource_item_capabilities.py`
- `python/tests/test_resource_item_surfaces.py`
- `python/tests/test_resource_graph_refs.py`
- `python/tests/test_resource_graph_edges.py`
- `python/tests/test_resource_graph_citations.py`
- `python/tests/test_resource_graph_connections.py`
- `python/tests/test_search_intent_model_guards.py`
- `python/tests/test_search_scope_matrix.py`
- `python/tests/test_search.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_read_resource_tool.py`
- `python/tests/test_reader_apparatus_html.py`
- `python/tests/test_migrations.py`
- `python/tests/test_cutover_negative_gates.py`
- `apps/web/src/lib/resourceGraph/contractParity.test.ts`
- `apps/web/src/lib/search/*.test.ts`
- `apps/web/src/lib/resources/*.test.ts`
- `apps/web/src/lib/conversations/citations.test.ts`
- `apps/web/src/components/**` focused render/activation tests.

## Duplicate Lanes To Delete

Delete or collapse these lanes during implementation:

1. Local search result type maps outside `schemas/search.py`, `services/search`,
   or generated frontend manifests.
2. `SearchQuery.result_types` and `SearchQuery.storage_kinds`.
3. `app_search` planned internal result types and storage filters.
4. Frontend `href` as the search row source of truth.
5. Local `context_ref` opening through object-ref route maps.
6. `resource_graph.connections` local href construction.
7. `ReaderSourceTarget` as cross-product citation/search activation.
8. Telemetry-derived citation reconstruction when `CitationOut` exists.
9. Separate document-map citation and connection locator-to-anchor logic.
10. Generic resource item normalizers under notes API ownership.
11. Frontend local scheme subsets for connection scannability/openability.
12. Backend citable result-type maps outside capability/target owners.
13. Readiness checks that differ between content-index-backed retrievers.
14. Stale docs that describe deleted stores or deleted schemes as current.

## Implementation Slices

### S0 - Contract Freeze And Census

- Add this spec.
- Add a source census issue list or checklist in the implementation PR.
- Confirm no unlisted owner answers resource activation, citable target mapping,
  or app-search result-type filtering.
- Add negative gates for new local resource capability lists before changing
  behavior.

Gate: no runtime behavior changes yet; tests remain green.

### S1 - Resource Target And Activation Owners

- Add backend target and activation owner modules.
- Add `ResourceActivationOut`.
- Add generated frontend type/manifest support.
- Wire `ResourceItemOut` to include activation.
- Keep old consumers temporarily only inside the same branch, then delete in
  later slices before merge. No production dual path.

Gate: resource item API can activate every currently routeable scheme through
the owner.

### S2 - Search Result Resource-First Contract

- Change `SearchResultOut` to emit `resource_ref`, `activation`, and
  `citation_target`.
- Remove `deep_link` as internal navigation authority.
- Refactor retrievers/projection to use target owner.
- Update `/search`, frontend search, and palette together.
- Reject deleted/internal query params.

Gate: user search and palette use same resource-first rows and activation.

### S3 - `app_search` Public Query Cutover

- Remove `SearchQuery.result_types` and `storage_kinds`.
- Remove planned internal result-type/storage filters from `app_search`.
- Convert `app_search` to public query semantics plus chat-owned
  post-search evidence selection.
- Ensure telemetry rows record selected results without becoming citation truth.

Gate: identical `SearchQuery` fixtures produce the same candidate set for user
search and `app_search` before chat evidence budgeting.

### S4 - Citation And Connection Activation Cutover

- Add activation to `CitationOut` and `ConnectionOut`.
- Delete frontend citation target reconstruction paths that duplicate backend
  `CitationOut`.
- Convert chat, LI, Oracle, document-map citations, and connections to shared
  activation.
- Delete local href construction in graph connection projections.

Gate: every citation/connection surface opens through one frontend adapter.

### S5 - Owner-Aware Evidence And Readiness

- Make `content_chunk` and `evidence_span` result resolution owner-aware.
- Decide whether note-owned chunks appear as generic `content_chunk` rows or
  only as `note_block` rows; encode that decision in target policy and tests.
- Apply one ready-state rule to every content-index-backed retriever.
- Align repair coverage with ingest coverage, including video transcripts.

Gate: no stale pending-index row can appear from one retriever while another
excludes it.

### S6 - Reader Apparatus Resource Items

- Add `reader_apparatus_item` scheme and DB CHECK parity.
- Expose apparatus rows through resolver/resource item surfaces.
- Index apparatus text if searchable.
- Add search result and activation support.
- Keep generated citations separate from apparatus storage.

Gate: a source-authored footnote/endnote/reference can be searched, opened in
the reader, linked, and cited as a target without becoming a generated citation
edge itself.

### S7 - Frontend Consolidation And Dead Code Deletion

- Move generic resource item API types out of notes.
- Delete old activation helpers or narrow them to reader-internal usage.
- Remove object-ref route fallback for context refs.
- Delete local capability/scannability lists.
- Update pane route identity for contributor/author routes.

Gate: grep gates prove no old activation, capability, or target maps remain.

### S8 - Docs, Architecture, And Final Gates

- Update `docs/architecture.md`.
- Mark superseded parts of older cutovers as historical or remove stale claims.
- Add negative gates for deleted params, deleted target maps, deleted
  app-search overrides, and deleted frontend href authority.
- Run targeted backend/frontend tests plus migration checks.

Gate: docs, tests, generated manifests, and DB checks agree on schemes and
capabilities.

## Acceptance Criteria

AC1. Every backend `ResourceScheme` has exactly one capability row and one
target-policy decision.

AC2. Frontend and backend `ResourceScheme` sets match, including
`reader_apparatus_item`.

AC3. No production code outside resource item owners defines routeability,
activation, citable target, readable scheme, app-search scope, or search-result
scheme lists by hand.

AC4. `/search` rows carry `resource_ref`, `activation`, and `citation_target`.
They do not use `deep_link` as app-internal navigation authority.

AC5. Palette rows and search page rows use the same row model and activation
adapter.

AC6. `app_search` builds the same `SearchQuery` contract as user search and has
no private internal result-type/storage-kind override path.

AC7. For a shared query fixture, user search and `app_search` produce the same
candidate set before chat-owned evidence budgeting.

AC8. `message_retrievals` remains telemetry and never owns citation numbering.

AC9. Every generated citation chip is backed by a `resource_edges` citation edge
and backend-built `CitationOut`.

AC10. No frontend surface reconstructs a `CitationOut` target from retrieval
telemetry when the backend supplied `CitationOut`.

AC11. Connections, search rows, context refs, document-map rows, LI citations,
Oracle citations, and chat citations activate through the same frontend
resource activation adapter.

AC12. `ReaderSourceTarget` is either deleted as a cross-product type or narrowed
to reader-internal implementation detail.

AC13. Note-owned and media-owned chunk/span behavior is explicit in the target
policy and tested.

AC14. All content-index-backed result types enforce one ready-state rule.

AC15. Generic repair coverage matches ingest coverage for every body-indexed
media kind.

AC16. `reader_apparatus_item` rows can be searched, opened, linked, and cited
as source-authored apparatus resources.

AC17. Generated assistant citations and source-authored apparatus rows remain
separate domains with separate storage owners.

AC18. Contributor/author product surfaces resolve to `contributor:<id>` when
they need a resource identity.

AC19. No `episode:`, `video:`, `web:`, `pdf:`, `epub:`, `author:`,
`annotation:`, or `tag:` ResourceRef scheme is accepted.

AC20. Deleted/internal search params are rejected at the route edge.

AC21. `SearchResultOut`, `CitationOut`, `ConnectionOut`, `ResourceItemOut`, and
reader document-map rows all use the same activation schema.

AC22. DB CHECK constraints, backend refs, frontend refs, capability rows, and
generated manifests agree.

AC23. Negative gates fail on reintroduced local capability lists, local href
builders, app-search result-type constants, telemetry citation reconstruction,
or object-ref context route fallback.

AC24. `docs/architecture.md` documents the final spine and older stale docs no
longer present superseded concepts as current.

## Test Plan

Backend targeted:

- resource ref grammar and DB CHECK parity;
- resource item capability coverage and helper behavior;
- resource activation for each scheme;
- search row projection for every result type;
- user search/app-search candidate parity;
- app-search telemetry and post-search evidence selection;
- graph citation edge ordinal/read model behavior;
- connection read model activation;
- reader apparatus resource search/activation;
- content-index readiness and repair coverage;
- migration tests for schemes/checks/index owners.

Frontend targeted:

- generated capability parity;
- resource activation adapter unit tests;
- search normalizer rejects rows without valid activation;
- search and palette rows activate through the shared adapter;
- `ReaderCitation` renders and activates backend `CitationOut`;
- connections and document-map surfaces use shared activation;
- contributor/author pane route identity;
- generic resource item API normalizer under resources.

Negative gates:

- no `APP_SEARCH_RESULT_TYPES`;
- no `SearchQuery.result_types` or `storage_kinds`;
- no route/search param acceptance for deleted internal keys;
- no local `hrefForRef`/`routeForRef` helpers outside the owner;
- no frontend local resource capability lists outside generated manifests;
- no telemetry-to-citation reconstruction path for backend-supplied citations;
- no `tag`, `author`, `annotation`, `episode`, `video`, `pdf`, or `epub`
  ResourceRef schemes.

## Key Decisions

D1. Same primitives does not mean same capabilities.

D2. `ResourceRef` remains the only cross-domain identity. Product aliases map
to existing schemes.

D3. `resource_edges` stores durable positive connections and generated citation
edges. It does not store search results, prompt retrieval telemetry, or
source-authored apparatus structure.

D4. `message_retrievals` stays because it is run telemetry. Its only citation
relationship is `cited_edge_id`.

D5. `app_search` can remain a chat tool with prompt budgeting, but it cannot
own private search semantics.

D6. `deep_link` is allowed in snapshots and external display, not as the
internal route authority.

D7. Source-authored apparatus becomes resource-addressable through
`reader_apparatus_item`, while generated citations stay graph-owned.

D8. User annotations remain `highlight` plus attached `note_block` until a
standalone annotation entity exists.

D9. Contributors are people/authors. No `author` scheme.

D10. Content index owners are explicit and limited. Metadata-searchable
resources do not need fake chunks.

D11. Frontend activation is one adapter. Individual components may style the
action, but not reinterpret the target.

## Composition With Existing Systems

### Search

Search remains the retrieval owner. This cutover changes what search returns and
how chat calls it; it does not move ranking or scope SQL into the graph.

### Resource graph

The graph remains the durable connection owner. Search does not become graph
traversal. Graph connections can influence scope only through explicit
`services/search/scope.py` policy.

### Chat

Chat consumes search and graph. It owns run telemetry, prompt inclusion, tool
calls, and budgeted evidence selection. It does not own citable target mapping,
resource routes, or search result taxonomies.

### Reader

Reader owns text rendering and reader-internal anchors. Product surfaces consume
resource activation. Reader apparatus remains source-authored document
structure, but its rows can be wrapped as resource items.

### Notes and highlights

Notes stay `page`/`note_block`. Highlight notes stay
`highlight -> note_block` edges with `origin='highlight_note'`. Inline note refs
stay `origin='note_body'` edges. No separate annotation graph appears.

### Library Intelligence

LI artifact heads remain mutable product surfaces. LI revisions remain immutable
generated-output citation sources. Citation chips come from graph-built
`CitationOut` with shared activation.

### Oracle

Oracle readings remain generated outputs and citation sources. Oracle corpus
passages remain citable targets. Oracle citation chips use the same activation
shape as chat and LI.

### Contributors

Contributor identity remains the author/person model. Search role/author filters
consume contributor taxonomy; resource identity is `contributor:<id>`.

### Web

In-library web articles are `media` resources. Public web tool results become
`external_snapshot` resources only when persisted/cited. There is no general web
archive hidden behind search.

## Rollout Discipline

This is a hard cutover but should land in reviewable slices on one branch. No
slice may merge independently while leaving production dual paths. The final PR
deletes compatibility code before merge.

Each slice must:

- name the owner being changed;
- delete the duplicate path it supersedes;
- update tests at the owner boundary;
- update generated manifests when schema/capability changes;
- update negative gates before the duplicate can regress;
- avoid broad refactors unrelated to the spine.

## Open Questions To Resolve Before S1

O1. Does `reader_apparatus_item` need one table-level id per apparatus row, or
can existing apparatus row ids be used directly? The scheme should wrap the
existing row if the row already has a stable UUID.

O2. Should note-owned chunks be exposed as `content_chunk` search results, or
only as `note_block` search results with internal chunk evidence? Either is
acceptable only if the target policy and tests make it explicit.

O3. Does `CitationOut` keep a display `deep_link` field as snapshot metadata
after activation becomes authoritative? If yes, rename or document it so it is
not treated as the app route.

O4. Which exact frontend components still need raw `href` for browser behavior?
Those components may derive it from `ResourceActivationOut`; none may parse it
back into identity.

O5. Does `podcast` become searchable metadata only, or also a scope-like parent
that expands to episodes? The capability policy must say so explicitly.

# Resource Capability Registry Hard Cutover

Status: SPECIFICATION
Author: Codex
Type: hard cutover
Date: 2026-06-17

## North Star

Nexus has one per-resource-scheme capability authority.

Every system that needs to decide whether a `ResourceRef` can be shown, opened,
attached, read, cited, searched, scoped, expanded, or rendered in a prompt asks
the resource capability service. No feature keeps a private list of supported
schemes, supported result types, routeability, citable mappings, prompt modes,
or expansion behavior.

The product language is:

> This resource can be linked, attached, read, cited, searched, expanded, and
> rendered in these exact ways.

The architecture is:

```text
ResourceRef
  -> resource_graph.refs identity grammar
  -> resource_graph.resolve runtime visibility and hydration
  -> resource_items.capabilities static per-scheme product capability
  -> resource_items route/read/citation/search/prompt/expansion policy helpers
  -> graph, search, chat, citations, object refs, and frontend chips consume
     those helpers or a generated frontend manifest
```

The outcome is alignment without pretending all schemes behave identically.
`media`, `library`, `highlight`, `message`, `oracle_reading`,
`library_intelligence_revision`, `external_snapshot`, `contributor`, and
`podcast` remain different products with explicit, tested policy.

## Type

Hard cutover. No legacy code, no fallback lists, no compatibility constants, no
duplicate route resolvers, no frontend-only scheme policy, no hidden search
allowlists, no old names kept as aliases, and no backwards-compatible payload
shape whose only purpose is to preserve the pre-cutover model.

If two modules answer the same capability question, one of them stops answering
it. If a call site needs a local list for performance or ergonomics, it must be
derived from the capability registry in the same module that owns the registry,
not re-authored at the call site.

## Precedents And Repo Rules

- `docs/cutovers/resource-graph-product-spine-hard-cutover.md` makes
  `resource_edges` the durable positive connection spine.
- `docs/cutovers/resource-chat-subject-hard-cutover.md` makes
  `resource_items.capabilities` the owner for chat subject, read, search,
  prompt, attach, and cite decisions.
- `docs/cutovers/resource-native-pages-and-notes-hard-cutover.md` names
  resource item capability policy as the consolidation point for linkable,
  readable, citable, attachable, contextable, searchable, and expandable
  behavior.
- `docs/cutovers/search-intent-model-hard-cutover.md` makes
  `services/search/scope.py` the `scope -> SQL` owner and keeps search
  taxonomy out of feature surfaces.
- `docs/modules/chat.md` keeps chat request assembly, prompt assembly, retrieval
  telemetry, and graph citations distinct.
- `docs/modules/reader-implementation.md` keeps reader selection bind-only and
  keeps generated chat citations separate from source-authored apparatus.
- `docs/rules/cleanliness.md` requires one owner per concern, deletion of
  compatibility lanes, and collapsing dangerous duplication.
- `docs/local-rules/module-apis.md` requires each capability in one primary form.
- `docs/rules/layers.md` keeps BFF and API routes thin; services own business
  behavior.
- `docs/rules/correctness.md` requires typed boundary parsing and illegal states
  made unrepresentable.
- `docs/local-rules/testing_standards.md` requires behavior tests at owner boundaries,
  not implementation-shape tests.

## SME Thesis

A subject matter expert would treat this as a capability-contract problem, not
as a search cleanup, not as a frontend enum sync, and not as a one-off
`read_resource` fix.

The repo already has the right center of gravity:

- `resource_graph.refs` owns the closed `ResourceRef` grammar.
- `resource_graph.resolve` owns hydration, display labels, prompt bodies, and
  runtime visibility.
- `resource_items.capabilities` owns item-level product facts.
- `resource_graph.policy` owns edge shape.
- `resource_graph.citations` owns citation edge writes and `CitationOut`.
- `resource_graph.context` owns conversation context refs and context-derived
  search scope discovery.
- `services/search/scope.py` owns search scope SQL.
- `services/search/kinds.py` and `schemas/search.py` own search result and
  user-facing kind taxonomies.
- Frontend resource refs are parsed in `apps/web/src/lib/resourceGraph`, and
  BFF routes proxy to backend owners.

The professional move is to finish the owner boundary:

1. Make `resource_items.capabilities` expose a deep, typed public capability
   service.
2. Move routeability, expansion policy, citable mapping, searchable scope,
   prompt render, attachability, linkability, and frontend chip affordances to
   that service or its generated frontend manifest.
3. Keep graph, search, resolver, and frontend display systems as consumers with
   their own narrow domains.

The wrong moves are:

- adding a second top-level `resource_capabilities` package that competes with
  `resource_items.capabilities`;
- putting runtime ACL checks or SQL hydration into static capability booleans;
- turning search into "walk every graph edge";
- turning every search result type into a resource scheme;
- treating `linkable`, `attachable`, `readable`, `searchable`, and `citable` as
  synonyms;
- leaving old constants such as local readable lists, citable maps, frontend
  object-type subsets, or scope regexes as independent truth;
- using frontend object refs as a route resolver for graph resources;
- keeping route helpers in multiple backend modules;
- keeping local fallback behavior for schemes the registry did not classify.

## Current Head Facts

### Already Correct

- `python/nexus/services/resource_items/capabilities.py` defines one
  `ResourceItemCapability` for every `ResourceScheme`.
- That module already derives readable schemes, scope-only schemes,
  app-search-scope schemes, conversation-search-scope schemes, citable result
  type mappings, citation output source schemes, linkable schemes, attachable
  schemes, and chat subject schemes.
- `python/tests/test_resource_item_capabilities.py` already fails when a
  `ResourceScheme` lacks a capability row.
- `python/nexus/schemas/resource_items.py` already exposes
  `ResourceItemCapabilitiesOut` on `ResourceItemOut`.
- `python/nexus/services/resource_items/surfaces.py` already resolves a
  `ResourceRef` and returns `route`, `missing`, labels, summary, capabilities,
  and version lanes.
- `python/nexus/services/resource_graph/context.py` checks
  `RESOURCE_ITEM_CAPABILITIES[target.scheme].attachable` before adding context
  refs.
- `python/nexus/services/resource_items/chat_subjects.py` checks
  `chat_subject`, `attachable`, and generated-output behavior.
- `python/nexus/services/context_assembler.py` uses `prompt_render` and
  `CITABLE_RESOURCE_RESULT_TYPES` for prompt rendering and attached citation
  materialization.
- `python/nexus/services/agent_tools/read_resource.py` already imports readable
  and citable policy from the capability module.
- `python/nexus/services/agent_tools/app_search.py` already imports
  `APP_SEARCH_SCOPE_SCHEMES` from the capability module for explicit scope
  validation.
- `python/nexus/services/resource_graph/policy.py` already imports
  `CITATION_OUTPUT_SOURCE_SCHEMES` from capabilities for graph citation source
  validation.
- `apps/web/src/lib/resourceGraph/contractParity.test.ts` already guards
  frontend/backend graph vocabulary parity.

### Still Wrong Or Partial

- Capability fields are still a flat dataclass plus derived constants, not a
  public policy service with typed route, read, search, citation, prompt, and
  expansion helpers.
- `visible` is not modeled correctly as a runtime resolver outcome. Callers can
  confuse static capability with runtime visibility.
- `resolvable` is implicit in `ResourceScheme` and resolver branches, not
  declared as a product capability.
- `route` is duplicated in `resource_items.surfaces._route_for_ref`,
  `resource_graph.connections._href_for_ref`, object-ref hydration, and
  frontend pane/opening helpers.
- `expansion_policy` is split: `ResourceItemCapability.expandable` is currently
  false for every scheme, while real owner rollup lives in
  `resource_graph.connections._owner_children`.
- `read_resource._present_read` still branches per scheme for presentation and
  citation behavior beyond using the registry for admission.
- `inspect_resource` is media-only by local code, not by a named capability such
  as `inspectable` or `expansion_policy`.
- `context_assembler` imports `CITABLE_RESOURCE_RESULT_TYPES` directly instead
  of asking a citation policy helper.
- `app_search` imports a tuple of schemes and has local scope grammar hints
  instead of asking a search-scope policy helper.
- `resource_graph.context.search_scope_refs_for_conversation` imports
  app-search and conversation-search tuples directly.
- `resource_graph.edges` and `resource_graph.adjacency` import the raw registry
  and read booleans directly.
- `apps/web/src/lib/objectRefs.ts` has a frontend `OBJECT_TYPES` subset that
  does not match backend `OBJECT_TYPES = ResourceScheme`.
- `apps/web/src/lib/resources/resourceKind.ts` has icon and scheme-to-object-ref
  maps. Icon presentation can remain frontend-owned, but object-ref/openability
  policy cannot.
- `apps/web/src/lib/search/types.ts`,
  `apps/web/src/lib/search/kinds.ts`,
  `apps/web/src/lib/search/parseSearchInput.ts`, and
  `apps/web/src/lib/api/sse/citations.ts` mirror search and citation
  vocabularies without a single generated manifest or parity-tested owner.
- `apps/web/src/components/connections/ConnectionsSurface.tsx` has local
  scannable type, origin, and kind lists.
- Citation target type, citable search result type, prompt numbering, and
  graph-backed `CitationOut` eligibility are related but not explicitly modeled
  as separate policy decisions.
- There is no cross-language guard asserting that frontend resource capability
  shapes match backend capability output.
- There is no negative gate that bans new local lists for capability decisions.

## Target Behavior

T1. Every `ResourceScheme` has exactly one capability row.

T2. The capability row explicitly declares static product behavior:

- whether the scheme can appear in visible product resource surfaces;
- whether it is resolvable through the resource resolver;
- how routes are produced;
- whether it can be linked;
- whether it can be attached;
- whether it can be a chat subject and in which prompt mode;
- whether `read_resource` can read it and in which mode;
- whether `inspect_resource` can inspect it;
- whether it can become a numbered prompt citation;
- whether it can become a graph-backed `CitationOut` target;
- whether it can be a generated-output citation source;
- whether it can be an app-search scope;
- whether it can activate conversation search scope;
- which search result type, if any, materializes it;
- how it renders in prompts;
- how it expands into owned child refs for connections or inspect surfaces;
- whether it can be an adjacency source or target.

T3. Runtime visibility is not a static boolean. The registry declares which
resolver path owns visibility, and `resource_graph.resolve` returns the runtime
answer.

T4. A missing, unauthorized, or unresolved row is not made visible by static
capability. Capability says "this scheme supports visible resources"; resolver
says "this specific ref is visible now."

T5. A scheme can be linkable but not readable.

T6. A scheme can be attachable but not searchable.

T7. A scheme can be readable but not citable.

T8. A scheme can be a generated-output citation source without being a source
evidence citation target.

T9. A scheme can be a search result type without being a graph-backed
`CitationOut` target.

T10. `app_search` scope eligibility remains narrower than generic conversation
read admission.

T11. Owner expansion does not imply search scope. Expansion is a product
projection for connections and navigation, not graph traversal for retrieval.

T12. Frontend chips and object-opening behavior are driven by `ResourceItemOut`
or the generated capability manifest, not by local object-ref subsets.

T13. Search result taxonomy stays search-owned, but any mapping from a
`ResourceScheme` to a search result type is declared in resource capabilities
or a search-owned manifest that the resource registry references by type.

T14. Adding a new `ResourceScheme` fails tests until every capability decision,
route policy, expansion policy, citation policy, search policy, frontend
projection, and negative gate implication is explicit.

## Capability Contract

The final service is `python/nexus/services/resource_items/capabilities.py`.
If implementation size requires splitting, helper modules may live under
`python/nexus/services/resource_items/`, but callers still import the public
capability API from one owner.

The target contract is semantic, not necessarily exact final Python syntax:

```python
ResourceVisibilityMode = Literal[
    "none",
    "runtime_resolver",
]

ResourceResolveMode = Literal[
    "none",
    "resource_graph_resolve",
]

ResourceRouteMode = Literal[
    "none",
    "direct",
    "lookup",
    "reader_target",
]

ResourceReadMode = Literal[
    "none",
    "scope",
    "body",
    "media",
]

ResourceInspectMode = Literal[
    "none",
    "media_document_map",
]

ResourceChatSubjectMode = Literal[
    "none",
    "label",
    "scope",
    "readable",
    "quote",
    "generated_output",
]

ResourcePromptRenderMode = Literal[
    "none",
    "label",
    "inline_body",
    "quote",
]

ResourceExpansionPolicy = Literal[
    "none",
    "media_owned_reader_children",
    "page_note_blocks",
    "note_block_owned_evidence",
    "library_intelligence_artifact_revisions",
]

@dataclass(frozen=True, slots=True)
class ResourceCitationPolicy:
    prompt_numbered_result_type: str | None
    graph_citation_target: bool
    citation_output_source: bool
    citation_target_type: str | None

@dataclass(frozen=True, slots=True)
class ResourceSearchPolicy:
    app_scope: bool
    conversation_scope: bool
    result_type: str | None

@dataclass(frozen=True, slots=True)
class ResourceRoutePolicy:
    mode: ResourceRouteMode
    routeable: bool

@dataclass(frozen=True, slots=True)
class ResourceItemCapability:
    visible: ResourceVisibilityMode
    resolvable: ResourceResolveMode
    route: ResourceRoutePolicy
    linkable: bool
    attachable: bool
    chat_subject: ResourceChatSubjectMode
    readable: ResourceReadMode
    inspectable: ResourceInspectMode
    citable: ResourceCitationPolicy
    search: ResourceSearchPolicy
    prompt_render: ResourcePromptRenderMode
    expansion_policy: ResourceExpansionPolicy
    adjacency_source: bool
    adjacency_target: bool
```

The existing scalar fields can be kept only if they remain the primary API.
No call site should import the raw table and reinterpret fields when a named
helper exists.

### Required Public Queries

The service exposes named operations with typed inputs and outputs:

- `capability_for_scheme(scheme: ResourceScheme) -> ResourceItemCapability`
- `capability_for_ref(ref: ResourceRef) -> ResourceItemCapability`
- `resource_can_link(ref: ResourceRef) -> bool`
- `resource_can_attach(ref: ResourceRef) -> bool`
- `resource_can_be_chat_subject(ref: ResourceRef) -> bool`
- `resource_read_policy(ref: ResourceRef) -> ResourceReadMode`
- `resource_inspect_policy(ref: ResourceRef) -> ResourceInspectMode`
- `resource_prompt_render_policy(ref: ResourceRef) -> ResourcePromptRenderMode`
- `resource_search_scope_policy(ref: ResourceRef) -> ResourceSearchPolicy`
- `resource_citation_policy(ref: ResourceRef) -> ResourceCitationPolicy`
- `resource_route_policy(ref: ResourceRef) -> ResourceRoutePolicy`
- `resource_expansion_policy(ref: ResourceRef) -> ResourceExpansionPolicy`
- `route_for_ref(db, viewer_id, ref) -> str | None`
- `expand_owned_child_refs(db, viewer_id, ref) -> tuple[ResourceRef, ...]`
- `resource_capability_manifest() -> ResourceCapabilitiesManifestOut`

Derived tuples and maps are allowed only inside the capability module or as
private implementation details. Public callers use semantic helpers unless a
tuple is itself the public capability, and then it must be exported from the
capability service with tests proving it is derived.

### Required Manifest Shape

The manifest is the backend-to-frontend source for static scheme behavior:

```json
{
  "schemes": {
    "media": {
      "visible": "runtime_resolver",
      "resolvable": "resource_graph_resolve",
      "route": { "mode": "direct", "routeable": true },
      "linkable": true,
      "attachable": true,
      "chatSubject": "readable",
      "readable": "media",
      "inspectable": "media_document_map",
      "citable": {
        "promptNumberedResultType": "media",
        "graphCitationTarget": true,
        "citationOutputSource": false,
        "citationTargetType": "media"
      },
      "search": {
        "appScope": true,
        "conversationScope": false,
        "resultType": "media"
      },
      "promptRender": "label",
      "expansionPolicy": "media_owned_reader_children",
      "adjacencySource": false,
      "adjacencyTarget": true
    }
  }
}
```

The primary frontend projection is generated TypeScript checked into the web
package or produced before frontend tests. The backend registry is the source of
truth; generated frontend output is never hand-edited. A runtime manifest
endpoint is not part of this cutover because per-ref runtime data is already
served by `ResourceItemOut`.

## Scheme Policy Targets

This table is the intended product shape. Exact route modes may be refined
during implementation, but every row must keep an explicit decision.

| Scheme | Visible | Resolvable | Route | Read | Inspect | Attach | Chat subject | Search scope | Prompt | Expansion | Citation target/source |
|---|---:|---:|---|---|---|---:|---|---|---|---|---|
| `media` | runtime | yes | direct `/media/:id` | media | document map | yes | readable | app | label | media children | target `media` |
| `library` | runtime | yes | direct `/libraries/:id` | scope | none | yes | scope | app | label | none | none |
| `evidence_span` | runtime | yes | reader target | body | none | yes | readable | none | inline body | none | target `evidence_span` |
| `content_chunk` | runtime | yes | reader target | body | none | yes | readable | none | inline body | none | target `content_chunk` |
| `highlight` | runtime | yes | media anchor | body | none | yes | quote | conversation | quote | none | prompt-numbered/search result; graph target only through normalized target policy |
| `page` | runtime | yes | direct `/pages/:id` | body | none | yes | readable | conversation | inline body | note blocks | prompt-numbered/search result; graph target only through normalized target policy |
| `note_block` | runtime | yes | direct `/notes/:id` | body | none | yes | readable | conversation | inline body | owned evidence | target `note_block` |
| `fragment` | runtime | yes | media anchor | body | none | yes | readable | none | inline body | none | prompt-numbered/search result; graph target only through normalized target policy |
| `conversation` | runtime | yes | direct `/conversations/:id` | body | none | yes | label | none | label | none | none |
| `message` | runtime | yes | conversation route | body | none | yes | readable | none | inline body | none | prompt-numbered result and citation output source; graph target policy remains explicit |
| `oracle_reading` | runtime | yes | direct `/oracle/:id` | body | none | yes | generated output | none | inline body | none | citation output source |
| `oracle_passage_anchor` | runtime | yes | reader target via current evidence pointer | body | none | no | none | none | inline body | none | stable Oracle public-domain citation/concordance target |
| `library_intelligence_artifact` | runtime | yes | library intelligence tab | body via current revision | none | yes | generated output/latest alias | none | inline body | artifact revisions | none |
| `library_intelligence_revision` | runtime | yes | exact revision tab | body | none | yes | generated output | none | inline body | none | citation output source |
| `external_snapshot` | runtime or citation-only | yes if resolver supports | none | none | none | no | none | none | none | none | target `external_snapshot` |
| `contributor` | runtime | yes | `/authors/:handle` | none | none | yes | label | none | label | none | none |
| `podcast` | runtime | yes | `/podcasts/:id` | none | none | yes | label | none | label | none | none |

The "prompt-numbered/search result" cases must be normalized during
implementation. A numbered prompt citation is not automatically a graph-backed
`CitationOut` target. The final policy must state the conversion target or
declare that the result is prompt-numbered only.

## Architecture And Composition

### ResourceRef

`resource_graph.refs` remains the identity owner.

The capability registry must import `ResourceScheme` and `ResourceRef`; it must
not define another scheme enum. It may fail import-time if the registry keys do
not exactly match `RESOURCE_SCHEMES`.

### Resolver And Visibility

`resource_graph.resolve` remains the runtime resolver and visibility owner.

The registry declares whether a scheme is resolvable in principle. It does not
query tables to decide whether a specific ref is visible. Callers needing labels,
summaries, prompt bodies, inline body text, or missing state must still call
`resolve_ref` or `load_resource_batch`.

### Resource Items API

`resource_items.surfaces.resource_item_out` becomes the canonical per-ref
projection:

- parsed ref;
- scheme;
- id;
- label;
- summary;
- runtime `missing`;
- canonical route;
- capability output;
- version lanes.

The route in `ResourceItemOut` is the canonical open target for frontend chips,
connections rows, object-ref hydration, context refs, search rows when they are
resource-backed, and chat subject rows.

### Routing

The backend has one route builder for a `ResourceRef`.

`resource_items.surfaces._route_for_ref` and
`resource_graph.connections._href_for_ref` collapse into the capability service.
Object-ref hydration consumes that service. Frontend pane route parsing can
still parse browser paths into pane state, but it is not allowed to be the
canonical routeability authority for a `ResourceRef`.

### Read Resource

`read_resource` composes three decisions:

1. Conversation admission: exact context ref or explicitly allowed parent-media
   context rule.
2. Resource read policy: `none`, `scope`, `body`, or `media`.
3. Presentation: scheme-specific text formatting.

Only decision 3 remains local to `read_resource`. Decisions 1 and 2 must be
named and tested; decision 2 comes from capabilities. Parent-media read
admission must stay separate from search scope.

### Present Read

`_present_read` may keep local formatting branches for text shape, page ranges,
media too-large responses, and enriched quotes. It must not own citable result
type mapping, scope-only classification, or readable-scheme classification.

### Inspect Resource

`inspect_resource` becomes a consumer of `inspectable` or `expansion_policy`.

Current behavior is media-only document-map navigation. That remains valid, but
the fact that only media can be inspected is declared in the registry. Non-media
errors cite the policy, not a local hardcoded set.

### Attached Context

Conversation context attachment uses `resource_can_attach`.

Attached prompt rendering uses `prompt_render`. Attached numbered materialization
uses `resource_citation_policy`. Context-derived app search scopes use
`resource_search_scope_policy`.

### App Search

`app_search` consumes a search-scope helper from capabilities for resource-scope
admission. It does not import a raw tuple or compile a private scope hint.

`services/search/scope.py` remains the only `scope -> SQL` owner. The resource
registry can say "this scheme may be an app-search scope"; search scope SQL
must still say how that scope filters each searchable result family.

### Search Result Taxonomy

Search result types and public search kinds are not resource schemes. They stay
owned by search modules.

The cutover adds one bridge:

- resource capability declares any scheme-to-result-type materialization;
- search owns result-type union, kind aliases, format filters, ranking weights,
  locator compatibility, and SQL dispatch;
- frontend search types are generated from or parity-tested against search
  owners, not retyped independently.

### Citations

Citation policy is split into explicit decisions:

- Can this resource be rendered as a numbered prompt citation?
- Which search result type materializes it?
- Can this resource be a graph-backed `CitationOut` target?
- Which `CitationTargetType` does it expose?
- Can this resource be a generated-output citation source?

`resource_graph.citations` remains the citation writer and read-model producer.
`resource_graph.policy` remains the edge-shape validator. Capability policy
answers whether a resource scheme is eligible; graph policy answers whether a
specific edge shape is legal.

### Connections

`resource_graph.connections` remains the hydrated connection read owner.

It consumes:

- route builder from resource capabilities;
- expansion policy from resource capabilities;
- graph edge reads from resource graph;
- hydration from resolver.

It must not keep a private href builder or private owner-rollup policy.

### Adjacency And Synapse

Adjacency source/target decisions are resource capabilities.

Edge origins, edge kinds, synapse rationale rules, panel origin filters, and
write-shape validation remain graph policy. Frontend scannable resource types
consume the generated capability manifest or a graph policy manifest; they do
not keep a local `Set<ObjectType>`.

### Object Refs

Object refs become a transport/view adapter over `ResourceRef`, not a competing
resource vocabulary.

Backend `OBJECT_TYPES = ResourceScheme` is the final contract unless a narrower
type is explicitly justified by a separate product concept. Frontend
`OBJECT_TYPES` must be generated from or parity-tested against backend object
types. Object-ref hydration uses `ResourceItemOut.route` and capability
metadata.

### Frontend Chips

Frontend context chips, connection rows, search rows, note object refs, and
chat resource rows consume:

- strict `ResourceRef` parsing from `resourceGraph/resourceRef.ts`;
- `ResourceItemOut` for resolved per-ref route/capabilities;
- generated static capability manifest for scheme-level affordances;
- frontend-owned icon and display labels that are exhaustive against the
  generated scheme list.

Icons can remain frontend presentation. Product behavior cannot.

### BFF Routes

BFF routes remain proxy-only. They do not parse capability policy, duplicate
scheme lists, or infer routeability. New `/api/*` files must update
`proxy-routes.test.ts` intentionally.

## API Design

### Backend Service API

The public backend service API is module-level functions in
`python/nexus/services/resource_items/capabilities.py` or a narrow public
`resource_items` facade. Callers must not import private route/expansion helper
modules.

Required properties:

- no call site constructs capability dictionaries by hand;
- no call site switches on scheme to answer a capability question when a helper
  exists;
- no helper accepts raw strings after the API boundary has parsed
  `ResourceRef`;
- impossible scheme states fail fast at import/test time.

### HTTP API

The existing `GET /resource-items/{resource_ref}` and
`POST /resource-items/resolve` continue to project per-ref capabilities.

No new runtime manifest endpoint is required. Static per-scheme capability data
is exported through a generated TypeScript manifest. Per-ref runtime data stays
on `ResourceItemOut`, where it can include route, missing state, labels,
summary, capabilities, and version lanes after hydration.

### Schema API

`ResourceItemCapabilitiesOut` is expanded to include the new nested route,
search, citation, visibility, resolver, inspect, and expansion fields.

Old scalar fields are removed only when all consumers have moved. They are not
kept as compatibility aliases. During the hard cutover branch, tests may be
updated in one commit to the new shape; production code must not support both
shapes.

### TypeScript API

The frontend gets a generated equivalent:

- `ResourceScheme`
- `ResourceCapability`
- `ResourceCapabilitiesManifest`
- `resourceCapabilityForScheme(scheme)`
- `resourceCanAttach(scheme)`
- `resourceCanOpen(scheme)`
- `resourceCanSearchScope(scheme)`
- `resourcePromptRenderMode(scheme)`

Frontend components may not hardcode behavior lists that duplicate these
functions.

## Duplicate Patterns To Consolidate

### Backend

- `resource_items.surfaces._route_for_ref`
- `resource_graph.connections._href_for_ref`
- object-ref route generation in `services/object_refs.py`
- owner expansion in `resource_graph.connections._owner_children`
- readable and scope-only checks in `agent_tools/read_resource.py`
- citable result mapping in `context_assembler.py` and `read_resource.py`
- app-search scope checks in `agent_tools/app_search.py`
- app/conversation scope context discovery in `resource_graph/context.py`
- linkability checks in `resource_graph/edges.py`
- adjacency checks in `resource_graph/adjacency.py`
- citation source scheme checks in `resource_graph/policy.py`
- media-only inspect policy in `agent_tools/inspect_resource.py`

### Frontend

- `apps/web/src/lib/objectRefs.ts` `OBJECT_TYPES`
- `apps/web/src/lib/resources/resourceKind.ts`
  `RESOURCE_SCHEME_OBJECT_TYPES`
- `apps/web/src/lib/search/parseSearchInput.ts` scope regex
- `apps/web/src/lib/search/types.ts` result type literals, if not generated from
  search owners
- `apps/web/src/lib/search/kinds.ts` search kind mirrors, if not generated from
  search owners
- `apps/web/src/lib/api/sse/citations.ts` citation result type literals
- `apps/web/src/components/connections/ConnectionsSurface.tsx`
  scannable/panel policy sets
- any resource chip logic that opens via object refs instead of
  `ResourceItemOut.route`

## Files In Scope

### Backend Core

- `python/nexus/services/resource_items/capabilities.py`
- `python/nexus/schemas/resource_items.py`
- `python/nexus/services/resource_items/surfaces.py`
- `python/nexus/api/routes/resource_items.py`
- `python/nexus/services/resource_graph/refs.py`
- `python/nexus/services/resource_graph/resolve.py`

### Backend Consumers

- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/services/agent_tools/inspect_resource.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/resource_items/chat_subjects.py`
- `python/nexus/services/resource_graph/context.py`
- `python/nexus/services/resource_graph/connections.py`
- `python/nexus/services/resource_graph/policy.py`
- `python/nexus/services/resource_graph/edges.py`
- `python/nexus/services/resource_graph/adjacency.py`
- `python/nexus/services/object_refs.py`
- `python/nexus/services/search/scope.py`
- `python/nexus/services/search/kinds.py`
- `python/nexus/schemas/search.py`
- `python/nexus/schemas/citation.py`
- `python/nexus/schemas/retrieval.py`

### Frontend

- `apps/web/src/lib/resourceGraph/resourceRef.ts`
- `apps/web/src/lib/resourceGraph/contractParity.test.ts`
- `apps/web/src/lib/resources/resourceKind.ts`
- `apps/web/src/lib/objectRefs.ts`
- `apps/web/src/lib/notes/api.ts`
- `apps/web/src/lib/search/types.ts`
- `apps/web/src/lib/search/kinds.ts`
- `apps/web/src/lib/search/parseSearchInput.ts`
- `apps/web/src/lib/search/normalizeSearchResult.ts`
- `apps/web/src/lib/api/sse/citations.ts`
- `apps/web/src/lib/conversations/citationOut.ts`
- `apps/web/src/components/chat/ConversationContextRefsSurface.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/ResourceChatDetail.tsx`
- `apps/web/src/components/connections/ConnectionsSurface.tsx`
- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/app/api/proxy-routes.test.ts`

### Tests

- `python/tests/test_resource_item_capabilities.py`
- `python/tests/test_read_resource_tool.py`
- `python/tests/test_inspect_resource_tool.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search_scope_matrix.py`
- `python/tests/test_resource_graph_policy.py`
- `python/tests/test_resource_graph_connections.py`
- `python/tests/test_resource_graph_refs.py`
- `python/tests/test_message_citation_contracts.py`
- `python/tests/test_retrieval_schema_contracts.py`
- `python/tests/test_cutover_negative_gates.py`
- `apps/web/src/lib/resourceGraph/contractParity.test.ts`
- `apps/web/src/lib/resources/resourceKind.test.ts`
- `apps/web/src/lib/search/normalizeSearchResult.test.ts`
- `apps/web/src/lib/search/searchApi.test.ts`
- `apps/web/src/lib/conversations/citationOut.test.ts`
- `apps/web/src/lib/conversations/chatRunBody.test.ts`

## Implementation Plan

### Phase 1: Contract And Manifest

1. Expand `ResourceItemCapability` into typed nested policies.
2. Add capability helper functions.
3. Add manifest schema to `schemas/resource_items.py`.
4. Add a generated TypeScript projection and a test that fails when it drifts
   from the backend manifest.
5. Add parity tests for manifest shape and complete scheme coverage.
6. Update `test_resource_item_capabilities.py` to pin policy invariants rather
   than only current tuples.

### Phase 2: Route Authority

1. Move `_route_for_ref` into the resource capability service.
2. Replace `connections._href_for_ref` with the shared route builder.
3. Replace object-ref hydration route generation with the shared route builder.
4. Update frontend context/opening surfaces to prefer `ResourceItemOut.route`.
5. Add a negative gate banning new private route builders for `ResourceRef`.

### Phase 3: Read, Inspect, Prompt, Citation

1. Move readable/scope-only/citable lookup behind named policy helpers.
2. Update `read_resource` admission to call read policy helpers.
3. Update `_present_read` to receive citation policy rather than lookup maps.
4. Add inspect policy and update `inspect_resource`.
5. Update `context_assembler` to call prompt and citation policy helpers.
6. Split prompt-numbered result policy from graph-backed `CitationOut` target
   policy.
7. Update citation tests for prompt numbering versus graph citation output.

### Phase 4: Search Scope And Result Bridge

1. Replace app-search scheme tuple imports with `resource_search_scope_policy`.
2. Keep `services/search/scope.py` as SQL owner.
3. Add a search-owned manifest or parity guard for result types, search kinds,
   media formats, locator compatibility, and frontend search values.
4. Remove frontend hardcoded scope regex and consume generated scope vocabulary.
5. Add negative tests that graph edges do not widen search without explicit
   scope policy.

### Phase 5: Expansion And Connections

1. Promote owner rollup from `connections._owner_children` to named expansion
   policy.
2. Implement `expand_owned_child_refs` in the capability service or a private
   helper exposed only through the service.
3. Update connections and reader-sidecar consumers.
4. Keep graph edge query ownership in `resource_graph.connections`.
5. Add tests for media children, page note blocks, note-owned evidence, and LI
   artifact revisions.

### Phase 6: Frontend Projection Cutover

1. Generate or fetch the resource capability manifest.
2. Replace frontend object type subsets and scheme-to-object-ref behavior maps.
3. Keep icons and small display labels frontend-owned, but exhaustively keyed by
   generated schemes.
4. Update chips, context refs, connection rows, note object refs, and chat rows
   to use route/capabilities.
5. Add frontend tests for capability parsing and behavior.

### Phase 7: Negative Gates And Cleanup

1. Delete old constants or make them private derived implementation details.
2. Add negative gates for banned local lists and duplicate route helpers.
3. Delete stale docs wording that says contributor is an app-search target if
   live policy remains media/library.
4. Ensure no production code imports private helper modules or raw policy maps
   outside allowed owner modules.

## Acceptance Criteria

AC1. Every `ResourceScheme` has exactly one capability row.

AC2. Importing the backend fails if capability keys and `RESOURCE_SCHEMES`
diverge.

AC3. The capability contract includes explicit visibility, resolvability,
route, link, attach, chat subject, read, inspect, citation, search, prompt,
expansion, and adjacency decisions.

AC4. Runtime visibility is resolved only through `resource_graph.resolve`.

AC5. No caller treats static capability as proof that a specific ref is visible.

AC6. `ResourceItemOut.capabilities` exposes the final capability shape.

AC7. `ResourceItemOut.route` is the canonical open route for resolved resource
items.

AC8. There is one backend `route_for_ref` owner.

AC9. `resource_graph.connections` does not define a private href builder.

AC10. `object_refs` does not define route policy independently.

AC11. Frontend resource chips open through resolved route data or a generated
capability projection, not object-ref special cases.

AC12. `read_resource` does not import readable/scope-only raw lists from outside
the capability service.

AC13. `read_resource` keeps parent-media read admission separate from search
scope.

AC14. `read_resource` errors for scope-only and non-readable resources are
driven by read policy.

AC15. `_present_read` does not own citable result type mapping.

AC16. `inspect_resource` uses inspect policy and remains media-only unless the
registry explicitly changes.

AC17. Attached context creation uses `resource_can_attach`.

AC18. Prompt rendering uses `resource_prompt_render_policy`.

AC19. Attached numbered citation materialization uses
`resource_citation_policy`.

AC20. `app_search` explicit scope validation uses resource search-scope policy.

AC21. `app_search` does not query `resource_edges` directly.

AC22. `services/search/scope.py` remains the only `scope -> SQL` owner.

AC23. Search result type taxonomy is generated from or parity-tested against
backend search schemas.

AC24. Frontend search result type literals cannot drift from backend schemas.

AC25. Frontend search scope parsing cannot drift from backend scope vocabulary.

AC26. Citation policy distinguishes prompt numbering, search result
materialization, graph citation target eligibility, citation target type, and
citation output source.

AC27. `resource_graph.policy` still owns edge-shape legality.

AC28. `resource_graph.citations` still owns citation writes and `CitationOut`.

AC29. `CitationOut` target types are generated from or parity-tested against
backend citation schemas.

AC30. Connection owner expansion is declared by capability expansion policy.

AC31. Connection owner expansion does not widen search scope.

AC32. Media owner expansion includes the intended reader children only.

AC33. Page owner expansion includes page note blocks only.

AC34. Note-block owner expansion includes note-owned evidence only.

AC35. LI artifact owner expansion includes artifact revisions only.

AC36. Adjacency source/target checks use resource capability helpers.

AC37. Synapse edge shape and origin policy remain graph-owned.

AC38. Frontend `OBJECT_TYPES` is generated from or parity-tested against backend
object types, or deleted in favor of `ResourceScheme`.

AC39. Frontend resource icon maps are exhaustive against generated schemes.

AC40. Frontend object/openability maps are not handwritten product policy.

AC41. BFF routes remain proxy-only.

AC42. New `/api/*` routes update the explicit proxy-route guard.

AC43. No old capability names are kept as public compatibility aliases.

AC44. No production code has private `_READABLE_SCHEMES`,
`_CITABLE_RESULT_TYPE`, `APP_SEARCH_SCOPE_TARGET_SCHEMES`, private route maps,
or private object-type subsets for resource behavior.

AC45. Negative gates fail on duplicate resource route builders.

AC46. Negative gates fail on local capability lists outside allowed owner files.

AC47. Tests prove external snapshots and Oracle corpus passages remain
non-attachable/non-linkable unless explicit policy changes.

AC48. Tests prove `library` remains app-search scope but not readable body.

AC49. Tests prove generated-output resources are readable/prompt-renderable but
not automatically source-evidence targets.

AC50. Docs describe the final capability registry as current architecture, not
as a future migration bridge.

## Non-Goals

N1. No graph database.

N2. No new persisted resource table.

N3. No new persisted capability table. The registry is code-owned policy unless
there is a later need for user-editable configuration.

N4. No runtime feature flag for old versus new capability behavior.

N5. No compatibility aliases for old request or response shapes.

N6. No generic graph traversal for search.

N7. No frontend-only capability vocabulary.

N8. No search-ranking rewrite.

N9. No attempt to make all resource schemes searchable.

N10. No attempt to make all resource schemes citable.

N11. No object-ref product redesign beyond collapsing duplicated resource
policy.

N12. No citation storage redesign beyond policy alignment.

N13. No permissions rewrite beyond clarifying resolver ownership.

N14. No migration of historical telemetry rows except where tests or schemas
require stale vocabulary deletion.

## Key Decisions

D1. `ResourceRef` remains the identity contract. Capabilities never define a
second identity vocabulary.

D2. `resource_items.capabilities` is the capability owner. The service may use
private helper modules, but callers see one public capability API.

D3. Visibility is runtime, not a static boolean.

D4. Resolvability is static support; resolution is runtime.

D5. Routeability is a capability; route construction is a backend service.

D6. Linkability, attachability, readability, searchability, citability, and
prompt renderability are separate decisions.

D7. `library` being a search scope does not make it a readable body.

D8. Parent-media read admission does not make child refs app-search scopes.

D9. Prompt-numbered citations are not automatically graph-backed citations.

D10. Generated-output citation sources are distinct from evidence citation
targets.

D11. Expansion policy is a named product projection, not graph traversal.

D12. Search owns search result taxonomy and SQL.

D13. Resource capabilities may reference search result types but do not own
search ranking, SQL, aliases, or filters.

D14. Graph policy owns edge shapes.

D15. Frontend display affordances can remain local only when they are
presentation, exhaustive, and parity-tested.

D16. Object refs are an adapter over resource identity, not a policy authority.

D17. Hard cutover means deleting old paths, not wrapping them.

## Verification Plan

Backend focused:

```bash
cd python
NEXUS_ENV=test uv run pytest -q \
  tests/test_resource_item_capabilities.py \
  tests/test_resource_chat_subjects.py \
  tests/test_read_resource_tool.py \
  tests/test_inspect_resource_tool.py \
  tests/test_agent_app_search.py \
  tests/test_search_scope_matrix.py \
  tests/test_resource_graph_policy.py \
  tests/test_resource_graph_connections.py \
  tests/test_resource_graph_refs.py \
  tests/test_message_citation_contracts.py \
  tests/test_retrieval_schema_contracts.py \
  tests/test_cutover_negative_gates.py
```

Frontend focused:

```bash
cd apps/web
bun run typecheck
bunx vitest run --project unit \
  src/app/api/proxy-routes.test.ts \
  src/lib/resourceGraph/contractParity.test.ts \
  src/lib/resourceGraph/resourceRef.test.ts \
  src/lib/resources/resourceKind.test.ts \
  src/lib/search/normalizeSearchResult.test.ts \
  src/lib/search/searchApi.test.ts \
  src/lib/conversations/citationOut.test.ts \
  src/lib/api/sse/events.test.ts \
  src/lib/conversations/chatRunBody.test.ts
```

Browser focused if chips, resource chat, or connection rows change:

```bash
cd apps/web
bunx vitest run --project browser src/__tests__/components/ResourceChatDetail.test.tsx
```

Broad repo gates after implementation:

```bash
make test-back-unit
make test-back-integration
make test-front-unit
make test-front-browser
```

## Final State

The final codebase has one obvious answer to each question:

- What schemes exist? `resource_graph.refs`.
- Is this specific ref visible? `resource_graph.resolve`.
- What can this scheme do? `resource_items.capabilities`.
- How do I open this resource? `resource_items` route policy.
- Can I attach it? `resource_items` attach policy.
- Can I read it? `resource_items` read policy plus `read_resource`
  presentation.
- Can I inspect it? `resource_items` inspect policy plus inspect-resource
  presentation.
- Can I search within it? `resource_items` search-scope policy plus
  `services/search/scope.py`.
- Can I cite it? `resource_items` citation policy plus graph citation policy.
- What edges are legal? `resource_graph.policy`.
- What connections exist? `resource_graph.connections`.
- What should the frontend chip do? `ResourceItemOut.route` and the generated
  capability manifest.

No feature-local list gets to answer those questions independently.

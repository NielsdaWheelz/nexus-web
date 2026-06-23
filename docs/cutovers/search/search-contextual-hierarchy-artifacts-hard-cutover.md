# Search Contextual Hierarchy Artifacts Hard Cutover

**Status:** First source-map retrieval slice implemented - 2026-06-21

**Build note (2026-06-21).** The first hard-cut retrieval slice now has:
`source_map.v1` on selected `content_chunk` evidence, graph-owned app-search
scope expansion read models, source-map trust/eval readback, and negative gates
blocking generated guidance from search-result, scope, graph-expansion, and
citation identity. Generated retrieval-artifact storage was intentionally
removed from this slice because no generated-artifact job or owner consumption
contract exists yet.

**Type:** Hard cutover. No generated retrieval artifacts as citations, no
search-result identity by accident, no graph traversal from app search, no
fallback from stale generated guidance to uncited summary evidence.

## One-Line

Add owner-bound contextual and hierarchy retrieval artifacts that improve
candidate generation and routing while keeping final evidence citations tied to
concrete source resources.

## SME Thesis

A subject matter expert would separate three things that often get collapsed:

1. Source-derived guidance: deterministic maps, section paths, hierarchy paths,
   and labels derived from current source index rows.
2. Generated retrieval guidance: summaries, concept tags, cluster labels, and
   hierarchy nodes produced by a model to guide search.
3. Evidence: concrete, citable source resources such as `content_chunk`,
   `evidence_span`, `media`, `page`, `note_block`, `highlight`, `message`, or
   `external_snapshot`.

The gold-standard move is to let generated or hierarchical artifacts guide
retrieval, not launder themselves into evidence. Search can use a generated
summary to find a candidate; the answer must cite the underlying source span,
chunk, media, or note that supports the claim.

## Current State

Implemented:

- `source_map.v1` is deterministic, source-derived, current-index guidance for
  selected `content_chunk` results.
- Source maps expose chunk URI, read URI, evidence URI, context header, section
  path, part count, owner, and a source revision hash.
- Source maps do not become citation targets.
- Resource graph exposes typed app-search scope expansion read models.
- Generated retrieval artifacts are blocked from app-search scope, search-result
  identity, graph expansion seeding, and citation identity by negative gates.

Gap:

- There are no generated contextual chunk headers or summaries.
- There is no durable generated-artifact table or owner service in this slice.
- A real generated-artifact job is not yet triggered outside the content-index
  transaction.
- App-search generated-guidance metadata is present only as an explicit
  disabled/unused ledger shape.
- Eval replay does not yet measure true with-guidance versus without-guidance
  behavior or stale/invalid/missing-target fixtures.

Hardened after audit:

- The speculative `retrieval_artifacts` schema/service/test surface was removed
  from the first slice.
- Deterministic app-search selection emits no generated-guidance influence trace
  fields until a real generated-guidance owner exists.

## Implemented Goals

1. Preserve `source_map.v1` as deterministic source-derived guidance.
2. Keep final citations on concrete source evidence.
3. Keep app search as a consumer of typed read models, not the artifact owner.

## Future Generated-Artifact Goals

1. Add generated contextual and hierarchy artifacts under one explicit owner.
2. Reindex those artifacts deterministically from current source-index inputs.
3. Ledger generated guidance use in search/rerank metadata.
4. Support global, cross-document, multi-hop, absence, and "what themes recur?"
   queries better than flat chunk retrieval alone.
5. Make stale/failed/generated guidance visible to evals and trust trails.

## Non-Goals

- No generated summary citation targets in this cutover.
- No new app-search scopes for `source_map`, `context_summary`,
  `section_summary`, `document_summary`, `hierarchy_node`, or concept nodes.
- No direct `resource_edges` SQL from app search.
- No replacement of hybrid search, deterministic selection, or exact read.
- No user-facing generated artifact UI unless a separate product surface is
  explicitly included.
- No parent-revision DAG, branch graph, CRDT, or merge model.
- No source-version replay guarantee. Current-only source evidence remains the
  rule; generated guidance tracks the current index.

## Artifact Classes

### Source-Derived Current Guidance

Owned by content indexing.

Examples:

- source map;
- section path;
- hierarchy path;
- parent/child chunk ids;
- locator-derived page/time/section bucket;
- deterministic context header.

Properties:

- current-only;
- derived without model generation;
- re-created by content reindex;
- no `ResourceRef`;
- no citation identity;
- no app-search scope identity;
- safe to expose in selected-result tool output as guidance.

### Generated Retrieval Guidance

Owned by a generated retrieval artifact service.

Examples:

- chunk contextual header generated from whole-document context;
- section summary;
- document summary for retrieval;
- concept/entity tags;
- cluster summary;
- local/global hierarchy node;
- contradiction/disagreement guide.

Properties:

- generated output is untrusted until accepted by the owner;
- carries source coverage and source revision;
- guides retrieval only;
- not citable in the first cutover;
- fails closed when stale, missing, or invalid.

### Evidence

Owned by existing source/citation systems.

Examples:

- `content_chunk`;
- `evidence_span`;
- `fragment`;
- `media`;
- `page`;
- `note_block`;
- `highlight`;
- `message`;
- `external_snapshot`.

Properties:

- can become citation targets only through existing capability policy and graph
  citation owners;
- final answers cite these resources, not generated guidance.

## Future Target Behavior

After a generated retrieval-artifact owner exists and is wired into search:

- contextual headers and hierarchy artifacts are built from the current ready
  content index;
- artifacts record exactly which source chunks/blocks/media they covered;
- app search can use artifact text or tags during candidate generation;
- rerank ledgers record which guidance artifacts affected candidate ordering;
- selected tool output may include compact guidance IDs and labels;
- generated artifact text is never presented as cited evidence;
- if an artifact is stale or failed, search ignores it and ledgers that it was
  unavailable;
- read/inspect still fetch concrete source evidence.

For global/library questions:

- graph/context expansion chooses likely source scopes;
- hierarchy guidance can suggest source clusters;
- search still retrieves concrete chunks/spans from those sources;
- final selected evidence remains citable source material.

For exact lookup:

- hierarchy guidance is low priority or unused;
- lexical/semantic exact candidates remain primary.

## Architecture

```text
content_indexing
  -> current source blocks/chunks/spans
  -> source_map.v1 and deterministic hierarchy paths

generated retrieval artifact owner
  -> generated context headers / summaries / tags / hierarchy nodes
  -> accepted guidance read model with source revisions

search
  -> hybrid candidate generation over concrete evidence
  -> future optional guidance signals from artifact read models
  -> deterministic/learned selection
  -> ledgers guidance use when real guidance exists

chat app_search
  -> consumes search results and disabled guidance metadata
  -> persists retrieval/rerank ledgers
  -> never cites guidance artifacts
```

## Data Model

First durable generated-artifact shape:

```text
retrieval_artifacts
  id
  owner_kind
  owner_id
  artifact_kind
  current_revision_id
  status
  created_at
  updated_at

retrieval_artifact_revisions
  id
  artifact_id
  status
  source_revision
  covered_targets
  payload
  generator
  generator_version
  error_code
  error_detail
  created_at
  promoted_at
```

Rules:

- `artifact_kind` is a closed vocabulary.
- `source_revision` is deterministic from current content-index rows and
  covered targets.
- `covered_targets` is an array of concrete source refs or chunk refs.
- `payload` is a tightly validated object per artifact kind.
- A ready revision must have a complete payload and source revision.
- A failed revision cannot be promoted.
- Promotion changes `current_revision_id`; it does not rewrite historical
  revision payloads.

Do not add this schema if the first implementation only extends source-derived
`source_map.v1`. Add it when generated text is persisted and reused.

## ResourceRef Decision

First slice default: generated retrieval artifacts are not `ResourceRef`s.

They are internal retrieval guidance. They do not need routeability,
attachability, search scope identity, read-resource support, or citation
identity.

If a later product makes generated hierarchy artifacts user-openable, that must
be its own hard cutover:

- add a concrete `ResourceRef` scheme;
- update backend/frontend parsers;
- add resource capabilities;
- keep `app_search_scope = false`;
- keep `citable_result_type = None` unless a separate generated-output citation
  product is explicitly designed;
- add reader/chat/open routes and tests.

## Capability Contract

Future generated retrieval guidance can be:

- built by its owner;
- read by search as guidance;
- recorded in rerank metadata;
- counted in eval reports;
- displayed in trust trail as retrieval guidance.

Generated retrieval guidance cannot be:

- an app-search scope;
- a conversation-search scope;
- a graph expansion seed;
- a `SearchResultOut` result type;
- a `RetrievalCitation.citation_target`;
- a `read_resource` URI;
- a citation edge target;
- a substitute for concrete source evidence.

## Search Integration

Future search integration consumes a typed read model such as:

```json
{
  "version": "retrieval_guidance.v1",
  "artifact_kind": "section_summary",
  "revision_id": "uuid",
  "source_revision": "sha256:...",
  "covered_targets": ["content_chunk:...", "evidence_span:..."],
  "label": "Attention and agency",
  "terms": ["attention", "agency", "control"],
  "summary": "Short generated guidance text",
  "target_uris": ["content_chunk:..."]
}
```

Search may use this to:

- expand query terms;
- select scopes/clusters;
- boost concrete candidates;
- diversify across clusters;
- explain a rerank movement.

Search must not return this object as the result. Search returns the concrete
candidate it helped find.

## Graph And Hierarchy

Graph/hierarchy use is query-class dependent:

- high value: global, cross-document, absence, multi-hop, disagreement,
  "what should I read next?";
- medium value: scoped synthesis within one long source;
- low value: exact lookup, title/person/date/identifier search.

The graph owner exposes scope expansion and relationship read models. The
generated retrieval artifact owner exposes hierarchy guidance. `app_search`
consumes neither table directly.

## Generation Contract

Generated guidance is model output, so it is untrusted until accepted.

Acceptance validates:

- schema shape;
- artifact kind;
- source target refs;
- source revision match;
- payload size;
- no citation target fields;
- no unsupported resource schemes;
- no hidden tool instructions or prompt injection markers in fields that will be
  sent back to a model.

The generation prompt should ask for compact guidance, not prose for end-user
answers.

## Evaluation Contract

Add eval metrics before using generated guidance by default:

- candidate recall with and without guidance;
- selected-pack recall with and without guidance;
- hard-negative rate introduced by guidance;
- citation precision after guided retrieval;
- stale-guidance skip rate;
- generation cost;
- indexing latency;
- coverage by owner/kind.

Fixtures:

- exact lookup that must not be hurt by guidance;
- cross-document theme query;
- global library question;
- absence query;
- multi-hop question;
- long source section question;
- generated guidance stale after reindex;
- generated guidance invalid payload;
- generated guidance points to missing target.

## Implemented Acceptance Criteria

- Source-derived guidance remains deterministic and current-only.
- App search carries source-map readback only through search-owned read models.
- Rerank metadata records selected source-map presence without creating citation
  identity.
- No generated guidance artifact is an app-search scope, search result type, or
  citation target.
- Final answer citations remain concrete source resources.

## Future Generated-Artifact Acceptance Criteria

- Generated guidance has one owner and one durable shape.
- Ready generated revisions have source revision, covered targets, and validated
  payloads.
- Stale generated guidance is ignored and ledgered as stale.
- Eval reports compare retrieval with and without guidance.

## Negative Gates

- Generated retrieval artifact schemes are not present in `SEARCH_RESULT_TYPES`.
- Generated retrieval artifact schemes are not app-search scopes.
- Generated retrieval artifact schemes are not conversation-search scopes.
- Generated retrieval artifact schemes cannot seed app-search graph expansion.
- Generated retrieval artifact payloads do not contain `citation_target`.
- `app_search` does not import generated artifact tables directly.
- Trust trail labels generated guidance as guidance, not evidence.

## API Design

No public API in the first retrieval-only slice.

Internal implemented API:

```python
load_content_chunk_source_map(
    db, *, viewer_id: UUID, chunk_id: UUID, evidence_span_id: UUID | None = None
) -> dict[str, object] | None
```

If a later UI is added, use owner routes rather than `app_search` routes. Do not
add a generic `/retrieval-artifacts` public API until there is a product surface
that needs it.

## Files

Likely backend files:

- `python/nexus/services/content_indexing.py`
- `python/nexus/services/search/*`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/resource_items/capabilities.py`
- `python/nexus/services/resource_graph/context.py`
- `python/nexus/services/retrieval_artifacts.py` if generated persistence is
  added
- `python/nexus/db/models.py`
- one Alembic migration if generated persistence is added

Likely tests:

- `python/tests/test_content_indexing.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search_retrieval_evals.py`
- `python/tests/test_resource_item_capabilities.py`
- `python/tests/test_resource_graph_context.py`
- `python/tests/test_cutover_negative_gates.py`

## Composition With Other Systems

- Run-level planner may choose routes that make hierarchy guidance useful, but
  does not load artifacts.
- Source-boundary policy treats generated retrieval guidance as private app
  metadata.
- Learned reranker may use guidance features, but must ledger that use.
- Library Intelligence remains the precedent for durable generated user-visible
  revisions; do not copy its UI/API unless retrieval artifacts become a product
  surface.

## Research Notes

Anthropic's Contextual Retrieval writeup reports gains from prepending
chunk-specific context before embedding/BM25 indexing and further gains from
reranking: `https://www.anthropic.com/engineering/contextual-retrieval`.

Microsoft GraphRAG's public docs distinguish indexing and query modes such as
global, local, and DRIFT search, which maps to the Nexus rule that hierarchy
helps global/multi-hop questions more than exact lookup:
`https://microsoft.github.io/graphrag/`.

## Verification

Focused first implementation gates:

```bash
./scripts/with_test_services.sh bash -lc 'make _test-back-db-ready >/dev/null && cd python && NEXUS_ENV=test uv run pytest -q tests/test_content_indexing.py tests/test_search_retrieval_evals.py'
./scripts/with_test_services.sh bash -lc 'make _test-back-db-ready >/dev/null && cd python && NEXUS_ENV=test uv run pytest -q tests/test_agent_app_search.py tests/test_resource_graph_context.py tests/test_resource_item_capabilities.py tests/test_cutover_negative_gates.py'
```

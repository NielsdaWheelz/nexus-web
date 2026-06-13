# Library Intelligence Revision Resource Identity Hard Cutover

Status: BUILT - hard cutover implemented
Author: Codex
Type: hard cutover
Date: 2026-06-12

## North Star

Library Intelligence has two distinct product identities:

1. `library_intelligence_artifact:<artifact_id>` is the mutable latest/head artifact for a library.
2. `library_intelligence_revision:<revision_id>` is an immutable generated artifact version.

All durable links, backlinks, citations, conversation context refs, and resource reads that mean "this exact Library Intelligence output" must point at the revision resource. The artifact resource remains useful only as the current-head entrypoint.

## SME Thesis

The pre-cutover system had immutable artifact revisions, but keyed citation edges on the mutable artifact head. That made graph identity contradict content identity: historical pages existed, but their backlinks were overwritten when the head changed. The professional fix was not a timestamp column, a fallback resolver, or an LI-private citation table. The fix was to promote the revision to a first-class `ResourceRef` and let the existing resource graph own all durable relationships.

This is the same architectural rule the rest of Nexus is converging on:

- provenance and citations are graph edges;
- resource identity must be stable enough to dereference later;
- mutable aliases are allowed, but only when the caller deliberately asked for "latest";
- attached resources that enter agent context must record the immutable resource actually consumed.

## Pre-Cutover State

At the start of this cutover, the repo already had the hard part of version storage:

- `library_intelligence_artifacts` stores one artifact head per library.
- `library_intelligence_artifact_revisions` stores immutable generated revisions.
- `library_intelligence_artifacts.current_revision_id` points at the current revision.
- generation creates a pending revision and promotion points the head at a ready revision.

The graph contract was the weak point:

- `python/nexus/db/models.py` only allows `library_intelligence_artifact` in resource-edge scheme checks.
- `python/nexus/services/resource_graph/refs.py` and `apps/web/src/lib/resourceGraph/resourceRef.ts` only know `library_intelligence_artifact`.
- `python/nexus/services/library_intelligence.py:get_artifact` builds citation rows with source `library_intelligence_artifact:<artifact_id>`.
- `python/nexus/services/library_intelligence.py:promote_revision` replaces citations for `library_intelligence_artifact:<artifact_id>` and explicitly clears citations when restoring a prior revision.
- `python/nexus/services/library_intelligence_reduce.py:_promote_built_revision` writes citations to `library_intelligence_artifact:<artifact_id>`.
- `python/nexus/services/resource_graph/resolve.py` resolves `library_intelligence_artifact:<artifact_id>` by joining to `current_revision_id`, so historical identity is impossible through that ref.
- `python/nexus/services/context_assembler.py` has comments that LI artifacts intentionally use fresh head content and do not pin a revision.
- `docs/cutovers/incoming-connections-reader-sidecar-hard-cutover.md` documented LI citations as current-head-only and said revision-level backlinks were out of scope.

That was the product constraint this cutover reversed.

## Goals

1. Add `library_intelligence_revision:<revision_id>` as a first-class backend and frontend `ResourceRef`.
2. Store Library Intelligence citation edges with source `library_intelligence_revision:<revision_id>`.
3. Preserve historical links and backlinks across new generations, promotions, restores, and head movement.
4. Keep `library_intelligence_artifact:<artifact_id>` as the latest/head alias only.
5. Make the Library Intelligence pane able to show and link to exact historical revisions.
6. Make chat and agent context pin the current revision by default instead of attaching the moving artifact head.
7. Reuse the existing resource graph, citation, resolver, read-resource, and connection machinery.
8. Delete the current restore behavior that clears citations.
9. Add tests that prevent head-keyed LI citations from returning.

## Non-Goals

1. No backward compatibility for old `library_intelligence_artifact` citation edges.
2. No dual-write from revision refs to artifact refs.
3. No fallback resolver from artifact refs to historical revisions.
4. No resurrection of an LI-private `library_intelligence_citations` table.
5. No `parent_revision_id`, revision DAG, branch, merge, diff, or CRDT model.
6. No source-version replay guarantee for old evidence targets. A revision preserves the citations it emitted; it does not freeze every cited source document.
7. No attempt to migrate historical edges that were already overwritten by head-keyed replacement.
8. No new graph API parallel to `resource_edges`.
9. No silent acceptance of unknown schemes in backend or frontend parsers.

## Capability Contract

### Resource Identity

`library_intelligence_artifact:<artifact_id>`

- Mutable latest artifact for a library.
- Resolves to the current ready revision's body.
- Suitable for "open the latest intelligence for this library."
- Suitable for durable links only when the link deliberately means "latest/head
  intelligence for this library."
- Not suitable for exact generated-output backlinks, default agent grounding, or
  historical references.

`library_intelligence_revision:<revision_id>`

- Immutable generated revision.
- Resolves to the exact revision body.
- Owns the citation edges emitted by that revision.
- Suitable for backlinks, chat context, read-resource, copied links, history views, and external references.

### Edge Ownership

For a generated revision with evidence citations:

- source: `library_intelligence_revision:<revision_id>`
- origin: `citation`
- kind: the existing citation stance from `CitationInput`, not a product relation verb
- targets: supported citation target `ResourceRef`s such as `library`, `media`, `page`, `note_block`, `evidence_span`, or `content_chunk`
- snapshot: existing citation display/replay snapshot from `replace_citations_for_output`
- ordinals: stable within the revision, starting at `1`

There must be no generated citation write whose source is `library_intelligence_artifact:<artifact_id>`.

### Head Movement

Promotion means:

1. validate the target revision is ready;
2. point `library_intelligence_artifacts.current_revision_id` at it;
3. update artifact head metadata;
4. do not rewrite, delete, or synthesize citation edges.

Restore is the same operation as promotion. Restoring an older revision cannot clear citations, because citations belong to the revision.

## Target Behavior

### Current Artifact View

Opening a library's intelligence pane shows the current artifact head. The returned payload includes both identities:

- `artifact_ref = library_intelligence_artifact:<artifact_id>`
- `revision_ref = library_intelligence_revision:<current_revision_id>`

The displayed citations come from the current revision source ref. The user experience remains "current intelligence for this library," but graph operations know which immutable revision supplied the content.

### Revision History View

Revision history rows expose `revision_ref`. Opening a historical revision loads the exact revision body, created/promoted timestamps, status, current marker, and citation edges for that revision.

Links from the history view use the revision ref, not the artifact ref. If the head moves after the link is copied, the link still opens the same revision.

### Backlinks

Incoming and outgoing connections support exact revision refs.

- Querying `library_intelligence_revision:<revision_id>` returns links to and from that exact revision.
- Querying `library_intelligence_artifact:<artifact_id>` returns only links whose
  product meaning is "latest/head intelligence for this library."
- Querying artifact-owner rollup may include all revision children when the caller explicitly asks for owner rollup.

The UI must label revision-sourced edges as historical when they are not from the current revision.

### Chat Context

Starting chat from the Library Intelligence pane attaches:

- `library_intelligence_revision:<current_revision_id>`
- `library:<library_id>` when the library itself is also useful scope

It does not attach the moving artifact head by default.

If a caller deliberately attaches `library_intelligence_artifact:<artifact_id>`,
context assembly treats it as a latest/head resource and resolves the current
revision before prompt assembly. The consumed revision ref is recorded in
prompt/retrieval assembly metadata or transcript-facing resource metadata, not
as a second graph edge and not as a replacement for revision pinning. That path
exists for explicit latest workflows, not as a substitute for revision pinning.

### Read Resource Tool

`read_resource(library_intelligence_revision:<revision_id>)` returns the exact revision body and metadata. `read_resource(library_intelligence_artifact:<artifact_id>)` returns the current head body and includes the resolved `revision_ref`.

Both keep the current LI rule that inline `[N]` citations inside the generated markdown are internal evidence markers and should not be advertised as user-citable source documents by the tool.

### Deletion

Deleting a library or LI artifact removes graph edges for:

- the artifact head ref;
- every revision ref owned by the artifact.

Cleanup is explicit. It must not depend on a broad string prefix delete.

## Architecture

### Relationship To Resource Graph Product Spine

This spec is a vertical Library Intelligence cutover that composes with `docs/cutovers/resource-graph-product-spine-hard-cutover.md`. It does not replace or fork the spine spec.

Owned here:

- add `library_intelligence_revision` as the immutable LI output resource;
- move LI citation source identity from artifact head to revision;
- expose revision detail/read/resolve/chat behavior;
- update LI pane and history behavior;
- remove LI restore citation clearing.

Owned by the product spine:

- `resource_edges` remains the only durable positive connection table;
- `origin` remains writer/invariant owner;
- `kind` remains stance only;
- citation edges keep `origin='citation'`, ordinal, and snapshot semantics;
- graph shape validation belongs in `resource_graph.policy` when that cutover lands;
- frontend/backend vocabulary parity and migration/model check parity are tested at the graph layer;
- search scope stays explicit and default-deny for ordinal citations.

This LI cutover adds a ResourceRef scheme and an output-resource source shape for existing citation edges. It does not add a new `EdgeOrigin`, `EdgeKind`, relation predicate, search traversal rule, public graph endpoint, or graph policy registry.

### Repo Precedents To Preserve

This cutover is not introducing a new style of versioning or citation storage. It is aligning the current code with existing repo contracts:

- `resource_graph.refs` says ResourceRef grammar is the single persisted resource-identity vocabulary and parsing is strict.
- `resource_graph.resolve` says per-scheme loading and presentation should exist exactly once and is shared by prompt assembly and `read_resource`.
- `resource_graph.citations` is already the shared citation read model for chat, Oracle, and Library Intelligence.
- `resource_edges` is already the post-cutover owner of citations and context refs.
- the Library Intelligence head/revision model already treats `library_intelligence_artifact_revisions` as immutable generated snapshots.
- the older AI-native Library Intelligence consolidation spec already chose stable head plus immutable revisions; this cutover makes the implementation match that product intent for graph identity.

### Data Model

No new Library Intelligence content table is needed. The existing split is correct:

- `library_intelligence_artifacts`: mutable head and library-level identity;
- `library_intelligence_artifact_revisions`: immutable generated versions;
- `resource_edges`: all links, citations, and backlinks.

The required migration is scheme vocabulary, not content storage:

- add `library_intelligence_revision` to `resource_edges.source_scheme`;
- add `library_intelligence_revision` to `resource_edges.target_scheme`;
- add it only to other closed ResourceRef scheme checks whose owner
  semantically accepts generic graph-addressable refs.
- do not widen synapse suppression, context, or other auxiliary scheme checks by
  default. If such a table intentionally accepts LI revision refs, document that
  owner decision in the migration and service tests.

The ORM model checks in `python/nexus/db/models.py` must match the migration exactly.

If the product-spine `resource_graph.policy` module lands before or during this work, update the existing `citation` origin policy so ordinal citations allow `library_intelligence_revision` as an output source. Do not add an LI-specific policy registry.

### ResourceRef Layer

Backend:

- add `library_intelligence_revision` to `ResourceScheme` in `python/nexus/services/resource_graph/refs.py`;
- keep parser strict;
- add helper construction only if helpers already exist near neighboring refs.

Frontend:

- add `library_intelligence_revision` to `apps/web/src/lib/resourceGraph/resourceRef.ts`;
- add icon/label/kind mapping in the shared resource-kind layer instead of special-casing inside LI UI.

No caller should build or parse these refs with ad hoc string splitting when shared ResourceRef helpers are available.

### Citation Write Path

Generation writes revision citations once:

1. create or update the pending revision;
2. normalize citation targets through existing citation helpers;
3. call `replace_citations_for_output(source=library_intelligence_revision:<revision_id>, citations=...)`;
4. mark the revision ready;
5. promote head by updating `current_revision_id`.

Promotion and restore do not call `replace_citations_for_output`. The only time citation replacement happens is while materializing a specific revision's generated output.

### Citation Read Path

`get_artifact` returns current revision citations by reading graph edges for `library_intelligence_revision:<current_revision_id>`.

`get_revision` returns historical revision citations by reading graph edges for `library_intelligence_revision:<revision_id>`.

Both reuse `build_citation_outs`. The only difference is the source ref.

### Resolver

`python/nexus/services/resource_graph/resolve.py` needs two loaders:

- artifact loader: resolves current head by joining `library_intelligence_artifacts.current_revision_id`;
- revision loader: resolves exact revision by `library_intelligence_artifact_revisions.id`.

The revision loader returns enough context for UI and tools:

- revision id/ref;
- artifact id/ref;
- library id/ref;
- title/name;
- status;
- content markdown;
- model metadata;
- creation and promotion timestamps;
- whether it is the current revision.

### Connections

`python/nexus/services/resource_graph/connections.py` remains the owner of graph query behavior. Add only the missing LI revision child expansion and href formatting there.

Rules:

- exact revision query means exact revision graph edges;
- exact artifact query means exact artifact graph edges;
- owner rollup for an artifact may expand to its revisions;
- library-level rollup may include LI artifact/revision connections only through explicit existing rollup semantics, not by inventing a second LI graph.
- product surfaces must pass explicit origin/kind filters when they want citations, user links, or diagnostic all-origin behavior. This mirrors the product-spine rule that "all origins" is diagnostic behavior, not a reader/sidebar default.

### Context Assembly

`python/nexus/services/context_assembler.py` must stop treating LI artifact context as inherently unversioned.

Rules:

- UI-created LI chat context pins revision refs;
- context assembly accepts revision refs as ordinary attached resources;
- if a moving artifact head is attached, assembly resolves the current revision
  before prompt assembly and records that revision ref in prompt/retrieval
  assembly metadata or transcript-facing resource metadata;
- consumed-revision audit data is not stored as a second context edge and does
  not create a new graph vocabulary;
- assembled context and downstream transcripts must make it possible to see which revision was consumed.

The goal is not perfect replay of every cited source. The goal is that a conversation that consumed LI output can identify the exact LI generated text it consumed.

### API Design

Current artifact:

`GET /api/libraries/{library_id}/intelligence`

Returns:

- `artifact_id`
- `artifact_ref`
- `revision_id`
- `revision_ref`
- `status`
- `content_md`
- `citations`
- `build`
- `stale_source_count`

Revision summary list:

`GET /api/libraries/{library_id}/intelligence/revisions`

Returns rows with:

- `revision_id`
- `revision_ref`
- `artifact_id`
- `artifact_ref`
- `status`
- `is_current`
- `created_at`
- `promoted_at`
- `citation_count`

Revision detail:

`GET /api/libraries/{library_id}/intelligence/revisions/{revision_id}`

Returns:

- `artifact_id`
- `artifact_ref`
- `revision_id`
- `revision_ref`
- `status`
- `content_md`
- `citations`
- `created_at`
- `promoted_at`
- `is_current`

Promote:

`POST /api/libraries/{library_id}/intelligence/revisions/{revision_id}/promote`

Moves the head pointer only. It returns the new current artifact payload whose citations are read from the promoted revision.

Generate:

`POST /api/libraries/{library_id}/intelligence/generate`

May keep its existing request semantics. Its result must expose revision identity for any generated/pending revision it creates.

Resource graph:

No new graph endpoints. Existing resolve, connection query, context, and read-resource APIs accept the new scheme.

### Frontend Structure

`LibraryIntelligencePane.tsx`

- displays the current artifact from the current endpoint;
- stores `artifact_ref` and `revision_ref` separately;
- shows revision history rows with exact revision refs;
- opens revision detail without mutating current head;
- promotes revision by calling the promote endpoint;
- after promote, refreshes current artifact and revision list;
- never infers revision identity from artifact id.

`LibraryPaneBody.tsx`

- chat entrypoint attaches the current `revision_ref`, not the artifact ref;
- attaches `library:<library_id>` separately if the current chat UX needs library-wide context.

Shared resource graph UI:

- maps `library_intelligence_revision` to a stable label and href;
- links revision edges to the revision detail view;
- distinguishes current revision from historical revision when that context is available.

## Reuse And Consolidation Moves

1. Reuse `resource_graph.citations.replace_citations_for_output` and `build_citation_outs`; change the source ref, not the storage pattern.
2. Reuse `ResourceRef` parsers in backend and frontend; do not introduce LI-local ref strings.
3. Reuse resource graph resolve loaders; add one scheme loader for revisions.
4. Reuse connection query and owner-rollup machinery; add LI artifact-to-revision expansion in one place.
5. Reuse `read_resource` resource dispatch; add a revision branch parallel to the artifact branch.
6. Reuse `toReaderCitationData` and existing citation row shapes; source identity changes, target evidence rendering does not.
7. Reuse existing revision list/promotion UI state in `LibraryIntelligencePane`; add detail selection rather than a separate history subsystem.
8. Centralize href formatting for artifact and revision refs in the shared graph/resource-kind helpers.
9. Keep `message_retrievals` as retrieval telemetry only; it must not become the LI citation source of truth.
10. Keep source extraction and citation normalization in the existing LI reducer/service flow; do not duplicate citation parsing in the UI.

## Duplicate Pattern Inventory

Adding a ResourceRef scheme is intentionally a multi-surface change today. The hard-cutover implementation should update the existing repeated surfaces together and avoid adding a new one.

### Closed Scheme Vocabularies

Update these together:

- `python/nexus/services/resource_graph/refs.py`: `ResourceScheme` and `RESOURCE_SCHEMES`.
- `apps/web/src/lib/resourceGraph/resourceRef.ts`: `RESOURCE_SCHEMES`.
- `python/nexus/db/models.py`: `ResourceEdge` source/target scheme checks.
- the Alembic migration that owns the live database check constraints.
- any closed scheme checks in suppression/context tables, if present in the current migration head.

Do not create a separate Library Intelligence scheme enum. Generated or parity-tested ResourceRef vocabulary belongs to the product-spine cutover, not this LI feature cutover. For this change, keep the repeated lists aligned and tested unless the spine contract has already centralized them.

If the product-spine vocabulary parity work lands first, consume that generated/parity-tested contract instead of hand-editing a parallel list here.

### Per-Scheme Dispatch Tables

Add `library_intelligence_revision` to the existing dispatch points:

- `resource_graph.resolve.load_resource_batch`;
- `resource_graph.resolve._present`;
- `resource_graph.connections._href_for_ref`;
- `resource_graph.connections._owner_children`;
- `agent_tools.read_resource` readable scheme list and presenter;
- frontend resource-kind icon/label/object-ref helpers.

Do not introduce a second resolver stack under Library Intelligence.

### Existing LI Citation Call Sites

These call sites must be cut over, not wrapped:

- `library_intelligence.py:get_artifact` reads current citations from the current revision ref.
- `library_intelligence.py:promote_revision` stops replacing/clearing citations.
- `library_intelligence_reduce.py:_promote_built_revision` writes citations to the revision ref.
- any tests that assert restore clears citations are wrong after this cutover and must be rewritten.

The call sites still use `resource_graph.citations.replace_citations_for_output` / `build_citation_outs`. They do not introduce a new citation origin, relation kind, direct `resource_edges` writer, or LI-only citation table.

### Repeated Navigation Rules

Artifact and revision hrefs belong in shared graph/resource helpers:

- artifact href: `/libraries/{library_id}?tab=intelligence`;
- revision href: `/libraries/{library_id}?tab=intelligence&revision={revision_id}` or the equivalent canonical pane route if the app already has one.

Do not hand-build revision URLs in isolated components.

## Files In Scope

### Docs

- `docs/cutovers/library-intelligence-revision-resource-identity-hard-cutover.md`
- `docs/cutovers/incoming-connections-reader-sidecar-hard-cutover.md`
- `docs/modules/library.md`
- `docs/architecture.md` if it documents ResourceRef/resource graph scheme contracts

### Migrations And Models

- new Alembic migration widening ResourceRef scheme checks
- `python/nexus/db/models.py`

### Backend Resource Graph

- `python/nexus/services/resource_graph/refs.py`
- `python/nexus/services/resource_graph/resolve.py`
- `python/nexus/services/resource_graph/connections.py`
- `python/nexus/services/resource_graph/cleanup.py`
- `python/nexus/services/resource_graph/citations.py` comments/contracts only if needed
- `python/nexus/services/resource_graph/context.py` if closed scheme admission exists there
- `python/nexus/services/resource_graph/schemas.py` if API schemas enumerate schemes

### Backend Library Intelligence

- `python/nexus/services/library_intelligence.py`
- `python/nexus/services/library_intelligence_reduce.py`
- `python/nexus/api/routes/library_intelligence.py`
- `python/nexus/schemas/library_intelligence.py`
- `python/nexus/services/library_governance.py` or whichever owner handles library deletion cleanup

### Agent And Context

- `python/nexus/services/context_assembler.py`
- `python/nexus/services/agent_tools/read_resource.py`
- any conversation creation or initial-reference validation path that enumerates allowed schemes

### Frontend

- `apps/web/src/lib/resourceGraph/resourceRef.ts`
- `apps/web/src/lib/resources/resourceKind.ts`
- shared resource kind/icon/href helpers
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryIntelligencePane.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- shared connection/citation surfaces if they enumerate resource schemes

### Tests

- `python/tests/test_resource_graph_refs.py`
- `python/tests/test_resource_graph_resolve.py`
- `python/tests/test_resource_graph_connections.py`
- `python/tests/test_resource_graph_edges.py`
- `python/tests/test_library_intelligence.py`
- `python/tests/test_library_intelligence_read_model.py`
- `python/tests/test_read_resource_tool.py`
- context assembler tests covering LI attached resources
- `apps/web/src/lib/resourceGraph/resourceRef.test.ts`
- `apps/web/src/__tests__/components/LibraryIntelligencePane.test.tsx`
- tests for chat initial context refs from the LI pane

## Key Decisions

### Decision: Revision Is The Durable Resource

The generated text lives at revision identity. Artifact identity is a pointer. This matches software release, document version, and content-addressable provenance practice.

### Decision: No LI-Private Citation Store

The existing resource graph is the owner of links and backlinks. Creating another citation store would recreate the drift that the graph cutover removed.

### Decision: No Dual-Write

Dual-writing artifact and revision citations creates conflicting backlink semantics and requires future reconciliation. This is a hard cutover: new citation writes use revision refs only.

### Decision: Promotion Does Not Touch Citations

Promotion changes which revision is current. It does not change what a revision cited. Citation mutation belongs to revision generation only.

### Decision: Source History Is Out Of Scope

Historical LI revisions preserve generated output and cited target refs. They do not guarantee that every cited source page, note block, or media extraction is replayed from the exact historical state that the model saw.

### Decision: Existing Artifact Ref Stays Meaningful

The artifact ref is not deleted. It means latest/head. That is a clean capability, not a compatibility fallback.

## Rules

1. Any code writing LI generated citations must use `library_intelligence_revision`.
2. Any code reading LI generated citations must query revision refs.
3. Promotion and restore must not delete, rewrite, or copy revision citation edges.
4. UI chat from LI must pin revision refs.
5. Raw artifact refs are allowed only for explicit latest/head workflows.
6. ResourceRef parsing stays strict on both backend and frontend.
7. New scheme support must be added to schema checks, parsers, resolvers, hrefs, icons, tests, and docs in the same change.
8. No new fallback path may reinterpret artifact refs as historical refs.
9. Deletion cleanup must remove revision edges explicitly.
10. Tests must include a negative guard that no generated citation write uses `library_intelligence_artifact`.

## Acceptance Criteria

1. Backend parses and serializes `library_intelligence_revision:<revision_id>`.
2. Frontend parses and serializes `library_intelligence_revision:<revision_id>`.
3. Database accepts `resource_edges` with source and target scheme `library_intelligence_revision`.
4. Generating LI creates citation edges whose source is the revision ref.
5. Generating LI creates no citation edges whose source is the artifact ref.
6. `GET /intelligence` returns current artifact content plus current `revision_ref`.
7. `GET /intelligence` citations are read from the current revision ref.
8. `GET /intelligence/revisions` returns revision refs and current markers.
9. `GET /intelligence/revisions/{revision_id}` returns exact historical content and exact historical citations.
10. Promoting a newer revision leaves older revision citation edges intact.
11. Restoring an older revision leaves newer revision citation edges intact.
12. After promotion or restore, copied links to both old and new revision refs still resolve.
13. `read_resource` for a revision returns the exact revision after head movement.
14. Resource graph resolve returns useful metadata for both artifact and revision refs.
15. Connection query for exact revision returns revision edges.
16. Artifact owner rollup can include revision children when explicitly requested.
17. Library deletion removes graph edges for all owned LI revision refs.
18. Chat from LI attaches the revision ref by default.
19. Context assembly records the exact LI revision consumed.
20. Docs no longer describe LI citations as current-head-only.

## Implementation Plan

### Phase 1: Contract Tests

Write failing tests first for:

- revision `ResourceRef` parsing in Python and TypeScript;
- generation writes revision-sourced citations;
- promotion does not rewrite citations;
- restore does not clear citations;
- historical revision detail returns citations after head moves;
- chat initial context refs use revision refs;
- read-resource exact revision stability;
- graph resolve and connection query for revision refs.

### Phase 2: Scheme Migration

Add the migration and ORM updates that allow `library_intelligence_revision` anywhere graph-addressable resource refs are stored. Keep the scheme list closed.

### Phase 3: Backend LI Read/Write Cutover

Refactor Library Intelligence service/reducer code so:

- generation writes citations to revision refs;
- current artifact reads citations from current revision;
- revision detail endpoint reads citations from requested revision;
- promotion/restoration only moves the head pointer.

Remove restore citation clearing entirely.

### Phase 4: Graph, Resolve, Context, Tools

Add:

- revision resolver;
- revision href/label support;
- artifact-to-revision owner rollup;
- read-resource revision support;
- context assembler revision pinning/metadata behavior.

### Phase 5: Frontend Cutover

Update the LI pane and shared graph UI:

- current view uses current revision ref;
- history rows can open exact revisions;
- promote refreshes current/head state;
- chat entrypoint attaches revision refs;
- connection rows can navigate to revision detail.

### Phase 6: Docs Cleanup

Amend existing docs that describe LI citations as head-only. The docs must present artifact=head and revision=durable as the canonical contract.

### Phase 7: Verification

Run targeted Python and frontend tests for all touched layers. Add a repository grep guard during review:

- no `replace_citations_for_output` call for LI uses `library_intelligence_artifact`;
- no restore path clears citations;
- no frontend chat path starts from LI with only the artifact ref.

## Verification Commands

Use targeted checks first:

```bash
pytest python/tests/test_resource_graph_refs.py \
  python/tests/test_resource_graph_resolve.py \
  python/tests/test_resource_graph_connections.py \
  python/tests/test_library_intelligence.py \
  python/tests/test_library_intelligence_read_model.py \
  python/tests/test_read_resource_tool.py
```

```bash
bun test apps/web/src/lib/resourceGraph/resourceRef.test.ts \
  apps/web/src/__tests__/components/LibraryIntelligencePane.test.tsx
```

Repository guards:

```bash
rg -n 'replace_citations_for_output\\(|library_intelligence_artifact|library_intelligence_revision' \
  python/nexus/services python/nexus/api apps/web/src python/tests
```

```bash
rg -n 'clear.*citation|citation.*clear|current-head-only|head-only' \
  python/nexus docs apps/web/src
```

## Open Implementation Notes

1. The exact migration revision number must be chosen from the current Alembic head at implementation time.
2. If suppression, context, or auxiliary tables duplicate ResourceRef scheme
   checks, widen them only when their owner semantically accepts LI revision
   refs. Otherwise keep the exclusion and document it in the migration and
   service tests.
3. If the frontend currently lacks a canonical resource-kind helper, create one small shared helper rather than scattering labels and hrefs across components.
4. If existing history UI cannot route to revision detail cleanly, use a selected-revision state inside the LI pane before adding a new page route.
5. If existing API response schemas conflate artifact id and revision id, split the fields explicitly instead of overloading names.

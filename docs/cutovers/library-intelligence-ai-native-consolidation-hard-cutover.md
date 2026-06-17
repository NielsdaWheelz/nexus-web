# Library Dossiers - Flagship Library Intelligence Hard Cutover

Status: SPEC - Rev 4, flagship completion plan over the built revision-first substrate
Author: design synthesis, 2026-06-16
Type: hard cutover - no legacy code, no fallbacks, no dual-write, no dual-read,
no backward-compatible payload shapes, no compatibility shims

## North Star

A Library Dossier is the latest Library Intelligence artifact for a library.

The user-facing product is "the dossier": a NotebookLM-like, source-grounded
research artifact that can be generated, regenerated, revised, cited, opened,
restored, and chatted with. The software identity is stricter than NotebookLM:

```text
library_intelligence_artifact:<artifact_id>
  mutable latest/head resource for one library

library_intelligence_revision:<revision_id>
  immutable generated output resource
  owns the exact markdown body and graph citation edges for that output
```

The pane defaults to the latest artifact head. Every exact citation, backlink,
copied link, historical view, and chat subject uses the consumed revision. The
head is a product alias for "latest"; the revision is the generated document.

## Product Reference

NotebookLM's public contract sets the product bar: notebooks are collections of
sources, chat answers use source citations that can be inspected and navigated
back to the source location, and the Studio panel generates reports such as FAQ,
study guide, briefing document, data table, slide deck, and other artifacts from
the notebook's sources:

- https://support.google.com/notebooklm/answer/16179559
- https://support.google.com/notebooklm/answer/16206563
- https://support.google.com/notebooklm/answer/16215270

Nexus should not clone that surface wholesale. The professional move is to keep
the NotebookLM affordances that matter for research work - source-grounded chat,
generated reports, inspectable citations, custom instructions, and regenerated
artifacts - while making the identity, citation, and replay contracts stronger:

- a generated dossier has an immutable revision resource;
- citations are graph edges, not LLM-owned blobs or frontend state;
- source-derived projections remain current-only;
- generated work products retain revision history;
- chat consumes and records the exact revision it used.

## Current Head Facts

The repo is no longer the old deterministic Library Intelligence scaffold.
Current head already has the important substrate:

- `python/nexus/services/library_intelligence.py` owns the stable artifact head,
  `get_artifact`, freshness, `generate_artifact`, revision promotion, revision
  listing dependencies, and the library-to-media expansion helper.
- `python/nexus/services/library_intelligence_reduce.py` owns the LLM reduce:
  resolve library media, build missing media units inline, run one structured
  synthesis, map citation claim indices to grounded media claims, materialize
  `CitationInput`s, write revision citations, and promote the revision.
- `python/nexus/services/media_intelligence.py` owns per-media summaries and
  grounded claims keyed by current content fingerprint.
- `python/nexus/services/resource_graph/citations.py` is the single backend
  citation ordinal owner and `CitationOut` producer.
- `resource_edges` stores LI citations with
  `source=library_intelligence_revision:<id>` and `origin='citation'`.
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryIntelligencePane.tsx`
  already renders `content_md` through `MarkdownMessage`, adapts
  `CitationOut[]` through `toReaderCitationData`, supports revision history,
  subscribes to the revision SSE stream, and starts chat with the selected
  revision ref.
- `docs/cutovers/library-intelligence-revision-resource-identity-hard-cutover.md`
  is the built identity cutover. This spec composes with it; it does not fork
  or rename the resource model.

This spec is therefore not a "build LI from scratch" plan. It is the flagship
completion plan: tighten the remaining product contract, remove stale doc
language, harden citation parity, add instructionful regeneration, make the pane
feel like a research artifact, and prove the whole generate-to-citation flow
end-to-end.

## SME Thesis

A subject matter expert would treat Library Dossiers as generated document
resources, not as a library-chat variant and not as a second artifact system.

The core questions are:

1. What is the identity of the generated work product?
2. Which identity is safe for durable citations and chat?
3. Which data is source-derived and current-only?
4. Which data is generated output and revisioned?
5. Which owner turns model output into durable citations?
6. What proves a browser user can generate a dossier, click a citation, and
   chat with the exact generated output?

The answers:

- Product default: `library_intelligence_artifact:<artifact_id>` latest head.
- Durable output: `library_intelligence_revision:<revision_id>`.
- Citations: dense ordinal `resource_edges` sourced from the revision.
- Read model: backend-built `CitationOut[]`.
- Render model: `CitationOut -> toReaderCitationData -> MarkdownMessage`.
- Chat: resource-chat subject over the revision plus the companion library.
- Source projections: current-only and allowed to go stale after re-ingest.
- Generated dossier revisions: durable work products with explicit promotion.

## Scope

In scope:

- the Library Dossier product contract;
- the existing Library Intelligence artifact/revision schema;
- `content_md` markdown generation and revision metadata;
- revision-scoped citation edges and the `CitationOut` read model;
- citation-marker parity between stored markdown and stored citation edges;
- instructionful generate/regenerate/revise;
- embedded revision-scoped chat in the Library Intelligence pane;
- revision history as a real product surface, not just an audit table;
- source coverage and stale-delta display;
- hierarchical reduce for large libraries;
- browser-level E2E coverage for generate -> render -> citation jump -> chat;
- docs and negative gates that keep stale current-only or artifact-head wording
  from returning.

Out of scope:

- a new `library_dossier` table, resource scheme, or route family;
- a second generated-chat-artifact system;
- a parent-revision DAG, branch graph, merge model, CRDT, or collaborative edit
  model;
- source-version replay for old citations after source replacement;
- a generic graph database or ontology UI;
- auto-regeneration without user action;
- using `message_retrievals` as dossier storage or citation authority;
- making Library Intelligence revisions source-evidence citation targets by
  default.

## Goals

G1. Make Library Intelligence the flagship research artifact in the library
surface.

G2. Keep the product wording simple: "Dossier" means the latest LI artifact head.

G3. Keep the engineering identity strict: citations, backlinks, chat subjects,
and historical links use the immutable revision.

G4. Generate one markdown document plus graph citations through one end-to-end
path. The model never emits `CitationOut`.

G5. Make regeneration instructionful: "regenerate", "focus on X", "revise with
this angle", and "use this chat result as an update instruction" all create a
new immutable revision through the same service contract.

G6. Keep generated-output history useful: revision list, current marker, restore,
source coverage, stale delta, citation count, model/run metadata, and prompt or
instruction visibility.

G7. Make citation integrity fail-closed: no ready revision can contain visible
`[N]` markers that do not resolve to a `CitationOut`.

G8. Reuse and centralize existing primitives instead of creating dossier-local
copies.

G9. Prove the flagship flow with one real browser E2E test and focused service
tests.

## Non-Goals

N1. No new durable product identity named `library_dossier`. The user language
is "dossier"; the system identity remains Library Intelligence artifact and
revision.

N2. No artifact-head citations. A citation source must never be
`library_intelligence_artifact:<id>`.

N3. No compatibility with the old deterministic compiler, old LI table fanout,
old current-only generated-intelligence wording, or old library-chat surface.

N4. No fallback from revision refs to artifact heads. If a caller asks for an
exact revision, it must load that revision or fail.

N5. No fallback from artifact heads to historical revisions. If a caller asks
for latest, it resolves only to the current head.

N6. No storage fold into `message_retrievals`, `conversation_references`,
`object_links`, or `oracle_reading_passages`.

N7. No frontend citation reconstruction from markdown, retrieval blocks, or SSE
fragments. The backend ships `CitationOut[]`.

N8. No source-derived replay guarantee. A revision preserves the citations it
emitted; it does not freeze every cited source document or old index row.

N9. No hidden auto-rebuild, scheduled rebuild, or "best effort" rebuild after
source changes. Staleness is visible; regeneration is explicit.

## Target Behavior

### Opening A Library

The library pane shows a first-class Dossier/Intelligence surface. If no dossier
exists, the pane shows a concise empty state and a Generate action. If a dossier
exists, the pane shows the latest revision body immediately.

Default visible state:

- title: "Dossier" or "Intelligence" consistently across the library surface;
- status: `Current`, `Stale`, `Generating`, `Failed`, or `Unavailable`;
- generated markdown body;
- inline citation chips;
- source coverage summary;
- revision metadata;
- regenerate/revise control;
- chat sidecar or chat affordance;
- revision history.

### Generating

Generate creates a draft revision for the existing artifact head or creates the
head first if none exists. The response returns `artifact_ref` and
`revision_ref`. The browser subscribes to the draft revision stream. The
revision is promoted only after markdown, citation edges, coverage metadata,
terminal run state, and marker parity are valid.

### Regenerating And Revising

Regenerate is not a special storage path. It is `generate_artifact` with an
optional instruction:

- empty instruction: rebuild the dossier from current sources;
- user instruction: bias the synthesis, add a lens, tighten the report, or
  update the dossier from an explicit chat-derived instruction;
- selected revision context: the current or selected revision may be included in
  the prompt as previous output, but it is not stored as `parent_revision_id`
  and does not create lineage semantics.

Every successful run creates a new immutable revision and promotes it.
Draft-only product states are not part of this cutover; promote-on-success is
the one path.

### Chattable Artifact

The pane embeds or opens a normal resource chat whose subject is the selected
revision and whose companion context includes the library:

```text
subject: library_intelligence_revision:<current_or_selected_revision_id>
context: library:<library_id>
```

If a user initiates chat from the latest artifact head, the resource-chat
subject resolver consumes the current revision and records both requested latest
and consumed revision. The product can say "chat with the dossier"; the durable
run must know which revision it read.

Chat answer citations should come from library/search evidence by default. A
dossier revision is readable prompt context, not source-evidence. If a future
feature wants answer citations to cite a specific dossier claim, add a real
`dossier_claim` or generated-output citation target; do not infer it from
attached-resource reads.

### Citation Interaction

Every visible `[N]` marker in a ready dossier resolves to exactly one
`CitationOut` with a deep link or a clear unresolved-current-source state. The
chip opens the existing reader target. Shift/open-in-new-pane behavior follows
the current reader citation convention.

If source re-ingest invalidates a target, the dossier becomes stale. The old
revision remains readable; its citation chip displays the stored snapshot and
fails closed for navigation instead of guessing a new location.

### Revision History

The history is a compact part of the flagship surface, not a hidden audit table.
Each row shows:

- created time;
- promoted/current marker;
- status;
- citation count;
- covered source count;
- stale delta if this revision were current;
- custom instruction preview when present;
- model/provider or `llm_call` summary;
- restore action for ready historical revisions.

Opening a historical revision shows a clear historical banner and chats with
that exact revision if the user uses Chat from that view.

## Architecture

### System Composition

```text
library_entries
  owns library membership of media/podcast targets

content_indexing
  owns current chunks, evidence spans, embeddings, current-source cleanup

media_intelligence
  owns per-media summary + grounded claims keyed by content_fingerprint

library_intelligence
  owns artifact head, revision lifecycle, freshness, promotion, revision read model

library_intelligence_reduce
  owns the LLM dossier synthesis run

structured_synthesis
  owns strict JSON synthesis call/repair scaffold

run_kit
  owns generation stream/event terminal mechanics

resource_graph.citations
  owns ordinal citation writes and CitationOut reads

resource_items / resource_chat_subject
  owns whether artifact/revision can be chatted with, read, linked, opened

LibraryIntelligencePane
  owns dossier rendering, generation control, history, and chat entry
```

No route, BFF handler, component, or SSE hook owns business rules that belong in
those services.

### Data Model

Use the existing three durable owners:

- `library_intelligence_artifacts`
  - one stable head per library;
  - owns `current_revision_id`;
  - source of product "latest dossier" identity.

- `library_intelligence_artifact_revisions`
  - immutable generated outputs;
  - own `content_md`, `covered_targets`, status, instruction metadata, timestamps,
    and terminal generation metadata that is not already owned by `llm_calls`;
  - one revision id is also the run/SSE id.

- `resource_edges`
  - owns all generated dossier citation edges;
  - source is `library_intelligence_revision:<revision_id>`;
  - `origin='citation'`;
  - `ordinal` dense from `1..N`;
  - `snapshot` contains display/replay fields;
  - target is a supported citable resource such as `evidence_span`,
    `content_chunk`, `media`, `page`, `note_block`, or `external_snapshot`.

Do not add:

- `library_dossiers`;
- `library_dossier_revisions`;
- `library_intelligence_citations`;
- `parent_revision_id`;
- `source_set_version_id`;
- generated-chat artifact tables.

### Revision Metadata

The revision read model should expose enough metadata for a professional
research artifact without duplicating owners:

- `custom_instruction: str | null` - revision-owned;
- `source_count: int` - derived from `covered_targets`;
- `citation_count: int` - derived from citation edges;
- `stale_source_count: int | null` - computed against live coverage;
- `model_provider` / `model_name` / usage - read from `llm_calls` where possible;
- `created_at`, `promoted_at`, `status`, `is_current`;
- `artifact_ref`, `revision_ref`.

If query cost becomes real, add a closed revision metadata table or columns with
one owner. Do not add an untyped JSON bag just because the UI wants labels.

### Generation Contract

The model-facing contract remains deliberately narrow:

```json
{
  "content_md": "markdown with [N] markers",
  "citations": [
    {"ordinal": 1, "claim_index": 42, "role": "supports"}
  ]
}
```

The LLM emits `claim_index`, not `CitationOut`, not `ResourceRef`, and not raw
evidence locators. The backend maps `claim_index` to a ready media claim and
that claim's evidence span. The backend then writes `CitationInput`s through
`replace_citations_for_output`.

### Citation Parity Contract

A ready revision must satisfy all of these:

1. Stored markdown citation markers are exactly dense `1..N`.
2. Stored citation edges for the revision are exactly dense `1..N`.
3. The marker set and edge ordinal set are identical.
4. Every edge target can be projected into a `CitationOut`.
5. The frontend does not hide an unresolved marker in a ready revision.

If the model emits an out-of-range claim index, duplicate ordinal, unknown role,
or markdown marker mismatch, the generation worker may make one bounded repair
attempt through the structured synthesis repair path. If the repair still fails,
mark the revision failed and do not promote. Silently dropping citations from a
ready revision is forbidden.

The shared helper should live with the citation owner, for example:

```python
validate_generated_markdown_citations(
    content_md: str,
    citations: Sequence[CitationInput],
) -> None
```

`MarkdownMessage` remains a renderer, not the validator of record.

### Staleness And Coverage

Staleness is computed from current expanded library media and their current
`media_summaries.content_fingerprint` values compared to the revision's
`covered_targets`.

Changed means:

- media added to the library;
- media removed from the library;
- podcast entry expanded to a changed episode-media set;
- a covered media item was re-ingested and got a new fingerprint;
- a media unit disappeared or failed where the revision had coverage.

The read model reports `stale_source_count`. The UI should also show source
coverage as a simple "covered X sources" value. A detailed source table is
allowed later, but not required for the first flagship pass.

### Large Libraries

Single-call reduce is acceptable for small libraries. The final product must
have a hierarchical reduce for libraries that exceed the input budget:

```text
media claims
  -> cluster or batch summaries
  -> intermediate cited briefs
  -> final dossier markdown + citations
```

The final dossier still emits citations to original source evidence. Intermediate
summaries are implementation artifacts unless a future product makes them
addressable resources. Do not expose them as durable citations or revision
children by default.

Minimum behavior:

- deterministic batching by library order and media id;
- explicit truncation/coverage events when budget pressure remains;
- revision metadata shows coverage and omitted-source count;
- no silent "best effort" report that appears complete while omitting sources.

## Capability Contract

### Read Current Dossier

`get_artifact(viewer_id, library_id) -> ArtifactView`

Returns:

- artifact id/ref;
- current revision id/ref;
- status;
- content markdown;
- `CitationOut[]`;
- stale source count;
- in-flight build, if any;
- revision metadata needed by the pane.

The service computes visibility and freshness. Routes only shape the response.

### Generate Or Revise Dossier

`generate_artifact(viewer_id, library_id, idempotency_key, instruction=None) -> RevisionRef`

Rules:

- `Idempotency-Key` header required;
- body is typed and optional, not a loose dict;
- same idempotency key returns the same draft revision;
- no body or blank instruction means ordinary regenerate;
- nonblank instruction is stored on the revision and included in the prompt;
- every successful run promotes one ready revision;
- current content stays visible while the draft builds.

### Run Dossier Generation

`run_artifact_generation(revision_id, llm) -> None`

Rules:

- build missing media units inline through `media_intelligence`;
- gather grounded claims;
- use hierarchical reduce when input exceeds budget;
- run strict structured synthesis;
- validate marker/citation parity;
- write citation edges with source `library_intelligence_revision:<id>`;
- write coverage metadata;
- mark terminal and promote in one owner-controlled transaction;
- failures leave the prior current revision untouched.

### List And Restore Revisions

`list_revisions(viewer_id, library_id) -> list[RevisionSummary]`

`promote_revision(viewer_id, library_id, revision_id) -> ArtifactView`

Rules:

- restore is promotion;
- promotion moves `current_revision_id`;
- promotion does not rewrite or clear citation edges;
- failed revisions are visible as failed rows but cannot be promoted;
- no revision DAG, branch, merge, or parent semantics.

### Chat With Dossier

The final chat entrypoint is the resource-chat subject contract:

```json
{
  "chat_subject": {"resource_ref": "library_intelligence_revision:<id>"},
  "extra_context_refs": ["library:<id>"]
}
```

The implementation slice must collapse any LI-local
`initial_context_refs` construction to the resource-chat subject adapter. There
should be one "start chat about resource" frontend helper and one backend
subject resolver.

### Read Resource

`read_resource(library_intelligence_revision:<id>)` returns the revision body
and metadata. It does not remint the revision's internal source citations as
chat citations.

`read_resource(library_intelligence_artifact:<id>)` resolves the current
revision and includes the resolved revision ref.

## API Design

Current route names stay because Library Intelligence remains the owning
capability. Do not add duplicate `/dossiers` routes unless the whole capability
is renamed in one separate cutover.

| Method | Route | Contract |
|---|---|---|
| `GET` | `/libraries/{library_id}/intelligence` | current latest dossier read model with artifact/ref, revision/ref, status, markdown, citations, coverage, build |
| `POST` | `/libraries/{library_id}/intelligence/generate` | 202; `Idempotency-Key` header; optional typed body `{instruction?: string}`; returns artifact/ref and draft revision/ref |
| `GET` | `/stream/library-intelligence/{revision_id}/events` | SSE over the draft revision run |
| `GET` | `/libraries/{library_id}/intelligence/revisions` | revision history summaries with citation/source/model/instruction metadata |
| `GET` | `/libraries/{library_id}/intelligence/revisions/{revision_id}` | exact historical revision body plus citations |
| `POST` | `/libraries/{library_id}/intelligence/revisions/{revision_id}/promote` | restore/promote ready historical revision |
| `POST` | `/conversations` | one centralized resource-chat subject contract, not LI-specific chat |

BFF routes remain proxy-only. They must not parse generated markdown, infer
citations, compute freshness, or create alternate request shapes.

## Frontend Structure

The existing `LibraryIntelligencePane` is the right home. Evolve it into the
flagship Dossier surface instead of creating a parallel page.

Final structure:

- header: title, status, regenerate/revise, chat;
- body: `MarkdownMessage(content_md, citations.map(toReaderCitationData))`;
- citation activation: existing reader source activation;
- revision bar/history: compact list with metadata and restore;
- chat sidecar: reuse `ResourceChatTab`/resource-chat primitives;
- generation: `useLibraryIntelligenceStream` on top of `useGenerationRun`;
- no polling loop;
- no `LibraryChatTab`;
- no frontend `CitationOut` reconstruction;
- no ad hoc resource-ref string parsing.

The UI should not bury the research artifact behind status cards. It should feel
like a readable report with controls around it.

## Composition With Other Systems

### Library Entries

`library_entries` remains the sole writer for library membership. LI reads
through the allowed Tier-R path and uses the existing media/podcast target
expansion helper. Dossier generation never mutates library entries.

### Content Indexing

`content_chunks`, `evidence_spans`, and embeddings are current-source evidence.
They are discovery and grounding substrate, not revisioned provenance. Reindex
can make old evidence targets stale; dossier revisions remain readable.

### Media Intelligence

`media_intelligence` is the reusable per-media unit layer. Dossiers should not
derive per-media summaries or claims ad hoc. If another surface needs the same
unit, it calls `media_intelligence`.

### Resource Graph

`resource_edges` is the only durable positive connection/citation contract.
Adding dossier behavior must update graph policy, DB checks, backend refs,
frontend refs, resolvers, and tests together. No LI-private citation table.

### Chat

Chat owns assistant messages, tool loop, retrieval telemetry, and message
citations. It does not own dossier revisions. Dossier chat supplies a subject
and companion library context; chat still cites evidence through its normal
retrieval/citation path.

### Oracle

Oracle and LI both use structured generation and graph citations, but their
product shapes differ. Do not copy Oracle folio/marginalia semantics into LI.
Do not make LI revision history behave like Oracle readings.

### Reader

Reader citation activation is reused. Dossier citations target reader-resolvable
source evidence where possible. Unresolvable historical targets are rendered as
stale/unavailable, not guessed.

### LLM Ledger And BYOK

Generation uses the existing provider/runtime/key/ledger spine. Model identity,
usage, error detail, and BYOK mode should come from `llm_calls` and the existing
generation harness where possible, not from duplicated revision columns.

## Duplicate And Reuse Map

| Pattern to avoid | Reuse or consolidation target |
|---|---|
| Dossier-local citation tables | `resource_edges` + `resource_graph.citations` |
| LLM-emitted `CitationOut` | LLM emits `claim_index`; backend builds `CitationOut` |
| Frontend citation reconstruction | backend `CitationOut[]`; `toReaderCitationData` |
| Markdown marker validation in the UI | backend citation parity helper |
| LI-specific chat creation | centralized resource-chat subject/start helper |
| Library chat surface beside dossier chat | Dossier chat over revision + library |
| Per-media summaries inside LI reduce | `media_intelligence` units |
| Source expansion duplicated in workers | `resolve_library_media_ids` owner helper |
| Another SSE/generation hook | `useGenerationRun` + `useLibraryIntelligenceStream` |
| BFF freshness/status logic | `library_intelligence.get_artifact` |
| Revision metadata copied from LLM calls | read from `llm_calls` unless revision-owned |
| Large-library silent truncation | hierarchical reduce + coverage metadata |
| New route family named dossiers | existing LI API until full rename cutover |

## Files And Owners

Backend:

- `python/nexus/services/library_intelligence.py`
- `python/nexus/services/library_intelligence_reduce.py`
- `python/nexus/services/library_intelligence_revisions.py`
- `python/nexus/services/media_intelligence.py`
- `python/nexus/services/structured_synthesis.py`
- `python/nexus/services/run_kit.py`
- `python/nexus/services/resource_graph/citations.py`
- `python/nexus/services/resource_graph/refs.py`
- `python/nexus/services/resource_graph/resolve.py`
- `python/nexus/services/resource_items/capabilities.py`
- `python/nexus/services/resource_items/chat_subjects.py`
- `python/nexus/services/resource_items/surfaces.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/api/routes/library_intelligence.py`
- `python/nexus/schemas/library_intelligence.py`
- `python/nexus/tasks/library_intelligence.py`
- `python/nexus/jobs/registry.py`
- `python/nexus/db/models.py`
- `migrations/alembic/versions/*library_intelligence*`

Frontend:

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryIntelligencePane.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/components/library/useLibraryIntelligenceStream.ts`
- `apps/web/src/components/chat/ResourceChatTab.tsx`
- `apps/web/src/lib/resourceGraph/resourceRef.ts`
- `apps/web/src/lib/conversations/citations.ts`
- `apps/web/src/components/ui/MarkdownMessage.tsx`
- `apps/web/src/lib/api/sse/libraryIntelligenceEvents.ts`
- `apps/web/src/lib/api/useGenerationRun.ts`

Tests:

- `python/tests/test_library_intelligence.py`
- `python/tests/test_library_intelligence_read_model.py`
- `python/tests/test_resource_graph_resolve.py`
- `python/tests/test_resource_graph_edges.py`
- `python/tests/test_conversations.py`
- `python/tests/test_attached_citations.py`
- `python/tests/test_cutover_negative_gates.py`
- `apps/web/src/__tests__/components/LibraryIntelligencePane.test.tsx`
- a new Playwright E2E covering generate -> citation jump -> chat.

Docs:

- this document;
- `docs/cutovers/library-intelligence-revision-resource-identity-hard-cutover.md`;
- `docs/cutovers/resource-chat-subject-hard-cutover.md`;
- `docs/cutovers/resource-graph-product-spine-hard-cutover.md`;
- `docs/cutovers/current-only-artifacts-hard-cutover.md`;
- `docs/modules/library.md`;
- `docs/modules/chat.md`;
- `docs/architecture.md`.

## Implementation Slices

S0 - Docs cleanup and contract lock:

- make this spec canonical;
- remove stale "generated LI is current-only presentation" wording;
- add negative gates for artifact-head citations and unresolved markdown markers;
- keep revision-resource identity doc as built lower-level precedent.

S1 - Test the flagship path first:

- add backend route/service tests for instructionful generate;
- add marker/citation parity tests;
- add Playwright E2E: open library, generate dossier, wait for done, click
  citation, verify reader location, open chat with revision subject.

S2 - Citation parity hardening:

- add backend marker extraction/validation helper;
- validate final markdown and citation inputs before promotion;
- repair once through structured synthesis if needed;
- fail the revision if parity remains invalid;
- remove any behavior that silently drops visible citations from ready output.

S3 - Instructionful regenerate/revise:

- add typed generate request body;
- persist or expose custom instruction as revision metadata;
- include instruction in the reduce prompt;
- let chat-derived update actions call the same generate service;
- keep `Idempotency-Key` as the replay key.

S4 - Flagship pane:

- make Dossier/Intelligence the primary library research surface;
- add embedded resource chat or a sidecar that reuses resource-chat primitives;
- enrich revision rows with citation/source/model/instruction metadata;
- show historical banner when selected revision is not current;
- keep current content visible during draft generation.

S5 - Resource-chat consolidation:

- collapse LI-specific chat start logic into the generic resource-chat subject
  adapter;
- ensure artifact-head requests consume and record current revision;
- ensure selected historical revision chat uses that exact revision.

S6 - Hierarchical reduce:

- add deterministic batching above the current single-call reduce budget;
- preserve citations to original evidence targets;
- record coverage and omitted-source counts;
- add tests for large-library coverage behavior.

S7 - Negative gates and cleanup:

- no artifact-head citation writes;
- no `library_intelligence_citations`;
- no `LibraryChatTab` or `library-chat`;
- no old deterministic compiler strings;
- no frontend citation reconstruction;
- no second dossier route family;
- no direct `library_entries` mutation from LI;
- no BFF business logic.

## Acceptance Criteria

AC1. Opening a library shows a Dossier/Intelligence surface backed by the latest
`library_intelligence_artifact` head.

AC2. Generate over a non-empty library creates a ready revision with non-empty
`content_md` and at least one `CitationOut` when the source corpus contains
citable evidence.

AC3. Every ready revision's visible markdown citation markers exactly match its
stored citation edge ordinals.

AC4. Every LI generated citation edge has source
`library_intelligence_revision:<id>`. No generated citation edge has source
`library_intelligence_artifact:<id>`.

AC5. The frontend renders dossier citations only from backend `CitationOut[]`
through `toReaderCitationData`.

AC6. Clicking a dossier citation navigates to the expected reader target or
renders an explicit stale/unresolved state for current-source replacement.

AC7. Regenerate with an instruction creates a new immutable revision, includes
the instruction in generation, stores/exposes the instruction metadata, and
promotes the successful revision.

AC8. Failed draft revisions do not disturb the current revision.

AC9. Restoring a historical revision moves `current_revision_id` only and does
not rewrite citation edges.

AC10. Chat from the current dossier uses the current revision ref plus companion
library context. Chat from a historical revision uses that historical revision.

AC11. Chat answer citations come from normal chat retrieval/citation machinery,
not from `message_retrievals` promoted into dossier storage and not from
implicit dossier-body citations.

AC12. Revision history shows current marker, status, citation count, source
coverage, instruction preview when present, and model/run metadata.

AC13. Re-ingesting, adding, removing, or podcast-expanding sources flips the
head to stale with a correct changed-source count.

AC14. Large libraries use hierarchical reduce or explicitly report omitted
coverage. They do not silently truncate while presenting a complete dossier.

AC15. One Playwright E2E proves generate -> stream done -> render markdown ->
click citation -> open chat with revision subject.

AC16. Existing chat, Oracle, reader, resource graph, and library entry tests keep
passing without compatibility lanes.

## Negative Gates

No production references outside migrations/tests/specs:

- `library_intelligence_citations`;
- old deterministic LI section compiler names;
- `LibraryChatTab`;
- `library-chat`;
- `parent_revision_id`;
- source-set version identity for LI;
- artifact-head LI citation writes;
- frontend `CitationOut` reconstruction from markdown/retrieval blocks;
- BFF-side freshness or citation computation.

Must remain present:

- `message_retrievals` as chat telemetry;
- `conversation_references` or their resource-graph context successor as chat
  context edges;
- `oracle_reading_passages` for Oracle folios;
- `object_links` or their graph-owned user-link successor;
- `resource_edges` as citation owner;
- `CitationOut` as backend read model.

## Rules

R1. Dossier is a product name. Library Intelligence remains the owning service
until a separate full rename cutover changes every API, schema, and doc.

R2. Mutable head is for latest presentation only. Immutable revision is for
exact generated output.

R3. The backend owns citation integrity. The frontend renders citations; it does
not repair them.

R4. The LLM may choose claim indices and prose. It may not choose database
resource identities.

R5. Source-derived projections are current-only. Generated dossier revisions are
the explicit durable-work-product carveout.

R6. One generation path. Generate, regenerate, and revise all create a revision
through `library_intelligence.generate_artifact`.

R7. One chat path. Dossier chat uses resource-chat subject primitives, not an LI
chat subsystem.

R8. One citation path. Dossier citations use `resource_graph.citations`.

R9. One per-media unit path. Dossier generation uses `media_intelligence`.

R10. Failure is explicit. No silent citation drops, silent source omission, or
silent fallback to old artifact shapes.

## Key Decisions

D1. "Dossier" is the latest LI artifact head, not a new database concept.

D2. `library_intelligence_revision` is the durable generated document identity.

D3. `CitationOut` is a read model; it is never model output.

D4. Instructionful revise creates a new revision without parent lineage.

D5. Generated revision history is product value even in a one-user prototype.
It stays simple: list, open, restore. No branch graph.

D6. Source coverage is a first-class trust signal. If the generator omits
sources for budget reasons, the UI must say so.

D7. A dossier body is readable chat context but not source evidence by default.
Chat should cite underlying library sources, not pretend the dossier's own
internal markers are search results.

D8. Hierarchical reduce is the scalable path. It must preserve final citations
to original evidence, not to hidden intermediate summaries.

D9. Docs are part of the cutover. Stale specs that claim generated LI is
current-only presentation are defects.

## Risks

Risk: citation parity repair could create another pseudo-verifier.

Mitigation: keep repair mechanical and bounded. It validates output structure,
not factual support.

Risk: embedded chat could duplicate generic resource-chat code.

Mitigation: all create/list/open behavior goes through resource-chat subject
helpers and `ResourceChatTab`.

Risk: hierarchy could hide omitted coverage.

Mitigation: coverage metadata and omitted-source counts are acceptance criteria.

Risk: revision metadata could duplicate the LLM ledger.

Mitigation: derive model/usage from `llm_calls`; store only revision-owned
instruction/coverage fields.

Risk: renaming UI to Dossier could trigger route/API churn.

Mitigation: UI copy can say Dossier while APIs remain `/intelligence` until a
separate rename cutover.

## Test Plan

Backend service/API:

- generate current dossier with fake structured LLM;
- generate with custom instruction;
- bad citation ordinal/marker mismatch fails or repairs before promotion;
- failed draft leaves current revision untouched;
- restore does not rewrite citation edges;
- stale source count changes on membership, podcast expansion, and re-ingest;
- large-library reduce reports coverage and omission deterministically.

Resource graph:

- `library_intelligence_revision` citation source allowed;
- `library_intelligence_artifact` citation source forbidden;
- `build_citation_outs` returns revision citations after head movement;
- deletion cleans artifact and revision refs explicitly.

Frontend component:

- renders current dossier markdown and citations;
- shows generating while current content remains visible;
- shows historical banner and selected revision citations;
- starts chat with selected/current revision ref;
- revision rows show metadata.

E2E:

- seed a library with citable media;
- click Generate;
- wait for SSE done/refetch;
- assert markdown and citation chip are visible;
- click citation and assert reader target;
- open chat and assert the chat subject/context includes the LI revision and
  companion library.

Static/negative gates:

- grep gates listed in this spec;
- frontend/backend ResourceRef scheme parity;
- docs consistency check for current-only LI carveout language.

# Graph-Built Note Citation Activation - Hard Cutover

Status: Spec, not implemented

Author/date: Codex design synthesis, 2026-06-17

Type: Hard cutover. No legacy wire shapes, no compatibility shims, no fallback reconstruction, no parallel citation paths.

## 0. North Star

Graph-built citations are the reader activation contract.

Every citation edge whose target resolves to note-owned text must produce the same typed reader target, whether the citation is shown while a chat response is streaming, after a reload, inside Library Intelligence, inside Oracle answers, or from resource graph connection UI.

The final state is:

- `resource_edges` remains the source of truth for graph-built citation relationships.
- Backend graph services reconstruct target location from the citation target grain.
- `CitationOut.locator` is the only frontend citation activation input.
- `note_block_offsets` maps into the existing `NoteReaderTarget` path.
- Chat live SSE and persisted message readback expose the same backend-built citation read model.
- Frontend code does not infer media-vs-note targets from resource refs, URLs, titles, snapshots, or missing media IDs.
- Non-activatable targets stay honestly non-activatable; they do not masquerade as reader targets.

## 1. Triggering Defect

Backend citation edges can point at notes, and backend graph resolution already knows how to reconstruct `note_block_offsets` for note-owned targets. The live reader citation adapter still degrades non-media targets into link-only citations because the chat live citation event carries a reduced edge entry instead of a backend-built `CitationOut`.

Observed split:

- Persisted/cold message readback can receive graph-built citations with typed locators.
- Live chat SSE emits citation index entries without `media_id` or `locator`.
- The frontend live update hook builds `CitationOut` objects with `media_id: null` and `locator: null`, which makes note citations link-only.
- Resource graph connection activation has a separate note-target early return, so document-map/resource-graph note targets can also fail to activate even when the backend supplied a note locator.

This is not a note adapter problem. It is a broken owner boundary: the stream path bypasses the graph citation read model.

## 2. Relevant Existing Contracts

### Backend

- `python/nexus/services/resource_graph/citations.py`
  - Owns conversion from citation edges to `CitationOut`.
  - Should be the single projection owner for citation read models.
- `python/nexus/services/resource_graph/resolve.py`
  - Owns target-grain reconstruction.
  - Already resolves direct `note_block`, note-owned `content_chunk`, and note-owned `evidence_span` targets into `note_block_offsets`.
- `python/nexus/schemas/retrieval.py`
  - Defines the canonical note locator:

    ```json
    {
      "type": "note_block_offsets",
      "block_id": "<uuid>",
      "start_offset": 0,
      "end_offset": 123
    }
    ```

  - The locator is strict. It has no `page_id`.
- `python/nexus/services/chat_runs.py`
  - Currently emits the reduced live `citation_index` event.
- `python/nexus/schemas/conversation.py`
  - Currently models the reduced live citation index entry.
- `python/nexus/services/message_trust_trails.py`
  - Uses backend-built citation outs for persisted trust trail/message readback.
- `python/nexus/services/resource_items/capabilities.py`
  - Declares `note_block` as citable, readable, attachable, and linkable.
- `python/nexus/services/notes.py`
  - Highlight-note writes create citation/resource edges and must keep note indexing fresh.

### Frontend

- `apps/web/src/lib/resourceGraph/citations.ts`
  - Already maps `CitationOut.locator.type === "note_block_offsets"` into `NoteReaderTarget`.
- `apps/web/src/lib/conversations/readerTarget.ts`
  - Defines the existing `NoteReaderTarget` shape.
- `apps/web/src/lib/conversations/readerSourceActivation.ts`
  - Dispatches note activation through the existing note-pulse path.
- `apps/web/src/lib/reader/pendingNoteActivation.ts`
  - Holds pending note activations until note content loads.
- `apps/web/src/app/(authenticated)/notes/[blockId]/NotePaneBody.tsx`
  - Consumes pending note activation and pulses the target block.
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
  - Currently reconstructs live citations from reduced stream entries and loses locators.
- `apps/web/src/lib/api/sse/events.ts`
  - Currently validates the reduced stream shape and rejects the desired typed citation payload.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - Currently has a note-locator early return in resource graph connection activation.

### Repo Rules

This cutover follows the repo's existing rules:

- One owner for each capability.
- Routes and event adapters stay thin.
- No compatibility branches for old application code.
- Collapse repeated shapes into one contract.
- Tests assert behavior and module boundaries, not implementation trivia.

## 3. Final Target Behavior

### 3.1 Live Chat Citations

When a chat answer streams a graph-built citation whose edge target resolves to note text:

1. The backend emits a live citation index payload containing the backend-built `CitationOut`.
2. That `CitationOut` contains:
   - `media_id: null`
   - `locator.type: "note_block_offsets"`
   - `locator.block_id`
   - `locator.start_offset`
   - `locator.end_offset`
   - the normal citation metadata, including source ref, deep link, kind, title, and snapshot fields.
3. The frontend stores that citation as-is.
4. `toReaderCitationData` maps it into `NoteReaderTarget`.
5. Activating the citation opens/focuses the target note and pulses the target block/range.

There is no live-only code path that manufactures `CitationOut` with `locator: null`.

### 3.2 Persisted Message Citations

Reloaded chat messages use the same `CitationOut` shape as live chat.

The same citation number in the same assistant message should have equivalent activation behavior before and after reload.

### 3.3 Resource Graph Connections

When a resource graph connection target has `target_reader.media_id: null` and `target_reader.locator.type: "note_block_offsets"`:

1. The frontend maps it to `NoteReaderTarget`.
2. Activation uses the same note activation helper as reader citations.
3. It does not return early or degrade to opening a bare note link unless the backend explicitly says there is no reader target.

### 3.4 Library Intelligence And Oracle

Library Intelligence and Oracle note citations continue to work through `CitationOut`.

This cutover must not create a second note-citation model for those surfaces.

### 3.5 Notes Search And Freshness

All note body writes that create, update, or materially change note text used as evidence must enqueue note reindexing through the note write owner.

Highlight-note body upserts are part of this contract. If highlight notes can become citation targets, their body changes must be visible to search/retrieval and future graph citation target reconstruction.

### 3.6 Non-Activatable Targets

External web, opaque corpus targets, missing note blocks, deleted evidence spans, and unresolved graph targets remain non-activatable unless the backend resolves a typed reader locator.

The UI may show links or source metadata for those citations. It must not fabricate note or media reader targets.

## 4. Architecture

### 4.1 Owner Boundary

`resource_graph.citations` is the citation read-model owner.

It owns:

- citation edge lookup
- source/target ref inclusion
- citation numbering inputs
- call into graph target resolution
- construction of `CitationOut`
- construction of any stream wrapper that needs to preserve edge identity

`chat_runs` owns when to emit chat events. It does not own citation read-model shape.

`useChatMessageUpdates` owns client-side state updates. It does not own citation target reconstruction.

### 4.2 Canonical Read Model

The canonical frontend citation activation model is `CitationOut`.

All surfaces that want a clickable reader citation consume this shape:

```ts
type CitationOut = {
  citation_number: number;
  source_ref: ResourceRef;
  target_ref: ResourceRef | null;
  kind: string;
  title: string | null;
  deep_link: string | null;
  media_id: string | null;
  locator: MediaLocator | NoteBlockOffsetsLocator | null;
  snapshot: CitationSnapshot | null;
};
```

The exact schema remains defined in backend Pydantic and mirrored in frontend schema guards. The important cutover rule is that `locator` is present whenever the graph target resolves to an activatable note or media target.

### 4.3 Live Stream Payload

Hard-cutover the chat `citation_index` event from reduced entries to backend-built citation items:

```python
class ChatRunCitationIndexItem(BaseModel):
    citation_edge_id: UUID
    citation: CitationOut


class ChatRunCitationIndexEventPayload(BaseModel):
    assistant_message_id: UUID
    citations: list[ChatRunCitationIndexItem]
```

Wire example:

```json
{
  "type": "citation_index",
  "data": {
    "assistant_message_id": "00000000-0000-0000-0000-000000000001",
    "citations": [
      {
        "citation_edge_id": "00000000-0000-0000-0000-000000000002",
        "citation": {
          "citation_number": 1,
          "source_ref": { "type": "chat_message", "id": "00000000-0000-0000-0000-000000000001" },
          "target_ref": { "type": "note_block", "id": "00000000-0000-0000-0000-000000000003" },
          "kind": "evidence",
          "title": "Research note",
          "deep_link": "/notes/00000000-0000-0000-0000-000000000003",
          "media_id": null,
          "locator": {
            "type": "note_block_offsets",
            "block_id": "00000000-0000-0000-0000-000000000003",
            "start_offset": 0,
            "end_offset": 123
          },
          "snapshot": null
        }
      }
    ]
  }
}
```

The wrapper preserves `citation_edge_id` for trust trails, debug views, and source graph references. The nested `citation` preserves the activation contract.

Delete the old reduced shape:

- no `entries`
- no `ChatRunCitationIndexEntry`
- no live stream payload with only `target_ref`, `kind`, `deep_link`, and `snapshot`
- no client reconstruction from reduced entries

### 4.4 Resource Graph Resolve

Target reconstruction belongs to `resource_graph.resolve`.

The service-level resolver should expose a reusable typed helper for graph citation/connection callers that need reader targets. That helper returns the same underlying location tuple/read model used by citation construction:

- media target: `media_id` plus media locator
- note target: `media_id: None` plus `note_block_offsets`
- unresolved target: no reader target

The public `/resource-graph/resolve` route should only be widened if an actual UI caller needs typed reader targets from that endpoint. If widened, the response must include a backend-built reader target field, not a frontend heuristic.

### 4.5 Connection Activation

Connection UI should use a single mapper:

```ts
ConnectionReaderTargetOut -> ReaderTarget | null
```

Rules:

- `media_id` plus media locator maps to media reader target.
- `media_id: null` plus `note_block_offsets` maps to `NoteReaderTarget`.
- missing locator maps to `null`.
- unknown locator type maps to `null` and should be observable in tests/logging where appropriate.

There must not be an inline note-locator early return inside `MediaPaneBody`.

### 4.6 Note Locator Contract

`note_block_offsets` is canonical and strict:

```json
{
  "type": "note_block_offsets",
  "block_id": "<uuid>",
  "start_offset": 0,
  "end_offset": 123
}
```

Rules:

- no `page_id`
- no `media_id`
- no note-page indirection
- no fallback to page-level note activation
- offsets are block-local text offsets
- the block ID is the activation identity

Docs that still describe page-owned note locators are stale and must be amended or marked historical.

## 5. Goals

- Make graph-built note citations activate note targets in live chat.
- Preserve activation parity between streamed messages and reloaded messages.
- Make resource graph connection note targets activate through the same note-reader path.
- Centralize citation read-model construction in graph services.
- Eliminate frontend target reconstruction from reduced live citation entries.
- Keep `note_block_offsets` strict and page-free.
- Ensure highlight-note body writes keep note indexing fresh.
- Align backend and frontend schemas for citation snapshot fields.
- Update docs so future work sees the owner contract, not the old split.

## 6. Non-Goals

- No generic note-page citation locator.
- No page-level fallback if a note block locator is missing.
- No frontend guessing from `target_ref.type`.
- No migration for old in-memory SSE events.
- No support for old `citation_index.entries` payloads.
- No compatibility mode for old frontend bundles.
- No redesign of citation numbering.
- No change to the `resource_edges` source-of-truth model.
- No new note-specific citation table.
- No broad reader architecture rewrite.

## 7. Scope

### Backend Files

- `python/nexus/services/resource_graph/citations.py`
  - Add or adapt a helper that returns stream-ready citation items with both edge identity and `CitationOut`.
  - Keep all target-locator construction behind graph citation/resolve services.
- `python/nexus/services/resource_graph/resolve.py`
  - Keep or expose the typed reader-target reconstruction helper used by citation and connection projections.
- `python/nexus/services/chat_runs.py`
  - Emit the new citation index payload.
  - Remove reduced-entry construction.
- `python/nexus/schemas/conversation.py`
  - Replace reduced citation index entry schemas with the hard-cutover item schema.
- `python/nexus/services/message_trust_trails.py`
  - Reuse the same projection helper if doing so removes duplicate citation queries or shape construction.
- `python/nexus/api/routes/resource_graph.py`
  - Only change if connection/resolve route read models need to expose the centralized reader target explicitly.
- `python/nexus/schemas/resource_graph.py`
  - Keep connection target schema aligned with the centralized reader target contract.
- `python/nexus/services/notes.py`
  - Ensure highlight-note body writes enqueue note reindexing.
- `python/nexus/schemas/citation.py`
  - Keep snapshot fields aligned with frontend schema guards.

### Frontend Files

- `apps/web/src/lib/api/sse/events.ts`
  - Parse the new `citation_index.citations[].citation` payload.
  - Delete the reduced-entry parser.
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
  - Store backend-built `CitationOut` objects directly.
  - Preserve `citation_edge_id` only where source/trust-trail state needs it.
  - Remove live-only `locator: null` construction.
- `apps/web/src/lib/conversations/citationOut.ts`
  - Align snapshot guard fields with backend `CitationSnapshot`.
- `apps/web/src/lib/resourceGraph/citations.ts`
  - Remains the citation-to-reader-target adapter for `CitationOut`.
  - Should not gain reduced-entry reconstruction.
- `apps/web/src/lib/resourceGraph/connections.ts`
  - Centralize connection-reader-target mapping if it is not already centralized.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - Replace inline note-locator early return with the shared activation path.
- `apps/web/src/lib/conversations/readerSourceActivation.ts`
  - Reuse existing note activation behavior.
- `apps/web/src/lib/reader/pendingNoteActivation.ts`
  - No semantic change expected; verify it covers the new activation caller.

### Docs

- `docs/cutovers/graph-built-note-citation-activation-hard-cutover.md`
  - This spec.
- `docs/architecture.md`
  - Update only if it currently describes citation activation ownership.
- `docs/modules/chat.md`
  - Update live citation event contract if documented there.
- `docs/modules/reader-implementation.md`
  - Update note citation activation contract if documented there.
- `docs/cutovers/notes-pages-evidence-unification-hard-cutover.md`
  - Amend or mark historical where it describes page-owned notes or `note_block_offsets.page_id`.
- `docs/cutovers/generation-run-harness-hard-cutover.md`
  - Amend only if current docs still claim a contradictory live citation payload.

## 8. API Design

### 8.1 Backend Schema

New hard-cutover schema:

```python
class ChatRunCitationIndexItem(BaseModel):
    citation_edge_id: UUID
    citation: CitationOut


class ChatRunCitationIndexEventPayload(BaseModel):
    assistant_message_id: UUID
    citations: list[ChatRunCitationIndexItem]
```

Validation rules:

- `citations` is ordered by `citation.citation_number`.
- `citation_edge_id` is required.
- `citation` is required.
- `citation.locator` may be `null` only when the backend cannot resolve an activatable reader target.
- `citation.locator.type == "note_block_offsets"` must include block offsets and must not include page fields.

### 8.2 Frontend Event Model

Frontend stream event type:

```ts
type CitationIndexEvent = {
  type: "citation_index";
  data: {
    assistant_message_id: string;
    citations: Array<{
      citation_edge_id: string;
      citation: CitationOut;
    }>;
  };
};
```

State application:

```ts
message.citations = data.citations.map((item) => item.citation);
```

Edge IDs can be retained separately for trust trail/source references if the current message update state needs them. They are not part of reader activation.

### 8.3 Reader Activation Model

The activation adapter remains:

```ts
CitationOut -> ReaderCitationData | null
```

For notes:

```ts
{
  kind: "note",
  blockId: locator.block_id,
  startOffset: locator.start_offset,
  endOffset: locator.end_offset
}
```

For media:

```ts
{
  kind: "media",
  mediaId: citation.media_id,
  locator: citation.locator
}
```

The adapter must not inspect `target_ref.type` to invent a reader target.

## 9. Capability Contract

### 9.1 `note_block`

`note_block` is a first-class citable target.

Capabilities:

- readable body
- citable result type
- attachable
- linkable
- graph-edge target
- reader-activatable when resolver returns `note_block_offsets`

### 9.2 `content_chunk` And `evidence_span`

`content_chunk` and `evidence_span` can resolve to notes when their ownership chain points to note-owned content.

The caller should not care whether the edge target is:

- direct `note_block`
- note-owned `content_chunk`
- note-owned `evidence_span`

All three resolve to the same public note locator when activatable.

### 9.3 Media Resources

Media targets continue to resolve to media reader locators.

No media behavior should depend on note activation changes.

### 9.4 External And Opaque Resources

External resources may have `deep_link` and metadata but no reader locator.

The UI should treat them as source links, not failed note activations.

## 10. Composition With Existing Systems

### Chat

Chat uses the graph citation projection for both live events and persisted message output. Streaming should no longer have a weaker citation shape than reload.

### Trust Trail

The trust trail can keep edge identity through `citation_edge_id`. It should not require a reduced citation model.

### Resource Graph

Resource graph edges remain authoritative. No citation activation state is stored separately from edges and resolvable target grain.

### Reader

The reader only sees typed reader targets. It does not know how graph edges, retrieval chunks, or evidence spans were resolved.

### Notes

Notes own text indexing and activation by block ID. Citation activation should pulse the block after the note document is available.

### Search And Retrieval

Search/retrieval may produce note-owned chunks. Graph resolution converts those internal targets into public `note_block_offsets` when they are cited.

### Library Intelligence

Library Intelligence should keep using `CitationOut`. This cutover must not fork its citation path.

### Oracle

Oracle should keep using `CitationOut`. Existing note citation behavior is precedent and regression coverage.

## 11. Key Decisions

### D1. Stream `CitationOut`, Not A Reduced Citation Entry

The frontend needs `locator` to activate notes. The backend already owns locator reconstruction. Therefore the live stream must carry `CitationOut`.

### D2. Preserve Edge Identity With A Wrapper

`citation_edge_id` remains useful for graph/debug/trust-trail flows. It belongs in a wrapper beside the read model, not inside a reduced replacement for it.

### D3. Do Not Use Frontend Target Heuristics

The frontend must not infer note activation from `target_ref.type === "note_block"` or from a `/notes/...` URL. That creates false positives and diverges from graph resolution.

### D4. Keep `note_block_offsets` Page-Free

The current strict locator is block-owned. Reintroducing `page_id` would revive stale page-owned-note assumptions and split activation identity.

### D5. Fix Connection Activation With The Same Reader Target Contract

Resource graph connection targets and citation targets are the same activation problem. They should map through the same note/media reader-target distinction.

### D6. Reindex At The Note Write Owner

If a note write changes text that can be cited or searched, the note service must enqueue reindexing there. Downstream readers should not compensate for stale note indexes.

### D7. Hard Cutover Means Delete Old Shapes

The old `citation_index.entries` shape should be removed from backend schemas, frontend parsers, tests, and fixtures in the same implementation.

## 12. Implementation Slices

### Slice 0 - Red Contract Tests

Add failing tests before the cutover implementation:

- backend live citation index schema can carry `CitationOut` with `note_block_offsets`
- frontend SSE parser accepts new `citations[].citation` payload
- frontend chat message update stores backend-built locator
- citation activation maps live streamed note citation to `NoteReaderTarget`
- connection target activation maps note locator to `NoteReaderTarget`
- highlight-note body write enqueues note reindex

### Slice 1 - Backend Projection Owner

Add or adapt a helper in `resource_graph.citations`:

```python
def build_citation_index_items_for_source(...) -> list[ChatRunCitationIndexItem]:
    ...
```

The exact function name can follow local naming, but the ownership rule is fixed: chat does not construct reduced citation read models.

### Slice 2 - Chat Stream Hard Cutover

Change `_emit_citation_index` to call the projection helper and emit `citations`.

Delete:

- reduced entry construction
- old schema classes
- tests that assert the reduced shape

### Slice 3 - Frontend Stream Hard Cutover

Change SSE parsing and message update logic to consume:

```ts
data.citations[].citation
```

Delete:

- reduced-entry frontend types
- live-only `CitationOut` reconstruction with null locators
- old fixtures using `entries`

### Slice 4 - Connection Activation

Centralize connection target mapping and remove the note-locator early return in `MediaPaneBody`.

Use the same note activation path used by `CitationOut` activation.

### Slice 5 - Highlight Note Reindexing

Ensure `set_highlight_note_body_pm_json` or its owner-level equivalent enqueues note reindex after successful note body upsert.

The reindex event should use the same note-block owner identity as other note body mutations.

### Slice 6 - Schema And Docs Alignment

Align frontend `CitationSnapshot` guard with backend fields, including `summary_md` if it remains part of the backend schema.

Amend stale docs that imply:

- note locators have `page_id`
- note evidence is page-owned
- live chat citation events carry reduced entries

### Slice 7 - Acceptance Pass

Run targeted backend and frontend tests, then a small browser/manual smoke if the changed frontend surface is not already covered by component tests.

## 13. Acceptance Criteria

### AC1. Live Note Citation Activation

Given a streamed assistant message with a graph-built citation edge targeting a note block, clicking the citation opens/focuses the note and pulses the cited block/range before any page reload.

### AC2. Reload Parity

The same message after reload exposes a citation with the same activation behavior and equivalent `CitationOut.locator`.

### AC3. Note-Owned Chunk/Span Activation

Citation edges targeting note-owned `content_chunk` or `evidence_span` resolve to `note_block_offsets` and activate notes, not link-only sources.

### AC4. Connection Target Activation

A resource graph/document-map connection target with `note_block_offsets` activates the note target through `NoteReaderTarget`.

### AC5. No Reduced Stream Shape

The old `citation_index.entries` shape is absent from backend schemas, frontend parsers, tests, and fixtures.

### AC6. No Frontend Reconstruction

The frontend no longer constructs live citations with `media_id: null` and `locator: null` from reduced graph entries.

### AC7. Locator Strictness

All tests and docs for `note_block_offsets` use `block_id`, `start_offset`, and `end_offset` only. No `page_id`.

### AC8. Highlight Note Freshness

Highlight-note body changes enqueue note reindexing through the note write owner.

### AC9. Snapshot Schema Parity

Frontend and backend citation snapshot schemas agree on supported fields.

### AC10. No Regression For Media Citations

Media citations still activate existing media reader targets.

### AC11. No Fake Activation For External Targets

External/unresolved targets remain link-only or non-activatable without fabricated reader targets.

## 14. Negative Gates

These searches should be clean or intentionally historical after implementation:

```bash
rg "ChatRunCitationIndexEntry|citation_index.*entries|entries:.*citation" python apps docs
rg "media_id: null,\\s*locator: null" apps/web/src
rg "note_block_offsets.*page_id|page_id.*note_block_offsets" python apps docs
rg "locator\\.type === [\"']note_block_offsets[\"'].*return" apps/web/src
```

Expected remaining references:

- historical migration/spec notes explicitly marked historical
- tests asserting old docs are gone, if any
- schema definitions for the current hard-cutover payload

## 15. Verification Plan

Backend targeted tests:

```bash
pytest \
  python/tests/test_resource_graph_edges.py \
  python/tests/test_oracle.py \
  python/tests/test_chat_runs.py \
  python/tests/test_message_citation_contracts.py \
  python/tests/test_notes.py
```

Frontend targeted tests:

```bash
cd apps/web
bunx vitest run --project unit \
  src/lib/conversations/citations.test.ts \
  src/lib/conversations/readerTarget.test.ts \
  src/components/chat/useChatMessageUpdates.test.tsx \
  src/components/chat/AssistantMessage.test.tsx \
  src/__tests__/components/LibraryIntelligencePane.test.tsx
```

If resource graph connection activation has browser-only behavior, add a focused component or Playwright test that clicks a note-backed connection target and asserts pending note activation.

## 16. Duplicate Patterns To Consolidate

### 16.1 Citation Projection

Current duplication risk:

- persisted message readback uses backend-built `CitationOut`
- live chat stream emits reduced entries
- frontend rebuilds partial `CitationOut`

Consolidation:

- one backend projection helper returns edge ID plus `CitationOut`
- live and persisted paths consume the same read model

### 16.2 Note Reader Target Mapping

Current duplication risk:

- `CitationOut` already maps note locators correctly
- connection activation has inline media/note branching and a note early return

Consolidation:

- one shared mapping from backend reader target output to frontend `ReaderTarget`
- both citation activation and connection activation use the same note activation primitive

### 16.3 Locator Shape Knowledge

Current duplication risk:

- backend schema, frontend schema guard, docs, and older cutover text disagree about `page_id`

Consolidation:

- backend schema is canonical
- frontend guard mirrors canonical fields
- docs state block-owned locator only

### 16.4 Citation Snapshot Shape

Current duplication risk:

- backend snapshot includes fields the frontend guard may drop

Consolidation:

- generated schema would be ideal long term
- in this repo, keep one explicit frontend guard with tests against backend fixture shape

## 17. SME Moves

A subject matter expert would not patch note links in the UI first. They would:

1. Identify the authoritative citation source.
2. Compare live, persisted, and adjacent graph surfaces.
3. Find the first place typed location is lost.
4. Move the full read model across that boundary.
5. Delete weaker duplicate shapes.
6. Preserve source edge identity separately from activation data.
7. Assert note locators at the graph service boundary.
8. Assert activation at the frontend reader boundary.
9. Sweep docs and schemas for stale page-owned assumptions.
10. Add negative gates so the old shape cannot quietly return.

The professional fix is therefore a contract cutover, not a note-specific click handler.

## 18. Risks And Controls

### Risk: Stream Payload Size

`CitationOut` is larger than the reduced entry.

Control: citation index events are small relative to answer content and should be emitted once per assistant message citation set. If this becomes material, optimize `CitationOut` itself, not a weaker live-only shape.

### Risk: Tight Backend/Frontend Schema Coupling

The frontend parser will reject malformed events.

Control: this is desired. Stream contracts should fail loudly in tests instead of silently producing link-only citations.

### Risk: Connection Activation Scope Creep

Media pane code is large and easy to patch locally.

Control: extract only the target mapping/activation seam needed for note reader targets. Do not redesign the pane.

### Risk: Stale Docs Confusing Future Work

Older cutover docs may describe historical states.

Control: mark historical contradictions explicitly or amend current architecture docs. Do not leave current-state docs saying `page_id` belongs in `note_block_offsets`.

## 19. Final State Checklist

- `resource_graph.citations` builds graph citation read models for live and persisted callers.
- `chat_runs` emits `citation_index.citations[].citation`.
- Frontend SSE parser accepts the new hard-cutover payload only.
- Frontend chat state stores backend-built `CitationOut` values.
- `note_block_offsets` citations activate `NoteReaderTarget` before and after reload.
- Resource graph connection note targets activate notes.
- Highlight-note writes enqueue note reindexing.
- Backend/frontend citation snapshot schemas are aligned.
- Stale note-page locator docs are corrected or marked historical.
- Negative gates show no old reduced citation index path in active code.

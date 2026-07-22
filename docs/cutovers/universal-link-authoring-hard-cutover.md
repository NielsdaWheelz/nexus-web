# Universal Link Authoring Hard Cutover

Status: SPECIFICATION
Author: Codex
Type: hard cutover; one-user prototype; production-grade invariants
Date: 2026-07-20
Open questions: none

SME synthesis: Codex's repo-grounded architecture, data, search, reader, product,
accessibility, and production-engineering review; no external endorsement.

## Decision

Replace reader **Cite** with the universal **Link** action.

Rationale: the live action writes a neutral user/context edge, not citation
ordinal, attribution, snapshot, or source-authored apparatus.

```text
selection or ResourceRef
  -> Link
  -> universal resource-target search
  -> durable endpoint materialization
  -> one neutral user/context resource_edge
  -> Connections + optional Link note
```

Product language:

- **Link**: user verb and primary chain-link action.
- **Connection**: read/manage surface.
- **Link note**: optional rationale, one ordinary note per Link.
- **Citation**: generated or source-authored evidence/attribution; unchanged.

Supersession is narrow and implementation-grounded:

- `second-apparatus-hard-cutover.md` is shipped at `92d6f122`; its stale
  `Status: Spec` must become `IMPLEMENTED`. This spec replaces only Cite,
  cross-document footnote presentation, direct derived user endpoints, the
  generic public user-edge writer, and associated tests/gates.
- `resource-discovery-link-citation-spine-hard-cutover.md` remains authoritative;
  only its implication that a direct `evidence_span` endpoint can be a durable
  user Link is superseded.
- `resource-provenance-graph-hard-cutover.md` is superseded only for user-authored
  relation direction/dedupe, direct derived endpoints, and the public edge writer;
  provenance capture remains authoritative.
- `resource-graph-product-spine-hard-cutover.md` already requires undirected
  user-link dedupe. This spec fixes the live gap: duplicate creation raises from
  `edges.py` instead of idempotently returning, and its broad index overlaps
  ordered adjacency.
- `incoming-connections-reader-sidecar-hard-cutover.md` already requires verbless
  user-link copy. Only its typed incoming/outgoing direction for neutral Links is
  superseded.
- `resource-capability-registry-hard-cutover.md` is narrowed only where scalar
  `linkable` cannot distinguish direct from materialized user endpoints.
- `current-only-artifacts-hard-cutover.md` is superseded only where refresh
  deletes authored Highlights or relations touching replaceable rows.

Generated citations, source-authored apparatus, Synapse/assistant origins, Oracle
internals, and stance gesture/meaning remain authoritative. Stance changes here
are endpoint durability and writer ownership, not a UX redesign.

## Posture

Hard cutover. No feature flag, dual write/read, old payload, compatibility alias,
fallback picker, client-side target inference, or legacy route remains.

One neutral Link exists per user and unordered endpoint pair. Only orderless
`origin=user, kind=context` Link rows are canonicalized by total `(scheme, id)`
order. Ordered adjacency keeps authored order/direction. Repeated or reverse Link
creation returns the existing Link. Stance remains directional and may coexist.

## Scope And Goals

1. Link any visible, durable, admissible `ResourceRef`, including same-document
   Highlights; reject self/capability/visibility violations and passage candidates
   without unique durable quote identity.
2. Support fresh and existing Highlights across web, EPUB, transcript, and PDF.
3. Make arbitrary passage targets durable across reindex/reingest.
4. Use central hybrid search for Link and a central lexical fast path for note
   references through one reusable target-search owner.
5. Provide confirmation-only mutation, Remove, immediate creation Undo, and honest
   loading/empty/error/unresolved states.
6. Keep authored Highlights, Links, and Link notes when derived artifacts change.
7. Delete the Cite picker, ObjectRef search/hydration lane, generic public edge
   writer, duplicated picker state, and stale terminology.

## Non-goals

- No relation taxonomy, graph canvas, AI suggestions, or automatic linking.
- No raw external-URL endpoint; ingest/capture a URL as a Resource first.
- No threaded comments, replies, reactions, notifications, or collaboration.
- No multiple notes per Link; one rich note is sufficient.
- No historical source versions or citation snapshot on user Links.
- No permanent `evidence_span`, `content_chunk`, `fragment`, or apparatus-row ID.
- No passage-anchor daemon, persisted resolution status, or maintained
  current-row pointer.
- No new resource-creation flow inside the picker.
- No new public `GET /search` result type, SearchKind, or search-UI surface.
- No stance UX redesign.

## Invariants

1. `ResourceRef` is identity; `resource_edges` is relationship storage.
2. User/context Links are neutral, canonical unordered pairs and unique per user.
3. Context Link and stance may coexist. At most one stance exists per user and
   unordered pair; its stored direction carries the stance.
4. A Link, stance, or note-body reference never persists an `evidence_span`,
   `content_chunk`, `fragment`, `reader_apparatus_item`, or
   `oracle_passage_anchor` endpoint. Ordered adjacency is a separate shape.
5. Derived passage hits materialize/reuse `passage_anchor:<id>` before persistence.
6. Fresh reader selections materialize as Highlights only when Link confirmation
   succeeds. Cancel performs zero writes.
7. Existing Highlights are reused and never deleted by Link/Undo.
8. Immediate creation Undo removes only the Link. The Highlight remains authored
   user data.
9. Reindex and source refresh never delete Highlights or passage anchors. Failed
   resolution is visible and non-navigable, never silent deletion or wrong fallback.
10. Server-side visibility and capabilities govern admission before pagination and
    are revalidated in the mutation transaction.
11. Link-note structure is graph-owned; prose remains note-owned.
12. Generic Connections reads fold structural Link-note edges into one Link row.

## Target Behavior

### Reader

1. Fresh selection or existing Highlight exposes primary **Link…** with the
   conventional chain icon in the existing popup/action bar.
2. Link opens one searchable dialog. It accepts text or an exact ResourceRef.
3. Results include direct Resources, existing Highlights, and passage candidates.
4. Choosing a result is confirmation. While committing, the row/dialog is busy and
   duplicate submission is disabled.
5. Results already connected to a durable source stay ranked and show a textual
   **Linked** state. Choosing one returns `created=false` and closes with
   `Already linked · View connection`; it never offers Undo or inline Remove.
6. A newly created Link closes with
   `Linked to <label> — Undo · Add note to link`.
7. Failure keeps the dialog and selection open with an inline error and Retry.
8. Stable Link rows/details expose Remove and context-scoped Add/Edit/Remove note
   controls with endpoint-specific accessible names.
9. Same-document Highlight-to-Highlight Links work. Self-link does not.

Fresh PDF selections use their true page-space quads. Existing PDF Highlights use
the same path. Search-derived PDF passages become passage anchors, not visible
Highlights.

### Other resources

`ConnectionsSurface` accepts one canonical `resourceRef`; **Connect** becomes
**Link** for `context`. Its existing kind selector remains: `context` calls Link,
while `supports`/`contradicts` call the stance command. Attach remains outside the
picker: existing ingest creates a `media` Resource, then Link connects it. If Link
fails, the ingested media remains visible with Retry; no upload is rolled back.
Row removal dispatches by relation: neutral Link to Link DELETE, user stance to
stance DELETE, and Synapse to its existing dismiss command. Every existing
Link/Connections authoring surface can target every admissible Resource; adding
new authoring chrome to every Resource surface is out of scope.

### Notes

Note `@`, selected-text Mod-K, and `[[...]]` reuse target search, rows, keyboard
behavior, loading, and errors. They use the one-character-capable lexical-only
`purpose=reference` profile, preserve note-body substring matching, accept direct
Resource targets only, and insert the existing ProseMirror `object_ref`. Note save
remains the sole `note_body` edge writer. They never call Link, materialize a
passage, or invoke an embedding provider.

## Final Architecture

```text
services/search/ ------------------- one pre-projection candidate engine
        |                                            |
        | /search discovery                          | target candidates
        v                                            v
resource_items.targets -----------------> ResourceTargetOut
        |                                 capability + visibility + activation
        v
shared frontend target controller/listbox
        |-- LinkTargetDialog -----------> resource_graph.user_relations
        |                                  |-- create/reuse Highlight
        |                                  |-- create/reuse passage_anchor
        |                                  `-- create/reuse canonical Link
        |-- Connections composer --------> same Link command
        `-- note @ / Mod-K / [[ ----------> insert object_ref only

resource_edges -> resource_graph.connections -> ConnectionOut(link_note=...)
passage_anchors/highlights -> current-content resolver -> reader activation
```

| Concern | Sole owner |
|---|---|
| Identity grammar | `services/resource_graph/refs.py` |
| User-Link/mention capability | `services/resource_items/capabilities.py` |
| Search candidate retrieval/ranking | `services/search/candidates.py` |
| Target admission/projection | `services/resource_items/targets.py` |
| Passage-anchor identity/materialization | `services/passage_anchors.py` |
| Locator-resolution orchestration | `services/locator_resolver.py` |
| Format quote matching | `services/text_quote.py`, `services/pdf_quote_match.py` |
| Link/stance/link-note mutation | `services/resource_graph/user_relations.py` |
| Low-level edge persistence | `services/resource_graph/edges.py` |
| Connection read composition | `services/resource_graph/connections.py` |
| Edge-to-local-reader-row projection | `services/reader_connections.py` |
| Highlight persistence/resolution | `services/highlights.py` |
| Shared frontend target state/listbox | `lib/resources/*` + `components/resources/*` |
| Reader Link session | `lib/reader/useLinkComposer.ts` |

Routes and BFF files parse/proxy only. Consumers do not query resource tables,
derive target refs, or switch on schemes.

## Capability Contract

Replace ambiguous `linkable` with an explicit graph sub-policy; do not keep an
alias.

```python
UserLinkTargetMode = Literal["none", "direct", "materialize_passage"]

@dataclass(frozen=True, slots=True)
class ResourceUserRelationPolicy:
    user_link_source: bool
    user_link_target: UserLinkTargetMode

    @property
    def note_reference_target(self) -> bool:
        return self.user_link_target == "direct"
```

Policy classes:

- Direct source/target/reference: `media`, `library`, `highlight`, `page`,
  `note_block`, `conversation`, `message`, `oracle_reading`,
  `artifact`, `artifact_revision`, `contributor`, `podcast`, `passage_anchor`.
- Passage candidate only: `evidence_span`, `content_chunk`, `fragment`,
  `reader_apparatus_item`, `oracle_passage_anchor`.
- None: `external_snapshot`.

Every `ResourceScheme` has one explicit policy row. Backend helpers and the
hand-maintained TypeScript projection are exhaustive and parity-tested; the
`.generated.ts` filename does not imply code generation. Internal citation,
Synapse, and assistant edge policies remain origin-owned and may use derived refs;
this policy governs user-authored relations and note references only.

## Passage Anchor

`passage_anchor` is user-owned passage identity, not an index row. Its owner,
version, normalized quote, and key are immutable; `locator_hint` is replaceable.

```text
passage_anchors
  id           uuid primary key
  user_id      uuid FK users.id
  owner_scheme text                    # media | note_block
  owner_id     uuid                    # validated polymorphic owner; no FK
  selector_version smallint
  anchor_key   text                    # sha256(canonical normalized quote)
  selector     jsonb                   # quote identity + non-identity locator_hint
  created_at   timestamptz

  UNIQUE (user_id, owner_scheme, owner_id, selector_version, anchor_key)
    name: uq_passage_anchors_identity
```

No status, error, snapshot, tags, historical version, current-span pointer, or
`updated_at`. Owner visibility and explicit owner cleanup replace a polymorphic
FK. Retargeting creates/reuses another anchor.

`PassageSelector` separates identity from locator hints:

```text
quote:        exact + prefix + suffix
locator_hint:
  | text: fragment/section + start/end offsets
  | pdf:  page number + page-space quads
  | time: start/end milliseconds
```

`anchor_key` hashes only canonical JSON of `{exact, prefix, suffix}`;
`selector_version` remains a separate uniqueness column.
Strings are Unicode NFC, CRLF/CR becomes LF, every Unicode whitespace run becomes
one U+0020, and ends are trimmed. JSON keys are sorted, UTF-8 encoded, and compact.
The server recomputes prefix/suffix from current owner text as the nearest 64
normalized Unicode scalar values on each side (shorter only at boundaries); caller
context length never changes identity.
Derived IDs, offsets, times, DOM paths, PDF quads, rectangle order, and
floating-point encodings never affect identity. Locator integers use base-10 with
no leading zero; non-integral geometry uses a fixed decimal string without
exponent or trailing zero. Locator numbers remain replaceable hints. A
search-derived PDF anchor requires nonempty quote identity; geometry-only PDF
selections are Highlights.

Materialization converts a current search locator into this selector. The shared
`locator_resolver` uses the hint, then the existing unique/ambiguous/no-match
matchers in `text_quote.py` and `pdf_quote_match.py`. Highlights and passage
anchors call the same resolver. Ambiguity/no-match returns explicit unresolved;
it never selects the first occurrence. Exact text is the last-known excerpt.
Before create/reuse, the normalized quote must resolve uniquely within its owner.
Repeated identical quote/context is a typed ambiguous-target refusal; locator
geometry never disambiguates identity. An existing anchor that later becomes
ambiguous remains durable but unresolved.

Oracle passage anchors remain Oracle-owned precedent; tables/schemes do not merge.

## Highlight Durability

- Fragment IDs/offsets are locator caches, not Highlight identity.
- Drop `trg_highlight_fragment_anchor_delete_core` and
  `delete_fragment_highlight_after_anchor_delete()`.
- Drop the `highlight_fragment_anchors.fragment_id` FK and treat that UUID as a
  disposable cache pointer; LEFT JOIN reads detect a missing fragment and resolve
  by quote.
- Recreate `highlights.{user_id,anchor_media_id}`,
  `highlight_fragment_anchors.highlight_id`,
  `highlight_pdf_anchors.{highlight_id,media_id}`, and
  `highlight_pdf_quads.highlight_id` with default non-cascading behavior; remove
  DB/ORM cascade ownership. Ordinary Highlight deletion explicitly removes
  graph/view-state attachments, then PDF quads, PDF/fragment anchor, and Highlight.
- Remove explicit Highlight-root deletion from web, EPUB, transcript-current, and
  podcast-transcription refresh. True media deletion uses explicit cleanup.
- Media-wide reads start from `highlights` with LEFT JOINs. Missing cache children
  resolve through the shared quote resolver and may be recreated.
- Unresolved Highlights remain in the sidecar/Connections surface and may be
  removed or retargeted; they are not painted at an incorrect location.
- True media/note owner deletion explicitly removes touching graph/view state and
  Link-note motifs, then passage anchors and Highlight children/root, preserving
  detached note prose.

## Graph Shapes

Neutral Link:

```text
min(A, B) -- origin=user, kind=context --> max(A, B)
```

Optional Link note:

```text
note_block:N -- origin=link_note, kind=context --> A
note_block:N -- origin=link_note, kind=context --> B
```

Rules:

- Exactly one ordinary note per Link; no new content/comment table.
- `link_note` attachment edges are structural and may be written only by the Link
  service.
- Ordinary body mentions remain separate `note_body` edges.
- `ConnectionOut` returns `direction="undirected"` and optional `link_note` for a
  user/context Link. Structural attachment rows never render separately.
- Delete Link note: delete the note and its attachment edges; preserve Link.
- Remove Link: detach attachment edges; preserve authored note as standalone prose.
- Delete endpoint/media: clean relation/attachments explicitly; preserve detached
  note prose.
- Link-note mutation selects the Link and completes the motif inside one retryable
  serializable transaction; no explicit lock is added.
- Link/endpoint cleanup removes `resource_view_states` before its edge and removes
  both motif halves; no malformed half-motif survives.

Drop `uq_resource_edges_context_pair`. Canonicalize only neutral Link rows matching
the exact predicate `origin='user' AND kind='context' AND ordinal IS NULL AND
snapshot IS NULL AND source_order_key IS NULL AND target_order_key IS NULL`;
never canonicalize an ordered edge. Add:

- `uq_resource_edges_user_context_link_pair`, a partial unique index over
  `(user_id, source_scheme, source_id, target_scheme, target_id)` with that exact
  predicate;
- `uq_resource_edges_user_stance_directed_pair`, a partial unique index over the
  same user-scoped directed columns, excluding `kind`, for orderless
  `supports|contradicts`;
- a directed non-user orderless-pair index; retain
  `uq_resource_edges_source_order`.

Canonical ordering is service-owned and defect-tested, not a new business
`CHECK`. Stance direction remains stored; one stance per unordered pair is
transaction-enforced by selecting both orientations, while the directed index
catches same-orientation races. Link, stance, and ordered adjacency may coexist on
the same endpoints. `adjacency.py` must stop deleting the neutral Link before
writing an ordered occurrence, and must reject duplicate target refs in application
validation so dropping the broad index does not weaken outline semantics.

Add `uq_passage_anchors_identity`, `uq_resource_edges_user_context_link_pair`,
`uq_resource_edges_user_stance_directed_pair`, and `highlights_pkey` to
`RETRYABLE_UNIQUE_CONSTRAINTS`; the replay constraint is already present. Every
retry reloads state. Different mutation IDs racing on a Link converge to one
`created=true` and one `created=false`, never a raw `IntegrityError`.
`edges.create_edge` must return the existing row for the neutral-Link constraint,
not raise its current duplicate `ValueError`; ordered and stance conflicts retain
their own typed semantics.

## Reader Projection

- `media_owned_reader_children` includes viewer-owned `passage_anchor` rows whose
  owner is that media.
- Neutral `ConnectionOut.direction` is `undirected`; presenters never infer its
  meaning from canonical storage direction.
- `reader_connections.py` asks `passage_anchors.py` for the current locator; quote
  matching remains in the shared locator resolver.
- Emit one reader row per local endpoint. A cross-document Link anchors once in
  each reader; a same-media Link between two local passages emits two rows. Each
  row activates the opposite endpoint and has stable identity
  `edge:{edge_id}:anchor:{local_ref}`.
- `reader_document_map.py` and its DTOs carry `passage_anchor_id` through margin
  and Evidence projections. Unresolved local anchors remain visible in the
  unanchored collection with no false jump.

## Resource Target Search

```text
POST /resource-items/targets/search
```

```text
ResourceTargetSearchRequest
  q: string
  purpose: "link" | "reference"
  source_ref: ResourceRef | omitted   # existing durable Link source
  schemes: ResourceScheme[] | omitted
  exclude_refs: ResourceRef[]
  cursor: string | omitted
  limit: 1..20

ResourceTargetOut =
  | { kind: "resource", item: ResourceItemOut,
      existing_link_id: UUID | omitted }
  | { kind: "passage", candidate_ref, source: ResourceItemOut,
      label, excerpt, activation, existing_link_id: UUID | omitted }
```

Rules:

1. Extract a typed internal candidate seam after retrieval/ranking but before
   pagination and `SearchResultOut` projection. Ordinary and target search share
   it; `service.py` is no longer the monolithic pre-projection owner.
2. `purpose=link` uses the central hybrid profile and may emit passage candidates.
   `purpose=reference` accepts one character; uses exact/prefix/substring/FTS;
   emits direct targets only; and never calls `build_query_embedding`.
3. Add target-only resource-metadata retrievers inside `services/search/` for
   libraries, Oracle/generated outputs, and passage anchors. They return internal
   candidates, not new public search result types.
4. Keep `SEARCH_RESULT_TYPES`, `SearchKind`, ordinary `GET /search`, and its UI
   unchanged. Add backend/frontend result-taxonomy parity, including the currently
   missing frontend `artifact` discriminant.
5. Apply target policy, visibility, canonical dedupe, and exclusions before each
   source's candidate cap. Refill until the requested page is full or all sources
   are exhausted; paginate only the post-filter ranking.
6. Exact ResourceRef input resolves through `ResourceItemOut`; unauthorized and
   missing refs are masked consistently.
7. `candidate_ref` is transient and never persisted. Confirmation reloads it and
   returns a typed stale-target conflict if its current index generation is gone.
8. `source_ref` is optional because a fresh selection has no Highlight yet. Search
   performs only a non-mutating identity/Link lookup; for passages it derives the
   canonical anchor key and checks an existing anchor. It never materializes an
   anchor. Existing targets remain selectable and carry `existing_link_id`.
9. The client never maps a search-result type to a ResourceRef.

The ordinary `GET /search` remains the discovery API. Target search is a second
projection over the same internal candidate engine, not a second search engine.

## Mutation APIs

### Link

```text
POST   /resource-graph/links
DELETE /resource-graph/links/{link_id}
PUT    /resource-graph/links/{link_id}/note
DELETE /resource-graph/links/{link_id}/note
```

```text
CreateLinkRequest
  client_mutation_id
  source:
    | { kind: "resource", ref }
    | { kind: "fragment_selection", highlight_id, fragment_id,
        start_offset, end_offset, color }
    | { kind: "pdf_selection", highlight_id, media_id, page_number,
        quads, exact, color }
  target:
    | { kind: "resource", ref }
    | { kind: "passage", candidate_ref }

CreateLinkOut
  created: bool
  created_source_ref: ResourceRef | omitted
  connection: ConnectionOut
```

The service validates visibility/capabilities, creates the fresh Highlight if any,
materializes/reuses the passage anchor if any, canonicalizes endpoints, creates or
loads the Link, and records the exact response through the existing mutation replay
ledger in one retryable transaction. `highlight_id` and `client_mutation_id` are
client-stable. Exact replay preserves `created`; failure rolls back all rows.

Duplicate/reverse creation is successful idempotency (`created=false`), not another
edge and not a generic error. Self-link, invalid capability, hidden resource, and
stale passage candidate are typed failures.

Malformed input is `400`; masked missing/hidden resources are `404`; capability,
self-link, and ambiguous quote identity are `422` (the last is
`E_LINK_TARGET_AMBIGUOUS`). The three `409` cases have typed codes:
`E_LINK_TARGET_STALE`, existing `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`, and
existing `E_HIGHLIGHT_CONFLICT` when a client-stable Highlight ID names a different
selection. Retry exhaustion remains a defect/5xx. DELETE is idempotent; duplicate
creation is never a `409`.

Link-note PUT reuses normal note validation. A serializable transaction selects the
Link, checks/creates the note, and commits exactly two `link_note` attachment edges;
normal note indexing remains the note-owned post-commit follow-up.

### Stance

```text
PUT    /resource-graph/stances
DELETE /resource-graph/stances/{stance_id}
```

This replaces the generic public edge writer without changing stance UX. The stance
service selects both endpoint orientations, replaces the prior kind/direction
transactionally, and materializes a passage anchor when the focused passage
resolves; durable media is the explicit fallback. `useStanceComposer.ts` uses this
client: same stance toggles through DELETE; the opposite stance is one PUT, not a
client delete/create sequence. Connections' generic stance choice remains.

`POST/DELETE /resource-graph/edges` and frontend `createUserEdge/deleteUserEdge`
are deleted. `resource_graph.edges` remains the internal low-level writer.

## Intra-system Composition

- Search produces candidates; resource-items owns admission/activation; it never
  mutates.
- Link owns the user operation and composes transaction-scoped Highlight,
  passage-anchor, note, and edge helpers.
- Notes own ProseMirror content and derive `note_body` edges on save.
- Connections owns hydrated reads/backlinks and folds Link-note structure.
- Reader owns DOM/PDF projection only; it does not repair or persist anchors.
- Content indexing owns replaceable spans/chunks. It never cleans authored Links,
  Highlights, or passage anchors.
- Media refresh publishes new artifacts, then authored selectors resolve against
  the new current content.
- `media_deletion.py` and note-block deletion call the explicit owner-cleanup
  service before owner removal; refresh code never invokes it.

## Hard-cutover Migration

One no-downgrade migration:

1. Inventory neutral Links, stances, `note_body` edges, ProseMirror
   `object_ref|object_embed` nodes, and matching `resource_view_states`. Ordered
   edges are explicitly excluded from Link canonicalization.
2. Classify each derived or missing direct endpoint:
   - live and convertible: record its canonical anchor map;
   - missing underlying row/Highlight: it is already lost; delete the dead edge
     and its edge view state, unwrap a stale note chip to its label/text, and emit
     an exact migration report;
   - readable but unconvertible: abort with edge/note/view-state IDs, JSON path,
     and raw ref. Never guess a media fallback.
3. Create `passage_anchors`; add its scheme to every closed resource/view-state
   contract; add `link_note` origin. Its shape is service validation plus defect
   tests, not a `CHECK` or trigger.
4. Materialize/reuse anchors for live `evidence_span`, `content_chunk`, `fragment`,
   `reader_apparatus_item`, and `oracle_passage_anchor` endpoints. Rewrite edges,
   view-state resource refs, and note JSON plus its `note_body` projection together.
5. Canonicalize only orderless user/context Links. Build a loser-to-winner edge map
   for duplicates. Before deleting a loser, rebind `resource_view_states.edge_id`;
   on occurrence collision retain the latest `(updated_at, id)`, matching migration
   `0179`, then delete the redundant state and edge.
6. Drop the broad context-pair index; install the shape-owned indexes and retry
   allowlist named above. Do not alter or collapse ordered adjacency.
7. Drop the destructive Highlight trigger/function and fragment cache FK; make all
   remaining Highlight-family FKs non-cascading and route deletes through explicit
   child-first cleanup.
8. Assert zero Link/stance/note-body endpoint or persisted note node remains on a
   derived passage scheme, and no dangling Link-note/view-state motif remains.

Absent history with no surviving ref is unknowable and is not claimed as recovered.
Surviving dead refs are removed because no selector exists to preserve truthfully;
all live convertible authored data is retained.

## Consolidation And Deletion

Delete:

- `CitePicker.tsx`, CSS/tests, `useCiteComposer.ts`, Cite action/props/copy, and
  frontend `citableRefForRow` inference.
- `/object-refs/search`, `/object-refs/resolve`, both BFF proxies,
  `lib/objectRefs.ts`, `ObjectRefAutocomplete`, and their tests.
- `services/object_refs.py` after moving pin CRUD to `services/pinned_objects.py`;
  hydrate pins through `resource_items.surfaces`.
- Public generic user-edge mutation routes/client and route-local stance rewrite.
- Picker-local debounce/fetch/active-row/error implementations in Cite,
  Connections, and notes.
- Refresh-time Highlight deletion from web, EPUB, transcript-current, and podcast
  transcription lifecycles, plus the destructive anchor-delete trigger.
- User-Link `footnote` taxonomy/copy; genuine citation/footnote terminology stays.
- Dead ObjectRef hydrators, contributor adapter, scheme maps, and tests after call
  sites move.
- The **Connect** label for neutral context creation; Connections remains the
  surface noun, while its neutral action is **Link**.

Keep/adapt:

- central `services/search/` candidate retrieval/ranking, split before projection;
- `ResourceItemOut`, activation, capability manifest, and ResourceRef parser;
  move frontend `ResourceItem` normalization from note-owned `notes/api.ts` to
  shared `lib/resources/resourceItems.ts`;
- `resource_edges`, `query_connections`, Connection cards, reader projection;
- `useDebouncedFetch`, `useDialogOverlay`, and Launcher accessibility patterns;
- ProseMirror `object_ref` storage and note-body edge synchronization;
- existing Highlight creation primitives, refactored for caller-owned transaction;
- Connections stance selection and Attach, routed through stance and Link commands;
- `real-media/real-media-seed.ts::createPdfHighlightThroughVisibleSelection` and
  `real-media/upload-pdf.spec.ts` as PDF setup/text-layer precedent, plus the
  `e2e/tests/selection.ts` drag harness; PDF Link remains a new end-to-end flow.

## Files

Create:

```text
migrations/alembic/versions/<next>_universal_link_authoring.py
python/nexus/services/passage_anchors.py
python/nexus/services/search/candidates.py
python/nexus/services/search/retrievers/resource_metadata.py
python/nexus/services/resource_items/targets.py
python/nexus/services/resource_graph/user_relations.py
python/nexus/services/pinned_objects.py
python/nexus/schemas/resource_targets.py
apps/web/src/lib/resources/resourceTargets.ts
apps/web/src/lib/resources/useResourceTargetSearch.ts
apps/web/src/lib/resources/resourceItems.ts
apps/web/src/lib/resources/resourceItems.test.ts
apps/web/src/components/resources/ResourceTargetListbox.tsx
apps/web/src/components/resources/LinkTargetDialog.tsx
apps/web/src/components/resources/ResourceTargetListbox.test.tsx
apps/web/src/components/resources/LinkTargetDialog.test.tsx
apps/web/src/lib/resourceGraph/links.ts
apps/web/src/lib/resourceGraph/stances.ts
apps/web/src/lib/reader/useLinkComposer.ts
apps/web/src/lib/search/contractParity.test.ts
apps/web/src/app/api/resource-items/targets/search/route.ts
apps/web/src/app/api/resource-graph/links/route.ts
apps/web/src/app/api/resource-graph/links/[linkId]/route.ts
apps/web/src/app/api/resource-graph/links/[linkId]/note/route.ts
apps/web/src/app/api/resource-graph/stances/route.ts
apps/web/src/app/api/resource-graph/stances/[stanceId]/route.ts
python/tests/test_passage_anchors.py
python/tests/test_resource_targets.py
python/tests/test_user_relations.py
e2e/tests/universal-linking.spec.ts
```

Primary modifications:

```text
python/nexus/db/models.py
python/nexus/db/retries.py
python/nexus/errors.py
python/nexus/services/resource_graph/{refs,schemas,edges,policy}.py
python/nexus/services/resource_graph/{resolve,connections,cleanup,adjacency}.py
python/nexus/services/resource_items/{capabilities,surfaces,routing}.py
python/nexus/services/search/{service,results,ranking,projection}.py
python/nexus/services/search/retrievers/contributors.py
python/nexus/services/{locator_resolver,text_quote,pdf_quote_match}.py
python/nexus/services/{highlights,content_indexing,web_article_artifacts,epub_lifecycle}.py
python/nexus/services/media_deletion.py
python/nexus/services/transcripts/current.py
python/nexus/services/podcasts/transcription.py
python/nexus/services/{note_bodies,notes,contributors}.py
python/nexus/services/{reader_connections,reader_document_map}.py
python/nexus/api/routes/{resource_items,resource_graph,pinned_objects}.py
python/nexus/api/routes/__init__.py
python/nexus/schemas/{resource_graph,resource_items,highlights,reader,reader_document_map}.py
apps/web/src/components/{PdfReader,SelectionPopover}.tsx
apps/web/src/components/connections/{ConnectionsSurface,ConnectionsSurface.test}.tsx
apps/web/src/components/connections/ConnectionsSurface.module.css
apps/web/src/components/{highlights/*,notes/*}.tsx
apps/web/src/components/reader/{MarginRail,document-map/*}.tsx
apps/web/src/components/workspace/{WorkspaceHost,WorkspaceHost.test}.tsx
apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx
apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx
apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.test.tsx
apps/web/src/app/(authenticated)/notes/[blockId]/NotePaneBody.tsx
apps/web/src/app/(authenticated)/notes/[blockId]/NotePaneBody.ac4.test.tsx
apps/web/src/components/appnav/AppNav.tsx
apps/web/src/components/appnav/AppNav.test.tsx
apps/web/src/lib/reader/{useStanceComposer,documentMap,marginItems}.ts
apps/web/src/lib/pinnedObjects.ts
apps/web/src/lib/pinnedObjects.test.ts
apps/web/src/lib/notes/api.ts
apps/web/src/lib/notes/api.test.ts
apps/web/src/lib/notes/prosemirror/{commands,commands.test}.ts
apps/web/src/lib/resources/{resourceCapabilities.generated,resourceKind}.ts
apps/web/src/lib/resources/{resourceKind.test,resourceLocators}.ts
apps/web/src/lib/resourceGraph/{connections,connections.test,contractParity.test}.ts
apps/web/src/lib/resourceGraph/{resourceRef,resourceRef.test}.ts
apps/web/src/lib/panes/{paneRuntime,paneRuntime.test}.tsx
apps/web/src/lib/search/{types,normalizeSearchResult,searchTypeIcon,searchViewModel}.ts
apps/web/src/app/api/proxy-routes.test.ts
apps/web/src/lib/reader/secondApparatus.guards.test.ts
python/tests/{test_migrations,test_reader_connections,test_highlights,test_media_deletion}.py
python/tests/{test_resource_graph_edges,test_resource_graph_refs}.py
python/tests/test_resource_item_capabilities.py
python/tests/test_notes.py
python/tests/test_cutover_negative_gates.py
```

Delete:

```text
python/nexus/api/routes/object_refs.py
python/nexus/services/object_refs.py
python/tests/test_object_refs_routes.py
apps/web/src/app/api/object-refs/resolve/route.ts
apps/web/src/app/api/object-refs/search/route.ts
apps/web/src/app/api/resource-graph/edges/[edgeId]/route.ts
apps/web/src/app/api/resource-graph/edges/route.ts
apps/web/src/components/notes/ObjectRefAutocomplete.module.css
apps/web/src/components/notes/ObjectRefAutocomplete.tsx
apps/web/src/components/reader/CitePicker.module.css
apps/web/src/components/reader/CitePicker.test.tsx
apps/web/src/components/reader/CitePicker.tsx
apps/web/src/lib/objectRefs.test.ts
apps/web/src/lib/objectRefs.ts
apps/web/src/lib/reader/useCiteComposer.ts
apps/web/src/lib/resourceGraph/edges.test.ts
apps/web/src/lib/resourceGraph/edges.ts
```

`python/nexus/schemas/search.py` and `python/nexus/services/search/kinds.py` are
audited but intentionally unchanged: target-only candidates do not enter the
public search taxonomy.

Rename application `PinnedObjectRef` types to `PinnedResource`; the existing table
may keep its physical name. Update migration/schema and hand-maintained capability
parity. `contractParity.test.ts` drops `OBJECT_TYPES`, recursively reads the nested
policy, and compares the complete frontend projection. Update:

```text
docs/architecture.md
docs/modules/{highlight,reader-implementation,library}.md
docs/scriptorium.md
docs/cutovers/second-apparatus-hard-cutover.md
docs/cutovers/resource-discovery-link-citation-spine-hard-cutover.md
docs/cutovers/resource-provenance-graph-hard-cutover.md
docs/cutovers/resource-graph-product-spine-hard-cutover.md
docs/cutovers/resource-capability-registry-hard-cutover.md
docs/cutovers/incoming-connections-reader-sidecar-hard-cutover.md
docs/cutovers/current-only-artifacts-hard-cutover.md
```

## Implementation Order

1. Migration, passage selector/resolver, capability parity, and data preflight.
2. Highlight retention and current-content resolution.
3. Extract the pre-projection search candidate seam; add hybrid Link and lexical
   reference projections; move pins; delete ObjectRef search/hydration.
4. Link/stance/link-note commands and composed Connection read model; delete public
   generic edge mutation.
5. Shared frontend target controller/listbox; Link rename, PDF wiring, notes and
   Connections adoption; delete Cite/duplicate UI.
6. Data conversion, docs, negative gates, component/integration/E2E verification.

Slices may land on one branch but do not ship dual paths. The cutover is complete
only when old routes/files/contracts are absent.

## Acceptance Criteria

1. Primary chain-link **Link…** works from fresh and existing reflowable/PDF
   Highlights; cancel writes nothing.
2. One confirmation atomically creates/reuses Highlight, passage anchor, and Link;
   failure leaves none of the new rows.
3. Repeated/reverse concurrent calls yield one Link and one edge ID. Different
   mutation IDs return one `created=true` and one `false`; the same mutation ID
   replays the exact first response. Passage-anchor and Highlight first-insert
   races expose no raw `IntegrityError`.
4. One neutral Link, one directional stance, and one ordered adjacency occurrence
   can coexist on the same pair. Ordered edges are neither canonicalized nor
   collapsed; duplicate ordered targets remain invalid. Opposite-orientation,
   opposite-kind stance PUTs race to exactly one directed stance with no raw DB
   error. Self-link is rejected.
5. Link targets include at least media, libraries, notes, pages, Highlights,
   messages, conversations, artifacts/revisions, contributors, podcasts, and
   existing passage anchors according to visibility.
6. Web/EPUB/transcript/PDF, note-owned, apparatus, and Oracle passage candidates
   persist only as general `passage_anchor` endpoints. Oracle's mutable anchor is
   never a direct user endpoint.
7. Gold vectors prove NFC/whitespace normalization, caller context-window changes,
   and changed offsets, times, quad order, or float precision reuse one anchor ID.
   Empty-quote PDF candidates cannot materialize. Identical quote/context at two
   locations is refused as ambiguous, never silently reused or geometry-disambiguated.
8. Media and note reindex plus equivalent-content reingest preserve and resolve
   anchors, Links, and Highlights. Changed content yields visible unresolved state,
   never disappearance or wrong navigation.
9. Fragment replacement may invalidate only the Highlight locator cache. The root,
   attached note, and graph edges survive; media-wide LEFT JOIN reads still return
   unresolved Highlights. Ordinary Highlight deletion and true media/note deletion
   use explicit child-first cleanup, remove touching graph/view/motif rows, and
   preserve detached note prose.
10. Remove deletes the Link. Undo appears only for `created=true` and deletes that
   returned Link; exact mutation replay preserves that value. Existing/new
   Highlights remain.
11. Add/Edit/Remove Link note uses one normal note; Connection reads show one row,
   not the structural attachment edges.
12. Removing a Link clears its view state and both attachment motifs while
    preserving/detaching authored note prose. Removing the note preserves the Link.
13. Target and ordinary search share the pre-projection candidate engine.
    Capability/visibility/exclusions precede caps and pagination; sparse filtered
    pools refill. Public search taxonomy and output remain unchanged and backend/
    frontend discriminants, including `artifact`, have parity.
14. Notes `@`, Mod-K, and `[[` accept one-character substring queries through the
    shared controller/listbox, make zero embedding calls, and insert direct
    `object_ref`s without calling Link.
15. Already-linked targets remain ranked with a non-color-only **Linked** state.
    Selection returns `created=false`, View, no duplicate, and no Undo; Remove is
    available only in stable Link detail/Connections UI.
16. A real browser drag in the PDF text layer—not an API-seeded Highlight—captures
    true page-space quads and completes Link/Undo/Remove/opposite-end activation.
    Existing PDF Highlight behavior matches reflowable readers.
17. Media rollup discovers passage anchors. Cross-document Links anchor in both
    readers; same-media passage Links render at both local endpoints; each row opens
    the opposite endpoint. Projection never depends on canonical storage direction.
18. Connections uses Link for neutral creation, retains transactional stance
    authoring, retains ingest-then-Link Attach with visible retry semantics, and
    dispatches Link/stance/Synapse removal to their semantic commands.
19. Every existing authoring surface can target every admitted Resource; no new
    per-Resource chrome is required. Neutral Links are typed `undirected` and keep
    existing verbless copy.
20. Loading, empty, stale request, typed stale target/conflict, retry,
    keyboard/listbox, focus return, and mutation error behavior are visible and
    tested.
21. Migration deletes and reports already-lost refs, aborts only on live
    unconvertible refs, rebinds duplicate edge view state before deletion, and never
    touches ordered adjacency.
22. No Link/stance/note-body relation or note node persists a derived passage
    endpoint after migration.
23. No Cite picker/composer, ObjectRef search/resolve, public generic edge writer,
    client target mapper, refresh-time Highlight deletion, or consumer scheme
    allowlist remains.
24. Backend integration tests cover APIs/migration/races; browser component tests
    cover the shared picker; E2E covers real PDF and non-PDF Link flows.
25. Negative gates enforce deleted routes/symbols, retry-constraint registration,
    and scheme/capability/search parity. Proxy route count is intentionally updated.
26. Architecture, Highlight/reader/library modules, Scriptorium, and every narrowly
    superseded cutover state the final contract and the second-apparatus status is
    corrected to implemented at `92d6f122`.

## Final State

Nexus has one durable relationship-authoring primitive: **Link**. Search discovers
targets, capabilities admit them, durable Resources identify them, `resource_edges`
connect them, Connections presents them, and ordinary notes explain them. Derived
index rows remain replaceable implementation detail.

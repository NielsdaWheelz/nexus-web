# Reader Evidence Scope + Associations — Hard Cutover

**Status:** BUILT · Rev 3 · 2026-07-20
**Type:** Hard cutover — no legacy response, fallback presenter, compatibility decoder, or dual UI path.

## One-line

Replace the storage-shaped Evidence list with one target-centered
fact → occurrence → association contract, `Passages | Whole document` scope
tabs, semantic filters, compact disclosures, and stable document-order
navigation.

## 1. Scope and target behavior

The outer Document Map remains `Contents | Evidence`.

Evidence contains:

- `Passages`: resolved and unresolved passage-targeted facts.
- `Whole document`: facts intentionally targeting `media:<id>`.
- multi-select filters: `Highlights · Citations · Links · Synapses`.
- exact-target groups ordered by document position.
- one-hop disclosures for chats, notes, dossiers, Oracle readings, and media.
- `Needs attention` for passage facts whose target cannot resolve.

Source-authored citations render as **Source reference**. Generated citations
render as **Cited by**. Both answer the Citations filter; provenance never
collapses.

Wide readers keep physical alignment in `MarginRail`. Evidence is a stable
inventory/inspector: current-target emphasis, reciprocal hover/focus, and
click-to-jump; it does not pixel-position rich cards. Mobile uses the same
semantics in one flow list and closes after successful activation.

## 2. Goals

- **G1.** Scope is explicit and independent of target resolution.
- **G2.** Kind, provenance, placement, and associations are typed variants.
- **G3.** Exact target identity owns grouping; geometry overlap never implies identity.
- **G4.** Direct/authored relationships are disclosed once with honest labels.
- **G5.** Highlight note editing is preview-first and mounts one editor on demand.
- **G6.** One aggregate response and one decoded frontend union own Evidence.
- **G7.** Existing domain storage, `ResourceRef`, `resource_edges`, locators, and mutations remain authoritative.
- **G8.** Apparatus associations survive re-extraction when `stable_key` survives.
- **G9.** The response is complete for one media object; no silent graph truncation.

## 3. Non-goals

- No evidence table, edge resource scheme, new graph origin, or locator on an edge.
- No recursive graph browser, fuzzy co-location, saved filters, search, or virtualization.
- No message history in Document Map.
- No new generic graph or margin endpoint.
- No approximate grouping of overlapping text ranges.
- No redesign of highlight, citation, Synapse, or graph authoring.
- No Synapse → user-Link promotion workflow in this cutover; existing dismissal remains.
- No same-document two-endpoint occurrence expansion; one reader locus per edge remains.
- No repo-wide nullable/`Presence` migration outside the new Reader Document
  Map/Evidence DTO.
- No speculative repo-wide locator-resolver batching; unique locator-sensitive
  citation targets retain their canonical resolver until measurement warrants a
  shared batch owner.

## 4. Final architecture

```text
domain owners
  highlights | reader apparatus | resource graph
       ↓
Reader Document Map aggregate
  contents + embeds + canonical evidence projection + markers
       ↓
typed web decoder
       ↓
Evidence inspector ───── semantic filter state ───── MarginRail
       ↓                                                ↓
stable ordered detail                            compact alignment
```

The aggregate reads owners; it never persists or mutates Evidence.

### 4.1 Capability contract

An Evidence fact has exactly one kind:

- `Highlight`
- `SourceReference`
- `GeneratedCitation`
- `Link`
- `Synapse`

Each fact has one occurrence in the open media:

```text
PassageOccurrence
  locus_ref
  resolution: Resolved(anchor, order_key) | Unavailable(reason)

DocumentOccurrence
  media_ref
```

Associations are one hop:

- `AuthoredIn`: a generated citation originated in a chat message/Oracle output.
- `DirectlyAttached`: an object directly targets a resource-backed fact.
- `AlsoReferences`: a readable object independently targets the group's exact `locus_ref`.

`AlsoReferences` belongs to the target group. Citation/Synapse edges do not
receive graph attachments and never become `ResourceRef`s.
`DirectlyAttached` retains `edge_id`, role, origin, and `Incoming | Outgoing`
direction so graph mutations such as stance toggling remain reconstructible.

### 4.2 API design

`GET /media/{media_id}/document-map` has no Evidence pagination or
`include_unanchored` option. The service exhausts internal graph pages.

```text
ReaderDocumentMap
  media_id + media_kind + title
  status: ready | empty | partial
  source_version
    media_updated_at: Presence<datetime>
    apparatus_source_fingerprint: Presence<string>
    graph_max_updated_at: Presence<datetime>
    highlights_max_updated_at: Presence<datetime>
  diagnostics { omitted_item_counts }
  navigation: Presence<MediaNavigation>
  embeds[]
  evidence
    counts { highlights, citations, links, synapses, passages, document }
    passage_groups[]
      locus_ref
      resolution
      target_excerpt
      items[]
      also_references[]
    document_items[]
  markers[]
```

`passages` and `document` count facts in each scope, not target groups.
`target_excerpt` belongs to the exact target and is invariant under filters.
Resolved anchors carry only a media retrieval locator; unavailable occurrences
carry only `Missing | Unanchorable | Stale` as their typed reason on the wire.

The new DTO uses discriminated variants and `Presence<T>` for owned semantic
absence. It contains no generic `provenance` dictionary, string action bag, raw
`highlights`, raw `apparatus`, raw `connections`, `chat_threads`, or
`anchored/unanchored` partition.

Marker kind is semantic (`Contents`, `Embed`, or an Evidence fact kind), not a
retired lens id. Marker activation resolves through the same occurrence owner
as Evidence rows.

### 4.3 Composition rules

- Highlights supply their own anchor, editing fields, linked notes, and linked conversations.
- Apparatus is projected as one marker/group fact with authored targets, not one row per raw item.
- Each authored target carries its own typed resolution; activating a footnote,
  endnote, or bibliography target never reuses the source marker's occurrence.
- Generated `message → target` citation edges produce one `GeneratedCitation`; the owning chat is `AuthoredIn`.
- A companion `conversation → target` context edge is coalesced into that citation presentation.
- Direct edges to a represented highlight/apparatus fact become `DirectlyAttached`, not duplicate Link rows.
- Exact conversation/note edges to a passage group may become group-level `AlsoReferences`.
- Direct `media:<id>` edges become Whole-document facts.
- Unreadable related objects are omitted before serialization.
- Message activation opens its conversation at the exact message; conversation activation remains the fallback.

### 4.4 Frontend structure

- `EvidencePaneSurface` consumes only normalized groups/items.
- `Tabs` owns scope; pressable `Chip` controls own semantic filters.
- Filters are pane-session state shared with `MarginRail`; scope is pane-local.
- Rows are compact and borderless. Target activation and disclosure are separate controls.
- Disclosures render only when opened and use `aria-expanded`/`aria-controls`.
- One `editingHighlightId` owns the only mounted `HighlightNoteEditor`.
- Reader scrolling may update active styling but never keyboard focus.
- Manual pane scrolling pauses follow behavior; target activation resumes it.
- Unavailable passage facts stay under Passages → Needs attention with disabled jump.

## 5. Rules and key decisions

- **R1.** Tabs encode scope; filters encode kind; disclosures encode relationships.
- **R2.** `anchor == null` is never used to infer Whole-document scope.
- **R3.** Exact `ResourceRef` equality is the only co-location rule.
- **R4.** Source reference and generated citation remain distinct variants.
- **R5.** Related-object labels name the relationship: `Cited in`, `Attached directly`, `Also references this passage`.
- **R6.** The pane is the complete inspector; the margin is the spatial presenter.
- **R7.** All-filter-off is a filtered-empty state with `Show all`, not a true empty state.
- **R8.** Target activation closes the mobile sheet only after success.
- **R9.** Refresh cleanup preserves apparatus rows; replacement reconciles by
  `(media_id, stable_key)` and deletes only removed refs/edges. Full apparatus
  deletion belongs only to true media deletion.
- **R10.** Backend owns ACL filtering, classification, dedupe, counts, ordering, and relationship meaning.
- **R11.** Common deterministic graph activations batch behind their canonical
  route owner; repeated citation targets resolve once per graph page. The
  aggregate does not fork locator-sensitive resolution policy for query count.

## 6. Owners and reuse

Backend:

- `python/nexus/db/session.py`
- `python/nexus/schemas/reader_document_map.py`
- `python/nexus/services/reader_document_map.py`
- `python/nexus/services/reader_evidence.py`
- `python/nexus/services/reader_evidence_markers.py`
- `python/nexus/services/reader_locations.py`
- `python/nexus/services/reader_connections.py`
- `python/nexus/services/resource_graph/citations.py`
- `python/nexus/services/resource_graph/connections.py`
- `python/nexus/services/resource_items/capabilities.py`
- `python/nexus/services/resource_items/routing.py`
- `python/nexus/services/reader_apparatus.py`
- `python/nexus/services/web_article_artifacts.py`
- `python/nexus/services/pdf_ingest.py`
- `python/nexus/services/epub_lifecycle.py`
- `python/nexus/api/routes/reader.py`

Frontend:

- `apps/web/src/lib/reader/documentMap.ts`
- `apps/web/src/lib/reader/documentMapContract.ts`
- `apps/web/src/lib/reader/useEvidenceFilters.ts`
- `apps/web/src/components/reader/document-map/EvidencePaneSurface.tsx`
- `apps/web/src/components/reader/document-map/EvidenceItemRow.tsx`
- `apps/web/src/components/reader/MarginRail.tsx`
- `apps/web/src/lib/reader/marginItems.ts`
- `apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/components/chat/Conversation.tsx`
- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/useConversation.ts`

Reuse `Tabs`, pressable `Chip`, `HighlightActionBar`, `HighlightNoteEditor`,
`MachineText`, `ResourceActivation`, reader pulse/navigation, and MarginRail's
projection/stacking solver. Do not use collection-owned `ResourceRow/List`.

## 7. Hard-cutover deletions

- Raw/normalized dual Evidence fields and old six-lens DTO vocabulary.
- Frontend `EvidenceRow` raw-source union and client merge/sort.
- `highlight | apparatus | connection` filters.
- Evidence use of `AnchoredSidecarSurface`; delete the component if no consumer remains.
- Always-mounted blank note editors and `ItemCard.linkedItems` when unused.
- Duplicate highlight/apparatus/connection/marker activation branches.
- Media-only `chat_threads` lookup and duplicate context-edge rows.
- Stale current-state docs, deleted lens names, deleted route instructions, and dead validation commands.

## 8. Acceptance criteria

Backend/API:

- **AC-B1.** One response contains canonical Evidence groups/items/associations/counts; old raw Evidence fields are absent.
- **AC-B2.** Highlight, source reference, generated citation, and span Synapse return Passage occurrences in document order.
- **AC-B3.** A direct media edge returns Whole-document; an unresolved child remains an unavailable Passage occurrence.
- **AC-B4.** Generated citation exposes its chat/message as `AuthoredIn` and suppresses its duplicate conversation-context row.
- **AC-B5.** Direct highlight/apparatus associations and exact-locus `AlsoReferences` are typed and ACL-safe.
- **AC-B6.** Media owner expansion includes apparatus refs.
- **AC-B7.** Same apparatus stable key preserves UUID and graph associations
  through web/PDF/EPUB refresh; removed keys cleanly delete them.
- **AC-B8.** More than one internal graph page still returns complete facts and counts.
- **AC-B9.** No legacy request option or response field is accepted.
- **AC-B10.** Common endpoint activation is query-bounded per graph page and
  repeated citation targets do not repeat locator resolution.

Frontend:

- **AC-F1.** Evidence exposes accessible `Passages | Whole document` tabs.
- **AC-F2.** Any filter combination works in both tabs; MarginRail honors the same filter state.
- **AC-F3.** Resolved Passage groups are stable and target-activatable; unavailable groups render under Needs attention.
- **AC-F4.** Whole-document facts never enter side-pane or margin geometry.
- **AC-F5.** Associations disclose lazily with relationship text and independent activation; source targets activate their own occurrence, including across EPUB sections.
- **AC-F6.** Source references and Cited-by rows remain visibly distinct.
- **AC-F7.** No blank note editor mounts; at most one explicit editor is open.
- **AC-F8.** Opening an authored citation reaches its exact chat message.
- **AC-F9.** Mobile preserves semantics and closes after successful activation.
- **AC-F10.** Margin items are capped after viewport projection; keyboard/touch actions remain visible.

Cutover/docs:

- **AC-C1.** No product consumer reads old fields or constructs the old union.
- **AC-C2.** No retired reader lens component/surface/route remains in current-state docs.
- **AC-C3.** `reader-implementation.md` and `highlight.md` describe the shipped contract and real tests.
- **AC-C4.** Focused backend integration, browser component, marker, margin, EPUB, PDF, and mobile behavior tests pass.

## 9. Verification

Passed: 41 focused Python aggregate/graph/apparatus/lifecycle integration
tests; 43 apparatus-corpus/locator contract tests; 7 hard-cutover negative
gates; 19 frontend unit tests; 105 focused browser tests across Evidence,
margin, overview, PDF/MediaPane, exact-message chat, embeds, and ItemCard;
path-scoped Ruff/ESLint and format checks; CSS-token lint; frontend typecheck;
and `git diff --check`. No broad suite was run.

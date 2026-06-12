# Resource Provenance Graph - Hard Cutover

Status: BUILT — resource provenance graph landed; Rev 5 notes/pages amendment implemented
Author: design synthesis, 2026-06-07. Rev 2: 2026-06-09 (13-agent survey + reviewer notes). Rev 3: 2026-06-09 — flat-table restructure: sidecars deleted, relation verbs killed, run telemetry and generated content evicted from the edge model. Rev 4: 2026-06-09 — column-justification pass: locators and `updated_at` dropped; `origin`/`ordinal`/`snapshot` pinned. Rev 5: 2026-06-10 — notes/pages graph amendment: ordered adjacency keys, `note_containment`, and `tag`.
Type: hard cutover - greenfield, one-user prototype, no production data migration, no fallbacks, no backward compatibility, no compatibility shims

Rev 3 changes: one flat `resource_edges` table replaces the base-plus-sidecar design (§8); the six workspace relation verbs are deleted — a code census showed they are machine writer-discriminators plus dead values, not user vocabulary, and the real job moves to an `origin` column (§1, §2.5, §5.4); `kind` collapses to the three stances `context | supports | contradicts` and `role` dies (§5, §8.1); `message_retrievals` + `message_retrieval_candidate_ledgers` are **no longer dropped** — they are chat run telemetry, not connections, and stay in the chat domain (§2.3, N7); Oracle marginalia moves to an oracle-owned `oracle_reading_folios` domain table pointing at its citation edge (§5.3, §8.3); deletion rules collapse to two (§9.6). Carried from Rev 2: sequencing gate (§0.1), concordance equivalence contract (§5.3), coverage-is-not-an-edge (§5.6, N8), transaction discipline (§9.0), contributor-merge repoint (§9.6), gate proofs (§17.0).

Rev 4 changes: column-justification pass — every column must name the thing that breaks without it (§8.1). **Dropped:** `source_locator`/`target_locator` (position lives in the target grain: the graph points at `evidence_span`/`content_chunk`/`highlight`/`note_block` objects, which carry their own anchoring; residual jump precision is the snapshot `deep_link`) and `updated_at` (edges are create/delete-only rows — nothing updates). **Kept with pinned justification:** `origin` (writer ownership: note-body replace-set scoping, highlight-note precision, delete guards, `reference_added`), `ordinal` (the `[N]` in stored prose — data, not metadata), `snapshot` (the evidence-outlives-target invariant; citations only). Dropping the ordinal/snapshot pair would not be flatter — it would move citations back into a second table.

Rev 5 changes: `docs/cutovers/notes-pages-object-graph-hard-cutover.md` extends, rather than forks, this graph. Ordered document containment is a connection fact, so `source_order_key` and `target_order_key` live on `resource_edges`; they are adjacency-order keys, not citation locators. `origin=note_containment` is the sole writer for page/block containment edges. `scheme=tag` and the `tags` table add first-class tag resources. Bare-edge uniqueness is scoped by `(user_id, origin, source, target)` so a user edge, body-derived edge, highlight attachment, and containment edge can coexist over the same endpoints without clobbering each other.

Precedents:
- `docs/rules/cleanliness.md`: one owner per concern, collapse dangerous duplication, typed public contracts, no fallback lanes.
- `docs/rules/layers.md`: routes validate and dispatch; services own business logic.
- `docs/rules/database.md`: no database cascades, explicit cleanup, `SERIALIZABLE` for sequential-equivalence writes.
- `docs/architecture.md`: `resource_uri` is already the vocabulary bridging conversation references, citations, prompt rendering, and read/inspect tools.
- `docs/cutovers/library-intelligence-ai-native-consolidation-hard-cutover.md`: Rev 2 keeps current stores separate in the LI cutover, but names a later provenance-graph cutover as the long-term consolidation path. Its N2/AC-12 is the gate this spec must pass: independently prove — with no compatibility shims — that retrieval replay, scope admission, concordance/marginalia, and user-link CRUD all survive.
- `docs/cutovers/generation-run-harness-hard-cutover.md`: prerequisite render-contract work (§5.6 there) — sole backend `CitationOut` producer (`build_citation_outs_for_message`), `web_search` folded into `insert_retrieval_row`, Oracle user-media passages join the read-model, `oracle_reading:` reference scheme. Its N1 explicitly defers all storage folding to this spec.

---

## 0. North Star

Replace the ad hoc link/reference/citation stores with **one flat `resource_edges` table** under one graph owner.

An edge is a connection from one `ResourceRef` to another, with a stance `kind` (`context | supports | contradicts`), a writer `origin`, and one optional citation pair (`ordinal` + `snapshot`). Every object type can sit on either end. There are no sidecar tables, no locator columns, and no per-feature link stores.

Stores replaced by edges:

- `conversation_references` → `kind=context` edges with `source = conversation:<id>`
- `object_links` → verbless user/note/highlight edges (see the census, §2.5)
- `oracle_reading_passages` → citation edges + an oracle-owned folio content table
- `library_intelligence_citations` → citation edges (LI cutover landed 2026-06-07; migrations 0141/0142)

Stores that **stay**, because they were never connections:

- `message_retrievals` and `message_retrieval_candidate_ledgers` — chat run telemetry (what a tool returned, what entered the prompt, replay disclosures). They keep their chat owner, lose only their citation-numbering job, and gain a pointer to the citation edge.
- Oracle folio content (marginalia, attribution, phase) — generated content, moved to `oracle_reading_folios` in the oracle domain, referencing its edge.
- Pins (`object_refs.PinnedObjectRef`) — surface ordering state, not connections.

The final product has one edge owner, one resolver vocabulary, one citation read-model, one cleanup owner, and one frontend citation adapter. The flatness is honest because everything that is not a connection has been evicted from the model, not flattened into it.

### 0.1 Sequencing and gate

This spec is the storage fold that the LI cutover's N2/AC-12 gates. Two things come first:

1. **Prerequisite — render contract.** `generation-run-harness-hard-cutover.md` §5.6 lands before S1 here starts: the backend becomes the sole `CitationOut` producer (`build_citation_outs_for_message` beside the revision twin), `web_search` folds into `insert_retrieval_row`, Oracle user-media passages join `CitationOut` read-model-only, and `oracle_reading:` becomes a reference scheme. This cutover then swaps storage underneath a stable render contract; the frontend citation adapter does not change shape here.
2. **Gate — four parity proofs.** Per LI cutover §14 (AC-12), the feature-typed stores may be superseded only by independently proving, with no compatibility shims: retrieval replay, scope admission, concordance/marginalia, and user-link CRUD. §17.0 maps each proof to acceptance criteria. Note Rev 3 shrinks the riskiest proof by construction: replay disclosures keep reading `message_retrievals`, which does not move.

---

## 1. SME Thesis

The shared primitive is:

> A stance-typed edge from one `ResourceRef` to another `ResourceRef`, tagged with the writer that owns it.

Two earlier framings are now refuted by code census:

**"User links need relation verbs" — no.** `object_links.relation_type` has six values. The census (2026-06-09): `note_about` is the machine-written highlight↔note attachment (`notes.py:998`, read at `notes.py:937/1453/1795`, `vault.py:709/985`, `search/retrievers/notes.py:291`); `references`/`embeds` are machine-synced from note body content (`notes.py:1337`, replace-set diff at `notes.py:1366-1417`); `used_as_context` has a search-scope reader (`search/scope.py:156`) but no live writer; `derived_from` and `related` have no writers; there is **no frontend UI that lets a user pick a verb**. The verb column was never user vocabulary — it was a writer-ownership discriminator plus dead taxonomy. The replacement is an explicit `origin` column; user-facing links are verbless, like every backlink system that survived contact with users.

**"Distinct invariants need distinct tables" — only for non-connections.** The Rev 2 sidecars held three kinds of payload: edge identity (belongs on the edge), run telemetry (retrieval ordinals, prompt-inclusion flags, rerank traces — belongs to the chat run, exactly as `message_tool_calls` already does under N7), and generated content (Oracle marginalia — belongs to the reading). Evict the last two and the residual edge payload is exactly one optional pair — `ordinal` + `snapshot`, jointly meaning "this edge renders as a citation" — constrained by CHECKs. The null-soup objection applied to flattening telemetry and content into edges; it does not apply to one two-column variant.

| Current thing | What it really is | Where it goes |
|---|---|---|
| `conversation_references` | conversation context/admission boundary | edge: `conversation:<id> → target`, `kind=context`, `origin=user\|citation\|system` |
| chat/Oracle/LI citations | output cites source, with stance and render ordinal | edge: `output → target`, `ordinal` set, `snapshot` set |
| `object_links` `note_about` | highlight's attached note | edge: `highlight → note_block`, `origin=highlight_note` |
| `object_links` `references`/`embeds` | derived index of refs in note bodies | edges: `page/note_block → target`, `origin=note_body`, replace-set per save |
| `object_links` user rows | user connected A and B | edge: `kind=context`, `origin=user`, verbless |
| `message_retrievals` (+ candidate ledgers) | run telemetry: results, selection, prompt inclusion, replay | **stays in chat domain**; drops `citation_ordinal`, gains `cited_edge_id` |
| Oracle marginalia/attribution/phase | generated folio content | `oracle_reading_folios` (oracle-owned) referencing its citation edge |

The SME question "what invariant owns this edge?" resolves to a sharper rule: **if it is not a durable connection, it does not get an edge row.**

---

## 2. Current State

### 2.1 `resource_uri` is the right seed

`resource_resolver.py` already owns `<scheme>:<uuid>`, presentation, missing behavior, and prompt-facing summaries. `resource_loaders.py` owns scheme-specific SQL and permissions. This is the correct foundation, but it is currently scoped to conversation references and prompt assembly.

Pre-cutover seed schemes (`resource_resolver.RESOURCE_URI_SCHEMES`, main as of
2026-06-09, before the graph service became canonical):

```text
media
library
library_intelligence_artifact
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

It becomes `kind=context` edges with `source = conversation:<id>`. The admission and scoping semantics are code over those edges, not schema.

### 2.3 `message_retrievals` is run telemetry, and it stays

`message_retrievals` stores tool-call result ordinals, result type/source id, selection flags, prompt-inclusion state, display snapshots, locators, `context_ref`/`result_ref` JSON, and the replay state for message GETs. `message_retrieval_candidate_ledgers` points back at it. Two current-state facts (verified 2026-06-09):

- Writes are already funneled through one validated writer, `retrieval_citation.insert_retrieval_row` — except `web_search`, which still hand-rolls SQL. The harness cutover (§5.6.3 there) removes that exception before this spec starts.
- Rows are **mutable during the owning run**: `citation_ordinal` is assigned as citations materialize, `chat_run_prompt_tracking.reconcile_prompt_retrievals` flips `included_in_prompt`/`retrieval_status` after prompt assembly, and tool-result replacement deletes and re-inserts a tool call's rows. Once the run is terminal the rows never change.

Rev 3 conclusion: this is not a connection store. It is the chat run's evidence ledger — the same species as `message_tool_calls`, which N7 already keeps out of the graph. It stays under its chat owner. The only change: citation numbering moves to edges (`citation_ordinal` column dropped; nullable `cited_edge_id` added), so there is exactly one source of truth for "what does this message cite."

### 2.4 `oracle_reading_passages` is a citation plus generated content

An Oracle passage stores phase, source kind, exact snippet, locator label/locator, source snapshot, attribution text, marginalia text, and a deep link. The citation half (target, snippet, deep link — the locator dissolves into the span/chunk/corpus-passage target) becomes a normal citation edge. The generated half (phase, marginalia, attribution) is content, not connection — it moves to an oracle-owned folio table referencing the edge.

`compute_concordance` today uses **raw JSONB equality** on `(source_kind, locator, source)` (`oracle.py:411-490`): readings match only when their snapshot JSON is byte-equal. §5.3 replaces this with normalized target identity and pins the semantic delta.

### 2.5 `object_links` dissolves into three writers and a dead taxonomy

The Rev 2 gap list stands (no `library` endpoint type in `OBJECT_TYPES`, `schemas/notes.py:22`; per-call commits in the CRUD service; symmetric canonical-pair identity, `uix_object_links_unlocated_pair`, `models.py:449`; no provenance column). Rev 3 adds the census result (§1): the table is the highlight-note attachment, the note-body reference index, and a handful of user rows, sharing one table with two dead enum values and one orphaned one. There is nothing here a verb column earns. In the final state:

- attachment rows → `origin=highlight_note` edges
- body-sync rows → `origin=note_body` edges with replace-set semantics
- user rows → `origin=user` edges, verbless
- `used_as_context` scope-matrix cell → re-pointed at `kind=context` edges with `source = conversation:<id>`, which actually have writers (the cell currently matches a verb nothing writes; this cutover fixes a dead cell)
- `derived_from`, `related` → deleted with the table

---

## 3. Goals

G1. **One canonical resource identity.** Every persisted edge uses `ResourceRef`, not per-feature `result_type/source_id`, `resource_uri`, `ObjectRef`, and Oracle source JSON variants.

G2. **One graph owner.** All edge writes go through `services/resource_graph/*`.

G3. **One flat table, honest flatness.** No sidecars and no null soup: run telemetry and generated content live in their domains; the residual edge payload (`kind`, `origin`, ordered adjacency keys, and the citation pair `ordinal`+`snapshot`) is constrained per origin/kind so illegal states are unrepresentable. Locators are never edge payload — the graph points at the positioned object (G1's granular schemes). Ordered adjacency is edge payload only when the edge itself is the ordered containment relationship.

G4. **Feature behavior preserved.** Chat replay, app-search scoping, `read_resource` admission, `reference_added`, citation chips, Oracle concordance, Oracle marginalia, note backlinks, highlight notes, and user link CRUD all survive with no compatibility layer.

G5. **Current-only resource resolution.** Reader jumps resolve against active content index state. Historical display snapshots are for cards/replay, not hidden fallback reads.

G6. **One citation render contract.** Chat, Oracle, Library Intelligence, attached resources, and read-resource evidence all emit the same `CitationOut` shape to the frontend, built from edges.

G7. **Hard cleanup.** Delete old stores, old routes, old schemas, old helpers, old tests, and old docs references in the same cutover. No dual-read, dual-write, bridge, backfill, or compatibility shim.

G8. **Prototype-simple, production-grade.** Single-user deployment removes cross-tenant complexity, not correctness. Keep user ownership explicit because it is part of the permission and cleanup model.

G9. **One connections read.** "Everything connected to X" is one query over one table — backlinks, referenced-in-conversations, and cited-by stop being three bespoke reads.

---

## 4. Non-goals

N1. No knowledge-graph product UI, graph visualization, recommendations, or semantic graph traversal.

N2. No compatibility with old API shapes.

N3. No backfill of existing local prototype rows. This is greenfield; old rows are dropped.

N4. No historical citation resolver. If a target no longer resolves against current content, the edge remains for display/replay and the jump fails closed.

N5. No distributed/multi-user collaboration semantics. One viewer owns the graph rows. Shared libraries can still be checked through existing resource permissions.

N6. No metadata escape hatch at all. Rev 3 deletes `object_links.metadata_json` and the sidecar `metadata` column with it. The only JSON on an edge is the schema-validated display `snapshot`.

N7. No folding of domain parents or run telemetry into the graph: `message_tool_calls`, chat runs, `message_retrievals`, `message_retrieval_candidate_ledgers`, Oracle readings and folio content, LI artifacts/revisions, and pins (`object_refs`) all stay in their domains.

N8. No coverage/freshness ownership. Library Intelligence `covered_targets` stays revision metadata on `library_intelligence_artifact_revisions` — an entry-target snapshot plus derived expanded-media fingerprints (§5.6). The graph records citations, not corpus coverage.

N9. No user-facing relation taxonomy. Links are verbless. If a future feature genuinely needs a typed relationship, it arrives as a new `origin` with a sole writer — not as a user-facing verb picker.

---

## 5. Target Behavior

### 5.1 Chat context

Adding a resource to a conversation creates a context edge:

```text
source = conversation:<conversation_id>
target = <resource_ref>
kind = context
origin = user | citation | system
```

The conversation owner can list and remove context edges. `app_search` may search only `media:` or `library:` context targets on the conversation. `read_resource` and `inspect_resource` may read only resources with an edge from the conversation (any kind, any origin), unless the tool has a narrower bind-only exception already owned by chat validation.

`reference_added` SSE is still emitted when a citation materializes a new `origin=citation` context edge; the payload is built from the graph read model.

### 5.2 Chat retrieval and citations

Retrieval stays chat telemetry: `app_search`, `web_search`, attached resources, and `read_resource` evidence keep writing `message_retrievals` rows through `insert_retrieval_row`, and message replay keeps building retrieval disclosures from them, exactly as today.

What moves is **citation numbering**. When a result is cited, chat writes a citation edge:

```text
source = message:<assistant_message_id>
target = <resource_ref or external_snapshot:<id>>
kind = context            (default stance; supports/contradicts if the model asserts one)
origin = citation
ordinal = dense turn-global N
snapshot = display snapshot (required when ordinal is set)
```

Targets are the finest-grained existing object (`evidence_span`, `content_chunk`, `note_block`, `external_snapshot`, …). There is no per-edge locator: the pointed-at object carries its own anchoring, and the snapshot `deep_link` carries residual jump precision (e.g. a quote inside a fragment). The full `RetrievalLocator` machinery stays alive in chat telemetry and rendering — it just never rides on an edge.

`message_retrievals.citation_ordinal` is dropped; the retrieval row gains nullable `cited_edge_id` as a provenance pointer. `CitationOut` is built from edges (`build_citation_outs(source=message:<id>)`); the `citation_index` SSE payload carries edge ids. One source of truth for citations; one for telemetry.

### 5.3 Oracle folios

Oracle writes one citation edge per phase, plus one folio content row in its own domain:

```text
edge:  source = oracle_reading:<reading_id>
       target = oracle_corpus_passage:<id> | evidence_span:<span_id> | content_chunk:<chunk_id>
       kind = context, origin = citation, ordinal = phase order (descent 1, ordeal 2, ascent 3)
folio: oracle_reading_folios(reading_id, phase, edge_id, source_kind, locator_label, attribution_text, marginalia_text)
```

Target rules:

- **Public domain**: the stable `oracle_corpus_passage` row (§8.5). Two readings drawing the same passage share one target id by construction.
- **User media**: the evidence span the candidate grounds to (`evidence_span:<span_id>`), matching the harness cutover's passage `CitationOut` target; fall back to `content_chunk:<chunk_id>` when no span exists. Both are content-index rows, stable across readings within an index generation — unlike anything minted per reading. Jump precision lives in the target's own anchoring and the snapshot `deep_link`, not in target identity.

**Concordance contract.** Two passages are concordant iff their edges have equal `(target_scheme, target_id)`. Locator is deliberately excluded from the key — keying on JSON equality would reintroduce the brittleness being removed. This is a pinned semantic delta from today's raw-JSONB join:

- Same-passage matches that today require byte-equal snapshot JSON become identity matches — strictly more robust.
- A content reindex **between** two readings regenerates spans/chunks, so the pair will not match on user-media targets (today's snapshot equality could still match). Accepted under current-only doctrine: matching live identity beats matching ghost snapshots.
- Deleting source media does **not** break existing matches: citation edges and their target ids persist; only the reader jump fails closed (N4, D8).

`compute_oracle_concordance` keeps today's output contract (`ConcordanceEntryOut`: shared plate, shared theme, shared passage count), and reading detail keeps `OracleReadingPassageOut` field-for-field — phase, source_kind, exact_snippet, locator_label, attribution_text, marginalia_text, deep_link — hydrated from the folio row plus its edge (snippet/deep link from the edge snapshot). A fixture parity test is mandatory (§18.2, AC21).

### 5.4 User links — verbless

A user connecting A and B creates:

```text
source = <resource_ref>
target = <resource_ref>
kind = context
origin = user
```

No relation verb, no metadata, no order keys, no directionality column, no locators. Stored as written; treated as undirected: dedup checks both directions (today's service-side approach) and connection lists match either endpoint. Span-anchored linking is done by linking the span-grained object itself (`highlight:`, `evidence_span:`). Every scheme is linkable on either end — including `library:`, `podcast:`, `conversation:`, `oracle_reading:`, `library_intelligence_artifact:` — closing the missing-type gap from §2.5. (User vocabulary mapping: note → `page`/`note_block`, chat → `conversation`, author → `contributor`, episode/video → `media` rows of those kinds.)

Users may also assert stance directly — `kind = supports | contradicts` with `origin=user` and no ordinal ("this note contradicts that article"). Same table, same three kinds; nothing new to build beyond allowing it.

Deliberate behavior delta: a user link from a conversation to a resource is a context edge from that conversation — it admits the resource to chat reads (§5.1). Attaching and linking are the same assertion in an AI-first product.

### 5.5 Library Intelligence citations

`library_intelligence_citations` is deleted. LI citations become edges:

```text
source = library_intelligence_artifact:<artifact_id>
target = evidence_span:<span_id> | content_chunk:<chunk_id> | media:<media_id>
kind = supports | contradicts | context   (today's role enum, verbatim — models.py CHECK)
origin = citation
ordinal = N
```

**Revision scoping collapses to head-swap.** Today citations key on the immutable `revision_id`; edges key on the artifact. The two reconcile inside the existing SERIALIZABLE promote: `replace_citations_for_output` runs in the same transaction that moves `current_revision_id`, so the artifact's citation set swaps atomically with its content. Draft and failed revisions write no edges. This is current-only doctrine applied to citations (`docs/cutovers/current-only-artifacts-hard-cutover.md`).

### 5.6 Coverage is not an edge

LI freshness must keep working, and it is out of scope here by design (N8). `covered_targets` on `library_intelligence_artifact_revisions` remains the **entry-target snapshot plus derived expanded-media fingerprint set**, produced by the single expansion owner `resolve_library_media_ids` (`library_intelligence.py:468`), whose UNION derives episode media from podcast library entries. Podcast entries therefore participate in coverage **via derivation**, not as covered targets themselves; a newly published episode flips the artifact to `stale` through the live-vs-snapshot fingerprint diff with zero graph involvement. Any future flattening to bare `covered_media_ids` is rejected: it would drop fingerprints, which carry content-change staleness, not just membership.

### 5.7 Note-derived edges

Two machine writers replace the old verb rows:

- **Body sync** (`origin=note_body`): when a page/note body saves, the sync replaces the page's `origin=note_body` edge set to match the refs and embeds in the document (today's `notes.py:1337-1417` diff, re-pointed at edges; the references-vs-embeds distinction is dropped — it was never read by anything but a label). Replace-set semantics are scoped by `(source, origin)`, so body sync can never clobber a user link or the highlight attachment. Positions are not stored: the body itself knows where its refs sit, so the same ref appearing twice in one body is one edge (the old located-pair multiplicity dies with the locator columns).
- **Highlight note attachment** (`origin=highlight_note`): the quick-note composer's highlight↔note edge. `linked_note_blocks_for_highlights`, vault reads, and the notes search retriever query this origin and keep their exact semantics — no behavior delta.

---

## 6. Final Architecture

```text
services/resource_graph/
  refs.py        ResourceRef grammar, parse/format, typed schemes
  resolve.py     batch hydrate refs for prompt/UI/API
  edges.py       create/list/delete, dedup, replace-set by (source, origin), repoint
  context.py     conversation admission + search-scope helpers over edges
  citations.py   ordinal ownership, CitationOut builder, concordant-target queries
  cleanup.py     explicit edge cleanup for deleted resources
  schemas.py     internal dataclasses / typed payloads

api/routes/resource_graph.py          resolve + edges (connections, user links)
api/routes/conversation_context.py    context refs

apps/web/src/lib/resourceGraph/
  resourceRef.ts
  edges.ts        connections + user link CRUD
  contextRefs.ts
  citations.ts
```

Feature modules call graph public functions. They do not write `resource_edges` directly. Oracle owns `oracle_reading_folios`; chat owns `message_retrievals` and its debug routes; both reference edges by id.

---

## 7. ResourceRef Contract

### 7.1 Canonical schemes

`ResourceRef` replaces the split between `resource_uri`, `ObjectRef`, `result_type/source_id`, and Oracle source JSON.

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
oracle_reading
oracle_corpus_passage
library_intelligence_artifact
external_snapshot
contributor
podcast
tag
```

Compatibility aliases are not kept. `span:` becomes `evidence_span:` and `chunk:` becomes `content_chunk:` in the final state. This is a hard cutover; all callers move. (`message_tool_call` from Rev 2 is dropped: tool calls no longer source edges — retrieval telemetry stays in its own table.)

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
    "oracle_reading",
    "oracle_corpus_passage",
    "library_intelligence_artifact",
    "external_snapshot",
    "contributor",
    "podcast",
    "tag",
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
- Missing/forbidden refs hydrate as `missing=True` for historical display, but writes reject missing targets unless the target is an `external_snapshot`.

---

## 8. Data Model

### 8.1 `resource_edges`

The one table.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid not null | single-user owner and cleanup scope |
| `kind` | text not null | CHECK `context`, `supports`, `contradicts` — the full stance vocabulary, for every edge |
| `origin` | text not null | CHECK `user`, `citation`, `system`, `note_body`, `highlight_note`, `note_containment` — the writer that owns the row |
| `source_scheme` | text not null | `ResourceScheme` CHECK |
| `source_id` | uuid not null | |
| `target_scheme` | text not null | `ResourceScheme` CHECK |
| `target_id` | uuid not null | |
| `source_order_key` | text null | adjacency order of the target in the source list; only meaningful for ordered graph projections such as note containment |
| `target_order_key` | text null | adjacency order of the source in the target list where the product exposes an ordered inbound projection |
| `ordinal` | int null | citation render index; present ⇔ this edge renders as a citation chip |
| `snapshot` | jsonb null | display snapshot: title/excerpt/section_label/deep_link/result_type only |
| `created_at` | timestamptz not null default now() | |

Every column must name what breaks without it:

| column | what breaks without it |
|---|---|
| `kind` | the product semantics — the user's three stances are the entire edge vocabulary |
| `origin` | writer ownership: note-body sync cannot replace-set its rows without clobbering user links and the highlight attachment; `linked_note_blocks_for_highlights` cannot tell the attached note from a note whose body merely mentions the highlight; the route cannot restrict user deletes to user rows; `reference_added` cannot distinguish citation-materialized refs |
| `source_order_key`/`target_order_key` | ordered graph projections need deterministic order without leaking parentage/order back onto note/page rows; containment order is a property of the edge's adjacency list |
| `ordinal` | the `[N]` markers in stored assistant prose dangle — the number is data the text depends on; without it, citations need their own table again |
| `snapshot` | the evidence invariant dies: delete any source and every past answer's citations blank out (migration 0093 removed cascades precisely to prevent this) |
| `created_at` | cursor ordering for context/connection lists |

Deliberately absent: **locators** (reader/text position is never edge payload — point at the positioned object: `evidence_span`, `content_chunk`, `highlight`, `note_block`; residual precision is the snapshot `deep_link`), **`updated_at`** (edges are immutable rows — create and delete only; "editing" a citation set is a replace-set), **`metadata`** (N6), **relation verbs** (§2.5).

Indexes and constraints:

- `(user_id, origin, source_scheme, source_id, source_order_key, id)` and `(user_id, origin, target_scheme, target_id, target_order_key, id)` — the two halves of every ordered adjacency, connections, backlink, and reverse-lookup query
- partial unique `(user_id, source_scheme, source_id, ordinal)` where `ordinal is not null` — dense citation numbering per output
- partial unique `(user_id, origin, source_scheme, source_id, target_scheme, target_id)` where `ordinal is null` — context/link dedup scoped to the writer origin (directed; undirected user dedup is the service's both-direction check, as today)
- partial unique `(user_id, source_scheme, source_id, source_order_key)` where `origin = 'note_containment' and source_order_key is not null` — one child occurrence per parent-order slot
- partial unique `(user_id, target_scheme, target_id, target_order_key)` where `origin = 'note_containment' and target_order_key is not null` — one inbound occurrence per target-order slot where used
- partial unique `(user_id, target_scheme, target_id)` where `origin = 'note_containment'` — this cutover enforces one containment occurrence per block until transclusion carries occurrence edge ids through every projection
- CHECK `source_order_key is null or char_length(source_order_key) between 1 and 64`
- CHECK `target_order_key is null or char_length(target_order_key) between 1 and 64`
- CHECK `ordinal >= 1`
- CHECK `ordinal is null or snapshot is not null` — a citation must render after its target dies
- CHECK `ordinal is null or origin = 'citation'`
- CHECK `snapshot is null or (origin = 'citation' and ordinal is not null)`
- CHECK citation rows carry no order keys; note-containment rows have valid containment endpoints and `source_order_key`; highlight-note rows are exactly `highlight -> note_block`
- CHECK snapshot is a JSON object

Notes:

- `origin = citation` rows with `source_scheme = conversation` are context refs materialized by citations (drives `reference_added`); with output source schemes (`message`, `oracle_reading`, `library_intelligence_artifact`) they are the citations themselves. Structure (source scheme + ordinal) discriminates; no extra column needed.
- Stance is a property of the connection, never of the target. `supports`/`contradicts` are valid with or without an ordinal (machine citations and user assertions respectively).
- The `origin` CHECK is the anti-creep gate: adding an origin requires a new sole writer and a migration, by design (N9).
- Edges are immutable: create and delete only. No update path exists, so no `updated_at`.

### 8.2 `resource_external_snapshots`

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

### 8.3 `oracle_reading_folios` (oracle-owned)

Generated folio content, in the oracle domain, referencing its citation edge.

| column | type | notes |
|---|---|---|
| `reading_id` | uuid not null fk `oracle_readings.id` | |
| `phase` | text not null | CHECK `descent`, `ordeal`, `ascent` |
| `edge_id` | uuid not null fk `resource_edges.id` | the citation edge for this phase |
| `source_kind` | text not null | `user_media`, `public_domain` |
| `locator_label` | text not null | |
| `attribution_text` | text not null | |
| `marginalia_text` | text not null | |
| `created_at` | timestamptz not null default now() | |

Constraints: `unique(reading_id, phase)`; pk `(reading_id, phase)`. Snippet and deep link live on the edge snapshot — not duplicated here.

### 8.4 Chat telemetry deltas (chat-owned)

`message_retrievals`: drop `citation_ordinal`; add `cited_edge_id uuid null` (provenance pointer to the citation edge, set when a result is cited). Everything else — including `message_retrieval_candidate_ledgers` and the in-run mutation behavior — is untouched and stays under the chat owner.

### 8.5 `oracle_corpus_passages`

Stable target for public-domain Oracle passages when they are not already backed by ordinary `media`/`evidence_span` rows.

> Note (as built): migration `0145` does **not** create this table. The live `oracle_corpus_passages` from migration `0072` — seeded, embedding-backed, and read by Oracle retrieval — already has a uuid `id` that serves the `oracle_corpus_passage:<id>` target verbatim. Recreating the shape below would collide with the live table, and dropping the live corpus would destroy Oracle retrieval, so the existing table is reused untouched and the columns below document the contract it already satisfies.

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

### 9.0 Transaction discipline

Graph mutators never commit. Every write capability is a composing form that flushes within the caller's transaction; thin committing wrappers exist only where a route is the sole caller. This is what lets conversation create, chat-run citation write-through, Oracle phase persistence, and the LI promote compose atomically — and it removes the per-call-commit defect that disqualified `object_links` (§2.5).

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

### 9.3 `resource_graph.edges`

```python
create_edge(db, *, viewer_id: UUID, input: EdgeCreate) -> EdgeOut                  # flush-only
delete_edge(db, *, viewer_id: UUID, edge_id: UUID) -> None
replace_edges_for_origin(db, *, viewer_id: UUID, source: ResourceRef, origin: EdgeOrigin, edges: Sequence[EdgeCreate]) -> list[EdgeOut]   # note_body sync, citation sets
repoint_edges(db, *, viewer_id: UUID, from_ref: ResourceRef, to_ref: ResourceRef) -> int   # identity merges; all kinds, ordinals/snapshots untouched
```

Undirected dedup for `origin=user` unlocated pairs is owned here (both-direction check before insert, as today). Product connection reads are owned by `resource_graph.connections.query_connections`; `resource_graph.edges` is the write/delete owner.

### 9.4 `resource_graph.context`

```python
list_context_refs(db, *, viewer_id: UUID, conversation_id: UUID) -> list[ContextRefOut]
add_context_ref_without_commit(db, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef, origin: EdgeOrigin) -> ContextRefOut
remove_context_ref(db, *, viewer_id: UUID, conversation_id: UUID, edge_id: UUID) -> None
is_context_ref(db, *, conversation_id: UUID, target: ResourceRef) -> bool          # any edge from the conversation
list_conversations_with_context_ref(db, *, viewer_id: UUID, target: ResourceRef, limit: int, cursor: str | None) -> ConversationPage
search_scope_refs_for_conversation(db, *, conversation_id: UUID) -> list[ResourceRef]
```

Thin views over `edges` filtered to `source_scheme = 'conversation'`; admission and scope semantics live here, in code, not in schema.

### 9.5 `resource_graph.citations`

```python
record_citation(db, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef, ordinal: int, kind: EdgeKind, snapshot: CitationSnapshot) -> EdgeOut
replace_citations_for_output(db, *, viewer_id: UUID, source: ResourceRef, citations: Sequence[CitationInput]) -> list[EdgeOut]
build_citation_outs(db, *, viewer_id: UUID, source: ResourceRef) -> list[CitationOut]
concordant_sources(db, *, viewer_id: UUID, source: ResourceRef, source_scheme: ResourceScheme) -> list[ConcordantSource]   # outputs sharing (target_scheme, target_id) — §5.3
```

`CitationOut` is the only backend shape consumed by the frontend citation adapter. By prerequisite (§0.1) the harness's `build_citation_outs_for_message` already exists; it relocates here and reads edges.

### 9.6 `resource_graph.cleanup`

```python
delete_edges_for_deleted_resource(db, *, ref: ResourceRef) -> None
assert_no_dangling_bare_edges(db, *, ref: ResourceRef) -> None
```

Cleanup is explicit application code. No `ON DELETE CASCADE`. Two rules, total:

1. **Cited edges outlive their targets.** An edge with an ordinal is never deleted by target cleanup — its snapshot renders and the jump fails closed (N4). It dies only with its domain parent (message/conversation delete, reading delete, LI promote replace).
2. **Bare edges die with either endpoint.** Context refs, user links, and note-derived edges to a deleted resource are deleted by cleanup. Deliberate delta vs today: conversation reference chips to deleted resources vanish instead of rendering `missing=true` tombstones.

Identity merge (contributor) repoints **all** edges via `repoint_edges` — including citations, whose ordinals and snapshots are untouched. Today's merge behavior ("links untouched, reads canonicalize", `contributors.py:945`) is deleted with the old table; split keeps its existing repoint path through the same capability.

---

## 10. API Design

Old route modules are deleted: `api/routes/conversation_references.py`, `api/routes/object_links.py`. Chat's retrieval debug routes stay chat-owned and unchanged.

### 10.1 Conversation context

| Method | Route | Service | Notes |
|---|---|---|---|
| GET | `/conversations/{id}/context-refs` | `context.list_context_refs` | replaces list conversation references |
| POST | `/conversations/{id}/context-refs` | `context.add_context_ref` (committing wrapper) | body `{resource_ref}` |
| DELETE | `/conversations/{id}/context-refs/{edge_id}` | `context.remove_context_ref` | |
| GET | `/conversations?has_context_ref=...` | `context.list_conversations_with_context_ref` | replaces `has_reference` |

### 10.2 Connections and edges

| Method | Route | Service | Notes |
|---|---|---|---|
| POST | `/resource-graph/connections/query` | `connections.query_connections` | the one product connection read: backlinks, cited-by, referenced-in, outgoing links |
| POST | `/resource-graph/edges` | `edges.create_edge` | user links and user stance edges; `origin` forced to `user` at the route |
| DELETE | `/resource-graph/edges/{edge_id}` | `edges.delete_edge` | user-origin rows only at this route |

No PATCH: a verbless link has nothing to edit; re-create to change endpoints.

### 10.3 Resource resolution

| Method | Route | Service | Notes |
|---|---|---|---|
| POST | `/resource-graph/resolve` | `resolve.resolve_refs` | body `{refs:[...]}` for UI hydration |

No route owns business logic. Routes parse request envelopes, call graph services, and return schemas.

---

## 11. Composition With Existing Systems

### 11.1 Conversations

`conversations.create` calls `add_context_ref_without_commit` for initial refs inside the same transaction that creates the conversation. Conversation delete explicitly deletes edges where `source = conversation:<id>` and citation edges sourced from its messages.

### 11.2 Context assembler

`context_assembler._build_resources_block` reads `context.list_context_refs`. Its `source_refs` point at edge IDs.

### 11.3 `app_search`

`app_search._resolve_scope_uris` becomes `context.search_scope_refs_for_conversation`. Retrieval persistence is unchanged (chat telemetry, §2.3).

### 11.4 `web_search`

Web results get `external_snapshot` resources; cited web results get citation edges targeting them. Telemetry rows unchanged (post-harness, they already flow through `insert_retrieval_row`).

### 11.5 `read_resource` / `inspect_resource`

Admission calls `context.is_context_ref`, except for any explicit chat-owned bind-only selection path. Evidence reads keep writing telemetry; cited evidence gets citation edges.

### 11.6 Chat runs

`_emit_citation_index` becomes: write the citation edge (via `citations.record_citation`, same transaction), set `cited_edge_id` on the telemetry row, emit the event with edge ids. `_persist_attached_citations` writes its synthetic telemetry as today plus citation edges for the attached set. The `citation_index` SSE payload carries `citation_edge_id`; there is no compatibility branch.

### 11.7 Oracle

Oracle generation still owns prompt, model call, reading status, and event emission. Per phase it writes one citation edge (`citations.record_citation`) and one `oracle_reading_folios` row in the same transaction. `compute_concordance` re-implements over `citations.concordant_sources` (§5.3 contract). Old passage model/schema/queries are deleted.

### 11.8 Library Intelligence

The promote transaction calls `citations.replace_citations_for_output` (§5.5). The LI-private citation table is deleted.

### 11.9 Notes, highlights, contributors

Body sync re-targets to `edges.replace_edges_for_origin(source=page, origin=note_body)`. The quick-note composer writes `origin=highlight_note` edges; `linked_note_blocks_for_highlights`, vault, and the notes search retriever query that origin. `object_refs.py` hydrates through `resource_graph.resolve`. Contributor merge **and** split call `edges.repoint_edges` (§9.6). The note/page search-scope cells re-point at edges; the dead `used_as_context` conversation cell is replaced by conversation context edges (§2.5). `chat_context_refs` (contributor-in-chat-context reader) is unchanged — it reads chat telemetry, which does not move.

### 11.10 Media deletion and content reindex

`media_deletion.py` and `content_indexing.py` stop hand-deleting `object_links` rows and call `resource_graph.cleanup` once for each deleted resource ref (the two rules in §9.6). Chat telemetry cleanup (`message_retrievals.media_id` SET NULL etc.) stays chat-side, honestly: telemetry is not the graph's.

### 11.11 Frontend

Frontend deletes object-link and conversation-reference clients. New modules: `resourceRef.ts`, `edges.ts`, `connections.ts`, `contextRefs.ts`, `citations.ts`. `ReaderCitation` remains the renderer; object sidecars use `ConnectionsSurface` over `POST /resource-graph/connections/query`; conversation reference surfaces become context-ref surfaces.

---

## 12. Duplication Removed

| Duplicate/repetitive pattern | Current locations | New owner |
|---|---|---|
| Resource identity parsing | `resource_resolver`, frontend `resourceKind`, object ref schemas, retrieval result refs | `resource_graph.refs` plus frontend `resourceRef.ts` |
| Resource hydration | `resource_resolver`, `object_refs`, object-link service, conversation references | `resource_graph.resolve` |
| Context admission checks | `conversation_references`, `app_search`, `read_resource`, `inspect_resource`, chat validation | `resource_graph.context` |
| Citation storage + numbering | `message_retrievals.citation_ordinal`, `library_intelligence_citations`, `oracle_reading_passages` | `resource_edges` ordinal-bearing rows |
| Citation index construction | `chat_runs`, LI pane adapter, Oracle jump adapter (frontend reconstruction already deleted by the harness cutover) | `resource_graph.citations` + `CitationOut` |
| Generated passage/folio storage | Oracle-local passage persistence and concordance SQL | citation edges + `oracle_reading_folios`; concordance via `concordant_sources` |
| User link CRUD and hydration | `object_links`, `object_refs`, notes schemas | `resource_graph.edges` |
| Note body reference sync + highlight note attachment | `object_links` verb rows in `notes.py` | `origin=note_body` / `origin=highlight_note` edges |
| Cleanup of refs to deleted media/chunks/spans | `media_deletion`, `content_indexing`, ad hoc SQL | `resource_graph.cleanup` (two rules) |
| "What's connected to X" | bespoke backlink query, `has_reference`, per-feature reverse lookups | `connections.query_connections` |

---

## 13. Migration Plan

One irreversible Alembic head migration. Greenfield reset; no backfill.

### 13.1 Create

- `resource_edges`
- `resource_external_snapshots`
- `oracle_reading_folios`
- `oracle_corpus_passages`

### 13.2 Drop

- `conversation_references`
- `object_links`
- `oracle_reading_passages`
- `library_intelligence_citations`

### 13.3 Alter

- `message_retrievals`: drop `citation_ordinal`; add `cited_edge_id uuid null`
- `message_retrieval_candidate_ledgers`: untouched
- remove old `citation_index` payload assumptions from chat SSE schema if they mention retrieval IDs
- remove `resource_uri` route/request schema dependencies outside graph APIs
- add `ResourceScheme`/`kind`/`origin` CHECKs to `resource_edges`

### 13.4 No compatibility

No views named like old tables. No insert triggers. No dual-write. No data copy. No route aliases.

---

## 14. Implementation Slices

Because this is broad, implementation can be reviewed in slices, but main must never contain a mixed old/new runtime. Do not start S1+ until the generation-run-harness cutover's §5.6 render-contract work is on main (§0.1).

S0. **ResourceRef and resolver contract.**
Add `resource_graph.refs` and `resource_graph.resolve`; update docs and tests. No old storage change yet.

S1. **Graph schema and service owner.**
Add migration and service modules. In a feature branch, wire graph writes for all consumers.

S2. **Conversation context hard cut.**
Replace `conversation_references` consumers with context edges: conversations, context assembler, app_search scope validation, read/inspect admission, reverse lookup, frontend context refs.

S3. **Citation hard cut.**
Citation edges own numbering; `citation_ordinal` dropped, `cited_edge_id` added; `_emit_citation_index`, `CitationOut` building, and the SSE payload move to edges. Retrieval telemetry untouched.

S4. **Oracle hard cut.**
Citation edges + `oracle_reading_folios`; concordance via `concordant_sources`; delete passage model/schema/queries.

S5. **Links and notes hard cut.**
Verbless user links; `origin=note_body` replace-set sync; `origin=highlight_note` attachment; contributor merge+split repoint; delete `object_links` and its routes/schemas; re-point search-scope cells.

S6. **Library Intelligence citation adoption.**
`replace_citations_for_output` in the promote transaction; delete the LI-private citation table.

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
- `python/nexus/services/resource_graph/citations.py`
- `python/nexus/services/resource_graph/cleanup.py`
- `python/nexus/services/resource_graph/schemas.py`
- `python/nexus/schemas/resource_graph.py`
- `python/nexus/api/routes/resource_graph.py`
- `python/nexus/api/routes/conversation_context.py`
- `migrations/alembic/versions/XXXX_resource_provenance_graph.py`
- `apps/web/src/lib/resourceGraph/resourceRef.ts`
- `apps/web/src/lib/resourceGraph/edges.ts`
- `apps/web/src/lib/resourceGraph/contextRefs.ts`
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
- `python/nexus/services/retrieval_citation.py` (telemetry writer stays; citation building moves out)
- `python/nexus/services/oracle.py`
- `python/nexus/services/library_intelligence.py`
- `python/nexus/services/notes.py` (body sync + highlight attachment re-target)
- `python/nexus/services/vault.py`
- `python/nexus/services/search/scope.py` + `search/retrievers/notes.py`
- `python/nexus/services/media_deletion.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/object_refs.py`
- `python/nexus/services/contributors.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/schemas/oracle.py`
- `python/nexus/schemas/notes.py`
- `apps/web/src/lib/api/sse/events.ts`
- `apps/web/src/lib/conversations/citations.ts`
- `apps/web/src/lib/conversations/readerTarget.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/resources/resourceKind.ts`
- `apps/web/src/components/connections/ConnectionsSurface.tsx` (verbless connections list)
- `apps/web/src/components/chat/ConversationReferencesSurface.tsx`
- `apps/web/src/components/chat/useConversation.ts`
- `apps/web/src/components/chat/useChatRunTail.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
- `docs/architecture.md`, `docs/modules/chat.md`, `docs/modules/oracle.md`, `docs/modules/library.md`

### 15.3 Delete

- `python/nexus/services/conversation_references.py`
- `python/nexus/services/object_links.py`
- `python/nexus/api/routes/conversation_references.py`
- `python/nexus/api/routes/object_links.py`
- `apps/web/src/app/api/object-links/**`
- old object-link schemas in `schemas/notes.py` (including `OBJECT_LINK_RELATIONS`)
- old frontend object-link/conversation-reference clients after replacements land
- tests that only assert old table/route shapes

---

## 16. Key Decisions

D1. **One flat edge table; eviction instead of sidecars.**
Run telemetry and generated content leave the model; what remains is uniform enough for one table with partial constraints. Domain tables may reference edges, never the reverse.

D2. **`ResourceRef` replaces `ObjectRef` and old URI aliases.**
No `span:`/`chunk:` aliases after the cutover; use `evidence_span:`/`content_chunk:`.

D3. **Links are verbless; `origin` does the verb column's real job.**
The census (§2.5) showed the verbs were writer discriminators plus dead values. `origin` is the explicit version, with a CHECK as the anti-creep gate (N9).

D4. **Three kinds, total: `context`, `supports`, `contradicts`.**
Stance is the only edge semantics; it applies uniformly to user links, context refs, and citations. `role` dies; Oracle's `source`, read-evidence `quotation`, and `web` discriminations were structural all along (source scheme, target scheme).

D5. **An ordinal marks a citation.**
`ordinal is not null` ⇔ the edge renders as a citation chip, with mandatory snapshot. No `is_citation` flag, no separate citation table.

D6. **Telemetry is not connection.**
`message_retrievals` + ledgers stay chat-owned (replay, prompt tracking, in-run mutation). The graph holds only the cited subset, as edges. `cited_edge_id` is a one-way provenance pointer.

D7. **External resources become resources.**
Web citations target `external_snapshot` rows, not unowned JSON blobs.

D8. **Public-domain Oracle passages become resources; folio content is oracle-domain.**
Marginalia/phase/attribution live in `oracle_reading_folios`, owned by oracle, referencing the citation edge. No hidden historical resolver: display snapshots preserve replay; reader jumps use current resolvers and fail closed.

D9. **Graph service owns cleanup, with exactly two rules.**
Cited edges outlive targets; bare edges die with either endpoint; merges repoint everything (§9.6).

D10. **One-user does not mean untyped.**
The prototype can delete old data and skip migration complexity, but the new model must still be strict.

D11. **Position lives in the target, not the edge.**
No locator columns. The scheme list is granular enough (`evidence_span`, `content_chunk`, `highlight`, `note_block`) that "where" is always answered by pointing at a finer object; the snapshot `deep_link` carries residual precision. `RetrievalLocator` survives in chat telemetry and rendering, never on edges.

D12. **Edges are create/delete-only.**
No update path, no `updated_at`. Citation sets change by replace-set inside the owning transaction; links change by delete + create.

---

## 17. Acceptance Criteria

### 17.0 Gate proofs (LI cutover AC-12)

- **P1 retrieval replay** → AC6 + the golden-message fixture (§18.2). Rev 3 shrinks this proof by construction: disclosures keep reading `message_retrievals`; only citation chips move to edges.
- **P2 scope admission** → AC2-AC4: app_search scoping and read/inspect admission behave identically, proven by the existing admission suite re-pointed at graph context.
- **P3 concordance/marginalia** → AC8-AC9 + AC21: folio rendering field-for-field; concordance fixture parity under the §5.3 equivalence.
- **P4 user-link CRUD** → AC10-AC11: verbless link behavior including symmetric dedup and merge/split repoint.

### 17.1 Product behavior

AC1. Adding a resource to a conversation creates a context edge and the conversation context surface renders it.

AC2. `app_search` with empty scopes searches media/library context targets only.

AC3. `app_search` with explicit scope rejects a media/library ref that has no edge from the conversation.

AC4. `read_resource` and `inspect_resource` admission use graph context edges.

AC5. Chat `app_search`, `web_search`, attached resources, and `read_resource` evidence all produce citation chips with stable dense ordinals, built from edges.

AC6. Message reload reconstructs tool-call disclosures from `message_retrievals` (unchanged) and citation chips from edges, with identical rendered output.

AC7. `reference_added` SSE still fires when a cited local resource becomes conversation context (`origin=citation` context edge).

AC8. Oracle readings render the same three folios with marginalia, attribution, and clickable jumps.

AC9. Oracle concordance returns shared plate/theme/passage matches from edges.

AC10. User link create/list/delete preserves symmetric duplicate prevention; backlink lists show connections without verbs; highlight notes and note-body backlinks behave exactly as today (`origin` discrimination, §5.7).

AC11. Contributor merge and split repoint **all** edges through `repoint_edges`; no read-side link canonicalization remains.

AC12. Media deletion and content reindex leave no bare edges to the deleted resource and no cited edge that claims active resolvability.

### 17.2 Architecture gates

AC13. Only `services/resource_graph/*` writes `resource_edges`.

AC14. No production code references old table names except the drop migration and head assertion tests.

AC15. No route imports SQLAlchemy graph models directly.

AC16. No `resource_uri` parsing outside `resource_graph.refs` and edge route boundary validation.

AC17. No frontend code manually splits resource refs outside `resourceGraph/resourceRef.ts`.

AC18. No old route modules are registered.

AC19. No compatibility views/triggers/functions exist for old tables.

AC20. Illegal-state rejection is tested per kind/origin: ordinal without snapshot, unknown origin, stance values outside the three, duplicate ordinals per viewer/source, duplicate bare pairs per viewer/origin, and duplicate containment order slots.

### 17.3 Parity and invariants

AC21. Oracle concordance over a seeded corpus (two readings sharing a corpus passage, two sharing a user-media span, one pair separated by a reindex) matches the §5.3 contract exactly, with the reindex pair asserted as a non-match.

AC22. Edges sourced from a terminal run's message or a promoted revision are immutable; `replace_citations_for_output` on a non-promoting path is rejected.

AC23. LI staleness still flips on podcast-episode arrival with zero graph involvement (§5.6).

AC24. No `relation_type`, `note_about`, or `OBJECT_LINK_RELATIONS` symbol survives outside the drop migration and head assertions; the search-scope conversation cell for notes matches conversation context edges (§2.5).

---

## 18. Test Plan

### 18.1 Unit tests

- `ResourceRef` parse/format rejects old aliases and malformed UUIDs; scheme matching is exhaustive with `assert_never`.
- edge creation rejects missing targets (except `external_snapshot`), bad kinds, bad origins.
- citation ordinal density and uniqueness per source output; snapshot required with ordinal.
- bare-pair dedup, including the both-direction check for user links.
- `replace_edges_for_origin` replaces exactly its `(source, origin)` set and nothing else.
- cleanup rules: cited edges survive target deletion, bare edges do not; repoint moves every kind.

### 18.2 Integration tests

- create conversation with initial refs, list context refs, run app_search scoped to library.
- app_search end-to-end: telemetry rows + citation edges + `cited_edge_id` linkage.
- web_search citation creates an external snapshot target.
- read_resource evidence creates a citation edge.
- assistant message GET rehydrates disclosures (telemetry) and citations (edges).
- SSE `citation_index` and `reference_added` fold correctly on the frontend.
- Oracle reading persists folio rows + citation edges and computes concordance.
- note body save replace-sets `note_body` edges; quick-note composer attachment round-trips through `linked_note_blocks_for_highlights`.
- user link CRUD through new routes; connections list returns links + citations + context refs for one ref.
- media deletion applies the two cleanup rules explicitly.
- golden-message replay fixture (P1): captured pre-fold message GET payloads (blocks + `CitationOut[]`) for the seeded conversation; assert identical rendering post-fold.
- concordance parity fixture (P3): captured pre-fold `compute_concordance` output for the seeded readings; assert §5.3-contract output post-fold, with the pinned reindex delta asserted explicitly.

### 18.3 Migration/head assertions

Assert old tables are absent:

```text
conversation_references
oracle_reading_passages
object_links
library_intelligence_citations
```

Assert `message_retrievals` exists with `cited_edge_id` and without `citation_ordinal`.

Assert old service/route files are absent:

```text
conversation_references.py
object_links.py
```

Grep gates:

```text
\bconversation_references\b
\boracle_reading_passages\b
\bobject_links\b
\blibrary_intelligence_citations\b
\brelation_type\b
\bnote_about\b
\bcitation_ordinal\b
has_reference
span:
chunk:
```

Allowed mentions: this spec, drop migration, migration tests, changelog entries.

---

## 19. Risks

R1. **Flat-table constraint sprawl.**
Mitigation: the kind and origin vocabularies are CHECK-capped (3 and 6); every partial constraint is enumerated in §8.1 and tested by AC20. A new origin requires a migration and a sole writer (N9).

R2. **Losing chat replay fidelity.**
Mitigation: by construction — telemetry does not move. Only citation chips re-source to edges, covered by the P1 golden fixture.

R3. **Breaking scope admission.**
Mitigation: context API owns `is_context_ref` and scope extraction; `app_search`/`read_resource`/`inspect_resource` stop querying storage directly. Named delta: user links from a conversation now admit (§5.4), and missing-target chips vanish on cleanup (§9.6) — both intended.

R4. **Silent concordance semantic drift.**
Mitigation: the §5.3 equivalence is pinned in-spec with the reindex delta named; AC21's fixture asserts it. No "should still roughly match" hand-waving.

R5. **`origin` taxonomy re-growing the verb problem.**
Mitigation: origins are writer names, not semantics; each requires a sole writer; stance stays the only user-visible vocabulary. The CHECK is the gate.

R6. **Citation/telemetry split-brain.**
Mitigation: numbering exists only on edges (`citation_ordinal` is dropped, grep-gated); `cited_edge_id` is a one-way pointer; AC6 asserts single-source rendering.

R7. **Overbuilding for one user.**
Mitigation: no graph UI, no generic traversal engine, no multi-tenant policy system, no backfill. Only consolidate existing duplicated primitives.

---

## 20. Done Means

The old link/reference/citation stores are gone. The product still works.

There is one flat edge table, one public backend vocabulary for resources, one graph write owner, one citation read-model with one numbering owner, one frontend citation adapter, one context admission owner, one connections query, and one cleanup owner with two rules.

Links have no verbs. Citations have stances. Telemetry belongs to runs. No feature knows or cares which table used to own its connections.

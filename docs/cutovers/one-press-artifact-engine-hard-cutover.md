# One Press — the scope-generic artifact engine — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims.

## One-line

Generalize the Library-Intelligence artifact/revision engine into one
`artifacts(subject_scheme, subject_id, kind)` press — stable head + immutable
revisions + citations + freshness — driven by a per-kind reducer registry; delete
the `library_intelligence` name everywhere in live code, and ship **conversation
distillation** as the first new customer so a conversation's claims survive its
transcript.

---
## 0. Prerequisites (hard, no fallback)

- **P-1. The LI engine is real and near-isomorphic.** `library_intelligence_artifacts`
  (stable head, `current_revision_id`, `UNIQUE(library_id)`; `models.py:1991-2036`),
  `library_intelligence_artifact_revisions` (immutable snapshot: `content_md`,
  `covered_targets` JSONB, `status`, `idempotency_key`; `models.py:2039-2091`),
  `library_intelligence_revision_events` (`models.py:2094-2125`). The reduce is a
  single `run_structured_synthesis` + `ground_indices("drop")` over an indexed
  candidate list, model-pinned `claude-sonnet-4-6` (`library_intelligence_reduce.py:82,192-208,242,339-346`).
  `media_summaries` is the isomorphic-but-distinct third engine (freshness =
  `content_fingerprint`; `_build_covered_targets` reads it, `:467-478`).
- **P-2. Citations already flow through one owner.** The reduce calls
  `replace_citations_for_output(source=ResourceRef("library_intelligence_revision", revision_id), citations)`
  (`library_intelligence_reduce.py:542-547`); render side is
  `build_citation_outs` → `citation_reader_target_for_edge` (`citations.py:138,213`).
  `route_for_ref` already routes `message` → `/conversations/{conversation_id}`
  (`resource_items/routing.py:80-85`), so a citation **to a message** already
  activates; but `reader_target_for_citation_target` has **no** `message` branch
  (`resolve.py:225-299`) — a message target yields `(None, None)`, so the
  distillate must ship its own `deep_link` in the citation snapshot (exactly as
  LI does, `library_intelligence_reduce.py:450`). Verified.
- **P-3. One SSE plane, one cursor wrapper.** `make_cursor_stream_response`
  (`stream.py:92-111`) serves chat/oracle/LI identically; the LI endpoint is
  `GET /stream/library-intelligence/{revision_id}/events` bound to
  `_LIBRARY_INTELLIGENCE_KIND` + `run_kit.RunStreamKind.LibraryIntelligence`
  (`stream.py:79-89,159-176`; channel `library_intelligence_revision_events`,
  `run_kit.py:51`). FE mirror: `GENERATION_RUN_STREAM_PATHS["library-intelligence"] = "/stream/library-intelligence"`
  (`useGenerationRun.ts:15,33`), decoded by `useLibraryIntelligenceStream`
  (`components/library/useLibraryIntelligenceStream.ts`).
- **P-4. The active branch is readable.** `conversation_branches.get_conversation_tree`
  resolves the viewer's active leaf and returns the selected message path
  (`conversation_branches.py:218-244`); `set_active_path`/`load_leaf_message_path`
  own the leaf contract. This is the sole reader the distillate reducer uses.
- **P-5. Sibling `machine-output-in-place-hard-cutover.md` (SPEC).** Deletes
  `LibraryIntelligencePane.tsx` (857 lines) and re-homes the dossier into a
  `LibraryBrief` family that consumes **`useLibraryIntelligenceStream` +
  `useGenerationRun`** unchanged (its §7.1, D-8), and its **gate 8** anti-regresses
  `GENERATION_RUN_STREAM_PATHS['library-intelligence'] === '/stream/library-intelligence'`
  (its §13). This cutover **renames that hook and path**; §10 declares the exact
  amendment. Do not edit that file.
- **P-6. Sibling `machine-hand-hard-cutover.md` (SPEC).** `components/ui/MachineText.tsx`
  is the sole machine-voice owner; origin labels in use are *Assistant, Synapse,
  Dossier, Dawn, Summary*, and the **label set is open by design** (labels derive
  from the surface's own provenance, its G3/§7). This cutover adds origin label
  **Distillate** — a new label, not a schema change.
- **P-7. Sibling `dawn-write-hard-cutover.md` (SPEC).** Claims migration **0169**
  and **widens `ck_llm_calls_owner_kind` to add `'dawn_write'`** (its §5.2). This
  cutover *renames* `'li_revision'` in the same CHECK; §5 writes the final set
  explicitly and §10 coordinates the drift.
- **P-8. FE↔BE scheme parity is enforced.** `contractParity.test.ts:78-79` asserts
  `RESOURCE_SCHEMES` (`resourceRef.ts:12-33`, includes `library_intelligence_artifact`/
  `library_intelligence_revision`) equals the backend `refs.py:36-51` literals.
  Any scheme rename must land both files in one slice or the guard fails.
- **P-9. Migration chain.** `main` ends at `0168_web_article_inline_embeds`
  (`migrations/alembic/versions/`). **Number assigned at build time — main ends at
  0168, sibling dawn-write spec claims 0169, unmerged branch
  `codex/search-retrieval-roadmap` claims 0168-0173 and renumbers at merge.**

---
## 1. Problem (grounded diagnosis)

### 1.1 The same press is built twice and named once.
`library_intelligence_artifact_revisions` and `media_summaries` are the same
machine — head + immutable snapshot + coverage fingerprint + a single grounded
reduce — but only the library scope carries the "artifact/revision" vocabulary.
`scriptorium.md §V` names two more presses coming (Canon at corpus scope, the
View Compiler at question scope). Four subsystems will diverge unless the engine
is keyed by a `subject_ref` today. The engine is real (P-1) but its name binds it
to one subject: `library_id` is a column, `LibraryIntelligenceArtifact` is a
class, `li_revision` is an `llm_calls.owner_kind`, `library_intelligence_revision`
is a `ResourceScheme` and a citation source (`models.py:671`).

### 1.2 Conversations are unretrievable and their transcripts are the only record.
The search `conversations` kind maps to result types `("conversation", "message")`
(`search/kinds.py:53`) — pure transcript FTS. Nobody rereads a chat log
(`dreams.md`, `scriptorium.md §V`), yet the only durable form of a conversation is
its raw turns. There is no grounded, message-cited summary an idle conversation
can decay into; `resource_edges` can already carry a `citation` edge to a
`message` (target scheme `message` is permitted, `models.py:604-611`; route exists,
P-2) but nothing writes one. The claims die with the transcript.

---
## 2. Target behavior (user-facing)

- **Reader / library owner:** the library dossier looks and streams exactly as
  before; nothing about the dossier surface changes for you (P-5 owns its layout).
- **On any conversation:** a quiet head block (machine voice, origin **Distillate**)
  appears once the conversation has been distilled — two-to-five grounded claims,
  each a footnote deep-linking to the exact message it came from. Your prose is
  never touched; the block is generated matter, marked as such, dismissible by
  collapse.
- **`Distill` verb:** on a conversation (list row action + conversation-pane
  action) you can distill on demand; it streams over the same generation-run plane
  the dossier uses.
- **The night shift:** a conversation left idle > 7 days with ≥ 6 messages and no
  fresh distillate is distilled automatically. It is provenance-marked and visible;
  it writes **no** user prose, so it is a silent *addition*, never a silent
  reorganization.
- **Search:** typing a query in the `conversations` kind now surfaces distillate
  claims (lexical), not only raw transcript lines. Dossiers stay unsearchable, as
  today.

---
## 3. Goals / Non-goals

- **G-1.** One engine `artifacts(subject_scheme, subject_id, kind)` with a
  stable head, immutable `artifact_revisions`, per-revision citations, and per-kind
  freshness — the sole writer of `artifact_revisions`.
- **G-2.** A per-kind **reducer registry**: `library_dossier` (the relocated LI
  reduce, model unchanged) and `conversation_distillate` (new, light model).
- **G-3.** Conversation distillation end to end: reducer + `conversation_distill`
  job + `conversation_distill_sweep` periodic + `Distill` verb + head-block render.
- **G-4.** Distillates are lexically retrievable under the `conversations` search
  kind (internal result type `artifact`).
- **G-5.** The string `library_intelligence` (and `LibraryIntelligence`/
  `libraryIntelligence`) survives **only** in migration history and this spec;
  every live symbol/route/hook is renamed to the artifact/dossier vocabulary.
- **G-6.** Data-preserving migration: every LI row, revision, event, citation edge,
  and ledgered call is carried forward by `UPDATE` + table/constraint rename, with
  row-count assertions.

- **N-1. No** absorption of `media_summaries`/`media_claims` into `artifacts`. The
  isomorphism is real but the fold is a named future follow-up (D-9).
- **N-2. No** Canon (corpus scope) or View Compiler (question scope) built. The
  generic `(subject_scheme, subject_id, kind)` shape *admits* them; their `kind`
  values are not added to the CHECK until built (D-8).
- **N-3. No** transcript deletion / Compost mechanism. The distillate merely makes
  it *possible* later (dreams.md's Compost); nothing is deleted here.
- **N-4. No** new `resource_edges` origin. Distillate claim edges reuse `citation`
  through the existing `replace_citations_for_output` owner.
- **N-5. No** semantic/vector retrieval for distillates in phase 1 — FTS/trigram
  lexical only, mapped into the existing `conversations` kind.
- **N-6. No** change to the library-dossier REST URLs (`/api/libraries/{id}/intelligence…`)
  or its SSE **payload** shape — P-5 depends on the URLs; only the module names,
  the SSE **path**, and the hook name change.

---
## 4. Architecture and final state

### 4.1 Ownership

| Concern | Sole owner (final) | Replaces |
| --- | --- | --- |
| Artifact head (any subject) | `artifacts` table | `library_intelligence_artifacts` |
| Immutable revision snapshot | `artifact_revisions` table | `library_intelligence_artifact_revisions` |
| Revision run events | `artifact_revision_events` table | `library_intelligence_revision_events` |
| Engine: create head/revision, run reduce, promote | `services/artifacts/engine.py` | inline logic in `library_intelligence_reduce.py` |
| Freshness/staleness (`_compute_freshness`, `is_artifact_stale`) | `services/artifacts/engine.py` (D-12) | `services/library_intelligence.py:214` |
| FK-less subject cleanup (`on_subject_deleted`) | `services/artifacts/engine.py`, called by subject owners (D-10) | `library_id` FK cascade |
| Per-kind reduce (inputs, prompt, schema, fingerprint) | `services/artifacts/reducers/` registry | the monolithic LI reduce |
| Library-dossier reduce | `reducers/library_dossier.py` (model `claude-sonnet-4-6`) | `library_intelligence_reduce.py` body |
| Conversation-distillate reduce | `reducers/conversation_distillate.py` (model `claude-haiku-4-5-20251001`) | *new* |
| Revision run-stream kind + channel | `run_kit.RunStreamKind.ArtifactRevision` | `RunStreamKind.LibraryIntelligence` |
| SSE endpoint | `GET /stream/artifact-revisions/{revision_id}/events` | `/stream/library-intelligence/…` |
| Citation edge (source `artifact_revision`) | `replace_citations_for_output` (unchanged owner) | same, renamed scheme |
| Distillate retrieval | `search/retrievers/conversations.py` (`artifact` result type) | *new* |
| FE stream hook | `useArtifactStream` | `useLibraryIntelligenceStream` |
| FE run kind / path | `GENERATION_RUN_STREAM_PATHS["artifact-revisions"]` | `"library-intelligence"` |
| Ref routing (`route_for_ref('artifact'/'artifact_revision', id)`) | `resource_items/routing.py` — branch on the row's `subject_scheme` | the two `library_intelligence_*` branches (`routing.py:136-158`) |

The renamed `route_for_ref` branch **reads the row's `subject_scheme`** (query
selects `subject_scheme, subject_id`, not the old hard-coded `library_id`) and
routes: `library` → `/libraries/{subject_id}?tab=intelligence` (unchanged, D-7);
`conversation` → `/conversations/{subject_id}?distillate=1` (§4.5). S2 verifies
both schemes route.

### 4.2 The engine

`services/artifacts/engine.py` exposes two entry points and consults a registry:

```python
def create_revision(db, *, viewer_id, subject_ref: ResourceRef, kind: str,
                    custom_instruction: str | None = None) -> UUID:
    """Ensure the (subject_scheme, subject_id, kind) head exists, insert a
    'building' revision (idempotency_key-guarded), enqueue the kind's job.
    SOLE creator of artifact heads/revisions."""

async def run_revision(db, *, revision_id: UUID, llm) -> None:
    """Shared reduce loop: load reducer = REDUCERS[revision.kind];
    resolve viewer_id from the subject row (D-13) → reducer.collect(db, subject_ref,
    viewer_id) → build request → run_structured_synthesis → ground_indices('drop')
    → reducer.materialize_citations → reducer.fingerprint → promote
    (run_kit.mark_terminal + head repoint)."""
```

```python
@dataclass(frozen=True)
class ArtifactReducer:
    kind: str                       # 'library_dossier' | 'conversation_distillate'
    model_name: str
    llm_operation: str              # llm_calls.llm_operation, e.g. 'li_reduce' | 'distill'
    collect: Callable[[Session, ResourceRef, UUID | None], ReduceInputs]  # candidates + coverage; viewer_id resolved by the engine (D-13)
    build_request: Callable[[ReduceInputs, str | None], SynthesisRequest]
    schema: type[BaseModel]
    materialize_citations: Callable[..., list[CitationInput]]
    fingerprint: Callable[[Session, ResourceRef, ReduceInputs], list[dict]]  # covered_targets

REDUCERS: dict[str, ArtifactReducer] = {
    "library_dossier": LIBRARY_DOSSIER_REDUCER,
    "conversation_distillate": CONVERSATION_DISTILLATE_REDUCER,
}
```

The promote path (`run_kit.mark_terminal("ready")` FIRST, then content/covered/
citations/head-repoint inside one SERIALIZABLE tx) is lifted verbatim from
`_promote_built_revision` (`library_intelligence_reduce.py:490-560`) — it is
kind-agnostic already. Freshness generalizes: `covered_targets` is whatever the
reducer's `fingerprint` returns (dossier: the media→`content_fingerprint` map,
unchanged; distillate: `[{"kind":"conversation","id":cid,"active_leaf_message_id":…,"message_count":N}]`).

### 4.3 Conversation distillate

`reducers/conversation_distillate.py`:
- **collect:** `collect(db, subject_ref, viewer_id)` reads the viewer's active
  branch via `conversation_branches.get_conversation_tree(db, viewer_id=viewer_id,
  conversation_id=subject_ref.id)` (P-4 — that call **requires** `viewer_id`,
  which the engine resolves and passes, D-13); offers the complete, non-pending
  messages as a 0-indexed list `{index, message_id, role, content}`. (The
  `library_dossier` reducer's `collect` ignores the `viewer_id` argument.)
- **schema/prompt:** `{summary_md: str, claims: [{text: str, message_index: int}]}`
  via `run_structured_synthesis`; model `claude-haiku-4-5-20251001` (light).
- **grounding:** `ground_indices(claims, offered, index_of=lambda c: c.message_index,
  policy="drop")` — the invariant precedent (`library_intelligence_reduce.py:339-346`):
  the model cannot cite a message it was not given.
- **citations:** one `CitationInput` per grounded claim, `target=ResourceRef("message",
  message_id)`, `kind="context"`, `ordinal=N`, snapshot carrying
  `deep_link=f"/conversations/{cid}#message-{message_id}"` and an excerpt of the
  message text (message targets have no reader-jump locator, P-2, so the snapshot's
  own `deep_link` drives activation via `route_for_ref` → `/conversations/{cid}`).
  Written through `replace_citations_for_output(source=ResourceRef("artifact_revision",
  revision_id), …)` — same owner, renamed source scheme (N-4).
- **fingerprint:** `[{"kind":"conversation","id":cid,"active_leaf_message_id":leaf,
  "message_count":N}]`. Staleness = the active branch's complete-message count or
  active leaf changed.

### 4.4 Triggers

- **Verb `Distill`** (`conversationResourceOptions`, list + pane) → `create_revision(
  subject_ref="conversation:<id>", kind="conversation_distillate")`.
- **`conversation_distill` job** (per-kind): thin wrapper → `run_revision`.
- **`conversation_distill_sweep` periodic job** (sweep pattern, one enqueue per
  slot, `periodic_dedupe_key`, `registry.py:79-97`): iterate the user's
  conversations; enqueue `conversation_distill` for each that is idle > 7 days,
  has ≥ 6 complete messages, and has no fresh distillate (no head, or the current
  distillate's `active_leaf_message_id`/`message_count` differs). Default **ON**
  (D-3), gated by the `DISTILL_ENABLED` ops kill-switch (D-14) — no-op when false.

### 4.5 Render

A new FE component `ConversationDistillate` (`components/chat/ConversationDistillate.tsx`,
mounted in `Conversation.tsx` above `<ChatSurface/>`) renders at the head of the
conversation pane: one `MachineText` block, origin `"Distillate"` (a plain `<p>`
shell if P-6 has not yet landed, §10), streaming via
`useArtifactStream({ kind: "artifact-revisions" })` on the conversation's artifact.
Claims render through `MarkdownMessage` + `toReaderCitationData` (the same citation
machinery the dossier uses). Present-but-quiet: collapsed by default, expands to
full `summary_md` (mirrors P-5's `LibraryBrief` disclosure contract). Expand state
persists via `useConversationDistillateExpanded`; a `?distillate=1` param (mirroring
the dossier's `?tab=intelligence` auto-expand) forces the block open and scrolls to
it, so an `artifact` search result (S4) landing in the conversation opens the
distillate (AC-10).

---
## 5. Data model / migration

**One migration `NNNN_one_press_artifact_engine.py`** (number assigned at build
time — P-9). Data-preserving; every step is `UPDATE`/`ALTER … RENAME`, never a drop
of a populated table. Row-count assertions (`SELECT count(*)` before/after each
rename, logged) guard the blast radius (R-1).

### 5.1 Table + column renames

```
ALTER TABLE library_intelligence_artifacts            RENAME TO artifacts;
ALTER TABLE library_intelligence_artifact_revisions   RENAME TO artifact_revisions;
ALTER TABLE library_intelligence_revision_events       RENAME TO artifact_revision_events;
```

On `artifacts`:
1. `ADD COLUMN subject_scheme text` (nullable), `ADD COLUMN subject_id uuid`
   (nullable), `ADD COLUMN kind text` (nullable).
2. Backfill: `UPDATE artifacts SET subject_scheme='library', subject_id=library_id,
   kind='library_dossier';` (assert rows updated == pre-rename count).
3. `ALTER COLUMN subject_scheme SET NOT NULL`, `subject_id SET NOT NULL`,
   `kind SET NOT NULL`.
4. `DROP CONSTRAINT uq_library_intelligence_artifacts_library;`
   `ADD CONSTRAINT uq_artifacts_subject_kind UNIQUE (subject_scheme, subject_id, kind);`
5. `ADD CONSTRAINT ck_artifacts_kind CHECK (kind IN ('library_dossier','conversation_distillate'));`
   and `ADD CONSTRAINT ck_artifacts_subject_scheme CHECK (subject_scheme IN ('library','conversation'));`
   — a DB-layer backstop matching the schema-wide CHECK-guarded scheme-column
   policy (§5.2); `create_revision`'s `resolve_ref` validation (D-2) guards the
   service path, this guards direct/migration writes. Widened alongside
   `ck_artifacts_kind` when a new subject scheme is added (D-8).
6. `DROP COLUMN library_id;` (its FK to `libraries.id` dies with it). `subject_id`
   is deliberately **FK-less** — a polymorphic subject reference, following the
   `resource_edges` no-endpoint-FK doctrine (D-2).
7. Rename FK `fk_li_artifacts_current_revision` → `fk_artifacts_current_revision`
   (still → `artifact_revisions.id`, `use_alter`).

On `artifact_revisions` (rename in place, no data change):
`ix_li_revisions_artifact_created`→`ix_artifact_revisions_artifact_created`;
`ck_li_revisions_status`→`ck_artifact_revisions_status`;
`ck_li_revisions_covered_targets_array`→`ck_artifact_revisions_covered_targets_array`;
FK `artifact_id` retargets to `artifacts.id` automatically on the table rename.
`uq_li_revisions_artifact_idempotency_key` is a **partial unique Index**
(`postgresql_where`, `models.py:2084-2090`), not a `pg_constraint` row, so it is
renamed via `ALTER INDEX uq_li_revisions_artifact_idempotency_key RENAME TO
uq_artifact_revisions_idempotency_key;` (never `RENAME CONSTRAINT`; the `WHERE`
clause is preserved, D-11).

On `artifact_revision_events`:
`ck_li_revision_events_seq_positive`→`ck_artifact_revision_events_seq_positive`;
`ck_li_revision_events_type`→`ck_artifact_revision_events_type` (value set
preserved byte-for-byte: `event_type IN ('meta', 'progress', 'delta', 'done')`,
`models.py:2118-2121`);
`uq_li_revision_events_seq`→`uq_artifact_revision_events_seq`.

### 5.2 `resource_edges` + scheme CHECKs (data-preserving)

Rename the two schemes everywhere they are **stored**, then rebuild every CHECK
that enumerates them. Schemes: `library_intelligence_artifact`→`artifact`,
`library_intelligence_revision`→`artifact_revision`.

```
UPDATE resource_edges SET source_scheme='artifact_revision' WHERE source_scheme='library_intelligence_revision';
UPDATE resource_edges SET target_scheme='artifact_revision' WHERE target_scheme='library_intelligence_revision';
UPDATE resource_edges SET source_scheme='artifact' WHERE source_scheme='library_intelligence_artifact';
UPDATE resource_edges SET target_scheme='artifact' WHERE target_scheme='library_intelligence_artifact';
UPDATE resource_versions       SET resource_scheme=…  WHERE resource_scheme IN (…);
UPDATE resource_view_states    SET surface_scheme=…, target_scheme=… WHERE …;
UPDATE chat_run_turn_contexts  SET subject_scheme=…, requested_subject_scheme=… WHERE …;
UPDATE synapse_suppressions    SET source_scheme='artifact', target_scheme='artifact' WHERE …='library_intelligence_artifact';
```

Then `DROP`+`ADD` each enumerating CHECK, substituting the two new names (and
keeping every other scheme byte-identical):

| Constraint | File anchor | Note |
| --- | --- | --- |
| `ck_resource_versions_resource_scheme` | `models.py:362-374` | both schemes |
| `ck_resource_view_states_surface_scheme` | `models.py:488-501` | both |
| `ck_resource_view_states_target_scheme` | `models.py:502-514` | both |
| `ck_resource_edges_source_scheme` | `models.py:588-601` | both |
| `ck_resource_edges_target_scheme` | `models.py:602-615` | both |
| `ck_resource_edges_citation_shape` | `models.py:659-676` | source list: `('message','oracle_reading','artifact_revision')` |
| `ck_synapse_suppressions_source_scheme` | `models.py:868-879` | only `library_intelligence_artifact` (no `_revision`) |
| `ck_synapse_suppressions_target_scheme` | `models.py:880-891` | only `library_intelligence_artifact` |
| `ck_chat_run_turn_contexts_requested_subject_scheme` | `models.py:4903-4911` | both |
| `ck_chat_run_turn_contexts_subject_scheme` | `models.py:4912-4920` | both |

**Distillate targets need no CHECK widening:** `message` is already a permitted
`target_scheme` on `resource_edges` (`models.py:604-611`) and the citation-shape
CHECK constrains only `source_scheme`/`ordinal`, never `target_scheme`
(`models.py:659-676`). The only citation-shape change is the source rename
`library_intelligence_revision`→`artifact_revision` (D-4).

### 5.3 `ck_llm_calls_owner_kind` (rename + drift coordination)

```
UPDATE llm_calls SET owner_kind='artifact_revision' WHERE owner_kind='li_revision';
```
Then drop + re-add the CHECK. **Final set, written explicitly to survive dawn-write
drift** (P-7): if dawn-write's `0169` has already added `'dawn_write'`, this
migration must not remove it; if this lands first, dawn-write re-adds it onto the
renamed set. The final enumerated set is:

```
owner_kind IN ('chat_run', 'oracle_reading', 'artifact_revision',
               'media_summary', 'media_enrichment', 'synapse_scan', 'dawn_write')
```

The migration writes the CHECK **including `'dawn_write'`** and, before re-adding,
runs `ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS ck_llm_calls_owner_kind`
(idempotent to either landing order). §10 states the ordering contract.

### 5.4 Downgrade

Reverse `UPDATE`s (`artifact_revision`→`li_revision`, `artifact`→
`library_intelligence_artifact`, etc.), re-add original CHECK names, re-add
`library_id` + backfill from `subject_id` where `subject_scheme='library'`,
`DELETE FROM artifacts WHERE kind='conversation_distillate'` (with their revisions/
events/edges), drop the three new columns + `uq_artifacts_subject_kind` +
`ck_artifacts_kind`, rename tables back. `'dawn_write'` handling mirrors §5.3.

---
## 6. API

No new REST route; no `API_ROUTE_COUNT` change. The library-dossier REST facade
keeps its URLs (`GET /api/libraries/{id}/intelligence`, `…/intelligence/revisions`,
`…/revisions/{id}`, `POST …/intelligence/generate`, `POST …/revisions/{id}/promote`)
so `machine-output-in-place` (P-5) is undisturbed; only the **module** is renamed
(`routes/library_intelligence.py`→`routes/library_dossier.py`) and its internals
call the shared engine.

| Change | From | To |
| --- | --- | --- |
| Revision SSE | `GET /stream/library-intelligence/{revision_id}/events` | `GET /stream/artifact-revisions/{revision_id}/events` |
| `CursorStreamKind` binding | `_LIBRARY_INTELLIGENCE_KIND` | `_ARTIFACT_REVISION_KIND` |
| Distill verb | — | `POST /api/conversations/{id}/distill` → `create_revision(subject_ref="conversation:<id>", kind="conversation_distillate")` (thin; returns `revision_id`) |
| Distillate read | — | `GET /api/conversations/{id}/distillate` (current revision content + citations) |

Distill/distillate handlers live in the existing conversations route module and
delegate to the engine; they are the only new endpoints (net +2 routes).

---
## 7. Frontend

### 7.1 Created / renamed

| File | Change |
| --- | --- |
| `components/library/useLibraryIntelligenceStream.ts` | → `useArtifactStream.ts` (rename; body unchanged except `kind: "artifact-revisions"`) |
| `lib/api/sse/libraryIntelligenceEvents.ts` | → `artifactRevisionEvents.ts` (rename) |
| `lib/api/useGenerationRun.ts` | `GenerationRunKind` `"library-intelligence"`→`"artifact-revisions"`; `GENERATION_RUN_STREAM_PATHS` key/value → `"/stream/artifact-revisions"` (`:15,33`) |
| `lib/resourceGraph/resourceRef.ts` | `RESOURCE_SCHEMES` `library_intelligence_artifact`→`artifact`, `library_intelligence_revision`→`artifact_revision` (`:25-26`) — lockstep with `refs.py` (P-8) |
| `lib/resources/resourceKind.ts`, `resourceCapabilities.generated.ts` | regenerate/rename LI scheme members |
| `lib/reader/documentMap.ts`, `components/reader/document-map/ReaderDocumentMapConnectionsLens.tsx` | rename LI scheme literals |
| `components/chat/ConversationDistillate.tsx` | **new** — head block, `MachineText` origin `"Distillate"`, `useArtifactStream`, citation render (colocated with every other conversation component in `components/chat/`) |
| `lib/actions/resourceActions.ts` | add `distill-conversation` option to `conversationResourceOptions` (`:286`) |

### 7.2 Adoption map (distillate render)

```
components/chat/Conversation.tsx  (mounts above <ChatSurface …/>)
 └─ ConversationDistillate (owner: conversation artifact + useArtifactStream + expand)
     ├─ status unavailable & no content → nothing (silence) + Distill affordance in pane options
     ├─ status building                 → MachineText "Distillate" streaming summary
     └─ current revision present        → collapsed lede ──expand──▶ full summary_md + claim footnotes
```

The dossier's own consumer (`LibraryBrief` in P-5, or `LibraryIntelligencePane.tsx`
if P-5 has not landed) swaps `useLibraryIntelligenceStream`→`useArtifactStream`.
No layout change to the dossier — only the hook identifier.

---
## 8. Key decisions

- **D-1. One engine keyed by `subject_ref`, per-kind reducers.** The reduce loop
  (collect → synth → ground → materialize → promote) is genuinely kind-agnostic;
  only inputs, prompt/schema, model, and fingerprint differ, and those are exactly
  the registry's four functions. *Rejected:* copy the LI reduce into a parallel
  `conversation_distill.py` — that would fork `ground_indices`, the promote tx, and
  the SERIALIZABLE ordering, re-creating the isomorphism §1.1 exists to kill.
- **D-2. `subject_id` is FK-less.** A polymorphic subject (`library`, `conversation`,
  later `user`/`corpus`) cannot carry a single FK. This follows the resource-graph
  doctrine ("resource_edges has deliberately no endpoint FKs; cleanup is the graph
  service's job") — the engine's `create_revision` validates the subject via
  `resolve_ref` before minting a head; deletion cleanup is the subject's owner's job.
  *Rejected:* a nullable per-scheme FK column set (`library_id`, `conversation_id`, …)
  — that is the flat-table anti-pattern this consolidation deletes.
- **D-3. The distillate sweep is ON by default.** Ambient generation is acceptable
  here **because it never mutates user prose** — it only *adds* a provenance-marked,
  visible, dismissible artifact (the horizons/scriptorium ambient-writer thesis;
  explicit-UI doctrine forbids silent *reorganization*, not silent *addition*).
  *Rejected:* an opt-in **product** flag that gates the *feature* per user — that
  is the "flags-for-old-behavior" governance sprawl the hard-cutover doctrine
  forbids; a single-user prototype does not need a per-feature toggle surface. This
  is distinct from the **ops kill-switch** `DISTILL_ENABLED` (D-14), which *does*
  exist as a deploy safety valve — the doctrine citation applies only to the
  product flag, not the kill-switch.
- **D-4. Distillate claims cite `message` with a self-supplied `deep_link`.** The
  citation-shape CHECK already permits `message` targets and the source rename covers
  `artifact_revision`; `reader_target_for_citation_target` has no message branch, so
  the reducer ships the `deep_link` in the snapshot exactly as LI ships its
  `#evidence-…` link. *Rejected:* adding a `message` branch to
  `reader_target_for_citation_target` — a message has no in-reader position to jump to;
  the conversation route + anchor is the honest target.
- **D-5. Distillate uses the light model; the dossier keeps Sonnet.** `claude-haiku-4-5-20251001`
  for a per-conversation summary (cheap, frequent, ambient); `claude-sonnet-4-6`
  unchanged for the whole-library reduce. Model pins live on the reducer, not the
  engine.
- **D-6. Per-kind job kinds over one generic job.** `library_dossier_generate`
  (renamed from `library_intelligence_artifact_generate`) and `conversation_distill`
  are thin wrappers over `run_revision`; the sweep is `conversation_distill_sweep`.
  *Rejected:* a single `artifact_revision_generate` job dispatched by subject scheme
  — the two differ in `USER_FACING_JOB_KINDS` classification (dossier generate is
  user-observed; the sweep is ambient housekeeping) and in payload/trigger, and the
  worker allowlist reads cleaner as named kinds.
- **D-7. REST URLs stay; only names move.** Renaming `/api/libraries/{id}/intelligence`
  would break P-5, which reads those exact URLs and declares "no route change." The
  hard-cutover target is the *symbol* `library_intelligence`, not the *word*
  "intelligence" in a library sub-resource URL. The module renames to
  `library_dossier.py`; the URL is unchanged.
- **D-8. `artifacts.kind` CHECK holds only built kinds.** Canon/View-Compiler are
  admitted by the generic `(subject_scheme, subject_id, kind)` **shape**, not by
  speculative enum values. Adding `'user_canon'`/`'question_view'` is a one-line CHECK
  widening when those cutovers land. *Rejected:* pre-seeding reserved kind values —
  "no speculative code."
- **D-9. `media_summaries` is not absorbed now.** It is retrieval substrate with a
  different freshness cadence (fingerprint-per-content, rebuilt on ingest, not
  subject-scoped promote). The fold is acknowledged (scriptorium §V: "absorbs
  `media_summaries`") and named as a future follow-up, not built here.
- **D-10. FK-less `subject_id` cleanup has a named owner (`on_subject_deleted`).**
  No FK (D-2) means no cascade when a subject dies. The engine exposes
  `on_subject_deleted(db, subject_ref)` (deletes the head + revisions + events +
  citation edges for that subject); the subject owner calls it from its delete path
  (conversation-delete → `"conversation:<id>"`; library-delete → `"library:<id>"`,
  replacing the dropped `library_id` cascade), mirroring the resource-graph
  `purge_edges_for_subject` pattern. *Rejected:* documented orphans — the "graph
  service never cleans up" gap the doctrine forbids.
- **D-11. Partial unique indexes rename via `ALTER INDEX`, not `RENAME CONSTRAINT`.**
  `uq_li_revisions_artifact_idempotency_key` is a partial unique *Index*
  (`postgresql_where`), not a `pg_constraint` row, so `RENAME CONSTRAINT` errors;
  §5.1 uses `ALTER INDEX … RENAME TO`, preserving the `WHERE` clause untouched.
- **D-12. Freshness/staleness lives in `services/artifacts/engine.py`.** The folded
  `services/library_intelligence.py` `_compute_freshness` + the dawn-write wrapper
  `is_artifact_stale` (P-7/§10) move onto the engine — `create_revision` is the
  caller that gates idempotent rebuilds by freshness — so no ghost dependency is
  left dangling (§4.1 row).
- **D-13. The engine resolves `viewer_id` and threads it to `collect`.**
  `get_conversation_tree` requires `viewer_id` (P-4); the `(Session, ResourceRef)`
  signature can't carry it. `run_revision` resolves it from the subject row
  (`conversation`→`conversations.user_id`; `library`→`None`, dossier ignores it),
  so `collect` is `Callable[[Session, ResourceRef, UUID | None], ReduceInputs]`.
  *Rejected:* a `viewer_id` column on `artifact_revisions` — the subject row owns
  the answer; a copy would drift.
- **D-14. The sweep has an ops kill-switch `DISTILL_ENABLED` (default `true`).**
  **Not** the opt-in *product* flag the doctrine forbids (D-3) — a deploy safety
  valve on a new ambient night job, identical to `SYNAPSE_ENABLED`/`DAWN_WRITE_ENABLED`
  (one field, one no-op guard, no old behavior preserved).
  `queue_conversation_distill`/the sweep return immediately when false.

---
## 9. What dies (exhaustive)

**Renamed tables (data preserved):** `library_intelligence_artifacts`→`artifacts`,
`library_intelligence_artifact_revisions`→`artifact_revisions`,
`library_intelligence_revision_events`→`artifact_revision_events` (§5.1).

**Renamed ORM classes (`models.py`):** `LibraryIntelligenceArtifact`→`SynthesisArtifact`
(`:1991` — a domain-qualified name, not the bare English noun `Artifact`, matching
the `LibraryEntry`/`MediaSummary`/`OraclePassageAnchor` convention and avoiding
`from db.models import Artifact` ambiguity, F11),
`LibraryIntelligenceArtifactRevision`→`ArtifactRevision` (`:2039`; compound, already
unambiguous), `LibraryIntelligenceRevisionEvent`→`ArtifactRevisionEvent` (`:2094`).

**Renamed schemes (both files, P-8):** `library_intelligence_artifact`→`artifact`,
`library_intelligence_revision`→`artifact_revision` in `refs.py:28-29,49-50` and
`resourceRef.ts:25-26`; every CHECK in §5.2; `route_for_ref` branches
(`resource_items/routing.py:136-158`).

**Renamed Python modules/symbols (the 23 files matching `library_intelligence`):**
`services/library_intelligence_reduce.py`→`services/artifacts/reducers/library_dossier.py`;
`services/library_intelligence_revisions.py`→`services/artifacts/revisions.py`;
`services/library_intelligence.py`→folded into `services/artifacts/` (its
`_compute_freshness`/`is_artifact_stale` → `services/artifacts/engine.py`, D-12);
`schemas/library_intelligence.py`→`schemas/artifact.py` (symbols
`LibraryIntelligenceRevisionEventOut`→`ArtifactRevisionEventOut`,
`LibraryIntelligenceDoneEventPayload`→`ArtifactDoneEventPayload`, `ArtifactStatus`
kept, other `LibraryIntelligence*` schema classes → `Artifact*`/`Dossier*`; its
five importers — `run_kit.py:41`, `library_intelligence_reduce.py:46`,
`tasks/library_intelligence.py:13`, `api/routes/library_intelligence.py:12`,
`services/library_intelligence.py:34` — updated);
`tasks/library_intelligence.py`→`tasks/artifacts.py`;
`api/routes/library_intelligence.py`→`api/routes/library_dossier.py` (URLs kept, D-7);
`run_kit.py` (`RunStreamKind.LibraryIntelligence`→`ArtifactRevision`, class imports,
`library_intelligence_revision_stream`→`artifact_revision_stream`, channel
`library_intelligence_revision_events`→`artifact_revision_events`, `:35-59,77-89`);
plus scheme-literal edits in `resource_graph/resolve.py`, `resource_graph/refs.py`,
`agent_tools/read_resource.py`, `resource_items/{routing,chat_subjects,capabilities}.py`,
`schemas/{reader,resource_items}.py`, `services/{reader_connections,library_governance,
object_refs}.py`, and `config.py` (LI settings → `dossier_*`/`artifact_*`).

**Renamed job kind:** `library_intelligence_artifact_generate`→`library_dossier_generate`
(`registry.py:124`); **added:** `conversation_distill`, `conversation_distill_sweep`.

**Renamed FE (files matching `LibraryIntelligence`/`libraryIntelligence`):**
`useLibraryIntelligenceStream.ts`→`useArtifactStream.ts`;
`sse/libraryIntelligenceEvents.ts`→`sse/artifactRevisionEvents.ts`;
`GenerationRunKind` literal + path (`useGenerationRun.ts:15,33`); the LI scheme
members in `resourceKind.ts`, `resourceCapabilities.generated.ts`, `documentMap.ts`,
`ReaderDocumentMapConnectionsLens.tsx`.

**Renamed `llm_calls.owner_kind`:** `li_revision`→`artifact_revision`
(`models.py:4011`; §5.3).

**Explicitly NOT deleted / NOT renamed:** the library-dossier REST **URLs**
(`/api/libraries/{id}/intelligence…`, D-7); `media_summaries`/`media_claims` (D-9);
`resource_edges` origins (none added, N-4); the `LibraryIntelligencePane.tsx` file
(that deletion belongs to `machine-output-in-place`, P-5 — this cutover only renames
the hook it consumes); the `intelligence` word inside library-scoped URLs and the
`conversations` search-kind name.

**Superseded specs:** `library-intelligence-ai-native-consolidation-hard-cutover.md`
and `library-intelligence-revision-resource-identity-hard-cutover.md` are
**SUPERSEDED** by this cutover (engine generalization) together with
`machine-output-in-place-hard-cutover.md` (surface re-homing). Their substrate is
carried forward under the artifact vocabulary; their `library_intelligence` naming
is retired.

---
## 10. Sibling cutovers and sequencing

- **`machine-output-in-place-hard-cutover.md` (SPEC) — sequence BEFORE this.**
  It deletes `LibraryIntelligencePane.tsx` and builds `LibraryBrief`, which consumes
  `useLibraryIntelligenceStream`. If it lands first, this cutover renames the hook
  it references (`LibraryBrief` → `useArtifactStream`) and **amends its gate 8**. Its
  gate 8 asserts `GENERATION_RUN_STREAM_PATHS['library-intelligence'] === '/stream/library-intelligence'`;
  **the replacement gate is:**
  ```ts
  expect(GENERATION_RUN_STREAM_PATHS["artifact-revisions"]).toBe("/stream/artifact-revisions");
  ```
  If this cutover lands first, `machine-output-in-place` rebases its `LibraryBrief`
  hook import + gate 8 onto the renamed hook/path. Either way, **do not edit that
  sibling file** — the amendment is declared here. No SSE payload or event shape
  changes (P-5's D-8 holds under the rename).
  **Superseded sibling claims (declared, not silently falsified):** this cutover
  supersedes two assertions in `machine-output-in-place` that name the old path —
  its **AC-4** (§12) and **gate 8** (§13), both asserting
  `GENERATION_RUN_STREAM_PATHS["library-intelligence"] === "/stream/library-intelligence"`.
  Post-rename both read `["artifact-revisions"] === "/stream/artifact-revisions"`;
  recorded here as superseded so no reader treats them as live.
- **`machine-hand-hard-cutover.md` (SPEC) — sequence BEFORE S5.** Provides
  `components/ui/MachineText.tsx`; this cutover adds origin label `"Distillate"`
  (an open-set label, P-6). **Hard prerequisite:** `MachineText.tsx` does **not**
  yet exist in the tree (`rg -n 'MachineText' apps/web/src` returns zero), and P-6
  is SPEC-only. S5 must not start until P-6 has landed and `MachineText.tsx`
  exists; if P-6 slips, S5 renders the block with a plain `<p>` shell wearing the
  same collapse/citation contract and adopts `MachineText` when P-6 lands (a
  one-import swap, no schema change). The dossier's `"Dossier"` label and the
  Synapse `"Synapse"` label are untouched.
- **`dawn-write-hard-cutover.md` (SPEC, claims mig 0169).** Both migrations touch
  `ck_llm_calls_owner_kind`. **Ordering contract:** whichever lands second must
  `DROP CONSTRAINT IF EXISTS` and re-add the **union** set — final set including both
  the `li_revision`→`artifact_revision` rename **and** `'dawn_write'` (§5.3). This
  cutover writes the CHECK with `'dawn_write'` present so a later dawn-write migration
  is a no-op on that value; dawn-write's spec adds `'dawn_write'` onto whatever set
  exists. At merge, migration numbers renumber (P-9); the two migrations are
  order-independent by the `IF EXISTS` + explicit-full-set rule.
  **Signal C breakage (beyond the CHECK).** Dawn-write's Signal C queries
  `library_intelligence_artifacts JOIN libraries ON lib.id = art.library_id JOIN
  library_intelligence_artifact_revisions` and calls `is_artifact_stale(…,
  library_id=…)` in `services/library_intelligence.py` (its §4.4/§15) — **all three
  names this cutover destroys** (tables renamed, `library_id` dropped, module
  folded). Whichever lands second rebases Signal C onto `artifacts`/
  `artifact_revisions`, joins on `subject_id` filtered `subject_scheme='library'`
  (not `library_id`), and imports `is_artifact_stale` from its new home
  `services/artifacts/engine.py` (D-12).
- **No other sibling** adds a `resource_edges` origin, touches `ck_llm_calls_owner_kind`,
  or renames a `ResourceScheme`; the scheme rename is this cutover's alone. Shared
  files touched by multiple specs — `useGenerationRun.ts` (P-5), `resourceActions.ts`
  (P-5 deletes `view-library-intelligence`; this adds `distill-conversation`),
  `paneSecondaryModel.ts` (P-5 deletes the `library-intelligence` surface) — are
  coordinated by sequencing P-5 first.

---
## 11. Slices (each independently buildable)

- **S0 — Migration + row-count harness.** Write `NNNN_one_press_artifact_engine.py`
  (§5): table/column/constraint renames, scheme + owner_kind `UPDATE`s, CHECK
  rebuilds, `subject_*`/`kind` backfill, `library_id` drop, row-count assertions.
  *Verify:* `cd python && uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head`; `make test-migrations`.
- **S1 — Mechanical code rename (no behavior change).** Rename the 22 Python files/
  symbols + 3 ORM classes + schemes + `run_kit` kind/channel + job kind + FE hook/
  path/scheme literals (§9), in lockstep so `contractParity.test.ts` stays green.
  *Verify:* `cd python && uv run ruff check . && uv run pyright && make test-back-integration`;
  `cd apps/web && bun run typecheck && bun run test:unit && bun run test:browser`;
  the negative gate §13.1 (`rg 'library_intelligence'`).
- **S2 — Engine + reducer registry.** Extract `services/artifacts/engine.py`
  (`create_revision`, `run_revision`) + `ArtifactReducer` registry; relocate the LI
  reduce as `reducers/library_dossier.py` (model, prompt, grounding, promote all
  byte-preserved). The dossier now flows through the engine.
  *Verify:* `make test-back-integration` (dossier suite green, no output diff);
  §13.2 gate (sole writer of `artifact_revisions`).
- **S3 — Distillate reducer + job + verb.** `reducers/conversation_distillate.py`
  (collect active branch, schema, ground, message citations, fingerprint);
  register both job kinds in `registry.py`, but **split their classification**
  (D-6): `conversation_distill` → `USER_FACING_JOB_KINDS` **and**
  `DEFAULT_WORKER_ALLOWED_JOB_KINDS` (user-observed on-demand distill);
  `conversation_distill_sweep` → `DEFAULT_WORKER_ALLOWED_JOB_KINDS` **only**
  (ambient housekeeping, matching the periodic-sweep pattern). Add
  `DISTILL_ENABLED: bool = Field(default=True, alias="DISTILL_ENABLED")` to
  `config.py` (D-14) + `# DISTILL_ENABLED=true` to `env-prod-worker.example` +
  `sync-env.sh`, threaded into `queue_conversation_distill`/the sweep as a no-op
  guard; `POST /api/conversations/{id}/distill`.
  *Verify:* new BE integration tests (distill a seeded conversation, assert grounded
  message edges + covered fingerprint + idle-sweep enqueue); `make test-migrations`.
- **S4 — Search retriever.** Add an `artifact` result type to the `conversations`
  kind (`search/kinds.py:53` → `("conversation","message","artifact")`) + a lexical
  (FTS/trgm) retriever over `artifact_revisions` where `kind='conversation_distillate'`
  and the row is `current` (promoted). Dossiers excluded. Define the result shape
  `ConversationArtifactSearchOut` (in the search output schemas file alongside the
  existing `conversation`/`message` out-schemas) carrying at minimum `revision_id`,
  `subject_ref` (`conversation:<id>`), `content_excerpt`, and `kind`; the FE renders
  it as a distillate hit that activates via `?distillate=1` (AC-10, F13).
  *Verify:* BE search integration test (distillate content matches a `conversations`-kind
  query and returns a `ConversationArtifactSearchOut`; a dossier does not).
- **S5 — FE distillate block.** *Prerequisite:* P-6 (`machine-hand`) has landed and
  `components/ui/MachineText.tsx` exists (§10); otherwise render the plain-`<p>`
  shell and swap in `MachineText` when P-6 lands.
  `ConversationDistillate.tsx` (MachineText origin `"Distillate"`, `useArtifactStream`,
  citation render) mounted at `components/chat/Conversation.tsx` above `<ChatSurface/>`;
  `distill-conversation` verb wired.
  *Verify:* `cd apps/web && bun run test:browser` (block renders, streams, expands,
  citations deep-link); `bun run test:unit`.

---
## 12. Acceptance criteria (testable)

- **AC-1.** After S0, every LI artifact/revision/event/citation-edge/ledger row is
  present under the renamed tables/schemes; `SELECT count(*)` is identical pre/post.
- **AC-2.** `artifacts` enforces `UNIQUE(subject_scheme, subject_id, kind)`,
  `kind IN ('library_dossier','conversation_distillate')`, and
  `subject_scheme IN ('library','conversation')`; `subject_id` has no FK.
- **AC-3.** The library dossier generates, streams, promotes, and renders exactly as
  before over `/stream/artifact-revisions/{id}/events` — no user-visible change.
- **AC-4.** `Distill` on a ≥6-message conversation produces a revision whose claims
  each carry a `citation` edge `artifact_revision → message` with a
  `/conversations/{cid}#message-{mid}` deep link; ungrounded claims are dropped.
- **AC-5.** The distillate head block renders in machine voice (origin `"Distillate"`),
  collapsed-by-default, expandable, dismissible; it writes no user prose.
- **AC-6.** The sweep enqueues `conversation_distill` for a conversation idle > 7 days
  with ≥ 6 complete messages and no fresh distillate, and skips one whose current
  distillate's `active_leaf_message_id`/`message_count` still matches.
- **AC-7.** A `conversations`-kind search surfaces a distillate claim (result type
  `artifact`); a `library_dossier` artifact never appears in any search result.
- **AC-8.** `ground_indices("drop")` is the sole grounding gate for both kinds; a
  claim citing an unoffered message index never persists an edge.
- **AC-9.** `rg 'library_intelligence'` over `nexus/` + `apps/web/src` returns
  **zero** hits (matches only under `migrations/alembic/versions/` and this spec).
- **AC-10.** Activating an `artifact` search result (§S4) navigates to the source
  conversation with `?distillate=1`, which auto-expands the `ConversationDistillate`
  block and scrolls it into view; the expand state persists across pane re-mounts.

---
## 13. Negative gates (grep-able)

### 13.1 The name is gone from live code
```bash
# Zero hits outside migration history and this spec.
rg -n 'library_intelligence|LibraryIntelligence|libraryIntelligence' \
   python/nexus apps/web/src \
   && echo 'FAIL: library_intelligence survives in live code' || echo OK
```
**Valid only once P-5 (`machine-output-in-place`) has deleted
`LibraryIntelligencePane.tsx` + `LibraryIntelligencePane.test.tsx`** (both under
`apps/web/src`, full of `LibraryIntelligence` identifiers) — §10 sequences P-5
first. Run before P-5 and it false-fails on those two files plus the line-3 comment
in `lib/conversations/citations.ts` (updated here, F6). AC-9 asserts the same
zero-hit invariant post-P-5.

### 13.2 One writer of `artifact_revisions`
```bash
# Only the engine INSERTs/UPDATEs artifact_revisions (+ the migration).
rg -n "INSERT INTO artifact_revisions|UPDATE artifact_revisions|ArtifactRevision\(" \
   python/nexus | rg -v 'services/artifacts/' \
   && echo 'FAIL: a non-engine writer of artifact_revisions' || echo OK
```

### 13.3 No new edge origin; distillate reuses `citation`
```bash
rg -n "origin\s*=\s*['\"](distillate|distill)" python/nexus \
   && echo 'FAIL: distillate minted a non-citation origin' || echo OK
# EDGE_ORIGINS unchanged — assert the full 7-value set (the CHECK wraps across
# two lines, so use -U) so a dropped 'synapse'/'document_embed' can't slip past
# a prefix match:
rg -U -n "'user', 'citation', 'system', 'note_body', 'highlight_note',\s*'synapse', 'document_embed'" python/nexus/db/models.py
```

### 13.4 Scheme parity holds
```bash
# resourceRef.ts RESOURCE_SCHEMES must contain artifact/artifact_revision, not the LI names.
rg -n "library_intelligence" apps/web/src/lib/resourceGraph/resourceRef.ts \
   && echo 'FAIL: FE scheme not renamed' || echo OK
```
(`contractParity.test.ts` remains the executable guard, P-8.)

### 13.5 `ck_llm_calls_owner_kind` final set
```bash
# The migration must write the full union set including artifact_revision + dawn_write.
rg -n "artifact_revision.*dawn_write|dawn_write.*artifact_revision" \
   migrations/alembic/versions/*one_press* || echo 'CHECK the owner_kind union set'
```

---
## 14. Test plan

- **Unit (`.test.ts`):** `useGenerationRun.test.tsx` updated to
  `["artifact-revisions", "${BASE}/stream/artifact-revisions/run-1/events"]`;
  `resourceActions.test.ts` gains `distill-conversation`; `artifactRevisionEvents`
  decoder test (renamed).
- **Browser (`.test.tsx`):** `ConversationDistillate.test.tsx` — machine-voice block,
  streaming, expand/collapse, claim footnote deep-links, `?distillate=1` auto-expand
  (AC-10), silence when no artifact.
  `LibraryIntelligencePane.test.tsx` is **deleted by P-5** (which §10 sequences
  before this cutover) — no action here; the dossier's stream-path regression now
  lives in the P-5-owned `LibraryBrief` test, which anti-regresses
  `GENERATION_RUN_STREAM_PATHS["artifact-revisions"]` per the amended gate 8 (§10).
- **Guards:** `contractParity.test.ts` (scheme parity); §13 rg gates in CI.
- **BE (`make test-back-integration`):** dossier no-diff after S2; distillate reducer
  (grounding drop, message-edge shape, fingerprint), engine `create_revision`
  idempotency, sweep enqueue predicate, search retriever inclusion/exclusion.
  `make test-migrations` for S0 up/down/up + row-count assertions.
- **Static:** `uv run ruff check . && uv run pyright`; `bun run typecheck`.
- **E2E:** distill a seeded conversation from the pane verb; assert the head block
  and a claim deep-link navigating to the cited message. (Written; not gating.)

---
## 15. Files (created / modified / deleted)

**Created:** `services/artifacts/engine.py`, `services/artifacts/reducers/__init__.py`,
`services/artifacts/reducers/library_dossier.py` (relocated),
`services/artifacts/reducers/conversation_distillate.py`,
`services/artifacts/revisions.py` (relocated), `tasks/artifacts.py` (relocated),
`apps/web/src/components/chat/ConversationDistillate.tsx`,
`migrations/alembic/versions/NNNN_one_press_artifact_engine.py`.

**Modified:** `db/models.py` (3 classes + 10 CHECKs + `owner_kind` + FK/index names),
`resource_graph/{resolve,refs}.py`, `resource_items/{routing,chat_subjects,capabilities}.py`,
`schemas/{reader,resource_items}.py`, `run_kit.py`, `api/routes/stream.py`,
`api/routes/__init__.py`, `jobs/registry.py`, `config.py`, `services/search/kinds.py`,
`services/search/retrievers/conversations.py`, `services/{reader_connections,
library_governance,object_refs}.py`, `agent_tools/read_resource.py`, conversations
route module (+2 endpoints; **conversation-delete handler calls
`engine.on_subject_deleted("conversation:<id>")`**, D-10), the library-delete path
(calls `on_subject_deleted("library:<id>")`, replacing the dropped `library_id` FK
cascade, D-10), `deploy/env/env-prod-worker.example`,
`deploy/hetzner/sync-env.sh`; FE `lib/api/useGenerationRun.ts`,
`lib/resourceGraph/resourceRef.ts`, `lib/resources/{resourceKind,resourceCapabilities.generated}.ts`,
`lib/reader/documentMap.ts`, `components/reader/document-map/ReaderDocumentMapConnectionsLens.tsx`,
`lib/actions/resourceActions.ts`, `lib/conversations/citations.ts` (its line-3
comment names `LibraryIntelligencePane`; updated to the P-5 replacement consumer
so §13.1 stays green — F6), the dossier hook consumer.

**Renamed (file moves):** `services/library_intelligence_reduce.py`,
`services/library_intelligence_revisions.py`, `services/library_intelligence.py`,
`schemas/library_intelligence.py`→`schemas/artifact.py` (F1),
`tasks/library_intelligence.py`, `api/routes/library_intelligence.py`;
FE `components/library/useLibraryIntelligenceStream.ts`,
`lib/api/sse/libraryIntelligenceEvents.ts`.

**Deleted:** none by this cutover (renames preserve data/behavior; the only file
*deletion* in this area — `LibraryIntelligencePane.tsx` — belongs to
`machine-output-in-place`, P-5/§10).

---
## 16. Risks

- **R-1. Rename blast radius (HIGH).** The scheme/table/owner_kind rename crosses ~22
  Python files, 8 FE files, 10 CHECK constraints, and every stored edge/revision/ledger
  row. *Mitigation:* S0 is a data-preserving migration with `SELECT count(*)`
  assertions per rename; S1 is a purely mechanical rename gated by `pyright`,
  `contractParity.test.ts`, and §13.1's `rg` gate before any behavior slice; the
  scheme rename lands `refs.py` + `resourceRef.ts` in one commit (P-8).
- **R-2. `ck_llm_calls_owner_kind` drift vs dawn-write (MEDIUM).** Two unmerged specs
  rewrite the same CHECK. *Mitigation:* §5.3/§10 mandate `DROP CONSTRAINT IF EXISTS` +
  re-adding the **explicit full union set** (`…, 'artifact_revision', …, 'dawn_write'`),
  making the two migrations order-independent; §13.5 asserts the union.
- **R-3. Ambient distillation surprises the user (MEDIUM).** A night job writing
  visible content could read as "silent reorganization." *Mitigation:* D-3 — the
  distillate is an *addition*, never a mutation of user prose; machine-voice + origin
  label + collapse-to-dismiss make provenance and reversibility explicit; the sweep is
  a single per-slot job on the existing periodic pattern (no fan-out).
- **R-4. Message citations don't jump in-reader (LOW).** A message has no reader
  locator (P-2). *Mitigation:* D-4 — the reducer supplies the `deep_link`; activation
  routes through `/conversations/{cid}` via `route_for_ref`, so the footnote lands on
  the cited turn, not inside a document reader.
- **R-5. `covered_targets` freshness ambiguity for conversations (LOW).** Branch edits
  could make "did it change?" fuzzy. *Mitigation:* the fingerprint records the active
  leaf id + complete-message count; the sweep predicate treats any change to either as
  stale, and `Distill` always regenerates.

# Synapse Resonance Engine

Status: BUILT + adversarially reviewed (10-dimension fleet, ~30 findings
fixed) + verified 2026-06-10 on worktree branch `worktree-synapse-resonance`
Type: additive feature on the resource provenance graph — greenfield, no old
store replaced, but held to cutover discipline: one owner, hard contracts, no
flags-for-old-behavior, no metadata escape hatches.
Base: branch from `6bf4a71a` ("Make note connections editable"). Built in
worktree `synapse-resonance` while the notes-pages object-graph cutover is in
flight in the main checkout — see §13 merge notes.

## 0. North Star

Nexus means *connection*. Today every connection in `resource_edges` is written
by a human hand or deterministic sync. Synapse adds the first **agent
co-author**: a background engine that, when an object is created or settles,
retrieves resonant material from the whole corpus, asks a model which
candidates *genuinely* illuminate the source, and writes the survivors into the
same graph as first-class, stance-typed, dismissible edges — each carrying a
one-line rationale.

The user experience: you highlight a passage, and a moment later the
Connections section knows that *"this contradicts the claim you highlighted in
March"* — clickable, sourced, deletable, and never re-proposed once dismissed.

This is the provenance-graph spec's own designed extension (`N9: a future
typed relationship arrives as a new origin with a sole writer`) and the first
real writer of the stance vocabulary (`supports` / `contradicts`).

## 1. SME Thesis

- **An agent is an origin, not a schema.** No new link table, no verb column,
  no "suggestions" parallel store. `origin='synapse'` with one sole writer
  (`services/synapse.py`), stance carried by the existing `kind`.
- **A rationale is the edge's display payload, not domain content.** The Rev 3
  eviction (Oracle folios) applies to generated content with *independent
  identity* (phase, attribution, marginalia). A resonance rationale has no
  identity apart from its edge: it is born with it, replaced with it, dies
  with it. It therefore rides in the edge's existing `snapshot`
  (`excerpt` = rationale, `title` = target label at scan time) — legal today
  (`ck_resource_edges_citation_has_snapshot` is `ordinal IS NULL OR snapshot
  IS NOT NULL`; bare edges may carry snapshots) and zero new tables.
- **Scan state is the job row.** No head table. `background_jobs` already owns
  status/attempts/error (`dedupe_key` = `synapse_scan:<user_id>:<ref uri>` —
  user-scoped so shared-visibility objects cannot starve a second viewer's
  scan or contradict their status read); `llm_calls` attribution gets a new
  `owner_kind='synapse_scan'` with `owner_id` = the source object id.
- **Dossiers come from projections, not structure.** Source text is gathered
  from layers that are stable across the in-flight notes containment cutover:
  media → intelligence unit (`media_summaries` + `media_claims`), page → its
  own `content_chunks` (`owner_kind='page'`), note_block → `body_text`,
  highlight → `exact` + `prefix`/`suffix` + attached note bodies. Synapse
  never traverses `page_id`/`parent_block_id`.
- **Current-only doctrine for agent assertions.** Every successful scan
  replace-sets the source's `(source, origin='synapse')` edge set
  (`replace_edges_for_origin`, resource_graph/edges.py:106). A failed scan
  leaves prior edges. Dismissal is the one memory the engine keeps.

## 2. Goals

G1. Ambient: highlight create, page reindex completion, and media-unit
readiness each soft-enqueue a scan with no user action.
G2. Explicit: a scan button on the Connections section; machine rows are
visibly machine; one-tap dismiss with permanent suppression.
G3. Grounded: every proposed edge points at a real object the retriever
actually returned (index-grounded, `ground_indices` policy `drop`).
G4. Cheap: light-tier pinned model, ≤12 candidates, ≤4 connections, ≤1000
output tokens, 45s timeout, BYOK-or-platform via `resolve_api_key("auto")`,
full rate-limit envelope.
G5. Honest flatness: zero new connection stores; one new domain table
(`synapse_suppressions`) holding the only thing edges cannot: a negative
assertion.
G6. Disable-able: `SYNAPSE_ENABLED=false` turns every trigger into a no-op.

## 3. Non-goals

N1. No graph traversal/visualization product; the read surface stays the
existing Connections section + media pane mount.
N2. No per-span resonance targets — connections are object-grain (`media`,
`page`, `note_block`); span/chunk precision remains the citation system's job.
N3. No confidence scores, no ranking column, no auto-decay. The model's
include/exclude judgment is the filter (AI-first: trust the model).
N4. No scheduled full-corpus sweeps in this slice (the daily-pulse cutover
will compose them later); scans are event-driven + manual only.
N5. No SSE stream for scans; the section polls job status briefly after a
manual scan (bounded; `useIntervalPoll`).
N6. No backfill — existing objects gain connections lazily as they are next
touched or manually scanned.

## 4. Data model — migration `0149_synapse_resonance.py`

`down_revision="0147"` in this worktree (see §13 for the 0148 merge note).
Style: copy `0144`'s structure; raw `op.execute` DDL with named constraints
like `0147`.

1. Widen `ck_resource_edges_origin` (drop + re-add) to
   `('user','citation','system','note_body','highlight_note','synapse')`.
2. Widen the `llm_calls` owner-kind CHECK (read `0145` for its exact name and
   current values; add `'synapse_scan'`).
3. Create `synapse_suppressions` — the dismissal memory:

```text
synapse_suppressions(
  user_id        uuid NOT NULL REFERENCES users(id),
  source_scheme  text NOT NULL,   -- same 16-value scheme CHECKs as resource_edges
  source_id      uuid NOT NULL,
  target_scheme  text NOT NULL,
  target_id      uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_scheme, source_id, target_scheme, target_id)
)
```

plus index `(user_id, target_scheme, target_id)` for reverse filtering.
Stored as-dismissed; the miner checks both directions (house precedent:
service-level undirectedness, edges.py:43-47). `downgrade()`: drop table,
restore narrowed CHECKs (additive migration; keep it reversible like 0144).

Model changes (`db/models.py`): `ResourceEdge` origin CheckConstraint string
(models.py:409-412) += `'synapse'`; `LLMCall` owner-kind CheckConstraint +=
`'synapse_scan'`; new `SynapseSuppression` model mirroring the table.

Vocabulary changes:
- `services/resource_graph/schemas.py:23` `EdgeOrigin` += `"synapse"`
  (EDGE_ORIGINS derives; wire schema aliases — pinned by
  tests/test_resource_graph_refs.py:35-50, no further edit).
- `services/llm_ledger.py:47` `LlmCallOwner.kind` Literal += `"synapse_scan"`.
- FE `apps/web/src/lib/resourceGraph/edges.ts` `EdgeOrigin` += `"synapse"`.

## 5. The sole writer — `python/nexus/services/synapse.py`

Constants (validated at import): `SYNAPSE_PROVIDER = "anthropic"`,
`SYNAPSE_MODEL = require_catalog_model("anthropic", "claude-haiku-4-5-20251001")`
(light tier), `SYNAPSE_CANDIDATE_LIMIT = 12`, `SYNAPSE_MAX_CONNECTIONS = 4`,
`SYNAPSE_MAX_OUTPUT_TOKENS = 1000`, `SYNAPSE_LLM_TIMEOUT_SECONDS = 45`,
`SYNAPSE_QUERY_CHAR_BUDGET = 800`, `SYNAPSE_DOSSIER_CHAR_BUDGET = 12_000`,
`SYNAPSE_SOURCE_SCHEMES = ("media", "page", "note_block", "highlight")`.

```python
def queue_synapse_scan(db: Session, *, user_id: UUID, ref: ResourceRef, reason: str) -> bool
```
Soft enqueue, never breaks its host write (copy the SAVEPOINT-swallow shape of
`try_enqueue_metadata_enrichment`, services/metadata_dispatch.py:17-45):
no-op `False` when `settings.synapse_enabled` is off or `ref.scheme` not in
`SYNAPSE_SOURCE_SCHEMES`. Dedupe via the media-unit pattern
(media_intelligence.py:265-282): `DELETE FROM background_jobs WHERE dedupe_key
= :k AND status IN ('succeeded','dead')` then
`enqueue_unique_job(db, kind="synapse_scan", payload={"user_id", "ref",
"reason"}, dedupe_key=f"synapse_scan:{user_id}:{ref.uri}")`. Flush-only;
rides the caller's transaction.

```python
def scan_status(db: Session, *, user_id: UUID, ref: ResourceRef) -> Literal["idle", "pending", "running"]
```
One SELECT on `background_jobs` by `dedupe_key` + non-terminal status.

```python
async def run_synapse_scan(db: Session, *, user_id: UUID, ref: ResourceRef, llm: LLMRouter) -> Literal["ok", "skipped", "failed"]
```
1. **Dossier.** Per scheme (all permission-checked through existing loaders):
   - `media`: `get_media_unit` (media_intelligence.py:293) — `summary_md` +
     claim texts + title. `NotReady` → `"skipped"`.
   - `page`: page title + concatenated `chunk_text` of its
     `content_chunks (owner_kind='page')` in `chunk_idx` order (the index
     projection, NOT the block tree). No ready index → `"skipped"`.
   - `note_block`: `body_text` + its page title (one column read).
   - `highlight`: `exact` + `prefix`/`suffix` + anchor media title +
     attached note bodies via `linked_note_blocks_for_highlights`
     (notes.py:840). Missing object anywhere → `"skipped"`.
   Truncate to `SYNAPSE_DOSSIER_CHAR_BUDGET`.
2. **Retrieve.** `search(db, user_id, SearchQuery(text=query,
   result_types=("content_chunk", "note_block"),
   limit=SYNAPSE_CANDIDATE_LIMIT))` — the chat-tool idiom
   (services/search/__init__.py:11; query = first
   `SYNAPSE_QUERY_CHAR_BUDGET` chars of title+dossier). Retrieval runs
   BEFORE any uncommitted writes in this session
   (`build_query_embedding` rolls back non-entry transactions,
   search/embedding.py:30). No OpenAI key degrades to lexical-only — fine.
3. **Map to candidate objects.** `content_chunk` result → target
   `media:<r.source.media_id>` (label = title, snippet = chunk snippet);
   `note_block` result → target `note_block:<id>` (label = page title,
   snippet = body_text). Dedupe by target ref keeping the best-scored
   snippet; cap at `SYNAPSE_CANDIDATE_LIMIT`.
4. **Exclude.** (a) the source itself; (b) its container/contained kin:
   highlight → its `anchor_media_id` media; note_block → its own page's
   blocks and `page:<page_id>`; page → its own blocks; media → its own
   chunks' media. (c) pairs already edge-connected to the source in either
   direction, any kind/origin (`resource_graph.connections.query_connections`);
   (d) suppressed pairs, both directions (`synapse_suppressions`).
5. **Judge.** Zero candidates → replace-set to `[]`, `"ok"` (current-only:
   the engine currently sees nothing). Else one structured synthesis:
   `run_structured_synthesis(llm=LedgeredLLM(db=db,
   owner=LlmCallOwner(kind="synapse_scan", id=<source object id>),
   router=llm, llm_operation="synapse_scan", key_mode_requested="auto",
   key_mode_used=resolved.mode), request=SynthesisRequest(provider=...,
   llm_request=build_synthesis_request(...), api_key=..., timeout_s=45),
   schema=SynapseSynthesis)` with
   `SynapseSynthesis{connections: list[{candidate_index: int,
   kind: Literal["context","supports","contradicts"],
   rationale: str (1..240)}]}` (`extra="forbid"`), grounded via
   `ground_indices(policy="drop")`, capped at `SYNAPSE_MAX_CONNECTIONS`.
   Prompt via `build_synthesis_prompt`: persona = the resonance engine of a
   personal knowledge system; rules = INDEX_GROUNDING_RULE; "propose only
   connections where remembering the candidate genuinely illuminates the
   source — shared argument, direct contradiction, same idea in different
   words, concrete example; reject mere topical overlap"; "supports /
   contradicts only when genuinely argued, else context"; "rationale: one
   sentence to the user naming the specific resonance"; "an empty list is a
   good answer".
6. **Write.** Build `EdgeCreate(source=ref, target=<candidate>, kind=<kind>,
   origin="synapse", snapshot=CitationSnapshot(title=<target label>,
   excerpt=<rationale>))` per survivor;
   `replace_edges_for_origin(db, viewer_id=user_id, source=ref,
   origin="synapse", edges=[...])` (skips pairs owned by other origins,
   edges.py:151 — DB backstop for step 4c races); commit.
7. **Envelope.** Key resolve (`resolve_api_key(db, user_id, provider,
   "auto")`; no key → `"skipped"` + log), rate-limit slots/rpm/token-budget
   identical to media units (media_intelligence.py:466-568 incl.
   release-on-failure finally; BYOK skips token budget).
   `LLMError`/`StructuredSynthesisError` → log + `"failed"` (prior edges
   intact; queue retry ladder applies).

```python
def dismiss_synapse_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None
```
Load via `get_owned_edge` (edges.py:59); absent → NotFoundError; origin ≠
`synapse` → conflict-class error. Insert `synapse_suppressions(source, target)`
(idempotent: skip if present), then `delete_edge`. Flush-only; route commits.

## 6. Job plumbing

- `python/nexus/tasks/synapse_scan.py` — copy `tasks/media_unit_build.py`:
  `run_llm_task(LlmTaskSpec(label="synapse_scan"), handler)`; handler parses
  `{user_id, ref}`, awaits `run_synapse_scan`, returns `{"status": result}`;
  `on_worker_exception=None` (queue ladder owns retries; no head row to fail).
- `jobs/registry.py`: `JobDefinition(kind="synapse_scan", handler=<lazy shim>,
  max_attempts=3, lease_seconds=300, failed_result_statuses=("failed",))`;
  `USER_FACING_JOB_KINDS` += `"synapse_scan"`.
- Allowlist propagation (ALL of, else drift guards fail):
  `config.py:29` `DEFAULT_WORKER_ALLOWED_JOB_KINDS`,
  `deploy/hetzner/sync-env.sh:16` SAFE list,
  `deploy/env/env-prod-worker.example`, `.env.example`,
  `python/tests/test_hetzner_env_sync_validation.py:14` `_SAFE_...`.
- `config.py`: `synapse_enabled: bool = Field(default=True,
  alias="SYNAPSE_ENABLED")`.

## 7. Triggers (all via `queue_synapse_scan`, all soft)

| Event | Site | Scan ref |
|---|---|---|
| Highlight created | `services/highlights.py:387` `create_highlight_for_fragment`, before its commit at :458 (and the PDF-anchor twin path if it does not share this function — verify at build time) | `highlight:<id>` |
| Note content settled | `tasks/page_reindex.py:42-43`, after `rebuild_page_content_index`, before the task commit | `page:<page_id>` |
| Media unit ready | `services/media_intelligence.py` ready-promote (:699-745), inside the committing `op()` after the status flip | `media:<media_id>` |
| Manual | `POST /synapse/scans` | any scannable ref |

Quick-note attach needs no hook: the block create already reindexes the
"Notes" page (notes.py:997) → page scan covers it.

## 8. API + frontend

Routes (`api/routes/synapse.py`, schemas in `schemas/synapse.py`, register in
`api/routes/__init__.py`; transport-only per `docs/rules/layers.md`):

| Method | Route | Behavior |
|---|---|---|
| POST | `/synapse/scans` | body `{ref}`; validate scheme ∈ scannable + `assert_ref_visible`; queue; commit; 202 `{queued, status}` |
| GET | `/synapse/scans?ref=` | `{status: idle\|pending\|running}` |
| POST | `/synapse/edges/{edge_id}/dismiss` | suppress + delete; commit; 204 |

BFF proxies (thin, copy `app/api/resource-graph/edges/route.ts`):
`app/api/synapse/scans/route.ts` (GET+POST),
`app/api/synapse/edges/[edgeId]/dismiss/route.ts` (POST).
`src/app/api/proxy-routes.test.ts` `API_ROUTE_COUNT` → 135 (133 actual files
at the `6bf4a71a` base — the base commit added the edge-delete proxy without
bumping the stale 132 — plus these two; this branch absorbs that drift).

FE client `apps/web/src/lib/synapse.ts`: `requestSynapseScan(ref)`,
`fetchSynapseScanStatus(ref)`, `dismissSynapseEdge(edgeId)`.

`ConnectionsSurface.tsx`:
- Synapse rows: a small `✦` marker (Pill, `aria-label="Synapse connection"`)
  + the rationale (`edge.snapshot?.excerpt`) as a `connectionMeta` line; a
  dismiss button (X) for `origin === "synapse"` calling `dismissSynapseEdge`
  → existing `onChanged` reload. Keep the user-origin delete button as is.
- Header: a scan button (Sparkles icon, label "Find connections"), rendered
  only for scannable schemes; on click `requestSynapseScan(selfRef)` then
  poll `fetchSynapseScanStatus` via `useIntervalPoll` (2s, stop at terminal
  or 45s) and reload the list when it goes idle.

New mount — media pane secondary surface: register
`{id: "connections", groupId: "reader-tools", title: "Connections", ...}` in
`lib/panes/paneSecondaryModel.ts:29-71` and push the surface in
`MediaPaneBody.tsx` `readerSecondarySurfaces` (:4611-4665) rendering
`<ConnectionsSurface objectRef={{objectType: "media", objectId}} />`.

## 9. Key decisions

D1. Agent-as-origin; stance on `kind`; sole writer `services/synapse.py`.
D2. Rationale in `snapshot.excerpt`; no findings sidecar (lifecycle identity).
D3. Object-grain targets (`media` / `note_block`); spans stay citation-land.
D4. Projection dossiers; never traverse note containment columns.
D5. Job row is scan state; no head table; ledger owner `synapse_scan`.
D6. Replace-set per scan; failure preserves; dismissal suppresses forever.
D7. Both-direction undirected semantics at the service layer (house pattern).
D8. Bare-pair DB uniqueness (origin-blind today) is a feature: a pair already
connected by any origin is not re-proposed; the service filter makes this
explicit, the index makes it safe. Two acknowledged consequences: a pair
synapse owns 400s a manual user link for the same pair until the synapse row
is dismissed (dismiss-then-create), and a body wiki-link whose pair synapse
owns is skipped by the `note_body` replace-set until the next body edit after
dismissal. Both resolve under 0148's per-origin uniqueness (§13.12).

D9. Exclusions are re-checked at write time. The candidate exclusion set is
computed before the LLM call; suppressions and connected pairs are re-read in
the write transaction immediately before `replace_edges_for_origin`, so a
dismiss or manual link landing during the scan window wins over the scan.

## 10. Acceptance criteria

AC1. Creating a highlight (with corpus overlap available) yields, after the
worker runs, `origin='synapse'` edges from `highlight:<id>` with non-empty
`snapshot.excerpt`, visible in the Connections section with marker + dismiss.
AC2. A successful re-scan replace-sets: stale targets vanish, kept targets
persist, other origins untouched (`note_body`/`user`/`highlight_note` edges
on the same source survive byte-identical).
AC3. Dismissing a synapse edge deletes it, writes a suppression, and the next
scan does not re-propose the pair in either direction.
AC4. A pair already connected by a `user` edge is never proposed.
AC5. Scan failure (LLM error) leaves the previous synapse edge set intact and
the job retries per ladder; scan skip (no key / disabled / unit-not-ready)
succeeds quietly with no edge changes.
AC6. `POST /synapse/scans` is idempotent while a scan is in flight (one
non-terminal job per ref); status endpoint reflects pending/running/idle.
AC7. Self/kin exclusion: a highlight never resonates with its own media; a
note block never with its own page or page-siblings.
AC8. `llm_calls` rows exist with `owner_kind='synapse_scan'`,
`owner_id=<source id>`, `llm_operation='synapse_scan'`.
AC9. Gates: `origin="synapse"` edge construction appears only in
`services/synapse.py` (+ tests); allowlist drift guards pass; FE lint/css
gates pass; `proxy-routes` count updated.
AC10. `SYNAPSE_ENABLED=false` → every trigger no-ops (no job rows).

## 11. Test plan

Backend (new `python/tests/test_synapse.py`, integration; fake-router pattern
from `test_media_intelligence.py:179-199`; platform-key env fixture +
entitlement grant + `_RecordingRateLimiter`):
- scan over seeded corpus (`create_searchable_media` ×2 with lexical overlap
  + a note page indexed synchronously via `rebuild_page_content_index`)
  writes expected edges (AC1, AC8); empty-pick → empty set; zero-candidate →
  clears; replace-set (AC2); suppression round-trip (AC3); connected-pair
  skip (AC4); failure preserves via `_RawTextRouter`-style bad output →
  repair → `StructuredSynthesisError` (AC5); kin exclusion (AC7).
- `queue_synapse_scan`: dedupe (one non-terminal row), disabled no-op (AC10),
  SAVEPOINT-soft (host write survives forced enqueue failure).
- Trigger tests: highlight create / page reindex task / media-unit promote
  each leave exactly one `synapse_scan` job row (extend existing suites or
  fold into test_synapse.py with direct service/task calls).
- Route tests: scan 202 + status + dismiss 204 + dismiss-of-user-origin
  rejected + invisible ref 404.
- `test_migrations.py`: head assertions — origin CHECK includes `synapse`,
  llm owner CHECK includes `synapse_scan`, `synapse_suppressions` shape.
- Gate in `test_cutover_negative_gates.py`: `origin="synapse"` outside
  `services/synapse.py` (excluding tests) is forbidden.

Frontend (`ConnectionsSurface.test.tsx` additions — fetch-boundary mock only):
synapse row renders rationale + marker; dismiss POSTs + reloads; scan button
POSTs, polls, reloads on idle; user-origin rows keep delete (no dismiss).
Unit: `lib/synapse.ts` paths. Pane registration: `paneSecondaryModel` id
present (typecheck covers); MediaPaneBody surface smoke if an existing
harness covers secondary surfaces cheaply.

Verification ladder: `make check-back type-back check-front test-back-unit`;
focused `test_synapse.py` + touched suites; full `make test-back-integration`
+ `make test-migrations`; `cd apps/web && bun run test:unit && bun run
test:browser`; `make check-bundle`. e2e/csp: deferred (house pattern; noted).

## 12. Files

Add: `migrations/alembic/versions/0149_synapse_resonance.py`,
`python/nexus/services/synapse.py`, `python/nexus/tasks/synapse_scan.py`,
`python/nexus/api/routes/synapse.py`, `python/nexus/schemas/synapse.py`,
`python/tests/test_synapse.py`, `apps/web/src/lib/synapse.ts`,
`apps/web/src/app/api/synapse/scans/route.ts`,
`apps/web/src/app/api/synapse/edges/[edgeId]/dismiss/route.ts`,
`docs/horizons.md`, this spec.

Modify: `db/models.py`, `services/resource_graph/schemas.py`,
`services/llm_ledger.py`, `services/highlights.py`,
`services/media_intelligence.py`, `tasks/page_reindex.py`,
`jobs/registry.py`, `config.py`, `api/routes/__init__.py`,
`deploy/hetzner/sync-env.sh`, `deploy/env/env-prod-worker.example`,
`.env.example`, `python/tests/test_hetzner_env_sync_validation.py`,
`python/tests/test_migrations.py`, `python/tests/test_cutover_negative_gates.py`,
`apps/web/src/lib/resourceGraph/edges.ts`,
`apps/web/src/components/connections/ConnectionsSurface.tsx` (+ `.module.css`,
`.test.tsx`), `apps/web/src/lib/panes/paneSecondaryModel.ts`,
`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`,
`apps/web/src/app/api/proxy-routes.test.ts`.

## 13. Merge checklist (notes-pages object-graph cutover in flight)

Audited 2026-06-10 against the in-flight tree (both branches fork from
`6bf4a71a`). Ordered procedure — do after `git merge`, before running
anything:

1. **Alembic chain.** `0149_synapse_resonance.py` `down_revision="0147"` →
   `"0148"`. Until this lands the chain has two heads and every
   `upgrade head` aborts.
2. **Origin CHECK union.** 0149's recreated `ck_resource_edges_origin` (and
   the `models.py` twin) must list all SEVEN origins —
   `('user','citation','system','note_body','highlight_note',
   'note_containment','synapse')` — else the widening recreate silently
   drops 0148's vocabulary.
3. **CRITICAL — 0148's snapshot CHECKs forbid every synapse edge.** 0148
   adds `ck_resource_edges_snapshot_has_ordinal`
   (`snapshot IS NULL OR ordinal IS NOT NULL`) and
   `ck_resource_edges_snapshot_origin`
   (`snapshot IS NULL OR origin = 'citation'`) — both reject D2's
   bare-edge-with-rationale. Rebased 0149 must drop + recreate them with the
   synapse carve-outs (`… OR origin = 'synapse'` /
   `… origin IN ('citation','synapse')`), restore 0148's strict forms in
   `downgrade()`, and mirror both in `models.py`. Red tests that prove the
   miss: the rewritten bare-snapshot test in `test_resource_graph_edges.py`,
   the 0149 migration class, `test_synapse.py`'s raw edge seeds.
4. **0149 `downgrade()`.** Target becomes 0148's six-origin CHECK (with
   `note_containment`); the migration test's `downgrade 0147` becomes
   `downgrade 0148` (0148 itself is irreversible). Also delete
   `origin='synapse'` edges and `owner_kind='synapse_scan'` ledger rows
   before narrowing CHECKs, or document the downgrade as data-dependent.
5. **`resource_graph/edges.py` `_validate_edge_input`** conflicts in the
   ordinal/snapshot region: keep synapse's relaxed pairing check
   (`ordinal is not None and snapshot is None` → reject) PLUS all of 0148's
   added checks (ordinal-origin, order-key, shape) — they compose.
6. **`EdgeOrigin` unions** (BE `resource_graph/schemas.py`, FE `edges.ts`):
   seven members; order free (`EDGE_ORIGINS` derives).
7. **`test_migrations.py`** tail conflict: keep 0148's classes first, then
   the 0149 class; apply item 4's downgrade-target edit; decide whether
   `synapse_suppressions`' scheme CHECKs adopt 0148's 17th scheme `'tag'`
   (functionally optional — suppressions only ever hold scannable schemes —
   but the "verbatim mirror" comments must then say "as of 0147").
8. **`test_synapse.py::_add_note_page`** constructs `NoteBlock(page_id=…,
   order_key=…, collapsed=…)` — columns 0148 deletes. Rewrite to bare
   `NoteBlock` + `origin='note_containment'` edges (copy the merged
   `factories.create_test_highlight_note` pattern).
9. **`apps/web/src/app/api/proxy-routes.test.ts`**: both branches edited the
   count from a base that was already stale (base committed 132 with 133
   files). Merged value = real file count = **136** (133 base + 2 synapse +
   1 resolve), not either branch's number and not delta arithmetic.
10. **`ConnectionsSurface.tsx/.test.tsx`, `models.py`** remaining hunks: additive
    textual merges (verified disjoint regions).
11. **Search retriever contract.** Synapse consumes
    `SearchResultNoteBlockOut.page_id`/`page_title` (kin exclusion, labels)
    and `content_chunks.summary_locator->>'note_block_id'`; main's
    note_block retriever still selects `nb.page_id` — a column 0148 drops —
    so when that retriever is re-pointed at containment edges, confirm the
    output shape keeps `page_id`+`page_title` semantics
    (`test_note_block_scan_excludes_self_and_page_siblings` is the canary).
12. **Behavior note, no action:** 0148 removes `replace_edges_for_origin`'s
    other-origin pair skip and makes bare-pair uniqueness per-origin — a
    user link created mid-scan can briefly render beside a synapse row for
    the same pair (the engine's write-time re-check minimizes the window;
    next scan heals it).
13. **Suppression strands:** note-block merge repoints edges but not
    `synapse_suppressions` endpoints; after the notes cutover lands its
    block-merge verb, re-key suppressions in the same transfer (deliberately
    deferred here — that function is mid-rewrite on the other branch).

Re-verify after merge: `test_migrations.py -k "0148 or 0149"`,
`test_resource_graph_edges.py`, `test_synapse.py`, FE `ConnectionsSurface.test.tsx`
+ `proxy-routes.test.ts` + typecheck.

## 14. Done means

You highlight, read, and write; the graph quietly grows around you. Machine
rows are marked, explained, clickable, dismissible — and dismissal sticks.
One origin, one writer, one prompt, no new connection stores, every doctrine
intact, full suites green.

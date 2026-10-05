# synapse, connections and the reading slate

two features that share a word and meet only in `resource_edges`. synapse is a
write path: a background model call proposes edges. resonance is a read path:
deterministic sql ranks next reads. connections is the generic read of the
graph that the synapse ui and the reader both consume.

| owner | role |
|---|---|
| `python/nexus/services/synapse.py` | queue, status, dismiss, the `synapse_scan` job (dossier, retrieval, exclusion, judgement, publish) |
| `python/nexus/services/resonance.py` | at hand, quick reads and library suggestions over one snapshot |
| `python/nexus/services/resource_graph/owners.py` | `owner_rows_sql`: one hop from a graph endpoint to the object that owns it |
| `apps/web/src/components/connections/ConnectionsSurface.tsx` | the Connections list, ＋ Link, ✦ scan and its wait |
| `apps/web/src/components/collections/ReadingSlateSection.tsx` | At hand and library suggestions: read, Add, refill, focus |
| `apps/web/src/lib/{synapse,resonance}.ts` | the generated-wire clients and the slate row presenter |

## journeys

- scan (J1, J2). a note block or page offers ✦ on its Connections; highlight
  create, pdf highlight create, a media unit becoming ready and every note
  reindex queue one automatically. the ui polls every 2 s for 45 s and then
  says "N proposed connections" (the source's current outgoing proposals),
  "The scan failed" or "Still scanning". mounting over a live scan resumes the
  wait.
- dismiss (J3). a proposal's edge menu, on Connections or in reader Evidence,
  deletes it and remembers the pair.
- browse and author (J4). every page of connections, human edges first, then
  proposals, newest first in each; rows open the far object as links. ＋ Link
  offers Link, Record "supports" and Record "contradicts"; the choice opens the
  shared Link dialog and a pick commits at once. a stance on a passage is
  refused in the dialog; a failure stays there with an exact Retry. there is no
  attach: upload through Add content, then link.
- slates (J6–J8). At hand (≤10, hidden at Lectern capacity), library
  suggestions (≤10, admin of a non-system library; the default library takes
  media only) and quick reads (≤5 unfinished documents with under ten minutes
  left). Add files through the destination's own command, removes the row,
  appends at most one fresh replacement and moves focus to the survivor in the
  same position, or to pane chrome when the list empties.

## invariants

- S1. synapse alone writes `origin='synapse'`: source ∈ {media, page,
  note_block, highlight (the viewer's own)}, target ∈ {media, note_block,
  evidence_span}, snapshot `{excerpt: rationale}`.
- S2. an `ok` scan replace-sets exactly the source's synapse edges, possibly to
  empty. `skipped` and `terminal_failed` leave them untouched.
- S3. ≤4 edges, ≤2 per work. never self, kin (a page's own blocks), a work
  already related to the source, or a dismissed pair.
- S4. one job row per (user, ref), keyed `synapse_scan:<user>:<ref>`; queueing
  deletes only a `succeeded` or `dead` row on the key.
- S5. queueing is flush-only in a savepoint and never breaks the host write.
  `SYNAPSE_ENABLED=false` makes it a no-op.
- S6. only owned synapse edges dismiss; the suppression is idempotent.
- R1. slates are read-only at REPEATABLE READ with one `now()`; no model, job
  or stored recommendation.
- R2. eligibility: At hand excludes Finished media and Lectern members; library
  slates exclude members and need relational evidence; quick reads have neither
  gate.
- R3. sql gives each target one family (Continuity, Arrival, then Rediscovery
  or GraphThread) and one order inside it, capped at 20 per family. python only
  composes: Lectern rotates C, G, A, R then backfills G, C, R, A; library takes
  flat strength order. each pick keeps reason, media kind, anchor and author
  under two while an alternative exists. Continuity and Arrival carry their own
  reason and borrow no evidence, so they have no anchor or author.
- R4. Similar counts only rows under the calibrated embedding identity
  (`openai/openai_text_embedding_3_small_256_v1/256`, similarity ≥0.80), bound
  in sql before the neighbour limit.

## the grain rule

"already related" is decided at work grain on the far end: a passage,
highlight, fragment, apparatus item, chunk or passage anchor counts as the work
that owns it (`owner_rows_sql`). relations are read from the source itself, so
a highlight's scan is not blocked by its media's links or proposals (that
would leave passage-level scans nothing to propose in a well-connected work;
owner question 5). a dismissal is read at work grain on both sides: the scan's
exclusion, its publish-time recheck and the dismissal all compare works, so
dismissing one passage silences the pair of works from either end, the
works' highlights included, even when the dismissal lands while the model runs.

## contracts

- `POST /synapse/scans {ref}` → 202 `{data: {status}}`; `GET /synapse/scans?ref=`
  → `{data: {status}}`. status is `idle | pending | running | failed`: a dead
  row or a `terminal_failed` result reads `failed`; a `failed` row awaiting its
  retry reads `pending`. 400 for a bad ref or scheme, 404 when not visible.
- `POST /synapse/edges/{id}/dismiss` → 204; 404 unknown or foreign, 409
  `E_RETRY_INVALID_STATE` for a non-synapse edge.
- job `synapse_scan`: payload `{user_id, ref, reason}`; result `{status: ok |
  skipped | terminal_failed, error_code, ref}`; Light, Llm child runtime, 3
  attempts at 60/300/900 s, 300 s lease.
- the generation journal owns replay. a scan with an admission replays its
  frozen `synapse-input.v2` intent; a Completed generation replays its memo
  `{connections, error_code}`. publish runs under the job's lease fence in a
  fresh SERIALIZABLE transaction and drops picks whose target is gone or whose
  work became excluded.
- retrieval leaves `search()`'s read-only snapshot open; the scan rolls it back
  before any write.
- slate routes: `GET /lectern/slate`, `GET /lectern/quick-reads`,
  `GET /libraries/{id}/slate`, no query parameters, generated `SlateOut` /
  `QuickReadsOut`.

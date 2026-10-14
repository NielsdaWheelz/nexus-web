# release: media (A metadata + intelligence; B media core)

The media slice changes these contracts at once; the api refuses the old forms and
there is no compatibility arm. `X-Nexus-Wire` stays 1 (conventions): web and api deploy
together from the release sha; a tab open across the deploy sends no wire header and is
refused (426 `E_WIRE_MISMATCH`, [release-edge](release-edge.md)) until reloaded. The apk reads
none of these keys natively (`NexusOriginClient.kt` calls `me`, reading-copy,
reader-state, player, listening-state and the consumption routes); its webview runs the
new web. The extension is untouched.

## A: metadata + intelligence (migration 0284)

| before | after |
|---|---|
| `POST /media/{id}/metadata-enrichment {client_mutation_id, expected_job_id}` → 202 `{media_id, job_id}`; 409 `E_RESOURCE_CONFLICT` when expected ≠ latest | `{expected_job_id}` → 202 `{media_id, job_id, last_enriched_at}`; an expected job older than the latest (or null while one exists) → 202 the latest; an expected job that is not this media's, or a latest job of another purpose than the media's (a bibliography run from before x articles took titles), → 409 `E_RESOURCE_CONFLICT`; a `client_mutation_id` → 400; title jobs (x articles) and their `source_context_missing` refusal unchanged |
| `POST /media/{id}/metadata-enrichment/{job_id}/review {client_mutation_id}` → 200 `{job_id, reviewed_at}`; unknown job 404 `E_MEDIA_NOT_FOUND` | no body → 204 (an existing review stands); unknown job 404 `E_NOT_FOUND` |
| `/stream/media/{id}/metadata/events` never ends | ends (`done`) once nothing is unfinished: an idle media answers one frame |
| `MetadataEnrichmentView.operation.selection {provider: "codex", model, reasoning}` | `{route, model, reasoning}` (a provider route's `model_ref` as `model`) |
| a dead `media_unit_build` leaves its unit `building` ("suspended" in dossier abstracts and omissions) | the job's `on_dead` fails the unit with the job's code; "suspended" is gone |
| a unit build whose index moved on before it ran leaves its unit `building` (read "suspended": Failed) | the build fails its unit (`superseded`); a publish with text builds it anew |

`resource_mutations` rows in the scopes `media_metadata_enrichment:*` and
`media_metadata_result_review:*` go inert (nothing reads them); the platform slice drops
the table.

### order

- `0284_media_units_by_generation` runs after `0283` with writers stopped, in the one end
  release; api, workers and web deploy together.
- the unit census below is the gate, on the rehearsal and again in production right
  before and right after the real 0284 (writers still stopped): after 0284 every ready
  unit on a ready index must read current. a shortfall means the retired rule was not
  recognised: list the stale ones (the query's `FILTER` negated), and in production
  restore the backup (every such unit would read stale: abstracts hide from citations and
  dossiers rebuild units on demand).

### unit census (rehearsal on a restored backup, mac only; then production)

```sql
-- ready units on ready indexes, and those current under the NEW rule. a ready unit on a
-- ready index is current (a publish re-ensures its unit, a build publishes only at its
-- own fingerprint), so after 0284 current_units = ready_units, the same count as before.
-- before 0284 current_units is 0 (old fingerprints).
SELECT count(*) AS ready_units, count(*) FILTER (WHERE h.content_fingerprint =
  encode(sha256(convert_to(concat_ws('|',
    coalesce(s.active_embedding_provider, ''), coalesce(s.active_embedding_model, ''),
    to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex'))
  AS current_units
FROM media_summaries h
JOIN content_index_states s ON s.owner_kind = 'media' AND s.owner_id = h.media_id
WHERE h.status = 'ready' AND s.status = 'ready';
-- heads by status (informational)
SELECT status, coalesce(error_code, '-'), count(*) FROM media_summaries GROUP BY 1, 2;
-- before 0284: building units with no runnable build job (= 0284 step 2's count; after
-- 0284 the `job_dead` heads above number the same)
SELECT count(*) FROM media_summaries h WHERE h.status = 'building' AND NOT EXISTS (
  SELECT 1 FROM background_jobs j WHERE j.kind = 'media_unit_build'
    AND j.status IN ('pending', 'failed', 'running')
    AND j.dedupe_key = 'media_unit_build:' || h.media_id || ':' || h.content_fingerprint);
-- inert ledger rows (informational)
SELECT split_part(mutation_scope, ':', 1), count(*) FROM resource_mutations
WHERE mutation_scope LIKE 'media_metadata_enrichment:%'
   OR mutation_scope LIKE 'media_metadata_result_review:%'
GROUP BY 1;
```

0284 does not depend on any session's time zone: the retired rule rendered the index
generation with `isoformat()` in the application session's zone, so the migration accepts
a unit whose fingerprint matches the same instant at any quarter-hour UTC offset (a
rendering names its instant: a stale unit matches none). the dry run
(`campaign-artifacts/2026-10-15/restack/mig-0284/`, first run as 0283 in
`2026-10-13/media/mig-0283/`) seeds units with the base code under UTC, America/New_York
and Asia/Kathmandu application sessions, migrates from a session in another zone, and
shows every current unit rewritten and the census above whole.

### owner smoke

- research metadata from a row menu: HUD "metadata request confirmed", the
  title changes in the open list; press it again from a stale menu: the same run.
- a no-findings result: mark reviewed (overlay and imports inspector).
- leave a settled media pane open for five minutes: the vercel function log shows no
  metadata stream for it.
- a chat citation of a document shows its abstract; a media dossier asked right after a
  capture turns readable waits and completes.

## B: media core (migration 0285)

| before | after |
|---|---|
| `GET /media?kind&search&cursor&limit` | gone (no caller) |
| `GET /media/{id}` → `MediaOut` with `source_progress`, `failure_stage`, `document_embed_summary`, `read_state`, `progress_fraction`, `progress_resettable` and 14 capabilities | those keys gone; `consumption {state, progress}`; `capabilities {can_read, can_highlight, can_quote, can_retry}` (a document's read, highlight and quote from its ready reader publication, as before); `author_mode` required; `x_source_context` unchanged |
| `DELETE /media/{id}` → 200 `Removed \| Hidden \| Deleting`; a resend after it landed 404; any query string 400 | 204; a media the viewer cannot read (removed, or never theirs) 204; system-only 403 |
| `/stream/media/{id}/events` frames carry `source_progress`, `failure_stage`, `updated_at`; `done` at ready, failed or suspended | those keys gone; `done` once no source work, requested transcript or readable media's index is in flight: an episode or video waiting on a transcript nobody requested holds no stream |
| `media_teardown` job: checkpoints (`Unprepared` → `PathsPrepared` → `DeletionCommitted`), 60 s grace before objects go, payload `{mediaId, intentId, checkpoint}`, result `{disposition: Deleted\|Voided\|NoOp\|Stale, deletedPaths}` | one step: every row in one transaction, then objects (an object a failed delete leaves goes to the orphan sweep); payload `{media_id, intent_id}`; result `{disposition: Deleted\|Voided\|Stale, deleted_paths}` |

### order and env

- `0285_media_core_one_step_teardown` runs right after `0284`, with writers stopped, in
  the same end release; api, workers and web deploy together.
- delete `MEDIA_TEARDOWN_CLEANUP_GRACE_SECONDS` wherever production sets it (no repo env
  file does); the setting is gone and the api ignores an unknown variable.

### media census (rehearsal on a restored backup, mac only; informational)

```sql
-- teardown jobs by status and checkpoint: 0285 rewrites every payload. a DeletionCommitted
-- job whose objects were not yet deleted finds no intent after 0285 (Stale); its objects
-- go to the orphan sweep (24 h or more later).
SELECT status, coalesce(payload->'checkpoint'->>'kind', '-'), count(*) FROM background_jobs
WHERE kind = 'media_teardown' GROUP BY 1, 2;
-- media with a failure stage (0285 drops the column; nothing read it)
SELECT failure_stage, count(*) FROM media WHERE failure_stage IS NOT NULL GROUP BY 1;
-- anything that depends on title_tsv (expect none: 0285 drops it)
SELECT DISTINCT v.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
JOIN pg_class v ON v.oid = r.ev_class JOIN pg_attribute a
  ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
WHERE d.refobjid = 'media'::regclass AND a.attname = 'title_tsv';
-- unsettled attempts with no job or a missing job row (expect 0: the processing stream
-- counts an unsettled latest attempt that is not repairable as source work, so such a
-- media's stream would never end). the 0bd6619236 backup holds no unsettled attempt.
SELECT a.source_type, a.status, count(*) FROM media_source_attempts a
LEFT JOIN background_jobs j ON j.id = a.job_id
WHERE a.status IN ('accepted', 'queued', 'running') AND j.id IS NULL GROUP BY 1, 2;
```

### owner smoke

- open a failed import's pane: its title, explanation and Open source.
- remove a document from a row menu: it leaves every list at once; press Remove again
  from a stale menu: no error; a minute later its row and objects are gone.
- open a pane while an import extracts: "Search and AI are still preparing" clears by
  itself once the index is ready; leave a podcast episode pane open: the vercel function
  log shows no lingering processing stream. an add, upload, Imports action or transcript
  request in the same tab briefly reopens each open media pane's processing and metadata
  streams (one short read each): expected, not lingering.
- with an episode pane open on "Transcript has not been requested yet.", Request
  transcript… from its row menu: the pane follows it (queued, then the transcript)
  without a reload.
- with a media pane open on a stopped index, Rebuild search index from Imports: the
  banner goes without a reload.
- with an x post's pane open, "refresh source" from its row menu: the post stays readable
  through the refresh, a title job follows it, and the open pane takes the new title
  without a reload; the vercel function log then shows its processing stream ended.

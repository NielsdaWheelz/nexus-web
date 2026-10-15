# release: imports (the imports pane and import history)

the slice changes the Imports wire and the stored history at once; there is no compatibility
arm: web and api deploy together from the release sha. the base already sends
`X-Nexus-Wire: 2` (the 2026-10-15 release); a tab open across the deploy would read the old
Imports wire, so the end release carries one bump past 2 (conventions: the first breaking
change merged after a release bumps once; the coordinator names the PR that carries it).
android reads no imports key natively (webview); the extension reads none (it relies on
Imports offering Remove for a capture session it could not remove, which holds). beyond that
bump (its PR owns the apk and extension rebuild), no apk, no extension build, no env change,
no job payload change.

| before | after |
|---|---|
| `ImportItem{…, media_ref, readiness{can_read, can_search, can_play}, state: Active{…} \| NeedsAttention{stage, failure_code} \| Complete, capabilities{can_remove}, obligations{source, search: {state, recovery, unavailable_reason}, metadata}}` | `{…, media_id, can_read, can_play, classification, primary: source \| search \| metadata \| null, obligations{source, search: ImportObligation, metadata}}` |
| `ImportPage{observed_at, matched_count, items, next_cursor}` | `{matched_count, items, next_cursor}` |
| `ImportDetail{item, history_coverage, source_issues: {generation, issues} \| null}` | `{item, source_issues: SourceIssue[]}` |
| `HistoryEntry.facts`: 22 variants, `kind` re-derived from `event_type` | 20 stored kinds (`kind` stored) + `MetadataOperation`; `failure_code` vocabulary −`E_UPLOAD_TRANSPORT_FAILED` −`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` +`E_EMBEDDING_PROVIDER_UNAVAILABLE` |
| list cursors bound to `imports:<view>:composed`, history to `imports:history:composed` | `imports:<view>`, `imports:history`: a cursor minted before the deploy answers 400 `E_INVALID_CURSOR` once ("More imports couldn’t be loaded · Refresh") |

## order

1. before merge (R3): restore the newest production backup (the 2026-10-15 release left
   `releases/fdd0a3ecade305082643f6231bbfbcce211b04d7/database.dump`, at 0287; mac only,
   disposable, deleted after), run the preflight below, then `alembic upgrade head` from this
   branch on it: 0288 converts or refuses, naming every reason. any refusal is the owner's
   decision before merge (keep the shape as stored vocabulary, or accept a conversion), never a
   silent rewrite. production has written neither retired code since that release (0283
   removed the transport-failure writer; the replay code was only ever a response), so the
   rows its earlier code wrote are all in that backup and their count is final.
2. at the release, writers stopped, before migrating: rerun the refusal query below against
   the database. alembic runs every pending migration in one transaction, so a refusal inside
   0288 rolls back the whole run; a row here stops the release before the run starts. the
   query covers shapes and codes; a value 0288 cannot read has no writer (every writer dumps
   typed facts), and 0288's own read check still refuses it.
3. `0288_import_history_kinds` runs after head (`0287`; renumber at merge if another migration
   lands first). irreversible: rollback restores the pre-release backup.
4. after: the after queries below.
5. api, workers and web deploy together.

data effects: every history row keeps its id, owner, time, stage and code; each payload
becomes `{kind, <the facts a reader is told>}` (execution, job, retry-time, winner and
published ids leave; a source recovery keeps its kind as text; a 0225 baseline's outcome
becomes `outcome` + `outcome_code`); both tables lose `event_type`. each source `Superseded`
row (rehomed to the winner when written) becomes one `media_source_supersessions` row and
leaves history. 0288 refuses, writing nothing, on any other shape (an `UploadExecutionStarted`
included), a code outside the catalog in history or in `media.last_error_code` (failed
media), `media_source_attempts.error_code` or `media_upload_sessions.verification_error_code`,
or one superseded attempt naming two media; then, after converting, on any row the history
reader cannot build (a stage outside the pipeline, a fact value outside its vocabulary),
rolling the conversion back.

## preflight (restored backup, mac only)

```sql
-- C1 every row by shape; kind NULL = a shape 0288 refuses
WITH stored AS (
  SELECT 'upload' AS tbl, event_type, false AS indexed,
         ARRAY(SELECT k FROM jsonb_object_keys(payload) k ORDER BY k COLLATE "C") AS keys
  FROM media_upload_events
  UNION ALL
  SELECT 'processing', event_type, payload ? 'revision',
         ARRAY(SELECT k FROM jsonb_object_keys(payload) k ORDER BY k COLLATE "C")
  FROM media_processing_events
), known(tbl, event_type, indexed, keys, kind) AS (VALUES
  ('upload', 'Accepted', false, '{generation}'::text[], 'UploadAccepted'),
  ('upload', 'RecoveryAccepted', false, '{generation}', 'UploadRecoveryAccepted'),
  ('upload', 'Failed', false, '{generation}', 'UploadFailed'),
  ('upload', 'Published', false, '{generation,media_id,source_attempt_id}', 'UploadPublished'),
  ('upload', 'HistoryBaseline', false, '{generation}', 'UploadHistoryBaseline'),
  ('processing', 'Accepted', false, '{attempt_no,source_attempt_id}', 'SourceAccepted'),
  ('processing', 'ExecutionStarted', false, '{execution_id,source_attempt_id}', 'SourceExecutionStarted'),
  ('processing', 'StageChanged', false, '{execution_id,source_attempt_id}', 'SourceStageChanged'),
  ('processing', 'RetryScheduled', false, '{execution_id,next_attempt_at,source_attempt_id}', 'SourceRetryScheduled'),
  ('processing', 'Failed', false, '{execution_id,origin,progress,source_attempt_id,terminal}', 'SourceFailed'),
  ('processing', 'RecoveryAccepted', false, '{recovery,source_attempt_id}', 'SourceRecoveryAccepted'),
  ('processing', 'Succeeded', false, '{execution_id,source_attempt_id}', 'SourceSucceeded'),
  ('processing', 'HistoryBaseline', false, '{attempt_no,outcome,source_attempt_id}', 'SourceHistoryBaseline'),
  ('processing', 'Superseded', false, '{source_attempt_id,winner_media_id}', '(media_source_supersessions)'),
  ('processing', 'Accepted', true, '{job_id,revision}', 'IndexAccepted'),
  ('processing', 'ExecutionStarted', true, '{execution_id,job_id,revision}', 'IndexExecutionStarted'),
  ('processing', 'RetryScheduled', true, '{execution_id,job_id,next_attempt_at,revision}', 'IndexRetryScheduled'),
  ('processing', 'Failed', true, '{execution_id,job_id,origin,revision,terminal}', 'IndexFailed'),
  ('processing', 'RecoveryAccepted', true, '{job_id,revision}', 'IndexRecoveryAccepted'),
  ('processing', 'Succeeded', true, '{execution_id,job_id,revision}', 'IndexSucceeded'),
  ('processing', 'Superseded', true, '{execution_id,job_id,revision}', 'IndexSuperseded')
)
SELECT s.tbl, s.event_type, s.indexed, s.keys, k.kind, count(*)
FROM stored s LEFT JOIN known k USING (tbl, event_type, indexed, keys)
GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3;

-- C2 nested shapes: recoveries by kind; baselines by outcome
SELECT payload->'recovery'->>'kind' AS recovery, count(*) FROM media_processing_events
WHERE event_type = 'RecoveryAccepted' AND NOT payload ? 'revision' GROUP BY 1;
SELECT payload->'outcome'->>'kind' AS outcome, payload->'outcome'->>'failure_code' AS code, count(*)
FROM media_processing_events WHERE event_type = 'HistoryBaseline' GROUP BY 1, 2;

-- C3 envelope codes (the two retired literals must be 0)
SELECT 'upload' AS tbl, failure_code, count(*) FROM media_upload_events
WHERE failure_code IS NOT NULL GROUP BY 2
UNION ALL
SELECT 'processing', failure_code, count(*) FROM media_processing_events
WHERE failure_code IS NOT NULL GROUP BY 2 ORDER BY 1, 2;

-- C4 source supersessions: after 0288, media_source_supersessions holds this many rows
SELECT count(DISTINCT (payload->>'source_attempt_id', media_id)) FROM media_processing_events
WHERE event_type = 'Superseded' AND NOT payload ? 'revision';
```

0288's refusal query (shapes and codes; step 1 on the restored copy, step 2 on the database
with writers stopped), the catalog bound from the release sha; any row printed is a blocker:

```sh
# TARGET_URL: a libpq url of the database checked
cd python && uv run --frozen --no-sync python - <<'EOF' | psql "$TARGET_URL"
import importlib.util
from nexus.schemas.import_history import SAFE_FAILURE_CODES
spec = importlib.util.spec_from_file_location(
    "m0288", "../migrations/alembic/versions/0288_import_history_kinds.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
codes = "ARRAY[" + ",".join(f"'{c}'" for c in sorted(SAFE_FAILURE_CODES)) + "]"
print(m._REFUSALS.replace(":codes", codes) + ";")
EOF
```

## after 0288

```sql
-- per kind: equals C1 per shape, Superseded excepted
SELECT 'upload' AS tbl, payload->>'kind' AS kind, count(*) FROM media_upload_events GROUP BY 2
UNION ALL
SELECT 'processing', payload->>'kind', count(*) FROM media_processing_events GROUP BY 2 ORDER BY 1, 2;
-- 0: every payload names its kind
SELECT count(*) FROM (SELECT payload FROM media_upload_events
                      UNION ALL SELECT payload FROM media_processing_events) p
WHERE NOT p.payload ? 'kind';
-- equals C4
SELECT count(*) FROM media_source_supersessions;
-- 0: event_type is gone
SELECT count(*) FROM information_schema.columns
WHERE table_name IN ('media_upload_events', 'media_processing_events') AND column_name = 'event_type';
```

## owner smoke (after deploy)

- open Imports: it lands on the right view; the rail badge shows the attention count.
- a failed upload: Retry upload with the original file publishes it; Remove removes another.
- a failed url import: Retry source processing.
- History with a reason filter: the matched line, and the inspector's History opens on it.
- an import from before September: its history shows the baseline lines ("Detailed
  execution history was not recorded…").
- a repaired epub's history ("Reprocessing accepted"), if one exists.
- on the phone: the details sheet opens and closes.

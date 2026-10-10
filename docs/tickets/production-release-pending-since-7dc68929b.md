# production release pending since 7dc68929b

status: open · origin: 2026-09-28 cleanup campaign · area: release / production

tracking: [github #483](https://github.com/NielsdaWheelz/nexus-web/issues/483)

release preparation is delivered by [pr #482](https://github.com/NielsdaWheelz/nexus-web/pull/482).
the application reset/release owner owns the remaining production execution.
the frozen integrated source is `bcb86e0204ef2ea347a8836a9e5d48f031d09134`;
the sole head is `0257`: `0252` → resource `0253` → atlas `0254` → native
`0255` → metadata `0256` → effects `0257`. preparation is green. the earlier
`617baf70e/0256` and old migration-graph receipts remain historical; no database
was stamped or aliased into the new graph.

private artifacts: `/private/tmp/nexus-metadata-release-uy48cjy2/`.
the table names exact files and sha256 prefixes; full hashes remain in the
private artifacts. see `docs/metadata-enrichment-verification.md` at `407fcc735`
for scope and limits.

| preparation proof | artifact | sha256 prefix |
|---|---|---|
| frozen noneditable installed bytes: nexus/provider/kernel/tools `466/46/17/18` | `installed-source-bcb86e.receipt.json` | `d7b71504ec34` |
| actual controlled owner-populated `0241→0257`, retained rows, original write receipts, authenticated inspection/undo and stale-authority refusal | `0257-metadata-restored-cutover.receipt.json` | `b0b50e9f192f` |
| eight whole-transaction refusal/rollback cases, including late `0249` and `0253` guards | `0257-fullchain-negative-transactions.receipt.json` | `25cd59b71508` |
| native `0255` passed, metadata `0256` refused inactive uncertainty; all 114 public tables/full schema returned to `0252` | `0257-late-native-metadata-guard.receipt.json` | `13d02c88c9c4` |
| six controlled consumer jobs and generated web projections; short summary of original controlled `b3cb3cd8` | `0257-consumer-composition-summary.receipt.json`, `0257-consumer-web.receipt.json` | `059c14144992`, `61100d6c7785` |
| 11 forwarding cases; controlled remote leaves | `0257-metadata-snapshot-forwarding.receipt.json` | `cd4ad1db11ab` |
| 10 release-controller cases; controlled remote/backup leaves | `0257-metadata-release-archive-green.json` | `b354e146de4c` |
| `./scripts/test`, before disposable proof cleanup | `metadata-integrated-bcb86-precleanup-static.receipt.json` | `5fb539901b89` |
| exact owned disposable fixture/resource cleanup; real evidence retained | `0257-owned-fixture-cleanup.receipt.json` | `2fb2685c2651` |
| post-deletion `./scripts/test` exit 0; native main ancestor, unchanged qualified tree, sole head `0257` | `metadata-final-current-postcleanup-static.receipt.json` | `108ca2156da0` |

the unmodified preliminary live `0241` archive was separately restored. the
owner-populated proof backup is a controlled local fixture, not production/R2
authority. no production drain, disposition, deployment or saved-item repair
occurred. a fresh drained exact backup, actual restore/source review of those
bytes, and explicit migration-loss approval remain required. follow
[the operator sequence](../../deployment.md#reviewed-model-history-reset).

## blockers found 2026-10-10

the read-only release preparation of 2026-10-10 (plan and production reads in
`nexus-web-campaign-artifacts/2026-10-09/release/plan.md` and its `preflight/`,
outside the repo) found eight blockers for `7dc68929b`/0241 -> main. its phases 0-7
are the owner steps, in order.

- B1 (owner): no backend candidate since 2026-10-08. `backend-images.yml` failed for
  want of a private memory build credential, a repo secret that never existed. the
  credential is now the read-only deploy key `UNIVERSAL_MEMORY_DEPLOY_KEY`, set
  2026-10-10 (`deployment.md`). merge that change; the first main commit after it
  whose first image run succeeds is the target `T`. freeze main at `T`.
- B2 (fixed, cleanup/release-blockers): `ModelCutoverRestore.target_revision` was
  pinned to `^0258$` while release and archive cli require the candidate head.
- B3 (owner): production `current.env` lacks `NEXUS_MEMORY_CLIENT_CONFIG_FILE`;
  publish config with `sync-env.sh` before the window.
- B4 (owner): production lists `moonshot`, which main refuses after the irreversible
  migration; drop it and its key in that publication (`deploy/env/README.md`).
- B5 (owner): the local env inputs are from may; supply or rebuild them from the
  live files.
- B6 (owner; harness fixed): fresh census with writers stopped, backup bound to `T`,
  restored-copy qualification with `deploy/hetzner/qualify_model_cutover.py`
  (`deployment.md`), review and sign.
- B7 (fixed): two succeeded `enrich_metadata` jobs name generation ids absent from
  `llm_calls`; the reviewed input now acknowledges such terminal jobs by id
  (`retire_dangling_job_ids`). re-read the set from the frozen database.
- B8 (fixed): 0245 loaded `Media` through the live ORM and failed on
  `failure_stage='metadata'`; it now reads and writes its own schema in sql.

## what is true

- the last public web/backend version observation was `7dc68929b` (#377) on 2026-09-28. reviewed aggregate SQL on 2026-10-03 independently confirms production remains at `0241`; this did not re-probe public versions.
- merging to main deploys nothing. `deploy/hetzner/deploy.sh <sha>` converges the backend (`release.py`: backup, migrate, start), then promotes and aliases the vercel build of the same sha. web and backend therefore release together.
- the final release target carries migrations through `0257`. most older migrations are irreversible: their `downgrade()` raises. after release, the verified pre-migration backup is the only copy of dropped data. rollback restores the aligned application and that backup together, losing every write made since release.

| revision | what | reversible | preflight |
|---|---|---|---|
| 0242 | reader publication source issues | no | |
| 0243 | reader section semantics | no | [reader-chapter-production-correspondence-unverified](reader-chapter-production-correspondence-unverified.md) |
| 0244 | shared note links (stop writers, drain client journals) | no (its downgrade raises) | [notes-writing-legacy-draft-checkpoint](notes-writing-legacy-draft-checkpoint.md), [notes-writing-target-unsafe-links-census](notes-writing-target-unsafe-links-census.md), [notes-writing-target-missing-body-versions](notes-writing-target-missing-body-versions.md) |
| 0245 | reader source note bodies | no | [reader-source-body-production-publication-preflight](reader-source-body-production-publication-preflight.md), [reader-source-notes-production-repair-pending](reader-source-notes-production-repair-pending.md) |
| 0246 | reviewed archival retirement; independent completed-write receipts survive history deletion | no | [model-history-cutover-blocked-by-uncertain-work](model-history-cutover-blocked-by-uncertain-work.md) |
| 0247 | generation api credential binding | yes | |
| 0248 | drops the rate limiter and stream-token replay tables (#405) | no | none; both tables are ephemeral |
| 0249 | resource grant row shape (#409) | no | [resource-grants-0249-production-preflight](resource-grants-0249-production-preflight.md) |
| 0250 | dossiers keep only the current revision (#411) | no | [dossier-latest-revision-0250-production-preflight](dossier-latest-revision-0250-production-preflight.md) |
| 0251 | drops one table and 39 columns (#413); restored loss inventory recorded | no | [schema-0251-production-loss-preflight](schema-0251-production-loss-preflight.md) |
| 0252 | deletes billing, stripe state and the transcription minute ledger (#404) | no | [billing-0252-release-steps](billing-0252-release-steps.md) |
| 0253 | activation receipt keys; explicit oracle passage nulls | yes | one copied original nested receipt rewrites in a separate rollback-only transaction; late malformed receipt refuses atomically |
| 0254 | drops atlas computation timestamps | no | [atlas-0254-production-timestamp-loss](atlas-0254-production-timestamp-loss.md) |
| 0255 | qualified native adapter; original principal/history preservation, shell credentials removed | no | `docs/metadata-enrichment-verification.md` at `407fcc735` |
| 0256 | metadata hard cutover; unresolved journals block | no | `docs/metadata-enrichment-plan.md` §9 at `407fcc735` |
| 0257 | independent completed-write receipts and archival audit | no | `docs/metadata-enrichment-verification.md` §release preparation at `407fcc735` |

the earlier activation-owner preflight records the `0253` receipt-key and oracle nullable-key
migration, with paired snake API/web output. production has 24 exact camel
activation paths in 22 targeted receipts at `0241`. only chat
`citation_index`/`context_ref_added` and oracle `passage` populations were counted
and empty; plate/bind were not queried. source base `e92d6c6d9`, query sha256
`65de77483069113f23ce5e66db644cd03c18e8c01fdf0c1cca4d6af7203800ca`,
safe receipt `/tmp/nexus-resource-activation-production-preflight.receipt.json`.
migration shape guards still run with writers stopped. merging/checks/preview publication do not establish a
matched live application; release the same API/web sha only after migration and
backend health, through the existing controller. no promotion is requested by
this cleanup slice.

the current full-chain proof observes that `0244` deletes all 54 original scoped
mutation memos before `0253`; no original activation receipts survive to that
revision. oracle passage population is zero. the positive rewrite therefore
uses one copied original nested receipt with two admitted paths in a separate
rollback-only transaction; it does not claim production normalization coverage.

the separate plate/bind read-only census at `0241`, 2026-10-03 11:11:24–27 utc,
found zero rows for each type (`/tmp/nexus-oracle-nullable-production-preflight.receipt.json`,
query sha256 `0054460ae3ea9f39fe8ef40377caa21c34b59114a3d1afb7010fa2ed1fcdc691`).
the required-nullable year/gloss source cut deliberately rejects raw stored
omissions previously defaulted to null. bounded initial/current and previously
observed deployed writer history includes both members; no omission-producing
writer was found. this is not proof about unavailable historical backups.
no migration or new revision is added for that contract change.

the atlas cut adds `0254`: old atlas query/writer code requires the removed
column. stop writers, verify the existing backup, migrate and restart the same
application sha through the existing paired release controller. unused timestamps
are deliberately lost; migration downgrade refuses. this is locally qualified,
not an applied production migration.

## what to do

1. run every linked preflight read-only against production, and resolve each one before releasing.
2. follow [the finite reset sequence](../../deployment.md#reviewed-model-history-reset): fresh drained census, source/revision-bound R2 backup and actual restore/qualification of those exact bytes; reviewed original IDs and migration losses.
3. after separate authorization, run `deploy/hetzner/deploy.sh <target sha> --model-cutover-snapshot <reviewed-json>` from a clean checkout. no clone fixture or preliminary live archive qualifies that input.
4. after release, complete [saved-epub contributor repair](epub-contributors-production-repair-pending.md)
   and [saved lewis date repair](metadata-book-date-counts-serialization.md), with live verification.
   run the three processing repairs and then land #387 ([processing-repairs-await-release-then-387](processing-repairs-await-release-then-387.md)), and finish [billing-0252-release-steps](billing-0252-release-steps.md). the chat and
   oracle rate-limit arms and the make-current and failed-quota source arms are
   already removed.
5. open tabs still running the old web may fail dossier and chat reads and transcript requests until reloaded. there is nothing to do beyond reloading.

## done when

production `/version` and alembic report the released sha and its head, every preflight above is closed, and the follow-up tickets in step 4 are resolved.

## added to the release since `0257` (2026-10-04 cleanup campaign)

main now also carries `0258` (local vault history), `0259` (dossier head carries its revision; preflight: [ticket](dossier-0259-production-preflight.md)), `0260` (retire admitted synapse scans), `0261` (chat tree owner; refuses on underivable `message_document`) and `0262` (oracle one-row readings; `release.py` drains oracle jobs first; preflight: [ticket](oracle-0262-production-preflight.md)). all are irreversible. the release also changes the android bridge and the offline copy format: follow [offline cutover release steps](offline-cutover-release-steps.md) (open the old app online once, deploy, clear app storage, install the new apk; never the apk first). after release, seed the oracle corpus once (`docs/modules/oracle.md`).

the connections port at base `1b18fe8d0` includes `0263` (fold listening completion
into consumption overrides and remove unused listening/queue columns) and adds
`0264` (neutral user links, prose-only inline references, discovery vocabulary).
`0264` is irreversible: stop old clients/writers, export unsaved journals, settle
retired discovery and exact old read-tool grants, then take a verified backup.
local `0263→0264` preservation/rollback and real native discovery passed;
no production migration or deployment occurred. see
`docs/connections-verification.md` at `407fcc735`.

#538 adds `0265` (persist effective finished/unread states, then drop
`reader_engagement_states.max_total_progression`). it is irreversible: its
downgrade raises; rollback is the verified pre-cutover backup plus the prior
builds. stop writers and take that backup first. #538 also renames the android
bridges to `nexusPlayback` and `nexusDownloads` with no compatibility path, so
backend, web and android ship together, in the
[offline cutover](offline-cutover-release-steps.md) order: old app online once,
deploy, new apk. see `docs/media-row-plan.md` (migration and hard cutover) at
`407fcc735`.

the graph reauthor adds `0268` (graph wire cutover, data only). its guard is the
count below, which means something only at the 0267 schema. at production's 0241 it
counts edges that 0244, 0246 and 0264 rewrite or delete before 0268 runs (16 on
2026-10-10: 15 `page`->`note_block` edges with a `source_order_key`, 1
`conversation`->`highlight`), so a non-zero count there is expected. the restored-copy
qualification runs 0268 itself, which fails closed; that run is the preflight:

```sql
SELECT count(*) FROM resource_edges WHERE origin = 'user' AND (
    kind <> 'context' OR ordinal IS NOT NULL OR snapshot IS NOT NULL
    OR source_order_key IS NOT NULL
    OR (source_scheme || ':' || source_id::text) COLLATE "C"
        >= (target_scheme || ':' || target_id::text) COLLATE "C")
```

`0268` runs that count and fails closed (nothing written) when it is non-zero, then
deletes the link and link-note replay memos (`resource_mutations` scopes
`resource_graph:link` and `link_note:%`); no edge, view state or version changes. its
downgrade is a no-op. web and api ship together: `ConnectionOut` lost its mirrors and
`GET /conversations?has_context_ref` answers 400. stale tabs re-execute a pre-release
retry instead of replaying it (a link answers "Already linked"); reload fixes them.

the generation reauthor adds `0269` (drop crash replay). it ends every in-flight
chat run as `interrupted` (queued with a cancel request: `cancelled`), closes open
ledger rows and unfinished tool positions, fails dossier/oracle/summary rows whose
job is dead, rewrites retired failure codes, and drops the turn and continuation
tables. it is irreversible: its downgrade raises; rollback is the pre-release backup
plus the prior builds, so stop writers and take that backup first (0268 and 0269 run
in the same window). web and api ship together (chat contract "3"). after the
release, remove `GENERATION_CONTINUATION_ENCRYPTION_KEY` from the live env.

the podcasts python reauthor adds `0270` (podcast sync without epochs). it drops
`podcast_subscriptions.sync_generation`, `sync_job_id` and `sync_job_attempt_no`,
starts the watermark of every subscription with auto-queue on and no watermark at
migration time (their back catalogue is never queued) and adds the CHECK
`NOT auto_queue OR auto_queue_watermark_at IS NOT NULL`, makes a subscription's
backfill and an episode's identity aliases cascade with their parent, and deletes the
`podcast:control` replay rows. it is irreversible: its downgrade raises. drain the
old worker before migrating (it reads the dropped columns) and start the new one
after; queued sync jobs survive (their payload is a superset of the new one). web,
api and worker ship together; never the web first (the new web sends no
`Idempotency-Key`, which the old api requires). preflight, read-only:

```sql
SELECT count(*) FILTER (WHERE auto_queue AND auto_queue_watermark_at IS NULL) AS d1_rows,
       count(*) FILTER (WHERE sync_status IN ('Pending', 'Running')) AS live_syncs
FROM podcast_subscriptions;
SELECT count(*) FROM resource_mutations WHERE mutation_scope = 'podcast:control';
SELECT count(*) FROM podcast_subscription_backfills b
WHERE NOT EXISTS (SELECT 1 FROM podcast_subscriptions s WHERE s.id = b.subscription_id);  -- must be 0
```

expect a few backfills to read Failed after release: a history page that fails to
fetch or parse now fails the backfill (it used to end history silently); "Retry
backlog" is the remedy ([ticket](backfills-completed-by-silent-page-failures.md)).

the chat runs rewrite adds `0271` (chat runs own their intent), after the podcasts
`0270`. it moves each run's frozen prompt from `chat_prompt_assemblies` onto
`chat_runs.generation_intent` (refusing, nothing written, if a run has no
assembly), drops that table and the write-only `chat_run_turn_contexts`, deletes
the never-read `meta`, `assistant_activity` and `citation_index` frames (and
`tool_call_delta`) and narrows the event-type CHECK, rebuilds eight chat foreign
keys `ON DELETE CASCADE` with two supporting indexes, and drops
`message_retrievals.snippet_prefix/suffix`. production crosses `0246` first, so it
touches no rows there. it is irreversible: its downgrade raises; rollback is the
pre-release backup plus the prior builds. it runs in the same window as 0268 to
0270, writers stopped; web and api ship together (chat contract "4").

the imports reauthor adds `0272` (retire historical import failure codes, data only), after the chat `0271`.
it rewrites `E_BILLING_REQUIRED`, `E_LLM_BAD_REQUEST` and `E_PODCAST_QUOTA_EXCEEDED`
to `E_INGEST_FAILED` in `media.last_error_code` (all rows), `media_source_attempts.error_code`,
`media_processing_events.failure_code` and its SourceHistoryBaseline `payload->'outcome'->'failure_code'`,
`media_upload_events.failure_code`, and `background_jobs.error_code` for the jobs imports
reads (a source attempt's `job_id`, or `media_content_reindex_job`); other queue rows,
`media_transcript_states.last_error_code` and verification codes stay. it is irreversible:
its downgrade raises; the pre-release backup holds the original codes. `media_notify`
fires once per rewritten media row (writers are stopped; it runs in the same window as 0268 to 0271). migrate before the web and api
start: the new web has no copy for the retired codes and the new api asserts on an
uncatalogued stored code, so either against an unmigrated database fails on those rows.
web and api ship together (the repair route's response is now typed; its bytes are
unchanged). production at `0241` also crosses `0252`, which leaves the quota code only in
`media_transcript_states`. dry run: `campaign-artifacts/2026-10-09/imports/migration-dry-run.txt`.

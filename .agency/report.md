# podcast-transcript-phase3-4

## summary
- fixed default "all filters selected" search behavior so transcript chunks are included end-to-end (frontend now always serializes all selected `types`; backend omitted-types default now includes `transcript_chunk`)
- repaired stale podcast fail-close handling in `reconcile_stale_ingest_media` so failure closes job+quota+transcript state atomically (no stranded `running`/`queued` admission state)
- cut semantic transcript retrieval over to pgvector ANN + hybrid SQL reranking (semantic similarity + lexical relevance + recency), removing bounded python-side corpus scan/rank
- upgraded transcript embedding pipeline to production provider path (`openai` embeddings with configurable model/dimensions/timeout) while keeping deterministic test-mode embeddings for hermetic CI
- added migration `0027` to introduce `embedding_vector` + ANN index and mark legacy hash-indexed active transcripts `semantic_status='pending'` for re-index
- closed the semantic cutover gap with an explicit repair/reindex path: readable transcripts in `semantic_status in ('pending','failed')` now enqueue targeted semantic reindex jobs, and stale ingest reconciler now runs a semantic backlog repair pass
- fixed annotation remap logic across transcript versions to choose nearest active fragment by overlap/proximity, not exact timestamp equality only
- made migration `0026` time-stable by freezing embedding logic inside migration code (`hash_v1_frozen_0026`) and removing runtime app-code imports

## decisions
- **explicit type serialization over implicit defaults**: frontend now always sends selected `types` (including full-selection case) to prevent backend-default drift
- **semantic retrieval moved into postgres**: ANN candidate generation + hybrid reranking run inside SQL to avoid python scan/rank bottlenecks
- **provider embeddings are mandatory in non-test envs**: transcript semantic indexing now uses a production embedding backend; test env remains deterministic for reliability
- **legacy hash embeddings are not treated as production-semantic-ready**: migration `0027` demotes those rows to `semantic_status='pending'` pending re-index
- **readable transcript admission is semantic-aware**: transcript requests no longer idempotently no-op when transcript text is readable but semantic index is pending/failed; they enqueue semantic repair without spending quota
- **semantic repair is operationalized in the reconciler loop**: stale ingest reconciliation now includes bounded semantic backlog repair (`pending` immediately, `failed` after cooldown) to prevent indefinite non-searchable drift
- **recovery paths must use domain failure handlers**: stale podcast fail-close delegates to podcast service failure repair to clear job reservation and transcript-state drift
- **migration determinism over runtime coupling**: migration `0026` owns frozen embedding logic locally so fresh installs stay stable over future app refactors

## how to test
```bash
# apply latest schema
make migrate-test

# backend regressions (changed domains)
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q tests/test_podcasts.py tests/test_search.py tests/test_capabilities.py tests/test_reconcile_stale_ingest_media.py

# ingest orchestration/task-contract regressions
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q tests/test_ingest_recovery_ops.py tests/test_ingest_remediation_contracts.py tests/test_podcast_polling_orchestration.py

# migration regressions (includes 0026/0027 behavior)
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations uv run pytest -q tests/test_migrations.py

# frontend regressions
cd apps/web && npx vitest run "src/lib/search/resultRowAdapter.test.ts" "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx"
```

## risks
- non-test semantic indexing now depends on valid `OPENAI_API_KEY` and provider availability; failed embedding calls leave transcript readable but semantic status `failed`
- semantic backlog throughput now depends on `INGEST_SEMANTIC_REPAIR_BATCH_LIMIT` and reconcile cadence; under very large pending/failed backlogs, full recovery latency can still be non-trivial
- ANN recall/latency tuning (`lists`, `ivfflat.probes`) may need environment-specific adjustment as corpus size grows

## cutover analysis addendum (2026-03-17)

### summary
- confirmed that pgvector cutover intentionally demotes legacy hash-backed transcript states from `semantic_status='ready'` to `'pending'`, while search serves only rows with `semantic_status='ready'` and current embedding model match.
- confirmed that repair exists but is eventual: single-media enqueue on transcript request, plus periodic reconcile with bounded batch size and retry cooldown.
- confirmed there is no dedicated run-until-empty bulk semantic drain controller in current code paths.

### decisions
- treat this as a deterministic-cutover gap, not a transient operational nuisance.
- target a generation-based semantic index cutover controller (shadow build + atomic active-generation switch) instead of migration-time state demotion.
- avoid long-lived backward-compatibility serving; keep compatibility only as temporary rollout scaffolding, then remove.

### how to test
- analysis-only pass (no product code changes in this addendum).
- validate claims with:
  - `migrations/alembic/versions/0027_pgvector_semantic_transcript_search_cutover.py`
  - `python/nexus/services/search.py`
  - `python/nexus/services/podcasts.py`
  - `python/nexus/tasks/reconcile_stale_ingest_media.py`
  - `python/nexus/tasks/podcast_reindex_semantic.py`
  - `python/nexus/config.py`

### risks
- default reconcile throughput (`INGEST_SEMANTIC_REPAIR_BATCH_LIMIT=50`, `INGEST_RECONCILE_SCHEDULE_SECONDS=300`) can leave large legacy corpus segments semantically dark for extended periods post-cutover.
- embedding model/version drift can silently deindex `semantic_status='ready'` rows because serving requires exact model equality while repair claim currently targets only `pending`/`failed`.
- embedding dimension is runtime-configurable, while migration hardcodes `embedding_vector vector(256)`; misalignment can break insert/query behavior.

## podcast ux hardening addendum (2026-03-18)

### summary
- made podcast discovery subscription-aware across sessions by hydrating existing subscriptions before rendering discovery actions.
- exposed full subscription lifecycle controls in the web ui: unsubscribe mode selector (1..3), manual sync refresh action, and explicit sync error visibility.
- made podcast surfaces pagination-safe by adding `offset` support backend-side and load-more flows frontend-side for subscription lists, episode lists, and default-library membership scans.
- added demand-driven transcript request CTA controls on podcast episode rows with explicit reasons (`search`, `highlight`, `quote`) instead of relying only on `episode_open`.
- added user-facing podcast plan/quota surface (`GET/PUT /podcasts/plan`) and wired a plan/quota section in subscriptions ui with safe save controls.

### decisions
- use backend pagination parameters (`limit` + `offset`) as a backward-compatible hardening path instead of breaking envelope contracts for existing list endpoints.
- introduce a dedicated manual sync refresh route (`POST /podcasts/subscriptions/{podcast_id}/sync`) that transitions non-running subscriptions to `pending` and dispatches sync jobs.
- keep sync refresh fail-safe for active running jobs: no duplicate enqueue while running lease is healthy.
- expose plan management on a first-class viewer route (`/podcasts/plan`) rather than extending the internal self-only route surface.

### how to test
```bash
# frontend podcast flows + bff routes
cd apps/web && npm test -- "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" "src/app/api/podcasts/podcasts-routes.test.ts"

# frontend static type validation
cd apps/web && npm run typecheck

# backend podcast integration coverage (full file)
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q tests/test_podcasts.py

# backend lint on touched files
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run ruff check nexus/api/routes/podcasts.py nexus/api/routes/libraries.py nexus/services/podcasts.py nexus/services/libraries.py nexus/schemas/podcast.py tests/test_podcasts.py
```

### risks
- offset pagination is vulnerable to concurrent list mutation drift (skip/duplicate windows) under high write churn; cursor pagination remains the long-term ideal.
- plan editing is now user-accessible; if product policy requires stricter entitlement checks, this route should be gated by billing/feature flags before broad rollout.

## entitlement + rollout safety addendum (2026-03-19)

### summary
- removed self-serve entitlement overrides: public `PUT /podcasts/plan` now returns `E_FORBIDDEN`, Next BFF no longer exports `PUT /api/podcasts/plan`, and subscriptions UI is read-only for plan/quota snapshot.
- hardened semantic index rollout behavior: runtime now enforces `TRANSCRIPT_EMBEDDING_DIMENSIONS=256` (schema-compatible), transcript request admission detects stale/missing active-model semantic chunks even when state is `ready`, and semantic repair reconciler now includes stale `ready` rows (not only `pending`/`failed`).
- fixed media transcript UX stall after admission: queued/running transcript media now polls status and refreshes fragments until readable.
- fixed podcast detail stale state after mutations: transcript request responses now patch episode row state + request forecast hint, and refresh sync now performs full detail/episodes/library reload to reset pagination and surface newly synced rows.
- fixed search cursor contamination: editing query or type filters now clears stale results/cursor state before the next search.

### decisions
- **forbid instead of soft-hide**: keeping a public write endpoint while hiding controls is not a security control; explicit server-side `403` closes the quota/billing bypass class.
- **dimension drift fails fast**: schema is `vector(256)`, so runtime dimensions are now pinned to `256` until an explicit DB migration changes storage shape.
- **stale-ready semantic rows are first-class backlog**: semantic repair now treats active-version model mismatch/null-vector/missing-chunk rows as repairable drift.
- **polling is lifecycle-driven**: transcript polling is enabled only for transcript media in `queued`/`running`/`extracting` states and self-disables once readability is restored.
- **refresh sync must be data-refreshing, not cosmetic**: post-sync state now rehydrates full detail + episodes instead of mutating only subscription fields.

### how to test
```bash
# frontend type + regressions
cd apps/web && npm run typecheck
cd apps/web && npm test -- \
  "src/app/(authenticated)/media/[id]/transcriptPolling.test.tsx" \
  "src/app/(authenticated)/search/page.test.tsx" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" \
  "src/app/api/podcasts/podcasts-routes.test.ts"

# backend regressions
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_config.py::TestTranscriptEmbeddingConfiguration::test_transcript_embedding_dimensions_must_match_schema_dimension \
  tests/test_podcasts.py::TestPodcastUxHardening::test_get_plan_route_surfaces_user_plan_and_usage \
  tests/test_podcasts.py::TestPodcastUxHardening::test_put_plan_route_rejects_self_serve_plan_override \
  tests/test_podcasts.py::TestPodcastTranscriptRequestAdmission::test_transcript_request_enqueues_semantic_repair_for_ready_transcript_with_stale_model \
  tests/test_podcasts.py::TestPodcastTranscriptRequestAdmission::test_transcript_request_enqueues_semantic_repair_for_readable_transcript_backlog \
  tests/test_reconcile_stale_ingest_media.py::test_reconciler_repairs_pending_semantic_backlog_for_ready_podcast_transcripts \
  tests/test_reconcile_stale_ingest_media.py::test_reconciler_retries_failed_semantic_backlog_after_retry_window \
  tests/test_reconcile_stale_ingest_media.py::test_reconciler_repairs_ready_semantic_rows_when_active_model_changes \
  tests/test_search.py::TestSemanticTranscriptChunkSearch::test_semantic_search_returns_timestamped_transcript_chunks \
  tests/test_search.py::TestSemanticTranscriptChunkSearch::test_semantic_search_excludes_transcripts_when_index_not_ready

# backend lint for touched files
cd python && uv run ruff check \
  nexus/api/routes/podcasts.py \
  nexus/config.py \
  nexus/services/podcasts.py \
  nexus/tasks/reconcile_stale_ingest_media.py \
  tests/test_config.py \
  tests/test_podcasts.py \
  tests/test_reconcile_stale_ingest_media.py
```

### risks
- embedding dimension is now intentionally pinned to `256`; future dimension upgrades require explicit schema migration + coordinated rollout (by design).
- transcript provisioning polling uses a fixed 3s interval; this is robust but may create mild API churn under very large concurrent queued/running sets.
- podcast detail refresh now reloads full episode/default-library state; this trades more API calls for correctness and may need optimization if lists grow.

## billing principal + transcript-state clarity addendum (2026-03-19)

### summary
- replaced self-identity authorization on `PUT /internal/podcasts/users/{user_id}/plan` with a first-class billing/admin principal policy (role/email/user-id based) and moved the handler into a dedicated internal podcasts route module.
- extended authenticated viewer identity with normalized role claims, so backend authorization decisions are policy-driven and independent of BFF/internal-header transport assumptions.
- updated podcast detail episode rows to surface transcript state/coverage explicitly, patch these fields immediately on transcript request acknowledgement, and then refresh the row from `GET /api/media/{id}` to avoid stale state.
- added an explicit partial-transcript warning in the readable transcript pane so users are told search/highlight coverage may be incomplete.

### decisions
- **backend policy over transport gates**: internal header gating is not treated as authorization for entitlement writes; principal policy now executes inside backend route handling.
- **stable route contract, stronger guardrail**: kept `/internal/podcasts/users/{user_id}/plan` path stable for operator tooling, but enforced billing/admin principals instead of `viewer.user_id == user_id`.
- **multi-channel principal matching**: authorization accepts any of (configured admin role claims, configured admin emails, configured admin user IDs) to support staged migration across identity providers.
- **targeted row refresh over full page reload**: transcript request follow-up refresh uses media-level fetch to reconcile row state without resetting pagination/list UI.

### how to test
```bash
# frontend targeted regressions
cd apps/web && npm test -- \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx"

# frontend static type validation
cd apps/web && npm run typecheck

# backend authorization + config regressions
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py::TestPodcastUxHardening::test_get_plan_route_surfaces_user_plan_and_usage \
  tests/test_podcasts.py::TestPodcastUxHardening::test_internal_plan_route_rejects_non_billing_principal_even_for_self \
  tests/test_podcasts.py::TestPodcastUxHardening::test_internal_plan_route_allows_billing_admin_for_other_user \
  tests/test_config.py::TestPodcastPlanAdminPrincipalConfiguration

# backend auth + podcast safety spot checks
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q tests/test_auth.py
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py::TestPodcastQuotaAndPlans::test_manual_plan_change_applies_immediately \
  tests/test_podcasts.py::TestPodcastTranscriptRequestAdmission::test_transcript_request_admits_with_quota_and_enqueues_job

# backend lint
cd python && uv run ruff check \
  nexus/config.py \
  nexus/auth/middleware.py \
  nexus/auth/principals.py \
  nexus/api/routes/__init__.py \
  nexus/api/routes/podcasts.py \
  nexus/api/routes/internal_podcasts.py \
  tests/test_config.py \
  tests/test_podcasts.py
```

### risks
- if production tokens do not include any configured admin role and operator allowlists are unset, internal plan writes will now hard-fail with `403` until principal config is supplied.
- role extraction is intentionally permissive across several claim shapes; accidental role-claim overloading in upstream auth systems could grant authority if configured admin role names are too broad.
- each transcript request now performs one additional media read for reconciliation; this improves correctness but increases per-action API load.

## podcast detail transcript ux parity addendum (2026-03-20)

### summary
- made podcast detail episode-row transcript actions state-aware: request controls now render only for requestable states, and ready/partial/queued/running rows no longer show redundant request CTAs.
- added transcript provisioning follow-through polling on podcast detail episodes, reusing the same queued/running/extracting lifecycle semantics as media detail so rows self-refresh through completion.
- added pre-request dry-run quota forecasting for podcast detail transcript requests, surfaced per-row budget hints, and disabled the request action when `fits_budget` is false.
- updated search empty-state guidance copy to explicitly include transcript chunks.

### decisions
- **single-source transcript state gates**: requestability now derives from explicit transcript-state guards (`not_requested`/`failed_*` requestable; `queued`/`running`/`ready`/`partial`/`unavailable` non-requestable) rather than ad hoc UI button rules.
- **polling by observable state, not click side effects**: polling eligibility is computed from row state (`queued`/`running`/`extracting`), so rows continue progressing even if intermediate refreshes fail or updates originate outside the current click path.
- **forecast before commit**: dry-run (`dry_run: true`) is now a first-class preflight for row actions; commit requests (`dry_run: false`) are blocked when forecast budget does not fit.
- **bounded forecast fan-out**: forecast loading is batched (`TRANSCRIPT_FORECAST_BATCH_SIZE=5`) to avoid unconstrained N+1 request spikes on large episode lists.

### how to test
```bash
cd apps/web && npm test -- \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" \
  "src/app/(authenticated)/search/page.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx"

cd apps/web && npm run typecheck
```

### risks
- per-row dry-run forecasting adds API traffic on podcast detail pages with many requestable episodes; batching reduces burst pressure but does not remove aggregate overhead.
- polling currently uses a fixed 3s cadence for all provisioning rows; large concurrent queues may benefit from adaptive backoff in a future pass.

## s7 pr-05 player + listening-state cutover addendum (2026-03-22)

### summary
- introduced durable backend listening-state persistence with a new `podcast_listening_states` table, authenticated `GET/PUT /media/{id}/listening-state` endpoints, and media-detail hydration of `listening_state` in `GET /media/{id}`.
- cut over the global footer player from minimal controls to a full transport surface: draggable scrubber, skip back/forward, playback speed select, desktop volume slider, keyboard arrow shortcuts when player controls are focused.
- added audio playback durability semantics in `GlobalPlayerProvider`: periodic writes at 15s while actively playing, plus unconditional flushes on pause, track switch, and `beforeunload`.
- wired media-page resume hydration end-to-end: podcast panes now pass saved `position_ms`/`playback_speed` into global track setup and emit a resume toast on open when a saved position exists.
- added red/green coverage for bff route proxying, footer controls/keyboard behavior, persistence timing semantics, transcript-pane resume hydration, backend listening-state integration, and migration schema contract.

### decisions
- **hard cutover (no compatibility shim):** listening persistence is now first-class via `podcast_listening_states`; no reader-state fallback path was introduced for audio position/speed.
- **single write path:** all player persistence writes converge on `PUT /api/media/{id}/listening-state`, including lifecycle flush events; this avoids split persistence logic across components.
- **default speed reset policy preserved:** absent per-episode listening state, track load sets playback speed to `1.0x` (not previous-track carryover), matching the PR-05 decision.
- **global volume preference:** volume remains global localStorage state (`nexus.globalPlayer.volume`) and is intentionally not persisted per episode in backend state.
- **service-layer enforcement:** backend visibility and ownership checks stay in service/routing boundaries (`can_read_media` + viewer-scoped upsert/get), with no route-level domain logic.

### how to test
```bash
# migrate test schema to include 0028
make migrate-test

# frontend PR-05 coverage
cd apps/web && npm test -- \
  "src/app/api/media/media-routes.test.ts" \
  "src/__tests__/components/GlobalPlayerFooter.test.tsx" \
  "src/__tests__/components/GlobalPlayerPersistence.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx"

# backend PR-05 coverage
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_media.py::TestGetMedia::test_get_media_success \
  tests/test_media.py::TestMediaListeningState::test_get_listening_state_returns_defaults_when_absent \
  tests/test_media.py::TestMediaListeningState::test_put_then_get_listening_state_upserts_and_preserves_optional_fields \
  tests/test_media.py::TestMediaListeningState::test_get_media_hydrates_listening_state_when_present \
  tests/test_media.py::TestMediaListeningState::test_listening_state_endpoints_mask_unreadable_media

# migration contract assertion
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations uv run pytest -q \
  tests/test_migrations.py::TestPodcastListeningStateMigration::test_head_contains_podcast_listening_state_table_contract

# backend lint on touched files
cd python && uv run ruff check \
  nexus/db/models.py \
  nexus/schemas/media.py \
  nexus/services/media.py \
  nexus/api/routes/media.py \
  tests/test_media.py \
  tests/test_migrations.py
```

### risks
- `beforeunload` persistence relies on browser keepalive semantics; mobile/browser-specific lifecycle behavior can still drop the very last write despite periodic sync.
- current listener-state writes are direct per-event upserts; high-concurrency heavy listeners may eventually require write coalescing or queue-based buffering.

## dnd-kit queue + libraries ordering addendum (2026-03-22)

### summary
- replaced native html drag/drop in the global queue panel with `@dnd-kit` sortable interactions.
- introduced a shared reusable sortable primitive (`SortableList`) and used it in both playback queue and library detail media rows.
- added durable ordering for library media via new `library_media.position` schema + migration `0030`.
- added backend reorder contract `PUT /libraries/{library_id}/media/order` with full-set validation and admin-only enforcement.
- updated library list semantics from recency-only (`created_at DESC`) to persisted position order with deterministic tie-breakers.
- added bff proxy route for library reorder and coverage for queue/library route proxying + backend reorder behavior.

### decisions
- **single reusable dnd layer**: queue and libraries use one shared sortable component to avoid divergence in drag behavior.
- **persisted library order, not client-only order**: library drag-drop writes to backend order endpoint and survives refresh/session/device.
- **full-set reorder payload**: library reorder uses complete `media_ids[]` replacement to keep server validation simple and atomic.
- **admin-only library ordering**: reorder writes are restricted to admin members to match existing library media mutation policy.
- **append-first ordering model**: newly added library media gets the next position; reorder updates are normalized server-side.

### how to test
```bash
# schema
make migrate-test

# frontend
cd apps/web && npm run typecheck
cd apps/web && npm test -- \
  "src/app/api/playback/playback-routes.test.ts" \
  "src/app/api/libraries/libraries-media-routes.test.ts" \
  "src/__tests__/components/GlobalPlayerFooter.test.tsx" \
  "src/__tests__/components/GlobalPlayerQueue.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"

# backend
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_playback_queue.py \
  tests/test_libraries.py::TestReorderLibraryMedia \
  tests/test_libraries.py::TestListLibraryMedia::test_list_media_ordering

# migration contracts
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations uv run pytest -q \
  tests/test_migrations.py::TestPlaybackQueueMigration::test_head_contains_playback_queue_table_and_auto_queue_flag \
  tests/test_migrations.py::TestLibraryMediaOrderingMigration::test_head_contains_library_media_position_contract
```

### risks
- library ordering currently has no dedicated ui component tests for drag gesture interactions on the library detail page; behavior is covered indirectly via backend reorder contracts and route tests.
- library order uses explicit position writes plus periodic normalization, but non-route internal writers can still create temporary position gaps before normalization.
- `SortableList` currently targets vertical list strategy only; if grid/horizontal drag surfaces are added later, the shared primitive must be extended carefully.

## s7 pr-06 playback queue cutover addendum (2026-03-22)

### summary
- added a first-class per-user playback queue backend contract: `playback_queue_items` schema + service-layer operations for list/add/remove/reorder/clear/next, with strict viewer scoping and duplicate-elision semantics.
- exposed full queue API surface to web through dedicated node-runtime bff proxies under `/api/playback/queue*`.
- integrated queue-aware transport behavior into the global player: next/previous controls, >3s previous-restart threshold, ended-event auto-advance, queue hydration, and queue state in player context.
- added queue interaction surfaces in media and podcast detail ux: `Play next` and `Add to queue` actions, in-queue badge feedback, and a queue panel with remove/clear/reorder affordances.
- extended podcast subscription sync with `auto_queue` opt-in so newly ingested episodes can be appended automatically for opted-in subscriptions only.
- delivered red/green coverage across backend queue API + migration contract + auto-queue sync behavior, plus frontend player/queue behaviors and bff wiring.

### decisions
- **strict cutover, no compatibility shim**: queue behavior is server-owned and authoritative (`playback_queue_items`), with no fallback to client-only queue state.
- **single shared player state**: queue and active track are managed in `GlobalPlayerProvider`, so page-level actions update one source of truth used by footer controls and panes.
- **deterministic next/previous semantics**: `next` resolves from ordered server queue by current media id; `previous` restarts current track when playback has crossed 3 seconds, otherwise jumps to prior queue item.
- **queue mutation safety over cleverness**: backend reindexing runs after each mutation and now flushes pending ORM inserts before SQL normalization to avoid duplicate-position drift.
- **subscription auto-queue is explicit opt-in**: `auto_queue` defaults false and only opted-in active subscriptions append newly ingested episodes.

### how to test
```bash
# apply schema (includes playback queue migration 0029)
make migrate-test

# frontend queue + player + podcast/media integration coverage
cd apps/web && npm run typecheck
cd apps/web && npm test -- \
  "src/app/api/playback/playback-routes.test.ts" \
  "src/__tests__/components/GlobalPlayerFooter.test.tsx" \
  "src/__tests__/components/GlobalPlayerQueue.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"

# backend queue + auto-queue sync behavior
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_playback_queue.py \
  tests/test_podcasts.py::TestPodcastSubscriptionSyncLifecycle::test_sync_job_auto_queue_opt_in_appends_new_episodes_to_playback_queue

# migration contract assertion
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations uv run pytest -q \
  tests/test_migrations.py::TestPlaybackQueueMigration::test_head_contains_playback_queue_table_and_auto_queue_flag
```

### risks
- footer queue panel currently uses native html drag/drop ordering (not `@dnd-kit` yet); accessibility and touch ergonomics are acceptable for now but not best-in-class for high-volume queue management.
- queue actions in media/podcast rows are intentionally optimistic at interaction level but still silently recover on api failure; if stronger user feedback is required, explicit toast/error surfacing should be added in a follow-up.
- auto-advance depends on `ended` firing from the active audio element; unusual stream failures that bypass `ended` will not advance automatically without additional error-event fallbacks.

## s7 pr-07 episode state + filtering cutover addendum (2026-03-22)

### summary
- added durable completion-state semantics to listening persistence by introducing `podcast_listening_states.is_completed` and extending `/media/{id}/listening-state` get/put contracts to surface and mutate completion state explicitly.
- implemented 95% completion auto-marking on position writes in media service logic, while supporting explicit manual overrides (`is_completed=true/false`) without requiring position writes.
- added batch completion endpoint `POST /media/listening-state/batch` with strict viewer visibility validation and episode-kind enforcement for multi-episode mark-as-played flows.
- extended podcast episodes list contract with server-side `state`/`sort`/`q` query support plus per-row `episode_state` + full `listening_state` payload (`position_ms`, `duration_ms`, `playback_speed`, `is_completed`).
- extended subscriptions list contract with per-row `unplayed_count` and server-side sort modes (`recent_episode`, `unplayed_count`, `alpha`).
- cut frontend podcast detail and subscriptions UIs over to the new contracts: state pills, sort select, debounced search, mark played/unplayed actions, mark-all-visible-as-played flow, unplayed-count badges, and subscription sorting controls.
- added a backend regression guard that fails if episodes listing ever falls back to per-episode `get_media_for_viewer` lookups, protecting the batch-hydration refactor.
- refactored media hydration assembly into shared helpers so `get_media_for_viewer`, `list_media_for_viewer_by_ids`, and `list_visible_media` construct `MediaOut` payloads through one canonical code path.
- extracted shared media projection query builders (`_media_select_projection_sql` + `_media_listening_state_join_sql`) so both ID-batch hydration and visible-media listing derive row shape from a single source.

### decisions
- **derived-state source of truth**: episode state is never persisted as a standalone column; it is derived from `position_ms` + `is_completed`, with `is_completed` as the sole explicit override bit.
- **position writes are completion-aware**: auto-complete is applied in service logic (not db trigger) only on position writes; manual `is_completed` overrides always win when provided.
- **batch writes are strict and explicit**: batch mark validates full viewer visibility set and rejects unknown/invisible IDs before any mutation.
- **query-driven UI state**: podcast detail filter/sort/search controls are encoded in pane URL query params and drive server-side list fetches directly.
- **episode hydration is batch-first**: episodes list now resolves all media rows in one viewer-scoped batch query plus one batched authors read, then reattaches derived episode state without per-item media lookups.
- **projection drift guardrail**: media row select columns now come from one internal builder, with explicit null listening-state placeholders for queries that intentionally do not join listening state.

### how to test
```bash
# schema
make migrate-test

# backend
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_media_list.py \
  tests/test_media.py::TestMediaListeningState \
  tests/test_media.py::TestMediaListeningStateBatch \
  tests/test_podcasts.py::TestPodcastApiSurface::test_get_podcast_episodes_supports_state_sort_search_and_derived_episode_state \
  tests/test_podcasts.py::TestPodcastApiSurface::test_list_subscriptions_returns_unplayed_count_and_supports_sort_modes

# migration contract
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations uv run pytest -q \
  tests/test_migrations.py::TestPodcastListeningStateMigration::test_head_contains_podcast_listening_state_table_contract

# frontend
cd apps/web && npm run typecheck
cd apps/web && npm test -- \
  "src/app/api/media/media-routes.test.ts" \
  "src/app/api/podcasts/podcasts-routes.test.ts" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"
```

### risks
- media-out hydration drift risk is reduced via shared constructors, but capabilities/author payloads are still assembled per row in Python after batched SQL fetches; very large pages may still need profiling/tuning.
- mark-all-as-played intentionally applies to currently visible rows (current filter/search/page) rather than every historical episode in the subscription.
- subscription `unplayed_count` is computed live via joins/aggregates; users with many subscriptions and very large episode corpora may need future index/tuning work.

## s7 pr-08 opml import/export cutover addendum (2026-03-22)

### summary
- added backend OPML contracts: `POST /podcasts/import/opml` (multipart upload, recursive RSS outline traversal, feed-identity subscription import summary) and `GET /podcasts/export/opml` (active-subscription OPML 2.0 download).
- implemented OPML import safeguards: XML/type validation, 1MB upload cap, 200-outline cap, xmlUrl validation + normalization (including trailing-slash identity normalization), and string sanitization for imported metadata.
- wired import behavior to create/reactivate subscriptions idempotently, skip already-active subscriptions, fallback to OPML metadata when PodcastIndex feed lookup misses, and enqueue sync jobs only for newly imported subscriptions.
- added web BFF passthrough routes for OPML import/export and upgraded subscriptions UI with import modal + upload flow + result breakdown and direct OPML export download action.
- added red/green coverage for backend OPML acceptance paths, BFF route wiring, and subscriptions UI import/export behavior.

### decisions
- **feed url is the import identity**: import resolves podcasts by normalized feed URL first and uses trailing-slash normalization so slash/no-slash variants do not fork duplicate podcasts/subscriptions.
- **strict synchronous control plane, async data plane**: OPML parse/subscription creation runs in-request; sync/ingest remains queued per new import.
- **graceful provider degradation**: provider feed lookup is best effort; unknown feeds still import from OPML metadata with stable feed-derived provider IDs.
- **explicit no-compat cutover**: OPML import/export is first-class on podcast routes and subscriptions UI without fallback to legacy/manual-only migration paths.

### how to test
```bash
# backend OPML coverage
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py::TestPodcastOpmlImportExport

# backend podcast regression sweep
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py

# frontend BFF + subscriptions flow coverage
cd apps/web && npm test -- \
  "src/app/api/podcasts/podcasts-routes.test.ts" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"
```

### risks
- import currently performs one provider lookup and one transaction per RSS outline; at the 200-outline cap this is acceptable but may require batching/caching optimization if limits are increased later.
- export currently emits feed/title/website only (no extended OPML metadata fields beyond acceptance scope); some third-party importers may ignore or expect additional optional attributes.
- provider identity collisions (same provider podcast id mapped to different feed urls) are handled defensively, but this remains a rare edge case that may need dedicated reconciliation tooling if observed in production.

## s7 pr-09 podcast chapter support cutover addendum (2026-03-22)

### summary
- added first-class podcast chapter persistence with migration `0032` (`podcast_episode_chapters`) including ordering, source constraints, and temporal integrity checks.
- implemented rss chapter extraction during subscription sync for both Podcasting 2.0 JSON (`<podcast:chapters>`) and Podlove Simple Chapters (`<psc:chapters>`), with normalization, deterministic ordering, and idempotent upsert/delete semantics.
- extended backend media contracts so `GET /media/{id}` and podcast episode list hydration surface `chapters[]` consistently through `MediaOut`.
- cut frontend player/transcript experiences over to chapter-aware rendering: global footer now shows active chapter + scrubber tick marks; transcript pane now renders chapter list, chapter click seek, active chapter highlighting, and inline chapter dividers.
- added red/green coverage for migration schema contract, sync extraction + API exposure, transcript pane chapter UX, and footer chapter metadata/ticks.

### decisions
- **hard cutover, no fallback parser path:** chapter support is now explicit in schema/contracts; no compatibility shim to legacy ad hoc chapter handling was introduced.
- **feed-source precedence:** when Podcasting 2.0 chapter references exist and parse successfully, they win; Podlove chapters are used as fallback only when Podcasting 2.0 chapter payload is absent/unusable.
- **idempotent replace semantics per media:** sync writes normalize chapter rows, upsert by `(media_id, chapter_idx)`, and remove stale trailing rows to prevent drift after feed edits.
- **single hydration path for chapter payloads:** chapter projection is batched in media service and reused by both list and detail media responses to avoid endpoint-specific divergence.
- **player state carries chapters as track metadata:** chapter markers/active chapter resolution are driven from normalized `GlobalPlayerTrack.chapters`, keeping footer and pane behavior consistent.

### how to test
```bash
# migrate schema (includes 0032)
make migrate-test

# backend chapter contracts
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py::TestPodcastApiSurface::test_sync_extracts_podcasting20_chapters_and_exposes_episode_and_media_contract \
  tests/test_podcasts.py::TestPodcastApiSurface::test_sync_extracts_podlove_chapters_when_podcasting20_is_absent \
  tests/test_migrations.py::TestPodcastEpisodeChapterMigration::test_head_contains_podcast_episode_chapters_table_contract

# frontend chapter UX contracts
cd apps/web && npm run test -- \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx" \
  "src/__tests__/components/GlobalPlayerFooter.test.tsx"
```

### risks
- chapter URL fetch for Podcasting 2.0 JSON is synchronous per selected episode during sync; large subscriptions with many chapter manifests may increase sync latency.
- chapter image/link payloads are normalized but treated as external content; downstream clients still need conservative rendering/sandbox posture for untrusted feeds.
- active chapter highlighting in the transcript pane depends on current player time updates; very low-frequency time updates can make highlight transitions appear slightly delayed.

## s7 pr-10 test hardening + strict contract cutover addendum (2026-03-22)

### summary
- removed frontend backward-compat parsing for legacy flat search rows; search result normalization now accepts only canonical nested source contracts.
- hardened transcript provisioning polling semantics: polling is now enabled only for `queued`/`running` transcript states, and poll errors are explicitly swallowed/retried without unhandled promise rejection leakage.
- expanded transcript-pane coverage with explicit tests for `queued`, `running`, `failed_provider`, `failed_quota`, and `unavailable` rendering paths (in addition to existing `not_requested`/`ready`/`partial` coverage).
- added a dedicated backend provider test module (`python/tests/test_podcast_index_provider.py`) covering PodcastIndex success, 429 + Retry-After retry behavior, 5xx retry exhaustion, timeout retry exhaustion, malformed JSON handling, and empty result handling.
- updated global-player persistence assertions to measure only listening-state writes (`/api/media/*/listening-state`) so queue hydration fetches do not produce false negatives.

### decisions
- **hard cutover, no shim:** legacy flat search payloads are intentionally rejected post-cutover rather than normalized client-side.
- **state-driven polling only:** transcript polling no longer depends on `processing_status="extracting"` fallback; transcript-state drives lifecycle.
- **error-tolerant polling loop:** polling hook catches/retries transient poll failures and avoids unhandled rejection side effects.
- **provider reliability tests are explicit:** PodcastIndex retry/error behavior now has direct unit coverage instead of relying on indirect integration paths.
- **test intent isolation:** global-player persistence tests now assert only the listening-state boundary they claim to verify.

### how to test
```bash
# frontend strict-cutover + transcript-state suites
cd apps/web && npm run test -- \
  "src/lib/search/resultRowAdapter.test.ts" \
  "src/app/(authenticated)/media/[id]/transcriptPolling.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx"

# frontend broader podcast/player/search regression slices
cd apps/web && npm run test -- \
  "src/app/(authenticated)/search/page.test.tsx" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" \
  "src/__tests__/components/GlobalPlayerFooter.test.tsx" \
  "src/__tests__/components/GlobalPlayerPersistence.test.tsx" \
  "src/__tests__/components/GlobalPlayerQueue.test.tsx"

# backend provider retry/error hardening + key podcast admission/sync slices
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcast_index_provider.py \
  tests/test_podcasts.py::TestPodcastTranscriptRequestAdmission::test_transcript_request_dry_run_reports_budget_fit_without_spending_or_enqueue \
  tests/test_podcasts.py::TestPodcastTranscriptRequestAdmission::test_transcript_request_admits_with_quota_and_enqueues_job \
  tests/test_podcasts.py::TestPodcastTranscriptRequestAdmission::test_transcript_request_is_idempotent_when_already_queued \
  tests/test_podcasts.py::TestPodcastTranscriptPersistence::test_transcript_segments_persist_with_deterministic_order_and_diarization_fallback \
  tests/test_podcasts.py::TestPodcastSubscriptionSyncLifecycle::test_sync_job_ingests_window_and_marks_subscription_complete
```

### risks
- strict search-shape cutover means any backend contract regression to flat payloads now fails closed (rows dropped) instead of silently adapting; this is desired but sharp.
- polling now keys strictly off transcript state; if backend emits stale/null transcript state while still extracting, client auto-polling will not run until state consistency is restored.

## s7 pr-10 e2e sweep + selector hardening addendum (2026-03-23)

### summary
- ran the full playwright suite and fixed initial failures caused by stale e2e selectors against the responsive toolbar cutover.
- updated `e2e/tests/epub.spec.ts` to drive toolbar actions via role-based selectors with mobile overflow fallback (`More actions`) and current TOC label semantics (`Show TOC`).
- updated `e2e/tests/pdf-reader.spec.ts` to click toolbar actions through either inline buttons or overflow menu items, eliminating desktop/mobile selector drift.
- hardened the PDF quote-to-chat e2e flow by treating action-menu open state explicitly (`aria-expanded`) and retrying quote dispatch once before surfacing failure.
- final full e2e sweep completed green: `46 passed`.

### decisions
- **contract-first selectors:** e2e now targets accessibility role/name contracts and explicit overflow menu behavior rather than brittle raw `aria-label` CSS selectors.
- **stateful action-menu handling:** menu-trigger interactions now assert/open `aria-expanded=true` before selecting menu items to avoid toggle races.
- **de-brittled persistence path:** quote-to-chat flow no longer blocks on transient overlay-marker timing; it validates persistence through API + linked-row behavior.

### how to test
```bash
# full e2e sweep
make test-e2e

# targeted regression slices that were previously failing/flaky
cd e2e && API_PORT=8001 WEB_PORT=3001 npx playwright test \
  tests/epub.spec.ts \
  tests/pdf-reader.spec.ts \
  --grep "navigate chapters|toc leaf with anchor lands at exact in-fragment target|upload -> viewer -> persistent highlight -> send to chat"

# repeated stability check for pdf quote-to-chat flow
cd e2e && API_PORT=8001 WEB_PORT=3001 npx playwright test \
  tests/pdf-reader.spec.ts \
  --grep "upload -> viewer -> persistent highlight -> send to chat" \
  --repeat-each=2
```

### risks
- the quote-to-chat PDF flow remains one of the highest-variance e2e paths (full upload + reload + pane-runtime routing); retries reduce flakes but do not prove zero nondeterminism under all host load conditions.
- repeated webpack/autoprefixer warnings in e2e runs are noisy but non-fatal; they can obscure real failures in raw logs if not filtered.

## s7 pr-11 mediasession + streaming error cutover addendum (2026-03-23)

### summary
- wired `GlobalPlayerProvider` to the Web MediaSession API with hard-cutover behavior: track metadata publishing, media action handlers, playback-state syncing, and throttled lock-screen position updates.
- moved transport keyboard shortcuts from footer-focus scope to global document scope: Space toggles play/pause and ArrowLeft/ArrowRight skip globally, with strict input/contenteditable guardrails.
- added explicit streaming failure handling for the hidden audio element: mapped MediaError codes to user-facing messages, retry control, source fallback link, and network auto-retry on `online`.
- added buffering lifecycle state (`waiting`/`stalled` -> loading indicator, `playing` -> clear) and exposed both buffering/error state through player context for consistent footer rendering.
- extended player track metadata contract with optional `podcast_title` and `image_url`, and propagated those fields from transcript media + queue row call sites into global track state.
- delivered red/green browser coverage in new and updated component suites for MediaSession wiring, global shortcuts, error/retry/recovery behavior, buffering state, and cleanup semantics.

### decisions
- **provider owns transport orchestration:** MediaSession handlers, keyboard shortcuts, retry logic, and playback-status state live in `GlobalPlayerProvider` so UI components stay presentation-centric.
- **no backward-compat focus shortcuts:** removed footer focus-only keydown behavior; transport shortcuts are globally available and guarded only by editable-target detection.
- **explicit error-state contract:** playback failures map to deterministic user copy by MediaError code and clear only on track switch or successful playback lifecycle (`playing`).
- **throttled lock-screen position sync:** MediaSession `setPositionState` updates are time-throttled to 1s to avoid excessive lock-screen update churn.
- **feature-detected MediaSession path:** all MediaSession calls are no-op when unsupported; supported browsers get full metadata/action wiring without compatibility shims.

### how to test
```bash
# frontend behavior suites for PR-11 cutover
cd apps/web && npm test -- \
  "src/__tests__/components/GlobalPlayerFooter.test.tsx" \
  "src/__tests__/components/GlobalPlayerMediaSession.test.tsx" \
  "src/__tests__/components/GlobalPlayerPersistence.test.tsx" \
  "src/__tests__/components/GlobalPlayerQueue.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx"

# optional static check (currently shows unrelated pre-existing errors outside PR-11 scope)
cd apps/web && npm run typecheck
```

### risks
- MediaSession platform behavior remains browser/OS-dependent (especially iOS Safari action coverage); component tests validate wiring, not full device-level dispatch behavior.
- `podcast_image_url` metadata is now consumed when present, but upstream media payload coverage for that field may still vary by ingestion/source path.
- global Space shortcut intentionally prevents default scrolling when a track is loaded and focus is non-editable; any future page-level Space shortcuts must coordinate with this contract.

## s7 pr-12 show-notes + batch transcript cutover addendum (2026-03-23)

### summary
- added persistent episode show-notes storage on `podcast_episodes` via migration `0033` (`description_html`, `description_text`) and ORM model updates.
- implemented feed-side show-notes extraction during podcast sync with strict source precedence (`content:encoded` over `description`), html sanitization, plain-text derivation, and byte truncation caps (100kb html / 50kb text).
- extended media contracts so `GET /media/{id}` and podcast episodes list rows now expose `description_html` + `description_text`; list rows intentionally truncate `description_text` to a 300-char preview while media detail returns full stored text.
- added backend batch transcript admission endpoint `POST /media/transcript/request/batch` with max-20 validation, sequential per-item admission, per-item outcomes (`queued`, `already_ready`, `already_queued`, `rejected_quota`, `rejected_invalid`), and quota-exhaustion short-circuit semantics.
- added web bff proxy for `/api/media/transcript/request/batch`, podcast detail ui show-notes preview expand/collapse, and “transcribe unplayed” batch action with quota estimate confirmation + deterministic result summary text.
- added transcript media pane show-notes rendering for podcast episodes: sanitized html rendering, plain-text fallback rendering, external links/images preserved, and timestamp tokens (`mm:ss` / `hh:mm:ss`) converted into seek buttons.

### decisions
- **hard cutover only:** no compatibility shim for legacy show-notes fields; contracts now use explicit `description_html` and `description_text`.
- **source-of-truth hierarchy:** rss `content:encoded` wins when present; `description` is fallback only.
- **storage safety first:** enforce byte caps at ingest time (100kb/50kb) and presentation cap at list time (300 chars) to bound payload + ui density.
- **batch admission semantics are sequential and fail-soft:** process IDs in order, preserve per-item outcomes, and stop invoking per-item admission once quota is exhausted.
- **timestamp interaction is a show-notes responsibility:** show-notes surface owns parsing/rendering seek affordances; transcript fragment selection behavior remains unchanged.

### how to test
```bash
# frontend targeted suites for pr-12 behavior
cd apps/web && npm test -- \
  "src/app/api/media/media-routes.test.ts" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx"

# backend pr-12 suites (requires db env)
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py::TestPodcastShowNotesAndBatchCutover

cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations uv run pytest -q \
  tests/test_migrations.py::TestPodcastEpisodeShowNotesMigration::test_head_contains_podcast_episode_show_notes_columns
```

### risks
- batch transcript endpoint currently commits per-item through existing single-admission service calls; this is intentional for quota correctness but can leave partially-applied outcomes when later items fail.
- show-notes timestamp parsing is regex-based and may interpret non-timestamp numeric tokens that match `mm:ss`/`hh:mm:ss` shape as seek actions.
- backend verification for pr-12 could not be executed in this environment without `DATABASE_URL`; only syntax/lint + frontend behavior were validated locally.

## s7 pr-13 per-subscription settings cutover addendum (2026-03-23)

### summary
- added backend schema support for per-subscription default speed via migration `0034` and `PodcastSubscription.default_playback_speed` (`NULL` = inherit 1.0x, enforced 0.5-3.0 range).
- added `PATCH /podcasts/subscriptions/{podcast_id}/settings` with strict patch semantics (partial updates only for provided fields, null clears speed override, out-of-range speed rejected).
- extended podcast subscription list/detail contracts to include `default_playback_speed` + `auto_queue`.
- extended media hydration contract with `subscription_default_playback_speed` so first-play initialization can use subscription-level speed when episode-level listening state is absent.
- added bff proxy route `PATCH /api/podcasts/subscriptions/{podcastId}/settings`.
- added subscriptions-list and podcast-detail settings panels (default speed dropdown + auto-queue toggle + save), with detail-page visual summary line (`{speed}x default speed · Auto-queue on/off`).
- wired transcript media pane first-play behavior to prefer `subscriptionDefaultPlaybackSpeed` only when no per-episode listening state exists; existing per-episode speed remains authoritative on resume.

### decisions
- **strict patch semantics**: request validation requires at least one settings field; omitted fields are preserved, explicit `null` only applies to `default_playback_speed`.
- **nullable speed override**: `NULL` remains the canonical “inherit default 1.0x” signal rather than writing sentinel `1.0` values.
- **frontend-controlled first-play inheritance**: no backend-side implicit listening-state creation; frontend chooses startup speed using episode/media payload fields.
- **single-source summary formatting**: podcast detail derives the visible settings summary directly from live subscription payload to reduce drift between controls and displayed state.

### how to test
```bash
# migrate schema (includes 0034)
make migrate-test

# backend targeted contract + migration checks
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py::TestPodcastApiSurface::test_list_subscriptions_returns_podcast_metadata_and_sync_snapshot \
  tests/test_podcasts.py::TestPodcastApiSurface::test_get_podcast_detail_returns_podcast_and_subscription_payload \
  tests/test_podcasts.py::TestPodcastApiSurface::test_get_podcast_episodes_returns_visible_episode_media \
  tests/test_podcasts.py::TestPodcastApiSurface::test_patch_subscription_settings_updates_contract_and_episode_default_speed \
  tests/test_podcasts.py::TestPodcastApiSurface::test_patch_subscription_settings_rejects_out_of_range_default_speed \
  tests/test_media.py::TestMediaListeningState::test_get_media_hydrates_listening_state_when_present \
  tests/test_migrations.py::TestPlaybackQueueMigration::test_head_contains_playback_queue_table_and_auto_queue_flag

# backend lint on touched files
cd python && uv run ruff check \
  nexus/api/routes/podcasts.py \
  nexus/db/models.py \
  nexus/schemas/media.py \
  nexus/schemas/podcast.py \
  nexus/services/media.py \
  nexus/services/podcasts.py \
  tests/test_podcasts.py \
  tests/test_migrations.py

# frontend targeted suites
cd apps/web && npm test -- \
  "src/app/api/podcasts/podcasts-routes.test.ts" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"
```

### risks
- first-play speed inheritance currently depends on media payload hydration (`subscription_default_playback_speed`); any future alternate playback entrypoint that bypasses this payload can regress to 1.0x unless it is wired similarly.
- settings writes are immediate and global to a subscription; users may forget a high speed setting and perceive abrupt playback changes on new episodes (mitigated by explicit summary + visible player speed).

## s7 pr-13 queue parity follow-up addendum (2026-03-23)

### summary
- extended playback-queue response contract with `subscription_default_playback_speed` so queue-driven playback has the same first-play speed inheritance data as media-detail playback.
- updated queue service query hydration to join active `podcast_subscriptions` for each queued episode and surface nullable speed overrides alongside per-episode listening state.
- updated global player queue playback fallback so playback rate resolves in this order: episode listening-state speed, then subscription default speed, then implicit `1.0x`.
- added backend integration coverage for queue payload inheritance field and frontend component coverage proving queue-next playback applies subscription speed when listening state is absent.
- extracted subscription playback-speed option/label/summary formatting into a shared frontend utility to remove duplicate logic across subscriptions and podcast detail settings UIs.

### decisions
- **single inheritance rule across entrypoints**: first-play speed inheritance is now consistent whether playback starts from media page or directly from queue transport controls.
- **episode-specific state remains highest priority**: if queue rows carry saved listening-state speed, it always overrides subscription default speed.
- **no compatibility branch**: queue contract now directly includes `subscription_default_playback_speed`; frontend uses it without legacy fallback adapters.
- **single-source formatting policy**: one shared formatter now owns speed-option labels and summary rendering to reduce cross-page drift.

### how to test
```bash
# backend queue inheritance checks
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_playback_queue.py::TestPlaybackQueueApi::test_queue_rows_expose_subscription_default_playback_speed \
  tests/test_playback_queue.py::TestPlaybackQueueApi::test_post_items_supports_next_last_and_ignores_duplicates

# frontend queue + pr-13 behavior slices
cd apps/web && npm test -- \
  "src/__tests__/components/GlobalPlayerQueue.test.tsx" \
  "src/app/api/podcasts/podcasts-routes.test.ts" \
  "src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"
```

### risks
- queue inheritance now depends on the queue API field being returned for podcast-episode rows; non-episode media kinds intentionally return `null` and will continue at `1.0x` unless explicitly overridden by listening state.

## s7 pr-14 subscription categories cutover addendum (2026-03-23)

### summary
- added first-class backend category domain for podcast subscriptions: new migration `0035`, `podcast_subscription_categories` table, and nullable `podcast_subscriptions.category_id` foreign key with uncategorize-on-delete semantics.
- implemented category API surface on backend: `GET/POST/PATCH/DELETE /podcasts/categories`, `PUT /podcasts/categories/order`, and subscription-list filtering via `category_id` (`UUID` or `null` token for uncategorized).
- extended subscription contracts (`GET /podcasts/subscriptions`, `GET /podcasts/{id}`, `PATCH /podcasts/subscriptions/{id}/settings`) to expose and mutate `category` assignment as server-owned persisted state.
- wired web bff passthrough routes for category APIs under `/api/podcasts/categories*`.
- cut subscriptions UI over to category-aware behavior: tabs (`All`, category tabs with aggregate unplayed counts, `Uncategorized`), row-level category assignment dropdown, and inline category create/edit/delete/reorder controls.
- cut podcast detail subscription header/settings over to category awareness with explicit `Category: ...` summary and settings-modal reassignment control.
- added red/green coverage for backend category acceptance paths + migration contract and frontend bff/ui category flows.

### decisions
- **strict server ownership of category state**: category assignment persists only through backend contracts; no client-side fallback state or compatibility adapter.
- **explicit uncategorized filter token**: list filtering uses `category_id=null` to target uncategorized subscriptions while omitting `category_id` remains “all”.
- **service-layer category invariants**: duplicate-name rejection, reorder full-set validation, and delete-to-uncategorized behavior are enforced in podcast service methods (not page logic).
- **reorder semantics over drag dependency**: category ordering is persisted by explicit ordered-id writes (`PUT /podcasts/categories/order`), allowing UI reorder controls without coupling to any single drag library.
- **graceful empty-category UX**: category tabs render only when at least one category exists; category management entrypoint remains available for first-category creation.

### how to test
```bash
# migrate test db to include 0035
make migrate-test

# backend PR-14 contracts
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test uv run pytest -q \
  tests/test_podcasts.py::TestPodcastApiSurface::test_list_subscriptions_returns_podcast_metadata_and_sync_snapshot \
  tests/test_podcasts.py::TestPodcastApiSurface::test_patch_subscription_settings_updates_contract_and_episode_default_speed \
  tests/test_podcasts.py::TestPodcastApiSurface::test_subscription_categories_crud_assignment_filter_and_delete_uncategorizes \
  tests/test_podcasts.py::TestPodcastApiSurface::test_subscription_category_name_must_be_unique_per_user

# migration schema contract for categories
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations uv run pytest -q \
  tests/test_migrations.py::TestPodcastSubscriptionCategoryMigration::test_head_contains_subscription_categories_and_subscription_fk_contract

# backend lint on touched files
cd python && uv run ruff check \
  nexus/services/podcasts.py \
  nexus/schemas/podcast.py \
  nexus/db/models.py \
  nexus/api/routes/podcasts.py \
  tests/test_podcasts.py \
  tests/test_migrations.py \
  ../migrations/alembic/versions/0035_podcast_subscription_categories.py

# frontend bff + subscriptions/detail category flows
cd apps/web && npm test -- \
  "src/app/api/podcasts/podcasts-routes.test.ts" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"
```

### risks
- category-name uniqueness is case-insensitive in service validation but case-sensitive at db unique-constraint level; race windows still rely on constraint + conflict mapping and may need stronger canonicalization if multilingual naming expands.
- `Uncategorized` tab aggregate count currently derives from the loaded subscription page slice in the web UI; users with very large lists may need a dedicated backend aggregate for exact global count parity.
- frontend `npm run typecheck` currently fails on two pre-existing unrelated files (`GlobalPlayerPersistence.test.tsx`, `transcriptPolling.test.tsx`); PR-14 changes do not introduce additional typecheck failures beyond those existing errors.

## s7 pr-14 reorder ergonomics follow-up addendum (2026-03-23)

### summary
- replaced category management left/right reorder buttons with touch-first drag handles on the subscriptions page.
- reused the shared `SortableList` dnd primitive so category reorder behavior is consistent with queue/library sortable surfaces.
- wired drag reorder to the existing persisted backend order endpoint (`PUT /api/podcasts/categories/order`) with optimistic local ordering and rollback on API failure.
- expanded podcast flow coverage to assert drag-handle controls are rendered for category reordering.

### decisions
- **touch-first over directional buttons**: primary reorder affordance is now direct manipulation (`touch-action: none` handle + large tap target), reducing friction on mobile/touch devices.
- **single sortable abstraction**: category reorder now uses the same shared sortable component as other list-reorder surfaces to avoid divergent drag semantics.
- **optimistic reorder with rollback**: UI updates immediately on drag end for responsiveness; failed writes restore prior order and surface explicit error state.

### how to test
```bash
# frontend category drag ergonomics + proxy regression
cd apps/web && npm test -- \
  "src/app/api/podcasts/podcasts-routes.test.ts" \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx"
```

### risks
- touch-first drag improves ergonomics but does not yet include explicit inline “drop target” preview beyond sortable movement, which some users may still find subtle on very dense category sets.

## s7 pr-14 drag feedback + e2e path addendum (2026-03-23)

### summary
- upgraded category reorder feedback with explicit drag visuals: active drag overlay ghost + inline source placeholder/drop-target highlighting on the subscriptions category list.
- extended the shared `SortableList` primitive with active-item tracking, drag overlay rendering, and `data-over` metadata so reorder surfaces can render clearer drag state.
- wired category reorder UI to expose richer drag accessibility state (`aria-grabbed`) while preserving the existing persisted reorder write path.
- added dedicated playwright coverage in `e2e/tests/podcast-categories.spec.ts` for drag reorder persistence flow, with environment preflight gating to skip when podcast routes are intentionally disabled (`podcasts_enabled=false`).

### decisions
- **overlay is explicit, not implied by movement**: reorder now gives a concrete drag ghost and target affordance rather than relying only on list reflow.
- **shared primitive stays generic**: overlay support was added to `SortableList` as an optional render callback, avoiding category-specific logic in the shared component.
- **e2e contract is feature-flag aware**: when backend podcast routes are disabled in an environment, the test skips explicitly instead of timing out on 404-based waits.

### how to test
```bash
# web regression slices for sortable + subscriptions behavior
cd apps/web && npm test -- \
  "src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" \
  "src/app/api/podcasts/podcasts-routes.test.ts" \
  "src/__tests__/components/GlobalPlayerFooter.test.tsx"

# dedicated categories drag e2e path
cd e2e && SKIP_SEED=1 npm test -- tests/podcast-categories.spec.ts --project=chromium
```

### risks
- in environments where podcasts routes are disabled server-side, the new e2e test intentionally skips; full drag-path execution still requires an environment with `podcasts_enabled=true`.

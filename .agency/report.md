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

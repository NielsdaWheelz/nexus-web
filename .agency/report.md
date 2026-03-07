# podcast-feature-implementation

## summary
- implemented the approved podcasts roadmap across backend, bff, frontend ux, global player, and transcription lifecycle using red/green tdd cycles
- added async podcast transcription job lifecycle (`pending`/`running`/`completed`/`failed`) with idempotent claim semantics and manual retry support for both `podcast_episode` and `video` media
- hardened operability and setup safety:
  - migration `0021` downgrade now normalizes `running -> pending` before restoring older constraints
  - stale ingest reconciler now includes `podcast_episode` recovery dispatch
  - podcast transcription task now defends against malformed UUID payloads
  - `make setup` generated `.env` now sets `PODCASTS_ENABLED=false` by default unless credentials are added
  - env/docs alignment now covers `SUPABASE_SERVICE_KEY` vs `SUPABASE_SERVICE_ROLE_KEY`

## decisions
- kept subscription sync as control/data-plane split: sync creates media + job records and enqueues transcription; worker executes transcription independently
- centralized transcript retry routing under `retry_for_viewer_unified`, then dispatched by media kind (pdf/epub vs podcast/video) to keep one public retry endpoint contract
- made retry idempotency explicit at service level:
  - retry on `extracting` returns accepted/no-op (`retry_enqueued=false`)
  - worker only claims jobs in `pending` or `failed`; completed/running claims skip
- preserved fail-closed posture when enqueue fails: media remains/returns failed with explicit internal error code instead of silently pretending work is queued
- hardened frontend navigation and accessibility in touched flows:
  - internal podcasts navigation uses `next/link` (lint-safe)
  - external open-source links use `noopener noreferrer`
  - transcript segment active state now exposes `aria-current`

## how to test
1. run podcast backend integration suite:
   - `./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_podcasts.py"`
2. run stale-ingest + task-guard regression coverage:
   - `./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_reconcile_stale_ingest_media.py tests/test_podcast_transcribe_episode_task.py"`
3. run media retry regression coverage:
   - `./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_media.py -k retry"`
4. run config validation suite:
   - `./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_config.py"`
5. run migration suite:
   - `./scripts/with_test_services.sh bash -lc "cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:${DATABASE_PORT:-5434}/nexus_test_migrations NEXUS_ENV=test uv run pytest -v tests/test_migrations.py"`
6. run frontend touched-surface checks:
   - `cd apps/web && npm run test -- \"src/app/api/podcasts/podcasts-routes.test.ts\" \"src/app/(authenticated)/podcasts/podcasts-flows.test.tsx\" \"src/__tests__/components/GlobalPlayerFooter.test.tsx\" \"src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx\"`
   - `cd apps/web && npm run lint && npm run typecheck && npm run build`
7. manual cli verification (performed):
   - migration downgrade probe with a seeded `running` row confirms `manual_migration_status=pending` after downgrade+upgrade
   - stale reconcile probe with a stale `podcast_episode` confirms `requeued=1` and dispatch invocation

## risks
- retry dispatch still depends on celery broker health; enqueue failures are explicit and recoverable, but user-facing retry UX should surface broker outages clearly in frontend
- transcript worker currently commits claim/status transitions in multiple phases for robustness; if future refactors collapse this into one transaction, idempotency/race guarantees can regress
- this slice validates backend behavior strongly; end-to-end browser verification of podcast retry UX messaging and player-state edge cases should still be run before release

# podcast-transcript-metadata-first-refactor

## summary
- refactored podcast subscription ingest to metadata-first: sync no longer spends transcript quota or auto-enqueues transcription jobs
- added explicit transcript admission endpoint `POST /media/{media_id}/transcript/request` with dry-run budget forecast, quota-fit evaluation, and enqueue behavior
- updated transcript quota accounting to use an atomic reservation-style upsert path for explicit requests
- updated transcript media capability derivation so playback remains usable for metadata-only/pending podcast episodes
- hardened transcript admission by persisting `request_reason` on `podcast_transcription_jobs` and validating API response shape against the declared schema
- added idempotency guard for duplicate requests while a transcript job is already queued/running
- converted legacy integration tests to explicit-demand behavior while preserving async lifecycle coverage

## decisions
- **control plane / transcript plane split**: `_sync_subscription_ingest` now only creates metadata + library attachment (`processing_status='pending'`) and never creates `podcast_transcription_jobs`
- **admission API**: transcript requests now require explicit reason (`episode_open`, `search`, `highlight`, `quote`, `background_warming`, `operator_requeue`) and support `dry_run` for budget forecasting
- **quota reservation semantics**: explicit requests reserve minutes via atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` logic; over-budget requests fail with `E_PODCAST_QUOTA_EXCEEDED`
- **enqueue failure handling**: failed dispatch refunds reserved minutes and marks the media/job as failed with deterministic internal error state
- **playback fallback**: transcript media with playback URLs are now playable regardless of transcript readiness, avoiding false "processing-only" UX for metadata-first episodes
- **reason auditability**: transcript job rows now persist the admission reason via `request_reason` (new migration `0023`)

## how to test
```bash
# podcast backend integration coverage
./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_podcasts.py -q"

# capabilities unit coverage
./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_capabilities.py -q"

# podcast/capability/search regression slice
./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_podcasts.py tests/test_capabilities.py tests/test_search.py -q"

# backend lint + format
cd python && uv run ruff check nexus tests && uv run ruff format --check nexus tests

# frontend type + build compile
cd apps/web && npx tsc --noEmit
cd apps/web && npm run build
```

## risks
- transcript readiness is still represented through `processing_status` (`pending` as metadata-not-requested) rather than dedicated `transcript_state` + `coverage` enums
- refund coverage currently handles enqueue failure path; provider-failure/stale-job reclaim automation is still follow-up work
- re-transcription still rewrites transcript fragment substrate in place; versioned transcript artifacts/anchors are still pending
- semantic transcript search (chunking + embeddings + readiness gating) and background warming policy are still not implemented

# ingest fetch hardening review

## summary
- completed a full staff-level review/hardening pass for web-article ingest after the Playwright -> native fetch migration
- hardened `node/ingest/ingest.mjs` with bounded response-size reads, charset-fallback robustness, URL/timeout input validation, and explicit no-JS-render limitation docs
- aligned runtime/docs/ops surfaces (`README`, `CONTRIBUTING`, worker docs, setup script, CI, S2 spec) and fixed a real worker image build blocker in `docker/Dockerfile.worker` (missing `python/README.md` during `uv sync`)
- added/updated targeted ingest tests and verified with hermetic backend test runs, lint, typecheck, frontend build, celery-contract verification, CLI smoke, and worker Docker build

## decisions
- **fetch-only ingestion remains the contract**: no browser rendering; JS-hydrated SPAs are explicitly documented as out-of-scope for this pipeline
- **safety limit**: enforce `MAX_BODY_BYTES = 10 MiB` in Node ingest to prevent unbounded memory use on malicious/oversized responses
- **charset strategy**: resolve charset from `Content-Type`, then `<meta>`, then UTF-8 fallback; unsupported charset labels degrade gracefully
- **input validation**: reject non-HTTP(S) URLs and invalid/unsafe timeout values before network work begins
- **ops consistency**: remove stale ingest-Playwright install steps from setup/CI and update worker docs/concurrency guidance to match fetch-based runtime

## acceptance criteria check
- [x] ingest runtime no longer requires Playwright/Chromium and still extracts readable content
- [x] redirect, timeout, HTTP failure, and charset edge-paths covered by tests
- [x] docs/setup/CI instructions no longer contradict runtime behavior
- [x] worker container build succeeds with current Dockerfile

## how to test
```bash
# targeted backend ingest tests (hermetic postgres + redis)
./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_node_ingest.py tests/test_ingest_web_article.py -q --tb=short"

# backend lint for touched ingest files
cd python && uv run ruff check nexus/services/node_ingest.py nexus/tasks/ingest_web_article.py tests/test_node_ingest.py tests/test_ingest_web_article.py tests/test_web_article_highlight_e2e.py

# frontend compile gates
make typecheck && make build

# celery contract preflight
make verify-celery-contract

# manual CLI smoke
printf '{"url":"https://example.com","timeout_ms":15000}\n' | node node/ingest/ingest.mjs

# worker image build
docker build -f docker/Dockerfile.worker -t nexus-worker:pr-review .
```

## risks
- client-rendered SPA pages remain a known ingest gap (no JS execution by design)
- 10 MiB response cap can reject extremely long articles; this is intentional safety trade-off
- frontend build emits pre-existing test-file lint warnings unrelated to this PR; no new errors introduced

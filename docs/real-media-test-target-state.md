# Real-Media Test Target State

## Scope

This document owns the deterministic real-media acceptance contract for
`make test-real-media` and `make seed-real-media-e2e`.

## Contract

- Supabase is used only for Auth during real-media tests.
- App data is stored in the test Postgres service started by
  `scripts/with_test_services.sh`.
- Object data is stored through the R2-compatible storage client; local tests use
  MinIO from `docker/docker-compose.test.yml`.
- Local real-media commands refuse non-local R2/MinIO endpoints unless
  `REAL_MEDIA_ALLOW_NON_LOCAL_STORAGE=1` is set explicitly.
- The E2E user is created by `e2e/seed-e2e-user.ts` and looked up through the
  Supabase Auth admin API.
- Seed scripts must not query Supabase internal schemas through `DATABASE_URL`.
- Real-media fixtures must enter through app upload, capture, URL, ingest,
  transcript, and indexing paths.
- `e2e/.seed/real-media.json` contains only ids, fixture SHA-256 hashes, and
  short expected search/text needles needed by Playwright.
- Upload acceptance uses non-seeded PDF/EPUB fixture files so it proves fresh
  upload creation, ingest queue dispatch, worker processing, and ready media
  instead of deduping to preseeded media.
- PDF evidence acceptance requires visible projected geometry for text PDFs;
  `no_geometry` is reserved for fixtures that explicitly cannot provide
  projection.

## Local Commands

```bash
make seed-real-media-e2e
make test-real-media
```

Both commands start Supabase Auth plus isolated Postgres and MinIO wrappers.
Because those app-data services are ephemeral, the Make targets remove
`e2e/.seed/real-media.json` before exit instead of leaving stale media ids for a
stopped database or object store.

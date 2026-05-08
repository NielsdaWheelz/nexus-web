# Real-Media Test Target State

## Role

This document owns the deterministic real-media acceptance contract.

`make test-real-media` proves that real uploaded/captured/readable media works
through the product stack: ingest, indexing, search evidence, reader navigation,
highlight projection, scoped chat attachment, and cleanup.

## Contract

- Tests use real app services: Next.js, FastAPI, PostgreSQL, Supabase local, and
  browser Playwright.
- Media fixtures are real artifacts with pinned byte length and SHA-256.
- External LLM chat completion is replaced only at the provider boundary by the
  real-media fixture router used by the chat worker.
- The FastAPI app global LLM router stays real so key validation and unrelated
  API routes do not accept fixture responses.
- Playwright specs drain queued jobs through the real Postgres worker loop, not
  by calling task handlers directly.
- OpenAI embeddings are real for `make test-real-media` seeding.
- Provider fixture mode requires `REAL_MEDIA_PROVIDER_FIXTURES=1` and
  `REAL_MEDIA_FIXTURE_DIR`.
- The seed script is idempotent and records fixture IDs, hashes, and provider
  fixture metadata in `e2e/.seed/real-media.json`.

## Acceptance Gates

- Backend real-media tests assert API-visible behavior and database-backed
  service outcomes through supported interfaces.
- Playwright real-media specs assert user-visible browser behavior: search
  results, reader navigation, evidence highlights, saved highlights, scoped
  chat, reingest/delete permissions, and trace output.
- Specs clean up created highlights and documents, and cleanup failures report
  HTTP status/body without hiding the product assertion.
- Generated traces are diagnostic artifacts, not assertions.

## Non-Goals

- Do not use provider fixtures for live-provider acceptance.
- Do not use fixture LLM routing for `/api/keys/*` validation or unrelated API
  routes.
- Do not add test-only UI paths, feature flags, or lab-only fallbacks.

# Tech Stack

## Scope

This document covers the top-level runtime and tooling stack.

## Stack

- Web app: Next.js (React), TypeScript, Vitest.
- Android shell: Kotlin, Android SDK, WebView, Custom Tabs.
- Backend: FastAPI, Python, SQLAlchemy, Pydantic, pytest.
- Database: PostgreSQL with pgvector (standalone Docker Postgres for local dev/test, Hetzner Postgres in production).
- Auth: Supabase Auth (JWKS token verification).
- Object storage: Cloudflare R2 in production, MinIO for local dev/test through the R2-compatible client path.
- Build and package tooling: bun (web and e2e), uv (backend), Gradle (android).

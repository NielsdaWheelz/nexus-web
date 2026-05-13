# Codebase

## Scope

This document covers repository-wide code organization, imports, and module boundary rules.

## Structure

- `apps/` — top-level runnable app surfaces.
- `apps/android/` — Android shell app.
- `apps/api/` — FastAPI ASGI entrypoint.
- `apps/extension/` — browser extension.
- `apps/web/` — Next.js frontend and BFF.
- `apps/worker/` — worker entrypoint.
- `python/` — backend package and Python tests.
- `migrations/` — Alembic migrations.
- `supabase/` — Supabase local configuration.
- `e2e/` — Playwright end-to-end tests.

## Imports

- Relative imports may go up at most two levels.
- If a relative import would go deeper, use an alias (`@/` in TypeScript) or a package import (Python, Kotlin).
- Do not re-export symbols from other modules. Import each symbol from its defining module.

## Module Boundaries

- A module is any directory.
- External functionality may be consumed by any module.
- Internal functionality is only for a module and its submodules.
- Default to internal unless functionality is clearly external.

# Codebase

## Scope

This document covers repository-wide code organization, imports, and module boundary rules.

## Structure

- `apps/web/` — Next.js frontend (TypeScript, React).
- `python/` — FastAPI backend (Python).
- `python/nexus/` — Backend application code.
- `python/tests/` — Backend tests.
- `supabase/` — Supabase configuration and migrations.
- `e2e/` — Playwright end-to-end tests.

## Imports

- Relative imports may go up at most two levels.
- If a relative import would go deeper, use an alias (`@/` in TypeScript, package-level in Python).
- Do not re-export symbols from other modules. Import each symbol from its defining module.

## Module Boundaries

- A module is any directory.
- External functionality may be consumed by any module.
- Internal functionality is only for a module and its submodules.
- Default to internal unless functionality is clearly external.

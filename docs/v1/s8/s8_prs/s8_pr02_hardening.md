# PR-02 Hardening Addendum: Catalog Aggregation + Reader Side-Pane Consistency

## Why this addendum exists

PR-02 established transcript-first media UX in the shared `/media/[id]` workspace.  
This hardening pass closes two operational gaps discovered during implementation review:

1. category catalog pages were still doing client-side per-library fanout (`N+1` request pattern)
2. `/media/[id]` highlights side-pane controls were not yet aligned to the shared UI primitives used elsewhere

## Backend changes

### New endpoint: `GET /media`

Server-side aggregated listing of viewer-visible media across all provenance paths.

- visibility model: reuses canonical S4 media visibility SQL
- filters:
  - `kind` (comma-separated list of `web_article|epub|pdf|video|podcast_episode`)
  - `search` (title substring match)
- pagination:
  - keyset cursor (`updated_at DESC, id DESC`)
  - query params: `limit`, `cursor`
  - response: `{ data: MediaOut[], page: { next_cursor } }`

### Defensive behavior

- invalid cursor -> `E_INVALID_CURSOR` (400)
- invalid kind filter -> `E_INVALID_REQUEST` (400)
- search wildcard metacharacters (`%`, `_`, `\`) are escaped before `ILIKE` matching
- status values from SQL rows are normalized before capability derivation and response serialization

## Frontend changes

### BFF

- added `GET /api/media` proxy route to `/media`

### Catalog pages

- `MediaCatalogPage` now consumes `/api/media` directly
- removed client fanout over `/api/libraries/{id}/media`
- retained local text filter UI
- added load-more pagination using server `next_cursor`

### Reader side-pane consistency (`/media/[id]`)

- scope controls moved into shared `SectionCard`
- book-mode controls moved into shared `SectionCard`
- no-selection state migrated to `StateMessage`
- PDF active-page hint migrated to `StatusPill`
- linked-items empty state migrated to `StateMessage`

## Accessibility hardening

- catalog filter input now has explicit `aria-label`
- EPUB scope toggle buttons now expose `aria-pressed` and grouped labeling
- quote-to-chat action is keyboard-reachable (not hover-only)
- global focus-visible outline added for interactive elements
- legacy `.sr-only` clipping updated to `clip-path: inset(50%)`

## Validation performed

- targeted web checks:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test -- src/app/api/media/media-routes.test.ts src/app/api/podcasts/podcasts-routes.test.ts src/__tests__/components/Navbar.test.tsx src/__tests__/components/LinkedItemsPane.test.tsx`
- targeted backend checks:
  - `DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/postgres pytest tests/test_media_list.py`
  - `python -m py_compile nexus/services/media.py nexus/api/routes/media.py tests/test_media_list.py`
- full gates:
  - `make verify` (pass)
  - `make e2e` (pass)

## Follow-up recommendations

- extract shared visibility CTE helpers into a dedicated module to remove service-to-service import coupling
- add unit tests for `MediaCatalogPage` load-more behavior and `kind` parsing edge cases
- continue migrating remaining reader-internal controls to shared primitives where behavior risk is low

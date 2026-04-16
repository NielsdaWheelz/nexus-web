# Nexus Frontend

Next.js application that serves the UI and BFF routes for Nexus.

## Scope

This app owns:

- Browser UI and workspace shell
- Next.js `/api/*` BFF proxy routes
- Session-aware request forwarding to FastAPI
- Stream token flow for direct SSE to FastAPI
- Browser extension capture routes for article, PDF/EPUB, and supported video ingestion

## Request Topology

- Default: Browser -> Next.js (`/api/*`) -> FastAPI.
- Streaming: Browser -> FastAPI `/stream/*` with short-lived stream token minted via BFF.
- Extension capture: Browser extension -> Next.js `/api/media/capture/*` -> FastAPI with scoped, revocable extension auth.

BFF routes are transport-only. Business logic lives in FastAPI services.

## Local Development

From repo root:

```bash
make web
```

Or from this directory:

```bash
bun install
bun run dev
```

Prerequisites:

- `make dev` (Supabase local)
- `make api` (FastAPI)

## Environment

Primary variables for this app:

- `FASTAPI_BASE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `AUTH_ALLOWED_REDIRECT_ORIGINS`
- `NEXUS_EXTENSION_REDIRECT_ORIGINS`
- `NEXUS_INTERNAL_SECRET` (required outside local/test)
- `NEXT_PUBLIC_ENABLE_STREAMING` (optional)

`make setup` writes `apps/web/.env.local` for local development.
Full variable definitions live in root `.env.example`.

## Directory Map

- `src/app/` -> pages and BFF route handlers
- `src/components/` -> UI components
- `src/lib/api/proxy.ts` -> BFF forwarding logic
- `src/lib/panes/` + `src/lib/workspace/` -> pane/workspace state and routing
- `src/lib/highlights/` -> highlight rendering and selection utilities

## Guardrails

- Browser does not hold access tokens in `localStorage`/`sessionStorage`.
- Route handlers should stay thin and delegate to backend endpoints.
- Extension capture must use a scoped, revocable token and must not reuse the standard app session cookie flow.
- Extension BFF routes must stay transport-only; article parsing, file validation, URL classification, and lifecycle dispatch belong to FastAPI.
- Only `HtmlRenderer` may use `dangerouslySetInnerHTML`.

Repository-wide rule owners:

- `docs/rules/layers.md`
- `docs/rules/codebase.md`
- `docs/rules/errors.md`

## Testing

From repo root:

```bash
make test-front-unit
make test-front-browser
make test-e2e
```

From `apps/web/`:

```bash
bun run test:unit
bun run test:browser
bun run typecheck
bun run lint
```

## Highlight Libraries

Reference map for highlight internals used in code comments:

- `src/lib/highlights/canonicalCursor.ts`
- `src/lib/highlights/applySegments.ts`
- `src/lib/highlights/selectionToOffsets.ts`

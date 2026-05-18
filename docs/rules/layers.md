# Layers

## Scope

This document covers the architectural layers and their responsibilities.

## Architecture

- **Next.js middleware**: network-free session-cookie classification, auth gating, CSP headers. Performs no network I/O and no token refresh; redirects `refreshable` navigations to `/auth/refresh`.
- **Android shell**: host the configured Nexus web origin in `WebView`; route off-origin navigation to Custom Tabs.
- **Next.js API routes (BFF)**: proxy requests to FastAPI with bearer tokens. No business logic.
- **FastAPI middleware**: JWT verification, request ID, viewer injection.
- **FastAPI route handlers**: validate input, call services, return response envelopes.
- **Services** (`python/nexus/services/`): business logic. No HTTP or framework types.
- **Models** (`python/nexus/db/models.py`): SQLAlchemy table definitions.

## Rules

- Service dependencies must be explicit (function parameters, not globals).
- Services must not import from route handlers or middleware.
- Route handlers must not contain business logic beyond input validation and response shaping.
- BFF proxy routes must not contain business logic. They forward requests and attach auth.
- Client-side product data calls use `/api/*` routes only. They never call
  FastAPI directly except streaming SSE.
- OAuth is initiated server-side via a server route or server action. There is no
  browser Supabase client; the browser holds no tokens.
- Android shell code does not call FastAPI, Supabase, or product APIs directly.

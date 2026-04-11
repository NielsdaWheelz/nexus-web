# Layers

## Scope

This document covers the architectural layers and their responsibilities.

## Architecture

- **Next.js middleware**: session refresh, auth gating, CSP headers.
- **Next.js API routes (BFF)**: proxy requests to FastAPI with bearer tokens. No business logic.
- **FastAPI middleware**: JWT verification, request ID, viewer injection.
- **FastAPI route handlers**: validate input, call services, return response envelopes.
- **Services** (`python/nexus/services/`): business logic. No HTTP or framework types.
- **Models** (`python/nexus/models/`): SQLAlchemy table definitions.

## Rules

- Service dependencies must be explicit (function parameters, not globals).
- Services must not import from route handlers or middleware.
- Route handlers must not contain business logic beyond input validation and response shaping.
- BFF proxy routes must not contain business logic. They forward requests and attach auth.
- Client-side code calls `/api/*` routes only. It never calls FastAPI directly (except streaming SSE).

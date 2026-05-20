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
- `apps/android/app/src/main/java/.../GoogleSignInController.kt` owns native
  Google sign-in via the Android Credential Manager: generates the OIDC nonce
  and the handoff verifier, calls `getCredential`, posts the Google ID token
  to `/auth/native/google`, and loads the WebView at `/auth/handoff` with the
  verifier.
- `apps/android/app/src/main/java/.../MainActivity.kt` owns Android shell
  mechanics: owned-origin routing, external routing, file chooser handoff,
  popup handoff, app-link intent handling, and OAuth Custom Tab orchestration
  and `nexus://auth/handoff` deep-link intake.
- `apps/android/app/src/main/java/.../NexusWebView.kt` owns the WebView
  configuration shared by MainActivity and ShareActivity.
- `apps/android/app/src/main/java/.../ShareActivity.kt` owns the
  system-share-sheet capture entry: the `ACTION_SEND` intent filter and the
  `nexus-share://` scheme it intercepts to hand off to MainActivity.
- Android manifests own Android framework entrypoints and deep-link filters.
- Android Gradle files own Android build, signing, app-link, and release
  configuration.
- Android code must not add product API clients, Supabase clients,
  OAuth/PKCE exchange logic, upload clients, or JavaScript bridges without
  updating this rule first. The single auth-bootstrap `POST /auth/native/google`
  from `GoogleSignInController` is authorized; the OAuth/PKCE exchange itself
  stays server-side.

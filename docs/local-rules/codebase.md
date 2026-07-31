# Codebase

## Scope

Nexus-web repository structure, module ownership, and import specifics. This
complements the shared, language-agnostic rules in
[../rules/codebase.md](../rules/codebase.md), which owns the generic
technology-ownership, import, and module-boundary model.

## Structure

- `apps/` — top-level runnable app surfaces.
- `apps/android/` — Android shell app.
- `apps/api/` — FastAPI ASGI entrypoint.
- `apps/extension/` — browser extension.
- `apps/web/` — Next.js frontend/BFF and the sole Playwright package under
  `apps/web/e2e/`.
- `apps/worker/` — worker entrypoint.
- `python/` — backend package, typed test control plane, and Python proofs.
- `migrations/` — Alembic migrations.
- `supabase/` — Supabase local configuration.
- `testdata/` — cross-language corpus, priority-proof registry, faults, and
  policy exceptions.

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
- `apps/android/app/src/main/java/.../playback/NexusPlaybackService.kt` owns the
  Android Media3 player, Media Session, native Consumption recording, and
  player notification lifecycle.
- `apps/android/app/src/main/java/.../playback/NexusPlayerBridge.kt` owns the
  exact, main-frame, owned-origin `nexusPlayer` WebKit protocol and adapts it to
  the service-owned MediaController.
- `apps/android/app/src/main/java/.../playback/NexusOriginClient.kt` is the
  single authorized native product API client. It may call only its fixed
  listening-state and Consumption-activity BFF paths with WebView cookies and
  the exact owned Origin; it accepts no arbitrary URL, path, headers, or
  credentials.
- `apps/android/app/src/main/java/.../ShareActivity.kt` owns the
  system-share-sheet capture entry: the `ACTION_SEND` intent filter and the
  `nexus-share://` scheme it intercepts to hand off to MainActivity.
- Android manifests own Android framework entrypoints and deep-link filters.
- Android Gradle files own Android build, signing, app-link, and release
  configuration.
- Android has exactly four authorized native boundaries:
  `GoogleSignInController` may make the auth-bootstrap
  `POST /auth/native/google`; `NexusOriginClient` may call only its fixed
  listening-state and Consumption-activity paths; and AndroidX WebKit may
  expose the exact-main-frame, exact-owned-origin `nexusOfflineMedia` and
  `nexusPlayer` listeners. Android code must not add other product or Supabase
  clients, OAuth/PKCE exchange logic, upload clients,
  `addJavascriptInterface`, or generic bridges. OAuth/PKCE exchange remains
  server-side.
- Password identities are managed via Supabase Auth's `auth.identities` table;
  the application stores no password material. Password-auth Server Actions
  live in `apps/web/src/lib/auth/password-actions.ts`.

## Environment

- The environment-variable contract required by
  [../rules/codebase.md](../rules/codebase.md) is `.env.example`.

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
- `apps/extension/` — Firefox capture extension package (manifest and icons; sources live in `apps/web/src/extension/`).
- `apps/web/` — Next.js frontend/BFF.
- `apps/worker/` — worker entrypoint.
- `python/` — backend package.
- `migrations/` — Alembic migrations.
- `supabase/` — Supabase local configuration.

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
- `apps/android/app/src/main/java/.../NexusOriginClient.kt` is the one
  authorized native product API client, shared by the player and offline. It
  may call only its fixed listening-state, Consumption-activity, `me`,
  stream-token and reader-state BFF paths with WebView cookies and the exact
  owned Origin; it accepts no arbitrary URL, path, headers, or credentials.
- `apps/android/app/src/main/java/.../offline/` owns offline
  ([module](../modules/offline.md)): the store, the transfer and sync jobs, the
  `nexusOffline` bridge and the shelf router. Its only direct calls are the
  episode's https enclosure and `/stream/media/{id}/reading-copy` at the
  `stream_base_url` a stream token names; it accepts no renderer-supplied URL,
  path, headers, credentials, or filesystem location.
- `apps/android/app/src/main/java/.../ShareActivity.kt` owns the
  system-share-sheet capture entry: the `ACTION_SEND` intent filter and the
  `nexus-share://` scheme it intercepts to hand off to MainActivity.
- Android manifests own Android framework entrypoints and deep-link filters.
- Android Gradle files own Android build, signing, app-link, and release
  configuration.
- Android has exactly five authorized native boundaries:
  `GoogleSignInController` may make the auth-bootstrap
  `POST /auth/native/google`; `NexusOriginClient` may call only its fixed
  paths above; offline may make only the two direct calls above; and AndroidX
  WebKit may expose the main-frame `nexusPlayer` listener on the owned origin
  and the main-frame `nexusOffline` listener on the owned and shelf origins.
  Android code must not add other product or Supabase clients, OAuth/PKCE
  exchange logic, upload clients, `addJavascriptInterface`, or generic bridges.
  OAuth/PKCE exchange remains server-side.
- Supabase Auth alone owns password hashes, invitation and recovery tokens, and
  sessions. `auth.identities` describes linked provider identities and MUST NOT
  be used to infer password presence. Nexus stores no password, invitation, or
  password-presence state.

## Environment

- The environment-variable contract required by
  [../rules/codebase.md](../rules/codebase.md) is `.env.example`.

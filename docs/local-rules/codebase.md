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
- `supabase/` — canonical local auth policy and templates.
- `scripts/lab`, `python/scripts/disposable_runtime.py` — disposable runtime owner;
  provisioning, private driver context, readiness, diagnostics and scoped teardown.
- `python/scripts/local_storage.py` — shared local bucket/cors provisioning.
- `python/scripts/lab_auth_cleanup.py` — exact-project Supabase teardown for the
  lab and its recorded recovery command, without daemon-wide prune operations.
- `python/scripts/worker_checkout_image.py` — dependency-hash worker images,
  host cache locking, real container creation and reference-aware tag retention.
- `apps/web/scripts/lab/` — real browser authentication and temporary-case configuration.

## web production build

`apps/web/package.json` owns `bun run build`: `build:next` removes generated
`.next`, copies pdf.js assets and builds next; `scripts/package-standalone.mjs`
packages public and static assets with `.next/standalone/serve.mjs`, replacing
Next's generated HTTP/1 entrypoint. the canonical server requires a certificate
and key and serves TLS with HTTP/2 only on `PORT`/`HOSTNAME`; Next binds a private
kernel-assigned loopback port. `probe-web.mjs` verifies `/version` over HTTP/2
with an explicit CA. streams retain their existing application API and lifetime.
`make web` builds and starts this package; development uses build/restart.
Vercel owns its managed frontend TLS edge and uses `build:next`. production
builds start without the previous `.next` cache so installed dependency patches
reach the generated bundles. each build pays the full compilation cost.
the lab reuses a completed package under its documented source/slot/public-key
contract and copies a private writable runtime; it uses this same production
build and packaging command.

## Imports

- Relative imports may go up at most two levels.
- If a relative import would go deeper, use an alias (`@/` in TypeScript) or a package import (Python, Kotlin).
- Do not re-export symbols from other modules. Import each symbol from its defining module.

## Module Boundaries

- A module is any directory.
- External functionality may be consumed by any module.
- Internal functionality is only for a module and its submodules.
- Default to internal unless functionality is clearly external.
- `apps/android/app/src/main/java/.../GoogleSignInController.kt` obtains a
  google credential and joins the current native handoff attempt. `DeviceSession`
  owns its verifier, account binding, credential effects and private startup
  record. `AppRouter` owns installed interface delivery; `AppBridge` exposes its
  fixed operations ([module](../modules/device-startup.md)).
- `apps/android/app/src/main/java/.../MainActivity.kt` owns Android shell
  mechanics: owned-origin routing, external routing, file chooser handoff,
  popup handoff, app-link intent handling, and OAuth Custom Tab orchestration
  and `nexus://auth/handoff` deep-link intake.
- `apps/android/app/src/main/java/.../NexusWebView.kt` owns the WebView
  configuration shared by MainActivity and ShareActivity.
- `apps/android/app/src/main/java/.../playback/NexusPlaybackService.kt` owns the
  Android Media3 player, Media Session, native Consumption recording, and
  player notification lifecycle.
- `apps/android/app/src/main/java/.../playback/PlayerBridge.kt` owns the
  main-frame, owned-origin `nexusPlayer` WebKit bridge and adapts it to the
  service-owned MediaController.
- `apps/android/app/src/main/java/.../NexusOriginClient.kt` is the one
  authorized native product API client, shared by the player and offline. It
  may call only its fixed player-descriptor, listening-state, consumption-command,
  Consumption-activity, `me`, reading-copy, reader-state, episode-download,
  pinned episode transcript, offline-catalog, bootstrap, handoff and
  account-setting BFF paths with
  WebView cookies, the exact owned Origin and `X-Nexus-Wire`; it accepts no
  arbitrary URL, path, headers, or credentials.
- `apps/android/app/src/main/java/.../CatalogStore.kt` owns the complete saved
  browsing catalog, atomic publication and account retirement. its fixed local
  route and bridge operations are documented in
  [offline-catalog.md](../modules/offline-catalog.md); media downloads remain with
  the offline owner below.
- `apps/android/app/src/main/java/.../offline/` owns offline
  ([module](../modules/offline.md)): the store, the transfer and sync jobs, the
  `nexusLocalContent` bridge and the shelf router. Its only direct calls are the
  captured episode's https enclosure/artwork and the signed storage url a reading copy names;
  it accepts no renderer-supplied URL,
  path, headers, credentials, or filesystem location.
- `apps/android/app/src/main/java/.../ShareActivity.kt` owns the
  system-share-sheet capture entry: the `ACTION_SEND` intent filter and the
  `nexus-share://` scheme it intercepts to hand off to MainActivity.
- Android manifests own Android framework entrypoints and deep-link filters.
- Android Gradle files own Android build, signing, app-link, and release
  configuration.
- Android product api/auth calls belong to `NexusOriginClient`'s fixed paths,
  including bootstrap, handoff, google minting and account settings. offline may
  make only its direct download calls above. AndroidX WebKit exposes the
  main-frame `nexusApp` and `nexusPlayer` listeners on the owned origin and
  `nexusLocalContent` on the owned and shelf origins.
  Android authored replication uses fixed provision/change/snapshot paths through
  `NexusOriginClient`; its bridge admits only the owned workspace and exact
  packaged shelf generation. Android code must not add other product or Supabase clients, OAuth/PKCE
  exchange logic, upload clients, `addJavascriptInterface`, or generic bridges.
  OAuth/PKCE exchange remains server-side.
- Supabase Auth alone owns password hashes, invitation and recovery tokens, and
  sessions. `auth.identities` describes linked provider identities and MUST NOT
  be used to infer password presence. Nexus stores no password, invitation, or
  password-presence state.

## Environment

- The environment-variable contract required by
  [../rules/codebase.md](../rules/codebase.md) is `.env.example`.

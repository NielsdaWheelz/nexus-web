# android shell production cutover

this doc owns the hard production cutover for the first-party android shell in:

- `apps/android/`
- `apps/web/public/.well-known/`
- `apps/web/src/app/(authenticated)/settings/`
- `apps/web/src/app/(authenticated)/media/[id]/`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/`
- `apps/web/src/lib/androidShell.ts`
- `docs/rules/`

the android app is a thin first-party shell around the existing hosted nexus web
app. android owns shell mechanics only. the web app remains the product
surface. next api routes remain the bff. fastapi remains the product backend.

this is a hard cutover.

- no trusted web activity
- no capacitor
- no react native
- no native product api client
- no native supabase client for product traffic
- no native auth/session exchange
- no parallel mobile bff
- no shell-specific web route fork
- no native billing flow
- no local vault support in the shell
- no js bridge unless a concrete shipped behavior forces it later
- no legacy redirect fallback in production
- no runtime host switcher

## goals

- ship one production android app that hosts the canonical nexus web origin
- keep browser or webview -> next `/api/*` -> fastapi intact
- keep android shell code local, linear, explicit, and easy to audit
- make oauth compliant by sending provider auth to a system user-agent
- return production auth through verified `https` app links only
- keep existing web upload and ingest flows working through `WebView`
- publish signed release apks through github releases
- remove android-incompatible product entry points from the shell
- fail release builds when production identity, app links, or host config are
  incomplete
- make android a first-class app in repo docs, ci, and test gates

## non-goals

- no native reader, player, chat, library, settings, billing, or vault rewrite
- no direct android -> fastapi calls for product behavior
- no direct android -> supabase calls for product behavior
- no separate mobile backend contract
- no offline mode
- no push notifications
- no background media service
- no share-intent ingestion
- no native upload client
- no local markdown folder sync
- no store billing integration in this cutover
- no custom-scheme callback in release builds
- no staging/dev host fallback in release builds
- no broad third-party host allowlist inside `WebView`

## production inputs

these inputs are required before any production or release-candidate apk can be
called complete:

- final android `applicationId`
- final app name and launcher assets
- canonical production web origin
- release `nexusAndroidReleaseBaseUrl`
- release `nexusAndroidReleaseOwnedHost`
- permanent android release keystore
- release keystore backup and rotation owner
- release apk signing certificate sha-256 fingerprint
- github release secrets for the keystore and signing passwords
- deployed `/.well-known/assetlinks.json` on the canonical host
- production supabase site url
- production supabase redirect allowlist
- production google oauth client config
- production github oauth app config
- production privacy policy url
- crash, anr, and auth failure monitoring owner

missing any item above is a release blocker, not a todo that can be papered
over in code.

## target behavior

### app launch

- launching the app opens `BuildConfig.NEXUS_BASE_URL` in one `WebView`
- release builds require `BuildConfig.NEXUS_BASE_URL` to be `https`
- release builds do not accept localhost, emulator, example, or placeholder
  origins
- if the launch intent contains a verified nexus `https` url, the app opens
  that exact url in the same `WebView`
- android back navigates `WebView` history before exiting the activity
- there is one launcher activity

### owned versus external navigation

- same-host nexus main-frame navigation stays in the `WebView`
- off-host main-frame navigation never stays in the `WebView`
- off-host navigation opens in a Custom Tab
- unsupported external schemes never crash the app
- popup or new-window navigation is user-gesture gated
- third-party popup content is not a product surface
- there is no allowlist for arbitrary third-party hosts inside `WebView`

### auth

- the existing web login page remains the login surface
- the existing linked-identities page remains the identity-linking surface
- starting google or github sign-in from the shell leaves to a system
  user-agent
- production provider redirects return to
  `https://<nexus-host>/auth/callback?...`
- android app links hand that verified callback url to the app
- the app loads the callback url in the `WebView`
- `apps/web/src/app/auth/callback/route.ts` remains the only owner of auth code
  exchange and cookie writes
- after callback completion, authenticated browsing continues in the same
  `WebView`
- release builds do not use `nexus-dev://`
- debug builds may use `nexus-dev://auth/callback` only for local supabase
  oauth testing

### app links

- the release manifest declares verified `https` app links for the canonical
  nexus host
- `apps/web/public/.well-known/assetlinks.json` contains the release
  application id and release apk signing certificate sha-256 fingerprint
- app links are verified on an installed release build before rollout
- all app-link failures are treated as release blockers
- no production flow depends on users manually choosing the app from an
  unverified chooser

### uploads

- tapping `Upload file` in the existing add-content tray opens the android
  system file chooser
- the chosen file returns to the existing web file input
- the existing upload-init -> signed upload -> ingest path runs unchanged
- cancelling the chooser leaves the current web page state unchanged
- there is no native upload or ingest code path

### shell-restricted product surface

- the local-vault entry is absent from settings in the android shell
- direct shell access to local vault shows an explicit unsupported message
- local-vault autosync does not run in the shell
- shell detection is used only for ux and policy gating, never authorization

## architecture

### runtime model

- `apps/android/` is a standalone kotlin android app
- the hosted next app remains the product surface
- the android shell does not call fastapi, supabase, stripe, or product apis
  directly
- the web app inside the shell calls next `/api/*` routes only
- next owns sessions, bff proxying, and auth callback handling
- fastapi owns backend product behavior

### android ownership

`MainActivity.kt` owns:

- `WebView` creation and settings
- owned-host versus external-host routing
- Custom Tab handoff
- incoming app-link intent handling
- debug-only local callback intent handling
- file chooser handoff
- back navigation

`AndroidManifest.xml` owns:

- launcher entrypoint
- release app-link intent filters
- debug-only local callback intent filters

`app/build.gradle.kts` owns:

- compile, min, and target sdk versions
- debug and release host configuration
- release placeholder failure checks
- build-time `BuildConfig` values

there is no android controller, navigator, repository, service, adapter, bridge,
or view model unless a second concrete shipped behavior creates an obvious
payoff.

### web ownership

- `apps/web/src/app/auth/callback/route.ts` owns auth callback exchange
- `apps/web/src/lib/auth/redirects.ts` owns callback url construction
- `apps/web/src/lib/auth/callback-origin.ts` owns callback origin validation
- `apps/web/src/lib/androidShell.ts` owns shell detection and restricted route
  checks
- settings, local vault, pane, and command palette files own visible shell-safe
  product gating
- `apps/web/public/.well-known/assetlinks.json` owns digital asset links
  verification content

### shell identification

- the android shell appends one stable `NexusAndroidShell` token to the
  `WebView` user agent
- the web app checks that token only where shell-specific ux or policy gating
  is needed
- generic android webviews are not treated as the nexus android shell
- there is no injected dom api
- there is no `postMessage` protocol
- there is no native command surface exposed to web content

### build configuration

- debug defaults may target `http://10.0.2.2:3000`
- release builds require explicit `nexusAndroidReleaseBaseUrl`
- release builds require explicit `nexusAndroidReleaseOwnedHost`
- release builds require `https`
- release builds fail on placeholder hosts
- release builds fail on placeholder asset-link fingerprints
- release builds disable cleartext traffic
- release builds enable app-link autoverification
- there is no runtime host selection

### release operations

- release artifacts are signed apks
- signing is owned by the self-distribution release keystore
- the release keystore is never committed
- github release assets are the signed apk and its sha-256 checksum
- tagged release candidates are installed on physical devices before publish
- release testing verifies oauth, app links, uploads, billing, and
  shell-restricted ux on physical devices
- rollback criteria are defined before rollout
- crash, anr, webview load failure, auth callback failure, and app-link failure
  signals are monitored during rollout

## rules

- follow `docs/rules/simplicity.md`
- follow `docs/rules/control-flow.md`
- follow `docs/rules/module-apis.md`
- follow `docs/rules/codebase.md`
- follow `docs/rules/conventions.md`
- follow `docs/rules/entrypoints.md`
- follow `docs/rules/layers.md`
- follow `docs/rules/testing_standards.md`
- follow `docs/rules/tech-stack.md`

feature-specific rules:

- do not add direct android product api calls
- do not add direct android supabase product calls
- do not duplicate auth code exchange in android
- do not keep third-party oauth inside `WebView`
- do not render arbitrary third-party pages inside `WebView`
- do not add a js bridge for shell detection
- do not add a second upload implementation
- do not show local-vault entry points in the shell
- do not add share-intent ingestion in this cutover
- do not fork normal product routes into android-only route trees
- do not hide production blockers behind defaults or fallbacks

## key decisions

### 1. one hosted web app, one shell

the android app is a host around the current nexus web app, not a second
product client.

this preserves the existing repo layers and avoids inventing a mobile api
surface.

### 2. system user-agent owns oauth

oauth provider ui must not run inside the `WebView`.

the shell sends provider navigation to a system user-agent, then receives the
verified app-link callback and lets the existing next route finish the session.

### 3. app links are the only release callback path

production uses `https://<nexus-host>/auth/callback`.

`nexus-dev://auth/callback` exists only to make local debug oauth possible with
local supabase and non-public hosts.

### 4. web billing remains web-owned

self-distribution does not require store billing.

the android shell may use the existing web billing page and bff billing routes.
android still does not get a native stripe client or native billing flow.

### 5. local vault is unsupported

local vault depends on browser file-system assumptions that do not belong in
this shell.

the shell hides the entry point and shows an explicit unsupported state if a
direct route is opened.

### 6. native features wait for native value

native modules are added only when android owns a capability the web app cannot
reasonably provide: push, background media, share intake, offline sync, or
store billing.

native code is not added to mirror existing web product behavior.

## files

### android

- `apps/android/settings.gradle.kts`
- `apps/android/build.gradle.kts`
- `apps/android/gradle.properties`
- `apps/android/app/build.gradle.kts`
- `apps/android/app/src/main/AndroidManifest.xml`
- `apps/android/app/src/debug/AndroidManifest.xml`
- `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt`
- `apps/android/app/src/main/res/values/strings.xml`
- `apps/android/app/src/main/res/values/themes.xml`
- `apps/android/app/src/androidTest/java/app/nexus/android/MainActivityTest.kt`

### web

- `apps/web/public/.well-known/assetlinks.json`
- `apps/web/src/app/auth/callback/route.ts`
- `apps/web/src/lib/auth/callback-origin.ts`
- `apps/web/src/lib/auth/redirects.ts`
- `apps/web/src/lib/androidShell.ts`
- `apps/web/src/app/login/LoginPageClient.tsx`
- `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/LocalVaultAutoSync.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/components/CommandPalette.tsx`

### repo and ops

- `README.md`
- `.env.example`
- `.github/workflows/ci.yml`
- `.github/workflows/android-release.yml`
- `.gitignore`
- `Makefile`
- `supabase/config.toml`
- `docs/rules/codebase.md`
- `docs/rules/entrypoints.md`
- `docs/rules/layers.md`
- `docs/rules/tech-stack.md`
- `docs/rules/testing_standards.md`

## implementation plan

### 1. finish shell behavior

- keep one `MainActivity`
- keep webview settings explicit
- keep same-host routing in `WebView`
- route all off-host navigation to Custom Tabs
- reject non-user-gesture popups
- ensure popup targets are routed externally or through normal owned-host
  handling, never rendered as a second product surface
- keep file chooser success and cancel behavior
- keep webview history-first back behavior
- handle `onNewIntent` for app-link re-entry while the app is already running

### 2. finish release identity

- set final application id
- add final app label and launcher icons
- define version code and version name ownership
- define release signing through the self-distribution release keystore
- build signed release apk in ci
- verify the signed apk with `apksigner`
- generate a sha-256 checksum for the signed apk
- upload the apk and checksum to github releases
- fail ci if release host or asset links are placeholders

### 3. finish app links

- replace the asset links placeholder with the release apk signing certificate
  sha-256 fingerprint
- deploy `/.well-known/assetlinks.json` from the canonical web host
- verify app links on installed debug and release variants
- document the exact adb verification commands
- keep release callbacks on `https` only

### 4. finish oauth

- keep web login and linked identity flows as the only auth surfaces
- keep provider auth outside `WebView`
- configure production supabase redirect urls for canonical `https` callbacks
- configure google and github oauth apps for production
- verify google login on a physical android device
- verify github login on a physical android device
- verify identity linking on a physical android device
- reject non-allowlisted callback origins before code exchange

### 5. finish shell-safe product gating

- hide local vault entries from shell settings
- hide shell-restricted command palette and pane entry points
- show explicit unsupported states for direct local-vault routes
- prevent local-vault autosync from running in the shell

### 6. finish tests and ci

- keep android lint and debug/test apk build in `make verify-android`
- add release apk build coverage once production props are available in ci
- add instrumentation coverage for launch, owned routing, external routing,
  app-link re-entry, debug callback re-entry, `onNewIntent`, back navigation,
  popup handling, file chooser success, and file chooser cancel
- add real-device or managed-device oauth smoke coverage where practical
- keep web unit/browser tests for callback construction and shell-safe ux
- run workflow lint after ci changes

### 7. finish operations

- add crash and anr monitoring before production rollout
- add auth callback failure telemetry
- add webview load failure visibility
- write a release checklist for tagged github releases
- write rollback criteria
- keep the public privacy policy current

## acceptance criteria

### routing

- launching the app opens the configured base url in one `WebView`
- verified nexus `https` links open directly in the installed app
- owned-host links stay in `WebView`
- off-host links open in Custom Tabs
- unsupported external schemes do not crash the app
- android back navigates web history before exiting
- app-link re-entry works when the activity is cold
- app-link re-entry works when the activity is already running

### auth

- google sign-in starts in a system user-agent, not in `WebView`
- github sign-in starts in a system user-agent, not in `WebView`
- provider success returns through verified `https` app links in release
- provider success loads the existing next callback route in `WebView`
- callback exchange writes cookies through the existing web callback path
- linked identity flows use the same return path
- release builds contain no custom-scheme callback dependency

### app links

- `assetlinks.json` is deployed on the canonical host
- `assetlinks.json` contains the release apk signing certificate sha-256 fingerprint
- android reports verified app-link status for the release package
- release oauth succeeds without chooser prompts or manual app selection

### uploads

- tapping upload opens the android file chooser
- selecting a supported file completes the existing web ingest flow
- cancelling the chooser leaves the page usable
- no native upload path exists

### shell-safe product surface

- shell settings hide local vault
- direct shell local-vault route shows unsupported state
- local-vault autosync does not run in the shell
- normal web behavior remains unchanged outside the shell

### architecture

- android has no product api client
- android has no supabase product client
- android has no native auth exchange
- android has no js bridge
- android has no native upload implementation
- android has no share-intent ingestion path
- web code inside the shell still calls next `/api/*`
- next remains the only auth callback/session owner

### build and release

- `make verify-android` passes
- release apk builds in ci with production properties
- release build fails with placeholder host config
- release build fails with placeholder asset links
- release build fails without release keystore inputs
- release build fails when asset links do not contain the release signing cert
  fingerprint
- release cleartext traffic is disabled
- release app-link autoverification is enabled
- signed release apk verifies with `apksigner`
- github release contains the signed apk and sha-256 checksum
- release candidate completes google and github oauth on a physical device
- release has monitoring and rollback criteria

## verification commands

local:

```bash
make verify-android
bun run test:unit -- src/lib/auth/callback.test.ts src/lib/auth/redirects.test.ts src/lib/androidShell.test.ts
bun run test:browser -- src/app/login/LoginPageClient.test.tsx 'src/app/(authenticated)/settings/SettingsPaneBody.test.tsx' 'src/app/(authenticated)/settings/billing/page.test.tsx' 'src/app/(authenticated)/settings/local-vault/page.test.tsx' 'src/app/(authenticated)/settings/identities/page.test.tsx'
make check-workflows
```

device:

```bash
adb devices
adb shell pm get-app-links app.nexus.android
adb shell pm verify-app-links --re-verify app.nexus.android
```

one-time release key bootstrap:

```bash
keytool -genkeypair \
  -v \
  -keystore nexus-release.jks \
  -alias nexus \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000

keytool -list -v -keystore nexus-release.jks -alias nexus
base64 -i nexus-release.jks | pbcopy
```

release, once production inputs exist:

```bash
cd apps/android
./gradlew :app:assembleRelease \
  -PnexusAndroidReleaseBaseUrl=https://<canonical-host> \
  -PnexusAndroidReleaseOwnedHost=<canonical-host> \
  -PnexusAndroidReleaseStoreFile=/abs/path/nexus-release.jks \
  -PnexusAndroidReleaseStorePassword='<store-password>' \
  -PnexusAndroidReleaseKeyAlias=nexus \
  -PnexusAndroidReleaseKeyPassword='<key-password>' \
  -PnexusAndroidReleaseCertSha256='<release-cert-sha256>' \
  -PnexusAndroidVersionCode=<monotonic-version-code> \
  -PnexusAndroidVersionName=<release-version-name>
```

## release blockers

- placeholder app-link fingerprint
- placeholder release host
- missing release signing fingerprint
- missing release keystore
- unverified app links
- production oauth redirect allowlist contains debug custom scheme
- production auth allowed origins contain localhost, emulator, or example hosts
- google or github oauth cannot complete on a physical android device
- local vault can start in the shell
- signed release apk cannot be built in ci
- signed release apk cannot be verified with `apksigner`
- crash/anr/auth failure monitoring is not available for rollout

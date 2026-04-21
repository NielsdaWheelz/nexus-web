# android shell cutover

this doc owns the hard cutover for the first-party android shell in:

- `apps/android/`
- `apps/web/public/.well-known/`
- `apps/web/src/app/(authenticated)/settings/`
- `apps/web/src/app/(authenticated)/media/[id]/`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/`
- `docs/rules/`

it adds one first-party android app that hosts the existing nexus web app in a
`WebView` and removes android-incompatible product paths from the shell
surface.

this is a hard cutover.

- no trusted web activity
- no capacitor
- no react native
- no native product api client
- no parallel mobile-web packaging layer
- no in-app billing flow
- no local vault support in the shell
- no auth shim outside the existing web callback path
- no js bridge unless a concrete shipped behavior requires it

## goals

- ship one first-party android app around the existing hosted nexus web app
- keep the current browser -> next `/api/*` -> fastapi architecture intact
- keep android shell code local, linear, and easy to read
- make oauth work safely on android without embedding third-party sign-in in a
  `WebView`
- let verified nexus links open directly in the android app
- let existing web upload flows keep working through the shell
- make the play build consumption-only and policy-safe
- remove shell entry points that are broken or policy-incompatible on android
- update the repo rules/docs so `apps/android/` is a first-class part of the
  codebase

## non-goals

- no native reader, player, chat, library, or settings rewrite
- no direct android -> fastapi calls for product behavior
- no separate mobile bff or mobile backend contract
- no offline mode
- no push notifications
- no background media service cutover
- no share-intent ingestion flow in this cutover
- no native upload client
- no local markdown folder sync in the shell
- no alternate billing program or play billing integration
- no shell-specific web route fork for normal product navigation

## target behavior

### app launch

- launching the android app opens the configured nexus base url in one
  `WebView`
- if the launch intent contains a verified nexus https url, the app opens that
  exact url in the same `WebView`
- the android back button goes back in `WebView` history first and exits the
  activity only when there is no more in-app history

### owned versus external navigation

- same-origin nexus navigation stays in the `WebView`
- off-origin navigation never stays in the `WebView`
- every off-origin link opens in a `Custom Tab`
- there is no allowlist for arbitrary third-party hosts inside the `WebView`

### auth

- the existing web login page remains the login surface
- the existing linked-identities page remains the identity-linking surface
- starting google or github sign-in from the `WebView` leaves immediately to a
  `Custom Tab`
- the provider redirect back to `https://<nexus-host>/auth/callback?...`
  re-enters the android app through verified app links
- the app loads that callback url in the `WebView`
- the existing next `GET /auth/callback` route remains the only owner of auth
  code exchange and cookie writes
- after callback completes, authenticated browsing continues in the same
  `WebView`

### deep links

- verified nexus links open directly in the android app when installed
- library, media, settings, and auth callback urls all use the same verified
  host model
- there is no custom-scheme deep-link model in the shipped app

### uploads

- tapping `Upload file` in the existing add-content tray opens the system file
  chooser
- choosing a pdf or epub returns the file to the web file input
- the existing web upload + ingest path runs unchanged after file selection
- cancelling the file chooser leaves the current web page state unchanged
- there is no native upload or ingest code path

### shell-restricted product surface

- the billing entry is absent from settings in the android shell
- opening the billing route directly in the android shell shows an explicit
  consumption-only message and no checkout or portal actions
- transcript and podcast upgrade prompts do not render purchase affordances in
  the android shell
- the local-vault entry is absent from settings in the android shell
- opening the local-vault route directly in the android shell shows an
  explicit unsupported message

## final state

### runtime model

- `apps/android/` is a standalone kotlin android app
- the hosted next app remains the product surface
- the android shell does not talk to fastapi or supabase directly for product
  data
- the web app inside the shell still calls next `/api/*` routes only
- the existing bff and backend auth boundaries remain unchanged

### android ownership

- `MainActivity.kt` owns:
  - `WebView` creation and settings
  - owned-host versus external-host branching
  - `Custom Tab` handoff
  - incoming app-link intent handling
  - file chooser handoff
  - back navigation
- `AndroidManifest.xml` owns:
  - verified app-link intent filters
  - the launcher entrypoint
- there is no android controller, navigator, repository, service, bridge, or
  abstraction layer above those files unless a second concrete call site
  forces it

### web ownership

- `apps/web/src/app/auth/callback/route.ts` remains the only auth callback
  exchange owner
- `apps/web/public/.well-known/assetlinks.json` owns website -> app
  verification for app links
- web billing and local-vault gating remains a small surface-level ui concern
- shell detection exists only to gate shell-incompatible ui
- shell detection is not an auth mechanism and not a security boundary

### shell identification

- the android shell appends one stable token to the `WebView` user agent
- the web app checks that token where shell-only product gating is required
- there is no injected dom api, custom event protocol, or message bridge for
  shell identification

### build configuration

- the nexus base url and owned host are build-time values
- release builds use `https` only
- there is no runtime host-switching ui
- there is no fallback host guessing

### code shape

- keep the main android control flow in one activity until a second call site
  creates obvious payoff for extraction
- branch explicitly on:
  - owned host versus external host
  - app-link intent versus plain launch
  - file chooser result versus cancel
  - shell versus non-shell web ui
- keep one-use constants and one-use helpers inline unless they hide
  substantial incidental complexity
- do not add abstractions that exist only to look reusable

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

feature-specific implementation rules:

- keep the existing browser -> next `/api/*` -> fastapi contract unchanged
- do not add a direct android auth/session client for nexus product traffic
- do not duplicate auth code exchange in android when the next callback route
  already owns it
- do not keep third-party oauth inside the `WebView`
- do not allow arbitrary third-party sites to render inside the `WebView`
- do not add a js bridge, `postMessage` protocol, injected command surface, or
  shell dom contract in this cutover
- do not add a second upload implementation when the existing file input flow
  already works
- do not keep billing checkout or portal affordances visible in the shell
- do not keep local-vault entry points visible in the shell
- do not add share-intent ingestion in this cutover
- do not fork the product into separate android-specific and web-specific page
  trees

## key decisions

### 1. one hosted web app, one shell

the android app is a host around the current nexus web app, not a second
product client.

that keeps the existing repo layers intact and avoids inventing a mobile api
surface that this codebase does not need yet.

### 2. custom tabs own every off-origin navigation

the `WebView` is only for nexus-controlled content.

that keeps oauth compliant, keeps external browsing behavior predictable, and
avoids debugging third-party web breakage inside the shell.

### 3. app links are the only shipped callback return path

the provider redirect returns to the same nexus https host the web app already
uses.

android app links hand that url back to the app, and the existing next
callback route finishes the session inside the `WebView`.

there is no second native callback parser and no custom-scheme callback model
in the shipped app.

### 4. consumption-only means removing purchase affordances from the shell

the safe play posture is not "show checkout and hope policy allows it later."

the shell should not expose stripe checkout or billing-portal entry points at
all.

### 5. local vault is unsupported in the shell

the local vault depends on browser file-system apis that are not the right fit
for this android shell.

the shell should remove the entry point and show an explicit unsupported state
if a direct route is opened.

### 6. no share-intent ingestion in the first cutover

url or file share intake is valuable, but it forces a second android entry
path and additional web control flow.

the first cutover should stay focused on the shell, auth, verified links, file
chooser support, and shell-safe product gating.

## files

### add

- `docs/android-shell-cutover.md`
- `apps/android/settings.gradle.kts`
- `apps/android/build.gradle.kts`
- `apps/android/gradle.properties`
- `apps/android/app/build.gradle.kts`
- `apps/android/app/src/main/AndroidManifest.xml`
- `apps/android/app/src/main/java/.../MainActivity.kt`
- `apps/android/app/src/main/res/values/strings.xml`
- `apps/android/app/src/main/res/values/themes.xml`
- `apps/android/app/src/androidTest/java/.../MainActivityTest.kt`
- `apps/web/public/.well-known/assetlinks.json`

### modify

- `README.md`
- `docs/rules/codebase.md`
- `docs/rules/tech-stack.md`
- `docs/rules/testing_standards.md`
- `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`

### delete

- no runtime deletes are required for this cutover

## plan

### 1. repo cutover

- add `apps/android/` as a first-class app in the repo
- update repo docs/rules so the new app is part of the documented codebase and
  test surface

### 2. android shell cutover

- add the minimal android project
- build one activity that hosts the nexus base url in a `WebView`
- keep navigation policy local in that activity:
  - owned host stays in `WebView`
  - off-origin host goes to `Custom Tab`
  - back goes through `WebView` history first
- wire file chooser support for existing web file inputs

### 3. auth and app-link cutover

- add verified app-link intent filters for the nexus host
- add `assetlinks.json` under `apps/web/public/.well-known/`
- confirm the oauth flow:
  - web login button starts sign-in
  - provider ui opens in `Custom Tab`
  - `/auth/callback` returns to the app
  - next callback route exchanges code and sets cookies in the `WebView`

### 4. shell policy cutover

- append one explicit android-shell token to the `WebView` user agent
- remove billing and local-vault entry points from shell settings
- replace direct shell access to billing/local-vault routes with explicit
  unsupported messaging
- remove shell-visible purchase affordances from transcript and podcast upgrade
  surfaces

### 5. verification and docs cutover

- add android instrumentation coverage for owned-host routing, external-host
  handoff, app-link callback loading, and file chooser handoff
- keep existing product behavior covered by current web tests
- update onboarding docs for android setup and local development

## acceptance criteria

### routing

- launching the android app opens the configured nexus base url in one
  `WebView`
- opening a verified nexus https link from another app opens that exact url in
  the android shell
- clicking an owned nexus link inside the shell stays in the `WebView`
- clicking an off-origin link inside the shell opens a `Custom Tab`
- pressing android back navigates `WebView` history before exiting the app

### auth

- starting google sign-in from the nexus login page opens provider ui in a
  `Custom Tab`, not in the `WebView`
- starting github sign-in from the nexus login page opens provider ui in a
  `Custom Tab`, not in the `WebView`
- after provider success, `/auth/callback` re-enters the android app and lands
  authenticated in the `WebView`
- linked-identity flows use the same callback path and succeed without a
  second native auth implementation

### uploads

- tapping `Upload file` in the add-content tray opens the android system file
  chooser
- choosing a supported file completes the existing web upload/ingest flow
- cancelling the chooser does not break the current page state

### shell-safe product surface

- the settings list in the android shell does not show `Billing`
- the settings list in the android shell does not show `Local Vault`
- opening `/settings/billing` directly in the android shell shows no checkout
  or portal action
- opening `/settings/local-vault` directly in the android shell shows an
  explicit unsupported state
- transcript and podcast upgrade surfaces in the android shell show no stripe
  purchase entry points

### architecture

- the android shell does not call fastapi directly for product traffic
- the android shell does not implement a duplicate auth callback exchange path
- the web app inside the shell still uses next `/api/*` routes
- there is no js bridge or injected message protocol in the shipped shell
- there is no native upload implementation in the shipped shell
- there is no share-intent ingestion path in the shipped shell

### tests

- android instrumentation tests cover:
  - owned nexus url stays in the `WebView`
  - off-origin url opens a `Custom Tab`
  - verified app-link callback url loads in the app
  - web file input launches the system chooser path
- existing web tests continue to cover product behavior outside the android
  host boundary

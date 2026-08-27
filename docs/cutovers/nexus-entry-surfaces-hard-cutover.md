# Nexus Entry Surfaces Hard Cutover

**Status:** APPROVED SPEC · 2026-08-26 · **Type:** hard cutover · 80/20 slice ·
one-user prototype

**Questions requiring an answer:** none.

This spec assumes `/android` is the landing in scope, authenticated `/` remains
Resume, Google remains the primary sign-in method, and no public marketing
homepage is wanted. The release repository is private: `/android` is therefore
public-by-URL but no-index, and download requires GitHub access. Those are
decisions, not extension points.

## Decision

Make entry feel like the threshold to Nexus, not a generic SaaS template.

> Quiet identity. One obvious task. Verifiable trust.

Use one responsive entry canvas for `/login` and `/android`. Keep authentication
and release capabilities in their existing owners; compose a more intentional
presentation around them. On wide screens the login becomes a restrained
asymmetric editorial field. On narrow screens the same DOM becomes one focused
column. `/android` becomes a durable release colophon, not a marketing site.

Hard-cut every superseded layout, selector, assertion, and copy path. Add no
compatibility props, legacy branch, fallback, variant framework, or feature
flag.

## Goals

1. Give desktop login, mobile login, and Android install one Nexus identity.
2. Make the primary action and method hierarchy immediately legible.
3. Verify a live session before showing login; never trust cookie shape.
4. Make every control reachable at small/zoomed viewports and safe in WebView.
5. Make the Android download independently inspectable without runtime data.
6. Centralize only genuinely shared identity and viewport responsibilities.
7. Prove one behavior at each ownership boundary, then stop.

Follow all `docs/rules`, especially cleanliness, simplicity, boundaries,
frontend, correctness, errors, tagged unions, and testing, plus
`docs/local-rules/testing-standards.md`.

## Scope Lock

In scope:

- `/login` session gate, hierarchy, content, responsive composition, and states;
- `/android` content, trust links, responsive composition, and metadata;
- shared entry viewport/safe-area ownership and shared product identity;
- mechanical canvas/reflow adoption by existing `AuthSurface` ceremonies,
  without changing their content, state, or capability;
- entry/auth no-index enforcement, crawl policy, and accurate legal copy;
- focused browser, HTTP journey, release-gate, and physical-device proof.

Non-goals:

- a public homepage, `/welcome`, CMS, blog, waitlist, pricing, or SEO campaign;
- signup, user administration, identity linking, provider removal, or auth
  transport redesign;
- passkeys, magic links, MFA, native callback hardening, or Supabase migration;
- a runtime GitHub API/BFF, dynamic release status, analytics, experimentation,
  personalization, localization, or a general content system;
- public artifact hosting, repository-visibility changes, or distribution
  outside the existing private GitHub release;
- remote hero art, stock imagery, animation system, glass/card treatment, or
  broad application restyle;
- JSON-LD, `llms.txt`, service workers, install detection, or update delivery.

No database, Android-native, auth-endpoint, or release-manifest producer-schema
changes are authorized. Align the deploy decoder to the manifest-v2 shape the
release producer already emits; this is a strict contract repair, not a legacy
branch. Do not remove an auth provider without a live identity inventory;
presentation priority is not identity policy.

## Target Behavior

### Route contract

| Request | Result |
| --- | --- |
| Anonymous `/` | Existing redirect to `/login`; no new landing route |
| Verified `/` | Existing authenticated Resume surface |
| Anonymous `/login?next=<safe>` | `200` login with the validated target |
| Verified `/login?next=<safe>` | `307` directly to the validated target |
| Refreshable or terminal-shaped `/login` | `307` to canonical session recovery |
| Auth dependency failure at `/login` | `307` to recovery; credentials preserved |
| Invariant defect at `/login` | Existing `500` defect boundary |
| `/android` | Public-by-URL, no-index private release colophon |

`/login` calls `getSessionVerification()` after parsing the existing
`AuthReturnTarget`. `Verified` redirects to the target. Returned
`RefreshRequired` and `SessionEnded` enter
`/auth/session/recover?next=<target>`; `Anonymous` renders without mutation.
`AuthDependencyError` is thrown, not returned: catch exactly that class and
enter recovery, but rethrow every other error to the `500` defect boundary.
Only the existing POST resolver may rotate or clear cookies. Middleware must
not convert an unverified cookie shape into an authenticated redirect.

This supersedes only the `/login` clause in
`auth-session-recovery-hard-cutover.md`: middleware still never redirects from
cookie shape to a protected target; the Login Server Component may redirect
only after DAL verification.

### Login ceremony

Order is fixed:

1. **Continue with Google** — primary and immediately visible.
2. **Use email and password** — explicit native disclosure; the form remains in
   the initial HTML for progressive enhancement and password-manager discovery,
   but is absent from the focus order while closed.
3. **Other ways to sign in** — tertiary disclosure containing GitHub.

Only password sign-in creates in-page pending state. While it is pending, all
competing methods and disclosures are disabled. Browser OAuth forms and native
anchors are stateless navigation handoffs; do not leave the page pending because
native cancellation has no web callback. Provider cancellation restores idle
controls and projects no alert. Expected failure is inline and actionable; a
defect throws. Preserve password-manager semantics, paste, autofill, reveal,
field focus, validated `next`, and generic credential errors. There is no signup
affordance or account-existence disclosure. A retry hides stale feedback from
assistive technology but preserves its occupied layout slot until the new
outcome, so entering pending state never shifts the method stack. A successful
password redirect remains terminally pending through page unload; it must not
re-expose or re-announce the prior failure.

Browser OAuth remains server-initiated. In the Android shell, Google retains
`nexus://auth/native`; GitHub retains `nexus://auth/start` and the existing
Custom Tab/PKCE owner. The visual cutover may not reimplement those protocols.

### Android release colophon

The page identifies this as private distribution and says GitHub access is
required. The primary action is the stable latest APK. A compact verification
section links to the stable checksum, stable `release-manifest.json`, and release
page. It explains the verification operation but renders no fetched version,
date, commit, signature, or health claim. GitHub Releases and the existing
release gate remain the truth; the page cannot become stale data infrastructure.

Stable targets:

```text
/releases/latest/download/nexus-android.apk
/releases/latest/download/nexus-android.apk.sha256
/releases/latest/download/release-manifest.json
/releases/latest
```

Use the existing repository origin when forming the absolute GitHub URLs.

Cutover prerequisite: the current stable release lacks
`release-manifest.json`. Before the page change is promoted, publish and promote
one manifest-bearing Android release through the existing workflow and prove,
with authenticated GitHub access, that the APK, checksum, and manifest stable
URLs resolve. There is no missing-manifest branch or compatibility copy.

## Final Architecture

```text
productIdentity.ts ───────────────┬─ root metadata / manifest / OG
                                 ├─ AuthSurface
                                 └─ Android page

androidReleaseLinks.ts ── page links / pure closed URL contract

EntryCanvas ─ viewport + scroll + safe area + canvas + 48 px local control size
    ├─ AuthSurface ─ identity region + task region
    │    └─ LoginPageClient ─ method disclosures + transaction state
    ├─ Android page ─ release narrative + static artifact links
    └─ legal utilities ─ long-form policy + terminal return action

/login Server Component ─ login-entry plan ─ DAL / existing recovery capability
LoginPageClient ─ existing password/OAuth endpoints and native deep links
/android ─ static GitHub release URLs ─ existing signed release pipeline
```

Ownership:

| Concern | Sole owner |
| --- | --- |
| Entry/discovery wordmark and descriptor | `lib/productIdentity.ts` |
| Entry viewport, scroll, safe areas, and local target size | `EntryCanvas` |
| Auth identity/task composition | `AuthSurface` |
| Method order, disclosure, pending, and form projection | `LoginPageClient` |
| Login render/target/recovery decision | `lib/auth/login-entry.ts` |
| Session truth and repair | existing auth DAL and recovery capability |
| Provider transport and return-target safety | existing auth endpoints/builders |
| Android release facts | existing manifest/release pipeline |
| Web release-channel URL model | `lib/androidReleaseLinks.ts` |
| Android page narrative and link projection | `/android` page |
| Raw WebView system insets | existing Android/CSS safe-area owners |
| HTML index/canonical intent | route metadata |
| No-index and cache response enforcement | middleware |
| Crawl permission only | `robots.ts` |

## Capability And Schema Contracts

### Shared entry canvas

```ts
interface EntryCanvasProps {
  readonly children: ReactNode;
}
```

`EntryCanvas` owns only `100dvh`, vertical overflow, four canonical
`--viewport-safe-*` paddings, `--surface-canvas`, and a scoped
`--size-xl: 48px`. It accepts no route, variant, alignment, theme, or content
props. It reads no `env(safe-area-inset-*)` directly. Feature modules own width,
grid, copy, and semantics.

`AuthSurface` keeps its narrow semantic API:

```ts
interface AuthSurfaceProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}
```

It uses one DOM. At `>= 60rem`, identity and task form an unboxed asymmetric
two-column field; below it, they form one centered column no wider than `24rem`.
There is no `desktop`/`mobile` component split and no visual variant schema.
Every current `AuthSurface` consumer adopts this canvas and responsive geometry
so the owner remains singular. Forgot password, invite/recovery, and account
password retain their exact content, states, endpoints, and actions; the
existing auth-surfaces browser proof samples those ceremonies for regression.

### Login entry decision

```ts
type LoginEntryPlan =
  | { readonly kind: "Render" }
  | { readonly kind: "Target"; readonly target: AuthReturnTarget }
  | { readonly kind: "Recover"; readonly target: AuthReturnTarget };

type SessionVerificationReader = () => Promise<SessionVerification>;

function planLoginEntry(
  target: AuthReturnTarget,
  verify: SessionVerificationReader,
): Promise<LoginEntryPlan>;
```

This login-specific capability is the deterministic decision seam. It maps the
four returned session outcomes, catches only `AuthDependencyError`, and rethrows
unknown errors. It neither redirects nor mutates cookies. The Server Component
alone projects the plan to render or framework `307`; do not create a generic
page-gate framework.

### Product identity

```ts
export const PRODUCT_NAME = "Nexus";
export const PRODUCT_DESCRIPTOR = "A private instrument for attention.";
```

Only exact cross-surface identity belongs here. Route-specific promises,
headings, errors, and action labels stay with their feature. `lib/brand.ts` is
generated and must not be edited.

### Existing release manifest

The page links to, but does not decode, the existing v2 artifact:

```ts
interface ReleaseManifestV2 {
  version: 2;
  run_id: string;
  git_sha: string;
  tag: string;
  package: string;
  version_code: number;
  previous_version_code: number;
  version_name: string;
  signer_sha256: string;
  source_apk_sha256: string;
  api_origin: string;
  api_origin_source: "signed_apk_build_config";
  target_sdk: number;
  player_protocol: unknown;
  assets: unknown;
}
```

`deploy/hetzner/release.py` remains the decoder/validation owner. Do not add a
second TypeScript decoder merely to render this static page.

The shared release-origin predicate accepts only the byte-exact lowercase
serialization `https://<canonical-host>[:<valid-port>]`. It rejects trimming,
trailing separators, empty query/fragment delimiters, credentials, paths,
encoded or noncanonical hosts, and invalid ports before producer or deploy use.

`lib/androidReleaseLinks.ts` is the closed web projection of the existing
release channel: latest release, APK, checksum, and manifest. The page has no
local URL. Its focused pure unit proof compares the closed model with the four
exact stable URL literals without file I/O, network access, or React. The
existing Python release-gate proof owns producer/deploy conformance; the browser
proof separately verifies that the candidate page projects the model. Do not
create a generic repository/config service.

## Content Design Contract

The feature designer owns content inside this discriminated design schema:

```ts
type EntryLink = { readonly label: string; readonly href: string };
type EntryFeedback = { readonly title: string; readonly message?: string } | null;
type LoginFeedbackState =
  | "EmptyEmail"
  | "InvalidEmail"
  | "EmptyPassword"
  | "InvalidCredentials"
  | "RateLimited"
  | "Offline"
  | "DependencyFailure"
  | "ProviderStartFailure"
  | "ProviderCallbackFailure"
  | "ProviderCancellation"
  | "SessionEnded";

type EntryContent =
  | {
      readonly kind: "Login";
      readonly identity: { readonly name: string; readonly descriptor: string };
      readonly task: {
        readonly heading: string;
        readonly support: { readonly browser: string; readonly androidShell: string };
      };
      readonly methods: {
        readonly primary: string;
        readonly passwordDisclosure: string;
        readonly passwordSubmit: readonly [idle: string, pending: string];
        readonly otherDisclosure: string;
        readonly tertiary: string;
      };
      readonly states: Readonly<Record<LoginFeedbackState, EntryFeedback>>;
      readonly footer: {
        readonly browser: readonly EntryLink[];
        readonly androidShell: readonly EntryLink[];
      };
    }
  | {
      readonly kind: "AndroidRelease";
      readonly identity: { readonly name: string; readonly descriptor: string };
      readonly eyebrow: string;
      readonly heading: string;
      readonly support: string;
      readonly accessNote: string;
      readonly primary: EntryLink;
      readonly verification: {
        readonly heading: string;
        readonly explanation: string;
        readonly links: readonly EntryLink[];
      };
      readonly installNote: string;
      readonly returnAction: EntryLink;
      readonly footer: readonly EntryLink[];
    };
```

This is not a runtime registry. Identity may be evocative; every task, state,
action, and trust sentence is literal. Good content is calm, short at 200% zoom,
useful before promotional, free of unverifiable claims, and never exposes
account, corpus, or private data. A heading names the task; support answers the
next doubt; an action starts the named operation; trust copy names an actual
check.

### Login content

| Slot | Required content |
| --- | --- |
| Identity | `Nexus` · `A private instrument for attention.` |
| Heading | `Sign in` |
| Browser support | `Private workspace. No public registration.` |
| Android-shell support | `Use the account connected to this Nexus.` |
| Primary | `Continue with Google` |
| Secondary disclosure | `Use email and password` |
| Password submit | `Sign in` / `Signing in…` |
| Tertiary disclosure/action | `Other ways to sign in` / `Continue with GitHub` |
| Browser footer | `Android` · `Privacy` · `Terms` |
| Android-shell footer | `Privacy` · `Terms` |

Normative state projection:

| State | Title | Message / behavior |
| --- | --- | --- |
| Empty email | `Enter your email address.` | focus Email |
| Invalid email | `Enter a valid email address.` | focus Email |
| Empty password | `Enter your password.` | focus Password |
| Invalid credentials | `Email or password is incorrect.` | clear/remask/focus Password |
| Rate limited | `Too many sign-in attempts.` | `Wait a few minutes, then try again.` |
| Offline | `You’re offline.` | `Reconnect to sign in.`; use only when offline is known |
| Dependency failure | `Sign in is temporarily unavailable.` | `Try again in a moment.` |
| Provider start failure | `We couldn't start sign in.` | `Please try again.` |
| Provider callback failure | `We couldn't complete sign in.` | `Please try again.` |
| Provider cancellation | none | suppress the permitted callback message; restore idle controls |
| Session ended | `Your session ended.` | `Please sign in again.` |

Remove the pseudo-consent sentence: links inform, and sign-in is not legal
assent. Keep endpoint feedback allowlists and transport strings unchanged;
`/login` alone owns the calmer content projection.

### Android content

| Slot | Required content |
| --- | --- |
| Identity | `Nexus` · `A private instrument for attention.` |
| Eyebrow | `Private distribution` |
| Heading | `Nexus for Android` |
| Support | `The first-party Android companion for your Nexus library.` |
| Access note | `GitHub access is required to download this release.` |
| Primary | `Download APK` |
| Trust heading | `Verify this release` |
| Trust explanation | `Compare the APK's SHA-256 with the checksum. The release manifest records the source commit, signing-certificate fingerprint, and artifact digests accepted by the release gate.` |
| Trust links | `SHA-256 checksum` · `Release manifest` · `View release on GitHub` |
| Install note | `Android may ask you to allow installs from this browser. Only install Nexus from this page or its linked GitHub release.` |
| Return action | `Open Nexus` → `/` |
| Footer | `Privacy` · `Terms` |

Do not invent testimonials, AI claims, feature inventories, download counts,
security superlatives, or a release value not supplied by the artifact owner.

## Visual And Interaction Rules

- Reuse `AsterismMark`, existing typefaces, color/space tokens, `Button`,
  `Input`, `FeedbackNotice`, and native `details`/disclosure semantics where
  suitable. Add no new image asset or icon family.
- Canvas may breathe; task density stays compact. No card-in-card, hero mockup,
  gradient mesh, glass, dashboard preview, or ornamental motion.
- The wide login uses a flexible identity column plus a `20–24rem` task column;
  it is never centered `50/50`. Both regions are left-aligned, the task remains
  compact and unboxed, and its footer stays in the task column.
- Below `60rem`, identity, task, and footer center into one `24rem` column
  without changing DOM order. `/android` remains one centered release column at
  every width and never inherits the login split.
- Every interactive target is at least `48px` in the entry scope. Body/link
  text meets WCAG AA contrast; focus indication meets non-text contrast. Never
  use `--ink-faint` for required text or links.
- `360×640`, `390×844`, landscape, short desktop, and 200% zoom retain vertical
  scroll, visible focus, terminal content, and no horizontal overflow.
- Safe-area padding uses canonical tokens on all four sides. Background may
  paint edge-to-edge; content and controls may not cross the safe rectangle.
- Prefer no entrance animation. Honor reduced motion for any existing state
  transition. Pending state must not move the layout.

## HTTP, Metadata, And Discovery

No endpoint or response schema changes. Preserve:

- `POST /auth/password/sign-in`: `400`, generic `401`, `429`, `503`, or `303`;
- existing `GET /auth/oauth` initiation and callback behavior;
- `GET /auth/session/recover`: non-mutating `200`, private no-store;
- `POST /auth/session/resolve`: existing `204`/`401`/`403`/`503`/`500` effects.

All auth response paths emit `X-Robots-Tag: noindex, nofollow` and retain the
existing private/no-store policy. `/login` also exports server-owned robots
metadata with indexing and following disabled. Client code owns no metadata.

`/android`, `/privacy`, and `/terms` export `noindex, follow, noarchive`
metadata. `/android` also exports its canonical URL. There is no sitemap: a
private one-user product has nothing to solicit for discovery. Root metadata,
manifest, and OG art use the shared descriptor without claiming the private
root is a public homepage.

`robots.ts` controls crawling, never privacy or indexing. Use one exact rule:

```text
Allow: /login, /forgot-password, /account/password
Allow: /auth/invite, /auth/recovery, /auth/session/recover
Allow: /android, /privacy, /terms, /s$
Disallow: /
```

The more-specific allows let crawlers read each route's meta/header `noindex`;
the catch-all keeps private application and API paths out of crawl traffic. The
end anchor on `/s$` prevents that allow from prefix-matching private `/search`,
`/settings`, or `/share` routes. Do not disallow a noindex-controlled HTML
route. Preserve `/s`'s existing header contract.

Add `/robots.txt`, `/manifest.webmanifest`, `/opengraph-image`,
`/twitter-image`, and `/apple-icon` to `PUBLIC_ROUTES`; otherwise middleware
redirects anonymous metadata requests to login. Prove the closed set is
pass-through. No `/sitemap.xml` route is added.

Terms and Privacy must describe email/password and linked-provider auth
accurately. Replace any promised support channel that does not exist with
`the operator who provided access`; do not broaden the legal policy.

## Files

Add:

- `apps/web/src/components/EntryCanvas.tsx` and `EntryCanvas.module.css`;
- `apps/web/src/components/EntrySurfaces.browser.test.tsx`;
- `apps/web/src/lib/productIdentity.ts`;
- `apps/web/src/lib/{androidReleaseLinks.ts,androidReleaseLinks.unit.test.ts}`;
- `apps/web/src/lib/auth/{login-entry.ts,login-entry.unit.test.ts}`;
- `apps/web/src/app/robots.ts` and `robots.unit.test.ts`;
- `apps/web/src/app/android/AndroidPage.browser.test.tsx`.

Modify:

- `apps/web/src/components/auth/{AuthSurface.tsx,AuthSurface.module.css,AuthForms.module.css,AuthSurfaces.browser.test.tsx}`;
- `apps/web/src/app/login/{page.tsx,LoginPageClient.tsx}`;
- `apps/web/src/app/android/{page.tsx,page.module.css}`;
- `apps/web/src/{middleware.ts,middleware.unit.test.ts}`;
- `apps/web/src/lib/supabase/{middleware.ts,middleware.unit.test.ts}`;
- `apps/web/src/app/{layout.tsx,manifest.ts,opengraph-image.tsx}`;
- `apps/web/src/app/{privacy,terms}/page.tsx` and
  `apps/web/src/app/legal.module.css`;
- `apps/web/e2e/{fixtures.ts,extension/capture.extension.spec.ts,journeys/auth-session.journey.spec.ts,journeys/password-recovery.journey.spec.ts}`;
- `README.md`, `testdata/proofs.json`, and
  `docs/cutovers/{auth-session-recovery-hard-cutover.md,android-player-protocol-release-hard-cutover.md,browse-surface-deletion-hard-cutover.md}`;
- `deploy/hetzner/release.py`,
  `python/nexus/release_artifact.py`,
  `python/nexus_test_control/android_visual.py`,
  `python/nexus_test_control/cli.py`,
  `python/nexus_test_control/evidence.py`,
  `python/nexus_test_control/runner.py`,
  `python/nexus_test_control/model.py`,
  `python/tests/kernel/test_backend_artifact.py`,
  `python/tests/kernel/nexus_test_control/test_android_visual.py`,
  `python/tests/kernel/nexus_test_control/test_cli.py`,
  `python/tests/kernel/nexus_test_control/test_runner.py`,
  `python/tests/kernel/nexus_test_control/test_selection.py`,
  `python/tests/kernel/test_android_player_protocol_release_gate.py`, and the
  canonical fixture in `python/tests/testkit/production_deploy.py`, to
  align the closed decoder with the already-emitted manifest-v2 shape, share one
  canonical release-origin predicate with the producer, and atomically refreeze
  the independently recomputed proof-ownership digest; the Android visual test
  control files additionally own exact formal-replay inputs and bounded build
  failure diagnostics.

Delete:

- `apps/web/src/app/android/page.unit.test.tsx` after
  `androidReleaseLinks.unit.test.ts` owns the exact stable URL model and the
  browser proof owns rendered semantics. Atomically replace its exact
  `android-player-protocol-skew` registry entry; no dangling proof path is
  allowed. Static React rendering is legacy evidence, not a testing pattern.

The original branch base required a closure-only canonical offline-reader
refreeze. Live `main` now contains the identical generated closure through PR
#202. After rebasing, run the canonical generator and require no diff for
`asset-manifest.sha256`, `source-manifest.sha256`, `index.html`, the current
`index-B5ZkvHQQ.js`, and removal of `index-BnFwN24i.js`. PR #204 must not create
an independent generated-asset delta. This changes no reader source, generator,
native owner, or asset schema.

Keep unchanged:

- auth route handlers, redirect builders, auth adapters, and Supabase config;
- `.github/workflows/release.yml` and the manifest-v2 producer schema;
- Android native auth, WebView, Credential Manager, and inset implementation;
- authenticated application routes and Resume behavior.

## Proof And Acceptance Matrix

One primary proof owns each boundary. Do not duplicate it in a journey.

| Boundary / risk | Primary proof | Required acceptance |
| --- | --- | --- |
| Login hierarchy, disclosure, feedback, and pending | `apps/web/src/components/auth/AuthSurfaces.browser.test.tsx` | Exact content/order; closed controls unfocusable; password pending disables competitors; OAuth stays stateless; password-manager behavior and all existing auth ceremonies survive |
| Shared viewport, reflow, safe area, target size, contrast | `apps/web/src/components/EntrySurfaces.browser.test.tsx` | Real Chromium at `1440×900`, `390×844`, `360×640`, short landscape, and 200%-equivalent reflow; login, Android, and long legal utilities remain reachable with no x-overflow, `48px` terminal actions, and AA computed colors |
| Android semantics and stable release links | `apps/web/src/app/android/AndroidPage.browser.test.tsx` | Exact content/order and four stable targets; no runtime fetch or fabricated release value |
| Web release-channel URL model | `apps/web/src/lib/androidReleaseLinks.unit.test.ts` | Closed model equals the four exact stable URL literals; no file I/O, network, or React rendering |
| Login decision outcomes and error discipline | `apps/web/src/lib/auth/login-entry.unit.test.ts` | Four returned outcomes; only `AuthDependencyError` recovers; invariant error identity is rethrown |
| Direct `/login` wiring | `apps/web/e2e/journeys/auth-session.journey.spec.ts` | One anonymous render and one verified safe-target `307`; no duplicated DAL edge matrix |
| Auth cache/index response policy | `apps/web/src/middleware.unit.test.ts` | Every auth response path is private/no-store/noindex; `/s` contract remains |
| Cookie-shape restraint and metadata pass-through | `apps/web/src/lib/supabase/middleware.unit.test.ts` | Active shape never authenticates `/login`; robots, manifest, OG, Twitter, and apple-icon routes never redirect |
| Crawl output | `apps/web/src/app/robots.unit.test.ts` | Exact allow/disallow contract above; no sitemap declaration |
| Release artifact/deploy contract | `python/tests/kernel/test_android_player_protocol_release_gate.py` | Exact current manifest-v2 shape, APK digests, source SHA, signer, HTTPS API origin, version monotonicity, target SDK, and protocol gate remain valid; pre-repair shape is rejected |
| Candidate stable-asset availability | authenticated GitHub release preflight | Latest APK, checksum, and manifest assets resolve before page promotion |
| Web-to-native handoff strings | `apps/web/src/components/auth/AuthSurfaces.browser.test.tsx` | Exact Google/GitHub deep links; native owners remain unchanged |
| Signed-out physical login | recorded manual device review | `/login`: portrait, landscape, large text, keyboard, TalkBack, gesture and three-button navigation |
| Physical Android colophon | `./scripts/test android-visual --sha <candidate-sha> --path /android --device primary` | `/android` remains reachable and safe in the candidate shell |

Selected desktop/mobile screenshots are review evidence only for the actual
composition contract, not broad snapshots. Chromium cannot prove WebView
insets; synthetic Android emulation cannot replace the physical boundary.

`android-visual` authenticates before navigation, so it cannot prove the login
surface. Review `/login` manually on a signed-out physical shell and record the
candidate SHA/device/build. Use the harness only for the public colophon:

The harness uses the existing public `/version` route solely to prove its owned
local web process is ready. It must not probe protected `/`, whose anonymous
redirect is an application contract rather than a health failure.

```sh
./scripts/test android-visual --sha <candidate-sha> --path /android --device primary
```

Complete one manual Google sign-in on the release candidate; no automated
Credential Manager claim is made. GitHub's unchanged native intake remains in
`NativeAuthHandoffTest.kt`.

## Red / Green / Refactor

1. **Baseline:** run `./scripts/test confidence`; record unrelated failures.
2. **Red:** replace the Android legacy unit first and add the smallest failing
   browser/journey assertions above. Demonstrate sensitivity with the existing
   `44px`, unsafe short-viewport layout, equal-weight method order, and missing
   verified-session redirect. The login-entry error test uses the named reader
   port to prove dependency recovery and invariant rethrow; no route interception
   is allowed. Use a parent/fault only when the natural red is unavailable.
3. **Green:** implement one ownership slice at a time. Use
   `./scripts/test changed <exact paths>` after each slice.
4. **Refactor:** remove duplicate viewport CSS, old selectors/copy/assertions,
   and orphan imports. Generalize nothing beyond the proven entry consumers.
5. **Close:** run `./scripts/test confidence`, affected type/lint gates, residue
   searches, and proof-registry validation. Publish the manifest-bearing stable
   Android release, prove its three assets, then capture signed-out `/login` and
   harnessed `/android` physical evidence against the exact candidate SHA.

This is the 80/20 shape: several boundary/component proofs, one narrow real
stack journey owner, existing release/native gates, and two deliberate physical
screens. Do not add an end-to-end login suite or visual matrix for every auth
ceremony.

## Non-Overlapping Work Lanes

0. **Foundation — lands first:** `EntryCanvas`, product identity, `AuthSurface`,
   all existing consumers' mechanical adoption, and the shared geometry proof.
1. **Login — after Lane 0:** login page/client, login-entry decision, auth form
   styles/proof, direct-login journey, middleware header policy, and the named
   session-spec supersession. No Android landing or global metadata.
2. **Android — after Lane 0, parallel with Lane 1:** release-link model and
   conformance proof, Android page/styles/browser proof, atomic legacy-test and
   proof-registry replacement, README links. No auth or release-pipeline code.
3. **Trust/discovery — parallel with Lanes 1–2:** layout/manifest/OG,
   robots output, metadata public-route pass-through, Terms/Privacy. No entry
   component or auth behavior.
4. **Closure — after 1–3:** strict deploy-decoder alignment to the existing
   producer shape, atomic proof-registry replacement plus independently
   recomputed ownership-digest refreeze, residue gates, full confidence gate,
   manifest-bearing release prerequisite, and exact-SHA physical review. No
   producer-schema change or production redesign.

Only Lane 0 is a shared dependency. Lanes 1–3 have disjoint production files;
Lane 4 integrates evidence and documentation.

## Hard-Cut Residue Gates

Completion requires absence, not deprecation:

- no Android `100vh`/non-scroll viewport owner or stale `No editorial` comment;
- no duplicate AuthSurface/Android/legal safe-area or canvas ownership;
- no `--ink-faint` on entry legal, trust, or return links;
- no equal-weight password/Google/GitHub stack, orphan divider/provider/legal
  selectors, or pseudo-consent sentence;
- no OAuth/native handoff that leaves local pending state after cancellation;
- no source-reading Android page unit, compatibility class, alias prop, old
  branch, separate mobile login, or `desktop`/`mobile` variant;
- no runtime release fetch, new proxy/API, remote hero, or duplicate manifest
  decoder;
- no page-local release URL or static-React release conformance test;
- no sitemap, indexable-private-distribution claim, or robots rule that blocks a
  noindex-controlled HTML route;
- no `/sign-up`, `?mode=create`, `EmailPasswordSignIn`, legacy login stylesheet,
  or provider-removal work introduced by this cutover;
- no contradictory normative docs or proof-registry entries.

## Acceptance Criteria

- All route/session outcomes match the table and preserve existing cookie,
  return-target, provider, and recovery contracts.
- Desktop and mobile render one semantic login with the fixed method hierarchy,
  exact content, password-only local pending, stateless provider handoff, and no
  signup or false consent. Other auth ceremonies keep their behavior/content.
- `/android` is a no-index private-distribution colophon with an obvious APK
  action, honest GitHub-access note, and independently inspectable stable
  artifacts; it makes no stale claim.
- Auth and entry utilities remain non-indexable; robots lets crawlers observe
  those directives, private/API paths stay disallowed, and no sitemap exists.
- Entry surfaces use one viewport/safe-area owner, one entry/discovery identity owner,
  existing primitives/tokens, AA contrast, `48px` targets, and reachable
  short/zoomed layouts.
- Legal copy matches implemented authentication and names no nonexistent
  support channel.
- A manifest-bearing stable Android release exists before page promotion; the
  APK, checksum, and manifest latest URLs resolve with authorized GitHub access.
- The deploy decoder accepts exactly the current manifest-v2 producer shape and
  rejects the pre-repair shape; no compatibility path remains.
- Every matrix boundary has its single primary proof; red sensitivity, final
  confidence, residue, and exact-SHA physical evidence are recorded.
- Every superseded component, style, test, copy path, comment, and normative
  statement is deleted. No fallback or compatibility residue survives.

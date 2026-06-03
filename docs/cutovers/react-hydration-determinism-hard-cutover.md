# React Hydration Determinism Hard Cutover

Status: draft implementation spec
Date: 2026-06-03
Owner: web app
Scope: `apps/web` authenticated shell, pane chrome, first-paint data rendering, and
hydration verification

## 1. Thesis

The production `Minified React error #418` with `args[]=text` means the server
HTML and the first client render are not identical. This is not a recoverable UI
warning and not a logging problem. It is a broken first-render contract.

The correct fix is to make every value that can affect first-render markup
deterministic at its owner. The implementation must not hide the mismatch with
`suppressHydrationWarning`, `dynamic(..., { ssr: false })`, "mounted" gates,
client-only skeletons, route-local try/catch branches, or duplicated local
browser checks. The final state has one first-render environment contract, one
viewport contract, one platform/keybinding contract, one Android-shell capability
contract, one display-formatting contract, and deterministic content transforms.

This is a hard cutover:

- no legacy lane
- no compatibility shims
- no old/new dual behavior
- no temporary hydration suppression
- no fallbacks that keep browser-global reads alive in render paths

## 2. Governing Rules

This plan follows the repo rules already in `docs/rules/`:

- `docs/rules/index.md`: keep docs scoped to their narrow owner, use
  unconditional rules, and avoid umbrella guidance that duplicates rule docs.
- `docs/rules/correctness.md`: hydration mismatches are broken invariants, not
  expected abnormalities.
- `docs/rules/cleanliness.md`: collapse repeated logic to one owner, remove
  fallback/compatibility lanes, and keep public surfaces narrow.
- `docs/rules/layers.md`: keep platform and client-shell concerns behind their
  correct web and Android boundaries.
- `docs/rules/entrypoints.md`: side effects belong in explicit entrypoints and
  browser-facing shared imports must remain browser-safe.
- `docs/rules/module-apis.md`: each capability has one primary public form; do
  not expose duplicate interchangeable APIs.
- `docs/rules/simplicity.md`: default to fewer code paths and no speculative
  options.
- `docs/rules/testing_standards.md`: SSR and page-level rendering behavior belongs
  in Playwright E2E against a production-built Next runtime, backed by focused
  unit/browser tests for pure owned logic.
- `apps/web/README.md`: `HtmlRenderer` is the only component that may use
  `dangerouslySetInnerHTML`.
- `docs/architecture.md`: the authenticated app is a client-side pane system
  inside a fixed `AuthenticatedShell`; route `page.tsx` files are URL markers, not
  behavior owners.

External framework constraints:

- React hydration expects server-rendered content and the initial client render
  to match.
- React treats hydration mismatches as bugs; recovery is not guaranteed.
- Next.js identifies browser-only conditions, time-dependent APIs, and invalid
  HTML nesting as common hydration causes.

References:

- https://react.dev/errors/418
- https://react.dev/reference/react-dom/client/hydrateRoot
- https://nextjs.org/docs/messages/react-hydration-error

## 3. Current Failure Model

React error #418 is generic, but `args[]=text` narrows the class: text content in
the hydrated tree differs between server output and the first browser render.
In this codebase, text mismatch and structural mismatch risks share the same
root cause: render-time code reads browser-only state or host defaults that the
server could not have used.

The immediate suspects are not isolated bugs. They are repeated patterns:

1. Viewport-dependent first-render branching.
2. Platform and keybinding labels derived from `navigator` or `localStorage`.
3. Android-shell gating derived from client `navigator.userAgent`.
4. Dates and numbers formatted with runtime default locale/time zone.
5. HTML or Markdown transformed differently on server and client.
6. Browser `document` and portal guards scattered through overlay components.
7. Tests that prove hydration-cache hits but do not fail on React hydration
   warnings or errors in a production browser.

## 4. Audit Findings

### 4.1 Viewport Branching

Owner today: `apps/web/src/lib/ui/useIsMobileViewport.ts`

Problem:

- `readIsMobile()` returns `false` on the server.
- The same initializer reads `window.innerWidth` on the client.
- Mobile browsers can therefore render a mobile tree as their first client
  render while the server emitted a desktop tree.

Known consumers that can affect first-paint markup or labels:

- `apps/web/src/components/appnav/AppNav.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/GlobalPlayerFooter.tsx`
- `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/components/palette/CommandPalette.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/SelectionPopover.tsx`
- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/chat/ModelSettingsPopover.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/lib/workspace/mobileChrome.tsx`

Target:

- No first-render component may choose different text or element structure by
  reading `window.innerWidth`.
- The app uses either markup-invariant responsive CSS or a hydration-safe
  viewport snapshot that is identical on server and first client render.
- Actual measured viewport may update only after hydration has committed.

### 4.2 Keybinding and Platform Labels

Owners today:

- `apps/web/src/lib/keybindings.ts`
- local render-time callers

Problems:

- `loadKeybindings()` reads `localStorage`.
- `formatKeyCombo()` reads `navigator.userAgent` and changes text such as
  `Ctrl+K` versus command-symbol labels.
- `AppNav.tsx` computes command-palette hint text during render.
- Palette and settings surfaces duplicate the same formatting capability.

Known consumers:

- `apps/web/src/components/appnav/AppNav.tsx`
- `apps/web/src/components/palette/paletteProviders.ts`
- `apps/web/src/components/palette/usePaletteController.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx`

Target:

- Keybinding display is owned by a single seeded keybinding provider.
- The first-render keybinding snapshot is derived from server-known platform
  inputs plus static defaults.
- User customizations from storage apply after hydration through the same owner.
- Callers ask for a semantic shortcut display; they do not read storage or
  format platform glyphs themselves.

### 4.3 Android-Shell Gating

Owners today:

- `apps/web/src/lib/androidShell.ts`
- ad hoc render-time consumers

Problems:

- `isAndroidShell()` reads `navigator.userAgent`.
- Server routes such as `/login` and `/share` already use
  `isAndroidShellUserAgent(headers().get("user-agent"))`, but authenticated
  pane rendering often reads the client global.
- Settings navigation, pane subtitles, palette filtering, and local-vault
  visibility can diverge between server HTML and first client render.

Known consumers:

- `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- `apps/web/src/components/palette/usePaletteController.ts`
- `apps/web/src/components/palette/paletteProviders.ts`
- `apps/web/src/lib/panes/paneRouteTable.ts`
- `apps/web/src/lib/workspace/sessionSync.ts`
- `apps/web/src/app/(authenticated)/LocalVaultAutoSync.tsx`

Target:

- Android-shell mode is a render-environment capability seeded by the
  authenticated server layout from request headers.
- `isAndroidShellUserAgent()` remains a pure parser.
- `isAndroidShell()` as a render-time global helper is deleted.
- UI code consumes `useRenderEnvironment()` or a narrower `useAndroidShell()`
  hook owned by the provider.

### 4.4 Locale, Time Zone, and Numeric Formatting

Owners today:

- local `toLocaleDateString()` calls
- local `Intl.NumberFormat()` calls

Problems:

- Default locale and time zone can differ across server runtime and browser.
- `SettingsBillingPaneBody.tsx` is especially high risk because
  `paneServerLoaders.ts` seeds `settingsBilling` into the hydration cache under
  `billing-account:0`; prefetched text can be rendered on both sides during
  hydration.
- Chat, conversation, contributor, identity, and browse surfaces repeat date
  formatting decisions locally.

Known callers:

- `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/browseState.ts`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryIntelligenceView.tsx`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/ForkStrip.tsx`
- `apps/web/src/components/chat/ForkGraphOverview.tsx`
- `apps/web/src/components/chat/ReferencingChatRow.tsx`

Target:

- User-visible dates and numbers are formatted through one display-formatting
  module with explicit locale and time-zone inputs.
- The initial locale/time-zone contract is deterministic and server-seeded.
- If user-specific locale preferences are added later, they must be loaded into
  the same render-environment contract before first render, not discovered
  independently by components.

### 4.5 Render-Time Content Mutation

Owners today:

- `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`
- `apps/web/src/lib/highlights/applySegments.ts`
- `apps/web/src/components/ui/MarkdownMessage.tsx`
- `apps/web/src/components/ui/ReaderCitation.tsx`

Problems:

- `TranscriptPlaybackPanel.tsx` uses `DOMParser` in a render-time helper to
  enhance show-notes HTML with timestamp buttons. Server render lacks
  `DOMParser`, so it returns unmodified HTML while the browser can inject
  buttons during first render.
- `applyHighlightsToHtml()` also uses `DOMParser` and serializes transformed
  HTML. `MediaPaneBody.tsx` calls it from render memoization before handing the
  result to `HtmlRenderer`.
- `MarkdownMessage.tsx` rewrites bare citation tokens before Markdown rendering.
  The custom anchor renderer can emit `ReaderCitation`, creating a risk of
  invalid or nested anchors when citation tokens appear in link contexts.
- Next.js and React both treat invalid HTML nesting as a hydration risk because
  browsers repair HTML before React attaches.

Target:

- Show-notes enhancement is deterministic on both server and client, preferably
  by parsing to structured segments at the content boundary.
- Highlight HTML annotation and show-note timestamp annotation share one
  isomorphic sanitized-HTML transform owner, or are precomputed before the React
  render boundary.
- Markdown citation transformation is AST-aware and context-aware; it must not
  create nested anchors or rely on browser repair.
- Client-only actions such as copying to clipboard stay event-handler only and
  must not affect initial markup.

### 4.6 Portal and Document Guards

Owners today:

- `apps/web/src/components/ui/HoverPreview.tsx`
- `apps/web/src/components/ui/ActionMenu.tsx`
- other overlays that branch on `typeof document`

Problems:

- Overlay components repeat local `document` checks.
- Some render inline on the server and portal on the client, which can change
  structure during hydration.
- A generic "mounted" gate is forbidden for app content, but portals are a real
  browser-only rendering primitive that need one narrow owner.

Target:

- Add one `ClientPortal` owner for transient overlay surfaces that cannot render
  without `document`.
- `ClientPortal` may render `null` until mounted only for non-route, non-shell,
  non-content overlays that are not expected to be visible in server HTML.
- Shell chrome, pane bodies, settings content, billing content, transcripts,
  Markdown messages, and nav labels must not use `ClientPortal` to avoid
  hydration work.

### 4.7 Test Gap

Existing useful tests:

- `apps/web/src/lib/api/useResource.test.tsx`
- `apps/web/src/lib/workspace/bootstrap.server.test.ts`
- AC-4 pane hydration-cache tests under `apps/web/src/app/(authenticated)/**`
- unit tests for `androidShell.ts`, keybindings, and pane route tables

Gap:

- There is no E2E sentinel that fails on React hydration console errors,
  minified hydration page errors, or text mismatch messages in a production-built
  Next app.
- Hydration-cache hit tests do not prove React's SSR-to-hydrate contract.

Target:

- A production Playwright route matrix fails the build on hydration warnings,
  hydration errors, and page errors that match React hydration signatures.

## 5. Goals

G1. Eliminate production React hydration mismatches in the authenticated app shell.

G2. Make first-render determinism an explicit architecture contract, not an
implicit component convention.

G3. Collapse duplicate browser-environment reads into one render-environment
owner and small semantic hooks.

G4. Make viewport adaptation hydration-safe without losing mobile behavior after
hydration.

G5. Make keybinding display, Android-shell gating, and display formatting stable
on first paint.

G6. Replace render-time environment-dependent HTML mutation with deterministic
structured transformations.

G7. Centralize browser-only portal ownership for transient overlays without
turning it into an SSR escape hatch.

G8. Add real-browser, production-build verification that fails on hydration
warnings and errors.

G9. Leave the codebase cleaner: fewer render-time global reads, fewer repeated
formatters, narrower public APIs.

## 6. Non-Goals

- Do not upgrade React or Next.js as the fix.
- Do not disable SSR for affected components.
- Do not add `suppressHydrationWarning`.
- Do not add a broad "mounted" or `isClient` gate around the shell.
- Do not replace the pane architecture.
- Do not introduce SWR, React Query, Redux, or a new app-wide state framework.
- Do not change Android native behavior unless a separate Android issue proves
  the UA token contract is wrong.
- Do not add telemetry-only detection as the acceptance mechanism.
- Do not preserve old helper APIs for compatibility after their callers migrate.
- Do not make browser viewport a server truth via UA guessing.

## 7. Target Behavior

On a production build:

- The HTML emitted by Next.js and the first client render are identical for all
  routes covered by the acceptance matrix.
- Desktop and mobile may differ after hydration, but not before hydration.
- Mac, Windows/Linux, browser, and Android shell clients hydrate without text
  mismatches.
- Command-palette shortcut hints are stable during hydration.
- Android shell restricted surfaces are hidden or shown consistently on server
  HTML and first client render.
- Billing usage, dates, and numbers render the same text on server and client.
- Transcript show notes render timestamp actions without server/client markup
  drift.
- Markdown citations render valid HTML and never create nested interactive
  anchors.

## 8. Final Architecture

### 8.1 Render Environment

Add a first-render environment owner under `apps/web/src/lib/renderEnvironment/`.

Proposed files:

- `types.ts`
- `server.ts`
- `provider.tsx`
- `format.ts` if display formatting is small enough to colocate

The server layout owns creation of the initial environment. The client provider
owns hydration-safe access and post-hydration updates. Components consume narrow
hooks rather than browser globals.

Public type:

```ts
export type PlatformKind =
  | "mac"
  | "ios"
  | "android"
  | "windows"
  | "linux"
  | "other";

export type ViewportKind = "desktop" | "mobile";

export interface RenderEnvironment {
  androidShell: boolean;
  platform: PlatformKind;
  displayLocale: string;
  displayTimeZone: string;
  currentLocalDate: string;
  initialViewport: ViewportKind;
}
```

Initial decisions:

- `androidShell` and `platform` come from request `user-agent`.
- `displayLocale` is an explicit app value, initially `en-US` unless an existing
  server-side user preference already exists.
- `displayTimeZone` is explicit, initially `UTC` unless an existing server-side
  user preference already exists.
- `currentLocalDate` is a server snapshot formatted as `YYYY-MM-DD` in
  `displayTimeZone`. First-paint routes such as `/daily` must use this snapshot
  rather than calling `new Date()` during client render.
- `initialViewport` is a deterministic hydration snapshot. It must not be
  inferred from UA. The default is `desktop` unless the implementation chooses
  a markup-invariant responsive shell that does not need a viewport snapshot.

The root authenticated path is:

1. `apps/web/src/app/(authenticated)/layout.tsx` verifies the session.
2. It calls existing `loadWorkspaceBootstrap()`.
3. It builds `RenderEnvironment` from request headers and server-known
   preferences.
4. `AuthenticatedShell` receives the environment with existing bootstrap data.
5. `AuthenticatedShell` installs `RenderEnvironmentProvider` beside
   `BootstrapHydrationProvider`, `ReaderProvider`, and `WorkspaceStoreProvider`.

This composes with the existing theme pattern: theme is already root-owned by the
`nx-theme` cookie. Render environment is the same class of first-render input.

### 8.2 Viewport Contract

Replace `useIsMobileViewport()` with a hydration-safe viewport owner.

Allowed designs:

1. Preferred: markup-invariant responsive components. The same elements render on
   server and first client render; CSS media queries control layout.
2. Acceptable where markup must differ: `useViewportKind()` returns the provider
   `initialViewport` on server and first client render, then updates from
   `matchMedia` after hydration.

Required behavior:

- No component may call `window.innerWidth` in render.
- `matchMedia` subscriptions may run only in effects or
  `useSyncExternalStore` with identical server and first-client snapshots.
- The hook exposes semantic viewport state, not raw pixels.
- Existing tests that mock `useIsMobileViewport()` must move to the new public
  hook or, preferably, assert behavior through viewport-sized browser tests.

### 8.3 Keybinding Contract

Refactor `apps/web/src/lib/keybindings.ts` into a pure model plus a provider.

Pure model keeps:

- default bindings
- parsing and validation
- matching keyboard events
- platform-specific display formatting that accepts `PlatformKind` as an
  argument

Provider owns:

- first-render snapshot from defaults and `RenderEnvironment.platform`
- storage hydration after mount
- storage persistence for settings updates
- one semantic display API

Proposed public API:

```ts
export function useKeybinding(actionId: KeybindingActionId): string | null;

export function useKeybindingLabel(actionId: KeybindingActionId): string | null;

export function useKeybindingsController(): {
  bindings: Record<KeybindingActionId, string>;
  setBinding(actionId: KeybindingActionId, combo: string | null): void;
  resetBinding(actionId: KeybindingActionId): void;
};
```

Rules:

- `formatKeyCombo(combo)` must become `formatKeyCombo(combo, platform)`.
- `loadKeybindings()` must not be called during render.
- UI callers render labels from `useKeybindingLabel()`.
- Keyboard event matching may read the current provider state in effects and
  event handlers.

### 8.4 Android Shell Capability Contract

Split pure parsing from runtime capability access.

Keep pure functions:

- `isAndroidShellUserAgent(userAgent: string): boolean`
- `isAndroidShellRestrictedHref(href: string): boolean`
- `isAndroidShellRestrictedRouteId(routeId: string): boolean`

Delete global render helper:

- `isAndroidShell()`

Add semantic hook:

```ts
export function useAndroidShell(): boolean;
```

or consume `androidShell` from `useRenderEnvironment()`.

Rules:

- Server pages that already read headers continue using pure UA parsing.
- Authenticated pane components use the provider.
- Static registries such as `paneRouteTable.ts` must not call runtime global
  helpers to compute labels. They should expose pure metadata plus a rendering
  selector that accepts `shell` as input, or move shell-dependent text to the UI
  owner.

### 8.5 Display Formatting Contract

Create `apps/web/src/lib/display/format.ts` or colocate in
`lib/renderEnvironment/format.ts`.

Proposed API:

```ts
export interface DisplayFormatContext {
  locale: string;
  timeZone: string;
}

export function formatDisplayDate(
  value: string | Date,
  context: DisplayFormatContext,
  options?: Intl.DateTimeFormatOptions,
): string;

export function formatDisplayNumber(
  value: number,
  context: Pick<DisplayFormatContext, "locale">,
  options?: Intl.NumberFormatOptions,
): string;
```

Rules:

- No user-visible first-paint code may call `toLocaleDateString()` without an
  explicit locale and time zone.
- No first-paint code may call `new Intl.NumberFormat()` without an explicit
  locale.
- Components get the formatting context from `useRenderEnvironment()`.
- Pure tests cover invalid dates and stable UTC/localized output.

### 8.6 Content Transform Contract

Sanitized HTML annotation, transcript show notes, and Markdown citations must be
deterministic transforms.

Transcript target:

- Move timestamp detection out of render-time `DOMParser`.
- Prefer a structured representation:

```ts
export type ShowNoteSegment =
  | { kind: "html"; html: string }
  | { kind: "timestamp"; seconds: number; label: string };
```

or a server/client shared parser that does not depend on browser-only APIs.

Highlight target:

- `applyHighlightsToHtml()` must not depend on browser-only DOM APIs in a render
  path.
- If HTML annotation stays client-side, the parser must be isomorphic and owned
  by the highlight/html-rendering layer.
- If annotation moves server-side, the API must return final sanitized annotated
  HTML with typed metadata and the client must not re-annotate it.

Rules:

- The same input produces the same React tree on server and first client render.
- Event handlers provide seeking behavior.
- Sanitization remains at the content boundary; render code does not silently
  normalize malformed trusted HTML.
- Raw sanitized HTML continues to render only through `HtmlRenderer`; the cutover
  must not add a second `dangerouslySetInnerHTML` owner.

Markdown target:

- Replace regex-level citation link injection with an AST-aware transform or a
  renderer that detects link context.
- Citation components must not render an `<a>` inside another `<a>`.
- Tests include citations inside plain text, inside existing links, adjacent to
  punctuation, repeated citations, and malformed citation tokens.

### 8.7 Portal Contract

Create one shared portal owner only if the overlay audit confirms multiple
components need it.

Proposed API:

```ts
export function ClientPortal({ children }: { children: React.ReactNode }) {
  // implementation-owned details
}
```

Rules:

- `ClientPortal` is for transient overlays only.
- It must not wrap route content, shell content, pane content, or any text that
  should appear in server HTML.
- Overlay components do not branch locally on `typeof document`.
- The server and first client render for the parent component remain identical.
- Tests assert overlay behavior in browser mode or E2E, not through internal
  portal implementation details.

## 9. Capability Contract

The first-render capability contract is:

- Server owns facts available before HTML generation.
- Client owns post-hydration measurements and browser storage.
- Components may consume capabilities, but may not rediscover them.

Capabilities:

| Capability | Server source | Client post-hydration source | Owner |
|---|---|---|---|
| Shell runtime | request UA token | none required | render environment |
| Platform | request UA | optional refinement only if needed | render environment |
| Viewport | deterministic snapshot | `matchMedia` after hydration | viewport owner |
| Keybinding defaults | static model + platform | `localStorage` after hydration | keybinding provider |
| Locale | server-known app/user setting | none for first render | render environment |
| Time zone | server-known app/user setting | none for first render | render environment |
| Reduced motion | no first-render branch | `matchMedia` in effects/CSS | motion-specific hooks |
| Clipboard/media/session APIs | none | event handlers/effects only | feature-specific owners |
| Portals | none for transient overlays | `document` after mount | `ClientPortal` |

## 10. API Design Rules

- Public hooks return semantic values, not raw browser APIs.
- Pure helpers accept all environment-dependent inputs as parameters.
- Providers are seeded from server data and may update only after hydration.
- Callers must not import private parser/storage helpers to reconstruct state.
- Static route registries stay pure and deterministic.
- Storage APIs are effect/event-handler only.
- Browser globals are allowed in:
  - event handlers
  - effects
  - external-store subscriptions with stable server snapshots
  - non-render utility code explicitly called from those places
- Browser globals are forbidden in:
  - `useState` initializers that affect markup
  - render functions
  - `useMemo` values that affect markup
  - static module initialization for UI metadata
  - server/client shared formatters without explicit inputs

## 11. File Plan

### New Files

- `apps/web/src/lib/renderEnvironment/types.ts`
- `apps/web/src/lib/renderEnvironment/server.ts`
- `apps/web/src/lib/renderEnvironment/provider.tsx`
- `apps/web/src/lib/display/format.ts`
- `apps/web/src/lib/viewport/useViewportKind.ts`
- `apps/web/src/lib/keybindings/provider.tsx`
- `apps/web/src/lib/keybindings/model.ts`
- `apps/web/src/lib/showNotes/segments.ts` or equivalent content-owned parser
- `apps/web/src/components/ui/ClientPortal.tsx` only if multiple overlays need a
  shared portal owner
- `e2e/tests/hydration-sentry.ts`
- `e2e/tests/hydration-determinism.spec.ts`
- `e2e/seed-hydration-conversation.py` or an owned scenario in
  `e2e/seed-conversation-tree.py`, if existing seeded conversations cannot cover
  Markdown citations
- `e2e/seed-hydration-billing.py`, if existing billing setup cannot produce a
  deterministic non-empty billing period and usage row

The exact keybinding file split can differ if the implementation keeps
`lib/keybindings.ts` as the public facade, but the final public surface must
make ownership clear and remove render-time storage/global reads.

### Modified Files

- `apps/web/src/app/(authenticated)/layout.tsx`
- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx`
- `apps/web/src/lib/workspace/bootstrap.server.ts` if the render environment is
  bundled into the existing bootstrap payload
- `apps/web/src/lib/ui/useIsMobileViewport.ts` or its replacement
- `apps/web/src/components/appnav/AppNav.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/GlobalPlayerFooter.tsx`
- `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/components/palette/CommandPalette.tsx`
- `apps/web/src/components/palette/PaletteSheet.tsx` if motion logic affects
  first render
- `apps/web/src/components/palette/paletteProviders.ts`
- `apps/web/src/components/palette/usePaletteController.ts`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/SelectionPopover.tsx`
- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/chat/ModelSettingsPopover.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/browseState.ts`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryIntelligenceView.tsx`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/ForkStrip.tsx`
- `apps/web/src/components/chat/ForkGraphOverview.tsx`
- `apps/web/src/components/chat/ReferencingChatRow.tsx`
- `apps/web/src/components/ui/MarkdownMessage.tsx`
- `apps/web/src/components/ui/ReaderCitation.tsx`
- `apps/web/src/components/ui/HoverPreview.tsx`
- `apps/web/src/components/ui/ActionMenu.tsx`
- `apps/web/src/lib/androidShell.ts`
- `apps/web/src/lib/highlights/applySegments.ts`
- `apps/web/src/lib/panes/paneRouteTable.ts`
- existing tests that mock deleted hooks or helpers

### Deleted or Forbidden Final-State APIs

- `isAndroidShell()` as a global render-time helper.
- `formatKeyCombo(combo)` without platform input.
- `loadKeybindings()` calls from render paths.
- `useIsMobileViewport()` if it cannot be made hydration-safe without preserving
  misleading semantics.
- render-time `DOMParser` enhancement for show notes.
- render-time browser-only sanitized-HTML annotation.
- local `typeof document` portal branches in overlay components once a shared
  portal owner exists.
- direct first-paint `toLocaleDateString()` and default `Intl.NumberFormat()`
  calls in UI components.

## 12. Implementation Sequence

### Phase 0: Failing Sentinel First

Add the Playwright hydration sentinel before fixes.

The sentinel should:

- run against production-built Next through the existing `make test-e2e` path
- attach `page.on("console")` and `page.on("pageerror")`
- fail on:
  - `Hydration failed`
  - `Text content does not match`
  - `Text content did not match`
  - `Minified React error #418`
  - Next hydration warning URLs/messages
  - invalid nesting warnings that React emits during hydration
- visit the route matrix in desktop, mobile, Mac UA, and Android-shell UA

This establishes the red test and prevents a paper fix.

### Phase 1: Render Environment Provider

- Add render-environment types and server builder.
- Seed it from `(authenticated)/layout.tsx`.
- Install provider in `AuthenticatedShell`.
- Add unit tests for UA parsing into `PlatformKind` and shell runtime.
- Keep theme ownership unchanged.

### Phase 2: Viewport Cutover

- Replace or rewrite `useIsMobileViewport()`.
- Migrate all consumers.
- Prefer CSS-invariant structures in `AppNav`, `WorkspaceHost`, and
  `GlobalPlayerFooter`; use post-hydration viewport state only where markup
  differences are necessary.
- Delete old viewport hook semantics and update tests.

### Phase 3: Platform, Keybindings, and Android Shell

- Split keybinding pure model from provider.
- Migrate command hints, palette providers, workspace shortcuts, and settings.
- Delete render-time `loadKeybindings()` use.
- Replace authenticated `isAndroidShell()` calls with provider consumption.
- Refactor `paneRouteTable.ts` so shell-dependent metadata is selected with an
  explicit shell input or rendered outside the static registry.
- Delete global `isAndroidShell()`.

### Phase 4: Formatting Cutover

- Add display-format owner.
- Migrate billing first, because it uses server-prefetched hydration-cache data.
- Migrate remaining date/number UI callers found by search.
- Add pure tests for stable output.
- Add an `rg`-backed review item for future direct default-locale usage.

### Phase 5: Content Transform Cutover

- Replace transcript show-note render-time `DOMParser` mutation with a
  deterministic shared transform.
- Move highlight HTML annotation to the same isomorphic transform owner or to a
  server-side final-HTML boundary.
- Replace Markdown citation injection with context-aware parsing/rendering.
- Add tests for valid HTML and citation-in-link cases.

### Phase 6: Portal Cutover

- Audit `typeof document` branches in overlay components.
- Add `ClientPortal` only if at least two real overlay owners need it.
- Migrate overlays that currently render different server/client structures.
- Do not migrate app content, shell chrome, pane content, or first-paint text.

### Phase 7: Cleanup and Gates

- Delete old helpers and tests that existed only for old APIs.
- Run targeted frontend unit/browser tests.
- Run the hydration E2E route matrix.
- Confirm static search checks for forbidden render-time patterns.

## 13. E2E Acceptance Matrix

Add `e2e/tests/hydration-determinism.spec.ts` and reusable
`e2e/tests/hydration-sentry.ts`.

The sentry attaches before navigation and fails only on hydration diagnostics
from `console.error`, `pageerror`, and an early `addInitScript` console wrapper.
Match at least:

- `Minified React error #418`
- `react.dev/errors/418`
- `Hydration failed`
- `Text content does not match`
- `Text content did not match`
- `server rendered HTML didn't match`
- `Expected server HTML`

Required projects or test contexts:

- desktop Chromium
- mobile Chromium viewport, using the existing `390x844` pattern
- desktop Chromium with Mac user agent
- Chromium with `NexusAndroidShell` user agent token

Required routes:

- `/libraries`, `/conversations`, `/notes`, `/settings/billing`, and
  `/settings/keys` for desktop authenticated shell coverage
- `/libraries` and a reader/transcript route on mobile viewport
- `/settings` for Android-shell filtered navigation
- `/settings/local-vault` for Android-shell local-vault restriction behavior
- `/settings/billing` for prefetched billing text and number/date formatting
- a media route with transcript/show-notes data when fixture data is available
- a conversation/chat route with message dates and citations when fixture data is
  available
- a route that opens the command palette and reads shortcut labels

The spec should reuse existing E2E helpers:

- `e2e/tests/workspace.ts` for device/session isolation
- app auth storage state from existing Playwright setup
- existing seeded media/conversation fixture data where possible
- the YouTube transcript fixture path used by existing transcript E2E coverage
- existing seed scripts before adding hydration-only seed scripts

Example local command:

```sh
make test-e2e PLAYWRIGHT_ARGS='tests/hydration-determinism.spec.ts --project=chromium'
```

The final implementation may add a dedicated Playwright project only if the
route matrix cannot be expressed cleanly inside one spec.

CI should run this through the existing Playwright E2E workflow lane. Do not make
`make verify` the only gate; it does not prove production-browser cold-load
hydration.

## 14. Static Acceptance Checks

After implementation, these searches should produce no forbidden first-render
callers. Some allowed uses in effects, tests, event handlers, and non-render
browser utilities may remain, but every remaining hit must be reviewed.

```sh
rg -n "suppressHydrationWarning|ssr:\\s*false" apps/web/src
rg -n "useIsMobileViewport|isAndroidShell\\(|formatKeyCombo\\([^,]+\\)|loadKeybindings\\(\\)" apps/web/src
rg -n "toLocaleDateString\\(|new Intl\\.NumberFormat\\(\\)" apps/web/src
rg -n "DOMParser" apps/web/src
rg -n "typeof document|createPortal" apps/web/src/components apps/web/src/app
rg -n "window\\.innerWidth|navigator\\.userAgent|localStorage\\.getItem" apps/web/src
```

Passing the search alone is not sufficient. It is a review aid that supports the
behavioral tests.

## 15. Unit and Browser Test Acceptance

Required focused tests:

- Render environment server builder:
  - browser UA -> `shell: "browser"`
  - Android shell UA -> `shell: "android"`
  - Mac/iOS/Android/Windows/Linux platform mapping
- Viewport owner:
  - server snapshot and first client snapshot match
  - post-hydration media-query update changes semantic viewport state
- Keybinding model/provider:
  - default labels are stable for each platform
  - storage overrides apply after hydration
  - event matching uses current bindings
- Android shell:
  - pure restricted href/route behavior remains covered
  - authenticated UI consumes provider state rather than global UA
- Display formatting:
  - dates use explicit locale/time zone
  - invalid dates preserve the existing user-visible fallback behavior
  - numbers use explicit locale
- Transcript show notes:
  - timestamp segments render deterministically
  - seek buttons call the expected callback
- Highlight HTML annotation:
  - annotated HTML output is identical in Node and browser test environments
  - malformed trusted HTML defects at the owned boundary instead of silently
    changing per runtime
- Markdown citations:
  - plain citation renders as citation affordance
  - citation inside existing link does not create nested anchors
  - malformed citation text stays text
- AC-4 parity for loader-backed panes:
  - billing pane hydration-cache hit
  - conversations pane hydration-cache hit
  - settings keys/account panes if they are touched by the final route matrix
- Portal owner:
  - transient overlays mount into the portal in browser mode
  - parent components do not render different first-client structures

Avoid tests that mock internal modules and inspect wiring. Test pure owners
directly, and test integrated UI through browser/E2E behavior.

## 16. Production-Ready Acceptance Criteria

AC-1. The production Playwright hydration spec passes with zero hydration console
messages and zero hydration page errors.

AC-2. No final code path uses hydration suppression, SSR disabling, or mounted
gating as the fix.

AC-3. `AppNav`, `WorkspaceHost`, and `GlobalPlayerFooter` hydrate without
viewport-induced text or structure drift on mobile.

AC-4. Command shortcut labels are stable on first paint for Mac and non-Mac
clients.

AC-5. Android-shell settings and palette restrictions are stable on server HTML
and first client render.

AC-6. Billing date/number output is deterministic with server-prefetched
hydration data.

AC-7. Transcript show-note timestamp controls render deterministically.

AC-8. Highlight annotation renders deterministic sanitized HTML without
browser-only render mutation.

AC-9. Markdown citations render valid, non-nested interactive HTML.

AC-10. Overlay portal behavior is centralized for transient overlays and is not
used as a shell/content hydration escape hatch.

AC-11. Old render-time browser-global APIs are deleted or narrowed so they cannot
be imported by future first-paint UI code.

AC-12. Tests cover the new owners at the smallest meaningful layer and cover the
complete hydration story in E2E.

AC-13. No unrelated pane, auth, API proxy, or Android native behavior changes.

AC-14. The implementation reduces duplication: platform detection, Android-shell
mode, keybinding labels, display formatting, viewport state, HTML annotation,
and portal mounting each have one public owner.

## 17. Key Decisions

D1. Hydration determinism is a capability contract, not a component-by-component
patch.

D2. Browser storage can affect user preferences only after hydration unless the
same value is also available to the server before rendering.

D3. User agent is acceptable for shell/platform because it is available to both
server and client. It is not acceptable for viewport.

D4. Viewport should be solved first with markup-invariant responsive design.
Where that is not practical, use a stable initial snapshot plus post-hydration
measurement.

D5. Default host locale and time zone are not product contracts. First-paint
formatting must use explicit inputs.

D6. Content transforms must be data transforms, not browser-DOM side effects in
render.

D7. Client-only portals are legitimate only for transient overlays with no
server-visible content. They are not a permissible fix for shell, pane, or
first-paint content mismatches.

D8. The E2E sentinel is mandatory. Unit and browser tests cannot prove the
server/client hydration contract alone.

D9. The final state should remove old APIs. Keeping wrappers around old names
would invite future regressions.

## 18. Composition With Neighboring Systems

### Auth and Session

The existing `(authenticated)/layout.tsx` remains the verified-session boundary.
Render environment creation belongs after session verification and before
`AuthenticatedShell` rendering. No browser Supabase client is introduced.

### Workspace Bootstrap

The existing bootstrap path already passes server-derived data to client
providers. Render environment composes with this model. It can be a separate
prop or part of the bootstrap object, but the final ownership must be clear.

### Pane Routing

Pane route resolution remains pure. Static registries do not read runtime browser
state. Shell-dependent labels or restrictions accept shell capability as an
explicit input at selection/render time.

### Theme

Theme remains cookie-owned at the root layout. Do not move theme to the new
provider unless a separate design requires it.

### Android Shell

The Android app already sends the `NexusAndroidShell` UA token. The web app should
consume that token on the server and expose a typed shell capability. No JS bridge
or native HTTP changes are part of this cutover.

### BFF, CSP, and Middleware

No API proxy or CSP weakening is required. Do not add inline scripts or dynamic
client-only loading to avoid hydration.

### Player and Browser APIs

Media Session, clipboard, local audio settings, and other browser APIs may remain
effect/event-handler concerns. They must not affect first-render text or
structure unless their value is server-seeded.

### Hydration Cache

The existing `BootstrapHydrationProvider` remains the data cache owner. This
cutover does not replace it. It ensures components that consume prefetched data
format and branch deterministically.

## 19. SME Implementation Checklist

- Reproduce with production build and record failing route/context.
- Add hydration sentinel that fails before implementation.
- Build the render-environment owner.
- Remove render-time browser global reads from first-paint UI.
- Convert viewport consumers.
- Convert keybinding and platform labels.
- Convert Android-shell consumers.
- Convert display formatting.
- Convert content transforms.
- Delete replaced APIs and tests.
- Run targeted unit/browser tests.
- Run hydration E2E matrix.
- Run static forbidden-pattern searches and review remaining hits.
- Record any deliberate remaining browser global reads with their effect/event
  boundary.

## 20. Review Questions Before Implementation

1. Does any route render user-specific locale or time-zone preferences today? If
   yes, use that existing server-side source. If no, keep the explicit app
   default until a real preference system exists.
2. Can `AppNav`, `WorkspaceHost`, and `GlobalPlayerFooter` be made markup
   invariant with CSS? If yes, prefer that over JS viewport branching.
3. Which seeded media fixture reliably contains transcript show notes with
   timestamps? Use that fixture for the E2E route rather than inventing a
   test-only path.
4. Which conversation fixture contains citations or can be seeded through product
   APIs? Use that route for Markdown citation hydration coverage.
5. Should render environment live as a separate provider or inside the existing
   bootstrap payload? Choose the shape that produces the smallest public surface.

## 21. Explicitly Rejected Fixes

- `suppressHydrationWarning` on command hints, dates, transcript notes, or shell
  chrome.
- `dynamic(..., { ssr: false })` around app nav, workspace, player, settings, or
  media panes.
- `const [mounted, setMounted] = useState(false); if (!mounted) return null`.
- UA-based mobile/desktop guessing.
- Duplicating `isAndroidShell()` checks locally with `typeof navigator`.
- Duplicating date formatter helpers per component.
- Keeping both old `useIsMobileViewport()` and new viewport hooks alive after
  migration.
- Formatting keybindings differently in nav, palette, and settings.
- Catching hydration errors in Playwright without failing the test.

## 22. Definition of Done

The cutover is complete when a production-built E2E run proves the authenticated
shell hydrates without React/Next hydration errors across the acceptance matrix,
all first-render environment concerns have one owner, replaced global helpers are
deleted, and the remaining browser API usage is confined to effects, event
handlers, or external stores with stable first-render snapshots.

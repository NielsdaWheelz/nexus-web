# Android WebView System Insets — Hard Cutover

**Status:** IMPLEMENTED — physical-device acceptance required

**Type:** hard cutover

**Date:** 2026-07-31

**Boundary:** Android web shell plus existing mobile viewport composition; 80/20 slice

No product question blocks implementation. This design assumes the controlled
device runs Android System WebView M144 or newer. An older renderer is an
unsupported environment to update, not a compatibility case.

Follow [`docs/rules/`](../rules/index.md), especially cleanliness, simplicity,
boundaries, frontend, correctness, and the
[testing standards](../local-rules/testing-standards.md).

## Decision

Keep edge-to-edge. Repair its ownership boundary once.

Android passes original `systemBars` and `displayCutout` insets to the
full-window WebView. WebView M144+ publishes them through the four standard CSS
`safe-area-inset-*` values. One root CSS adapter names those values. The
existing `MobileViewportProvider` composes the bottom safe area with Nexus,
Player, and modal-keyboard obstructions. Features consume only those outputs.

```text
Android systemBars + displayCutout
  -> original, unconsumed WindowInsets
  -> WebView M144+ CSS safe-area-inset-*
  -> --viewport-safe-{top,right,bottom,left}
  -> MobileViewportProvider bottom composition
  -> reader / player / Nexus / overlays

Android IME
  -> WebView visual-viewport resize
  -> existing useKeyboardInset / mobile modal lifecycle
  -> existing --mobile-overlay-keyboard-inset
```

Philosophy: paint to the physical edge; keep interactive content inside the
safe rectangle. Platform geometry is boundary data, not feature policy.

This document supersedes only the safe-area/native-system-bar ownership clauses
in the mobile viewport section of [`docs/modules/workspace.md`](../modules/workspace.md).
Reader chrome, Nexus, Player, sheets, and full-screen tasks retain their current
owners and behavior.

## Goals

1. Reader endings, MiniPlayer controls, Nexus, Now Playing, sheets, and task
   controls remain visible and operable above every Android system bar.
2. One native-to-web inset path and one web composition owner exist.
3. Portrait, landscape, cutouts, gesture navigation, and three-button
   navigation obey the same contract.
4. Backgrounds remain edge-to-edge without unsafe hit targets or dead content.
5. The cut deletes duplicate safe-area reads and lowers total complexity.

## Non-goals

- No JavaScript/native message bridge, injected inset payload, or second source
  combined with CSS `env()`.
- No support path, warning screen, or updater UI for WebView before M144.
- No IME, `MobileSheet`, full-screen-task, reader-motion, Player, or Nexus UX
  redesign.
- No immersive mode, hidden system bars, custom navigation bar, predictive
  Back, edge-gesture redesign, or `systemGestures()` composition.
- No foldable hinge/viewport-segment policy, docked side-keyboard support, or
  `safe-area-max-inset-*` browser-chin optimization.
- No target/min SDK change, broad AndroidX upgrade, iOS-specific change,
  backend/API/database schema, feature flag, or analytics.

## Target behavior

| Situation | Required result |
| --- | --- |
| Gesture navigation | Canvas bleeds behind the transparent gesture region; every control stays above its safe bottom edge. |
| Three-button navigation | Android owns the translucent contrast scrim; web controls and final content stay above the full navigation-bar inset. |
| Status bar / top cutout | Existing black native protection and light icons remain; web headers and controls start inside the safe top edge. |
| Landscape / side cutout | Interactive content respects left and right safe edges; no portrait-only bottom assumption. |
| Reader, no Player | Final content and reader commands remain reachable above system UI and Nexus. |
| Reader with Player | Final content clears the larger active obstruction; Nexus sits above Player plus its existing gap. |
| MiniPlayer | Its surface paints to the physical bottom; its interactive row remains inside the safe rectangle. |
| Now Playing / Nexus task / sheet | The frame fills the viewport; header, body, and actions respect all applicable safe edges. |
| Nexus retreats | Its existing transform and inertness remain correct; safe-area changes do not alter the motion policy. |
| IME opens/closes | Existing visual-viewport/keyboard handling keeps focus visible, restores cleanly, and never double-counts the navigation inset. |
| Rotation / resize | Insets and composed clearances update without stale or ghost padding, focus loss, or reader-position jump. |

## Final architecture and contracts

### 1. Android window boundary

- Pin only `androidx.activity:activity-ktx:1.13.0`; keep other dependency and
  SDK versions unchanged.
- Call `enableEdgeToEdge(...)` before `super.onCreate`.
- Use a transparent, light-icon status style and the automatic navigation
  style forced to dark appearance. Result: transparent gesture navigation,
  platform contrast scrim for button navigation, light icons throughout.
- Keep the accessibility-hidden black status protection as an overlay. Size it
  from `systemBars | displayCutout` top. It never pads or resizes the WebView.
- Keep the WebView and root at full window bounds.
- Root and WebView inset listeners return the exact original `WindowInsets`.
  Never consume, zero, copy, serialize, or convert them in app code.
- Delete `configureStatusBarColor`, deprecated `window.statusBarColor`, manual
  `setDecorFitsSystemWindows(false)`, and manual icon-controller setup replaced
  by `enableEdgeToEdge`.
- Add no bottom protection view. The system owns three-button protection; the
  web surface owns edge-to-edge paint.

Reference setup:

```kotlin
enableEdgeToEdge(
    statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    navigationBarStyle = SystemBarStyle.auto(
        lightScrim = Color.BLACK,
        darkScrim = Color.BLACK,
        detectDarkMode = { true },
    ),
)
```

### 2. CSS platform schema

`apps/web/src/app/globals.css` is the sole raw safe-area adapter:

```css
--viewport-safe-top: env(safe-area-inset-top);
--viewport-safe-right: env(safe-area-inset-right);
--viewport-safe-bottom: env(safe-area-inset-bottom);
--viewport-safe-left: env(safe-area-inset-left);

--mobile-content-bottom-clearance: var(--viewport-safe-bottom);
--mobile-nexus-bottom-offset: var(--viewport-safe-bottom);
--mobile-overlay-keyboard-inset: 0px;
```

Rules:

- No component, hook, or module outside `globals.css` reads
  `env(safe-area-inset-*)`.
- Consumers use the canonical token without a numeric or `env()` fallback.
- Top/side/full-screen geometry consumes `--viewport-safe-*` directly.
- Ordinary mobile scroll owners consume
  `--mobile-content-bottom-clearance`, never the raw bottom token.
- Fixed Nexus consumes `--mobile-nexus-bottom-offset` plus its existing gap.
- Background paint may cross a safe edge. Text, controls, selection handles,
  focused targets, and terminal scroll content may not.
- No hard-coded status/navigation-bar height exists.

### 3. Mobile viewport composition

Keep the public capability unchanged:

```ts
type MobileFixedObstructionId = "Nexus" | "Player";

interface MobileViewportCapability {
  registerFixedObstruction(
    id: MobileFixedObstructionId,
    element: HTMLElement,
  ): () => void;
  reportMobileOverlayKeyboardInset(px: number): () => void;
}
```

Keep `model.ts`, obstruction measurement, duplicate-registration defects,
ordered keyboard reports, and `window.innerHeight` projection unchanged.

Only change the two composed publications:

```text
--mobile-content-bottom-clearance
  = max(--viewport-safe-bottom, Nexus rect, Player rect, active overlay keyboard)

--mobile-nexus-bottom-offset
  = max(--viewport-safe-bottom, Player rect)
```

On provider teardown, removing inline publications reveals the root safe-area
defaults. There is no transient zero state and no second platform-inset store.

### 4. Intra-system composition

| Consumer family | Input | Rule |
| --- | --- | --- |
| Reader/chat/PDF/collection scroll roots | `--mobile-content-bottom-clearance` | Apply terminal padding and scroll padding at the real scroll owner. |
| MiniPlayer | `--viewport-safe-bottom` | Safe-area space belongs inside the player surface; the registered rect therefore includes it. |
| Nexus wrapper | `--mobile-nexus-bottom-offset`, `--viewport-safe-right` | Preserve current 48 px wrapper, gap, measurement, and retreat distance. |
| Full-screen tasks / Now Playing | four `--viewport-safe-*` tokens | One frame; page-owned header/body apply the appropriate edge. |
| MobileSheet | `--viewport-safe-bottom` plus existing keyboard token | Safe area and IME remain distinct inputs; preserve shrink behavior. |
| FloatingActionSurface | root tokens plus composed bottom clearance | Read token-computed pixels from its existing probe; do not read `env()` directly or add a store. |

Features never branch on Android, navigation mode, WebView version, OEM, or
shell capability.

## Scope and files

| Area | Files / action |
| --- | --- |
| Native setup | `apps/android/app/build.gradle.kts`; `MainActivity.kt`; `SystemInsetsTest.kt` |
| CSS owner/composer | `apps/web/src/app/globals.css`; `lib/mobileViewport/MobileViewportProvider.tsx`; `mobileSafeArea.browser.test.tsx` |
| Direct-read cut | `SelectionPopover.module.css`; `AppNav.module.css`; `AddPanel.module.css`; `Nexus.module.css`; `MobileMiniPlayer.module.css`; `MobileNowPlaying.module.css`; `ShareOverlay.module.css`; `switchboard.module.css`; `FloatingActionSurface.tsx`; `HoverPreview.module.css`; `MobileSheet.module.css`; `PaneShell.module.css` |
| Normative docs | `docs/modules/workspace.md`; update overlapping module prose only after proof |

Do not touch `mobileViewport/model.ts`, feature state/controllers, reader
motion, player runtime, Nexus controller, overlay lifecycle, backend, or schema
files unless demonstrated-red evidence disproves this boundary diagnosis. Stop
and revise this spec before expanding scope.

## Implementation plan

1. **Demonstrate red on the affected device.** Record OS/API, OEM/model,
   navigation mode, orientation, System WebView package/version, native
   `systemBars/displayCutout/ime`, CSS safe-area values, layout/visual viewport,
   and actual Nexus/Player/reader control rectangles. A missing device is
   `not_run`, not green.
2. **Repair native dispatch.** Pin Activity, install modern edge-to-edge styles,
   preserve the top overlay, and forward original insets to the WebView.
3. **Hard-cut web ownership.** Define four root tokens, replace every direct
   safe-area read, and make provider publications compose from the root bottom
   token. Delete old fallbacks and obsolete tests/comments.
4. **Prove the boundary.** Add one real-WebView instrumentation fixture and
   update focused web owner tests. Do not add production diagnostic APIs,
   test-only selectors, delays, or mocks of the native/WebView handoff.
5. **Physical acceptance, residue search, docs.** Run the matrix below, then
   update `workspace.md` to the final ownership model.

## Acceptance criteria

### Demonstrated-red and automated proof

- Before the fix, the affected-device capture shows at least one real control
  or terminal content rectangle intersecting native system UI. Preserve the
  capture with the test evidence.
- Android instrumentation loads an inline `viewport-fit=cover` probe page in
  the real WebView; no production seam or network server is used.
- For each side, `CSS safe inset * window.devicePixelRatio` equals the native
  `systemBars | displayCutout` inset within one physical pixel.
- A fixed probe control's rectangle is wholly inside the CSS safe rectangle.
- The WebView/root still equal window bounds; the top protection is black,
  accessibility-hidden, and exactly the combined top inset; system icons are
  light.
- Rotate once and prove old inset values are cleared rather than retained.
- Focused provider tests prove safe-area-only, Player, Nexus, keyboard, stacked
  keyboard report, unregister, and teardown composition.
- Existing focused reader chrome, Player surface, Nexus, sheet, and
  `FloatingActionSurface` tests remain green. Browser-only tests do not claim
  native handoff coverage.

### Physical-device matrix

Run on the affected phone with System WebView M144+:

- gesture and three-button navigation;
- portrait and landscape/cutout;
- Player absent/present;
- Nexus visible/retreated;
- reader at final content, MiniPlayer, Now Playing, Nexus full-screen task,
  one sheet, and one root text-entry flow;
- IME open/close and rotation while focused;
- reduced motion; TalkBack as a separate accessibility smoke.

For every state:

- all visible interactive rectangles fit inside the safe rectangle;
- final scroll content can be exposed, focused, and activated;
- no control is hidden behind system UI and no phantom bottom gap appears;
- canvas/player backgrounds reach the physical edge as designed;
- Nexus remains above Player and preserves its current motion/inertness;
- IME dismissal restores the exact pre-IME platform clearance;
- no reader position, selection, playback, focus, or Back behavior regresses.

Capture one screenshot per navigation mode and record the WebView version.
Absent physical-device evidence leaves acceptance incomplete.

### Hard-cut residue

```sh
rg -n 'env\(safe-area-inset-' apps/web/src
# exactly four declarations in apps/web/src/app/globals.css

rg -n 'setDecorFitsSystemWindows|statusBarColor|nexusViewport|native.*inset|inset.*bridge' \
  apps/android/app/src/main apps/web/src
# no superseded inset path
```

No compatibility branch, native inset payload/schema, feature-local safe-area
formula, navigation-mode conditional, magic bar height, stale owner comment, or
dead test remains.

## Primary references

- [Android edge-to-edge views](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- [Android WebView window insets](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)
- [Chromium WebView inset contract](https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/insets.md)
- [AndroidX `enableEdgeToEdge`](https://developer.android.com/reference/androidx/activity/EdgeToEdge)
- [AndroidX Activity releases](https://developer.android.com/jetpack/androidx/releases/activity)
- [Chrome edge-to-edge CSS guidance](https://developer.chrome.com/docs/css-ui/edge-to-edge)

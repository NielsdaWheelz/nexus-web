# Android WebView System Insets — Hard Cutover

**Status:** IMPLEMENTED — M144 boundary accepted; signed product and release blocked

**Last verified:** 2026-08-02

**Boundary:** Android system insets, existing mobile viewport composition, and
exact-artifact Android release; 80/20 slice

Follow [`docs/rules/`](../rules/index.md) and the
[testing standards](../local-rules/testing-standards.md). This is the sole
governing cutover document for this concern.

## Questions and assumptions

No product question blocks implementation.

- The controlled device runs Android System WebView M144 or newer. Older
  WebView is an environment to update, not a compatibility target.
- Nexus remains a self-distributed, one-user APK using the existing GitHub
  Release workflow and signing identity.
- Edge-to-edge paint is intentional. Only interactive/content geometry stays
  inside the safe rectangle.
- The current source architecture is the intended final architecture. Scope is
  proof, immutable release, and demonstrated defects only.

Stop and revise this spec before adding a native bridge, updater/version API,
feature flag, second inset store, or feature redesign.

## Decision and philosophy

Repair platform geometry once, at its boundary; compose product obstructions
once, at the root; let features consume policy-free outputs.

```text
Android systemBars | displayCutout
  -> original, unconsumed WindowInsets
  -> full-window WebView M144+ / viewport-fit=cover
  -> CSS safe-area-inset-*
  -> --viewport-safe-{top,right,bottom,left}
  -> MobileViewportProvider + Nexus / Player / overlay keyboard
  -> reader, panes, player, Nexus, tasks, sheets
```

The platform owns unsafe geometry. The app owns composition. Features never
infer bar heights, navigation mode, OEM, Android, or WebView version.

## Goals

1. Terminal reader content and every playback/Nexus/overlay control remain
   visible, focusable, and operable outside Android system UI.
2. Preserve edge-to-edge backgrounds in gesture and three-button navigation.
3. Keep one native handoff, one raw CSS adapter, and one obstruction composer.
4. Promote the exact signed APK physically accepted on the device.
5. Delete the superseded proof/release paths; add no compatibility path.

## Target behavior

| State | Required result |
| --- | --- |
| Gesture navigation | Canvas may bleed behind the gesture region; content and controls do not. |
| Three-button navigation | Android owns its contrast scrim; the full navigation inset remains clear. |
| Top bar / cutout | Black native protection and light icons remain; web interaction starts inside the safe top. |
| Landscape / side cutout | Left/right safe edges are honored without portrait-specific branching. |
| Reader / PDF / panes | Terminal content clears the largest active bottom obstruction and can be selected/activated. |
| MiniPlayer / Nexus | Player includes its own safe bottom; Nexus remains above Player plus its existing gap. |
| Tasks / Now Playing / sheets | Background fills the frame; header, body, and actions honor applicable safe edges. |
| IME open/close | Existing visual-viewport path keeps focus visible and restores exact pre-IME clearance without double counting. |
| Rotation / resize | Current insets replace old insets; no ghost gap, overlap, focus loss, or reader-position jump. |

## Final architecture

### Native boundary

`MainActivity` owns Android window policy.

- `enableEdgeToEdge` runs before `super.onCreate`.
- Root and WebView retain full window bounds.
- The root listener returns the exact original `WindowInsets`; the full-window
  WebView receives and returns them unconsumed. App code does not copy,
  serialize, convert, or inject them.
- The accessibility-hidden black top protection is sized from
  `systemBars | displayCutout` top and never pads the WebView.
- No bottom protection view exists. Android owns three-button protection.

### Platform schema

`apps/web/src/app/globals.css` is the sole raw safe-area adapter:

```css
--viewport-safe-top: env(safe-area-inset-top);
--viewport-safe-right: env(safe-area-inset-right);
--viewport-safe-bottom: env(safe-area-inset-bottom);
--viewport-safe-left: env(safe-area-inset-left);
```

No other production file may read `env(safe-area-inset-*)`. There is no native
payload, JavaScript bridge, persisted schema, backend API, or capability/version
negotiation.

### Composition capability

Keep the existing public API exactly:

```ts
type MobileFixedObstructionId = "Nexus" | "Player";

interface MobileViewportCapability {
  registerFixedObstruction(
    id: MobileFixedObstructionId,
    element: HTMLElement,
  ): () => void;
  reportMobileOverlayKeyboardInset(px: number): () => void;
  subscribeContentBottomClearance(listener: () => void): () => void;
}
```

`MobileViewportProvider` remains the sole composer:

```text
--mobile-content-bottom-clearance
  = max(safe bottom, Nexus rect, Player rect, active overlay keyboard)

--mobile-nexus-bottom-offset
  = max(safe bottom, Player rect)
```

Duplicate obstruction identity is a defect. Teardown removes inline
publications and reveals root safe-area defaults. IME and system bars remain
distinct inputs.

### Consumer contract

| Owner | Input and rule |
| --- | --- |
| Reader, chat, PDF, pane scroll roots | Use composed content clearance for terminal padding and scroll padding at the real scroll owner. |
| MiniPlayer | Put safe-bottom space inside the registered Player surface. |
| Nexus | Use composed Nexus offset and existing gap; preserve retreat/inertness behavior. |
| Full-screen tasks / Now Playing | Use the four root safe tokens at the frame-owned edge. |
| MobileSheet | Compose root safe bottom with the existing keyboard token; preserve shrink behavior. |
| Floating surfaces | Reuse the existing root-token probe/subscription; add no store or platform branch. |

Background paint may cross a safe edge. Text, controls, focus targets,
selection handles, and terminal scroll content may not.

## Release capability contract

Hard-cut `.github/workflows/android-release.yml` to two exclusive modes:

1. **Build draft:** an `android-v*` tag builds, signs, verifies, hashes, and
   uploads one draft APK plus a plain one-line `nexus-android.commit` witness
   for its resolved tag commit. Existing assets are never clobbered.
2. **Promote stable:** manual dispatch receives `tag` and
   `verified_apk_sha256`, downloads the existing draft assets and commit
   witness, validates each, resolves the annotated tag commit, requires exact
   witness equality, then verifies the supplied device-accepted hash before
   publishing. It never checks out, builds, signs, uploads, or mutates assets.

The tag commit, APK version name/code, signer, and SHA-256 are release facts.
Promotion reuses those facts; it does not derive replacements. A mismatch
fails closed. Invalid drafts are deleted and rebuilt explicitly, never repaired
in place. `nexus-android.commit` is release-internal evidence, never a
distribution contract, updater manifest, app API, or client capability.

No updater service, rollout channel, manifest protocol, or compatibility lane
is added.

## Scope and files

| Action | Files |
| --- | --- |
| Correct the independent physical oracle | `apps/android/app/src/androidTest/java/app/nexus/android/MainActivityTest.kt` |
| Make exact-artifact promotion immutable | `.github/workflows/android-release.yml` |
| Landscape safe-side owners | `apps/web/src/components/workspace/PaneShell.module.css`; `apps/web/src/components/appnav/AppNav.module.css`; `apps/web/src/components/player/MobileMiniPlayer.module.css` |
| Focused safe-side proof | `apps/web/src/components/workspace/PaneShell.mobileChrome.browser.test.tsx`; `e2e/tests/mobile-reader-chrome.spec.ts` |
| Record final contract and release evidence | this file; `docs/modules/workspace.md`; `README.md` only where current distribution prose changes |

No planned backend, database, API, reader-state, playback-runtime, Nexus-state,
motion, overlay-lifecycle, SDK, target/min SDK, or dependency change exists.

## Hard-cut plan

1. Replace the density-naive fixed one-physical-pixel equality oracle. For each
   edge, independently prove: CSS never under-protects native geometry;
   conservative excess is less than one CSS pixel in physical units; native
   zero clears to CSS zero. Keep the safe-control and full-window assertions.
   Do not merely widen a constant tolerance.
2. Demonstrate oracle sensitivity: a representative under-protected edge and a
   retained stale inset must each fail.
3. Run focused Android, web compositor, reader/player/Nexus/sheet, static, and
   workflow checks. Delete obsolete exact-equality and asset-clobber paths.
4. Tag the intended SHA. Let the existing signing workflow create one draft.
5. Install that draft, record its SHA-256, and run physical acceptance.
6. Promote only the signed, physically accepted hash.

Any current signed-product failure expands scope only to its demonstrated
owner. Revise this document before crossing another boundary.

## Acceptance criteria

### Automated boundary proof

- All three M144 WebView scenarios pass on the controlled device: actual
  insets, same-renderer nonzero-to-zero clearing, and rotation recreation.
- For every edge, `css_px * devicePixelRatio >= native_physical_px`, excess is
  `< devicePixelRatio` (allowing only floating-point comparison epsilon), and
  native zero yields CSS zero.
- The probe control is wholly inside the CSS safe rectangle; WebView/root equal
  window bounds; top protection and icon behavior are correct.
- Focused web tests cover safe-only, Player, Nexus, keyboard, stacked reports,
  unregister, teardown, and named consumers.
- `make check-android`, focused frontend checks, `make check-workflows`, and the
  signed release proof pass. Each proof is reported separately.

### Signed physical product

On the affected phone with M144+ WebView, verify the signed draft APK in
gesture and three-button navigation, portrait and landscape, Player
absent/present, Nexus visible/retreated, reader terminal content, MiniPlayer,
Now Playing, one Nexus task, one sheet, and one root text-entry flow.

- Every visible interactive/content rectangle is outside native system UI.
- Terminal content can be exposed, focused, selected, and activated.
- Backgrounds reach intended physical edges; no phantom gap appears.
- IME dismissal restores exact pre-IME clearance.
- Rotation does not retain prior-edge insets or disturb content position.
- Playback, selection, focus, Back, Nexus motion/inertness, reduced motion, and
  a TalkBack smoke do not regress.
- Record OS/device, navigation mode, orientation, WebView version, tag SHA,
  signer, APK version, APK SHA-256, and one screenshot per navigation mode.

### Release proof

- The stable APK SHA-256 equals the physically accepted draft SHA-256.
- The draft `nexus-android.commit` witness is one valid commit SHA and equals
  the commit currently resolved by the annotated release tag.
- Stable promotion performs no build, signing, upload, or asset clobber.
- The release tag resolves to the recorded commit and the stable install URL
  serves the recorded signer/version/hash.

### Hard-cut residue

```sh
rg -n 'env\(safe-area-inset-' apps/web/src
# exactly four declarations in apps/web/src/app/globals.css

rg -n 'setDecorFitsSystemWindows|statusBarColor|nexusViewport|native.*inset|inset.*bridge' \
  apps/android/app/src/main apps/web/src
# no superseded inset path
```

No compatibility branch, inset payload/schema, feature-local safe formula,
navigation-mode conditional, magic bar height, rebuild-on-promote path,
`--clobber`, stale owner prose, dead proof, or client-facing commit manifest
remains.

## Current demonstrated evidence

- 2026-08-02: Samsung Galaxy S22+ SM-S906W, Android 16/API 36, three-button
  navigation (`mode=0`), 1080x2340, physical density 450/override 480, and
  System WebView `150.0.7871.181`.
- Sensitivity red: right CSS 14 px at DPR 3 produced 42 physical px against a
  native 43 px inset; native zero with retained left CSS 6 px produced 18
  physical px. Both failed with the intended diagnostics.
- Same-renderer clearing passed 1/1; the full `RequiresWebViewM144` lane passed
  3/3 in 57 seconds.
- Signed `android-v0.2.7` remained red on the same phone in landscape
  three-button navigation: the native left system bar occupied physical
  `[0,0][144,1080]`; pane Back `[24,90][168,237]`, the Lectern clickable row
  beginning at x=72, and MiniPlayer Open beginning at x=36 intersected
  `[0,144)`.
- The scoped CSS correction keeps pane/chrome/player backgrounds and progress
  full bleed while their existing body, contextual/app-bar, MiniPlayer row,
  and status-row owners apply physical left/right safe tokens to content and
  controls. It adds no bridge, store, or platform branch.
- Focused green: `cd apps/web && bun run test:browser --
  src/components/workspace/PaneShell.mobileChrome.browser.test.tsx` passed 1/1
  in 2.61 seconds; `make test-e2e PLAYWRIGHT_ARGS='tests/mobile-reader-chrome.spec.ts
  --project=mobile-chrome --grep "active global player preserves"'` passed
  setup plus the grepped case, 2/2 in 2.4 minutes. Scoped ESLint, CSS token
  lint, and E2E `tsc --noEmit` passed.
- Repo-wide web TypeScript was stopped on the unrelated baseline
  `src/__tests__/components/PaneShell.test.tsx:556` (`HTMLElement.labels`); it
  is not scoped proof or a new feature red.
- This accepts only the M144 native-to-CSS boundary. The correction is not yet
  accepted on a deployed current SHA or fresh signed draft; product matrix and
  release promotion remain blocked.

## Non-goals

- No reader/listener/TTS UX, reader chrome, Nexus, Player, sheet, keyboard,
  motion, predictive Back, or edge-gesture redesign.
- No immersive mode, hidden bars, custom navigation bar, foldable hinge,
  viewport-segment, side-keyboard, or browser-chin optimization.
- No WebView-before-M144 fallback, warning, updater, telemetry, feature flag,
  bridge, dual path, or backward compatibility.
- No broad AndroidX/SDK upgrade, iOS-specific work, backend, API, or schema.

## Primary references

- [Android edge-to-edge views](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- [Android WebView window insets](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)
- [Chromium WebView inset contract](https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/insets.md)
- [AndroidX `enableEdgeToEdge`](https://developer.android.com/reference/androidx/activity/EdgeToEdge)

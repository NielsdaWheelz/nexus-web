# Mobile Reader Position Ribbon Hard Cutover

Status: IMPLEMENTED — focused software and Android ribbon proof complete;
manual reviews pending — 2026-08-02

Type: one frontend hard cutover. No flag, compatibility path, fallback
position model, or mixed presentation.

Date: 2026-08-02

No blocking product question remains. The decisions below are locked.

Follow all of [`docs/rules/`](../rules/index.md), especially cleanliness,
simplicity, frontend, correctness, and naming, plus the Nexus-owned
[`testing-standards.md`](../local-rules/testing-standards.md).

Depend on the implemented ownership contract in
[`mobile-reader-unified-scroll-chrome-hard-cutover.md`](mobile-reader-unified-scroll-chrome-hard-cutover.md),
not its remaining exhaustive physical certification. Universal Switch,
external keyboard, fling/selection, navigation mode, and broad accessibility
review remain external project/release dependencies, not ribbon-thread
implementation scope. Do not implement the cuts concurrently in
`MediaPaneBody` or reader geometry.

## Decision

Mobile readable Web, EPUB, and PDF surfaces have one quiet horizontal
**position ribbon**. It projects the existing exact semantic viewport onto the
whole document. It is orientation, not completion and not navigation.

The ribbon is reader-owned and reader-relative. It is not workspace fixed chrome
and never attaches to the physical viewport edge.

SUPERSEDED — the clause placing the ribbon at the upper boundary of the composed
mobile bottom clearance is replaced by
[`mobile-reader-bottom-geometry-hard-cutover.md`](mobile-reader-bottom-geometry-hard-cutover.md).
The ribbon now paints at the reader surface bottom (`bottom: 0`), consumes no
bottom clearance, and may be covered by a higher-priority surface. Every
bottom-placement clause below carries the same supersession; this document
remains authoritative for the semantic range, band model, and presentation
tokens.

## Goals

- Preserve place while reader chrome recedes.
- Match the desktop overview rail's semantic viewport-band model.
- Reuse the canonical source-coordinate projection and the mobile bottom
  geometry owner without creating another owner. SUPERSEDED: the ribbon reuses
  the projection only; it takes no bottom-geometry input.
- Add no persistence, network, format, or scroll-discovery capability.

## Target behavior

| Situation | Required result |
| --- | --- |
| Exact mobile Web/EPUB/PDF viewport | One full-document track and one band spanning semantic `start..end` |
| Trusted scroll, restore, Preview, or Return | Band follows the published viewport; presentation writes no reader state |
| Chrome retreats | Ribbon remains stable and subdued |
| Nexus, MiniPlayer, safe area, or keyboard changes | SUPERSEDED: the ribbon stays at the reader surface bottom and does not move; those surfaces change terminal content clearance only |
| Sheet, dialog, selection UI, or progress handoff overlaps it | Owning overlay paints above the ribbon |
| Short document | Exact range may span the full track |
| Missing or mismatched semantic range | Ribbon is absent; never zeroed or approximated |
| Desktop | Existing Document Map overview rail is unchanged; no ribbon mounts |
| Transcript, loading, not-readable, or error | No ribbon mounts |
| RTL | Normalized zero maps to logical inline start |
| Forced colors | Track and band remain distinguishable with system colors |

## Capability contract

Reuse `ReaderDocumentOverviewRange` and `projectReaderDocumentRange` from
`readerDocumentPosition.ts`. Add no domain type.

```ts
interface MobileReaderPositionRibbonProps {
  readonly visibleRange: ReaderDocumentOverviewRange;
}
```

The component:

- accepts only a valid projected range;
- owns only horizontal rendering;
- contains no hook, state, effect, observer, event handler, format branch, or
  source-coordinate projection or position discovery;
- renders one noninteractive root and one band;
- is `aria-hidden="true"` and `pointer-events: none` with no ARIA role or live
  region.

`MediaPaneBody` owns the single render gate:

```ts
const showMobileReaderPositionRibbon =
  isMobileViewport &&
  readerCapability.state === "Readable" &&
  !isTranscriptMedia &&
  readerDocumentVisibleRange !== null;
```

Do not gate on Document Map markers, `documentMapAvailable`, Consumption,
saved cursor state, or playback state.

## Final composition

```text
format-owned viewport capture
  -> ReaderSemanticViewport
  -> projectReaderDocumentRange
  -> readerDocumentVisibleRange
       -> desktop Document Map overview rail
       -> mobile reader position ribbon

MobileViewportProvider
  -> SUPERSEDED: no input to ribbon placement
  -> element-local --mobile-content-bottom-clearance
  -> terminal reader content only

PaneShell
  -> physical safe-left/right padding
  -> already-safe reader column
  -> ribbon inline span only
```

- `MediaPaneBody` remains the composition owner.
- `PaneShell` remains the sole horizontal side-safe owner. `.readerColumn`
  remains the already-safe relative containing block.
- The ribbon is a sibling of the format reader and
  `ReaderProgressHandoff`, after the format reader in DOM order.
- The ribbon root spans the full reader column with `inset-inline: 0` and uses
  `bottom: 0` — SUPERSEDED from
  `bottom: var(--mobile-content-bottom-clearance)` by
  [`mobile-reader-bottom-geometry-hard-cutover.md`](mobile-reader-bottom-geometry-hard-cutover.md).
  It does not consume the physical safe-left/right tokens again.
- The band uses logical inline positioning. Use the projected values directly;
  do not mirror them in TypeScript.
- Use a 2px track, a 2px rounded accent band, and a 2px minimum visible band.
  Use the reachable global edge/accent tokens. Band-to-track contrast is at
  least 3:1 in shipped themes.
- Use local `z-index: 2`: above artifact content; below transition chrome
  (`3`), handoff/error overlays (`4`), and modal layers.
- Add no transition or animation. Reduced-motion behavior is therefore
  identical.

## APIs and state

No backend, HTTP, DTO, schema, database, persistence, URL, workspace state,
analytics, or environment API changes.

The visible range remains derived state. Rename the current local
`documentMapVisibleRange` to `readerDocumentVisibleRange` and hard-cut every
local reference. Add no alias.

Preview, Return, and Restore may move the ribbon because they publish current
position. Existing intent fences continue preventing those movements from
writing cursor, progress, completion, or activity.

## Reuse and removal

- Reuse the existing semantic viewport publication, projection helper, mobile
  viewport classification, clearance token, reachable global tokens, and stacking
  context.
- Do not rotate, parameterize, or share the desktop rail component. It owns
  markers, vertical keyboard behavior, clustering, tooltips, measurement, and
  interaction that the ribbon must not acquire.
- Do not reuse or generalize `PlayerMiniProgress`. Playback time and reader
  place are different capabilities. Small local CSS duplication is cheaper
  than a hollow cross-domain abstraction.
- Remove stale documentation saying mobile has no rail. The final wording is:
  mobile has no interactive Document Map overview rail; it has one passive
  reader position ribbon.
- No existing runtime path is replaced. If implementation discovers an older
  mobile reader progress bar, listener, ratio helper, style, or test seam,
  delete it rather than retaining or adapting both paths.

## Scope

Create:

- `apps/web/src/components/reader/MobileReaderPositionRibbon.tsx`
- `apps/web/src/components/reader/MobileReaderPositionRibbon.module.css`
- `apps/web/src/components/reader/MobileReaderPositionRibbon.browser.test.tsx`

Modify:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/e2e/journeys/mobile-reader-bottom-geometry.journey.spec.ts`
- `docs/modules/reader-implementation.md`
- `docs/modules/workspace.md`
- `docs/cutovers/reader-document-map-canonical-position-hard-cutover.md`
- this document: status and retained proof only

Predecessor ownership resolution — 2026-08-02:

The Android inset hard cut landed on `main` before this feature. It now owns
native-to-CSS outward quantization, stale-zero clearing, physical evidence, and
release status. This feature retains no parallel Android test helper or inset
cutover narrative. `mobile-reader-unified-scroll-chrome-hard-cutover.md` and
the durable module docs receive only the final reader-composition wording.

Adversarial final-audit scope amendment — 2026-08-02:

- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/components/PdfReader.tsx`
- the narrow existing component/E2E proofs that own these contracts

The final runtime audit proved two predecessor-owner failures that directly
violate this cutover's acceptance contract. Canonical mobile classification
includes coarse-pointer landscape widths through 900px, while Web/EPUB and PDF
terminal-content clearance stopped at 768px. PDF runtime errors could also
replace a previously positioned viewport without clearing its published
semantic viewport. Hard-cut both owner contracts: use the canonical mobile
media query for reader terminal clearance, and publish a null semantic viewport
whenever the PDF runtime enters its error surface. Prove the 769–900px coarse
landscape case and the valid-range-then-error transition at the narrowest real
owned boundary. Do not add a ribbon-local workaround or compatibility path.

Do not modify `readerDocumentPosition.ts`, format readers, viewport providers,
pane publications, player code, backend code, fixtures, or schemas unless a
failed acceptance criterion proves the owning contract is wrong. Amend this
spec before widening scope.

## Non-goals

- Filled completion bars, high-water/read-wear layers, Finished state, streaks,
  goals, or gamification.
- Percentage or time-remaining text.
- Markers, chapters, bookmarks, highlights, citations, or connections.
- Tap, drag, scrub, seek, hover, tooltip, focus, or keyboard behavior.
- Return-to-place UI or changes to cross-device handoff.
- Transcript support or scrollbar-ratio fallback.
- User preferences, flags, experiments, telemetry, ML, gaze, or analytics.
- CSS Scroll Timeline, another scroll listener, observer, RAF, or geometry
  service.
- Audio MiniPlayer progress relocation.

## Acceptance criteria

### Contract

- Exactly one ribbon mounts for an exact mobile readable Web, EPUB, or PDF
  range; none mounts for every excluded state.
- Band start and width equal the supplied semantic range within browser layout
  precision, except that a sub-2px span expands inward to the required 2px
  visual minimum. No reader scroll geometry is read.
- The ribbon cannot receive pointer or accessibility focus and emits no live
  announcement.
- Preview/Return/Restore repaint it without cursor, progress, completion, or
  activity writes.
- Desktop rail behavior, width publication, markers, and navigation are
  unchanged.
- No content, final line, selection surface, handoff, Nexus, MiniPlayer,
  keyboard, safe area, or sheet is obscured.

### Proof

- Chromium component proof owns horizontal geometry, RTL, forced colors,
  decorative semantics, and stacking/clearance behavior.
- `MediaPaneBody` proof covers mobile Web/EPUB/PDF exactly once, transcript and
  null/non-readable absence, and desktop preservation.
- Extend one existing Pixel 7 Web/MiniPlayer/Nexus journey to prove trusted
  scroll movement, retreat stability, and composed clearance. Extend the
  existing PDF safe-area journey for portrait-to-landscape placement. Do not
  duplicate pure projection or format-gating cases in E2E.
- Focused Android WebView ribbon geometry and trusted-touch review is the
  physical implementation proof. Manual iOS Safari/VoiceOver and remaining
  hands-on accessibility review remain pending external project/release
  dependencies; do not duplicate the predecessor's exhaustive matrix here.

Required commands:

```bash
cd apps/web && bunx eslint --max-warnings 0 \
  src/components/reader/MobileReaderPositionRibbon.tsx \
  src/components/reader/MobileReaderPositionRibbon.browser.test.tsx \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx'
cd apps/web && node scripts/check-css-tokens.mjs
cd apps/web && bunx vitest run --project browser \
  src/components/reader/MobileReaderPositionRibbon.browser.test.tsx \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' \
  -t 'MobileReaderPositionRibbon|mobile position ribbon|passive PDF viewport|desktop rail without'
make test-e2e \
  PLAYWRIGHT_ARGS='journeys/mobile-reader-bottom-geometry.journey.spec.ts --project=mobile-chrome'
git diff --check
```

## Final-state gates

The focused ribbon implementation is complete only when:

- source, browser, trusted journey, and focused Android ribbon
  geometry/trusted-touch proof pass;
- current module docs describe the final state without contradictory
  mobile-no-rail language;
- searches find no second reader-position calculation, compatibility branch,
  approximate fallback, interactive ribbon semantics, or obsolete local name;
- this document records implementation evidence and status `IMPLEMENTED`.

## Retained implementation evidence

- Exact frontend ESLint and CSS-token validation pass. The exact E2E TypeScript
  command `cd e2e && bunx tsc --noEmit -p tsconfig.json` passes.
- Shipped global-token contrast is 6.961:1 in dark and 4.847:1 in light.
- Focused Chromium ribbon/composition proof: 19 passed, 96 unrelated cases
  skipped. Focused PDF error-invalidation proof: 1 passed, 20 unrelated cases
  skipped.
- Supported real-stack runner: both selected mobile journeys plus auth setup
  passed, 3 total.
- `git diff --check` and hard-cut residue searches pass.
- Physical Samsung landscape review found a stale predecessor-composition
  defect: the already-safe 707px reader column was inset by the 25px/48px
  physical safe sides a second time, compressing the ribbon to 634px. The
  corrected source contract keeps `PaneShell` as the sole horizontal safe-side
  owner and spans the full already-safe reader column.
- Sensitivity was demonstrated before the owner fixes: the coarse-landscape
  terminal checks measured 138px of PDF overlap and 77.5px of Web overlap, and
  the PDF runtime-error regression observed no null semantic-viewport
  publication. The corrected contracts pass those same proofs. The ribbon
  rerender proof uses independent Chromium layout geometry and rejects both the
  old start and old width.
- A physical Samsung SM-S906W running Android 16 and System WebView
  150.0.7871.181 passed the upstream-owned predecessor M144 annotation matrix,
  3 of 3. Focused ribbon geometry and trusted-touch evidence also passed. The
  original production Android package remained installed and unchanged.
  Physical iOS Safari/VoiceOver review was unavailable; remaining hands-on
  accessibility reviews and predecessor physical matrices remain pending
  external project/release dependencies.

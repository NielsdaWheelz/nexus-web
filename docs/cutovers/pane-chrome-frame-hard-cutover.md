# Pane Chrome Frame Hard Cutover

Status: IMPLEMENTED — 2026-07-31
Type: atomic hard cutover

> **Refinement-row update (2026-08-02):**
> [`library-entry-type-filter-and-filter-row-reflow-hard-cutover.md`](library-entry-type-filter-and-filter-row-reflow-hard-cutover.md)
> supersedes the single-line/local-inline-overflow rule for `FilterRows` only.
> Refinement rows reflow; `FindOccurrences` and reader instruments retain the
> single-line instrument contract.

> **Canonical-action update (2026-08-05):**
> [`canonical-resource-action-menu-hard-cutover.md`](canonical-resource-action-menu-hard-cutover.md)
> supersedes this document's `ActionPublication` and resource-menu publication
> clauses. Desktop and both mobile pane headers now consume the pane's sole
> `actionSubject`; pane/view/session controls remain separate.

## Questions And Locked Defaults

Open questions: none.

- Keep pane Back/Forward leading on desktop; keep Back leading on mobile.
- Use one 60px primary header track for every section and resource pane.
- Render at most one contextual row: expanded Search replaces reader navigation.
- Keep PDF/EPUB navigation top-mounted; do not redesign reader interaction.
- Preserve current actions, Options, identity, focus, safe-area, and mobile-motion owners.
- Optimize the existing system; do not create a second chrome or design-system layer.

## Decision

Cut all primary pane chrome to one quiet editorial frame:

```text
PaneShell
  60px identity track
    fixed leading rail | fluid identity | fixed trailing controls
  zero or one contextual instrument track
  content
```

Section and resource identity differ through typography and content, never outer
geometry. Desktop and mobile use the same visual grammar. `SurfaceHeader` and
`MobilePaneBar` own the identity-track projections; `PaneShell` owns contextual
row placement, material, separators, padding, overflow, and mobile registration.
Pane bodies publish meaning and controls, not chrome.

This document supersedes the geometry and free-form-toolbar clauses in
`pane-header-identity-hard-cutover.md`, `docs/modules/workspace.md`, and
`docs/architecture.md`. Their remaining identity, action, route, focus, and
reader contracts stay authoritative.

## Philosophy

- **Edition, not dashboard.** One paper-like material, exact typography, and
  hairlines do the work; no glass, glow, gradients, or card stack.
- **Rhythm is architecture.** Stable tracks and rails outrank local pixel fixes.
- **Content owns meaning; shell owns placement.** Publishers cannot restyle the
  frame.
- **Calm under compression.** Text truncates first; controls retain targets;
  rows never wrap into accidental chrome.
- **One capability, one path.** Reuse current identity, action, Search,
  `PaneToolbar`, and mobile-motion primitives; delete the generic escape hatch.

## Goals

- Make adjacent pane headers and contextual rows share exact vertical rhythm.
- Keep identity and controls spatially stable across route, loading, history,
  Search, and mobile Back availability changes.
- Give Study and Press the same geometry with theme-native optical weight.
- Make 320px mobile, narrow desktop panes, long identity, keyboard use, and 200%
  zoom deliberate states.
- Reduce code and styling ownership while preserving product behavior.

## Scope

In scope: primary desktop/mobile header geometry and material; the optional
Search/reader-navigation row; its publication API; media migration; active-pane
registration; narrow-width, zoom, forced-color, and reduced-motion presentation;
direct proof and normative docs.

The cut is presentation-only except for narrowing the in-process publication
shape from `toolbar` to `instrument`. It adds no persisted, transport, or domain
schema.

## Non-Goals

- No new action priority schema, command registry, automatic action overflow,
  user pinning, or configurable chrome.
- No workspace-depth coordination or reserved empty contextual rows across panes.
- No secondary-pane, pane-strip, app-rail, Nexus, MiniPlayer, body-toolbar, or
  reader-content redesign.
- No scroll-reactive desktop material, blur, translucent glass, media-derived
  tint, new icon set, or animation framework.
- No route, persistence, backend, database, Android-native, or wire change.
- No redesign of Search semantics, PDF/EPUB navigation, Document Map, Companion,
  Share, refresh, or Options contents.

`PaneSurface.toolbar` is in-content composition and is explicitly out of scope.
`MobileChromeProvider`'s `"PaneToolbar"` motion-role name remains current.

## Target Behavior

| State | Required result |
|---|---|
| Adjacent desktop panes | All primary headers are one 60px track; baselines and rules align |
| Section → resource route | Outer geometry does not move; identity typography changes in place |
| Mobile without Back | The empty 48px leading rail remains; identity does not jump |
| Mobile with Back | Back fills the reserved leading rail; Options remains in the trailing rail |
| No contextual capability | No empty second row is rendered |
| PDF/EPUB | One labelled reader-navigation instrument row is rendered |
| Search opens | Search replaces reader navigation in the same row; rows never stack |
| Search closes | Focus returns through the existing owner; reader navigation returns |
| Narrow width | Identity truncates, spacing compresses, controls remain operable, no document overflow |
| Study / Press | Same geometry; semantic tokens supply each room's material and hairline weight |
| Active desktop pane | One restrained accent registration line; no full inset focus-like ring |
| Mobile reader retreat | App bar, active instrument row, and Nexus retain existing synchronized motion |

## Final Architecture

```text
PaneRouteHeaderContract + accepted current-route publication
  -> resolvePaneHeaderModel
  -> PaneHeaderModel
       -> SurfaceHeader -------------------------------- desktop identity track
       -> MobilePaneBar / MobileChromeProvider -------- mobile identity track

PanePrimaryChromePublication
  header / search / instrument / actions / menu / refresh
       -> PaneShell
            contextual = expanded search ?? instrument ?? absent
            -> one shell-owned instrument row
                 -> PaneSearchBar -> PaneToolbar
                 -> media controls -> PaneToolbar
```

Existing owners remain:

- route/identity semantics: `PaneRouteHeaderContract`,
  `resolvePaneHeaderModel`, `PaneHeaderIdentity`;
- desktop projection: `SurfaceHeader`;
- mobile projection: `MobilePaneBar` and `MobileChromeProvider`;
- action semantics: `ActionDescriptor`, `ActionBar`, `ActionMenu`;
- Search semantics and focus: `PaneSearchPublication`, `PaneSearchBar`,
  `PaneShell`;
- outer chrome composition: `PaneShell`;
- inner row layout: `PaneToolbar`.

No `PaneChromeFrame`, registry, provider, context, hook, or variant system is
added.

## Capability Contract

Replace the sole free-form publication field:

```ts
export interface PaneInstrumentPublication {
  readonly label: string;
  readonly content: ReactNode;
}

export interface PanePrimaryChromePublication {
  readonly header?: PaneHeaderPublication;
  readonly search?: PaneSearchPublication;
  readonly instrument?: PaneInstrumentPublication;
  readonly actions?: readonly PaneHeaderAction[];
  readonly menu?: ActionPublication;
  readonly refresh?: PaneRefreshPublication;
}
```

Rules:

- Delete `toolbar?: ReactNode`; do not alias, deprecate, or accept both shapes.
- `label` is the user-facing accessible group name, currently `PDF controls` or
  `EPUB controls`; it is not an identifier or variant.
- `content` contains controls only. It must not render an outer material,
  separator, padding, height, overflow owner, or toolbar landmark.
- `PaneShell` renders `content` inside `role="group"` with the published label.
  Native Tab order is retained; do not claim ARIA toolbar semantics without a
  roving-focus implementation.
- Omission means no permanent row. Unexpected trusted shapes defect; there is no
  normalizer or fallback.
- Publication equality compares `label` and `content` reference identity, as the
  old React-node field did.
- `search` stays a separate typed capability. When expanded, it has exclusive
  occupancy of the contextual row.
- Only Media publishes `instrument` in this cut. A second producer requires a
  real product need, not a speculative variant.

## Geometry And Visual Contract

Canonical global tokens:

```css
--pane-chrome-header-height: max(60px, 3.75rem);
--pane-chrome-instrument-height: max(40px, 2.5rem);
```

The mobile pane sets `--pane-chrome-instrument-height: max(48px, 3rem)`. Delete
`--pane-section-header-height`, `--pane-resource-header-height`, and
`--appnav-bar-height`; all consumers use the canonical header token directly.

| Property | Desktop | Mobile |
|---|---:|---:|
| Primary header | 60px | 60px + safe area |
| Outer inline gutter | 16px | 8px |
| Leading rail | 64px; two 32px navigation cells | 48px; always reserved |
| Identity rail | `minmax(0, 1fr)` | `minmax(0, 1fr)` |
| Trailing rail | intrinsic typed actions + Options | 48px; always reserved |
| Contextual row | 40px | 48px |
| Control target | 32px | at least 44px |
| Separator | `var(--stroke-hairline)` | `var(--stroke-hairline)` |

At default text scale these are exact track sizes. At 200% text-only scaling,
tracks may grow only as required to avoid clipping; sibling panes under the same
conditions must still agree.

`primaryPane` is the named inline-size container for desktop chrome:

| Tier | Width | Allowed adaptation |
|---|---:|---|
| Comfortable | `>= 480px` | 16px gutter; normal gaps |
| Compact | `360–479px` | 12px gutter; tighter gaps |
| Compressed | `< 360px` | 8px gutter; minimum gaps; stronger truncation |

Container rules may change spacing and text allocation only. They must not hide
actions, change semantics, or create a second JS/`ResizeObserver` breakpoint
model. Existing `isMobile` remains the platform projection owner; mobile app-bar
compression follows the same 320/390 visual contract.

Layout rules:

- `SurfaceHeader` uses a three-column grid, not nested `space-between` flex.
- `MobilePaneBar` uses `48px minmax(0, 1fr) 48px`; absent Back renders an empty
  leading cell rather than deleting the cell.
- All primary rows share the same outer gutters and full-width bottom rule.
- Identity truncates before leading/trailing controls shrink or overlap.
- `PaneToolbar` becomes one-line and non-wrapping for chrome use. The shell row
  may scroll inline locally; the document must never gain horizontal overflow.
- Search input shrinks before fixed controls. Status text ellipsizes. No control
  is clipped, overlaid, or moved to an unlabelled icon.
- Section/resource differences remain in `RunningHead` and `ResourceHead`.
  Do not fork frame geometry by `data-header-kind`.
- Header and contextual row use one quiet `--surface-2` material. Depth comes
  from typography and hairlines, not shadow.
- Replace the active desktop pane's full inset ring with one accent
  `--stroke-hairline` at the block-start edge. Mobile has no redundant active
  registration.
- Use logical properties and existing spacing, surface, ink, edge, ring,
  duration, and easing tokens. No new color or shadow token.
- Forced colors uses opaque system colors and an explicit boundary; reduced
  motion keeps existing pinned/no-transition behavior.

## Intra-System Composition

- **Route lifecycle:** current `routeKey` acceptance remains before rendering;
  stale publications cannot alter a newer route.
- **Search:** `PaneShell` keeps open/close, keyboard request, focus return, and
  active-control marker ownership. Search does not become an instrument payload.
- **Media:** PDF/EPUB keep their existing commands and state. They publish only
  labelled control content composed with `PaneToolbar`; local
  `.mediaToolbar*` frame styles are deleted.
- **Actions:** promoted desktop actions and mobile Options keep their shared
  descriptors and present projection. No action is reclassified for aesthetics.
- **Mobile motion:** `useMobileChromeSurface(..., "PaneToolbar", ...)` registers
  exactly when the effective contextual row exists. Locks, progress, inertness,
  transforms, safe area, Nexus obstruction, and reader scrollports do not move.
- **Content offsets:** mobile header and contextual offsets consume the canonical
  fixed tracks. Keep the current safe-area and measured obstruction owners.
- **Two Rooms:** Study and Press vary through existing semantic tokens only;
  geometry and component structure are identical.

## Reuse, Consolidation, And Deletion

Reuse and centralize:

- `SurfaceHeader`, `MobilePaneBar`, `PaneHeaderIdentity`, `RunningHead`,
  `ResourceHead`;
- `PaneShell` as the only outer primary-chrome layout owner;
- `PaneToolbar` for Search and media inner layout;
- existing Button, Select, ActionBar, ActionMenu, focus, safe-area, and motion
  primitives.

Delete in the implementation change:

- section/resource/app-nav height split and every stale assertion/doc claim;
- `toolbar?: ReactNode`, `effectiveToolbar`, `pane-shell-toolbar`, and old
  publication test fixtures;
- media outer `role="toolbar"` landmarks and `.mediaToolbar` /
  `.mediaToolbarRow` frame ownership;
- the separate Search-row and media-row frame branches in `PaneShell`;
- literal 1px primary-chrome separators where `--stroke-hairline` is the owner;
- the full active-pane inset ring;
- dead selectors, comments, source guards, and tests that exist only for the
  superseded geometry or API.

Do not retain aliases, fallback CSS, duplicate selectors, feature flags, old/new
branches, compatibility exports, or tombstone tests.

## Files

Primary implementation owners:

- `apps/web/src/app/globals.css`
- `apps/web/src/lib/panes/panePublications.ts`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/components/ui/SurfaceHeader.tsx`
- `apps/web/src/components/ui/SurfaceHeader.module.css`
- `apps/web/src/components/ui/PaneToolbar.tsx`
- `apps/web/src/components/ui/PaneToolbar.module.css`
- `apps/web/src/components/appnav/MobilePaneBar.tsx`
- `apps/web/src/components/appnav/AppNav.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`

Touch only if proof requires projection-level optical adjustment:

- `apps/web/src/components/ui/PaneHeaderIdentity.tsx`
- `apps/web/src/components/ui/RunningHead.module.css`
- `apps/web/src/components/ui/ResourceHead.module.css`
- `apps/web/src/components/workspace/PaneSearchBar.tsx`

Direct proof owners:

- `apps/web/src/lib/panes/panePublications.test.ts`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/__tests__/components/SurfaceHeader.test.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx`
- `apps/web/src/components/workspace/PaneShell.mobileChrome.browser.test.tsx`
- `e2e/tests/pane-chrome.spec.ts`
- `e2e/tests/mobile-reader-chrome.spec.ts` only for preserved composition

Normative docs updated in the same implementation change:

- `docs/architecture.md`
- `docs/modules/workspace.md`
- `docs/cutovers/pane-header-identity-hard-cutover.md`
- `docs/cutovers/mobile-reader-unified-scroll-chrome-hard-cutover.md` only if a
  named surface description becomes stale

Do not modify workspace schemas, route tables, action descriptors,
`MobileChromeProvider` behavior, reader adapters, `PaneSurface`, secondary
chrome, native Android code, or backend code unless a locked acceptance
contract proves the scope statement false.

## Implementation Order

1. Add failing behavior proof for unified geometry, stable mobile rails, and
   single-row Search replacement; record demonstrated-red evidence.
2. Cut the canonical height tokens and desktop/mobile grid geometry together.
3. Replace `toolbar` with `instrument`; migrate Media and delete the old path in
   the same slice.
4. Consolidate row styling through `PaneShell` + `PaneToolbar`; delete media and
   Search frame duplication.
5. Apply active-pane, theme, forced-color, compression, zoom, and overflow
   polish using existing tokens.
6. Update normative docs, run residue gates, focused proof, the smallest public
   lanes, and manual visual review.

These are build-order steps, not coexistence phases.

## Acceptance Criteria

- **AC1 — Unified frame.** Section and resource headers measure 60px at default
  scale on desktop and mobile; mobile safe area is additive.
- **AC2 — Alignment.** Adjacent panes share header and contextual-row baselines,
  gutters, rules, and material with no route-dependent vertical jump.
- **AC3 — Stable mobile identity.** The 48/identity/48 grid is invariant with
  and without Back; long title/credit text never overlaps Back or Options.
- **AC4 — One contextual row.** Zero or one row renders. Expanded Search replaces
  PDF/EPUB navigation and closing Search restores it without a blank or stacked
  band.
- **AC5 — Ownership.** Pane bodies publish labelled control content only;
  `PaneShell` owns every outer frame property.
- **AC6 — Responsive behavior.** At 320px and 390px mobile, narrow desktop pane,
  and wide desktop, controls retain targets, identity/status truncate, local
  row overflow remains operable, and document horizontal overflow is zero.
- **AC7 — Accessibility.** Names, heading/landmark structure, keyboard order,
  visible focus, menu focus return, 44px mobile targets, 200% zoom, forced
  colors, and reduced motion remain correct. No false ARIA toolbar exists.
- **AC8 — Art direction.** Study and Press read as the same quiet press system:
  one material, semantic ink, theme-native hairlines, restrained accent, no
  glass/gradient/glow. This is a manual review gate.
- **AC9 — Active pane.** Desktop selection is legible without resembling
  keyboard focus; mobile receives no redundant selection ornament.
- **AC10 — Motion composition.** App bar, effective contextual row, Nexus,
  locks, inert phases, safe-area offsets, and real reader scrollports preserve
  the existing mobile chrome contract.
- **AC11 — No semantic regression.** Back/Forward, Search/Find, PDF/EPUB
  navigation, actions, Options, refresh, identity links, Companion, and reader
  content behavior are unchanged.
- **AC12 — Hard cut.** All named legacy tokens, API fields, frame styles,
  selectors, assertions, and prose are absent; there is no compatibility path.

## Required Proof

Follow `docs/local-rules/testing-standards.md`.

- Use the specification as the independent oracle; demonstrate the old 44/60
  split, disappearing mobile leading cell, or stacked-row behavior failing the
  new proof before implementation.
- Prove visible geometry, overflow, focus, keyboard, and accessibility in real
  Chromium components; do not assert CSS classes or private choreography.
- Keep one thin Playwright journey for real workspace/mobile wiring. Do not add
  broad screenshot regression.
- Manually review selected screenshots at 320, 390, narrow multi-pane desktop,
  and 1440 widths in Study and Press, including long resource identity, Search,
  PDF, EPUB, focus-visible, and 200% zoom.
- Run focused browser tests first, then `make check-front`,
  `make test-front-browser`, and the focused `pane-chrome.spec.ts` journey.
- Report browser, E2E, Android WebView, build, deploy, and production evidence
  separately; an unrun lane is not passed.

One-time residue audit after implementation:

```sh
rg -n -- '--pane-section-header-height|--pane-resource-header-height|--appnav-bar-height' \
  apps/web/src e2e docs/architecture.md docs/modules/workspace.md \
  docs/cutovers/pane-header-identity-hard-cutover.md
rg -n 'toolbar\?: ReactNode|effectiveToolbar|pane-shell-toolbar' apps/web/src
rg -n 'mediaToolbar|role="toolbar"' 'apps/web/src/app/(authenticated)/media/[id]'
```

Every command must return no superseded primary-chrome residue. Delete any
temporary source-grep proof once the cutover is complete.

## Final State

Nexus has one primary pane frame, one identity rhythm, one optional instrument
track, and one responsive projection per platform. Section/resource meaning,
actions, Search, readers, and mobile motion retain their current deep owners.
The result is calmer, more aligned, more legible, and simpler than the system it
replaces.

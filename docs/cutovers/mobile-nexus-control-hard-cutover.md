# Mobile Nexus Control — Hard Cutover

Status: IMPLEMENTED IN ANCESTRY — integration preservation required
Type: hard cutover

## Decision

Replace the large, intrinsically sized Nexus FAB-like pill with one quiet,
fixed-geometry mobile Nexus switcher:

```text
48px interaction and motion envelope
  -> 42px neutral Nexus face
  -> 20px accent Asterism mark
  -> neutral 1–12 tab index plate at the upper trailing corner
```

The counter is browser-style open-tab inventory. It is not a notification,
unread state, warning, action, or separate target. It never changes control
geometry at a given text scale. Its squared frame, neutral treatment, and exact
number distinguish it from notification-badge grammar.

Nexus remains the sole bottom-right mobile global entrance, used equally for
pane switching, Find, and creation. It fully retreats with ordinary reader
chrome. Existing reduced-motion pinning remains authoritative.

Product questions: none.

## Integrated authority

This control cut and the full-screen-task cut are already ancestors of the
current reader-chrome repair. There is no remaining landing or rebase
instruction. The repair targets their integrated final state and must prove it
preserves this document's Nexus anatomy and count, the reader document's
mobile-chrome policy and stable-wrapper/inner-control motion, and the
full-screen-task document's task presentation and viewport ownership.

This document then supersedes the mobile Nexus control's visual anatomy in
[mobile-nexus-switchboard-hard-cutover.md](mobile-nexus-switchboard-hard-cutover.md).
Preserve that document's 48px-target,
obstruction, current sheet, accessibility, and performance clauses. Replace
only its “Accent is reserved for Nexus/current selection” rule with: “Accent
is reserved for current selection and the Nexus mark; Nexus surfaces remain
neutral.” Its other Switchboard, pane, navigation, focus, performance,
obstruction, and accessibility behavior remains normative during this cut.

The stable wrapper/inner-control contract in
[mobile-reader-unified-scroll-chrome-hard-cutover.md](mobile-reader-unified-scroll-chrome-hard-cutover.md)
also remains normative.

[mobile-nexus-full-screen-task-hard-cutover.md](mobile-nexus-full-screen-task-hard-cutover.md)
supersedes this document's `SwitchboardSheet / MobileSheet`
composition, current-sheet preservation, Switchboard no-change, and
`MobileViewportProvider`-unchanged clauses. It preserves the complete control
anatomy, count, mobile-chrome motion, focus, and open-state
obstruction-unregister contract here.

Governing rules: `docs/rules/{frontend,cleanliness,simplicity,codebase,testing,
boundaries,correctness,naming,control-flow,overrides}.md`.

## Goals

- Make form match function: Nexus is a global switcher, not a FAB.
- Preserve one-handed bottom-right access without competing with reading.
- Keep a familiar exact tab count without notification urgency.
- Keep button, counter, anchor, wrapper, and obstruction geometry identical for
  counts `1` through `12` at each text scale.
- Reuse current workspace, Switchboard, mobile-chrome, viewport, theme, focus,
  and accessibility owners.
- Remove the inline-count layout path and lower total complexity.

## Scope

In scope:

- `NexusButton` markup and local styles;
- quiet editorial art direction and interaction states;
- fixed target, counter, hidden/inert, and obstruction behavior;
- directly affected behavior tests and normative docs.

Non-goals:

- no Switchboard, Find, creation, Places, pane, recently-closed, ranking,
  dispatch, workspace, persistence, backend, API, database, or schema change;
- no bottom bar, dock, second global control, dedicated tab switcher, pinned
  items, handedness preference, or configurable placement;
- no new gesture, haptic, long-press, swipe, shared-element transition, or
  animation system;
- no generic badge, counter, button, FAB, dock, or floating-control framework;
- no translucent/glass system, blur dependency, image asset, new icon, theme,
  token family, or design-system migration;
- no change to normal reader retreat, reduced-motion policy, top chrome,
  MiniPlayer, `MobileSheet`, safe areas, or Android shell behavior.

## Target Behavior

| Case | Result |
|---|---|
| Rest | Quiet circular Nexus face with one attached neutral tab index plate |
| Count `1` | Show `1`; accessible name is `Open Nexus, 1 tab` |
| Count `2…12` | Show the exact count; accessible name uses `{count} tabs` |
| Count change | Only counter text changes; no target, counter, anchor, wrapper, or obstruction change |
| Tap / keyboard activation | Open Switchboard Root through the existing controller |
| Hover-capable input | Optional subtle surface/border elevation; no glow or growth |
| Press | Visible color/elevation feedback; no transform competing with chrome motion |
| Focus visible | One circular ring surrounds the complete 48px target and attached counter |
| Reader retreat | Face and counter translate out together; `Hidden` is inert and unannounced |
| Reduced motion | Preserve existing visible/pinned policy |
| Switchboard open | Preserve existing hidden/inert and obstruction-unregister behavior |
| MiniPlayer / safe area | Preserve existing provider-owned bottom and trailing offsets |
| 200% text scaling | Counter grows inward with its text; count remains legible and unclipped |
| Forced colors | Explicit system colors preserve face, mark, counter, and focus without shadow |

The counter has no live region and does not announce count changes
spontaneously. It remains part of the button's accessible name when the button
is encountered.

## Final State

```text
WorkspaceStore primary pane order (1…MAX_PANES)
  -> useNexusController.paneCount                  existing truth owner
  -> Nexus mobile projection                      existing responsive owner
  -> NexusButton                                  existing trigger owner
       nexusWrapper
         -> fixed position
         -> safe-area/player offset
         -> MobileViewportProvider "Nexus" obstruction
       nexusButton (48x48)
         -> native button capability
         -> MobileChromeProvider "NexusControl"
         -> phase / collapse / transform / focus / hidden / inert
         -> nexusFace + AsterismMark
         -> nexusCount, visual-only and noninteractive
  -> onOpen
  -> existing SwitchboardSheet / MobileSheet
```

There is one pane-count truth, one global trigger, one motion owner, one
obstruction owner, and one Switchboard surface.

## Capability And API Contract

Keep the existing component API:

```ts
interface NexusButtonProps {
  paneCount: number;
  switchboardOpen: boolean;
  onOpen: () => void;
}
```

- Do not add visual variants, placement, tone, size, badge, or motion props.
- `paneCount` remains derived from all ordered primary panes, including
  minimized panes.
- Workspace invariants guarantee `1 <= paneCount <= MAX_PANES`; `MAX_PANES` is
  currently `12`.
- `NexusButton` does not clamp, coerce, validate, hide, abbreviate, or provide a
  fallback for trusted pane state. There is no `0`, dot, `9+`, or `99+` branch.
- Keep `aria-haspopup="dialog"` and the exact singular/plural accessible name.
- Keep the visual counter `aria-hidden="true"` and `pointer-events: none`.
- `onOpen` remains the only command. No counter-specific event exists.
- Preserve the live click sequence:
  `beginSwitchboardPerformance(NEXUS_OPEN_PERFORMANCE)` synchronously precedes
  `onOpen()`.

No public API, wire contract, persisted schema, capability registry, event
name, controller state, or provider interface changes.

## Implementation Anatomy And Visual Contract

Use this local anatomy; tests assert its behavior, not class names:

```text
div.nexusWrapper
  button.nexusButton
    span.nexusFace
      AsterismMark
    span.nexusCount
      paneCount
```

- The wrapper remains fixed, untransformed, and `pointer-events: none`.
- The button remains the registered `NexusControl`, restores pointer events,
  and owns the entire 48px hit, focus, and motion envelope.
- The face and counter stay inside that envelope. No negative-positioned
  overhang may escape the measured wrapper or remain visible at `Hidden`.
- The face is a centered 42px circle: `--surface-2`, 1px
  `--edge-strong`, and at most `--shadow-2`.
- The centered 20px Asterism mark uses `--accent`. Accent identity is required;
  accent face fill is forbidden.
- The opaque face controls the mark's background over arbitrary pane content.
  Mark/face contrast remains at least 3:1 in every theme; shadow is
  supplementary.
- The counter is a fixed `1.625em` square at `--text-2xs`, with
  `box-sizing: border-box`, `--radius-sm`, `--edge-strong` fill, 1px
  `--surface-2` border, and `--ink` text. Use grid centering, semibold weight,
  tight line height, and `font-variant-numeric: tabular-nums`. Do not add inline
  padding or content-sized width. Counter text/fill contrast remains at least
  4.5:1.
- Anchor the counter to the face using logical properties: its block-start and
  inline-end edges sit 2px beyond the corresponding face edges, therefore 1px
  inside the 48px envelope.
- At the default text scale, keep at least 2px between the counter and painted
  Asterism dots. At 200% text scaling the counter grows inward; count legibility
  takes priority over the decorative mark.
- Use neutral ink/surface contrast. Do not use `--danger`, `--warning`, red,
  glow, pulse, gradient, blur, a pill/full counter radius, or accent-filled FAB
  treatment.
- The button itself is transparent, 48px square, and full-radius. One
  `--ring` focus outline with zero offset surrounds that button; inner elements
  do not draw independent focus rings.
- Preserve the current `--mobile-chrome-collapse` transform and Settling-only
  transition on the button. Do not add a second transform or transition owner.
- Preserve `data-mobile-chrome-phase` and the computed
  `--mobile-chrome-collapse` on the native button. Consume the shared
  `@property` registration from `AppNav.module.css`; do not redeclare it.
- At phase `Hidden`, use `visibility: hidden` in addition to the existing
  `aria-hidden` and `inert` state so no face, counter, outline, or shadow paints.
- Focus, hover, active, light, dark, and forced-color states cannot rely on
  shadow alone.

Forced colors require an explicit local media rule:

- face: Canvas fill and 1px CanvasText border;
- mark: CanvasText;
- counter: CanvasText fill, Canvas text, and Canvas border;
- focus: Highlight outline.

The button accessible name continues exposing the exact count when the visual
counter is hidden from the accessibility tree.

## Reuse, Consolidation, And Deletion

Reuse:

- `AsterismMark`;
- `NexusButton`, `useNexusController`, and `Nexus`;
- `MobileChromeProvider` / `useMobileChromeSurface`;
- `MobileViewportProvider`;
- global focus-ring and theme tokens;
- existing Nexus functional/performance E2E and final scroll-chrome proof
  infrastructure.

Reuse the `Button` secondary-state token language, not the `Button` component:
its content and sizing contract does not own a transformed shell obstruction.
Do not use `Pill`; its label/padding grammar is the behavior being removed. Do
not use `FloatingActionSurface`; it owns anchored transient content, not a
global shell trigger.

Delete in the same change:

- the inline mark-plus-count flex layout;
- count-driven intrinsic width, horizontal gap, and horizontal padding;
- the 56px painted FAB body;
- accent-filled face, strong FAB border, and `shadow-4`;
- stale FAB, inline-count, content-sized-counter, or old Nexus-accent prose.

Do not retain old selectors, styles, markup, aliases, fallback classes, feature
flags, or old/new visual branches.

## Ownership And Files

Implementation:

- `apps/web/src/components/switchboard/NexusButton.tsx`
- `apps/web/src/components/switchboard/switchboard.module.css`

Behavior proof:

- `apps/web/src/components/nexus/Nexus.test.tsx`
- `e2e/tests/nexus.spec.ts`
- `e2e/tests/pane-chrome.spec.ts`

Verify unchanged label consumers unless a behavior failure proves otherwise:

- `e2e/tests/app-navigation.spec.ts`
- `e2e/tests/mobile-sheets.spec.ts`
- `e2e/tests/consumption-stats.spec.ts`
- `e2e/tests/hydration-determinism.spec.ts`

Normative docs:

- `docs/cutovers/mobile-nexus-switchboard-hard-cutover.md`
- `docs/cutovers/mobile-nexus-full-screen-task-hard-cutover.md` as the
  integrated presentation authority
- this document

Do not modify `useNexusController`, `Nexus`, the final `MobileChromeProvider`,
`MobileViewportProvider`, workspace schemas, Switchboard components, global
tokens, or Android native code unless implementation evidence disproves a
locked contract above. Do not add a production seam for tests.

## Integration preservation proof

1. Treat the integrated reader/control/full-screen state as the baseline.
2. Run focused Nexus anatomy, count, motion, focus, obstruction, and
   trusted-input reader-chrome proof.
3. Audit the repair for ownership drift, dead selectors, duplicate state, and
   stale FAB/inline-count terminology.

## Acceptance Criteria

- **AC1 — Classification.** The control reads as a quiet global switcher, not a
  primary-action FAB. This is a manual art-direction gate.
- **AC2 — Fixed geometry.** Counts `1`, `9`, and `12` produce the same 48px
  button, counter, wrapper, anchor, and published obstruction geometry at each
  tested text scale.
- **AC3 — Counter.** The exact `1…12` value is visibly attached at the upper
  trailing face corner in the specified squared neutral frame, never
  red/alert-like, never interactive, and never in normal layout flow. Visual
  classification is a manual gate.
- **AC4 — Accessibility.** The native button retains correct singular/plural
  names, dialog semantics, visible focus, at least a 48px target, and no
  duplicate or live counter announcement. At 200% text scaling, `12` remains
  visible and unclipped.
- **AC5 — Motion.** Face and counter track the existing Nexus chrome progress,
  preserve phase/collapse hooks, paint nothing at `Hidden`, and become
  hidden/inert atomically.
- **AC6 — Composition.** Safe area, MiniPlayer, Switchboard-open, keyboard,
  bottom clearance, and Android edge-to-edge behavior remain provider-owned and
  unchanged.
- **AC7 — Art direction.** Light and dark presentations use quiet surface/ink
  hierarchy, the accent mark, real borders, restrained depth, and visible
  press/focus. Hover is reviewed only on hover-capable input.
- **AC8 — Hard cutover.** No inline-count layout, FAB styling, compatibility
  path, fallback, new abstraction, or stale normative requirement remains.
- **AC9 — Scope.** No controller, state, API, persistence, Switchboard, reader,
  player, or platform capability changes.

## Required Proof

Automated behavior:

- component: counts `1`, `9`, and `12`; exact accessible names; one button and
  one visual-only counter; open and hidden/inert states;
- existing real-stack Nexus E2E remains green for open, switch, close, restore,
  and `nexus-open` performance;
- final trusted-input pane-chrome E2E remains green for retreat/reveal and
  phase/collapse observation on the native button;
- extend browser proof for counts `1`, `9`, and `12` with unchanged target,
  counter, anchor, wrapper, and obstruction rectangles;
- add new composition cases for Switchboard-open state, active MiniPlayer, safe
  area, and literal painted clearance at `Hidden`;
- static: formatting, lint, typecheck, and `git diff --check`.

Visual/manual:

- primary Android WebView, bottom-right one-handed use;
- light, dark, forced colors, 200% browser zoom, 200% text-only scaling,
  Android 200% font scale, and narrow portrait;
- counts `1`, `9`, and `12`;
- rest, hover-capable, press, focus, partial retreat, `Hidden`, Switchboard
  open, and MiniPlayer present.

Do not add pixel snapshot tests or assert private refs, class composition,
provider calls, or CSS implementation details. Assert observable size,
placement, accessibility, state, and viewport clearance. Report browser proof,
real-stack proof, and physical Android proof separately.

# Mobile workspace right-edge hard cutover

## Status

Implemented locally.

Targeted browser component tests, frontend typecheck, focused frontend lint,
and CSS token validation pass. Targeted Playwright E2E was attempted through the
repo Make wrapper, but the run failed in global setup before any cutover specs
executed because unrelated dirty backend ORM state could not join
`media_source_attempts` to `podcast_episodes`.

This is a hard-cutover plan. It does not preserve legacy behavior, compatibility
branches, CSS-only concealment, or best-effort fallbacks for the mobile workspace
right-edge artifact.

## Summary

Mobile authenticated workspace surfaces must not reserve, paint, or imply a
desktop right-side rail. At phone widths, the app has one primary pane, optional
mobile modal sheet chrome, and no desktop canvas affordances.

The current codebase already has most of the intended owner boundaries:

- `RenderEnvironmentProvider` owns viewport classification.
- `WorkspaceHost` owns workspace composition and decides which panes/chrome are
  mounted.
- `usePaneCanvas` owns desktop horizontal canvas measurement and edge fade state.
- `PaneShell` owns pane frame geometry.
- `MobileSecondaryPaneHost` owns mobile secondary-pane presentation.
- `ChatSurface` owns chat transcript scroll behavior.

Before this cutover, the defect class appeared where those boundaries were not
strict enough:

- Desktop canvas edge state can outlive the desktop mode that produced it.
- Desktop-only edge fades are rendered from workspace state without a mobile
  rendering guard.
- Chat transcript scrollports reserve a stable scrollbar gutter on mobile.
- A mobile sheet uses a non-existent shadow token, which creates visual-system
  drift and makes shadow debugging less deterministic.
- Mobile shell visual rules remove some desktop chrome but not every
  desktop-only edge affordance.

The professional fix is to make the mode contract impossible to misread:
desktop canvas behavior exists only in desktop workspace mode; mobile workspace
mode has no desktop canvas edge state, no desktop canvas edge DOM, no fixed
desktop chrome, no secondary pane column, no overview ruler, no resize handle,
and no stable inline-end scrollbar gutter.

## SME framing

A subject matter expert would not start by hiding the visible strip. They would
ask which owner is allowed to create horizontal inline-end space on mobile, then
remove every ambiguous owner.

The high-standard approach is:

1. Treat the artifact as a violated layout contract, not a styling blemish.
2. Define a mobile workspace capability contract with negative invariants:
   desktop-only chrome must not be mounted, measured, painted, or reserve space.
3. Move the fix to the highest owner layer that creates the artifact class.
4. Reset state at mode boundaries instead of relying on render-time luck.
5. Use existing primitives for accessibility and modal behavior.
6. Add geometry assertions in real browser tests because this class of bug is
   viewport, scroll, and paint dependent.

For a one-user prototype, the right move is still a hard cutover. There is no
business value in maintaining compatibility for stale mobile desktop-canvas
semantics, and the extra branch would make future workspace work harder to
reason about.

## Problem statement

On mobile, a visually unnecessary right-side strip/shadow/bar could appear and
take perceived or actual space. The likely contributors were not one single
line; they were a cluster of weakly-separated desktop and mobile concerns:

- `WorkspaceHost` disables `usePaneCanvas` on mobile but renders edge fades from
  `edges` unconditionally.
- `usePaneCanvas` returns early when disabled and does not clear prior edge
  state at the desktop-to-mobile transition.
- Server render starts from a desktop viewport assumption, while the client
  later hydrates to mobile via `matchMedia`.
- `ChatSurface` applies `scrollbar-gutter: stable` to the scrollport globally.
- `PaneShell` removes the mobile border-right but the active pane inset ring can
  still read visually as a desktop edge treatment.
- `MobileSecondaryPaneHost` references `--shadow-lg`, while global tokens define
  `--shadow-1` through `--shadow-5`.

The fix must remove the class of defects, not tune one viewport screenshot.

## Target behavior

### Mobile workspace

At mobile viewport width:

- The authenticated workspace renders exactly one primary pane in the main
  canvas.
- The main workspace width equals the visual viewport width after app navigation
  reservations.
- The workspace does not create document-level horizontal scrolling.
- The workspace does not render desktop canvas edge fades.
- The workspace does not retain stale desktop canvas edge state after resizing
  from desktop to mobile.
- The workspace does not mount desktop secondary pane columns.
- The workspace does not mount fixed desktop chrome.
- The workspace does not mount the reader overview ruler.
- The workspace does not mount desktop pane resize handles.
- Pane shells do not paint desktop active-pane edge treatments.
- Chat transcript scrollports do not reserve a stable inline-end scrollbar
  gutter.
- Mobile secondary content appears only through the mobile secondary sheet.

### Desktop workspace

At desktop viewport width:

- The horizontal pane canvas keeps its existing behavior.
- Edge fades render only when the desktop canvas can scroll in that direction.
- Secondary panes and fixed desktop chrome render according to route and pane
  contracts.
- Existing desktop width contracts from `paneRouteModel`, `paneSizing`, and
  fixed chrome publication remain authoritative.
- Desktop scrollbars and stable gutters are unchanged unless a test proves they
  are part of the same defect class.

### Resize boundary

When the viewport changes across the mobile breakpoint:

- Desktop-to-mobile immediately clears desktop canvas edge state and unmounts
  desktop-only edge fade DOM.
- Mobile-to-desktop re-measures the canvas from the current DOM and restores
  desktop canvas edge behavior without using stale mobile assumptions.
- No transition frame may permanently leave horizontal overflow or a stale
  right-side fade.

### First paint and hydration

Before viewport hydration is known on the client:

- Desktop-only canvas measurement must not create durable state that can leak
  into mobile.
- The server-side desktop default must not be used as evidence that mobile can
  render desktop canvas affordances.
- Any transient pre-hydration desktop markup must be gone after hydration and
  must not leave measured state behind.

## Final architecture

### Workspace mode is the top-level switch

`WorkspaceHost` owns a single workspace layout mode derived from render
environment state:

```ts
type WorkspaceLayoutMode = "mobile" | "desktop";
```

The mode is the input to every workspace-only composition decision:

- pane list to render
- secondary-pane host
- fixed chrome publication
- pane strip visibility
- canvas measurement
- canvas edge fade rendering
- mobile sheet rendering

`isMobile` can remain as a local boolean if the implementation style prefers
that, but the effective design rule is that there is one mode and it is passed
through the composition tree intentionally. No child should rediscover a
separate meaning of "mobile workspace" for the same concern.

### Pane canvas is desktop-only

`usePaneCanvas` is a desktop canvas hook. It should expose that in its API rather
than accepting a loose boolean that leaves callers to remember reset semantics.

Preferred hard-cutover API:

```ts
type PaneCanvasMode = "desktop" | "disabled";

type UsePaneCanvasInput = {
  mode: PaneCanvasMode;
  paneIds: readonly string[];
};

type PaneCanvasState = {
  containerRef: RefObject<HTMLDivElement | null>;
  edges: {
    atStart: boolean;
    atEnd: boolean;
  };
  scrollToPane: (paneId: string) => void;
  registerPane: (paneId: string, node: HTMLElement | null) => void;
};
```

Rules:

- `mode: "desktop"` is the only mode that attaches scroll listeners, resize
  observers, or measures horizontal canvas edges.
- `mode: "disabled"` must synchronously converge to
  `{ atStart: false, atEnd: false }`.
- Pane registrations may remain available so callers do not need conditional
  ref code, but disabled mode must not measure or scroll.
- The hook must own state reset when mode changes. Callers should not clear edge
  state manually.
- The hook must be tested for desktop-to-disabled and disabled-to-desktop
  transitions.

If the repo owner prefers to keep the existing `enabled` boolean, the semantic
contract still changes: disabled mode clears edge state and renders no edge DOM.
The API rename is recommended because it makes the hard cutover visible at call
sites.

### Edge fades are owned by desktop canvas rendering

`WorkspaceHost` must render edge fades only when the workspace layout mode is
desktop. The fade DOM is not a generic workspace decoration.

Required rule:

```tsx
{layoutMode === "desktop" && edges.atStart ? ... : null}
{layoutMode === "desktop" && edges.atEnd ? ... : null}
```

This is not a cosmetic guard. It documents ownership: a mobile workspace has no
horizontal desktop canvas edge affordance, even if stale state is present during
a transition. The hook reset and the render guard are both required because they
defend different layers.

### Pane shell is mode-pure

`PaneShell` already receives `isMobile` and uses it to suppress visible
secondary content and fixed chrome. The final contract is stricter:

- Mobile shell width is exactly `100%` of the workspace content area.
- Mobile shell min/max width are exactly `100%`.
- Mobile shell has no desktop border-right.
- Mobile shell has no desktop active-pane inset edge treatment.
- Mobile shell has no resize handle.
- Mobile shell does not receive visible fixed desktop chrome.
- Mobile shell does not receive visible secondary desktop chrome.

`PaneShell` may still own mobile toolbar/body layout, but it must not own
workspace mode discovery. `WorkspaceHost` decides mobile vs desktop composition;
`PaneShell` applies the frame contract for the mode it was given.

### Mobile secondary pane is a sheet, not a column

`MobileSecondaryPaneHost` is the only supported mobile secondary-pane
presentation.

Rules:

- It renders as a modal bottom sheet.
- It uses `useDialogOverlay` for focus trap, focus restore, Escape handling,
  and body scroll lock.
- It does not share desktop secondary-pane sizing.
- It does not reserve horizontal workspace space.
- It does not render a desktop right rail.
- It uses valid design tokens only.

The existing `useDialogOverlay` primitive should remain the accessibility owner.
Do not introduce a parallel focus trap or body lock for this cutover.

### Chat transcript scrollbars are platform-sensitive

`ChatSurface` owns the transcript scrollport. It must not reserve a stable
inline-end gutter on mobile.

Rules:

- Desktop may keep `scrollbar-gutter: stable` if that is still desired for
  transcript layout stability.
- Mobile must use the platform default scrollbar behavior or an explicit
  `scrollbar-gutter: auto`.
- Global scrollbar styling must not be used as the mobile layout contract.
- Hiding scrollbars globally is not an acceptable fix.

The important invariant is not "no scrollbar can ever be visible." The invariant
is "mobile does not reserve a desktop-like right-side gutter or rail."

### Design tokens are authoritative

The app defines shadow tokens as `--shadow-1` through `--shadow-5`. Components
must use those tokens or add a new token at the design-system layer.

`MobileSecondaryPaneHost` must not reference `--shadow-lg`.

Preferred final state:

- Use an existing token, likely `--shadow-4` or `--shadow-5`, for the mobile
  secondary sheet.
- If a semantic mobile sheet token is desired, define it once in `globals.css`
  as an alias to an existing numbered token, then use the semantic token from
  sheet surfaces.
- Do not define a token locally in the component module to paper over the drift.

## Capability contract

### Render environment

Owner: `apps/web/src/lib/renderEnvironment/*`

The render environment classifies the viewport. It does not own workspace
layout policy.

Contract:

- Expose viewport kind and hydration state.
- Keep one mobile breakpoint source for app code.
- Do not let server desktop defaults create durable mobile desktop-canvas state.

Composition:

- `WorkspaceHost` consumes render environment state.
- `PaneShell`, readers, chat, and media panes consume the already-decided mode
  or their existing viewport hook only for local presentation details.

### Workspace host

Owner: `apps/web/src/components/workspace/WorkspaceHost.tsx`

`WorkspaceHost` is the workspace composition owner.

Contract:

- Decide workspace layout mode once.
- In mobile mode, render only the active primary pane in the main workspace.
- In mobile mode, render secondary content only through
  `MobileSecondaryPaneHost`.
- In mobile mode, pass no visible fixed desktop chrome to pane shells.
- In mobile mode, do not render `WorkspacePaneStrip`.
- In mobile mode, do not render edge fades.
- In desktop mode, preserve current pane canvas and secondary/fixed chrome
  behavior.

### Pane canvas hook

Owner: `apps/web/src/components/workspace/usePaneCanvas.ts`

`usePaneCanvas` is the desktop horizontal canvas measurement owner.

Contract:

- Desktop mode measures horizontal overflow and reports edge state.
- Disabled mode clears edge state and performs no measurement.
- Mode transitions are deterministic.
- The hook does not know about route semantics, pane content, or mobile sheets.

### Pane shell

Owner: `apps/web/src/components/workspace/PaneShell.tsx` and
`apps/web/src/components/workspace/PaneShell.module.css`

`PaneShell` owns the frame around a pane.

Contract:

- It applies mode-specific frame geometry from explicit props.
- It does not mount desktop resize/fixed/secondary visual affordances in mobile
  mode.
- It does not paint desktop active-pane edge treatments in mobile mode.
- It remains reusable across route-specific pane bodies.

### Mobile secondary pane host

Owner: `apps/web/src/components/workspace/MobileSecondaryPaneHost.tsx` and
`apps/web/src/components/workspace/MobileSecondaryPaneHost.module.css`

`MobileSecondaryPaneHost` owns mobile secondary-pane presentation.

Contract:

- It is modal sheet chrome, not workspace column chrome.
- It uses `useDialogOverlay`.
- It consumes valid design tokens only.
- It does not participate in desktop canvas sizing.

### Chat surface

Owner: `apps/web/src/components/chat/ChatSurface.tsx` and
`apps/web/src/components/chat/ChatSurface.module.css`

`ChatSurface` owns transcript scrollport behavior.

Contract:

- Desktop transcript layout may reserve scrollbar gutter for stability.
- Mobile transcript layout must not reserve stable inline-end gutter.
- Transcript scroll behavior must not create document-level horizontal overflow.

### Reader/media fixed chrome

Owners:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/lib/workspace/fixedPrimaryChrome.ts`
- `apps/web/src/lib/workspace/paneSizing.ts`
- `apps/web/src/lib/panes/paneRouteModel.ts`

Contract:

- Route and pane sizing policy remain centralized in existing route/sizing
  modules.
- Fixed chrome width is desktop-only in mobile workspace mode.
- The overview ruler remains desktop reader/media chrome only.
- Mobile reader secondary content remains sheet-based.

## Files in scope

### Runtime files

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.module.css`
- `apps/web/src/components/workspace/usePaneCanvas.ts`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.tsx`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.module.css`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/app/globals.css`

### Test files

- `apps/web/src/components/workspace/usePaneCanvas.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.test.tsx`
- `e2e/tests/workspace-canvas.spec.ts`
- `e2e/tests/reader-pane-width.spec.ts`
- `e2e/tests/pane-chrome.spec.ts`
- `e2e/tests/conversations.spec.ts`

### Documentation files

- `docs/cutovers/mobile-workspace-right-edge-hard-cutover.md`
- `docs/modules/workspace.md`
- `docs/modules/panes-tabs.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/chat.md`

The module docs should be updated as part of implementation because
`workspace.md` and `panes-tabs.md` are currently empty stubs. The cutover should
leave the workspace mode contract documented outside this plan.

## Existing patterns to reuse

### Reuse `useDialogOverlay`

`useDialogOverlay` already owns modal focus behavior, Escape handling, focus
restore, and body scroll locking. Mobile secondary sheets should reuse it rather
than growing a custom overlay lifecycle.

### Reuse `paneRouteModel` and `paneSizing`

Route-level width policy already belongs to `paneRouteModel` and workspace
sizing helpers. Do not duplicate route width decisions in CSS or pane bodies.

### Reuse current viewport provider

The render environment already exposes viewport state. The cutover should not
introduce a second breakpoint registry.

### Reuse `MobileSecondaryPaneHost`

The app already has a mobile secondary-pane owner. Fix that owner rather than
creating a parallel "mobile drawer" for workspace secondaries.

### Reuse existing shadow token scale

The design system already exposes numbered shadow tokens. Use that scale or add
one semantic alias at the global token layer.

## Duplicate and repetitive patterns found

The codebase has several mobile sheet or overlay implementations with similar
geometry:

- `MobileSecondaryPaneHost.module.css`
- `AddContentTray.module.css`
- `palette.module.css`
- `GlobalPlayerFooter.module.css`
- `ModelSettingsPopover.module.css`
- `AppNav.module.css`

The relevant duplication is not the business content of those components. It is
the overlay geometry:

- fixed viewport layer
- backdrop/scrim
- bottom or side sheet placement
- max-height or max-width constraints
- rounded leading edge
- handle/grabber
- shadow/elevation token
- body scroll containment

Near-term cutover rule:

- Reuse `useDialogOverlay` and fix the workspace-specific sheet now.
- Do not centralize every sheet in this right-edge cutover unless the
  implementation touches those surfaces for this defect.

Recommended follow-up cutover:

- Create a shared `MobileSheet` or `ModalSurface` primitive for overlay geometry
  and token usage.
- Migrate all mobile sheets to that primitive in one separate hard cutover.
- Delete duplicated local sheet geometry after migration.

Reasoning:

- The right-edge defect is a workspace mobile/desktop contract problem.
- Migrating every sheet in the app would expand blast radius and verification
  scope beyond the artifact.
- The correct SME move is to document the duplication and schedule a clean
  primitive cutover, not mix a broad overlay-library refactor into a viewport
  regression fix.

## Key decisions

### Decision: fix at the workspace mode boundary

The primary fix belongs in `WorkspaceHost` and `usePaneCanvas`, not only in CSS.
CSS can prevent a fade from painting, but it cannot make stale desktop state
safe or clarify ownership.

### Decision: both reset state and guard rendering

`usePaneCanvas` must clear edge state when disabled, and `WorkspaceHost` must
avoid rendering fades outside desktop mode. A single-layer fix is weaker:

- Hook-only reset can still leak if future code introduces another state path.
- Render-only guard can hide stale state while leaving a bad contract alive.

The hard cutover requires both.

### Decision: mobile does not get stable scrollbar gutter

Stable transcript gutters solve a desktop layout-jump problem. On mobile, they
create or imply the exact artifact class being removed. Mobile uses platform
scrollbar behavior.

### Decision: no generic global scrollbar suppression

Hiding scrollbars globally is a lab-only patch. It would mask the symptom and
could damage accessibility, desktop behavior, and scroll discoverability.

### Decision: no new breakpoint system

The app already has `RenderEnvironmentProvider`. A second breakpoint helper
would create a long-term source of drift.

### Decision: no compatibility lane

No old mobile desktop-canvas behavior is preserved. If mobile currently depends
on a desktop canvas artifact, that dependency is invalid and should fail tests
until corrected.

## Implementation plan

### 1. Introduce explicit workspace canvas mode

In `WorkspaceHost`:

- Derive a single layout mode from viewport state.
- Pass `"desktop"` to `usePaneCanvas` only in desktop mode.
- Pass `"disabled"` in mobile mode.
- Render edge fades only in desktop mode.

In `usePaneCanvas`:

- Replace or semantically harden the existing `enabled` input.
- Clear `edges` whenever the mode is disabled.
- Do not attach canvas listeners, observers, or measurement loops in disabled
  mode.
- Re-measure on desktop re-entry.

### 2. Close mobile pane shell visual leaks

In `PaneShell.module.css`:

- Ensure mobile shell has no border-right.
- Ensure mobile shell has no active inset ring.
- Ensure mobile shell has no desktop resize affordance.
- Keep focus-visible affordances for actual interactive elements.

In `PaneShell.tsx`:

- Preserve the existing mobile suppression of fixed and secondary desktop
  chrome.
- Avoid adding local fallback checks for route-specific panes.

### 3. Fix mobile secondary sheet token drift

In `MobileSecondaryPaneHost.module.css`:

- Replace `--shadow-lg` with the chosen valid token or a global semantic alias.
- Keep sheet geometry full-width and viewport-constrained.

If adding a semantic token:

- Define it in `apps/web/src/app/globals.css`.
- Use it consistently in the mobile secondary host.
- Do not define component-local token fallbacks.

### 4. Make chat mobile scrollbar gutter policy explicit

In `ChatSurface.module.css`:

- Move `scrollbar-gutter: stable` behind a desktop media query, or set mobile to
  `scrollbar-gutter: auto`.
- Verify transcript width on mobile.
- Do not alter transcript behavior by hiding overflow or removing scrolling.

### 5. Document the owner contracts

Update:

- `docs/modules/workspace.md`
- `docs/modules/panes-tabs.md`
- `docs/modules/reader-implementation.md` if the reader/mobile ruler contract
  needs sharper wording.
- `docs/modules/chat.md` if the transcript mobile gutter policy should be
  recorded there.

Docs should state which module owns:

- workspace mode
- desktop canvas edge fades
- mobile secondary sheets
- fixed desktop chrome
- transcript scrollport gutter policy

### 6. Add tests at the owner layers

Unit/component tests:

- `usePaneCanvas` clears edges when switching from desktop to disabled.
- `usePaneCanvas` re-measures after switching back to desktop.
- `WorkspaceHost` mobile render has no edge-fade DOM.
- `WorkspaceHost` mobile render has no desktop pane strip.
- `PaneShell` mobile render has no resize handle, no visible fixed chrome, and
  no visible secondary desktop content.
- `MobileSecondaryPaneHost` uses modal semantics and remains full-width.

Browser tests:

- At `390x844`, authenticated workspace has no document horizontal overflow.
- At `390x844`, no workspace edge fade elements are present.
- At `390x844`, pane shell width is no greater than viewport width.
- At `390x844`, reader/media panes do not mount desktop overview ruler or fixed
  chrome.
- At `390x844`, chat transcript does not reserve stable inline-end gutter.
- At desktop width, workspace canvas edge fades still appear when the pane
  canvas overflows.

## Acceptance criteria

### Functional

- Mobile workspace renders without a right-side desktop bar, shadow, gutter, or
  reserved rail.
- Mobile workspace has no document-level horizontal scroll.
- Desktop workspace canvas behavior is unchanged.
- Mobile secondary content still opens and closes through the mobile sheet.
- Chat transcript remains scrollable on mobile.
- Reader/media overview ruler remains available on desktop where intended.

### Structural

- `WorkspaceHost` is the only owner deciding desktop vs mobile workspace
  composition.
- `usePaneCanvas` owns desktop canvas edge state and resets it when disabled.
- `PaneShell` applies mobile shell frame rules from explicit mode input.
- `ChatSurface` owns transcript scrollbar-gutter policy.
- `MobileSecondaryPaneHost` uses valid global design tokens.
- No new breakpoint helper is introduced.
- No component-local fallback token is introduced for `--shadow-lg`.
- No global scrollbar hiding is introduced.

### Negative invariants

At mobile viewport width:

- No `.edgeFade` workspace element is mounted.
- No `WorkspacePaneStrip` is mounted.
- No pane resize handle is visible.
- No fixed desktop chrome is visible.
- No desktop secondary pane column is visible.
- No reader overview ruler is visible.
- No active-pane desktop inset edge treatment is visible.
- No stable scrollbar gutter is applied to the chat transcript scrollport.

### Verification

The cutover is accepted only after targeted verification passes:

- targeted unit/component tests for `usePaneCanvas`, `WorkspaceHost`,
  `PaneShell`, and `MobileSecondaryPaneHost`
- targeted Playwright/E2E coverage for mobile workspace geometry
- targeted desktop workspace canvas coverage
- manual browser screenshot or Playwright screenshot review at phone width if
  automated pixel checks are inconclusive

## Test design details

### Geometry assertion

Mobile E2E tests should assert:

```ts
const metrics = await page.evaluate(() => ({
  innerWidth: window.innerWidth,
  docWidth: document.documentElement.scrollWidth,
  bodyWidth: document.body.scrollWidth,
}));

expect(metrics.docWidth).toBeLessThanOrEqual(metrics.innerWidth);
expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.innerWidth);
```

For specific workspace elements, tests should assert bounding boxes:

```ts
const box = await page.locator('[data-testid="pane-shell"]').boundingBox();
expect(box?.width).toBeLessThanOrEqual(390);
expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
```

Selectors should use existing stable test IDs where available. Add a test ID
only if the element is a durable product surface, not just an implementation
detail.

### Edge fade absence

Mobile tests should assert absence, not hidden display:

```ts
await expect(page.locator('[data-side="end"]')).toHaveCount(0);
```

If a more specific selector is added, prefer a workspace-scoped selector so
unrelated components can use `data-side` without breaking the test.

### Scrollbar gutter

Browser support for computed `scrollbar-gutter` can vary. Prefer a layered test:

- assert the mobile CSS rule does not apply `stable`
- assert transcript client width does not create document horizontal overflow
- visually review the mobile transcript if a browser renders overlay scrollbars
  differently

## Non-goals

- No redesign of the desktop multi-pane canvas.
- No change to route-level pane width contracts except where they currently
  leak desktop chrome onto mobile.
- No removal of desktop edge fades.
- No removal of desktop transcript gutter behavior unless tests show it is part
  of the same issue.
- No generic scrollbar-hiding policy.
- No migration layer for old mobile workspace behavior.
- No new alternate mobile secondary host.
- No broad mobile-sheet primitive migration in this cutover.
- No changes to backend APIs.
- No changes to authentication, player, library, or ingest systems.

## API design

There is no network API change. This is a local component and layout API
cutover.

### Preferred local API changes

Replace loose canvas enablement with explicit mode:

```ts
usePaneCanvas({
  mode: layoutMode === "desktop" ? "desktop" : "disabled",
  paneIds,
});
```

If keeping the current boolean input for minimal churn, the API contract still
changes:

```ts
usePaneCanvas({
  enabled: layoutMode === "desktop",
  paneIds,
});
```

Required behavior either way:

- disabled means no measurement
- disabled means no listeners
- disabled means false edge state
- desktop re-entry means fresh measurement

### Optional future local API

For the separate overlay-consolidation cutover:

```tsx
<MobileSheet
  open={open}
  onClose={onClose}
  labelledBy={titleId}
  placement="bottom"
  maxHeight="80dvh"
>
  {children}
</MobileSheet>
```

This is deliberately not required for the right-edge cutover. It is recorded so
future sheet consolidation has a clear direction and does not recreate local
overlay geometry.

## Composition with other systems

### App navigation

`AuthenticatedShell` composes `AppNav`, `WorkspaceHost`, and
`GlobalPlayerFooter`. This cutover must not change app-nav ownership. The
workspace content area must continue to respect app nav reservations through
existing layout CSS.

### Global player

The global player has its own mobile expanded sheet and queue overlay. Those
surfaces are similar to mobile sheets but not part of the workspace right-edge
contract. They should be handled by a future mobile-sheet primitive cutover.

### Reader system

Reader implementation docs already state that the overview ruler is not a phone
surface. The reader owns whether reader overview-ruler content exists; the
workspace owns whether fixed primary chrome can affect shell composition,
sizing, and rendering. Mobile workspace mode must make any fixed-chrome
publication inert even if a pane body publishes one during hydration or route
transitions.

### Media system

Media panes may publish fixed primary chrome on desktop. Mobile workspace mode
must make that publication inert for desktop fixed chrome rendering while
preserving legitimate mobile body content.

### Chat system

Chat owns its scrollport. Workspace must not compensate for chat gutter policy;
chat must make mobile gutter behavior correct locally.

### Tests and fixtures

Existing tests that mock viewport state should be updated to exercise both
mobile and desktop modes. Do not rely only on jsdom for geometry. The final
proof needs at least one browser test because the symptom is viewport and
scrollbar dependent.

## Risks

### Risk: masking with CSS only

If only `.edgeFade` is hidden on mobile, stale desktop edge state can remain and
reappear through future rendering changes. Mitigation: reset hook state and
guard rendering.

### Risk: breakpoint drift

If a new mobile breakpoint helper is introduced, workspace, panes, and render
environment can disagree. Mitigation: consume existing render environment state.

### Risk: over-broad sheet refactor

If every mobile sheet is migrated during this cutover, the implementation can
turn a targeted viewport fix into a broad UI refactor. Mitigation: document
duplication now, schedule the primitive as a separate hard cutover.

### Risk: desktop regression

Edge fades and stable gutter may exist for desktop usability. Mitigation:
desktop tests must prove existing desktop behavior remains intact.

### Risk: visual-only tests

Screenshots alone can miss invisible horizontal overflow. Mitigation: combine
DOM absence checks, computed geometry checks, and screenshot review.

## Rollout plan

This can ship as one hard cutover because it removes invalid mobile behavior and
does not require compatibility.

Suggested sequence:

1. Implement canvas mode and edge fade guard.
2. Add hook and workspace tests.
3. Fix pane shell mobile edge styling.
4. Fix mobile secondary sheet token.
5. Fix chat mobile scrollbar gutter.
6. Add mobile browser geometry assertions.
7. Update module docs.
8. Run targeted verification.
9. Manually review mobile and desktop screenshots.

No feature flag. No compatibility branch. No fallback CSS token.

## Verification commands

Use the repo's existing targeted test wrappers where available. React/browser
component tests run through the browser-mode wrapper, not direct `bun test`:

```bash
cd apps/web && bun run test:browser -- \
  src/components/workspace/usePaneCanvas.test.tsx \
  src/components/workspace/WorkspaceHost.test.tsx \
  src/__tests__/components/PaneShell.test.tsx \
  src/components/workspace/MobileSecondaryPaneHost.test.tsx
```

For browser coverage, use the repo's Playwright wrapper so app, backend, seed,
and auth setup stay on the supported lane:

```bash
PLAYWRIGHT_ARGS='tests/workspace-canvas.spec.ts tests/reader-pane-width.spec.ts tests/pane-chrome.spec.ts tests/conversations.spec.ts --project=chromium' make test-e2e
```

Do not invent a verification lane that bypasses repo setup.

## Definition of done

The cutover is done when:

- mobile has no right-side artifact or reserved rail in authenticated workspace
  flows
- desktop canvas edge behavior still works
- stale edge state cannot survive a desktop-to-mobile transition
- mobile chat scrollport does not reserve stable inline-end gutter
- mobile sheet tokens are valid
- owner contracts are documented
- targeted unit/component tests pass
- targeted browser geometry tests pass
- no fallback branch or legacy mobile desktop-canvas path remains

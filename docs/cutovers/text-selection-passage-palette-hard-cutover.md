# Text Selection Passage Palette Hard Cutover

**Status:** IMPLEMENTED LOCALLY · focused automated proof and visual review
passed · selected real-stack production build and default Playwright gate passed ·
deterministic real-media Link lane pending because its only public owner target
is broad and was excluded by the brief · literal browser-geometry gate for actual
backward/long Range and PDF page-scale zoom pending · physical-device gates
pending · full CI/check-front not run · 2026-07-31

**Superseded presentation:**
[`text-selection-icon-toolbar-hard-cutover.md`](text-selection-icon-toolbar-hard-cutover.md)
owns the fresh-selection action order, names, icons, tiering, and layout. Where
this document states a labeled seven-action row, a `4 + 3` mobile grid, a
viewport- or count-driven layout, palette separators, or the labels `Colour`,
`New chat`, and `Existing chat`, that document is authoritative instead;
sections 1–7, 12, and 15 carry per-section markers. Selection normalization,
floating geometry, dismissal, action write order, concurrency, single-flight,
and Undo semantics remain authoritative here.

**Posture:** One frontend hard cut. No legacy renderer, fallback viewport rule,
feature flag, compatibility prop, new dependency, backend change, or parallel
action catalog.

**Rules:** `docs/rules/{cleanliness,control-flow,frontend,simplicity}.md`,
`docs/local-rules/testing-standards.md`, and the steady-state reader/highlight
module docs govern implementation.

## 1. Decision

**Superseded:** the labeled seven-action order and the desktop-row/mobile-grid
projection. The captured selection, action set, mutations, overlays, and
`FloatingActionSurface` ownership stand.

There are no blocking questions.

Replace the fresh-text-selection icon strip with the **Passage Palette**: one
quiet, labeled action dock that preserves the selected line and the exact action
order:

```text
Colour · Note · Link | Share | Learn · New chat · Existing chat
```

Desktop uses one labeled row. Mobile uses one non-scrolling `4 + 3` grid. The
same captured selection, actions, mutations, overlays, and `FloatingActionSurface`
remain authoritative.

## 2. Philosophy, Goals, And Scope

**Superseded:** the seven-action stop line and the readable-label goal; the
direct row is icon-only. The preserve-the-line, stable-order, escalate-depth,
and quiet-press goals stand.

- **Preserve the line.** The surface stays near the passage without covering it.
- **Preserve muscle memory.** Order never changes from history, prediction, or AI.
- **Escalate depth, not chrome.** Actions open existing owned workflows; the
  palette contains no preview, prompt, or mini-application.
- **Quiet press.** Warm paper, ink, hairline, restrained elevation, readable
  labels, and exact motion. No glass, gradient, sparkle, or AI-dashboard styling.
- **80/20 stop line.** Stop when the seven actions are beautiful, legible,
  race-safe, keyboard-operable, selection-safe, and viewport-safe in HTML and
  PDF readers.

Goals are visible comprehension, stable muscle memory, touch/keyboard parity,
race safety, and less code. Scope is the fresh-selection renderer, its floating
geometry integration, reader creation guard, focused proof, and contradicted
docs. Everything named in section 14 is outside the cut.

## 3. Target Behavior

**Superseded:** the Desktop and Mobile label, grouping, grid, reflow, and
target-size clauses; density is pointer-owned, not viewport-owned. Placement,
clamping, caret, safe-area, native-edit-menu, material, and motion clauses
stand.

### Desktop

- Render one horizontal labeled dock in the canonical order above.
- Group authoring (`Colour`, `Note`, `Link`), transfer (`Share`), and thinking
  (`Learn`, chat) with two hairline separators.
- Each control is at least `44px` high; icon and visible label form one target.
- Prefer above/below placement, `8px` from the nearest selected line; clamp to
  the visual viewport without covering the passage when either side fits.
- Width is content-driven and viewport-clamped. It never horizontally scrolls.

### Mobile And Coarse Landscape

- Keep `FloatingActionSurface`; do not migrate to `MobileSheet` or a modal.
- Render four equal columns followed by three equal columns:

  ```text
  Colour     Note       Link          Share
  Learn      New chat   Existing chat
  ```

- Each control is at least `48px` in both axes. Labels may wrap to two lines.
- The surface consumes available safe width up to `360px`. It has no `228px`
  cap and no horizontal scrolling.
- At an effective viewport width below `240px`, including browser zoom/reflow,
  use two columns and let the color swatches wrap; targets never shrink.
- Prefer below the last selected line, then above the first, then a free side;
  use the existing safe-edge placement only when none fits.
- Respect `visualViewport`, safe-area tokens, mobile chrome clearance, browser
  zoom, text reflow, and the canonical coarse-landscape mobile classification.
- Native Copy, Look Up, Translate, and platform selection handles remain usable;
  Nexus does not replace or intercept the OS edit menu.

### Material And Motion

- Use existing surface, ink, edge, radius, shadow, duration, easing, and focus
  tokens. Add no palette-specific color system.
- Use one lifted opaque paper surface, one hairline, one restrained shadow, and
  a clear pressed/busy state.
- Enter with the existing fast duration: fade, `0.98 -> 1` scale, and at most
  `4px` travel away from the selected passage. Reduced motion is fade-only.
- Above/below placement has one `6px` hairline caret aimed at the selection
  center. `FloatingActionSurface` computes its clamped inline offset without a
  new public prop; side/edge placement hides it.
- In forced colors, use an opaque system surface, explicit border/focus outline,
  and non-color selected/busy indicators.

## 4. Action Semantics

**Superseded:** the action names only. Every required behavior, capability
gating, order-stability, and busy-in-place rule below stands.

Presentation changes only. Existing capability owners and write order remain:

| Action        | Required behavior                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Colour        | Open the existing color picker. A swatch creates/reuses the Highlight in that color. Opening/cancelling writes nothing.            |
| Note          | Open the existing quick-note composer synchronously while its current Highlight creation promise runs.                             |
| Link          | Open universal Link target search. Create the Highlight and Link only on target confirmation; cancel writes nothing.               |
| Share         | Create/reuse the default-yellow Highlight, then open the existing anchored Share surface.                                          |
| Learn         | Create/reuse the default-yellow Highlight, then run the existing durable Idea Dossier flow.                                        |
| New chat      | Create/reuse the default-yellow Highlight, then launch the existing new-chat intent. Create no conversation until send.            |
| Existing chat | Create/reuse the default-yellow Highlight, then open the existing destination chooser. Create no conversation mutation until send. |

Full-capability readers show all seven. Existing capability gating remains
canonical for genuinely unavailable actions, including unreliable PDF text
geometry. Never reorder remaining actions. Busy actions remain in place.

## 5. Final Architecture

**Superseded:** the dock's labeled desktop/mobile rendering and the
responsive-classification ownership row. `projectSelectionActionPlan` sits
between `buildHighlightActions` and `SelectionActionDock` and owns tiering and
order; `ActionMenu` renders the overflow tier; density is pointer-owned CSS.
Every other ownership row stands.

```text
MediaPaneBody / PdfReader
  capture canonical selection + rects
  own Highlight creation and mutation single-flight
            |
            v
SelectionPopover
  own fresh-selection lifecycle and action sequencing
            |
            v
buildHighlightActions
  own action identity, order, labels, icons, grouping, and capability gating
            |
            v
SelectionActionDock
  own labeled desktop/mobile rendering, color disclosure, and toolbar focus
            |
            v
FloatingActionSurface
  own portal, selection geometry, viewport/safe-area bounds, and dismissal
```

`ActionBar` and `ActionMenu` remain the renderers for existing Highlight
surfaces. They do not render fresh-selection actions after this cut.

### Ownership Rules

| Concern                                 | Sole owner                                            |
| --------------------------------------- | ----------------------------------------------------- |
| DOM/PDF selection normalization         | `MediaPaneBody` / `PdfReader`                         |
| Durable Highlight creation              | existing reader creation handlers                     |
| Composite create-then-open sequencing   | `SelectionPopover`                                    |
| Action catalog/order/gating             | `buildHighlightActions`                               |
| Passage Palette layout/focus            | `SelectionActionDock`                                 |
| Floating geometry/dismissal             | `FloatingActionSurface`                               |
| Responsive classification               | `RenderEnvironmentProvider` via `useIsMobileViewport` |
| Share, Learn, Link, Note, chat behavior | their existing subsystem owners                       |

## 6. Capability And Component Contracts

**Superseded:** the `SelectionActionDockProps` shape, the visible-label and
separator rendering rules, and the selection label list. `SelectionPopover`'s
external contract, the single `PaneHeaderAction` schema, the local pending-action
union, the reuse-existing-primitives rule, and the no-new-dock-framework rule
stand.

No network or persistence API changes.

`SelectionPopover` retains its current external contract: canonical rects,
container ref, existing callbacks, dismissal, and reader-owned busy state. It
continues to be generic over the created Highlight identity.

`SelectionActionDock` is internal to `components/highlights`:

```ts
type SelectionPendingActionId =
  "color" | "share" | "learn" | "quote-new" | "quote-existing";

interface SelectionActionDockProps {
  readonly actions: readonly PaneHeaderAction[];
  readonly pendingActionId: SelectionPendingActionId | null;
  readonly externalBusy: boolean;
}
```

Rules:

- accept only the canonical descriptors returned for a `selection` target;
- render `descriptor.label` visibly; accessible names equal visible labels;
- render descriptor icons, state, disabled reason, separators, and custom color
  disclosure without copying action business logic;
- preserve DOM order across desktop and mobile;
- branch exhaustively on descriptor `kind`; unexpected states defect;
- use existing `Button`, `HighlightColorPicker`, `FloatingActionSurface`,
  `projectActionControlState`, `nextRovingIndexForKey`, `cx`, and design tokens;
- add no generic dock framework, registry, slot API, polymorphic layout option,
  or second descriptor type.

For `target.kind === "selection"`, `buildHighlightActions` owns the concise
labels `Colour`, `Note`, `Link`, `Share`, `Learn`, `New chat`, and
`Existing chat`, plus separators before `Share` and `Learn`. Existing-Highlight
labels remain unchanged.

No durable, transport, or domain schema changes. New action state is limited to
the local pending-action union above, the renderer sequencing ref, and the
reader-owned fresh-selection action and Link-session ownership refs; retained
Range geometry and compact placement remain local reader/surface state.
Existing `PaneHeaderAction` remains the one action descriptor schema.

## 7. Interaction And Accessibility Contract

**Superseded:** the two-projection wording and the 44px desktop / 48px mobile
swatch split. The toolbar role and name, the single roving tab stop, `Alt+F10`,
Escape unwinding, focus restoration, selection preservation, `aria-disabled`
busy treatment, the status-channel rules, and the zoom clause stand.

- The surface is `role="toolbar"`, `aria-label="Selection actions"`, and
  `aria-orientation="horizontal"` in both projections; expose
  `aria-keyshortcuts="Alt+F10"`.
- It exposes one tab stop. Reuse `nextRovingIndexForKey` for Left/Right and
  Home/End navigation in DOM order; do not wrap.
- While a selection palette exists, `Alt+F10` focuses its current roving item.
  Do not add a global bindable action or bare-character shortcut.
- Escape closes nested color disclosure first, then the palette. If focus
  entered the palette, dismissal restores the pre-palette focused element.
- Pointer-down inside the surface continues preventing selection collapse.
- Opening the palette never steals focus. Pointer users retain native selection;
  keyboard users opt in with `Alt+F10`.
- Busy state is announced once, leaves layout stable, and blocks reactivation.
  Use `aria-disabled` rather than removing or natively disabling the focused
  action; busy never ejects focus from the toolbar.
- Reader-owned creation projects as `externalBusy` only without a local pending
  action. The busy toolbar has one specific pending status or one generic
  `Selection action in progress` status, never a synthetic action.
- Color swatches use the existing labels and pressed state, with `44px` desktop
  and `48px` mobile targets. Color is never the only selected-state signal.
- Focus is never obscured by the palette or mobile chrome at 200% zoom.

## 8. Concurrency And Failure Rules

- A rapid double activation can produce at most one highlight-first composite
  action and at most one downstream destination launch.
- `SelectionPopover` acquires a synchronous ref-backed action lock before any
  color/share/learn/chat create-then-open sequence. React render-time `busy`
  state is presentation, not the correctness guard.
- `MediaPaneBody` protects every fresh-selection action entrypoint with one
  synchronous reader-owned ref, covering Note, Link, highlight-first actions,
  bare-`n`, and other same-turn callers.
- `PdfReader` independently protects its canonical Highlight-creation
  entrypoint with a synchronous ref.
- The retained snapshot ref is the sole action authority; synchronous clearing
  invalidates stale render handlers in the same turn.
- Duplicate reuse and create success hold the reader lock until selection
  retirement renders; `null` or throw releases it immediately for retry.
- Fresh-selection Link cancel releases its owned lock while retaining the
  selection; success retires the selection before release, and failure keeps
  the retryable Link session locked.
- Note and Link retain their distinct semantics; they must not be routed through
  the default highlight-first helper.
- Do not add retries, debounce, timers, queues, optimistic Highlight objects, or
  swallowed errors.

## 9. Hard Cut And Deletions

- Create the dedicated `SelectionActionDock`; mount it directly from
  `SelectionPopover`.
- Remove `SelectionProps`, `SelectionActionBar`, and `variant="selection"` from
  `HighlightActionBar`.
- Remove the now-single-value `variant="existing"` prop from remaining
  `HighlightActionBar` call sites.
- Delete the selection popover's icon-only and `228px` capsule CSS.
- Delete `useFloatingActionMobileViewport` and its raw `innerWidth <= 768`
  rule. `FloatingActionSurface` uses `useIsMobileViewport` with no fallback.
- Delete tests and comments that specify icon-only selection actions or
  `role="group"` for the palette; replace them with observable final behavior.
- Do not duplicate `buildHighlightActions`, color-picker logic, viewport
  measurement, safe-area reads, or action sequencing.

## 10. Files

### Create

- `apps/web/src/components/highlights/SelectionActionDock.tsx` — own the single
  local/external busy announcement.
- `apps/web/src/components/highlights/SelectionActionDock.module.css`
- `apps/web/src/components/highlights/SelectionActionDock.test.tsx`

### Modify

- `apps/web/src/components/SelectionPopover.tsx` — project reader-owned creation.
- `apps/web/src/components/SelectionPopover.module.css`
- `apps/web/src/__tests__/components/SelectionPopover.test.tsx`
- `apps/web/src/components/highlights/highlightActions.tsx`
- `apps/web/src/components/highlights/highlightActions.test.ts`
- `apps/web/src/components/highlights/highlightActions.test.tsx`
- `apps/web/src/components/highlights/HighlightActionBar.tsx`
- `apps/web/src/components/highlights/HighlightActionBar.test.tsx`
- `apps/web/src/components/highlights/HighlightActionPopover.tsx`
- `apps/web/src/components/highlights/HighlightActionPopover.test.tsx` — compose
  the shared render environment for the production-owned mobile overlay.
- `apps/web/src/components/reader/document-map/EvidenceItemRow.tsx`
- `apps/web/src/components/ui/ActionBar.test.tsx` — proof-fixture change only;
  compose the shared render environment without changing `ActionBar` production.
- `apps/web/src/components/ui/FloatingActionSurface.tsx`
- `apps/web/src/components/ui/FloatingActionSurface.module.css`
- `apps/web/src/components/ui/FloatingActionSurface.test.tsx`
- `apps/web/src/lib/mobileViewport/MobileViewportProvider.tsx`
- `apps/web/src/lib/mobileViewport/MobileViewportProvider.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` — own the
  reflowable fresh-selection action lock and release transitions.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx` — prove
  cross-action same-turn exclusion, retirement release, and immediate retry.
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/__tests__/components/PdfReader.test.tsx`
- selection-label consumers in `e2e/tests/{epub,notes,quote-attach-references,web-articles,youtube-transcript}.spec.ts`
- `e2e/tests/selection.ts`
- `e2e/tests/universal-linking.spec.ts`
- `e2e/tests/real-media/quote-to-chat.spec.ts`
- `e2e/tests/real-media/real-media-seed.ts`
- `docs/modules/{chat,highlight,reader-design-rationale,reader-implementation}.md`
- `docs/cutovers/highlight-quick-note-composer-hard-cutover.md`
- `docs/cutovers/reader-highlight-quote-chat-hard-cutover.md`
- `docs/cutovers/universal-link-authoring-hard-cutover.md`

### Explicitly Unchanged

- `ActionBar` production, `ActionMenu`, `Button`, and their non-selection
  contracts;
- Highlight, Link, Share, Learn/Artifact, Note, and chat APIs/services/schemas;
- database models, migrations, workers, BFF routes, and Android native code;
- selection offset/quad capture, mobile stabilization timing, and OS edit menus.

## 11. Implementation Order

1. Record focused baselines; add independently specified failing browser proof.
2. Make selection labels/grouping canonical and harden both Highlight creation
   owners against same-turn re-entry.
3. Cut `FloatingActionSurface` to the canonical viewport owner.
4. Build `SelectionActionDock`; wire `SelectionPopover`; delete the selection
   branch from `HighlightActionBar` in the same change.
5. Update journeys and steady-state module docs; delete contradicted CSS,
   tests, comments, props, and imports.
6. Run focused proof, source gates, screenshots, and physical-device checks.

No intermediate dual renderer may merge.

## 12. Acceptance Criteria

**Superseded:** AC-1 and AC-2, and the action names in AC-5. The remaining
criteria stand.

- **AC-1:** A full-capability HTML or reliable-text PDF selection visibly shows
  the seven labeled actions in the exact canonical order.
- **AC-2:** Desktop is one labeled row with `>=44px` targets; 390px and 320px
  mobile are a non-scrolling `4 + 3` grid with `>=48px` targets; effective
  widths below 240px reflow to two columns without shrinking targets.
- **AC-3:** No palette or child control crosses the visual viewport, safe area,
  or mobile content bottom clearance at normal and 200% zoom.
- **AC-4:** Long, multiline, backward, near-edge, nested-scroll, and PDF
  selections do not lose or cover the selected passage when a fitting side
  exists.
- **AC-5:** Colour, Note, Link, Share, Learn, New chat, and Existing chat retain
  the exact write order and cancellation semantics in section 4.
- **AC-6:** Two same-turn activations create at most one Highlight and launch at
  most one terminal destination; a failed creation remains retryable.
- **AC-7:** The toolbar has one tab stop; `Alt+F10`, Left/Right, Home/End, Escape,
  nested color focus, and focus restoration satisfy section 7.
- **AC-8:** Pointer interaction preserves the native selection; native OS edit
  menus and selection handles still work on iOS Safari and Android WebView.
- **AC-9:** Reduced motion, forced colors, keyboard-only, VoiceOver/TalkBack,
  and color-independent states remain understandable.
- **AC-10:** Canonical mobile classification includes `769-900px` coarse
  landscape; no raw `innerWidth <= 768` selection-surface rule remains.
- **AC-11:** Existing Highlight action bars/menus and every downstream workflow
  are behaviorally unchanged.
- **AC-12:** The old icon-only selection renderer, mobile capsule cap, variant
  props, stale tests/docs, compatibility paths, and duplicate logic are absent.

## 13. Verification Contract

- Pure descriptor proof: selection order, labels, separators, gating, and busy
  state; existing-Highlight labels/actions unchanged.
- Real Chromium component proof: real CSS geometry at `1280x800`, `390x844`,
  `320x568`, and coarse `844x390`; target rectangles, no overflow, collision,
  roving focus, color disclosure, reduced motion, and forced colors.
- Component sequencing proof: each action's observable outcome plus controlled
  unresolved creation proving same-turn single-flight and retry after failure.
- Reader/PDF component proof: retained selection, actual owner wiring, unreliable
  PDF gating, scroll/resize/zoom repositioning, and Escape.
- Existing journeys: Note, Link, color, and quote-to-chat. Extend the current
  Share and Learn selection journeys only where their wiring is not already
  proved; do not add a broad duplicate E2E suite.
- Review screenshots for desktop, compact mobile, coarse landscape, dark theme,
  forced colors, and 200% zoom. Do not accept broad snapshots as the oracle.
- Manual physical iOS Safari and Android WebView checks are required for native
  edit-menu, handles, safe areas, VoiceOver/TalkBack, and coarse-pointer reality.
- Run focused browser files first, then `make check-front`, the smallest owning
  browser lane, selected existing Playwright files, and `git diff --check`.
- Negative scan of production source proves no `variant="selection"`,
  `variant="existing"`, `228px` palette cap, raw floating-surface mobile hook,
  duplicate action array, feature flag, compatibility prop, or new
  backend/persistence surface.

## 14. Non-Goals

- AI action ranking, personalization, history-based reorder, telemetry, or A/B test;
- radial/marking gestures, hover previews, inline Learn output, or command palette;
- native Android/iOS edit-menu projection;
- Floating UI, CSS Anchor Positioning, View Transitions, or another dependency;
- a generic responsive action-dock design system;
- redesigning existing Highlight cards/menus, color taxonomy, downstream
  overlays, reader selection capture, or mobile shell chrome;
- backend, persistence, schema, migration, worker, auth, or sharing-policy work.

## 15. Final-State Laws

**Superseded:** "Labels are visible" and "responsive behavior comes from the
canonical render environment" — direct actions are icon-only, overflow actions
are text-labeled, and density follows the pointer. The remaining laws stand.

- One selection, one palette, one action catalog, one geometry owner.
- Order is stable; capability may remove an action but never move another.
- Labels are visible; icons support meaning but never carry it alone.
- Responsive behavior comes from the canonical render environment.
- UI busy state communicates; synchronous refs enforce single-flight.
- The palette opens existing capabilities and owns none of their domain logic.
- Every removed path stays removed.

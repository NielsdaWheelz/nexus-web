# Text Selection Icon Toolbar Hard Cutover

**Status:** APPROVED SPECIFICATION
**Date:** 2026-08-03
**Type:** frontend presentation hard cut; no compatibility period
**Open questions:** none

## 1. Decision

Replace the fresh-text-selection Passage Palette with one compact, icon-only toolbar:

`Highlight · Note · Link · Ask · More`

`More` opens one labeled menu, in this order:

`Learn · Ask in existing chat… · Share`

This document supersedes only the fresh-selection action order, labels, icons, and layout specified by `text-selection-passage-palette-hard-cutover.md`. That document remains authoritative for selection normalization, geometry, dismissal, mutation timing, Undo, concurrency, and downstream ownership.

## 2. Goals

- Make the common path legible at a glance and operable with one hand.
- Order actions by increasing semantic depth: mark, interpret, connect, interrogate.
- Keep one stable action grammar across HTML and PDF readers.
- Preserve every existing write, cancellation, single-flight, and capability invariant.
- Reduce UI and code paths: one catalog, one projection, one toolbar, one menu primitive.

## 3. Non-goals

- Changing selection geometry, anchoring, dismissal, or browser selection handling.
- Changing Highlight, Note, Link, Learn, Share, or chat domain APIs.
- Redesigning actions for an existing Highlight.
- Auto-applying the last-used colour, adding preferences, or changing Undo semantics.
- User-customizable, adaptive, telemetry-ranked, or AI-ranked actions.
- New backend endpoints, persistence, migrations, analytics, or feature flags.
- A new general tooltip, menu, or action-descriptor framework.

## 4. Capability contract

### 4.1 Canonical plan

For a fresh selection, the complete semantic order is fixed:

| Tier | Action ID | Accessible/visible name | Icon |
|---|---|---|---|
| Direct | `color` | `Highlight` | `Highlighter` plus current-colour indicator |
| Direct | `note` | `Note` | `NotebookPen` |
| Direct | `link` | `Link` | `Link2` |
| Direct | `quote-new` | `Ask` | `MessageCircleQuestion` |
| Overflow | `learn` | `Learn` | existing catalog icon |
| Overflow | `quote-existing` | `Ask in existing chat…` | existing catalog icon |
| Overflow | `ResourceAction.Share` | `Share` | resource-action catalog icon |

The toolbar then appends an `Ellipsis` trigger named `More` iff at least one overflow action is present. `More` is presentation, not a domain action.

Rules:

1. Eligibility remains owned by `buildSelectionActions` and its existing inputs.
2. Ineligible actions are absent. A temporarily busy action remains in its canonical slot and is disabled.
3. Surviving actions retain relative order. Missing actions do not promote overflow actions.
4. Order never depends on history, viewport width, telemetry, model output, or usage frequency.
5. Every action ID appears in exactly one tier. Unknown or duplicate IDs are programmer defects.
6. Existing-Highlight descriptors and ordering are unchanged.

### 4.2 Behaviour

Presentation changes only. Preserve this exact write order:

| Action | Required behavior |
|---|---|
| Highlight | Open the existing colour picker. A swatch creates/reuses the Highlight in that colour; open/cancel writes nothing. |
| Note | Open the quick-note composer synchronously while its current Highlight-creation promise runs. |
| Link | Open universal Link search; create the Highlight and Link only on confirmation; cancel writes nothing. |
| Ask | Create/reuse the default-yellow Highlight, then launch the new-chat intent; create no conversation until send. |
| Learn | Create/reuse the default-yellow Highlight, then run the durable Idea Dossier flow. |
| Ask in existing chat… | Create/reuse the default-yellow Highlight, then open destination selection; create no conversation mutation until send. |
| Share | Create/reuse the default-yellow Highlight, then open the anchored Share surface. |

- A pending action preserves the existing single-flight lock. The action stays visible; the toolbar exposes busy status. If the pending action is in overflow, `More` exposes the busy state.

No component may reimplement these commands or write around their current owners.

## 5. Presentation contract

### 5.1 Density

- Fine pointer: 32 by 32 px direct controls; 16 px glyphs; 4 px gap.
- Coarse pointer: 44 by 44 px direct controls; the same glyph scale.
- One content-sized row. No labels, separators, wrapping, scrolling, grids, count-based CSS, or responsive reordering.
- Preserve existing viewport clamping, caret placement, collision flipping, and safe-area handling.
- Colour is a stateful parameter of `Highlight`, not a separate verb. The glyph must identify the action without its colour indicator; the open picker retains labeled, pressed colour states.

### 5.2 Semantics and input

- The direct row remains one named `toolbar` with one roving tab stop.
- Each icon control has its canonical accessible name and matching native `title`; decorative SVGs are hidden from accessibility APIs.
- Preserve `Alt+F10`, Arrow Left/Right, Home/End, Enter/Space, Escape unwinding, focus restoration, and bare `n` Note behavior.
- `More` participates in the toolbar's roving sequence and opens the existing `ActionMenu`; its items are text-labeled and use the menu's keyboard/focus contract.
- Opening and using either colour or overflow must preserve the native text selection.
- Nested Escape closes the nested surface first, then the selection surface.
- Disabled reasons and pending announcements remain exposed through the current status channel.
- Focus indicators, forced colours, reduced motion, zoom, and screen-reader names must remain usable.

Native `title` is sufficient for this cut. A custom tooltip system is separate work; a local selection-only tooltip is forbidden.

## 6. Architecture and composition

```text
MediaPane / PdfReader
  -> SelectionPopover                 selection lifecycle and command sequencing
    -> buildSelectionActions          transient action identity, eligibility, semantics
      -> projectSelectionActionPlan   fixed direct/overflow projection
        -> SelectionActionDock        toolbar, roving focus, pending presentation
          -> ActionMenu               overflow interaction and labeled items
    -> FloatingActionSurface          geometry, portal, dismissal, selection preservation
```

Ownership laws:

- `buildSelectionActions` remains the only fresh-selection action catalog.
  Materialized Highlights use the canonical `ResourceActionMenu`; selection
  code never supplies their standing actions.
- Add one pure, selection-specific projection beside that catalog. Do not add prominence or tier fields to the generic action schema.
- `SelectionActionDock` renders the supplied plan; it does not infer capability, rank actions, or synthesize domain commands.
- `ActionMenu` is the only overflow-menu primitive. Do not use or extend the resource-action runtime; selection actions are outside its ownership.
- `FloatingActionSurface` remains the only selection-surface geometry and dismissal owner. Nested menu portals must use its existing transient-container/dismiss-ignore contract.
- Downstream composers and mutations remain authoritative. UI composition must not create a second write lane.

### 6.1 Local frontend API

```ts
type SelectionActionPlan = Readonly<{
  direct: readonly PaneHeaderAction[];
  overflow: readonly PaneHeaderAction[];
}>;

function projectSelectionActionPlan(
  actions: readonly PaneHeaderAction[],
): SelectionActionPlan;
```

The projector is pure and exhaustive over the fresh-selection action IDs. It:

- partitions without changing handlers, disabled state, tone, or custom renderers;
- emits the canonical order above, independent of input order;
- removes obsolete palette separators from its projected menu descriptors;
- throws on duplicate or unclassified IDs in every environment; there is no fallback tier;
- is never called for an existing-Highlight target.

No HTTP, database, event, URL, or cross-process contract changes.

## 7. Hard cutover and deletion

In the same implementation change:

- Delete the seven-label Palette renderer and label-specific styling.
- Delete the desktop labeled-row and mobile 4+3/two-column grid paths.
- Delete count-based selectors, responsive reorder logic, legacy separators, and obsolete width assumptions.
- Replace old order/layout assertions and fixtures; do not retain dual expectations.
- Update the superseded presentation clauses in the implemented Passage Palette cutover and reader module docs to point here.
- Remove imports, helpers, CSS, and tests made unreachable by the cut.

Forbidden:

- legacy props, compatibility adapters, fallback ordering, duplicated action arrays, or a second mobile renderer;
- viewport-driven movement between direct and overflow;
- silently placing unknown actions into `More`;
- speculative extraction of a repository-wide toolbar or tooltip abstraction.

## 8. Files

Expected implementation surface:

- `apps/web/src/components/highlights/highlightActions.tsx`
- `apps/web/src/components/highlights/highlightActions.module.css`
- `apps/web/src/components/highlights/highlightActions.unit.test.tsx`
- `apps/web/src/components/highlights/SelectionActionDock.tsx`
- `apps/web/src/components/highlights/SelectionActionDock.module.css`
- `apps/web/src/components/highlights/SelectionActionDock.browser.test.tsx`
- `apps/web/src/components/SelectionPopover.tsx`
- `apps/web/src/components/SelectionPopover.module.css`
- `apps/web/src/components/PdfReader.browser.test.tsx`
- `docs/modules/highlight.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/reader-design-rationale.md`
- `docs/modules/chat.md`
- `docs/cutovers/text-selection-passage-palette-hard-cutover.md`

`ActionMenu`, `FloatingActionSurface`, generic action schemas, resource-action infrastructure, backend code, and migrations should not change unless an existing contract defect is proven first.

## 9. Acceptance criteria

1. A full-capability fresh selection exposes direct controls in exact order: `Highlight`, `Note`, `Link`, `Ask`, `More`.
2. `More` exposes exact labeled order: `Learn`, `Ask in existing chat…`, `Share`.
3. The direct row contains no visible action text and remains a single row at supported viewport widths and zoom levels.
4. Fine/coarse target sizes, icon scale, gap, colour state, and focus treatment meet Section 5.
5. HTML, reliable-text PDF, and unreliable-geometry PDF each omit only capability-ineligible actions; survivor order is stable.
6. Toolbar, nested colour picker, and overflow menu pass keyboard, pointer, touch, focus-return, screen-reader-name, and Escape tests.
7. Native selection survives all pointer/menu interactions; outside dismissal, browser Back, and focus restoration retain current behavior.
8. Every action preserves Section 4.2 write order plus existing cancellation, single-flight, pending, failure, and Undo behavior.
9. Existing-Highlight actions are unchanged.
10. Old labels, grids, responsive ordering, dead CSS/helpers, and dual tests are absent.
11. No backend, persistence, generic schema, or public API changed.

## 10. Verification

- Unit-test the projector's exact order, partial capabilities, disabled preservation, separator removal, duplicate IDs, and unknown IDs.
- Browser-test the toolbar/menu DOM order, visible text absence, target sizes, roving focus, nested Escape, busy state, and native-selection preservation.
- Retain PDF capability and real-stack Highlight/Note provenance coverage.
- Prove test sensitivity by running the focused contract once with one deliberate wrong-order/legacy-layout mutation, then revert it.
- Use only `./scripts/test changed <paths>` during implementation and `./scripts/test confidence` before handoff when the affected closure warrants it.
- Manually inspect desktop, Android WebView, iOS Safari, 200% zoom, keyboard-only, and forced-colours states.

## 11. Final-state laws

1. There is one fresh-selection action catalog and one fixed presentation projection.
2. Capability decides presence; it never decides priority.
3. Direct actions are icon-only; overflow actions are text-labeled.
4. Colour configures Highlight; it is not a sibling capability.
5. Menus, geometry, mutations, and downstream workflows retain their existing owners.
6. The repository contains no legacy Passage Palette layout path.

# Command Palette — Inline Tab Close (Hard Cutover)

Status: Planned.
Scope owner: command palette surface (`apps/web`), specifically the `open-tabs` section on both shells and the supporting controller/row plumbing.
Related: `docs/command-palette.md`, `docs/command-palette-global-cutover.md`, `docs/workspace-tabs.md`.
Date: 2026-05-25.

## 1. Problem

The command palette's `open-tabs` resting section renders each open pane as TWO separate `PaletteCommand` entries:

- `pane-${pane.id}` — title is the pane title; selecting it activates the pane.
- `pane-close-${pane.id}` — title is `"Close ${title}"`; selecting it closes the pane.

Both are pushed into `sectionId: "open-tabs"` in
`apps/web/src/components/CommandPalette.tsx:208-239`, so the resting list reads:

```text
OPEN TABS
  📄  My Doc
  ✕   Close My Doc
  📄  Other Doc
  ✕   Close Other Doc
```

This is functionally correct but UX-poor:

- The most populated resting section is twice as long as it needs to be: `N` panes → `2N` rows.
- In the querying state, the close row participates in ranking. A query like `"doc"` can rank `Close My Doc` adjacent to or above unrelated higher-relevance results because the close row inherits the pane's keywords (`["tab", "pane", "close", pane.href]`).
- Screen readers announce `option K of N — Close colon My Doc`, an awkward utterance for what is logically a secondary destructive action on the row above it.
- Every shipped mobile reference for this interaction — Chrome's tab switcher, iOS Mail account/mailbox lists, Slack channel switchers, Linear command-K, Raycast, VS Code Quick Open, and this repo's own redesigned desktop pane strip (`WorkspacePaneStrip.tsx`, commit `c0c4949`) — uses **one row per tab with an inline trailing close affordance**.
- The team already codified the inline-X pattern internally for the desktop pane strip in `docs/workspace-tabs.md:22-28`:
  > Each tab has one activator and one action group. … The action buttons are pointer affordances with `tabIndex={-1}`. Keyboard users close the focused pane with `Delete` or `Backspace`.

The fix is a hard cutover: open-tab palette rows become single rows with an inline trailing close button on both shells, mirroring the pane-strip pattern. The separate `pane-close-*` command is deleted.

## 2. Goals

- Render each open pane as exactly one row in the command palette, on both shells.
- Provide an inline trailing close button on those rows that closes the pane without dismissing the palette.
- Preserve every other palette capability: open-tab activation, ranking, querying, mobile presentation, desktop keyboard navigation, search and pinned affordances, Android shell restrictions, history recording on primary selection.
- Match the desktop pane-strip's activator + close pattern at the visual and interaction level so the palette feels coherent with the workspace strip.
- Keep `PaletteRow` platform-agnostic: no `isMobile` branch in row code; hover-reveal vs always-visible is driven by `@media (hover: hover) and (pointer: fine)` in CSS only.
- Delete every reference to `pane-close-${pane.id}` synthesis in the same change.

## 3. Non-Goals

- Redesigning any other palette section (`recent`, `recent-folios`, `create`, `navigate`, `settings`, `search`, pinned rows).
- Adding trailing actions to non-tab rows. This change introduces the `trailingAction` field but uses it only for `open-tabs`. No other section gains a trailing action.
- Introducing a multi-purpose secondary-action registry, an adapter from `PaletteCommand` to `ActionMenuOption`, or a shared trailing-action factory. One concrete caller; no abstraction until a second real caller arrives.
- Changing the workspace pane strip, `closePane` semantics in the workspace store, palette history persistence, or the search/Oracle providers.
- Changing how the active pane is tracked or what `closePane` does to the active pane.
- Multi-select, drag-to-reorder, or any other gesture in the palette beyond the existing swipe-down dismiss.
- Animating row removal when a tab is closed.
- Introducing a feature flag, compatibility shim, dual-code-path, or a "show old close rows" preference.

## 4. Target Behaviour

### 4.1 Open-tab row anatomy

A single row per open pane:

```text
┌──────────────────────────────────────────────────────┐
│ 📄  My Document                                  ✕   │
└──────────────────────────────────────────────────────┘
   ▲                                                ▲
   icon + title (primary tap area → activate)       inline close button
```

- Primary tap target: the row body (icon + title region). Activating it performs the existing tab-switch target and dismisses the palette.
- Trailing tap target: the inline close button. Tapping it closes the pane and **keeps the palette open**.
- Both targets are ≥44×44px (`--size-xl`). The row's right-edge padding shrinks so the close button has its own hit area separated from the primary target by ≥8px.

### 4.2 Resting state

`open-tabs` remains the first resting section when at least one open pane exists. The section omits the inline title-only header changes — only the row anatomy changes. Rows are still ordered by frecency/recency descending; section ordering, labels, and section visibility rules are unchanged.

### 4.3 Querying state

Open-tab rows still appear in the flat ranked querying list when their score is high enough.

- The inline close button is rendered on querying open-tab rows just as in resting.
- The "Tab" type tag is suppressed on open-tab rows in querying — the close icon visually identifies the row as a tab. (Other section tags are unchanged.)
- The deleted `pane-close-*` command no longer competes in ranking. A query like `"close"` no longer surfaces a row per open pane.

### 4.4 Desktop shell behaviour

- Hover/focus-within reveal: the trailing close button is rendered at low opacity (≈0.4) at rest and at full opacity when the row is active (`data-active="true"`), hovered, or contains the focused element. Gated by `@media (hover: hover) and (pointer: fine)` so touch never relies on hover.
- Keyboard close path: when the active listbox row has a `trailingAction` AND the input is empty, pressing `Delete` invokes the trailing action without dismissing the palette. `Backspace` is reserved for input editing and never invokes the close action. If the input is non-empty, `Delete` performs its default text-editing behaviour. The active row remains active after a close.
- Mouse click on the inline close button: closes the pane, keeps the palette open. The row body's `onClick` does not fire (event propagation is stopped on the button).
- Per-row shortcut hints: still rendered on rows that have a `shortcutLabel` AND no `trailingAction`. An open-tab row's trailing slot is the close button; it never shows a shortcut hint. (Open-tab rows do not declare shortcut labels today.)
- Active-row scroll-into-view, `aria-activedescendant`, and Esc/backdrop dismiss are unchanged.

### 4.5 Mobile shell behaviour

- The inline close button is rendered at full opacity at all times. No hover-reveal.
- Tap on the button closes the pane and keeps the palette open; the row body's `onClick` does not fire.
- Tap on the row body activates the pane and closes the palette (unchanged).
- `visualViewport` sizing, swipe-down dismiss, Android-back dismiss, the close-palette button, the absence of autofocus, and the absence of shortcut hints are unchanged.
- The close button's hit target is ≥44×44px regardless of visible icon size, matching the row's `--size-xl` floor.

### 4.6 Selection vs trailing-action semantics

Selecting a command and invoking a row's trailing action are distinct paths with different post-conditions:

| Path | Closes palette | Records `palette-selections` | Notes |
|---|---|---|---|
| Primary selection (row body tap / Enter on active row) | yes | yes | Identical to today |
| Trailing action (inline button tap / `Delete` on active row with empty input) | **no** | **no** | New path; preserves the user's flow when closing multiple tabs |

The trailing action is not a "selected command" — it is a secondary action on a command that remains visible. It is not recorded in palette history.

## 5. Final State

After the cutover:

- `apps/web/src/components/CommandPalette.tsx` no longer pushes any `pane-close-${pane.id}` command into the command list. Each open pane contributes exactly one `PaletteCommand` whose row carries an inline `trailingAction`.
- The `pane-close:${pane.id}` action handler in the controller's command executor is unchanged in shape but is now invoked via a new `onTrailingAction` path that does **not** close the palette or record palette history.
- `PaletteCommand` has one new optional field, `trailingAction?: { actionId: string; ariaLabel: string }`. No other field is added.
- `PaletteRow` renders a `<button type="button" tabIndex={-1}>` in the trailing slot when `command.trailingAction` is present, replacing the tag/shortcut/meta span for that row.
- `PaletteBody` owns the `Delete`-key handler that maps to the active row's trailing action under the guards in §4.4.
- `PaletteBody.module.css` exposes a `.trailingButton` class with hover/focus-within opacity rules gated by `@media (hover: hover) and (pointer: fine)`.
- `commandRanking.ts` is unchanged. `buildPaletteView` does not look at `trailingAction`.
- `docs/command-palette.md` is updated in the same PR to describe the inline close pattern as current behaviour and to remove any reference to a separate close row.
- The e2e command-palette spec covers: switch via row body, close via inline button (palette stays open), section length equals pane count after the change.

## 6. Capability Contract

### 6.1 Palette controller contract (addendum)

Inputs unchanged. One output added:

- Output: optionally invokes the trailing action of a command via `onTrailingAction(actionId)`. This dispatches through the existing controller-level action executor for the same `actionId` namespace (`pane-close:*`) but does **not** call `closePalette()` and does **not** post `/api/me/palette-selections`.

New invariants:

- A `PaletteCommand` with a `trailingAction` always renders a single row (not two). The palette never produces both an activate row and a close row for the same pane.
- The trailing action does not appear in the ranked or grouped views as its own row. It is reachable only via the row's trailing button or the desktop `Delete` shortcut on the active row.
- Trailing action invocation never closes the palette, never records palette history, never changes the active listbox row.
- If a trailing-action invocation removes the source row from the list (e.g., closing a pane removes its open-tabs row), the active row falls back to the existing rule used when `view` changes and the active row is no longer present (re-point to the first command in the view).

### 6.2 Palette row contract

`PaletteRow`'s contract gains one element:

- When `command.trailingAction` is present, the row renders a `<button>` in the trailing slot in lieu of the tag/meta/shortcut span.
- The button's `aria-label` is `command.trailingAction.ariaLabel`.
- The button's `onClick` stops propagation and calls `onTrailingAction(command.trailingAction.actionId)`.
- The button has `tabIndex={-1}` so keyboard tab order skips it; keyboard close is via the `Delete` path in `PaletteBody`.
- The row's primary `onClick` (row body activation) remains in place and is not invoked when the trailing button is clicked.

## 7. API Design

### 7.1 `palette/types.ts`

`PaletteCommand` gains one field:

```ts
export interface PaletteCommand {
  // ...existing fields unchanged...
  trailingAction?: {
    actionId: string;
    ariaLabel: string;
  };
}
```

Conventions:

- `actionId` is dispatched through the same controller action executor as `target.actionId`; the executor branches on the prefix (e.g., `pane-close:`).
- `ariaLabel` is a complete, human-readable label (e.g., `"Close My Document"`). It is consumed verbatim by the button's `aria-label`.
- The trailing close button always renders the `X` icon from `lucide-react`. The icon is not configurable. If a second caller appears that needs a different icon, the field is widened then — not pre-emptively.

`PaletteTarget`, `PaletteGroup`, and `PaletteView` are unchanged.

### 7.2 `CommandPalette.tsx`

Source-of-truth changes:

- Delete the second `commands.push({ id: "pane-close-...", ... })` block at `CommandPalette.tsx:229-238`.
- On the activate command (`id: "pane-${pane.id}"`), set:
  ```ts
  trailingAction: {
    actionId: `pane-close:${pane.id}`,
    ariaLabel: `Close ${title}`,
  };
  ```
- Add a controller-level callback `onTrailingAction(actionId)` that:
  - Branches on prefix exactly as today's `executeCommand` action branch does (`pane-close:` → `closePane(paneId)`).
  - Does **not** call `closePalette()`.
  - Does **not** post to `/api/me/palette-selections`.
  - Uses an exhaustive `never` check if the action-id prefix space grows beyond `pane-close:`.
- The existing `executeCommand` retains its `pane-close:*` branch unchanged, in case a future caller invokes it as a primary target. (No live caller will do so after this cutover; the branch is the executor's contract for that action id.)

The `OPEN_COMMAND_PALETTE_EVENT` listener, the URL-param open path, keybindings, and shell selection are untouched.

### 7.3 `palette/PaletteRow.tsx`

Props:

```ts
interface PaletteRowProps {
  command: PaletteCommand;
  selected: boolean;
  showTag: boolean;
  showShortcut: boolean;
  onSelect(command: PaletteCommand): void;
  onTrailingAction(command: PaletteCommand): void;
  onHover?(commandId: string): void;
}
```

Rendering rules in the trailing slot, in order of precedence:

1. `command.disabled` → `<span class="optionMeta">{command.disabled.reason}</span>`. (unchanged)
2. `command.trailingAction` → `<button type="button" tabIndex={-1} class="trailingButton" aria-label={trailingAction.ariaLabel} onClick={stopPropagation + onTrailingAction(command)}><X size={16} aria-hidden="true" /></button>`.
3. `showTag` and `tagFor(command)` returns non-null → tag span. (unchanged)
4. `showShortcut` and `command.shortcutLabel` → meta span. (unchanged)
5. Else → no trailing element. (unchanged)

The `optionName` `aria-label` built from row text fields does **not** append the trailing-action label; the button's own `aria-label` carries that information.

The row's primary `onClick` is unchanged. The trailing button must call `event.stopPropagation()` so the row's `onClick` does not fire.

### 7.4 `palette/PaletteBody.tsx`

Props gain one callback:

```ts
interface PaletteBodyProps {
  // ...existing props unchanged...
  onTrailingAction(command: PaletteCommand): void;
}
```

Behaviour:

- Pass `onTrailingAction` through to every `PaletteRow`.
- Add a key handler for `Delete` in `onKeyDown` on the input:
  - Fires only when `event.key === "Delete"`, the input value is the empty string, and the active command has a non-null `trailingAction`.
  - Calls `onTrailingAction(activeCommand)` and `event.preventDefault()`.
  - Does not change `activeCommandId`.
- `Backspace` is unchanged (no new handling); it continues to operate purely on the input.
- The existing `Enter`/`Arrow*`/`Home`/`End` handling is unchanged.

`flattenView` and the resting/querying rendering branches are unchanged except for the new `onTrailingAction` passthrough.

### 7.5 Shells

`PaletteDesktopShell` and `PaletteMobileShell` each gain a passthrough:

```ts
interface PaletteDesktopShellProps {
  // ...existing props unchanged...
  onTrailingAction(command: PaletteCommand): void;
}

interface PaletteMobileShellProps {
  // ...existing props unchanged...
  onTrailingAction(command: PaletteCommand): void;
}
```

Each shell passes it through to `PaletteBody` and does nothing else with it. Shells do not implement keyboard handling for the trailing action (the desktop `Delete` path lives in `PaletteBody`, which owns the input keydown). Shells do not branch on whether the active row has a trailing action.

### 7.6 `palette/PaletteBody.module.css`

`.option` grid is unchanged at the structural level (`auto minmax(0, 1fr) auto`). The trailing slot now holds the close button instead of a meta/tag span when the row has a trailing action.

New class `.trailingButton`:

```css
.trailingButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--size-xl);
  height: var(--size-xl);
  margin-right: calc(var(--space-2) * -1); /* extend hit area to the row's right edge */
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .trailingButton {
    opacity: 0.4;
    transition: opacity 120ms ease-out;
  }

  .option:hover .trailingButton,
  .option:focus-within .trailingButton,
  .option[data-active="true"] .trailingButton {
    opacity: 1;
  }

  .trailingButton:hover {
    background: var(--surface-3);
  }
}
```

On touch (no hover query), `.trailingButton` renders at full opacity by default.

The current `.tag` and `.optionMeta` rules are unchanged; they apply only when the row does not render a trailing button.

## 8. Architecture

### 8.1 Ownership

- `CommandPalette.tsx` owns the synthesis of the activate-tab `PaletteCommand` including its `trailingAction`, and owns the `onTrailingAction` callback. No row code or shell code knows about pane ids or `pane-close:` semantics.
- `PaletteRow` owns the rendering of the trailing button and the click-event propagation guard. It does not know that the action is "close" — it only renders a generic trailing button with the supplied `ariaLabel`.
- `PaletteBody` owns the `Delete`-key shortcut path and the threading of `onTrailingAction` through to rows. It does not know which actions are eligible.
- The shells own nothing about trailing actions beyond a passthrough prop.

### 8.2 Data flow

```text
workspace store panes
  → CommandPalette.tsx builds one PaletteCommand per pane
     with target = activate and trailingAction = close
  → buildPaletteView (unchanged) groups/ranks
  → PaletteDesktopShell / PaletteMobileShell (passthrough)
  → PaletteBody (renders + owns Delete key)
  → PaletteRow (renders trailing <button> when present)

Primary selection path:
  PaletteRow click on row body
    → PaletteBody.onSelect
    → CommandPalette executeCommand → activatePane + closePalette + history POST

Trailing action path:
  PaletteRow click on trailing button (stopPropagation)
  OR PaletteBody Delete on active row with empty input + trailingAction present
    → CommandPalette onTrailingAction
    → closePane (palette stays open, no history POST)
```

### 8.3 ARIA position

`role="listbox"` and `role="option"` are preserved per `docs/command-palette.md:281-282`. The new inline `<button>` is a deliberate, scoped deviation from "options must be atomic":

- The button is non-tabbable (`tabIndex={-1}`), so keyboard focus never enters the option.
- Screen readers in touch-explore mode will land on the option and then on the button; the button's `aria-label` ("Close My Document") describes the action.
- The option's own `aria-label` continues to describe the primary action; the trailing-action label is not concatenated into it.
- This pattern is already used in the project's own desktop pane strip (`WorkspacePaneStrip`), `Chip`, and `ContextRow` components; the deviation is consistent with existing internal practice.

This decision is recorded in §14.

## 9. Composition With Other Systems

### Workspace store

Open-tab synthesis still reads `panes` and `activePaneId` from the workspace store. The trailing action's `actionId` resolves to the same `closePane(paneId)` call the deleted second row used. No store change.

### Workspace pane strip

The pane strip is unchanged. Both surfaces now use the same one-row-with-trailing-X visual pattern for tabs, reinforcing the parallel between strip and palette.

### Pane shell and surface header

No change. Pane Options dropdowns are unaffected. The palette has not gained a pane-scoped capability.

### Palette history API

`POST /api/me/palette-selections` is called only on primary selection, as today. Trailing actions are not recorded. Old `pane-close-${pane.id}` rows in storage are harmless: no frontend source declares that id after this cutover, so they never render or rank.

### Search

Search-result rows have no `trailingAction`. The search adapter and ranking are unchanged.

### Oracle, Android shell, keybindings, browser history

All unchanged. Android-shell route restrictions still apply to the activate target. `open-palette` and static-command hotkeys are unchanged.

### Add Content Tray, Pane Options

No interaction. Trailing close lives only on `open-tabs` rows.

## 10. Rules

- Hard cutover only. The separate close row is deleted in the same change that introduces the inline close button.
- No feature flag, no compatibility shim, no dual command source, no fallback that re-creates the deleted close row.
- `pane-close-${pane.id}` does not exist as a `PaletteCommand` id in the final state. `commands.push({ id: "pane-close-...", ... })` is removed in full. The `pane-close:${pane.id}` action id continues to exist as an executor branch.
- No platform conditional inside `PaletteRow` or `PaletteBody`. The hover-reveal is CSS-only, gated by `@media (hover: hover) and (pointer: fine)`.
- No `@media (pointer: coarse)` is introduced.
- No new shared abstraction is added. `trailingAction` has one caller; if a second arrives, the type widens then.
- Touch targets ≥44×44px. The inline close button is ≥44×44 hit area; the row's primary tap area is shrunk on the right by the button's width plus ≥8px spacing.
- Input font-size ≥16px is unchanged.
- Exhaustive `switch`/`never` checks apply to any new branching on action-id prefixes or on `PaletteView.state`.
- No new timing constants (no animation introduced).
- No comments restating the change ("inline close button" etc.). Code names and structure carry the meaning.
- Tests assert user-visible behaviour, not internal wiring.
- `docs/command-palette.md` is updated in the same PR.

## 11. Acceptance Criteria

### 11.1 Row anatomy

- The palette's `open-tabs` section renders one row per open pane, with an inline trailing close button.
- The trailing button has `aria-label="Close <pane title>"` and `tabIndex={-1}`.
- The trailing button's icon is `X` from `lucide-react`.
- On desktop, the trailing button is dimmed at rest and at full opacity on hover, focus-within, or when the row is the active option.
- On mobile, the trailing button is at full opacity at all times.

### 11.2 Behaviour

- Clicking/tapping the row body activates the pane, closes the palette, and posts to `/api/me/palette-selections`.
- Clicking/tapping the trailing button closes the pane, keeps the palette open, and does not post to `/api/me/palette-selections`.
- On desktop, with the active row being an open-tab row and the input empty, pressing `Delete` closes the pane and keeps the palette open. `Backspace` does not invoke the close path under any circumstances.
- On desktop, with the input non-empty, `Delete` performs default text behaviour and does not close any pane.
- When a pane is closed via the trailing action, the corresponding row disappears from the palette; if the active row was that row, the active row re-points to the first command in the new view.

### 11.3 Querying state

- An open-tab row that matches the current query renders with the same inline trailing close button.
- The "Tab" type tag is suppressed on open-tab rows (because the close button visually identifies the row as a tab).
- No `pane-close-*` command appears anywhere in querying ranking.
- Typing `"close"` does not surface a row per open pane.

### 11.4 Code shape

- `apps/web/src/components/CommandPalette.tsx` contains no `id: \`pane-close-` literal.
- `git grep "pane-close-"` shows hits only inside the `pane-close:` action id (the executor branch and the trailing-action `actionId` literal).
- `PaletteCommand` has a `trailingAction?: { actionId: string; ariaLabel: string }` field with no other variants.
- `PaletteRow` has no JSX branch keyed on `command.sectionId === "open-tabs"`. The trailing button renders solely from the presence of `trailingAction`.
- No `@media (pointer: coarse)` in palette CSS.
- No comment in any palette file references the deleted close-row pattern as historical.

### 11.5 A11y

- The listbox container retains `role="listbox"` and rows retain `role="option"`.
- `aria-activedescendant` continues to track the active row on desktop and is absent on mobile.
- The trailing button is announced by screen readers in touch-explore mode with its `aria-label`.
- The row's own `aria-label` describes the primary action and does not include the trailing-action label.

## 12. Verification Plan

### Unit tests

```bash
cd apps/web && bun run test:unit -- \
  src/components/command-palette/commandRanking.test.ts
```

Expected updates:

- Drop any assertion that depends on `Close <title>` appearing in the ranked list. Verify ranking still places open-tab activate rows correctly.
- Add an assertion that `pane-close-${id}` never appears in `buildPaletteView` output for any input that includes open-tab activate commands carrying `trailingAction`.

### Browser component tests

```bash
cd apps/web && bun run test:browser -- \
  src/__tests__/components/CommandPalette.test.tsx \
  src/components/palette/PaletteBody.test.tsx \
  src/components/palette/PaletteDesktopShell.test.tsx \
  src/components/palette/PaletteMobileShell.test.tsx
```

Expected coverage:

- `PaletteBody` renders a trailing button when a command has `trailingAction` and does not when it does not.
- Clicking the trailing button calls `onTrailingAction(command)`, does not call `onSelect`, and does not change `activeCommandId`.
- `Delete` on a desktop body with empty input + active row carrying `trailingAction` calls `onTrailingAction`; `Delete` with a non-empty input does not.
- `Backspace` never calls `onTrailingAction`.
- The mobile shell shows the trailing button at full opacity (no hover state). The desktop shell relies on hover/active styling; tests assert the button is present, not its opacity.
- `CommandPalette` no longer emits a `pane-close-*` command for an open pane; closing via the trailing action calls `closePane` and leaves `open` true.

### E2E tests

```bash
make test-e2e PLAYWRIGHT_ARGS="tests/command-palette.spec.ts"
```

Expected coverage:

- Desktop: open palette → arrow to open-tab row → press `Delete` with empty input → pane closes, palette stays open, the row is gone.
- Desktop: open palette → arrow to open-tab row → click trailing X → pane closes, palette stays open.
- Mobile viewport: open palette → tap trailing X on an open-tab row → pane closes, palette stays open.
- Mobile viewport: open palette → tap the row body of an open-tab row → pane activates, palette closes.
- Both: querying with `"close"` returns no per-pane close rows.

### Static gates

```bash
cd apps/web && bun run typecheck
cd apps/web && bun run lint
```

Broader gates before merge:

```bash
make check
make test-front-unit
make test-front-browser
```

### Manual device pass

- iOS Safari: tap close X on an open-tab row in the palette; verify pane closes, palette stays open, no soft-keyboard flicker, no rubber-banding into the row body.
- Android WebView: same; additionally verify hardware-back still closes the palette and does not re-trigger the trailing action.
- Confirm the trailing X hit area feels ≥44px and that mis-taps to the row body are not observed on narrow viewports.

## 13. Implementation Plan

One hard-cutover PR. The phases below are development order, not separate compatibility stages.

### Phase 1 — Tests first

- Update `PaletteBody.test.tsx`: add cases for trailing-button rendering, click behaviour, and the `Delete` key path. Remove any case that asserts on a `Close <title>` row.
- Update `PaletteDesktopShell.test.tsx` and `PaletteMobileShell.test.tsx`: add tests for `onTrailingAction` passthrough and (mobile) the always-visible button.
- Update `CommandPalette.test.tsx`: assert that open-tab rows carry `trailingAction`, that `onTrailingAction` calls `closePane` and does not close the palette or record history, and that `pane-close-*` ids no longer exist as commands.
- Update `commandRanking.test.ts`: drop close-row assertions.

### Phase 2 — Types and row

- Add `trailingAction?: { actionId: string; ariaLabel: string }` to `PaletteCommand` in `palette/types.ts`.
- Update `PaletteRow.tsx` to render the trailing button, with `stopPropagation` on its click and `tabIndex={-1}`.
- Add `.trailingButton` rules to `PaletteBody.module.css` including the hover-gated opacity transitions.

### Phase 3 — Body and shells

- Add `onTrailingAction` to `PaletteBodyProps` and thread it through to rows.
- Implement the `Delete`-key handler in `PaletteBody` under the guards in §4.4 / §7.4.
- Add `onTrailingAction` to `PaletteDesktopShellProps` and `PaletteMobileShellProps` and thread through.

### Phase 4 — Controller cut

- Delete the second `commands.push({ id: "pane-close-...", ... })` block in `CommandPalette.tsx`.
- Set `trailingAction` on the activate command.
- Implement the `onTrailingAction` callback (close pane, no palette close, no history POST) and pass it to the shell.
- Leave the executor's `pane-close:` action branch intact (it is the contract for the action id; no live caller invokes it as a primary `target` after this cutover).

### Phase 5 — Docs

- Update `docs/command-palette.md` to describe the inline-close row anatomy as current behaviour and remove any reference to a `Close <title>` row. Reference this planning doc as the cutover record.

### Phase 6 — Verification

- Run focused unit/browser/e2e tests.
- Run static checks.
- Manual device pass (§12).
- `git grep "pane-close-"` to confirm only the action-id form remains.

## 14. Key Decisions

1. **One row per tab with an inline trailing close.** The dominant cross-platform convention; matches the redesigned desktop pane strip in this repo.
2. **Trailing action does not dismiss the palette and is not recorded in history.** Preserves the user's flow when closing several tabs in sequence. Closing is not a "selection" of a command.
3. **`role="listbox"` and `role="option"` are retained; the inline button is a deliberate, scoped ARIA deviation** in line with existing internal patterns (`WorkspacePaneStrip`, `Chip`, `ContextRow`). Keyboard tab order remains atomic via `tabIndex={-1}`; touch-explore SR users still reach the button by its own `aria-label`.
4. **`PaletteCommand.trailingAction` is a concrete `{ actionId, ariaLabel }` field, not a generic registry or icon-pluggable variant.** Single caller; the type widens only when a second caller arrives.
5. **Hover-reveal on desktop only, persistent on mobile**, gated by `@media (hover: hover) and (pointer: fine)`. No JS branch on platform inside `PaletteRow`.
6. **Keyboard close shortcut is `Delete` (only)**, guarded by empty-input + active-row-has-trailingAction. `Backspace` is reserved for input editing — the input is the primary keyboard surface and must not lose a key.
7. **The "Tab" type tag is suppressed on open-tab rows in querying** because the inline X already identifies the row as a tab and the tag would compete with the button for the trailing slot.
8. **The icon is hardcoded `X`.** Concrete > abstract until a second use case appears.
9. **The change applies to both shells.** Per `command-palette.md`'s "no platform conditional inside `PaletteRow`" rule, diverging row anatomy between desktop and mobile would be a regression in coherence; the inline close is the right answer on both.
10. **No animation on row removal.** Matches the rest of the palette; animations belong to entrance, not data churn.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Mis-taps on narrow viewports between row body and close X | ≥44×44 hit areas with ≥8px separation; manual device pass (§12) covers narrow widths; trailing-button click stops propagation so a mis-tap onto the button never accidentally activates the pane. |
| ARIA-strict reviewers flag the nested `<button>` inside `role="option"` | Document the decision in §14.3; cite internal precedent in `WorkspacePaneStrip`, `Chip`, `ContextRow`; keyboard tab order remains atomic via `tabIndex={-1}`. |
| `Delete`-as-close conflicts with input forward-delete | Guarded by empty-input precondition; `Backspace` is never overloaded; spec'd in §4.4 and asserted in §11.2. |
| Closing the active row leaves `aria-activedescendant` pointing at a stale id | Existing rule already re-points the active row when the view changes and the active row is no longer present; this rule extends naturally to the trailing-action removal case. |
| Stale `pane-close-*` rows in palette history rendered as recents | No frontend source declares the id after this cutover; without a declaration the recents path cannot reconstruct a renderable command. Backend cleanup is unnecessary. |
| A future caller wants a different trailing icon | The shape is `{ actionId, ariaLabel }` today; widening to `{ actionId, ariaLabel, icon }` is a backward-compatible additive change made at the second-caller moment. |

## 16. Definition Of Done

- `apps/web/src/components/CommandPalette.tsx` synthesises one row per open pane, with `trailingAction` set; the `pane-close-${pane.id}` push is deleted.
- `PaletteCommand` has the new `trailingAction` field; `PaletteRow` renders the inline button; `PaletteBody` owns the `Delete` shortcut; both shells pass the callback through.
- The palette executor still understands the `pane-close:` action id (executor contract); no live primary `target` invokes it.
- `docs/command-palette.md` describes the new row anatomy as current behaviour; this planning doc remains as the cutover record.
- All focused unit, browser, and e2e tests in §12 pass.
- `git grep "pane-close-"` returns no hits other than the executor branch literal and the trailing-action `actionId` literal.
- `git grep "Close \\\${title}"` returns no hits.
- Manual device pass (iOS Safari + Android WebView) confirms the inline X is reachable, tap-accurate, and does not dismiss the palette.

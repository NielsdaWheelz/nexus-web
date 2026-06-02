# Reader highlights sidecar — collapse the action bar into one overflow menu · hard cutover spec

Status: **Approved direction, ready to implement.** Hard cutover. No legacy paths, no
fallbacks, no compatibility shims, no feature flags. One presentation per surface.

This spec finishes the arc that
[`reader-highlight-actions-unification.md`](./reader-highlight-actions-unification.md) started.
That cutover unified *which* highlight actions exist and *how they are wired* —
`buildHighlightActions()` → `HighlightActionBar` → a renderer — across all three surfaces
(sidecar card, reader-text click popover, selection popover), all rendering the flat icon
`ActionBar`. This cutover changes only the **sidecar's presentation**: the persistent, viewport-
scoped highlights list stops rendering a five-icon bar on every row and renders a single
overflow `…` menu instead. The two *transient, in-context* surfaces (reader-text click popover,
selection popover) keep the icon bar — they are the rich, roomy disclosure; the sidecar is the
light, persistent one.

It composes with, and does not disturb,
[`reader-highlight-sidecar-focus-decoupling.md`](./reader-highlight-sidecar-focus-decoupling.md)
(focus = pure selection; chats always clickable; snippet show-more; note always-full — all
shipped 2026-06-01). That cutover made every *other* slot in the row always-on; this one is the
last density lever, applied to the slot it deliberately left untouched (its §3 non-goal: "Not
changing the action bar … or its hover/`:focus-within` opacity reveal").

---

## 1. Context & problem

The sidecar (`ReaderHighlightsSurface`) renders each visible highlight as an `ItemCard`
(`ReaderHighlightsSurface.tsx:514-588`) whose `actions` slot is a
`<HighlightActionBar variant="existing">` (`:520-539`). That widget calls
`buildHighlightActions()` and renders the result through the flat icon `ActionBar`
(`HighlightActionBar.tsx:98-111`). For an owner-editable, reflowable, quotable highlight the bar
is **five 28×28 icon buttons** in a non-wrapping `inline-flex` row — color · quote-new ·
quote-existing · edit-bounds · │ · delete — roughly **165 px wide** (`highlightActions.tsx:50-108`,
`ui/ActionBar.tsx:20-46`).

The cost is **structural, not visual**:

1. **It permanently reserves space.** The bar sits in `ItemCard`'s header
   (`ItemCard.tsx:119-134`) as a `flex: 0 0 auto` sibling of the snippet
   (`ItemCard.module.css:32-34`); it never shrinks, so it steals horizontal width from the snippet
   and forces a ≥28 px header row even for a one-line highlight. The opacity reveal
   (`:38-46`, ambient `0.5` → `1` on hover/`:focus-within`) changes *visibility*, never *layout* —
   the box is always there.
2. **The icons are already icon-only.** There is no label fat to trim; shrinking further fights
   the WCAG 2.5.8 touch-target floor. "Make them smaller" is a dead end.
3. **Touch gets the densest version.** `@media (hover: none)` forces all five icons to full
   opacity (`:48-52`), so the most cramped, sub-44 px layout is the one mobile users get.
4. **The row already carries more than it used to.** Post-focus-decoupling, the note is
   always-full and linked chats are an always-clickable list. The five-icon bar now competes with
   those for the same row.

**Root cause.** The sidecar inherited the *icon-bar* presentation from the unification cutover
because that was the one renderer at the time. But a flat icon bar is a *toolbar* idiom — right
for a transient in-context popover with room to spare, wrong for a dense, persistent list row
where most of the actions are low-frequency (color, edit-bounds) or destructive (delete). The fix
is not to delete actions or shrink icons; it is to give the sidecar the **progressive-disclosure**
presentation the rest of this app already uses for per-row actions (`AppList` →
`ActionMenu`): collapse the whole set behind one `…` trigger.

The descriptor model already supports this with **zero model change**: `ActionMenu` consumes the
same `ActionMenuOption[]` as `ActionBar` (`ui/ActionMenu.tsx:20-37`) and already honors every
field `buildHighlightActions` emits — `render` (the color picker renders inline,
`ActionMenu.tsx:268-273`), `tone:"danger"` (`:281,:310`), `separatorBefore` (`:265-267`),
`disabled`, and a flipping `label` for the edit-bounds toggle. The only thing missing is wiring
the sidecar to that renderer.

---

## 2. Goals

1. **The sidecar row shows one affordance, not five.** Each existing-highlight row renders a
   single `…` overflow trigger (accessible name "Highlight actions"); the full action set lives
   inside the menu it opens.
2. **Reuse, don't build.** The trigger is the house `ActionMenu` (`ui/ActionMenu.tsx`) — the same
   overflow primitive `AppList` uses — driven by the *unchanged* `buildHighlightActions()`
   descriptors. No new component, no new descriptor field, no new icon import (the kebab is the
   established `…` glyph, not a lucide `MoreHorizontal`).
3. **One widget still owns destructive/async state.** `HighlightActionBar` remains the single
   mount point that owns the delete-confirm and color-spinner state for *every* surface; it gains
   one `presentation` choice and nothing else.
4. **The in-context popovers are untouched.** The reader-text click popover and the selection
   popover keep the icon `ActionBar`. The bar is *not* legacy — it is the correct presentation for
   a transient, roomy surface.
5. **Touch-correct by construction.** The single trigger inherits `ItemCard`'s existing
   touch-safe ambient reveal (`@media (hover:none)` → opacity 1); we explicitly do **not** copy
   `AppList`'s touch-buggy `opacity:0` reveal.
6. **Hard cutover.** The sidecar renders the menu and only the menu — no icon-bar branch, no flag,
   no "compact mode" fallback in the sidecar path.

---

## 3. Non-goals

- **Not** changing `buildHighlightActions()` — the descriptor set, order, icons, gating, tone, and
  toggle state are unchanged (`highlightActions.tsx:26-109`). Both renderers read the same list.
- **Not** merging the two quote actions (`quote-new` + `quote-existing`). Merging was only ever
  motivated by *icon-row density*; a dropdown lists two text rows for free, so the pressure is
  gone. Keeping them distinct is clearer than a nested new-vs-existing sub-choice, and it avoids a
  model change that would ripple into the two popovers. Revisit independently if ever desired.
- **Not** changing the reader-text click popover (`HighlightActionPopover.tsx`) or the selection
  popover (`SelectionPopover.tsx`) — both keep `presentation:"bar"`.
- **Not** changing the delete UX (`window.confirm`, `HighlightActionBar.tsx:86`) — still deferred
  per the unification cutover.
- **Not** changing focus/selection, navigation, hover, the note editor, the snippet show-more, the
  linked-chats list, the color picker, or the scanline layout engine. This touches one slot.
- **Not** a repo-wide consolidation of the ambient-actions reveal idiom or a fix to the
  `AppList`/`WorkspacePaneStrip` touch bug. Documented as a tracked follow-up in §8.4 — it changes
  *other* surfaces' behaviour and belongs in its own commit.
- **Not** adding `aria-pressed`/`menuitemcheckbox` semantics to `ActionMenu` for the edit-bounds
  toggle. The flipping accessible name ("Edit bounds" ↔ "Cancel edit bounds") is the standard,
  correct way to convey a menu action's state (§12.4).

---

## 4. Target behaviour (UX)

### 4.1 The row collapses to one trigger

```
BEFORE (five-icon bar, always reserved)            AFTER (one overflow trigger)
┌───────────────────────────────────────────┐     ┌───────────────────────────────────────────┐
│ "…poolpah hit the fan. I had the…"  ◑ ✎ ⤺ ⤻ ⌫ │  │ "…poolpah hit the fan. I had the…"        ⋯ │
│ 📝 note …                                   │     │ 📝 note …                                   │
│ 💬 Poolpah theory                           │     │ 💬 Poolpah theory                           │
└───────────────────────────────────────────┘     └───────────────────────────────────────────┘
  ~165px reserved on every row, top-aligned          one ~32px trigger; the snippet reclaims the width
```

Opening the `…` reveals the full set as a portaled menu:

```
        ┌──────────────────────────────┐
        │  ◐ ◐ ◐ ◐ ◐   ← color swatches │  (inline color picker; current color disabled)
        │  Quote to new chat            │
        │  Quote to existing chat       │
        │  Edit bounds                  │  ("Cancel edit bounds" when active)
        │ ──────────────────────────── │
        │  Delete highlight             │  (danger tone)
        └──────────────────────────────┘
```

- The trigger is ambient at rest (opacity `0.5`), full on row hover / `:focus-within` / while its
  menu is open / on touch (§11). It is the only child of the row's `actions` slot.
- When `buildHighlightActions` returns an empty list (e.g. a non-owner highlight with no quote
  capability), `ActionMenu` renders nothing (`ActionMenu.tsx:244`) — no empty trigger, exactly as
  the empty `ActionBar` rendered nothing today (`ui/ActionBar.tsx:29`).
- Selecting **color** opens the inline swatch picker; choosing a swatch changes the color and
  closes the menu. Selecting **quote-new / quote-existing** fires the quote handler and closes.
  Selecting **edit-bounds** focuses the row, starts edit-bounds, and closes (the "Select new text…"
  meta line then shows on the focused card, unchanged). Selecting **delete** runs the existing
  `window.confirm` flow.
- Keyboard, focus-trap, focus-restore-to-trigger, type-ahead, and outside-/Escape-dismiss are all
  provided by `ActionMenu` (`ui/ActionMenu.tsx:116-242`) — no new a11y code.

### 4.2 What is unchanged on the row

Snippet + show-more, note (always-full, editable), linked-chat list (always clickable), focus
selection ring, hover, mobile above/below jumps, edit-bounds meta line — all exactly as the
focus-decoupling cutover left them. Only the `actions` slot's *presentation* changes.

### 4.3 In-context surfaces unchanged

Clicking a highlight in the reader prose still opens the icon-bar `HighlightActionPopover`;
selecting text still opens the icon-bar `SelectionPopover`. Same icons, same order, same anchoring.

---

## 5. Architecture & final state

### 5.1 One model, two renderers, surface-chosen presentation

```
buildHighlightActions(target, flags, state, handlers)  → ActionMenuOption[]      (UNCHANGED)
                              │
                 HighlightActionBar (the only widget any surface mounts)         (+1 prop)
                 owns: delete-confirm + color-spinner state, feedback wiring
                              │
        presentation ────────┼──────────────────────────────
            "bar"            │            "menu"
              ▼              │              ▼
        ui/ActionBar         │        ui/ActionMenu                              (both UNCHANGED)
        flat icon row        │        portaled "…" dropdown
              ▲              │              ▲
   HighlightActionPopover    │     ReaderHighlightsSurface
   SelectionPopover (sel.)   │     (the sidecar — this cutover)
```

`ActionBar` and `ActionMenu` are already documented siblings over the same `ActionMenuOption`
model (`ui/ActionBar.tsx:12-19`). This cutover makes `HighlightActionBar` choose between them per
surface instead of always rendering the bar. Nothing about the model, the gating, or the two
popovers moves.

### 5.2 Final state by surface

| Surface | Mount | Presentation (after) |
|---|---|---|
| Reader sidecar row (`ReaderHighlightsSurface`) | `HighlightActionBar variant="existing" presentation="menu"` | `…` overflow `ActionMenu` |
| Reader-text click popover (`HighlightActionPopover`) | `HighlightActionBar variant="existing" presentation="bar"` | icon `ActionBar` (unchanged) |
| Text-selection popover (`SelectionPopover`) | `HighlightActionBar variant="selection"` | icon `ActionBar` (unchanged) |

After the cutover, the sidecar has exactly one action presentation path. There is no
icon-bar-in-the-sidecar code to fall back to.

---

## 6. Capability contract & API design

### 6.1 `components/highlights/HighlightActionBar.tsx` — the one surface-facing change

`ExistingProps` gains a **required** `presentation` discriminator (required, not defaulted, so
every existing-variant mount declares its surface intent — no implicit fallback, per hard-cutover):

```ts
type ExistingProps = {
  variant: "existing";
  presentation: "bar" | "menu";          // NEW (required)
  highlight: AnchoredHighlightRow;
  canQuoteToChat: boolean;
  isReflowable: boolean;
  isEditingBounds: boolean;
  onSelectColor: (color: HighlightColor) => Promise<void>;
  onDelete: () => Promise<void>;
  onQuoteToNewChat: () => void;
  onQuoteToExistingChat: () => void;
  onToggleEditBounds: () => void;
  className?: string;
};
```

`SelectionProps` is **unchanged** — the selection variant only ever mounts in `SelectionPopover`
and is always a bar; it carries no `presentation`.

`ExistingActionBar` keeps all its state ownership (`HighlightActionBar.tsx:67-110`) and changes
only its final return — choosing the renderer by `presentation`:

```ts
const options = buildHighlightActions({ /* …unchanged… */ });
return props.presentation === "menu" ? (
  <ActionMenu options={options} label="Highlight actions" className={props.className} />
) : (
  <ActionBar options={options} label="Highlight actions" className={props.className} />
);
```

`label="Highlight actions"` is the `ActionMenu` trigger's `aria-label` (it was the `ActionBar`'s
`role="group"` label before) — the row's overflow button announces as "Highlight actions, has
popup menu". Symmetry: the bar and the menu carry the same accessible name.

### 6.2 `components/reader/ReaderHighlightsSurface.tsx` — flip the one call site

In `renderRow` (`:520-539`), add `presentation="menu"` to the `HighlightActionBar`. Everything
else on that mount — `highlight`, `canQuoteToChat`, `isReflowable`, `isEditingBounds`, all five
handlers, the edit-bounds focus-then-start closure (`:531-538`) — is **unchanged**. No prop
changes to `ReaderHighlightsSurfaceProps`; no new state; the `renderRow` dependency array is
unchanged.

### 6.3 `components/highlights/HighlightActionPopover.tsx` — declare the bar explicitly

Add `presentation="bar"` to its `HighlightActionBar` mount (`:56-67`). Behaviourally a no-op (bar
is what it renders today), but `presentation` is now required, so the call site must state it.
This is the only change to this file.

### 6.4 `components/ui/ActionMenu.tsx`, `ui/ActionBar.tsx`, `highlightActions.tsx`, `ItemCard.tsx`

**No signature changes.** `ActionMenu` already renders the descriptors correctly (§1). One small
*style* addition to `ItemCard.module.css` keeps the trigger fully visible while its menu is open
(§11.2) — no TSX change to `ItemCard`.

---

## 7. How it composes with other systems

- **`ItemCard` `actions` slot.** `ItemCard` renders `actions` as an opaque `ReactNode` in
  `.actions` (`ItemCard.tsx:133`). Swapping a five-button bar for a one-button menu is invisible to
  `ItemCard`; the ambient-reveal CSS already targets the `.actions` wrapper, so the menu container
  inherits the reveal with no change (§11.2).
- **Card focus / click-through.** `ActionMenu`'s trigger `stopPropagation`s its click
  (`ActionMenu.tsx:337`) and is a `<button>`, which `ItemCard`'s root-click guard already ignores
  (`ItemCard.tsx:108-117`, `closest('a, button, …')`). Opening the menu never focuses/activates the
  row. Menu items are portaled to `document.body` (`ActionMenu.tsx:369-371`), so clicks inside the
  menu are not inside the card at all — no focus side effects, and no clipping by the sidecar's
  scanline `overflow`/`transform` container.
- **Scanline layout engine** (`alignRows`/`rowHeights`, `ReaderHighlightsSurface.tsx:148-257`). The
  trigger is shorter than the old bar and the menu is portaled (zero in-flow height), so collapsing
  the bar can only *shrink or preserve* a row's measured height. The existing
  `useLayoutEffect` repack handles it; no new deps. (The trigger's ambient opacity does not affect
  layout.)
- **Delete / color async state.** Unchanged — still owned by `ExistingActionBar`
  (`HighlightActionBar.tsx:67-110`). In menu form the spinner/disabled state shows via the same
  `disabled` descriptor field (`ActionMenu` honors `disabled` on menuitems,
  `ActionMenu.tsx:312`); the color picker's `disabled`/`disabledColors` props are passed through its
  inline `render` exactly as in the bar's popover.
- **Quote handlers** (`onQuoteToNewChat`/`onQuoteToExtantChat` → `MediaPaneBody` quote flows).
  Unchanged; the menu fires the identical handlers the bar fired.
- **The other two surfaces.** `HighlightActionPopover` and `SelectionPopover` keep the bar; because
  the model and `ActionBar` are untouched, they cannot regress. Verified: these three
  (`ReaderHighlightsSurface`, `HighlightActionPopover`, `SelectionPopover`) are the only
  `HighlightActionBar` mounts.

---

## 8. Reuse / consolidation decisions (resolved)

1. **Reuse `ActionMenu` as-is — no new overflow component.** The repo already has exactly one
   overflow primitive (`ui/ActionMenu.tsx`), used by `AppList`, `SurfaceHeader`, `NavTopBar`,
   `NavAccount`, and several pane bodies. The sidecar joins that set. Building a bespoke
   highlight-menu would duplicate keyboard nav, focus management, portaling, and dismissal that
   `ActionMenu` already provides.
2. **Reuse the default `…` trigger — no new icon.** `ActionMenu`'s default trigger is the HTML
   ellipsis glyph (`ActionMenu.tsx:362-368`); no `MoreHorizontal`/`MoreVertical`/`Ellipsis` lucide
   icon is imported anywhere in the app today. Reusing the default keeps the highlight kebab
   visually identical to every other overflow menu. No `renderTrigger`.
3. **Reuse `buildHighlightActions` and the `ActionMenuOption` model verbatim.** The single source of
   truth (`highlightActions.tsx`) feeds both renderers; the menu is a pure presentation choice. The
   `render`-based inline color picker, the `separatorBefore` divider, and the `tone:"danger"` styling
   are all already supported by `ActionMenu` — the reason the unification cutover built `ActionBar`
   and `ActionMenu` as siblings over one model.
4. **Ambient-reveal duplication — fix the sidecar by reuse; track the rest separately.** The
   "actions fade in on hover" idiom is copy-pasted three times: `ItemCard.module.css:36-52`
   (highlight, opacity `0.5`, **touch-safe**), `WorkspacePaneStrip.module.css:127-141`
   (opacity `0.5`, **no `@media (hover:none)`** → latent touch bug), and `AppList.module.css:101-109`
   (opacity `0`, **no `@media (hover:none)`** → latent touch bug, actions unreachable on touch).
   This cutover reuses `ItemCard`'s already-correct rule (the menu lands in the same `.actions`
   wrapper) and adds nothing to `AppList`/`WorkspacePaneStrip`. Centralizing the three into one
   utility class and fixing the two touch bugs is a real consolidation — but it changes the
   touch behaviour of unrelated surfaces (tab/list actions would become visible on touch), so it is
   an **explicit out-of-scope follow-up** (§3), not folded into a highlights cutover. Per
   `docs/rules/cleanliness.md` (one change, one concern) it gets its own commit.
5. **`label` parity.** Both renderers use `label="Highlight actions"` so the accessible name is
   stable across presentations and across the existing `HighlightActionPopover.test.tsx` dialog
   name (`"Highlight actions"`).

---

## 9. Scope

**In:** `HighlightActionBar.tsx` (add required `presentation` to `ExistingProps`; pick renderer),
`ReaderHighlightsSurface.tsx` (pass `presentation="menu"`), `HighlightActionPopover.tsx` (pass
`presentation="bar"`), `ItemCard.module.css` (one open-state opacity rule, §11.2), and the tests
for all of it.

**Out:** everything in §3 — the descriptor model, quote-merge, the two popovers' behaviour, delete
UX, focus/nav/note/snippet/chat slots, and the cross-surface ambient-reveal/touch-bug
consolidation.

---

## 10. Files

| File | Change |
|---|---|
| `apps/web/src/components/highlights/HighlightActionBar.tsx` | Add **required** `presentation: "bar" \| "menu"` to `ExistingProps`. In `ExistingActionBar`, return `<ActionMenu …>` when `presentation==="menu"`, else `<ActionBar …>` (`:111`). Import `ActionMenu`. `SelectionActionBar` unchanged. |
| `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` | Add `presentation="menu"` to the `HighlightActionBar` in `renderRow` (`:521-522`). Nothing else. |
| `apps/web/src/components/highlights/HighlightActionPopover.tsx` | Add `presentation="bar"` to its `HighlightActionBar` (`:57`). |
| `apps/web/src/components/items/ItemCard.module.css` | Add one rule so the actions stay opacity `1` while the overflow menu is open (`ActionMenu` sets `data-open="true"` on its container): `.card[data-content-kind="highlight"]:has(.actions [data-open="true"]) .actions { opacity: 1; }`. Existing ambient + hover + touch rules (`:36-52`) unchanged. |
| `apps/web/src/components/highlights/HighlightActionBar.test.tsx` | Add `presentation="menu"` cases: the row renders one "Highlight actions" trigger; opening it exposes the actions as `menuitem`s + the color group; "Delete highlight" still runs `window.confirm` then `onDelete`; selecting "Edit bounds" fires `onToggleEditBounds` and the menu closes. Keep all existing `presentation="bar"` cases (pass `presentation="bar"` where the harness mounts the existing variant). |
| `apps/web/src/components/reader/ReaderHighlightsSurface.test.tsx` | Invert the action assertion (`~:327-339`): the row exposes one `button` named "Highlight actions" with `aria-haspopup="menu"`; the five icon buttons are **not** directly present; after opening, the actions are reachable as `menuitem`s (and the color picker as a `group`). |
| `apps/web/src/components/highlights/HighlightActionPopover.test.tsx` | No behavioural change (still a bar); update only the harness mount to pass `presentation="bar"` so it typechecks. The "same options as the sidecar" dialog assertion (`:39-52`) stays — but its prose framing should note the sidecar is now a menu over the *same options*. |
| e2e (`apps/web/e2e/**`) | Sidecar-driven steps that today click an icon button inside the row's "Highlight actions" group must instead open the row's "Highlight actions" `…` menu and click the `menuitem` (or the swatch, for color). Reader-text-click-popover and selection-create flows are **unchanged** (still bars). Requires an `e2e` run. |

No new files. Net change: one required prop, two call sites declaring it, one CSS rule, test
updates. Nothing is deleted (the bar is still the popovers' presentation).

---

## 11. Key details

### 11.1 How each descriptor renders in the menu (verified against `ActionMenu.tsx`)
- **color** — has `render`, so `ActionMenu` renders the `HighlightColorPicker` **inline** as the
  first row, wrapped in `<li role="none"><div role="group" aria-label="Highlight color">`
  (`:268-273`); `closeMenu` is passed, so picking a swatch changes color and closes. Same picker,
  same `disabled`/`disabledColors` behaviour as the bar's popover. (`option.icon`, the color dot,
  is unused in the menu — the swatches *are* the color affordance.)
- **quote-new / quote-existing** — plain `menuitem`s rendered from `option.label`
  (`:305-321`); `option.icon` is unused in the menu (text labels are the affordance). They fire the
  same handlers and close on select.
- **edit-bounds** — a `menuitem` whose label flips "Edit bounds" ↔ "Cancel edit bounds"
  (`highlightActions.tsx:89`). `option.pressed` is not reflected as `aria-pressed` in a menu — by
  design (§12.4): the flipping accessible name is the state signal.
- **delete** — a danger `menuitem` (`menuItemDanger`, `:281,:310`) preceded by a `role="separator"`
  (`:265-267`); `disabled` while deleting (`:312`).

### 11.2 Ambient reveal + open-state
The kebab inherits `ItemCard`'s existing `.actions` reveal (`ItemCard.module.css:36-52`): ambient
`0.5`, full on `:hover`/`:focus-within`, and full on `@media (hover:none)` — already touch-correct,
no change. **Addition:** while the menu is open, keyboard focus is on a portaled menuitem (outside
the card), so `:focus-within` is false and the trigger would dim to `0.5`. `ActionMenu` sets
`data-open="true"` on its container (`ActionMenu.tsx:360`); a single `:has()` rule keeps the
trigger at opacity `1` while open:
```css
.card[data-content-kind="highlight"]:has(.actions [data-open="true"]) .actions { opacity: 1; }
```

### 11.3 Empty option set
`buildHighlightActions` can return `[]` (non-owner, no quote capability). `ActionMenu` returns
`null` for an empty list (`ActionMenu.tsx:244`), so the row shows no trigger — identical to the
empty-`ActionBar` behaviour today (`ui/ActionBar.tsx:29`). No empty kebab is ever painted.

### 11.4 Portaling and the scanline
`ActionMenu` portals its `<ul role="menu">` to `document.body` (`:369-371`) and positions it with
`useAnchoredPosition` (flip-aware). The sidecar list uses absolute `translateY` row positioning and
a clipped container; portaling means the menu is never clipped by it and never perturbs row-height
measurement.

### 11.5 Test layer
Component tests run in the real-Chromium Vitest browser project (`*.test.tsx`), where the portal,
focus management, and `:has()` open-state behave as in production
(`docs/rules/testing_standards.md`; `reference_vitest_project_split`). Drive the menu the way the
app does: query the trigger by name "Highlight actions", click/Enter to open, then assert/act on
`menuitem`s and the color `group`.

---

## 12. Key decisions (resolved)

1. **Aggressive single-`…`, not a primary-inline + overflow split.** Per the chosen direction: the
   sidecar collapses *all* actions behind one trigger and leans on the reader-text click popover for
   the rich, one-tap-each icon bar. Rationale: the sidecar is navigation/reading-first; the
   in-context popover already exists as the heavy-action surface; one trigger is the minimum
   persistent footprint and the lowest visual noise across a long list. A primary-inline split was
   considered and rejected here as it reintroduces per-row icon density and a second
   presentation branch.
2. **Presentation lives on `HighlightActionBar`, not in a new wrapper.** Adding a `presentation`
   prop keeps the single owner of delete-confirm/color-spinner state intact and reuses the existing
   `ActionBar`/`ActionMenu` sibling split. A separate `HighlightActionMenu` component would
   duplicate that state. (`docs/rules/cleanliness.md`: one owner per concern.)
3. **`presentation` is required, not defaulted.** A default (`"bar"`) would read as a back-compat
   hedge; making it required forces both existing-variant call sites to state their surface intent
   and guarantees no silent fallback. (Hard-cutover; `docs/rules/module-apis.md`: explicit over
   implicit.)
4. **Edit-bounds state is conveyed by the flipping label, not `aria-pressed`.** A `role="menuitem"`
   has no `aria-pressed`; the ARIA-correct toggle-in-a-menu is `menuitemcheckbox`/`aria-checked`,
   which would require changing `ActionMenu` for one consumer. The label already flips
   ("Edit bounds" ↔ "Cancel edit bounds"), which announces the state through the accessible name —
   standard for menu actions. No `ActionMenu` change. (`docs/rules/simplicity.md`: no speculative
   API surface.)
5. **Color renders inline in the menu (reuse `ActionMenu`'s `render`).** Rejected making color a
   nested submenu or a separate popover from the menu — `ActionMenu` already renders `render`
   options inline, which the unification cutover relies on. The swatch row sits at the top of the
   menu; compact and already-supported.
6. **Two popovers keep the bar; the bar is not legacy.** The icon `ActionBar` is the right idiom for
   transient, roomy, in-context surfaces. This is surface-appropriate presentation, not a retained
   fallback — there is no bar path left in the *sidecar*.
7. **No quote-merge, no cross-surface CSS consolidation in this cutover.** Both are real but
   separable; folding them in would widen blast radius into the popovers and unrelated list/tab
   surfaces. Tracked in §3/§8.4.
8. **Hard cutover.** The sidecar renders the menu only — no icon-bar branch, no flag, no compact
   mode.

---

## 13. Acceptance criteria

1. **One trigger per row.** Each existing-highlight sidecar row renders exactly one `button` with
   accessible name "Highlight actions" and `aria-haspopup="menu"`; none of "Highlight color",
   "Quote to new chat", "Quote to existing chat", "Edit bounds", "Delete highlight" is present as a
   directly-visible control before the menu is opened.
2. **Full set reachable in the menu.** Opening the trigger exposes: the color picker as a
   `group` named "Highlight color"; `menuitem`s "Quote to new chat", "Quote to existing chat",
   "Edit bounds"; a separator; and a danger `menuitem` "Delete highlight" — gated exactly as
   `buildHighlightActions` dictates (PDF drops edit-bounds; non-owner drops color/edit/delete;
   no quote capability or empty `exact` drops the quotes; empty set → no trigger).
3. **Actions behave identically.** Color change, quote-to-new, quote-to-existing, edit-bounds
   (focuses + starts, label flips to "Cancel edit bounds"), and delete (`window.confirm` →
   `onDelete`) all fire the same handlers and side effects as before; the menu closes on select.
4. **Trigger does not activate the row.** Opening/closing the menu never calls the card's
   `onActivate` (no focus/selection change from interacting with the menu).
5. **Open-state visibility.** The trigger is full-opacity while its menu is open (keyboard or
   pointer), ambient `0.5` at rest, full on hover/focus, and full on touch (`hover:none`).
6. **In-context popovers unregressed.** `HighlightActionPopover` and `SelectionPopover` still render
   the icon bar with the same options; `HighlightActionPopover.test.tsx`'s dialog/option assertions
   stay green.
7. **No dead/abandoned paths.** The sidecar has no icon-bar code path; `presentation` is required on
   `ExistingProps`; grep shows no defaulted/optional `presentation`. Typecheck + lint + the full
   unit/browser suite green; e2e green after its run.

---

## 14. Test plan

Component tests run in the real-Chromium browser project (per `docs/rules/testing_standards.md`
and `reference_vitest_project_split`), so portal/focus/`:has()` behave as in production.

- **`HighlightActionBar.test.tsx`** — keep the existing `presentation="bar"` cases (pass the prop).
  Add `presentation="menu"`: (a) one "Highlight actions" trigger, no directly-visible action
  buttons; (b) open → `menuitem`s present, color `group` present; (c) "Delete highlight" with a
  stubbed `window.confirm=()=>true` calls `onDelete` once and closes; with `=>false` does not call
  it; (d) "Edit bounds" calls `onToggleEditBounds` and closes; (e) a non-owner highlight renders no
  trigger.
- **`ReaderHighlightsSurface.test.tsx`** — invert the row action assertion (`~:327-339`): assert the
  single named trigger with `aria-haspopup="menu"`; assert the five icon buttons are absent; open
  the menu and assert one action is reachable as a `menuitem` and the color picker as a `group`.
  Keep focus-no-scroll, hover, show-more, and linked-chat tests green (untouched slots).
- **`HighlightActionPopover.test.tsx`** — pass `presentation="bar"` in the harness; keep the dialog
  + five-option assertion (the popover is still a bar).
- **`highlightActions.test.ts`** — unchanged (descriptor model unchanged); it remains the gating
  contract both renderers share.
- **E2E** — for the desktop sidecar: open a row's "Highlight actions" `…` menu → delete (confirm) →
  the highlight disappears from the list and the prose mark is removed; open the menu → change color
  → the row/mark recolor; open the menu → "Edit bounds" → the meta line appears and the row is
  focused. Reader-text-click-popover and selection-create flows are unchanged (icon bars). Run the
  full `e2e` suite; update any sidecar step that targeted an icon button to target the menu.

---

## 15. Rules adherence

- `docs/rules/simplicity.md` — one presentation per surface, no speculative API: the only new
  surface is one required prop; no new component, hook, icon, or descriptor field; no
  `menuitemcheckbox` change for one consumer.
- `docs/rules/cleanliness.md` — one owner per concern (`HighlightActionBar` keeps delete/color
  state; `buildHighlightActions` keeps the descriptor truth); the cross-surface CSS consolidation is
  declined here and tracked as its own change rather than smuggled in.
- `docs/rules/module-apis.md` — `presentation` is explicit and required; both renderers share one
  accessible name; the model exposes one capability set, rendered two surface-appropriate ways.
- `docs/rules/testing_standards.md` — behaviour asserted in the real-browser component layer plus a
  user-flow e2e; no jsdom reliance for the portal/menu.
- Hard cutover — the sidecar renders the menu only; no flag, no icon-bar fallback, no compat default.

---

## 16. Risks & mitigations

- **Discoverability of a single kebab.** Mitigated by the ambient `0.5` reveal (the trigger is
  faintly visible at rest, not hidden like `AppList`'s `opacity:0`), and by the unchanged
  reader-text click popover, which still surfaces actions in-context on the prose. The `…` glyph is
  the app-wide learned overflow affordance.
- **Extra click for high-frequency actions.** Accepted per the chosen aggressive direction; the
  in-context popover remains the one-tap-each path. If quote frequency later argues for it, a single
  inline primary can be added without undoing this cutover (it would just stop collapsing one
  descriptor) — but that is explicitly not this spec.
- **Color picker as the first menu row.** Slightly unusual but compact and already the established
  inline-render behaviour; the current color is disabled in the picker, so it reads as status +
  action.
- **Edit-bounds cancel via the menu.** Cancelling requires reopening the kebab and selecting "Cancel
  edit bounds" (or using the reader-text popover / existing cancel paths). Acceptable for a
  low-frequency action; the meta line makes the editing state obvious on the focused card.
- **Touch.** No hover dependence in the new path — the trigger is full-opacity on `hover:none`
  (inherited rule) and the menu is a normal tap-driven dropdown with comfortable menuitem targets,
  strictly better than five sub-44 px icons.
```

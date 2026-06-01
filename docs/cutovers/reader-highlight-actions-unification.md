# Reader highlight actions — icon action bar & unified click surface · hard cutover spec

Status: implemented (2026-06-01); reviewed & hardened (2026-06-01) · Owner: reader/highlights · Type: hard cutover (no legacy, no fallbacks, no back-compat)

**As-built notes (deviations from this plan):**
- **AC#7 fully met.** `useAnchoredPosition` is now the sole positioning implementation for `ActionMenu`, `HoverPreview`, both Library pickers, and the two new popovers. The hook gained one generic ref param (`<T extends HTMLElement = HTMLDivElement>`) so `ActionMenu`'s `<ul>` can use it; `ActionMenu` maps to `placement:"below", align:"end"` (replacing its `translateX(-100%)` hack) and re-keys its focus-after-position effect on the hook's `anchorRect`; `HoverPreview` maps its `{x,y}` point to a zero-size `DOMRect` with `placement:"above", align:"center", flip:true` (memoized on the x/y primitives to avoid a layout-effect loop). All bespoke positioning blocks are deleted. (The initial implementation deferred these two; the review completed them — the hook needed no new options, and migrating turned the otherwise-speculative `placement:"above"`/`align:"end"` into used surface.)
- **Builder location:** `buildHighlightActions` lives at `components/highlights/highlightActions.tsx`, **not** `lib/actions/highlightActions.ts` as §5/§6.2/§10 sketched. Rationale: unlike the pure, JSX-free `lib/actions/resourceActions.ts`, this builder embeds JSX (lucide icons, a `ColorDot`, and the `HighlightColorPicker` render slot) and owns a `.module.css`; `lib/` hosts no CSS module anywhere, so co-locating with its component co-owners is the cleaner home. The §10 file list is stale on this point.
- `useHighlightInteraction` is unchanged (deviates from §7/§10): the clicked element's rect is already in hand inside `MediaPaneBody.handleReaderContentClick`, so the reflowable anchor is captured there directly (PDF already supplied a rect).
- The `HighlightActionCapabilities` / `HighlightActionHandlers` / `HighlightActionState` interfaces (§6.2) were inlined into `buildHighlightActions`' argument; only `HighlightActionTarget` is a named type. `HighlightActionBar` is split into internal `ExistingActionBar`/`SelectionActionBar` so the feedback hook is scoped to the existing variant (selection needs no `FeedbackProvider`).
- The nested-layer dismiss marker is `data-dismiss-ignore` (generalized from `data-selection-popover-ignore-outside`) and `useDismissOnOutsideOrEscape` now honors it, so a click-popover's child color picker never dismisses its parent.

**Review pass additions (2026-06-01), beyond the original implementation:**
- **Correctness:** the reader-text click popover is now declaratively suppressed while a selection is live (`!selection` in its render guard) and during edit-bounds — previously the two popovers' mutual exclusion relied only on outside-pointerdown, so a keyboard selection or a double-click landing on the popover could show both at once.
- **Consolidation:** `SelectionPopover`'s two hand-rolled dismiss effects (Escape + outside-pointerdown, which re-implemented the shared hook line-for-line including the `data-dismiss-ignore` rule) were replaced with `useDismissOnOutsideOrEscape`. (Its multi-placement positioning stays bespoke per §3.)
- **Cleanup:** `MediaPaneBody.handleReaderContentClick` no longer returns the dead `string | null` from the removed sheet-reveal path; the one-use `handleContentClick` wrapper was inlined; the click-popover resolution was hoisted out of an in-JSX IIFE to a derived `highlightActionTarget`.
- **Tests:** added the missing `useAnchoredPosition.test.tsx` (browser project — flip/clamp/align/disabled geometry); dropped a duplicate confirm-copy assertion from `ReaderHighlightsSurface.test.tsx` (owned by `HighlightActionBar`'s test).
- **E2E (was left broken by the cutover):** updated the Playwright specs that drove the deleted kebab — `epub`, `pdf-reader`, `non-pdf-linked-items` now act via the sidecar icon buttons (`role="group" name="Highlight actions"` → direct `Quote to new chat` / `Delete highlight` / `Edit bounds` buttons) instead of `name:"Actions"` → `menuitem`s; and the selection-create flows in `epub`, `web-articles`, `youtube-transcript`, `real-media-seed` now open the unified "Highlight color" dot before picking a swatch (the always-open swatch row is gone per §13.1). These require an `e2e` run to confirm end-to-end.

Highlight actions are today a text-label kebab dropdown on the sidecar card, and they are
**not reachable at all** when you click a highlight in the reader text. This cutover makes the
highlight action set a single, centralized capability rendered as a compact **icon action bar**,
and surfaces that same bar — same options, same components — in three places: the sidecar card,
a new popover anchored to a clicked highlight in the reader text, and the selection popover for
fresh selections. One builder, one bar, one color picker. The dropdown (`ActionMenu`) survives
for resource lists but is no longer the highlight surface.

This composes on top of `reader-highlight-sidecar-exact-only.md` (assumed landed: `ItemCard`'s
highlight content is `{ exact, color }`).

---

## 1. Context & problem

There are three highlight-adjacent action surfaces, each hand-rolled, with no shared model:

1. **Sidecar card.** `ReaderHighlightsSurface.renderRow` builds an `ActionMenuOption[]` **inline**
   (`ReaderHighlightsSurface.tsx:568–620`) — *Quote to new chat*, *Quote to existing chat*,
   *Edit bounds*, *Highlight color* (a `render` slot embedding `HighlightColorPicker`), *Delete*
   (danger, `separatorBefore`) — and hands it to `ItemCard`, which renders a single `…`
   `ActionMenu` trigger (`ItemCard.tsx:108`). Every action costs an open-then-read; affordances
   are hidden; the kebab competes with the (now exact-only) selection text.

2. **Selection popover** (fresh text selection only). `SelectionPopover.tsx:318–355` renders an
   inline `HighlightColorPicker` plus two **icon** quote buttons (`MessageSquarePlus`,
   `MessagesSquare`, `aria-label`+`title`). This is the icon-bar pattern we want — but it is a
   bespoke copy: its own buttons, its own ordering, its own dismiss logic (`:244–275`, not the
   shared hook), wired to the *same* underlying handlers as the sidecar.

3. **Clicking an existing highlight in the reader text** surfaces **no actions**. Reflowable:
   `handleReaderContentClick` (`MediaPaneBody.tsx:2880–2901`) → `findHighlightElement` →
   `handleHighlightClick` only sets `focusedId`. PDF: per-rect listener →
   `handlePdfHighlightTap(id, rect)` (`MediaPaneBody.tsx:3627–3640`) only focuses (note: PDF
   already hands up a `DOMRect`). To act on a highlight you must leave the text, find its card
   in the sidecar, open the kebab.

The handlers are already centralized in `MediaPaneBody` and already shared between surfaces:
`quoteHighlightToNewChat` (`:3663`), `quoteHighlightToExtantChat` (`:3687`), `handleColorChange`
(`:3006` → `applyHighlightMutation`→`updateHighlight`), `handleDelete` (`:3013`),
`startEditBounds`/`cancelEditBounds` (from `useHighlightInteraction`, `:648–654`). The selection
popover reaches the same quote callbacks via *create-then-quote* (`:5024–5040`). So the **logic**
is one; only the **action descriptors and their presentation are triplicated**.

What is missing is a single, presentation-neutral **action model** and **one renderer** for it,
plus one anchored-popover host so the reader-text click can show that renderer.

---

## 2. Goals

1. **One highlight action model.** A pure builder `buildHighlightActions(...)` is the single
   source of truth for which highlight actions exist, their icons, order, tone, toggled state,
   and gating — mirroring the existing `lib/actions/resourceActions.ts` builders.
2. **One inline renderer.** A generic `ActionBar` renders any `ActionMenuOption[]` as a compact
   row of icon buttons (tooltips, danger tone, separators, toggled state, and `render`-slot
   options as anchored popovers). `ActionMenuOption` gains an optional `icon` (Option B).
3. **One domain component.** `HighlightActionBar` owns transient per-action state (deleting,
   changing color, confirm), calls the builder, and renders `ActionBar`. It is the *only* thing
   any surface mounts to show highlight actions.
4. **Same actions at the click site.** Clicking a highlight in the reader text (reflowable **and**
   PDF) opens `HighlightActionPopover` anchored to the highlight, hosting `HighlightActionBar` —
   identical options/components to the sidecar.
5. **Selection popover folds in.** `SelectionPopover` renders the same `HighlightActionBar`
   (selection variant: color + quotes only), deleting its bespoke quote buttons.
6. **Consolidate floating positioning.** Introduce one `useAnchoredPosition` hook for the new
   popovers and migrate the mechanically-identical existing consumers onto it.
7. **Hard cutover.** No highlight kebab path remains; no parallel/old action arrays; no
   compatibility flags. `ItemCard` stops embedding `ActionMenu`.

## 3. Non-goals

- **No change to highlight mutation logic or API.** `createHighlight`/`updateHighlight`/
  `deleteHighlight`/quote selection (`lib/highlights/api.ts`, `quoteText.ts`,
  `applyHighlightMutation`, `readerSelectionForHighlight`) are unchanged. We only re-route *which
  UI* invokes them.
- **No change to focus/projection/alignment.** `useHighlightInteraction`, `focusedId` →
  `expanded`, `useAnchoredHighlightProjection`, row measurement, ruler — unchanged except for
  `handleHighlightClick` carrying an anchor rect (additive).
- **No change to the overview ruler**, its hover popover, or `HoverPreview` content.
- **No new highlight features** (reorder, multi-select, batch). The action *set* is exactly
  today's five; only presentation and reach change.
- **No forced rename** of `ActionMenuOption` and **no forced icons** on resource menus — the new
  `icon` field is optional; existing `ActionMenu` consumers are untouched.
- **`SelectionPopover` positioning is not migrated** to `useAnchoredPosition` in this cutover
  (its multi-placement/visualViewport/mobile logic is its own concern — see §8). Only its
  *content* unifies.

---

## 4. Target behaviour (UX)

### 4.1 Sidecar card — kebab → icon bar

```
BEFORE (current)                              AFTER (this cutover)
┌────────────────────────────────────────┐   ┌────────────────────────────────────────┐
│ poolpah                            [⋯]  │   │ poolpah                                 │  resting: text only,
│ Add a note…                             │   │ Add a note…              ◐ ⤷+ ⤷ ⌖ · 🗑 │  bar fades in on
│ ▸ 2 linked chats                        │   │ ▸ 2 linked chats                        │  hover / focus-within
└────────────────────────────────────────┘   └────────────────────────────────────────┘
  one kebab, open-then-read every action        color · quote-new · quote-existing · edit-bounds | delete
```

- **Resting:** no controls visible (text + note + linked chats only) — calmer than today's
  always-present kebab.
- **Hover / `:focus-within`:** the icon bar fades in (opacity 0.5→1, the `WorkspacePaneStrip`
  pattern), right-aligned, tight gap.
- **Icons:** color = a dot in the highlight's current color (opens the picker); quote-new =
  `MessageSquarePlus`; quote-existing = `MessagesSquare`; edit-bounds = `TextSelect`; delete =
  `Trash2` (danger, preceded by a thin divider). Each has `aria-label`+`title`.
- **Gating:** quotes appear only when `canQuoteToChat && hasQuoteText`; color/edit/delete only for
  owners (`canEdit`); edit-bounds only for reflowable text (`canEditBounds`, hidden on PDF).
- **Edit-bounds is a toggle:** when active it shows `aria-pressed`, an active background, and the
  label flips to "Cancel edit bounds".

### 4.2 Reader-text click — new action popover

Clicking (or Enter/Space on) a highlight in the reader text focuses it (as today) **and** opens
`HighlightActionPopover` anchored to the clicked highlight, hosting the same `HighlightActionBar`:

```
   …the unmitigated ⟦poolpah hit the fan⟧ and then…
                    └─────────────────┘
                    ┌───────────────────────┐
                    │ ◐  ⤷+  ⤷  ⌖   ·   🗑  │  ← same bar, same components
                    └───────────────────────┘
```

- Dismiss: outside-click, Escape, scroll, a new text selection, or clicking another highlight
  (re-anchors). Uses the shared dismiss + positioning hooks.
- Entering edit-bounds mode dismisses the popover (the user then selects new text in the reader).
- Mobile: the popover positions within the viewport (clamped). It **replaces** the current
  "tap reveals the highlights sheet" behaviour for the action use case (see §8 decision).

### 4.3 Selection popover — same bar, selection variant

Selecting fresh text shows `SelectionPopover` as today, but its body is now `HighlightActionBar`
in **selection** mode: color + quote-new + quote-existing (create-then-quote). No
edit-bounds/delete (no highlight exists yet). The color affordance is the **same compact
current-color dot → `HighlightColorPicker` popover** as the other surfaces (resolved §13.1) —
picking a color creates the highlight in that color. The selection popover therefore loses its
current always-open 5-swatch row in favour of identical layout everywhere. Same icons, same
`HighlightColorPicker`.

---

## 5. Architecture & final state

```
lib/actions/highlightActions.ts                 PURE builder (mirror of resourceActions.ts)
  buildHighlightActions({target, capabilities,   →  ActionMenuOption[]  (now with icon, pressed)
    handlers, state}) ──────────────────────────────┐
                                                     │ ActionMenuOption[]
components/highlights/HighlightActionBar.tsx         │  DOMAIN component — the ONLY mount point
  owns transient state (deleting, changingColor,     │  builds options, renders <ActionBar/>
  confirm); variant: "existing" | "selection" ◄──────┘
        │ renders
        ▼
components/ui/ActionBar.tsx                       GENERIC inline renderer of ActionMenuOption[]
  icon buttons + tooltips + danger + separators        (sibling of ActionMenu; shares the type)
  render-slot option → anchored popover (uses ▼)
        │                                           components/ui/ActionMenu.tsx (UNCHANGED behaviour)
lib/ui/useAnchoredPosition.ts                          + ActionMenuOption gains optional `icon`,`pressed`
  shared anchor-rect positioning (portal, clamp,       + renders `icon` as leading glyph if present
  scroll/resize) ── also used by HoverPreview,
  ActionMenu, Library pickers (migrated)

Mounted by:
  reader/ReaderHighlightsSurface.renderRow ── passes <HighlightActionBar variant="existing"/> as ItemCard.actions
  highlights/HighlightActionPopover ───────── hosts <HighlightActionBar variant="existing"/>; positioned by useAnchoredPosition
  SelectionPopover ────────────────────────── hosts <HighlightActionBar variant="selection"/>
  (all three get handlers from MediaPaneBody, which already owns them)
```

Layering, top to bottom: **MediaPaneBody** owns canonical async mutations (unchanged) →
**`buildHighlightActions`** is a pure descriptor factory → **`HighlightActionBar`** binds state +
confirm and is the single domain widget → **`ActionBar`** is the generic presentation →
**`useAnchoredPosition`** is the shared geometry. `ItemCard` becomes a dumb slot host.

---

## 6. Capability contract & API design

### 6.1 `ActionMenuOption` — additive fields (`components/ui/ActionMenu.tsx:17`)

```ts
export interface ActionMenuOption {
  id: string;
  label: string;                       // used as the accessible name / tooltip everywhere
  icon?: ReactNode;                    // NEW — required-in-practice for ActionBar; optional leading glyph in ActionMenu
  pressed?: boolean;                   // NEW — toggle state; ActionBar → aria-pressed + active style; ActionMenu ignores
  render?: (c: { closeMenu: () => void; triggerEl: HTMLElement | null }) => ReactNode;
  onSelect?: (d: { triggerEl: HTMLElement | null }) => void;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  separatorBefore?: boolean;
  restoreFocusOnClose?: boolean;
}
```

- `render` is re-interpreted per renderer: in `ActionMenu` it is an inline menu row (today's
  behaviour); in `ActionBar` it becomes an **icon button (using `icon`) that opens an anchored
  popover containing `render(controls)`**. The color option uses exactly this.
- Both new fields are optional → the 9 existing `ActionMenuOption` consumers (`resourceActions`,
  `AppList`, `SurfaceHeader`, `PaneShell`, `WorkspaceHost`, …) compile unchanged.

### 6.2 `lib/actions/highlightActions.ts` — the builder (NEW)

```ts
export type HighlightActionTarget =
  | { kind: "existing"; highlight: AnchoredHighlightRow }
  | { kind: "selection"; color: HighlightColor };   // no highlight yet

export interface HighlightActionCapabilities {
  canQuoteToChat: boolean;   // media.capabilities.can_quote
  canEdit: boolean;          // highlight.is_owner !== false (color, delete)
  canEditBounds: boolean;    // canEdit && reflowable (text) — never on PDF
  hasQuoteText: boolean;     // exact.trim().length > 0
}

export interface HighlightActionHandlers {
  onQuoteToNewChat(): void;
  onQuoteToExistingChat(): void;
  onSelectColor(color: HighlightColor): void;
  onToggleEditBounds(): void;          // start if idle, cancel if editing
  onDelete(): void;                    // confirm lives in HighlightActionBar, not here
}

export interface HighlightActionState {
  isEditingBounds: boolean;
  deleting: boolean;
  changingColor: boolean;
}

export function buildHighlightActions(args: {
  target: HighlightActionTarget;
  capabilities: HighlightActionCapabilities;
  handlers: HighlightActionHandlers;
  state: HighlightActionState;
}): ActionMenuOption[];
```

**Canonical order & gating** (absent actions are omitted, never disabled-but-present):

| id | icon | when | tone | notes |
|----|------|------|------|-------|
| `color` | current-color dot | `canEdit` (existing) / always (selection) | default | `render` = `HighlightColorPicker`; `selection` → pick creates |
| `quote-new` | `MessageSquarePlus` | `canQuoteToChat && hasQuoteText` | default | |
| `quote-existing` | `MessagesSquare` | `canQuoteToChat && hasQuoteText` | default | |
| `edit-bounds` | `TextSelect` | `canEditBounds` (existing only) | default | `pressed = isEditingBounds`; label flips |
| `delete` | `Trash2` | `canEdit` (existing only) | `danger` | `separatorBefore: true` |

Pure: no React state, no async — fully unit-testable on `(target, capabilities, state)`.

### 6.3 `components/ui/ActionBar.tsx` (NEW)

```ts
interface ActionBarProps {
  options: ActionMenuOption[];
  label?: string;          // group aria-label; default "Actions"
  className?: string;
}
```

- Renders `<div role="group" aria-label={label}>` of icon buttons (one per option), tight gap,
  reusing `Button` `variant="ghost" size="sm" iconOnly` (28px). Icon `size={14}`, `aria-hidden`.
- Each button: `aria-label`+`title` = `option.label`; `tone==="danger"` → danger color;
  `pressed` → `aria-pressed` + active style; `disabled` honored; `separatorBefore` → a 1px
  divider; `href` → anchor.
- A `render` option becomes an icon **toggle** whose press opens an anchored popover (via
  `useAnchoredPosition` + `useDismissOnOutsideOrEscape`) containing `render({ closeMenu, triggerEl })`.
- No portal/menu semantics of its own beyond the optional render-popover; it is a flat toolbar.

### 6.4 `components/highlights/HighlightActionBar.tsx` (NEW) — single mount point

```ts
interface HighlightActionBarProps {
  variant: "existing" | "selection";
  highlight?: AnchoredHighlightRow;     // required when variant="existing"
  selectionColor?: HighlightColor;      // current swatch when variant="selection"
  capabilities: HighlightActionCapabilities;
  isEditingBounds: boolean;
  handlers: HighlightActionHandlers;    // raw MediaPaneBody handlers (no confirm/spinner)
  className?: string;
}
```

- Owns transient state: `deleting`, `changingColor`. Wraps `handlers.onDelete` with
  `window.confirm("Delete this highlight?")` + `deleting` spinner (moving the confirm currently
  at `ReaderHighlightsSurface.tsx:512` here, so all three surfaces share it). Wraps
  `onSelectColor` with `changingColor` (today `ReaderHighlightsSurface.handleColorChange`).
- Calls `buildHighlightActions(...)` then renders `<ActionBar options={...} />`.
- A component (not a bare function) precisely so the per-instance hooks are legal — the sidecar
  mounts one per card (no hook-in-loop), the popovers mount one each.

### 6.5 `components/highlights/HighlightActionPopover.tsx` (NEW)

```ts
interface HighlightActionPopoverProps {
  highlight: AnchoredHighlightRow;
  anchorRect: DOMRect;                  // clicked highlight rect (PDF supplies; reflowable captured)
  capabilities: HighlightActionCapabilities;
  isEditingBounds: boolean;
  handlers: HighlightActionHandlers;
  onDismiss(): void;
}
```

- Portals to `document.body`; positioned by `useAnchoredPosition(anchorRect, { placement: "below", flip: true })`;
  dismissed via `useDismissOnOutsideOrEscape` + scroll. Hosts `<HighlightActionBar variant="existing" .../>`.

### 6.6 `lib/ui/useAnchoredPosition.ts` (NEW)

```ts
function useAnchoredPosition(
  anchor: DOMRect | (() => DOMRect | null) | RefObject<HTMLElement>,
  opts?: {
    placement?: "below" | "above" | "right" | "left";
    align?: "start" | "end" | "center";
    flip?: boolean;          // flip to opposite side if clipped
    gap?: number;            // px from anchor (default 4)
    viewportPadding?: number;// clamp inset (default 8)
  },
): { ref: RefObject<HTMLElement>; style: CSSProperties; placement: string };
```

- Encapsulates `getBoundingClientRect` read, viewport clamp/flip, and `scroll`(capture)+`resize`
  listeners — the logic duplicated across `ActionMenu.tsx:112–126`, `HoverPreview.tsx:36–55`,
  `LibraryMembershipPanel.tsx:105–125`, `LibraryMultiSelectPicker.tsx:347–373`.

---

## 7. How it composes with other systems

- **MediaPaneBody (handlers & mounts).** Already owns and shares the canonical handlers. New work:
  (a) capture an **anchor rect** on highlight click — PDF already passes it
  (`handlePdfHighlightTap`); for reflowable, read `findHighlightElement(...)`’s
  `getBoundingClientRect()` in `handleReaderContentClick` (`:2880`); (b) hold
  `highlightActionAnchor: { highlightId, rect } | null`; (c) render `<HighlightActionPopover>` when
  set and not in edit-bounds/selection; (d) pass the same `handlers`/`capabilities` to the sidecar,
  the popover, and `SelectionPopover`. Capability flags (`canEdit`, `hasQuoteText`, `canEditBounds`)
  are computed once per highlight (today they live at `ReaderHighlightsSurface.tsx:563–564`; they
  move to a tiny shared selector so all three surfaces agree).
- **`useHighlightInteraction`.** `handleHighlightClick` already resolves the topmost id + cycles
  overlaps; extend its callback to carry the rect so MediaPaneBody can anchor. `focusState`
  unchanged. Edit-bounds start/cancel unchanged.
- **`ItemCard`.** `actions` changes from `ActionMenuOption[]` to `actions?: ReactNode`
  (`ItemCard.tsx:25,108`); it renders the node in the header and no longer imports `ActionMenu`.
  Both consumers update: `ReaderHighlightsSurface` passes `<HighlightActionBar/>`;
  `ConversationReferencesSurface.tsx:39` (a resource card) passes `<ActionMenu options={…}/>`.
- **`ActionMenu`.** Behaviour preserved for resource lists; gains optional leading `icon`
  rendering. It is no longer in the highlight path. Not deleted.
- **`HighlightColorPicker`.** Unchanged; now consumed only through the `render` slot of the color
  option (sidecar/popover) and the selection bar — one component, three surfaces.
- **Quote / color / delete / edit pipelines.** Untouched below the UI. Quote still flows through
  `readerSelectionForHighlight` → `pendingQuoteUri`/`secondaryChat`; color/delete still through
  `applyHighlightMutation`; edit-bounds still through the existing select-new-text effect.
- **Ruler & `HoverPreview`.** Content untouched; `HoverPreview` only swaps its bespoke positioning
  for `useAnchoredPosition` (no visual change).

---

## 8. Reuse / consolidation decisions (resolved)

| Question | Decision | Why |
|---|---|---|
| Inline variant: new prop on `ActionMenu` vs sibling component | **Sibling `ActionBar`, shared `ActionMenuOption`.** | `ActionMenu` is a trigger+portal+menu-keyboard machine; a flat toolbar is a different render. One type, two renderers (the `ActionMenu`+`resourceActions` split, extended). |
| Highlight actions defined where | **One pure `buildHighlightActions` in `lib/actions/`.** | Removes the triplication (sidecar inline array, selection buttons, nothing-at-click). Mirrors `resourceActions.ts`; testable without React. |
| Transient state (deleting/confirm/changingColor) | **Owned by `HighlightActionBar`.** | Keeps the builder pure and gives all three surfaces identical confirm/spinner with no copy. Confirm moves out of `ReaderHighlightsSurface`. |
| Color affordance in the bar | **Single current-color dot → opens `HighlightColorPicker` in an anchored popover** (via the `render` slot). | Compact and identical in the narrow sidecar, the small click-popover, and the selection popover. A 5-swatch inline row (today's selection layout) overflows the sidecar next to 4 icons. *Alternative for selection mode — keep the immediate inline row — is flagged in §13.* |
| Reader-text click: focus only vs focus + popover | **Focus + popover.** | The explicit ask: act at the click site. Focus still drives the mark + sidecar sync; the popover adds reach without a sidecar trip. |
| Reuse `ActionMenuOption` name vs rename to `ActionItem` | **Keep the name (add fields).** | Renaming ripples through 9 files for no behaviour gain; out of scope. Optional follow-up. |
| `useAnchoredPosition` scope | **New hook; migrate the 4 mechanically-identical sites** (`ActionMenu`, `HoverPreview`, both Library pickers) + use it for the 2 new popovers. **Defer `SelectionPopover`.** | The new popovers need positioning; building bespoke would *add* duplication. `SelectionPopover`’s multi-placement/visualViewport/multi-line-selection logic is materially richer and would dominate/destabilize this cutover — it migrates separately. |
| Mobile reader-text tap | **Popover replaces the auto-reveal of the highlights sheet** for actions. | Actions arrive at the tap site; the sheet is still reachable via its toggle. Two surfaces popping at once is noise. (Flagged in §13.) |
| Keep a kebab fallback for highlights | **No.** | Hard cutover — the bar is the only highlight action UI; no dual path. |

---

## 9. Scope

**In scope**
- `components/ui/ActionMenu.tsx`: add optional `icon`,`pressed`; render `icon` as leading glyph.
- `components/ui/ActionBar.tsx` (+`.module.css`): new generic inline renderer.
- `lib/actions/highlightActions.ts`: new `buildHighlightActions` + types.
- `components/highlights/HighlightActionBar.tsx` (+`.module.css`): new domain widget.
- `components/highlights/HighlightActionPopover.tsx` (+`.module.css`): new click-site popover.
- `lib/ui/useAnchoredPosition.ts`: new hook; migrate `ActionMenu`, `HoverPreview`,
  `LibraryMembershipPanel`, `LibraryMultiSelectPicker`.
- `components/items/ItemCard.tsx`: `actions` → `ReactNode` slot; drop `ActionMenu` import.
- `components/chat/ConversationReferencesSurface.tsx`: wrap its resource actions in `<ActionMenu>`.
- `components/reader/ReaderHighlightsSurface.tsx`: `renderRow` mounts `<HighlightActionBar>`;
  remove the inline action array, `handleDelete` confirm, `handleColorChange` state (moved).
- `components/SelectionPopover.tsx`: body → `<HighlightActionBar variant="selection">`; remove
  bespoke quote buttons + inline picker block.
- `app/(authenticated)/media/[id]/MediaPaneBody.tsx`: capture anchor rect; own
  `highlightActionAnchor`; render `HighlightActionPopover`; share `capabilities`/`handlers`;
  hoist capability-flag computation to a shared selector.
- `lib/highlights/useHighlightInteraction.ts`: `handleHighlightClick` carries the anchor rect.
- Tests (see §10).

**Out of scope**
- Highlight data model, APIs, BFF, quote selection logic, `applyHighlightMutation`.
- Focus/projection/alignment engine; ruler logic; `HoverPreview` content.
- `SelectionPopover` positioning migration; renaming `ActionMenuOption`; icons on resource menus.
- Any new highlight feature beyond the existing five actions.

---

## 10. Files

**New**
- `apps/web/src/components/ui/ActionBar.tsx` + `ActionBar.module.css`
- `apps/web/src/lib/actions/highlightActions.ts`
- `apps/web/src/components/highlights/HighlightActionBar.tsx` + `.module.css`
- `apps/web/src/components/highlights/HighlightActionPopover.tsx` + `.module.css`
- `apps/web/src/lib/ui/useAnchoredPosition.ts`

**Modified**
- `apps/web/src/components/ui/ActionMenu.tsx` — `icon`,`pressed` fields; leading-glyph render;
  adopt `useAnchoredPosition` (replacing `:112–126`).
- `apps/web/src/components/ui/HoverPreview.tsx` — adopt `useAnchoredPosition` (replacing `:36–55`).
- `apps/web/src/components/library/LibraryMembershipPanel.tsx`,
  `apps/web/src/components/library/LibraryMultiSelectPicker.tsx` — adopt the hook.
- `apps/web/src/components/items/ItemCard.tsx` — `actions: ReactNode`.
- `apps/web/src/components/chat/ConversationReferencesSurface.tsx` — wrap actions in `<ActionMenu>`.
- `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` — mount `HighlightActionBar`; drop
  inline array (`:568–620`) + moved state.
- `apps/web/src/components/SelectionPopover.tsx` — host `HighlightActionBar` (selection).
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` — anchor capture, popover host,
  shared capabilities/handlers.
- `apps/web/src/lib/highlights/useHighlightInteraction.ts` — anchor rect on click.

**Tests (new)** `ActionBar.test.tsx`, `highlightActions.test.ts`, `HighlightActionBar.test.tsx`,
`HighlightActionPopover.test.tsx`, `useAnchoredPosition.test.ts`.
**Tests (modified)** `ActionMenu.test.tsx` (leading icon), `ItemCard.test.tsx` (actions slot),
`ConversationReferencesSurface.test.tsx`, `ReaderHighlightsSurface.test.tsx` (assert icon buttons
by role/name, not menu items), `SelectionPopover.test.tsx` (shared bar).

---

## 11. Key details

- **Icons** (lucide, all verified present): `MessageSquarePlus`, `MessagesSquare` (reuse the
  selection-popover vocabulary), `Trash2`, and `TextSelect` for edit-bounds (semantically
  “adjust the selected range”; alternatives `Pencil`/`Crop` noted in §13). Color is a small
  current-color `ColorDot` (reuse the swatch CSS from `HighlightColorPicker`).
- **Sizing/tokens:** `ghost`/`iconOnly`/`size="sm"` (28px = `--size-sm`); icon `size={14}`; gap
  `var(--space-1)`; danger via `--danger`; hover-reveal `opacity .5→1`,
  `transition: opacity var(--duration-fast) var(--ease-glide)` (the `WorkspacePaneStrip` idiom);
  reveal on `:hover` **and** `:focus-within`. No raw px / inline styles (ESLint).
- **A11y:** bar = `role="group" aria-label`; each button `type=button`, `aria-label`+`title`,
  icon `aria-hidden`; toggle uses `aria-pressed`; danger uses color, not color-only meaning (the
  label carries it). PDF overlay rects keep `role="button"`/`tabindex=0`; Enter/Space opens the
  popover (focusable) just like click.
- **Delete safety:** `window.confirm` retained, now in `HighlightActionBar` (one copy).
- **PDF edit-bounds:** `canEditBounds=false` on PDF (matches the existing `if (isPdf) return`
  guard at `MediaPaneBody.tsx:2908`) → the edit icon is simply absent there.
- **Empty-`exact` highlights:** quotes are gated off (`hasQuoteText=false`), exactly as
  `ReaderHighlightsSurface.tsx:564` does today; color/edit/delete remain.
- **Dismiss interplay:** the click-popover and `SelectionPopover` are mutually exclusive
  (`SelectionPopover` shows only for a live, non-collapsed selection; clicking a highlight
  collapses selection) — no double surface.

---

## 12. Implementation phasing (suggested order, each independently green)

1. **Primitives:** `useAnchoredPosition` + migrate `HoverPreview`/`ActionMenu`/Library pickers
   (pure refactor; no UX change; lands behind existing tests).
2. **Model + renderer:** `ActionMenuOption.icon/pressed`, `ActionBar`, `buildHighlightActions`,
   `HighlightActionBar` — with unit/component tests; not yet wired.
3. **Sidecar cutover:** `ItemCard.actions → ReactNode`; `ReaderHighlightsSurface` mounts
   `HighlightActionBar`; update `ConversationReferencesSurface`; flip `ReaderHighlightsSurface`
   tests to role/name. (Kebab gone from highlights.)
4. **Selection cutover:** `SelectionPopover` hosts the selection-variant bar; delete bespoke
   buttons.
5. **Click surface:** anchor-rect capture in `useHighlightInteraction`/`MediaPaneBody`;
   `HighlightActionPopover`; e2e of click-highlight-then-act on reflowable + PDF.

---

## 13. Resolved decisions

1. **Color affordance → unified everywhere.** The compact current-color dot → `HighlightColorPicker`
   popover is used by all three surfaces, including the selection popover (which loses its
   always-open 5-swatch row). One layout, no divergence. (§4.3, §6.2, §8.)
2. **Edit-bounds icon → `TextSelect`.** Semantically "adjust the selected range"; distinct from the
   generic edit/note glyph. (§6.2, §11.)
3. **Mobile reader-text tap → popover replaces the sheet auto-reveal.** Tapping a highlight opens
   the action popover at the tap site (viewport-clamped); the highlights sheet no longer
   auto-reveals on tap and stays reachable via its toggle. (§4.2, §8.)

---

## 14. Acceptance criteria

1. Highlight actions exist in exactly one descriptor source (`buildHighlightActions`); no inline
   `ActionMenuOption[]` for highlights remains (`rg` of `ReaderHighlightsSurface` shows the array
   gone), and `SelectionPopover` defines no bespoke quote buttons.
2. The sidecar card shows actions as an **icon bar** that is hidden at rest and revealed on
   hover/`:focus-within`; each action is reachable by `getByRole("button", { name })`; the kebab
   `ActionMenu` no longer appears for highlights.
3. Clicking (or Enter/Space on) a highlight in the reader text — reflowable **and** PDF — opens a
   popover anchored to that highlight containing the **same** `HighlightActionBar`, with options
   gated identically to the sidecar (owner/quote/PDF rules); it dismisses on outside-click,
   Escape, scroll, new selection, and re-anchors on clicking another highlight.
4. `SelectionPopover` renders the selection-variant bar (color + both quotes, no edit/delete) via
   `HighlightActionBar` and `HighlightColorPicker`; create-then-quote still works.
5. Edit-bounds shows `aria-pressed`/active styling while editing, flips its label, is **absent**
   on PDF, and starting it dismisses the click-popover; color change and delete (with confirm)
   work identically from all three surfaces.
6. `ItemCard.actions` is `ReactNode`; `ItemCard` no longer imports `ActionMenu`; both consumers
   compile and render (`ConversationReferencesSurface` via `<ActionMenu>`, highlights via
   `<HighlightActionBar>`).
7. `useAnchoredPosition` is the sole positioning implementation for `ActionMenu`, `HoverPreview`,
   both Library pickers, and the two new popovers; their prior bespoke positioning blocks are
   deleted; no visual regression.
8. No mutation/API/projection/ruler code changed (diffs of `lib/highlights/api.ts`,
   `applyHighlightMutation`, `useAnchoredHighlightProjection`, `ReaderOverviewRuler` are empty).
9. `bun run typecheck`, `bun run lint` (zero warnings), and all new/updated tests pass.
```

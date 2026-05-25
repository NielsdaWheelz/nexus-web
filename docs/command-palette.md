# Command Palette — Global Two-State Surface

Status: Implemented. Hard cutover complete: no legacy code, no fallbacks, no flags.
Scope owner: command palette surface (`apps/web`).
Date: 2026-05-25.
Related hard-cutover spec: `docs/command-palette-global-cutover.md`.

## 1. Problem

Before this redesign, the command palette was one keyboard-first desktop
component (`palette/Palette.tsx`) with a 17-line `@media (pointer: coarse)`
block (`palette/Palette.module.css:183-200`) bolted on for touch. The JS had no
touch path. Consequences on a phone:

- The input autofocuses on open, so the soft keyboard covers ~half the surface
  before the user decides whether to type.
- The surface is `min(92dvh, 100svh)` tall; `dvh` does not shrink for the keyboard,
  so results render behind it. No `visualViewport` handling exists.
- A single rigid layout serves both "I just opened it" and "I typed a query".
- When querying, sections render in a fixed order, so a high-relevance match in a
  low-priority section sits far below a weak match in a high-priority one.
- The querying view duplicates the best match as a separate row — dead weight
  without a keyboard.
- Hover-to-activate, the roving `aria-activedescendant` highlight, arrow keys, and
  per-row shortcut hints are inert or misleading on touch.
- Android hardware-back navigates the page instead of closing the palette
  (the palette pushes no history entry; the shell binds back to `WebView.goBack()`).
- Mobile vs desktop was decided by `@media (pointer: coarse)`, while the rest of
  the app decided it with `useIsMobileViewport()` (≤768px) — two disagreeing
  definitions.

## 2. Target behaviour

The palette stays a single unified command palette — one input that surfaces and
ranks open tabs, recents, search results, create-actions, and navigation together.
It is restructured around **two states**, shared by desktop and mobile:

### Resting state (empty query)

A launchpad. Sectioned, in this fixed order (empty sections omitted):

1. `open-tabs` — "Open tabs".
2. `recent` — "Recent".
3. `recent-folios` — "Recent folios" (Oracle).
4. `create` — "Create".
5. `navigate` — "Go to".
6. `settings` — "Settings".

Within a section, rows are ordered by resting score (frecency + recency); static
create/navigate rows have no score and fall back to declaration order.

### Querying state (non-empty query)

A single flat list, ranked by score descending — no sections, no duplicate
best-match row. The best-scoring command is row 1. Each row carries a short type tag ("Tab", "Recent",
"Action", "Go to", "Folio", or the search result's type). Two affordances are
pinned last, in order: "See all results in Search" (query ≥ 2 chars) and
"Ask AI about '<query>'" (query ≥ 2 chars, no exact title match). Empty query
returns to the resting state. No matches → a "No matches" row plus the pinned rows.

### Platform differences (presentation and input only)

| Aspect | Desktop | Mobile |
|---|---|---|
| Container | Centered card (560px, anchored 16dvh) | Full-screen, top-anchored |
| Selected by | `useIsMobileViewport()` ≤ 768px | `useIsMobileViewport()` ≤ 768px |
| Input autofocus on open | Yes | No |
| Keyboard navigation | Arrow/Home/End/Enter + roving highlight | None — direct tap |
| Per-row shortcut hints | Shown | Hidden |
| Height | `min(720px, 100dvh − space-8)` | `window.visualViewport.height` |
| Dismiss | Esc, backdrop click | Close button, swipe-down, Android back |
| Entrance animation | None (unchanged) | Slide + fade; instant under reduced-motion |

Sourcing, ranking, command model, execution, and accessibility roles are identical
on both platforms.

## 3. Architecture

The seam runs **below the UI**, not down the middle of it. There is no
`DesktopPalette`/`MobilePalette` pair duplicating the input, list, and rows.

```
CommandPalette.tsx                 controller — sourcing, data, ranking call,
  │                                execution, open/close, keybindings.
  │                                Calls useIsMobileViewport(); renders one shell.
  ├── PaletteDesktopShell.tsx       <dialog> centered card; autofocus; keyboard-nav
  │     │                          state; Esc / backdrop dismiss.
  │     └── PaletteBody.tsx ───┐
  └── PaletteMobileShell.tsx   │    <dialog> full-screen; no autofocus; visualViewport
        │                      │    sizing; back-button history entry; swipe-down
        └── PaletteBody.tsx ───┤    dismiss; entrance animation.
                               │
              PaletteBody  ────┘    SHARED. Input + listbox; renders
                └── PaletteRow         the resting groups or the querying list
                                       inline, one PaletteRow per command.
```

**Shared primitive (zero platform conditionals):** the `CommandPalette` controller,
`buildPaletteView`, the `PaletteView` model, `PaletteBody`, `PaletteRow`, and the
combobox/listbox/option accessibility semantics. `PaletteBody` renders the resting
groups and the querying list inline — there are no separate list components.

**Platform implementations (thin):** `PaletteDesktopShell` and `PaletteMobileShell`.
Each owns its container CSS, autofocus, dismiss, animation, and platform behavior —
keyboard-nav state on desktop; `visualViewport` sizing, the back-button history
entry, and swipe-down on mobile. That behavior is inlined into each shell as plain
`useState`/`useEffect`. There are no separate hook files: each piece has exactly
one consumer, so a hook would be indirection without payoff.

**Two shell components, not one with an `isMobile` branch.** The desktop card and
the mobile full-screen surface share almost nothing at the shell level — different
container, CSS, dismiss model, and effects. One component would carry both sets of
effects behind `enabled` guards. Two thin shells around the shared body is the
honest decomposition. This is a small, reasoned deviation from the house
"one component, runtime branch" pattern (`AddContentTray`, `LibraryMembershipPanel`),
which have no platform-specific effects.

**The branch happens exactly once**, in the controller: `useIsMobileViewport()`
picks the shell. No shared component imports it.

## 4. Capability contract

The command palette is a single global surface mounted once
(`AuthenticatedShell`). Its contract:

- **Inputs:** workspace state (panes, active pane, runtime titles); the user's
  query string; palette history + frecency
  boosts; live search results; Oracle readings; keybindings; Android-shell flag.
- **Output:** a `PaletteView` (resting groups or querying results) for rendering,
  and — on selection — exactly one `executeCommand` effect.
- **Invariants:**
  - Empty `query.trim()` ⇒ resting state; non-empty ⇒ querying state.
  - The querying list is relevance-ordered; row 1 is the highest-scoring command.
  - No command appears twice in a view.
  - Selecting a command records one `POST /api/me/palette-selections`, performs
    the target, and closes the palette.
  - Pane-local commands live in pane Options menus, not in the command palette.
  - On mobile the input is never focused programmatically; the soft keyboard
    appears only on user tap.
  - Android-shell-restricted routes (Local Vault) never appear and never execute.
- **Failure modes:** history/search/Oracle fetch failures degrade silently to an
  empty result set for that provider (expected system abnormality, not a defect);
  a failed `executeCommand` surfaces a feedback toast. There is no retry loop.

## 5. API design

### 5.1 Types — `palette/types.ts`

`PaletteCommand` gains one optional field, `pin?: "last"` (pins the command to the
bottom of the querying list, after ranked results). The dead `shortcutActionId`
field is removed. New view model — a discriminated union, `state` is the discriminant:

```ts
export interface PaletteGroup {
  sectionId: string;
  label: string;
  commands: PaletteCommand[];
}

export type PaletteView =
  | { state: "resting"; groups: PaletteGroup[] }
  | { state: "querying"; results: PaletteCommand[] };
```

`PaletteView` is the only view shape exposed from the ranking layer.

### 5.2 View builder — `command-palette/commandRanking.ts`

`buildPaletteView` is a pure function and the only export of the module.

```ts
export function buildPaletteView(input: {
  query: string;
  commands: PaletteCommand[];
  frecencyBoosts: Map<string, number>;
  currentWorkspaceHref: string | null;
}): PaletteView;
```

- Scoring tiers and boosts are **unchanged** (exact/prefix/keyword/subsequence,
  frecency, recency, current-href, danger, disabled).
- Empty query ⇒ `state: "resting"`: score by resting signals, group by
  `sectionId`, order groups by section order, order rows within a group by score
  descending (stable).
- Non-empty query ⇒ `state: "querying"`: one flat list sorted by score
  descending (stable by source index), then `pin: "last"` commands
  stable-partitioned to the bottom. Each command appears at most once.

Section order and labels are module-private constants (`navigate` is labelled
"Go to"). The querying-row type tag is a local function in `PaletteRow`; the
desktop shell flattens a view inline for keyboard navigation. No shared
`sectionFor` / `tagFor` / `flattenView` helpers.

### 5.3 Providers — `command-palette/commandProviders.ts`

`getAskAiPinnedCommand` returns the Ask AI command with
`pin: "last"`. New `getSeeAllInSearchCommand({ query }): PaletteCommand | null` —
returns a `pin: "last"` href command to `/search?q=<query>` when `query.trim()`
is ≥ 2 chars, else `null`.

### 5.4 Component props

`PaletteBody` (shared): `view`, `query`, `searchLoading`, `activeCommandId`
(`string | null`), `showShortcuts`, `autoFocusInput`, `onQueryChange`,
`onSelect`, `onActiveCommandChange?` (omitted by mobile).
`PaletteBody` owns the input and its full keydown: Enter selects the active
command (or the first command in the view when none is active); Arrow/Home/End
move the active command when `onActiveCommandChange` is supplied (desktop only);
IME composition is guarded.

`PaletteRow` (shared): `command`, `selected`, `showTag`, `showShortcut`,
`onSelect`, `onHover?`. Renders icon, title, subtitle, type tag (querying only),
shortcut hint (desktop only), disabled reason. When `selected` becomes true the
row scrolls itself into view.

`PaletteDesktopShell` / `PaletteMobileShell`: `query`, `view`, `searchLoading`,
`onQueryChange`, `onSelect`, `onClose`.
`PaletteDesktopShell` additionally takes `initialActiveCommandId` (mobile has no
keyboard-nav highlight).

### 5.5 Platform behavior (inlined into the shells)

- **Desktop** (`PaletteDesktopShell`): a native `<dialog>` opened with
  `showModal()`, autofocused. Holds `activeCommandId` state, seeded from
  `initialActiveCommandId`; an effect re-points it to the first command when the
  view changes and the active command is no longer present. Esc and backdrop
  click close.
- **Mobile** (`PaletteMobileShell`): a native `<dialog>` opened with
  `showModal()`, full-screen, not autofocused. One effect tracks
  `window.visualViewport.height` (on `resize`/`scroll`) and applies it as the
  dialog's inline height (`100dvh` when `visualViewport` is absent — a guard for
  SSR/tests, not a behavior fallback). One effect pushes a
  `history.pushState` marker on mount and closes on `popstate` (Android/browser
  back), popping the marker on a non-back close. One effect runs swipe-down
  dismissal. A close button is always present.

## 6. Composition with other systems

| System | Touchpoint |
|---|---|
| Workspace store | Reads panes/active pane for `open-tabs`; `activatePane`/`closePane`/`restorePane`. |
| Search | `fetchSearchResultPage` (top 5) in the querying state; "See all results in Search" → `/search?q=`. |
| Palette history API | `GET /api/me/palette-history` (recents + frecency); `POST /api/me/palette-selections` on every selection. Backend unchanged. |
| Oracle | `GET /api/oracle/readings` → `recent-folios`. |
| Pane routing | `resolvePaneRoute`, `requestOpenInAppPane`, `getPaneRouteIcon`. |
| Android shell | `isAndroidShell`, `isAndroidShellRestrictedRouteId` — filter + block Local Vault. |
| `PaneShell` | The mobile header trigger dispatches `OPEN_COMMAND_PALETTE_EVENT`. |
| Keybindings | `open-palette` and static-command hotkeys (desktop keydown listener). |
| `useIsMobileViewport` | Single source of the desktop/mobile decision. |
| Browser history | Mobile only — one pushed entry so Android back closes the palette. |

The palette is the quick layer; `/search` remains the deep layer (full,
filterable, paginated). They are not redundant.

## 7. Rules and invariants

- **Hard cutover.** `palette/Palette.tsx`, `palette/Palette.module.css`, and
  `palette/Palette.test.tsx` are deleted. No feature flag, no compatibility
  shim, no dual code path. `buildPaletteView` returns only `PaletteView`; no
  parallel legacy view shape remains.
- **No `@media (pointer: coarse)`** for layout anywhere in palette CSS. The
  platform decision is `useIsMobileViewport()`, made once.
- **No platform conditional** inside `PaletteBody`, the lists, or `PaletteRow`.
  Sizing and typography are touch-first on both platforms.
- **One owner.** Ranking and sectioning live only in `commandRanking.ts`. The
  controller no longer builds a `sections` array.
- **Touch targets ≥ 44×44px** for every interactive element, both platforms
  (`--size-xl`). The mobile close button exposes a 44px square target.
- **Input font-size ≥ 16px** on both platforms (prevents iOS Safari
  zoom-on-focus; the `--text-base` token is 15px, so the body CSS sets 16px).
- **Mobile input attributes:** `enterKeyHint="search"`, `autoCapitalize="off"`,
  `autoCorrect="off"`, `spellCheck={false}` — set on both platforms (harmless on
  desktop).
- **Exhaustive matching.** `switch` on `PaletteView.state` and on
  `PaletteTarget.kind` use a `never` check (`control-flow.md`).
- **Named timing constants** — debounces extracted (`timing.md`):
  `PALETTE_HISTORY_DEBOUNCE_MS`, `PALETTE_SEARCH_DEBOUNCE_MS`,
  `PALETTE_ORACLE_TTL_MS`.
- **No dead code or dead CSS** in the final state.
- **Accessibility preserved.** Input is `role="combobox"`; results container is
  `role="listbox"` of `role="option"`. `aria-activedescendant` is set on desktop
  only; mobile relies on direct tap (`onClick`), which screen readers activate.

## 8. Final state

After the cutover:

- `CommandPalette.tsx` is a thin controller: it sources commands, computes
  `view` via `buildPaletteView`, owns `open`/`query`, runs the keybinding
  and `OPEN_COMMAND_PALETTE_EVENT` listeners and the URL-param open path, and
  renders exactly one shell chosen by `useIsMobileViewport()`. It no longer owns
  `activeCommandId`, builds no `sections` literal, and passes `?cmd=` through as
  `initialActiveCommandId`.
- The `palette/` directory contains the shared body subtree, the two shells, and
  `types.ts`. No file named `Palette` remains.
- The desktop palette is a centered card with the same dimensions, keyboard
  navigation intact, but: querying shows one ranked list (not fixed sections)
  and each command appears at most once.
- The mobile palette is a full-screen `<dialog>` that opens with the keyboard
  down, resizes to `visualViewport` when the keyboard appears, has ≥44px touch
  targets, a 16px input, an entrance animation, swipe-down and close-button
  dismissal, and closes on Android hardware-back.
- `PaneShell`'s mobile trigger is labelled accurately ("Open command palette").

## 9. Implemented behavior checklist

Resting state:
- Opening with no query shows sections in order:
      Open tabs, Recent, Recent folios, Create, Go to, Settings.
- Empty sections are omitted; no section renders with zero rows.
- Rows within a section are ordered by frecency/recency descending.

Querying state:
- Typing replaces sections with one flat list ranked by score descending.
- The highest-scoring command is row 1; no command appears twice.
- Each row shows a type tag.
- "See all results in Search" and "Ask AI about '<q>'" are the last two rows
      (query ≥ 2 chars; Ask AI suppressed on exact title match).
- Clearing the query restores the resting state.
- No matches → a "No matches" row plus the pinned rows.

Mobile shell:
- `useIsMobileViewport()` (≤768px) selects it; it is full-screen.
- The input is not focused on open; the soft keyboard does not appear until tap.
- With the keyboard open, the input stays visible and the list stays
      scrollable above it (height tracks `visualViewport`).
- Every interactive target is ≥44×44px; the input font-size is ≥16px.
- Entrance animates (slide + fade); instant under `prefers-reduced-motion`.
- Android hardware-back closes the palette and does not navigate the page.
- Close button and swipe-down both dismiss; no shortcut hints render.

Desktop shell:
- Centered card, unchanged dimensions and position.
- Arrow/Home/End move the highlight; Enter runs it; `aria-activedescendant`
      tracks it; the active row scrolls into view.
- Esc closes; backdrop click closes.
- Shortcut hints render on rows that have a keybinding.

Cross-cutting:
- Selecting any command posts `/api/me/palette-selections`, performs the
      target, and closes the palette.
- Local Vault stays filtered/blocked under the Android shell.
- `OPEN_COMMAND_PALETTE_EVENT`, `?palette=1`, `?cmd=`, `?q=` still open it.
- No file named `Palette.tsx`/`Palette.module.css` exists; no
      `@media (pointer: coarse)` remains in palette CSS.

## 10. Test coverage

- `commandRanking.test.ts` — `buildPaletteView`: resting grouping
  and order; querying flat ranking; `pin: "last"` ordering; one result per
  command.
- `commandProviders.test.ts` — `pin: "last"` and `getSeeAllInSearchCommand`
  cases.
- `PaletteBody.test.tsx` — resting vs querying rendering; combobox/listbox
  roles; Enter selects active-or-first; empty state.
- `PaletteDesktopShell.test.tsx` — keyboard nav, Enter select, Esc
  close, autofocus, shortcut hints.
- `PaletteMobileShell.test.tsx` — no autofocus, no shortcut hints, the
  `popstate` close, the close button.
- `CommandPalette.test.tsx` — querying shows a flat list; resting shows sections.
- `androidShell.commandPalette.test.tsx` — Android shell restrictions and
  command-palette entry behavior.
- `e2e/tests/command-palette.spec.ts` — desktop: open → arrow → Enter;
  mobile viewport: open → type → tap → execute.

`visualViewport` resizing and the swipe gesture are not unit-testable under
jsdom; they require manual device verification.

## 11. Implementation record

The cutover landed as one cohesive change; this records the implemented
ownership.

1. **Model.** `palette/types.ts` owns `PaletteView`, `PaletteGroup`, and `pin`.
   `commandRanking.ts` owns `buildPaletteView`. `commandProviders.ts` owns
   `getSeeAllInSearchCommand` and the Ask AI pinned row. Pure, no UI.
2. **Shared body.** `PaletteBody`, `PaletteRow`, and `PaletteBody.module.css`
   render resting groups and the querying list inline.
3. **Desktop shell + cutover.** `PaletteDesktopShell` owns desktop keyboard-nav
   state and card presentation. `CommandPalette.tsx` chooses shells through
   `useIsMobileViewport()`. `Palette.tsx`, `Palette.module.css`, and
   `Palette.test.tsx` are absent.
4. **Mobile shell.** `PaletteMobileShell` owns `visualViewport` sizing, the
   mobile history entry, close-button dismissal, and swipe-down dismissal.
5. **Integration.** `PaneShell` exposes the command-palette trigger label,
   timing constants are named, and the e2e command-palette spec covers desktop
   and mobile flows.

## 12. Scope

**In scope:** the two-state model; the shared body + two shells; `buildPaletteView`;
flat ranked querying; duplicate-row removal; full-screen mobile shell with
keyboard-avoidance, ≥44px targets, 16px input, entrance animation, swipe-down +
Android-back dismissal; the `PaneShell` trigger label; deletion of `Palette.tsx`.

**Non-goals:** redesigning `/search`; a broader discoverability strategy (FAB,
onboarding) beyond the trigger label; changing `ui/Dialog` or other
sheets/modals; changing the scoring/fuzzy algorithm; changing the command
sourcing set (navbar pins are not added); the palette-history backend; desktop
visual redesign beyond the two-state behavior; multi-select or command chaining;
an exit animation (the house pattern animates entrance only).

## 13. Risks

| Risk | Mitigation |
|---|---|
| `visualViewport` behaves differently across iOS Safari / Android WebView | Feature-detect; inline height falls back to `100dvh`; device pass. |
| Android back history dance double-pops or strands an entry | One inlined effect with a guard flag; covered by `PaletteMobileShell.test.tsx`. |
| Swipe-down conflicts with list scroll | Drag-dismiss starts only when the list is scrolled to top; distance threshold; disabled under reduced-motion. |
| Desktop querying changes grouped → flat | Intended and agreed; desktop card and keyboard nav are otherwise unchanged. |
| Regression coverage drifts from the implemented contract | §10 enumerates the current coverage owners. |

## 14. Confirmed decisions

1. **Swipe-down-to-dismiss is part of the mobile shell** — close button and
   Android back remain the primary dismissal affordances.
2. **Both shells are native `<dialog>` + `showModal()`** — focus trap, top layer,
   and background `inert` for free; they differ only in CSS and inlined effects.
3. **"See all results in Search"** is added as a pinned querying row — a small
   composition point with `/search`.
4. Platform behavior is inlined into the two shells; there are no custom hooks
   (each piece has a single consumer).

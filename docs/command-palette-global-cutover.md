# Command Palette Global-Only Cutover

Status: Implemented.
Scope owner: command palette surface, pane chrome action menus, and affected pane bodies in `apps/web`.
Related: `docs/command-palette.md`, `docs/workspace.md`, `docs/workspace-tabs.md`.
Date: 2026-05-25.

## 1. Problem

The command palette currently behaves as a scoped/global hybrid. When it is
opened from an active pane, the controller captures the active pane and the empty
query view becomes a pane-scoped command surface. The first screen can be "In
this <pane>" actions rather than the global command surface.

That model is technically consistent with the current `docs/command-palette.md`
implementation reference, but it is a weak mobile interaction:

- The mobile pane header button is labelled as "Open command palette", but the
  first screen can be pane-specific actions.
- The route back to global commands is a small scope-chip remove button. On
  mobile this reads like an `X` to get out of a nested mode, and in a tabbed
  workspace `X` already carries "close" meaning.
- Pane-specific actions compete with global actions in the one surface whose
  name implies cross-application command search.
- The repo already has a production pane-local action pattern: pane bodies
  publish `ActionMenuOption[]` through `usePaneChromeOverride({ options })`,
  and `PaneShell` renders those options in the pane header dropdown.

The fix is a hard cutover: the command palette becomes global-only, and pane
commands move to pane header options or are deleted when they duplicate an
existing global command.

## 2. Goals

- Make the command palette one global command surface, not a pane-mode surface.
- Make the first screen predictable on desktop and mobile.
- Put pane-local actions in the active pane's Options dropdown.
- Remove the scope chip and all scope-clearing behavior from the palette.
- Delete the pane-scoped command registry and all scope-ranking paths.
- Preserve global palette capabilities: open tabs, recents, search, create
  actions, navigation, settings, Oracle recents, Ask AI, and "See all results".
- Preserve mobile shell fixes from the previous redesign: no autofocus, native
  dialog, `visualViewport` height, close button, swipe-down, Android back, and
  no shortcut hints.
- Keep one owner per capability. A command exists in one primary surface.

## 3. Non-Goals

- Redesigning `/search`.
- Changing the search ranking algorithm beyond removing scope signals.
- Changing palette history persistence or backend API schemas.
- Changing desktop pane strip anatomy, minimize/restore behavior, or tab close
  behavior.
- Adding a mobile pane strip.
- Reworking `ActionMenu`, `SurfaceHeader`, or `PaneShell` as generic component
  redesigns.
- Introducing feature flags, compatibility modes, old/new dual paths, or hidden
  query parameters for scoped palette behavior.
- Creating a generic adapter from `PaletteCommand` to `ActionMenuOption`.

## 4. Target Behaviour

### 4.1 Command Palette

The command palette is global-only. Opening it from any trigger shows the same
global empty-query view:

1. `open-tabs` - "Open tabs"
2. `recent` - "Recent"
3. `recent-folios` - "Recent folios"
4. `create` - "Create"
5. `navigate` - "Go to"
6. `settings` - "Settings"

Empty sections are omitted. There is no `in-this-pane` section.

Typing a query still switches to a single flat ranked list. Global search results
are included when the query is long enough. Pinned affordances remain last:

1. "See all results for `<query>`"
2. "Ask AI about `<query>`"

The palette never renders a scope chip. There is no "Clear scope" button. The
close button closes the palette. `Esc`, backdrop click on desktop, mobile
close, mobile swipe-down, and Android/browser back dismiss the palette.

### 4.2 Pane Header Options

Pane-local commands live in the pane header Options dropdown. The dropdown is
the existing `ActionMenu` rendered by `SurfaceHeader` through `PaneShell`.

The pane menu always keeps `Copy pane link` first. Contextual pane options follow
it, with a separator before the first contextual option. Destructive actions
remain last, separated from non-destructive actions.

Pane-local options are visible wherever the pane header is visible. On mobile
document panes, opening the Options menu continues to hold mobile chrome visible
through the existing `action-menu` lock.

### 4.3 Mobile

Mobile has no special palette mode. The mobile pane header keeps an icon button
for opening the global command palette. Pressing it opens the same global
palette as desktop, rendered through the mobile shell.

The active pane's Options dropdown is the place for actions specific to that
pane. Users do not leave a pane-specific palette mode to find global actions.

### 4.4 Desktop

Desktop keeps keyboard-first palette behavior. `Meta+K` opens the global
palette. Arrow/Home/End/Enter keep their current behavior. Shortcut hints remain
desktop-only.

The desktop pane strip remains the direct place for tab close/minimize/restore
affordances. The command palette can still expose global open-tab switch/close
commands because tabs are workspace-level global state, not pane-local body
commands.

## 5. Final State

After the cutover:

- `CommandPalette.tsx` has no `PaletteScope`, no `captureScope`, no `scope`
  state, no `scopeLabel`, no `inThisPaneLabel`, and no `clearScope`.
- Opening the palette from URL params, global keybinding, or
  `OPEN_COMMAND_PALETTE_EVENT` only sets `query`, `initialActiveCommandId`, and
  `open`.
- `buildPaletteView` accepts no `scopeFilter` and no `inThisPaneLabel`.
- `PaletteBody` accepts no `scopeLabel` and no `onClearScope`.
- `PaletteBody` renders only the input and listbox.
- `PaletteView` remains a two-state discriminated union:
  `resting` groups or `querying` results.
- `RESTING_SECTIONS` starts with `open-tabs`.
- `PaletteCommand` has no `scopeAffinity`.
- `commandsForPaneType` is deleted.
- `PANE_TYPE_LABELS` is deleted unless another non-palette caller exists.
- `SECTION_TAGS` has no `in-this-pane` tag.
- Existing global static commands remain global static commands.
- Active-pane-only palette commands are either moved into pane header Options or
  deleted as duplicates of existing global commands.
- Tests no longer assert scoped palette behavior.
- `docs/command-palette.md` is updated to describe the global-only final state.

## 6. Capability Contract

### 6.1 Command Palette Contract

The command palette is a single global surface mounted once in
`AuthenticatedShell`.

Inputs:

- Workspace state: panes, active pane id, pane visibility, runtime titles.
- Query string.
- Palette history and frecency boosts.
- Live search result rows.
- Recent Oracle reading rows.
- Static global commands.
- Keybindings.
- Android-shell availability restrictions.

Outputs:

- A `PaletteView` for rendering.
- Exactly one command execution effect when a command is selected.
- Exactly one palette-selection history write for selected commands.

Invariants:

- Empty `query.trim()` returns `state: "resting"`.
- Non-empty `query.trim()` returns `state: "querying"`.
- No command appears twice in a view.
- The querying list is relevance ordered, with pinned commands last.
- The palette never captures pane scope.
- The palette never filters by active pane route id.
- The palette never renders a scope chip.
- Android-shell-restricted routes never render and never execute.
- Failed history/search/Oracle providers degrade to empty provider result sets.
- Failed command execution shows feedback.

### 6.2 Pane Options Contract

Pane options are local to one pane instance and are rendered in that pane's
header.

Inputs:

- The pane body route data.
- The pane body's local state and permissions.
- Caller-provided callbacks that the pane can actually execute.
- Shared resource-action factories where the same resource options are used in
  both header and row contexts.

Outputs:

- `ActionMenuOption[]` published through `usePaneChromeOverride({ options })`,
  or route chrome options when the options are static for the route.

Invariants:

- Options only appear when the pane can execute them.
- Destructive actions are last and visually separated.
- Options that open another panel use `restoreFocusOnClose: false` when the
  panel manages focus.
- Header and row menus share a resource-action factory when they expose the
  same resource capability.
- One-off pane controls stay local to the pane body; no speculative shared
  registry is added.

## 7. API Design

### 7.1 Palette Types

`PaletteCommand` remains the global command model:

```ts
export type PaletteTarget =
  | { kind: "href"; href: string; externalShell: boolean }
  | { kind: "action"; actionId: string }
  | { kind: "prefill"; surface: "conversation"; text: string };

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  sectionId: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
  target: PaletteTarget;
  source: "static" | "workspace" | "recent" | "oracle" | "search" | "ai";
  rank: {
    searchScore?: number;
    frecencyBoost?: number;
    recencyBoost?: number;
    scopeBoost?: number;
  };
  shortcutLabel?: string;
  disabled?: { reason: string };
  danger?: boolean;
  pin?: "last";
}
```

`scopeAffinity` is deleted.

`rank.scopeBoost` remains only for global workspace ranking such as boosting the
active open tab. It must not be used to create pane-local command groups.

### 7.2 View Builder

`buildPaletteView` becomes:

```ts
export function buildPaletteView(input: {
  query: string;
  commands: PaletteCommand[];
  frecencyBoosts: Map<string, number>;
  currentWorkspaceHref: string | null;
}): PaletteView;
```

Removed fields:

- `scopeFilter`
- `inThisPaneLabel`

The builder owns only global resting grouping and global querying ranking.

### 7.3 Palette Body

`PaletteBody` becomes:

```ts
interface PaletteBodyProps {
  view: PaletteView;
  query: string;
  searchLoading: boolean;
  activeCommandId: string | null;
  showShortcuts: boolean;
  autoFocusInput: boolean;
  onQueryChange(query: string): void;
  onSelect(command: PaletteCommand): void;
  onActiveCommandChange?(commandId: string): void;
}
```

Removed props:

- `scopeLabel`
- `onClearScope`

### 7.4 Static Command Catalog

`STATIC_COMMANDS` owns only global commands. It keeps:

- Global navigation.
- Global create actions.
- Global settings navigation.

It does not own pane-local commands. Delete `commandsForPaneType`.

### 7.5 Pane Option Factories

Pane-local options use existing `ActionMenuOption` and existing pane-chrome
plumbing:

```ts
usePaneChromeOverride({
  options: paneOptions,
});
```

Shared factories in `apps/web/src/lib/actions/resourceActions.ts` remain for
resource capabilities reused across header and row menus.

Do not introduce a second pane-action registry unless there are at least two
real pane bodies sharing the same option logic and callbacks.

## 8. Pane Command Mapping

Every current pane-scoped palette command must be accounted for.

### 8.1 Media Pane

Current scoped commands:

- `pane-media-open-chat` - "Open chat about this"
- `pane-media-reader-settings` - "Reader settings"

Final state:

- "Chat about this document" stays in `mediaResourceOptions` and the media
  header Options menu.
- "Reader settings" becomes a media header option that opens
  `/settings/reader`.

Files:

- `apps/web/src/lib/actions/resourceActions.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`

### 8.2 Library Pane

Current scoped command:

- `pane-library-add-content` - "Add content"

Final state:

- "Add content" becomes a library pane header option. It invokes the same
  add-content tray event currently used by global create actions.

Files:

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/lib/actions/resourceActions.ts` only if the option is shared
  with another library row/header surface.

### 8.3 Daily Note Pane

Current scoped commands:

- `pane-daily-open-today` - "Open today"
- `pane-daily-open-yesterday` - "Open yesterday"

Final state:

- "Open today" is deleted from pane-scoped command logic. The global "Today's
  note" command already owns that capability.
- "Open yesterday" becomes a daily pane header option.

Files:

- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx`
- `apps/web/src/components/command-palette/staticCommands.ts`

### 8.4 Conversation Panes

Current scoped commands:

- `pane-conversation-quick-note-today` - "Save snippet to today's note"
- `pane-conversation-open-today` - "Open today's note"

Final state:

- "Save snippet to today's note" is deleted from pane-scoped command logic if it
  only opens the generic quick-note tray. The global "Quick note to today"
  command owns that capability.
- "Open today's note" is deleted from pane-scoped command logic. The global
  "Today's note" command owns that capability.
- Conversation-specific destructive or management actions remain in
  `conversationResourceOptions` and pane Options.

Files:

- `apps/web/src/components/command-palette/staticCommands.ts`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/lib/actions/resourceActions.ts`

### 8.5 Page And Note Panes

Current scoped command:

- `pane-note-open-today` - "Open today's note"

Final state:

- "Open today's note" is deleted from pane-scoped command logic. The global
  "Today's note" command owns that capability.

Active-pane commands currently synthesized in `CommandPalette.tsx`:

- `pin-current-page`
- `pin-current-note`

Final state:

- "Pin current page" becomes a page pane header option.
- "Pin current note" becomes a note pane header option.

Files:

- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`
- `apps/web/src/app/(authenticated)/notes/[blockId]/NotePaneBody.tsx`
- `apps/web/src/components/CommandPalette.tsx`

### 8.6 Routes With No Pane Commands

Routes that currently return `[]` from `commandsForPaneType` stay unchanged.
Deleting `commandsForPaneType` must not create placeholder options.

## 9. Architecture

### 9.1 Ownership

`CommandPalette.tsx` is a controller for the global palette. It sources global
commands, computes `PaletteView`, owns open/query state, executes commands, and
records palette selections.

`commandRanking.ts` owns global command ranking and sectioning. It does not know
about pane route ids.

`staticCommands.ts` owns static global command data only.

`PaneShell` owns pane chrome assembly. It prepends `Copy pane link`, applies
contextual separators, and renders `SurfaceHeader`.

Pane bodies own pane-local option callbacks because they own the state and side
effects needed to execute those options.

`resourceActions.ts` owns resource-action option lists only when the same list is
used by multiple surfaces for the same resource capability.

### 9.2 Data Flow

Global palette flow:

```text
open trigger
  -> CommandPalette open/query state
  -> global command sources
  -> buildPaletteView
  -> PaletteDesktopShell or PaletteMobileShell
  -> PaletteBody
  -> executeCommand
  -> palette selection history + target effect
```

Pane option flow:

```text
pane body state
  -> local ActionMenuOption[] or resourceActions factory
  -> usePaneChromeOverride({ options })
  -> PaneShell paneMenuOptions
  -> SurfaceHeader
  -> ActionMenu
  -> pane-owned callback
```

There is no data flow from pane route id to command-palette scoped command
generation.

## 10. Composition With Other Systems

### Workspace Store

The palette still reads workspace panes to build `open-tabs` commands. It can
activate, restore, and close panes through workspace store actions.

The palette does not capture active pane scope. The active pane can still receive
an open route through `requestOpenInAppPane` when a global command targets a
route.

### Workspace Pane Strip

Desktop pane strip behavior is unchanged. It remains a toolbar with direct
activate, minimize/restore, and close affordances. The palette's open-tab rows
are an alternate global launcher surface, not a replacement for the strip.

### Pane Shell And Surface Header

Pane-local actions compose through the existing `options` path. `PaneShell`
continues to prepend `Copy pane link` and to hold mobile chrome visible while the
menu is open.

### Search

Palette query results still use the search adapter and top-five preview. The
full search page remains the deep search surface.

### Palette History API

History endpoints stay unchanged. The frontend stops recording pane-scoped
command ids because those commands no longer exist.

No backend migration is required for old usage rows. Old rows can remain in
storage. They do not render unless the frontend still defines matching command
sources, and this cutover deletes those sources. Do not add frontend fallbacks
for old target keys.

### Oracle

Recent complete Oracle folios remain a global resting section.

### Keybindings

`open-palette` remains global. Static command hotkeys remain global. Pane-next
and pane-previous remain workspace-level keybindings handled by `WorkspaceHost`.

No pane menu option gains a new global keybinding as part of this cutover.

### Android Shell

Android-shell route restrictions remain enforced in command sourcing and command
execution. Local Vault remains filtered/blocked.

Mobile browser back continues to close the palette through the mobile shell's
history marker. It does not clear scope because there is no scope.

### Add Content Tray

Global palette create actions still dispatch add-content events. Library pane
"Add content" also dispatches the tray event from the pane option callback.

## 11. Rules

- Hard cutover only.
- Delete old scoped-palette code in the same change that adds pane options.
- No feature flag.
- No compatibility shim.
- No old/new dual command source.
- No hidden fallback to scoped command behavior.
- No query param, localStorage field, or event payload reintroduces palette
  scope.
- No empty placeholder sections.
- No disabled row kept only to explain removed scoped behavior.
- No duplicate pane action in both palette and pane dropdown.
- No generic abstraction until two real callers need it.
- Tests assert user-visible behavior, not implementation wiring.
- Update docs with the final state in the same PR as implementation.

## 12. Acceptance Criteria

### 12.1 Palette Behaviour

- Opening the command palette from a media pane shows no scope chip.
- Opening the command palette from a library pane shows no scope chip.
- Opening the command palette from a daily note pane shows no scope chip.
- Opening the command palette from a conversation pane shows no scope chip.
- Opening the command palette from a page or note pane shows no scope chip.
- The resting view never includes an "In this ..." section.
- The first visible resting section is "Open tabs" when open tabs exist.
- Clearing/removing scope is impossible because no scope UI exists.
- The mobile top-left/top-header `X` closes the palette.
- Android/browser back closes the mobile palette.
- `Meta+K` toggles the global palette without preserving stale query or scope.
- URL open paths `?palette=1`, `?q=`, and `?cmd=` still work for global commands.
- Querying still renders one flat ranked list.
- Global "See all results" and "Ask AI" pinned rows still appear when eligible.
- Android-shell-restricted routes are not shown or executed.

### 12.2 Pane Options

- Media pane Options includes chat-about-document and Reader settings.
- Library pane Options includes Add content when the pane can execute it.
- Daily pane Options includes Open yesterday.
- Page pane Options includes Pin current page when the current page can be
  pinned.
- Note pane Options includes Pin current note when the current note can be
  pinned.
- Options are not rendered when the pane cannot execute the action.
- Destructive options remain last.
- Opening Options on mobile document panes keeps chrome visible.

### 12.3 Code Shape

- `commandsForPaneType` no longer exists.
- `PANE_TYPE_LABELS` no longer exists unless a non-palette caller remains.
- `PaletteScope` no longer exists.
- `scopeAffinity` no longer exists on `PaletteCommand`.
- `scopeFilter` and `inThisPaneLabel` no longer exist in `buildPaletteView`.
- `scopeLabel` and `onClearScope` no longer exist in `PaletteBody`.
- Tests do not call helper functions that only existed for scope.
- Docs do not describe `in-this-pane` as current behavior after cutover.

## 13. Verification Plan

### Unit Tests

Update and run:

```bash
cd apps/web && bun run test:unit -- \
  src/components/command-palette/commandProviders.test.ts \
  src/components/command-palette/commandRanking.test.ts \
  src/lib/actions/resourceActions.test.ts
```

Expected coverage:

- Resting groups start at `open-tabs`.
- Querying rank/pin behavior is unchanged.
- `scopeAffinity` and scoped filters have no tests because they no longer exist.
- Resource action option ordering remains stable.

### Browser Component Tests

Update and run:

```bash
cd apps/web && bun run test:browser -- \
  src/__tests__/components/CommandPalette.test.tsx \
  src/components/palette/PaletteBody.test.tsx \
  src/components/palette/PaletteDesktopShell.test.tsx \
  src/components/palette/PaletteMobileShell.test.tsx \
  src/__tests__/components/PaneShell.test.tsx \
  src/__tests__/components/ActionMenu.test.tsx \
  src/__tests__/components/SurfaceHeader.test.tsx
```

Expected coverage:

- Command palette opens without scope from active panes.
- No scope chip or clear-scope button renders.
- Mobile close still closes.
- Pane options still render through `PaneShell` and `SurfaceHeader`.
- ActionMenu keyboard behavior is covered if any menu interaction changes.

### E2E Tests

Update and run:

```bash
make test-e2e PLAYWRIGHT_ARGS="tests/command-palette.spec.ts tests/workspace-tabs.spec.ts tests/pane-chrome.spec.ts"
```

Expected coverage:

- Mobile palette opens global-only and can execute global commands.
- Desktop palette opens global-only and can execute global commands.
- Pane chrome options remain usable.
- Workspace tabs remain unaffected.

### Static Gates

Run:

```bash
cd apps/web && bun run typecheck
cd apps/web && bun run lint
```

Run broader gates before merge:

```bash
make check
make test-front-unit
make test-front-browser
```

## 14. Implementation Plan

This is one hard-cutover PR. The phases below are development order, not
separate compatibility stages.

### Phase 1 - Tests First

- Update command-ranking tests to remove `in-this-pane` expectations.
- Update palette body tests to remove scope row expectations.
- Update command palette tests so opening from active panes still shows global
  commands and never shows scoped rows.
- Add pane option tests for any newly added pane menu actions.

### Phase 2 - Palette Model Cut

- Remove scope state and capture logic from `CommandPalette.tsx`.
- Remove `commandsForPaneType` usage.
- Remove active-pane pin commands from `CommandPalette.tsx`.
- Simplify `buildPaletteView` signature and implementation.
- Remove `scopeAffinity` from `PaletteCommand` and all command declarations.
- Remove scope UI from `PaletteBody`.
- Remove `in-this-pane` labels/tags/sections.

### Phase 3 - Pane Options

- Add or verify media pane Options for chat and Reader settings.
- Add library pane Add content option.
- Add daily pane Open yesterday option.
- Add page/note pin options.
- Reuse existing resource option factories where the option is a resource
  capability shared by rows and headers.
- Keep one-off pane actions local to the pane body.

### Phase 4 - Docs

- Rewrite `docs/command-palette.md` to the new global-only implemented
  reference.
- Keep `docs/workspace.md` and `docs/workspace-tabs.md` unchanged unless their
  command-palette references become stale.
- Keep this planned spec or mark it superseded by the implemented reference.

### Phase 5 - Verification

- Run focused tests.
- Run static checks.
- Run relevant E2E tests.
- Manually verify on a narrow mobile viewport that the palette opens global-only
  and the pane Options dropdown owns pane-local actions.

## 15. Key Decisions

1. The command palette is global-only.
2. Pane-local actions live in pane header Options.
3. Open tabs stay in the palette because they are workspace-global.
4. Active-pane pin actions move to page/note pane Options.
5. Duplicates of existing global commands are deleted, not moved.
6. Old palette history rows for removed command ids receive no frontend fallback.
7. No adapter converts `PaletteCommand` into `ActionMenuOption`.
8. No mobile-only branch changes command sourcing. Mobile and desktop differ only
   in shell presentation and input behavior.
9. The docs are updated as part of the implementation cutover.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Users lose discoverability for pane actions | Put actions in the existing pane Options dropdown and cover key panes with tests. |
| Duplicate actions survive in palette and menu | Delete `commandsForPaneType` and remove active-pane command synthesis. |
| Old history rows create confusing recents | Do not render removed command ids; history persistence can retain old rows harmlessly. |
| Scope removal breaks URL `?cmd=` open path | Keep `initialActiveCommandId`; it only targets global command ids. |
| Pane option callbacks require pane-local state | Keep callbacks in pane bodies rather than adding a registry. |
| Mobile menu and chrome interfere | Keep existing `action-menu` visible lock and verify in `pane-chrome` coverage/manual mobile pass. |

## 17. Definition Of Done

- Implementation has no scoped palette code.
- Pane-local actions are reachable from pane Options or intentionally deleted as
  global duplicates.
- Current docs describe the final implemented behavior.
- Focused unit, browser component, and E2E checks pass.
- `git grep` for the deleted concepts returns no live implementation hits:

```bash
rg "commandsForPaneType|PaletteScope|scopeAffinity|scopeFilter|inThisPaneLabel|palette-scope-chip|In this pane" apps/web/src docs
```

Allowed hits after implementation:

- Historical mention in this planned spec if it is kept as a record.
- Test names or docs only if they explicitly describe removed behavior as
  historical, not current.

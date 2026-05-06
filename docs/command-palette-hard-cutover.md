# Command Palette Hard Cutover

## Role

This document is the target-state plan for the Nexus command palette: the
global keyboard-first surface for navigation, workspace switching, creation,
search, recent destinations, recent Oracle folios, and explicit AI handoff.

The implementation is a hard cutover. The final state keeps no feature flag,
no legacy focus-management path, no viewport-width TypeScript branch, no
custom modal wrapper, no `cmdk`, no Vaul, no parallel legacy recents API, no
localStorage ranking fallback, and no backward-compatible command-palette
payload. The old palette is replaced by a typed internal `<Palette>` primitive
and a Nexus-specific `<CommandPalette>` integration wrapper in one branch.

The implementation follows the repository rules in `docs/rules/`, the visual
token direction in `docs/visual-foundation-1a-hard-cutover.md`, and the
platform rules in `docs/black-forest-oracle-vade-mecum.md`: native `<dialog>`
for modal overlays, CSS-first responsive behavior, `100svh`/`100dvh`, hover
styles gated by `(hover: hover) and (pointer: fine)`, and no third-party
palette/sheet/modal dependency.

## Context

The current palette already does useful product work:

- Global open shortcut through `open-palette` in
  `apps/web/src/lib/keybindings.ts`.
- Static navigation, creation, and settings commands in
  `apps/web/src/components/CommandPalette.tsx`.
- Workspace tab switching and minimized-pane restore through
  `useWorkspaceStore`.
- Backend search through `fetchSearchResultPage`.
- Workspace recents through `/api/me/command-palette-recents`.
- Oracle entry and recent folios through `/api/oracle/readings`.
- Mobile opener through `OPEN_COMMAND_PALETTE_EVENT` from the workspace shell.

The current implementation also has target-state gaps:

- Desktop and mobile overlays are hand-rolled `div`/`section` dialogs instead
  of native `<dialog>`.
- Mobile behavior depends on `useIsMobileViewport` and a custom focus trap.
- Arrow navigation moves DOM focus into result buttons instead of keeping
  focus on the input and exposing active result state through
  `aria-activedescendant`.
- Result rows can contain nested interactive controls, which prevents a clean
  listbox/option accessibility model.
- Static actions, runtime actions, filtering, ranking, rendering, recents,
  Oracle folios, keyboard handling, and overlay behavior live in one large
  component.
- Recents are destination-only and cannot support query-aware frecency.
- The existing `/me/command-palette-recents` contract is too narrow for
  future ranking, query history, and typed command targets.

## Goals

1. Keep a first-party `<Palette>` abstraction owned by this repo.
2. Make `CommandPalette` a thin Nexus integration layer that supplies command
   providers, ranking signals, and execution handlers.
3. Use one native `<dialog>` modal for desktop and mobile, with responsive CSS
   selecting centered panel or bottom-sheet presentation.
4. Implement APG-grade searchable command semantics: input focus stays on the
   search field, arrow keys update an active option, and the input owns
   `aria-activedescendant`.
5. Remove nested interactive controls from result options. Every row is one
   selectable command. Secondary operations such as "close tab" become their
   own commands.
6. Replace the legacy recents table/API with command-palette usage history
   that supports query-aware frecency.
7. Add deterministic ranking with exact, prefix, fuzzy, scope, search, recent,
   and frecency signals.
8. Add a "Top result" section when a query exists, so section grouping never
   hides the best command.
9. Add explicit "Ask AI" fallback only as a user-selected command, never as an
   automatic execution path.
10. Add deep-linkable palette state for opening, prefilled query, and selected
    command, with user activation required before any command executes.
11. Token-sweep palette styling and remove legacy command-palette CSS tokens,
    hardcoded colors, hardcoded radii, custom viewport-height hacks, and
    ungated hover states.
12. Preserve current product capabilities: Oracle navigation, recent folios,
    workspace tabs, search results, recents, create commands, settings
    commands, configurable keybindings, and mobile search trigger.

## Non-Goals

- Do not add `cmdk`, Vaul, React Aria, Radix Dialog, Headless UI, Downshift,
  Ariakit, Fuse, fuzzysort, match-sorter, or any other runtime dependency.
- Do not redesign global navigation outside the command-palette entry points.
- Do not change the global search backend beyond the request/response shape
  needed to consume search rows inside palette ranking.
- Do not introduce natural-language command execution.
- Do not auto-send AI prompts from the palette.
- Do not support old command-palette recents endpoints or old event payloads.
- Do not migrate every overlay in the app. This cutover owns only the command
  palette.
- Do not keep the existing pane-row close button inside palette results.
  Closing a pane is represented as a separate command.
- Do not add mobile-only command inventory. The same command model powers all
  viewports.

## Final State

`apps/web/src/components/CommandPalette.tsx` remains the authenticated app's
mounted global component, but it no longer owns rendering, focus management,
dialog behavior, or ranking internals. It composes command providers and
passes normalized `PaletteCommand` objects into `components/palette/Palette`.

`Palette` is a pure UI primitive:

- It renders a native `<dialog>`.
- It renders one search input and one result collection.
- It owns active-result state, keyboard behavior, and ARIA attributes.
- It does not import workspace, search, Oracle, notes, panes, keybindings,
  or API code.
- It exposes typed callbacks for query change, command selection, open change,
  and active command change.

`CommandPalette` is a product integration wrapper:

- It listens for keybindings and external open events.
- It resolves static commands, workspace commands, recents, recent folios,
  backend search rows, and AI fallback into one command list.
- It records command selection through the new usage-history API before
  executing a command.
- It handles command execution by calling existing app APIs and navigation
  helpers.

Palette history is backend-owned:

- Existing runtime references to `command_palette_recents` are removed.
- A new table stores query-normalized, target-normalized usage records.
- The service exposes recent destinations and query-aware frecency boosts.
- The frontend does not write ranking data to localStorage.

## Target Behavior

### Opening

1. `Cmd+K` on macOS and `Ctrl+K` elsewhere open the palette through the
   configurable `open-palette` binding.
2. The workspace shell search button dispatches the same open event on all
   viewports.
3. `?palette=1` opens the palette after hydration.
4. `?palette=1&q=library` opens the palette with a prefilled query.
5. `?cmd=nav-oracle` opens the palette with the matching command selected.
   The command does not execute until the user presses Enter or clicks/taps
   the row.
6. Opening the palette clears stale active-result state. It preserves the
   query only when opened by a URL parameter that explicitly supplies query
   state.

### Closing

1. `Escape`, native dialog cancel, backdrop click, and a close button close
   the palette.
2. Executing a command closes the palette before navigation or mutation.
3. Closing restores focus to the element that opened the palette when that
   element is still connected.
4. Closing does not clear backend usage history or cached provider results.

### Input and Keyboard

1. Focus stays on the input while arrowing through results.
2. `ArrowDown` and `ArrowUp` move active result state.
3. `Home` and `End` move to the first and last selectable result.
4. `Enter` executes the active result.
5. `Escape` closes the dialog.
6. `Tab` follows native modal-dialog behavior. It does not move through every
   result row.
7. Browser text-editing shortcuts are preserved. JavaScript does not intercept
   platform text editing keys.
8. IME composition cannot execute a command by accident.

### Result Inventory

No query:

1. Open tabs
2. Recent
3. Recent folios
4. Create
5. Navigate
6. Settings

With query:

1. Top result
2. Search results
3. Open tabs
4. Recent
5. Recent folios
6. Create
7. Navigate
8. Settings
9. Ask AI

The "Top result" command is the highest-ranked selectable command across all
sections and is removed from its original section to avoid duplication.

The "Ask AI" command appears only when:

- The trimmed query has at least two characters.
- There is no exact local command label match.
- The user has permission to create or open a conversation.

Selecting "Ask AI" opens a new conversation composer with the palette query
prefilled. It does not submit the message automatically.

### Command Execution

Every command has exactly one execution mode:

- `navigate`: opens a route through `requestOpenInAppPane` or
  `window.location.assign` when the destination is outside the workspace
  shell.
- `mutate`: calls a typed action such as creating a page or pinning an object.
- `dispatch`: dispatches an existing app event such as opening the add-content
  tray.
- `prefill`: opens another surface with user-controlled draft text.

Commands that require mutation are never auto-executed from URL state.

### Mobile

The same native dialog and command list render on mobile. CSS presents the
dialog as a bottom sheet or full-height sheet on coarse-pointer devices.

- No `useIsMobileViewport` branch in palette code.
- No custom focus trap.
- No custom body scroll lock.
- Touch targets are at least 44 x 44 CSS px.
- The sheet uses `max-height: min(100dvh, ...)` and safe-area padding.
- Hover styles are scoped inside `(hover: hover) and (pointer: fine)`.

## Architecture

### Component Boundary

```
CommandPalette
  - owns Nexus command providers
  - owns keybinding and external-open integration
  - owns command execution
  - owns API calls
  - owns usage-history recording
  - passes normalized commands to:

Palette
  - owns native dialog
  - owns input/list semantics
  - owns active option and keyboard behavior
  - owns presentational sections
  - no Nexus domain imports
```

### Public Palette API

```ts
export interface PaletteSection {
  id: string;
  label: string;
  order: number;
}

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  sectionId: string;
  icon: LucideIcon;
  target: PaletteTarget;
  disabled?: PaletteDisabledReason;
  shortcutActionId?: string;
  danger?: boolean;
  source: "static" | "workspace" | "recent" | "oracle" | "search" | "ai";
  rank: PaletteRankSignals;
}

export type PaletteTarget =
  | { kind: "href"; href: string; externalShell: boolean }
  | { kind: "action"; actionId: string }
  | { kind: "prefill"; surface: "conversation"; text: string };

export interface PaletteProps {
  open: boolean;
  query: string;
  sections: PaletteSection[];
  commands: PaletteCommand[];
  activeCommandId: string | null;
  loadingSectionIds: string[];
  onOpenChange(open: boolean): void;
  onQueryChange(query: string): void;
  onActiveCommandChange(commandId: string | null): void;
  onSelect(command: PaletteCommand): void;
}
```

`Palette` accepts fully ranked commands. It does not score, fetch, or mutate.

### ARIA Contract

The modal wrapper is a native dialog:

```tsx
<dialog aria-labelledby="palette-title">
  <h2 id="palette-title">Command palette</h2>
  <input
    role="combobox"
    aria-label="Search commands"
    aria-expanded="true"
    aria-controls="palette-listbox"
    aria-autocomplete="list"
    aria-activedescendant={activeOptionId}
  />
  <div id="palette-listbox" role="listbox">
    <div role="group" aria-labelledby="palette-section-navigate">
      <div role="option" aria-selected="true" id="palette-option-nav-oracle" />
    </div>
  </div>
</dialog>
```

Rules:

- `aria-activedescendant` always points at a mounted option or is omitted.
- Result ids are stable for the current render and derived from command ids.
- Options expose one accessible name containing title, section, subtitle, and
  shortcut when present.
- Icons are `aria-hidden`.
- Section headings label option groups.
- Empty state uses `role="status"` when loading has completed.
- Loading state uses `aria-busy` on the listbox and visible text in the
  affected section.
- There are no nested buttons, links, inputs, or menus inside options.

### Native Dialog Rules

- The dialog is controlled through `HTMLDialogElement.showModal()` and
  `HTMLDialogElement.close()`.
- React open state and the native `open` attribute are reconciled in one
  small hook local to `Palette`.
- The dialog handles `cancel` and `close` events.
- Backdrop click closes only when the click target is the dialog element.
- Focus restore uses the browser's modal behavior plus an opener ref.
- The CSS uses `::backdrop`; no separate backdrop element survives.

### Command Providers

Each provider returns `PaletteCommand[]` and never renders UI.

- `staticCommandProvider`: Navigate, Create, Settings.
- `workspaceCommandProvider`: switch, restore, close, and pin commands derived
  from workspace panes and active route.
- `recentDestinationProvider`: target-centric recents from usage history.
- `recentOracleProvider`: top five complete Oracle folios from
  `/api/oracle/readings`.
- `searchResultProvider`: backend search rows from `fetchSearchResultPage`.
- `askAiProvider`: explicit AI fallback command.

Provider rules:

- Providers are deterministic for the same inputs.
- Providers can be async only at the integration layer.
- Providers return typed disabled commands instead of dropping commands when a
  user should understand why an action is unavailable.
- Permission-hidden commands are omitted.
- Permission-disabled commands are visible only when seeing the command itself
  is not sensitive.

### Ranking

Ranking is a pure TypeScript function in the command-palette integration
module. It takes:

- normalized query
- provider commands
- backend frecency boosts
- current workspace context

It returns commands in display order plus the selected top result.

Signals:

1. Exact title match.
2. Prefix title match.
3. Word-start match.
4. Alias/keyword match.
5. Ordered fuzzy acronym/subsequence match.
6. Workspace scope boost.
7. Search backend score for search rows.
8. Query-aware frecency boost.
9. Destination recency boost.
10. Disabled and danger demotions.

Frecency uses the Slack-style bucket relationship:

- last 4 hours: 100
- last 24 hours: 80
- last 3 days: 60
- last 7 days: 40
- last 30 days: 20
- last 90 days: 10
- older: 0

The formula is:

```text
frecency = total_count * bucket_points_sum / min(visit_count, 10)
```

Query-specific usage receives full weight. Target-only usage receives reduced
weight so a frequently opened destination rises for related queries without
overriding a stronger exact query history.

### Backend Usage History

The hard cutover replaces the old recents model with query-aware usage.

Runtime model:

```text
command_palette_usages
  id uuid pk
  user_id uuid not null
  query_normalized text not null
  target_key text not null
  target_kind text not null
  target_href text null
  title_snapshot text not null
  source text not null
  use_count integer not null
  visit_timestamps jsonb not null
  last_used_at timestamptz not null
  created_at timestamptz not null
  updated_at timestamptz not null

unique(user_id, query_normalized, target_key)
index(user_id, last_used_at desc, id desc)
index(user_id, query_normalized, last_used_at desc)
```

The historical Alembic migration that created `command_palette_recents` stays
in migration history. Runtime code does not import or model that table. A new
migration drops `command_palette_recents` and creates
`command_palette_usages`.

FastAPI routes:

- `GET /me/palette-history?query=...`
  - returns recent destination commands and per-target frecency boosts for the
    normalized query.
- `POST /me/palette-selections`
  - records one successful user selection after the command has been accepted
    by the frontend.

Next.js BFF routes:

- `apps/web/src/app/api/me/palette-history/route.ts`
- `apps/web/src/app/api/me/palette-selections/route.ts`

Removed routes:

- `apps/web/src/app/api/me/command-palette-recents/route.ts`
- FastAPI `/me/command-palette-recents`

Service rules:

- Canonicalization rejects absolute URLs and unsupported internal routes.
- `query_normalized` is lowercased, trimmed, whitespace-collapsed, and capped.
- `visit_timestamps` stores at most the ten most recent visits.
- Titles are snapshots, capped, and never trusted as route authority.
- Service functions accept `db` and `viewer_id` explicitly.
- Routes shape responses; services own canonicalization and ranking data.

### Search

- Query length threshold remains two non-whitespace characters.
- Fetches use `AbortController`.
- The debounce interval is 200 ms.
- Newer requests always win over older requests.
- Search rows become `PaletteCommand` objects with `source: "search"`.
- Search result execution opens the result href through `requestOpenInAppPane`.
- Search result labels and hrefs are recorded in usage history only after the
  user selects a result.

### Deep Links

Supported query params:

- `palette=1`
- `q=<query>`
- `cmd=<command-id>`

Rules:

- Deep links open or prefill the palette.
- Deep links never execute commands automatically.
- Mutating commands require a user-generated Enter/click/tap.
- Unknown command ids open the palette with the query unchanged and no active
  command.
- Consumed params are removed from the URL with `router.replace` after open so
  reload does not repeat the open action.

### AI Fallback

The AI fallback is a command, not a mode.

- Title: `Ask AI about "{query}"`
- Section: `Ask AI`
- Source: `ai`
- Target: `{ kind: "prefill", surface: "conversation", text: query }`
- Execution opens `/conversations/new` with the composer prefilled.
- The composer does not send the prompt until the user submits.
- The command records usage with `source: "ai"` after selection.

## File Plan

### Frontend Additions

```
apps/web/src/components/palette/
  Palette.tsx
  Palette.module.css
  types.ts
  useNativeDialog.ts
  usePaletteKeyboard.ts
  getPaletteOptionId.ts

apps/web/src/components/command-palette/
  commandRegistry.ts
  commandProviders.ts
  commandRanking.ts
  commandExecution.ts
  commandHistory.ts
  commandDeepLinks.ts
  commandTypes.ts
```

### Frontend Replacements

```
apps/web/src/components/CommandPalette.tsx
apps/web/src/components/CommandPalette.module.css
apps/web/src/components/commandPaletteEvents.ts
apps/web/src/components/workspace/PaneShell.tsx
apps/web/src/lib/keybindings.ts
apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx
```

### Frontend Removed

```
apps/web/src/app/api/me/command-palette-recents/route.ts
```

If `useIsMobileViewport` and `useFocusTrap` become unused after the cutover,
remove them and their tests in the same branch. If another component still
uses them, they stay, but command-palette code must not import them.

### Backend Replacements

```
python/nexus/services/command_palette.py
python/nexus/schemas/command_palette.py
python/nexus/api/routes/me.py
python/nexus/db/models.py
```

### Backend Additions

```
migrations/alembic/versions/<next>_command_palette_usage_history.py
python/tests/test_command_palette_usage_integration.py
```

### Tests

```
apps/web/src/__tests__/components/CommandPalette.test.tsx
apps/web/src/components/palette/Palette.test.tsx
apps/web/src/components/command-palette/commandRanking.test.ts
apps/web/src/components/command-palette/commandProviders.test.ts
e2e/command-palette.spec.ts
python/tests/test_command_palette_usage_integration.py
```

The duplicate legacy component test file under
`apps/web/src/components/CommandPalette.test.tsx` is removed or merged into
the browser/component test location in the same cutover.

## Key Decisions

1. **First-party primitive over third-party dependency.** React Aria is the
   best generic external implementation path, but this repo has explicit no
   new runtime dependency and no third-party overlay rules for this surface.
   The cutover implements the APG contract directly.
2. **Native dialog over custom overlay.** The browser owns modal top-layer
   behavior, inert background, Esc, backdrop, and focus containment.
3. **CSS presentation over TypeScript viewport branching.** Pointer and
   viewport differences are CSS concerns unless command inventory changes,
   which it does not.
4. **No nested result controls.** A row is a command. Secondary row actions
   are commands.
5. **Backend usage history over local recents.** Frecency needs durable,
   query-aware history scoped to the authenticated user.
6. **Deep links open, not execute.** URL state can guide the palette but
   cannot trigger mutations.
7. **AI is an explicit fallback command.** It is opt-in and prefill-only.

## Hard Rules

1. No `cmdk`, Vaul, React Aria, Radix Dialog, Headless UI, Downshift, Ariakit,
   Fuse, fuzzysort, or match-sorter dependency is added.
2. No command-palette runtime import of `useIsMobileViewport`.
3. No command-palette runtime import of `useFocusTrap`.
4. No `role="dialog"` on a `div`/`section` inside command-palette code.
   The modal element is `<dialog>`.
5. No command-palette code moves DOM focus into result rows for arrow-key
   navigation.
6. No interactive descendants inside `role="option"` rows.
7. No `/api/me/command-palette-recents` runtime route or client call remains.
8. No `CommandPaletteRecent` runtime model remains.
9. No command-palette localStorage usage for recents, ranking, or frecency.
10. No palette-specific hardcoded colors in CSS modules.
11. No palette-specific `100vh`; use `100svh` or `100dvh`.
12. No ungated hover styles. Hover-only styles live under
    `(hover: hover) and (pointer: fine)`.
13. No mobile-only command list. Mobile and desktop share command providers.
14. No auto-execution from deep links.
15. No broad `catch` that silently hides command execution failure. Execution
    failures route through the feedback layer.

## Implementation Sequence

This is one hard-cutover branch, but the work lands in this order to keep
verification clean.

1. Write failing tests for `Palette` dialog semantics, keyboard behavior,
   `aria-activedescendant`, no nested controls, and native close behavior.
2. Write failing tests for ranking: exact, prefix, fuzzy, search score,
   frecency, top result, disabled demotion, and no duplicate top result.
3. Write backend integration tests for usage recording, canonicalization,
   capped timestamp history, recents, and frecency boosts.
4. Add the new backend table, schemas, service, and routes. Remove old recents
   runtime model/routes.
5. Add the first-party `Palette` primitive and CSS.
6. Split `CommandPalette` into command providers, ranking, execution, history,
   and deep-link modules.
7. Rebuild static, workspace, recent, Oracle, search, settings, create, and AI
   commands on the new `PaletteCommand` contract.
8. Token-sweep `CommandPalette.module.css` or move final styles wholly into
   `components/palette/Palette.module.css`.
9. Remove legacy focus movement, focus trap, viewport branch, nested pane close
   button, and old recents code.
10. Add Playwright E2E coverage for keyboard open, search result selection,
    recent folio navigation, mobile trigger, and deep-link open.
11. Run static analysis and focused tests.

## Acceptance Criteria

### Behavior

- `Cmd+K`/`Ctrl+K` opens the palette.
- The workspace search icon opens the same palette.
- `Escape` closes the palette.
- Backdrop click closes the palette.
- The input is focused on open.
- Arrow keys change the active option without moving DOM focus out of the
  input.
- Enter executes the active option.
- Oracle appears under Navigate.
- Recent Oracle folios appear under Recent folios.
- Workspace pane switch, restore, close, and pin commands work.
- Create commands work.
- Settings commands work.
- Search results appear for two-character queries and open their target.
- "Top result" appears for non-empty queries and is not duplicated.
- "Ask AI" appears only when its eligibility rules pass and opens a prefilled
  conversation without submitting it.
- Deep links open/prefill/select but never execute commands.
- Usage history is recorded only after user selection.

### Accessibility

- The modal element is native `<dialog>`.
- The search input has `role="combobox"`, `aria-expanded`, `aria-controls`,
  `aria-autocomplete`, and valid `aria-activedescendant`.
- Results are exposed as `role="listbox"` and `role="option"`.
- Active option has `aria-selected="true"`.
- Section groups are labeled.
- No option contains an interactive descendant.
- Loading and empty states are announced appropriately.
- IME composition cannot execute a command.
- Browser text editing shortcuts keep working.
- Touch targets are at least 44 x 44 CSS px.

### Styling

- Desktop presentation is a centered native dialog panel.
- Coarse-pointer presentation is a bottom/full-height sheet using the same
  dialog element.
- The CSS uses `::backdrop`.
- The CSS uses `100svh`/`100dvh`, not `100vh`.
- Hover styles are gated by `(hover: hover) and (pointer: fine)`.
- Palette CSS uses semantic tokens from the visual foundation.
- Text truncates without layout shift.
- Reduced motion collapses animations through the global motion rule.

### Backend

- `command_palette_usages` exists and is used by runtime code.
- `command_palette_recents` has no runtime model, schema, service, or route.
- Usage history rejects unsupported routes and absolute URLs.
- Usage history caps timestamps at ten per query/target row.
- Recent destination output is deduped by target.
- Frecency boosts are query-aware and user-scoped.
- BFF routes only proxy; business logic stays in FastAPI services.

### Removal Checks

These commands must return no command-palette runtime hits after the cutover:

```sh
rg "cmdk|vaul" apps/web/src package.json
rg "useIsMobileViewport|useFocusTrap" apps/web/src/components/CommandPalette.tsx apps/web/src/components/palette apps/web/src/components/command-palette
rg "command-palette-recents|CommandPaletteRecent" apps/web/src python/nexus
rg "role=\"dialog\"" apps/web/src/components/CommandPalette.tsx apps/web/src/components/palette
rg "100vh" apps/web/src/components/CommandPalette.module.css apps/web/src/components/palette
```

The `role="dialog"` check is intentionally scoped to command-palette runtime
files. Other app overlays are outside this cutover.

### Test Gates

Focused gates:

```sh
bun test apps/web/src/components/palette/Palette.test.tsx
bun test apps/web/src/components/command-palette/commandRanking.test.ts
bun test apps/web/src/__tests__/components/CommandPalette.test.tsx
uv run pytest python/tests/test_command_palette_usage_integration.py
```

Final gates:

```sh
make check
make test-unit
make test-e2e
```

If `make test-e2e` is too broad for the branch while iterating, the focused
Playwright command-palette spec must pass before final verification.

## Completion Definition

The cutover is complete when the app has one command-palette implementation:
`CommandPalette` as Nexus integration and `Palette` as the first-party
primitive. The implementation uses native dialog, APG input/listbox semantics,
typed commands, backend usage history, deterministic ranking, tokenized CSS,
CSS-only responsive presentation, deep-link open state, and explicit AI
fallback. The old recents API/model, custom dialog/focus-trap path, viewport
branch, DOM-focus result navigation, nested row controls, and legacy tests are
gone.

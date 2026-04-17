# mobile command palette

this brief defines the target behavior for the mobile command palette trigger
and palette copy.

it builds on:

- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)
- [docs/mobile-selection-popover.md](./mobile-selection-popover.md)

## goal

make the mobile command palette easy to discover and semantically honest.

the trigger must communicate that it opens a mixed launcher for pane switching,
navigation, creation, settings, and search-backed results.

## scope

this change covers:

- the mobile trigger shown in the pane header
- the mobile-visible label and accessibility name for that trigger
- the command palette title and input copy

this change does not cover:

- desktop trigger behavior
- the `/search` route behavior or search result model
- workspace routing architecture
- a new mobile pane switcher, overflow menu, or bottom navigation system

## product decision

mobile keeps one global command palette.

mobile does **not** ship separate launchers for commands, panes, and search.

the mobile trigger uses visible text: `Commands`.

the trigger may include an icon, but text is required.

the trigger does **not** rely on a lone magnifying-glass icon.

the palette remains a mixed command-and-search surface, not a search-first
screen.

## implementation rules

- keep the existing `CommandPalette` capability and `OPEN_COMMAND_PALETTE_EVENT`.
- keep the mobile branch local to the existing `PaneShell` header action path.
- keep the control flow local and linear in `PaneShell` and `CommandPalette`.
- do not add a second mobile launcher surface.
- do not add a generic trigger registry, action manifest, shared header-button
  abstraction, or new intermediate model for this change.
- keep trigger semantics, accessibility copy, sheet title, and input copy
  aligned.
- reserve the `Search` icon for actual search affordances such as the `/search`
  route and explicit search actions.
- if the trigger keeps an icon, the icon must support generic launcher or pane
  semantics, not search-only semantics.
- keep the trigger compact enough for the mobile header without introducing a
  second toolbar row.
- keep desktop behavior materially unchanged.

## implementation plan

1. update the mobile trigger in `apps/web/src/components/workspace/PaneShell.tsx`
   so the button shows visible `Commands` text and still dispatches
   `OPEN_COMMAND_PALETTE_EVENT`.
2. update `apps/web/src/components/workspace/PaneShell.module.css` so the
   mobile trigger remains compact and readable with text in the header.
3. update `apps/web/src/components/CommandPalette.tsx` placeholder copy to
   `Search or run a command...`.
4. keep the existing palette title `Commands`, dialog labeling, event wiring,
   and mixed command-and-search behavior.
5. add or update focused frontend tests around the mobile trigger, palette
   copy, desktop search semantics, and keybindings copy.

## copy rules

- mobile trigger visible label: `Commands`
- mobile trigger `aria-label`: `Commands`
- mobile palette title: `Commands`
- mobile palette input placeholder: `Search or run a command...`
- settings label stays `Open command palette`

## cases to cover

- mobile header on a non-search pane
- mobile header on the `/search` pane
- workspace with one pane
- workspace with multiple panes
- initial open with no query
- query that matches static commands only
- query that returns backend search results
- trigger with icon present
- trigger with no icon fallback, if styling removes the icon at narrow widths

## acceptance criteria

- on mobile, the pane header shows one visible `Commands` trigger.
- on mobile, the trigger meaning does not depend on icon recognition alone.
- on mobile, tapping the trigger opens the existing global command palette.
- on mobile, the opened surface is still titled `Commands`.
- on mobile, the input copy makes the mixed surface explicit: search plus
  commands.
- on mobile, there is no icon-only magnifying-glass trigger for the command
  palette.
- the `/search` route and explicit search affordances continue to use search
  semantics.
- desktop keyboard access and desktop overlay behavior remain materially
  unchanged.
- the implementation stays local to the existing `PaneShell` and
  `CommandPalette` path and does not introduce a new launcher subsystem.

## regression coverage

required frontend coverage includes:

- browser component test: mobile pane header renders a visible `Commands`
  trigger
- browser component test: tapping `Commands` opens the dialog labeled
  `Command palette`
- browser component test: mobile palette title is `Commands`
- browser component test: mobile palette placeholder is `Search or run a
  command...`
- component test: desktop nav still exposes `Search` for the `/search` route
- component test: keybindings settings still show `Open command palette`

## validation commands

```bash
cd apps/web && bun run test:browser
make verify
```

# Mobile Command Palette

## Scope

This document owns the mobile pane-chrome launcher and the palette copy it
opens.

This document does not own desktop workspace chrome, general accessibility
rules, or testing policy. Those stay in the repo rule docs.

## Launcher Contract

- Mobile pane chrome shows an icon-only `Search` button.
- The mobile launcher does not render a visible `Commands` label.
- The mobile launcher uses the existing
  `OPEN_COMMAND_PALETTE_EVENT` event to open the palette.
- The mobile launcher exposes the accessible name `Search`.
- The mobile launcher remains a compact square button that fits alongside
  other mobile pane actions.

## Palette Contract

- The mobile launcher opens the existing command palette surface.
- The mobile palette is framed as `Search`.
- The mobile dialog exposes the accessible name `Search`.
- The mobile sheet shows the visible heading `Search`.
- The shared palette input uses the placeholder
  `Search or run an action...`.
- The palette still shows the existing sections and actions:
  `Recent`, `Panes`, `Create`, `Navigate`, `Settings`, and
  `Search Results`.

## Out Of Scope

- Desktop keyboard shortcut behavior
- Desktop overlay layout
- Search backend behavior
- Action grouping and execution logic

## Validation

- Cover the launcher and sheet copy in frontend component tests.
- Assert behavior through roles, accessible names, and visible copy.
- Do not add feature-specific test rules here. Repo-wide testing rules stay in
  `docs/rules/testing_standards.md`.

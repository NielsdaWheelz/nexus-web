# Mobile Command Palette

## Role

This document owns the mobile command palette product behavior.

## Trigger

- The mobile `Search` trigger opens the `Search` dialog.
- The trigger does not open a route, pane, or legacy overlay.

## Default Content

- The default mobile dialog shows `Open tabs` before `Recent`.
- `Open tabs` lists currently open workspace tabs.
- `Recent` lists command palette recents after removing destinations already present in `Open tabs`.
- Recents are deduped by destination, not by title.

## Query Content

- A non-empty query promotes `Search results` above default navigation and action groups.
- Search results use the backend search surface, not a mobile-only search implementation.
- Default sections may remain visible after search results, but they do not outrank matching search results.

## Cutover

- The mobile command palette has no legacy compatibility mode.
- Removed mobile command palette behavior must not remain behind viewport checks, feature flags, or fallback events.

## Ownership

This file owns only the mobile command palette behavior. Shared command palette data modeling, workspace pane rules, and repository-wide UI rules belong in their narrower owner docs.

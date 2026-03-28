# UI Item Action Menus — UI-First PR Brief / Spec / Plan

## Goal

Add consistent dropdown action menus to item rows and item title bars across the existing UI, using the current shared menu primitives and only the actions that already exist or can be wired with existing endpoints.

This PR is UI-first.

It does not add a new backend media delete service.

It should leave the codebase more uniform, easier to scan, and easier to extend later when true media delete is implemented.

## Scope

In scope:

- Add row-level dropdown menus anywhere an item row does not already have one and there are meaningful actions to show.
- Add header/title-bar dropdown menus anywhere an item detail pane/page does not already have one and there are meaningful actions to show.
- Replace lone destructive or secondary buttons with dropdown menus where that makes the UI cleaner.
- Reuse existing actions wherever they already exist in the page.
- Use existing shared primitives.
- Add minimal helper code if needed to support default-library membership checks and row/header option building.

Out of scope:

- True permanent media delete.
- Any new FastAPI media delete route or service.
- Any new nested menu or submenu system.
- Any generic action registry, action DSL, or metadata-driven menu framework.
- Any large visual redesign of rows or headers.
- Any change to pane routing or workspace title runtime behavior.

## Current Codebase State

### Shared primitives that already exist

- `apps/web/src/components/ui/ActionMenu.tsx`
  - Single shared ellipsis dropdown.
  - Current option shape is already enough: `id`, `label`, `onSelect`, `href`, `disabled`, `tone`.
- `apps/web/src/components/ui/SurfaceHeader.tsx`
  - Shared header chrome for both panes and full-page layouts.
  - Already accepts `options`.
- `apps/web/src/components/Pane.tsx`
  - Item detail pane shell.
  - Already passes `options` into `SurfaceHeader`.
- `apps/web/src/components/ui/PageLayout.tsx`
  - Full-page layout shell.
  - Already passes `options` into `SurfaceHeader`.
- `apps/web/src/components/ui/AppList.tsx`
  - Shared list row wrapper.
  - Already supports both `actions` and `options`.
- `apps/web/src/components/ui/ContextRow.tsx`
  - Lower-level row primitive for custom layouts.

### Surfaces that already use row menus

- `apps/web/src/app/(authenticated)/libraries/page.tsx`
  - Library list rows already use menus.
- `apps/web/src/app/(authenticated)/conversations/page.tsx`
  - Conversation rows already use menus.
- `apps/web/src/components/LinkedItemRow.tsx`
  - Highlight rows already use menus.
- `apps/web/src/components/ConversationContextPane.tsx`
  - Context rows already use menus.

### Surfaces that already use header menus

- `apps/web/src/app/(authenticated)/libraries/[id]/page.tsx`
  - Library detail header already has a menu.
- `apps/web/src/app/(authenticated)/conversations/[id]/page.tsx`
  - Conversation detail header already has a menu.
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx`
  - Media viewer header already has a menu.
  - Current items are limited to things like `Open source` and EPUB TOC toggle.

### Surfaces missing menus or still using bespoke buttons

- `apps/web/src/components/MediaCatalogPage.tsx`
  - Shared catalog rows for documents, videos, and visible podcast episodes.
  - Rows already support `options`, but the component only exposes a narrow `onDeleteItem` prop today.
- `apps/web/src/app/(authenticated)/libraries/[id]/page.tsx`
  - Library media rows use a custom sortable row with a lone `Remove` button.
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.tsx`
  - Subscription rows use dense inline actions and no menu.
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.tsx`
  - Episode rows use dense inline actions and no menu.
  - Podcast detail page header has no menu today.
- `apps/web/src/app/(authenticated)/podcasts/page.tsx`
  - Discovery rows use inline actions and no menu.

### Backend reality that matters for this UI PR

- There is no `DELETE /media/{id}` route today.
- Current library removal uses `DELETE /libraries/{id}/media/{mediaId}`.
- Current default-library GC only removes `library_media` rows; it does not delete the underlying `media` row.
- Retry exists server-side for `pdf`, `epub`, `podcast_episode`, and `video`.
- Retry does not exist for `web_article`.
- The web app currently does not expose `/api/media/[id]/retry`.

Implication:

- This PR must not pretend permanent delete exists.
- This PR may prepare the UI shape for delete later, but it should not show a fake permanent delete action.
- This PR may optionally wire retry only if the implementation adds the missing web-side proxy route and keeps the behavior limited to existing backend support.

## Design Principles

- Use one dropdown menu primitive everywhere: `ActionMenu`.
- Use one option shape everywhere: `ActionMenuOption`.
- Keep action ownership local to each page or surface.
- Prefer small explicit option-builder functions over a generic action registry.
- Do not push menu logic into pane routing, workspace state, or shared runtime layers.
- Only show a menu trigger when there is at least one meaningful option.
- Keep obvious primary actions inline when they are truly primary.
- Move secondary, contextual, and destructive actions into the menu.
- Replace lone destructive buttons with a menu when the row otherwise has no action cluster.
- Do not duplicate the same action inline and in the menu on the same row.

## UX Rules

### Menu trigger visibility

- Reuse the existing list-row hover/focus behavior from `AppList`.
- For custom rows that are not `AppListItem`, match the same visual behavior as closely as possible.
- Header menus should use the existing `SurfaceHeader` trigger behavior.

### Menu content rules

- Use plain, literal labels.
- Use `tone: "danger"` only for destructive actions.
- Order actions from most common to least common.
- Put destructive actions last.
- Do not show disabled placeholder items for unimplemented features.
- Do not show menu items that have no effect.

### Library semantics for this UI PR

- Outside a specific library page, `Add to library` / `Remove from library` should mean the viewer’s default library only.
- Inside a specific library page, `Remove from library` means the current library.
- This PR does not add a “choose library” flow.

## Surface-by-Surface Action Matrix

### 1. Library list rows

File:

- `apps/web/src/app/(authenticated)/libraries/page.tsx`

Required behavior:

- Keep current row menu behavior.
- No redesign needed.

Menu items:

- `Edit library`
- `Delete library` when viewer is allowed

### 2. Library detail header

File:

- `apps/web/src/app/(authenticated)/libraries/[id]/page.tsx`

Required behavior:

- Keep current header menu behavior.
- No redesign needed.

Menu items:

- `Edit library`
- `Delete library` when viewer is allowed

### 3. Library detail media rows

File:

- `apps/web/src/app/(authenticated)/libraries/[id]/page.tsx`

Required behavior:

- Replace the current lone `Remove` button with a dropdown menu.
- Keep drag handle behavior unchanged.
- Keep row click/navigation behavior unchanged.

Menu items:

- `Remove from library`

Non-goals:

- Do not redesign sortable behavior.
- Do not add permanent delete here.

### 4. Document and video catalog rows

Files:

- `apps/web/src/components/MediaCatalogPage.tsx`
- `apps/web/src/app/(authenticated)/documents/page.tsx`
- `apps/web/src/app/(authenticated)/videos/page.tsx`

Required behavior:

- Add row menus to catalog items when at least one relevant action exists.
- Hydrate default-library membership so the row can show add/remove actions using existing library endpoints.

Menu items:

- `Add to library` when not in default library
- `Remove from library` when in default library
- `Open source` when `canonical_source_url` exists

Not in this PR:

- `Delete`
- `Retry`

Reason:

- Delete is not implemented.
- Retry is not available for every document type and is not web-wired today.

### 5. Media viewer header

File:

- `apps/web/src/app/(authenticated)/media/[id]/page.tsx`

Required behavior:

- Expand the existing header menu so the viewer pane has relevant item actions.
- Keep existing `Open source` and EPUB TOC behavior.
- Add default-library membership actions using existing endpoints.

Menu items:

- `Add to library` when not in default library
- `Remove from library` when in default library
- `Open source` when present
- `Show table of contents` / `Hide table of contents` for EPUB when applicable

Optional in this PR:

- `Retry` only if the implementation also adds the missing web proxy route and only for supported failed media kinds

Not in this PR:

- `Delete`

### 6. Podcast discovery rows

File:

- `apps/web/src/app/(authenticated)/podcasts/page.tsx`

Required behavior:

- Add a row menu without removing the obvious primary subscribe flow.
- Keep `Subscribe` inline for unsubscribed results.
- Keep `View podcast` inline for already-subscribed results.

Menu items:

- `Open website` when `website_url` exists
- `Open feed` when `feed_url` exists

### 7. Podcast detail header

File:

- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.tsx`

Required behavior:

- Add a header menu to the podcast detail page.
- Keep `My podcasts` as the inline header action.
- Move secondary subscription actions into the header menu.

Menu items:

- `Refresh sync`
- `Settings`
- `Unsubscribe` when currently subscribed

Keep inline:

- `My podcasts` link

### 8. Podcast subscription rows

File:

- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.tsx`

Required behavior:

- Add a row menu to each subscription row.
- Reduce the inline action cluster.
- Keep the category selector inline because `ActionMenu` does not support embedded form controls.

Menu items:

- `Settings`
- `Refresh sync`
- `Unsubscribe`

Keep inline:

- Category selector

### 9. Podcast episode rows

File:

- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.tsx`

Required behavior:

- Add a row menu to each episode row.
- Keep the playback actions inline.
- Keep transcript-request controls inline if they still depend on the transcript reason selector.
- Move membership and playback-state toggles into the menu.

Menu items:

- `Add to library` / `Remove from library`
- `Mark as played` / `Mark as unplayed`

Keep inline:

- `Play next`
- `Add to queue`
- Transcript reason selector
- `Request transcript` button, unless the implementer also redesigns that interaction cleanly without increasing complexity

Optional in this PR:

- `Retry transcription` only if retry is wired through the web app and the row is in a supported failed state

## Recommended Implementation Shape

### Shared helper strategy

Recommended small helpers:

- A tiny helper for loading default-library membership state using:
  - `/api/me`
  - `/api/libraries/{defaultLibraryId}/media`
- A tiny helper for toggling default-library membership using:
  - `POST /api/libraries/{defaultLibraryId}/media`
  - `DELETE /api/libraries/{defaultLibraryId}/media/{mediaId}`
- Local option-builder functions per page:
  - one function per row/header surface
  - returns `ActionMenuOption[]`

Do not build:

- a global registry keyed by item kind
- a menu JSON schema
- a context provider just for actions
- a generic “item actions engine”

### Recommended file touch map

Very likely files:

- `apps/web/src/components/MediaCatalogPage.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.tsx`

Possible small helper files:

- a new helper under `apps/web/src/lib/`
- or a small existing-page-local helper if reuse stays limited

Shared primitive files that should only change if truly necessary:

- `apps/web/src/components/ui/ActionMenu.tsx`
- `apps/web/src/components/ui/AppList.tsx`
- `apps/web/src/components/ui/SurfaceHeader.tsx`
- `apps/web/src/components/Pane.tsx`
- `apps/web/src/components/ui/PageLayout.tsx`

Default recommendation:

- avoid modifying shared primitives unless a concrete limitation blocks the UI work

### Suggested read order for the implementer

Read these files in this order before writing code:

1. `apps/web/src/components/ui/ActionMenu.tsx`
2. `apps/web/src/components/ui/SurfaceHeader.tsx`
3. `apps/web/src/components/Pane.tsx`
4. `apps/web/src/components/ui/PageLayout.tsx`
5. `apps/web/src/components/ui/AppList.tsx`
6. `apps/web/src/components/MediaCatalogPage.tsx`
7. `apps/web/src/app/(authenticated)/media/[id]/page.tsx`
8. `apps/web/src/app/(authenticated)/libraries/[id]/page.tsx`
9. `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.tsx`
10. `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.tsx`
11. `apps/web/src/app/(authenticated)/podcasts/page.tsx`

Reason:

- The first five files define the existing menu and header contracts.
- The next six files are the real feature surfaces.
- The implementing engineer should understand the shared contracts first and only then touch page code.

## Acceptance Criteria

### AC-1: library media rows use a dropdown, not a lone remove button

- Given I am viewing a specific library page
- When I look at a media row
- Then the row has a dropdown trigger
- And the old standalone `Remove` button is gone
- And the menu includes `Remove from library`
- And selecting it performs the same action the old button performed

### AC-2: media catalog rows expose relevant row menus

- Given I am on Documents or Videos
- When an item has at least one relevant action
- Then the row shows a dropdown trigger
- And the menu only shows actions that are currently supported for that row
- And `Add to library` / `Remove from library` reflects default-library membership correctly
- And `Open source` is shown only when a canonical source URL exists

### AC-3: media viewer headers expose relevant item menus

- Given I am viewing a media item in the pane viewer
- When the item has supported header actions
- Then the title bar shows a dropdown trigger
- And the menu includes the currently supported item actions for that media
- And existing header actions like `Open source` and EPUB TOC continue to work

### AC-4: podcast detail header exposes secondary actions in a menu

- Given I am on a podcast detail page
- When the page loads
- Then the header shows a dropdown trigger
- And the menu contains `Refresh sync`, `Settings`, and `Unsubscribe` when applicable
- And the existing `My podcasts` link remains visible inline

### AC-5: podcast subscription rows get menus without breaking category editing

- Given I am on My Podcasts
- When I inspect a subscription row
- Then the row has a dropdown trigger
- And `Settings`, `Refresh sync`, and `Unsubscribe` are available through the menu
- And the category selector still works inline

### AC-6: podcast episode rows get menus without breaking playback flows

- Given I am on a podcast detail page
- When I inspect an episode row
- Then the row has a dropdown trigger
- And the row still keeps the primary playback actions usable inline
- And membership/state actions are available in the menu
- And transcript request behavior still works correctly

### AC-7: menus are never empty or fake

- Given any row or header in this slice
- When there are no meaningful actions for that surface
- Then no dropdown trigger is shown
- And the UI does not show disabled placeholders for unimplemented features

### AC-8: no backend delete is implied

- Given the current backend state
- When this PR ships
- Then no menu in this PR claims permanent media delete exists
- And no row or header calls a nonexistent media delete endpoint

### AC-9: code stays explicit and local

- Given a new engineer opens the changed files
- When they trace where a menu item comes from
- Then they can find the builder function in the same page or in one tiny obvious helper
- And they do not need to understand a global action framework

## Implementation Plan

### Step 1: Normalize the decision rules

- Write down, in code comments only where needed, the simple rule:
  - primary actions stay inline
  - secondary/contextual/destructive actions go in the menu
- Keep this rule consistent across the affected pages.

### Step 2: Add small membership helpers

- Reuse the existing `/api/me` and library-media endpoints.
- Centralize default-library membership loading only if two or more surfaces truly share it.
- If reuse stays shallow, page-local helpers are fine.

### Step 3: Upgrade `MediaCatalogPage`

- Replace the narrow `onDeleteItem` prop with something explicit like item option builders.
- Allow rows to define menu options without page-specific hacks.
- Keep the component readable.

### Step 4: Replace bespoke row buttons

- Start with the library detail row.
- Replace the remove button with `ActionMenu`.
- Match existing hover/focus behavior.

### Step 5: Add header option builders

- Podcast detail page gets a new header menu.
- Media viewer header expands to include current membership actions.
- Do not push this logic into shared runtime layers.

### Step 6: Add row option builders

- Podcast subscriptions page gets a row menu.
- Podcast detail episode rows get a row menu.
- Podcast discovery rows get a row menu for source-opening actions.

### Step 7: Wire retry only if kept inside this PR

- If the implementer chooses to include retry in this UI PR:
  - add the missing Next.js proxy route
  - expose retry only for supported failed media kinds
  - do not show retry for `web_article`
- If this is too much for the PR, leave retry for the next PR and do not show it here.

### Step 8: Verify no fake delete leaks in

- Ensure there is still no permanent media delete UI.
- If a later PR adds delete, it should drop into the same option-builder pattern.

### Recommended execution order

Use this order unless a concrete code dependency forces a change:

1. Library detail row menu
2. `MediaCatalogPage` row-menu plumbing
3. Document and video catalog row actions
4. Media viewer header membership actions
5. Podcast detail header menu
6. Podcast subscriptions row menus
7. Podcast episode row menus
8. Podcast discovery row menus
9. Retry wiring only if still clearly within PR scope

Reason:

- This goes from simplest local change to broadest page complexity.
- It gives the engineer a working pattern before touching the podcast screens.

## Testing Plan

### Unit/component tests

Update or add tests around:

- `apps/web/src/__tests__/components/AppList.test.tsx`
- `apps/web/src/__tests__/components/SurfaceHeader.test.tsx`
- `apps/web/src/__tests__/components/Pane.test.tsx`

Add page-level tests where behavior changes materially:

- `apps/web/src/app/(authenticated)/podcasts/podcasts-flows.test.tsx`
- relevant page tests for documents/videos if added

Assertions to cover:

- menu appears only when options exist
- correct labels render
- destructive items use danger tone where appropriate
- selecting a menu item triggers the same mutation/navigation as before
- inline primary actions still exist where the spec says they should remain

### E2E/manual checks

Manually verify:

- library detail row remove flow
- document catalog add/remove from default library
- video catalog add/remove from default library
- media viewer header add/remove from default library
- podcast detail header menu actions
- podcast subscription row menu actions
- podcast episode row menu actions

## Risks and How to Avoid Them

### Risk: over-engineering the action model

Avoidance:

- keep option builders local
- only extract small helpers with obvious reuse

### Risk: duplicate actions inline and in menus

Avoidance:

- for each surface, decide once which actions stay inline and which move to the menu
- do not keep both unless there is a very strong reason

### Risk: pretending delete exists

Avoidance:

- do not add any permanent media delete item in this PR

### Risk: ambiguous library semantics outside a library page

Avoidance:

- default-library only
- document that rule clearly in code and tests

### Risk: podcast episode row complexity balloons

Avoidance:

- keep transcript request inline unless the redesign stays obviously simpler
- keep playback actions inline
- move only the secondary state/membership actions to the menu

## Definition of Done

This PR is done when:

- item rows across the targeted surfaces have dropdown menus where meaningful actions exist
- item detail headers across the targeted surfaces have dropdown menus where meaningful actions exist
- current actions still work
- no fake delete is introduced
- the code remains page-local, explicit, and easy to follow
- tests cover the new menu behavior and the retained primary actions

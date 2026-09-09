# An Imports invalidation unmounts the rows it is refreshing

**Status:** open
**Origin:** 2026-09-08, imports workspace hard cutover, Track E
**Area:** `apps/web/src/lib/imports/useImportsPage.ts`;
`apps/web/src/components/imports/ImportsWorkspace.tsx`

## What is wrong

Every invalidation (a successful upload retry or removal, a media recovery, a
manual refresh) increments the provider's observation revision, which re-keys
`useResource` in `useImportsPage`. A re-keyed `useResource` has no data, so the
page goes `loading` and the workspace has nothing to render: the rows unmount
for one round trip and remount.

Two consequences were found while proving Track E:

1. The workspace showed the view's **empty state** during that round trip, so a
   full list briefly read "No imports need attention". Fixed in this change:
   the empty state renders only for a page that actually came back empty.
2. Row-local state does not survive the remount. Track E moved the upload
   command's failure copy to the shared feedback HUD for this reason
   (`ImportRow.tsx`), but any future row-local state has the same exposure.

Contract D10 keeps the *live five-second re-read* from disturbing the list (a
structurally identical page keeps the previous page object). It says nothing
about an explicit invalidation, which always re-keys.

## Prerequisites

None; the decision is whose layer holds the last-good page.

## Proposed fix

Keep the previous page object in `useImportsPage` across a re-key of the same
query (only the revision changed) and expose it as `items` while the new read is
in flight, the way `ImportsProvider` keeps its last-good summary. The page must
still be replaced by the read's answer when it arrives.

## Acceptance

A named case in `components/imports/ImportsWorkspace.browser.test.tsx`: after a
successful upload removal the remaining rows stay on screen for the whole
invalidation round trip (no loading placeholder, no empty state).

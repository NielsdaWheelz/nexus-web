# Any appnav edit now selects the whole document-import-reliability risk

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain W2, 2026-09-09, when
`components/appnav/**` was added to the risk's source globs
**Area:** `testdata/proofs.json` (`document-import-reliability.source_globs`)

## What is wrong

Registering `vitest:apps/web/src/components/appnav/NavRail.browser.test.tsx`
under the `document-import-reliability` priority risk required
`apps/web/src/components/appnav/**/*` in that risk's `source_globs`. A priority
risk selects its **whole** proof set, so any edit anywhere under `components/
appnav/` — the mobile top bar, the sheet, the command hint, the brand mark —
now selects that risk's migration, service and browser nodes (`migrations`,
`service`, `component`, `kernel-web` capabilities), not just the rail proof that
covers the Imports entrance.

Only the Imports footer link and the Account menu item in that directory carry
import behaviour; the rest of the rail has nothing to do with the risk. This is a
heavier `changed` for a directory that is otherwise rarely touched, and it works
against the PR time budget OI-007 tracks.

## Prerequisites

A way to route one proof from a narrow source set without widening a priority
risk's globs — either a narrower glob shape the registry admits, or splitting the
navigation entrance into its own risk with the `component` capability only. Both
change `nexus_test_control` selection, so this is not a `proofs.json` edit alone.

## Proposed fix

Either narrow the glob to the files that carry the entrance
(`components/appnav/NavRail.tsx`, `AccountMenu.tsx`, `navModel.ts`,
`AppNav.module.css`) if the registry admits an exact-file list beside globs, or
register the navigation entrance as its own priority risk whose proof set is the
rail proof alone. Measure the `changed` set for a one-line `AppNav.tsx` edit
before and after.

## Acceptance

An edit to a navigation file that carries no import behaviour selects the rail
proof and the static gates, not the risk's migration and service nodes, and
`vitest:apps/web/src/components/appnav/NavRail.browser.test.tsx` is still
selected by an edit to the Imports entrance.

# The Imports pane body has no browser proof

**Status:** open
**Origin:** Imports workspace cutover, Track E second re-review, 2026-09-08;
widened by Track F's re-review the same day
**Area:** `apps/web/src/app/(authenticated)/imports/ImportsPaneBody.tsx`;
`apps/web/src/components/appnav/AccountMenu.tsx`;
`apps/web/src/lib/panes/paneSecondaryModel.ts`

## What is wrong

`ImportsPaneBody` is the composition Track F owns — the `imports-inspector`
secondary group, the `usePaneReturnReady` token, the URL codec — and no browser
proof renders it. `components/imports/ImportsWorkspace.browser.test.tsx` renders
the router-free workspace inside its own harness, with its own
`role="complementary"` container and its own Back button, so three behaviors are
unproven:

1. **The mobile sheet.** Dismissing the real sheet (its Back control or a
   browser history entry) must clear `selected` from the URL and return the
   reader to the list. The Track E case narrows the viewport to 390 px and
   dismisses the harness's own container instead.
2. **The return-memento gate.** The pane spends its one `ShellScroll` readiness
   token on `listSettled || loadState.kind === "Failed"`. The workspace proof
   covers the `onListSettled` report; nothing covers the pane's composition of
   it, in particular that a failed first summary read still releases the
   memento instead of withholding it forever.
3. **The mobile entrance.** Contract D9 makes the shared `AccountMenu` item
   `Imports` the mobile entrance to this pane. No proof clicks it, and no proof
   reads its `aria-current`.

## Prerequisites

None; Track F's route, pane body and secondary group all exist.

## Proposed fix

One browser proof beside the pane body (the `StatsPaneBody.browser.test.tsx`
harness is the precedent: `PaneRuntimeProvider` + `PaneReturnMementoProvider`)
with a named case per behavior above, or a mobile-viewport step in
`durable-ingest-reader-open.journey.spec.ts` for the entrance and the sheet.

## Acceptance

Named cases owned by Track F fail if the mobile sheet's dismissal stops clearing
the selection, if a failed first summary read stops releasing the return
memento, or if the Account menu's `Imports` item stops naming the pane.

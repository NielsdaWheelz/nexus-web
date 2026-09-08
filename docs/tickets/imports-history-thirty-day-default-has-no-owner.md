# The History view's 30-day default has no owner

**Status:** open (Track E's toolbar to own; Track D2 to verify the URL stays honest)
**Origin:** Imports workspace cutover, Track D1, 2026-09-08
**Area:** `apps/web/src/lib/imports/importsUrlState.ts`;
`apps/web/src/components/imports/**` (not yet written)

## What is wrong

The spec says "History defaults to a visible 30-day filter; this is not
retention", and contract §4 confirms "No server default for `from`". So the
default must be applied on the browser, and it must be *visible* — in the URL and
in the toolbar's date field — or the reader cannot tell why older imports are
missing, and cannot widen the window.

Nothing applies it. `decodeImportsUrlState` returns `from: absent()` for a
History URL with no `from`, `importsQueryParams` therefore sends no `from`, and
the server answers with the unbounded set. No other module in `lib/imports/` or
`docs/tickets/` claims the default.

D1 deliberately did not apply it in the codec: `decodeImportsUrlState` is
tolerant and canonicalizing over what the reader wrote, and injecting a filter
the reader did not write would make an unqualified `/imports` URL disagree with
itself the moment the pane resolves `view=History` before the toolbar exists to
show or clear it.

## Prerequisites

Track E's `ImportsWorkspace` toolbar (the "From" / "Before" date fields and
`AppliedFilters`).

## Proposed fix

Have Track E's toolbar seed `from` with `now - 30 days` when the pane resolves
`view=History` with `from` absent, writing it through the same
`usePaneUrlState` setter the date fields use, so the value lands in the URL, in
the applied-filter chips, and in the API query by the one existing path.

## Acceptance

Opening History with no `from` shows a 30-day window whose bound is visible in
the URL and in the toolbar, Clear all / widening the date removes it, and a URL
that already names `from` is left exactly as written.

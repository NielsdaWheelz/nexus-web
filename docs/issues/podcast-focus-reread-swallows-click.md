# podcast focus reread can swallow a click

a window `focus` moves a podcast read's `stale` with no debounce. that is a real
invalidation, so the control disables, and a click arriving then does nothing.

evidence: `indexPaneEntry.tsx:74` (show headers) and `usePodcastActionFacts.ts:41`
(search and browse rows) call `useRefreshStamp(active && visible, 0)`. in a firefox
lab run of header subscribe, the label was already `Last known not subscribed` at
pointerdown and no dialog opened. a neutral click on the pane heading first cured
it. the same case in chromium never showed it. the focus event itself was not
observed, so the cause is inferred.

impact: the click that returns to the window can be lost, and with the 600ms hold a
subscribed control still looks gold while it ignores the click.

proposed fix: check first a nonzero `foreground`, as `lectern.tsx:153` and
`MediaSummaryProvider.tsx:264` use 60_000.

resolved when the first click that returns to the window opens the dialog on a
settled show in firefox, with no neutral click before it.

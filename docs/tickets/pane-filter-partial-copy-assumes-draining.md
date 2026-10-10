# the partial pane-filter status promises loading that a manual list never does

status: open · origin: 2026-10-10 podcasts/browse web rewrite (design T2) · area: panes / filter rows

`paneFilterRowsStatusMessage` and `paneCollectionRowsStatusMessage`
(`apps/web/src/lib/panes/paneFilterRows.ts:68,90`) describe `Partial` as
"…; loading remaining …" / "…; loading more". That held while every pane drained
its pages. The podcast index and detail now load 100 rows and continue only on
Load more, so a partial list announces loading that never happens until the
user asks.

fix: give `Partial` copy that states what is loaded without promising more
(e.g. "n matches in m loaded"), or a separate status for manual continuation;
owned by `lib/panes`, used by every collection pane.

acceptance: a podcast list with more pages and no Load more in flight reads a
truthful status; draining panes keep theirs.

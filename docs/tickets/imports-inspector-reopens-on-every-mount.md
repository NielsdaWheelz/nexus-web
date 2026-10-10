# a dismissed imports Inspector reopens whenever the pane remounts

status: open · origin: 2026-10-10 workspace host reauthor (cleanup/workspace-host-reauthor), c2wh review · area: imports / web

`ImportsPaneBody` requests its Inspector in an effect keyed on the selection
(`if (selected !== null) requestSecondarySurface("import-detail")`), which also
runs on mount. its own comment says a dismissed Inspector keeps the selection
and reopens from the header, but a resume or a breakpoint round trip remounts
the body and reopens it. main has the same effect (through `usePaneSecondary`).

evidence: c2wh probe I1 (build 459e14098): select an import, close its
Inspector (saved `visibility: "collapsed"`), resume `/`: the Inspector shows
and the saved record reads `visible`.

impact: the user's dismissal does not survive a reload. since the host
rewrite the desktop column also scrolls into the canvas when a command opens
it, and this mount-time request is such a command, so a resume can move the
canvas to an inactive imports pane.

what to do: open the Inspector when the selection changes within a mounted
body (and on onSelect, which already does), not when the body mounts with one.

acceptance: dismiss the Inspector of a selected import, resume: it stays
closed, the saved record stays `collapsed`, and the canvas does not move to it.

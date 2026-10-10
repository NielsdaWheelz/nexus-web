# a quick pane return restores the raw offset: the anchor search looks inside the collection bar

status: open · origin: 2026-10-10 authors reauthor (cleanup/authors-reauthor), harness X8 · area: workspace / pane return

`usePaneReturnScrollport` (`apps/web/src/lib/workspace/paneReturnMemento.tsx:298-314`)
registers the pane's scrollport with `content = element.firstElementChild`. PaneShell
renders the accepted collection bar (`styles.collectionRow`,
`components/workspace/PaneShell.tsx:794-803`) as the scroll body's first child, ahead of
the route content. when the bar is already accepted at registration, `content` is the
bar, `findAnchor` finds no `[data-collection-row-id]` inside it, and `place()` falls back
to the raw `scrollTop`.

that happens on a quick Back: the forward route (a media pane) has not published its
own chrome yet, so the author pane's collection bar is still accepted when the author
visit re-registers. with a 1.5 s dwell the forward pane publishes first, the bar is
absent at registration, the route shell is `content`, and the eye-line anchor is found
(harness U6: within 1 px).

the raw offset then lands wrong because returning rows are not at their capture-time
heights: every `ResourceList` row (`content-visibility: auto; contain-intrinsic-size:
auto 52px`) comes back 69 px tall (grid tracks stretched to the remembered size) and
the ones near the viewport settle at 61 px once action snapshots resolve, so the row
above the eye line sits ~570 px lower than at capture.

evidence (authors explore stack, branch build, 2026-10-10): before Back, scrollTop 6530,
eye-line row `https://www.gutenberg.org/ebooks/60103` at -53 px, 111 rows of 61 px and 3
of 73 px above the target. after Back every restore write (stacks: `register`, `ready`,
the two-frame `requestAnimationFrame` place) sets 6530, while the anchor would need 7365
(first frame) then 7109; the scroller's first child during the restore is
`PaneShell_collectionRow` with 0 rows inside. the target row lands at 1245 instead of
666. main's author pane (a different implementation) shows the same 739 → 1326, so
neither the author pane nor the moved server-state hooks cause it.

fix: register the scroll body itself (or the route content element) as `content`, so
the anchor search covers the rows whatever precedes them; consider re-placing until
the rows stop resizing.

acceptance: authors harness X8 (`quick-pane-return-restores-scroll`) passes, U6 still
passes, and a quick Back on any long collection pane restores its eye-line row.

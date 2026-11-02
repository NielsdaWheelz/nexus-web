# connections return waits for a remote anchor

status: open.
origin: 2026-11-02 connections-scroll lane 3 (window), case a6 and a diagnostic return.
area: reader connections pane, pane return.

problem: when the connections pane returns to a remote row's anchor, the list shows its start until
the reader's document map loads again, then jumps to the anchor. the return remounts the media pane,
so the annotations store reads the map afresh (`state.remote` starts `loading`), and the pane's
restore (`E/EvidencePane.tsx`, the restoration effect) holds an anchor it cannot place until that row
exists. local anchors restore at once.

impact: on the stress book under lab load the list sat at offset 0 for about 5s, then moved 14131px
to the exact row and offset. a reader sees the wrong rows, then a jump. a reader who scrolls first ends
the hold, so the return is lost.

evidence: `a6diag` on `connections-scroll-window` (lab run `window-green2`): before leaving,
`remote:…5b567e83876f` at 476.5px, scrollTop 14131. after return: facets `—`, 0 remote rows, scrollTop 0
for 4s; at 6s the counts land and the row is at 476.5px, scrollTop 14131, held for the next 8s. the
real book, whose map loads faster, restores before the first sample.

acceptance: a6 (return) samples 4s after the pane reopens and stays red on the stress book's remote
anchors while this is open. a case that waits for the facet counts first would hide this defect, so it
is no oracle fix; only this issue's resolution or the owner's explicit waiver closes a6 there.

reproduce: stress book, `all`, scroll to a remote row, open a linked note, go back, reopen the
inspector; watch the list before the facet counts appear.

resolved when: a return to a remote anchor shows that row at its offset in the first frame after
the pane mounts, for example because the map survives the return or the list holds the anchor's
remembered extent until it loads.

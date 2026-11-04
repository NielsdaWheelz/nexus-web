# connections return waits for a remote anchor

status: open. pre-existing: main at `61562d112` does the same wherever its document map arrives.
origin: 2026-11-02 connections-scroll lane 3 (window), case a6; measured by the proof lane's `a6remote`.
area: reader connections pane, pane return.

problem: a pane return to a remote row's anchor shows other rows until the reader's document map
loads again, then jumps to the anchor. the return remounts the media pane, which builds a new
annotations store (`app/(authenticated)/media/[id]/MediaPaneBody.tsx:484`) whose remote section starts
`loading` (`annotations.ts:127`) and reads the map afresh. remote rows exist only in that map, so the
restore (`E/EvidencePane.tsx:254`, `follow`) finds no row and, while the read is pending (`terminal`,
`:134`), holds the anchor without placing it. when the map lands the row mounts and `follow` scrolls
it to its offset, exactly. a local anchor does not wait for the map.

impact: the wait is the map's latency. on the branch the list shows its start (offset 0) meanwhile,
then jumps the whole offset; on main it showed unrelated local rows, then jumped. a reader who scrolls,
clicks or presses a key during the wait ends the hold (`endRestore`, `:215`, bound at `:456-458`), so
the return is lost; a map read that fails ends it too (`:265`), with the list at its start.

evidence, chromium 1440 against the real server under lab load, the case's clock from the click away:

- branch (`0b3deb03`), stress, anchor `remote:…` at 25px, port 1200: list back at 1.65s at offset 0,
  facets `—`, no remote rows; map requested at 1.23s, 200 at 6.96s; anchor at 25px, port 1200, at
  7.03s (run `proof-clean`). again: back 1.79s, map 1.10s to 4.11s, landed 4.17s (`proof-clean2`).
  lane 3's `window-green2`: offset 0 for 4s, then 14131px to the exact row.
- branch, real book, anchor `remote:…` at 55px, port 7920: back 1.67s at offset 0, map 1.03s to 1.80s,
  landed 1.83s (`proof-clean2`). the same wait, short enough that a6's 4s settle never sees it.
- main (`61562d112`), real book, same anchor: back 5.30s, the port then walked 0 to 4263 over 0.3s
  among local rows; map requested 4.88s, 200 at 14.37s; the anchor reached 55px at 14.46s, left it
  twice, and settled at port 7434 by 14.60s (run `main-return`). on the stress book main's map never
  arrives (504 at the 30s proxy deadline, lane 0's a12), so main has no remote row to anchor there.

acceptance: per the build contract's decision of 2026-11-02, a6 gates on local anchors and the real
book, and the stress book's remote-anchor return is a stated gap, not a pass. the real book's anchors
are remote too: a6 passes there only because its map lands inside the case's settle. a case that waits
for the facet counts before sampling would hide this defect, so that is no oracle fix.

reproduce: stress book, `all`, scroll until a remote row is the first fully visible row and a linked
note is in view, open the note, go back in the pane, reopen the inspector, and watch the list before
the facet counts appear. `a6remote` in the connections-scroll cases does this with a per-frame trail.

resolved when: a return to a remote anchor shows that row at its offset in the first frame after the
pane mounts, on the stress book under load; for example because the map survives the return, or the
list holds the anchor's remembered extent until the map loads.

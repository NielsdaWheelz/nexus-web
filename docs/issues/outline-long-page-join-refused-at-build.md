# a row put after a long page's last loaded row cannot be joined into the row above

status: open · origin: notes re-slice second review (overlay/O-7e), 2026-10-21; fixed only by
the dropped web engine (P2) · area: notes outline (`lib/notes/useOutlineSession.ts`)

on a page of 120 notes (100 loaded), Enter at the end of row 99 makes a row the server puts
at index 100, on the second read page. after it saves, Backspace at its start (join into
row 99) is refused before sending.

impact: the join does not happen; the tab shows "that change couldn’t be saved" and keeps
the drafts; nothing is lost. afaict any row put after a long page's last loaded row is affected.

evidence (main `c0063b28e`):
- overlay/O-7e is an xfail on main and on P1 (#734): `set_body+insert_note` 200, the row's
  `set_body` 200, then no join request; the server keeps `["row 98","row 99","zz","row 100"]`.
- cause unproven (idk). the join is refused while building its request, so one of the
  build refusals threw: `lib/notes/useOutlineSession.ts:510-523` ("the insertion position is
  no longer loaded", "placement changed; refresh before trying this edit again") or
  `sealOutlinePosition` (`lib/notes/writes.ts:107-128`) for the pending row's proof
  (`useOutlineSession.ts:1137-1161`). a suspect: the insert's reply carries only the first
  100 items and replaces the loaded view
  ([outline-structure-reply-truncates-long-page](outline-structure-reply-truncates-long-page.md)),
  so the new row is no longer in the graph the join is checked against.

repro: the steps above; type "zz" in the new row, wait 2.5 s, put the caret at its start,
Backspace.

starting point: P2 (`88acbbf1e`) kept the new row as an acknowledged intent replayed over
partial reads, so the join's consume replays and seals with it.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: overlay/O-7e passes (the server holds "row 99zz" at 99 and no "zz"; the tab
shows the same).

# on a page longer than one read page, a row this tab added stays after another device unlinks it

status: open · origin: notes re-slice review (overlay/O-7b), 2026-10-21; fixed only by the
dropped web engine (P2) · area: notes outline (`lib/notes/useOutlineSession.ts`)

a row this tab inserts is kept as a pending occurrence until a read retires it. main
retires pending occurrences, and detects links removed elsewhere, only on a complete read.
a page over 100 items is never read completely without "show more" to its end, so the
inserted row keeps showing after another device unlinks it.

impact: a ghost row: this tab shows `["row 0","ghost here","row 1"]` while the server lists
`["row 0","row 1","row 2"]`, afaict until a reload. pending occurrences on long
pages likewise stay in memory for the tab's life.

evidence (main `c0063b28e`):
- `lib/notes/useOutlineSession.ts:628`: `retirePendingOccurrences` returns on a partial read;
  `:705-711` calls it only for `read.complete`.
- `lib/notes/useOutlineSession.ts:240`: `adopt` collects links removed elsewhere only from a
  complete read.
- overlay/O-7b (120 rows, 100 loaded) is an xfail on main and on P1 (#734). the same check
  on a short page (overlay/O-7) passes.

repro: a page with 120 notes (100 loaded); Enter after row 0, type "ghost here", wait for
the save; another tab unlinks that row; make this tab reread the page (save its title).

starting point: P2 (`88acbbf1e`) retired an acknowledged intent on a partial read that
holds every link the intent put there and shares no link with an earlier intent still
replaying there (`graph.ts` `retire`).

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: overlay/O-7b passes and overlay/O-7, O-7c, O-7g stay green.

# a note deleted elsewhere can take its unsaved text out of view

status: open · origin: notes re-slice harness (bodies/B14, defect D9), 2026-10-21; fixed only
by the dropped web engine (P2) · area: notes outline (`lib/notes/useOutlineSession.ts`)

`docs/modules/notes.md:200` promises that a deleted note's dirty text stays visible, read-only,
for copying ("this note is no longer available" + copy). that holds when the held save's 404
arrives first. when a reread of the page arrives first, it no longer lists the note's link,
the row goes, and the later 404 has no row to show the notice in.

impact: unsaved text in a note another device deleted vanishes from the page with no way to
copy it. it stays in the tab's text store, unreachable.

evidence (main `c0063b28e`):
- `lib/notes/useOutlineSession.ts:238-252` (`adopt`): a newer complete read replaces the
  outline; links missing from it go, unsaved text or not.
- `lib/notes/useOutlineSession.ts:182-191` (`liveOutline`) keeps a link with unsaved text
  only when this tab already knows its target is deleted, which the reread precedes.
- `lib/notes/texts.ts:539-545`: the save's 404 marks the note gone;
  `components/notes/OutlineSurface.tsx:497-506` renders the copy notice only inside a row.
- bodies/B14 passed by chance on main's baseline (1 of 3 dev runs failed); strengthened to
  force the order (leave the pane and return before the held save answers), it is an xfail
  on main and on P1 (#734): "the row and its unsaved text vanished".

repro: type in a page's note without letting it save (hold the save, or go offline); delete
the note from another tab; return to the page so it rereads before the save answers.

starting point: P2 (`88acbbf1e`) kept a row removed elsewhere while its note has unsaved
text.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: bodies/B14 (strengthened) passes: the notice and copy action show whichever
of the reread and the 404 lands first.

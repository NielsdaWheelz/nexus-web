# removing a row in a scrolled day returns the pane to its top

status: open · origin: notes re-slice harness (outline/O37, defect D12), 2026-10-21; fixed
only by the dropped web engine (P2) · area: notes outline
(`components/notes/OutlineSurface.tsx`, `lib/notes/useOutlineSession.ts`)

in a day long enough to scroll, block-selecting a row below the one in view and pressing
Backspace removes it, and the row in view jumps by about 1,270 px: the pane is back at its
top.

impact: every removal in a long day or page loses the reading position. it also keeps
outline/O37's prepend anchoring half from being judged on main: the journey measures the
removal alone first and fails there.

evidence (main `c0063b28e`):
- outline/O37 is an xfail on main and on P1 (#734): "removing a row below moved the row in
  view by 1265 px (no prepend involved)". 60 rows, the target at the viewport's centre,
  Escape on a row four below, Backspace.
- cause unproven (idk). P2's rewritten surface fixed it without a named change. a candidate
  where main and P2 differ: `components/notes/OutlineSurface.tsx:139-145` focuses the whole
  section, without `preventScroll`, on every change of `rows` while a block selection
  exists, and a pending unlink re-renders the rows; P2 focused it only when the selection
  changed and its surface held the anchor.

repro: a day with 60 notes; scroll so row 30 is centred; click row 34, Escape, Backspace;
watch row 30.

starting point: bisect the removal's renders on main (the section focus above, the pane's
loading fallback at `app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:117`), then
compare P2's `OutlineSurface` (`88acbbf1e`).

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: outline/O37 passes (a removal below keeps the row in view within 4 px, and
a row prepended elsewhere then arrives above it without moving it).

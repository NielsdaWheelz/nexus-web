# block-selection arrows skip an expanded row's children, so Backspace unlinks the wrong row

status: open · origin: notes re-slice harness (outline/O16, defect D4), 2026-10-21; fixed
only by the dropped web engine (P2) · area: notes outline
(`components/notes/OutlineSurface.tsx`, `components/resources/ResourceDisclosure.tsx`)

`docs/modules/notes.md:160-161` says selection, navigation and joins consume the visible
rows. block selection walks only the rows of one surface. an expanded row's children render in the disclosure's own `OutlineSurface`,
with its own rows, so ArrowDown from the expanded row goes to its next sibling.

impact: with "parent" expanded to show "child", Escape on parent, Shift+ArrowDown selects
"after" instead of "child"; Backspace then unlinks parent and after. notes survive (unlink
keeps them), but a row the person did not mean to touch leaves the page.

evidence (main `c0063b28e`):
- `components/notes/OutlineSurface.tsx:209-219`: the next row is
  `rows[rows.indexOf(row) + direction]`, this surface's rows only.
- `components/resources/ResourceDisclosure.tsx:145-159`: each open branch renders its own
  `OutlineSurface` (since #703).
- `components/notes/OutlineSurface.tsx:221-235`: Backspace unlinks the selected rows.
- outline/O16 is an xfail on main and on P1 (#734).

repro: a page with parent > child, and after; expand parent; click parent's text, Escape,
Shift+ArrowDown, Backspace.

starting point: P2 (`88acbbf1e`) had every surface register the rows it draws
(`session.drawRows`) and walked selection over `session.visibleRows(parentKey)`, which spans
open disclosures.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: outline/O16 passes (the arrows walk rows drawn through open disclosures and
Backspace unlinks exactly the selected rows).

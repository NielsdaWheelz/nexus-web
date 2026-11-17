# the inspector's `mentioned in` list is ordered by a uuid

found 2026-11-16 at 839bb918b, photographing the notes in a lab for a redesign.

## problem

the `backlinks` query behind the connections inspector's `mentioned in` section
orders its rows by `r.ref`, a uuid-bearing resource ref. to a reader the order is
arbitrary and shifts as items are added.

## impact

the section lists notes and pages that mention the open resource in no order a
reader can predict or scan; there is no way to find the latest mention or one by
name.

## evidence

- `node/authored/src/queries.ts:460`: `... WHERE i.target_ref=? AND r.visible=1
  AND r.ref>? ORDER BY r.ref LIMIT ?`. the `r.ref>?` keyset cursor is the reason:
  paging is by ref.
- the consumer is `components/connections/ConnectionsSurface.tsx:58, 90-92`,
  which takes the first 100 rows as returned; `annotations.ts:248` pages the same
  query to exhaustion for the reader, where order does not matter.
- the sibling `annotations` query orders by `ref` too (`queries.ts:459`); the
  `pages` query orders by display title (`queries.ts:454-457`), so a reader-visible
  order is already a pattern here.
- `docs/modules/notes.md` does not say how `mentioned in` is ordered.
- a lab photograph taken during the survey (not kept in the repo). to reproduce:
  mention one note from several others and open its inspector.

## resolved when

`mentioned in` orders by something a reader can see (display title, or last
touch where the projection carries one), keyset-paged on that key plus `ref`, and
the module doc says which.

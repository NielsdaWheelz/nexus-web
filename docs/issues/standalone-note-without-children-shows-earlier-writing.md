# a childless note opened from its bullet shows only `earlier writing`

found 2026-11-16 at 839bb918b, photographing the notes in a lab for a redesign.

## problem

opening a note that has no children of its own as a standalone pane (clicking its
bullet, `/notes/:id?via=...`) shows the words `earlier writing` under the header
and nothing else. expected: the empty outline's first-bullet seed
(`write or @ to link`), as for any childless note opened directly. cause not
established.

## impact

the note reads as having hidden content that does not exist; the only control
loads nothing, and the seed that would let the user write is absent.

## evidence

observed in the lab; cause not established. suspects:

- `OutlineViewport.layout` emits a gap part for any branch it has not proved
  complete: with no shown rows, `gap(0, items.length, unknown)` runs with
  `unknown = !branch.last`, and with no prior item its direction is `before`
  (`apps/web/src/lib/notes/outlineViewport.ts:100-120`), which paints
  `earlier writing` (`lib/notes/outlineController.ts:2158`) at an estimated
  768px+ (`outlineViewport.ts:107`).
- `branch.first/last` become true only for a window that `provesEmptyOutline`
  (`outlineViewport.ts:18-21`, `admit` at `68-76`) or that has rows with no edge
  (`84-85`). so a window with no rows that is not a clean proof (a non-null
  `tailEdge`, cursor or edge) leaves both false and yields this gap. the `?via=`
  entry adds the traversed link to `excluded_link_ids` and `entering_link_id`
  (`components/notes/LocalOutline.tsx:102, 265-267`); the sql excludes it from
  `kept` and the tail (`node/authored/src/queries.ts:341-356`), so the proof
  should be clean, but the lab shows otherwise. not checked at runtime.
- the seed row needs `provesEmptyOutline(window)` and no sibling
  (`outlineController.ts:1321-1326`), so a gap row and the missing seed share
  one cause: the empty proof was not reached.
- a lab photograph taken during the survey (not kept in the repo). to reproduce:
  from a parent's outline press the bullet of a childless note (url ends in
  `?via=<link id>`).

## resolved when

a childless note opened from a bullet shows the seed, with no gap row, and a note
with an unloaded earlier window still shows `earlier writing`.

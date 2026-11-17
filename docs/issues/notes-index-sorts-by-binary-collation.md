# the notes index sorts with sqlite's binary collation

found 2026-11-15 at fcd6843db, surveying the notes for a redesign.

## problem

the `pages` query orders by `display_title, ref` with no collation, so sqlite
compares bytes: every capitalised title sorts before every lowercase one, and
dated pages (titled `November 15, 2026`) sort as strings, so `April 10, 2026`
precedes `April 2, 2026` and months run alphabetically, not chronologically.

## impact

the notes list reads as shuffled: `Zebra` above `apple`, a journal's days out of
order. nothing is lost; the list is just unpredictable to a reader.

## evidence

- `node/authored/src/queries.ts:454-457`: the `pages` case, `ORDER BY
  display_title,ref LIMIT ?` over `${PAGE_TITLE_SQL} AS display_title`, and the
  cursor test `WHERE(display_title,ref)>(?,?)`; no `COLLATE` anywhere in
  `node/authored/src` (`grep -rn COLLATE` is empty).
- `PAGE_TITLE_SQL` (`queries.ts:64`) is `COALESCE(NULLIF(title,''),DAILY_TITLE_SQL,'untitled page')`;
  `DAILY_TITLE_SQL` (`queries.ts:54`) spells the date as month name, unpadded day, year.
- `NotesPaneBody.tsx` declares the ordering a contract (header comment: "Pages use
  one title/ref ordering") and offers no sort control (`order: null`, line 54).

## proposed fix

pick the order first: case-insensitive title order, with dated pages ordered by
`local_date` rather than their spelling. then change the order, the cursor
comparison and the `resources_pages` index (`node/authored/src/schema.ts:34`,
which indexes `PAGE_TITLE_SQL,ref`) together, since an index only serves the
collation it was built with.

## resolved when

a list holding `apple`, `Zebra`, `April 2, 2026` and `April 10, 2026` shows them
in the chosen order, across a page boundary of the cursor, and the planner still
uses the index.

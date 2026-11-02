# a highlight row reads as gone until reading scope hydrates

status: open; observed on a fresh firefox profile in the lab. the path predates the
reader highlight row change.

for about 2s after opening a source on a fresh profile, a placed row is wrong:

- literal `highlight:<uuid>`, with a button bullet: `ResourceOutlineRow.tsx`, the
  `LocalRow` fallback, while the read is null.
- the quote with no `mark`, and a bullet to `/highlights/<id>`: `ReferenceRow`'s stub
  href carries no `activationRef`.
- blank, then `no longer available on this device`: `AuthoredRow` with a null resource.

the row corrects itself once catch-up publishes `up to date`.

cause: `excerptQuery` returns empty rows with `scope_available: false` while the
reading is missing from hydrated scope (`node/authored/src/queries.ts:467`). `LocalRow`
can't tell pending from absent.

impact: `no longer available` is a false claim about the owner's writing, and a click
in this window can leave the reader. first opens only, as far as observed. whether a
newly saved reading on a hydrated device hits this window is unobserved.

proposed fix: the query distinguishes pending from absent, so the row can hold. a
row-level `reading_ref: null` is wrong: it re-keys the read on a placement flip and
unmounts `HighlightAnnotation`.

resolved when a fresh profile shows neither that copy nor a `/highlights/<id>` bullet
on a placed row.

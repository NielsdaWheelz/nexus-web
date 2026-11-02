# library type filters omit pieces

problem: `text_part` has no entry in the library type filter, though pieces can be
filed in a library and the catalog selector accepts the kind.

impact: a filed essay or poem cannot be isolated by type. it appears only under all
types.

evidence: `apps/web/src/lib/libraries/views.tsx:40-47` and the `entry_type` whitelist at
`app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:354` both stop at five kinds.
`lib/catalog/selectors.ts:122` lists all six. `lib/search/kinds.ts:33` omits pieces as
well.

proposed fix: add `text_part`, labelled pieces, to both lists; confirm the server's
`entry_type` filter accepts it, and decide search separately.

resolved when a library holding pieces can be filtered to pieces, online and from a
saved catalog.

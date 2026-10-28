# outline excerpt reading navigation

`apps/web/src/components/resources/ResourceOutlineRow.tsx` reads an owned
highlight under `props.readingRef` but derives its source route without that
reading. a piece-scoped quotation can therefore navigate to the root source.
found by static integration review after merging `fff2266c9`.

pass the admitted reading through the existing route owner. resolved when a
piece-scoped outline excerpt retains that reading in its actual source link
and arrival, while ordinary owner access keeps its existing route.

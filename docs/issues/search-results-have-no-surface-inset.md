# search results have no surface inset

`SearchPaneBody` renders its sections straight into the pane body. library, browse,
authors and lectern sit in `PaneSurface`, which owns the `--space-4` inset. search
does not, so nothing supplies that inset.

two symptoms follow:

- the section heading sits at x=0 at every width, while row text sits 8px in and the
  query controls above it sit further in.
- a folded row sets `padding-inline: 0` (`ResourceRow.module.css:149`) and leaves the
  inset to its surface, so folded search rows run edge to edge. the metadata line's
  last glyph lands on the viewport edge.

impact: cosmetic, and nothing clips. the heading shows on every search with sections.
rows fold at 276px at 100% type, narrower than any phone, and at 456px at 200%, so the
folded case needs large text on a phone. it predates row facts; natural-basis context
exposes it, since context now runs to the end of the line.

evidence: 2026-11-01 lab case. the heading is at x=0 in the `search-w900-*`,
`search-w360-*` and `search-w270-*` shots. at 270px and at 200% type on a 360px touch
viewport, row and metadata measure from 0 to the viewport's width. library and browse
rows at the same widths sit 16px in at 100% type and 32px in at 200%.

decision, owner, 2026-11-01: wrap search's results in `PaneSurface`, and add no
fold-specific rule. rejected: fold-only row padding, which makes a row know its surface
and leaves the heading flush; a local `padding-inline` on search's wrapper, a second
inset that drifts from `PaneSurface`; accepting edge to edge, which keeps the heading
misaligned at every width.

costs, by arithmetic and not measured:

- every search row loses 32px at every width, 64px at 200% type. at 200% on a 360px
  phone that is about five fewer title characters.
- hover and selection tints stop at the inset, as in library, instead of bleeding to
  the pane's edges.
- search folds at a pane of about 308px instead of 276px at 100% type, and about 520px
  instead of 456px at 200%.

unknown: `PaneSurface` puts a `--space-4` gap between its children, and search's root
also holds feedback notices and local results. how those compose is unread, so this
may be more than a one-line wrap.

resolved when the section heading and folded rows at 200% type on a 360px phone keep
the same inset as library at the same width, and search's notices and local results
keep their order and spacing.

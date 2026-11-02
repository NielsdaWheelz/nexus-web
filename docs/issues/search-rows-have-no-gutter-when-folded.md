# search rows have no gutter when folded

a folded row sets `padding-inline: 0` (`ResourceRow.module.css:149`) and leaves the
inset to its surface. search has none, so its folded rows run edge to edge and the
metadata line's last glyph lands on the viewport edge.

impact: cosmetic, and nothing clips. at 100% type rows fold at 276px, narrower than any
phone. at 200% they fold at 456px, so large text on a phone reaches it. it predates row
facts; natural-basis context exposes it, since context now runs to the end of the line.

evidence: 2026-11-01 lab case, the `search-w270-*` shots. at 270px and at 200% type on a
360px touch viewport, row and metadata measure from 0 to the viewport's width. library
and browse rows at the same widths sit 16px in at 100% type and 32px in at 200%.

an owner's call: search gains a gutter, or edge to edge stands.

resolved when a folded search row at 200% type on a 360px phone keeps an inset from
both viewport edges, or the owner accepts it and this file is deleted.

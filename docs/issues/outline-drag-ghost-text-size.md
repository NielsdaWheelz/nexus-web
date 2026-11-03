# the drag ghost's text is larger than the outline's

problem: the drag ghost (`OutlineDrag.module.css`, `.ghost`) sets `font: inherit`,
and it renders in the overlay container, outside the outline host, so it inherits
the page's 16px text instead of the outline's 14px.

impact: the lifted item's label jumps a size while dragging on a desktop.

evidence: the presentation review's drag-chrome measurements (its finding 3,
chromium and firefox at 1180): the ghost's text is 16px against the rows' 14px.

resolved when the ghost's text matches the outline's type size with a mouse and
with touch, read from the outline's tokens.

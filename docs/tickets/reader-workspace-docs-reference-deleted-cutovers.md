# reader and workspace docs link to deleted cutovers

status: open
origin: 2026-09-25 article-section-navigation final documentation review
area: reader / workspace documentation

`docs/modules/reader-implementation.md:211,266,403,405,543` and
`docs/modules/workspace.md:476,478` link to absent `docs/cutovers/` files for
the mobile position ribbon, reader evidence scope, bottom geometry and link
authoring. the reader behavior prose still stands, but its claimed contract
references cannot be opened. the existing collection-documentation ticket
covers different owners.

prerequisite: identify the current owning contracts or reconstruct only the
necessary invariants from code and surviving docs. replace each dead link or
remove the claim that a deleted file owns the behavior.

acceptance: all reader/workspace contract references resolve and name actual
current owners; no deleted cutover is cited as live authority.

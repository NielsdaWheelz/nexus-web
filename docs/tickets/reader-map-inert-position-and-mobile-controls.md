# reader position and mobile map controls are missing

status: open
origin: 2026-09-11 reader-map council request
area: reader interaction contract

the requested behavior makes position and section/evidence destinations
activatable. the current viewport band and themed bud are inert
(`apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx:220-260`,
`ReaderDocumentMapOverviewRail.module.css:39,61`). mobile has an intentionally
passive position ribbon and accesses contents/evidence through the inspector
(`docs/modules/reader-implementation.md:191-198`). this is a capability gap
against the new request, not proof that existing individual marker callbacks
are broken.

prerequisites: specify current position versus saved reading position,
continuous seeking versus discrete targets, and the dense-target interaction.

proposed fix: expose named exact-locator position/return actions and the shared
section/evidence detail map through existing desktop and mobile inspector
surfaces. retain exact coordinates; resolve collisions through explicit member
selection. targetless outline groups expand their children; only exact
source-addressable nodes are plotted as destinations. supersede the
passive-only contract where the new control is added.

acceptance: pointer, keyboard, and touch users can reach every section and
evidence target, including dense/coincident targets, and return to the saved
reading locus without a precision gesture or hover. navigation alone does not
claim read coverage or completion.

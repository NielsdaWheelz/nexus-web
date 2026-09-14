# deferred unit resources: SVG paint scope and member bytes are still unowned

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: publication render / reader admission

## what is wrong

the admission seam exists — `DocumentReaderSession.memberAssetUrl(reference)`
resolves an authored `nexus-reader-member:` reference against the **selected**
generation, and `applyReaderUnitResources(session, prepared)` in
`apps/web/src/lib/reader/publicationDom.ts` applies it at every
`prepareReaderUnit` site — so an authored `<img>` now mounts with its authorized
URL. two halves remain:

- **typed SVG paint (`LocalFragment`) and member-less URL attributes are still
  deferred.** applying them needs an owner that scopes fragment ids across the
  units mounted beside each other; today a `url(#id)` in one unit can resolve a
  definition in another, and across panes (see the SVG reference-scope ticket).
- **member bytes are not charged against any budget.** a unit's admission counts
  its DOM nodes and canonical text, not the assets it pulls in, so a unit within
  budget can still drag arbitrary asset bytes into the pane.

## prerequisites

decide where the fragment-id scope lives — per prepared unit root, or per pane —
and whether member bytes are charged at prepare time (requires their size on the
wire) or measured on arrival.

## proposed fix

give prepared unit roots a scoped id namespace so `url(#…)` cannot escape, and
charge member bytes against the reader payload budget using the size the
descriptor already carries.

## acceptance

an SVG paint reference in one unit cannot resolve a definition in another unit or
another pane, and a unit whose assets exceed the payload budget is refused with
the same typed capacity reason as an oversized body.

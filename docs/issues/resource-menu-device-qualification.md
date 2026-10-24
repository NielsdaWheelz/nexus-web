# resource menu device qualification

physical handset touch/soft-keyboard, real ime composition and spoken screen-reader
qualification remain unrun for the podcast/library menu cutover. browser geometry,
keyboard, focus and accessibility-tree checks do not establish those observations.

affected owners: `components/resources/ResourceActions.tsx`,
`components/podcasts/PodcastLibrariesDialog.tsx`,
`components/collections/CollectionConsumptionDialog.tsx` and
`CollectionLecternDialog.tsx` under `apps/web/src/`.

resolved when a real handset and spoken assistive-technology pass confirm menu
availability, named scopes, chooser/review focus, selected/blocked destinations,
ime-safe filtering and recovery after dismissal. no product defect is established;
the missing evidence requires the corresponding device/input setup.

installed-app qualification must also drop remote admission while a review is open
and during progress preparation: no new request/uncertainty, no lost undo, and no
automatic replay after reconnect. those admission guards are source-reviewed;
the ordinary web lab starts admitted and does not exercise the native transition.

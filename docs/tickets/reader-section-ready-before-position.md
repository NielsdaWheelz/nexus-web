status: open
origin: 2026-09-14 bounded reader cutover, client review
area: reader navigation and durable progress

`MediaPaneBody.tsx::navigatePublicationSection` saves the resolved locator as
soon as the unit-window request returns `Ready`. that receipt attests admission;
it does not attest that the prepared root mounted or reached its source point.
a held preparation can therefore acknowledge movement before visible movement.

route section, authored href and overview contents commands through the existing
prepared-root positioning operation. preserve the exact resolved epub locator,
including equal-offset section identity. a newer command or genuine input must
cancel old positioning and capture.

acceptance: hold actual preparation, supersede the command, then commit the old
root. no stale scroll or durable write; a live command positions first and saves
the exact selected source locator afterward.

producer-formed edge pending composed verification: publication's table archive
contains an opening-only `td` that owns its original anchor at canonical cp 6,
while its rendered suffix ends at cp 5. the next continuation drops the original
id. `publicationApparatus.ts` must position the retained structural marker or
owned source boundary while preserving cp 6 in the saved locator; clamping the
saved offset to rendered text would change provenance. actual emitted archive
fixture and browser proof are still pending (2026-09-14 publication review).

2026-09-14 actual composition: `360eb70af1135ecf` passes normal and failed-read
retry positioning with the exact retained locator, trusted-scroll withdrawal of
both commands, and concurrent navigation-hold conservation. true reds were
`c3d9f3383d00e664` (old response replaces current source) and
`db4f39002c4d8b9f` (window-only retry saves the wrong locator).

remaining retry path: `waitForPublicationUnit` settles `{kind:"Failed"}` on a
real `publicationRenderDefect` (`MediaPaneBody.tsx:2725`) without returning its
error. `positionPublication` therefore returns Unavailable and the generic render
retry outlives its semantic command. preserve the original target through that
existing error owner too; demonstrate actual preparation failure/recovery before
closing this ticket. the actual table fixture is now retained at
`testdata/offline-reading/source-table-schema-2-members.json` (sha256
`d0ae33c2a0eea0a2aa219354b19b8197e037da7bd9c577a6b51f430da02e5184`);
its opening-only cell boundary is cp 948, with render end 947.

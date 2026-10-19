# landscape dialog keyboard clearance

status: unverified reachability; portrait passes
origin: 2026-10-16 principal-actions physical qualification, source `42069aa1`
area: web / dialog viewport

physical android chrome155, landscape, real ime: visual viewport height74csspx;
new-library close spans y−4..40, name41..85 and actions97..141. controls extend
outside the visible viewport. portrait360px, real ime, has all controls visible
and native back hides the keyboard before closing the dialog.

the landscape assertion required simultaneous visibility; native body-scroll
reachability was not checked. this is not proof that submission is impossible.
`Dialog.module.css` currently reserves header padding inside its bounded panel.

reproduce with an ordinary new-library dialog and landscape ime. establish
whether field/close/submit remain reachable by native scrolling; if obstructed,
repair the existing dialog/viewport composition. no feature-specific overlay.

acceptance: truthful native landscape keyboard/scroll/back proof, with affected
dialog consumers checked if their shared geometry changes.

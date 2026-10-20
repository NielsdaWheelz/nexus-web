# qualify find-only inspector focus across presentation changes

problem: the action-menu sheet header change moves specialized inspector headers
outside the retained body. the find-only header has no tab fallback. source review
found and repaired its close-button focus restoration, but its exact live path
still needs qualification.

evidence: `components/workspace/Companion.tsx` captures removed header focus and
restores the replacement close after refs commit. `ArtifactPaneBody.tsx` supplies
the find-only case. settings has no pane find; ordinary resource inspectors have
tabs. no supported provider-free command publishes a completed dossier document.

qualification: open a real completed dossier's find results, focus its sheet x,
cross to column layout, and verify focus reaches the corresponding column x.
also verify retained body state and no competing focus theft. use a real generated
artifact; do not insert internal publication records or fabricate read facts.

resolved when that exact route passes on the served implementation.

# workspace recovery promises durability it has not established

status: open
origin: 2026-09-13 second-tab council; head `7fa89b88c8`; production `7e8fd48244b3b436965037738e05785bb4931be1`
area: workspace recovery / user trust

`apps/web/src/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx:47`
unconditionally promises that the user's data is safe. this boundary also
catches failures after editing and navigation; it does not inspect pending
writes or locally retained drafts. `useWorkspaceSession.ts:32–35,57–58`
advances its saved snapshot before acknowledgment, so even layout durability
is not established. this is not evidence that document content was lost.

prerequisite: define the separate durability states of document edits,
navigation layout, and selection history.

fix: remove the unconditional assurance. recovery copy must distinguish
acknowledged changes, recoverable local drafts, and unresolved pending work
when those facts are known. preserve recoverable work before remounting its
renderer; do not invent a saved state to make recovery copy reassuring.

acceptance: bootstrap failure and failure with pending work present accurate
recovery copy; retry restores independently verified recoverable state.

# verify feedback with the native reader and player

status: open; device verification pending
origin: 2026-10-16 compact feedback cutover
area: android / shelf / playback / offline

the shared feedback adapters compile, but this campaign did not execute native
download, playback recovery or shelf bridge failures on a device. browser
viewport checks do not prove native bridge behavior or player/keyboard clearance.

evidence: changes in `components/player/GlobalPlayerSurfaces.tsx`,
`lib/actions/project.tsx`, `shelf/Shelf.tsx` and `shelf/ShelfReader.tsx`;
the static gate builds the shelf, not the android runtime.

prerequisite: an isolated app/device connected to a working fixture stack.
exercise a failed download, playback failure, sync recovery and shelf source
failure with player/keyboard visible. preserve their existing command owners.

acceptance: correct local/shared feedback, supported retry, retained busy action
and unobscured primary controls; no replacement of native operating-system feedback.

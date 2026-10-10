# the media pane's retrieval status stays stale after a search repair

status: open · origin: 2026-10-10 content index reauthor harness (U1, branch cleanup/content-index-reauthor) · area: web media pane / imports

after "Rebuild search index" on the imports page publishes, an open media pane
keeps showing the dead index: its banner still reads "Search indexing stopped"
and its info overlay keeps `retrieval availability: suspended` while it stays
open, until the overlay is reopened or the page reloaded. the pane loads the
media once (`app/(authenticated)/media/[id]/MediaPaneBody.tsx:97-105`) and
streams processing snapshots only while processing is not terminal
(`lib/media/useMediaProcessingStatus.ts:49-52`); a readable media's index changes
(`pending → indexing → ready`) never reach it. `MediaInfoOverlay` loads when it
opens (`components/media/MediaInfoOverlay.tsx:370-382`). harness: U1 first waited
on the open overlay and timed out at `suspended` while the index was `ready`.

fix: refresh the pane's media (or just its retrieval facts) when the viewer's own
repair is admitted, or keep the processing stream until retrieval settles.

acceptance: with a media pane open on a suspended index, repairing it from the
imports page turns the banner off and the open overlay to `ready` without a
reload.

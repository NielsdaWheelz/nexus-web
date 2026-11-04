# podcast play can fail during a reread

starting playback from a show's episode list refuses while its strict read is
in flight or failed. passive unchanged polls are silent, but changed poll data
publishes `Entries` and can trigger that strict reread.

evidence: `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
checks `episodes.refreshing` and `episodes.error` in its source capture. current
main uses `E_PLAYBACK_REFUSED`, with “this list is still loading.” or “this list
couldn’t refresh.”; it no longer mislabels this as a lost connection.
`LibraryPaneBody.tsx` has the same freshness boundary.

actual occurrence: lab `20261101-212711-a69f1560d9f3`, firefox, pressed about one
second after opening the show, during its 1012–1111ms reread. no snapshot or
player request followed. an android run hit the same refusal. a later retry works.

impact: an ordinary press during a reread can fail. source capture sends a
server-side query, but changing its gate requires checking the visible-source
capture contract first. resolve when play during a held reread safely captures
or waits without reporting a preparation failure for ordinary loading.

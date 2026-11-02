# podcast play can fail during a reread

starting playback from a show's episode list refuses while the pane's read is in
flight or not current.

evidence: `PodcastDetailPaneBody.tsx:468` throws `ApiError(503,
"E_REMOTE_UNAVAILABLE", "requires a connection and current episode facts")` when
`episodes.refreshing` is true or `episodes.fresh` is false. a followed show polls
every 60s, or every 3s during work (`:217`). found by reading; not reproduced, and
the caller's handling of the throw is unread.

passive reads removed the unchanged-poll case: a passive read no longer counts as
`refreshing`. it stays open because a poll that sees changed data publishes
`Entries`, moves the pane's own stale stamp and rereads, so play can still refuse
during an import. `LibraryPaneBody.tsx:351` has the same gate.

impact: play can fail intermittently, with a message that blames the connection.

proposed fix: since `capturePlaybackSource` sends a server-side query, not the
loaded rows, afaict the gate can drop to connection and failure. check that against
the capture contract first.

resolved when play from an episode row succeeds while a reread is held in flight.

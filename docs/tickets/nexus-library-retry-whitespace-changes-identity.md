# whitespace edits change an uncertain launcher request identity

status: open; separate from the libraries pane change
origin: 2026-10-14 design review; reconfirmed on current main `69c00182c`, 2026-10-15
area: web / nexus library replay

`apps/web/src/components/nexus/useNexusController.ts:266` trims submission, but
`setLibraryName` at466–476 mints another id after a retryable failure whenever
raw text differs. a trailing space therefore submits the same normalized name
under another id. `python/nexus/services/libraries.py:create_library` replays
by id/owner, and names are not unique: a committed request with a lost response
can become two libraries. the pane now freezes its attempt; launcher ownership
was explicitly excluded from that change. source confirmed, not exercised in
production.

fix: bind retry identity to the normalized submitted command, retaining its id
across whitespace-only edits and repeated attempts.

acceptance: commit a request and lose its acknowledgement, edit edge whitespace
and retry; the submitted id stays unchanged and exactly one library exists.

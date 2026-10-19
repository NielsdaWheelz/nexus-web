# collection keyset continuations: release steps

status: open until the release that carries the collection-revision cut.
origin: 2026-10-10 collection-revision cut (branch cleanup/collection-keyset-continuations,
coordinator review R5, R6).
area: release / lists.

- web and api deploy together (`deploy/hetzner/deploy.sh` does). the list
  responses lose `collectionRevision`, four deletes answer 204, and
  `PATCH /libraries/{id}` answers `Data[LibraryOut]`.
- migration `0275_drop_viewer_collection_revisions` (after model tools'
  `0274_one_tool_call_record`) drops
  `viewer_collection_revisions` and its rows. irreversible; the release's
  pre-migration backup is the only copy. the rows are derived counters (at most
  six per user, no other meaning, no table references them), so it needs no
  preflight. optional read-only census before the window:
  `SELECT family, count(*), max(revision) FROM viewer_collection_revisions GROUP BY family;`
- accepted trade-offs: a tab still on the old bundle shows pane errors on its
  lists until reloaded; every cursor held at deploy (a pane mid-drain, an open
  destination search, an agent read-tool cursor) answers `400 E_INVALID_CURSOR`
  once (the web offers Refresh list, the read tool its `invalid_cursor` refusal).

acceptance: production at a release carrying the cut; delete this ticket.

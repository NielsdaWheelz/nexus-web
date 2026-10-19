# release: media, owed owner checks

status: shipped; owner checks owed
origin: metadata and intelligence (0284), media core (0285); shipped in
`83459f1b8` and `fdd0a3e` (schema 0287, wire 2) on 2026-10-15
area: release / media

done: 0284's in-transaction guard passed. it kept 403 of 418 ready identities,
and the newest stale unit dates from 2026-07-23 17:08 utc, before the cutoff.
0285 ran after it (book campaign `coordinator/final83459/canonical-release/root-review.json`).
`MEDIA_TEARDOWN_CLEANUP_GRACE_SECONDS` is absent from the published keys
(`coordinator/final1c07/env-published-readback.json`). metadata research and
no-findings review need a working `web.search`;
[imports metadata proof](imports-live-metadata-proof-needs-working-search.md)
owns them.

owed: no release record shows these in production.

- leave a settled media pane open for five minutes. the vercel function log
  shows no metadata stream for it.
- a chat citation of a document shows its abstract.
- ask for a media dossier right after a capture; it waits for readable content
  and completes.
- open a failed import's pane: its title, explanation and open source.
- remove a document from a row menu; it leaves every list at once. remove again
  from a stale menu; no error. a minute later its row and objects are gone.
- open a pane while an import extracts. the preparing notice clears by itself
  once the index is ready.
- leave a podcast episode pane open. the vercel function log shows no lingering
  processing stream.
- on an episode with no transcript requested, request one from its row menu.
  the pane follows it to queued, then to the transcript, without a reload.
- on a media pane with a stopped index, rebuild the search index from imports.
  the banner goes without a reload.
- refresh an x post from its row menu. it stays readable, a title job follows,
  and the open pane takes the new title without a reload.

delete this file once the owner has run these or waived them.

# release notes re-slice

hard cutover: api, both workers and web ship from one release. the server half
(outline replies, scoped retention, capture as one batch, code text without marks)
and the web half (the write queue, then the outline engine) may land in consecutive
releases, server first; the web engine needs the server half. no migration, no wire
revision change (replies keep their shapes and only shrink), no apk, extension or env
change.

release steps:

1. preflight on the newest production backup (mac only, disposable, deleted after),
   count-only:
   - marked text inside a `code_block` must be 0: `validate_body` now refuses it,
     and a stored one would fail its next save. above 0 needs a migration that
     strips those marks before this release.
   - facts by another user incident to a page or note, to what it owns (passage
     anchors, evidence spans, content chunks) or capturing it, must be 0: retention
     now counts only the owner's own. above 0 needs owner-agnostic retention (edge
     indexes on source and target) before this release.
   - bodies over 4,000,000 bytes: each is listed for the owner, since the web now
     refuses a body over the 4.5 MB BFF cap at build.
   the 8a67 restore (0304) counted 0, 0 and 0 on 2026-10-21.
2. after deploy, owner smoke on desktop and phone: type in a page note, then press
   enter in a child row of that note within 1.5 s (lands); paste a 5 MB image into a
   note ("note change not confirmed"; other notes keep saving); with today's day
   latent, type in its draft and send a launcher `/n` capture before the draft saves
   (one page, both items, no "saved in another tab"); undo and redo three steps across
   a split; drag a row before, after and inside another.
3. for 24 h after deploy: no rise of `outline_commands exhausted` in the api log; the
   rate of `GET /resource-graph/outline` while typing falls; p95 of outline reads for
   pages with notes falls.

resolved when the release carrying both halves has run these steps and recorded
them; then delete this file.

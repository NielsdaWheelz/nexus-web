# release notes re-slice

status: #734 already shipped in production `dc12792e0` (schema 0312, wire 14):
outline replies, scoped retention, capture as one batch, code text without marks
and the then-current web write queue. the outline engine rewrite (P2) was dropped; the main
defects only it fixed are recorded as their own issues. no migration, no wire revision
change, apk, extension or env change was needed. the remaining census and log
observation below are not established by deployment.

remaining checks:

1. census on a current production backup (mac only, disposable, deleted after),
   count-only:
   - marked text inside a `code_block` must be 0: `validate_body` now refuses it,
     and a stored one would fail its next save. above 0 needs a migration that
     strips those marks before affected writing can be saved.
   - facts by another user incident to a page or note, to what it owns (passage
     anchors, evidence spans, content chunks) or capturing it, must be 0: retention
     now counts only the owner's own. above 0 needs owner-agnostic retention (edge
     indexes on source and target) at the retention owner.
   - bodies over 4,000,000 bytes: each is listed for the owner, since the web now
     refuses a body over the 4.5 MB BFF cap at build.
   the 8a67 restore (0304) counted 0, 0 and 0 on 2026-10-21.
2. 24 h of api observation: no rise of `outline_commands exhausted` in the api log; the
   rate of `GET /resource-graph/outline` while typing falls; p95 of outline reads for
   pages with notes falls.

delete this file once these existing-data checks and the observation are recorded.

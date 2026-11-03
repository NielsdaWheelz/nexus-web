# an expired confirmation cannot settle an earlier unanswered confirmation

status: open · origin: 2026-11-02 import repair · area: uploads / extension

`confirm_session` reads `published_at` without a row lock before checking expiry
(`python/nexus/services/media_upload_sessions.py:681-696`). an older confirmation
may already hold the publication lock, have passed its final expiry check
(`:716-740`), and still have an uncommitted publication. `_now` uses transaction
`now()` (`:1129-1130`). an overlapping retry can therefore answer
`E_UPLOAD_CAPABILITY_EXPIRED` from an older visible row while publication can
still commit. that answer does not prove the earlier request failed.

the extension must retain `Check` after an earlier unanswered confirmation. if
nothing published and expiry is all later retries report, it cannot safely offer
start over as a settled outcome. the user can still discard the local draft.

resolve at the upload owner by giving confirmation an authoritative terminal
answer serialized against publication, without changing the frozen request.
prove both overlaps through real confirmation requests: an older publication
commits and replay reports it; or publication cannot commit and replay settles
expired. do not substitute a database status/expiry edit for those races. the
server contract change and overlapping-expiry lab are outside this popup repair.

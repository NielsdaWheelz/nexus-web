# accepted url replay requires current destination write access

status: open, source-qualified; runtime not reproduced here.
origin: 2026-10-04 add-content adversarial review at `f2167baf3`.
area: url source admission / lost-response recovery.

`python/nexus/services/media_source_ingest.py:697` validates writable
destinations before `_accept_url` looks up the exact viewer/key/intent replay
at `766-770`. `library_governance.py:761-781` rejects a deleted or no-longer-
writable destination with `E_LIBRARY_FORBIDDEN`. an already-committed import
whose selected library access was later revoked therefore returns a refusal
on exact check-status replay, despite requiring no new filing. the browser
cannot recover that accepted identity from this command. this is a verified
ordering defect, not a reproduced data loss.

reproduction: accept a url into a shared named destination and lose the response;
revoke destination write access; resend the original body and idempotency key.
the current route rejects before observing its accepted attempt.

prerequisite: admit the source command's replay/authorization ordering
separately from the add browser rewrite. authenticate the same viewer and
validate exact intent/key, then return its existing accepted result before
checking authority needed only for a new destination mutation. retain all
current authority checks and transactional rechecks for first admission.

acceptance: the exact lost-response replay recovers its original media/attempt
identity after destination deletion or access loss, without inserting a job or
restoring placement. a fresh key still refuses unwritable destinations, and a
changed intent under the old key still conflicts.

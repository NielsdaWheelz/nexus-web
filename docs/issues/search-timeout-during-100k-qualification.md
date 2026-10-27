# remote search timeout during 100,000-note qualification

run `20261027-002018-aaeea68ffeea` logs one server `E_SEARCH_TIMEOUT`504 at
2026-10-27T07:47:16.651Z, request `31e1f81f-59ff-4d36-94dc-02c1ca9728ad`
(api.log:3062). the corpus contains100,000 previously edited notes. no cause
or local-search latency failure is established. later499 search failures are
explicit client cancellations and must not be counted as further timeouts.

this concerns the separately failable server search lane. local authored search
passed its unchanged firefox measurements; that does not diagnose this remote
query.
resolve with attribution of the timed-out query/plan and a repeated equivalent
server request within its existing budget; preserve local result availability.

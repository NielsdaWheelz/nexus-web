# reader content requests materialize entire documents

- status: open
- origin: 2026-09-13 second-tab investigation; revision `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: reader api memory and content delivery

## evidence

`python/nexus/services/media.py:1310-1360` selects both sanitized html and
canonical text for every fragment, calls `fetchall()`, creates a complete model
list, and attaches embeds. `python/nexus/api/routes/media.py:161-169` returns the
entire list as one json response. the path has neither a content window nor a
response-byte budget. deployed revision
`7e8fd48244b3b436965037738e05785bb4931be1` contains the same implementation.
concurrent requests multiply these materializations; the input size controls
the per-request allocation.

read-only production aggregation on 2026-09-13, restricted to the media id in
the user's cursor error (`043e7f93-bff0-4e6d-8c2e-ff684288641c`), finds 977
fragments: `3720452` bytes of html and `2923318` bytes of canonical text, about
6.34 mib combined. the largest combined fragment is `419953` bytes. the query
uses `octet_length`, a read-only transaction, and a two-second statement timeout;
no document text was retrieved. those are stored content bytes, not measured
response size or request peak memory. model/dictionary/json representations
add allocations; they need not each copy every underlying string.

this is a confirmed resource-scaling hazard with measured source size. api
memory kills are independently confirmed, but no allocation trace yet attributes
the incident to this endpoint or proves it was in flight at the kill.

## prerequisites and fix

measure the failing media's response sizes and peak request memory; identify
which reader surfaces still require this endpoint. specify a maximum resident
content budget while preserving complete reading, search, and stable locators.
deliver revision-pinned fragment/content windows with explicit continuation and
fetch only the needed representation. preserve whole-document positions in
metadata; do not silently truncate content. make ingestion's supported maximum
unit size consistent with the request budget.

## acceptance

through `./scripts/test`, use real large-document data and concurrent reader
requests to verify bounded per-request memory and bytes, complete traversal,
stable locator/progress semantics, and controlled generation changes. preserve
authorization on each window. capture a failing budget proof against the
current whole-document response before accepting the fix.

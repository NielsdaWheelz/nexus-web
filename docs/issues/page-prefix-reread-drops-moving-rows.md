# a page-prefix reread can miss a row whose sort key moved between its pages

**problem**: `usePagePrefix` (`apps/web/src/lib/api/pagePrefix.ts`) rereads a loaded prefix
one keyset page per request. a key that moves between two of those requests (a History row's
`matched_at` when a newer matching event lands, `services/imports.py`; a metadata history
entry's time, creation then completion, `services/metadata_operations.py`) can put the row
behind a cursor already passed. the duplicate half is fixed in the readers (Imports dedupes
rows by ref and history entries by id); the missing half remains.

**impact**: a row or history entry is absent from the loaded prefix until the next
observation (at most one poll, 5 s, while work runs; the next wake otherwise). nothing is
lost; the count line can read one short meanwhile.

**evidence**: design Q14 (2026-10-15/imports/design.md); `pagePrefix.ts:24-29` (one request
per page); shared with the assistant writes log (`AssistantWrites`).

**resolved when**: a prefix of at most 200 rows rereads in one request (raise the list and
history `limit` cap and ask for `pages × page size` at once), and a harness journey moving a
row's key between two page reads (route-level delay) shows it present in the reread.

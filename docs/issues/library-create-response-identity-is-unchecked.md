# library creation does not check acknowledgement identity

status: open
origin: 2026-10-14 libraries specification review; refreshed 2026-10-16 at `69c00182c8328f46cec893517971f87f03cdbf16`
area: web / library command boundary

`apps/web/src/lib/libraries/api.ts:62-73` publishes a library change and
returns `response.data` without checking its id against submitted `input.id`. a mismatched
acknowledgement could make create-and-open target another library and discard
the original attempt. source-confirmed contract gap; no bad response observed.

prerequisite: none. compare the returned id with the submitted id inside `createLibrary`
before publication/return, as specified in the
libraries creation plan (#629). no new decoder,
endpoint or launcher-state change. the former client/contract helper no longer exists;
do not recreate it merely to satisfy stale implementation references.

acceptance: mismatched acknowledgement raises the existing contract defect
before publication; the pane retains its submitted attempt. a matching response
publishes normally and permits same-id replay and navigation.

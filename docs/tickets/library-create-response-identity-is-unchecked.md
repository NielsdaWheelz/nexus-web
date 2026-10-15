# library creation does not check acknowledgement identity

status: implemented; final physical acceptance pending
origin: 2026-10-14 libraries specification review; source `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: web / library command boundary

implementation and browser evidence: [verification receipt](../libraries-creation-verification.md).
keep this cutover record until the remaining physical acceptance and final cleanup.
the findings below describe the pinned baseline.

`apps/web/src/lib/libraries/client.ts:107-125` publishes a library change and
returns `response.data` without checking its id against `libraryId`. get and
rename use `libraryOutForId` from `lib/libraries/contract.ts:34-45`. a mismatched
acknowledgement could make create-and-open target another library and discard
the original attempt. source-confirmed contract gap; no bad response observed.

prerequisite: none. use that existing identity check inside `createLibrary`
before publication/return, as specified in the
[libraries creation plan](../libraries-creation-plan.md). no new decoder,
endpoint or launcher-state change.

acceptance: mismatched acknowledgement raises the existing contract defect
before publication; the pane retains its submitted attempt. a matching response
publishes normally and permits same-id replay and navigation.

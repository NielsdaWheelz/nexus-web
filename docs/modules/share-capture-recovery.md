# share capture recovery

status: implemented; integrated local browser proof and latest-parent static passed
origin: 2026-10-02 cleanup; base `fe26c52b2a49afc19ded58effaa4dc971f943206`

## baseline behavior

[`ShareCapture.tsx`](../../apps/web/src/app/share/ShareCapture.tsx) owns capture results. `/share` deliberately stays
outside the authenticated shell; its server admits active/refreshable cookies
and shows a separate sign-in card for anonymous/ended sessions. plain text
reads `/api/me` for its calendar time zone before capturing. an account
`401 E_UNAUTHENTICATED` reached the network-only formatter and threw
during render. the plain-text command catch already shows inline auth guidance.

## specified behavior

an actual account auth failure yields the existing Unauthenticated result:
“Sign in to save this”, “Open Nexus, sign in, then share again.”, its public
request id and Done. the screen retains trimmed shared text and `/share`, offers
no auth Retry, starts no login navigation and sends no capture mutation. exact authentication
means the existing `isUnauthenticatedApiError`: ApiError, status 401, code
`E_UNAUTHENTICATED`. other errors keep their strict classification.

one private complete projection,
`failedCaptureResult(label: string, error: unknown): Extract<CaptureResult, { ok: false }>`,
serves account-derived render and the plain-text command catch. auth is first;
otherwise it refuses non-ApiError or code other than `E_NETWORK`. it uses
`apiTransportFeedback(error, "Couldn’t save")`; null throws the original error.
the Capture failure carries that feedback. render throws directly for defects;
the async catch still sends them through `setDefect`. the redundant same-system
predicate import is gone. state, effects and the module interface are unchanged.

network wording deliberately changes: “Check your connection and retry.”
becomes canonical “Check your connection and try again.” retry behavior and
request ids stay unchanged. the URL auth branch still omits request id.
URL selection/destinations/concurrency, success Open targets, frozen plain-text
local date/note id/mutation id and per-URL replay keys remain unchanged.

| surface | shell target | browser target |
| --- | --- | --- |
| URL preview Save + Cancel | Cancel: `nexus-share://dismiss` | Cancel: `/lectern` |
| empty/result Done | `nexus-share://done` | `/lectern` |
| anonymous server Done | `nexus-share://dismiss` | `/` |

## verification receipt and limits

2026-10-02: the one production file went from 451 to 429 lines. an independent
verifier used production Next bundles with isolated local auth/api/postgres;
the reviewer checked the exact source, oracle, dump and receipts.

| run | result |
| --- | --- |
| original baseline | 70/82; ten intended auth reds, two wrong database-scheme filters |
| corrected baseline | 72/82; only ten intended inline-auth reds |
| candidate | 82/82; no escaped page error or incomplete scenario |
| fresh-main integration | 82/82 with the same oracle and restored dump |
| static gate at the tested integration | passed; canonical migration head `0252` |
| static gate after #434 | passed; canonical migration head `0252` |
| latest-parent static gate | passed; canonical migration head `0252` |

the oracle correction changed only `note` to the actual `note_block` scheme in
two persistence filters; the original receipt remains preserved. both later
runs used the same corrected oracle and restored prewrite dump. real admitted
SSR followed by same-context app signout and unchanged hydration scripts
produced natural account 401. candidate displayed its exact public request id,
retained text/path and Done without Retry, login navigation or capture writes.
the same terminal result followed settled network failure then signout/Retry.

all three automatic account GET attempts settled before manual Retry reached
real account/capture success. a real first capture was accepted with 201, its
browser response delivery was lost, and manual Retry sent the identical URL
and raw body; the second 201 returned the same result and every application
table remained unchanged after the first acceptance. anonymous entry, empty
share and URL preview retained their distinct callback hrefs; no URL was ingested.

tested runtime: base `fe26c52b2a49afc19ded58effaa4dc971f943206` plus only the
frozen uncommitted ShareCapture edit, sha256
`dc17b5c7920eea9973575ae9834d7dd5f437dece08c287ce338239cce48ea8ad`;
baseline file sha256 `6928006ea2a3b0a7cca884f10f53eb3246e4e08e17ed4c725e5cf239ebfa262c`.
corrected oracle sha256 `1ea1d78f4dc7321df1ff9b43a36d6732d28d9cbaafa6391b8b150fa9591ceddd`.
that pre-integration receipt is separate from the later actual integrated run:
main `aea51d2b35d4c35b291051c3c25f5f11de7468fe` (including #432/#433) plus
the unchanged ShareCapture edit. the real API restarted and production Next
rebuilt from that source; the same oracle/dump passed 82/82 with no escaped error
or incomplete flow. this is isolated local evidence; production was not run.

`./scripts/test` passed on the integrated working Git tree
`99b910e2323359d38f9522781e50242be6a537c6`, base `aea51d2b3`, with all seven
owned source/docs paths. later integration onto main
`17e5e054d9448a39f72402cdb1ff11a75796dd9a` (#434) preserves all 26 qualified
owner hashes; its search/citation projection changes are outside the executed
share boundary and were source-reviewed. the actual browser runtime above
remains `aea51d2b3`; no new live run is claimed for that later parent. refreshed
`./scripts/test` passed on working Git tree
`ffd188f1f175c025206481ca0fa5762bfd0eb5e7`, base `17e5e054d`;
this final receipt edit changes documentation only.

the later release parent `eff06297813af3323a00f28a44bfa8767756cf4a` (#435)
consolidates media-kind ownership; all 26 qualified owner hashes and fixed web
kind values remain unchanged. that transfer is source-reviewed, without a new
live browser claim. `./scripts/test` passed on working Git tree
`0bd39e94a201bf134e4482d2acfb93b66a93477e`, base `eff062978`;
this final receipt edit changes documentation only.

callback execution/device, external URL ingestion, production, private-helper
classification and command-auth live cases were not run. exact classification
and command defect routing were source-reviewed. no maintained suite or product
probe seam is added. temporary proof is removed after integration/review;
the scoped default-false [auth contract](browser-session-recovery.md) stays intact.

# mobile command palette verification

status: feature qualified on its isolated baseline; task cleanup and final static gate complete.
origin: 2026-10-16 pacific / 2026-10-17 utc. contract: [implementation plan](mobile-command-palette-plan.md).
real isolated services, ordinary password sign-in and product apis; temporary
node/playwright 1.59.1 campaigns, no fake auth or production test seam.

## final served feature

- baseline: `4d5970de7dd3963d7862a6e3db3b99feb2f68925`, wire 1.
- final implementation: `e4beffb354095c5a9bd66bae6143b735caeb3eec`; no uncommitted implementation.
- implementation-tree sha256: `3f0888fe397eed452f9e8424b366f1011ae014a17f9bb6a4211b4261bbc06e10`.
- production-mode next build: `XSSKjRakmttUpD-RchRmP`; api/web `/version` agree on
  the implementation; database head 0287, generated wire 2.
- 21 fetched assets; sha256 `5864c29e6e87ac3d778ac559c81f172f67190b84f57091f77a6de41fe5e6cf02`
  over compact, key-sorted asset-manifest json; witnessed `2026-10-17T02:53:01.330Z`.
- matching debug apk `app.nexus.android.debug`, wire 2, sha256
  `c9b8fe5bc0656e9dee4d13ad559dbd5c4a273acec1cada883ea82e6801de0052`; installed bytes verified.

## red, green, refactor

unchanged-baseline runs exposed eight real contract failures and two submission
failures. setup failures were excluded. subsequent genuine regressions proved
modal focus cancellation, pointer-independent workflow origins, desktop chooser
return across a breakpoint, native rotation state loss and a native bottom tap
hitting home. each was repaired at its existing owner and rechecked.

reset proof: six workspace sessions removed; only `workspace_sessions` and
`alembic_version` changed. all 93 other tables compared identically, including
nonempty media, pages, library entries and consumption data. no deployment ran.

on `12a0141b`, all 32 chromium browser cases passed; the separate api rerun
passed 28/28 with no skips. two startup 502s in the initial combined run remain
classified as setup failures, not erased. coverage included:

- cold inactive/minimized/duplicate identities, every dynamic route, 101 distinct
  locators in bounded batches, shared chrome/manager/document names;
- live/acknowledged text versions, genuinely uncreated notes, empty-title clearing,
  hints through fork/history/reopen, real previews, stale replies and retry;
- nullable visibility and foreign-resource privacy, strict locator/hint validation,
  daily reads without writes, old-shape rejection and wire 426 before saving;
- overview/search/submission/composition, partial results and retained-query failure,
  finite workflow returns, destination focus, direct close, final-tab replacement,
  resource menus, desktop behavior, three themes and 320px controls.

a real title-query cancellation produced 500/`E_INTERNAL` and local telemetry.
the editor and retained title survived; session save was 204, independent outline
read 200, explicit title retry 200. no content rows were mutated.

firefox passed 14 changed journeys. webkit exposed a real pointer-focus assumption;
its repaired campaign passed 14/14. the final source passed seven changed
geometry/input/workflow cases in EACH of chromium, firefox and webkit: 21/21,
no skips, retries or flaky results. unaffected proofs above carry only across
unchanged contracts; they are not described as fresh full runs.

## physical android

samsung sm-s906w, android 16/api36; chrome 155.0.8059.79 and system webview
154.0.8037.106. ordinary sign-in, twelve-tab overview, native ime search/full
search/destination focus, keyboard-first Back, manager active-close, finite
`UseText` return, resource menus, account/import access, native Downloads shelf
and return, done/opener focus, and real rotation all observed working.

source lineage: chrome core ran against the frozen `c89406ecd` server; its
receipt lacks a source field, while the separate account continuation reports
that source. native core/downloads ran on `acd0e37a9`; final targeted geometry,
ime and rotation ran on `e4beffb35`. no full phone rerun on the final source is claimed.

final geometry proof: actual adb tap reaches new above native navigation;
its bottom is approximately 732px in a 780px viewport with a 48px native inset.
import footer ends at 732px. with the real ime, task/visual bottom is 477px and
residual safe padding is zero. rotation preserves the same live webview and draft.
phone checks were split into core and targeted continuation receipts after
badge-name/capture-buffer/ime-animation harness mistakes; none is counted as a
product pass until the corresponding real observation succeeded.

restoration: original apk sha256
`6108334f763367d174337af6f9d7598ee3839f205566ea6600162082af7340dc`;
110 original data entries equal by bytes/modes/types/symlinks; original mappings
and rotation equal; owned phone mappings/files removed. both original chrome
targets survived each owned context close. after an adb reconnect, find observed
both original ids absent before its own context; final tab/account preservation
remains [unconfirmed](tickets/mobile-phone-final-chrome-target-witness.md).
mobile, find and pane-tabs have released their explicitly sequenced windows;
the phone queue is closed. pane-tabs' earlier ownership ledger identifies
forwards 52905/52319 and reverse 3296 as its allocations. their final removal is
accepted as owned cleanup; final raw mapping equality is not claimed.

## limits and cleanup

physical ios and gesture-navigation mode are unqualified; desktop webkit is not
ios. accessibility qualification was waived. background/process-death persistence,
global summary failure policy and creation-completion lifetime remain separate.

main integration is NOT qualified by this isolated run: [reader/menu ordering](tickets/mobile-palette-reader-menu-integration.md)
and [migration/wire rebase](tickets/mobile-palette-cutover-rebase.md) are explicit prerequisites.
main already uses wire9/head0291; never replay this wire2/reset0287 unchanged.

cleanup complete: task-owned campaigns, drivers/dependencies, fixtures, credentials,
backups, isolated build outputs and services removed. shared caches retained;
other sessions untouched. unchanged `./scripts/test` passed after deletion,
including the single-head check. this sanitized record remains; no continuing
behavioral suite remains, as requested.

# feedback cutover verification

date: 2026-10-16
baseline: `69c00182c8328f46cec893517971f87f03cdbf16`
candidate: this commit, branch `codex/feedback-cutover-20261016`
contract: [feedback plan](feedback-plan.md)
status: browser acceptance and post-cleanup static gate passed; runtime limits below remain open

three implementation specialists supplied feature content and reviewed one
another's boundaries. the integrator reviewed ownership, exact replay, copy,
cutover removal and the assembled application. fixes were made before accepting
green, including conditional strict-mode handoff, stale command replacement,
note settlement, retained document refresh and a duplicate admission host.

## actual application

the finite campaign used isolated auth, web, bff, api, postgres, object storage
and real source/index workers. fixtures entered through product interfaces.
faults delayed or dropped real transport; no successful domain reply was invented.
the immutable baseline ran separately against the same owned fixture services.

| journey | baseline observation | candidate observation |
| --- | --- | --- |
| combined browser oracle | six intended failures; native browse anchor already passed | seven pass after refactor; no skipped or flaky case |
| workspace | required save could be dismissed; literal severity column; retry vanished; unrelated controls survived modal opening | owner condition cannot dismiss; compact summary; actual pending retry retained; modal defers unrelated controls |
| finish inverse | actual finish returned 200; undo disappeared after 11.1 seconds | exact inverse survives delay and pane closure; busy control stays mounted and cannot dismiss; committed 204 with lost reply becomes required recovery; explicit retry sends identical receipt; superseding unread retires it |
| source refresh AND metadata research | actual accepted 202 lost its reply; timed confirmation disappeared and reload retained no record | final frozen-source rerun passed all twenty checks: both persisted before post, survived 11.1 seconds, origin closure and genuine browser-process restart; zero startup posts; simultaneous two-tab confirmation sent one post per operation, with original expectation; records and both views cleared after acknowledgement |
| saved text position | initial cursor failure had no visible remedy; adoption was direct | visible typed retry; no progress write before cursor recovery; busy retry retained; return direct, adoption disclosed |
| real pdf | no pdf-specific baseline claim | genuine 35,736-byte upload parsed/rendered four pages; all fourteen checks pass, with two real cursor reads and two writes; held excursion sends nothing, return restores exact scroll position, disclosure sends nothing, explicit adoption advances the persisted page/revision; 390px disclosure remains inside viewport |
| capability | reopening readable but unindexed media made no processing subscription | genuine second url import reopened while readable/search-pending; local find worked; same open metadata dialog observed actual index completion without reload; terminal stream returned state/done |
| module delivery | source audit showed catch-all remount recovery | actual atlas chunk delivery aborted; only explicit app reload offered; restored chunk returned 200 after reload and atlas rendered |
| link/refused outline | pre-existing unsupported retry documented by source | real missing-target 404 has no retry, including after dialog close; committed link 201 with lost reply retains exact busy replay; deleted page's refused insert leads to visible unavailable state and blocks its stale editor |
| text settlement | source review caught premature failure clearing and later false residue | real invalid-title 400 remains visible until settlement; returning to acknowledged value clears it; real newer-title 409 followed by use-saved clears it |
| public/breadth | existing route contracts retained | anonymous shared reader at 390px recovers a dropped read through retained busy retry; six actual feature routes mounted without page errors; model-catalog 503 retained its supported retry at mobile width |

metadata admission/replay is proved; successful metadata generation is NOT claimed.
the fixture's generation runtime/catalog was unavailable. source extraction and
indexing did execute with the configured embedding provider.

## narrower integration boundaries

these supplement the live journeys; they are not end-to-end claims.

- production admission owner/provider with real auth/api/storage/native locks:
  fresh typed refusal retires; prior uncertainty plus refusal retains; queued
  account departure sends nothing; late acceptance cannot affect the new owner;
  deletion failure retains known settlement and cleanup sends no post; stale
  cleanup cannot delete a later dispatch. a real accepted response body stalled
  for 30,138ms became unconfirmed and released its native lock.
- browser owner integration: receipt burst cannot evict recovery; restart/second
  tab restores without sending; failed storage or absent locks blocks dispatch;
  strict-mode replay works; old account callbacks cannot clear restarted intent.
- shared public components: priority/count/order freezing; exact publication
  handles; stale cleanup; busy dismissal guard; same-command offer/condition
  handoff; changed-command refusal; receipt visible-time expiry/pause/no queue;
  modal and pane scope. the real conditional-mount strict-mode failure was red,
  then green with the same action node.
- actual summary components/api transport: failure remains while retrying;
  disposal aborts and fences late unauthorized responses. actual pane boundary
  with a throwing child logs the original defect and supplies no remount retry.
- actual reader with real source/progress ports and service: dropped refresh
  retains the readable copy, retry stays busy, successful recovery retains the
  same document node. simulated-port owner checks separately passed nine
  position/fence cases and four runtime retry cases.

## visual and source checks

shared-renderer review covered all rooms/themes, 320px width, browser 200% zoom
and representative firefox/webkit behavior; full application journeys used chrome.
controls wrap; anchored disclosure uses the existing floating surface and viewport collision geometry. accessibility
verification was waived by the owner; existing semantics were preserved.

captures: [workspace recovery](verification/feedback-20261016/workspace-required.png),
[reader disclosure at 390px](verification/feedback-20261016/reader-disclosure-390.png).
these are actual application states; the next dev indicator is development tooling.

source review found no retired hud/persistent variants, feedback publish/resolve
aliases, timer-owned actions, old tone column or standalone reader warning card.
one authenticated admission provider and one presentation host remain. domain
layouts, comparison bodies, skeletons and native menu/player controls remain
feature-owned. no backend schema, migration, permanent dependency or ci gate changed.

## limits and explicit costs

- [native shelf/player/download verification](tickets/feedback-native-device-verification.md)
  and [installed-extension verification](tickets/feedback-extension-runtime-verification.md)
  remain open. builds and browser checks do not establish those runtime outcomes.
- [older domain-helper invalidations](tickets/domain-invalidation-outlives-account.md)
  remain outside the new owners' account fences; no cross-account data disclosure
  was observed or inferred.
- only the two admissions gain restart persistence. optional undo remains in
  memory; secondary/nonleading choices need disclosure; receipts have no history.
  a media pane and independently opened metadata dialog may each observe processing.
- deletion of the temporary tests intentionally removes future automated
  regression detection. static consistency and this finite evidence are different
  guarantees.

## final gate and cleanup

the unchanged `./scripts/test` passed after cleanup, exit 0: workflow/shell
checks, python format/lint/types, shelf and extension builds, css-token closure,
wire freshness, eslint, web/extension types and canonical migration head `0286`.
no migration was applied to an existing environment.

temporary tests, runners, test dependencies, fault controls, browser profiles,
private fixture configuration and the detached baseline worktree were deleted.
the eight owned containers, three data volumes and two networks were removed;
owned web/api and harness ports are clear. only this receipt, the adopted plan,
module documentation, remaining tickets and two sanitized captures remain.
no temporary test or fault seam entered the application tree.

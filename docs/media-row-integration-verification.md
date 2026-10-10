# media rows: current-main integration

origin: 2026-10-09, [media-row contract](media-row-plan.md).
integration base: `167773ac115f877ee4968068997bc8328586ae59`, 155 commits after
the original implementation's base. the [initial receipt](media-row-verification.md)
is historical; its retired reader/player protocols were not restored.
final base: `3a42c73d2260eaf2eb4cc06d7e5b002001cbdeca` (#537). this later
memory change left the media/list/reader/player owners untouched; its generated
wire addition composed cleanly. locked dependencies and the static gate were
rerun after this final rebase.

independent agents ported backend facts, current list owners, shared reader/audio
owners and native verification. review removed duplicate formatting/decoders,
an unused page mapper, redundant reader publication and consumption-triggered
ordinary-list reloads. late review fixed input intent surviving unread authority,
equal-revision pending acknowledgements, and publication being lost when a
successful command's follow-up authority read fails. native authority outages
now retain local retry feedback; a preparation timeout refuses the command through
the existing client transport-error channel. native reconciliation drains old
writes before reading authority, including after that timeout; post-commit
adoption outages retain feedback rather than refusing an accepted command.
collection fallback follows the
current labeled region rather than a retired section shape.

## real red and database cutover

the current-main api, real password authentication and published task fixtures
returned 404 for the required summary resolver; the target assertion failed.
setup failures were excluded. the same actual endpoint passed after integration.

the ordinary migration chain built a disposable database through `0264`.
`pg_dump -Fc` was restored into a separate database; heads, media identities,
cursors/revisions, overrides and audio positions/epochs matched before `0265`.
backup sha256: `ee9b323bbd1133cbe7b702cdbaf85ec73c7424d0d5042596dc1e4b9870770b27`.
`0265` then preserved effective finished/unread and completion history, fenced
old writes, and removed maximum progression plus its check constraint.

## observed behavior

temporary probes used real browser → bff → api → disposable postgres and an
ordinary android debug build. transport delays/failures controlled real requests;
no forged successful responses, auth bypass or production test hooks.

| boundary | observed |
| --- | --- |
| api/domain | reader, video and audio 80%→20%; sticky 96%→20%; unread bookmark retention, stale equal/different writes rejected, matching-base equal resume, reset/history and exact undo; unknown/zero/streamless duration and canonical 1×; preview cannot replace owned zero; old natural end superseded and own acknowledged heartbeat advances correctly |
| summary resolver | request order, unique 1–100 bounds, missing/private absence under a second real account, all credits, and library/lectern agreement |
| catalogue | genuine author api and browser expose all three stored catalogue authors, preserve ordinal/credited/canonical names, match hidden coauthors, and invent no date, state or time |
| episodes | ordinary enabled api with existing dev-server credentials; five facts, first two linked credits plus accessible overflow, original 1925/unread/10 min; title, overflow-credit and canonical-author filters agree; streamless retains unread/8 min, unknown duration omits percentage/time; no browser errors |
| browser/reader | 124 retained rows across two pages; exact five facts, two linked authors plus truthful overflow, all-author filters; local unread drains prior input, passive reflow/lifecycle makes no save, genuine equal-position activity resumes with unchanged revision; ordinary progress preserves primary focus, scroll 3950 and entry-request count 2 |
| browser/topology | an inactive accepted empty in-progress view gains an item from genuine input in another pane; a 6%→62% save reorders the remaining-time view while all 124 rows stay mounted; real continuation 409 retains the 100-row prefix, recovers 124, and preserves primary/menu focus and viewport anchor |
| browser/failure/focus | successful unread plus aborted authority GET still patches mounted list facts; reader feedback/retry remains visible, saves stay gated, retry only reads, separate input resumes; removal chooses next survivor or labeled region, and deliberate departure retains focus |
| android | actual playback drain → unread → epoch adoption → separate resume; aborted authoritative GET retains workspace and visible retry, which makes one GET and zero writes; real downloaded equal-position save keeps cursor revision, clears pending and advances publication; the same acknowledgement updates an already-mounted hosted unread row to 20%; stale equal pending gets real 409 and retires read-only, preserving unread |
| android/end/timeout | own completion heartbeat acknowledged after eof yields Done and plays the actual successor; a later unread supersedes the old end and prevents successor playback; sequential real 10s/18s acknowledgement delays exceed the 20s bridge deadline, send zero consumption commands, retain workspace/operational feedback, and permit authority GET only after both old writes drain (28.049s) |
| visual | settled 390px row, actual 200% desktop browser zoom (780 physical pixels / 390 css pixels, devicePixelRatio 2, visualViewport.scale 1), and minimum 611px rtl split pane retain year/state/time/menu without overflow; english time reads `5 min` under rtl |

## native artifact

android 15, isolated readonly emulator; ordinary `assembleDebug` succeeded.
the final apk contains 205 matching current shelf assets and zero retired
`nexus-offline` entries. apk sha256:
`75cb026bdb1286e34eeef7bcc6bd19ff634679e039e79c4d332da00aa29cf77d`.
57 native/shared-reader inputs matched the rebuilt artifact; aggregate sha256:
`76cd96b45ba96211da4a38a0d9002d3942a0352d84ad4bba3defe508602072f9`.
packaged shelf sha256:
`cb97834e1c9a82981b6d87442c8dee5726d422ca8b603bbaabbbdf5b0cc8f936`.
the installed apk pulled from the emulator matched the build hash.
the targeted timeout proof ran on this final artifact. earlier native cases
exercise unchanged paths from its predecessor; the sole subsequent native change
is reconciliation's drain before GET.

captures: [390px library](evidence/media-rows-current/library-390.png),
[actual 200% zoom](evidence/media-rows-current/library-200-percent.png),
[minimum rtl split](evidence/media-rows-current/minimum-split-rtl.png).
one initial development navigation hydration warning did not recur on subsequent
reloads/visual runs; [its undiagnosed attribute difference](tickets/app-nav-intermittent-hydration-warning.md)
remains open rather than being suppressed.

## cutover and limits

audio retains main's epoch-only listening owner. accepted writes now return the
position/reset/override tuple; natural ends drain their own acknowledged heartbeat.
`nexusPlayback` and `nexusDownloads` replace the old bridge names; required snapshot
`consumptionRevision` publishes accepted native facts. no old protocol or fallback.

this is disposable local integration evidence, not a production deployment or
physical-phone claim. fixtures prove consumption/presentation, not ingestion.
deployment still requires stopped writers, verified backup and coordinated
backend/web/android releases; rollback requires the backup and prior builds.

## cleanup

both exact task auth accounts were deleted through the ordinary admin api and
returned 404. the disposable postgres container and its anonymous volumes were
removed; task ports 59620/59630/59632/59633/59640 closed. native cleanup removed
the task app, readonly emulator, reverses/forward, proxy, device xml and build
caches. original avd config/ini hashes were unchanged; no build copy or object
writes. shared auth/storage, other worktrees and the physical device remain.

temporary probes, credentials, profiles, backup, raw receipts and apk were
removed. only these written observations and three captures remain. the final
static gate recreates ordinary generated shelf assets.

the post-cleanup `./scripts/test` exited 0 on the integration sources: ruff,
pyright, generated wire/tool contracts, css tokens, eslint, typescript and
the sole migration head `0265`. no temporary test seam, dependency, task origin,
old bridge object or furthest-point writer remains in production sources.

hosted pr #538 ci run `38022622059` failed before checks because main's new
`UNIVERSAL_MEMORY_READ_TOKEN` repository secret is absent. pr #537 already
records that setup failure. the local passing gate is not a hosted success;
[the credential prerequisite](tickets/private-memory-ci-build-credential-missing.md)
remains recorded.
the owner explicitly approved merging with that inherited ci setup failure on
2026-10-10 utc. no check was bypassed or represented as passing.

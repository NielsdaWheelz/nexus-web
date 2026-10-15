# library chooser qualification

2026-10-15. source: `55673a8b095cad1f22aa19e2136475b7a2d93921`, composed with
main `4d5abbf4c0792e97fd75b15c6305dbcfb2cbb8f4`. the earlier implementation at
`4c33ec204` is superseded. the owner explicitly chose main's online-only contract:
no reload recovery, historical receipts, ledger restoration or migration.

qualification used disposable local accounts, normal password login, the browser,
bff, api, postgres, supabase auth and minio. app ports 3396/8396; owned data/auth/
storage ports 59930/59931/59940. the new `library_chooser_online` database leaves
the earlier task database intact. no production mutation or deployment occurred.
pending source acceptance was not reported as completed extraction.

three agents implemented non-overlapping chooser/draft, catalog/placement and
extension slices; root owned integration and independent browser oracles.
cross-review repaired stale create refusal, post-await owner checks, hidden review
feedback, standalone share auth, native ingress typing and capture-slot takeover.
the global review surface reuses Dialog; ordinary placement stays anchored/inline.

## observed proof

[receipts](verification/library-chooser-online-20261015/receipts.json) retain
outcomes and real canonical reads. tests were temporary and external. held/dropped
delivery never manufactured a successful application response.

| boundary | observation |
|---|---|
| shared keyboard loop | six unchanged assertions pass in chromium 147, firefox 148.0.2 and webkit (reported 26.0): deliberate activation, clear-prefix entry, selected-row filtering, native editing keys, escape return and 390px keyboard focus |
| focus | all three engines pass tab/shift-tab continuation, native repeated-enter guard and synthetic composition guard |
| catalog | complete query-free catalog exceeds 50; old query rejected with 400; failed refresh retains locally matching good rows and blocks creation |
| draft composition | current-row bulk preserves per-row choices and future defaults; held real creation permits dismissal and applies only to frozen surviving rows, preserving newer choices/query |
| draft publication | three ordinary url admissions return 202; submitted ids and canonical named placements are exactly beta, beta+gamma and alpha; no placement write occurs during drafting |
| online placement | seven assertions pass: held real put response, editable cleared search, accepted queued inverse, no early dispatch, escape, post-close delete drain and canonical absent |
| failure recovery | five assertions pass: real committed put reply lost, three failed reads, inverse paused without replay, visible review Dialog, connected focus fallback, read-only retry then one delete and canonical absent |
| creation | five assertions pass: actual reserved-name 400 followed by corrected 201 and frozen target placement; old error/notice clears. 100 unicode code points create; 101 offer no creation |
| standalone share | actual 401 on catalog and create shows sign-in guidance without redirect; create offers no false retry |
| extension | installed firefox: separately dispatched entry loop, selection/save and canonical destination set; real-port edit/save/late-edit sequence, save barrier, discard and stale command/account fencing. native optional permission withdrawal, repeated saves and subsequent grant complete normally |

genuine current-main baseline reds (`ef2aaf1d7`, same tree as `7bc7c8a13`): five
chooser assertions, both catalog assertions, both transient tab boundaries and
five live placement assertions. escape and repeated/composition guards already
passed. draft-specific baseline checks reach the old checkbox-only bulk editor
and creation's blocked dismissal.

the refusal, failed-read recovery, auth/refresh and unicode checks ran before
main's overlay composition; their chooser/API owner files are unchanged by that
merge. merged focus, placement, draft and installed-extension checks exercise the
composition separately.

the native extension baseline batched down/enter and is INCONCLUSIVE; it is not
counted as an accepted-action red. native key dispatch and the real-port ordering
check are distinct boundaries. permission qualification did not force the old
concurrent takeover interleaving; that narrow fix also received source review.

setup corrections: cold compilation exceeded a navigation deadline; an auth
locator expected different guidance copy; a repeated unicode fixture already
existed; changing viewport while opening remounted the surface. none is counted
as a product red. the imports harness also clicked before the Nexus receiver
hydrated; the [early launch gap](tickets/nexus-launch-click-before-hydration-is-lost.md)
is separate open work. later checks wait for readiness without changing their
behavior assertions. the final frozen-creation run awaits the existing receiver
flag explicitly; the successful admission run waited for document load and does
not qualify early launch.

the pinned minio init image could not be pulled. the existing task-owned server
image started; its missing `media` bucket was created with the existing local s3
client. the ordinary signed upload path then passed. the existing
[distribution ticket](tickets/local-minio-image-pull-fails-on-devbox.md) remains
open; this does not qualify a fresh `make dev` installation.

## decisions and limits

- complete local matching increases the first payload. accepted entry clears the
  prefix; per-target order delays dispatch, never typing.
- current editable drafts and future defaults have separate controls. creation
  freezes scope; final submission waits on it while editing/dismissal stay free.
- creation and placement are separate effects and may leave an empty library.
  an unknown create releases unsent dependent reservations; explicit retry keeps
  its id/name/targets but admits fresh dependent adds at that time. main's retry
  may return a renamed row or recreate a deleted one.
- work survives picker close within its mounted owner, not reload or account
  teardown. no cross-tab order or historical replay exists. a delayed unknown
  request can still land after a later edit; rereading cannot fence it.
- transient tab exits at the first/last control so close/retry remain reachable.
  mobile sheets retain modal tab traversal. wire revision 2 requires coordinated
  server/web/extension cutover and an update for old installed extensions.
- [physical ime/speech, soft keyboard, native zoom and popup-host escape remain
  unverified](tickets/library-chooser-physical-accessibility-unverified.md).
  synthetic composition checks only the event guard. explicit Firefox host
  dismissal proves close/reopen lifecycle, not physical escape.
- deleting temporary tests removes future automated journey coverage. retained
  observations are evidence, not a regression suite.

visual samples: [390px](verification/library-chooser-online-20261015/narrow-100-codepoints.png)
and [doubled text](verification/library-chooser-online-20261015/narrow-double-text.png).
long names wrap; search/summary remain above the bounded list. doubled text is
not native browser zoom.

## gate and cleanup

[`./scripts/test` passes](verification/library-chooser-online-20261015/static-check.txt)
on the composed source: formatting/lint/types, shelf and
extension builds, css tokens, wire freshness and the single migration head 0286.
no dependency, migration, permanent test or test-only production seam was added.

[cleanup receipt](verification/library-chooser-online-20261015/cleanup.json):
temporary tests, baseline checkout, profiles, fixture files and credential files are
removed after qualification; shared dependency/browser caches remain. task
api/web, native browser, driver and fixture server are stopped. only exact owned
containers/networks are removed, without volume deletion. preserved volumes:

- `nexus-library-chooser-20261015_postgres-data`
- `nexus-library-chooser-20261015_minio-data`
- `supabase_db_nexus-library-chooser-20261015`

no prune/reset or production operation occurred. unrelated workspace changes are
preserved. local data fixtures remain in the preserved volumes. publication stays on its feature branch under the approved release
freeze; main/protection/deployment remain the coordinator's responsibility.

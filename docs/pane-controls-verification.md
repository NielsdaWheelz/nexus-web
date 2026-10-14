# pane controls verification

date: 2026-10-13 · branch: `codex/pane-controls-20261013`
contract: [plan](pane-controls-plan.md)
status: complete; youtube success explicitly waived by owner, remaining manual limits recorded below.

## identity and method

baseline: `16763c3cd4a7cb0b54520e99ec388fb82d573b9d`, served from the
detached task baseline worktree. implementation:
`/Users/nnandal/Documents/code/nexus-web-pane-controls-20261013`.
qualified pre-integration snapshot: `d17affbd43b900cb1332bfb0125f10baba025651`.
its web-source sha256:
`9c469b23fe6563bc1e80f6b09658af408a8e9734f86295846555867d47ecd2ea`.
digest input: union of baseline `git ls-tree -r --name-only` and current
`git ls-files --cached --others --exclude-standard` paths under `apps/web/src`,
sorted uniquely; each contributes path, nul, bytes (or `<deleted>`), nul.
669 paths. this identifies the dirty implementation independently of the
runtime's unchanged baseline sha metadata. the only source changes after
live proof stripped trailing blank lines from two css files; rules were unchanged.

actual browser → next/bff (`127.0.0.1:3197`) → api (`:8197`) → isolated database,
local password auth and minio bucket. current source was served from that
worktree. normal linux workers used deepgram for the transcript and the
normally enrolled codex host for the conversation/dossier. no publication database writes,
auth bypass, runtime test seams or fabricated successful responses. race checks
held/released or aborted real traffic; released response bodies were unchanged.

chromium 147.0.7727.15; firefox 148.0.2; webkit 26.0. geometry/focus/reader
checks passed 6/6 per engine. physical samsung `RFCT51J2MCH`, dpr 3:
chrome 155.0.8059.39 and an isolated native debug package. final apk sha256:
`0fa9d18cac25bf4067703f0770e040e312f23293ff00fde5d5a05c95d90771c7`.
the precise android os/webview-provider versions were not retained.

## observed outcomes

baseline controls scrolled away; idle reader find/native inline options were
absent, navigation and find switched roles, and clear left browse's applied
query. the 12-case baseline recorded ten failures/two passes; downstream cases
blocked on missing controls do not prove independent progress/cancellation
defects. setup failures were excluded. imports' incoming false facet also had
no representable control.

| plan case | final observation |
|---|---|
| 1 pinned controls | library/lectern controls and focus stay stationary; real brave results scroll 0→400px while input stays y108; option-label drag leaves canvas at 0px, header-drag positive control moves it 90px |
| 2 reader composition | article, epub, pdf and real transcript find; navigation coexists, canonical destinations/limits and pdf validation work |
| 3 geometry | 320px panes, 600×900 with 200% root text, 390×600 coarse layouts; closed-option chips scroll vertically without horizontal overflow; physical ime keeps 44px actions and 16px input reachable |
| 4 options/focus | native inline groups, grouped chips/counts, imports dates and false tri-state; collapse, reset, ordinary/cascading/last-chip removal retain live focus |
| 5 clear/reset | browse clears immediately; held real responses and pending global-search debounce cannot republish old text; facets/order and imports context/selection survive |
| 6 find lifetime | empty focus captures nothing; first query freezes scope; later navigation retains it; clear removes paint/results, preserves preferences/origin and never adopts progress |
| 7 cancellation | nine real pdf-range variants: clear, replacement, newer jump, prearrival clear, resize and failed/cancelled/successful mobile preview; no stale movement/paint or false dismissal |
| 8 progress | nonempty canonical snapshots remain unchanged during inspection/options/clear/reflow; return reaches first origin; continue and genuine later scrolling save normally |
| 9 ownership | two panes keep radio/query/url independence; active shortcut/overlay ownership; trusted native fallback for unsupported/resolving find; visit retirement, hash/query refinement and actual g1→g2 publication replacement |
| 10 mobile/resize | collapsed default, navigation coexistence, clear/close/escape, empty-input/options breakpoint continuity; saved restore stays shown; physical forward/inert/reverse/tap/hold/rotation checks pass |
| 11 continuity | delayed sort explicitly shows previous results; real failed cursor leaves partial/failed status and retry completes 105 rows; back/forward restores the list anchor |
| 12 migration | 28 checks pass across all 20 producers; real chat/dossier/transcript paint; anonymous epub navigation without owner progress writes; final native offline epub/pdf inspection/return/continue/reopen and exact local-file response hashes pass |

final core: 12 passing entries (epub/pdf composition split; full census checked
separately). physical webview: 6/6; final packaged offline readers: 6/6 with task
origin reverses removed. populated brave and podcast discovery passed; genuine
gutenberg empty responses supplied the browse race check. youtube
filter/sort/clear composition passed in the empty-query state;
successful upstream video discovery/newest order is **waived**, never counted
as pass. the configured key rejects this caller ip; [configuration ticket](tickets/browse-youtube-upstream-forbids-live-query.md).

adversarial review reproduced and repaired two additional geometry defects:
text resize after a settled wheel wrote revision 7→8 without input and changed
the passage; the corrected coordinate/fence preserves the exact reading-line
offset and canonical revision, including concurrent real resize/wheel. the old
unheld late-layout pin also hid restored mobile chrome; chromium, webkit and
the physical webview now keep it shown. pdf page content-box sizing aligns
actual glyph pixels with selected highlights; zoom/resize/return preserve the
reading line without progress writes. independent final source review found no
legacy control renderer or duplicate density owner.

## fixtures and limits

ordinary api fixtures: 105 libraries, 12 pages, notes, author works and a
subscribed show; redundant imported episodes were removed through ordinary
delete actions after their real transcript was ready.

| fixture | id |
|---|---|
| epub | `01a13738-fc5e-7468-9077-7cc2e0c8d238` |
| pdf | `01a13738-fa6a-7a1a-8d82-798046d29300` |
| delayed pdf | `01a1375c-516a-7d9e-96e1-369bbe419ec2` |
| article | `f698cee4-5a2d-4707-a1eb-c6859b992c3b` |
| transcript | `01a1374b-3f67-7bc8-86f6-ed8c7bbb12fb` |
| generated conversation | `13c77549-997b-4889-bb4c-e11ac2741dbc` |
| generated artifact | `artifact:c8cf12ef-80f8-4e2c-9982-881f94fd9620` |

200% text used a browser-applied root-font userstyle, not native os/browser
accessibility settings. real device proof uses three-button system navigation;
gesture-mode safe areas, ios and spoken assistive technology remain unverified.
concurrent resize/wheel used real browser actions, without artificial subframe
suspension. unrelated device resources changed during parallel work; the
[cleanup limitation](tickets/android-baseline-drift-during-pane-qualification.md)
records what was observed without attributing those changes to this task.

separate out-of-scope findings: [linux worker instructions](tickets/background-worker-local-command-requires-linux.md)
and [failed media projection recovery](tickets/failed-media-projection-has-no-user-retry.md).
the published dossier fixture used a completed conversation; the failed media
projection was preserved as evidence rather than manually repaired.

## final gate and removal

`./scripts/test` passed on the frozen implementation and again after removal;
`git diff --check` passed. temporary browser drivers, dependencies, private raw receipts,
configuration, fixtures and the detached baseline worktree were removed.
task containers/networks/socket volume, database, bucket and disposable auth
user were removed. the original enrolled account volume was subsequently removed
under the owner's “clean everything up” instruction, without copying or archiving
credentials. no automated suite or production test seam remains.
the task android package and owned port forwards were removed; rotation/home
restored. unrelated apps/services are outside cleanup ownership.

## merge integration

the cutover was first rebased onto `443eda51e75ee3f23af4ed7d7f7d00345da76716`,
then onto `b6768bee2469cbc3a43902302836a44d07a11ea7` after metadata-imports
landed during pr preparation. the issue register preserves both sets of entries.
imports' inline choices now use the canonical expanded failure vocabulary;
incoming metadata diagnostics css is retained. the other 78 of 80 cutover source
paths retain identical bytes/deletion state to the qualified snapshot.
`./scripts/test` and diff checks passed after integration. live journeys were
not replayed for these domain-owned choice/style changes; independent review
checked metadata stages/reasons, add/import, overlays and transport contracts.

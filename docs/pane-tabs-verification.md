# pane tabs verification

status: implementation and cleanup complete; physical wide-touch acceptance blocked · origin: 2026-10-16
branch: `codex/pane-tabs-20261016` · worktree: `nexus-web-pane-tabs-20261016`

[contract](pane-tabs-plan.md). baseline:
`69c00182c8328f46cec893517971f87f03cdbf16`. final product source:
`83f3473f7f2e142256d4f58a86c0cf7c5aa520c2`; next standalone build
`1wwR7SIiaXc5iD_vm1xvW`. independently observed `/version` matches that source;
api readiness200, isolated database0286, wire1. this receipt qualifies this
branch, separately from later canonical-main integration. qualification ran in
the isolated worktree without deployment.

## method and gates

temporary external live journeys exercised ordinary password sign-in,
browser→bff→api→real isolated postgres/auth, public commands and a real uploaded
pdf processed by the linux worker. delayed/failed requests remained real;
no successful response, owner, react state or authentication was fabricated.
setup failures were excluded from red/green counts.

| gate | observed result |
|---|---|
| permanent `./scripts/test` | green on final product source and after temporary test deletion; migration head0286 |
| empty-directory `bun install --frozen-lockfile` | green; core6.3.1, sortable10.0.0, utilities3.2.2; all three patched bundles match |
| chromium147.0.7727.15 | all35 main journeys green on final source, no skips/retries |
| firefox148.0.2 / webkit26.4 | 25 targeted strip/focus/drag/geometry/companion/management journeys each green on final source; no skips/retries |
| moved focused textarea, all three engines | 3/3 green on final source; same connected node, focus and exact pre-placement selection |
| reader/import, all three engines | four journeys per engine green on `4c3a01e0b`, build`WT1DECO-Mj8E0YjIP-YBf`; visible/hidden reorder6/6 green on final source with ≤1csspx tolerance |
| physical samsung sm-s906w, android16 | chrome155 / isolated app webview154 final management smoke green on final source; earlier rotation checks green |

chromium covers targeting/repeat guards, readable overflow and real dragging,
cancel/invalidation/no-op/single-commit behavior, maximize, real chat/dossier/member
drafts, companion ownership, active/final close, management continuity,
uncapped entry paths, delayed/retried/ambiguous saves and exact reload.
30 mixed panes saved8144bytes; load→move→reload took3583ms in this isolated
sample. ids/order/visits/history/widths/companions survived. 30 is not a cap.

both final android smokes used fresh documents with the exact source/build
above. real device input moved panes both ways, restored a pane, closed the
active pane while retaining management and successor focus, and opened a pane
with landmark focus. android back dismissed the real search keyboard. the task
app used the isolated package `app.nexus.android.panetabs20261016`; existing packages were
not replaced. landscape widths707px/780px retained mobile composition, so these
checks do not qualify physical desktop-strip dragging.

## critical red → green

native keyed placement retained the pdf node but reset its nested scroll from
`(12919,200)` to`(0,0)`, including a hidden-pane variant. the canvas now restores
the same descendants' two axes around actual surviving-pane reorders. it does
not replay ordinary membership/breakpoint changes or write reader progress.
primary bodies and saved page5/zoom2 cursors survived the qualified journeys.
final numeric comparison allows1csspx for browser rounding: chromium/webkit
changed0; firefox changed0.2002px vertically and0 horizontally in both cases.
mobile composition preserved page/body/cursor/maximize state,
but not the exact reading anchor described below.

the focused-root journey observed the textarea's OWN pane root actually move:
native append blurred it; react restored the same node and range. chromium then
lost`[44,45]` because dnd's retired selectionchange listener ran after restoration.
the pinned patch now retires that listener synchronously with keydown; final
chromium retains`[44,45]`, firefox its`[55,55]` caret, webkit its`[0,0]` caret.
there is no app focus/caret restoration framework.

another red swallowed4/8 fresh clicks inside dnd's old50ms teardown window.
the preceding`4c3a01e0b` patch qualified8/8 fresh gestures40.7–41.9ms after escape,
with zero stopped fresh clicks. final source preserves that exact teardown path
and its ordinary release-click suppression.

## shared-menu ownership

shared source matches`6d02203ee`: ActionMenu blob
`2d0a6e702e98b3767b0152ee954ea4c3dc8f52ae`, css
`214479cdd376ec4f247e9a532e2b75ae3df74861`, overlay
`9c2cc4f17436d7a4289b82abdccf7889514e0c75`.
principal-actions supplies its observed page/row/nexus keyboard-exit receipts;
these are separately identified integration evidence. this branch additionally
qualified real empty/loading/failed
menus and a busy disabled-only connection menu in all three engines. a held
write could not be repeated with enter/space. no second overlay owner was added.
an additional actual anchored-reader menu journey passed on `4c3a01e0b`;
that acceptance is now obsolete. its real caller remains here at
`app/(authenticated)/media/[id]/SelectionDock.tsx:186`. canonical main's reader
cutover removes it; the new shared-menu removal must follow that cutover.
principal-actions owns the separate current native-pdf→passage-composer→highlight-save
qualification. do not reintroduce an anchored host to preserve obsolete acceptance.
its integrated shared cutover`30bf3ed6ef3d2c2530f610a944d1d4d473a7615b`
reports build`QEZcj_oxsLE7BMuWo4v_T`, wire9/schema0291, static green and final
row/nexus keyboard assertions green in all three engines. that campaign retains a separately
ticketed firefox React#418 setup symptom; this branch's green counts do not
qualify the whole canonical-main campaign.

## limits and tradeoffs

physical wide-touch strip dragging remains
[blocked by available hardware](tickets/pane-tabs-wide-touch-unqualified.md).
mobile resize can shift the reading anchor about21px despite unchanged
page/body/cursor and zero progress writes; a one-pane firefox control excludes
canvas replay: [responsive drift](tickets/reader-responsive-scroll-drift.md).
webkit page entry can stop0.78125px short of its classification line before any
pane operation; a real40px wheel movement established the interior page for
reorder proof: [page rounding](tickets/pdf-page-navigation-rounding.md).
neither reader owner was changed by this task.

dedicated accessibility conformance checks were waived; functional keyboard,
focus, menu and touch checks remained. unload delivery stays best effort with
its [existing issue](tickets/workspace-session-unload-can-send-empty-body.md).

uncapped panes retain mounted bodies and enlarge saves. readable tabs require
horizontal scrolling; secondary actions cost a menu step. maximize resets on
reload; narrow inspectors become modal. canvas scanning avoids reader coupling.
the pinned dependency patch requires review on core upgrades. deleting the
temporary tests forfeits repeatable regression coverage. api widening must
accompany web cutover; rollback must preserve it.

## cleanup

deleted task-owned drivers, browser dependencies, private credentials/fixtures,
browser artifacts, temporary installs, proof checkout and patch. stopped the owned
api/web process groups; removed seven owned containers, three volumes and two
networks. normal product dependencies remain for review; borrowed dependencies,
shared browser caches and unrelated worktrees/services were preserved.
post-deletion `./scripts/test` passed; its temporary log and generated outputs
were then removed. independent local cleanup review passed. no permanent tests
or test-only production seams survive.

phone cleanup removed the task chrome context and isolated package, preserving
the actual lease-entry foreign chrome target, existing packages, display/rotation
and original foreground task. earlier pane-tabs allocations forward52905 and
52319, plus reverse3296, had been preserved across intervening owners' windows;
final owned cleanup removed them. raw lease-entry/final mapping equality was
NOT preserved: final lists were empty. the owner reviewed the saved ownership
and mapping witnesses and accepted removal without restoration. historical
chrome ids remain an inherited unconfirmed witness, not attributed to this
lease. release was accepted; the phone queue is closed with no further calls.

nonsecret mapping, qualification and local-cleanup receipts were handed to the
principal-actions owner separately. that owner integrated the product slice
into [merged pr651](https://github.com/NielsdaWheelz/nexus-web/pull/651);
its later source/schema/wire qualifications remain separate from this branch's
receipt.

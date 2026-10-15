# action menu button verification

date: 2026-10-15 · branch: `codex/action-menu-button-20261014`
contract: [plan](action-menu-button-plan.md)
status: complete within the plan's stated limits.

## original candidate and method

the browser evidence below qualifies original commit `6267afa73`.
the final rebased candidate is qualified separately under merge integration.

baseline: `367da80e0c1beb1c426f6d2d72201b0733809b50`.
qualified web-source sha256:
`98778b0e70c66c610e1ac99b536eb139355ca8480cc3290ef33dbb39ee549e39`.
digest: the 16 changed/new application paths, sorted; append each path then
its bytes without separators. [source identity](verification/action-menu-button-20261015/source-identity.json)
lists them.
component and visual receipts also verify individual source hashes.

actual browser → next/bff (`localhost:3286`) → api (`:8286`) → isolated
postgres/minio and local password auth. articles entered through ordinary
capture/upload/confirmation and worker ingestion; the library, connection and
pdf used normal product paths. no mocked actions or responses, auth bypass
or production seams. collection reorder was restored.

chromium `147.0.7727.15`; firefox `148.0.2`. red preceded application edits:
nine preservation checks passed and five header appearance checks failed.
the reserved-library setup blocker is excluded from red evidence.
the later forced-color matrix caught browser remapping of `currentColor`
borders; explicit system-color borders repaired it.

## observed acceptance

| boundary | evidence |
| --- | --- |
| row/header/collection | glyph, stable geometry, hover/press/persistent-open/focus; enter/space/down/up, escape, drag suppression and restored alt-arrow reorder pass |
| nexus/switchboard | compound shortcut target, virtual-grid focus, registered ref/shortcut, tab exclusion, 48px mobile target and nested dismissal pass |
| reader/pending | chromium dock opens and restores focus; actual snapshot-pending aria-disabled and reader-busy native-disabled controls remain inert; both held requests continue unchanged and settle normally |
| semantic controls | account, pdf zoom and relationship controls retain their separate appearance and working menus; one ordinary library `Open` command completes |
| shared native contract | 167/167 checks per engine: three rooms, native/aria disabled, expanded+focused combinations, forced colors, reduced motion, ref and single event forwarding |
| adornments | 23/23 per engine: actual owner css, original badge offsets, centered glyph, decorative semantics, click-through and forced-color visibility |
| visual review | all three rooms; glyph/hint contrast ≥5.97:1 and measured focus contrast ≥7.18:1; 320px coarse layout has 44px rows, 48px header and no pane clipping |
| native 200% zoom | 18/18: browser zoom reports `2`, viewport halves and dpr doubles; targets/glyphs, menu interaction, focus return and unclipped layout pass |

main firefox recorded 48 passes; its semantic-control setup blocker was closed
by a focused 25/25 pass. main chromium recorded 41 passes; focused nexus 12/12
and reader/pending 18/18 close its two setup blockers. counts overlap; they are
not a combined test total. original blocked receipts remain intact. initial
native-zoom captures cropped output and coincided with header replacement;
the final explicit host-pixel capture preserves header identity. no product
focus defect was established.

independent source review found all seven overflow renderers migrated, preserved
bindings, one paint owner and no compatibility path. designer and root reviewed
populated panes and open menus. selected evidence:
[before](verification/action-menu-button-20261015/before-header.png),
[press](verification/action-menu-button-20261015/press.png),
[study](verification/action-menu-button-20261015/study.png),
[solar/nexus](verification/action-menu-button-20261015/solar.png),
[320px mobile](verification/action-menu-button-20261015/mobile.png).

## limits and operational recovery

the known [firefox dock dismissal](tickets/firefox-selection-dock-closes-when-its-menu-takes-focus.md)
remains excluded. firefox touch emulation does not set the coarse-pointer media
query; chromium qualifies it. physical touch and spoken assistive technology
were not tested. this is not a complete accessibility audit.

no current action producer emits a status badge; its actual component/css
contract was qualified separately without inventing a product capability.
oracle bodies contain no overflow consumer and override no shared button
tokens; pane headers sit outside that scope. local articles remain readable
without external indexing credentials; search success is outside this change.

shared docker/storage failure interrupted auth with 503/connection refusal
and next cache writes with `ENOSPC`. those runs are setup blockers. after the
owner's recovery handoff, only task services resumed against preserved volumes;
ordinary auth and a same-value library update passed. no prune, reset, shared
docker-engine restart or production operation was performed by this task.

## gate and removal

`./scripts/test` and `git diff --check` pass. the first gate attempt lacked the
isolated worktree's ingestion dependency link; linking the existing dependencies
with identical package/lock files fixed setup. no application source changed.

disposable runners, fixture servers, profiles, setup scripts, private fixture
credential files and generated build caches are deleted. the one created highlight
was deleted normally (204), then verified absent (404). no new test dependency,
target or production seam remains; deleting the tests forfeits future automated
regression coverage, as requested.

owned api/web processes and all seven task containers were stopped. the three
`nexus-menu-button-20261014` postgres/minio/auth data volumes and their bind
assets were initially preserved under the recovery instruction. the owner's
subsequent “pr, merge, clean everything up” request retires that task stack,
fixture data, worktree, branch and raw artifact directory after merge. committed
screenshots, source identities and this receipt remain. unrelated work and
shared dependencies are outside cleanup ownership.

## merge integration

rebased onto `7bc7c8a13`; integrated [source identity](verification/action-menu-button-20261015/source-identity-integration.json)
uses the same 16-path digest method. `./scripts/test` passes with migration head
`0286`; `git diff --check` passes. independent review confirms the primitive and
all seven css owners are byte-identical to the original qualification. the
relationship-button conflict retains upstream's inline renderer with only its
local appearance class added.

upstream's plain resource refs, annotation editor and fetch-on-open behavior
remain intact, including loading-to-item focus handoff. the old snapshot-pending
disabled-trigger journey above is historical: current resource menus open with
a loading row. disabled paint and native reader-busy contracts remain unchanged.
live journeys were not repeated after rebase; integration proof is source review
and static checking, with unchanged presentation covered by the original runs.

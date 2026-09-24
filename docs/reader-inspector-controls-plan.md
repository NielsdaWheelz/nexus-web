# reader inspector controls

status: approved direction; implementation and live verification not started
origin: 2026-09-24 reader council; source `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`

## goal and scope

one predictable inspector disclosure; document position stays the rail's job.
change shared desktop/mobile header presentation, hosted reader shortcuts, and
redundant hosted/offline map openers. retain contents, evidence, dossier, exact
navigation, previews, return, and reading-position semantics.

shared presentation intentionally reaches every existing consumer, including
imports. offline retains its independent, local document-map toggle. no new
features, panel tabs, preferences, backend/native protocols, database schema,
dependencies, toolbar framework, rail geometry, or mobile motion policy.

## target behavior and content contract

the interaction/content designer owns this finite vocabulary and reviews its
rendering; implementers consume existing action fields, not parallel copy.

| surface | content and behavior | good means |
| --- | --- | --- |
| desktop inspector | stable lucide `PanelRight`, 16px, plus visible `inspector`; order `back, forward / identity / more, inspector` | a quiet divided-panel symbol, honest container name, nearest its trailing panel; label never collapses at narrow desktop widths |
| mobile inspector | same glyph, accessible name `inspector`, icon-only after more | same learned command; existing 48px target and revealed-header access; no floating map control |
| disclosure state | stable name `inspector`; command copy `show inspector` / `hide inspector` from existing `state.menuLabels`; hover title uses projected command copy | open state is visually distinct and announced; no changing glyph, duplicate tooltip system, or misleading contents label |
| offline map | retain text `document map`, current section label, and `aria-expanded` | names its actual navigation body; reachable after removing the rail opener |

desktop keeps the existing 32px control height, natural label width, spacing and
focus tokens; document identity yields width first. mobile keeps its existing
target dimensions. actual dom/focus order matches visual order. the inspector
control never moves into the opened panel; existing panel/sheet close controls
remain. no duplicate inspector command in more.

open restores the last still-published tab; otherwise use the publication's
declared default. close hides the whole inspector, including dossier. bare `g`
has exactly those semantics; retain the existing chord delay, `g e`, `g c`,
shift-`g`, editable-field exclusions and topmost-modal guards.
transient find results are not the durable inspector: the inspector command
selects its remembered durable surface; ordinary find dismissal restores the
preceding durable presentation.

mobile uses the existing reverse-scroll/top/focus recovery policy. disclosure
pins chrome through existing ownership and opens the existing sheet. pointer or
focused-button activation passes the actual opener; dismissal returns there
without scrolling. bare `g` passes no button and uses existing keyboard focus
settlement. opening/closing alone changes no reading cursor, completion or
activity; existing workspace visibility/tab persistence is expected.

## architecture and api

`domain publication → companionAction → desktop/mobile header`
and `useResourceInspector.companionAction → reader g chord`.

- retain `PaneCompanionAction`, `ActionSelectDetail`, `companionAction`, action
  id and all stored group/surface ids. these are current shared contracts, not
  compatibility paths. no transport or persistence schema changes.
- `useResourceInspector` owns resource visibility and remembered-tab selection;
  imports keeps its existing domain owner and uses the same action factory.
  workspace owns presentation and focus; reader owns document destinations.
- the factory supplies the sole label/icon/state. keep `projectActionControlState`
  for active styling and `aria-expanded`; `aria-controls` names the mounted
  region while open. retain native button semantics and explicit opener handoff.
- add only `ActionBar.showLabels?: boolean`, default false: true renders existing
  icon plus label with natural width via `Button`; applies consistently to its
  action kinds. `SurfaceHeader` passes true; other bars retain icon-only layout.
  no descriptor metadata or new inspector component.
- rename existing `searchCommandsRef` to `inspectorCommandsRef`, add
  `companionAction` to its existing `Pick`, and retain its per-render assignment
  to `inspector`. move the g-chord effect below that assignment; both bare-g
  branches invoke `inspectorCommandsRef.current?.companionAction?.onSelect({
  triggerEl: null })`. action/publication identity changes must not cancel the
  pending chord. retain lifetime guards; no new ref, toggle API or state.
- remove `onOpenDetail` from the rail's public props and both hosted/offline
  callers. remove `onOpenMap` from the mobile ribbon. the ribbon's only input
  remains its semantic visible range; it stays passive and `aria-hidden`.

## exclusive implementation packages

paths below are relative to `apps/web/src/`. a and b can proceed independently
after c records reds; c alone owns verification and document changes.

| owner | files and responsibility | designer/adversarial check |
| --- | --- | --- |
| a: shared disclosure | `components/resource-inspector/companionAction.tsx`; `components/ui/{ActionBar,SurfaceHeader}.tsx` and css; `components/appnav/MobilePaneBar.tsx`, `AppNav.module.css` | content designer checks the exact vocabulary, stable placement, active state, truncation and contrast; reviewer rejects reader-only copies or changed imports semantics |
| b: reader integration | `app/(authenticated)/media/[id]/MediaPaneBody.tsx`; `components/reader/{ReaderDocumentMapOverviewRail,MobileReaderPositionRibbon}.tsx` and css; `offline-reading/OfflineDocumentReader.tsx` | reading designer preserves the truthful offline map label and document orientation; reviewer checks dossier/g agreement, retained destinations, mobile recovery and offline access |
| c: evidence and closure | temporary live scripts/fixtures outside tracked application code; this plan; `docs/modules/{reader-implementation,workspace}.md`, affected passages of `docs/architecture.md`; linked tickets/register | independent reviewer checks actual outcomes against this contract, package boundaries, and untouched user work |

no two packages edit the same file. a owns public presentation changes; b owns
every reader call-site removal. changes outside these boundaries require a
concrete contract failure and review, not opportunistic cleanup.

## temporary red / green / refactor

the explicit user request authorizes temporary live tests for this change;
`./scripts/test` and ci remain unchanged and static-only. these tests earn their
cost because static checking cannot detect competing controls, wrong toggle
semantics, lost focus, occlusion, or unintended reading writes.

use one isolated runnable stack, real authentication, browser → bff → api →
postgres, and disposable documents with contents and without contents. include
saved evidence and dossier selection; use ordinary service fixtures, not mocked
responses, auth bypasses or test-only production seams. downloaded-reader proof
uses a real downloaded publication and the actual android bridge/webview.
do not mutate production reading data. reuse existing setup; no test framework.

| acceptance | executable/live observation |
| --- | --- |
| a1: one disclosure | each eligible primary pane has one labelled desktop inspector after more, no rail opener; phone has one active-pane header entry and no floating map button. name/icon stay stable; expanded state and controlled region are correct |
| a2: command agreement | from contents, evidence and dossier, header and bare `g` close then restore the same tab; missing contents uses the declared default. a real pane resize during the 500ms chord does not cancel it. preserve explicit chords/input/modal exclusions; over transient find, header/`g` select the durable tab; ordinary find dismissal restores preceding durable state |
| a3: focus and layout | pointer and keyboard activation, tab order, dismissal and focus return work in wide/narrow panes, 320px phone and 200% zoom; labels/controls are not clipped or occluded. with mobile inspector closed: forward reading retreats chrome, reverse scroll reveals it, then open/dismiss sheet; focus returns to a visible, interactive opener |
| a4: quiet navigation | use a fresh restored session without prose input after fixture setup/engagement has settled; compare durable cursor/revision, completion and activity before/after disclosure only. they stay unchanged. separately check an exact section jump/return and an evidence marker preview/activation |
| a5: shared and offline | two mounted resources control only their own regions; an ineligible pane has no orphan control/gap. smoke a non-reader inspector and imports, including remembered selection; fork actions remain icon-only. a downloaded publication retains its sole map toggle, contents/return, and no rail opener |

an independent reviewer challenges assertions and outcomes before each phase
advances; resolve concrete objections, without enlarging the feature scope.

1. red: write and run target assertions before code changes. retain genuine
   failures for duplicate controls, old label/order and dossier/g mismatch;
   existing correct invariants may already pass. first prove the stack works.
2. green: implement a/b; run the same assertions and `./scripts/test`. designers
   inspect the actual rendered controls; browser assertions do not prove taste
   or assistive-technology usability. perform a focused physical touch and
   screen-reader open/close check for the changed mobile access path.
3. refactor: independently challenge each package's ownership, assumptions,
   invariants and simpler alternatives; resolve actionable objections. rerun
   affected assertions and static checks after material changes.
4. delete task-owned temporary tests, fixtures, credentials and test-only
   dependencies/artifacts after green. retain a terse completion record here:
   candidate sha, runtime/device, commands, red failures, green results and
   limits, without secrets. run `./scripts/test` on the final tree.

missing stack/device prerequisites are blocked evidence, never passes. record
them in tickets; do not silently replace actual offline/device checks with a
simulated bridge or declare the affected acceptance complete.

## hard cutover and completion

delete rail `onOpenDetail`/`.openDetail`, ribbon `onOpenMap`/`.mapControl`, hosted
`openDocumentMap`, and reader-local `toggleInspector`, `defaultInspectorSurface`,
`inspectorSurfaceActive`, plus now-unused imports/styles. retain unrelated uses
of shared types, document-map data, and existing default-surface reconciliation.
no flags, old/new branches, aliases or compatibility adapters. deploy through
the normal web/offline-bundle workflow; reload clients. rollback is the prior
build; no migration or data repair is introduced.

costs: direct contents access can take one extra tab selection; visible desktop
text shortens title space; mobile adds reach/reveal effort; more is no longer
outermost; shared presentation changes other panes; `inspector` is learned
terminology; deleting tests relinquishes ongoing regression detection.

done: a1–a5 and scoped manual review pass with recorded evidence, final static
checks pass, retired paths/tests are absent, and owning docs describe the result.
delete resolved [disclosure](tickets/reader-inspector-disclosure-competes-with-document-map.md)
and [keyboard](tickets/reader-inspector-keyboard-toggle-disagrees-with-header.md)
tickets/register entries. update the existing
[accessibility ticket](tickets/reader-map-inert-position-and-mobile-controls.md)
only for checks actually completed; this change does not close its wider map
interaction review. record deferred discoveries immediately, one ticket each.

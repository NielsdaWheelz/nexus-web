# shared article and epub section controls

status: implementation verified on source branch; current-main integration pending
origin: 2026-09-25 article-contents council and owner approval
source: `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`

## outcome and boundary

web articles with sections expose the same pane-bar dropdown, previous/next
buttons and section counter as epubs. the existing navigation response already
supplies their headings and exact destinations. this is a frontend capability
extension, not an extraction project. [research and rationale](article-contents-review.md).

scope: hosted desktop and mobile reader instruments. retain the sidebar
contents, inspector disclosure, pdf page controls, and offline document map.
no new offline instrument, extraction rules, inferred headings, source repair,
reimport, schema, endpoint, dependency, preference, feature flag, or toolbar
framework. implementation was authorized in the 2026-09-25 follow-up.

## behavior contract

| condition or action | required result |
| --- | --- |
| readable article/epub, navigation ready, one or more sections | publish the existing instrument in its current pane-bar position; group label `section navigation` |
| zero sections, unreadable, navigation loading or failed | omit the compact section instrument; reader loading/error behavior remains with its existing owner; never retain another document's options |
| one heading, including a retained title | show one destination; no length, heading-count or title-equality heuristic |
| options | use `readerNavigation.sections` in supplied order; section id is the option value/key and label is the supplied text; retain duplicates as distinct destinations; keep the native flat select |
| current position | selected value follows existing `currentSectionId`; counter is its one-based index over the same full section list; it is not reading completion |
| no containing section | select the disabled `between sections` placeholder and omit the counter; never select the first section by default |
| previous/next | retain the existing destinations deduplicated by source position and strict less-than/greater-than comparison with current offset; inside a section, previous returns to its start; disable a button without a destination |
| committed selection or movement | navigate to the exact section through the existing positioning and excursion owners; no pane-history push, completion, or reading write caused solely by the jump |
| ordinary scrolling or reflow | update selection/counter from semantic viewport state, with no second selected-section state |
| hosted mobile and find | use the same publication, chrome reveal/retreat, and existing search precedence; dismissing find restores the instrument |

retain current control order: previous, counter when present, next, picker.
retain the accessible names `Previous section`, `Next section`, `Select section`
and `Section n of total`, existing focus styling, and the current-label title.
native picker dismissal follows platform behavior; selection does not focus
prose programmatically or steal focus from the control. preserve full option
text in the accessible control even when its closed visual value is clipped.
no custom menu/tree role, new shortcut, or independent popup state.

the sidebar's zero-heading behavior is outside this contract: it also contains
map controls. do not apply the compact instrument's availability rule there.

## ownership and contracts

the implementation owner is
`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`:

- derive instrument availability, options, count and current index from ready
  `readerNavigation` and its existing `sections`. preserve `Presence` for
  current-section identity; convert absence to the native select's empty value
  only at the render boundary. do not flatten `toc_nodes` or scrape rendered html.
- replace the epub-only `navigateToEpubSection` user command with one
  `navigateToSection` callback, shared by the picker and both buttons. resolve
  the destination from current navigation once. retain the existing no-op for
  an id that is no longer present; never substitute another destination.
- retain epub positioning through
  `navigateToEpubRequest(buildEpubSectionRestoreRequest(section))`, including
  its active-fragment reset and capture suppression. preserve its applied
  request marker and existing `loc` replacement.
- dispatch web positioning through `applySourceAnchor("web", ...)` when the
  section has an anchor, otherwise `navigateToWebPoint(section.target)`.
  use canonical offsets as the declared destination when no anchor exists;
  do not add a fallback after an anchor fails. web positioning already replaces
  the fragment address; do not prepend an epub-style `loc` that it overwrites.
- wrap user positioning exactly once in `positionFromDocumentMap`. retain its
  departure capture, failure recovery, cancellation/supersession and reading
  suppression. a late completion must not reposition a newer request or pane.
  add no queued navigation, debounce, optimistic selection or dropdown loading
  state; pending application remains owned by the existing restore session.
- keep `navigateToWebSection` as the route-restoration entry point. route
  restoration is not a user excursion. keep the sidebar's current action path;
  no need to move or redesign `positionAtDocumentMapSection` for this change.

`MediaNavigation`, `ReaderNavigationSection`, their decoder, section identities,
publication generation, semantic position and restore-session ownership remain
unchanged. there is no network or persistence contract change. `epubSections`
and other format-specific values remain where epub loading/restoration needs
them; only the instrument loses format-specific assumptions.

reuse `components/ui/Select.tsx`, `PaneToolbar`, pane-shell publication and
`page.module.css` unchanged unless a reproduced layout defect requires a local
style correction. do not extract a single-use reader-control component or add
a navigation service for this small extension.

## implementation sequence

one implementer owns the reader file; splitting this shared edit between agents
would create coordination work. use one independent review after the change.

1. establish the behavior before editing: an imported article has populated
   sidebar contents/navigation but no compact picker; an epub has the picker.
   retain a small set of representative documents and observations.
2. generalize the instrument inputs/current index and its user command; update
   memo dependencies. keep format-specific positioning below that shared action.
3. run `./scripts/test` and the focused manual cases below. repair concrete
   failures at their owner. after passing, repeat checks only for changes or
   unresolved concerns; do not build a test framework or second gate.
4. independently review the final diff for duplicated state/actions, changed
   epub behavior, route/interaction conflation and unintended data writes.
   update the compact-navigation description in `docs/modules/reader-implementation.md`
   and the instrument-consumer list in `docs/modules/workspace.md`. record
   actual evidence here.
5. after acceptance, delete the resolved picker ticket
   and only its register entry. keep the adjacent tickets below open.

## focused acceptance

use actual imported documents through the normal reader. static checks cannot
establish arrival, interaction or persistence behavior. do not use production
reading data for mutation-sensitive checks.

| case | observation required |
| --- | --- |
| article parity | nested/skipped levels and repeated labels appear in source order; picker and buttons reach the intended visible heading; ordinary scroll updates the current label/count |
| empty/single | zero-heading article and zero-section epub have no dead instrument or reserved gap; one-heading article remains navigable; pre-heading text shows the unselected state |
| epub preservation | ordinary epub selection, previous/next, cross-fragment loading and address behavior remain correct; duplicate-position destinations retain existing movement semantics |
| quiet navigation | after existing saves settle, compare cursor/revision, engagement and completion around jumps without subsequent prose input; no jump-caused write or extra pane-history entry; ordinary reading afterward still saves |
| supersession and isolation | commit a second destination before the first finishes, and switch documents/panes during navigation; the latest applicable request wins and no old options or completions affect another pane |
| interaction/layout | pointer and native keyboard selection/dismissal retain visible focus; narrow desktop and actual hosted mobile allow long-label selection; chrome reveal and find open/dismiss preserve access and state |
| excursion | when a departure is available, a successful toolbar jump establishes the existing return origin; subsequent successful jumps retain it until the existing lifecycle clears it; a superseded request cannot replace it. exact pixel return is outside this slice; record observed drift against its existing ticket |
| unaffected surfaces | sidebar still shows hierarchy; pdf keeps page controls. confirm offline preservation by diff review; exercise the downloaded reader only if shared-code changes affect it |

record candidate sha, document cases, browser/device, static result and observed
outcomes. record unavailable device/assistive-technology checks as not run or
blocked, never passed. the authorized red/green work used temporary live scripts;
delete them after acceptance. no persistent automated tests are required for
this slice under [current testing standards](local-rules/testing-standards.md).

## hard cut, costs and completion

remove the old epub-only user action, instrument gate, `EPUB controls` label,
and instrument-only `epubSections` assumptions/dependencies. leave one shared
instrument and one user command, with no old/new branch or compatibility alias.
format-specific positioning adapters are necessary current behavior, not legacy.

costs: articles gain a control row; title-only articles can have a modestly useful
one-item picker; flat native options omit hierarchy and long-label presentation
varies by platform; zero-section epubs lose their empty row. offline receives
no new compact control. these are accepted scope choices; the sidebar continues
to supply full structure. rollback is the previous frontend build, with no data
migration or stored-source change.

separate work remains ticketed: [multiline labels](tickets/web-article-contents-truncates-multiline-headings.md),
[authored anchors](tickets/web-ingest-replaces-authored-heading-anchors.md),
[empty inspector contract](tickets/reader-empty-contents-availability-contract.md),
[saved cursors](tickets/web-publication-invalidates-saved-reader-cursors.md),
[contents flash](tickets/reader-contents-publishes-after-navigation.md),
[return drift](tickets/document-map-return-drifts-per-round-trip.md), and
[physical accessibility review](tickets/reader-map-inert-position-and-mobile-controls.md).
do not reimport articles or conceal those defects inside this feature.

done means the shared controls work with recorded acceptance, static checks pass,
the old instrument path is gone, and owning docs/ticket closure match actual
evidence. unresolved required acceptance remains incomplete unless the owner
explicitly waives it. merge and deployment have not occurred.

## implementation evidence

candidate: branch `feature/article-section-navigation` in isolated worktree
`/Users/nnandal/Documents/code/nexus-web-article-section-navigation`, based on
`cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`. final candidate sha to be
recorded after commit. the main checkout's unrelated work was untouched.

the temporary live suite ran against the normal import and reader paths on an
isolated app/api/auth/storage/database stack. before the change, the w3c headings
article had six navigation sections and populated inspector contents but zero
`Select section` controls. with the change, its six options matched the response
order and identities; selection and previous/next reached visible headings, and
trusted scrolling changed the semantic counter from 1/6 to 6/6. the mdn article
kept four distinct `Result` destinations. one-heading and pre-heading cases
retained the specified states; empty article and epub had no compact instrument
or gap. the epub import retained 31 options and chapter ii/iii movement with
exact `loc` changes. the 25-page pdf retained page movement.
the epub's chapter ii publisher and generated-heading ids share one fragment
and offset; both remained distinct options. next skipped the same-position
sibling for chapter iii, previous returned to chapter ii, and previous from
within chapter ii returned to that chapter's start.

with a settled disposable cursor, section jumps caused no revision, engagement,
completion, activity or pane-history change; a subsequent trusted wheel advanced
the cursor revision from 2 to 3. a held epub fragment response superseded by a
second selection left the latest chapter visible. return restored the original
chapter after supersession. failed latest arrival, inspector dismissal and a
workspace-tab switch did not publish a stale return origin or leak options into
another pane. a full-page article deep link can separately revert during
workspace bootstrap; it is [ticketed](tickets/workspace-deep-link-reverts-during-reader-jump.md).

desktop pointer/typeahead kept native select focus and its visible ring; an
800 px viewport kept the revealed instrument within the viewport. on an actual
android 16 chrome 151 phone, the native picker showed the full long label,
selection visibly reached section 4/6, and find dismissal restored it. the
downloaded article opened in the physical android app's offline reader with six
headings and the document map. with airplane mode on, wi-fi off and no active
network, its overview rail moved from the final heading to `heading ranks`,
updated progress from 100% to 11%, and exposed `return to reading position`;
no hit-height error appeared. a screen reader was not run; native control
semantics and keyboard behavior were checked without claiming assistive-technology
acceptance. `./scripts/test` passed on the current product diff; it is static
evidence only. the map rail's transient zero-geometry failure was reproduced
on 4/8 loads, repaired at its measurement owner, then absent on 8/8 repeated
hosted loads and the physical offline run.

the retained epub `loc` after return is a [separate routing issue](tickets/epub-map-return-keeps-jump-loc.md):
the semantic reading position was restored, but the coarse url remained on the
jump chapter. this change does not alter cold-load url contracts. native flat
options also forgo hierarchical context; the inspector retains it. no reimport,
stored-source rewrite or new offline compact control was introduced.

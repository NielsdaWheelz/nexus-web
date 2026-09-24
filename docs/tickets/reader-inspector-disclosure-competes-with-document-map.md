# reader inspector disclosure competes with document map

status: open; design approved, implementation not started
origin: 2026-09-24 reader sidebar council; checkout `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`
area: reader / workspace interaction

problem: the reader exposes two nearby ways into the same resource inspector
with different names and semantics. the header's panel icon is called
"Companion" and toggles the inspector, restoring its last valid tab. the
overview rail's literal `≡` opens contents, or evidence when contents is absent.
the mobile position ribbon adds a separate "map" button. these affordances
make layout visibility and document navigation unnecessarily hard to distinguish.

evidence:

- `apps/web/src/components/resource-inspector/companionAction.tsx:32-54`:
  `PanelRightOpen`, "Companion", shared disclosure and toggle.
- `apps/web/src/lib/dossiers/useResourceInspector.ts:293-315`: restore the
  last valid surface and pass the header trigger for focus return.
- `apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx:419-430`:
  literal `≡`, "Open document map", optional detail callback.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:6517-6519`:
  map action selects contents/evidence rather than toggling the inspector.
- `apps/web/src/components/reader/MobileReaderPositionRibbon.tsx:13`:
  separate map opener beside the passive position presentation.
- `docs/modules/reader-implementation.md:362-365` says the rail contains no
  generic open control; clarify the distinction or reconcile it with the
  selected design. `docs/modules/workspace.md:455-457` likewise says there is
  no generic document-map opener despite the targeted opener being present.

history: `e169805fa95cc77aa54e57134e0de1e65ea2ef90` added the rail and mobile
map openers while retaining the generic companion action. this is an intentional
targeted shortcut whose product distinction is unclear, not duplicate state.

contract: [approved implementation plan](../reader-inspector-controls-plan.md).
the shared control is `inspector`; mobile retains the existing header recovery
policy. implementation must establish the plan's live acceptance before closure.

proposed fix: retain the existing workspace disclosure owner; remove redundant
reader map openers and dead callbacks/styles once a reachable replacement is
established. give the canonical control a clear name, state and spatial mapping.
preserve direct rail destinations and existing exact navigation/return behavior.
update the owning reader/workspace docs. no new inspector state or backend work.

acceptance: desktop and mobile have one obvious primary inspector disclosure;
contents, evidence and dossier remain reachable; open/close and restored-tab
behavior are predictable; keyboard focus and mobile sheet dismissal return to
the actual opener; progress and reading position do not change from disclosure.
check narrow panes, retreated mobile chrome and downloaded-reader contents before
removing controls. the downloaded reader already has an independent named toggle
at `OfflineDocumentReader.tsx:693-697`; preserve it when removing its rail opener.
record manual observations separately from static checks and physical
accessibility acceptance.

# reader inspector keyboard toggle disagrees with header

status: open; source-confirmed, runtime reproduction not run
origin: 2026-09-24 reader sidebar council; checkout `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`
area: reader / keyboard interaction

problem: bare `g` and the header's companion control do not toggle the same
concept. with dossier open, the header closes the inspector; `g` selects
contents/evidence instead. reopening by `g` also discards the remembered tab.

evidence: `MediaPaneBody.tsx:4581-4585` counts only contents/evidence as active;
`:5511-5520` closes those or opens the reader default; `:5530` calls this
"toggle Companion". `useResourceInspector.ts:264-268` counts any visible
inspector surface; `:293-315` restores the last valid surface and closes the
whole inspector. paths are under `apps/web/src/app/(authenticated)/media/[id]/`
and `apps/web/src/lib/dossiers/`, respectively.

contract: the [approved plan](../reader-inspector-controls-plan.md) makes bare
`g` the generic inspector toggle.
proposed fix: dispatch that shortcut through the existing canonical inspector
command; retain distinct commands for explicitly selecting contents/evidence.
remove the competing reader-local visibility interpretation.

acceptance: header and bare `g` agree when closed and when contents, evidence or
dossier is selected, including remembered-tab reopening. editable fields and
modal ownership retain their existing keyboard exclusions. manually reproduce
the dossier case before and after the change.

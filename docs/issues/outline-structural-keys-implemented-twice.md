# outline structural keys are implemented twice

problem: the structural-selection grammar (space, escape, enter, tab/shift-tab,
arrows, move chord, undo/redo, delete/backspace) is written out in both
`apps/web/src/components/notes/OutlineSurface.tsx:85-115` and
`apps/web/src/components/resources/ResourceOutlineRow.tsx:311-333` (main
`e2719572c`). the copies already differ: one unlinks every selected target, the
other only the selected occurrence; undo uses the same chord, move the same
platform sniff.

impact: a key change lands in one copy and not the other, so note outlines and
connection/evidence outlines drift apart.

proposed fix: one structural key handler owned by the outline session or the
occurrence target, with the surface supplying only its rows and unlink scope.
the outline touch accessory change shares only the tab/move matcher
(`outlineStructuralCommand` in `lib/shortcuts.ts`) and puts f2 in
`ResourceOutlineRow` alone; the rest of the duplication remains.

resolved when one handler serves both surfaces and the selection behaviour is
identical in a note outline and a connections outline.

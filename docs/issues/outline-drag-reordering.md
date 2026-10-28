# direct outline drag reordering is deferred

the initial editor proposal retained six fixed commands and deferred direct
drag reordering to avoid conflicting mobile gestures. arrow movement is
implemented and qualified; that does not provide gesture parity with a
draggable outliner.

`apps/web/src/components/notes/OutlineCommands.tsx` exposes movement commands.
`OutlineEditorRow.tsx` owns bullet navigation/selection and disclosure, while
`lib/notes/outlineController.ts` applies arrangement commands to an occurrence.
there is no outline occurrence-drop placement contract in those owners. ordinary
resource dragging or rich-text drops do not establish structural reordering.

resolve by explicitly excluding direct dragging from the bounded editor target,
or defining and qualifying its selection, drop/reparent, caret and undo behavior
through the same graph command owner. do not describe the existing six-command
workflow as full gesture parity while this decision remains implicit.

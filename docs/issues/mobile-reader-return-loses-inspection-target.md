# mobile reader return loses the inspected passage

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: workspace / reader return state

problem: mobile pane switching unmounts the reader. after a source deep link is
consumed, returning to its pane reconstructs from the shared saved reading
cursor, losing the inspected passage and its decoration. duplicate reader panes
therefore cannot retain distinct inspected positions across mobile switching.

evidence: `apps/web/src/components/workspace/WorkspaceHost.tsx:72` renders only
the active mobile pane. `apps/web/src/lib/documentReader/DocumentReader.tsx:105-140`
creates the reader runtime in the mounted component.
`apps/web/src/app/(authenticated)/media/[id]/hostedReader.ts:219-237,289-295`
removes consumed source targets from pane urls. restoration in
`apps/web/src/lib/documentReader/runtime.ts:290-305` uses the new entry or the
shared media cursor; the runtime does not publish an inspection memento.
source-confirmed; no live execution.

prerequisite: keep per-pane viewing position separate from the media's one
durable resume cursor and from unsaved editor state.

proposed fix: retain the reader's view/inspection target in the existing
pane-visit data mechanism and restore it on remount, guarded by source identity.
do not save inspection as reading progress or keep every mobile reader mounted.

acceptance: open two passages of one media in separate panes, switch between
them on mobile, and return through pane history: each restores its own passage
and inspection decoration while the durable reading cursor remains unchanged.
a changed source retires unresolvable view state explicitly.

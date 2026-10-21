# outline note edits do not expose their writing status

at `5eca855d4`, private run `20261021-125632-fe36feba9150`, offline split now
retains the child's exact input, but no completed local/offline status appears.
`CanonicalNoteEditor.tsx` renders conflict only; `OutlineEditor.tsx` renders
writing status only for the outline root/title. paths are under `apps/web/src/`.

show the affected note's existing writing status at its body owner, keeping
ordinary clean rows quiet and avoiding duplicate root status. resolved when the
offline split case observes completed local status, exact checkpoint and undo,
while normal input still avoids whole-outline rerenders.

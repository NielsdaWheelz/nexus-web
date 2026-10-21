# reference ownership can leave a retained editor read-only

lab `20261021-155433-eebfea3173b7`, retained shared-note inverse case: the server
accepted `insert_link` and local binding correctly replaced the provisional note
ref with the retained canonical ref. trace 52584 showed the provisional editor
editable; trace 52802 showed the canonical editor at the same fresh-link occurrence
with `contenteditable=false`. it stayed read-only until the case timed out.

`useReferenceInput` changed its visit-local draft cell when `editorKey` changed,
but retained its old opening handle. the new cell started unready and the old
opening prevented acquisition. its native branch lifetime now follows
`draft.owner`; owner plus opening identity fence async callbacks, and cleanup
releases every old opening promise without discarding raw writing. it does not
alter existing editor creation or journal lock gates.

implemented, awaiting live verification. resolved when the unchanged retained-note
inverse case retains the parent editor, makes the canonical child editable and
delivers its next edit to the retained canonical note.

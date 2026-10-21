# retained undo binding replaces an active editor

hold the real acknowledgement of a shared empty note's structural removal, undo,
and type into its fresh provisional child. this window remains open until that
reply arrives: `useOutlineSession.step` blocks pending preserving unlinks, not
this structural removal. later local binding maps the provisional body to the
retained canonical note.

`NoteEditor` recreates its view when `editorKey` or `reference.owner` changes,
resetting selection, composition and editor-local history. completed prose is
retained, but the ongoing interaction is disrupted. ordinary first publications
keep their fixed note ids; this is the retained structural inverse path.

lab16 (`fae96229c`, `20261021-164438-723cb535048c`) reproduced this with a real
held remove reply, pending inverse and durably checkpointed rich successor.
both retained-base variants disconnected the original child and lost focus,
native selection nodes and offsets; the parent remained connected.

implemented: the existing visit and body occurrence own the view; the root's
empty occurrence uses its resource key so zooming still resets it. canonical
reference/query authority remains current through the existing handler refs.
each focus serial is consumed once per view. awaiting live qualification.

resolved when a real held-remove → undo → rich successor → acknowledgement
journey retains the same child editor, focus, native selection and session
history while adopting the canonical note. preserve real navigation resets.

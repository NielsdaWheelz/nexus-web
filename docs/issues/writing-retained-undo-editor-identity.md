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

lab17 (`ad7815f03`, `20261021-170114-42049dd78ecb`) still disconnects the child
in both variants. its fresh-link occurrence key remains unchanged and the parent
remains connected. journal delivery, rich successor preservation and the genuine
historical-mismatch refusal now pass. the remaining ancestor/body-mode handoff
is not localized; the next temporary case captures passive ancestor identities
and removal/addition records without changing the acceptance assertions.

run18 (`2808a6124`, `20261021-173813-e9aef096df90`) localizes the remaining
replacement: canonical binding first updates the original editor and row in
place. then the entire child li disappears for roughly 34 ms while its ul and
all higher ancestors survive. `consume` recorded no occurrence placement in its
history entry. its inverse therefore skipped `commit`'s pending occurrence
admission. after the inverse ack, `receive([])` adopted the parked post-removal
adjacency without that overlay; the next canonical read recreated the row.

implemented at the structural owner: consume and join retain the removed row's
exact occurrence key, item and source in the existing history contract. undo
therefore admits the existing pending overlay until canonical adjacency adopts
that edge. no new editor lifetime or overlay mechanism. awaiting live green.

resolved when a real held-remove → undo → rich successor → acknowledgement
journey retains the same child editor, focus, native selection and session
history while adopting the canonical note. preserve real navigation resets.

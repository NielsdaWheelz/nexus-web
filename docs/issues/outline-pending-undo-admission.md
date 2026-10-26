# pending flat writing can consume and discard undo

external candidate `f07f1963eb` passes immediate firefox continuation through
return, indent, outdent and move, but its first undo leaves the final `s` intact
through the ten-second assertion deadline. canonical run
`20261025-235607-29c813d0cd74`, `mobile-editor-firefox.spec.ts:44` failed;
the following hint and last-unlink cases did not run.

the trace's passed text assertion immediately before undo (`cddl@130`, then
`cddl@132`) still marks the exact target field `data-outline-pending=true`.
`LocalOutline.tsx:121` skips history undo while pending input reports changed or
unconfirmed; `outlinePending.ts:73` reports changed for every raw field. the
editor consumes the key, and later settlement cannot replay it. this supports
an input-admission defect; the trace does not directly instrument that branch.

the editor owner must preserve undo in the existing ordered input owner without
dropping later writing or adding an independent queue. resolve with the same
immediate-undo journey and affected pending/structural history cases on the
integrated candidate. waiting for save before pressing undo would evade the bug.

the raw-stage repair needs canonical identity, not just delayed dispatch. for
raw `ab`, delete `b`, then receive unseen `x` before `b`: canonical yjs undo can
restore `b` with anchors depending on `x`. replaying that inverse into a frozen
raw clone lacks its dependencies; restoring the earlier body loses concurrent
writing. before the runtime repair, `commands.ts` created the actual initializer only
after runtime store/lease admission, so immediate history cannot own it.

a new note must receive its one real initializer at semantic admission, with
creation reserved before subsequent edits. this alone is insufficient: split
and join also change existing documents. ordinary document listeners would
autosave those changes separately from their atomic structural command. the
runtime needs one bounded synchronous command admission that captures the actual
canonical yjs mutations and persists them with their graph intents. callbacks
must await only predecessor proofs captured before their own reservation, never
their own pending frontier. history must seal the actual group at admission,
rather than select the latest group after waiting.

the approved runtime boundary is one synchronous `admitWriting` call declaring
existing document/origin pairs and new-note bodies, a synchronous canonical
mutation, and asynchronous graph-only preparation. it reserves the existing
command order before publication, seals initializers and deltas once, and keeps
participants pinned through the existing eventual commit/retry owner. partial
mutation failure retains unsaved writing and blocks later commands; retry never
reruns that mutation. this boundary is implemented in `59f316fa9`, simplified in
`658a499a6`, and passes the static gate. real sqlite/yjs run
`20261026-020746-90bfa6cea63c` proves creation/edit/inverse/edit ordering before
the first receipt, retry without repeated mutation, and copy/discard of separate
queued notes. its injected store adapter does not qualify editor or native input.

ordering barriers, displayed forward-delete identities, and history-owned inverse
coverage are distinct. awaiting a broad capture cannot authorize deleting its
foreign touches. a consumed inverse must publish its causally complete actual
post-undo body before subsequent input; it cannot install inverse-only bytes into
an obsolete displayed clone. the consumer rewrite and unchanged immediate-undo
journey remain required.

preserve offscreen settlement too: old-controller run
`20261026-033916-75451f0eb8dc` passes real blocked creation, same-pane navigation
with the prior session unmounted, exact durable body/link, and browser close
without a loss warning. this is a baseline control; the transient owner-null
early return was found in the consumer rewrite, not in `ec33256fa`. rerun this
unchanged control on the integrated replacement.

replacement run `20261026-040739-aa1f8f7f61d5` on `671837d36` passes that
unchanged offscreen control, including canonical body/link and zero beforeunload
dialogs. the same run passes alias byte admission/writing/release/retry and the
48-edit manual-tail control. those controls are no longer open here.

the replacement consumers are integrated from `f8c2b2ed3`. that checkpoint's
text redo duplicates occurrence nodes; the projection repair in `671837d36`
passes the unchanged full firefox journey, including undo/redo, joins and exact
canonical final writing (`20261026-040010-ee608cb2729b`, 4.3 seconds).

held-receipt run `20261026-040315-c76a1871aec4` passes first-glyph undo followed
by fresh typing and return. the split/two-undo/following-split case passes exact
canonical bodies, resource visibility, links and untouched control, then fails
`outline-immediate-pending-history.spec.ts:83`: the still-visible source retains
`data-outline-pending=true`. the cause and whether any work remains unacknowledged
are unestablished. resolve that owner state and pass the unchanged held controls;
do not replace the marker oracle with a delay or infer native qualification.

# unfinished ime preedit is admitted as authored writing

`NoteEditor.tsx:692–735` defers composition only for an empty reference-capable
paragraph. other composing transactions reach `onEdit` at lines 910–924, then
`useOutlineSession.ts:2680–2734` and `texts.ts:313–345` checkpoint/admit them.
this violates `writing-performance-spec.md:147`: unfinished preedit is provisional.
an interrupted composition can therefore retain or send text the user never committed.

native run17 at source `ad7815f03` records rich `We r` in an autosave authored
snapshot at revision 2. the same editor's second trusted composition starts at
event 48; inputs 51–76 remain trusted and composing. the next end/committed input
are events 77/81, with final text `We still `. evidence:
`.nexus-local/lab/20261021-170114-42049dd78ecb/artifacts/writing-device/first-publication-ime-failure.json`.
the end event's origin is unknown; its trust is not inferred.

fix at the editor owner: retain preedit locally and publish one exact rich edit
when composition commits, preserving editor identity, selection and history.
prove no preedit draft/outbox admission during real native composition, followed
by exact committed rich durability and publication across a held first ack.

implemented at the editor: every composition retains its starting rich body and
selection, composing transactions paint without prose or raw-query checkpoint,
and the existing completion path publishes the committed result. acknowledgement
projection also waits for that composition boundary. awaiting native green.

same scope remains in page titles: `OutlineEditor.tsx:270–274` sends every
composition `onChange` through `useOutline.ts:499–510` to `editText`/`persist`.
the enter-key guard did not protect change or blur. the adapter now keeps its
provisional value local and calls the existing title owner once on commit;
unchanged cancellation adopts the latest title. awaiting native verification and
the captured-authority fix below.

`ReferenceRowEditor.tsx:453–466` also copies composing text into its retained
visit draft before returning. its initializer at line 156 restores that cell as
ordinary document text after remount. this does not checkpoint indexeddb, but
promotes provisional text into retryable continuation text. the adapter now
retains the committed cell until the existing composition completion publishes
its final value. awaiting native verification.

remaining authority hazard after buffering: a clean text at a/v1 can adopt a
remote c/v2 through `texts.ts:210–216` while the editor alone holds b preedit.
the editor defers projecting c, but its eventual a→b edit reaches ordinary
`editText` with current acknowledged c/v2. `useOutlineSession.editBody` ignores
`edit.before` for version authority, so b can silently overwrite unseen c instead
of conflicting against v1. changed title preedit has the same race. preserve the
composition's observed base/version through commit; unchanged cancellation may
adopt c. the existing deferred edit base is now `TextEditBase`, shared by body
and title commits. composition captures the actual value and acknowledged version;
`editText` records a differing current canonical value as a conflict without
autosave. its captured expectation advances only when the current acknowledged
value equals the captured local value and the owned draft retains the exact
accepted desired fact for that ref/lane, captured starting version and accepted
version. this covers both unpublished a→first ack and saved z/v1→pending a→b
composition→own a/v2 acknowledgement; independent reads supply no such proof.
clean-row cleanup retains this proof in the owned memory seed until the next
committed edit renews the branch. missing proof keeps the comparison for review;
no new receipt retention exists. awaiting real foreign-update/native verification.

when the clean owner adopted c during local preedit, the conflicting commit now
uses an existing fresh journal branch seeded with actual captured a, committed b
and saved c. only a clean owner without pending authored work may fork; the old
confirmed row is never rewritten with a stale base. resource/editor identity
stays fixed, the new branch follows existing lock/checkpoint/export ownership,
and the old clean handle releases through its existing asynchronous contract.
this changes one branch id at a real conflict and keeps a/b/c after reload/export.
failed-storage or unfinished local work does not qualify as a clean fork. a
committed value already equal to the actual current canonical value needs no
write or new causal proof; preexisting conflicts remain. awaiting qualification.

run18 at `2808a6124`, lab `20261021-173813-e9aef096df90`, passed the actual
native first-publication and numeric-acknowledgement boundaries: no preedit
checkpoint, same editor/focus/selection through acknowledgement, then exact rich
committed durability. the real foreign-update journey also retained original a,
local b and saved c on disk without sending b. run21 at `f8250653b` also passed
the real saved-version touch and canonical decision. the earlier driver click
used the wrong visual-viewport coordinates; no product layout defect was proved.
html title composition remains unqualified; its deferred
completion retains the captured base through the following native input and
reads that same actual input's committed value once.

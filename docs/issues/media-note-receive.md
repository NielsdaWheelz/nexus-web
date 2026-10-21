# annotation note receive ordering and retry

problem: annotation preview adoption can apply an older acknowledgement after a
newer body read. a failed background body refresh can also remain stale without
a visible retry.

impact: the media preview can roll back or keep old note text while the canonical
text owner has newer content. the mounted note can miss the receive budget.

evidence: the initial implementation of
`apps/web/src/app/(authenticated)/media/[id]/annotations.ts::receiveNote` patched
preview body/version without checking the current version. its body watch and
`apps/web/src/components/notes/AnnotationNoteHost.tsx` used one-shot reads; the
receive owner suppresses repeated invalidations for the same stale version.

source repair now prefers the newer canonical body and uses the existing
abortable `requestWithRetry` in both watches. that helper makes three attempts;
exhausted failures still need qualification for reconnect/manual retry. no new
retry owner was introduced. runtime proof remains pending.

resolved when: the preview rejects older body versions, the existing abortable
read retry owner handles transient failures, and real reordered-ack/read plus
failed-read/reconnect cases show convergence without a whole-media body reread.

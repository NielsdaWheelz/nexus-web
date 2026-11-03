# attachment refusal can erase an earlier unknown upload

problem: attachment consumers can drop their pending UI owner after a later refused
replay, although the original confirmation remains unsettled. the shared attempt
now preserves its immutable confirmation; consumer lifetime must preserve it too.

impact: the held retry and work guard disappear while acceptance remains unknown.
a connection retains the task only in an expiring plain retry callback; a note
attachment can lose the file and retry outright.

evidence at12cd8e7ce, source-only: `apps/web/src/components/notes/NoteEditor.tsx:685-694`
handles a later generic409 through `setAttachment(null)`; connection attachments
`useConnectionAttachments.tsx:182-189` can clear unconfirmed/retire the task after a
later refusal. typed bytes-missing also proves only the current confirmation could
not read staging; an earlier candidate may already be publishing. this is separate
from the preflight GET failure fixed at12cd8e7ce.

resolve by retaining prior unknown independently of the current refusal, using each
existing attachment owner. clear only on accepted result or an exact permanent
fence; shared UploadAttempt.confirmation_unsettled prevents review from rewriting a
possibly dispatched confirmation. prove unknown-confirm503, later409, wait past8s,
then deliberate same-byte retry, with no automatic write on wake. root owns the
bounded l2b/l4 follow-up; no new registry or upload protocol is needed.

partial repair: NoteEditor now retains its frozen file/attempt and unknown through typed
BytesMissing, Unresolved, authority refusal and ordinary transport refusal using
confirmation_unsettled. shared permanent publication fences still retire the attempt.
connection-attachment repair and fresh review of both consumers remain required;
this record stays open until both owners are qualified.

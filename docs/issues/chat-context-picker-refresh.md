# chat context picker refresh

selecting an existing item can leave future context unchanged until a new read.
the local link commits, but the composer’s immediate server read can precede
upload. the selected item then lacks visible confirmation.

`ResourceComposer.tsx:78–88,115–124` finishes after local `createLink` and calls
`onSaved`; `ChatContext.tsx:40–44,67` refetches server membership immediately and
subscribes only to `Notes`, `NoteBodies`, `Metadata` stamps. this sequence also
exists on base `9c809765c`; the row change does not alter it.

observed in the disposable picker journey: after image-note selection, the row
was absent for 10 seconds. the trace’s pre/post-selection context reads returned
identical five-item bodies. a separate qualification observed both selected refs
in authenticated server context and both rows after reload. upload/refetch timing
is the suspected cause, not a fully isolated concurrency proof.

the import doors run `20261102-233217-2c4160318cff`, on held head `1b63b5706`,
also observed a claimed chat file drop confirm with 200 while its context row
stayed absent for 60 seconds in both browsers. only the pre-drop context read
appeared in the page trace. `useConnectionAttachments.tsx:89-91` commits through
`createLink` without a context refresh callback. that run did not independently
read post-upload server membership, so it does not establish link durability.

resolve at the boundary between local link completion and server-owned context
refresh, preserving immediate durable local writes and offline behavior. do not
substitute local graph membership for the server admission owner. admission/sync
changes are excluded from the chat-context-row specification.

resolved when a real picker selection reaches server admission and appears in
the already-open context without reload, including delayed upload. exercise the
existing-item link, newly composed note and file attachment paths.

chromium lab `20261103-002002-2f1baa7d0845` additionally observed the actual
public context membership exactly once and the same row after ordinary reload;
the open view still showed no row before reload. this qualifies persistence for
that file attachment, not live refresh. firefox setup did not reach its drop.

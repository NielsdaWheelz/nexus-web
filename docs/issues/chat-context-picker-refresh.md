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

resolve at the boundary between local link completion and server-owned context
refresh, preserving immediate durable local writes and offline behavior. do not
substitute local graph membership for the server admission owner. admission/sync
changes are excluded from the chat-context-row specification.

resolved when a real picker selection reaches server admission and appears in
the already-open context without reload, including delayed upload. exercise the
existing-item link and newly composed note paths.

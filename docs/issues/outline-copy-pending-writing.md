# copying pending outline writing

while a first local commit is failed or awaiting retry, `OutlineDraft.tsx` keeps
later typing and completed return segments in its retained draft. those words
have not yet entered the runtime document or its frozen creation intent.
`LocalOutline.tsx`'s stopped-store “copy writing” action calls only
`WritingRuntime.uncommittedText()`, which sees the frozen intent and runtime
documents. it can therefore omit later words still owned by the temporary input.
the draft's save-error UI currently offers retry but no complete draft copy.

reproduce with an actual first local commit failure, continue typing/returning,
then use copy writing before restarting. compare copied text with every visible
pending segment and the active body. this is source-evidenced, not fault-injection
qualified.

resolve at the retained input owner: expose a copy action that includes its
current completed segments and active writing. preserve the runtime's exact-byte
retry and the loss guard; no recovery inventory or new persistence is needed.
prove all later words can be copied before an explicit restart/discard.

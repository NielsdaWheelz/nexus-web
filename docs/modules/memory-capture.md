# shared memory capture

`services/memory_capture.py` owns future-only export of the configured owner's
durable librarian turns. shared-memory reads and explicit note saves remain with
[model tools](model-tools.md); archive, tree and retrieval remain in the external
`universal-memory` library hosted by jarvis. this adopts jarvis adr 0070's source
contract, `nexus-turn-capture-v1`.

automatic [chat orientation](chat.md#historical-orientation) reads a frozen ready
shared view independently of capture. terminal settlement, periodic publication
and host compaction are separate stages; a new question does not wait for its
predecessor to reach them. ready/admitted positions describe central progress only,
never pending local exports or uncaptured external events. recent exact context
bridges some of this delay without claiming read-after-write memory consistency.

## admission and persistence

the existing account mutex fixes one capture uuid and the first eligible question
sequence in `librarian_state`. activation never scans old runs or moves the cut.
new send/retry admission stamps that uuid only for the configured owner while
`capture && admit`; connecting model reads is independent. old runs remain
ineligible even when they settle after activation.

the sole `chat/events.finalize` freezes exact canonical question/answer, saved
attachments, published citations and persisted tool receipts after terminal
publication and pruning. fresh sql reads follow the flush; cached message objects
cannot substitute for those rows. snapshot, terminal state and next export
sequence commit together under the account mutex. exports follow settlement
order, not question order. a cancelled later question can therefore reach shared
memory before an earlier queued question executes. the chat owner's execution-time
knowledge contract permits that context; capture adds no question-sequence filter.
no network call runs in that transaction.

`memory_exports` has no cascading relationship to deletable turns or evidence.
its identity, canonical payload and digest are immutable. only its content-free
parked code changes. deletion, later undo and retries never rewrite an export;
already-recorded undo state is part of the snapshot. retries are new turns with
their existing lineage. prompts, reasoning and transient tool bodies are excluded.

## delivery and operations

the existing periodic background job activates locally, registers the same source
centrally, then publishes the lowest pending export sequentially. overlapping
jobs converge through central duplicate receipts and exact local cleanup. central
archive/leaf/progress commits before acknowledgement; only an exact matching
receipt permits deletion. response loss retains the original payload and digest.

ordinary later scheduling retries outages. auth refusal ends the invocation;
schema/digest/size/conflict parks the head for repair without cropping, skipping,
resetting or regeneration. local snapshots may exceed transport bounds so a valid
terminal turn is still durable. the publisher uses the shared 16-mib request bound.

`nexus memory-capture-status` reports local boundary, count, oldest pending time
and parked code; unavailable central progress is unknown. `memory-capture-retry`
clears only one exact parked diagnostic. both use the existing maintenance role.
when publisher configuration is disabled, these commands take the owner from the
existing client file and retain local status/repair; central progress stays null.
when both files are present their owner/capture/admit must agree. no text enters
ordinary logs or status.

the private client file supplies owner/admit/capture to api and interactive
workers, including when `connect=false`: its required nullable `bearer` is null
exactly when disconnected. capture never requires model memory tools. the
separate publisher file supplies only upload authority to the
background worker; it grants no model tools. both are generated from the common
fleet declaration. changing capture settings requires stopped maintenance and
drained admitted runs. disabling keeps pending exports; account migration,
historical import and delete/edit synchronization are outside this contract.

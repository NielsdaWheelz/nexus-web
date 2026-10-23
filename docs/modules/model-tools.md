# Model tools

What a model may do inside Nexus on a user's behalf, inside a frozen grant: read
what the chat may see, make five kinds of additive writes, search and read the web,
and (for one configured owner) use shared memory. every call leaves one row;
nexus writes are attributable and undoable. remote memory saves are append-only.

Code: `python/nexus/services/tools/` (`contract`, `presentation`, `run`, `reads`, `writes`,
`assistant_writes`, `memory`), `api/routes/assistant_writes.py`,
`schemas/assistant_writes.py`; web `lib/assistantWrites.ts`, the chat card
(`components/chat/AssistantTrust.tsx`), the connections menu and settings
"Assistant writes" (`app/(authenticated)/settings/account/AssistantWrites.tsx`).

## Concepts

- **tool contract** (`contract.py`): the closed vocabulary. Ten Nexus specs plus
  llm-tools' web pair and universal-memory's six; per tool its input, success and
  error schemas, effect, byte limits, per-tool deadlines, result kind and
  activity verb. input schemas are what providers publish; nothing else is.
- **presentation** (`presentation.py`): one bounded semantic projection for saved
  calls and public tool frames: verb, subject derived from recorded arguments/
  results with current authorized resource labels, canonical resource/web target,
  useful parameters and meaningful outcome. no model-generated narration,
  provider-input revalidation or raw output dump. callers batch resource hydration.
  start supplies arguments only; result supplies its committed facts. saved reads
  alone carry current authorship/undo state. absent subject is not absent input.
- **plan**: plan id -> granted tool ids, in publication order: `NoModelTools`,
  `ChatReadAdditiveWrite`, `ChatMemoryRead`, `ChatMemoryReadSave`,
  `MetadataResearch`. Generation policy picks one; admission freezes it into the
  generation spec. A plan with an unavailable granted tool (no embedding key, no
  Brave key, memory not connected/admitted) is refused at admission and in the
  picker.
- **admitted scope**: the frozen resource URIs a generation may touch (a chat: its
  context refs at admission; metadata research: `media:{id}`). Reads also accept a
  pointer into an admitted parent: a `page_range:` of an admitted media, a complete
  user/assistant `message:` of an admitted conversation, a fragment-like ref whose
  media is admitted. Arguments and outputs never widen it.
- **tool call**: one `tool_calls` row per call that reached dispatch: generation,
  seq, dense position, principal, the chat answer (while it exists), tool, arguments,
  result, created refs, status, revert stamp. Its id is the effect id: note and
  highlight ids are `uuid5(call id, component)`; a memory save submits it.
- **write budget**: complete, unreverted Nexus writes of the generation; at 8 the
  next write is `WriteCapReached`; undo frees one. No-op writes count (D-Q4).
- **undo**: one route, `POST /assistant-writes/{tool_call_id}/undo`, for the chat
  card, the connections menu and settings.
- **machine authorship**: a read of the rows: the successful write whose
  `created_refs` name a target (GIN containment). it authorizes the receipt's
  undo, model-facing evidence and relations, and
  connections' "View creation".
- **citation candidates**: chat's; a call's staged retrievals feed them.

## Invariants

- I1 a nexus effect commits only in the transaction that completes its row, after the
  fence: generation open (`llm_calls` row lock), job claim live, and in a chat the run
  `running`, not cancel-requested. The row is committed, with the chat's start
  frames, before the handler runs.
- I2 one call in flight per generation; positions dense from 1 in dispatch order.
- I3 a name outside the frozen plan never runs and leaves no row, and the answer
  goes on. the provider route answers `ToolUnavailable`; on codex the binary
  answers its own refusal (`unsupported call: <name>`), a model error, not
  authority.
- I4 lock order: generation -> chat run -> job claim -> `tool_calls` row; chat's
  finalize takes run -> rows. generation closure locks its generation rows before
  settling their unfinished tool rows in the same transaction.
- I5 `created_refs` list exactly the targets the call inserted; nothing that
  existed before.
- I6 live Nexus writes per generation <= 8.
- I7 undo is principal-gated; every reversal and the stamp commit together; a second
  undo is a no-op 204. other absent targets count as reverted. library undo
  requires current named-library authority, the exact inserted entry id and its
  unchanged receipt revision. stale, absent or historical null-revision entry
  receipts return `E_RESOURCE_CONFLICT` atomically; default holdings survive.
- I8 history, authorship and undo outlive the conversation and the target.
- I9 the model sees a call's output only after its row committed; in a chat the
  output carries the call's numbered `tool_citation` sections.
- I10 memory tools run only for the config's owner, in a live chat; a save submits
  `submission_id` = call id, `native_conversation_id` = the chat.
- I11 terminal states: `complete` (Success), `error` (Failure, an escaping handler
  exception, or chat finalize), `cancelled` (a cancelled callback or stopped chat).
  An escaping exception rolls back local effects, settles its still-running row
  without inventing a result, then propagates unchanged. generation closure and
  dead-attempt recovery settle any remaining running rows in their transaction;
  cancellation uses `cancelled`, other interrupted calls use `error`. completed
  receipts and their results remain unchanged. late callbacks cannot overwrite
  settlement. Nothing treats `running` as finished.

## One call

Generation core holds one value, `ToolRun` (sessions, owner, generation, plan,
scope), and one callback, `run_tool(run, tool_id, arguments | refusal)`. The codex
transport passes the kernel-validated input; the provider route passes the
canonical call, the transport's refusal (`InvalidJson` -> `InvalidInput`,
`InputTooLarge` -> `BudgetExceeded`) or an unpublished name.

1. `_start` (one transaction): fence, next position, insert the `running` row, the
   chat's one `tool_call_start` frame, commit.
2. `_dispatch`: input envelope bytes, availability, strict validation, then the
   handler under the tool's deadline. Declared and boundary failures are results;
   anything else propagates after settling the receipt (I11). A stop cancels the
   codex callback here and marks its unfinished receipt `cancelled`.
3. `_complete` (one transaction): a Failure rolls back locally staged effects; lock the
   chat run; complete the row; in a chat, web snapshots for `web.search`, the call's
   retrievals, the `tool_result` frame and the numbered output; commit.

Writes (`writes._write`) admit every URI field directly, take the fence (held to
commit), count the cap, run the domain owner, and map reviewed owner refusals to
declared errors.

## Account history and undo

`GET /assistant-writes?generation_id=&before=` lists the viewer's finished write
attempts (result present), newest first, 30 a page, keyed by `(created_at, id)`;
an unknown cursor is 400 `E_INVALID_CURSOR`. the account surface uses the shared
collection owner with that fixed 30-row page size (`before`, no `limit`),
publishing and draining pages while its pane is active and the document visible.
a deep link focuses its row once on arrival; absence is established only after
source exhaustion. undo and manual refresh strictly invalidate the collection.
`POST /assistant-writes/{id}/undo`
answers 204; 404 `E_NOT_FOUND` when the row is not the viewer's write; 409
`E_RESOURCE_CONFLICT` for a failed write or one that created nothing; domain 409s
pass through.

Coordinator defaults the owner may reverse: one undo route (D-T3; reversing
restores a chat-scoped route), and rows outlive the conversation (D-T4;
`assistant_message_id ON DELETE SET NULL`, so "View creation" then opens settings
at `?generation_id=&tool_call_id=`).

## Shared memory

Production runs with memory unconfigured (the config file holds `null`). `MEMORY_CLIENT_CONFIG_PATH` names the private
owner declaration (`memory.MemoryClientConfig`); policy grants a memory plan only
to its owner on a processor chain it allows. One MCP session per call, never
resent; the server must answer one bounded text item. `memory.save_note` is a Write
outside the cap, the history and undo (D-Q3).

the client speaks the current private stateless json endpoint. sse responses and
session ids are `unsupported`; generic streaming/stateful compatibility is outside
this client. the sdk retains supported method-preserving redirects and notification
replies. the http boundary rejects unsupported redirects without logging their
destinations, retains status codes, and validates json-rpc with the sdk's public
adapter before its logger can expose private bodies. a request requires a response
or error with its matching id. tool
results must be one text item, without structured content or an advertised output
schema, within the actual serialized envelope bound and the requested tool schema.

expected transport/auth/protocol failures become `MemoryFailure` and complete the
existing tool row, so the model can continue. http 401/403/429 become
`unauthorized`/`forbidden`/`rate_limited`; connection, remote timeout and server
failures become `unavailable`; malformed or unsupported results become
`unsupported`. valid application error codes survive. known exception groups are
normalized only when every leaf is recognized; mixed known codes become
`unavailable`. unknown defects and cancellation propagate; the outer tool deadline
retains `DeadlineExceeded`. no retry, reconnect or alternate endpoint is added.

a save uses the original `tool_calls.id` and host-known conversation. after
submission, failure does not prove absence: the central note may have committed
even if nexus rolls back, times out or stops. client-normalized failures say so
in their existing notice; outer deadline/cancellation keeps its existing result.
report success only after a valid receipt. an intentional same-intent replay uses
the exact id/text/owner/conversation; a new model call, rerun or regeneration is
a new intent. there is no new recovery ledger or endpoint. local transaction
completion and undo cannot reverse a central note.

## Stale tabs

A change to the tool vocabulary the browser reads (effects, error types,
presentation) breaks a tab loaded from the last release, so it takes the one
`WIRE_REVISION` bump allowed before the next ([api edge](api-edge.md#wire-revision)).

## guarded library filing

`nexus.resource.inspect` returns `{resource: {kind: Media | Library, ...}}` from one
read-only snapshot. media retains its read map; a visible library supplies its
id, name, exact decimal `order_revision`, viewer `removal_revision` and
`can_manage`. all remains unmanageable. admitted scope and visibility still apply.

`nexus.library.add` requires a named `library_id`, resource uri and both frozen
revisions. it uses the public absolute placement owner; conflicts map to the tool's
`Conflict` refusal and require review, never refreshed-token retries. an actual
named insertion records its exact entry id and final revision. a no-op records
no undo ownership. filing personally retains media; undo removes only the named
filing. account history uses the same receipt eligibility predicate as execution.
historical entry receipts carry required `order_revision:null`; their provenance
survives, but their old undo authority is unproved.

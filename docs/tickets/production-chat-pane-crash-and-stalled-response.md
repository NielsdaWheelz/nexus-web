# production chat pane crash and stalled response

status: blocked on a reproducible exception · origin: 2026-09-25 user report and read-only production inspection · area: chat

the user reports pane crashes with retry for every model, in new and existing
production chats. a later send succeeded but appeared to load indefinitely;
the user suspects vps memory pressure during codex startup. the cause is not
yet established.

update: the later stalled run is traced to a host `invalid_request`, then
uncertain dispatch and exhausted queue attempts; see the existing
[dispatch-failure ticket](restored-chat-codex-dispatch-fails.md). the original
pane crash is still unproven. suspended-state display after queue exhaustion
requires browser observation; the user's loading report may precede it.

the user subsequently confirmed the pane shows "response paused". suspension
display therefore reached this browser. endless assistant-row loading is not
an established defect. composer feedback has a separate
[state-presentation issue](chat-suspended-response-announces-in-progress.md).

on 2026-09-25 the user said the earlier crash occurred one or two weeks prior
and is not reproducible. neither retained logs nor current browser evidence
identify its first exception or failing request. the local reliability changes
must not be presented as a proven repair for that crash.

both public `/version` endpoints and the host current pointer report
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`. api, workers, codex host, database,
and proxy reported healthy with 43 hours uptime. this is infrastructure
evidence, not a successful chat proof.

retained api logs from `2026-09-24T07:14Z` onward contain a successful send at
`2026-09-26T02:43:49.721194Z`, request
`0908df25-42bb-42ce-900e-2086003e37e6`. the subsequent run/tree/list reads and
stream connection returned 200 for run
`ac2b162e-0bb1-4b66-90f5-a9aaec0b3f22`, conversation
`f0c19bb2-efb2-401a-b5d8-258ba784768d`. no client-defect event appeared in that
retained api log window. this does not identify the earlier crash or prove
that every request reached the api.

the shared frontend escalates unclassified admission/read failures through
`ChatComposer.tsx:426-431,522-529,686` into the pane error boundary. acceptance
precedes canonical reads (`useConversation.ts:785-866`); a pane crash does not
establish that a message was rejected.

prerequisite: correlate the original browser exception with command, run,
worker/provider journal and memory evidence. repair the first broken owner
contract; preserve accepted receipts and uncertain work. do not blindly resend
or replace the existing recovery mechanism.

acceptance: the identified triggering condition is reproduced and repaired;
new chat and continuation display terminal outcomes; reopening recovers the
same accepted run without duplicate generation/tool effects. record separate
static, runtime and production evidence.

the [implementation plan](../chat-reliability-plan.md) owns the proposed repair
sequence. the original pane exception remains an explicit diagnostic gate;
preparing the plan does not close this incident.

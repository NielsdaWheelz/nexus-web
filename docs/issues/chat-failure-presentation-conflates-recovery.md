# chat failure presentation conflates recovery

`python/nexus/services/chat/reads.py:51-66` maps authentication, quota, rate
limits, runtime unavailability and interruption to `assistant_unavailable`, then
permits rerun for that category. `AssistantMessage.tsx:30` renders every case as
“the model wasn’t available.” authentication or quota may require an intervention
that rerun cannot supply. the read contract loses that distinction.

terminal tool receipts without a result become “no result recorded” in
`python/nexus/services/tools/presentation.py:400-401`; an error status adds
“didn’t work” in `apps/web/src/components/chat/MessageDetails.tsx:75-76`.
execution ending without a recorded result does not establish tool failure.

production run `e8190fe8-7898-4ac2-a352-9c6300325a25` on 2026-10-29 exposed
these ambiguities after database memory exhaustion. no duplicate execution or
visible card was established. [chat settlement](chat-recovery-erases-generation-failure.md)
owns the separate loss of a known generation failure.

preserve actionable causes in the read contract and derive copy and recovery
from those facts. resolve when auth, quota, interruption, actual tool failure
and internal defect retain truthful distinctions after reload. an absent result
must remain unrecorded, without inventing failure or an empty search result.

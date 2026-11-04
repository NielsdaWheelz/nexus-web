# connection scan start has no durable replay identity

problem: an unanswered scan POST and its explicit retry cannot be correlated by
the wire contract. a late original can enqueue another scan after the retry's
job finishes. passive status cannot prove which request accepted.

source evidence at14400e332: `python/nexus/services/connection_discovery.py:145-151`
deletes a terminal job before enqueue;169-181 selects status/result by selfRef
dedupe. `apps/web/src/lib/api/wire.gen.ts:4520` exposes status/outcome, with no
command receipt. this is a source-supported schedule, not an induced database race.

a successful explicit retry proves that attempt accepted and may settle its local
uncertainty; it does not permanently fence an earlier in-flight request. existing
active-job dedupe bounds concurrent work, not delayed repetition. feedback must
retain unanswered state through refused retries and passive idle observations.

if duplicate delayed work must be excluded, the scan writer needs an explicit
monotone admission/receipt contract shared by all callers. do not add a UI timer,
read loop or replay ledger. qualify delayed original, completed retry job and late
enqueue at the writer. this protocol change is outside feedback homes' non-goals.

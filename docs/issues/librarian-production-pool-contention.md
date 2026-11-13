# librarian fresh projection still costs about a second

the deployed `c828088` follow-up removed repeated authority checks, root extent
and apparatus reads, no-op capture helpers and discarded location text. three
stock-firefox runs on the 17-turn / 34-message corpus observed no http failures
or checkout exhaustion. fresh transcript paint still took 1,225–1,674 ms;
valid-draft send readiness took 175–1,674 ms. three physical-phone refreshes spent
836–867 ms in the api (median 854). retained returns and details were prompt. the previous
recurring multi-second waits were not reproduced in these checks.

the full timeline response is 225,238 decoded bytes. its owner remains the
complete response snapshot in `services/chat/reads.py`, `references.py` and
`resource_items/`; remembered-selection readiness also waits for its current
account read. current evidence does not apportion the remaining time among
database work, excerpt projection, transfer and recall contention. the broader
[authored hydration issue](unsynced-resource-reads-exhaust-the-pool.md) has its own
owner; [request lifetime](api-sync-work-outlives-request-cancellation.md) is separate.

this residual cost remains a follow-up after deployed-client qualification.
resolve by attributing it on representative fresh reads, then demonstrating a
proportionate repair at the responsible owner or explicitly accepting that cost.
preserve full payloads, snapshot authority and the recalled-selection fence;
new caching or capacity changes require evidence of the remaining cause.

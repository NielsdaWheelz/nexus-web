# production search exhausted postgres memory

status: open; production incident attribution and current capacity proof.

production `3d81ef45`, schema 0317, suffered postgres cgroup kills on 2026-10-26
at 18:11:49 and 18:16:12 utc under 512 mib. postgres terminated peers and recovered;
container restart count stayed zero, while api had no oom/restart. kernel counters
prove nonreclaimable demand exhausted the database leaf. a hybrid victim emitted
a planner warning naming indexed keyword eligibility relations; its truncated
statement does not identify a faulty allocator.

restored profiling reproduced exhaustion while warming retained ordinary
connections before another search. repeated reads on one backend plateaued, and
closing it released memory. retained connection demand is supported; an unbounded
leak, precise query-versus-retained allocation and native allocator attribution
remain unproved. those amd64 images ran under arm64 emulation, limiting equivalence.
this cause is separate from the unattributed historical phone admission holder in
[contention](production-search-admission-contention.md).

resolve by attributing the remaining demand and qualifying the integrated candidate
with normal retained connections, complete retrieval/cancellation and useful
background work inside unchanged service/host budgets, without recovery. see
[capacity](production-database-connection-budgets-implicit.md). the exact incident,
kernel hashes and profiling limits remain privately archived under
`.nexus-local/search-integration-docs-20261029.private/original-source/docs/issues/production-search-postgres-oom.md`.
the detailed main-side kernel, request and retained-backend profiling record is
also preserved in
`.nexus-local/pr866-e219-doc-contract-before.private/e219/docs/issues/production-search-postgres-oom.md`.
its old timer failures remain failures; current capacity/progress acceptance is
owned by the reliability contract, not those retired latency cutoffs.

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

disposable outline qualification reproduced backend death on `ca942ac6d`, schema
0335, with the unchanged 512-mib database limit. run
`20261108-195829-b21d847c360a` records four signal-9 backend terminations at
2026-11-09 03:59:55, 04:00:17, 04:00:52 and 04:01:02 utc in its private
`containers.log`; api `search.database.disconnected` events name
`/resource-items/targets/search`. writing streams and replica registration then
fail during recovery. local reference results remain usable. this run retained
no fresh cgroup oom counters, so it proves recurring backend death and recovery,
not a new allocator attribution. that initial outline candidate changed no backend
or budgets; production capacity remains unresolved here.

native outline run `20261108-205529-8dfcf1c51390` on `5d9de5a8d`
records postgres backend pid277 killed by signal9 at
`2026-11-09 04:57:16.403 UTC` while running the first target search; postgres
terminated peers and reinitialized (`containers.log:68–90`). api request
`e9128287-8e5a-42ae-b074-12a26bf57b8e` records the broken connection. no fresh
cgroup counters were retained, so the kill's cause remains unproved. the later
`highlight_annotation` resource-scheme failure occurred after recovery and is a
separate deterministic defect.

focused run `20261108-212904-4b9af5559229` establishes a current cgroup oom on
native aarch64 postgres 15.19/pg_search 0.26.2 at the unchanged 512-mib/no-swap
limit. the first ordinary annotation-only picker request returned 500;
`memory.events` changed `oom:0→1`, `oom_kill:0→1`, `max:0→276`, with
`memory.peak=536870912`. baseline demand was about 220 mb, with two ordinary api
database backends each retaining about 96 mb rss. after recovery, baseline was
about 100 mb and the same query returned 200 on a fresh backend, sampled at
432552 kib rss and 506535936 cgroup bytes without another oom. both search backends
were explicitly retired. private snapshots retain limits, settings, backend
identities, per-pid samples and both responses. aggregate retained demand plus
large query demand is established; the responsible allocator is not.

`6ad6a662c` bounds the existing highlight reading-owner projection against
planner pull-up with `OFFSET 0`; visibility, cardinality and ranking are unchanged.
a same-snapshot comparison returned identical quote/annotation candidate identities,
labels, scores and reading owners. effective jit was off; no native allocator is
attributed. the normal full native run `20261108-220209-0b64c4e45f71` then
completed both ordinary picker requests with 200, peak 425435136 cgroup bytes and
zero max/oom/kill events, without recovery. the three retained search foundation
checks passed in `20261108-220656-d4b0ed622a0d`.

this qualifies the bounded local query repair only. production and restored-corpus
capacity, combined headroom and the historical allocator attribution remain open;
no memory, swap, pool or retry policy changed.

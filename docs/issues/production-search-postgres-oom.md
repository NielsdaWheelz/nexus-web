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
[capacity](production-database-connection-budgets-implicit.md). the historical
profiling limits above remain material: emulation, retained-backend demand and
unattributed allocation are different facts. old timer failures remain failures;
current capacity/progress acceptance belongs to the reliability contract, not
those retired latency cutoffs.

on 2026-10-29, the same `3d81/0317` cohort also exhausted the 512 mib
postgres cgroup during a media-scoped chat-tool search with limit 5.
nearest-chunk retrieval ran 19.456 seconds; subsequent highlight ranking lost
its connection at 20:41:52 utc when backend 359910 was killed and postgres
recovered. this proves aggregate exhaustion, not allocation attribution to
that query. the historical observation was recorded as
`nexus-chat-diagnosis-20261029-5_rw1_cy`; current release acceptance and
remaining aggregate-headroom limits stay with the connection-budget issue.

on 2026-11-03 at 19:34:43.596 utc, deployed `e505409d1` again exhausted
the postgres memory cgroup. the kernel killed host pid 1700443 (`postgres`,
anon-rss 301104 kb); postgres logged backend 222306 killed by signal 9 and
recovered by 19:34:44.313. chat admission request
`14adfdad-89c6-48f0-801b-c6cb9a2c3f9c` lost its connection during attached
citation hydration (`chat/context.py:316` through `search/sources.py:856`),
returned 500 and triggered the reader crash.
kernel and api journald records establish this recurrence and its impact;
they do not establish that this query caused the aggregate allocation.

on 2026-11-05, deployed `191ae44612d22626251a0d17950d3077d89650da`, schema
0335, again exhausted postgres's 512 mib cgroup during a batch of metadata
updates. kernel records show postgres kills at 18:37:24 utc (host pid 3074827,
anon-rss 190452 kb) and 18:37:45 (pids 3075365 and 3074992, anon-rss 269548
and 65056 kb). container restart count remained zero. interactive-worker logs
show connection loss and recovery-mode refusal during those times; metadata
job `01a1acfb-ec15-7896-9ba4-97e3a8860a92` retained an open generation and
expired lease after settlement failed. subsequent jobs progressed normally.
postgres logged recovery by 18:37:25.838 and 18:37:46.729. both killed-backend
statements share a truncated `WITH visible_media AS` / recursive eligibility
prefix; the remainder is unavailable. job `01a1acfb-dc97-7037-8046-46a0709d9bda`
also lost its database connection during the first recovery. this proves another
aggregate-memory failure and interrupted research, not which allocation caused
it. the independent earlier excerpt failures are
recorded separately as metadata excerpt correspondence failures.

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

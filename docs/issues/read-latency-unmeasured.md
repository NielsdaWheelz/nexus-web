# read latency is unmeasured

cold api reads and first/warm local queries have no recorded latency
distribution. the ruling's 200ms delay and eight-second wording threshold remain
design choices; they do not establish whether a stale-first cache is worthwhile.

the read owners are `apps/web/src/lib/api/serverState.tsx` and
`useServerList.ts`; local reads cross `apps/web/src/lib/authored/client.ts` and
the sqlite worker. accepted-entry reads are single-use work and carry their
source/accepted-staleness contract. they are not a retained completed-read cache.
any cache proposal must state authority and invalidation before adoption.

resolved when p50, p95 and p99 are recorded for cold lists, media detail,
`/llm-catalog` and first/warm local queries, and the deferred cache is accepted
or rejected on those measurements.

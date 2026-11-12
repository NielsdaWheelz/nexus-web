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

2026-11-12 librarian scope: the owner clarified that roughly 400 ms is a design
target, not a hard cap. qualify representative desktop firefox and physical
android interactions on the exact deployed candidate and normal connection.
measure readable transcript paint, detail reveal, model readiness and durable
send acceptance separately; record query families, payload/render costs and
observed timing ranges. isolated spikes do not justify new infrastructure.
whole-app startup remains outside this change. no runtime timings were taken
in the source audit. the [implementation specification](../librarian-responsiveness-spec.md)
owns the temporary red/green/refactor/live-verification workflow and accepted
tradeoffs. this broader measurement issue remains open beyond librarian.

local implementation evidence: a plain 25-turn response fell from 1,280 queries /
1,212 ms to 6 / 20 ms; the reference-rich response fell from 1,879 / 5,619 ms to
28 / 250 ms. final firefox navigation observations across seven cursor, anchor,
return and second-pane actions ranged 109–347 ms, median 291 ms; first plain/rich
disclosure paints were 136 / 51 ms. these are controlled local observations, not
a production percentile distribution. exact deployed-client qualification remains
[pending](librarian-deployed-client-qualification.md); other views are unmeasured.

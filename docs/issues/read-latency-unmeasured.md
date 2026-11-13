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

2026-11-12 librarian scope: roughly 400 ms is an ordinary-interaction design
target. the [implementation specification](../librarian-responsiveness-spec.md)
records scope and accepted tradeoffs. controlled checks distinguish readable
transcript, details, model readiness and durable admission; whole-app startup
remains separate. this broader measurement issue remains open beyond librarian.

local implementation evidence: a plain 25-turn response fell from 1,280 queries /
1,212 ms to 6 / 20 ms; the reference-rich response fell from 1,879 / 5,619 ms to
28 / 250 ms. final firefox navigation observations across seven cursor, anchor,
return and second-pane actions ranged 109–347 ms, median 291 ms; first plain/rich
disclosure paints were 136 / 51 ms. these are controlled local observations.

deployed web/api `c828088a2e97a16d70aec94dc4d7ab90eedd3414` was checked on the
normal connection with 17 turns / 34 messages. three stock-firefox runs measured
fresh transcript paint at 1,225–1,674 ms (median 1,375), retained returns at
50–70 ms (median 58.5), details at 32–41 ms (median 33.5), and valid-draft send
readiness at 175–1,674 ms (median 1,117). no observed request returned http 400
or higher. these are small descriptive samples, not production percentiles.

physical android retained the signed 0.3.14 / code 35 apk, whose interface inputs
are unchanged by this backend release. three retained transcript refreshes took
836–867 ms in the api (median 854). first/reopened details were captured by
379 / 350 ms after the host tap command; retained return with an exact model and
enabled send was captured by 734 ms. these upper bounds include adb and screenshot
overhead. a nonempty unsent fixture draft enabled send, then its draft and pane
were removed and the original pane restored. phone capture bounds and api
duration are different measurements. the remaining
[fresh projection cost](librarian-production-pool-contention.md) is recorded;
other views remain unmeasured.

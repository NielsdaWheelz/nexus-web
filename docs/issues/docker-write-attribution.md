# docker desktop write attribution

status: deferred · 2026-10-22. the owner waived attribution of 80% of a full day's
vm writes as a completion gate for the completed lab/host-budget work. the
measurement remains unresolved; the waiver establishes no attribution result.

problem: about 150 of the historical 231 gb written in 28 h has no named source.
a fresh 17:06–18:04 utc prefix on 2026-10-22 recorded 991100928 host bytes and
646664192 guest `vda` bytes; the difference is unassigned, not proved overhead.
host task-charged io, guest completed block writes and process dirtying measure
different layers. root cgroup `io.stat` aliases disk counters; nested cgroups and
waited-child counters overlap. these views cannot be added as source attribution.

the owner's positive control completed a 1 mib s3 put with status 200 during a
64-second host trace: 3031040 host bytes and 75628 bytes of raw capture. the
capture was not decoded. this demonstrates a nonempty control, not attribution of
the earlier residual or proof of 80% coverage.

impact: current evidence cannot show that the completed image/web optimizations
explain the historical writes.

on 2026-10-22 the owner retired the collectors and deleted their partial data.
docker became unavailable: the guest collector ended at 19:41 utc,
and the host/block collectors ended at 19:42 utc, before the original
`2026-10-23T17:06:04Z` deadline. there is no full-day result. retiring collectors
and old data does not fix or attribute the write cause.

future investigation requires a fresh owner-approved observation, not a restart
of these retired collectors. resolved when new evidence explains the dominant
write sources without overlapping counter totals and quantifies the remaining
unknown. the waived completion gate remains waived.

# api reader/search memory margin remains small

status: open · origin: 2026-09-16 utc pr #270 manual acceptance · area: api memory · oi-137

the d23063e4 pillow-book plus shadow/claw reproduction remained usable, with
no oom/restart during that interval. a later00:05:58 verification-overlap oom
reopened oi-116. pr #271 removes probe overhead; its final7965 paired-reader
manual check passed and closes that specific issue. capacity beyond bounded
reader intervals remains unproved.

pr #271 deployed7965f7cd with smaller health and host-side release probes.
through00:36:58 utc2026-09-16 production api peak was312.484/320 mib, zero
limit/oom/swap events and restarts, leaving7.516 mib observed peak margin.
host available floor485.238 mib does not remove the api cgroup ceiling.
`production-7965f7cd-memory-closeout-start.json` records this interval. the
native exact-image probe peaked289.395 mib; neither short interval proves
sustained capacity or timely semantic search. this issue remains open.

production api reached its 320-mib ceiling and 31 limit/reclaim events through
00:02:02 utc, zero oom/swap/restarts. at 00:02:26, current 306.5625 mib included
300.176 mib anonymous and 2.129 mib file memory; cumulative limit events 36.
this is not merely a large file cache. host available floor 343.641 mib through
00:02:02. source: `production-d23063e4-memory-paired-reader.json`,
`api-d23063e4-manual-memory-stat.json`, `manual-d23063e4-paired-reader.json`
under the private `/tmp/nexus-release-255/`.

profile sustained representative reader/search concurrency and bound the
remaining live allocations; selected complete fragment quotes remain oi-135.
review allocation budgets together with other services on the existing host.
do not infer safety from a single no-oom interval or raise caps without combined
host evidence. acceptance: representative sustained use with measured allocation
explanation, usable responses and operating margin, without weakening limits.

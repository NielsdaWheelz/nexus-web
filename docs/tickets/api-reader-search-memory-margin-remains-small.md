# api reader/search memory margin remains small

status: open · origin: 2026-09-16 utc pr #270 manual acceptance · area: api memory · oi-137

the d23063e4 pillow-book plus shadow/claw reproduction remained usable, with
no oom/restart. a later00:05:58 verification-overlap oom reopens oi-116. capacity beyond the
bounded reader interval remains unproved. see that ticket for the new kernel
evidence and probe overhead.

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

# api reader/search memory margin remains small

status: open · origin: 2026-09-16 utc pr #270 manual acceptance · area: api memory · oi-137

2026-10-13 release recurrence: production `3ea1b8e6e` at revision `0276`
was killed by the api cgroup at 18:48:07 utc while opening the complete
montaigne essays and returning to its citation chat. kernel evidence records
uvicorn anonymous rss 325360 kib against the 320-mib cap; the api restarted
and the browser received reader, document-map, catalog and workspace 502s.
no repair or provider generation was active. `OOMKilled=false` after restart
does not contradict the kernel event. source navigation had rendered before
the failure; this does not qualify sustained reader use.

private evidence: release `provider-smoke/results/partial-browser-failure-receipt.json`
and `nexus-release-repair-plan-20261013/postgres-oom-history.json`
(sha256 `393a66b16a856e58d52b9422f79630fd74d6220644b10c5953e365bb4a2a89a0`).
runtime repairs and broad browser journeys are held while the exact request
path is profiled on a restored production copy. short, serial provider checks
run separately under host observation. preserve publication semantics and
measure the complete host budget; an isolated api cap increase is not proof.

the first private source-overlay runner mounted patched files under
`/app/python/nexus`, but the image imports `/app/nexus`. all of its apparent
patched successes and failures are therefore unpatched observations. retain
those receipts with that correction; neither qualifies the patch. the corrected
runner must record imported module paths and source hashes inside the serving
process before workload acceptance. the six-cycle oom receipt
`3d5ab557d87acd7f24fafb55ec9d9c8115e25a48700ef019e357f09e318bb554`
belongs to the released source. exact published-image qualification remains
required after the preparatory source-overlay run.

the proposed repair removes a duplicate initial reader request, resolves graph
ownership only for actual edges, and shares a bounded, disk-backed image
delivery path. restored-copy graph comparisons preserve complete responses,
visibility and pagination; peak python allocation falls from 44021188 to
497905 bytes for the populated montaigne page. the cold unpatched reader alone
still peaks at 270.3 mib. complete http workload and live host qualification
remain pending; these component results do not close the capacity issue.
private graph receipts: `2026-10-13/release/runtime-query-audit/` in the campaign
artifacts, manifest sha256
`e10a7a8eef235a5de38809339428cf67edef14d1f4977874b7f7a71ca150074d`.

remaining source allocations to measure if capacity is still insufficient:
`reader_document.py:187` retains original html rows while building rewritten
reader units; `reader_apparatus.py:710` loads every fragment body and caches
canonical structures for copied-source link resolution. the incident book has
no apparatus, so the latter path did not cause this crash. assess a large book
with source notes during reader acceptance before attributing a second defect
or expanding the repair.

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

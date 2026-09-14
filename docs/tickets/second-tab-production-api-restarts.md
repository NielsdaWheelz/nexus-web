# production api memory kills cause gateway failures

status: open; repeated container memory kills confirmed
origin: 2026-09-13 second-tab council; production `7e8fd48244b3b436965037738e05785bb4931be1`
area: api / production capacity / workspace bootstrap

## decisive follow-up evidence

the user's follow-up shows unrelated contributor reads, openable search,
consumption writes, and reader-state writes returning 502 together, followed
by the whole-workspace boundary. it also occurs during navigation without a
new pane. the title/history defect does not explain this incident.

read-only kernel inspection at approximately 04:11 utc records six
`CONSTRAINT_MEMCG` kills of `uvicorn`, at 03:09:11, 03:19:15, 03:20:29,
03:27:13, 04:04:54, and 04:06:36 utc on 2026-09-13. all name container
`2bf9ef989afc05a7f2c3cf7a192aff509bdfd4dc8afd37b292e840e690845dfd`,
independently matched by `docker inspect nexus-api-1`. restart count is now
6. the last kernel receipt is:

```text
Memory cgroup out of memory: Killed process 3265879 (uvicorn)
total-vm:895712kB, anon-rss:312060kB, file-rss:12416kB
```

caddy records 502 at the same failures: `EOF` at unix time
`1789272294.4826808` (04:04:54 utc), error id `kpuwq60w6`, then connection
refusals to `172.18.0.4:8000`; another series begins at
`1789272396.6094346` (04:06:36 utc), error id `5zcf2ayt8`.
the user's exact `/contributors/augustine-of-hippo-fad23d3937f1` and `/works`
requests fail at 04:06:38–39 (error ids `u1yuwxraz`, `6qvcnen71`,
`rzwfdzuys`, `bj7qb9uqk`). `/resource-items/openables/search`,
`/consumption/activity`, and reader-state writes fail in the same series.

the live container and `deploy/hetzner/docker-compose.yml:64–65` both set
memory and memory-plus-swap to `335544320` bytes: 320 mib, no container swap
allowance. host inspection still had 642 mib available and 938 mib unused
swap. these are container-limit kills, not evidence that the entire host ran
out of memory. the last kernel task table includes the api at 81119 resident
pages and another python process at 4837 pages. the configured health check
launches python every five seconds; include that process and cgroup overhead
in the measured envelope. do not infer a particular request allocation or
leak from the process victim alone.

the earlier negative kernel search was invalid: its escaped alternation did
not match the journal's regex syntax. the corrected query uses
`--grep "oom|Out of memory|Killed process"`. current `oom=false` and
post-restart cgroup counters also do not preserve the prior kills.

the frontend failure amplification is independently tracked in
[the gateway classification ticket](second-tab-gateway-outage-classified-as-workspace-defect.md).

## allocation follow-up

read-only host `/proc` and cgroup inspection at 04:22:09 utc, pid `3267325`,
finds process rss `310212` kib (303 mib), private anonymous residency `282676`
kib (276 mib), and six threads. cgroup `memory.current` is `320995328` bytes
(306 mib), `memory.peak` is `335556608`, and restart count remains six. the
largest mapping groups are unnamed mappings (`187128` kib) and the heap
(`90340` kib). this is a running-process sample, not a cold-start baseline or
proof that those bytes are leaked. shared libraries account for much less
resident memory; anonymous memory can contain both python and native objects.

the exact api image is
`ghcr.io/nielsdawheelz/nexus-api@sha256:8564b8ec84376772c7cad8dc8c91f29892e4bb3b325a2520a6835a10f6ed456c`.
the process remains close enough to its limit that a modest transient
allocation could exhaust it. separate startup imports, live request objects,
allocator-retained free space, and accumulated application state with allocation
profiles; rss alone cannot apportion them. capture python and native allocation
stacks in the isolated exact-artifact reproduction. do not inject a profiler or
another interpreter into this nearly full production api cgroup.

## initial evidence

read-only inspection around 03:28 utc found `nexus-api-1` with restart count
`4` and start time `2026-09-13T03:27:13.579397976Z`. the current container
reports `oom=false`; this does not exclude earlier memory kills. a subsequent
sample was `274.7MiB / 320MiB` (85.86%). `/readyz` returned ready.

vercel deployment `dpl_EzbAXd1AigvoskfzRHeFza64nENU` has eight error records in
the queried 24-hour window: bootstrap reads received non-json http 502
responses, code `E_INVALID_RESPONSE`, digests `2738950100` and `104974553`.
examples: request ids `d2ppv-1789269636715-3949d7886aeb` and
`xb4zx-1789268953638-364c25a7cfd7`. this proves a server failure path to the
workspace boundary; it does not prove it caused the user's pane-opening event.

prerequisite: measure baseline, request overlap, retained allocations, and
health-check overhead on the exact deployed artifact in an isolated local
runtime. the kill mechanism is established; the allocation owner and correct
production capacity budget remain to be measured.

fix: right-size the api's complete cgroup envelope and bound the measured
expensive foreground work. reserve health-check and host headroom. compare
changing per-container limits with increasing host capacity; do not raise all
limits into host contention. preserve the committed release/config owner.
keep ordinary gateway unavailability explicit at client boundaries; retries
cannot repair an api repeatedly killed under supported load.

acceptance: a production-shaped local overlap of the identified reads stays
within a measured memory budget without process death; restart/unavailability
proof preserves user work and provides a correlated recovery result. collect
read-only post-release evidence of the same deployed artifact.

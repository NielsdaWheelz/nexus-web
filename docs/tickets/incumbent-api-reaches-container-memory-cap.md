# incumbent api reaches its container memory cap

status: open · origin: 2026-09-15, pr #255 host qualification · area: api memory

## evidence

on `nexus-api-worker` at 16:36:26 utc, the old production source
`a1f59a755c91bdc22e77e33c12b93dde829a8e6e` api was killed by its 320 mib
cgroup limit. kernel `CONSTRAINT_MEMCG` evidence names container
`b98be92be0016237a9ac0e758afe34bdd3cb9520935ca99795528828ee83a311` and
uvicorn with 310,632 kib anonymous rss. a health subprocess was also present.
docker restarted the same container; it was healthy at observation with restart
count 3. no candidate runtime was running. this was not host-wide exhaustion.

private mac receipts: `/tmp/nexus-release-255/incumbent-api-oom-163626-kernel.log`
and `incumbent-api-oom-163626-receipt.json`. docker's current `OOMKilled=false`
after recovery does not invalidate the retained kernel event.

## next action and acceptance

inspect the restored api's actual composition and health footprint, then verify
representative requests within its existing limit. remove avoidable resident
imports or bound the operation responsible; do not infer that a server resize
is required. close after the exact restored image completes representative
traffic without oom or repeated restarts, with source and host measurements.

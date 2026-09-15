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

the user identified opening “shadow & claw” and “how to unclench” together as
the trigger. the api log confirms their reader requests and six concurrent svg
image rejections immediately before the kill. response sizes were not logged;
the image path is implicated, not proven to be the sole cause. the same image
code survives restoration: eager downloads precede the byte/type checks, cache
retention permits 128 mib, and cache misses have no concurrency bound.

the current article is titled “the pain of clenching” at `howtounclench.com`,
created at 16:30:35 utc after the rehearsal snapshot. its 110,641-byte html
contains 35 distinct proxied images without lazy-loading attributes. the
requested book chapter is only 18,278 html bytes with no image tags. exact
`3ee6a9b5` api import on `dev-server` peaked at 217.59 mib without loading
provider runtime; this measured no lifespan or requests.

the image fix limits cache retention to 16 mib and active fetches to two,
queues before thread/client allocation, and checks headers plus actual streamed
bytes before retaining a body. upstreams ignoring `accept-encoding: identity`
are rejected. smaller caches cause more refetching and queued images can load
more slowly. completed responses and socket buffers can outlive the fetch slot;
these changes do not prove a total process-memory bound. keep this ticket open
until the exact restored api passes the two-document check.

## next action and acceptance

inspect the restored api's actual composition and health footprint, then verify
representative requests within its existing limit. remove avoidable resident
imports or bound the operation responsible; do not infer that a server resize
is required. close after the exact restored image completes representative
traffic without oom or repeated restarts, with source and host measurements.

## production restoration update

source `6baccaee9c053b10f46fb5e270e73f5bc12b5026` is healthy on production.
its exact api peaked at 231.980 mib under 320 mib during the owned release,
with no limit, oom, swap or restart events. this includes startup and operational
release probes, not the reported simultaneous two-document browser traffic.
that manual check remains pending, so this ticket remains open. see the
[release evidence](../cutovers/restoration-release-2026-09-15.md).

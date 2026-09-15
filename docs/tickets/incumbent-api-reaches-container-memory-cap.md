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

source `6baccaee9c053b10f46fb5e270e73f5bc12b5026` initially passed production
release health checks.
its exact api peaked at 231.980 mib under 320 mib during the owned release,
with no limit, oom, swap or restart events. this includes startup and operational
release probes, not the reported simultaneous two-document browser traffic.
that manual check was pending at this observation and subsequently failed as
recorded below. see the
[release evidence](../cutovers/restoration-release-2026-09-15.md).

## failed restored production workload

on 2026-09-15 at 19:18:47 utc, restored source
`6baccaee9c053b10f46fb5e270e73f5bc12b5026` api container
`2b0b94bca5de38f5ace8d4227b11f6515911323c401e682a934e7525028b02a9`
was oom-killed under its 320 mib cap. the kernel reports `CONSTRAINT_MEMCG`,
uvicorn pid2042389, anon-rss322620 kib. reader navigation/document-map and a
burst of image requests immediately preceded the kill. docker restarted the
same container. the user reports any pair of shadow & claw, unclenching, and
lectern can cause the workspace error; the browser/app stays open.

basic android/web pages and the scrollbar looked correct, but sustained use
failed; solar/imports/chat acceptance is blocked. the earlier image-route-only
measurement excluded full api lifespan, database reads and auth. diagnose the
combined request footprint before another release. private kernel/request
evidence: `/tmp/nexus-release-255/memory-incident-1921/` on the mac.

## request-path diagnosis and successor fix

a private devbox allocation diagnostic using the exact `6baccaee` image
reached oom (exit137, `OOMKilled=true`) after four concurrent book reads,
six concurrent openable searches and the article's 35 real image requests.
the `clone-http2` setup and most subsequent overlays unintentionally retained
two app/router graphs: importing `apps.api.main` created one, then the harness
called `create_app` again. this inflated the baseline and is not a faithful
reproduction of the normal single-app process. it used the retained db0229
clone, actual asgi routes, a supplied viewer identity and lifespan without
catalog startup; the exclusions below apply to these historical runs too.

source changes remove preview-body reads from document summaries (oi-124),
make the pure viewer dependency async, reuse verified image tls trust state,
and close one image decoder instead of reopening it. the api image fixes glibc
arenas at2 and mmap/trim thresholds at128 kib. these trade allocator contention
and system calls for lower retention; the container remains320 mib/no swap.

source-overlay diagnostics are not replacement-image qualification. the
initial overlay plus arena bound reached320 mib on its third round and was
rejected. the final decoder/threshold path completed ten rounds,270 raster200
and80 expected svg400 responses, with peak312.445 mib, zero max/oom events and
seven threads instead of36. about22 mib of that diagnostic's baseline was
charged file cache; do not compare its cgroup peak to rss or subtract cache to
claim another limit. final checksum-error mapping was added after this run.
receipts: `memory-incident-1921/clone-http2/` (oom), `clone-http-repeated/`
(rejected retention), and `clone-http-decoder/` (ten-round source overlay).

no production restart, schema mutation or cap change was used for this diagnosis.

## corrected exact-image allocation diagnostics

the corrected harness reuses `apps.api.main.app`, checks that its middleware
stack is unbuilt, removes only the auth middleware registration and attaches
the same private viewer fixture. it retains the same requests and ten rounds,
320 mib cap and no swap. it also restores request-id middleware that the
second app lacked. old receipts remain retained.

the published `7b28c879dc958c1d8ccf100cb880f49e63b07e2b` image completed ten
rounds at 285.199 mib with zero max/oom events using one app; its earlier
two-app run completed at 319.879 mib with zero max/oom events. differing charged
file cache and middleware prevent attributing the entire difference to graph
count. receipts: `memory-incident-1921/published-single-7b28c879/` and
`published-7b28c879/`.

on `dev-server` at 20:22:32–20:23:56 utc, source
`5acb211ab6966a87201dffe5d30d427ca0189e7e`, exact api image
`ghcr.io/nielsdawheelz/nexus-api@sha256:a0cbb6186a93990dbf8f1bff86fd315562b8cb2c83e02092629a220b06c830c7`,
completed the corrected ten-round diagnostic at 301.262 mib, with seven threads,
exit0 and all sampled cgroup memory-event counters zero. responses: 40 reader200,
60 search200, 270 raster200 and 80 expected svg400. retained receipt and summary:
`/tmp/nexus-release-255/memory-incident-1921/published-single-5acb211a/`.

these are allocation diagnostics, not production qualification. viewer injection
bypasses jwt/jwks, bootstrap and their allocations; test environment skips catalog
startup. the health surrogate imports `urllib` and sleeps but never calls
`/readyz` or reproduces its database work and probe cadence. the diagnostic
client and retained response bodies are charged to the measured cgroup; uvicorn,
tcp/bff/browser behavior and the current article's database reads are absent.
file-cache charges differ between runs; do not infer a production memory margin
from their peak differences. no solar/imports/chat or manual device pass follows
from these results.

production deployment of `5acb211a` was still running when this evidence was
recorded. public verification and sustained manual production checks remain
pending; oi-116 stays open.

## deployed successor; renewed manual acceptance pending

`5acb211ab6966a87201dffe5d30d427ca0189e7e` settled succeeded on production at
20:27:05 utc. exact api startup/public probes retained248.973/320 mib through
20:28:29, with zero limit/oom/swap/restart events. host sampling has a
20:26:02–20:27:24 gap; retained cgroup peaks/counters cover startup. the user was
asked to reload and repeat the two-view workload after release health passed.
this ticket remains open until that representative traffic is observed. see
the current [release evidence](../cutovers/restoration-release-2026-09-15.md).

## successor manual failure

user reported two views lasted longer, then the workspace failed again. kernel
evidence confirms5ac api container4b18ba4509b86ed5105804bb074cb21e92a0b0e1c327dbda9d24938edeade0f1
was oom-killed at20:34:49 utc under320 mib, anon332783616 bytes. it restarted
once. the two-second observer saw277 mib before the kill, then restart1;
post-restart zero counters and smaller peaks are a new cgroup lifetime, not
absence of this oom. all35 image response headers were logged around the kill;
those logs do not prove complete body transfer. earlier startup and private
allocation evidence remains narrower than this failed real workload.

private evidence: `memory-incident-5acb211a/{api,kernel}.log`, runtime.json and
`production-5acb211a-memory-resumed.jsonl`. pause manual checks and diagnose
workspace warmup, authentication, and real response transfer omitted by the
in-process diagnostic. no further limit relaxation is authorized by this result.

## second request-path correction (pr #267)

real uvicorn/tcp diagnostics keep the client outside the api cgroup and restore
original auth middleware/bootstrap with a private verifier. ten reader/search/
35-image rounds plus workspace warmup and real readyz subprocesses reached the
320 mib cap on both5ac and a transfer-only overlay (max events310 and364,
respectively; no oom). old in-process diagnostics did not exercise socket
backpressure. the first warmup omitted required workspace device_id and got400;
the corrected overlay supplies it and gets200.

image admission now lasts through body transfer, with64 kib writes. two slow
consumers delay queued image requests; bytes, validation and conditional304
behavior remain unchanged. chat and dossier admission also stop importing the
worker-owned mcp server graph. the two codex execution paths retain their local
binding imports; no provider, listener or tool contract changes.

the final three-file source overlay ran21:03:28–21:05:04 utc on the devbox:
ten rounds, peak259.402/320 mib, sampled anonymous peak253.852 mib, zero
max/oom events, healthy on completion. the api reported mcp absent from loaded
modules. this includes the unchanged16 mib image cache and two-transfer limit.
file-cache charges differ between runs; peak differences are not isolated
measurements of python import savings. private evidence:
`memory-incident-5acb211a/tcp-transfer-mcp-readable/`.

an earlier overlay had unreadable source permissions and failed before serving;
its receipt is retained. a separate allocation profile used768 mib on the
existing devbox to accommodate tracing overhead; it is not320 mib capacity
evidence. an earlier transfer diagnostic was interrupted by the devbox user
service/docker restart; no production change or host reboot was performed.

these remain source-overlay diagnostics: fake token verification, test-mode
catalog startup, cloned database without the current article, and no browser/
bff/device journeys. require the new immutable image and actual sustained use;
keep oi-116 open. the repository check has not yet run on this code.

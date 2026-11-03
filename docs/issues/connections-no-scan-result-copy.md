# no scan result does not prove a completed scan

problem: `outcome === null` says `the scan ended without changes.`.

impact: a scan that never queued appears to have completed cleanly.

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`; `apps/web/src/components/connections/ConnectionsSurface.tsx:119-125`; `python/nexus/services/connection_discovery.py:141-145,164-168,180-181` returns no job after disabled discovery or a swallowed enqueue failure. `python/nexus/api/routes/connection_discovery.py:40-45` ignores the enqueue result and returns that idle/null state.

resolution: split null from proven skipped. proposed null fact `no scan result is available.`; no invented cause. keep known terminal failure and skipped branches distinct. prove the no-job response never claims a scan ended or made no changes.

status: source finding only; no runtime journey run. correction and behavior qualification remain pending.

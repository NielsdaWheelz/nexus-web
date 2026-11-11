# production container exit history is unexplained

status: open · origin: 2026-09-18 deployment preflight · area: runtime availability

on 2026-11-10 at 04:07 utc, the `422dc2596` release refused before candidate
mutation for the same shutdown condition: original background container
`c43f9f926e25` exited0 with `OOMKilled=true`. that flag was already present
while healthy before cutover; no new oom appears in retained kernel logs from
04:00 through the refusal. all four original writers exited0. the captured
cohort was recoverable at source191ae4461/schema0335 with unchanged host inputs.
canonical `--restore-original` restored those exact containers; the background
worker restarted at04:09:04utc with a clear oom flag. the unchanged retry passed
the strict clean-stop and empty-work checks, then released422dc2596/schema0337.
independent checks at04:23utc found eight healthy services,667mib host headroom
and no kernel oom since04:00. historical attribution remains open; no guard or
memory ceiling changed. these are recorded wire20 release observations, not a
fresh production inspection.

on 2026-11-05 at 02:23:06 utc, the canonical release of
`c6c90343c4324942b310fe7d9b9fadc4f6e5e944` refused before candidate mutation:
the original e505 background container
`7eddf14f247fb93e4b4e82a8a10b34dfe6351079004535ca83aff0061307b96f`
stopped with `ExitCode=0`, `OOMKilled=true`, and no runtime error. it had run
since 2026-10-31 at 02:18:13 utc. retained kernel logs identify two python-child
kills in that exact cgroup on november 3 at 23:29:45 and 23:31:26 utc, with
343072 and 342740 kb anonymous rss. the api cgroup also had oom events on
november 4 at 19:05:56 and 20:10:40 utc. no later oom event appeared through
november 5 at 02:25 utc. affected work is not yet attributed.

the release guard correctly refused the retained flag. canonical
`--restore-original` restored the exact original cohort; no schema, host input
or current-pointer mutation had occurred. the background worker restarted at
02:25:09 utc, healthy with `OOMKilled=false`. an ordinary retry must establish
a new clean stop and empty census. do not clear a flag or weaken the shutdown
guard to release. the historical memory defect remains open after a successful
retry.

read-only docker inspection at `2026-09-18T18:05:07Z`, before deploying
`d598efe8dc`, found the following on the host serving release
`7965f7cd88865dac03be672c2164ef58235840fd`:

- background container
  `b22416cf909135bda29041657baf3d3550131db371e952190111e23d3f870275`:
  `RestartCount=148`, `OOMKilled=false`, running and healthy;
  created `2026-09-16T00:30:19.74363572Z`, last finished
  `2026-09-18T07:59:20.087732999Z`, last started
  `2026-09-18T08:00:20.119390694Z`; memory limit `469762048` bytes.
- postgres container
  `2cfa43116454c971bdb9e955511a26aedba48fff1d0f3150085251ed3765fdd3`:
  `RestartCount=0`, `OOMKilled=true`, running and healthy;
  created `2026-08-07T15:20:17.812269446Z`, last finished
  `2026-09-12T21:00:18.356192039Z`, last started
  `2026-09-12T21:00:18.432289658Z`; memory limit `536870912` bytes.

both reported `ExitCode=0` at inspection. these fields do not establish the
causes of the worker restarts, when postgres was oom-killed, or a shared cause.
current health does not explain historical interruptions. the worker count
and postgres oom flag remain distinct from the previously recorded
[memory margin](background-worker-production-memory-margin.md) and
[query timeouts](production-synapse-scan-statement-timeout-backlog.md).

prerequisite: obtain any retained, narrowly scoped docker/kernel event metadata
for these container lifetimes; historical event availability is unproved.
correlate exit times, reasons, cgroup events, and service progress, then repair
the responsible owner if an ongoing defect is found. if history is unavailable,
record that limit and capture the next recurrence. do not infer a cause or
raise memory limits from these counters alone.

acceptance: explain the recorded history or explicitly bound what cannot be
recovered; verify any required fix during a stated representative operating
interval, with background progress and database health and no unexplained
exits. retain sanitized evidence without application log bodies or secrets.

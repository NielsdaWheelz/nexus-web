# production container exit history is unexplained

status: open · origin: 2026-09-18 deployment preflight · area: runtime availability

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

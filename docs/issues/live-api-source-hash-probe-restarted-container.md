# live source hash probe restarted the api container

status: open
origin: 2026-09-27 processing release preflight
area: production api / operator source verification

a read-only `docker exec` python probe in `nexus-api-1` selected four retained
`media_file` rows and began hashing their r2 objects through
`get_storage_client().stream_object`. it printed no result, exited `137`, and
the api container restarted once (`RestartCount=1`, `OOMKilled=false`). the
exact cause is unknown. subsequent container health was `healthy`, postgres
and both workers were healthy, and public api/web `/version` returned 200.
there was no database write. the probe was not repeated.

2026-10-14, 22:25:02 utc: the kernel confirms a second occurrence in api
container `e95f6b2df152` (384 mib, no swap). python pid 2838233 triggered
allocation pressure alongside uvicorn pid 2693065; the cgroup reached its
393,216 kib limit and killed uvicorn. the submitting command/session is
unidentified. docker again reported `OOMKilled=false`, with restart count one;
the restarted cgroup's zero counters do not contradict the kernel receipt.
private evidence:
`nexus-web-campaign-artifacts/2026-10-14/book-repair/coordinator/api-oom-2225.kernel.private.log`.
the repair campaign had issued no python execution inside the api. its parser,
storage and backup work runs off-host in separately bounded containers.

prerequisite: keep bulk object reads out of the live api container. use an
off-host bounded reader or an isolated restored rehearsal for exact-byte
correspondence; inspect the container limit and exit evidence before reusing
this method.

acceptance: exact retained source bytes are verified with measured bounded
memory and no production container restart; the chapter repair rehearsal uses
those verified bytes.

2026-10-14 x-title cutover preflight: a read-only `docker exec -i` python
eligibility probe imported `services.media.get_media_for_viewer` and the source
owner inside the running 384 mib api container. it printed nothing and exited
`137`. subsequent docker facts: `RestartCount=1`,
`StartedAt=2026-10-14T22:25:03.086255092Z`, `running`, `OOMKilled=false`,
`healthy`; public `/version` still served source
`665e7b3af03282d37ac1a2aac3c6589e2a0f5932`, revision `0277`. the supplied kernel
receipt now proves this incident was an api cgroup oom: at `22:25:02`,
`CONSTRAINT_MEMCG` in container `e95f6b2df152` killed `uvicorn`, pid `2693065`.
the task list also contains the additional python probe, pid `2838233`.
evidence: `/Users/nnandal/Documents/code/nexus-web-campaign-artifacts/2026-10-14/book-repair/coordinator/api-oom-2225.kernel.private.log:94–95`
(task list: lines 92–93). docker's later `OOMKilled=false` did not establish
the absence of this kernel oom. the probe contained no database writes and
was not repeated. the earlier september incident's cause remains unknown.

keep business-owner probes out of the live api cgroup as well as bulk object
reads. use the existing separate 512 mib `migration` one-off for authorized
business-owner operations; narrow read-only sql can use the controller's
postgres owner. source preflight evidence is retained at
`/private/tmp/nexus-x-titles-proof-20261014/production-source-preflight.md`.

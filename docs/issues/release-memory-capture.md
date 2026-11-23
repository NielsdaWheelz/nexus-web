# shared memory capture cutover

the conversation-only producer and jarvis receiver use
`nexus-turn-capture-v2`. install nexus `0347` first and jarvis `0020` second,
with capture held until both match. the earlier `0346` installation at
`833eb09a7d3e13562d1a7ecb19890dd51d78ceff` verified the private read-only mounts
and four dependency pins with both declarations null. activation and real
central delivery remain unperformed.

read-only inventory on november 23, 2026 found `2393cb88a328` at `0346`,
both mounted declarations null, and zero registrations, unsettled admitted
capture runs, pending exports and parks. recheck at the release boundary.

automatic owner-turn orientation is a separate source change on top of these
disabled declarations. deploying it alone grants no reads and enables no capture.
after private activation, verify both provider and native owner turns receive all
pages of the shared ready view, report backlog/capture limits, and recover an old
topic outside recent transcript context through zoom/open. verify an unavailable
service yields an explicit limitation with ordinary chat, and other accounts and
helpers receive no shared content. source probes do not establish installed recall
or its usefulness.

source qualification passed for `12f74c865eb289e186ff33b310f8d34a28c9220d`:
authenticated send/cancel/retry, all six memory tools collectively across paid
provider/native journeys, typed outage continuation and exact `Call.id` replay
after uncertain saves. future-only exports survived deletion/outage, lost
acknowledgements and overlapping publishers; malformed/oversize heads parked
without losing content. native internal exclusion passed. temporary probes and
fixtures were deleted. [immutable source evidence](https://github.com/NielsdaWheelz/jarvis/blob/d66e84057cb2468f23aacf3f359dac49453e0a3a/docs/universal-memory.md#memory-completion-source-qualification)
records exact pins, image ids and the remaining deployment limits.

- take a read-only inventory of the installed sha, schema, capture declarations,
  registration, admitted runs, outbox and parks. if capture is inactive, keep it
  inactive through both releases.
- quiesce new sends and retries using [the edge and background lane holds](../../deployment.md#refusal-recovery).
  let admitted runs settle and the old publisher and receiver acknowledge every
  v1 export before stopping the background lane. check for zero pending exports
  and no capture-eligible unsettled runs. if registered, verify central progress
  is the local next export sequence minus one under the same capture id and
  boundary. even a committed v1 export cannot acknowledge through the v2 receiver.
  repair a park on the old pair before switching.
- retain the verified predecessor backup. if capture was active, publish a
  matched disabled client capture flag and null publisher through the [existing
  generated declaration path](../../deploy/env/README.md) after
  the drain. keep sends and retries quiet. the ordinary nexus controller brings
  the edge and background lane up for health checks, so the disabled declarations
  hold capture across that restart. restore the authorized flags through the
  same stopped publication procedure only after both sides agree on v2.
- run the [normal paired nexus release](../../deployment.md#backend-release) for
  `0347`, then the separately authorized jarvis `0020` release. the nexus final
  stopped census refuses a remaining old export before invalidating restoration
  of the original cohort. use `--restore-original` after that refusal and drain
  on the old pair. migration `0347` also refuses unsettled eligible runs or pending
  exports and requires v2 for new outbox rows. it preserves the capture id,
  boundary and export sequence.
- if capture was left enabled and a v2 export parks in the mixed-revision window,
  wait for jarvis `0020`, then clear that exact park with `memory-capture-retry`.
  preserve the pending envelope and verify its receipt.
- publish generated client and publisher files from one sharing declaration.
  active capture requires matching owner/capture/admit. capture-only client has
  `connect=false, bearer=null`; disabled publisher is `null`.
- background alone receives the upload file. api and interactive receive only
  the client file.
- inspect `nexus memory-capture-status`. with capture active, one synthetic owner
  turn with an attachment, tool receipt and published citation must yield four
  originals and disappear from pending only after its exact receipt. check that
  the receipt is still local and that historical originals remain reopenable.
- disable without deleting pending exports. repair a parked cause before
  `nexus memory-capture-retry <capture_id> <export_seq>`; never skip a sequence.

resolved when the installed paired release has that functional evidence and the
owner's intended flags. historical import, backup/restore and usefulness/load
evaluation remain separate work.

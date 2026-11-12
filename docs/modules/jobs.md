# durable jobs

## owner and contract

`python/nexus/jobs/` owns the postgres queue, registry, two worker lanes, exact
execution fence, heavy capacity lease, child protocol and settlement.
`apps/worker/main.py` composes one lane. domain services own admission,
checkpoints, permanent refusals and repair authorization. generation owns model
replay permission; the queue owns scheduling. no transaction spans provider io.

`registry()` is the complete kind table: lane, handler, capacity, periodic
schedule, retention, parser temporary root and import-light settlement hooks.
metadata uses the existing background lane; chat, part discovery and oracle use
interactive execution. the registry is authoritative rather than a second list
in this document.

## state and identity

| status | meaning |
| --- | --- |
| pending | admitted work or a useful continuation, waiting for its due time |
| running | one current execution holds the claim |
| failed | classified temporary failure, waiting to retry |
| held | unfinished work requiring an owner repair; never claimable or pruned |
| succeeded | completed or obsolete intent |
| dead | owner-declared unsuccessful terminal; never automatically resurrected |

unfinished includes pending, running, failed and held. executing means running;
claimable means due pending/failed. held is not idle, actively running or
recovering. ordinary continuations are not recovery merely because attempts>1.

claiming increments `attempts` and mints a fresh `execution_id`. counts never
reset or refund. every effect locks its exact running execution until commit:
`id = job_id AND status = 'running' AND execution_id = execution_id`.
`lock_running_job_claim` is that fence; an unlocked check is only advisory.
a lease permits revocation, not publication without the fence. every exit from
running releases its claim and heavy capacity. retained execution ids are audit,
never permission to publish again.
heavy capacity remains occupied until that release; its timestamp alone never
admits another heavy execution while the holder can still publish.

## failure policy

`JobResult` is a mapping/none, `RescheduleRequested(at, payload?)`, or
`TerminalJobFailure`. mappings succeed; continuations reschedule without a failure
charge; terminal failures end the owner's intent. `JobFailure` carries an explicit
retry/bounded_retry/hold disposition before a handler can mistake it for a permanent
refusal. both lanes use the same `Failed` child codec and `failure_of` classifier.

| cause | disposition |
| --- | --- |
| lease expiry, worker interruption, recognized required transport/database outage | retry indefinitely; no repeatable-failure charge |
| confirmed child oom/deadline, replay-safe model timeout/invalid output/output bound | charge `failed_executions`; retry below 3, otherwise hold |
| configuration/auth/quota, unknown exception, invariant defect, malformed child protocol, uncertain external effect | hold for repair |
| cancellation, deletion, supersession or permanent input/policy refusal | owner's existing terminal settlement |

transient failures neither increment nor reset `failed_executions`. only a
committed reusable checkpoint (`record_job_checkpoint`) or reviewed repair resets
it. payload updates, progress and model audit closure do not establish a
checkpoint. the initial charged failure plus two reruns consume the allowance.

failure retries wait 60 seconds with ±20% jitter, respecting a later retry-after.
useful continuations retain their owner's due time. no delivery count/age expiry
applies to classified transient durable work: this is the repository-local
exception to shared bounded-server-retry wording. individual database, model,
provider, tool and executor attempts remain bounded; foreground requests retain
their own finite retry budgets.

`is_transient_database_error` recognizes typed database outages and contention.
an exception group is transient only when every leaf is recognized. arbitrary
sqlalchemy errors are defects. storage classifies sdk failures in its own adapter
and exports an import-light declared error; generic storage error codes do not
prove transient failure. tool cleanup retains the primary error when recording a
secondary failure also fails.

## locks and settlement

before locks, generation confirms any recorded native turn ended. unknown native
finality holds the existing job and leaves its generation open. local process
termination and an interrupt acknowledgement are not native terminal evidence.

1. a stopped handler/child's settlement locks open generation rows in id order.
2. its `lock_owner` participant locks domain rows in their publication order.
3. settlement locks the exact current job, then heavy capacity when required.
4. it reconciles already committed owner success, closes the locked audit rows,
   and commits the queue disposition and reactions together.

no lost execution settles. terminal domain publication and `finish_job` may commit
facts and queue success together; a lost response then changes nothing.
`on_failure` recognizes already committed success before retry/hold.
`on_dead` runs only for terminal failure, never for a hold. `on_history` records
retry, hold, reschedule and interruption outcomes in the transition transaction.
passive observation has no queue notification producer. only worker wakeups and
chat events retain notifications; retained jobs remain the source of operation state.

expiry first obtains necessary domain locks, then rechecks and revokes the exact
expired execution, releases capacity and schedules recovery. it never closes
generations while holding a queue row. replacement generation startup locks old
open rows, then its exact current claim, and closes only those locked rows after
native finality is confirmed outside the transaction.
opening a generation holds its owner's advisory lock and current queue claim
through insertion and commit: a displaced opener inserts nothing.

chat tool effects preserve generation→run→job ordering. media publishers use the
complete source-family barrier in `services/media_locks.py`: ordered root/piece
locks followed by membership revalidation. physical teardown locks discovery
owners and audit rows before media, preventing a late opener while deleting the
job. its deletion transaction also requires its current queue execution.

repair is an owner operation: lock domain, revalidate current intent,
authorization and checkpoint, then resume the exact held job. obsolete work
settles instead. historical dead-job repair remains explicit; never blanket replay
rows whose terminal hooks already ran. no generic public repair endpoint exists.

## execution and supervision

interactive handlers run in the worker process. background handlers run in one
fresh child sharing the existing 448 mib cgroup with a lean supervisor. hooks and
shared queue imports must not load storage sdk, httpx or lxml graphs at startup.
settlement may load httpx for bounded native host control; inference, storage and
parsing remain in children. a worker
refuses that composition at startup. metadata competes with ingestion/indexing;
existing priorities and capacity remain the scheduler.

`ChildExecutor.open` proves cgroup v2 memory enforcement and individual oom kills.
a child arms parent-death protection, retains a supervisor liveness pipe, runs in
its own process group, and raises its oom preference. the supervisor joins/kills
the whole group before settlement. a cgroup oom witness and wall deadline are
charged resource failures; missing, malformed or oversized child results and
unexpected executable exits hold as defects. a typed external signal may recover
as interruption. graceful worker shutdown reschedules with a failure cooldown;
claims are never refunded.

heartbeats renew job/heavy leases every five seconds. recognized temporary
heartbeat outages leave the claim to its lease. a heartbeat defect stops the
child and communicates its typed failure to settlement; it is not disguised as
worker disappearance. renewal reports renewed, busy or lost: a current claim
whose publication lock is busy retains its child and capacity without claiming
to have extended either lease. recovery must revoke the expired claim under its
normal fence before capacity becomes available. periodic schedules use unique utc slots; idle workers
listen for their lane, next due instant or heartbeat. readiness and health keep
their existing process/database identity contracts.

codex host restarts have no three-crash ceiling. intentional docker stops retain
their existing semantics. process restart, durable queue delivery and effect
replay are separate facts.

native finality gates replacement work and abnormal settlement. unresolved
bindings bypass domain failure hooks and consume the existing bounded failure
allowance, then hold with `E_NATIVE_FINALITY_UNKNOWN`. the ledger stays open;
foreground fifo stays blocked. maintenance `nexus native-repair JOB_ID` verifies
exact bindings and current intent before resuming that same held job. deletion
repair includes its retained discovery dependencies. no new counter, prompt
replay or generic reset accompanies repair.

## checkpoints and model effects

existing ingestion, indexing, discovery, traversal, asset and deletion checkpoints
remain domain-owned. transcription acquires a prepared source outside the
transaction, then publishes transcript/status, exact source-attempt success and
follow-up work together under the source fence. that exact completed attempt
prevents another provider call after restart. response loss before persistence
can still repeat paid read-only computation; no exactly-once billing claim follows.
atlas publication uses the same current execution fence.

background generation retries read-only work from fresh current input. temporary
runtime failure retries; invalid setup holds; resampling-eligible failures share
the queue's charged allowance. permanent content/context/policy refusal remains
a domain terminal. additive effects are never blindly replayed after uncertain
dispatch.

chat continuation is a separate delivery. an interrupted chat with a previously
started generation retains its existing safe interruption/cancellation behavior;
this queue policy does not promise that every accepted chat automatically finishes.

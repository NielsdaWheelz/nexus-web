# generation quiescence before release

the release owner is `deploy/hetzner/release.py`; operator commands live in
[deployment.md](../deployment.md#refusal-recovery). this contract adds no general
maintenance subsystem, admission flag or database state.

the quiescence check belongs to the existing release owner's stopped-writer
boundary. accept a planned single-user outage. do not introduce a general
maintenance mode, new database state, job scheduler or preparatory application
release unless the concrete refusal/recovery rehearsal proves one necessary.

## outcome and known evidence

before an incompatible provider/host cutover, stop new generation admissions,
settle accepted work under its original runtime, and prove zero nonterminal
generations. preserve admitted specifications, receipts, usage and saved history.

the prior controller only stopped processes. worker shutdown sets a stop signal; the worker
loop schedules periodic producers before consuming jobs and can reschedule
released work. clean process exits do not prove drained generations. no general
admission/producer pause was found in the survey; individual chat cancellation
exists.

the bounded live read-only census during this investigation found 21 chat runs,
all complete; zero `llm_calls` with null outcome; zero pending/failed/running jobs;
428 dead and 2,232 succeeded jobs. this establishes one idle observation, not a
stable release barrier. 144 tools marked running all join terminal failed
media-enrichment calls from october 14. they are historical receipt inconsistency,
not evidence of active execution; [their issue](issues/terminal-generations-retain-running-tool-receipts.md)
owns repair. do not rewrite them to make a release census look clean.

current generation-capable jobs include chat, metadata enrichment, part discovery,
oracle generation, media-unit synthesis and connection discovery. ingest/index
completion and tool writes can enqueue later work; periodic scheduling lives in
the worker loop. `llm_calls` alone cannot witness pending generations because its
row opens only when an attempt reaches dispatch. `chat_runs` retains accepted
chat intent before that. inspect durable jobs and accepted domain work together.

## owners, scope and invariants

- release coordination belongs to `deploy/hetzner/deploy.sh` / `release.py`;
  generation admission owns accepted commands; `jobs/worker.py` and
  `jobs/registry.py` own periodic scheduling/consumption; existing domain owners
  own cancellation, claims and settlement.
- distinguish new root operations from continuation/tool work required to finish
  accepted runs. stopping producers must not starve completion or lease renewal.
- prove quiescence across all processes and automatic producers, not only closed
  browser tabs. the existing physical stop boundary closes application admission
  and worker scheduling. a final census after verified shutdown is authoritative;
  an earlier census only helps choose an uneventful no-use window.
- preserve accepted command bytes and receipts; never mark rows complete through
  ad hoc sql or rewrite retired model choices. existing uncertain retries retain
  their identity and must receive a truthful disposition during maintenance.
- count nonterminal chats using the domain's terminal set (`complete`, `error`,
  `cancelled`); open generations by `llm_calls.outcome IS NULL`. classify tools by
  their generation and execution ownership, not the tool status in isolation.
  unresolved open rows refuse even if a job is dead or missing; no live process
  does not automatically make an unclosed generation truthful history.

## stopped-writer procedure

1. before replacing inputs, retain the actual deployed image identities, compose
   and immutable config references needed for recovery. use private existing
   artifacts; add no release-state database or second current pointer. a sha alone
   is insufficient. retain exact original container/image ids and host-input
   fingerprints before stopping; candidate host/Caddy installation follows the
   final census. the containers retain their original environment and immutable
   bind paths even if `current.env` already points to candidate configuration.
2. choose a no-use window after ordinary work settles. commit/sync device writing,
   close clients and stop operator/maintenance writers. inspect a bounded
   preflight census; use ordinary chat cancellation where deliberately requested.
   no server application imports inside a serving container for diagnostics.
3. let the existing controller stop api, both workers and codex, verify their
   clean exits and confirm no owned child or application maintenance one-off is
   still writing. do not wait for provider completion by inventing success.
4. before backup, postgres recreation or migration, read the old schema through
   the existing bounded sql path. require zero nonterminal chats and open
   generations. for this cutover initially require zero pending/failed/running
   jobs across all kinds: this is a conservative rule matching the observed idle
   state, not a requirement to delete recurring or terminal jobs. a narrower
   exemption requires proof of payload/schema compatibility and no later old
   generation, not merely that a kind sounds unrelated.
5. if zero holds, continue the normal backup/migration/start/promotion owner. no
   producer exists to race the census. if anything remains, refuse before schema
   mutation, identify exact ids/kinds, preserve accepted bytes and stay closed.
   settle through the captured old cohort's domain owners before retrying; never
   start new worker policy to finish old admitted commands.

the smallest pre-migration recovery uses the original stopped container ids:
their images and environment are still intact. under the existing release lock,
prove the database identity/revision is unchanged and no competing writer or
mutation one-off exists, verify the captured host input files/config references,
then start those exact original containers through `release.py --restore-original`.
do not recreate them from candidate compose or invoke an old deployment script.
refuse this path once postgres recreation/migration has begun or original
containers/inputs are unavailable. the implementation must rehearse start order,
readiness and identity before naming it an available recovery command.

the durable host record has two states: `recoverable` before candidate mutation,
and `invalidated` before the first candidate host/Caddy install or postgres
mutation. it survives controller loss. an invalidated record stays invalidated
across forward retries; no retry recaptures old containers against changed host
files. the controller removes it only after successful health/isolation and
current-pointer publication. incomplete original cohorts cannot be restored.
recovery stops partially restored originals, excludes competing nexus one-offs
and all other database client sessions, then starts codex, api and both workers
in dependency order with health and api runtime identity checks. operator writers
outside controller ownership must remain stopped.

strongest objection: shutdown itself can interrupt/reschedule accepted work, and
an earlier idle census can race a periodic producer. the conservative final gate
must refuse these cases safely. old services may need restoration to finish work;
that recovery must be executable through the release owner using captured old
inputs, before any migration. do not present a bare old script or `current` pointer
as a proved restoration procedure. after migration, normal forward-only recovery
still applies.

## smallest decisive rehearsal and open decisions

use the deployed cohort in an isolated restored runtime. first prove idle stop,
stable zero census and continuation. then admit one real generation and one
producer-follow-on before shutdown; observe the actual interruption/settlement,
nonzero refusal and unchanged schema. prove restoring the captured old cohort,
ordinary completion/cancellation and a successful retry. include controller loss
while stopped and a periodic enqueue race; keep the app unavailable until a
deliberate release-owner action.

this is the experiment that decides whether a broader drain control is needed.
if periodic work prevents a usable quiet window, identify that specific producer
before adding a pause capability. no blanket runtime redesign follows from a
hypothetical busy system. exact old-cohort restoration commands, one-off ownership
checks and accepted-domain census coverage must be qualified before merge.
the original investigation's independent source review supported this narrower
boundary; that investigation ran no recovery rehearsal. current proof belongs
in the implementation pr, not this contract.

## acceptance, costs and dependencies

qualify races with new admission, periodic producers, running tools, cancellation,
released work and controller interruption. prove accepted work can settle, the
census is zero after verified shutdown and stays zero until compatible writers
reopen. refusal must
leave requests/history truthful; after success, reopen only the compatible
server/web/client cohort. keep failure recovery concrete and observable.

costs: planned downtime and possible safe refusals/retries when shutdown catches
work. a conservative all-jobs check may delay release for unrelated work; accept
that small operational cost before introducing a classification framework.
the census runs after normal connections stop, avoiding a new live control pool.
coordinate with the model-catalog cutover; device outbox/cursor draining remains
a separate prerequisite. final operations
belong in [deployment.md](../deployment.md) and the release issue, proof in the pr.
use [verification rules](local-rules/testing-standards.md).

issue owner: [model release and missing drain](issues/release-model-catalog.md).
separate recovery hazard: [orphaned backup](issues/canonical-backup-rerun-lacks-attempt-reconciliation.md).

# Codex Personal Metadata Hard Cutover

**Status:** BASE CUTOVER AND EXISTING-VPS CAPACITY AMENDMENT IMPLEMENTED — OPERATOR ENROLLMENT, LIVE QUALIFICATION, CANARY, AND DEPLOYMENT PENDING
**Date:** 2026-08-13
**Type:** metadata-only hard cutover; no compatibility period
**Open questions:** none

## 1. Decision

Move `enrich_metadata` from the direct-provider API lane to a private,
ChatGPT-authenticated Codex agent host. The host uses the pinned
`llm-calling` `AgentRuntime`, the official stable Python Codex SDK, and a
Nexus-owned `codex-personal` profile.

This is not an OpenAI-compatible proxy and `codex-personal` is not a provider
row. Direct API generation and native Codex turns have different auth, state,
quota, tool, retry, and recovery semantics. They remain separate systems.

Metadata is the complete 80/20 slice. Chat, resume/fork UI, Nexus tools/MCP,
summaries, synapses, Dawn, dossiers, Oracle, and other background work are later
operation-by-operation cutovers. No partial framework for them ships here.

The committed production target remains the existing measured 1.9 GiB VPS. A
resize is not a prerequisite. The cutover ships there only if the exact
candidate satisfies the fixed cgroup, admission, and live-capacity proof below;
the proof threshold is not relaxed to make a release pass.

Approved assumptions:

- use the same personal ChatGPT subscription, not the operator's live
  `~/.codex-personal` directory;
- enroll a separate Nexus-owned state root with profile key `codex-personal`;
- subscription only: no API-key, model, provider, or backend fallback;
- old API conversations need no migration; a later chat cutover starts clean;
- metadata quota exhaustion is a visible terminal soft failure, manually
  retryable after capacity returns; v1 does not guess quota reset time;
- metadata has no Nexus tools, MCP, web search, writable files, or approvals;
- existing-VPS operation is conditional on the fixed §8 capacity contract;
- only a proven pre-accept capacity refusal may follow the bounded §7 wait;
  every post-accept loss remains uncertain and is never redispatched.

## 2. Goals and non-goals

Goals:

- make the personal Codex subscription the sole model route for metadata;
- preserve current metadata sampling, strict output, merge, author-pin, and
  soft-failure behavior;
- isolate subscription credentials and native state from API and job workers;
- retain exact target, policy, request, session, runtime, usage, and terminal
  provenance without pretending subscription use has API cost attribution;
- survive safe pre-dispatch replay and refuse ambiguous redispatch;
- keep the existing production VPS by combining the existing Heavy lease,
  per-container containment, and pre-accept host-pressure admission;
- establish one narrow native-agent boundary reusable by later explicit
  cutovers;
- delete every metadata-specific direct-provider path and test fixture.

Non-goals:

- changing metadata fields, prompt meaning, ingest triggers, or reader UI;
- migrating or deleting chat data in this pass;
- routing any other operation through Codex;
- public agent endpoints, raw App Server/WebSocket, `codex exec` parsing, or a
  general OpenAI `/v1` facade;
- shrinking the existing PostgreSQL, API, or worker budgets without separate
  measurements, or treating swap as additional Codex capacity;
- resizing the VPS, autoscaling, a second host, a general resource scheduler,
  or a cross-operation capacity broker;
- arbitrary model selection, dynamic discovery, provider fallback, automatic
  quota polling, or dynamic capacity policy;
- MCP, shell, web, filesystem write, skills, plugins, multi-agent delegation,
  scheduled agents, or a workflow engine;
- changing `docs/rules/modules/agent-runtime.md`; that module owns Nexus guest
  agent tool/context behavior, not this SDK host.

## 3. Final behavior

For every eligible metadata job:

1. The queue atomically claims the job and the existing global Heavy lease.
   Metadata cannot overlap `ingest_media_source` or
   `media_content_reindex_job`, including across worker replicas.
2. Nexus reads and snapshots the current media facts, builds the existing
   bounded content sample, and closes the database transaction.
3. It prepares one replay-stable generation id and request fingerprint in the
   existing job-payload step journal.
4. It durably starts the `agent_turns` row and commits `Uncertain` immediately
   before the host request.
5. Before returning HTTP 200, the host acquires the sole turn slot and proves
   the fixed capacity predicate in §8. A busy or pressured host returns the
   exact typed pre-accept capacity response in §6 without constructing
   `AgentRuntime` or opening a native session.
6. After admission, the host opens one new native Codex session and runs one
   structured-output turn using `gpt-5.6-luna` at `low` reasoning.
7. Nexus durably records the normalized terminal and `Completed` checkpoint
   before publishing metadata.
8. Nexus revalidates the structured value with
   `MetadataEnrichmentOutput`, then applies metadata fields, observed authors,
   and collection revisions in one serializable publication transaction through
   the existing transaction-scoped contributor facade.

Success returns the existing enriched-field list plus honest execution facts:
`backend=codex`, `transport=sdk`, `auth_profile=codex-personal`, and model.
There is no `provider=codex-personal` value.

An exact capacity response is not a model terminal. Nexus proves the same
generation and fingerprint are still `Uncertain`, changes only that checkpoint
back to `Prepared`, leaves the incomplete `agent_turns` row reusable, releases
the Heavy lease, and follows the bounded §7 wait without consuming an attempt.
Wait exhaustion completes the known pre-accept turn as
`E_METADATA_AGENT_CAPACITY_UNAVAILABLE`; it does not dispatch or fall back.
Crashing after refusal but before the `Prepared` checkpoint lands conservatively
leaves `Uncertain` and requires reconciliation.

Expected model failures complete the queue work but leave the existing
`failure_stage=metadata` warning on the media. This distinction is intentional:
the job executed to a known terminal; the enrichment did not succeed. Quota is
`E_METADATA_AGENT_QUOTA_EXHAUSTED`. Host/auth/unavailable and invalid-output
terminals receive distinct metadata-owned codes. None fall back or auto-retry.
Capacity re-admission is the sole pre-accept scheduling exception above.

A worker or transport loss after `Uncertain` leaves the job suspended/dead and
the incomplete `agent_turns` row operator-discoverable. It never emits another
turn. A replay from `Prepared` may dispatch once; a replay from `Completed`
reuses the recorded terminal and only republishes the domain result.

Manual retry is allowed after a known terminal, including quota exhaustion. It
is refused while an unresolved uncertain job exists; retry must never create a
second native turn around the reconciliation boundary.

No user-facing control is added. Existing metadata warning/retry affordances
remain the product surface.

## 4. Architecture and ownership

```text
ingest/refresh
  -> Postgres background job                  existing queue owner
  -> metadata snapshot + operation command   metadata domain owner
  -> durable_step_journal                     replay/uncertainty owner
  -> private HTTP-over-Unix-socket client     Nexus transport owner
  -> nexus-codex-agent-host                   process/security owner
  -> llm-calling AgentRuntime                 lifecycle/policy/event owner
  -> official Python Codex SDK                native protocol/session owner
  -> ChatGPT-authenticated Codex subscription
  <- normalized closed event stream + terminal
  -> agent_turns + Completed checkpoint       audit/replay result
  -> existing merge/contributor facades       publication owners
```

Ownership laws:

- `metadata_enrichment.py` remains sole owner of the prompt, output schema,
  content sampling, validation, and merge rules.
- A new closed operation catalog owns model, reasoning, policy, timeout, prompt
  revision, and output-schema digest. Callers cannot override them.
- The host owns SDK construction, state root, auth profile, cwd, process cleanup,
  concurrency, host/cgroup capacity parsing and admission, and conversion from
  `AgentEvent` to the wire union.
- The queue registry remains the sole resource-class catalog. It classifies
  metadata as `Heavy`; no host-local lock substitutes for the durable Heavy
  lease.
- The metadata job owns its bounded capacity-wait index and the sole safe
  `Uncertain` to `Prepared` transition. Shared replay codecs gain no
  capacity-specific field or branch.
- The release controller owns the deployment envelope and proves exact cgroup
  settings. The host owns per-turn admission. Neither reconstructs the other's
  state or adds a second scheduler.
- `llm-calling` owns in-process agent types and vendor behavior. Nexus owns its
  private RPC. No `llm-calling` change is expected; make one only for a proven
  missing public capability, with upstream conformance proof.
- `agent_turn_ledger.py` is the sole writer of `agent_turns`.
- The durable job remains coordination authority. `agent_turns` is provenance,
  not a second scheduler.
- The model proposes typed data; only Nexus writes PostgreSQL.
- `apply_observed_role_slices_in_current_transaction` remains the contributor
  write seam, so the author pin and metadata facts commit atomically.
- No database transaction remains open across host or SDK I/O.

## 5. Capability contract

The v1 operation catalog contains exactly one entry:

| Field | Required value |
|---|---|
| operation | `metadata_enrichment` |
| backend / transport | `codex` / `sdk` |
| auth | `CredentialRef(local_account, codex-personal)` |
| session | `NewSession`; one turn; close afterward |
| model / reasoning | `gpt-5.6-luna` / `low` |
| input | one bounded text part from existing metadata sampling |
| output | `MetadataEnrichmentOutput.model_json_schema()` |
| filesystem | `read_only` in an empty, read-only container cwd |
| network / approvals | `disabled` / `deny` for model tools |
| MCP / additional dirs / web search | empty / empty / false |
| Codex built-in tools | `builtin_tools="disabled"`; the public operation has no enabled tool surface |
| turn timeout | 120 seconds |
| host concurrency | one active turn |
| queue resource class | `Heavy` |
| host memory | 128 MiB reservation; 384 MiB memory hard limit; cgroup swap disabled |

`PermissionPolicy.allowed_tools=("*",)` remains the SDK's outer policy sentinel;
it does not grant a Codex tool. `CodexNativeOptions(builtin_tools="disabled")`
is the native capability boundary, and any residual tool or permission event
still fails closed.

Confinement comes from disabled built-in tools, the empty container, read-only
filesystem, disabled tool network, denied approvals, absent mounts, and absent
credentials. Any residual `AgentToolUse` or `AgentPermissionRequest` event is a
terminal policy failure and auditable.

Unknown operations, fields, event kinds, schema revisions, model drift, policy
drift, or post-terminal frames fail closed before publication.

## 6. Private API

Expose no TCP port. The background worker talks to
`/run/nexus-codex/agent.sock`, authorized by directory/socket ownership.

```http
POST /v1/turns
Content-Type: application/json
Accept: application/x-ndjson
```

```json
{
  "schema_version": "nexus-agent-command.v1",
  "request_id": "<replay-stable UUID>",
  "operation": {
    "kind": "metadata_enrichment",
    "revision": "<catalog revision>",
    "input": "<bounded metadata context>"
  }
}
```

Each NDJSON frame is strict and ordered:

```text
{schema_version, request_id, sequence, event:{kind,...}}
```

`event.kind` is the closed normalized union `text | tool_use | usage |
permission_request | native | terminal`. `terminal` is last and contains
status, typed failure, final text, structured output, session ref, usage,
bounded redacted diagnostics, SDK version, and bundled Codex runtime version.
The worker requires exactly one terminal. HTTP validation errors occur before
session open; loss after request acceptance is ambiguous.

This is API-shaped for composability, not OpenAI-compatible. Later operations
add tagged command variants; they do not add optional fields to the metadata
variant or weaken its policy.

Capacity refusal is the only non-200 response that means safe scheduling rather
than a rejected command:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
```

```json
{"schema_version":"nexus-agent-rejection.v1","kind":"capacity_unavailable"}
```

The host emits it only while holding no accepted turn and before runtime/session
construction. The client recognizes capacity only when status, content type,
schema, and body match exactly. Any other response is rejected by the existing
closed transport contract. No raw memory, PSI, process, or credential fact
crosses the UDS response.

## 7. Persistence and replay

Add `agent_turns` with application-validated lifecycle and only storage-owned
database constraints:

| Column | Meaning |
|---|---|
| `id uuid PK` | replay-stable generation id |
| `owner_kind text`, `owner_id uuid`, `turn_seq int` | polymorphic owner and ordered turn |
| `operation text`, `operation_revision text` | exact product binding |
| `backend text`, `transport text`, `auth_profile text` | execution route |
| `model_name text`, `requested_reasoning text` | requested target |
| `request_fingerprint text`, `policy_fingerprint text`, `output_schema_fingerprint text` | immutable request facts |
| `session_ref jsonb NULL` | strict opaque `agent-session-ref.v1` after a terminal |
| `outcome text NULL`, `error_code text NULL`, `error_detail text NULL` | normalized terminal; null means incomplete/uncertain |
| token columns | reported input/output/total/reasoning/cache usage when present |
| `sdk_version text`, `runtime_version text` | executable provenance |
| `created_at`, `completed_at NULL` | audit time |

Use a unique `(owner_kind, owner_id, turn_seq)` constraint and no FK from the
polymorphic owner. Do not store prompts, document excerpts, final prose, native
frames, auth material, or a fictitious dollar cost. Store hashes and normalized
bounded facts. The completed result needed for replay stays in the existing
job-payload journal until publication/pruning.

The metadata step path is `codex/metadata`. Its request fingerprint covers the
catalog revision, model, reasoning, system prompt, user input, output schema,
policy, and timeout. Reuse `stable_generation_id`, `StepReplayState`,
`checkpoint_step_state`, and `ReplayPolicy.BilledOnce`; do not fork their codec.

The metadata job payload always contains a bounded integer
`capacity_wait_index`, initially zero. The cutover migration canonicalizes any
retained metadata job, including a dead row eligible for manual repair, to that
one forward shape; runtime code has no missing-field compatibility decoder.
Each capacity refusal increments the index in the same lease-fenced mutation
that restores `Prepared`. The four schedule entries correspond to indices zero
through three. At index four the owner records the known capacity terminal
instead of rescheduling.

Set `enrich_metadata` to `Heavy`, two queue attempts, and a measured 300-second
lease.
Attempt two exists only to recover a crash before dispatch or to classify an
`Uncertain` replay as suspended. Known terminals do not return a queue-failure
sentinel and therefore do not consume a second attempt. Capacity waits use the
existing `RescheduleRequested` transition, compensate the claim attempt, and
release the exact Heavy lease. Retain dead rows for operator reconciliation.

## 8. Security and deployment

Run `nexus-codex-agent-host` as a separate Compose service using the same
immutable worker image, but a different command, environment, mounts, and
resource boundary. The worker image alone installs `provider-runtime[codex-sdk]`;
the API image does not. Reusing the worker artifact avoids a third release
identity while keeping process/state authority isolated.

Host requirements:

- dedicated non-root uid; `cap_drop: ALL`; `no-new-privileges`; read-only root;
  bounded tmpfs, memory, CPU, PIDs, output, and timeout;
- persistent `0700` state filesystem directly bind-mounted only by the host;
  shared run directory contains only the `0660` Unix socket;
- no Nexus `env_file`, database URL, provider keys, object-store keys, Docker
  socket, source/library mounts, or host home;
- a fixed empty cwd and no caller-selected paths;
- ChatGPT account check at readiness; API-key auth or inherited `OPENAI_API_KEY`
  is a startup defect;
- production preflight runs the bundled Codex CLI's actual sandbox path through
  `python -m apps.codex_agent.sandbox_health` before promotion;
- the outer Docker seccomp/AppArmor/system-path guards are relaxed only for the
  named, non-root, capability-free host so it can construct that stricter inner
  sandbox; Ubuntu's global user-namespace restriction remains enabled;
- the host uses a dedicated internet-egress bridge with no database or
  application-service peers, and release inspects the bridge's exact live
  membership rather than trusting only the host container's network name;
- production credential state is a dedicated LUKS2 container; the
  release-owned PostgreSQL backup neither mounts nor reads it, provider
  snapshots may contain only its ciphertext, and every other backup or unlock
  secret remains explicit operator evidence; re-enrollment is the recovery
  path;
- graceful shutdown interrupts the active turn and reaps descendants before the
  container exits.

Enrollment is an explicit operator handoff: provision the empty volume, run the
documented device-login command against the exact host profile directory, verify
ChatGPT auth and file modes, then deploy. Credentials never enter Git, captured
env, logs, test artifacts, or another container.

Pin the `llm-calling` commit, SDK, bundled runtime, and image digest. Upgrade only
after the hosted canary and sandbox/auth probes pass at the candidate versions.

### Existing-VPS capacity contract

The production host must report at least 1,900 MiB `MemTotal`, at least 1 GiB
`SwapTotal`, cgroup v2 memory control, `MemAvailable >= 256 MiB`, memory PSI
`full avg10 == 0`, and `some avg10 <= 5` before release mutation. The release
controller no longer requires every independently capped service to reach its
hard maximum simultaneously or requires a nominal 4 GiB machine. It proves that
every long-lived service reservation plus the 320 MiB host reserve fits measured
`MemTotal`; the Heavy lease and per-turn predicate own active-work admission.
Individual hard limits remain enforced and inspected; existing service limits
are not reduced in this slice.

The Codex container has `memory.max = 384 MiB`, no cgroup swap allowance, and a
128 MiB reservation. Immediately before accepting each request it strictly
parses host `MemAvailable`, host memory PSI, and its own cgroup
`memory.current`/`memory.max`. With

```text
remaining_growth = memory.max - memory.current
```

admission requires a finite exact `memory.max`, non-negative
`remaining_growth`, `MemAvailable >= remaining_growth + 256 MiB`, PSI
`full avg10 == 0`, and `some avg10 <= 5`. The sole turn slot is acquired before
the snapshot and held through terminal emission and runtime close. Busy,
malformed, pressured, or insufficient-capacity states return the exact §6
pre-accept response. They never wait behind an already accepted HTTP 200.

The 384 MiB ceiling is valid only with the live qualification in §11: three
turns must keep `memory.peak <= 320 MiB`, leaving at least 64 MiB cgroup margin,
while sampled host `MemAvailable` never falls below 256 MiB.
Failure blocks this existing-VPS cutover. Do not raise the cap, lower the host
reserve, reduce existing service limits, or relax PSI thresholds inside this
scope.

## 9. Hard-cut residue

In the same atomic change:

- remove `metadata_enrichment` from direct `BackgroundLlmOperation`,
  `OPERATION_PROFILES`, provider runtime-composition expectations, and
  `LlmCallOwner`;
- delete `build_metadata_enrichment_intent` and all metadata imports of
  `GenerationRequest`, `execute_generation`, `run_llm_task`, API rate limiting,
  provider outcomes, `httpx`, and `uuid4`;
- delete the metadata strict-output responder from
  `tests/testkit/openai_embedding_server.py`;
- delete historical `llm_calls` rows owned by `media_enrichment`, remove that
  owner from the table constraint, and never decode them;
- delete `METADATA_ENRICHMENT_MAX_OUTPUT_TOKENS` because the agent SDK has no
  matching product knob; the strict bounded schema and runtime output limit own
  the replacement behavior;
- remove `E_METADATA_NO_PROVIDER` and any other now-unreachable metadata API
  wording;
- update `docs/modules/llms.md` to show metadata on the native-agent lane.

Do not leave a feature flag, dual write, legacy reader, shadow call, API escape
hatch, source-grep tombstone test, or fallback. Direct API chat and other jobs
remain because their cutovers are explicitly out of scope, not as metadata
fallbacks.

## 10. Non-overlapping work packages

| Package | Sole file ownership | Deliverable |
|---|---|---|
| A. Contract and host | `python/nexus/services/native_agent_{contract,operations,client}.py`; `apps/codex_agent/**`; `python/pyproject.toml`; `python/uv.lock` | strict command/event/rejection union, fixed metadata binding, pre-accept admission, UDS host/client |
| B. Durable audit | `python/nexus/services/agent_turn_ledger.py`; `python/nexus/db/models.py`; migration `0216` | `agent_turns`, hard deletion of legacy metadata calls, canonical retained-job payload, start/terminal writer |
| C. Metadata cutover | `python/nexus/tasks/enrich_metadata.py`; `metadata_{enrichment,dispatch,lifecycle}.py`; `llm_profiles.py`; `jobs/registry.py`; `config.py`; `errors.py`; metadata-only testkit residue | Heavy classification, bounded capacity wait, journaled execution, atomic domain publication |
| D. Runtime and operations | `docker/Dockerfile.backend`; `deploy/hetzner/docker-compose.yml`; `deploy/hetzner/{release.py,sync-env.sh,prove-codex-capacity.sh}`; enrollment/runbook docs | isolated service, measured existing-VPS envelope, capacity qualification, promotion, rollback |
| E. Proof portfolio | only files under `python/tests/**`, `testdata/**`, and test-controller routing | red/green proof below |
| F. Documentation integration | `docs/modules/llms.md` and this spec's status only | final owner map and shipped-state record |

Package A first fixes the contract. B and D may then run in parallel. C starts
after A+B. E writes the failing proof before each production package and owns no
production edits. One integrator handles F and the final residue inventory.

## 11. Red / green / refactor and proof shape

Follow [`testing.md`](../rules/testing.md). Every proof
must be observed red for the named missing behavior before production code, then
green, then refactored without weakening the oracle. Use `./scripts/test` only.

| Ownership boundary | One focused proof | Oracle |
|---|---|---|
| command/event algebra | `python/tests/kernel/test_native_agent_contract.py` | strict tagged round trip; unknown/drifted values rejected |
| agent host process | `python/tests/service/test_codex_agent_host.py` | real UDS process + upstream `ScriptedAgentRuntime`; insufficient/busy capacity returns exact 503 before runtime construction; admitted turn preserves policy, grammar, cleanup |
| queue capacity | `python/tests/service/test_heavy_job_capacity.py` | real PostgreSQL workers cannot claim metadata while parser/reindex holds Heavy; metadata becomes claimable after release |
| storage migration | `python/tests/migrations/test_codex_personal_metadata.py` | real PostgreSQL upgrade/convergence; legacy metadata calls absent; shape preserved |
| metadata durable job | `python/tests/service/test_codex_metadata_enrichment.py` | real PostgreSQL + real worker process + test-owned protocol-valid UDS host; capacity refusal restores Prepared, preserves attempt and incomplete ledger, then one accepted success; existing replay and quota cases remain |
| accepted transport loss | `python/tests/service/test_codex_metadata_transport_durability.py` | real worker observes HTTP acceptance followed by disconnect; ledger stays incomplete and replay stays suspended |
| live subscription wire | `python/tests/hosted/nightly/test_codex_personal_metadata.py` | one bounded real Luna structured turn from a dedicated test profile; ChatGPT auth, usage, versions, no tools |
| deployment wiring | existing production deploy behavior/journey owner | measured 1,900 MiB fixture passes; low headroom/PSI blocks before mutation; exact cgroup/image/isolation/health/rollback |
| existing-VPS qualification | `deploy/hetzner/prove-codex-capacity.sh <source-sha>` and immutable JSON evidence | exact image/profile/384 MiB cgroup; one cold plus two warm turns; peak/headroom/PSI/OOM assertions plus evidence-free predecessor-health admission; no prose or credential evidence |

The hosted runner is a credential boundary, not merely a label. Do not register
it directly to a public repository. Use a private repository, a separate private
orchestrator, or an organization runner group restricted to this exact workflow
on `main`. The runner has no unrelated credentials, production reachability,
Docker authority, or general job-time `sudo`; OS packages and AppArmor are
pre-provisioned outside the workflow.

The local fake runs behind the production UDS client boundary; product code has
no fixture mode. Do not mock PostgreSQL, the queue, the worker, or the metadata
publisher. Do not snapshot generated prose. The hosted proof is scheduled and
one-turn bounded, never a PR dependency.

Register `durable-codex-metadata-uncertain-checkpoint-bypass`, which removes
only the pre-dispatch `Uncertain` checkpoint. Its exact durable proof is
`pytest:python/tests/service/test_codex_metadata_enrichment.py::test_real_worker_publishes_authors_pins_and_exactly_replays_after_publication`;
the fresh transaction guard must fail with `the Uncertain checkpoint was not
durably committed before native dispatch`. `./scripts/test prove` must then
pass on the implementation. Broader journey proof covers wiring only; it does
not repeat domain cases.

The existing-VPS qualification runs only after operator enrollment and before
the first 0216 promotion. It sends three bounded synthetic metadata commands
through the real UDS host without database or application credentials. Its
run-bound evidence contains only source SHA, worker digest, SDK/runtime
versions, a `measured_at` timestamp, cgroup limit/current/peak, minimum host
available memory, maximum PSI, OOM counter deltas, terminal status/usage
presence, tool-event count, and named service health. The command, not the
operator, validates every §8 threshold, three successful structured turns,
zero tool/permission events, zero new OOM events, and healthy PostgreSQL, API,
Caddy, and workers.

The command deletes neither application data nor Codex state and never records
prompt, output, auth, or raw SDK frames. A failed or stale proof cannot authorize
promotion. It asks the immutable release controller to write root-owned `0444`
evidence at `/var/lib/nexus/releases/codex-capacity/<source-sha>.json`; the first
0216 promotion refuses absent, malformed, stale (`measured_at` older than 72
hours), or wrong-image evidence. The command cleans only its named ephemeral
canary container and socket.

Insufficient pre-admission headroom produces `not_run`; auth or quota
unavailability produces `provider_blocked`; pre-accept unavailability or
accepted transport loss produces `transport_retriable`. None writes qualifying
evidence, and the unchanged SHA may be repeated only after the corresponding
pressure, account, or transport fault is resolved. PostgreSQL, Caddy, API, and
worker health are observations of the unchanged predecessor: unhealthy state
blocks measurement without evidence and remains retriable for the same SHA. A
cgroup peak, OOM, PSI, host-policy, protocol, or structured-output breach writes
failed evidence and blocks this cutover; rerunning cannot replace it.

Register `durable-codex-host-capacity-admission-bypass`, which changes only the
host admission result from refused to admitted. Bind it to the exact real-UDS
host proof that supplies insufficient capacity and asserts HTTP 503 plus zero
runtime construction. The fault must fail by observing an accepted response or
runtime construction. Keep the existing uncertainty and accepted-transport-loss
sensitivities unchanged.

Required verification shape:

```text
inner loop:  ./scripts/test changed <exact owned path/proof>
package:     ./scripts/test confidence
integration: ./scripts/test pr
live:        ./scripts/test codex-nightly
capacity:    ./deploy/hetzner/prove-codex-capacity.sh <source-sha>
release:     ./scripts/test release
sensitivity: ./scripts/test prove --proof <durable-proof> --against fault:<fault-id>
```

## 12. Acceptance criteria

The cutover is complete only when:

1. An eligible media item is enriched through one subscription-authenticated
   Codex turn and the current metadata/author semantics persist.
2. Metadata starts no direct provider request and creates no `llm_calls` row.
3. No API key is visible to the agent host or child; account identity is ChatGPT.
4. The host has no public listener, DB access, host home, writable source, MCP,
   web search, or mutation authority.
5. The exact model, reasoning, prompt/schema/policy revisions, session ref,
   runtime versions, usage, and terminal are auditable in `agent_turns`.
6. A completed replay publishes without a second turn; an uncertain replay
   suspends without a second turn; a prepared replay may dispatch once.
7. Quota, schema violation, timeout, cancellation, auth failure, and pre-accept
   host unavailability are distinct closed outcomes. Pre-accept capacity
   refusal follows only the bounded Prepared/reschedule contract; exhaustion is
   `E_METADATA_AGENT_CAPACITY_UNAVAILABLE`. None falls back or retries a known
   terminal. Host loss after request acceptance remains `Uncertain` and is never
   redispatched automatically.
8. Manual retry works after a known terminal and is refused while an uncertain
   job awaits reconciliation.
9. Metadata fields, authors, author-pin behavior, and collection revisions
   converge in one serializable publication transaction.
10. The migration deletes legacy metadata call history and all residue in §9 is
   absent. Other direct-API operations are unchanged.
11. The focused local proof portfolio, required sensitivity, hosted canary, and
   release sandbox/auth/health gates pass at the exact shipped revisions. The
   first 0216 promotion also has fresh existing-VPS qualification evidence that
   satisfies every §11 threshold.
12. `docs/modules/llms.md`, deployment runbook, and runtime identity describe the
    shipped boundary without claiming OpenAI API equivalence.

## 13. Later cutovers

Each later operation gets its own spec, policy, schema, eval, quota behavior, and
proof. Chat is next and may reuse the UDS event contract and `agent_turns`, but
must separately design Nexus-canonical transcripts, native session refs,
resume/fork lineage, evidence/quotes, MCP capability grants, interactive
priority, cancellation, compaction, and destructive deletion of old API chat
state. Nothing in metadata v1 pre-decides those product semantics.

Authoritative references:

- [`docs/modules/llms.md`](../modules/llms.md)
- [`docs/runbooks/codex-personal-agent-host.md`](../runbooks/codex-personal-agent-host.md)
- [`llm-calling/docs/agent-runtime.md`](../../../llm-calling/docs/agent-runtime.md)
- [Official Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Official Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Official Codex App Server boundary](https://learn.chatgpt.com/docs/app-server)

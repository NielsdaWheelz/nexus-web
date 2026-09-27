# codex subscription reading helpers

status: implementation staged; live release qualification incomplete
origin: 2026-09-26 owner approval; runtime, api/content and adversarial review

## outcome and decisions

codex subscription runs nexus chat and background reading/research helpers.
codex owns its native shell/tool loop; shell commands call nexus through an
authenticated http api. each generation gets disposable scratch and public
internet access. there is no saved filesystem, workspace product, autonomous
background process, account pool or new agent platform.

this replaces the codex execution/authority requirements in
[latest-models-cutover-plan.md](latest-models-cutover-plan.md). that plan still
owns the exact model/effort catalogue, non-codex providers, ultra prohibition,
policy roles, history reset and remaining release qualification. chat remains
`CodexPersonal / gpt-6-sol / medium`; all twelve background roles retain their
codex model, effort and strict final schema. no automatic metered-api route.

source of truth for the mechanism: `codapt2@4f79e5a4c56af50844b8477c69cb3df57f40058e`,
`docs/modules/main-{codex-pool,workspace-api}.md`,
`src/main/server/codex/{service.ts,internal/commands.ts}` and
`src/main/server/codex/internal/skills/workspace-api/SKILL.md`. copy execution separation,
http/schema discovery and ordinary shell use. codapt2 pins 0.153.1 and uses
metered apis for structured projections; neither qualifies nexus's 0.157.1
shell-plus-strict-json combination. prove that combination first.

## authority and composition

the new boundary is an isolated execution environment plus authenticated
domain services. there is NO promise of an exact model-visible native tool
list. scratch, shell and public-internet effects are outside nexus's tool
ledger and undo. nexus api operations retain their domain guarantees.

| owner | public contract; hidden implementation |
| --- | --- |
| llm-calling | typed remote codex execution selection, model/effort/output facts, native session/turn/events/interruption/usage; hides vendor rpc and feature configuration |
| llm-agent-kernel | existing `run_generation` ordering, durable terminal callbacks and cancellation; no container, model table or nexus api knowledge |
| nexus runtime | existing private `agent.sock`, admission slot, subscription enrollment, execution isolation and teardown; supplies native endpoints to the library |
| nexus generation api | authenticates account/run, publishes existing operation schemas, authorizes domain access and records effects; uses existing handlers and llm-tools |

llm-tools gets one generic `HttpApi` exposure arm for its existing frozen
profile/executor contract. nexus freezes one release-owned broad api profile;
every codex run has the same operation grant. do not mislabel http as `Native`
function publication or `HostTable`, or add HTTP routing to the library.

other provider routes keep their existing frozen function tools and sealed
continuations. both transports call the same domain handlers. the kernel's
contained schema-step provider remains a distinct, actively used contract;
do not inject its no-shell instruction into this native execution route or
relax containment for its other consumers.

## runtime

retain the current one-generation admission slot, outer host container and
private host protocol. each generation starts an account app-server outside
a fresh exec-server sandbox. account auth stays in the outer host; the shell
gets only scratch, system executables and its generation-api credential.

reuse installed **bubblewrap** for a fresh user/pid/mount namespace: allowlisted
read-only binaries/libraries/ca/resolver files, fresh `/proc`, scratch cwd/home,
cleared environment and closed inherited fds. NEVER bind `/` or the host's
`/run`, auth, control sockets or product data. use `--unshare-user`,
`--unshare-pid`, `--die-with-parent` and disable nested user namespaces.
the shell may install/download dependencies into scratch; system mounts stay
read-only. current codex workspace-write confinement permits outside READS
and is insufficient for this boundary. no docker socket or new privileged
container controller is required.

set account app-server `CODEX_EXEC_SERVER_URL=none`, as codapt2 does. start
exec-server inside the namespace on a dynamic `127.0.0.1` websocket port;
reject non-loopback addresses. llm-calling registers that remote environment,
checks `environment/info`, and selects only it on thread and turn requests.
all shell/filesystem helpers must resolve there. remote loss fails the run;
no local-execution fallback. control remains on the host's private unix socket.
native policy is `full_access` + `unrestricted` + `approval=deny` (codex
`danger-full-access`/`never`), with the library's required explicit policy
acknowledgements. the OUTER namespace enforces isolation; do not start a
second native workspace-write sandbox after disabling nested namespaces.

the sandbox shares the outer network namespace. revise deployment firewall,
egress policy, release attestation and network health together: permit public
destinations and the private generation api; deny database/private-service,
administration and metadata routes in both address families. neither native
sandbox flags nor instructions enforce this. no published exec/control port.

pin app-server and exec-server to **0.157.1** from the same locked binary/image
source; verify both running identities. retain codapt2's service-owned deny-all
mcp/extensions configuration, including apps, plugins, hooks and delegation;
enable ordinary shell/filesystem tools and the managed nexus skill. do not
claim feature flags form an exact native tool allowlist. browser/computer/image
product integration is outside scope.

native shell events are progress, not requests for nexus to execute commands
again. strict output uses codex's native output schema followed by host schema
validation; intermediate shell output is never the final structured result.
retain actual native terminal/usage semantics and bounded final publication.

on cancel/deadline: close api admission, interrupt codex, terminate the sandbox
namespace and account process, await both, settle or retain uncertain api
effects, then delete scratch/native state and release the slot. namespace-init
exit must kill detached descendants; `killpg` alone does not. host restart must
prove no prior execution remains before readiness. never automatically rerun
uncertain dispatch.
reuse existing admission/journal/health owners; no new scheduler or recovery
state machine. retain ids and teardown evidence in existing runtime records.

## capability and api contract

extend existing llm-calling native options with one typed remote execution
descriptor: private exec endpoint plus cwd, supplied by the runtime owner.
catalogue facts distinguish contained execution from remote shell and state
which final output kinds are supported in each. these are generic native
facts; `nexus`, http endpoint names and domain permissions never enter the
library catalogue. nexus composes them with local runtime/api readiness.
strict-json-plus-shell is advertised only after its pinned live proof.

replace nexus's codex frozen-model-tool authority with this explicit arm;
retain the existing provider-api arm and its optional frozen plan:

```text
GenerationAuthority =
  CodexShell { api_contract_revision, api_plan: FrozenToolPlanSnapshot,
               execution_policy_revision }
  | ProviderFunctions { existing_optional_frozen_plan }

GenerationApiCredential = {
  generation_id: uuid, token_sha256: unique digest,
  user_id: uuid, job_execution_id: uuid, expires_at: utc timestamp,
  closed_at: utc timestamp | null
}
```

`api_plan` freezes the fixed broad profile's grants, bindings and budgets for
replay identity; it is not chosen/narrowed per task. account, generation,
selected model/effort, limits and output schema stay in
the existing frozen generation spec. no new workspace identity/table. rotate
affected catalogue, request, backend and schema fingerprints.

the execution environment receives `NEXUS_AGENT_API_URL`,
`NEXUS_AGENT_API_SPEC_URL`, `NEXUS_AGENT_API_TOKEN` and `NEXUS_GENERATION_ID`.
the token is random, run-bound and opaque; server storage contains only its
hash, requester identity, original job execution identity and deadline in one
generation-keyed credential row; status remains owned by existing generation/job
rows. some media-keyed jobs do not identify one requester from their resource
owner; mint must prove and bind the actual requesting account from job evidence
or refuse admission.
require that non-resetting execution id to remain the live claim. every
request checks expiry, active run and claim;
cancellation/terminal closes admission. use existing token-hash and
lease primitives. keep credentials out of frozen specs, application logs and receipts.
retain final-only answer publication for bearer-backed turns. redact assembled
native activity/diagnostic text before persistence or display, including bearer
values split across event chunks; per-frame replacement is insufficient.
redact a text final; reject a structured final containing the bearer rather
than mutate the strict payload. temporary native state is deleted at teardown.
this lifetime restriction does NOT narrow the run's operation permissions.

all codex generations receive the same finite surface, using canonical ids:

| endpoint | contract |
| --- | --- |
| `GET /agent-api/openapi.json` | authenticated, generated from operation declarations; exact inputs, outputs, limits, errors and examples; `no-store` |
| `POST /agent-api/operations/<canonical-id>` | one concrete documented route per id; existing typed input as body; required UUID `Idempotency-Key`; returns `{position_id, result}` with the canonical typed result and evidence |

the browser's authenticated `GET /generation-effects` lists recent account
write positions with cursor pagination, including completed and uncertain
outcomes and exact undo eligibility. its optional `generation_id` filter is
for linked operation views; the unfiltered list remains discoverable. the
authenticated `POST /generation-effects/<position-id>/undo` reverses a
completed background generation-api write from the current account. the shell
cannot call this route with its generation bearer. the position's exact created
refs, reversal and authorship stamp commit together; an already undone position
returns idempotent success, while unfinished or uncertain work returns `409`.

the twelve ids are `web.search`, `web.read`, `nexus.search`,
`nexus.resource.read`, `nexus.document.search`, `nexus.resource.inspect`,
`nexus.relations.list`, `nexus.library.add`, `nexus.note.create`,
`nexus.highlight.create`, `nexus.edge.create`, `nexus.queue.add`.
do not export browser/admin/delete routes. api provider keys stay server-side.
missing optional search credentials yield an explicit dependency failure at
that operation, not global codex unreadiness or an invented empty result.

api authorization covers the authenticated account's visible corpus, including
resources outside chat context. null search scope means that corpus. explicit
references still pass domain visibility and mutation checks. current
`admitted_resource_uris` membership must not silently retain the old limit;
use an explicit account-scope arm beside the existing provider context scope.
record truthful scope in evidence. task instructions guide behavior; they do
not reduce the api grant. all twelve operations, including additive writes,
are available to background helpers too.

serve this api on the execution-private route through the existing API owner;
public ingress/bff must not forward `/agent-api`. bearer credentials cannot
authorize ordinary nexus endpoints. no second domain server or hand-written
openapi mirror. reuse pydantic/tool declarations and existing error envelopes.
missing/invalid bearer is `401`; inactive/changed/uncertain work `409`;
unknown operation `404`; oversized body `413`; schema rejection `422`;
unavailable dependency `503`. domain refusals keep their declared result type.

## durable effects

extend the existing tool-position owner with `GenerationApi` transport. its identity is
`(generation, transport, native-child-sequence, idempotency-key)`. allocate the
ordinary monotonic position before dispatch and bind the canonical operation,
input digest and api/binding revisions. an http request arrives DURING the
native child; it needs an authenticated active child, not an already accepted
model terminal. do not fabricate a native function call or infer one from logs.

while the run/token remains active, exact-key replay returns the stored typed
result; afterwards use persisted nexus history. changed operation/body is
`409` replay mismatch; concurrent/in-progress and uncertain calls return
explicit `409` states without redispatch. existing domain transactions and
llm-tools replay policy own settlement. new keys mean new operations: the
server cannot infer identical human intent from two keys. reuse the same key
after a lost response. preserve existing request/result limits and one api
operation in flight per generation; reuse the current chat api-budget ceilings
and eight-write cap, bounded by each generation's deadline. unknown routes/auth/schema failures occur
before effects. expected domain failures remain typed results; dependency
unavailability is explicit. do not catch defects as empty successes.

include http positions in the existing unfinished-position terminal guard,
citations, authorship and undo projections. close admission atomically before
terminal acceptance so no late request creates an untracked effect. cancel
does not undo completed writes. shell/public-internet effects have native
activity history only: no fabricated receipts, exactly-once or universal undo.

## non-overlapping implementation and content ownership

each owner supplies a designer; reviewed content is part of the interface.
the reviewer owns no implementation files and challenges each stage.

| owner | exclusive files/scope | designer's definition of good |
| --- | --- | --- |
| a — provider protocol | llm-calling `agent_runtime/{types,codex_app_server,codex_adapter,model_catalog,policy}.py` and native contract docs | exact modes/output facts; concise safe stage/cause diagnostics; no nexus vocabulary |
| b — execution | nexus `apps/codex_agent/` except skill content, `docker/`, `deploy/hetzner/`, codex health contract and runtime runbook | instructions identify disposable scratch, allowed network and cleanup; diagnostics distinguish auth, runtime and teardown |
| c — domain api/effects | new `api/routes/agent_api.py`, `services/agent_api.py`, managed `apps/codex_agent/skills/nexus-api/SKILL.md`; `tool_runtime/`, `tool_authority.py`, `llm_ledger.py`, db models/migration; llm-tools `profiles.py`/exports for `HttpApi` only | schemas give purpose, bounds, failure and minimal valid example; skill teaches discover → inspect → call → same-key retry → cite, without duplicating schemas |
| d — consumer/product | `generation_{spec,catalog,policy,backend}.py`, `codex_generation_{contract,client,operations}.py`, affected structured-task/projection/UI owners | existing route description distinguishes subscription quota from metered api; explains disposable scratch, public internet and account-wide read/additive access; background-operation details show the same authority; distinguish native activity, app effects and uncertain outcomes |
| e — integration | manifests/locks, kernel dependency/contract docs, this and parent plan, tickets and receipts | exact pins, passed/failed/waived/not-run evidence; no inherited proof claims |

b owns skill installation, c owns its content. shared schemas describe null
search scope by transport; examples include every required nullable field.
c owns ledger fields; d consumes
them through public interfaces. provider-library changes belong in a; kernel
needs only contract/pin alignment unless a demonstrated generic gap remains.
publish a/c interfaces before b/d depend on them. no additional tool catalogue,
shell wrapper framework, vm platform, account pool, native checkpoint transfer,
shell transcript viewer or persistent package/filesystem feature.

## hard cut and proof

use the parent plan's drain, backup, approved history reset and coordinated
release. invalidate old native commands/authority and remove codex mcp paths,
the frozen-mcp capability, text-only eligibility workaround, dead containment
assumptions in this nexus route and abandoned api-route substitutions. preserve
active contained-library contracts and other providers. never mount prior
generation scratch or native state. domain data/effects survive the approved
reset; new scratch is always disposable. pre-cutover rollback retains the
parent plan's explicit data handling.

temporary end-to-end/live proofs follow red → implementation → green →
refactor → green → delete. independent review challenges requirements, red,
implementation, green and cleanup. ordinary `./scripts/test` remains static.

1. **feasibility red first:** prove pinned app/exec version and remote selection;
   model-originated shell fetches the generated api spec, makes two dependent
   api calls and returns text; repeat with strict json for luna/low and
   sol/high. native schema rejection blocks the design; no api fallback.
2. **authority:** account-wide search/read outside chat context; one additive
   write with durable result, authorship and supported undo; wrong-account,
   expired/cancelled token and unknown operation denied before effects.
   demonstrate duplicate-key replay, changed-request rejection, lost-response
   uncertainty and terminal racing an http call without an orphan effect.
3. **isolation/lifecycle:** public fetch/package download succeeds; secret paths,
   host/docker/app-server control, database/private and metadata routes fail
   (both address families). exercise detached child teardown, deadline,
   cancellation, host death/restart and real auth refresh. never print a
   credential to prove it is inaccessible. prove bearer filtering across split
   chunks, final answers and diagnostics. prove scratch absent next run and
   no redispatch after uncertain native/effect dispatch.
4. **product/composition:** final pinned browser/bff/api/worker/native journey,
   chat reopen and all twelve background roles produce valid recorded outputs;
   all 15 codex model/effort cells work with native shell, ultra is rejected.
   preserve the parent's api/continuation/configuration proofs and xai waiver;
   rerun affected boundaries on the final artifacts, including one other
   provider's function-tool journey. measure cold-start/resource fit.
5. **finish:** required static checks and residue audit; delete only temporary
   proof code/fixtures/owned resources after acceptance, retaining a terse
   nonsecret receipt with exact pins, cases and limits. close resolved tickets.

## explicit trade-offs

native shell/public internet permits disclosure and external actions outside
the app ledger; even read-only tasks have the broad account api grant. run
tokens are visible to shell and can be copied, but work only through private
ingress while their run remains active. scratch/package changes disappear.
app-server and exec-server starts cost latency; reusing bubblewrap avoids a
privileged container controller but makes linux namespace isolation a release
requirement. both share the outer public-egress policy: account-process egress
is broader than before; account credentials must be absent from every native
execution filesystem. exact-key replay cannot deduplicate a freshly invented key.
subscription usage remains quota-limited; no automatic api spending. final-only
answer publication sacrifices incremental display for secret filtering. retaining
the separate provider function transport serves the requested other models.
deleting temporary proofs leaves static checks and ordinary use as regression
coverage. these are explicit design costs, not hidden implementation choices.

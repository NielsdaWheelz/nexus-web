# chat reliability review

2026-09-25. read-only investigation with three parallel reviewers covering
frontend state, durable execution, and external product/research patterns.
application code and production state were not changed. findings were recorded
in tickets as required by repository rules. this is a proposed direction, not
an implemented repair.

the subsequent [specification and implementation plan](chat-reliability-plan.md)
owns the proposed contracts, work packages, cutover and acceptance.

the latest no-reply incident has a concrete explanation: nexus requests a
codex capability combination that the pinned provider rejects. the original
pane crash remains unproven. memory pressure exists, but no memory kill was
observed in the inspected production window.

**evidence and limits**

frontend, api and host current pointer agree on production source
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`; local source is
`cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`. the relevant generation lowering,
provider pin and inspected chat paths are unchanged between these revisions.

run `ac2b162e-0bb1-4b66-90f5-a9aaec0b3f22`, selected codex model
`gpt-5.6-sol` with low reasoning, was accepted at 7:43:49 pm pacific. subsequent
run/history reads and stream connection succeeded. three seconds later the
worker recorded `GenerationContractDefect: invalid_request is a host defect`.
the generation became uncertain; subsequent attempts refused redispatch. the
job became dead after three attempts at 7:46:22 pm. only the initial metadata
event exists. the user subsequently confirmed the pane says response paused.

this is a failed execution with functioning suspension display, not an active
model thinking indefinitely. the previous crash may be a separate failure.
the retained api logs contain no client-defect report identifying it. a pane
retry remounts the view; it does not repair a provider or data-contract defect.

api, interactive worker and codex host had zero restarts and zero cgroup oom
kills; retained kernel logs for 48 hours contained none. the interactive
worker reached its 320 mib cap with 13 max-limit events. the codex host peaked
near 332 mib under its 448 mib cap. lifetime counters do not establish what
happened in earlier deployments or which operation caused the peak.

**the broken contract**

[nexus lowering](../python/nexus/services/codex_generation_operations.py)
requests workspace writes, unrestricted network, and its authenticated mcp
server for tool-bearing chat. it also sets `builtin_tools="disabled"`.
provider-runtime commit `97fbac7fece4f1ea54651b7d6344df9fac3b2791`
explicitly requires read-only files, disabled network and no mcp for that
posture. inspection inside the deployed host verified this exact installed
commit and both rejection guards. a pure local policy check against that pin
raised `UnsupportedCapability` before any native session was started.

the host maps this exception to `invalid_request`. its original exception
subtype is discarded, so the specific recorded host occurrence cannot be
reconstructed from its logs. nevertheless, the request incompatibility is
deterministic and shared across codex models. it does not establish that
provider-api routes have the same defect.

merely enabling built-ins or deleting the guard is incorrect. the provider's
pinned documentation states that disabled built-ins do not prove native
capability absence before execution: its containment depends on a
credentialless, read-only, offline child. adding mcp/network changes that
contract. later terminal validation also rejects observed authority activity
under the disabled posture.

the correct owner is the provider's capability contract and nexus's lowering
to it. establish whether the native runtime can enforce only the exact
nexus-authorized mcp plan while retaining native-effect containment. capability
compatibility must be validated before admitting durable work. if this cannot
be enforced, codex-plus-tools must be explicitly ineligible until it can;
another supported route requires a deliberate user choice. a renamed option,
prompt restriction or permissive fallback is not a solution.

**what the council would ask**

| perspective | decisive question | conclusion |
| --- | --- | --- |
| runtime and capability design | can the installed adapter represent this exact authority request? | currently no; repair the contract before tuning models or memory |
| distributed systems | what was accepted, completed, or left uncertain? | admission succeeded; generation has no accepted terminal; retain its identity and effects |
| frontend | which phase threw: admission, canonical read, stream or render? | the original crash still needs browser evidence; the latest paused state is confirmed |
| product and accessibility | what survived, and what will the recovery action actually do? | preserve words and history; distinguish reread, reconnect, rerun and operator repair |
| operations | can the first failure be traced without reproducing paid work? | correlation exists, but the host discards the original runtime rejection |
| verification | what proves an ordinary user can complete this exact journey? | static checks and healthy containers do not; a tool-bearing real-stack journey does |

the agreement is stronger than a generic call for resilience: one command has
one durable identity; observation is separate from execution; current model
availability does not own historical access; a defect stays a defect; recovery
must preserve uncertainty rather than invent success or start fresh work.

**the philosophy and useful precedents**

a chat turn is durable work, and a pane is one view of it. continuity means
preserving the user's intention, accepted work and understanding of state.
the system owes an honest account of what happened, especially after a fault.

[librechat resumable streams](https://www.librechat.ai/docs/features/resumable_streams)
records generation deltas and reconstructs prior content before resuming live
delivery. borrow that continuity across navigation and connection loss. its
docs distinguish in-memory single-instance operation from redis for multiple
instances; they do not justify adding redis to nexus's existing durable event
store. do not generalize restart durability from an in-memory mode.

[assistant-ui](https://www.assistant-ui.com/docs/primitives/message) provides
message-local error presentation and distinguishes running, action required,
complete and incomplete responses. borrow the locality and explicit states;
its presentation primitives are not evidence of safe command replay.

[react](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary)
describes product-meaningful error boundaries, including conversation lists and
individual messages. an independent malformed message renderer can be
contained locally; an invalid shared transcript engine cannot safely be kept
running by catching everything. repair invariants before narrowing boundaries.

[aws's idempotency guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
explains caller-owned identity, atomic mutation-plus-receipt and equivalent
replay outcomes. nexus already implements much of this at chat admission.
keep it. admission idempotency does not prove a separate uncertain provider
call may safely be repeated.

an [open webui user report](https://github.com/open-webui/open-webui/issues/29596)
describes a refreshed client losing the beginning of a streamed response even
though the full response remained server-side. it is a cautionary example,
not our reproduction or evidence of prevalence: durable storage and correct
rehydration must both work.

[nielsen norman's error guidance](https://www.nngroup.com/articles/error-message-guidelines/)
emphasizes preserving input and reducing the work needed to recover.
[amershi et al.](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)
developed and evaluated human-ai interaction guidelines covering correction,
understandable behavior and user control. these support truthful recovery
actions; neither source prescribes a new workflow engine.

**disagreements, decisions and their costs**

- availability versus authority: a permissive flag could unblock generation,
  but would change which effects the model can cause. preserve the intended
  authority boundary. cost: codex tools may remain unavailable until the
  native capability contract is proven.
- loud failure versus readable history: keep strict decoders and operator
  defect reporting. contain independent presentation failures and model known
  operational failures at their owner. cost: some corrupt views still stop;
  never fabricate a transcript to make the pane look healthy.
- automatic recovery versus duplicate work: automate bounded observation
  recovery; reconcile uncertain execution instead of resending it. cost:
  genuine uncertainty can require operator attention and temporarily block
  continuation. that is preferable to repeating paid calls or tool writes.
- diagnostic detail versus confidentiality: retain the original safe class,
  cause, stage and correlation identifiers in existing operator logs. cost:
  deliberate sanitization; full prompts, credentials and arbitrary exception
  payloads are not acceptable diagnostics.
- history availability versus current model eligibility: read frozen facts
  independently of the live catalog; disable unavailable generation actions.
  cost: controls can be unavailable while the conversation remains readable.
- proof versus infrastructure: reuse the database, queue, generation journal
  and event stream. cost: their contracts must be repaired precisely. a new
  broker, workflow framework or telemetry service would add owners without
  resolving this contradiction.
- manual proof versus regression automation: justify small checks at the
  cross-package capability boundary and uncertain-cancellation transition,
  which ordinary typechecking misses. do not rebuild the retired suite.
  `./scripts/test` remains the sole automated static gate, not runtime proof.

**proposed repair order**

1. preserve diagnostic evidence at the host boundary and reproduce the exact
   capability rejection without paid dispatch. settle the enforceable provider
   contract, then update its implementation, nexus lowering and admission
   eligibility together. keep unavailable combinations unselectable.
2. repair cancellation/reconciliation of uncertain generations before using it
   on affected production work. the current source can repeatedly renew the
   queue attempt budget without resolving the dispatch. preserve original
   identities and effects; do not rewrite uncertain rows by hand.
3. align composer and assistant-row state. the paused card works; the composer
   still calls every pending assistant running. remove operator-defect copy
   that invites a new message while rerun is forbidden.
4. capture and repair the original pane crash at its first failing owner.
   separately decouple history/run reads and cancellation from catalog
   initialization. cached catalog refresh already tolerates some outages, so
   do not overstate that ticket as the cause of this observed run.
5. measure the interactive worker's allocations during successful ordinary
   tool-bearing work. an evidence-based memory change can be independent;
   increasing limits does not repair an invalid capability request.

acceptance should cover one new conversation and continuation for each distinct
execution route, at least one real authorized tool operation, leave/reopen and
connection-loss recovery of the same run, a lost admission reply replayed with
the same key, and uncertain cancellation without repeated execution or an
unbounded requeue. validate the native capability boundary against unintended
effects. add the concrete pane-crash trigger once identified. record source,
static, manual and production evidence separately.

**open work and boundaries**

- [codex dispatch and capability mismatch](tickets/restored-chat-codex-dispatch-fails.md)
- [original pane crash](tickets/production-chat-pane-crash-and-stalled-response.md)
- [lost original runtime failure](tickets/codex-host-discards-original-runtime-failure.md)
- [uncertain cancellation loop](tickets/chat-cancel-uncertain-codex-requeues-without-settlement.md)
- [suspended composer wording](tickets/chat-suspended-response-announces-in-progress.md)
- [unsafe operator-defect guidance](tickets/chat-operator-defect-copy-invites-new-command.md)
- [catalog-dependent reads and cancellation](tickets/conversation-read-500s-without-generation-catalog.md)
- [interactive worker memory margin](tickets/interactive-worker-startup-reaches-memory-cap.md)
- [incidental selection-label rejection](tickets/nexus-selection-label-exceeds-api-limit.md)

no application fix, new generation, cancellation, retry, restart, deployment,
production data change or successful tool-bearing chat proof was performed.
the production database inspection used read-only transactions and selected
metadata, not message bodies. static checks were not run for this research and
ticket-only change. existing unrelated workspace changes were preserved.

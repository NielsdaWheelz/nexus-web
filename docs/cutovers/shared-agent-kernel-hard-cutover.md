# Shared agent kernel hard cutover

## Decision

Nexus and Jarvis consume one embedded `llm-agent-kernel` package. The package owns
model/tool execution ordering; each application owns its durable records,
authority, domain effects and publication. `llm-calling` owns provider transport
and native protocol normalization. `llm-tools` owns tool definitions, execution
and recorder contracts. Applications pin immutable, independently qualified
commits. No kernel service or second Nexus execution loop remains.

This implements the approved September 9 architecture review against Nexus main
`a7d6c6babdf529cb950df55ea8f3e3e995c6623e`. That main already contains the generation
journal and exact backend catalogs. Those owners remain authoritative; findings
about the older Chat loop are superseded by this baseline.

## Required behavior and proof

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| K1 | One portable execution owner drives API and contained native-agent turns. Nexus has adapters, without a duplicate orchestration loop. | Shared kernel behavioral suite; Nexus API and Codex composition proofs; static import and ownership review. |
| K2 | A complete valid model decision is durably accepted before its proposals are acknowledged or tools execute. A late event, missing/duplicate terminal, protocol defect or failed durable write prevents dependent effects. | Controlled boundary-fault kernel proofs and real PostgreSQL Nexus journal proof. |
| K3 | Ordered multiple proposals retain exact call identities. Recovery reopens the committed canonical decision and uses the existing effect recorder; it never reruns an uncertain model request or changes its arguments. | Kernel ordering proof; Nexus real-worker continuation and tool-position replay proof; Jarvis recovery-barrier proof. |
| K4 | Stream observers acknowledge output before dependent work. Cancellation and finite turn/tool limits stop further dispatch with explicit non-success orchestration outcomes; native terminal and usage evidence remain unchanged. | Kernel cancellation, acknowledgement and limit proofs; Nexus durable stop/replay proof. |
| K5 | Latest provider catalog and initialization behavior coexist with contained Codex authority checks. Forbidden native authority and protocol failures are fatal. Owned transport queues and messages are bounded. Explicit Nexus MCP grants remain supported. | Provider subprocess/adapter/catalog suite and adversarial fault sensitivity; app catalog composition checks. |
| K6 | Latest `llm-tools` implementation revisions are frozen into admission. Asynchronous recorder/database work yields during database waits and preserves atomic effect, receipt and settlement. | Real PostgreSQL lock-progress and effect-replay proofs; immutable snapshot identity tests. |
| K7 | Historical records stay readable without executable old grant adapters or fabricated revisions. Migration refuses undrained incompatible active work. | Migration tests with historical records and active-work refusal; historical selection/provenance service proof. |
| K8 | Jarvis retains its durable action recovery barrier, explicit terminal outcomes and shared sealed base instruction. Recoverable effectful execution requires a durable model-decision owner. | Jarvis service/restart proofs and kernel conformance suite. |
| K9 | Dependency pins resolve to immutable reviewed commits, with one provider/tools version per application graph. All replaced paths and obsolete tests are removed after sensitive replacement proof. | Frozen install, lock review, authoritative static and behavior gates across all changed repositories. |

## Boundaries

Nexus keeps `GenerationSpec`, model-turn and tool-position ledgers, continuation
encryption, claims, Chat/artifact publication, citations, app policy, native MCP
grants and its existing transport service. Jarvis keeps its message/action
storage, reconciliation and delivery. Shared code does not import application
types or own a database, workflow engine, approval UI or tool executor.

The kernel accepts explicit host lifecycle, driver, tool and observer contracts.
Provider lowering remains native: API continuation bytes and Codex session
identity are not forced into an artificial common transcript. A stopped
orchestration is separate from a provider terminal and cannot imply success.
Durable host acceptance is mandatory for recoverable effects; disposable
inference must choose an explicit transient lifecycle.

Jarvis stores paid model requests and their exact normalized terminals separately
from action contracts. Recovery restores the original input IDs, checkpoint,
time and role-validation evidence before applying retry limits. Completed paid
reads use durable tool positions; an armed read with no result cannot rebill.
The deployment advisory lock and consequential database operations use the same
connection. Losing that connection ends the owner's authority permanently.
Existing immutable action contracts retain their original shape and recovery
barrier; the model journal owns the new definition identity.

## Cutover and trade-offs

1. Reconcile the contained provider transport onto current provider main and
   qualify the latest tools revision.
2. Extend the shared kernel contract and prove its invariants independently.
3. Replace Nexus orchestration with shared-kernel adapters; update tool contracts
   and required application persistence/projections. Migrate Jarvis to the same
   released contracts while preserving its recovery barrier.
4. Pin exact reviewed commits and run the application conformance and required
   repository gates. Delete replaced paths after sensitivity is demonstrated.

The embedded library gives one semantic owner with independent app releases; it
does not provide centralized live deployment. Serial tool execution preserves
effect order and reduces recovery states at the cost of parallel throughput.
Scoped asynchronous PostgreSQL connections preserve transaction ownership and
event-loop responsiveness; unpooled connections trade connection setup cost for
safe use from the worker and MCP event-loop lifetimes.

Deployment must drain incompatible active generations before the schema change.
Historical admission documents remain immutable; read projections consume
historical presentation facts, never reconstruct executable old authority.
Terminal failed job history remains readable. Pending/retryable jobs and open
model generations must drain; historical grants cannot execute through the new
strict decoder, including through a manual retry.
The cutover has no dual runtime, feature flag or backward execution path.

Existing application write policy remains the authority owner. This work does
not add semantic intent inference or a new approval interface. Agent councils,
recursive context runtimes, learned memory, distributed workflow services and
parallel tool schedulers from the research survey are outside this cutover.

## Verification contract

Follow `docs/local-rules/testing-standards.md`: independent behavioral oracles,
recorded red/green sensitivity, a dominant service/component middle, real
PostgreSQL and workers for durable behavior, and only essential enclosing
journeys. Use `./scripts/test` for Nexus gates. Report local, Linux/process,
CI, hosted-provider and production evidence separately. A blocked or unrun gate
is not a pass. No paid provider request, merge or live deployment is part of
local implementation verification.

The sensitivity registry uses `coherent-fault` for the new shared-kernel
boundaries: the baseline lacks the shared package, new lifecycle result and
asynchronous recorder contract. It also uses that exception for the retained
accepted-child replay, MCP authority, dossier uncertainty and prompt-safety
owners. Their test support now constructs the required implementation revision,
awaits recorder operations, and uses the renamed generation failure encoder;
overlaying that support onto the old dependency graph cannot reach the retained
behavioral assertion. Each exception pins one reviewed exact owner and one
product-only fault with an explicit assertion fingerprint. Existing unrelated
BASE proofs retain their original sensitivity mode.

New independent faults cover native and API terminal tails, implementation
authority, database event-loop progress, atomic effect/receipt settlement,
historical read-only projection, migration drain, durable orchestration stops,
and resumed Chat usage. Chat's recovery proof consumes original accepted child
usage from the ledger and publishes it once while retiring the continuation.
Cancellation of an armed unknown call still requires reconciliation; cancellation
cannot manufacture evidence that the provider did not execute it.

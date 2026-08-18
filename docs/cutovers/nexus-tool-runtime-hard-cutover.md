# Nexus Tool Runtime Hard Cutover

**Status:** IMPLEMENTED IN SOURCE; FINAL CONFIDENCE/PR/FULL/RELEASE GATES PENDING
**Date:** 2026-08-13
**Type:** atomic Nexus consumer/runtime hard cutover; no compatibility period
**Prerequisite:** [LLM Tools Library Hard Cutover](llm-tools-library-hard-cutover.md)
**E0 prerequisite:** SATISFIED BEFORE N3 — hardened source `1c4c60c0` and the
E0 R0/N0d checkpoint `325a8eb1` preceded N1–N3; the §7 connection-seam proof
and `accepted-url-private-redirect-bypass` sensitivity are green. Candidate-image
binding remains required by the final protected release gate.

## 1. Decision

Build one Nexus-owned tool runtime from the portable `llm_tools` declaration,
profile, execution, and evidence primitives. Nexus declares and binds every
`nexus.*` tool locally because Nexus owns its resource
vocabulary, authorization, data admission, search semantics, persistence,
citations, durable replay, trust trail, and Undo.

`declarations.py` exports the one immutable Nexus declaration set.
`composition.py` joins it to the owned bindings as one
`ToolFamily(namespace="nexus", ...)`, then composes imported `web`/`tool`
families only for profiles that grant those ids. No unbound family or final
profile revision is published before composition.

The target product surface is:

- Chat: eleven direct native tools—today's nine under canonical ids, plus
  `nexus.document.search` and `nexus.relations.list`.
- Idea Dossier: its existing durable application-owned research flow, using the
  imported `web.search` binding where it already searches the Web.
- Other background work: its current direct domain reads and writes, with no
  new model-callable tool grants.

Keep general `web.read`, `tool.search`, and `tool.read` in `llm_tools`, but do
not publish them in a Nexus v1 profile. Nexus's accepted-source ingest is a
durable persistence workflow, not `web.read`. An explicit-URL ingestion tool,
discovery-mode Nexus profile, and remote transport each require their own later
product/security cutover.

Keep current first-party Chat write policy: additive effects, maximum eight
active writes per run, durable trust trail, and one-tap Undo. Do not add an
approval/suspension state machine. Keep the live edge-write semantics as
`nexus.edge.create`; do not split it into propose/apply in this pass.

## 2. Goals and non-goals

The goal is the target surface in §1 under the contracts in §§3–10 and the
acceptance criteria in §14.

Non-goals:

- granting all tools to every job or rewriting background algorithms;
- Nexus page reading, arbitrary-URL fetching, source-ingest redesign, Browse
  behavior, or Dossier coordination redesign; E0's §7 egress hardening was a
  separate prerequisite, not permission to redesign that workflow here;
- PTC, provider-native Tool Search, a guest code runtime, or provider engine,
  model-registry, continuation, or retry changes;
- remote Nexus tool transport, credentials, authorization, or client product;
- a new search index, graph traversal engine, capability registry, citation
  store, write service, queue, journal, or worker;
- renaming `app_search_scope` / `appSearchScope` or any product capability that
  is not a tool id;
- provider/model fallback, a tool marketplace, dynamic plugins, or feature
  flags preserving the old route.

## 3. Architecture and rules

```text
Nexus vocabulary/domain owners
  -> local ToolSpec declarations + ToolBinding adapters
  -> immutable Nexus ToolCatalog
  -> operation-owned CapabilityProfile + ToolPlan snapshot
  -> one ToolExecutor
       -> Native: provider-runtime values for Chat
       -> HostTable: deterministic application calls for Idea research
  -> existing Nexus managed operations
  -> strict result + Nexus evidence
  -> existing durable journal / citations / trust / Undo / projections
```

Laws:

- The catalogue states what exists; the profile grants what this operation may
  call; the principal and operation-owned admitted set or data-scope predicate
  constrain what it may see. Every boundary must pass.
- Tool output, retrieved text, model arguments, and external metadata are
  untrusted and cannot widen grants, scope, limits, or identity.
- Authority profiles and exposure plans are separate. Chat has a `Native` plan;
  Idea research has a `HostTable` plan. There is no exposure fallback.
- A direct Program Agent governed by `docs/rules/modules/agent-runtime.md`
  continues to publish only `run`. Its internal host table may consume the same
  declarations later; this cutover does not change that runtime.
- Canonical ids are the only executable identity. Provider aliases are derived
  only by the `provider-runtime` integration adapter and never authorize
  dispatch or replay. A bounded raw provider name may persist only in the
  rejected-provider-call audit variant in §10.
- General declarations are imported; Nexus declarations remain beside their
  owning vocabulary. No Python package containing Nexus domain contracts is
  created for remote reuse.
- The executor is an application service, not a new domain layer. It validates
  and dispatches to existing managed operations; it does not reproduce their
  authorization, transactions, retries, or citations.

The shared Agent Runtime rule remains unchanged: its Program Agent publishes
only `run`. Nexus Chat is an application-owned generation ToolLoop outside that
module and publishes one closed Native plan. Never combine the two runtimes or
reuse Agent Runtime protocol state for Chat.

## 4. Structure and reuse

```text
python/nexus/services/tool_runtime/
  declarations.py   local specs; generated from or directly importing owners
  profiles.py       immutable profile definitions
  bindings.py       spec-to-existing-service bindings
  execution.py      Nexus context, admission, budgets, result adaptation
  composition.py    bound families, final catalogue/plans, startup validation
```

Reuse these sole owners rather than moving or cloning them:

- `resource_items/capabilities.py`, `search/kinds.py`, and
  `contributor_taxonomy.py` for closed search vocabulary;
- `search/service.py` and current search indexes;
- `resource_graph/resolve.py`, `media_read_map.py`, and current document-read
  policy;
- resource-graph connection/provenance/citation owners;
- library, notes, highlights, edge, and consumption/queue write services;
- `chat_run_tools.py`, `chat_run_citations.py`, trust-trail and Undo owners;
- `durable_step_journal.py`, Chat worker/lease/fence, and Dossier coordination.

Delete only the old tool declaration, parsing, dispatch, and presentation code.
Do not rename underlying product/domain APIs merely because the model-facing id
changes. Keep `app_search_scope`; local declarations import its generated
schemes and hint so schema/help drift remains impossible.

There is no mutable global registry, string `if/elif` dispatch ladder, second
executor, raw Pydantic schema publication, XML result protocol, or
recursive result rewriting. The existing three duplicated `_xml_attr` helpers
and tool-specific XML renderers disappear; canonical results are JSON and any
prompt wrapper uses `llm_tools.prompt_sections`.

## 5. Nexus capability contract

All inputs are strict objects. All expected failures are closed unions tagged
by `type`. Common boundary failures are `InvalidInput | ToolUnavailable |
BudgetExceeded | DeadlineExceeded`; each declaration adds only the `ErrorT`
below. Read successes carry Nexus-owned evidence sufficient for current citation
publication; write successes carry the persisted result refs required by the
trust trail and Undo.

| Canonical id | Effect / replay | Input / result | Closed `ErrorT` | Existing semantic owner |
|---|---|---|---|---|
| `nexus.search` | Read / `ReDispatchable` | query, admitted scopes/types, limit -> ranked matches and evidence | `ResourceUnavailable` | current app-search service and capability registries |
| `nexus.resource.read` | Read / `ReDispatchable` | admitted resource/read URI -> exact bounded text and evidence | `ResourceUnavailable | Unreadable | TooLarge` | resource resolver/read policy |
| `nexus.document.search` | Read / `ReDispatchable` | one admitted readable document URI, query, required-nullable limit -> matching sections/fragments and evidence | `ResourceUnavailable | Unreadable` | current scoped search/index owners |
| `nexus.resource.inspect` | Read / `ReDispatchable` | admitted resource URI -> ordered document map and canonical read URIs | `ResourceUnavailable | Uninspectable` | media read-map owner |
| `nexus.relations.list` | Read / `ReDispatchable` | admitted resource URI, direction, required-nullable kinds/limit -> one-hop relations and refs | `ResourceUnavailable` | resource-graph connections owner |
| `nexus.library.add` | Write / `ReDispatchable` | resource and library identity -> persisted membership ref | `ResourceUnavailable | TargetAmbiguous | WriteCapReached` | library-entry service |
| `nexus.note.create` | Write / `ReDispatchable` | markdown and optional page URI -> persisted note ref | `ResourceUnavailable | WriteCapReached` | daily-note service |
| `nexus.highlight.create` | Write / `ReDispatchable` | media URI, quote context, optional note -> persisted highlight ref | `ResourceUnavailable | QuoteNotFound | QuoteAmbiguous | Conflict | WriteCapReached` | highlight service |
| `nexus.edge.create` | Write / `ReDispatchable` | source, target, kind, rationale -> persisted edge ref | `ResourceUnavailable | Conflict | WriteCapReached` | graph-edge service |
| `nexus.queue.add` | Write / `ReDispatchable` | media URI -> persisted queue-entry ref | `ResourceUnavailable | WriteCapReached` | consumption queue service |

The eight renamed Nexus tools preserve their current required-nullable input
fields, defaults, validation, domain outcomes, and output meaning; only their
canonical id, strict JSON envelope, and centralized declaration/execution path
change. `nexus.document.search` takes `{uri, query, limit}` and returns at most the
profile's bounded ranked passages from that admitted document.
`nexus.relations.list` takes `{uri, direction, kinds, limit}` where direction is
`incoming | outgoing | both`, kinds is required-nullable owner-defined kinds,
and limit is required-nullable and capped by the profile; it returns stable
one-hop relation and endpoint refs. Every object is closed and every field is
required; semantic absence uses the repository-owned `Presence` internally and
required JSON `null` only at the model boundary.

`nexus.document.search` is a single-document specialization of existing scoped
search, not a new index. `nexus.relations.list` is one hop only; it does not add
recursive traversal. Limits are declared from actual owner limits. A profile
may tighten them but may not silently lower shipped Synapse, Oracle, or other
non-tool consumers.

Malformed arguments use common `InvalidInput`. Empty searches/lists and
already-added library or queue membership are successful convergent results.
At model and same-system projection boundaries, nonexistent, foreign-owned,
unauthorized, and outside-admission resources collapse to one
`ResourceUnavailable` envelope with no existence-bearing fields. Every binding
maps an explicit closed set of existing domain exceptions and `ApiErrorCode`
values into its `ErrorT`; the open global API error space never crosses the tool
boundary. An unmapped exception or code defects. Internal telemetry may retain
the true reason without returning private identifiers. Expected authorization
denials map to `ResourceUnavailable`; authorization-evaluator exceptions or
invariant failures, foreign-row leakage, invalid owned results, impossible
state, and partial writes remain defects. Retry exhaustion is a defect unless
the owning declaration explicitly models dependency exhaustion, as imported
Web tools do with `RateLimited` and `UpstreamUnavailable`.

The legacy refusal map is exhaustive: `write_cap_reached` becomes
`WriteCapReached`; `library_not_found` becomes `ResourceUnavailable`;
`library_ambiguous` becomes `TargetAmbiguous`; quote no-match/ambiguous become
`QuoteNotFound`/`QuoteAmbiguous`; empty quote and all argument-shape failures
become `InvalidInput`; and `unknown_write_tool` becomes unreachable/defect.
Each named existing `ApiErrorCode` encountered by a binding is likewise listed
in that binding's adapter table and covered by its contract proof before the
open legacy handler is deleted.

### Evidence

Nexus bindings adapt their existing retrieval/citation values into each local
strict success schema; the generic result envelope has no Nexus evidence union.
A citable read result retains:

- canonical resource/source identity;
- immutable snapshot/revision or content digest;
- exact locator and excerpt identity;
- observed/retrieved time when material;
- admission scope and the existing citation target/ref.

The current citation owner remains the sole publisher of final citation edges
and back-pointers. Tool output never fabricates citation numbers.

Nexus declarations also own one typed presentation projection. Tool activity
and result events expose server-derived `effect`, closed `result_kind`, and
`activity_label`; trust/Undo payloads expose the same structural fields. The UI
renders these fields and never classifies by tool id. Effect comes from the
tool contract; result kind participates in the browser projection revision;
labels participate only in the documentation revision.

For known tools, `effect` is `Pure | Read | Write` and `result_kind` is
`retrieval` for `web.search`, Nexus search/read/document-search/relations;
`navigation` for resource inspection; or `mutation` for writes. The failure
status does not change that semantic kind. The two non-executable historical
variants have `effect=null` and exact kinds `rejected_provider_call` or
`attached_context`. No other null effect or result kind decodes.

## 6. Profiles and actual operation behavior

Profiles are closed source declarations validated at startup. A frozen plan
snapshot contains `profile_id`, `profile_revision`, `plan_revision`, `exposure`,
grants, effective limits, tool revisions, and binding-policy revisions; it
contains no prose hash or provider alias.

`chat_runs.profile_id` remains the existing LLM/model-selection snapshot and is
never repurposed. Add `tool_profile_id`, `tool_profile_revision`, and closed
`tool_profile_snapshot` JSONB, written atomically before Chat admission. New
runs require all three; the revision equals the snapshot's `profile_revision`,
whose grant entries contain every tool contract revision. Workers execute only
that snapshot. Terminal pre-cutover runs may leave them null and are never
executable; refuse every nonterminal old run. Do not add a generic profile
table. Idea research stores one complete frozen `HostTable` plan snapshot in
the existing durable-step journal before its first Web-search position:
profile/plan ids and revisions, HostTable exposure, run/effective limits, the
`web.search` grant, tool revision, binding-policy revision, and replay policy.

| Operation | Exposure | Exact grants | Rule |
|---|---|---|---|
| Chat | Native | `web.search` plus all ten `nexus.*` ids above | Eleven eager tools; `web.search` is tightened to the current six results/five selected/12,000 context chars; current read/write behavior plus the two new reads; no `web.read` or discovery tools |
| Idea Dossier research | HostTable | `web.search` at the existing research step | Keep current sequential durable selection, accepted-source ingest, readiness, and citation behavior; no PTC |

The exact provider-published Chat definition list—provider-safe names,
descriptions, and strict presentation input schemas after the production
`provider-runtime` lowering—must be at most 12,288 canonical UTF-8 JSON bytes
for every Chat-supported engine.
N1 records only the declaration baseline; N3's final bound-publication proof
records the existing nine-tool baseline plus final per-tool and total bytes;
the ceiling is a deterministic prompt-cost guard, not a token or latency claim.

The following remain direct, operation-owned behavior and receive no generic
model-callable profile in this cutover:

- non-Idea Dossier deterministic membership/MI work;
- Synapse's single 48-hit search, relation/exclusion logic, and sole replace-set
  commit;
- Oracle's anchor-joined retrieval and existing 100-edge paging;
- Dawn's raw time-window signal reads;
- `media_unit_build`, `enrich_metadata`, metadata, summaries, abstracts,
  authors, linking, and other structured synthesis jobs.

Tool availability is not authority. Do not route these jobs through Chat limits,
grant every background model a catalogue, or create empty persisted profile
state solely for uniformity. A later job gets a profile only when its model
actually chooses tools.

The public Browse feature keeps its product query contract and directly adapts
to the renamed low-level Brave provider. It is not a model tool profile.

`BRAVE_SEARCH_API_KEY` remains optional at process boot. When it is absent,
Chat still publishes the exact eleven-tool plan; `web.search` uses an explicitly
unavailable binding and returns `ToolUnavailable` before network dispatch.
Because Idea research requires Web search, its request boundary returns a
closed `WebResearchNotConfigured` admission error before creating or enqueueing
a build. Invalid explicitly configured credentials remain a deployment defect,
not a model-visible failure. No alternate provider or fallback is added.

## 7. Web and write security

Chat's `web.search` sends only the bounded model-authored query and freshness
policy to the configured search provider; Nexus never mechanically appends
credentials, retrieved documents, context objects, or opaque private payloads.
Because Chat also has private Nexus reads, query text can still encode terms
learned from private context. V1 explicitly treats the operator-configured
search provider as an authorized processor for that query disclosure; enabling
the credential records acceptance of this information-flow policy. This is not
a claim that network safety prevents semantic exfiltration from prompt
injection. The binding proof asserts the exact outbound field set and bounds;
log provider/request identity and bounded query metadata, never credentials or
private context. A stricter partition or approval gate is a later product/
security cutover, not an unenforceable v1 promise.

Chat receives no arbitrary-destination fetch tool. `agent_tools/web_page_read.py`
and `media_source_ingest.py` remain the Dossier-owned durable accepted-source
workflow: they may create Media, attempts, jobs, and library membership and may
wait/requeue for readiness. They are not bound as `web.read` and are not
re-plumbed through the portable reader. A future explicit URL tool is a
separately reviewed `nexus.source.accept` Write/durable capability.

Idea Dossier accepts only an exact build-owned `web.search` result reference;
the model cannot supply an arbitrary URL. This first-party host policy requires
no human approval, but a search result does not make its URL trusted. The pre-E0
production transport in `node/ingest/ingest.mjs` followed redirects without the
required destination enforcement. **E0 Accepted-URL Ingest Egress Hardening**
therefore landed as a separately committed prerequisite work package with
exclusive ownership of `node/ingest/**`, its lock/package metadata,
`.dockerignore`, `python/nexus/services/{node_ingest,web_article_ingest}.py`,
`docker/Dockerfile.backend`, `deploy/env/env-prod-worker.example`, the release
publisher/config validator, and its test-control routing. At the final E0
checkpoint, the actual Node connection seam proved:

- HTTP(S)-only normalized URLs, no userinfo, credentials, cookies, ambient
  proxy, or cross-hop authorization forwarding;
- resolution and rejection of every non-public/metadata address, bounded
  manual redirects with full per-hop revalidation, and DNS-rebinding prevention
  through connected-address pinning or an enforcing egress proxy;
- HTML/XHTML MIME admission before parsing plus compressed, decoded, body,
  redirect, and total-deadline limits while streaming; and
- public-to-private redirect, DNS-to-private/rebinding, forbidden-MIME, and
  oversize fixtures that observe zero requests at the private endpoint.

Do not claim that the portable reader or Python `safe_fetch.py` proves this
Node-owned path. E0 owns exactly
`node/ingest/test/accepted_url_egress.test.mjs`, run by the repository test
controller as `node-test:node/ingest/test/accepted_url_egress.test.mjs` and
registered under `auth-privacy-secrets`; the proof uses test-owned HTTP/DNS
fixtures while exercising the production resolver/connected-transport policy.
E0 recorded target-proof red and green, the representative
`accepted-url-private-redirect-bypass` fault and fingerprint, and its exact
source SHA before N3 began. Production always launches the
image-baked `/app/node/ingest/ingest.mjs`; published config containing
`NODE_INGEST_SCRIPT` is rejected, and the production adapter has no environment
override. Local/test composition may inject an explicit owned script path
through a non-environment test seam. The E0 worker-boundary proof inspects the
candidate image and proves `run_node_ingest` launches that baked hardened
entrypoint. E0 adds no general crawler, browser, or portable-reader abstraction.

First-party Chat writes retain all current owner checks, transactions, maximum
eight non-reverted writes per run, trust records, and Undo. Starting Chat is the
authority; no approval pause is introduced. No remote tool principal exists in
v1. Commit the tool result before dispatching the next provider turn.

## 8. Position-aware durable execution

For Chat, invocation identity reuses the shipped journal owner:

```text
InvocationPosition = (run_id, durable_step_path)
durable_step_path = turn/{turn_index}/tool/{global_tool_index}

InvocationPosition ->
  (canonical_tool_id, canonical_input_sha256)

ExecutionContext.effect_id =
  StepReplayState.generation_id =
  durable_step_journal.stable_generation_id(run_id, durable_step_path)
```

Idea Dossier uses the same journal contract with its own stable owner path:

```text
InvocationPosition = (build_id, "research/web-search/{query_index}")
InvocationPosition -> ("web.search", canonical_input_sha256)
```

`query_index` is the persisted ordinal in the existing sequential research
plan, never an attempt count or a result id. Recovery rejects a changed query
digest at an occupied position and reads replay behavior from the bound
`web.search` metadata, not from the path prefix.

Adapt `message_tool_calls`, `chat_run_events`, and the existing durable step
journal; do not add a parallel generic invocation ledger. Before execution,
persist the stable generation/effect id, lock/admit the position, and reserve
limits. A completed position returns its stored terminal result. The same
position with a different id or input digest defects before dispatch. Provider
call id, provider name, tool id, attempt, and worker are never effect identity.
A binding derives stable child ids only from `(effect_id, component_key)`. A
write position is fenced by the current worker lease and existing
single-mutation/Undo owners.

This replay identity applies only to newly admitted executable positions.
Terminal pre-cutover audit rows with null tool-profile state never enter replay
admission and may retain the explicitly nullable historical fields in §10.

For Nexus database writes, the domain mutation, tool row, strict result event,
and journal completion remain one transaction exactly as today; there is no
post-commit result gap. Persist that terminal response before the next provider
dispatch. A genuinely external future Write must declare its idempotency or
reconciliation strategy before it can bind. Reads and Web results are memoized
after journal completion and are never recomputed. An incomplete local read may
redispatch under the same frozen input/admission and must return evidence for
the snapshot it actually observed; an uncertain Web search may not redispatch.
Provider continuation artifacts remain opaque and provider-owned.

Every Brave-backed `web.search` dispatch is `BilledOnce`, including Idea
Dossier research. The host marks the position uncertain before dispatch. It
may dispatch only after first obtaining durable `ProveNotDispatched`; once the
provider boundary may have been crossed, that resolution is no longer valid.
Recovery of an uncertain position with stored `BilledOnce` metadata suspends
and performs zero automatic Brave redispatch rather than synthesizing a
model-visible failure. An explicit operator reconciliation may terminalize
independent evidence but may never silently issue a second paid request. Local
Nexus reads are `ReDispatchable`.
A Nexus database write is `ReDispatchable` only because its domain mutation,
tool row, strict result event, and journal completion commit atomically;
otherwise the binding declares `BilledOnce` or runtime rejects dispatch.
Composition validates that every Write declares this policy metadata; the
domain-owner proof, not catalogue introspection, establishes transaction
atomicity. Delete all tool-name and durable-step-prefix replay classifiers only
after Chat and Dossier uncertain-dispatch proofs are sensitive.

`tool_contract_revision` changes for one tool's semantic id, semantic schemas,
errors, effect, or limits. Search kind/format/role enum membership is semantic;
enum order is not. Scope labels, generated hints, descriptions, examples,
activity labels, and prompt help change `documentation_revision` only. Admitted
scope schemes and resource-capability policy are canonical binding-policy
inputs. Nexus computes `policy_revision` from an explicit policy epoch plus
those inputs, replay policy, authorization, relation filtering, semantic owner,
and result policy; it never relies on a remembered hand bump alone.
`profile_revision` changes for run limits, grants, effective limits, or a
granted tool/binding-policy revision. `plan_revision` additionally changes with
exposure.

The existing prepared provider-intent state freezes the exact presentation
schema and descriptions before first provider dispatch. An admitted but not yet
prepared run may take the current documentation; once its provider intent is
persisted, presentation never changes. Tool, binding, profile, and plan
revisions participate in admission/replay as applicable. Documentation-only
deployments do not drain runs because they change neither authority nor an
already prepared intent.

A contract revision rollover stops admission of affected new work, drains or
domain-cancels affected nonterminal tool-bearing work, migrates, and then starts
the new code. Binding-policy changes use the same path. Documentation-only edits
do not drain work.

## 9. Deferred remote transport

Nexus v1 ships no MCP endpoint, transport projection, remote principal,
access-token schema/CLI, SDK dependency, client configuration, or canary.
Remote Nexus tool access requires a separate product/security cutover after one
named deployed consumer owns its end-to-end behavior and Native/HostTable
adoption is proven.

## 10. Hard-cut migration

The deployment gate stops Chat and Idea-Dossier admission and refuses the data
migration before mutation while any Chat run or Idea-Dossier research build is
nonterminal. Other background jobs are unaffected because they do not decode
the replaced tool/profile state.

Rewrite only these executable ids:

| Old id | Canonical id |
|---|---|
| `app_search` | `nexus.search` |
| `web_search` | `web.search` |
| `read_resource` | `nexus.resource.read` |
| `inspect_resource` | `nexus.resource.inspect` |
| `add_to_library` | `nexus.library.add` |
| `jot_note` | `nexus.note.create` |
| `create_highlight` | `nexus.highlight.create` |
| `mint_edge` | `nexus.edge.create` |
| `queue_add` | `nexus.queue.add` |

Migration rules:

1. Keep `chat_runs.profile_id` as the LLM/model snapshot. Add nullable
   `tool_profile_id`, `tool_profile_revision`, and strict
   `tool_profile_snapshot`. Refuse nonterminal old runs; terminal old runs keep
   these fields null and are never executable. New admission requires and
   persists all three atomically before enqueue. Journal the Idea research
   complete HostTable plan snapshot from §6 before its first Web-search
   position; a grant alone is insufficient for `ExecutionContext`.
2. Rename `message_tool_calls.tool_name` to nullable `canonical_tool_id`; add
   required `record_kind`, nullable `provider_wire_name`, `canonical_input_sha256`,
   `tool_contract_revision`, and `binding_policy_revision`. Rename `query_hash`
   to audit-only `search_query_fingerprint`; it never participates in replay.
   Rename affected constraints/indexes. The migration and application decoder
   accept exactly four tagged variants. Following `docs/rules/database.md`, the
   database owns only primitive storage types, column nullability, and true
   relational identity; it adds no enum, digest-format, conditional-nullability,
   or union-branch `CHECK`. The narrow application `RecordKind` type,
   constructors, and decoder own the closed kind set, 64-character lower-case
   digest validation, and every cross-field invariant:

   - **`current_execution`:** a mapped canonical id; `provider_wire_name` is
     null; full canonical-input digest and current revisions are required. Only
     this variant can be created by the post-cutover execution writer or enter
     replay. A bounded malformed/non-object/schema-invalid argument to a known
     tool still uses this variant: the library's tagged raw-input envelope is
     digested before `InvalidInput` terminalizes.
   - **`historical_execution`:** one of the nine mapped old ids, no provider
     wire name, reviewed historical revisions, and an optional digest. It is
     terminal audit state with no replay authority.
   - **`rejected_provider_call`:** `canonical_tool_id` is null; preserve the
     original 1–128-character name—the existing storage bound—in
     `provider_wire_name`; require exact
     `scope='provider_tool'`, `status='error'`, and
     `error_code='unknown_tool'`; revisions and replay authority are absent.
   - **`attached_context`:** both identities are null; preserve the exact
     synthetic `attached_resources` / `attached_context`, index-zero, complete
     row meaning; revisions and replay authority are absent.

   For a terminal historical executed row, backfill the digest only from one
   exact matching valid typed `tool_call_done` input. Leave it null when no such
   event survives; refuse ambiguous or contradictory matches and every row
   outside the four variants. Never derive the full digest from
   `search_query_fingerprint`.
   `chat_run_tools.py` owns the only post-cutover row constructors; execution
   can emit only `current_execution`, provider-call rejection only
   `rejected_provider_call`, and context attachment only `attached_context`.
   `historical_execution` is migration-only. Raw rows always pass the tagged
   decoder before any replay, API, trust, citation, or Undo consumer observes
   them.
3. Migrate typed `chat_run_events` tool-call/result payloads to the same closed
   tagged union. Current/historical execution gets `canonical_tool_id`; a
   rejected call gets only `provider_wire_name`; attached context remains
   synthetic. Add reviewed
   server-derived `effect`, `result_kind`, and `activity_label` using §5's exact
   known/rejected/attached mapping, and assert semantic equality for every
   pre-existing other key. The presentation may render a bounded rejected name
   but never classifies or dispatches by it. Provider request/continuation
   payloads and opaque audit facts are unchanged.
4. Preflight and migrate every Nexus-decoded durable-step request/result field
   containing an executable tool id, including `ToolStepRequest.tool_name`,
   `ToolStepResult.tool_name`, and its owning fingerprint. Provider request/
   continuation blobs remain opaque. No decodable journal JSON may retain an
   old executable id or require a legacy decoder.
5. Change only exact `message_retrievals.scope='read_resource'` to the
   domain-owned retrieval channel `resource_read`. `scope='assistant_write'`,
   `attached_context`, resource scopes, and all other domain vocabulary remain.
6. Rename the complete active typed projection through conversation schemas,
   event emitter/store, SSE response/reducer, citation/context/trust/failure
   readers, testkit, and UI. `provider_wire_name` is protocol audit evidence
   only, never dispatch or replay identity. Delete the unused `context_types`
   projection if its red test confirms it has no consumer; do not preserve it
   under new labels.
7. Preserve completed edge result refs, reverted state, trust history, and Undo;
   `nexus.edge.create` remains executable with the same domain semantics. No
   historical old-id decoder exists because no nonterminal old work survives.

The generated browser artifact owns one `tool_projection_revision` over only
the same-system Chat event/result/trust/Undo wire shape: field names and closed
`effect`/`result_kind`/error enums. It excludes provider declarations,
descriptions, search vocabulary, profile revisions, and binding policy. The
browser bundle—never the BFF—originates this revision as
`X-Nexus-Tool-Projection` on every request that creates, returns, mutates, or
streams that shape: initial send; run list/detail/reconcile/cancel; message
history; rerun/regenerate; Undo; candidate admission; and direct fetch-based
SSE attachment. The BFF allowlists and forwards it unchanged;
`StreamCORSMiddleware` allows it in preflight.

FastAPI validates the header before creating or mutating a row, returning a
projection-bearing response, or attaching a stream. Missing or mismatched
revisions return the one closed `reload_required` outcome; never dual-emit old
and new fields or let the BFF make an old browser appear current. Existing
browser sessions must reload across the cut. The pre-cutover bundle cannot
interpret this new outcome, so v1 makes no automatic old-tab recovery claim:
during maintenance the one operator closes every Nexus tab and attests that
step before the new frontend is promoted. A missed old tab fails closed on its
missing header; a current bundle with a stale revision renders the reload
outcome.

Delete, with no aliases or fallbacks:

- `_chat_tool_specs`, `ASSISTANT_WRITE_TOOL_DEFINITIONS`, all tool-name/
  definition constants, and manual argument/name dispatch in `chat_runs.py` and
  `writes.py`;
- name-based replay policy, prompt branches, frontend name sets, XML result
  renderers, and duplicated `_xml_attr` helpers;
- `ASSISTANT_WRITE_TOOLS_ENABLED` / `assistant_write_tools_enabled` and its dead
  branch;
- `web_search_tool` imports, dependency/lock entry, stale commands, fixtures,
  and active docs;
- old ids in live code and supported data. Historical cutover prose remains
  historical.

Do not delete Browse, accepted-source ingest, domain search/read/write services,
or background-job algorithms.

## 11. Non-overlapping implementation lanes

Land the upstream library first and freeze its commit. N0 is one test-control
owner with two temporal phases: N0a adds routing; N0d later refreshes only the
frozen ownership digest after each R0 handoff. E0 lands as one independent
security prerequisite. N1–N4 comprise the one atomic Nexus tool cutover. R0 is
the sole registry checkpoint owner, not a behavior implementer. Lane ownership
is sequential unless the table makes a disjoint prerequisite explicit; no lane
creates deployable dual paths.

| Lane | Exclusive files/owner | Depends on | Exit proof |
|---|---|---|---|
| N0a routing setup | pin/lock plus `Capability.LLM_TOOLS` and `Capability.INGEST_NODE`; workflow ownership, direct-path routing, runners/materializers, doctor, CI, policy projections, controller tests, proof-owner table in `docs/local-rules/testing-standards.md`, and only `llm-tools-developer-head-bypass`'s fault object/patch/hash | final library/provider integration commits | exact LLM package paths route to their own `full` capability, never `PROVIDER_RUNTIME`; the Node prerequisite proof routes through its deterministic owned capability |
| R0 proof registry | only this cutover's exact risk/journey objects and source globs in `testdata/proofs.json`; no test, product, fault, digest, or controller code | each behavior owner first supplies the exact target proof with a recorded meaningful red | registry validation and N0d digest checkpoint after each handoff; final ownership digest after N3 |
| N0d digest checkpoint | only `PRIORITY_RISK_OWNERSHIP_SHA256` and its existing policy self-test; this is a repeatable N0 governance phase, not a parallel behavior lane | each R0 handoff | exact independently recomputed digest and policy proof before that behavior lane proceeds to green |
| E0 accepted-URL egress | `.dockerignore`, `node/ingest/**`, `python/nexus/services/{node_ingest,web_article_ingest}.py`, `docker/Dockerfile.backend`, `deploy/env/env-prod-worker.example`, `deploy/hetzner/{release.py,sync-env.sh}`, `python/tests/release_artifact/test_node_ingest_image_binding.py`, and only `accepted-url-private-redirect-bypass`'s fault-manifest object/patch/hash | N0a, then its red → R0 → N0d | exact Node connection-seam proof, worker/image binding proof, and representative fault are green at a separately recorded SHA |
| N1 local declarations | `tool_runtime/{declarations,profiles}.py`; `python/scripts/generate_tool_contract_projection.py`; the generated `apps/web/src/lib/conversations/toolContractProjection.ts`; declaration/schema/documentation-revision proofs; migration of `python/tests/kernel/test_agent_tool_surface.py` | N0a, then its red → R0 → N0d | exact declarations and profile definitions, closed errors/effects/limits, semantic-vs-presentation revision, and byte-identical browser projection; no bound family, provider lowering, or final profile revision is claimed |
| N2 durable/public shape | `db/models.py`, migration; `chat_run_tools.py`, event store/response, `chat_failure.py`, candidates, citations/context/trust readers, conversation schemas, `errors.py`, projection-bearing `api/routes/{chat_runs,stream,messages,conversations,conversation_branches}.py`, `middleware/stream_cors.py`, migration/projection testkit; BFF routes, `lib/api/{client.ts,proxy.ts,sse-client.ts,useGenerationRun.ts}`, Chat send/tail consumers, reducers, and UI | N1 frozen contract, then its red → R0 → N0d | historical migration plus backend/browser projection-header proofs |
| N3 execution/adoption | `tool_runtime/{bindings,execution,composition}.py`, final bound-catalogue/profile proof, `agent_tools/**`, `chat_runs.py`, `chat_run_steps.py`, Chat prompt, `config.py`, `app.py`, `tasks/{artifacts,chat_run}.py`, Dossier/Browse/resource-graph consumers, every `web_search_tool` importer, named fixtures/safety proofs/faults below, and final existing Chat journey execution | N1–N2, exact E0 SHA/proof, then its red → R0 → N0d | bound family/catalogue/profile revisions and every-engine definition-byte ceiling; reads, writes, keyless boot, Chat/Dossier replay, consumers, trust/Undo, safety eval, and existing Chat journey |
| N4 residue/docs/release | active architecture/module docs except the N0a-owned testing standard, one-time residue audit, confidence/full/release ledger; no behavior, proof-definition, registry, or fault edits | N1–N3 and final R0/N0d checkpoint | final gates and exact release evidence |

N2 owns the complete final-shape rewrite of `chat_run_tools.py`; N3 consumes its
API and may not reopen the file. `chat_failure.py` classifies a write attempt by
migrated structural facts (`scope='assistant_write'` or event `effect='Write'`),
never another tool-name set. N3 deletes the write kill switch from `config.py`
with no replacement flag. No tool-runtime lane edits `app_search_scope` owners
or `node/ingest/**`; E0 lands separately first. N3 alone constructs the bound
families and final catalogue/profile/plan revisions after N1 declarations and
N3 bindings both exist.

N2's frontend boundary includes every projection-bearing Chat BFF route:
`apps/web/src/app/api/chat-runs/route.ts`,
`apps/web/src/app/api/chat-runs/[runId]/route.ts`, the sibling `cancel/route.ts`,
`apps/web/src/app/api/conversations/[id]/messages/route.ts`, the sibling
`tree/route.ts` and `active-path/route.ts`, both
`apps/web/src/app/api/messages/[messageId]/{rerun,regenerate}/route.ts`, and
`apps/web/src/app/api/conversations/[id]/tool-calls/[toolCallId]/undo/route.ts`.
It also owns
`apps/web/src/lib/api/{client.ts,proxy.ts,sse-client.ts,useGenerationRun.ts}` and
`apps/web/src/components/chat/ChatComposer.tsx`, `useConversation.ts`, and
`useChatRunTail.ts` with their focused proofs. The generated revision artifact
comes from N1; N2 consumes it and must not synthesize another revision.

Tests live with the lane that owns behavior. The mandatory cycle is: behavior
owner writes the exact target and records meaningful red; R0 registers the
frozen id/source globs/risk or journey mapping; N0d refreshes only the ownership
digest and proves policy; the behavior owner proceeds to green/sensitivity.
Repeat for E0, N1, N2, and N3, then take one final R0/N0d checkpoint. Only R0
ever edits `testdata/proofs.json`; only N0d edits the matching digest. E0 owns its one named
fault object/patch/hash. N2 owns the new
`llm-tools-cutover-migration-bypass` and
`llm-tool-projection-gate-bypass` objects/patches/hashes. N3 owns
`llm-write-tool-authorization-bypass`,
`llm-tool-safety-prompt-bypass`, `web-search-provider-identity-bypass`,
`llm-tools-legacy-browse-owner-bypass`,
`nexus-tool-profile-scope-bypass`, `llm-tool-position-replay-bypass`,
`llm-tool-prepared-documentation-freeze-bypass`,
`nexus-tool-declaration-effect-bypass`,
`nexus-read-empty-admission-scope-bypass`,
`dossier-uncertain-search-redispatch-bypass`, and the required adaptation of
`durable-job-fence-bypass`, each at fault-manifest object granularity. N4 never
edits either registry or a fault patch. Any implementation discovery that
changes a frozen proof id/source glob reopens R0 and invalidates all later
evidence; any later proof/fault content change requires `prove` again at the
final SHA.

N3 explicitly migrates `python/tests/testkit/openai_embedding_server.py`,
`python/tests/kernel/test_llm_product_intent.py`,
`python/tests/service/test_tool_authorization.py`,
`python/tests/service/test_web_search_identity.py`,
`python/tests/evals/cases/tool_safety.v3.json`, the safety service/eval/hosted
owners, and their named faults before deleting a legacy definition or handler.

## 12. Red / green / refactor and 80/20 proof

Use existing risks: `llm-tool-safety`, `auth-privacy-secrets`,
`citation-provenance-identity`, `costly-effects`, `durable-job-replay`,
`migration-compatibility`, and `production-release-test-control`. Add no parallel
risk portfolio.

R0 unions these literal source-glob additions into the named existing risk
object and adds each exact proof once. This is the JSON-ready routing map; one
proof has exactly one priority-risk owner. Existing unrelated entries remain.

| Exact proof id | One existing risk | Literal source-glob additions | Capability |
|---|---|---|---|
| `pytest:python/tests/llm_tools_contract/test_pinned_llm_tools.py::test_exact_pins_round_trip_one_canonical_native_tool` | `production-release-test-control` | `python/pyproject.toml`; `python/uv.lock`; `python/nexus_test_control/**/*.py`; `python/tests/llm_tools_contract/**/*.py` | `LLM_TOOLS` |
| `pytest:python/tests/kernel/nexus_test_control/test_llm_tools_capability.py::test_llm_tools_paths_route_to_exact_full_materialization` | `production-release-test-control` | `python/nexus_test_control/**/*.py`; `python/tests/kernel/nexus_test_control/test_llm_tools_capability.py`; `docs/local-rules/testing-standards.md` | `kernel-python` |
| `node-test:node/ingest/test/accepted_url_egress.test.mjs` | `auth-privacy-secrets` | `node/ingest/**/*`; `python/nexus/services/node_ingest.py`; `python/nexus/services/web_article_ingest.py` | `INGEST_NODE` |
| `pytest:python/tests/release_artifact/test_node_ingest_image_binding.py::test_worker_launches_only_the_image_baked_hardened_ingest_entrypoint` | `production-release-test-control` | `.dockerignore`; `python/nexus/services/node_ingest.py`; `docker/Dockerfile.backend`; `deploy/env/env-prod-worker.example`; `deploy/hetzner/release.py`; `deploy/hetzner/sync-env.sh`; `python/tests/release_artifact/test_node_ingest_image_binding.py` | `release-artifact` |
| `pytest:python/tests/kernel/test_llm_tool_declarations.py::test_nexus_declarations_and_browser_projection_are_one_closed_semantic_contract` | `llm-tool-safety` | `python/nexus/services/tool_runtime/declarations.py`; `python/nexus/services/tool_runtime/profiles.py`; `python/scripts/generate_tool_contract_projection.py`; `apps/web/src/lib/conversations/toolContractProjection.ts`; `python/tests/kernel/test_llm_tool_declarations.py` | `kernel-python` |
| `pytest:python/tests/kernel/test_llm_tool_profiles.py::test_bound_families_compile_exact_closed_operation_profiles_without_fallback` | `costly-effects` | `python/nexus/services/tool_runtime/*.py`; `python/tests/kernel/test_llm_tool_profiles.py`; `python/tests/kernel/test_agent_tool_surface.py` | `kernel-python` |
| `pytest:python/tests/kernel/test_llm_product_intent.py::test_product_intent_freezes_tool_documentation_at_first_prepare` | `costly-effects` | `python/nexus/services/llm_intent_state.py`; `python/nexus/services/chat_runs.py`; `python/tests/kernel/test_llm_product_intent.py` | `kernel-python` |
| `pytest:python/tests/service/test_llm_tools_reads.py::test_nexus_reads_are_scoped_citable_and_closed` | `auth-privacy-secrets` | `python/nexus/services/tool_runtime/bindings.py`; `python/nexus/services/tool_runtime/execution.py`; `python/tests/service/test_llm_tools_reads.py` | `service` |
| `pytest:python/tests/service/test_llm_tool_safety.py::test_all_mutating_tools_enforce_owner_persistence_and_idempotent_undo` | `llm-tool-safety` | `python/nexus/services/tool_runtime/*.py`; `python/nexus/services/agent_tools/writes.py`; `python/nexus/services/chat_run_tools.py`; `python/nexus/services/message_trust_trails.py`; `python/tests/service/test_llm_tool_safety.py` | `service` |
| `pytest:python/tests/service/test_llm_tool_replay.py::test_position_replay_settles_once_and_does_not_automatically_reissue_uncertain_billed_search` | `durable-job-replay` | `python/nexus/services/tool_runtime/*.py`; `python/nexus/services/chat_runs.py`; `python/nexus/services/chat_run_steps.py`; `python/nexus/services/durable_step_journal.py`; `python/nexus/tasks/chat_run.py`; `python/tests/service/test_llm_tool_replay.py` | `service` |
| `pytest:python/tests/migrations/test_llm_tools_cutover_migration.py::test_cutover_rewrites_only_closed_historical_variants_and_refuses_live_or_malformed_state` | `migration-compatibility` | `migrations/alembic/versions/0217_llm_tools_cutover.py`; `python/nexus/db/models.py`; `python/nexus/services/chat_run_tools.py`; `python/nexus/services/chat_run_event_store.py`; `python/nexus/services/chat_run_response.py`; `python/tests/migrations/test_llm_tools_cutover_migration.py` | `migrations` |
| `pytest:python/tests/evals/test_tool_safety_eval.py::test_injected_requests_cannot_authorize_a_foreign_mutating_tool_call` | `llm-tool-safety` | `python/nexus/services/tool_runtime/*.py`; `python/nexus/services/chat_prompt.py`; `python/tests/evals/test_tool_safety_eval.py`; `python/tests/evals/cases/tool_safety.v3.json` | `llm-eval` |
| `pytest:python/tests/hosted/nightly/test_openai_canary.py::test_pinned_openai_canary_refuses_indirect_tool_authority_inside_budget` | `llm-tool-safety` | `python/nexus/services/tool_runtime/*.py`; `python/nexus/services/chat_prompt.py`; `python/tests/hosted/nightly/test_openai_canary.py` | `hosted` |
| `pytest:python/tests/service/test_llm_tools_availability.py::test_keyless_boot_preserves_plan_and_refuses_required_web_before_dispatch` | `production-release-test-control` | `python/nexus/config.py`; `python/nexus/app.py`; `python/nexus/tasks/artifacts.py`; `python/nexus/tasks/chat_run.py`; `python/tests/service/test_llm_tools_availability.py` | `service` |
| `pytest:python/tests/service/test_web_search_identity.py::test_web_search_provider_ref_remains_telemetry_behind_one_snapshot_identity` | `citation-provenance-identity` | `python/nexus/services/tool_runtime/bindings.py`; `python/nexus/services/agent_tools/web_search.py`; `python/nexus/services/retrieval_citation.py`; `python/tests/service/test_web_search_identity.py` | `service` |
| `pytest:python/tests/service/test_llm_tools_dossier.py::test_dossier_freezes_host_plan_and_does_not_automatically_reissue_uncertain_search` | `costly-effects` | `python/nexus/services/artifacts/research.py`; `python/nexus/services/artifacts/coordination.py`; `python/nexus/services/agent_tools/web_page_read.py`; `python/nexus/tasks/artifacts.py`; `python/tests/service/test_llm_tools_dossier.py` | `service` |
| `pytest:python/tests/service/test_llm_tools_browse.py::test_browse_preserves_normalized_provider_results_after_rename` | `citation-provenance-identity` | `python/nexus/api/routes/browse.py`; `python/nexus/services/browse/brave.py`; `python/nexus/services/browse/service.py`; `python/tests/service/test_llm_tools_browse.py` | `service` |
| `pytest:python/tests/service/test_llm_tool_projection_protocol.py::test_revision_gates_every_changed_chat_projection_boundary` | `production-release-test-control` | `python/nexus/api/deps.py`; `python/nexus/api/routes/{chat_runs,stream,messages,conversations,conversation_branches}.py`; `python/nexus/middleware/stream_cors.py`; `python/nexus/schemas/conversation.py`; `python/nexus/errors.py`; `python/nexus/services/{chat_run_event_store,chat_run_response,chat_failure,chat_run_candidates,chat_run_citations,context_assembler,message_trust_trails,conversations}.py`; `python/tests/service/test_llm_tool_projection_protocol.py` | `service` |
| `vitest:apps/web/src/components/chat/toolProjectionProtocol.browser.test.tsx` | `production-release-test-control` | the nine projection-bearing BFF route files under `apps/web/src/app/api/{chat-runs,conversations,messages}`; `apps/web/src/lib/api/{client,proxy,sse-client,useGenerationRun}.ts`; `apps/web/src/lib/api/sse/events.ts`; `apps/web/src/lib/conversations/{toolContractProjection,types,messageWire,messageUpdateReducer,toolCallUndo}.ts`; `apps/web/src/components/chat/{ChatComposer,useConversation,useChatRunTail,Conversation,AssistantMessage,AssistantWriteTrail,AssistantDetails,ToolProjectionReloadNotice,toolProjectionProtocol.browser.test}.tsx` | `component` |

R0 also amends only the existing `grounded-chat-citation` journey object's
source globs with `python/nexus/services/tool_runtime/*.py`,
`apps/web/src/app/api/chat-runs/**/*`,
`apps/web/src/app/api/conversations/**/*`,
`apps/web/src/app/api/messages/**/*`, and
`apps/web/src/lib/conversations/toolContractProjection.ts`; its existing plural
journey risk tags remain valid. N0d policy validation rejects a missing path,
duplicate proof owner, unsupported prefix, capability mismatch, or stale digest.

| Ownership boundary | One primary behavioral proof |
|---|---|
| exact package/pin | `python/tests/llm_tools_contract/test_pinned_llm_tools.py::test_exact_pins_round_trip_one_canonical_native_tool`: independently materializes exact `llm-tools` and `provider-runtime` commits, imports their public APIs, performs one canonical invocation/returned-name round trip through the public adapter, and rejects developer-head substitution under `Capability.LLM_TOOLS`; it does not oracle provider-native dictionaries |
| test-control routing | `python/tests/kernel/nexus_test_control/test_llm_tools_capability.py::test_llm_tools_paths_route_to_exact_full_materialization`: the dedicated owner routes its exact path, checks doctor/materializer readiness, and defers complete execution to `full`; it never piggybacks `python/tests/contract/**` / `PROVIDER_RUNTIME` |
| local declarations/projection | `python/tests/kernel/test_llm_tool_declarations.py::test_nexus_declarations_and_browser_projection_are_one_closed_semantic_contract`: exact declaration/error/effect/limit/presentation table; descriptions and enum order do not change tool contract, semantic enum membership does; generated browser projection byte-matches; no bound publication is attempted |
| bound catalogue/profile | `python/tests/kernel/test_llm_tool_profiles.py::test_bound_families_compile_exact_closed_operation_profiles_without_fallback`: real bound family composition; exact operation/profile/plan/grant/replay/policy table, scope-policy changes binding policy, unbound publication defects, every Chat-supported engine's production-lowered eleven-tool definitions report per-tool/total bytes and stay at or below 12,288 bytes, and no fallback or Web-read grant exists |
| prepared presentation | adapt `python/tests/kernel/test_llm_product_intent.py::test_product_intent_freezes_tool_documentation_at_first_prepare`: an admitted-unprepared run takes current documentation; persisted provider intent retains exact descriptions/schema across a documentation-only deploy without changing authority revisions |
| Nexus reads/evidence | `python/tests/service/test_llm_tools_reads.py::test_nexus_reads_are_scoped_citable_and_closed`: real PostgreSQL, two users, all five read tools, canonical evidence, closed error translation, identical `ResourceUnavailable` envelopes for nonexistent and foreign ids, and only `current_execution` writer output |
| Nexus writes | adapt `python/tests/service/test_llm_tool_safety.py::test_all_mutating_tools_enforce_owner_persistence_and_idempotent_undo`: real PostgreSQL proves owner checks, eight-write cap, one `current_execution` commit, trust trail, duplicate recovery, and Undo |
| Chat replay | `python/tests/service/test_llm_tool_replay.py::test_position_replay_settles_once_and_does_not_automatically_reissue_uncertain_billed_search`: real worker/PostgreSQL plus scripted provider and the production reconciliation path; malformed known-tool input terminalizes/replays as one `current_execution`, completed read/write replay, identical effect/child ids across attempts, changed id/input rejection, stale-worker fencing, one final write, `ProveNotDispatched` only before boundary crossing, and zero automatic redispatch after uncertain Brave dispatch |
| migration | `python/tests/migrations/test_llm_tools_cutover_migration.py::test_cutover_rewrites_only_closed_historical_variants_and_refuses_live_or_malformed_state`: empty and every supported production snapshot to head; pre-mutation live-work refusal; all four `record_kind` variants; pre-0167 historical execution with null full-input digest; post-0167 unique-input backfill; unknown-provider row plus start/done/result events; attached context; ambiguous/malformed refusal; a raw malformed current row rejected by every public decoder; search filters proving query fingerprint is not replay identity; exact journal/fingerprint rewrites; other JSON/opaque facts and Undo preserved; one head |
| model/tool safety | preserve `python/tests/evals/test_tool_safety_eval.py::test_injected_requests_cannot_authorize_a_foreign_mutating_tool_call` and `python/tests/hosted/nightly/test_openai_canary.py::test_pinned_openai_canary_refuses_indirect_tool_authority_inside_budget` against canonical declarations and `ToolExecutor`; the exact write proof above covers persistence/Undo; both registered safety faults remain sensitive before legacy deletion |
| availability | `python/tests/service/test_llm_tools_availability.py::test_keyless_boot_preserves_plan_and_refuses_required_web_before_dispatch`: keyless app/worker boot, exact eleven-tool Chat publication, zero-network `ToolUnavailable`, and pre-enqueue `WebResearchNotConfigured` with no Dossier build/job |
| Web-search disclosure/provenance | adapt `python/tests/service/test_web_search_identity.py::test_web_search_provider_ref_remains_telemetry_behind_one_snapshot_identity`: owned recording provider sees only bounded query/freshness and no credentials/private-context fields; canonical evidence remains the application identity |
| Dossier research | `python/tests/service/test_llm_tools_dossier.py::test_dossier_freezes_host_plan_and_does_not_automatically_reissue_uncertain_search`: real worker/PostgreSQL proves the full frozen HostTable plan, exact `(build_id, research/web-search/{query_index})` positions, changed input rejection, the renamed `BilledOnce` search binding, production reconciliation with zero automatic Brave redispatch after uncertain dispatch, and unchanged search-ref/accepted-source/readiness replay; no model eval |
| accepted-URL egress prerequisite | `node-test:node/ingest/test/accepted_url_egress.test.mjs` covers public-to-private redirect, DNS/private/rebinding, connected destination, MIME, streaming/decompression/timeout ceilings, credential isolation, and zero private-endpoint requests; `python/tests/release_artifact/test_node_ingest_image_binding.py::test_worker_launches_only_the_image_baked_hardened_ingest_entrypoint`, routed by N0a to existing `Capability.RELEASE_ARTIFACT`, proves the candidate image/worker/public adapter reject environment substitution and execute that seam; E0's exact green SHA is release input, not evidence from `web.read` |
| Browse consumer | `python/tests/service/test_llm_tools_browse.py::test_browse_preserves_normalized_provider_results_after_rename`: public Browse request preserves normalized search results/provenance through the renamed provider |
| backend projection protocol | `python/tests/service/test_llm_tool_projection_protocol.py::test_revision_gates_every_changed_chat_projection_boundary`: real ASGI/PostgreSQL; current revision admits; stale/missing revision rejects every projection-bearing read/mutation, fresh send, rerun, regenerate, Undo, candidate creation, and stream attachment before effects or disclosure; CORS preflight admits the header |
| browser projection protocol | `apps/web/src/components/chat/toolProjectionProtocol.browser.test.tsx`: current bundle originates the revision on every projection-bearing read/mutation and direct SSE, BFF forwards unchanged, and a stale revision renders reload; missing-header behavior of the old bundle is deliberately not claimed; stub only fetch and add no journey |
| public wiring | R0 owns the existing `grounded-chat-citation` journey registry object; N3 owns, adapts, and runs `apps/web/e2e/journeys/grounded-chat-citation.journey.spec.ts` for matching projection, citation, recovery, and reload across the real browser/BFF/FastAPI/worker seam; adapt the focused trust/Undo component proof; add no journey |

Follow `testing-standards.md`: write the closest-seam target proof, record a
meaningful red, green one owner, demonstrate representative sensitivity for
critical/replacement proofs, then refactor without changing those proofs.
Before deleting `ASSISTANT_WRITE_TOOL_DEFINITIONS` or `execute_write_tool`, N3
adapts the service proof, deterministic safety eval, hosted canary, testkit, and
both sensitivity artifacts to canonical declarations and `ToolExecutor`, then
demonstrates both faults. Proof ownership lives in `testdata/proofs.json`; fault
ids, patches, hashes, and fingerprints live in
`testdata/faults/manifest.json`. Register before final green/sensitivity
evidence. Remove temporary residue greps after the cut; retain behavioral proof.

Commands are repository-owned verdicts:

```bash
./scripts/test changed <exact-proof-node-or-path>
./scripts/test prove --proof <proof-id> --against <fault-id>
./scripts/test confidence
./scripts/test pr
./scripts/test full
./scripts/test release
```

All oracle, fixture, gate, evidence-record, and prohibition rules come from the
testing standard; this spec does not create exceptions.

## 13. Rollout and recovery

1. On a disposable supported production snapshot, rehearse both recovery
   branches and verify the backup restore. Record Nexus, provider-runtime,
   final `llm-tools`, and Accepted-URL egress SHAs plus current migration head.
2. Enter maintenance. Stop every API/worker process importing the old package,
   stop new Chat and Idea-Dossier admission, and drain or domain-cancel every
   nonterminal affected operation. Verify refusal queries before migration.
3. Deploy the exact backend migration artifact and run empty/snapshot migration
   proofs against it. Record `DataMutationStarted` immediately before its first
   write.
4. Before `DataMutationStarted`, abort and restore the known-good application
   artifact. After it, roll back only to an explicitly proven same-schema
   artifact; otherwise forward-fix. Never run old code or a legacy decoder
   against rewritten rows. Prove both recovery branches.
5. Start the exact backend/workers but keep Chat and Idea research in
   maintenance. Prove readiness plus semantic Chat, Idea-Dossier, Browse,
   projection-mismatch, and recovery behavior. While maintenance remains
   active, the sole operator closes all pre-cutover tabs and records the manual
   attestation. Promote and verify the matching frontend artifact from the same
   release ledger, then load it. Reopen Chat and Idea admission separately only
   after their respective proof is green. A missed old tab fails closed;
   automatic old-tab reload is not acceptance scope.
6. Run the one-time old-id/import residue audit and record release evidence.

## 14. Acceptance criteria

1. Nexus pins exact final commits for `llm-tools` and `provider-runtime` and
   contains no executable old package/import path.
2. All ten Nexus tools are declared locally with strict semantic/presentation
   schemas, closed errors, replay policy, measured limits, and existing domain
   owners; no global `ApiErrorCode` leaks through the tool boundary.
3. Chat publishes exactly the eleven approved native tools; no `web.read`,
   discovery, PTC, fallback, or approval path exists. Keyless boot keeps that
   exact plan and fails `web.search` before dispatch. Its exact production-
   lowered definition list is at most 12,288 canonical UTF-8 JSON bytes for
   every Chat-supported engine.
4. Idea Dossier and Browse preserve shipped behavior; all other named background
   operations preserve their actual direct algorithms and limits. Required
   keyless Idea research refuses before enqueue.
5. Catalogue/profile/principal/resource admission all fail closed, and a
   profile cannot widen declaration limits.
6. Canonical ids flow through every executable call, storage, event, API/SSE,
   trust, citation, Undo, and UI path. Only the two closed non-executable audit
   variants have null canonical identity; a rejected raw provider name never
   authorizes dispatch or replay.
7. Position replay returns completed results, preserves one stable effect id,
   and never duplicates a write; stale workers are fenced, `BilledOnce` Brave
   calls never automatically redispatch from uncertainty, and the next provider dispatch
   follows persistence.
8. First-party writes retain owner checks, the eight-write cap, trust trail, and
   Undo without a suspension FSM.
9. Dossier accepts only build-owned search refs and reaches the separately
   proven hardened Node egress; it remains distinct from portable `web.read`,
   and no arbitrary-URL read enters Chat.
10. Contract, binding-policy, profile, plan, documentation, and browser
    projection revisions change only for their owned semantics. Description-only
    edits neither drain runs nor masquerade as authority changes.
11. The browser originates the exact projection revision; the BFF forwards it,
    CORS admits it, and stale/missing clients fail before any projection-bearing
    response, mutation, run creation, or stream attachment with
    `reload_required`. The current bundle renders stale-revision recovery; the
    one-user maintenance procedure closes/reloads pre-cutover tabs rather than
    claiming they understand the new outcome.
12. The migration refuses affected live work before mutation; preserves
    all four record kinds, pre-0167 null digests, rejected-provider and
    attached-context audit variants, model profile, opaque facts, and edge Undo;
    rewrites every executable identity/event/journal fingerprint; and leaves
    one head with no old decoder.
13. Replacement proofs satisfy the Nexus testing standards, demonstrate
    sensitivity in proportion to risk, and pass the intended deterministic,
    full, and protected release gates.
14. No MCP endpoint, token model, SDK dependency, CLI, transport adapter, client
    configuration, canary, duplicate registry/search/read/write service,
    background workflow, approval system, or speculative provider/runtime
    feature ships.

## 15. References

- [LLM Tools Library Hard Cutover](llm-tools-library-hard-cutover.md)
- [Nexus architecture](../architecture.md)
- [Nexus testing standards](../local-rules/testing-standards.md)
- [Operation types](../rules/operation-types.md)
- [Agent host functions](../rules/modules/agent-host-functions.md)
- [Agent runtime](../rules/modules/agent-runtime.md)
- [Provider Runtime contract](../../../llm-calling/README.md)

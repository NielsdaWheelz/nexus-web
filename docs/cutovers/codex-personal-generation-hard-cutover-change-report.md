# Codex Personal Generation Hard Cutover Change Report

**Status:** SOURCE VERIFICATION IN PROGRESS; PRODUCTION ACCEPTANCE PENDING

**Base:** `42f33dc4fc896d0e01287f68ef1d300d47440db1`

## Result

Nexus generation now has one product policy catalog, one Codex Personal UDS
execution boundary, one `llm_calls` ledger, and one scoped HTTPS MCP tool path.
The cut is atomic: no provider, API-key, compatibility, or redispatch fallback
remains for generation. Embeddings, transcription, Brave retrieval,
deterministic authors, and abstract projection remain outside the cutover.
The local controller's v4 runtime owns a distinct MCP port and one strict,
run-scoped Codex v2 UDS peer. Browser journeys therefore exercise the real
generation client, durable owner, worker, and ledger wiring while the peer
deterministically supplies only protocol-valid terminals. The controller proves
the interactive worker's exact `127.0.0.1` listener, literal mount, persisted
process identity, and grantless `401` before Chat dispatch. Synthesis commands
remain grantless and tool-free; Chat commands require the scoped bearer grant.

## One-time deletion audit

The final candidate was searched across active application, worker, host,
deployment, and image sources for the deletion manifest in the owning spec.
No active generation use remains for:

- `provider_credentials`, `ProviderRetryMode`, provider certification, provider
  continuation, token-budget billing tables/functions, generation entitlement,
  cost/attempt ledger facts, per-operation reasoning overrides, or the Fable
  retention gate;
- Anthropic, Gemini, Moonshot, or DeepSeek generation credentials/profiles;
- `reasoning_option_id`, the metadata-only `/v1/turns` surface or error family,
  `agent_turn_ledger`, `llm_intent_state`, `llm_outcomes`, or the native-agent
  client/contract/operations;
- the direct provider live fixtures, provider certification suite, metadata
  canary, OpenAI generation canary, superseded migrations/proofs/faults, and
  the metadata/provider cutover authorities.

Retained matches are intentional and bounded:

- `OPENAI_API_KEY` is embeddings-only; the Codex host explicitly rejects it.
- Old provider keys in deployment sync scripts are deletion guards that remove
  forbidden remote configuration. Browser `reasoning_option_id` fixtures are
  negative decoder tests.
- `provider-runtime` remains pinned only for embeddings and its Codex
  `AgentRuntime` extra. `llm_calls` is the unified generation ledger.
- Four historical dossier failure spellings remain readable for immutable
  domain rows and SSE replay, but are excluded from the current write enum.
- `max_output_tokens` remains only as an internal context-admission calculation,
  not caller policy or provider billing.
- Immutable database migration history may name removed columns and tables; no
  runtime or compatibility decoder does.

Repository policy, proof-ownership, fault-manifest, JSON, patch-application,
formatting, lint, and diff diagnostics report no violations.

The confidence pass also exposed a stale embeddings-only test-peer path. The
controller now owns that peer as one run-scoped semantic resource with exact
CA, key, and audit files, strict DNS/loopback TLS identity, and recoverable
PLANNED-to-CREATED cleanup. Production embedding behavior is unchanged.

The integrated browser portfolio also exposed excess import memory in the
bounded source-ingest child. DB-only media-unit lifecycle state now has one
narrow owner that can be imported by content indexing and media deletion
without preloading generation, tool, or provider runtimes. Those runtimes are
loaded only at the execution boundary that uses them; no capacity limit was
weakened.

That same red proof exposed a merge regression in the pre-existing worker
boundary: Light/Base background handlers were running inline despite the jobs
contract requiring every background handler to use a fresh bounded child. An
installed background process executor is now the sole dispatch signal for that
boundary. `Light | Heavy` remains queue-capacity policy and no longer changes
where a background handler imports or executes.

The final changed portfolio then exposed queue starvation across journeys: an
older backlog of derived media-unit synthesis could keep a newly published
source in `extracting`. The media lifecycle owner now schedules derived
`media_unit_build` work at background priority 200, behind the ordinary
priority-100 user-blocking ingest lane. Queue ordering remains centralized in
the existing durable job owner; no second scheduler or timeout concession was
introduced.

The final clean changed run exposed the same ordering defect at the scheduler
boundary: routine periodic rows shared priority 100 with newly accepted
ordinary work, so their older slot timestamps could delay a user metadata
generation behind the entire maintenance set. The registry now admits routine
periodic rows at priority 200 while preserving the stale-ingest reconciler's
explicit -1000 urgency. On every pass the scheduler locks every active row in
the kind's global periodic dedupe namespace, validates its exact aligned slot
identity, and reconciles only priority, preserving payload, availability,
attempts, lease, claimant, lifecycle, and timestamps across an upgrade or
expired-lease replay. The registry separates immutable scheduler identity from
the closed checkpoint-key sets owned by Dawn and the storage orphan sweep;
their strict codecs continue to validate checkpoint values. A propagated
`request_id` remains correlation and does not claim the periodic namespace. The
namespace lookup is global across kinds and reads at most 257 claimants;
foreign-kind ownership, a noncanonical identity, an undeclared checkpoint, or
more than 256 active rows defects the whole transaction before durable mutation.
On-demand rows sharing the kind remain untouched, and no second fairness
mechanism was introduced.

The exact integrated changed run also exposed a browser-portfolio isolation
defect: an optional `synapse_scan` left by an earlier journey could occupy the
single shared background worker while the reader-progress journey waited for
its newly published EPUB. The EPUB remained durably pending and the worker
released the interrupted Synapse claim correctly; the failure was not job loss,
scheduler drift, or an ingest-latency contract. The required formal diagnostic
replay passed while preserving the original failed verdict. The controller now
passes the existing `SYNAPSE_ENABLED=false` product setting to the browser
portfolio's API and both workers, so scenarios cannot leak unowned optional
synthesis work through their shared queue. Focused Synapse service and eval
owners remain enabled and unchanged. One exact controller contract proves the
three-process environment; no retry, test reordering, queue deletion, priority
change, or timeout widening was introduced.

## Verification

The 80/20 proof shape is one dominant proof per ownership boundary and sixteen
representative sensitivity faults, followed serially by
`./scripts/test changed --base 42f33dc4fc896d0e01287f68ef1d300d47440db1`,
`./scripts/test confidence --base 42f33dc4fc896d0e01287f68ef1d300d47440db1`,
`NEXUS_TEST_BASE_SHA=42f33dc4fc896d0e01287f68ef1d300d47440db1 ./scripts/test pr`,
`./scripts/test full`, `./scripts/test release`, the ordinary
`./scripts/test nightly`, and finally the protected `codex-nightly` lane. Final
clean-SHA receipts are recorded here after the source candidate is committed.

| Gate | Candidate result |
|---|---|
| Focused owner proofs | pending final clean-SHA run |
| Sixteen fault red/green proofs | pending final clean-SHA run |
| `./scripts/test changed --base 42f33dc4fc896d0e01287f68ef1d300d47440db1` | pending final clean-SHA run |
| `./scripts/test confidence --base 42f33dc4fc896d0e01287f68ef1d300d47440db1` | pending final clean-SHA run |
| `NEXUS_TEST_BASE_SHA=42f33dc4fc896d0e01287f68ef1d300d47440db1 ./scripts/test pr` | pending final clean-SHA run |
| `./scripts/test full` | pending final clean-SHA run |
| `./scripts/test release` | pending final clean-SHA run |
| Ordinary `./scripts/test nightly` | pending final clean-SHA run |
| Protected four-plan `codex-nightly` | pending enrolled-runner execution |
| Same-SHA capacity and deployed-host evidence | pending deployment |

## Production boundary

Source completion does not equal production acceptance. All fourteen criteria
in the owning cutover remain mandatory in one release. The protected runner
must live-qualify the exact four model/effort pairs, and fresh capacity plus
target-host evidence must bind to the shipped SHA. No local fake substitutes
for those authorities.

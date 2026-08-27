# Codex Personal Generation Hard Cutover Change Report

**Status:** SOURCE VERIFICATION IN PROGRESS; PRODUCTION ACCEPTANCE PENDING

**Base:** `beb8877513de5323bd7f1907712607babbda8721`

## Result

Nexus generation now has one product policy catalog, one Codex Personal UDS
execution boundary, one `llm_calls` ledger, and one scoped HTTPS MCP tool path.
The cut is atomic: no provider, API-key, compatibility, or redispatch fallback
remains for generation. Embeddings, transcription, Brave retrieval,
deterministic authors, and abstract projection remain outside the cutover.
The local controller's v4 runtime owns a distinct MCP port and proves the real
interactive worker's exact `127.0.0.1` listener, literal mount, persisted
process identity, and grantless `401` before Chat dispatch.

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

## Verification

The 80/20 proof shape is one dominant proof per ownership boundary, sixteen
representative sensitivity faults, then `changed`, `confidence`, `pr`, `full`,
`release`, `nightly`, and the protected `codex-nightly` lane. Final clean-SHA
receipts are recorded here after the source candidate is committed.

| Gate | Candidate result |
|---|---|
| Focused owner proofs | pending final clean-SHA run |
| Sixteen fault red/green proofs | pending final clean-SHA run |
| `changed` / `confidence` / `pr` | pending final clean-SHA run |
| `full` / `release` / `nightly` | pending final clean-SHA run |
| Protected four-plan `codex-nightly` | pending enrolled-runner execution |
| Same-SHA capacity and deployed-host evidence | pending deployment |

## Production boundary

Source completion does not equal production acceptance. All fourteen criteria
in the owning cutover remain mandatory in one release. The protected runner
must live-qualify the exact four model/effort pairs, and fresh capacity plus
target-host evidence must bind to the shipped SHA. No local fake substitutes
for those authorities.

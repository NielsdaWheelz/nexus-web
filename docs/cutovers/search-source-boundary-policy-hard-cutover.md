# Search Source Boundary Policy Hard Cutover

**Status:** Implemented and hardened - 2026-06-21

**Type:** Hard cutover. No prompt-only enforcement, no mixed public/private
source use without an explicit user request, no hidden recovery path after a
blocked tool, no frontend-inferred source policy.

## One-Line

Move private saved-source versus public web mixing from prompt guidance to a
chat-owned runtime policy gate that classifies, allows, blocks, ledgers, and
renders every evidence-producing tool call by source domain.

## SME Thesis

A subject matter expert would treat this as an information-boundary and agent
control problem, not as a search-ranking problem.

The current prompt says not to mix private `app_search` evidence and public
`web_search` evidence unless the user explicitly asks. That is useful guidance,
but it is not enforcement. Professional retrieval systems make source domains
explicit because the risk is not only answer quality; it is privacy leakage,
prompt injection, confusing provenance, and citation laundering.

The gate belongs in chat-owned tool orchestration because chat sees the whole
turn, the model's tool-call batch, previous tool outputs in the same run,
whether public web is configured, and which evidence has already been forwarded
to the provider.

## Current State

Implemented:

- `app_search` is private saved-source retrieval.
- `read_resource` and `inspect_resource` read/map private conversation context
  or same-turn app-search-selected resources.
- `web_search` is public web retrieval and mints `external_snapshot` citation
  targets.
- `app_search` and `web_search` write separate tool-call rows, retrieval rows,
  candidate ledgers, and rerank ledgers.
- The trust trail can show the separate tools and their ledgers.
- `chat_prompt.py` warns the model not to mix domains unless explicitly asked.
- `chat_retrieval_plan.py` maps tool names to source domains and evaluates
  same-batch plus later-turn private/public evidence mixing before adapter
  execution.
- `chat_runs.py` persists blocked source-policy tool calls as typed errors with
  no retrieval rows or citation edges.
- `message_tool_calls` stores `source_domain` and `source_boundary_policy.v1`,
  and the trust trail renders policy version, decision, reason, mix state,
  domains seen, and requested domains.

Remaining audit gaps:

- Historical conversation messages are not source-domain classified for
  public-web routes. This slice treats source policy as same-run tool evidence
  policy, not a full DLP/history-redaction system.

Hardened after audit:

- `app_search` and `web_search` now require an existing chat-started tool-call
  row with an allowed source policy; adapters only complete result fields and
  never synthesize, insert, or update source policy.
- Chat-owned tool-call persistence validates `source_boundary_policy.v1`
  version, source-domain parity, decision, reason, mix flag, and evidence-domain
  arrays before writing `message_tool_calls`.
- Per `docs/rules/database.md`, DB constraints remain storage-shape only; policy
  parity/full JSON shape is an application invariant with defect checks, not a
  JSONB business-invariant constraint.
- Blocked source-policy batches persist every blocked call and typed error event
  before checking whether compact error outputs fit the continuation budget.

## Goals

1. Classify every evidence-producing chat tool by source domain.
2. Detect explicit user requests to combine saved/private sources with public
   web sources.
3. Enforce the source-domain policy before executing a tool batch.
4. Persist allowed and blocked decisions with the tool call.
5. Ensure blocked calls produce no retrieval rows, no citation edges, and no
   forwarded evidence.
6. Keep source policy in chat, not in app search, web search, read resource, or
   frontend code.
7. Render the decision in the trust trail.
8. Keep saved `web_result` rows retrieved by `app_search` in the private app
   domain; only live `web_search` is public web.

## Non-Goals

- No content moderation system.
- No enterprise data-loss-prevention layer.
- No provider-side policy dependency.
- No user-visible permission prompt for the first slice.
- No public/private policy fields on `/chat-runs` requests.
- No source-domain fields in model tool arguments.
- No migration of citation identity away from `resource_edges`.
- No attempt to classify every cited historical source on old runs beyond a
  one-time migration label for trust-trail display.

## Source Domains

Closed source-domain vocabulary:

- `private_app`: saved Nexus resources, attached context, `app_search`,
  `read_resource`, `inspect_resource`, same-turn app-search handoff, private
  long-context reads, and saved `web_result` rows found by app search.
- `public_web`: live `web_search` results and the `external_snapshot` rows
  created from that live web search in the same run.
- `provider_control`: provider/tool protocol errors and unknown-tool rows that
  do not carry evidence.

Do not infer `public_web` from URL shape. A saved web article and a live web
search result have different product semantics.

## Target Behavior

Before executing a batch of model-requested tools, chat computes:

- domains already forwarded to the provider in this run;
- source domain requested by each pending tool call;
- whether the user explicitly asked to combine saved sources with the web;
- whether the run-level planner allowed mixed-source research.

If executing the batch would mix `private_app` and `public_web` without explicit
permission, chat blocks the whole violating batch before any evidence-producing
tool runs.

Allowed examples:

- User asks "search my saved sources for X" -> private only.
- User asks "what happened today?" -> public only.
- User asks "compare my saved notes with the current web" -> mixed allowed.
- User asks "use the web to update this saved article" -> mixed allowed if the
  wording clearly asks for both the saved source and public web.

Blocked examples:

- Model calls `app_search` and `web_search` in the same batch for "what do my
  sources say about X?"
- Model calls `web_search` after private evidence was forwarded for a prompt
  that did not ask for public web.
- Model calls `read_resource` after public web evidence was forwarded for a
  prompt that only asked for current web.

Blocked calls:

- are persisted as `message_tool_calls` rows;
- have status `error`;
- use error code `source_policy_blocked`;
- have no `message_retrievals`;
- have no candidate/rerank ledgers unless a tool-specific owner already wrote
  nonevidence metadata before the policy gate, which should not happen;
- return a compact tool error to the model;
- are visible in SSE and trust trail.

## Architecture

```text
run-level retrieval plan
  -> source policy snapshot
  -> provider tool-call batch
  -> pre-execution source-domain gate
      allowed -> execute tool owner
      blocked -> persist blocked tool call, no adapter execution
  -> trust trail
```

The source gate runs before adapter execution. It must not reuse aggregate
tool-output budget checks, because budget checks happen after tool execution and
can leave persisted retrievals that must then be excluded.

## Runtime Policy

Policy inputs:

- `ChatRetrievalPlan.source_domain`
- `ChatRetrievalPlan.mixing_policy`
- current user message text
- pending model tool calls
- domains forwarded in earlier iterations of the same run
- domains in the pending batch

Policy output:

```json
{
  "version": "source_boundary_policy.v1",
  "decision": "allowed",
  "source_domain": "private_app",
  "mixing_allowed": false,
  "reason": "single_domain_private_app",
  "domains_seen": [],
  "requested_domains": ["private_app"]
}
```

Blocked output:

```json
{
  "version": "source_boundary_policy.v1",
  "decision": "blocked",
  "source_domain": "public_web",
  "mixing_allowed": false,
  "reason": "would_mix_private_app_with_public_web",
  "domains_seen": ["private_app"],
  "requested_domains": ["public_web"]
}
```

## Persistence

Add source policy to `message_tool_calls`, not to retrieval rows.

Preferred shape:

- `source_domain TEXT NOT NULL`
- `source_policy JSONB NOT NULL`

The JSONB object is tightly shaped by chat read/write helpers and trust-trail
schemas. It is not a generic debug bag.

One-time migration:

- `app_search`, `read_resource`, and `inspect_resource` -> `private_app`
- `web_search` -> `public_web`
- unknown/provider rows -> `provider_control`
- historical policy decision -> `historical_pre_cutover`

After cutover, every new tool call must write a `source_boundary_policy.v1`
object.

## Tool Domain Mapping

| Tool | Domain | Notes |
|---|---|---|
| `app_search` | `private_app` | includes saved `web_result` rows |
| `read_resource` | `private_app` | current tool reads Nexus context only |
| `inspect_resource` | `private_app` | maps Nexus media only |
| private long-context read | `private_app` | synthetic read inherits app-search domain |
| `web_search` | `public_web` | live public web only |
| unknown tool | `provider_control` | no evidence domain |

If a future public fetch/open-page tool is added, it must enter this mapping in
the same cutover that adds the tool.

## API Design

No public API request changes.

SSE/tool-trust read models may add:

```json
{
  "source_domain": "private_app",
  "source_policy": {
    "version": "source_boundary_policy.v1",
    "decision": "allowed",
    "reason": "single_domain_private_app"
  }
}
```

Frontend code must render backend policy state. It must not infer policy from
tool name, scope string, result type, or URL.

## Capability Contract

This cutover does not change resource capabilities.

Resource capabilities still answer:

- can this `ResourceRef` be attached?
- can it be read?
- can it be searched as a scope?
- can it be cited?
- can it seed graph expansion?

Source-boundary policy answers a different question:

- can this chat run combine these evidence domains in this turn?

Do not add source-domain booleans to `ResourceItemCapability` unless a future
resource scheme genuinely spans private/public trust levels.

## Explicit Mix Detection

First implementation uses deterministic text classification. The classifier
should be narrow and fail closed:

Allow mixed domains when the current user text contains both a saved-source
intent and a web/current/outside-source intent, such as:

- "compare my saved sources with the web"
- "check this against current web sources"
- "use my notes and current public sources"
- "what do my sources say, and what does the web say now?"

Do not allow mixed domains for generic words like "research", "look up", or
"find" unless the user names both domains.

A model-based classifier is out of scope until fixtures exist.

## Acceptance Criteria

- Every new tool call has `source_domain` and `source_boundary_policy.v1`.
- A same-batch `app_search` + `web_search` request is blocked before either
  adapter executes when the user did not explicitly ask for mixed research.
- A later `web_search` after forwarded private evidence is blocked unless mixed
  research is explicit.
- A later private read after forwarded public evidence is blocked unless mixed
  research is explicit.
- Explicit saved-source/web comparison allows both domains and ledgers the
  reason.
- Blocked calls write no retrieval rows and no citation edges.
- Trust trail displays allowed/blocked source policy state.
- Existing app-search, web-search, read-resource, long-context, budget, and
  citation tests continue to pass.

## Negative Gates

- No prompt-only source-boundary enforcement.
- No policy decision in frontend-only code.
- No source-domain tool arguments.
- No direct provider/web calls from app-search or read-resource.
- No app-search downgrade from public web to private saved web result based on
  URL.
- No hidden deterministic "just choose one domain" fallback after a mixed batch.

## Files

Likely backend files:

- `python/nexus/services/chat_runs.py`
- `python/nexus/services/chat_retrieval_plan.py`
- `python/nexus/services/chat_prompt.py`
- `python/nexus/services/message_trust_trails.py`
- `python/nexus/services/agent_tools/web_search.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/db/models.py`
- one Alembic migration for `message_tool_calls` source policy

Likely frontend files:

- `apps/web/src/lib/api/sse/events.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/components/chat/AssistantTrustInspector.tsx`
- `apps/web/src/components/chat/AssistantMessage.tsx`

Likely tests:

- `python/tests/test_source_boundary_policy.py`
- `python/tests/test_openai_reasoning_contracts.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_web_search_route.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_cutover_negative_gates.py`
- `apps/web/src/lib/api/sse/events.test.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.test.tsx`

## Composition With Other Systems

- Run-level planner supplies the expected domain and mixing policy.
- App search and web search keep separate adapter implementations and ledgers.
- Resource graph still owns citations and `external_snapshot` resource identity.
- Trust trail becomes the source of UI display; frontend does not infer policy.
- Learned reranking stays inside private app search unless a future public
  reranker explicitly crosses domains under this policy.

## Research Notes

OWASP's LLM Top 10 highlights sensitive information disclosure and excessive
agency as core LLM application risks. For Nexus, the production lesson is to
limit the agent's evidence domains and tool autonomy at runtime, not only in
prompt prose:

- `https://genai.owasp.org/llm-top-10/`
- `https://owasp.org/www-project-top-10-for-large-language-model-applications/`

## Verification

Focused first implementation gates:

```bash
cd python && NEXUS_ENV=test uv run pytest -q tests/test_source_boundary_policy.py
./scripts/with_test_services.sh bash -lc 'make _test-back-db-ready >/dev/null && cd python && NEXUS_ENV=test uv run pytest -q tests/test_openai_reasoning_contracts.py tests/test_chat_runs.py tests/test_agent_app_search.py tests/test_web_search_route.py tests/test_cutover_negative_gates.py'
cd apps/web && bun run test:unit -- src/lib/api/sse/events.test.ts
cd apps/web && bun run test:browser -- src/components/chat/useChatMessageUpdates.test.tsx src/components/chat/AssistantMessage.test.tsx
```

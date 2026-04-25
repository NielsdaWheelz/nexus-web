# Agent Web Search Tool

This is the hard-cutover implementation spec for letting chat search the public
web for current or external information.

There is no legacy mode, compatibility adapter, duplicate web-search stack, or
old chat request shape after this work lands. The final product has one
provider-neutral web-search tool contract, one persistence model, one stream
protocol, and one citation model.

## Problem

The assistant can currently answer from model knowledge, user-attached Nexus
context, and conversation history. It cannot reliably look up fresh public web
information, verify current facts, or cite external sources unless the user
manually supplies that context.

Provider-native web search exists, but using each model vendor's built-in web
tool as the primary product architecture would make search behavior,
observability, cost control, and citations depend on the selected LLM provider.

The target behavior is that Nexus owns a typed `web_search` tool, backed first
by Brave Search API, with citations persisted and rendered consistently across
streaming and non-streaming chat.

## Goals

- Give the assistant a read-only `web_search` tool for public web information.
- Make search available from normal chat without exposing arbitrary HTTP fetch
  or browser control to the model.
- Use a provider-neutral internal contract so OpenAI, Anthropic, Gemini, and
  other adapters can share the same orchestration semantics.
- Use Brave Search API as the first production provider because it is a real
  search API, has its own web index, exposes result URLs/snippets/metadata, has
  AI-oriented search features, and has predictable pricing.
- Keep web-search business logic in FastAPI services. Next.js BFF routes remain
  transport-only.
- Persist tool calls, selected results, citations, provider request IDs,
  latency, status, and cost-relevant metadata.
- Render visible, clickable citations for every answer that relies on web
  results.
- Enforce query, result, domain, timeout, retry, token, and cost budgets in
  deterministic backend code.
- Treat web results as untrusted text. Web pages cannot issue instructions to
  the assistant.
- Keep the architecture ready for later Exa, Tavily, Google, or vendor-native
  provider adapters without shipping a multi-provider fallback in the first
  cut.

## Non-Goals

- No SERP scraping provider as the canonical production backend.
- No SearXNG/public-instance dependency for customer-facing production search.
- No Playwright/Puppeteer browsing, crawler, or arbitrary URL fetch in the
  first cut.
- No OpenAI, Anthropic, Gemini, or Azure built-in web search as the canonical
  search backend.
- No MCP server as the internal implementation path.
- No write tools, form submission, account login, purchasing, posting,
  crawling, indexing, or site mutation.
- No hidden fallback where the assistant invents web citations if search fails.
- No backwards-compatible chat request schema for clients that omit the new web
  search mode.
- No feature flag that preserves the old no-web-search chat behavior in the new
  send path.
- No raw provider response bags stored as the durable product contract.

## Target Behavior

The chat composer exposes web search as a first-class mode:

```text
web_search.mode = off | auto | required
```

Rules:

- `off`: the assistant must not search the public web.
- `auto`: the assistant may search when the user asks for current, external,
  comparative, legal, pricing, release, event, factual verification, or
  source-backed information.
- `required`: the assistant must run at least one search before final answer,
  or return a controlled "search unavailable" response.

Examples that should search in `auto` or `required`:

- "What's the latest pricing for Brave Search API?"
- "Does Anthropic support web search in the API?"
- "Compare Tavily and Exa for agent search."
- "Find recent user feedback about SearXNG for AI agents."
- "Verify the current CEO of this company."
- "What changed in the latest OpenAI web search docs?"

Examples that should not search in `auto`:

- "Rewrite this paragraph."
- "Explain this code I pasted."
- "Summarize the attached article."
- "Search my saved Nexus library." That is `app_search`, not `web_search`.

Answers using web results must include citations. Citations must be visible and
clickable in the final rendered chat message. The assistant must not cite a URL
unless the backend received that URL from the web-search provider or a later
approved context extraction step.

If search is unavailable, over budget, rate limited, or returns no useful
results, the assistant says that directly. It may still answer from model
knowledge only when the user did not require search and the answer clearly
separates model knowledge from searched evidence.

The stream shows compact tool activity:

- web search started
- search query summary
- provider/result count
- selected citations
- final answer deltas

The model never receives API keys, raw provider payloads, hidden billing
metadata, unbounded page text, or instructions from web content as instructions.

## Final State

### Request Contract

`SendMessageRequest` is cut over to require an explicit web-search object:

```text
{
  content,
  model_id,
  reasoning,
  key_mode,
  contexts,
  web_search: {
    mode,
    freshness_days,
    allowed_domains,
    blocked_domains
  }
}
```

Required fields:

- `mode`: `off`, `auto`, or `required`.

Optional fields:

- `freshness_days`: positive integer or null.
- `allowed_domains`: list of normalized registrable domains.
- `blocked_domains`: list of normalized registrable domains.

Hard-cutover rule: requests without `web_search.mode` are invalid.

### Tool Contract

The canonical model-facing tool is:

```text
web_search(query, freshness_days, allowed_domains, blocked_domains, result_type, limit)
```

Parameters:

- `query`: natural-language search query, 2 or more non-whitespace characters.
- `freshness_days`: optional freshness bound enforced by backend policy.
- `allowed_domains`: optional allowlist, limited by backend policy.
- `blocked_domains`: optional denylist, limited by backend policy.
- `result_type`: `web`, `news`, or `mixed`.
- `limit`: 1 to 10 for model-facing calls.

Backend-owned policy, not model input:

- country
- language
- safe-search level
- max tool calls
- max provider requests
- timeout
- retry schedule
- total result budget
- total context character budget
- per-message cost budget

Result item shape:

```text
{
  result_ref,
  title,
  url,
  display_url,
  snippet,
  extra_snippets,
  published_at,
  source_name,
  rank,
  provider,
  provider_request_id
}
```

Rules:

- `result_ref` is an opaque typed backend reference.
- `url` is normalized and validated before model exposure.
- `snippet` and `extra_snippets` are treated as quoted source text, not
  instructions.
- Result ordering is deterministic for equal provider rank.
- No raw provider response becomes part of the stable internal API.

### Context Contract

Search finds candidates. Backend context assembly renders bounded source
blocks.

The assistant tool loop uses an internal backend operation:

```text
fetch_web_context(result_refs)
```

This operation is not a public API in the first cut. It renders quote-safe
source blocks from selected search results.

First cut context sources:

- Brave Web Search result title, URL, description, age, profile metadata, and
  extra snippets or LLM-context fields when available.

Later context sources, behind the same internal operation:

- Tavily Extract
- Exa Contents
- a first-party safe fetcher with SSRF protection and content sanitization

Rendered web context blocks include:

- result ref
- canonical URL
- title
- source name or hostname
- published or indexed date when available
- excerpt text
- provider
- provider request ID

### Conversation State

Web search metadata is distinct from user-attached context and app-search
retrieval.

Persisted tool-call records include:

- conversation ID
- user message ID
- assistant message ID
- tool name
- tool call index
- query hash, not raw query text by default
- requested result type
- requested freshness
- requested domain filters
- provider
- provider request ID
- latency
- result count
- selected result refs
- status
- error code

Persisted citation records include:

- assistant message ID
- citation index
- result ref
- title
- URL
- display URL
- source name
- quoted excerpt or snippet hash
- provider
- provider request ID

Raw query text is not stored in durable tables. Exact query display in the UI is
derived from ephemeral stream events or from a backend-produced short summary.

### Provider Model

Production day one has one concrete search provider:

```text
SearchProvider = BraveSearchProvider
```

The internal interface is provider-neutral:

```text
SearchProvider.search(WebSearchProviderRequest) -> WebSearchProviderResponse
```

No runtime multi-provider fallback ships in the first cut. If Brave is
unconfigured, rate limited, or unavailable, the tool returns a typed failure and
the assistant responds accordingly.

Provider-native model web search remains an optional future adapter path only
when it can satisfy the same citation, persistence, streaming, policy, and
observability contract.

## Architecture

### Layers

Browser:

- Sends `web_search.mode` with every chat request.
- Renders web-search activity, source chips, and citations.
- Does not call Brave or any other search provider directly.
- Does not execute search ranking, provider normalization, or citation logic.

Next.js BFF:

- Proxies authenticated requests to FastAPI.
- Keeps streaming token acquisition and transport behavior.
- Does not inspect, rewrite, authorize, rank, or normalize web results.

FastAPI routes:

- Validate request envelopes.
- Call send-message services.
- Return response envelopes or SSE events.

Services:

- Own tool orchestration, web provider calls, normalization, context assembly,
  persistence, budgets, retries, and error mapping.

LLM adapters:

- Translate provider-neutral tool specs and tool results into provider-specific
  request and response formats.
- Normalize provider tool-call events into internal shapes.
- Do not know Brave response semantics.

Database:

- Stores durable tool and citation records as typed relational columns plus
  constrained JSONB only where the shape is intentionally extensible.

### Runtime Flow

Non-streaming:

1. Validate `SendMessageRequest`, including `web_search.mode`.
2. Persist the user message.
3. Build a provider-neutral LLM request with the `web_search` tool when mode
   allows it.
4. The model returns either tool calls or a final answer.
5. Backend validates tool-call args.
6. Backend executes Brave search through `SearchProvider`.
7. Backend normalizes results and persists tool metadata.
8. Backend renders bounded web context and returns tool results to the model.
9. Repeat within budget.
10. Backend validates/persists final assistant answer and citations.
11. API returns conversation, messages, tool summaries, and citations.

Streaming:

1. Uses the same orchestration semantics as non-streaming.
2. SSE emits structured events for tool calls, tool results, citations, deltas,
   and done.
3. Final text still streams as `delta` events.
4. Tool state, citations, and final answer persist even if the browser
   disconnects.

Transport does not own the lifecycle of web-search work. Streaming reconnects
must not duplicate completed provider calls.

## Structure

### Backend Files

New files:

- `python/nexus/services/agent_tools/__init__.py`
- `python/nexus/services/agent_tools/types.py`
- `python/nexus/services/agent_tools/orchestrator.py`
- `python/nexus/services/agent_tools/web_search.py`
- `python/nexus/services/agent_tools/web_context.py`
- `python/nexus/services/agent_tools/citations.py`
- `python/nexus/services/web_search/__init__.py`
- `python/nexus/services/web_search/types.py`
- `python/nexus/services/web_search/errors.py`
- `python/nexus/services/web_search/brave.py`
- `python/nexus/services/llm/tools.py`
- `python/tests/test_agent_web_search.py`
- `python/tests/test_agent_tool_orchestrator.py`
- `python/tests/test_brave_search_provider.py`

Existing files to change:

- `.env.example`
- `python/nexus/config.py`
- `python/nexus/api/deps.py`
- `python/nexus/app.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/stream.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/db/models.py`
- `python/nexus/services/send_message.py`
- `python/nexus/services/send_message_stream.py`
- `python/nexus/services/llm/types.py`
- `python/nexus/services/llm/router.py`
- `python/nexus/services/llm/openai_adapter.py`
- `python/nexus/services/llm/anthropic_adapter.py`
- `python/nexus/services/llm/gemini_adapter.py`
- `python/nexus/services/llm/deepseek_adapter.py`
- `python/nexus/services/llm/prompt.py`
- `python/nexus/services/models.py`
- `migrations/alembic/versions/*`

### Frontend Files

Existing files to change:

- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/ChatComposer.module.css`
- `apps/web/src/lib/api/sse.ts`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/components/ui/MarkdownMessage.tsx`
- `apps/web/src/components/ui/InlineCitations.tsx`

New files if no equivalent exists:

- `apps/web/src/lib/chat/toolEvents.ts`
- `apps/web/src/lib/chat/citations.ts`
- `apps/web/src/components/chat/ToolActivityRow.tsx`
- `apps/web/src/components/chat/WebCitationChip.tsx`
- `apps/web/src/components/chat/WebSearchModeControl.tsx`

### Database

Add durable tables for:

- message tool calls
- web-search result selections
- assistant citations

Required indexes:

- lookup tool calls by conversation/message
- lookup citations by assistant message
- operational analysis by tool name, provider, status, and created time

Do not add speculative indexes. Add only indexes required by read paths and
operational queries.

The migration is a cutover migration. There is no compatibility table, legacy
JSON column, or old send-path branch.

## Rules

- One primary public-web search capability: `web_search`.
- One primary saved-content search capability: `app_search`.
- Do not mix public web search with Nexus app search under one tool name.
- Web-search execution is read-only.
- The backend owns all search budgets and provider policy.
- The model may propose a query, but the backend validates and can reject it.
- Provider failures are typed and visible to orchestration.
- No provider API key reaches the browser, prompt, stream event, or persisted
  message content.
- Web context is untrusted data. It is quoted evidence, not instructions.
- Claims based on web evidence require citations.
- Citations must be visible and clickable.
- The assistant must not cite URLs that were not returned by the provider or a
  future approved context extraction provider.
- Store query hashes by default. Do not log raw search queries.
- Tool calls have max count, timeout, result count, context character, and cost
  budgets.
- External HTTP retries are bounded and live inside the provider module.
- Every new env var must be documented in `.env.example`.
- Every structured payload uses typed Pydantic/dataclass contracts.
- LLM adapters implement the provider-neutral tool contract or the model is not
  offered as web-search capable.
- Existing tests are updated to the final behavior; do not preserve old
  no-web-search assumptions.

## Key Decisions

### Build Our Own Tool Contract

The product should own search behavior, persistence, citations, cost controls,
and UI semantics. Model-vendor built-in search is the fastest integration path,
but it couples the product to vendor-specific retrieval behavior and citation
formats.

### Use Brave First

Brave is the day-one provider because it exposes search results directly, is
built for AI-app use cases, has its own index, includes AI-oriented result
context features, and has predictable request pricing. This is a better core
substrate than SERP scraping and less vendor-coupled than model-native web
search.

### Keep Tavily and Exa as Later Provider Adapters

Tavily is strong for AI-ready search plus extraction and research workflows.
Exa is strong for semantic/coding/docs/company retrieval and page contents.
Both are valid future adapters, but adding several providers on day one would
increase configuration, tests, failure modes, and ranking variance before the
core contract is proven.

### Do Not Use Bing Search APIs

The old Bing Search APIs are retired. Microsoft's replacement is an Azure
grounding product, not a direct raw search-results API for this architecture.

### Do Not Use Google Custom Search JSON API

Google's Custom Search JSON API is not a good new product baseline. It requires
a configured Programmable Search Engine, is closed to new customers, and
existing customers have a published transition deadline. This makes it unsuitable
for a hard-cutover web search foundation.

### Do Not Use SERP Scraping as Core Infrastructure

SERP scraping can be useful for prototypes, but it is not the product baseline:
it has ToS, legal, blocking, identity, and reliability risk. Public reporting
and developer feedback show the market is unstable here.

### Do Not Use SearXNG for Production Search

SearXNG is useful for self-hosted and internal experiments. For a customer
product, a metasearch layer over other engines creates reliability,
rate-limit, ToS, and result-attribution ambiguity.

### Separate Search From Context Assembly

Search returns candidates. Backend context assembly decides what source text is
safe and useful to send to the LLM. This keeps the model away from raw provider
payloads and gives us one place to enforce budgets.

### Persist Citations Structurally

Markdown links in assistant text are not enough. Citations must be stored as
structured records so the UI, audits, evals, and future regeneration flows can
reason about source usage.

### Hard Cutover the Chat Schema

`web_search.mode` is required. The frontend is updated in the same change. Old
clients fail validation instead of silently running the old no-tool behavior.

## Implementation Plan

### 1. Schema and Persistence

- Add `web_search` to `SendMessageRequest`.
- Add typed SSE event variants for `tool_call`, `tool_result`, and
  `citation`.
- Add provider-neutral tool request/result dataclasses.
- Add persisted tool-call, web-result, and citation models.
- Add Alembic migration with required constraints and indexes.
- Add env vars for Brave API configuration and documented defaults.

### 2. Brave Provider

- Implement `BraveSearchProvider`.
- Normalize Brave web/news/mixed results into internal `WebSearchResult`.
- Capture provider request IDs when available.
- Map Brave HTTP errors and rate limits into typed internal errors.
- Add bounded retry and timeout constants in the provider module.
- Add `respx` tests for success, no results, rate limits, invalid API key,
  timeout, malformed response, and retry exhaustion.

### 3. Web Context Assembly

- Render selected results into quote-safe source blocks.
- Enforce result count and context character budgets before LLM calls.
- Strip or neutralize HTML.
- Treat snippets as evidence only.
- Reject unsafe or unsupported URL schemes.

### 4. Tool Orchestration

- Add a backend tool loop shared by streaming and non-streaming send paths.
- Validate tool args with Pydantic before execution.
- Enforce max tool calls, max provider calls, timeout, result count, and
  context budgets.
- Persist tool call and citation records.
- Return tool results to the model through provider-neutral abstractions.
- Decouple stream transport from tool-work lifecycle so disconnects do not
  duplicate completed searches.

### 5. Provider Adapters

- Extend `LLMRequest`, `LLMResponse`, and `LLMChunk` to carry tool specs,
  tool calls, tool results, citations, and usage.
- Implement function/tool calling for OpenAI, Anthropic, and Gemini where
  available.
- Mark DeepSeek web-search capability unavailable unless its adapter satisfies
  the same tool contract.
- Update model catalog response fields so the frontend can know whether the
  selected model supports `web_search`.

### 6. Frontend

- Add the web-search mode control to the composer.
- Send `web_search.mode` on every chat request.
- Parse SSE tool and citation events exhaustively.
- Render compact tool activity while the assistant searches.
- Render web citation chips and inline citation markers on final answers.
- Keep citation links accessible and clickable.

### 7. Tests and Cutover

- Write failing tests from the acceptance criteria first.
- Update existing chat tests to require `web_search.mode`.
- Remove tests that assert legacy no-tool send behavior.
- Run backend, frontend, and E2E verification gates.

## Acceptance Criteria

### Request and Configuration

- Chat send requests without `web_search.mode` fail validation.
- The frontend sends `web_search.mode` for new and existing conversation sends.
- `.env.example` documents every new Brave/web-search env var.
- If Brave is not configured, web-search capable mode returns a controlled
  unavailable response.

### Provider

- Brave search returns normalized results with title, URL, display URL,
  snippet, rank, provider, and provider request metadata.
- Domain filters, result type, freshness, country, language, safe-search, and
  limit are enforced by backend policy.
- Provider HTTP errors, rate limits, invalid credentials, malformed responses,
  and timeouts map to typed errors.
- Retries are bounded and tested.
- Raw provider response bags do not leak into LLM prompts, API responses, or
  persisted product records.

### Tool Orchestration

- In `required` mode, the assistant searches at least once before final answer
  or returns a controlled search-unavailable response.
- In `auto` mode, current/external/source-backed queries search, while simple
  local writing/coding tasks do not.
- In `off` mode, no provider call is made.
- Invalid tool args are rejected before provider execution.
- Max tool-call, provider-call, result, context, timeout, and cost budgets are
  enforced.
- Tool calls, selected results, citations, provider IDs, status, timing, and
  errors persist.
- Non-streaming and streaming paths produce equivalent final persisted state.
- Browser disconnect during streaming does not duplicate completed provider
  calls.

### Answer Quality

- Answers based on web results include visible clickable citations.
- The assistant does not cite URLs absent from selected search results.
- The assistant does not treat webpage snippets as instructions.
- No-results answers clearly say no useful web results were found.
- Search-unavailable answers clearly say search was unavailable.
- When answering partly from model knowledge, the assistant separates that from
  searched evidence.

### Frontend

- Composer exposes `off`, `auto`, and `required` web-search modes.
- Chat shows web-search activity while the assistant searches.
- Final answers show inline citation markers and source chips.
- Citation chips open the cited URL in a normal browser tab.
- Unknown SSE event variants fail tests rather than being silently ignored.

### Tests

- Backend integration tests cover request validation, provider normalization,
  orchestration, persistence, and failure modes.
- Provider tests mock Brave at the HTTP boundary with `respx`.
- Frontend tests cover request payload shape, SSE event parsing, tool activity,
  and citation rendering.
- E2E covers one required-search answer, one auto-search answer, one no-search
  answer, and one no-results answer.
- The final verification command for the PR passes.

## Cutover Rules

- Remove the old chat request shape once `web_search.mode` lands.
- Remove old SSE parsing that only knows `meta`, `delta`, and `done`.
- Remove app/client assumptions that assistant messages only contain text.
- Remove provider adapter assumptions that responses only contain output text.
- Do not keep hidden compatibility branches for clients that omit web-search
  state.
- Do not ship runtime fallback to model-native web search.
- Do not ship runtime fallback to SERP scraping, SearXNG, or public instances.

## External References

Primary provider docs:

- Brave Search API: https://brave.com/search/api/
- Brave Search API pricing: https://api-dashboard.search.brave.com/documentation/pricing
- Tavily credits and pricing: https://docs.tavily.com/documentation/api-credits
- Tavily Search API: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Tavily Extract API: https://docs.tavily.com/documentation/api-reference/endpoint/extract
- Exa pricing: https://exa.ai/pricing
- Exa Search API: https://exa.ai/docs/reference/search
- Exa Contents API: https://exa.ai/docs/reference/contents-api-guide
- OpenAI web search tool: https://developers.openai.com/api/docs/guides/tools-web-search
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- Anthropic web search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Gemini Grounding with Google Search: https://ai.google.dev/gemini-api/docs/google-search
- Microsoft Bing Search API retirement: https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- Microsoft Grounding with Bing pricing: https://www.microsoft.com/en-us/bing/apis/grounding-pricing
- Google Custom Search JSON API: https://developers.google.com/custom-search/v1/overview
- SearXNG documentation: https://docs.searxng.org/
- Ars Technica coverage of Google vs. SerpApi: https://arstechnica.com/google/2025/12/google-lobs-lawsuit-at-search-result-scraping-firm-serpapi/

User-feedback signals reviewed:

- Brave Search API cost/control feedback: https://www.reddit.com/r/openclaw/comments/1r340jz/psa_brave_search_api_no_longer_free_other_changes/
- Tavily as AI-agent search/extract feedback: https://www.reddit.com/r/openclaw/comments/1r4ldnh/i_built_a_tavily_search_plugin_for_openclaw/
- Deep-research retrieval pipeline discussion: https://www.reddit.com/r/LocalLLaMA/comments/1rvfkhh/how_are_people_building_deep_research_agents/
- SearXNG/free-search feedback: https://www.reddit.com/r/LocalLLaMA/comments/1kj6vlj/why_is_adding_search_functionality_so_hard/

## Open Questions

- Should `auto` be the default composer mode, or should the product default to
  `off` and require an explicit user action for cost control?
- Should exact search queries ever be persisted under a short retention policy,
  or should durable storage remain hash-only permanently?
- Should citations be inline markers only, source chips only, or both?
- Should the first cut use Brave LLM Context fields by default, or only standard
  web/news result snippets until answer quality testing says otherwise?
- Which models should be marked web-search capable on day one after adapter
  tool-call tests pass?

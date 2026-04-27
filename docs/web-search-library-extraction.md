# Web Search Library Extraction

## Purpose

Extract the reusable public web-search provider code into one small Python package while keeping
Nexus-specific chat tool behavior inside this application.

This is a hard cutover. The final state must have no compatibility wrapper, no legacy import path,
and no duplicated local provider implementation.

## Target Behavior

- Nexus chat behavior stays the same from the user's point of view:
  - `auto`, `required`, and `off` web-search modes keep their current meanings.
  - Required web search without a configured provider returns a typed web-search tool error.
  - Provider failures do not abort the chat run. They render a web-search error context block and
    persist a failed tool call.
  - Search citations remain clickable external web citations in the UI.
  - Prompt context still receives selected web result blocks with escaped title, URL, source,
    publication date, and excerpts.
- Brave remains the only production provider in the first extracted package.
- The extracted package owns only:
  - validated search request objects,
  - normalized result objects,
  - normalized provider errors,
  - the Brave HTTP implementation,
  - provider-level parsing, URL normalization, domain normalization, and provider tests.
- Nexus owns everything that is Nexus-specific:
  - `WebSearchOptions`,
  - auto-search heuristics,
  - chat-run orchestration,
  - prompt context rendering,
  - database persistence,
  - SSE event shapes,
  - frontend citation rendering,
  - environment variables and app startup wiring.

## Final State

### New Repository

Create a separate repository named `nexus-web-search`.

Python distribution name:

```text
nexus-web-search
```

Python import package:

```text
nexus_web_search
```

Expected structure:

```text
nexus-web-search/
  README.md
  SECURITY.md
  pyproject.toml
  uv.lock
  .github/
    workflows/
      ci.yml
      publish.yml
  src/
    nexus_web_search/
      __init__.py
      brave.py
      types.py
  tests/
    test_brave.py
    test_types.py
```

`src/nexus_web_search/__init__.py` stays empty. Consumers import symbols from the defining module:

```python
from nexus_web_search.brave import BraveSearchProvider
from nexus_web_search.types import WebSearchRequest, WebSearchResultType
```

### Nexus Repository

Delete the local provider package:

```text
python/nexus/services/web_search/
```

Update Nexus to depend on the external package and import from it directly. There must be no
`nexus.services.web_search` compatibility module.

## Architecture

Dependency direction is one-way:

```text
nexus-web
  imports nexus-web-search

nexus-web-search
  imports httpx and stdlib only
```

The extracted package must not import from Nexus, SQLAlchemy, Starlette, FastAPI, Pydantic settings,
logging, or frontend code.

The package must not own HTTP client lifecycle. Callers pass an `httpx.AsyncClient` into
`BraveSearchProvider`. Nexus keeps creating the provider in app startup and task-worker entrypoints
with the shared client it already owns.

## Public Package API

Keep the API small and concrete.

`nexus_web_search.types` owns:

- `WebSearchRequest`
- `WebSearchResultItem`
- `WebSearchResponse`
- `WebSearchResultType`
- `WebSearchError`
- `WebSearchErrorCode`
- `WebSearchProvider`

`WebSearchProvider` is the only interface-like type worth keeping. It earns its place because it is
the external boundary Nexus and tests consume, and it prevents the chat tool from importing the Brave
implementation.

Remove public one-use aliases. For example, use `Literal["off", "moderate", "strict"]` directly on
the `safe_search` field instead of exporting a separate alias.

Remove unused response fields during extraction. Keep fields only when Nexus consumes them or they
carry operational value:

- keep `results`;
- keep `provider`;
- keep `provider_request_id`;
- drop response fields that are not used by Nexus and are not actionable, such as pagination flags
  without pagination support.

`nexus_web_search.brave` owns:

- `BraveSearchProvider`
- Brave endpoint selection,
- Brave query parameter construction,
- Brave error mapping,
- Brave result parsing,
- private URL, source, date, and result-order helpers.

Do not add a provider registry, adapter layer, builder, plugin system, retry utility, ranking layer,
cache layer, crawler, summarizer, or DSL.

## Nexus Files

Delete:

- `python/nexus/services/web_search/__init__.py`
- `python/nexus/services/web_search/brave.py`
- `python/nexus/services/web_search/types.py`
- `python/tests/test_brave_search_provider.py`

Update:

- `python/pyproject.toml`
  - Add `nexus-web-search` as a backend dependency.
  - Expand the Pyright include list for newly touched backend modules if they type-check cleanly.
- `python/uv.lock`
  - Lock the new package dependency.
- `python/nexus/app.py`
  - Import `BraveSearchProvider` from `nexus_web_search.brave`.
- `python/nexus/tasks/chat_run.py`
  - Import `BraveSearchProvider` from `nexus_web_search.brave`.
- `python/nexus/api/deps.py`
  - Import `WebSearchProvider` from `nexus_web_search.types`.
- `python/nexus/services/chat_runs.py`
  - Import `WebSearchProvider` from `nexus_web_search.types`.
- `python/nexus/services/agent_tools/web_search.py`
  - Import request, response, result, error, and provider types from `nexus_web_search.types`.
  - Remove the local `WebSearchProvider` protocol.
  - Remove the unjustified `# type: ignore[arg-type]`.
  - Keep Nexus-specific execution, rendering, and persistence here.
- `python/nexus/config.py`
  - Type `brave_search_safe_search` as `Literal["off", "moderate", "strict"]` so invalid config fails
    at settings validation instead of at the provider boundary.
- `python/tests/test_agent_web_search.py`
  - Keep testing Nexus tool behavior.
  - Use a local fake object that satisfies `WebSearchProvider`.
- `.env.example`
  - Keep all `BRAVE_SEARCH_*` entries in sync with the settings code.

Frontend files should not need behavioral changes. Touch them only if backend event shapes change,
which this plan forbids.

## New Package Files

Create:

- `README.md`
  - Installation.
  - Minimal async Brave example.
  - Supported Python version.
  - Explicit note that callers own the HTTP client lifecycle.
- `SECURITY.md`
  - Vulnerability reporting path.
- `pyproject.toml`
  - `src/` layout.
  - Python `>=3.12`.
  - Runtime dependency: `httpx`.
  - Dev dependencies: `pytest`, `pytest-asyncio`, `respx`, `ruff`, `pyright`, `pip-audit`.
  - Build backend: Hatchling or another standard backend already accepted by the team.
- `.github/workflows/ci.yml`
  - Ruff check.
  - Ruff format check.
  - Pyright.
  - Pytest.
  - Build check.
  - Audit check.
- `.github/workflows/publish.yml`
  - GitHub OIDC trusted publishing.
  - PyPI attestations/provenance where supported.
  - Publish only on version tags.

## Rules

Apply these repo rules directly:

- Import symbols from their defining modules. Do not re-export from package `__init__`.
- Keep service dependencies explicit. Nexus passes the provider into chat execution.
- Keep HTTP/framework/database code out of the extracted package.
- Do not add speculative providers, flags, options, APIs, or registries.
- Prefer direct branches over catch-all control flow.
- Do not swallow generic exceptions. If a generic failure path remains in Nexus chat execution, it
  must be the final defensive tool-error boundary and must log enough context.
- Keep generated prompt XML escaping inline at the generated-text boundary.
- Keep `.env.example` synchronized with any settings change.
- Add no `# type: ignore`, `cast()`, `# noqa`, or TypeScript suppression without the required
  justification.
- Use `respx` or equivalent HTTP mocking only at the external Brave boundary. Do not mock internal
  Nexus services.
- Prefer a small amount of duplication over introducing a reusable-looking abstraction.

## Key Decisions

1. Extract only the provider layer.

   The chat tool is not reusable library code. It depends on Nexus database tables, chat-run state,
   prompt formatting, SSE events, and frontend citation contracts.

2. Keep Brave as the only provider.

   Brave is the current production provider and has a direct search API with an independent index.
   Tavily, Exa, Linkup, Firecrawl, OpenAI web search, and SearXNG can be evaluated later only when a
   real consuming project needs one.

3. Do not create a generic search framework.

   A provider registry or adapter system would add indirection before there is a second provider.

4. Use a hard cutover.

   All Nexus imports move to `nexus_web_search.*`. The old `nexus.services.web_search` path is
   deleted.

5. Keep provider errors typed.

   Nexus needs stable error codes for tool-result persistence and user-visible failure behavior.

6. Keep request validation in the package.

   Other projects should not need to copy query, domain, country, language, limit, or safe-search
   validation.

7. Keep Nexus persistence unchanged.

   There is no schema reason to touch migrations. The external package only changes where search
   results come from, not how Nexus stores tool calls.

8. Prefer package release over git URL for production.

   The long-term state is a versioned package published through trusted publishing. A temporary git
   dependency is acceptable only during the implementation branch before the first package release.

## Acceptance Criteria

### Package

- `uv run ruff check .` passes.
- `uv run ruff format --check .` passes.
- `uv run pyright` passes.
- `uv run pytest` passes without network access.
- `uv build --no-sources` succeeds.
- Provider tests cover:
  - web endpoint parameters,
  - news endpoint parameters,
  - mixed result ordering,
  - allowed and blocked domain query operators,
  - URL normalization,
  - duplicate URL suppression,
  - malformed JSON,
  - timeout handling,
  - 401/403 invalid key mapping,
  - 429 rate-limit mapping,
  - 5xx provider-down mapping,
  - request validation.
- No package test hits the real Brave API by default.
- The package can be imported with:

  ```bash
  python -c "from nexus_web_search.brave import BraveSearchProvider"
  ```

### Nexus

- `rg "nexus.services.web_search" python` returns no matches.
- `test -d python/nexus/services/web_search` fails because the directory is gone.
- `rg "type: ignore" python/nexus/services/agent_tools/web_search.py` returns no matches.
- Backend tests covering chat web search pass.
- Frontend tests covering web-search SSE events and citation rendering pass.
- `make check` passes or the equivalent touched static gates pass.
- A local chat run with `web_search.mode = "required"` and no Brave key persists a typed
  web-search tool error.
- A local chat run with a fake or mocked Brave response persists:
  - one `message_tool_calls` row with `tool_name = "web_search"`,
  - `scope = "public_web"`,
  - `semantic = false`,
  - selected web-result refs,
  - provider request IDs when present.
- Existing frontend citation chips still render external links for web citations.

### Repository Operations

- The package repository has branch protection on the default branch.
- Required checks include lint, format, type check, tests, build, and audit.
- `CODEOWNERS`, Dependabot, secret scanning, and dependency review are enabled where available.
- Publishing uses GitHub OIDC trusted publishing, not stored PyPI credentials.
- Releases use SemVer tags.

## Non-Goals

- Do not add Tavily, Exa, Linkup, Firecrawl, SearXNG, OpenAI web search, Google, Bing, SerpAPI, or a
  meta-search abstraction in this cutover.
- Do not switch Nexus chat to model-native OpenAI web search in this cutover.
- Do not add search result caching.
- Do not scrape result pages.
- Do not summarize pages.
- Do not add ranking beyond Brave's returned order and the current Nexus selected-result cap.
- Do not change chat persistence schema.
- Do not change frontend UX.
- Do not preserve the old import path.
- Do not publish broad "provider-neutral" promises beyond the concrete API shipped in version
  `0.1.0`.

## Implementation Order

1. Create `nexus-web-search` with the package files and tests.
2. Trim the copied code while preserving current Brave behavior.
3. Run package checks and build the package.
4. Publish `0.1.0` through trusted publishing, or use a temporary git dependency for the cutover
   branch only.
5. Update Nexus dependency metadata and lockfile.
6. Replace Nexus imports with `nexus_web_search.*`.
7. Delete `python/nexus/services/web_search/`.
8. Remove provider tests from Nexus after they exist in the package.
9. Fix the safe-search setting type and remove the `# type: ignore`.
10. Run targeted Nexus backend, frontend, and static checks.
11. Run the grep-based hard-cutover checks.


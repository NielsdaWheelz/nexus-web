# LLM Calling Library Extraction

## Purpose

Extract the reusable LLM provider-calling code into one small Python package while keeping
Nexus-specific prompt, chat, key, model, logging, persistence, and UI behavior inside this
application.

This is a hard cutover. The final state must have no compatibility wrapper, no legacy import path,
no fallback provider path, no duplicated local provider implementation, and no backward-compatible
`nexus.services.llm` package.

## Goals

- Make LLM provider calls reusable across projects without copying Nexus code.
- Preserve current Nexus behavior from the user's point of view.
- Keep the extracted package small enough to understand quickly.
- Keep control flow linear and explicit.
- Prefer direct provider code over extensible-looking abstractions.
- Treat every exported type, function, constant, and module as API surface that must earn its place.

## Target Behavior

- Nexus chat behavior stays the same from the user's point of view:
  - Streaming chat still yields text deltas and exactly one terminal LLM chunk.
  - Non-streaming calls still return text, usage when available, and provider request ID when
    available.
  - OpenAI, Anthropic, Gemini, and DeepSeek keep their current request and stream semantics.
  - Disabled or unknown providers still fail as model-not-available errors.
  - Invalid keys, rate limits, context-too-large errors, timeouts, provider outages, bad requests,
    and missing models still map to typed LLM errors.
  - Provider failures still surface through existing chat-run, key-test, and metadata-enrichment
    behavior.
  - Existing prompt rendering and prompt-size validation stay Nexus behavior.
- Nexus still owns API keys, platform/BYOK key resolution, entitlements, settings, model catalog,
  chat-run state, SSE events, database writes, and frontend rendering.
- The extracted package owns only provider-level LLM calling:
  - shared provider request and response types,
  - normalized provider error types,
  - OpenAI HTTP calls,
  - Anthropic HTTP calls,
  - Gemini HTTP calls,
  - DeepSeek HTTP calls,
  - provider-specific request formatting,
  - provider-specific response and stream parsing,
  - a small concrete router for provider selection.

## Non-Goals

- No agent framework.
- No LangChain, LangGraph, LlamaIndex, Pydantic AI, LiteLLM, gateway, MCP, or tool runtime.
- No prompt-template framework.
- No Nexus prompt extraction.
- No model catalog extraction.
- No API-key storage, encryption, or key-resolution extraction.
- No billing, entitlement, rate-limit, or quota extraction.
- No retries in the first cutover.
- No fallback provider behavior.
- No caching.
- No provider registry or plugin system.
- No structured-output, tool-calling, image, audio, embedding, or batch API expansion.
- No public package re-exports from `__init__.py`.

## Final State

### New Repository

Create a separate repository named `llm-calling`.

Python distribution name:

```text
llm-calling
```

Python import package:

```text
llm_calling
```

Expected structure:

```text
llm-calling/
  README.md
  SECURITY.md
  pyproject.toml
  uv.lock
  .github/
    CODEOWNERS
    dependabot.yml
    workflows/
      ci.yml
      publish.yml
  src/
    llm_calling/
      __init__.py
      py.typed
      anthropic.py
      deepseek.py
      errors.py
      gemini.py
      openai.py
      router.py
      types.py
  tests/
    fixtures/
      anthropic/
      deepseek/
      gemini/
      openai/
    test_anthropic.py
    test_deepseek.py
    test_errors.py
    test_gemini.py
    test_openai.py
    test_router.py
    test_types.py
```

`src/llm_calling/__init__.py` stays empty. Consumers import symbols from the defining module:

```python
from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, Turn
```

### Nexus Repository

Delete the local LLM provider package:

```text
python/nexus/services/llm/
```

Move Nexus prompt rendering to a Nexus-named module before deleting the package:

```text
python/nexus/services/chat_prompt.py
```

Update Nexus to depend on the external package and import from it directly. There must be no
`nexus.services.llm` compatibility module.

Nexus consumes the private package from GitHub, pinned to the package commit:

```toml
[tool.uv.sources]
llm-calling = { git = "https://github.com/NielsdaWheelz/llm-calling", rev = "<full commit sha>" }
```

The final state must not depend on a sibling checkout such as `../../llm-calling`.

## Architecture

Dependency direction is one-way:

```text
nexus-web
  imports llm-calling
  imports web-search-tool

llm-calling
  imports httpx and stdlib only
```

The extracted package must not import from Nexus, FastAPI, Starlette, SQLAlchemy, Pydantic settings,
structlog, frontend code, database code, or task-worker code.

The package must not own HTTP client lifecycle. Callers pass an `httpx.AsyncClient` into concrete
provider clients or `LLMRouter`. Nexus keeps creating shared clients in app startup and worker
entrypoints.

The package emits no application logs and logs no prompt or response bodies. It returns structured
errors, token usage, and provider request IDs. Nexus logs application context at call sites.

## Public Package API

Keep the API small and concrete.

`llm_calling.types` owns:

- `ReasoningEffort`
- `ProviderName`
- `Turn`
- `LLMRequest`
- `LLMUsage`
- `LLMResponse`
- `LLMChunk`

`llm_calling.errors` owns:

- `LLMError`
- `LLMErrorCode`
- `classify_provider_error`

`llm_calling.openai` owns:

- `OpenAIClient`

`llm_calling.anthropic` owns:

- `AnthropicClient`

`llm_calling.gemini` owns:

- `GeminiClient`

`llm_calling.deepseek` owns:

- `DeepSeekClient`

`llm_calling.router` owns:

- `LLMRouter`

Do not add `adapter.py`, an abstract base class, a provider protocol, a provider registry, builders,
manifests, generic utilities, callback models, event models, request builders, response wrappers, or
extra interfaces.

The provider clients should share method names because `LLMRouter` calls them, but they do not need a
public base class:

```python
await client.generate(request, api_key=api_key, timeout_s=timeout_s)
client.generate_stream(request, api_key=api_key, timeout_s=timeout_s)
```

`LLMRouter` earns its place because Nexus chooses providers dynamically in app startup, workers,
key tests, chat runs, and metadata enrichment. It stays concrete and explicit:

- create the four provider clients in `__init__`;
- store four enable flags;
- branch on `"openai"`, `"anthropic"`, `"gemini"`, and `"deepseek"` explicitly;
- raise `LLMErrorCode.MODEL_NOT_AVAILABLE` for unknown or disabled providers;
- call the chosen concrete client.

## Key Decisions

### Keep Prompt Rendering In Nexus

`python/nexus/services/llm/prompt.py` is Nexus product behavior. It names Nexus as a reading
assistant, understands saved media, highlights, annotations, app search, and web search, and defines
Nexus citation guidance.

Move it to `python/nexus/services/chat_prompt.py`. Import `Turn` from `llm_calling.types`.

### Remove Nexus LLM Context Types

`LLMOperation` and `LLMCallContext` are Nexus observability types, not provider-calling types. Do not
move them to the extracted package.

Do not replace them with new generic context objects. Log the needed fields directly where Nexus
performs each LLM call. A small amount of repeated logging code is preferable to a new cross-project
event abstraction.

### Rename Provider Classes To Clients

Use concrete client names in the extracted package:

- `OpenAIClient`
- `AnthropicClient`
- `GeminiClient`
- `DeepSeekClient`

Do not keep `Adapter` naming. There is no adapter interface in the final state.

### Keep Error Values Product-Neutral

The extracted package uses product-neutral error values:

- `invalid_key`
- `rate_limit`
- `context_too_large`
- `timeout`
- `provider_down`
- `bad_request`
- `model_not_available`

Nexus maps these to existing API/tool error codes only at product boundaries that already return
Nexus errors. The mapping must be explicit and exhaustive.

### Keep Stream Invariants In The Type

`LLMChunk` keeps the current invariant check:

- non-terminal chunks have `usage is None`;
- each provider stream yields exactly one terminal chunk;
- terminal chunks may include usage and provider request ID.

Provider clients are responsible for raising `LLMErrorCode.PROVIDER_DOWN` if a stream ends without a
terminal marker.

### Keep No-Retry Semantics

The extraction preserves current no-retry behavior. Retrying third-party LLM calls is a separate
product decision and must not appear as hidden behavior in the first package.

## Nexus Files

Delete:

- `python/nexus/services/llm/__init__.py`
- `python/nexus/services/llm/adapter.py`
- `python/nexus/services/llm/anthropic_adapter.py`
- `python/nexus/services/llm/deepseek_adapter.py`
- `python/nexus/services/llm/errors.py`
- `python/nexus/services/llm/gemini_adapter.py`
- `python/nexus/services/llm/openai_adapter.py`
- `python/nexus/services/llm/router.py`
- `python/nexus/services/llm/types.py`

Move:

- `python/nexus/services/llm/prompt.py`
  - to `python/nexus/services/chat_prompt.py`

Update:

- `python/pyproject.toml`
  - Add `llm-calling` as a backend dependency.
  - Source `llm-calling` from the private GitHub repository pinned to a full commit SHA.
  - Remove `nexus/services/llm` from the Pyright include list.
  - Add `nexus/services/chat_prompt.py` if it remains in the typed backend surface.
- `python/uv.lock`
  - Lock `llm-calling` to the same Git commit.
- `.github/workflows/ci.yml`
  - Before backend `uv sync --all-extras --locked`, create a short-lived GitHub App token scoped to
    `llm-calling`.
  - Configure Git to use that token for `https://github.com/NielsdaWheelz/` fetches.
- `python/nexus/app.py`
  - Import `LLMRouter` from `llm_calling.router`.
- `python/nexus/tasks/chat_run.py`
  - Import `LLMRouter` from `llm_calling.router`.
- `python/nexus/tasks/enrich_metadata.py`
  - Import `LLMRouter` from `llm_calling.router`.
  - Import `LLMRequest` and `Turn` from `llm_calling.types`.
- `python/nexus/api/deps.py`
  - Import `LLMRouter` from `llm_calling.router`.
- `python/nexus/api/routes/keys.py`
  - Import `LLMRouter` from `llm_calling.router`.
- `python/nexus/services/api_key_resolver.py`
  - Import `LLMError` and `LLMErrorCode` from `llm_calling.errors`.
- `python/nexus/services/chat_runs.py`
  - Import `LLMRouter` from `llm_calling.router`.
  - Import `LLMError` and `LLMErrorCode` from `llm_calling.errors`.
  - Import `LLMChunk`, `LLMRequest`, `LLMUsage`, and `Turn` from `llm_calling.types`.
  - Import `render_prompt` from `nexus.services.chat_prompt`.
- `python/nexus/services/user_keys.py`
  - Import `LLMRouter` from `llm_calling.router`.
  - Import `LLMError` and `LLMErrorCode` from `llm_calling.errors`.
  - Import `LLMRequest` and `Turn` from `llm_calling.types`.
  - Remove `LLMCallContext` and `LLMOperation`.
- `python/tests/test_llm_adapters.py`
  - Move provider, stream, router, and error-classification tests to `llm-calling`.
  - Move prompt tests to `python/tests/test_chat_prompt.py`.
- `python/tests/test_observability.py`
  - Stop importing `LLMCallContext` and `LLMOperation`.
  - Assert Nexus LLM log fields through the behavior that remains in Nexus.
- `python/tests/test_enrich_metadata.py`
  - Patch or fake only the external package boundary when needed.

Frontend files should not need behavioral changes. Touch them only if backend event shapes change,
which this plan forbids.

## New Package Files

Create:

- `README.md`
  - Installation.
  - Minimal async examples for direct provider clients and `LLMRouter`.
  - Supported Python version.
  - Explicit note that callers own the HTTP client lifecycle.
  - Explicit note that prompts and API keys are caller-owned.
- `SECURITY.md`
  - Vulnerability reporting path.
- `pyproject.toml`
  - `src/` layout.
  - Python `>=3.12`.
  - Runtime dependency: `httpx`.
  - Dev dependencies: `pytest`, `pytest-asyncio`, `respx`, `ruff`, `pyright`, `pip-audit`.
  - Build backend: Hatchling.
- `src/llm_calling/py.typed`
  - Mark the package as typed.
- `.github/CODEOWNERS`
  - Require owner review.
- `.github/dependabot.yml`
  - Keep GitHub Actions and Python dependencies current.
- `.github/workflows/ci.yml`
  - Ruff check.
  - Ruff format check.
  - Pyright.
  - Pytest.
  - Build check.
  - Audit check.
- `.github/workflows/publish.yml`
  - GitHub OIDC trusted publishing if the package becomes public.
  - PyPI attestations/provenance where supported.
  - Publish only on version tags.

## Extraction Steps

1. Create `llm-calling` with the package skeleton and CI.
2. Move the shared LLM types and errors into the new package.
3. Move OpenAI, Anthropic, Gemini, and DeepSeek provider code into concrete client modules.
4. Replace Nexus imports inside moved files with `llm_calling.*` imports.
5. Remove Nexus logging, `safe_kv`, `LLMOperation`, and `LLMCallContext` from moved code.
6. Build the concrete `LLMRouter` in the package with explicit provider branches.
7. Move provider fixtures and provider tests into the new package.
8. Add DeepSeek fixtures so every production provider has parallel success and error coverage.
9. Move Nexus prompt rendering to `nexus.services.chat_prompt`.
10. Add `llm-calling` to Nexus as a pinned Git dependency.
11. Update Nexus imports to use `llm_calling.*` directly.
12. Delete `python/nexus/services/llm/`.
13. Update CI token setup for the private dependency.
14. Run package and Nexus verification.

## Acceptance Criteria

- `llm-calling` has no imports from Nexus.
- `llm-calling` imports only stdlib and `httpx` at runtime.
- `src/llm_calling/__init__.py` is empty.
- `llm-calling` has no `adapter.py`, abstract base class, provider protocol, provider registry, or
  plugin mechanism.
- Every public symbol in `llm-calling` is imported by Nexus, used by package tests, or clearly part
  of the provider boundary.
- Every provider has tests for:
  - non-stream success;
  - stream success;
  - non-terminal stream chunks with `usage is None`;
  - invalid key;
  - rate limit;
  - context too large;
  - provider down;
  - timeout;
  - model not available where the provider has a known response shape.
- Package checks pass:

```text
uv run ruff check .
uv run ruff format --check .
uv run pyright
uv run pytest
uv run pip-audit
uv build --no-sources
```

- Nexus has no `python/nexus/services/llm/` directory.
- Nexus has no imports from `nexus.services.llm`.
- Nexus imports LLM provider types and router from `llm_calling.*` defining modules.
- Nexus has no local copy of OpenAI, Anthropic, Gemini, or DeepSeek provider-calling code.
- Nexus keeps prompt rendering in `nexus.services.chat_prompt`.
- Nexus keeps chat-run, key-test, metadata-enrichment, and observability behavior covered by tests.
- Nexus checks pass:

```text
make check
make test-back-unit
make audit
```

- The Nexus lockfile pins `llm-calling` to a full Git commit SHA.
- CI can install the private dependency without credentials in source code, `pyproject.toml`, or
  `uv.lock`.

## Rules

Apply these repo rules directly:

- Import symbols from their defining modules. Do not re-export from package `__init__`.
- Keep service dependencies explicit. Nexus passes routers and providers through function
  parameters, not globals.
- Keep HTTP framework, database, settings, task-worker, and frontend code out of the extracted
  package.
- Do not add speculative providers, flags, options, APIs, registries, builders, or plugins.
- Prefer direct branches over catch-all control flow.
- Branch exhaustively on provider names and error codes.
- Do not swallow generic exceptions. If a final provider boundary normalizes an unexpected transport
  or parse failure, the code must include the required `justify-ignore-error` comment and preserve
  the original exception as `__cause__`.
- Construct typed errors where provider failures are detected.
- Treat impossible states and provider schema mismatches as defects unless the provider response
  shape makes them expected external failures.
- Keep generated prompt escaping inline at the generated-text boundary in Nexus.
- Keep `.env.example` synchronized with any settings change.
- Add no `# type: ignore`, `cast()`, `# noqa`, or TypeScript suppression without the required
  justification.
- Use `respx` for external LLM HTTP mocking. Do not mock internal Nexus services.
- Prefer a small amount of duplication over introducing a reusable-looking abstraction.
- Inline one-use helpers, constants, object shapes, and staging variables unless they hide real
  incidental complexity.
- Keep private Git credentials out of `pyproject.toml`, `uv.lock`, and source code.

# Generation-Run Harness — One LLM Substrate for Chat / Oracle / Library Intelligence (Hard Cutover)

Status: SPEC — **Rev 1** (not built)
Author: design synthesis, 2026-06-09
Type: hard cutover — no legacy paths, no fallbacks, no backward compatibility, no compat shims. Two repos move in lockstep: this repo + `llm-calling` (git dep, owner-controlled).
Migrations: **0145** (`llm_calls` ledger + run-terminal error floor + oracle `interpretation_text` + drops) and **0146** (oracle event-vocabulary normalization).
Precedents: `library-intelligence-ai-native-consolidation-hard-cutover.md` (run_kit/structured_synthesis extractions; "consolidate by invariant, not table shape" §20.2; render-contract citation unification); `0143` polymorphic `(owner_kind, owner_id)`; `0142` DELETE-then-tighten event CHECK; `search-intent-model-hard-cutover.md` (route-edge 400s, negative gates); `notes-pages-evidence-unification-hard-cutover.md` (substrate rename discipline).

> Triggering incident: prod chat run `fa896d46` (2026-06-07, gpt-5.5 + `reasoning=max`) died `E_INTERNAL` at the post-tool continuation request. Diagnosis proved the bug class is **all-provider** (reasoning artifacts are never captured/replayed across tool turns), surfaced a second prod bug (`page_reindex_job` absent from the worker allowlist), and found the traceback unrecoverable (deploy destroyed container logs; no error detail persisted; no usage ledger row written). This cutover fixes the incident class and finishes the consolidation the LI cutover started: one harness in the rings around the already-shared spine.

---

## 0. One-paragraph north star

Every LLM generation in Nexus runs on **one harness**: one worker task envelope (event loop + httpx + router + fixture swap + boundary), one model/key spine (`MODEL_CATALOG` + `resolve_api_key` for **all five** call sites), one rate-limit/budget envelope, one **`llm_calls` ledger row per provider call** on every terminal path, one `llm.request.*` telemetry emitter, one structured-synthesis scaffold (shared RULES/candidates/grounding kernel + one bounded repair round), one SERIALIZABLE-retry helper, and one terminal contract (`run_kit.mark_terminal` stamps `error_code` + `error_detail` on every run parent and emits one normalized `done {status, error_code}` grammar). The transport plane converges the same way: every browser stream lives under **`/stream/*`** served by one generic cursor route + one snapshot route, `is_stream_path` collapses to a prefix check, and the frontend consumes all four streams through one extended `sseClientDirect` + one `useGenerationRun` hook (chat keeps its multi-run layer **on top**, not beside). Citations finish their render-contract unification: the backend becomes the **sole producer of `CitationOut`** for chat (new `build_citation_outs_for_message`), oracle's user-library passages join the same contract (chip + deep link), `web_search` stops being a rogue `message_retrievals` writer, oracle readings become chattable via an `oracle_reading:` reference scheme, and chat runs record the LI artifact `revision_id` they consumed. `llm-calling` itself is fixed so reasoning/thinking survive tool continuations on **all four providers**. Domain finalization stays per-feature (chat writes messages, oracle writes folios, LI promotes revisions) — the harness owns only what is genuinely identical.

---

## 1. Background

### 1.1 The incident is a provider-client class bug, not one bug

`llm_calling` (pinned `python/pyproject.toml:55`, rev `6b44ca72`) discards every reasoning artifact a provider emits and replays none, so any reasoning-enabled run that makes a tool call dies (or corrupts) at the continuation request:

| Provider | Emits | Captured today | Replay requirement | Result today |
|---|---|---|---|---|
| openai (Responses) | `reasoning` items (`rs_*`) paired with `function_call` items; `encrypted_content` only if `include`d | nothing (`openai.py:96-194` parses only text/function_call) | reasoning item must precede its function_call on replay; needs `store:false` + `include:["reasoning.encrypted_content"]` (no `store`/`include`/`previous_response_id` sent today, `openai.py:209-296`) | **400 at continuation** — the prod incident |
| anthropic | `thinking`/`redacted_thinking` blocks + `signature` (`thinking_delta`/`signature_delta`) | nothing (`anthropic.py:117-218` discards) | unmodified thinking blocks must lead the assistant turn before `tool_use` (`_turn_to_message` anthropic.py:387-400 omits them) | same-class 400 for any non-`none` mode + tools |
| gemini | `thoughtSignature` on functionCall parts; thought-summary parts (`thought: true`) | nothing; `ToolCall.id = name` (`gemini.py:155,369`) | echo `thoughtSignature` on replayed functionCall parts; **strip** `thought:true` parts from visible text (today they leak into `delta_text`) | Gemini-3 strict validation rejects continuation + thought text leaks |
| deepseek | `reasoning_content` | nothing | nothing (must NOT be replayed — already implicitly stripped, `deepseek.py:190-207`) | works; thinking tokens invisible |

Adjacent live bugs in the same layer:
- **FE/catalog reasoning mismatch:** the FE offers and defaults to `"default"` for every model (`useChatModels.ts:21,83-94`) but `chat_run_validation.py:57-61` rejects any mode not in `catalog_entry.reasoning_modes`, and only the OpenAI entries include `"default"` (`llm_catalog.py:35-42`) → every anthropic/gemini/deepseek send 400s at create.
- **Router exception leaks:** `router.py:48-123` catches Timeout/HTTPStatusError/NetworkError/json-KeyError-IndexError-ValueError; `httpx.ProtocolError`, `httpx.StreamError` (incl. `ResponseNotRead`), `httpx.DecodingError`, `TypeError`/`AttributeError` escape as non-`LLMError` → nexus `E_INTERNAL` (nexus even carries a bespoke patch for one of them: `_unread_stream_api_error_code`, `chat_runs.py:144-158`).
- `LLM_ERROR_CODE_TO_API_ERROR_CODE` (`errors.py:303-311`) omits `QUOTA_EXCEEDED` although `E_LLM_QUOTA_EXCEEDED` exists.

### 1.2 The observability floor is missing exactly where the incident needed it

- Deploy destroys logs: `deploy/hetzner/deploy.sh:83` `--force-recreate`s all services; the `json-file` driver (`deploy/hetzner/docker-compose.yml:19-23`) stores logs under the container id → the June-7 traceback is gone forever.
- No error detail is persisted: `chat_runs.error_code` only (models.py:4060); LI revisions and `media_summaries` have **no failure columns at all** (models.py:1469-1518, 2466-2495); a failed unit is indistinguishable from any other failure.
- The usage ledger is chat-only and not even reliable there: `message_llm` is written only when `model and key` are non-null at finalize (`chat_run_finalize.py:176-197`) — both `execute_chat_run` catch paths pass neither, so the incident wrote **no ledger row**; the tool loop overwrites usage per iteration so even success persists only the **last** call. Oracle uses usage only for budget commit; LI reduce + media-unit **discard `result.usage` entirely**; `structured_synthesis` emits zero `llm.request.*` telemetry.
- `page_reindex_job` is registered with a dead-letter handler (`jobs/registry.py:125-132`) but missing from the 9-kind allowlist literal that lives in **six** lockstep places (`config.py:29-34`; `deploy/env/env-prod-worker.example:5`; live `deploy/env/env-prod-worker:5`; `deploy/hetzner/sync-env.sh:16`; `python/tests/test_hetzner_env_sync_validation.py:14-19`; `python/tests/test_config.py:185-190`) — verified against the live prod worker env. Every prod note/page edit will strand its content index `pending` forever. No guard catches registry-kind-not-allowlisted.
- The worker process never installs a rate limiter (`set_rate_limiter` is called only by `tasks/chat_run.py:48` and the API): a fresh worker that picks up an **oracle** job first fails it `E_RATE_LIMITER_UNAVAILABLE` (`oracle.py:610-614`).

### 1.3 The ring duplication (what one harness replaces)

Five LLM call sites — chat (`services/chat_runs.py`), oracle (`services/oracle.py`), LI reduce (`services/library_intelligence_reduce.py`), media-unit build (`services/media_intelligence.py`), metadata enrichment (`tasks/enrich_metadata.py`) — plus the `user_keys.test_user_key` probe. Around the shared spine they hand-copy:

1. **Worker task envelope ×5** (`tasks/{chat_run,oracle_reading,library_intelligence,media_unit_build,enrich_metadata}.py`): `asyncio.new_event_loop` + `httpx.AsyncClient` + `LLMRouter(enable_…×4)` + boundary; enrich builds a **new loop+client per provider attempt** and sets no timeout; only chat gets the fixture-router swap; only chat installs the rate limiter.
2. **Model/key split-brain:** chat = `models` row + catalog validation + `resolve_api_key` (BYOK/platform/entitlements/key-status feedback); oracle/LI/unit = hardcoded anthropic constants + raw `settings.anthropic_api_key` (LI/unit `or ""` — silently empty); enrichment = stale settings model names (`gpt-4o-mini`, `claude-3-5-haiku-20241022`, `gemini-3.5-flash`, config.py:364-372) absent from `MODEL_CATALOG`, validated nowhere.
3. **Rate-limit/budget:** chat + oracle full envelope with two different estimators; LI/unit/enrich none.
4. **Structured-synthesis scaffold ×3** (oracle.py:1446-1528, reduce.py:478-513, media_intelligence.py:713-745): byte-identical RULES closing line, candidate render skeleton, two-turn shape, `reasoning_effort="none"`; plus **grounding map ×3** (oracle.py:1601-1620, reduce.py:217-251, media_intelligence.py:484-500) enforcing the same invariant (a model-emitted index must denote an offered candidate) in three shapes.
5. **SERIALIZABLE retry loop ×9** (`media_intelligence.py:119-130,612-672`; `library_intelligence.py:236-249,339-368`; `reduce.py:374-437`; `contributors.py:577-593`; `notes.py:1121-1160`; `stream_tokens.py:120-127`; `bootstrap.py:29-34`; `jobs/worker.py:276-317`).
6. **fail-after-worker-exception ×3** + chat dead-letter; **error→user-message maps ×2** (+ FE copy); **token estimators ×4 formulas**; **`llm.request.*` field sets ×3**.
7. **SSE route trio** (`stream.py:33-151`, byte-identical modulo per-kind closures) + off-prefix chat/media paths forcing the 4-arm `is_stream_path` (stream_paths.py:9-16); **FE stream engines ×4** (~1,900 lines over the 405-line shared transport; 4 identical token closures; chat sets `maxReconnects: 0` and re-implements reconnect because the client lacks a reconcile hook; 5 `optionalString` variants).
8. **Citations:** chat's `CitationOut` is reconstructed FE-side from two sources (`citations.ts:17-94`, `useChatMessageUpdates.handleCitationIndex`); `web_search` bypasses `insert_retrieval_row` with its own SQL (web_search.py:356-431); oracle renders citation dead ends (`deep_link` parsed at OracleReadingPaneBody.tsx:196 and never rendered); readings are not chattable; the LI spec's §6.6 `revision_id` stamp was never built.

### 1.4 What we reuse (verified, untouched in kind)

`run_kit` (event log + terminal, run_kit.py:101-177); `structured_synthesis` core (one call → strict JSON → schema); `_sse.py` (both tailers — the module docstring's two-tailer defense stands); `db/listen.py`; stream tokens (path-free by construction, services/stream_tokens.py); `sseClientDirect`/`sse-stream.ts`; `retrieval_citation.insert_retrieval_row` + `build_citation_outs_for_revision` + `build_evidence_span_citation_target`; `locator_resolver`; `resource_resolver`/`resource_loaders`/`conversation_references`; the jobs queue (claim/lease/dead-letter/dedupe); `MODEL_CATALOG`; `prompt_budget.estimate_tokens`.

### 1.5 What we deliberately do NOT touch

- The four feature-typed citation/reference stores (`message_retrievals`, `conversation_references`, `oracle_reading_passages`, `object_links`) — LI cutover §14 must-REMAIN; storage fold stays gated on the provenance-graph spec (§20).
- Chat's tool loop, context assembler, prompt budget lanes, branching, idempotency, dead-letter policy — behavior-preserving except where named.
- Oracle's product semantics (folios plural, no head, no auto-retry, single structured call, citation-marker prose ban).
- LI's head/revision/promote model, staleness, inline unit build.
- Media ingest pipeline; `tail_snapshot_stream` snapshot semantics.
- `metadata_enrichment`'s provider-native `StructuredOutputSpec` + multi-provider failover transport (different contract; it adopts only the harness envelope, key spine, ledger, and catalog-valid models).

---

## 2. Goals

- **G1 — Reasoning-safe tool continuations on all four providers.** Opaque provider items captured from streams/responses and replayed verbatim; gemini thought-text never leaks; a gated live-provider matrix proves it.
- **G2 — One model/key/budget spine.** All six call sites validate models against `MODEL_CATALOG` and resolve keys via `resolve_api_key`; the worker installs the rate limiter at startup; rpm/inflight/budget policy is per-kind config, not per-kind code.
- **G3 — One flight recorder.** `llm_calls` row per provider call on **every** terminal path (success, provider error, boundary exception, repair attempts), `error_code` + `error_detail` on every run parent, `llm.request.started/finished/failed` from one emitter, logs that survive deploys.
- **G4 — One worker envelope.** One `run_llm_task` harness; the five task modules become thin registrations.
- **G5 — One synthesis scaffold.** Shared prompt scaffold + grounding kernel + one bounded repair round (parse/schema + caller semantic validation), summed usage.
- **G6 — One stream plane.** Everything browser-streamable lives under `/stream/*`; one generic cursor route + one snapshot route; one normalized `done {status, error_code}` grammar (oracle's `error` event type deleted); one FE client + one `useGenerationRun`.
- **G7 — Citation render contract finished.** Backend-built `CitationOut` everywhere (chat twin, oracle user-media passages), one `message_retrievals` writer, chattable oracle readings, `revision_id` stamped per chat run.
- **G8 — Prod floor.** `page_reindex_job` allowlisted; registry⊆allowlist guard for user-facing kinds; journald logging; docs (`llms.md`, `jobs.md`, `byok.md`, architecture §7.3) match reality.

## 3. Non-goals

- **N1 — No citation storage fold, no `ResourceRef`, no provenance graph.** Render-contract only (LI cutover N2/§20 still governs).
- **N2 — No queue/durable-execution replacement.** Postgres `background_jobs` + LISTEN/NOTIFY + SSE replay is the substrate; no Temporal/Inngest/etc.
- **N3 — No token-streaming for oracle/LI synthesis.** Single structured call stays; `delta` stays reserved in the LI CHECK, unemitted.
- **N4 — No conversation kinds, presets, or artifact-as-message.** LI/oracle chattability remains `conversation_references` schemes.
- **N5 — No FE usage dashboard.** `llm_calls` is operator-queryable (SQL); no product surface.
- **N6 — No auto-rebuild/auto-retry semantics changes.** Oracle stays max_attempts=1 no-dead-letter; LI revision stays user-retried via fresh idempotency key.
- **N7 — Media stays a status snapshot stream**, not a run; it joins the transport (prefix + client), not the run model.
- **N8 — No multi-worker concurrency or scheduler changes.**
- **N9 — No prompt rewrites.** Persona/domain rules move verbatim into the scaffold parameters.

---

## 4. Target behavior (user-facing)

- Chat with any catalog model at any offered reasoning level — including tool-calling turns — completes on all four providers; `"default"` is valid for every model.
- A failed run shows the same friendly message as today, but the operator can always answer "what exactly failed": `chat_runs.error_detail` (exception class + message + provider request id), an `llm_calls` row for the attempt, and a `docker logs`-readable traceback that survives the next deploy.
- Note/page edits in prod become searchable (reindex jobs actually run).
- Oracle readings: user-library passages render as citation chips that jump to the exact passage (`/media/{id}#evidence-{span}`), public-domain passages keep their typography; a "Consult the archive" (chat) action opens a conversation referencing the reading.
- LI pane, oracle pane, chat pane, media status all stream over `/stream/*` with identical resume/reconnect behavior; chat citation chips appear from one server-built payload (no behavior change visible).
- Regenerating an LI artifact never orphans the question "which edition did this chat read" — the run's prompt ledger records the revision id.

---

## 5. Architecture — final state

### 5.1 `llm-calling` (external repo; one minor version, pinned rev bump)

Types (`types.py`) grow three opaque carriers — **provider-shaped, never interpreted by nexus**:

```python
ProviderItem = Mapping[str, object]              # verbatim provider payload fragment
class ToolCall:   ... provider_metadata: Mapping[str, object] | None = None   # gemini thoughtSignature, openai fc item id
class Turn:       ... provider_items: tuple[ProviderItem, ...] = ()           # assistant-turn reasoning/thinking items, captured order
class LLMChunk:   ... provider_item: ProviderItem | None = None               # non-terminal-legal, like tool_call
```

Per-provider serialization/capture:
- **openai**: when `reasoning_effort != "default"` is sent OR the model is a reasoning family, request `store: false` + `include: ["reasoning.encrypted_content"]`; capture `response.output_item.done` items of `type=="reasoning"` (full item dict incl. `encrypted_content` and `id`) as `LLMChunk.provider_item` (and from `output[]` in non-stream `generate`); capture function_call **item ids** into `ToolCall.provider_metadata`. `_build_request_body` emits `turn.provider_items` verbatim **before** that turn's function_call items.
- **anthropic**: accumulate `content_block_start(type=thinking|redacted_thinking)` + `thinking_delta`/`signature_delta` → flush one complete block per `content_block_stop` as `provider_item`; `_turn_to_message` prepends `provider_items` to the assistant `content` array unmodified.
- **gemini**: parse `thoughtSignature` from functionCall parts into `ToolCall.provider_metadata` and echo it on replay; **skip `thought: true` parts** in text parsing (fixes the visible-text leak); when a functionCall part carries an id, use it for `ToolCall.id` instead of `name`.
- **deepseek**: unchanged (already strips); document the invariant.
- **router**: widen the wrap to `except httpx.HTTPError` + `(TypeError, AttributeError)` → `PROVIDER_DOWN` (with the original message), so no transport exception escapes unclassified. Nexus then deletes `_unread_stream_api_error_code` (chat_runs.py:144-158, 1459-1486).

Nexus consumption delta is exactly one site: the chat tool loop collects `chunk.provider_item` per iteration and builds `Turn(role="assistant", content=iter_text, tool_calls=…, provider_items=tuple(items))` at `chat_runs.py:1263-1269`. History turns (flat text) and the four non-streaming call sites need nothing.

Catalog fix: every `MODEL_CATALOG` entry's `reasoning_modes` includes `"default"` (semantics: provider default; llm-calling already maps `"default"` → omit for all providers).

### 5.2 The harness (backend)

**`python/nexus/tasks/llm_task.py`** — the one worker envelope. Replaces the five hand-rolled task bodies:

```python
@dataclass(frozen=True)
class LlmTaskSpec:
    label: str                       # log-event prefix: "chat_run", "oracle_reading", ...
    http_timeout_s: float            # 60.0 default; LI 120.0
    http_limits: tuple[int, int]     # (max_connections, keepalive); chat (100, 20), others (10, 5)

def run_llm_task[R](spec: LlmTaskSpec, handler: Callable[[Session, LLMRouter], Awaitable[R]],
                    *, on_worker_exception: Callable[[Session, Exception], R] | None = None) -> R
```

Owns: session + fresh event loop + `httpx.AsyncClient` + router construction **including the fixture swap for every kind** (`RealMediaFixtureLLMRouter` under `settings.real_media_provider_fixtures` — today chat-only); the `justify-ignore-error` boundary calling `on_worker_exception`; `finally: loop.close(); db.close()`. The rate limiter is installed **once at worker startup** (`apps/worker/main.py`, same constructor as `apps/api/app.py:204-211`) — deletes the chat-task install and fixes the fresh-worker oracle `E_RATE_LIMITER_UNAVAILABLE` landmine. enrich_metadata's per-attempt loop+client collapses into one loop/client for the whole failover.

**Model/key spine.** Each surface keeps its model constant, now contract-checked: `llm_catalog.require_catalog_model(provider, model_name)` raises a defect at import/test time; enrichment defaults move to catalog-valid `KEY_TEST_MODELS`-tier names. All key resolution goes through `resolve_api_key(db, user_id, provider, key_mode)`: chat keeps request `key_mode`; oracle/LI/unit/enrich use `"auto"` attributed to the owning user (oracle `reading.user_id`, LI `artifact owner`, unit `media owner`, enrich `media owner`) — BYOK keys now serve background surfaces, entitlement gating applies uniformly, and `update_user_key_status` feedback flows from every surface's terminal write. Oracle's `_ensure_oracle_platform_llm_available` and the raw `settings.anthropic_api_key or ""` reads are deleted.

**Rate-limit/budget envelope.** Per-kind policy table (in the surface, executed by shared helpers): chat and oracle keep today's envelope; LI reduce, unit build, and enrichment gain `acquire_inflight_slot` + platform-mode `reserve/commit/release_token_budget` keyed on their owner ids. One estimator: `prompt_budget.estimate_tokens` over the rendered request text + `max_tokens` (deletes oracle's `_estimate_llm_request_tokens`, chat's user-message-only `//4` at chat_runs.py:1126, and `_usage_total_tokens` — `chat_run_usage.usage_tokens` is the one usage-totals owner). Dead `RateLimiter.charge_token_budget` is deleted.

**`python/nexus/services/llm_ledger.py`** — sole writer of the `llm_calls` table (§8) and the one `llm.request.*` emitter:

```python
@dataclass(frozen=True)
class LlmCallOwner:
    kind: Literal["chat_run","oracle_reading","li_revision","media_summary","media_enrichment"]
    id: UUID

def observed_llm_call(...)-> AsyncIterator[...]   # wraps generate/generate_stream:
# emits llm.request.started/finished/failed (one field schema: provider, model_name, reasoning_effort,
# key_mode, streaming, llm_operation, owner ids, prompt_chars, latency_ms, outcome, error_class,
# provider_request_id, usage_log_fields(usage)) and records one llm_calls row per provider call
# (call_seq per owner), on success AND failure, including repair attempts.
```

Chat's three field-set copies, enrichment's copy, and the key-probe copy collapse onto it (the key probe logs but does not ledger). `message_llm` is replaced by `llm_calls` (§8); `finalize_run`'s ledger block and its `model and key` gate are deleted — the executor records calls as they happen, so boundary-exception paths still leave a row.

**Failure floor.** `run_kit.mark_terminal` grows `error_code: str | None = None, error_detail: str | None = None` and stamps them on the parent via its existing isinstance dispatch (oracle also gets `failed_at` set there, satisfying `ck_oracle_readings_failed_has_error`). `error_detail` = sanitized `f"{type(exc).__name__}: {exc}"[:1000]` + provider request id when known — operator-facing, never rendered. The fail-after-worker-exception trio becomes one `fail_run_after_worker_exception(stream_loader, …)` helper parameterized by terminal-predicate + failure write; chat's dead-letter finalizer stays (it writes an assistant message). `LLM_ERROR_CODE_TO_API_ERROR_CODE` gains `QUOTA_EXCEEDED → E_LLM_QUOTA_EXCEEDED`. The only backend code→user-copy map left is chat's `ERROR_CODE_TO_MESSAGE` (it writes assistant content); oracle's `_oracle_failure_message` + its 7 constants + the read-time event rewrite (`_oracle_event_out`, oracle.py:965-970) are deleted — the FE already owns oracle failure copy (`oracleFailureFeedback`).

**`python/nexus/db/retries.py`** — `retry_serializable[T](db, label, op, *, retries=3) -> T` (SAVEPOINT-free wrapper of the existing `use_serializable_if_available` + `is_serialization_failure`); adopted at all nine sites (§1.3 item 5), including `run_identity_write` and the worker scheduler loop.

### 5.3 Structured-synthesis scaffold

`services/structured_synthesis.py` grows (the core call stays):

```python
def build_synthesis_prompt(*, persona: str, preamble: str | None, domain_rules: Sequence[str],
                           json_shape: str) -> str
# = persona + preamble + "RULES." + shared index-grounding rule + domain_rules +
#   "N. Output strict JSON of the form: {json_shape}. No markdown fences, no extra keys, no commentary outside the JSON."

def build_synthesis_request(*, system_prompt: str, candidates_header: str, rendered_candidates: str,
                            extra_user_block: str | None, model_name: str, max_tokens: int) -> LLMRequest
# two-turn shape, system cache_ttl="5m", user "…\n\nRespond with the strict JSON object as instructed.",
# reasoning_effort="none", prompt_cache_key=None

def ground_indices[E, C](entries: Sequence[E], candidates: Sequence[C], *, index_of: Callable[[E], int],
                         policy: Literal["drop", "reject"]) -> list[tuple[E, C]] | None
# THE invariant: 0 <= index_of(e) < len(candidates); "reject" → None (oracle), "drop" → skip (LI, unit).
# Phase cover (oracle), ordinal dedupe/role coercion (LI), dense reordinaling (unit) stay caller-side.

async def run_structured_synthesis(*, llm, request, schema,
                                   validate: Callable[[T], str | None] | None = None) -> SynthesisResult[T]
# ONE bounded repair round: on StructuredSynthesisError OR validate(value) returning a reason,
# re-issue once with appended assistant(bad output) + user("Your previous response was invalid: {reason}. …")
# turns; second failure raises/returns as today. SynthesisResult.usage = summed across attempts;
# SynthesisResult.attempts: int added for the ledger.
```

Oracle/LI/unit move their prompts verbatim into `build_synthesis_prompt` parameters and their per-candidate render lambdas into `build_synthesis_request` callers; oracle passes its semantic validator via `validate` (so its dominant failure class — semantic rejection — gets the repair round too). Timeouts unchanged (oracle 45s, LI 90s, unit 45s); **oracle lease 120→300s** (registry) to fit the worst-case repair round.

### 5.4 Stream plane

- Paths: `/stream/chat-runs/{run_id}/events`, `/stream/oracle-readings/{reading_id}/events`, `/stream/library-intelligence/{revision_id}/events`, `/stream/media/{media_id}/events`. `is_stream_path` becomes `path.startswith("/stream/")` (stream_paths.py). The `routes/__init__.py:107-111` ordering comment dissolves.
- One generic cursor route built from a per-kind table (literal path segments, not a catch-all param):

```python
@dataclass(frozen=True)
class CursorStreamKind:
    path: str                                   # "/stream/chat-runs/{run_id}/events"
    run_kind: run_kit.RunStreamKind
    assert_viewer: Callable[[Session, UUID, UUID], None]
    read_after: Callable[[Session, UUID, UUID, int], tuple[Sequence[RunEventLike], bool]]  # viewer always threaded
```

Oracle/LI reads gain the viewer param (normalize on always-pass-viewer). Media keeps its own thin handler over `tail_snapshot_stream`, moved under the prefix. Gone semantics unchanged (chat/media raise `STREAM_GONE_CODES`; oracle/LI missing⇒terminal).
- **Normalized done grammar.** `done` payload everywhere is `{status: <kind terminal status>, error_code: str | null, …kind extras}`: chat keeps `usage`/`final_chars`; LI becomes `{status: "ready"|"failed", error_code, revision_id}`; oracle becomes `{status: "complete"|"failed", error_code}` and **the `error` event type is deleted** — oracle failures route through `mark_terminal` (which now also writes `failed_at`/`error_code`/`error_detail`). Pydantic payload schemas added for oracle/LI done (chat already has one). Migration 0146 re-cuts `ck_oracle_reading_events_type` without `'error'` using the 0142 DELETE-then-tighten pattern.
- Oracle's dead create-response `stream` block (token minted, never consumed, RPM-guard-skipping — routes/oracle.py:36-48, schemas/oracle.py:19-34, FE types.ts:9-14) is deleted.

### 5.5 Frontend generation-run client

`sseClientDirect` extensions (lib/api/sse-client.ts):
1. `initialToken?: string` — deletes the four identical first-token closures.
2. `decode(type, data, id)` — id passed through; deletes oracle's `nextEventId` smuggling.
3. `onReconnect?: (attempt: number) => Promise<"continue" | "stop">` — fired before each backoff; chat's reconcile GET + `replayDeltaCharsToSkip` + terminal-while-disconnected detection move inside; `maxReconnects: 0` trick deleted.
4. Clean-EOF-without-terminal now reconnects (counts against `maxReconnects`) — fixes the silent oracle/LI/media stall.
5. HTTP-error policy: 401 + 5xx + network reconnect with backoff; 400/403/404 fatal.
6. `backoff?: {baseMs, maxMs, jitterMs}` — chat keeps its 1s→8s±250ms profile.

**`apps/web/src/lib/api/useGenerationRun.ts`** — one hook over the extended client:

```ts
useGenerationRun<TEvent>(cfg: {
  kind: "chat-runs" | "oracle-readings" | "library-intelligence" | "media";
  id: string | null;                       // null = idle
  decode: (type: string, data: unknown, id: string) => TEvent;
  isTerminal: (e: TEvent) => boolean;      // unified: type === "done"
  onEvent: (e: TEvent) => void;
  resume?: { lastEventId?: string };       // oracle seq-cursor, chat Last-Event-ID; LI/media none
  reconnect?: { max?: number; backoff?: …; onReconnect?: … };
}): { phase: "idle"|"connecting"|"streaming"|"done"|"failed"; retry(): void; abort(): void }
```

Per-surface residue: chat keeps `useChatRunTail` as the multi-run layer (registry/visibility/temp-id/fork machinery) **on top of** `useGenerationRun`, preserving the module path (three test files mock `@/components/chat/useChatRunTail`); oracle deletes `streamEventsWithReconnect` wholesale and keeps `applyEvent` + `stateFromDetail` (its `done` case parses `{status, error_code}`; `isTerminal` drops `|| error`); LI keeps its 3-event table, reports `event.data.revision_id` (not the subscribed id), and moves `idempotency_key` to the `Idempotency-Key` **header** convention (BFF already forwards it); media keeps its snapshot parser. Decoder guard kit unifies on `lib/api/sse/guards.ts` (the five `optionalString` variants collapse). Oracle create adopts an Idempotency-Key header (server: oracle gains the same normalized-key + `(user_id, idempotency_key)` partial-unique replay the LI generate path uses).

### 5.6 Citations — finishing the render contract

1. **`build_citation_outs_for_message(db, *, assistant_message_id) -> list[CitationOut]`** in `retrieval_citation.py` beside the revision twin: reads selected `citation_ordinal IS NOT NULL` rows (the `_emit_citation_index` query + `locator, deep_link, source_title, section_label, exact_snippet, source_id` columns), maps target per the FE rule it replaces (`evidence_span` → `content_chunk` → media), `role="context"`, batched variant for message pages. Type widening required first: `CitationTargetType` gains `"web_result"`, `CitationTargetRef.id: UUID | str`, `CitationSnapshot.summary_md: str | None = None` (populated for media targets via `media_intelligence.get_ready_summaries`).
2. **Wire:** `MessageOut.citations: list[CitationOut] = []` (populated for assistant messages in `message_to_out` + the list path + `chat_run_response.py` + `conversation_branches.py:1113`); the `citation_index` SSE payload becomes `{assistant_message_id, citations: CitationOut[]}` (event type name kept; chat_run_events CHECK untouched). FE deletes `messageToCitationOuts`/`citationIndexFromBlocks`/`targetRefFromRetrieval`/`retrievalBlocksOf` (citations.ts:17-94), the `handleCitationIndex` retrieval-rebuild, `ConversationMessage.citation_index`, and the 526-line `lib/api/sse/citations.ts` validator (replaced by a CitationOut guard); `AssistantEvidenceDisclosure` consumes `message.citations.map(toReaderCitationData)`.
3. **web_search fold:** `RetrievalCitation.result_ref_json()` gains the `web_result` pass-through branch; `persist_web_search_run` builds `RetrievalCitation(result_type="web_result", source_id=cit.result_ref, snippet=…, deep_link=cit.url, locator=cit.locator_json(), context_ref=…, result_ref=cit.to_json(), score=1/max(rank,1))` → `insert_retrieval_row(…, scope="public_web", retrieval_status="web_result")`; the hand-rolled select/update/insert SQL (web_search.py:356-431) is deleted. Pinned behavior deltas: `scope` becomes explicit `public_web` (was default `'all'`); `_UPDATE_RETRIEVAL`'s `citation_ordinal` COALESCE now applies to web rows.
4. **Oracle passages join the contract (read-model only, no storage change):** for `source_kind="user_media"` AND `source["owner_kind"]=="media"` AND `locator["evidence_span_id"]` present, mint `CitationOut` via `build_evidence_span_citation_target` (`target_ref={type:"evidence_span"}`, canonical deep link); ordinal = phase order (descent 1, ordeal 2, ascent 3). Exposed as `OracleReadingPassageOut.citation: CitationOut | None` and on the `passage` SSE payload. Page-owned chunks and missing spans ⇒ `citation=None`; public-domain passages unchanged. FE renders a `ReaderCitation` chip beside `locator_label` for passages with a citation; folio typography untouched.
5. **`oracle_reading:` scheme:** added to `RESOURCE_URI_SCHEMES` (readable, not a search scope); loader modeled on the LI artifact loader (ownership = `user_id == viewer_id`), body = question + motto + argument + per-phase passages + interpretation; `read_resource` branch mirrors the LI non-citable branch. To make the body loadable, `oracle_readings.interpretation_text` becomes a column (written at generation; today the interpretation exists only in the `delta` event payload — events are replay, not canonical store). FE: "Chat about this reading" action on the reading page → `POST /api/conversations {initial_references: ["oracle_reading:{id}"]}` → navigate.
6. **revision_id stamp (LI spec §6.6 debt):** the artifact loader SELECT adds `r.id AS revision_id`; `LoadedResource`/`ResolvedResource` carry it; `_build_resources_block` appends `{"type": "conversation_reference", "resource_uri": uri, "revision_id": "<uuid>"}` elements into the assembly ledger's `included_context_refs` (an **add** — resources are not in that list today). No migration; queryable via JSONB containment.

### 5.7 Ops floor

- Compose logging anchor (`deploy/hetzner/docker-compose.yml:19-23`) → `driver: journald` + `options: {tag: "{{.Name}}"}` (one edit, four services; `docker compose logs` read-back keeps every deployment.md recipe working). Host persistence made explicit: `/etc/systemd/journald.conf.d/10-nexus.conf` (`Storage=persistent`, `SystemMaxUse=2G`) via `cloud-init.yml` write_files + a documented one-time step for the existing VPS.
- Allowlist: append `,page_reindex_job` (after `media_unit_build`) in all six lockstep places (§1.2). New guard: `USER_FACING_JOB_KINDS` tuple in `jobs/registry.py` (every non-periodic kind with user-visible work) + a test asserting `USER_FACING_JOB_KINDS ⊆ DEFAULT_WORKER_ALLOWED_JOB_KINDS` — the class of bug becomes unrepresentable.
- deployment.md: journald note, ledger-query recipes (`select * from llm_calls order by created_at desc limit 20`), updated log instructions.

---

## 6. Capability contracts (typed)

### 6.1 `llm_calls` (new table; sole writer `services/llm_ledger.py`)

```sql
llm_calls (
  id uuid PK default gen_random_uuid(),
  owner_kind text NOT NULL CHECK (owner_kind IN ('chat_run','oracle_reading','li_revision','media_summary','media_enrichment')),
  owner_id uuid NOT NULL,
  call_seq int NOT NULL CHECK (call_seq >= 1),            -- per-owner provider-call ordinal (tool iterations, repair attempts, failover attempts)
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','gemini','deepseek')),
  model_name text NOT NULL,
  llm_operation text NOT NULL,                            -- 'chat_send','oracle_reading','li_reduce','media_unit','metadata_enrichment'
  streaming boolean NOT NULL,
  reasoning_effort text NOT NULL,
  key_mode_requested text NOT NULL, key_mode_used text NOT NULL,
  input_tokens int NULL CHECK (>=0), output_tokens int NULL, total_tokens int NULL, reasoning_tokens int NULL,
  cache_write_input_tokens int NULL, cache_read_input_tokens int NULL, cached_input_tokens int NULL,
  latency_ms int NULL, error_class text NULL, error_detail text NULL,
  provider_request_id text NULL, provider_usage jsonb NULL CHECK (jsonb object),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_kind, owner_id, call_seq)
);
CREATE INDEX ix_llm_calls_owner ON llm_calls (owner_kind, owner_id);
```

`message_llm` is dropped; its rows migrate via `JOIN chat_runs ON assistant_message_id` → `(owner_kind='chat_run', owner_id=run_id, call_seq=1)`. Change list (verified zero other readers): `MessageLLM` model + `Message.llm_metadata` relationship; `chat_run_finalize.py:176-197` writer; `conversations.py:862` raw delete; `chat_run_usage.usage_tokens` docstring; pins in `test_openai_reasoning_contracts.py:314-337` and `test_migrations.py:2555,8476-8493`.

### 6.2 Run-parent error floor (migration 0145 columns)

`chat_runs.error_detail text NULL`; `library_intelligence_artifact_revisions.error_code text NULL, error_detail text NULL`; `media_summaries.error_code text NULL, error_detail text NULL`; `oracle_readings.error_message` **renamed** `error_detail` (semantics: operator detail, not user copy — FE never rendered it); `oracle_readings.interpretation_text text NULL`; `oracle_readings.generator_model_id` **dropped** (zero writers/readers; `llm_calls` supersedes). `run_kit.mark_terminal(db, *, stream, status, done_payload, error_code=None, error_detail=None)` is the only writer of the error pair on run parents.

### 6.3 Worker harness

```python
# python/nexus/tasks/llm_task.py
def run_llm_task[R](spec: LlmTaskSpec, handler, *, on_worker_exception=None) -> R          # §5.2
# python/nexus/db/retries.py
def retry_serializable[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T
# python/nexus/llm_catalog.py
def require_catalog_model(provider: str, model_name: str) -> ModelCatalogEntry              # raises defect
```

Task modules shrink to: parse payload → `run_llm_task(SPEC, handler, on_worker_exception=…)`. Registry policies unchanged except `oracle_reading_generate.lease_seconds: 120 → 300`.

### 6.4 Stream route table

`api/routes/stream.py` keeps three (now four) thin decorated functions delegating to one `make_cursor_stream_response(kind: CursorStreamKind, …)` factory + the media snapshot handler; `_parse_last_event_id`, headers, threadpool offload, `get_stream_viewer` shared verbatim. `stream_paths.is_stream_path` = one prefix check.

### 6.5 Frontend

`sseClientDirect` extended args (§5.5); `useGenerationRun` (§5.5); `lib/api/sse/guards.ts` is the only guard kit. Deleted: chat's private retry loop + token closure; oracle's `streamEventsWithReconnect` + `OracleStreamParseError` + id smuggling; LI's token closure + `subscribedRevisionRef`; media's token closure; `lib/api/sse/citations.ts`.

### 6.6 Citations

`build_citation_outs_for_message` (+ batched `build_citation_outs_for_messages`), `CitationTargetType += "web_result"`, `CitationTargetRef.id: UUID | str`, `CitationSnapshot.summary_md`; `MessageOut.citations`; `ChatRunCitationIndexEventPayload` → `{assistant_message_id, citations: list[CitationOut]}`; `OracleReadingPassageOut.citation: CitationOut | None`; `ResourceUriScheme += "oracle_reading"`; `LoadedResource.revision_id: UUID | None`.

---

## 7. API design (wire-visible deltas)

| Surface | Change |
|---|---|
| `GET /stream/chat-runs/{id}/events`, `GET /stream/media/{id}/events` | renamed (old paths removed, 404) |
| oracle/LI stream paths | unchanged |
| `done` SSE payload | normalized `{status, error_code, …}` per kind (§5.4); oracle `error` event type removed |
| `citation_index` SSE payload | `{assistant_message_id, citations: CitationOut[]}` |
| `GET /conversations/{id}/messages` | `MessageOut.citations: CitationOut[]` added |
| `POST /oracle/readings` | response loses the dead `stream` block; gains `Idempotency-Key` header support (replay returns the existing reading) |
| `GET /oracle/readings/{id}` | passages gain `citation: CitationOut|null`; detail gains nothing else (events replay unchanged minus `error`) |
| `POST /libraries/{id}/intelligence/generate` | `idempotency_key` moves from body to `Idempotency-Key` header |
| `POST /conversations` | accepts `oracle_reading:{uuid}` in `initial_references` |
| `/health` | unchanged (`task_contract_version` already covers registry policy; allowlist guard is a test) |

BFF: no new routes; the header already forwards (`proxy.ts:629-631`).

---

## 8. Migration plan (hard cutover)

**0145_llm_call_ledger_and_error_floor.py** — create `llm_calls` (§6.1); INSERT-SELECT migrate `message_llm` rows via `chat_runs.assistant_message_id` join; drop `message_llm`; add error-floor columns + `oracle_readings.interpretation_text` (backfill from each reading's `delta` event payload where present); rename `oracle_readings.error_message → error_detail`; drop `oracle_readings.generator_model_id`.

**0146_oracle_done_normalization.py** — DELETE `oracle_reading_events` rows with `event_type='error'` (0142 pattern; prod has 0 readings, dev/test DBs may have rows), then replace `ck_oracle_reading_events_type` with the 8-type list (`meta,bind,argument,plate,passage,delta,omens,done`).

Deploy order: bump `llm-calling` rev (pyproject + uv.lock) → migrations → backend deploy → frontend deploys on push. Worker env: update `WORKER_ALLOWED_JOB_KINDS` in `deploy/env/env-prod-worker` before `sync-env.sh` (it dies on mismatch with the new SAFE literal). One-time VPS step: journald drop-in + `systemctl restart systemd-journald` + `docker compose up -d --force-recreate` (logging driver applies on recreate).

---

## 9. Frontend design

- `useGenerationRun` + extended `sseClientDirect` (§5.5). Chat: `useChatRunTail` becomes the multi-run orchestration layer over the hook (same module path, same public API, mock seam preserved); reconcile/replay-skip logic moves into `onReconnect`. Oracle: pane keeps reducer + hydration seed; stream effect becomes a `useGenerationRun` call; failure copy stays `oracleFailureFeedback` keyed on `done.error_code`. LI: hook body shrinks to decode table + state pair; pane unchanged. Media: `useMediaProcessingStatus` keeps its API, delegates transport.
- Citations: `AssistantEvidenceDisclosure` reads `message.citations`; live updates via the reshaped `citation_index` event; `toReaderCitationData`/`MarkdownMessage`/`ReaderCitation` untouched. Oracle passage chips: render `<ReaderCitation>` beside `locator_label` when `passage.citation` present; activation = existing reader-pulse dispatch (LibraryIntelligencePane.tsx:120-144 is the template).
- New oracle action: "Chat about this reading" (header action row, precedent OracleReadingPaneBody.tsx:752-779).
- Feedback copy: `apiErrorTitle` if-chain moves to `lib/errors/errorCodeMessages.ts` (data, not code) — unchanged strings.

---

## 10. Composition with existing systems

- **jobs**: harness runs inside the existing claim/lease/heartbeat envelope; dead-letter contracts unchanged; `task_contract_version` changes only via the oracle lease bump (expected; the health pin test updates).
- **BYOK/billing**: background surfaces now respect `can_use_platform_llm` entitlements and consume the monthly budget — single-user today, correct-by-construction if sharing ever returns.
- **search/app_search**: untouched; web_search fold changes only the retrieval persistence writer.
- **conversation_references / context assembly**: gains one scheme + one ledger element shape; `<resources>` rendering, citability rules (`_CITABLE_RESULT_TYPE` — oracle_reading is NOT citable, like LI artifacts), admission gates all unchanged.
- **fixtures/e2e**: `RealMediaFixtureLLMRouter` now serves all kinds — fixture-mode oracle/LI runs stop touching real providers; fixture router gains canned structured-synthesis responses for the three schemas.
- **provenance graph (future)**: `llm_calls` + `included_context_refs` revision stamps are inputs it can later consume; nothing here forecloses §20.

---

## 11. Consolidation / dedup map (what gets deleted)

| Deleted | Replaced by |
|---|---|
| 5 task-body envelopes (`tasks/*.py` bodies) | `run_llm_task` |
| `set_rate_limiter` in `tasks/chat_run.py` | worker-startup install |
| `_ensure_oracle_platform_llm_available`, raw `settings.anthropic_api_key` reads ×3, stale enrichment model defaults | `require_catalog_model` + `resolve_api_key` |
| `message_llm` + `finalize_run` ledger block + `dummy_resolved_key` | `llm_calls` + `llm_ledger` |
| `llm.request.*` field sets ×3 | `observed_llm_call` |
| `_oracle_failure_message` + 7 constants + `_oracle_event_out` rewrite + `oracle_readings.error_message` semantics | FE copy + `error_detail` |
| `fail_reading/artifact/media_unit_after_worker_exception` trio | one helper + `mark_terminal(error_code=…)` |
| `_estimate_llm_request_tokens`, `_usage_total_tokens`, `chat_runs.py:1126` estimator | `prompt_budget.estimate_tokens` + `chat_run_usage.usage_tokens` |
| 9 SERIALIZABLE retry loops | `retry_serializable` |
| 3 synthesis prompt scaffolds + 3 request builders + 3 grounding maps' bounds checks | `build_synthesis_prompt/request` + `ground_indices` |
| `_unread_stream_api_error_code` + call site | llm-calling router catch widening |
| `RateLimiter.charge_token_budget` (dead) | — |
| 4-arm `is_stream_path` | prefix check |
| 3 near-identical stream handlers' bodies | `make_cursor_stream_response` + kind table |
| oracle create-response `stream` block + `OracleStreamConnectionOut` | — |
| oracle `error` event type + FE error-event terminal | normalized `done` |
| FE: 4 token closures, chat private reconnect loop, `streamEventsWithReconnect`, `lib/api/sse/citations.ts` (526 lines), `messageToCitationOuts` family, `citation_index` rebuild, 5 `optionalString` variants | extended client + `useGenerationRun` + server CitationOut |
| web_search retrieval SQL (web_search.py:356-431) | `insert_retrieval_row` |

---

## 12. Slices (ordered; each independently reviewable)

- **S0 — llm-calling reasoning continuity.** External repo: `provider_items`/`provider_metadata`/`provider_item` types; per-provider capture/replay (§5.1); gemini thought-skip + signature echo + real call ids; router catch widening. Nexus: rev bump, chat-loop capture (chat_runs.py:1263-1269), `"default"` added to every catalog entry's reasoning_modes, delete `_unread_stream_api_error_code`, add `QUOTA_EXCEEDED` mapping. Gated live-provider matrix test (each enabled provider × {default, max-or-highest} × forced tool call → continuation completes).
- **S1 — prod floor.** `page_reindex_job` into the six allowlist sites + `USER_FACING_JOB_KINDS ⊆ allowlist` guard test; journald logging (compose anchor + cloud-init + deployment.md + one-time VPS step); worker-startup rate-limiter install (fixes the oracle landmine independently of S3).
- **S2 — ledger + error floor.** Migration 0145; `run_kit.mark_terminal(error_code, error_detail)`; `llm_ledger` (`llm_calls` writer + `observed_llm_call`); chat finalize/dead-letter/boundary paths write detail + ledger rows; oracle/LI/unit/enrich terminal writes adopt the floor (no behavioral change yet beyond persistence).
- **S3 — worker harness + key/budget spine.** `run_llm_task` + five task rewrites; `require_catalog_model`; `resolve_api_key` everywhere + per-kind budget envelope + one estimator; enrichment models → catalog-valid; fixture router for all kinds; `retry_serializable` adoption (all nine sites); delete the trio via the shared fail helper; delete `charge_token_budget`.
- **S4 — synthesis scaffold.** `build_synthesis_prompt/request` + `ground_indices` + one repair round with `validate` hook + summed usage; oracle/LI/unit migrate verbatim-prompt; oracle lease 120→300; `test_structured_synthesis` pins updated.
- **S5 — stream plane.** Path renames + prefix predicate + generic cursor factory + viewer-threaded reads; oracle done-normalization (migration 0146, `_fail` via `mark_terminal`, FE terminal/`done` parsing); LI done payload `{status, error_code, revision_id}`; delete oracle dead `stream` payload; oracle + LI idempotency-key header.
- **S6 — FE client.** `sseClientDirect` extensions; `useGenerationRun`; migrate chat/oracle/LI/media; guard-kit unification; delete the per-surface plumbing (§11).
- **S7 — citations.** Type widening; `build_citation_outs_for_message` (+batched) + `MessageOut.citations` + reshaped `citation_index`; FE dual-source deletion; web_search fold; oracle passage CitationOut + chips; `oracle_reading:` scheme + loader + `interpretation_text` + chat-about-reading action; revision_id stamp.
- **S8 — docs + gates.** Fill `docs/modules/llms.md` (llm-calling contract, catalog, BYOK, ledger, harness), `docs/modules/jobs.md`, `docs/modules/byok.md`; fix architecture.md §7.3 catalog/dead-letter/`failed_result_statuses` staleness + `:491` module path + add the harness section; deployment.md ledger/log recipes; wire all §14 gates into CI.

---

## 13. Acceptance criteria

- **AC-1 (reasoning continuity).** Live-gated matrix: for each enabled provider, a reasoning-enabled chat run that triggers `app_search` completes with final text; unit tests assert captured provider items are replayed in order (openai before function_call items; anthropic leading the assistant content; gemini signature echoed); gemini thought-summary text never appears in `delta` events.
- **AC-2 (default everywhere).** Every `MODEL_CATALOG` entry's `reasoning_modes` contains `"default"`; FE default send passes validation for all nine models.
- **AC-3 (ledger on every terminal path).** For each of the five surfaces, forced success / provider-error / boundary-exception each leave ≥1 `llm_calls` row with `owner_kind/owner_id`, `error_class`+`error_detail` on failure, and the run parent carries `error_code`+`error_detail`; a chat run with N tool iterations leaves N rows (call_seq 1..N); a repaired synthesis leaves 2 rows and summed usage.
- **AC-4 (one envelope).** No `asyncio.new_event_loop`, `httpx.AsyncClient(`, or `LLMRouter(` constructions outside `tasks/llm_task.py` (+ the fixture router module); worker startup installs the rate limiter; an oracle job on a fresh worker passes rate-limit checks.
- **AC-5 (one key spine).** No `settings.anthropic_api_key`/`settings.openai_api_key`-style reads outside `llm_catalog`/`api_key_resolver`; every surface resolves via `resolve_api_key`; enrichment model names exist in `MODEL_CATALOG`.
- **AC-6 (allowlist).** `page_reindex_job` in all six lockstep sites; the `USER_FACING_JOB_KINDS ⊆ DEFAULT_WORKER_ALLOWED_JOB_KINDS` test exists and passes; a note edit in a prod-shaped env gets its index built by the worker.
- **AC-7 (log retention).** Compose uses journald for all four services; a `--force-recreate` preserves prior `docker logs` output (manual verify documented in deployment.md).
- **AC-8 (one stream plane).** All four stream URLs start `/stream/`; `is_stream_path` is one prefix check; FE builders updated; the three cursor handlers share one factory; oracle emits no `error` events (DB CHECK forbids); every surface's `done` carries `{status, error_code}`.
- **AC-9 (one FE client).** Exactly one `fetchStreamToken` flow (inside the client); zero `maxReconnects: 0`; chat reconnect-reconcile runs via `onReconnect`; clean-EOF reconnects everywhere; LI/oracle/chat all consume `useGenerationRun`.
- **AC-10 (citations server-built).** `GET …/messages` returns `citations`; the FE builds no CitationOut from retrievals/blocks (`messageToCitationOuts` gone); web_search rows flow through `insert_retrieval_row`; oracle user-media passages render working deep links; `oracle_reading:{id}` attaches and reads in chat; a chat run over an LI artifact stamps the consumed `revision_id` in `included_context_refs`.
- **AC-11 (scaffold).** The three synthesis call sites contain no RULES-closing/“Respond with the strict JSON object” literals of their own; bounds checking flows through `ground_indices`; one repair round observable in `llm_calls` (attempts=2 on induced parse failure).
- **AC-12 (untouched stores intact).** `message_retrievals`, `conversation_references`, `oracle_reading_passages`, `object_links` schemas + consumers unchanged; chat tool loop, LI promote, oracle product semantics behavior-preserved (full suites green).

## 14. Negative gates (grep/CI-assertable)

- No `message_llm` outside migrations; no `MessageLLM` symbol.
- No `asyncio.new_event_loop|run_until_complete` under `python/nexus/tasks/` except `llm_task.py`.
- No `settings.anthropic_api_key|settings.openai_api_key|settings.gemini_api_key|settings.deepseek_api_key` outside `llm_catalog.py`/`api_key_resolver.py`/config.
- No `_SERIALIZABLE_RETRIES|for attempt in range` + `is_serialization_failure` outside `db/retries.py`.
- No `"No markdown fences, no extra keys"`/`"Respond with the strict JSON object"` literals outside `structured_synthesis.py`.
- No `_oracle_failure_message|_oracle_event_out|ORACLE_LLM_CONFIGURATION_MESSAGE` symbols; no `'error'` in the oracle event CHECK or writers.
- No `/chat-runs/` + `/events` or `/media/` + `/events` path literals (BE routes, FE builders, tests) — only `/stream/...`.
- No `startswith("/chat-runs/")` in `stream_paths.py` (file is a one-line prefix check + docstring).
- FE: no `fetchStreamToken` call sites outside `sse-client.ts`; no `messageToCitationOuts|citationIndexFromBlocks|targetRefFromRetrieval`; no `lib/api/sse/citations.ts`; no `streamEventsWithReconnect`; ≤1 `optionalString` definition.
- No `INSERT INTO message_retrievals` SQL outside `retrieval_citation.py`.
- No `charge_token_budget`; no `_unread_stream_api_error_code`; no `generator_model_id`.
- **Must REMAIN (anti-over-deletion):** `message_retrievals`, `conversation_references`, `oracle_reading_passages`, `object_links` tables + consumers; `run_kit.append_event`/`mark_terminal` as the only event-append/terminal owners; `tail_cursor_stream` AND `tail_snapshot_stream` (two tailers stay); `useChatRunTail` module path + its three vi.mock seams; `ERROR_CODE_TO_MESSAGE` (chat's user-copy map); `prompt_budget.estimate_tokens`; LI/unit char-budget constants (input truncation is domain, not estimation).

## 15. Rules & invariants

- **Sole writers:** `llm_calls` ← `llm_ledger.py`; run-parent `error_code`/`error_detail` ← `run_kit.mark_terminal`; `message_retrievals` ← `retrieval_citation.insert_retrieval_row`; stream-path predicate ← `stream_paths.py`.
- **Harness owns mechanics, surfaces own domain:** prompts, schemas, semantic validation, finalization writes stay per-feature (run_kit docstring doctrine).
- **Opaque means opaque:** `provider_items`/`provider_metadata` are never parsed, transformed, persisted, or logged with content by nexus — captured, held in-memory for the live loop, replayed verbatim, dropped. (Worker retry re-executes from scratch; no persistence needed.)
- **Errors vs defects:** unclassified exceptions reaching a run boundary are defects — they now leave `error_detail` + a ledger row + a journald traceback; observing one triggers a code change (errors.md), not a new UI state.
- **Every provider call is observable:** no `generate`/`generate_stream` call outside `observed_llm_call`.
- **Transport stays a dumb pipe:** renames change addresses, never lifecycle; the run is still worker-owned, SSE still tails persisted rows.

## 16. Key decisions (log)

1. **Fix reasoning continuity in `llm-calling` with opaque provider items**, not nexus-side request surgery or `previous_response_id` statefulness — stateless replay + `store:false` keeps the client provider-symmetric and nexus provider-blind.
2. **The bug class is all-provider** — scope S0 to all four providers (anthropic/gemini verified same-class), not the OpenAI incident alone.
3. **`"default"` reasoning becomes universally valid** (catalog change) rather than FE filtering — "default = provider default" is the honest contract.
4. **Generalize `message_llm` → polymorphic `llm_calls`** (0143 owner pattern), one row **per provider call** — fixes last-write-wins usage, gives LI/unit/enrich a home, has zero readers to break; historical rows migrate via the assistant-message join.
5. **`error_detail` is operator-facing everywhere; user copy is chat-BE + FE only.** Oracle's BE message map dies (FE already owns its copy); `error_message` renamed to `error_detail`.
6. **Rate limiter installs at worker startup**, not per task — kills the fresh-worker oracle failure and gives every kind a working limiter.
7. **Background surfaces use `resolve_api_key(mode="auto")` attributed to the owning user** — BYOK + entitlements uniformly; oracle's platform-only pre-check deleted.
8. **One repair round in `run_structured_synthesis`, with a caller `validate` hook** — bounded (retries.md), covers oracle's dominant *semantic* failure class, usage summed; not a verifier revival (single retry, model output still trusted).
9. **Oracle failures normalize onto `done {status:"failed", error_code}`** and the `error` event type is deleted — one terminal grammar across kinds; `failed_at`/`error_code` stamping moves into `mark_terminal`'s dispatch to satisfy the existing CHECK.
10. **Chat + media move under `/stream/`** (docs already claim it; architecture.md:74,118); predicate becomes a prefix check; generic-route table keeps literal segments (no catch-all param).
11. **`useGenerationRun` is transport+lifecycle only**; chat's multi-run registry/visibility/fork machinery stays a chat layer on top, same module path (preserves the vi.mock seam in 3 test files).
12. **Chat `CitationOut` is built backend-side and shipped both on the wire (`MessageOut.citations`) and in the reshaped `citation_index` event** — replay and live stay citation-complete; the FE dual-source reconstruction + 526-line validator die. (Refetch-on-done rejected: regresses replay.)
13. **Oracle citations are read-model only** — `oracle_reading_passages` storage untouched (must-REMAIN); user-media passages mint CitationOut, public-domain stays typographic; ordinal = phase order.
14. **`oracle_reading:` scheme + `interpretation_text` column** — readings become chattable through the existing reference machinery; the interpretation gets a canonical column (events are replay, not store).
15. **revision_id stamps into `included_context_refs`** (new element shape) — no migration, insert-once free via `persist_prompt_assembly`; a dedicated table only if "which chats read revision X" ever needs an index.
16. **journald is the only retention-correct driver** (json-file and local both die with the container); host persistence made explicit in cloud-init + a one-time step.
17. **metadata enrichment keeps its provider-native `StructuredOutputSpec` + failover transport** — different contract (provider-parsed JSON, multi-provider loop); it adopts only envelope/keys/ledger/catalog.
18. **Estimator unification on `prompt_budget.estimate_tokens`** for reservations (over-estimating formula, full prompt text) — deletes three `//4` variants; char *budgets* (LI/unit truncation) are domain constants and stay.

## 17. Risks & open questions

- **R1 — `xhigh` validity per model.** The `max → xhigh` mapping may not be accepted by every OpenAI/anthropic model tier; the live matrix (AC-1) is the gate, with per-model effort clamping in `llm-calling` as the fallback.
- **R2 — two-repo lockstep.** S0 spans `llm-calling` + nexus; the pin (`pyproject` rev + `uv.lock`) must move in the same PR as the chat-loop capture, or the live matrix fails. Mitigation: land llm-calling first (additive fields are backward-compatible for old nexus), then nexus.
- **R3 — repair-round wall-clock vs leases.** Worst case oracle 45×2s + retrieval inside a 300s lease (bumped), LI 90×2s + inline unit builds inside 900s — heartbeats cover, but a pathological unit backlog + repair could approach the lease; the reduce already heartbeats via the worker thread. Watch `llm_calls.latency_ms`.
- **R4 — anthropic thinking + tool loop interplay.** Anthropic forbids structured_output with thinking (anthropic.py:239-247) — irrelevant for synthesis (`reasoning_effort="none"`), but chat with thinking + forced tool_choice needs the live matrix to confirm replay ordering constraints ("thinking blocks lead the assistant turn") hold for parallel tool_use blocks.
- **R5 — `/stream/*` middleware bypass widening.** Any unrouted `/stream/foo` now skips Supabase auth and 404s unauthenticated (no data exposure; behavior change). One test pins it.
- **R6 — citation_index payload size.** CitationOut[] with snapshots is heavier than the old `{n, …, result}` entries; replay reads stay bounded by per-run citation counts (≤ ~20). Acceptable; revisit only if event rows near the 256KB FE cap.
- **Open — per-message usage UI** (deliberately N5): `llm_calls` makes it trivial later.
- **Open — oracle Idempotency-Key**: spec'd as new partial-unique on `(user_id, idempotency_key)`; folio allocation keeps its own conflict-retry loop (orthogonal).

## 18. Test plan

- **Unit (llm-calling, in its repo):** per-provider request-body golden tests for replay ordering (reasoning item before fc; thinking blocks lead; thoughtSignature echoed; deepseek strips); stream-parse tests yielding `provider_item` chunks; router classification table incl. ProtocolError/StreamError/TypeError.
- **BE unit/integration (nexus):** harness envelope (fixture swap per kind, boundary writes detail+ledger, rate-limiter present); `resolve_api_key` adoption per surface incl. entitlement failure paths; `llm_calls` row matrix (AC-3) with fake routers; `ground_indices` policy table; repair-round (parse fail → 2 calls; semantic fail via `validate` → 2 calls; success → 1 call — replaces the `calls == 1` pin at `test_structured_synthesis.py:84` semantics); `mark_terminal` error stamping per parent incl. oracle CHECK; allowlist guard test; migration tests for 0145/0146 (ledger move count == old `message_llm` count; oracle error rows deleted; CHECK tightened).
- **Stream:** route-table tests for all four kinds (auth, cursor resume, terminal close, gone semantics) replacing per-path literals in `test_chat_run_stream.py`; oracle failure → single `done {status:"failed"}` (flips `test_oracle.py:1098,1157` from `["error"]` to `["done"]`); prefix-predicate test incl. the unrouted-`/stream/foo` pin.
- **FE (vitest browser project):** extended `sseClientDirect` (initialToken, onReconnect, clean-EOF reconnect, HTTP policy, backoff override); `useGenerationRun` per kind with the real decoders; chat reconcile-via-onReconnect replay-skip; oracle done-payload parsing; LI revision-id-from-event; citations render from `message.citations` (chat) and `passage.citation` (oracle) through the real `MarkdownMessage`; palette/pane suites green (no internal vi.mock beyond the preserved `useChatRunTail` seam).
- **Live-gated (env-keyed, not CI):** AC-1 provider×reasoning×tool matrix; one BYOK-key chat send per provider.
- **E2E:** chat send + citation chip jump; LI generate + chat-on-artifact; oracle reading (fixture router) + chat-on-reading; media ingest status stream — all over the new paths.
- **Smoke (deploy):** existing `make smoke` + one ledger query + `docker logs` survival check after a forced recreate.

## 19. Post-implementation corrections

Reconciles three statements above against what the implementation actually does. The negative gates in `python/tests/test_cutover_negative_gates.py` pin the real shape.

1. **`lib/api/sse/citations.ts` is KEPT, not deleted.** The deletes in §5.6.2, §6.5, the §11 table, and the §14 gate conflated two distinct things: the file `lib/api/sse/citations.ts` — which **survives** as the validator for the `retrieval_result` tool-results event (never in §5.6's scope) — and the citation **render-reconstruction function family** (`messageToCitationOuts` / `citationIndexFromBlocks` / `targetRefFromRetrieval` / `retrievalBlocksOf`, formerly `citations.ts:17-94`), which was correctly removed now that `citation_index` ships server-built `CitationOut[]`. `lib/conversations/citations.ts` also survives, reduced to the `toReaderCitationData` render mapper. The §14 FE gate is therefore the render-family-absent check (`test_citation_render_reconstruction_family_absent`), not a "file deleted" check.

2. **`fetchStreamToken` / `sseClientDirect`: one shared opener, not zero call sites.** A single non-hook transport opener — `openGenerationRunStream(kind, id, sseArgs)` in `useGenerationRun.ts` — performs the one token-mint + per-kind URL build + `sseClientDirect` connect. Both the single-id `useGenerationRun` hook and chat's imperative multi-run tailer (`useChatRunTail`) delegate their transport wiring to it; chat keeps its per-run registry/visibility/fork/reconcile orchestration on top, not beside. The transport primitives therefore live in exactly three owners — `lib/api/streamToken.ts` (defines `fetchStreamToken`), `lib/api/sse-client.ts` (defines `sseClientDirect`, mints each reconnect's token), and `lib/api/useGenerationRun.ts` (the opener) — and no oracle/library/media/chat surface re-implements them. AC-9 / §14's "one `fetchStreamToken` flow / no per-surface re-implementation" is satisfied by that single opener — pinned by `test_sse_transport_primitives_have_one_caller_not_per_surface`, which forbids the primitives outside those three owners and asserts the opener references both so the gate cannot go vacuous — not by zero call sites outside `sse-client.ts` (the first mint also yields the stream base URL, so it must run in app code).

3. **`SynthesisResult.attempts` (§5.3) was dropped as dead state.** `SynthesisResult` carries only `value` + `usage`; the repair round is observed in the ledger via the per-owner `llm_calls.call_seq` row count (`MAX(call_seq) + 1` per owner, written on success and failure incl. repair attempts — AC-3 / AC-11), so an `attempts` field on the result had no reader.

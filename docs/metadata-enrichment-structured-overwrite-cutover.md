# Metadata Enrichment Structured-Overwrite Cutover

Status: Implemented.
Scope owner: metadata enrichment pipeline in `python/nexus`, `llm-calling`
provider contract, and document-pane metadata retry surfaces in `apps/web`.
Related: `docs/ingest-retry-metadata.md`, `docs/rules/layers.md`,
`docs/rules/errors.md`, `docs/rules/json-values.md`.
Hard cutover. No legacy gap-fill path, no prompt-only structured-data fallback,
no `force` compatibility branch, no feature flag, and no backward compatibility
for old metadata job payload semantics.

---

## 1. Problem

Metadata enrichment currently behaves like a conservative gap filler. That was
reasonable when deterministic extractors were treated as the source of truth,
but it is wrong for the current product:

- Many deterministic titles, authors, dates, publishers, and descriptions are
  low-quality machine guesses: filenames, site titles, page chrome, bylines from
  wrapper pages, or stale extractor metadata.
- Automatic post-ingest enrichment can skip title replacement because populated
  fields are not considered gaps.
- Manual re-enrichment can overwrite populated fields, but only if the model
  returns locally-parseable JSON.
- The model call is prompt-only. Provider-native schema enforcement is not used.
- The current prompt tells the model to "use known metadata first", which can
  reinforce exactly the low-quality fields enrichment should replace.
- Author enrichment can add `metadata_enrichment` credits while leaving
  semantically duplicate extractor credits in place.

The user-facing symptom is simple: pressing "Re-enrich metadata" does not
reliably produce a better title/author/date, and automatic enrichment often
preserves garbage metadata.

This spec deliberately chooses the one-user prototype solution: make AI
metadata authoritative over existing machine metadata, use provider-native
structured output, and remove the enterprise weight of field provenance, eval
harnesses, bulk repair tooling, and explicit mode semantics.

## 2. Goals

- G1. Automatic post-ingest metadata enrichment overwrites existing machine
  metadata by default.
- G2. Manual "Re-enrich metadata" uses the same overwrite-by-default pipeline;
  it is not a separate force mode.
- G3. Metadata enrichment uses provider-native structured output for every
  enabled metadata provider.
- G4. The metadata model receives current metadata as untrusted hints, not as
  primary truth.
- G5. The prompt describes media-kind semantics clearly enough to avoid common
  wrapper/page/title errors.
- G6. Local validation remains the final application boundary before any
  database mutation.
- G7. All terminal enrichment failures remain soft metadata failures:
  `failure_stage='metadata'`, `processing_status` unchanged.
- G8. Repeated enrichment does not create duplicate author credits.
- G9. The public API and document-pane capability contract stay small:
  `POST /retry {from_stage: "metadata"}` remains the user action.
- G10. The implementation reuses existing service, job, capability, and BFF
  boundaries.

## 3. Non-Goals

- NG1. No field-provenance table.
- NG2. No per-field decision history.
- NG3. No eval harness.
- NG4. No bulk repair, backfill, admin command, or operator CLI.
- NG5. No explicit enrichment mode taxonomy such as `post_ingest`,
  `manual_repair`, or `operator_backfill`.
- NG6. No model picker in the UI.
- NG7. No public web-search loop for metadata enrichment.
- NG8. No scheduled re-enrichment or drift detection.
- NG9. No user metadata editor in this change.
- NG10. No compatibility with prompt-only metadata extraction.
- NG11. No compatibility with old `enrich_metadata` job payload semantics such
  as `force`.
- NG12. No new database tables or migrations.

## 4. Terms

- **Deterministic metadata.** Metadata produced by extractors or source APIs,
  such as PDF embedded title, EPUB OPF creator, Readability title/byline, RSS
  episode data, YouTube oEmbed data, or filename fallback.
- **AI metadata.** Metadata produced by the `enrich_metadata` job.
- **Canonical media metadata.** The read-model columns on `media`: `title`,
  `publisher`, `description`, `published_date`, `language`, plus author
  contributor credits.
- **Structured output.** A provider-native schema-constrained response or tool
  call whose parsed object is returned by `llm-calling` as structured data, not
  recovered by regex from prose.
- **Provider failover.** Trying the next configured structured-output provider
  after a provider error, incomplete response, schema refusal, validation
  failure, or empty payload. This is part of the final path, not a legacy
  fallback.
- **Soft metadata failure.** A failure recorded as `Media.failure_stage =
  metadata` while preserving the media's current `processing_status`.

## 5. Target Behavior

### 5.1 Automatic Post-Ingest Enrichment

Every successful ingest dispatches `enrich_metadata` as it does today.

The job requests all canonical metadata fields every time:

- `title`
- `authors`
- `publisher`
- `description`
- `published_date`
- `language`

If the model returns a valid non-empty value for a field, that value replaces
the current machine-derived value. There is no `no_gaps` skip and no
field-by-field gap gate.

If the model returns `null`, an empty string, an empty authors list, or an
invalid value for a field, that field is ignored. If no fields are accepted, the
job records `E_METADATA_NO_FIELDS`.

### 5.2 Manual Re-Enrich

The document-pane "Re-enrich metadata" action still calls:

```json
{ "from_stage": "metadata" }
```

The backend enqueues the same `enrich_metadata` job shape as automatic ingest.
It does not set `force`. Manual retry is a user-triggered re-run of the same
overwrite-by-default policy.

Manual retry remains useful because it starts a fresh job after a provider
failure, prompt/schema change, model change, or source refresh.

### 5.3 Failure Behavior

Terminal failures record a soft metadata failure:

- `media.failure_stage = FailureStage.metadata`
- `media.last_error_code = <typed metadata/LLM error>`
- `media.last_error_message = <bounded diagnostic string>`
- `media.updated_at = now`
- `media.processing_status` is unchanged

The background job result is `{"status": "failed", ...}` so
`background_jobs.status` becomes `dead` for `enrich_metadata` after its single
attempt.

Successful enrichment clears `failure_stage`, `last_error_code`, and
`last_error_message` only when the previous failure stage was `metadata`.

### 5.4 Media-Kind Semantics

The model must be instructed with a concrete target object:

- `epub`: the saved item is a book or EPUB work. Prefer the work title and
  creators over filename, archive name, or retail wrapper metadata.
- `pdf`: the saved item is a PDF document. Prefer title/author from the first
  page, abstract, heading, or embedded metadata only when it looks like a real
  work title. Replace filename titles.
- `web_article`: the saved item is the primary readable page content. Prefer
  the article/work heading over site title, navigation title, SEO title, or
  generic page title. Publisher is the site/publication, not the author.
- `video`: the saved item is the video. Title is the video title; publisher is
  the channel/platform publisher when available.
- `podcast_episode`: the saved item is the episode. Title is the episode title;
  publisher is the show/podcast. Authors are hosts/creators only when clear.

For pages that primarily mirror a literary work, poem, letter, or essay, the
title should be the work title visible in the content, not the hosting site's
generic title.

### 5.5 Current Metadata Semantics

Current metadata is sent to the model as hints:

- It may be useful if it is clearly bibliographic.
- It must be ignored if it looks like a filename, URL, site name, page chrome,
  generic title, wrapper title, SEO title, or script-contaminated description.
- It never takes priority over clear content evidence.

The old instruction "Use the known metadata first" is removed.

## 6. Final Architecture

```
ingest_pdf / ingest_epub / ingest_web_article / ingest_youtube_video
podcast sync/transcript flows
        │
        ▼
enqueue background job: enrich_metadata
payload: {media_id, request_id?}
        │
        ▼
python/nexus/tasks/enrich_metadata.py
        │
        ├─ load ready-ish Media
        ├─ build clean metadata context
        ├─ request provider-native structured output through llm-calling
        ├─ validate structured object with Pydantic
        ├─ overwrite accepted scalar fields
        ├─ replace/dedupe author credits
        ├─ clear prior metadata failure on success
        └─ record soft metadata failure on terminal failure
```

Layer ownership follows `docs/rules/layers.md`:

- FastAPI routes validate public request shapes and call services.
- Services own business policy.
- Worker tasks own job orchestration and provider calls.
- `llm-calling` owns provider wire formats.
- BFF routes in `apps/web` remain proxies only.
- React components consume API state; they do not infer metadata policy.

## 7. Provider Structured-Output Contract

### 7.1 `llm-calling` Request Shape

`llm_calling.types.LLMRequest` gains one provider-neutral optional field:

```python
@dataclass(frozen=True)
class StructuredOutputSpec:
    name: str
    schema: dict[str, object]
    strict: bool = True

@dataclass(frozen=True)
class LLMRequest:
    model_name: str
    messages: list[Turn]
    max_tokens: int
    temperature: float | None = None
    reasoning_effort: ReasoningEffort = "none"
    prompt_cache_key: str | None = None
    structured_output: StructuredOutputSpec | None = None
```

`LLMResponse` gains:

```python
structured_output: dict[str, object] | None = None
```

For structured requests, callers consume `response.structured_output`. They do
not parse `response.text`.

### 7.2 OpenAI Adapter

The OpenAI Responses API adapter maps `StructuredOutputSpec` to structured
outputs using JSON Schema response formatting. The existing text extraction path
remains for non-structured callers, but metadata enrichment does not use it.

OpenAI structured output docs:
https://developers.openai.com/api/docs/guides/structured-outputs

### 7.3 Gemini Adapter

The Gemini adapter maps `StructuredOutputSpec` to Gemini structured output /
JSON schema generation config. The response is parsed as the provider-returned
JSON object and exposed as `LLMResponse.structured_output`.

Gemini structured output docs:
https://ai.google.dev/gemini-api/docs/structured-output

### 7.4 Anthropic Adapter

The Anthropic adapter maps `StructuredOutputSpec` to a strict forced tool call:

- one tool named from `StructuredOutputSpec.name`
- `input_schema` from `StructuredOutputSpec.schema`
- strict schema enforcement when supported by the API
- `tool_choice` forcing that tool

The adapter parses the `tool_use.input` object into
`LLMResponse.structured_output`.

Anthropic tool-use docs:
https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools

### 7.5 No Prompt-Only Compatibility Path

If a provider cannot satisfy `StructuredOutputSpec`, that provider is not a
valid metadata enrichment provider. The metadata path does not fall back to:

- Markdown stripping
- regex extraction of a JSON object from prose
- "JSON mode" without schema adherence
- natural-language repair prompts
- provider-specific text parsing

Provider failover remains allowed only between structured-output-capable
provider attempts.

## 8. Metadata Schema

The schema source lives beside the metadata domain code in
`python/nexus/services/metadata_enrichment.py`.

Provider-compatible structured output uses required nullable fields:

```json
{
  "title": "string|null",
  "authors": "array<string>|null",
  "publisher": "string|null",
  "description": "string|null",
  "published_date": "string|null",
  "language": "string|null"
}
```

Rules:

- All keys are present in structured provider output.
- Unknown fields are forbidden.
- Scalars may be `null`.
- `authors` may be `null` or a non-empty array of non-empty strings.
- `published_date` is `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`.
- `language` is lowercase ISO 639-1.
- `description` is one or two sentences, capped at 2000 characters.
- `title`, `publisher`, and each author are capped at current database limits.

The application validates with Pydantic after provider parsing. Provider schema
adherence is necessary but not sufficient.

## 9. Prompt And Context Construction

`build_enrichment_prompt` becomes `build_enrichment_context` or equivalent.
It builds a prompt for all fields, not a gap-specific prompt.

Context includes:

- media kind
- requested/canonical/source URLs
- provider and provider id when present
- current title/authors/publisher/date/language/description as untrusted hints
- clean early text sample
- media-kind-specific target rules

Context excludes:

- raw HTML
- script/style content
- uncleaned HTML descriptions
- instructions to omit keys
- instructions to return JSON syntax
- "Use known metadata first"

Text sampling reuses the existing order where possible:

1. `media.plain_text`
2. active `content_chunks`
3. active `content_blocks`
4. `fragments.canonical_text`
5. podcast show notes
6. cleaned description as a last resort

Every sampled text source is whitespace-normalized. Any fallback description is
HTML/script stripped before it is sent to the model.

## 10. Metadata Application Policy

`merge_enrichment(..., gaps, force_overwrite=False)` is deleted or collapsed
into a simpler `apply_enrichment(...)`.

Application rules:

- If `title` is a non-empty valid string, set `media.title`.
- If `publisher` is a non-empty valid string, set `media.publisher`.
- If `description` is a non-empty valid string, set `media.description`.
- If `published_date` is valid, set `media.published_date`.
- If `language` is valid, set `media.language`.
- If `authors` is a non-empty valid list, replace the media's machine-derived
  author credits with `metadata_enrichment` author credits.
- If no fields are accepted, record `E_METADATA_NO_FIELDS`.
- If at least one field is accepted, set `media.metadata_enriched_at` and
  `media.updated_at`.

The app does not use confidence scores, evidence spans, or per-field source
history in this cutover.

## 11. Contributor Credit Policy

The author path must not accumulate duplicates across repeated enrichment.

Add or reuse a contributor-credit helper with this behavior:

- Target: one media id, role `author`.
- Delete machine-derived author credits from sources:
  - `metadata_enrichment`
  - `epub_opf`
  - `pdf_metadata`
  - `web_article_byline`
  - `web_article_capture`
  - `x_api_author_thread`
  - `x_api_quoted_post`
  - `x_oembed_article`
  - `youtube_metadata`
  - `rss`
  - `podcast_index`
- Preserve manual/user/curated credits if such sources exist.
- Insert new `metadata_enrichment` author credits in model order.
- Deduplicate input names by normalized `(role, credited_name)` before insert.

This uses existing `contributor_credits.source`, `source_ref`,
`resolution_status`, and `confidence` columns. No new provenance table is added.

## 12. Capability Contract

No new public capability is added.

Existing `CapabilitiesOut.can_retry_metadata` remains the only UI capability
for manual metadata re-enrichment.

Final semantics:

- visible only for creator-owned media
- true when metadata enrichment is supported for the kind
- true when `processing_status` is one of `ready_for_reading`, `embedding`,
  `ready`
- false for `extracting`
- false for `failed`; source retry owns failed deterministic processing

The capability does not expose overwrite policy. Overwrite-by-default is the
only backend behavior.

## 13. API Design

No public API shape changes.

### 13.1 `POST /api/media/{id}/retry`

Request:

```json
{ "from_stage": "metadata" }
```

Behavior:

- validates viewer is creator
- validates media is in a metadata-retryable state
- enqueues `enrich_metadata`
- returns unchanged processing status and enqueue confirmation

Final payload:

```json
{
  "media_id": "<uuid>",
  "request_id": "<request_id|null>"
}
```

The job payload does not include `force`.

### 13.2 BFF Route

`apps/web/src/app/api/media/[id]/retry/route.ts` remains a proxy. It contains no
metadata policy.

### 13.3 Frontend Client

`apps/web/src/lib/media/retryClient.ts` continues posting
`{from_stage: "metadata"}`.

`MediaPaneBody` continues polling after enqueue. It should treat these as
terminal outcomes:

- success: `metadata_enriched_at` changed or a metadata signature changed
- failure: `failure_stage='metadata'` with changed `last_error_code` or
  `updated_at`
- no confident fields: visible as metadata failure with `E_METADATA_NO_FIELDS`

The UI does not need to explain overwrite policy.

## 14. Composition With Existing Systems

### 14.1 Ingest Tasks

Existing ingest tasks keep dispatching `enrich_metadata` after successful
source extraction/indexing. The dispatch payload drops `force`.

Affected dispatchers include:

- `python/nexus/tasks/ingest_pdf.py`
- `python/nexus/tasks/ingest_epub.py`
- `python/nexus/tasks/ingest_web_article.py`
- `python/nexus/tasks/ingest_youtube_video.py`
- `python/nexus/services/media.py` capture/import helpers
- podcast sync/transcript paths that enqueue `enrich_metadata`

### 14.2 Job Queue

`enrich_metadata` stays `max_attempts=1`. The user remains the retry boundary.

`failed_result_statuses=("failed",)` remains required so typed task failures
become dead background jobs instead of successful jobs with failed result
payloads.

### 14.3 Source Refresh

Source refresh can trigger another automatic metadata enrichment through the
existing ingest completion path. Since enrichment overwrites by default, source
refresh can repair metadata too.

### 14.4 Search, Reader, Chat, And Pane Titles

These systems consume `MediaOut` and contributor credits as before. They do not
need to know whether a field came from deterministic extraction or AI.

Pane titles continue to come from media metadata. This composes with
`docs/workspace-pane-title-identity-cutover.md`: metadata quality improves the
runtime title source, but reader content and location state still do not derive
pane titles.

### 14.5 Billing And Entitlements

No change. Existing docs state background metadata enrichment is not metered as
user-facing AI quota.

## 15. Files

### 15.1 Nexus Backend

- **CHANGE** `python/nexus/services/metadata_enrichment.py`
  - Replace gap-detection-first design with all-fields structured-output
    schema and context builder.
  - Delete `MetadataGaps`, `detect_metadata_gaps`, `has_any_gaps`, and
    gap-specific prompt construction if no other caller remains.
  - Replace tolerant text parser with validation of provider-returned structured
    objects.
  - Replace `merge_enrichment(... force_overwrite=...)` with always-overwrite
    application policy.
  - Add clean text/metadata normalization for model context.

- **CHANGE** `python/nexus/tasks/enrich_metadata.py`
  - Remove `force` parameter from `enrich_metadata`.
  - Stop reading or constructing gaps.
  - Build structured `LLMRequest`.
  - Read `response.structured_output`.
  - Fail closed if structured output is absent.
  - Preserve provider failover between structured-output-capable providers.
  - Keep soft metadata failure writes.

- **CHANGE** `python/nexus/jobs/registry.py`
  - Stop reading `payload["force"]`.
  - Call `enrich_metadata(media_id, request_id)`.

- **CHANGE** `python/nexus/services/metadata_lifecycle.py`
  - Enqueue metadata retry without `force`.

- **CHANGE** `python/nexus/services/contributor_credits.py`
  - Add a helper for replacing machine-derived media author credits while
    preserving manual/user/curated credits.

- **CHANGE** `python/nexus/config.py`
  - Keep existing metadata model env vars.
  - If any default metadata model cannot satisfy strict structured output,
    update the default to one that can.

- **CHANGE** `.env.example`
  - Keep documented metadata model defaults aligned with `python/nexus/config.py`
    if defaults change.

### 15.2 `llm-calling`

- **CHANGE** external git dependency `llm-calling`
  - Add `StructuredOutputSpec`.
  - Add `LLMRequest.structured_output`.
  - Add `LLMResponse.structured_output`.
  - Implement OpenAI structured outputs.
  - Implement Gemini structured outputs.
  - Implement Anthropic strict forced tool output.
  - Add provider adapter contract tests.

- **CHANGE** `python/pyproject.toml`
  - Bump the pinned `llm-calling` git revision.

- **CHANGE** `python/uv.lock`
  - Refresh the lockfile after dependency update.

### 15.3 Frontend

- **CHANGE** only if needed:
  - `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - `apps/web/src/lib/media/useDocumentActions.ts`
  - `apps/web/src/lib/media/retryClient.ts`

No frontend API shape change is expected. UI changes are limited to copy or
terminal-state handling if current polling does not clearly surface
`E_METADATA_NO_FIELDS` and parse/schema failures.

### 15.4 Tests

- **CHANGE** `python/tests/test_metadata_enrichment.py`
  - structured schema generation
  - context prompt rules
  - validation of nullable required fields
  - rejection of extra fields, invalid dates, invalid languages
  - author dedupe input normalization

- **CHANGE** `python/tests/test_enrich_metadata.py`
  - automatic enrichment overwrites populated title/publisher/description/date
  - automatic enrichment does not skip `no_gaps`
  - manual retry enqueues the same job and overwrites through same path
  - missing `structured_output` is `E_METADATA_PARSE_FAILED`
  - provider validation failure tries the next configured structured provider
  - all-provider failure records soft metadata failure and dead job result
  - success clears prior metadata failure
  - repeated runs do not duplicate author credits

- **CHANGE** `python/tests/test_media.py`
  - metadata retry payload no longer includes `force`
  - capability/API behavior remains unchanged from user perspective

- **CHANGE** `python/tests/test_podcasts.py`,
  `python/tests/test_ingest_youtube_video.py`, and any ingest tests that assert
  exact `enrich_metadata` job payloads.

- **CHANGE/ADD** `llm-calling` tests
  - OpenAI request body includes structured-output schema.
  - Gemini request body includes structured-output schema.
  - Anthropic request body includes forced strict tool.
  - Each adapter populates `LLMResponse.structured_output`.

## 16. Key Decisions

1. **Overwrite by default.** In this prototype, existing media metadata is
   assumed machine-derived unless the app later adds explicit user editing.
2. **No new mode semantics.** Manual and automatic enrichment use the same
   policy. The old `force` flag is removed.
3. **Structured output is the hard boundary.** Prompt-only JSON extraction is
   deleted for metadata enrichment.
4. **Provider failover remains.** It is part of dependency resilience, not a
   legacy compatibility path.
5. **No field provenance.** The current read model is sufficient for a one-user
   prototype.
6. **No eval harness.** Correctness is guarded by targeted tests and direct
   user inspection.
7. **No repair tool.** Existing bad docs can be manually re-enriched.
8. **No public API change.** `from_stage="metadata"` remains the user action.
9. **Local validation stays.** Provider schema enforcement does not replace
   application validation.
10. **Author replacement is machine-source-wide.** This prevents duplicates
   without adding a provenance system.

## 17. Rules And Invariants

- `enrich_metadata` never writes `processing_status`.
- `enrich_metadata` never uses current field population as a reason to skip.
- `enrich_metadata` requests every canonical metadata field.
- `enrich_metadata` applies every valid non-empty returned field.
- `metadata_enriched_at` changes only when at least one field is accepted.
- `failure_stage='metadata'` is a soft warning and can coexist with readable
  media states.
- Successful metadata enrichment clears only metadata failures.
- Structured-output absence on a structured request is a provider/schema
  failure, not a successful no-op.
- A model returning all `null` values is `E_METADATA_NO_FIELDS`.
- Extra fields are invalid.
- Invalid dates and invalid language codes are invalid.
- Author credit replacement is idempotent across repeated runs.
- BFF routes contain no metadata policy.
- Frontend components do not infer overwrite policy.

## 18. Acceptance Criteria

- A PDF with title `bitter_lesson.pdf` is automatically enriched to a real
  document title when the model returns one.
- An EPUB with populated OPF metadata is still eligible for AI replacement.
- A web page titled `John-Keats.com - Poems` is eligible for title replacement
  during automatic post-ingest enrichment.
- Manual "Re-enrich metadata" and automatic post-ingest enrichment use the same
  backend path.
- No code path returns `{"status": "skipped", "reason": "no_gaps"}` from
  `enrich_metadata`.
- No metadata enrichment code parses JSON out of markdown/prose.
- No metadata enrichment job payload includes or reads `force`.
- OpenAI/Gemini/Anthropic metadata calls are schema-constrained at the provider
  layer.
- If one provider returns invalid structured data, the next configured
  structured provider is attempted.
- If all configured providers fail, the media row records
  `failure_stage='metadata'`, a typed `last_error_code`, and unchanged
  `processing_status`.
- Repeated enrichment with the same author does not create duplicate author
  credits.
- Existing UI retry action still posts `{from_stage: "metadata"}` and surfaces
  success/failure through current polling.
- All targeted backend tests pass.

## 19. Cutover Plan

1. Update `llm-calling` with provider-neutral structured output support and
   adapter tests.
2. Bump `llm-calling` in Nexus and refresh `python/uv.lock`.
3. Replace metadata enrichment gap detection/prompt/parser/merge with the
   structured overwrite path.
4. Remove `force` from task, registry, lifecycle enqueue payloads, and tests.
5. Add machine-author replacement helper and wire it into metadata enrichment.
6. Update tests for overwrite-by-default and structured-output failure paths.
7. Update `docs/ingest-retry-metadata.md` to point metadata policy readers to
   this cutover doc.
8. Run targeted backend tests:
   - `python/tests/test_metadata_enrichment.py`
   - `python/tests/test_enrich_metadata.py`
   - metadata retry/API tests in `python/tests/test_media.py`
   - job worker failure-result tests if touched
9. Run frontend tests only if UI state/copy changes.
10. Deploy normally after implementation.

No data migration or repair command is part of the cutover.

## 20. Risks

- **Provider API drift.** Mitigation: provider adapter tests in `llm-calling`
  assert exact request/response mapping.
- **Anthropic strict-tool behavior differs by model.** Mitigation: unsupported
  Anthropic models are not valid metadata providers after the cutover.
- **AI overwrites a good deterministic field with a worse value.** Accepted for
  this prototype. Manual re-enrich and source refresh are the recovery paths.
- **All-null structured output becomes visible failure.** Accepted. Silent
  success with no metadata change is worse.
- **Duplicate author cleanup deletes a useful machine credit.** Accepted when it
  is machine-derived. Manual/user/curated credits are preserved.

## 21. Out-Of-Scope Follow-Ups

- Field provenance.
- User metadata editing.
- Bulk metadata repair.
- Metadata quality dashboard.
- Offline eval corpus.
- Per-field re-enrich.
- Model selection UI.
- Web-search-backed bibliographic lookup.

# Library Intelligence Hard Cutover

## Purpose

Add production-grade library-wide synthesis on top of scoped library chat.

The final product model is:

- library chat is an interactive conversation over one explicit library scope,
- library intelligence is a durable compiled artifact layer for that library,
- every generated library artifact is source-grounded, versioned, refreshable,
  and inspectable,
- every checkable synthesized claim resolves to backend-owned evidence,
- chat may use compiled artifacts as stable context, but chat does not secretly
  become the compiler.

This is a hard cutover. The final state has no hidden whole-library prompt
stuffing, no unscoped retrieval fallback, no compatibility mode, no legacy
library-summary path, no prompt-only synthesis cache, no opaque model memory,
and no generated library claim without source coverage metadata.

## Goals

- Give every readable library a first-class intelligence surface.
- Compile library-wide synthesis into durable artifacts instead of re-deriving
  it inside every chat turn.
- Preserve scoped chat as the only interactive library conversation path.
- Ground every artifact section, topic, claim, tension, and open question in
  exact source evidence.
- Make source coverage, freshness, and confidence visible to users.
- Make artifact generation asynchronous, resumable, observable, and idempotent.
- Reuse the existing retrieval, prompt assembly, evidence, and background job
  foundations.
- Keep library permissions and membership as the source boundary.
- Make stale or unavailable intelligence explicit, never silently hidden.
- Leave a clean path for document, author, topic, and cross-library intelligence
  without building arbitrary source sets in this cutover.

## Target Behavior

### Library Intelligence Home

- A library exposes an `Intelligence` view next to the normal library item list.
- The view shows:
  - library overview,
  - source coverage,
  - key topics,
  - entities and people,
  - major claims,
  - tensions and contradictions,
  - open questions,
  - suggested reading paths,
  - recent changes since the last build.
- Each section shows freshness:
  - current,
  - building,
  - stale,
  - failed,
  - unavailable.
- A stale or failed section remains visible with its last successful version and
  a clear status. The app never pretends stale synthesis is current.
- Empty libraries show an empty-state contract, not a generated placeholder.

### Library Chat

- `Chat about this library` continues to open the canonical library-scoped
  conversation.
- Library chat retrieves from `library:<library_id>` for every turn.
- Library chat may include the current compiled library artifact as stable
  context only when the active artifact version matches the current source-set,
  schema, and prompt versions.
- Library chat also retrieves fresh evidence for the current user question.
- Fresh retrieval remains required for source-grounded answers. Compiled
  artifacts are orientation and synthesis context, not sufficient evidence by
  themselves unless their own claim/evidence rows are included and verified.
- If the compiled artifact is stale, missing, or failed, the chat says so when
  the answer depends on library-wide synthesis. It does not silently fall back
  to an ad hoc whole-library summary.
- Web search remains explicit and visually distinct.

### Artifact Generation

- Generation is asynchronous through background jobs.
- A library can be queued for build by:
  - first opening the intelligence view,
  - explicit user refresh,
  - library membership/content changes,
  - source ingestion completion,
  - schema or prompt-version migration.
- Builds are idempotent by library id, source set version, artifact kind, and
  prompt version.
- A build creates a new artifact version and atomically marks it active only
  after all required sections, claims, evidence links, and ledgers are valid.
- A failed build keeps the last active version unchanged.
- Partial build output is stored only as build diagnostics, never rendered as an
  active artifact.

### Source Coverage

- The intelligence view shows which sources were included, excluded, missing
  text, not ready, failed ingestion, or omitted by limits.
- Coverage is computed from backend source state, not model prose.
- Users can open the coverage panel for any artifact version.
- Coverage rows include:
  - media id or podcast id,
  - title,
  - media kind,
  - ingest/readiness state,
  - chunk count,
  - retrieved/selected/included evidence count,
  - last source update time,
  - exclusion reason when excluded.

### Topics And Claims

- Topics are durable, source-backed artifact nodes.
- A topic page contains:
  - short synthesis,
  - supporting claims,
  - source list,
  - related topics,
  - tensions,
  - open questions,
  - reading path.
- Claims are atomized enough to verify and cite.
- Claims can be supported, partially supported, contradicted, not enough
  evidence, or out of scope.
- Positive citations render only for supported claims.
- Contradictions and open questions render as first-class states, not hidden
  caveats in prose.

### Refresh And Freshness

- Library intelligence has a source-set version.
- The source-set version changes when:
  - a media item enters or leaves the library,
  - a source's searchable text changes,
  - highlights or annotations included in intelligence change,
  - transcript or EPUB/PDF chunk readiness changes,
  - prompt, chunking, or evidence schema versions change.
- Freshness is per artifact kind and per active version.
- Users may manually refresh. Manual refresh deduplicates with existing queued
  or running jobs.
- The UI never blocks normal library reading or scoped chat while intelligence
  builds.

### Permissions

- Library intelligence is readable only by current library members.
- Artifact generation uses the requesting or system actor only to authorize the
  library boundary. The generated artifact belongs to the library source set,
  not to a private conversation.
- Private conversation memory is never compiled into library intelligence.
- Shared conversation messages enter library intelligence only through explicit
  future rules. They are not included in this cutover.
- Removing a member revokes access to all library intelligence immediately.
- Removing a source from a library marks affected artifact versions stale and
  prevents removed-source evidence from supporting newly active versions.

## Final State

### Kept

- `POST /api/chat-runs` remains the only send endpoint.
- Durable scoped conversations remain the library chat execution path.
- `library:<library_id>` remains the retrieval boundary for library chat.
- `content_chunks` remains the semantic retrieval index for text-bearing media.
- App search and web search remain separate evidence channels.
- Evidence-grade citations remain the rendering authority for supported claims.
- Prompt context cache uses compiled library artifacts only as stable versioned
  blocks.
- Background jobs remain the asynchronous execution mechanism.
- FastAPI services own business logic; Next.js BFF routes stay transport-only.

### Added

- Library intelligence artifact versions.
- Artifact sections and nodes.
- Artifact claim/evidence rows.
- Artifact source coverage ledgers.
- Library source-set versioning.
- Build jobs and build diagnostics.
- Intelligence view, coverage panel, topic/claim/tension pages.
- Chat context inclusion for current compiled library artifacts.

### Replaced

- Any one-off library summary text with versioned artifact sections.
- Any prompt-only library synthesis with persisted artifact rows.
- Any model-authored source list with backend-owned coverage and evidence rows.

### Removed

- Hidden whole-library prompt stuffing.
- Any library-wide answer path that bypasses scoped retrieval.
- Any library-wide synthesis path that stores opaque prose without source refs.
- Any fallback from stale intelligence to ad hoc synthesis.
- Any fallback from failed artifact build to stale-but-unmarked rendering.
- Any inclusion of private conversation memory in library intelligence.
- Any unversioned generated library overview.
- Any frontend-built citation or source locator.
- Any arbitrary source-set or checkbox UI for this cutover.

## Architecture

```text
Library Pane
  Intelligence tab
    overview
    coverage panel
    topic index
    claim/tension/open-question pages
    refresh action

Conversation Pane
  library-scoped chat
  stable compiled artifact context when current
  fresh scoped retrieval for every source-grounded turn

Next.js BFF
  transport-only /api/* proxy

FastAPI routes
  validate input
  call services
  return active artifact versions and build state

Services
  library_intelligence
    resolve active artifact versions
    authorize library access
    compute freshness and source-set version
    expose read models

  library_intelligence_builds
    plan builds
    claim idempotency keys
    orchestrate artifact generation
    atomically publish active versions

  library_source_sets
    compute source inventory
    compute source-set hashes
    record included and excluded sources

  artifact_retrieval
    run scoped retrieval passes
    select evidence candidates
    persist retrieval/evidence ledgers

  artifact_synthesis
    compile overview, topics, claims, tensions, open questions, paths
    produce structured output only

  evidence_verifier
    validate support state, scope, snippets, locators, and citations

  context_assembler
    includes current artifact blocks as stable context
    still includes fresh retrieval evidence for the current chat turn

Worker
  claims library-intelligence jobs
  executes deterministic build phases
  records progress, diagnostics, and terminal status
```

Artifact builds are separate from chat runs. Chat can consume active artifact
versions, but chat does not create or mutate active library intelligence.

## Structure

### Frontend

- Library pane exposes an `Intelligence` tab or pane action.
- Intelligence surfaces use normal app pane routing, not a separate product UI.
- The view separates:
  - active artifact content,
  - source coverage,
  - build/freshness state,
  - manual refresh controls.
- Claim and source navigation reuse reader, transcript, conversation, and web
  citation jump-target patterns.
- Library chat displays when a compiled artifact was included in context.
- Library chat still displays retrieved evidence and claim citations from the
  answer, not from the artifact banner.

### Backend

- Route handlers validate input and call services.
- Services own source-set versioning, build orchestration, retrieval policy,
  synthesis, verification, and publication.
- BFF routes do not contain intelligence business logic.
- Background jobs own long-running builds.
- Artifact rows are append-only by version; active pointers change only after
  validation passes.

### Data Model

Add artifact-owned tables rather than overloading conversations:

- `library_source_set_versions`
  - `id`
  - `library_id`
  - `source_set_hash`
  - `source_count`
  - `chunk_count`
  - `prompt_version`
  - `schema_version`
  - `created_at`

- `library_source_set_items`
  - `source_set_version_id`
  - `media_id`
  - `podcast_id`
  - `source_kind`
  - `readiness_state`
  - `chunk_count`
  - `included`
  - `exclusion_reason`
  - `source_updated_at`

- `library_intelligence_artifacts`
  - `id`
  - `library_id`
  - `artifact_kind`
  - `active_version_id`
  - `created_at`
  - `updated_at`

- `library_intelligence_versions`
  - `id`
  - `artifact_id`
  - `library_id`
  - `source_set_version_id`
  - `status`
  - `artifact_version`
  - `prompt_version`
  - `generator_model_id`
  - `published_at`
  - `invalidated_at`
  - `invalid_reason`

- `library_intelligence_sections`
  - `id`
  - `version_id`
  - `section_kind`
  - `title`
  - `body`
  - `ordinal`
  - `metadata`

- `library_intelligence_nodes`
  - `id`
  - `version_id`
  - `node_type`
  - `slug`
  - `title`
  - `body`
  - `metadata`

- `library_intelligence_claims`
  - `id`
  - `version_id`
  - `node_id`
  - `section_id`
  - `claim_text`
  - `support_state`
  - `confidence`
  - `ordinal`

- `library_intelligence_evidence`
  - `id`
  - `claim_id`
  - `source_ref`
  - `snippet`
  - `locator`
  - `support_role`
  - `retrieval_status`
  - `score`

- `library_intelligence_builds`
  - `id`
  - `library_id`
  - `source_set_version_id`
  - `artifact_kind`
  - `status`
  - `idempotency_key`
  - `phase`
  - `error_code`
  - `diagnostics`
  - `started_at`
  - `finished_at`

Use finite enums and check constraints for all status, kind, state, and phase
fields.

## Rules

- Hard cutover only.
- No feature flag.
- No compatibility table for old library summaries.
- No hidden all-library prompt stuffing.
- No unscoped retrieval fallback.
- No ad hoc synthesis fallback when compiled artifacts are missing or stale.
- No active artifact version without validated source coverage.
- No active artifact claim without evidence rows unless the support state is
  `not_enough_evidence`, `out_of_scope`, or `not_source_grounded`.
- No frontend-authored citations, snippets, source lists, or locators.
- No private conversation memory in library intelligence.
- No shared conversation message inclusion in this cutover.
- No arbitrary source-set builder or source checkbox UI.
- No cross-library synthesis in this cutover.
- No generated prose stored without prompt version, source-set version, model,
  and schema version.
- No build publication outside the build transaction.
- No overwriting active versions in place.
- No deleting old versions except through an explicit retention job.
- Branch exhaustively on artifact kind, build status, source state, support
  state, and node type.
- Keep route handlers thin and service boundaries explicit.
- Tests must prove user-visible behavior, source-boundary policy, build
  idempotency, and citation integrity.

## Key Decisions

1. Library intelligence is an artifact layer, not a chat side effect.

   Chat answers are ephemeral interactions. Library intelligence is a durable
   synthesized product surface with its own lifecycle, provenance, and refresh
   semantics.

2. Retrieval remains mandatory for source-grounded chat answers.

   Compiled artifacts summarize the corpus, but a chat answer still needs fresh
   scoped retrieval or included artifact evidence to support the current claim.

3. Source-set versioning is the freshness boundary.

   A library artifact is current only for a specific library membership/source
   inventory and processing schema. Library content changes make freshness a
   data fact, not a UI guess.

4. Artifacts publish atomically.

   Users should never see half-built synthesis. Build diagnostics can expose
   progress, but active artifact content changes only when the new version is
   complete and verified.

5. Claims are first-class.

   Professional synthesis needs claims, support states, and evidence, not just a
   generated paragraph with citations at the end.

6. Contradictions are product value, not errors.

   A research library often contains disagreement. The system should surface
   tensions and conflicting claims rather than collapse them into bland prose.

7. Private conversation memory is excluded.

   Library intelligence belongs to the library source corpus. Private chat state
   can inform that user's conversation, but it must not become shared library
   knowledge.

8. No arbitrary source sets in this cutover.

   The durable unit is one library. Arbitrary source-set builders are a separate
   product with different permission, freshness, and UX complexity.

9. Prompt caching is downstream of artifact versioning.

   A compiled artifact can be a stable cacheable prompt block only because it is
   versioned and source-grounded first.

10. Observability is part of correctness.

   Operators must be able to answer why an artifact is stale, which sources were
   omitted, why a build failed, and which evidence supports a claim.

## Files

### Add

- `docs/library-intelligence-hard-cutover.md`
  - This plan and behavior contract.

- `migrations/alembic/versions/<next>_library_intelligence.py`
  - Add source-set, artifact, version, section, node, claim, evidence, and build
    tables.

- `python/nexus/services/library_intelligence.py`
  - Source-set hashing, active artifact read models, authorization, freshness,
    build planning, deterministic synthesis, evidence persistence, publication,
    and prompt artifact context.

- `python/nexus/schemas/library_intelligence.py`
  - Request/response schemas for artifacts, coverage, build status, nodes,
    claims, and evidence.

- `python/nexus/api/routes/library_intelligence.py`
  - Library intelligence read and refresh endpoints.

- `python/nexus/tasks/library_intelligence.py`
  - Worker entrypoint for build jobs.

- `python/tests/test_library_intelligence_read_model.py`
  - Source coverage, member-only reads, stale detection, refresh idempotency,
    build publication, and supported-claim evidence tests.

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.test.tsx`
  - Browser component coverage for the intelligence tab, stale state,
    coverage, claims, and refresh action.

### Update

- `README.md`
  - Link this plan.

- `python/nexus/db/models.py`
  - Add library intelligence ORM models.

- `python/nexus/jobs/registry.py`
  - Register library intelligence build job kinds, retry policy, lease policy,
    and schedule policy.

- `python/nexus/services/chat_runs.py`
  - No direct changes; chat receives artifact context through context assembly.

- `python/nexus/services/context_assembler.py`
  - Add compiled artifact blocks as stable context when current and authorized.
  - Keep fresh retrieval evidence separate from artifact context.

- `python/nexus/services/prompt_budget.py`
  - Add artifact-context lane and priority rules.

- `python/nexus/services/libraries.py`
  - Explicitly clean up library intelligence rows before library deletion.

- `python/nexus/api/routes/__init__.py`
  - Include library intelligence routes.

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  - Add intelligence view/action, build state, section rendering, coverage, and
    refresh behavior.

- `apps/web/src/app/(authenticated)/libraries/[id]/page.module.css`
  - Add scoped intelligence tab styles.

### Avoid Unless Proven Necessary

- New chat runtime.
- New message table.
- New generic project/workspace table.
- WebSocket infrastructure.
- Separate vector database.
- Cross-library intelligence.
- Arbitrary source-set UI.
- Collaborative artifact editing.
- User-editable generated wiki pages.
- File upload from chat composer.
- LLM provider/router changes beyond structured artifact generation support.

## Acceptance Criteria

- Every readable non-empty library can show an intelligence surface.
- Empty libraries show an explicit empty state.
- Unauthorized users cannot read intelligence, coverage, claims, evidence, or
  build state for a library.
- Opening intelligence for a library queues exactly one build for the current
  source-set version and artifact kind.
- Reopening or refreshing during an active build deduplicates to the existing
  build.
- A failed build leaves the previous active version unchanged.
- A build cannot publish without source coverage rows.
- A build cannot publish a supported claim without evidence rows.
- Evidence rows resolve to authorized in-library sources.
- Removed library sources cannot support newly active artifact versions.
- Source-set version changes mark affected artifacts stale.
- Stale artifacts render as stale, not current.
- Library chat still runs with `scope=library:<library_id>`.
- Library chat includes active artifact context only when the active artifact
  version matches the current source-set, schema, and prompt versions.
- Library chat records artifact-context inclusion in the prompt assembly ledger.
- Library chat still runs fresh scoped retrieval for source-grounded answers.
- No library chat falls back to unscoped retrieval.
- No missing artifact triggers ad hoc whole-library synthesis inside chat.
- Coverage panel lists included and excluded sources with reasons.
- Topic pages render claims, evidence, related sources, and jump targets.
- Contradictions render as contradictions, not ordinary supported claims.
- Open questions render separately from unsupported claims.
- Build logs and metrics expose phase, duration, source counts, chunk counts,
  claim counts, evidence counts, and failure code.
- Prompt assembly tests cover artifact-context inclusion and budget dropping.
- Backend tests cover schema constraints, authorization, build idempotency,
  stale detection, publication atomicity, and evidence validation.
- Frontend component tests cover current, stale, building, failed, empty, and
  unauthorized states.
- E2E covers first build, refresh after source change, citation navigation, and
  library chat with artifact context.
- TypeScript typecheck passes.
- Targeted frontend tests pass.
- Targeted backend tests pass.
- Targeted migration tests pass.

## Non-Goals

- Do not replace scoped chat.
- Do not add cross-library synthesis.
- Do not add arbitrary source-set creation.
- Do not include private conversation memory in library intelligence.
- Do not include shared conversation messages in this cutover.
- Do not build collaborative wiki editing.
- Do not build user-authored knowledge pages.
- Do not add document-level intelligence beyond what is needed for library
  source coverage.
- Do not change media/library membership semantics.
- Do not change reader resume, highlight, or annotation storage semantics.
- Do not redesign the entire library page outside the intelligence surface.
- Do not add public web browsing to artifact generation in this cutover.
- Do not add prompt suggestions.
- Do not change billing or model availability beyond build execution accounting.
- Do not add a separate vector database.

## Implementation Order

1. Add library intelligence migration and ORM models.
2. Add schemas and route contracts.
3. Add source-set computation, coverage rows, and freshness detection.
4. Add build planning, idempotency, job registration, and worker entrypoint.
5. Add deterministic artifact compilation, claim/evidence persistence, and
   atomic active-version publication.
6. Add member-only read and refresh endpoints.
7. Add explicit intelligence cleanup before library deletion.
8. Integrate current artifact context into library-scoped prompt assembly and
   prompt assembly ledgers.
9. Add the library pane intelligence tab, build state, sections, coverage, and
   refresh action.
10. Add backend integration tests for coverage, authorization, stale detection,
    refresh idempotency, publication, and evidence.
11. Add browser component coverage for the intelligence tab.
12. Run targeted backend, frontend, migration, lint, type, and format checks.

## External Reference Notes

- NotebookLM separates source-grounded chat from generated study artifacts,
  reports, mind maps, and overviews:
  https://support.google.com/notebooklm/answer/16179559
  https://support.google.com/notebooklm/answer/16206563
- Granola supports chat over meetings and structured note synthesis:
  https://docs.granola.ai/help-center/getting-more-from-your-notes/chatting-with-your-meetings
  https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes
- ChatGPT Projects and Claude Projects treat workspace context as durable
  scoped context, not arbitrary hidden prompt stuffing:
  https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt
  https://support.claude.com/en/articles/9517075-what-are-projects
- Enterprise assistants converge on permission-aware retrieval and knowledge
  graphs:
  https://docs.glean.com/security/knowledge-graph
  https://support.atlassian.com/rovo/docs/knowledge-sources-for-agents/
  https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-architecture
- Production RAG guidance favors ingestion/retrieval/reranking/evaluation over
  whole-corpus prompt stuffing:
  https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/on-your-data-best-practices
  https://www.anthropic.com/research/contextual-retrieval
- The LLM Wiki pattern treats compiled knowledge pages as durable, cited
  artifacts over raw sources:
  https://llm-wiki.net/

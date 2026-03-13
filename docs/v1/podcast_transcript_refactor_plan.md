# Podcast Transcript Refactor — Spec + Plan

## Goal

Refactor podcast ingestion from eager quota-spending subscription sync into a metadata-first, demand-driven transcript platform that supports durable highlights, timestamp-aware quote-to-chat, and hybrid keyword + semantic episode-content search without quota shocks or anchor loss.

## Implementation Status (2026-03-13)

Current branch status against this plan:

- implemented now:
  - metadata-first subscription sync with no eager transcript spend
  - explicit transcript admission endpoint with dry-run forecast
  - atomic per-user/day quota reservation for transcript admission
  - playback-usable capabilities when transcript is pending/unavailable
  - request reason persisted on `podcast_transcription_jobs.request_reason`
  - dedicated `media_transcript_states` bridge (`transcript_state`, `transcript_coverage`, `semantic_status`)
  - immutable `podcast_transcript_versions` with active-version projection per media row
  - version-aware transcript anchors for highlights (`highlight_transcript_anchors`)
  - transcript chunk + embedding artifacts with semantic chunk search gating
- partially implemented:
  - refund path exists for enqueue failure; broader stale-running and provider timeout refund reconciliation is still pending
  - stale-running transcription reclaim now exists at worker claim time; scheduled reconciliation still remains best-effort and bounded
  - semantic ranking currently uses deterministic lightweight embeddings + lexical overlap (no pgvector ANN yet)
- not implemented yet:
  - budget-aware background warming policy and preemption behavior

## Why This Refactor Exists

The current system gets several expensive-to-reverse things right:

- podcast discovery is global while episode readability is visibility-scoped
- episode media rows and transcript work are globally reused across subscribers
- transcript segments reuse the fragment/highlight/quote model
- playback-only fallback exists for transcript-unavailable outcomes

It also has several production-grade flaws:

- subscribing can fail all-or-nothing because transcript cost is charged during initial sync
- daily quota is pre-paid before usable transcript artifacts exist
- quota accounting is non-atomic and concurrency-unsafe
- transcript readiness is overloaded into subscription sync behavior
- transcript highlights are unsafe across re-transcription because transcript storage is rewritten in place
- search is keyword-only today and transcript-dependent behavior is not modeled cleanly for partial or deferred states
- UI does not explain budget fit, deferred work, or user-triggered transcript actions

The target architecture must keep the good parts and remove the unsafe coupling.

## Target Product Posture

The target posture is not "pure eager" and not "pure on-demand only."

The target posture is:

- metadata-first subscribe
- demand-driven transcript generation
- optional budget-aware background warming
- explicit transcript readiness and coverage states
- durable transcript versions and stable highlight anchors
- hybrid metadata search immediately, transcript content search only when transcript/index artifacts exist

This keeps subscription cheap and reliable while still allowing fast search on content users actually care about.

## Non-Negotiable Invariants

- subscribing to a podcast must never fail solely because transcript budget is insufficient
- transcript spend must happen only through an explicit transcript job admission path
- quota accounting must be atomic, auditable, and refund-capable
- already-transcribed episodes must remain globally reusable across subscribers without duplicate spend
- re-transcription must never silently delete existing highlights or annotations
- transcript-unavailable, transcript-deferred, transcript-partial, and transcript-ready must be distinct user-visible states
- metadata search must remain available even when transcript content is unavailable
- semantic content search must never return chunks that are invisible or not index-ready

## Architecture

### High-Level Split

The system is split into three planes:

1. Control plane
   - podcast discovery
   - subscription lifecycle
   - episode identity and library entitlement
   - feed polling and metadata refresh

2. Transcript plane
   - transcript requests
   - quota reservations
   - transcription jobs
   - transcript versions and segments
   - retry, refund, and stale-job recovery

3. Search plane
   - metadata keyword search
   - transcript chunking
   - embeddings
   - hybrid lexical + semantic retrieval

Subscription sync owns episode discovery and attachment.
Transcript jobs own transcript production.
Search indexing owns retrieval artifacts.
These responsibilities may communicate, but they must not collapse back into one state machine.

### High-Level Flow

```text
subscribe
  -> create/update subscription
  -> sync podcast metadata + episode metadata
  -> attach visible episodes
  -> set transcript_state per episode to not_requested or ready(reused)

episode open / search-inside / highlight / quote
  -> if transcript ready: use it
  -> else show budget forecast + allow request
  -> reserve quota atomically
  -> enqueue transcript job
  -> persist transcript version + segments
  -> chunk + embed
  -> mark transcript/index ready
```

### State Model

Subscription sync state and transcript state are separate.

#### Subscription state

Subscription state continues to describe feed sync only:

- `pending`
- `running`
- `complete`
- `source_limited`
- `failed`

`partial` is removed from subscription sync semantics. "Partial" belongs to transcript coverage, not feed sync.

#### Transcript state

Each transcript-capable media row has explicit transcript state:

- `not_requested`
- `queued`
- `running`
- `ready`
- `partial`
- `unavailable`
- `failed_quota`
- `failed_provider`

Each transcript-capable media row also exposes transcript coverage:

- `none`
- `partial`
- `full`

Transcript state and coverage drive:

- `can_read`
- `can_highlight`
- `can_quote`
- `can_search`
- reader rendering
- user messaging
- retry behavior

Capability derivation must become transcript-state aware rather than inferring behavior from a small subset of generic processing states.

### Canonical Transcript Storage

Transcript storage becomes immutable and versioned.

Each transcript run creates a new transcript version instead of deleting and rewriting the current one in place. The system tracks one active transcript version per media row for reading/search. Older versions remain available for anchor preservation, auditing, and background remap.

The implementation may use:

- dedicated transcript version/segment tables, or
- versioned transcript-backed fragment rows plus an active-version projection

but the external invariant is the same:

- no in-place destructive rewrite of the anchor substrate
- no cascade deletion of existing transcript highlights during re-transcription
- clear distinction between active version and historical versions

### Highlight and Quote Anchoring

Transcript highlights must become version-aware.

The canonical anchor for transcript highlights includes:

- media identity
- transcript version identity
- stable segment identity or stable time span
- text offsets within the anchored segment span

During migration, legacy highlight routes may continue to present fragment-based shapes, but the stored truth must be version-aware so:

- old highlights remain resolvable after re-transcription
- quote-to-chat can still include timestamp and speaker data from the anchored version
- background remap can upgrade anchors from older versions to the current active version without loss

### Quota Accounting

Quota changes from "read then increment" to reservations.

Quota operations:

- reserve minutes when a transcript job is admitted
- commit minutes when a transcript job reaches a transcript-usable terminal state
- refund minutes when enqueue fails, the job expires, or the provider fails before usable transcript artifacts exist

Quota reservations must be:

- atomic per user/day
- concurrency-safe
- auditable by job/request/reason
- reclaimable on stale-job recovery

The system must support different request reasons:

- explicit user request from episode view
- user request from search
- user request from highlight/quote action
- background warming
- operator requeue

### Search Architecture

Search is split into two user-visible classes:

1. Metadata search
   - title
   - author/podcast metadata
   - episode description/show notes when available
   - always available once episode metadata exists

2. Content search
   - transcript keyword search
   - transcript semantic search
   - only available for transcript-ready or transcript-partial indexed content

Semantic search is added as a hybrid layer, not a replacement:

- lexical filtering for visibility and exact-term usefulness
- vector retrieval over transcript chunks
- ranking that combines lexical match, semantic similarity, recency, and source heuristics

The initial production target should use the existing PostgreSQL deployment with vector support rather than introducing a new search service prematurely. A separate vector/search service is deferred unless scale or latency data proves it necessary.

### Transcript Chunking and Embeddings

Semantic retrieval indexes transcript chunks, not whole episodes.

Chunk invariants:

- every chunk maps back to exact transcript version + segment span + timestamps
- chunk search results can open the episode at the relevant time window
- chunk regeneration is version-scoped
- retry/reset never leaves mixed-generation chunk/embedding artifacts

Transcript chunk readiness is separate from transcript text readiness, so the product can correctly represent:

- playable only
- transcript readable but not semantically searchable yet
- transcript readable and semantically searchable

### Background Warming Policy

Background warming is optional and budget-aware.

Background warming may transcribe some episodes without an explicit user request, but only after:

- metadata sync completes successfully
- transcript quota remains after explicit user-request demand
- policy selects likely useful episodes

Policy input examples:

- newest episode
- shortest episodes that fit remaining budget
- episodes the user opened recently
- podcast subscriptions marked high priority by the user

Background warming must never consume reserved capacity needed for foreground user requests.

### UI Contract

The UI must stop treating transcript availability as a hidden backend incident.

The product surfaces:

- "metadata ready"
- "transcript not requested"
- "transcript queued"
- "transcript running"
- "transcript ready"
- "transcript partially ready"
- "transcript unavailable"
- "not enough transcript budget today"

Every user-triggered transcript action shows forecast before enqueue:

- minutes required for the request
- minutes remaining today
- whether the request fits
- what fallback remains available if it does not fit

Podcast subscribe/detail pages show both:

- feed sync state
- transcript readiness summary for episode content

## Acceptance Criteria

### Subscribe never spends transcript budget
- **given**: an authenticated user subscribes to a podcast
- **when**: the subscription and initial episode sync complete
- **then**: the subscription succeeds even if transcript budget is exhausted, and episodes are attached in metadata/playback form without automatic transcript spend

### Existing global transcript artifacts are reused
- **given**: another user already caused a transcript-ready episode to exist globally
- **when**: a second user subscribes or opens that episode
- **then**: the second user reuses the same transcript-ready episode artifacts without additional transcription spend

### On-demand transcript request is explicit and budget-aware
- **given**: an episode with no ready transcript
- **when**: a user requests transcript-backed search, highlighting, or quote-to-chat
- **then**: the product shows budget fit before enqueue, reserves quota atomically if approved, and records the request reason

### Playback remains usable when transcript is deferred or unavailable
- **given**: an episode exists in metadata/playback form but transcript work is not requested, over budget, deferred, or unavailable
- **when**: the user opens the episode
- **then**: playback and library access remain usable, transcript-dependent actions are represented honestly, and the UI offers the correct next action instead of surfacing a subscription-level failure

### Background warming respects remaining budget
- **given**: a user has subscribed podcasts and unused transcript budget
- **when**: background warming selects episodes
- **then**: only episodes that fit policy and remaining budget are admitted, and foreground user-triggered requests can preempt background work

### Partial transcript coverage is explicit
- **given**: a transcript run produces only partial usable coverage
- **when**: the user opens the episode or searches inside it
- **then**: the product clearly marks transcript coverage as partial, allows read/highlight/search only on materialized portions, and never misstates full readiness

### Re-transcription preserves highlights
- **given**: a user has transcript highlights or annotations on an episode
- **when**: the episode is re-transcribed or upgraded to a newer transcript version
- **then**: existing highlights remain resolvable and are not deleted by transcript regeneration

### Quote-to-chat remains timestamp-aware across versions
- **given**: a transcript highlight exists on an older or current transcript version
- **when**: the user sends quote-to-chat
- **then**: rendered context includes stable source metadata plus timestamp and speaker label when present

### Metadata search remains available without transcript
- **given**: an episode has metadata but no transcript
- **when**: the user searches podcasts or episode titles
- **then**: metadata results remain searchable without implying that transcript content is searchable

### Semantic content search is chunk-backed and visibility-safe
- **given**: an episode has transcript chunks and embeddings for visible content
- **when**: the user performs content search
- **then**: results are ranked with hybrid lexical + semantic retrieval, link back to exact timestamps, and never expose invisible content

### Search readiness is explicit and stage-safe
- **given**: a transcript is readable but embeddings are still pending
- **when**: the user searches semantically
- **then**: the product either excludes that transcript from semantic ranking or marks it as still indexing, without mixing stale and fresh index artifacts

### Quota accounting is refund-capable and concurrency-safe
- **given**: concurrent transcript requests or enqueue/provider failures
- **when**: quota operations execute
- **then**: the user never overspends daily budget through race conditions, and failed admissions/refundable failures return minutes to available balance deterministically

### Stale-job recovery is transcript-state aware
- **given**: a transcript job is interrupted after reservation or while running
- **when**: recovery logic runs
- **then**: the system reclaims or resumes work safely, does not leave orphaned running jobs forever, and does not strand quota reservations

## Key Decisions

**Subscription sync and transcript generation are separate engines**: feed sync owns episode discovery and library attachment; transcript generation owns quota admission, production, readiness, and retry. This is the most important boundary in the refactor.

**Transcript state is a first-class contract**: transcript-capable media exposes explicit readiness and coverage states rather than inferring transcript usability from generic media processing states and a narrow set of error codes.

**Quota uses reservations, not prepaid best effort**: transcript spend must be admitted atomically and reconciled with commit/refund semantics so the product can remain trustworthy under concurrency and failure.

**Transcript artifacts are immutable and versioned**: re-transcription creates a new version instead of rewriting the current one in place. Active-version projection is allowed; destructive replacement is not.

**Transcript highlights are version-aware**: transcript anchors must survive version changes. Legacy fragment-only anchoring is treated as a compatibility bridge, not the durable end state.

**Hybrid retrieval is the search target**: metadata keyword search remains immediate; transcript keyword and semantic retrieval operate only on transcript/index-ready content. Semantic search is chunk-based with exact timestamp provenance.

**Background warming is an optimization, not a control path**: background warming may improve freshness, but it cannot be the only way users get transcript-backed functionality and cannot consume quota ahead of explicit demand.

**UI must expose budget fit and transcript readiness directly**: users should understand whether an episode is playable, transcript-readable, searchable, and highlightable without decoding backend failure codes.

## Out of Scope

- self-serve billing, upgrade, or Stripe integration
- speaker identity resolution beyond provider labels
- recommendations or podcast ranking
- transcript editing/correction tools
- non-podcast transcript architecture changes except where shared transcript media contracts must be unified
- moving to a separate dedicated search service before PostgreSQL vector-backed hybrid search is proven insufficient

## Rollout Plan

### Phase 0: Guardrails and Observability

Goal:

- make the current system measurable before changing behavior

Deliver:

- explicit transcript readiness telemetry
- quota reservation/admission metrics design
- stale-job and refund telemetry
- UI copy inventory for transcript state and budget forecasting

Exit criteria:

- operators can answer why a transcript is unavailable, deferred, partial, or failed

### Phase 1: Metadata-First Subscription

Goal:

- remove transcript spend from subscribe and polling paths

Deliver:

- subscription sync attaches episodes in metadata/playback state
- transcript state defaults to `not_requested` for new episodes unless a ready transcript already exists globally
- subscription pages expose feed sync separately from transcript readiness summary

Exit criteria:

- subscribe never returns an over-quota transcript failure for initial episode attachment

### Phase 2: Transcript Request and Reservation Engine

Goal:

- add explicit on-demand transcript request admission

Deliver:

- transcript request model and request reasons
- atomic quota reservation/commit/refund path
- high-priority user-triggered transcript enqueue from episode/search/highlight flows
- transcript retry semantics moved onto the same reservation-aware engine

Exit criteria:

- user-triggered transcript requests are budget-forecasted, atomic, and auditable

### Phase 3: Versioned Transcript Storage and Anchor Migration

Goal:

- make transcript regeneration safe for highlights and search artifacts

Deliver:

- transcript version model
- active transcript version projection
- version-aware highlight anchor model
- migration/backfill for legacy transcript highlights
- remap strategy for old-version anchors

Exit criteria:

- re-transcription cannot delete existing transcript highlights or annotations

### Phase 4: Search and Indexing Refactor

Goal:

- separate metadata retrieval from transcript content retrieval and add semantic search

Deliver:

- metadata search contract for transcript-not-ready episodes
- transcript chunk generation tied to transcript versions
- embedding lifecycle and retry/reset cleanup
- hybrid lexical + semantic retrieval with timestamped source return

Exit criteria:

- episode-content search works only on transcript/index-ready chunks and can open exact time windows

### Phase 5: Background Warming and Policy Tuning

Goal:

- improve freshness without reintroducing quota explosions

Deliver:

- budget-aware warming policy
- user/library subscription priority signals
- preemption rules favoring explicit demand over warming
- product tuning for how many fresh episodes should usually be transcript-ready without request

Exit criteria:

- warming improves freshness while keeping spend predictable and foreground latency acceptable

### Phase 6: Cleanup and Contract Hardening

Goal:

- remove compatibility drift and lock the architecture

Deliver:

- retire ambiguous subscription `partial` semantics
- remove destructive in-place transcript rewrite codepaths
- unify transcript-capable media state derivation
- close stale-job recovery gaps for running transcription jobs

Exit criteria:

- the old eager-on-subscribe transcript path no longer exists

## Verification Strategy

- backend lifecycle tests for transcript request, reservation, refund, and recovery
- migration tests for highlight preservation across transcript versions
- search tests for metadata-only vs transcript-keyword vs semantic readiness
- UI tests for transcript state rendering and budget forecasts
- concurrency tests for per-user quota admission races
- observability checks for stuck jobs, leaked reservations, and remap failures

## Success Metrics

- subscribe success rate no longer drops because of transcript quota exhaustion
- percentage of transcript minutes spent on episodes the user actually opened or searched rises materially
- transcript retry no longer causes highlight loss
- semantic episode-content search adoption can be measured separately from metadata search
- support incidents for confusing podcast sync failures decline

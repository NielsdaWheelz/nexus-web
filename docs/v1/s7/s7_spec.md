# Slice 7: Podcasts — Spec

## Goal

Extend "media" abstraction to time-based text with cost controls.

## Acceptance Criteria

### Podcast discovery is global
- **given**: an authenticated user (with or without any podcast subscriptions)
- **when**: they run podcast discovery search
- **then**: they receive podcast metadata results globally, independent of library membership, and discovery results do not include episode media rows.

### Subscribe ingests and attaches a bounded initial episode set
- **given**: a user with a default library and an active plan
- **when**: they subscribe to a podcast
- **then**: a subscription is created, the most recent configured episode window is ingested idempotently, and those episodes are added to the user’s default library.

### Episode identity is stable when GUID exists
- **given**: an episode with a feed GUID already ingested
- **when**: the same episode is encountered again (polling, retry, or another subscriber)
- **then**: no duplicate episode media row is created.

### Episode identity falls back deterministically when GUID is missing
- **given**: an episode without GUID
- **when**: ingestion sees the same episode again
- **then**: fallback identity rules prevent duplicate rows for that episode.

### Shared episode ingest prevents duplicate transcription work
- **given**: user A already caused episode ingest/transcription
- **when**: user B subscribes to the same podcast
- **then**: existing episode media rows are reused, B gets library attachment, and no redundant transcription job is created for already-ready episodes.

### Quota blocks over-limit transcription for free plan
- **given**: a free-plan user has exhausted daily transcription allowance
- **when**: subscribe or backfill would require new transcription work
- **then**: the operation is blocked with a stable quota error, and no over-limit transcription job is enqueued.

### Plan tier changes quota outcome
- **given**: the same user is on a paid plan with a higher (or unlimited) allowance
- **when**: the same operation is attempted
- **then**: quota checks pass and ingestion proceeds.

### Episode window cap is enforced per subscription ingest
- **given**: a feed with more episodes than the plan’s initial-ingest limit
- **when**: a user subscribes
- **then**: only the newest allowed episode window is ingested immediately, with older episodes deferred to progressive backfill policy.

### Quota usage resets daily
- **given**: a user reached quota on day D
- **when**: 00:00 UTC on day D+1 is reached
- **then**: quota usage is reset and transcription work is allowed again.

### Manual plan assignment is supported
- **given**: an authorized operator
- **when**: they change a user plan
- **then**: subsequent quota checks immediately use the new plan limits.

### Transcript ingestion produces readable segments with diarization fallback
- **given**: an ingested podcast episode with a reachable external audio URL
- **when**: transcription runs
- **then**: transcript segments are created as readable media artifacts, and if diarization fails, non-diarized transcript output is still persisted for reading/highlighting.

### Transcript segment ordering is deterministic
- **given**: transcript segments for one episode
- **when**: transcript is rendered and queried
- **then**: persistence enforces unique `(media_id, idx)` and UI ordering is deterministic by `(t_start_ms, idx)`.

### Transcript highlighting and quote-to-chat preserve time context
- **given**: a readable podcast transcript
- **when**: a user highlights transcript text and sends quote-to-chat
- **then**: highlight anchors to transcript segment offsets, and quote context includes timestamp and speaker label when present.

### Audio player supports click-to-seek and graceful fallback
- **given**: a podcast episode with transcript segments and an external playback URL
- **when**: a user clicks a transcript segment
- **then**: player seeks to that segment start timestamp when playback works; if browser playback fails, UI offers an "open in source" path while transcript reading/highlighting remain usable.

### Transcript-unavailable failures degrade to playback-only
- **given**: transcription for an episode fails while playback URL remains valid
- **when**: the user opens the episode
- **then**: the media stays playable, transcript-dependent capabilities are disabled, and failure state is explicit via stable error code semantics.

### Unsubscribe stops future auto-add
- **given**: an active subscription
- **when**: the user unsubscribes
- **then**: future episode auto-ingest/auto-add for that subscription stops, and existing-episode retention/removal follows explicit unsubscribe mode without removing from shared libraries implicitly.

### Unsubscribe mode behavior is explicit and predictable
- **given**: an active subscription with existing episodes in one or more libraries
- **when**: the user selects an unsubscribe mode
- **then**: one of the three constitution modes is applied exactly, mode 1 remains default, and episode removals never apply to shared libraries implicitly.

### Active subscriptions continue to ingest new episodes
- **given**: an active subscription
- **when**: feed polling detects newly published episodes
- **then**: new episodes are ingested idempotently and added to the subscriber’s default library under the same quota rules.

### Cross-cutting suites remain green
- **given**: Slice 7 implementation is integrated
- **when**: visibility and processing-state suites run
- **then**: all prior scenarios still pass, and new podcast/transcript scenarios pass (including transcript media capability gates).

## Key Decisions

**Global podcast vs media boundary**: `podcast` remains a global discovery object, while each `podcast_episode` is a visibility-scoped media object. This preserves constitution-level discovery/readability separation and avoids leaking episode content through discovery.

**Subscription ownership model**: subscriptions are per-user (not per-library) and always auto-attach episode media to the subscriber’s default library. Shared-library exposure remains an explicit, separate library action.

**Episode idempotency precedence**: ingestion identity prefers provider/feed GUID; fallback identity is used only when GUID is absent. This prevents identity drift across feed quality differences and is expensive to change later.

**Global ingest, local entitlement**: episode extraction/transcription is done once per global episode media row; subscribers receive library entitlements to that row rather than per-user duplicate ingest. This controls cost and queue pressure.

**Quota charge point**: transcription quota is enforced at the point where new transcription work would be created, not at read time. Already-transcribed episodes can be attached without new transcription spend. Usage resets on a fixed daily boundary.

**Plan-policy limits are configurable**: per-day transcription minutes and per-subscription episode window are centralized policy/config values, not schema constants, so product can tune limits without redesigning ingest identity or usage semantics.

**Transcript segment as fragment specialization**: transcript segments are stored as fragment-anchored units with immutable text and timestamp metadata (`t_start_ms`, `t_end_ms`, optional `speaker_label`) so existing highlight/chat anchoring patterns can be reused across media kinds.

**Quote-to-chat transcript context contract**: transcript quote rendering includes temporal metadata (timestamp and speaker label when available), making quoted context auditable and seekable in audio workflows.

**Ingestion window strategy**: subscribe performs bounded immediate ingest for the newest episodes and uses progressive ingestion for older/newly discovered episodes, with strict idempotency and quota checks on every ingestion path.

**Failure posture for audio/transcription**: playback transport failures and transcript pipeline failures are treated independently; transcript usability is preserved when playback fails, and capability gating handles transcript-unavailable cases without violating processing-state invariants.

**Unsubscribe modes are explicit and non-destructive by default**: unsubscribe supports all three constitution-defined retention/removal modes, defaults to mode 1 (stop future ingestion only), and never removes from shared libraries implicitly.

## Out of Scope

- Stripe integration and self-serve billing flows
- Self-serve upgrade/downgrade UI
- Semantic/vector search for podcasts (Slice 9)
- Advanced player controls (speed, chapters, waveform, queue intelligence)
- Speaker identity resolution beyond raw diarization labels
- Podcast recommendations/ranking features
- Local audio hosting or audio proxy infrastructure

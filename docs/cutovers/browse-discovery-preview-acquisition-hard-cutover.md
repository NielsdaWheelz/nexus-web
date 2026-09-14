# Browse, Preview, And Acquisition — Hard Cutover

> **Podcast container-first All update (2026-08-02):**
> [`podcast-container-first-all-hard-cutover.md`](podcast-container-first-all-hard-cutover.md)
> supersedes only this document's claim that child episodes of an active
> subscription appear as independent All roots. Episode acquisition and physical
> retention, named-Library placement, sync, and backfill contracts remain here.

**Status:** IMPLEMENTED · LOCALLY VERIFIED · Rev 5 · 2026-07-29
**Type:** Hard cutover — no legacy paths, compatibility fallbacks, dual writes, or compatibility decoders
**Scope:** One-user production-shaped prototype; smallest coherent Browse release

This spec supersedes
[`browse-surface-deletion-hard-cutover.md`](browse-surface-deletion-hard-cutover.md)
and the requirements-capture revision of this document.

## 0. Decision

Restore **Browse** as the one top-level, deep-linkable surface for discovering
things Nexus does not yet own.

> **Browse is reversible; acquisition is deliberate.**

- Search remains owned-only.
- Browse federates Nexus matches with external candidates and resolves owned
  collisions.
- Pane Filter narrows an already-loaded collection; Browse search is retrieval
  identity and does not publish pane Filter/Find capability.
- Open and Preview do not acquire.
- **Add** acquires one Media item.
- **Subscribe** creates one active Podcast relationship and begins live sync
  plus historical backfill.
- All is implicit; the chooser selects additional named Libraries.

There are no blocking product questions. Defaults fixed by this spec:

1. empty Browse has no recommendation feed and makes no provider call;
2. backlog means all safely discoverable episode metadata/playback sources, not
   enclosure download, queueing, or transcription;
3. external discovery identity is ephemeral; durable backfill state is not.

## 1. Goals And Non-goals

### Goals

1. One Browse pane, one Preview pane, one provider boundary.
2. Exact chips: **All · PDF · EPUB · Web Article · Video · Podcast**.
3. Non-mutating, reloadable Preview for every stable external candidate.
4. Explicit Add/Subscribe split controls with optional named-Library filing.
5. One canonical named Podcast placement fact.
6. Podcasts and episodes both fileable; no redundant parent/child filing.
7. Active subscriptions and their episodes appear in All without a Default
   Podcast `library_entries` row.
8. Bounded, resumable, independently fenced Podcast backlog.
9. Video/episode transcription only after acquisition and explicit Transcribe.
10. Reuse current workspace, collection, intake, Library, Podcast, player,
    transcript, proxy, and provider primitives.

### Non-goals

- Episode search/chip; the current show-search-plus-recent-episodes behavior dies.
- Recommendations, saved searches, lenses, feeds, or a result warehouse.
- Cross-provider score normalization, reranking, or a generic federation/plugin DSL.
- Enclosure download, automatic queueing of the backlog, or bulk transcription.
- Google Scholar scraping, Sci-Hub, Anna's Archive, NewPipe/Innertube, or
  arbitrary iframes.
- Scholarly graph, Internet Archive, direct arbitrary RSS, or a true episode
  index.
- A repository-wide ID/handle migration, Library smart-view redesign, or player
  queue redesign.
- Custom result caching; provider/HTTP caching is sufficient.

## 2. V1 Capability Contract

| Kind | Sources | External Preview | Commit |
| --- | --- | --- | --- |
| PDF | Nexus only | none; owned hit opens Media | existing Media |
| EPUB | Nexus, Project Gutenberg | metadata + source | Add Media |
| Web Article | Nexus, current read-only Brave provider | metadata + Open source | Add Media |
| Video | Nexus, YouTube Data API + official iframe | click-to-load video | Add Media |
| Podcast | Podcast Index + safe RSS reads | show + episode list | Subscribe |
| Episode | surfaced from Podcast Preview only | metadata + user-started audio | Add Media |

PDF remains an honest owned-only chip until a source can identify remote PDFs
without suffix guessing. Brave results are Web Articles; this cutover does not
pretend they are PDFs. Project Gutenberg projects as EPUB.

NewPipe contributes the useful architecture—provider adapter plus continuation—
not its reverse-engineered YouTube transport. Nexus uses the official YouTube
Data API and iframe. Podcast products contribute the useful intent split:
preview/play an episode without following; follow a show explicitly. Zotero and
Reader contribute the acquisition boundary and Libraries-as-relationships model.
Episode results have no V1 search section, but their sealed Preview URLs remain
reloadable, bookmarkable, and directly reachable.

Podcast intentionally has no Nexus Browse source. The existing Podcasts surface
owns subscribed-catalog search; duplicating it in Browse would add an owned-only
search path. Browse still resolves Podcast Index results against active
subscriptions and routes owned collisions to the canonical Podcast pane.

## 3. Target UX

### 3.1 Navigation And Routes

- Desktop order:
  **Lectern, Libraries, Browse, Podcasts, Chats, Notes, Stats, Atlas, Oracle**.
- Mobile Places order:
  **Lectern, Libraries, Browse, Podcasts, Chats, Notes**.
- `Browse` is a destination, pane route, render-registry entry, and semantic
  section.
- `/browse` is the standing retrieval pane.
- `/browse/preview?target=<DiscoveryTargetHandle>` is the external Preview pane.
- Owned results link directly to `/media/{id}` or `/podcasts/{id}`.
- Plain click/Enter is Follow; Shift+pointer is Fork; Meta/Ctrl/Alt/middle-click
  remain browser-owned through `targetLinkActivation.ts`.
- Successful Add/Subscribe **replaces** Preview with the canonical pane. It
  does not leave a stale external Preview behind.
- Browse declares `queryNavigation: "in-place"`. Submit and facet changes
  replace the current Browse visit; opening Preview pushes pane history;
  acquisition replaces Preview.
- Browse snapshots its exact committed URL, decoded pages/cursors, per-section
  status, focus, and scroll through the existing pane-visit memento. Back from
  Preview restores that snapshot without provider refetch; an absent/evicted
  memento performs the normal URL-owned load. Because unmount cancels a
  component-owned request, capture converts a live Pending section to the local
  typed **Search paused** failure with Retry; Back never restores an immortal
  spinner or automatically repeats provider spend.
- Browse header is **Browse**. Preview header is the candidate title with source
  credit. Neither route publishes `FilterRows | FindOccurrences`.

Committed retrieval state belongs in the Browse URL:

```text
q · kind · source · sort
```

Defaults are omitted. Decode is total: `Valid | Invalid`. Unknown, duplicate,
or inapplicable external values are Invalid, cause zero provider calls, and
render `FeedbackNotice` with **Reset Browse**. In-app controls always encode a
complete Valid state and rewrite dependent facets to their defaults.

`q` is part of that total decode:

- absent means the empty query and performs no retrieval;
- committed `q` occurs exactly once, is NFC, trimmed, 1–200 Unicode code
  points, and contains no C0/C1 control character;
- in-app submit trims and NFC-normalizes once; an empty draft removes `q`;
- externally supplied empty, whitespace-only, duplicate, over-limit, control-
  bearing, or noncanonical `q` is Invalid rather than silently normalized.

### 3.2 Pane Grammar

```text
Search field
All · PDF · EPUB · Web Article · Video · Podcast
Source · supported Sort
Results / source sections
```

- Draft query is local. Enter/Search commits it; no per-keystroke provider spend.
- Empty query focuses the field and performs no retrieval.
- Source is separate from kind and hidden when only one option applies.
- Sort exists only when Video + YouTube is selected:
  **Relevance · Newest**. It is absent everywhere else, including Video with
  all sources.
- Do not expose speculative date, duration, language, category, popularity, or
  availability controls.
- Ownership is row/collision state, not a facet. Owned-only duplicates Search;
  external-only filtering would produce misleading partial provider pages.
- All renders fixed kind/source sections. Each section owns loading, error,
  Retry, rows, and manual continuation independently.
- A single-kind view preserves fixed source blocks when multiple source scores
  cannot be compared.
- No partially loaded count is called a total.

Valid committed states:

| Kind | Source | Sort |
| --- | --- | --- |
| All/absent | absent | absent |
| PDF | absent/Nexus | absent |
| EPUB | absent/Nexus/Project Gutenberg | absent |
| Web Article | absent/Nexus/Brave | absent |
| Video | absent/Nexus | absent |
| Video | YouTube | absent/Newest |
| Podcast | absent/Podcast Index | absent |

Absent source means all sources applicable to that kind. Changing kind removes
an inapplicable source/sort; changing source removes an inapplicable sort.

All uses this exact section order:

```text
PDF/Nexus
EPUB/Nexus · EPUB/Project Gutenberg
Web Article/Nexus · Web Article/Brave
Video/Nexus · Video/YouTube
Podcast/Podcast Index
```

Every applicable section reserves one stable header and compact status/rows
region; it never renders a stack of full-pane skeletons. Pending is one
`aria-busy` status row, empty is **No results**, failure is the exact section
failure plus Retry, and continuation preserves committed rows. Announce the
first usable result set and one all-sections-settled summary only; do not
announce every settlement or cause layout shift.

Use `CollectionView` and canonical row geometry. A result is one semantic link,
not a nested control cluster. The selected Preview owns actions.

### 3.3 Preview

| Preview | Body | Primary action |
| --- | --- | --- |
| Podcast | overview, source, recent/discoverable episodes | **Subscribe** `[▾]` |
| Episode | show context, notes, source, remote audio | **Add** `[▾]` |
| Video | metadata, source, click-to-load official iframe | **Add** `[▾]` |
| EPUB/Web Article | metadata, provenance, Open source | **Add** `[▾]` |

- Preview refetches provider truth by stable ref.
- If refetch now resolves the target as owned, Preview immediately replaces
  itself with the canonical Media/Podcast pane; acquisition controls never
  render for owned targets.
- Missing stable identity is omitted or external-open-only.
- Remote images use the existing image proxy.
- Web content is never embedded in an arbitrary iframe.
- Podcast audio starts only after user action and names its source host.
- No transcript UI or Transcribe action exists in Preview.
- Preview query decode is total; missing, duplicate, extra, malformed, or
  obsolete target state is never normalized.
- Malformed/obsolete target handles render **Invalid preview link** with
  **Back to Browse**; provider deletion renders **No longer available**. Both
  are terminal, recoverable, and issue no acquisition mutation.
- Workspace/history persistence and operational provider telemetry are allowed.
  Preview must make **zero acquisition-domain writes**: no Media, Podcast,
  subscription, Library entry, ingest/transcript job, consumption state,
  activity, progress, completion, or Lectern write.

### 3.4 Action Controls

- Media/episode main button: **Add**. All is implicit.
- Podcast main button: **Subscribe**. All and backlog are implicit.
- Chevron opens **Also add to** through `LibraryDestinationField` and its
  responsive `LibraryDestinationPicker`. Selection is staged locally; the main
  Add/Subscribe button commits one batch. There is no immediate mutation,
  per-row picker, second chooser, or “Default” checkbox.
- Main action and chevron are distinct focusable buttons. The chevron declares
  `aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls`; Enter/Space
  opens the responsive picker, Escape closes it, and focus returns to the
  chevron. A visible `+N` and the accessible action name expose staged
  destinations even while the target is unowned.
- Adding a Podcast to a named Library while unsubscribed is Subscribe with that
  destination.
- On the canonical pane for an owned Podcast, **Subscribed** is state, not a
  disabled dead end; its **Also add to** picker stages destinations. A nonempty
  staged delta changes the primary to **Add to _N_ Libraries**; that button
  sends the same batch Subscribe command without restarting backlog.
- There is no Add Podcast, Save Podcast, catalog-only Podcast, or saved-but-
  unsubscribed Podcast action.
- `PodcastReplacementDialog` owns the typed 409 warning. Cancel writes nothing.
  Confirm starts a new logical command with a fresh mutation ID; transport retry
  of that frozen confirmed command reuses it. Cancel or a refreshed 409 retains
  staged destinations.
- Buttons disable duplicate submission and retain one mutation ID per frozen
  logical payload.
- Before dispatch, the control freezes the exact payload and mutation ID. A raw
  network failure, connection timeout, or post-dispatch transport abort is
  **Delivery unknown** and offers Retry with that same frozen command/key.
  Owner cancellation before dispatch writes nothing and offers no Retry.
- Target disappearance becomes **No longer available**. Authorization changes
  use the existing auth/permission feedback, refetch destinations, prune only
  destinations no longer writable, retain the still-authorized staged set, and
  require an explicit resubmit. Unknown same-system failures and idempotency
  replay mismatches defect; they are not collapsed into generic acquisition
  copy.

## 4. Domain And Wire Types

All enums use repository casing. All owned semantic absence uses
`Presence<T>`. Third-party null is normalized at provider ingress.

```text
BrowseKind   = Pdf | Epub | WebArticle | Video | Podcast
BrowseSource = Nexus | ProjectGutenberg | Brave | YouTube | PodcastIndex
BrowseSort   = Relevance | Newest

DiscoveryTarget =
  ProjectGutenbergEpub { ebookRef }
  BraveWebArticle      {
    canonicalUrl,
    searchProvenance: Presence<BraveResultRef>
  }
  YouTubeVideo         { videoRef }
  PodcastIndexPodcast  { podcastRef }
  PodcastIndexEpisode  { podcastRef, episodeRef }
```

`DiscoveryTargetHandle` seals canonical JSON for that closed union under a
Browse-specific domain using the existing sealed-handle signing root and
canonical base64url/HMAC primitives. HMAC authenticates integrity, never viewer
authority. The handle is:

- returned by search/Preview;
- allowed in route state and transient caches;
- decoded and refetched by Preview/Add/Subscribe;
- identity only, never authorization;
- not a table, Media/Podcast row, `ResourceRef`, Add draft, or saved result.

Unknown/obsolete handle domains fail `E_INVALID_DISCOVERY_TARGET`; there is no
compatibility decoder.
For Brave, the validated public `canonicalUrl` is identity and is refetched
through the existing safe-fetch boundary; a search-result ref is transient
provenance, never reload identity.

```text
BrowseResolution =
  InNexus     { href }
  Preview     { target: DiscoveryTargetHandle }
  ExternalOnly { sourceHref }

PodcastCommitTarget =
  Discovery { target: DiscoveryTargetHandle }
  Canonical { podcastId }

BrowseCandidate = {
  kind, source, resolution: BrowseResolution,
  title, contributors,
  description: Presence<Text>,
  publishedAt: Presence<Instant>,
  image: Presence<ProxiedImageSource>,
  kindFacts: closed kind-specific record
}

BrowsePage = {
  query, kind, source, sort,
  items: BrowseCandidate[],
  nextCursor: Presence<BrowseCursor>
}

BrowseSectionFailure =
  Unavailable
  RateLimited { retryAt: Presence<Instant> }
  QuotaExhausted { resetAt: Presence<Instant> }
```

Provider adapters construct that union only from classified provider facts:

- contract-recognized rate limiting → `RateLimited`;
- contract-recognized quota exhaustion → `QuotaExhausted`;
- the section's intentionally modeled provider/network outage after its bounded
  external-service retry policy → `Unavailable`;
- missing/bad credentials, impossible configuration, malformed provider data,
  schema drift, and unknown non-transient responses are defects and never a
  permanently soft section.

The frontend decodes the exact same-system shape once and rejects unknown keys,
unknown variants, omitted `Presence`, raw null, malformed handles, and
noncanonical internal hrefs. `podcastId` is the honestly named existing scoped
Podcast identifier; this cutover does not invent a nonexistent Podcast handle
or widen into the repository-wide ID/handle migration.

## 5. API

### 5.1 Reads

```http
GET /browse?q=<query>&kind=<kind>&source=<source>&sort=<sort>&limit=<n>&cursor=<cursor>
GET /browse/preview?target=<handle>&limit=<n>&cursor=<cursor>
```

- `kind` and `source` are required and concrete. There is no backend `All`.
- One UI section equals one request. All fans out in the browser with at most
  three concurrent requests and stable section order.
- Search returns one strict `BrowsePage`.
- Preview returns one strict kind-specific union; Podcast Preview contains an
  independently continuable episode page.
- Owned resolution is viewer-relative: visible Media or active subscription.
  A structural Podcast row created for an episode is not “In Nexus” for a user.
- Browse cursors use `signed_keyset_cursor.py` with unversioned families
  `BrowseSearch` and `BrowsePreviewEpisodes`.
- The search query digest binds viewer, normalized query, kind, source, sort,
  provider/locale/safety contract, and a named keyset/continuation plan.
- The Preview-episode digest additionally binds the Podcast target, provider,
  order, and named continuation plan. A cursor cannot cross shows.
- Unsigned cursors, wrong scalar kinds, or any family/digest/plan mismatch fail
  `E_INVALID_CURSOR`. Contract changes invalidate through the digest; do not
  version a cursor name.
- Invalid query tuples fail `E_INVALID_BROWSE_QUERY`; malformed, obsolete, or
  wrong-kind handles fail `E_INVALID_DISCOVERY_TARGET`. Rate/quota failures
  project the closed `BrowseSectionFailure` union with retry/reset facts where
  the provider supplies them.

Adapters declare their truthful kinds, filters, sorts, cursor, and Preview
support in one small code-owned matrix. There is no generic registry.

### 5.2 Mutations

Reuse:

```http
POST /media/from_url
{ url, library_ids }
Idempotency-Key: <clientMutationId>
```

Preview supplies the previously server-resolved Gutenberg, Brave, or YouTube
source URL. Intake still treats it as untrusted input: it revalidates/safe-
fetches, classifies, dedupes, creates/reuses Media, writes All plus named
destinations, and enqueues only source-required processing.

Add:

```http
POST /podcast-episodes/from-discovery
{
  target: DiscoveryTargetHandle,
  namedLibraryIds: LibraryId[]
}
Idempotency-Key: <clientMutationId>
```

Subscribe:

```http
POST /podcasts/subscriptions
{
  target: PodcastCommitTarget,
  namedLibraryIds: LibraryId[],
  replacementConfirmation: Presence<{
    conflictFingerprint
  }>
}
Idempotency-Key: <clientMutationId>
```

Relationship removal:

```http
DELETE /podcasts/subscriptions/{podcastId}
Idempotency-Key: <clientMutationId>

DELETE /libraries/{libraryId}/podcasts/{podcastId}
Idempotency-Key: <clientMutationId>

POST /podcasts/subscriptions/{podcastId}/backfill/retry
Idempotency-Key: <clientMutationId>
```

- Episode Add and Subscribe re-resolve provider truth server-side; client
  metadata is never a write payload. Relationship removal resolves only
  canonical local identity and current authorization.
- Every replayable mutation first canonicalizes its method/path/payload and
  checks its owner's durable replay record **before** provider resolution or
  external I/O. An exact hit returns the frozen response without a provider
  call. A miss may resolve provider truth, then must repeat the locked replay
  check inside the mutation transaction before any domain write; this second
  check closes concurrent first-attempt races.
- A Discovery target resolves provider truth; a Canonical target resolves the
  existing Podcast and current authorization.
- OPML remains a separate feed-input boundary, but after feed resolution its
  per-feed DB phase calls the same ordered relationship/subscription primitive
  as canonical Subscribe.
- Named Library inputs are additive; they never replace all existing Podcast
  placements.
- With no active row, the command subscribes and starts one backlog. With an
  active row, it preserves that subscription/backfill and adds only missing
  destinations.
- Hard-delete the separate `POST /libraries/{library}/podcasts` Add path; every
  external/canonical Subscribe-or-file entry point uses this one batch command.
- Unsubscribe applies §7.3. Removing a Podcast from one named Library removes
  only that placement and never unsubscribes.
- Subscribe returns canonical href, idempotency outcome, per-destination
  outcome, `Subscribed | AlreadySubscribed | DestinationsAdded`, collection
  revisions, and backfill state.
- Unsubscribe returns
  `Unsubscribed { removedPlacementCount, retainedSharedCount } |
  AlreadyUnsubscribed`.
- Removing one named placement returns `Removed | AlreadyAbsent`. It requires
  writable authority for that named non-system Library; Default/system targets
  are invalid, and membership/visibility failures use the Library owner's
  existing authorization/not-found policy.
- Backfill Retry is allowed only for an active subscription whose current
  backfill is `Failed`. It atomically replaces that terminal fence, enqueues one
  step-zero job, and returns `Retried { backfill } | NotEligible { backfill }`;
  repeated transport delivery replays the same result and never starts a second
  chain. An absent/invisible subscription uses the existing Podcast not-found
  policy; `NotEligible` means a current visible non-Failed backfill.
- Episode destination outcomes are `Added | AlreadyPresent |
  IncludedThroughPodcast`.
- Every §5.2 mutation uses the `Idempotency-Key` header; this control family has
  no body-key dialect.
- Podcast relationship/episode/backfill/position commands use
  `resource_mutation_replay`. `/media/from_url` retains the source-ingest
  owner's `MediaSourceAttempt` replay fact; it already gates before provider
  work and binds the key to the canonical source intent including
  destinations. Neither owner is wrapped by a third idempotency service.
  Reusing one key with different method/path/payload or source intent is
  `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`. `resource_mutation_replay` returns its
  frozen response; source ingest returns the same Media/source-attempt identity
  with its current lifecycle status. Both are one semantic commit.

After successful Add, Preview may transfer an audible position once:

```http
POST /media/{mediaId}/preview-position
{
  positionMs,
  durationMs: Presence<Milliseconds>
}
Idempotency-Key: <clientMutationId>
```

The consumption owner verifies visible ownership, clamps the position, and
installs it only when no pre-existing listening progress exists. Failure is
non-fatal feedback: acquisition remains committed. Add awaits the transfer
settlement, carries any nonfatal feedback into the canonical pane, then
performs the canonical replace. Position transfer is a separate frozen logical
command with its own mutation ID, stable across only its transport retries.

Podcast placement conflict:

```http
409 E_PODCAST_REPLACES_EPISODES
{
  conflicts: [{ libraryId, libraryName, episodeCount }],
  conflictFingerprint
}
```

The opaque fingerprint binds actor, Podcast, exact destinations, Library
IDs, and the exact conflicting entry-ID set—never the family-wide collection
revision. Retrying with that fingerprint is confirmation, not authorization.
The service recomputes under locks; a changed set returns a fresh 409 and
performs no mutation. No plan/confirmation table or service exists.

## 6. Final Persistence Model

### 6.1 Subscription

Hard-cut `podcast_subscriptions`:

- add replay-stable application-generated UUIDv7 `id` primary key;
- retain unique `(user_id, podcast_id)`;
- delete `status`; row presence means active;
- unsubscribe deletes the row;
- retain live-sync status/settings, `last_synced_at`, and the separate
  auto-queue watermark.

This removes inactive-row branches and gives virtual All rows and backfill one
real subscription identity.

### 6.2 Named Podcast Placement

Drop `podcast_subscription_libraries`.

In the target state, `library_entries(podcast_id)` is the only named Podcast
placement fact and `library_entries.py` its sole writer. Default/All has no
Podcast entry. Migration reconciles the current parallel facts from
`library_entries(podcast_id)` and `podcast_subscription_libraries`; this claim
does not describe the pre-cutover schema.

For every named `(library, podcast)`:

```text
Podcast entry and direct Media entries for that Podcast's episodes are
mutually exclusive
```

Application code enforces this under the Library owner's locks; no trigger,
business `CHECK`, closure table, or dual write exists.

Compaction is intentional and one-way: replacing direct episode entries with
the Podcast entry discards their explicit named-Library filing intent. Removing
the Podcast later does not restore those episode entries. The confirmation
dialog states this consequence; V1 adds no latent-child-intent table.

### 6.3 Episode Identity And Backfill

Hard-cut episode identity before adding backlog:

```text
EpisodeIdentityScheme = PodcastIndex | RssGuid | RssEnclosure

podcast_episode_identities
  id UUIDv7 PRIMARY KEY
  podcast_id UUID
  scheme text
  value text
  episode_media_id UUID
  created_at timestamptz
  UNIQUE (podcast_id, scheme, value)
  FOREIGN KEY (podcast_id, episode_media_id)
    REFERENCES podcast_episodes(podcast_id, media_id)  -- no cascade
  INDEX (episode_media_id)
```

The scheme is a closed application type, not a DB `CHECK`. Remove
`provider_episode_id`, `guid`, and `fallback_identity` from
`podcast_episodes`; the alias table is acquired canonicalization state, not
saved discovery state. Add the supporting unique
`podcast_episodes(podcast_id, media_id)` constraint required by the composite
foreign key.

For every ingest, normalize and validate all derivable aliases before writing.
One episode may own at most one `PodcastIndex` and one `RssGuid` alias;
`RssEnclosure` aliases may accumulate. Those cardinalities are application
invariants: violation is a typed reconciliation failure, not a DB `CHECK`.

Within one provider page/batch, the same Podcast Index ref or nonblank GUID
claimed by distinct item records fails the whole batch before writes unless a
shared stronger alias already proves they are the same episode. When probing
stored aliases:

1. no alias exists: create one episode/Media and store every alias;
2. all existing aliases name one episode: reuse it only if every missing strong
   alias satisfies the one-per-scheme invariant;
3. aliases name multiple episodes: return a typed reconciliation failure before
   filing or mutation; never choose one;
4. a GUID resolves one episode but the candidate introduces a previously unseen
   enclosure without also supplying a Podcast Index alias already bound to that
   episode: fail as ambiguous rather than silently merge a duplicate-GUID feed
   item;
5. no stable alias: omit the candidate and mark traversal `SourceLimited`.

Acquire namespaced transaction advisory locks for all candidate aliases in
canonical `(scheme, value)` order before probing; the unique alternate key is
the race backstop and the whole resolver runs through `retry_read_committed`.
Attaching a missing Podcast Index/GUID alias may advance the canonical
diagnostic anchor; enclosure aliases only accumulate. Stored aliases are never
replaced or forgotten. Title, publication time, and random values are never
identity. RSS-then-Podcast-Index and Podcast-Index-then-RSS must converge to one
Media.

There is no winner-takes-all identity precedence. After equivalence is proven,
`PodcastIndex`, then `RssGuid`, then `RssEnclosure` selects only the canonical
diagnostic/observation key. Resolution always probes every alias. Enclosure URL
normalization uses the existing canonical URL owner and is frozen as persisted
identity semantics; changing it requires an explicit alias migration, never
reinterpretation on read.

Add `podcast_subscription_backfills`:

```text
id UUIDv7 PK
subscription_id UUID UNIQUE FK podcast_subscriptions(id)  -- no cascade
cutoff_at timestamptz NOT NULL
step_no bigint NOT NULL
cursor jsonb NULL
processed_count bigint NOT NULL
added_count bigint NOT NULL
started_at timestamptz NULL
completed_at timestamptz NULL
source_limited_at timestamptz NULL
failed_at timestamptz NULL
error_code text NULL
error_detail text NULL
created_at / updated_at
```

- `id` is application-generated and the worker fence; Retry atomically replaces
  the terminal row, and re-subscribe creates a row under the new subscription.
- For a new subscription, `cutoff_at` is the DB-authored subscription
  `created_at`. For a migrated active subscription, it is the migration
  transaction timestamp. Backlog admits dated items at or before this boundary;
  undated stable items returned by its cutoff-rooted continuation are admitted.
  Live polling still admits every stable item exposed by the current feed.
- The job payload carries `backfillId`, expected `stepNo`, and the digest of the
  expected cursor. `step_no` is the continuation-position replay fence.
- `cursor` is a strictly decoded closed provider-continuation union.
- `started_at` plus the exclusive terminal timestamp facts derive
  `Pending | Running | Complete | SourceLimited | Failed`; do not persist
  another status discriminator.
- Terminal facts are mutually exclusive by service invariant, not DB `CHECK`.
- `error_code` is bounded and `error_detail` is bounded, redacted operator
  context; neither stores provider bodies, URLs, credentials, or user content.
- Job leases remain in job infrastructure; no domain lease columns.
- Unsubscribe locks the current backfill row `FOR UPDATE`, then explicitly
  deletes it before deleting the subscription.
- Canonical Podcast UI and operator status consume the counters as
  **Backfilling · _N_ processed · _M_ added**. No other counters are stored.

This table is justified durable operation state. It is not a saved discovery
candidate or external identity table.

### 6.4 Library All DTO And Cursor

Default All is the live union of:

1. the current deduplicated personal Media set; and
2. the viewer's active Podcast subscriptions.

Hard-cut the list item top level:

```text
placement: Presence<{ libraryEntryId, position }>
addedAt: Instant
```

- Named rows have `Present` placement.
- Default virtual rows have `Absent` placement.
- Never fabricate an entry ID or position.
- Default `addedAt` is Media creation or subscription creation.
- Named `addedAt` is entry creation.

Default canonical order is:

```text
addedAt DESC, targetKind ASC, targetId DESC
```

Every other sort adds `(targetKind, targetId)` as its total tie-break. Extend the
existing unversioned `CollectionFamily.LibraryEntries` query digest to bind
viewer, Library, projection, completion, order, and a named keyset plan; do not
rename or version the cursor family. Wrong families, digests, plans, or scalar
kinds fail `E_INVALID_CURSOR`.

- `{ kind: "AllItems", completion: "all" }` includes Podcast shows.
- `{ kind: "AllItems", completion: "unfinished" }`,
  `{ kind: "Unfiled", completion: "all" | "unfinished" }`, and
  `{ kind: "InProgress" }` exclude shows because a subscription has no honest
  completion/progress fact.
- Show title/creator are canonical Podcast facts; published date is the latest
  known episode date; added date is subscription creation in Default and entry
  creation in a named Library. Missing dates use the existing Presence/null
  ordering before the total `(targetKind, targetId)` tie-break.
- Library list/count and Default-scoped retrieval consume this one union.
- The Library owner bumps `LibraryEntries` in the transaction that changes any
  projected fact: subscription create/delete; Podcast placement
  insert/delete/compaction/reorder; Podcast title/creator/latest-episode facts;
  live-sync episode/Default facts; and every committed backfill batch. Existing
  Media filing, progress, and Library-entry writers retain their current bumps.
- Named reordering remains physical and unchanged.

The mixed-direction total order is one SQL keyset predicate using the existing
OR-ladder owner; it is not per-arm in-memory pagination. The union first
produces one ordered facts relation, then applies the signed cursor predicate.

### 6.5 Transcript Provenance

Add nullable `media_transcript_states.transcript_origin` as the sole current
transcript-origin fact:

```text
Publisher | Imported | Generated
```

- RSS sidecar writer sets `Publisher`.
- YouTube public-caption writer sets `Imported`.
- Deepgram writer sets `Generated`.
- Replacing current transcript segments replaces origin atomically; clearing
  them clears origin.
- The column is null unless transcript state is Ready/Partial; API projection is
  `Presence<TranscriptOrigin>`.
- Publisher/Imported retrieval consumes no AI entitlement or minute quota.
  Only Generated fallback checks `can_transcribe`, reserves, and settles the
  existing transcription-minute ledger.
- Migration classifies only from stored facts, in this order:
  1. `last_request_reason = rss_feed` on a Podcast episode → `Publisher`;
  2. everything else → ambiguous.
- `last_request_reason = episode_open` alone proves nothing: both YouTube
  captions and generated Podcast transcription use it today.
- Ambiguous Ready/Partial rows abort apply until the operator supplies a
  transcript-remediation manifest entry:
  `SetOrigin { mediaId, origin }` from verified evidence, or
  `ClearTranscript { mediaId }`. Clear removes current transcript segments and
  fragments and resets state/origin to `NotRequested`; it is allowed only when
  preflight proves no highlight, note, citation, graph, or other user state
  depends on them, and is explicitly destructive and reported. Referenced
  transcripts require `SetOrigin`. No `Unknown`/legacy origin survives the
  cutover.

RSS sidecar references remain Podcast source metadata. They are fetched only
after explicit Transcribe.

## 7. Backend Composition And Invariants

### 7.1 Browse

Replace the oversized `services/browse.py` with one deep Browse module:

- service: query/Preview orchestration and owned collision resolution;
- models/schema: closed domain and wire unions;
- cursor: shared signed codec composition;
- one adapter each for Nexus, Gutenberg, Brave, YouTube, Podcast Index.

Adapters reuse `gutenberg.py`, `search_web_readonly`, Podcast Index, safe RSS
fetch, `net/http_retry.py`, and YouTube identity. Provider parsing happens once
at ingress. Remove open-coded Browse sleeps/retries.

No adapter writes. No source failure erases another source's UI section.
Malformed provider payloads and configuration defects escape the section
failure channel and fail loudly at the Browse boundary.

### 7.2 Subscribe And Parent/Child Filing

An exact replay lookup occurs before provider resolution; provider resolution
occurs before a first mutation attempt. The DB phase repeats the replay check
and is one replayable READ COMMITTED command under ordered `FOR UPDATE` locks
and `retry_read_committed`:

1. resolves/locks Podcast family identity;
2. snapshots conflicting child Media identities;
3. locks that exact Media set in UUID order, then named Libraries in UUID order;
4. re-reads the child set and restarts/returns a refreshed 409 if it changed;
   it never acquires newly discovered Media locks while holding Library locks;
5. recomputes conflicts;
6. returns 409 with no writes when confirmation is absent/stale;
7. creates the active subscription and current backfill fact;
8. inserts named Podcast entries at the earliest removed child position, or
   appends when there were no children;
9. ensures removed child episodes have direct Default entries;
10. deletes only confirmed named child entries and normalizes positions;
11. enqueues live sync and backlog in the committed DB boundary;
12. bumps Podcast and Library collection revisions.

The one global order for operations that need these resources is:

```text
viewer/Podcast relationship advisory lock
→ queue job claim → backfill row → subscription row
→ episode-alias advisory locks (canonical scheme/value order)
→ Podcast → Media (UUID order) → Libraries (UUID order)
```

Operations skip irrelevant levels and never acquire an earlier level while
holding a later one. Every READ COMMITTED restart is bounded by
`retry_read_committed`. Subscribe and each resolved OPML feed take the same
relationship lock before subscription/placement work. Unsubscribe takes it
before locking the backfill/subscription rows. Live sync locks the subscription
before alias/Podcast/Media/Library work. Backfill follows job claim → backfill
→ subscription before resolving aliases. Episode Add skips relationship/job/
backfill/subscription but still takes aliases before Podcast. Provider reads
remain outside DB transactions and never hold these locks.

Every Podcast placement entry point calls the same Library-owned primitive.
Identity-bearing episode ingest acquires its candidate alias locks before its
parent Podcast. Every episode-Media filing through `library_entries.py`—single add,
`ensure_media_in_library`, intake destination arrays, agent filing, Slate Add,
live sync, and backfill—then resolves its parent Podcast before Media and
Libraries. Filing an already-canonical Media skips the alias level but keeps
Podcast → Media → Libraries. Default is always ensured. A named destination
already containing the parent returns `IncludedThroughPodcast` and creates no
child row. This intentionally retains no latent explicit filing intent: later
removal/unsubscribe does not recreate that child. The invariant is not scoped
to Browse callers.

Contributor application is unified, not assumed to exist today. Extract one
public contributor-observation port for `PodcastTarget | MediaTarget`, with an
in-current-transaction primitive and the existing fresh-session replay wrapper.
The current `media_author_observation_seam.py` runner delegates to that port.
Podcast ingest applies observations inside its fenced domain transaction,
replacing `SubscriptionIngestResult.author_observations →
replace_observed_role_slices`; direct Subscribe/OPML calls disappear.
Subscribe success no longer depends on a post-commit request thread. Backfill
step zero atomically applies show credits; every episode batch applies its typed
credits before that same transaction advances the continuation. No new
contributor table exists.

### 7.3 Unsubscribe And Shared Libraries

The Unsubscribe DB transaction takes the viewer/Podcast relationship advisory
lock, then locks the current backfill row, active subscription, Podcast, and
affected Libraries in the global order, then atomically:

- deletes the subscription and current backfill;
- removes Podcast entries only from viewer-owned Libraries with no other
  members;
- retains every shared/foreign placement, including shared Libraries the viewer
  owns or administers; removal there is an explicit Library-governance action;
- leaves episode Media, Default entries, progress, transcripts, and independent
  named episode entries;
- never restores child placements compacted earlier.

After that primary-state commit, an awaited durable queue-owner step revokes
live/backfill work. A leased zombie may finish its provider read, but its locked
backfill lookup then observes absence and returns the typed successful
`StaleOrUnsubscribed` no-op. It never dead-letters or writes domain state.

Removing one named placement uses the Library owner's authorization and ordered
Library lock, returns `Removed | AlreadyAbsent`, changes no subscription, and
never restores child entries.

A retained shared Podcast can remain visible to an unsubscribed viewer and
offer Subscribe, but it is not in that viewer's All.

### 7.4 Live Sync And Backfill

Delete `PODCAST_INITIAL_EPISODE_WINDOW` and every sync-run use of that cap; it
currently limits all polls, not only an initial path. Live and historical work
share one episode-ingest primitive but never one cursor/watermark.

```text
subscription cutoff
├── live: every stable item exposed by each current-feed poll
└── backlog: historical continuation rooted at cutoff, newest first
```

`last_synced_at` schedules/reports live polls; it is not episode admission.
Live always upserts the entire currently exposed bounded feed, including
undated/backdated arrivals. Multi-alias identity resolution makes overlap with
backlog harmless.

Each backlog job:

1. performs an unlocked cheap preflight of
   `backfillId + expectedStepNo + expectedCursorDigest` only to avoid needless
   provider spend; this read is never the fence;
2. fetches one bounded provider/feed page through safe-fetch policy and decodes
   `Items + Continuation | Exhausted | SourceLimited`;
3. sorts the batch newest-first and opens one bounded
   `retry_read_committed` transaction;
4. calls `lock_and_renew_running_job_claim` for the exact current job attempt,
   then `SELECT ... FOR UPDATE` on the backfill row;
5. revalidates the exact `(backfillId, expectedStepNo, expectedCursorDigest)`
   fence under those locks, resolves aliases, materializes
   episode/Media/Default facts, applies contributor observations, increments
   counters once, bumps `LibraryEntries`, advances `step_no`, and stores
   continuation/terminal facts;
6. when continuation remains, calls `enqueue_unique_job` in that same
   transaction with unique key
   `podcast-backfill:{backfillId}:{nextStepNo}`; terminal steps enqueue none;
7. returns only after that domain transaction commits; queue completion remains
   a separate generic worker transition.

Rules:

- no enclosure download, Lectern insertion, or transcript publication;
- resolve the complete alias set under §6.3; without any stable alias, omit and
  mark SourceLimited—never use title/time or mint a random identity;
- unsafe/cyclic continuation, provider/page cap, or identity loss is
  SourceLimited, not Complete;
- Complete means every currently exposed continuation was exhausted, not the
  show's lifetime;
- persistent backfill failure is an intentionally modeled Failed outcome after
  its bounded retry schedule; Retry replaces the fenced backfill and restarts
  idempotently;
- the registry declares `failed_result_statuses=("failed",)` and a dead-letter
  handler. In the queue's dead-letter transaction, that handler locks the
  backfill row `FOR UPDATE` and stamps `failed_at`/bounded error only when the
  payload's backfill ID, expected step, and cursor digest still name the current
  nonterminal row;
- replay after a crash between domain commit and generic job completion returns
  `AlreadyApplied`; it cannot increment counters or enqueue a second successor;
- a lost/noncurrent job claim returns successful `StaleJobAttempt`;
  missing/deleted backfill or subscription returns successful
  `StaleOrUnsubscribed`; an expected step behind current returns successful
  `AlreadyApplied`. None writes, retries, or dead-letters. A future step or
  same-step cursor mismatch is an invariant defect and fails closed;
- live sync continues while historical backfill runs.

### 7.5 Explicit Transcribe

Hard-cut implicit transcript work:

- Podcast sync stores RSS transcript references but removes eager fetch/write.
- YouTube Add fetches metadata and publishes playable Media only.
- `youtube_video_ingest.py` no longer starts transcript state or fetches captions
  during acquisition.
- Generalize the existing canonical Media Transcribe command to
  PodcastEpisode and Video.
- Episode Transcribe prefers a valid publisher sidecar, then the existing
  generated-transcript path.
- Video Transcribe uses the existing YouTube transcript provider path.
- Canonical video/episode playback remains available while transcript state is
  NotRequested.

## 8. Frontend Composition

- `BrowsePaneBody`: draft query, exact URL model, chips/facets, fixed sections.
- `BrowseSection`: one request generation, committed page, continuation,
  isolated Retry, stale-settlement rejection. It must compose
  `useCursorPagination`; exact decoding uses `api/presence.ts`; return
  restoration uses `usePaneVisitData` and the existing scroll/focus memento.
  Extract the identical host-runtime `asRecord`/`exactKeys` helpers repeated by
  Lectern, listening-heartbeat, Resonance, and `DossierDocumentFrame` into
  `api/exact.ts`, then reuse them with Browse. The generated self-contained
  `dossierDocumentRuntime.ts` iframe program keeps its local copy because it
  cannot import host modules. Do not implement another pagination, exact-
  decoding, or pane-return stack.
- `BrowsePreviewPaneBody`: strict Preview union and explicit action.
- `lib/browse/contract.ts`: domain/wire types and exact decoders.
- `lib/browse/query.ts`: sole URL codec.
- `lib/browse/client.ts`: transport only.
- `lib/collections/presenters/browse.ts`: candidate → canonical row view.
- `AcquisitionControl`: compact Add/Subscribe split control composed with the
  existing destination picker.
- Extract presentation-only `PodcastOverview`; canonical Podcast controllers
  retain progress, transcript, Lectern, and destructive behavior.
- Extract `YouTubeEmbedFrame` plus validator from
  `TranscriptPlaybackPanel`; canonical activity instrumentation stays outside
  the shared frame.
- `PodcastReplacementDialog` owns the 409 presentation and confirmed retry.
  `AcquisitionControl` owns staged named-Library selection; it performs no
  chevron-time mutation.
- `AcquisitionControl` also owns raw network/abort classification and preserves
  its frozen command/key in the active pane visit for **Delivery unknown**
  Retry; it does not rely on `ApiError` to catch `fetch` transport failures.
- Canonical Podcast detail renders the current backfill state/counters and owns
  the **Retry backlog** action for `Failed`; no Retry renders for other states.

Browse has quiet editorial catalog identity, not a generic metadata-card grid:
one semantic row with a bounded optional thumbnail, title, contributor/date,
and concise source credit. The Browse presenter maps source plus an `InNexus`
resolution into the existing `CollectionRowView.context` slot;
it does not add shared row fields, badge clouds, nested buttons, or provider
chrome. Pending/empty/failure presentation stays in the section, never in fake
result rows.

The global player gains an exhaustive `PreviewAudio` session variant inside its
one provider and one `<audio>` element. It uses `DiscoveryTargetHandle`
identity; do not make Media ID optional and do not create a Browse-local player.

| PreviewAudio concern | Contract |
| --- | --- |
| persistence/heartbeat/activity | none |
| completion on natural end | local `PausedAtEnd`; no completion POST |
| Lectern/history/queue | none |
| previous/next | unavailable |
| Media Session | metadata, play, pause, seek; unset previous/next |
| Media Session position | ephemeral `setPositionState`; clear on Preview session end |
| footer | title, source, Open source, Open Preview; no mutation or `/media/{id}` href |

Natural end means the audio element's non-looping `ended` event. The footer's
**Open Preview** follows the session target and is the only footer action toward
acquisition; `AcquisitionControl` in the active Preview is the sole mutation
owner. Add stops Preview playback, acquires, awaits the one-shot §5.2 position
transfer when eligible, carries any nonfatal transfer failure to the canonical
pane, clears Preview Media Session state, and only then replaces with canonical
Media. Transfer failure never rolls back Add.

Hard-delete duplicate external-discovery UI:

- `SwitchboardPodcastPanel`;
- `PodcastDiscovery`, `Nexus.Quick.Podcast`, their controller/fetch state, and
  auto-subscribe-on-select;
- standalone Nexus WebSearch renderer and Add-before-Preview path.

Desktop Nexus launcher rows remain non-interactive `role="option"` descendants
under `aria-activedescendant`; they dispatch an `InternalHref` rather than
nesting a link. Mobile Switchboard Places remain native `button` rows and
dispatch the same href through their existing tap/keyboard owner. Both
`SwitchboardPodcastPanel` render sites—desktop Nexus and mobile
`SwitchboardSheet`—are removed. “Search the web…” targets
`/browse?kind=WebArticle&q=<committed-query>`; Podcast Browse targets
`/browse?kind=Podcast`. Neither dispatches a provider-spending bare `All`.
The read-only Brave provider helper survives beneath Browse and chat; the
standalone WebSearch product surface does not.

`parseNexusUrlIntent` remains a total current-intent decoder. Any removed or
unknown intent, including old `intent=WebSearch` state reached through a cached
308, renders **This link is no longer supported** with **Open Browse** and makes
zero provider calls. It does not recover the old query, forward automatically,
or retain a compatibility decoder.

## 9. Migration And Deployment

Use the next free consecutive Alembic revisions at implementation time. Do not
edit history. The two DB revisions and maintenance command are one stopped-world
cutover; no application version supports the intermediate schema.

Preflight reports exact active/inactive subscriptions, legacy placements,
orphans, system/default destinations, duplicates, parent/child collisions,
unprovable episode identities, transcript-origin ambiguity, and affected rows.
`python -m nexus.ops.browse_cutover preflight` owns this report.
It runs against the intact `0200` legacy schema before the prepare revision;
`apply` is closed until the complete `0201` prepared schema is present.
The same bounded command owns
`apply --identity-map <path> --transcript-origin-map <path>` and `enqueue`; no
unnamed one-off script participates.

Identity classification is exact:

- nonblank legacy `guid` → `RssGuid`;
- validated normalized Media enclosure URL → `RssEnclosure`;
- legacy `provider_episode_id` → `PodcastIndex` only when durable source
  provenance proves Podcast Index origin;
- `episode-<uuid>`, legacy fallback strings, and ID shape alone prove nothing.

For every unprovable row, preflight emits an identity-remediation manifest. The
operator must either supply a verified `{ episodeMediaId, scheme, value }`
mapping or explicitly remove an episode/Media that the existing teardown
preflight proves has no Library, Lectern, progress, transcript, graph, or other
user state. Referenced rows require mapping. The maintenance command validates
alias collisions and records the manifest hash in the cutover report; it never
uses title/time similarity.

For every ambiguous Ready/Partial transcript, preflight emits a transcript-
remediation manifest. The operator supplies the exact §6.5 `SetOrigin` or
`ClearTranscript` decision. Apply validates Media/state consistency, records
the manifest hash and any destructive clear in the cutover report, and aborts
while any ambiguity remains.

The stopped-world sequence:

1. target-schema revision adds subscription UUIDs, episode aliases, fenced
   backfills, and transcript origin while retaining legacy columns;
2. the maintenance command applies verified aliases and aborts if any episode
   remains unprovable or aliases cross-link multiple Media;
3. it reconciles the union of current `library_entries(podcast_id)` and
   `podcast_subscription_libraries` facts for active subscriptions, dedupes
   exact overlaps, preserves the earliest existing Podcast-entry position,
   compacts named parent/child collisions at the earliest affected authored
   position, ensures Default child Media, and densely normalizes affected
   Libraries;
4. it snapshots and reports inactive-subscription placement rows, then
   intentionally discards them: an inactive relationship is not a saved
   Podcast in the target model;
5. it retains active subscriptions only, assigns each migrated backfill
   `cutoff_at = transaction_timestamp()`, classifies or applies remediation for
   every existing Ready/Partial transcript origin, and creates one pending
   backfill per retained subscription;
6. destructive-finalize revision reasserts every invariant, drops
   `podcast_subscription_libraries`, legacy episode identity columns, and
   subscription `status`, then bumps affected collection revisions;
7. the maintenance command enqueues exactly one step-zero job per pending
   backfill and proves none lacks one current nonterminal job.

Migration compaction cannot warn interactively; its preflight/report is the
warning and audit record.

Deploy in a maintenance window: stop writers/workers; preflight; apply the
prepare revision; run the bounded apply/compaction command; apply the finalize
revision; deploy API/web/workers; enqueue seeds; clear the one user's cached
`/browse` redirect/site data; smoke with a browser profile that visited old
`/browse`.

Rollback is a **paired application/database restore**, never an Alembic
downgrade. Before the prepare revision, the operator must:

1. record the exact deployed API/web/worker commit as `CUTOVER_FROM_SHA` and
   prove all three processes report it;
2. record `alembic current = 0200`, PostgreSQL server version, backup URI, byte
   size, and SHA-256 in the cutover report;
3. take a stopped-writer custom-format `pg_dump --no-owner --no-acl`, validate
   it with `pg_restore --list`, and restore it into a disposable database;
4. prove the disposable database is at `0200`, boot `CUTOVER_FROM_SHA` against
   it, and pass the pre-cutover authenticated Podcast/Library smoke.

Do not begin `0201` without that restore drill. On rollback, stop the new
API/web/workers, restore the verified dump into a fresh database, boot exactly
`CUTOVER_FROM_SHA` for all three processes, pass the same smoke, then switch the
database/application endpoints as one maintenance-window action. Never point
the old application at `0201`/`0202`, the new application at `0200`, or restore
over the failed database in place. Retain the failed database and cutover
report for diagnosis. The release record owns dump/restore command output,
hashes, process revisions, and both smoke results; a reset/re-upgrade migration
test is not rollback proof.

There is no dual-read/write window. If site data was not cleared, the stale
Nexus intent must reach the explicit unsupported-link state rather than
silently no-op.

## 10. File Plan

### Add

- `python/nexus/schemas/browse.py`
- `python/nexus/services/browse/{service,models,cursor,nexus,gutenberg,brave,youtube,podcast_index}.py`
- `python/nexus/services/contributor_observation_seam.py`
- `python/nexus/services/podcasts/backfill.py`
- `python/nexus/tasks/podcast_backfill_subscription.py`
- `python/nexus/ops/browse_cutover.py`
- `migrations/alembic/versions/<next>_browse_prepare.py`
- `migrations/alembic/versions/<next+1>_browse_finalize.py`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/preview/BrowsePreviewPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/preview/page.tsx`
- `apps/web/src/app/(authenticated)/browse/browse.module.css`
- `apps/web/src/lib/browse/{contract,query}.ts`
- `apps/web/src/lib/api/exact.ts`
- `apps/web/src/lib/collections/presenters/browse.ts`
- `apps/web/src/components/browse/{BrowseSection,AcquisitionControl,PodcastReplacementDialog}.tsx`
- `apps/web/src/components/podcasts/PodcastOverview.tsx`
- `apps/web/src/components/media/YouTubeEmbedFrame.tsx`
- `apps/web/src/app/api/browse/preview/route.ts`
- `apps/web/src/app/api/podcast-episodes/from-discovery/route.ts`
- `apps/web/src/app/api/podcasts/subscriptions/[podcastId]/backfill/retry/route.ts`
- `apps/web/src/app/api/media/[id]/preview-position/route.ts`
- focused behavior tests beside each owner

### Modify

- current `apps/web/src/app/(authenticated)/browse/page.tsx` into the real pane,
  and current `apps/web/src/lib/browse/client.ts` into transport only;
- navigation, app-nav, Switchboard Places, pane model/table/render registry,
  route header/query-navigation contracts;
- Browse, Podcast, Library, Media, and consumption FastAPI/BFF routes;
- `sealed_handles.py`, `signed_keyset_cursor.py` composition, and Browse error
  mapping;
- `db/models.py`, Podcast/Library schemas, auth/scope projections;
- `library_entries.py` and every generic episode-Media filing caller;
- `podcasts/{provider,identity,subscriptions,poll,feed,ingest,transcription}.py`;
- `media_author_observation_seam.py` callers into the unified contributor port;
- job queue claim/unique-enqueue composition, registry/dead-letter/config/
  environment contract;
- media source types/ingest, YouTube ingest, current transcript projection;
- contributor credits/presenters that emit legacy Gutenberg Browse hrefs;
- global player/session/footer and canonical transcript panel;
- Lectern, listening-heartbeat, Resonance, and
  `components/dossier/DossierDocumentFrame.tsx` host decoders onto
  `lib/api/exact.ts`; leave the generated self-contained Dossier iframe runtime
  local;
- Podcast list/detail Browse and placement actions;
- Nexus model/controller/dispatch projections, `SwitchboardSheet.tsx`,
  `SWITCHBOARD_QUICK_ACTION_IDS`, and `parseNexusUrlIntent`;
- `apps/web/src/lib/security/csp.ts` and the strict CSP specs without widening
  beyond the exact YouTube frame/remote-audio origins required;
- `apps/web/src/lib/workspace/bootstrap.server.test.ts`,
  `apps/web/src/lib/nexus/performance.{ts,test.ts}`,
  `e2e/tests/{nexus,app-navigation}.spec.ts`; app-navigation owns the new
  destination order and pane opening, not legacy-surface deletion;
- `docs/architecture.md`,
  `docs/modules/{app-navigation,library,podcast,player,workspace,video,web-article,epub,pdf,jobs}.md`.

### Delete / Extirpate

- the cached-308 `/browse` redirect implementation;
- current `services/browse.py`, untyped dict projections, unsigned cursors,
  server All aggregation, generic `documents`, and show search masquerading as
  `podcast_episodes` search;
- `apps/web/src/lib/browse/types.ts`;
- the already-unconsumed `/podcasts/discover` endpoint from
  `python/nexus/api/routes/podcasts.py`, its
  `apps/web/src/app/api/podcasts/discover/route.ts` proxy, and
  `PodcastDiscovery` Nexus/Switchboard overlay page state—not nonexistent page
  routes;
- `python/nexus/services/podcasts/discovery.py` after its provider behavior moves
  behind the Browse adapter;
- the `/web/search` FastAPI/BFF product proxy and WebSearch Nexus/Switchboard
  overlay state/renderer (`python/nexus/api/routes/web_search.py`,
  `apps/web/src/app/api/web/search/route.ts`); retain the read-only Brave
  service helper;
- `SwitchboardPodcastPanel`, both render sites in desktop Nexus and mobile
  `SwitchboardSheet`, and external auto-subscribe controller state;
- `podcast_subscription_libraries` model/table/service/query paths;
- subscription `status` branches and replacement-style
  `set_subscription_libraries`;
- separate `POST /libraries/{library}/podcasts` Add routing/client code;
- episode-to-every-subscription-Library propagation;
- random provider episode IDs and initial-window config/selection;
- eager YouTube/RSS transcript materialization.
- literal `/browse/gutenberg/{id}` links; emit a signed Preview target or a
  truthful external-source link.
- the `WebSearch` intent branch/name and version-suffixed cursor references
  attributed to Browse or `CollectionFamily.LibraryEntries` from active code,
  tests, and normative docs; unrelated cursor families are out of scope. The
  generic invalid-current-intent state remains.

## 11. Acceptance Criteria

1. Browse is present in exact desktop/mobile order; `/browse` and Preview
   restore as standard panes with specified headers/history; Browse publishes
   neither pane Filter nor Find. Desktop listbox options and mobile native
   buttons retain their distinct activation/accessibility contracts.
2. Exact chips/facets render. Every in-app transition emits a Valid tuple;
   exact `q` normalization/limits hold; malformed/external URL state renders
   Reset Browse, calls no provider, and is never silently normalized.
3. Empty query calls no provider. All issues bounded independent concrete
   requests in fixed section order with stable compact pending/empty/failure
   regions; `Unavailable`, `RateLimited`, `QuotaExhausted`, Retry, and
   continuation preserve other sections and prior rows. Credential/config/
   schema defects never masquerade as soft Unavailable.
4. Browse and Preview cursors are signed, unversioned, plan-bound, and
   scalar-kind checked; a Preview episode cursor cannot cross Podcasts.
   Pre-cutover unsigned/mismatched cursors fail `E_INVALID_CURSOR`.
5. Owned hits open canonical panes; external hits Preview; unstable hits are
   omitted/external-only. A Preview target acquired elsewhere canonical-
   replaces instead of showing Add. Invalid/obsolete handles and provider-
   deleted targets render their specified terminal states without mutation.
6. Follow/Fork/native modifiers, Back restoration, focus, announcements, and
   320px layout pass. Back restores committed pages/cursors/section state and
   scroll/focus from the pane memento without provider refan-out.
7. Open/reload/play/natural-end/leave Preview creates none of the forbidden
   acquisition rows, jobs, heartbeat/completion/activity events, or Media hrefs.
   Remote images are proxied; YouTube is click-to-load/allowlisted; arbitrary
   web is never framed. Preview Media Session position is ephemeral and cleared
   at session end.
8. Add is idempotent, commits staged All/named destinations once, stops Preview,
   settles its position transfer, and then replaces with canonical Media.
   Eligible Preview position transfers once; it never overwrites existing
   progress or rolls back Add on failure. A response-lost Retry returns the
   frozen result before provider resolution, and raw transport failure retains
   the same command/key. The footer cannot issue Add.
9. Subscribe is idempotent, projects Podcast into All, additively files staged
   named Libraries, and starts one live/backfill chain. Filing an already-active
   Podcast does not restart backlog.
10. Parent-over-child conflict returns the exact warning/count. Cancel or stale
    fingerprint writes nothing; confirmation uses a fresh logical mutation ID,
    recomputes under locks, preserves staged destinations and Default Media,
    and states that removed child intent will not be restored.
11. Episode Add works without subscription. Every generic episode-Media filing
    path returns `IncludedThroughPodcast` and creates no child row when the
    named Library contains its parent.
12. RSS→Podcast-Index and Podcast-Index→RSS ingestion converge to one Media and
    all aliases. Duplicate strong aliases within a batch, multiple strong aliases
    of one scheme on one episode, cross-linked aliases, and duplicate-GUID/new-
    enclosure ambiguity fail before filing. Candidates without a stable alias
    are never materialized.
13. All projects active subscriptions without Default Podcast entries or fake
    placement IDs. Exact Library lenses, factual sorts, Presence/null order,
    ties, counts, revisions, and the unversioned `LibraryEntries` cursor remain
    total and stable through one SQL keyset relation.
14. Unsubscribe removes the active All relation and only removable viewer-owned
    placements while preserving episodes/user state/shared placements and
    returns its closed absent/success outcomes. Removing one authorized named
    Podcast placement never unsubscribes or restores compacted children.
15. New/migrated cutoffs equal the specified DB times. Backfill is bounded and
    live-independent. Concurrent zombie/reclaimed workers serialize on the
    locked job claim and backfill row; replay after domain commit cannot double
    counters or fork `enqueue_unique_job` successors. Stale attempts and
    stale/unsubscribed jobs complete as typed no-ops; current retry exhaustion
    alone stamps `failed_at`. Failed Retry replaces one fence and starts exactly
    one new chain; all other states return `NotEligible`.
16. Every live poll ingests its entire safely exposed feed, without the legacy
    episode window. Alias overlap with backlog remains one Media.
17. Subscribe, OPML, live sync, episode Add, and backfill obey the one total
    lock order and use the one contributor-observation port. OPML's resolved
    per-feed DB phase uses the same relationship primitive; no request-thread
    best effort or bespoke Podcast episode loop remains.
18. Add/Subscribe/backfill never materializes transcripts. Explicit canonical
    Episode/Video Transcribe reports Publisher/Imported/Generated and charges
    only Generated.
19. Migration proves identity remediation, inactive-placement discard,
    transcript-origin classification/remediation, dual-placement reconciliation,
    compaction, seeded-job cardinality, and head schema. The release record
    proves the stopped-writer `0200` dump, hash/list validation, disposable
    restore, exact `CUTOVER_FROM_SHA` boot, and pre-cutover smoke required for
    paired rollback; Alembic downgrade remains rejected. A browser that cached
    the old `/browse` 308 reaches the new pane after the documented site-data
    step; without it, the stale intent renders the explicit unsupported-link
    state.
20. Residue scans find no deleted overlay/proxy, literal Gutenberg Browse href,
    legacy table/status/identity path, false episode search, random/title-time
    identity, auto-subscribe-on-open, child propagation, unsigned/versioned
    Browse or `LibraryEntries` cursor, duplicate observation path,
    initial-window cap, or eager transcript.

## 12. Required Proof

- Red/green unit proof for parsers, exact decoders, URL validity transitions,
  exact `q`, sealed target handles, both cursor domains/plans, alias resolution
  in both source orders, duplicate-GUID/new-enclosure rejection, and pure
  `PreviewAudio`/Media Session transitions.
- Real-DB/API integration proof for Preview no-write, Add/Subscribe replay,
  exact response-lost replay after provider disappearance with zero provider
  calls, canonical request-hash mismatch, fresh confirmation IDs, every
  parent/child filing entry point, Subscribe/OPML and live-sync/Unsubscribe
  races under the total lock order, All keysets/revision writers/lenses,
  authorized and absent Unsubscribe versus one-Library removal, standalone
  episode Add, contributor replay, Failed/NotEligible backfill Retry, and
  explicit transcript admission.
- Worker fault-injection proof at materialization, observation, step-advance,
  successor-enqueue, and generic queue-completion boundaries, plus an expired-
  lease zombie racing its reclaimed attempt. Prove locked-fence serialization,
  one counter increment, one `enqueue_unique_job` successor, typed stale-
  attempt/unsubscribed no-op, and fenced dead-letter finalization.
- Browser/component proof for semantic links, partial results, continuation,
  editorial row context, staged chooser/confirmation ARIA and failure states,
  raw `fetch` rejection retaining Retry with the same mutation ID, permission-
  refresh destination pruning, invalid/stale states, bounded announcements,
  focus, responsive layout, pane-memento return without refetch, embeds, footer
  non-mutation, every gated Preview-audio effect including `setPositionState`,
  and awaited conditional position transfer.
- Migration/head-schema/residue tests, including verified/manual identity
  remediation, inactive placement reporting, dual-placement reconciliation,
  both transcript-remediation actions, and a previsited browser profile with
  the old permanent redirect cached. Separately retain the §9 release record
  for the stopped-writer `0200` dump/hash, `pg_restore --list`, disposable
  restore, exact old-app boot, and authenticated smoke; local schema reset is
  not a substitute.
- `EXPLAIN (ANALYZE, BUFFERS)` for Default first/continuation pages in canonical
  and one alternate mixed-direction sort through the one SQL keyset relation;
  add indexes only if evidence requires them.
- `make test-csp` proves exact YouTube-frame and Preview-audio policy with no
  accidental allowlist widening.
- `make test-real-media` is the deterministic real-stack owner for
  Browse → Preview → Add/Subscribe → canonical pane; do not substitute MSW.
- Existing app-navigation and Nexus user-timing benchmark gates remain green
  after the overlay deletion and Browse dispatch cutover.
- Separate credentialed live smoke for Brave, YouTube, Podcast Index, RSS, and
  Gutenberg. Fixture success is not live-provider proof.

Implementation order is schema/contracts → backend owner cutovers → frontend
composition → migration/deletion → adversarial proof. All pieces deploy as one
hard cut; no intermediate behavior is a supported product state.

## 13. Implementation Evidence

Implemented on `codex/browse-discovery-hard-cutover` as one hard cut.

- Changed Python: Ruff format/check green (96 files).
- Changed web owners: ESLint and CSS-token checks green; E2E TypeScript green.
- Focused frontend unit/browser suites: 148 unit and 159 browser assertions
  green.
- Focused real-DB/API, worker, identity, library, consumption, replay, migration,
  and query-plan suites green, including fresh-schema `0200 → 0202`.
- Strict-CSP Browse/Preview gate green (3/3).
- Nexus/app-navigation and user-timing gate green (12/12).
- Production-built real-media Browse acquisition gate green (3/3): Podcast
  Preview → Subscribe → canonical Podcast and Episode Preview → Add → canonical
  Media.
- Hard-cut residue scans are clean; remaining legacy table/column mentions are
  confined to the stopped-world `0201` cutover preflight/remediation operation.

Not claimed by local proof: credentialed Brave/YouTube/Podcast Index/RSS/
Gutenberg smoke, the stopped-writer release dump/hash/restore and paired-
rollback drill, CI, deployment, or production attestation. The repository-wide
web typecheck retains inherited PDF/pane-search/pdfjs errors outside this
cutover; changed-owner lint, focused tests, and the production web build are
green. The broad pre-existing real-media project still has unrelated Add-content
dialog and evidence-highlight failures; the cutover-owned real-media spec is
green.

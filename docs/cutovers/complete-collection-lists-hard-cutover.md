# Complete Collection Lists Hard Cutover

Status: IMPLEMENTED — validated 2026-07-29; deployment pending.

> **Pane Filter update (2026-07-29):**
> [`collection-pane-search-filter-sort-hard-cutover.md`](collection-pane-search-filter-sort-hard-cutover.md)
> replaces Podcast subscription/episode `q` identities and predicates,
> `PodcastEpisodeSelection.query`, query-based folios, and “matching” command
> copy. Exhaustive loading, revision fencing, state/sort identity, and
> server-resolved command selection remain authoritative here.

Type: hard cutover. No flag, legacy path, fallback, dual schema, offset
compatibility, old-cursor decoder, or backward compatibility.

Open questions: none.

Governing contracts:

- `docs/rules/{boundaries,cleanliness,codebase,concurrency,control-flow,correctness,database,errors,frontend,keys-and-identities,naming,retries,simplicity,testing}.md`
- `docs/modules/{library,podcast,chat}.md`
- `docs/cutovers/{canonical-collection-row,collection-surface,library-entry-view-continuity,library-all-and-smart-views,pane-visit-return-memento,lightweight-author-deduplication,chat-interface,resonance-reading-slate}-hard-cutover.md`

This document supersedes only:

- `canonical-collection-row`: Author append-focus repair and its `toHaveFocus`
  acceptance test, plus §6's unchanged-response/`MediaOut` list-payload clauses;
- `collection-surface`: `MediaOut` list-fact ownership and
  `useCursorPagination`/podcast-offset pagination ownership for the six finite
  inventories;
- `library-all-and-smart-views`: `{v,q,after}` cursor shape, `Load More`, and
  terminal continuation recovery;
- `pane-visit-return-memento`: the six finite-list snapshot fields
  `hasMore`/`nextOffset`/`hasMoreEpisodes` and blanket inert restore;
- predecessor clauses requiring finite-list `Load more`, button-focus repair,
  podcast offsets, or universal `useCursorPagination` ownership.

All unrelated predecessor behavior remains normative.

## Decision

Finite primary collections paint a bounded first page, then automatically
traverse private cursor pages. Pagination remains an HTTP transport capability,
not user work.

“Complete” means cursor absence under one unchanged server collection revision.
The final count is the deduped committed row count for that revision. Background
or concurrent membership/order changes invalidate the chain instead of silently
skipping rows.

The 80/20 boundary is: compact pages, one continuation driver, one signed cursor
codec, one strict page envelope, and one durable revision mechanism. Do not add
virtualization, client databases, server-held snapshots, or a cache framework.

## Goals

- No healthy-path `Load more`, bottom sentinel, focus jump, or scroll jump.
- First paint remains bounded at 100 compact rows.
- All finite rows become searchable native DOM.
- Query-wide commands target the exact server selection, never rendered rows.
- Counts, completion, mutations, cursor failures, and pane return stay truthful.
- External clients retain explicit bounded pagination.

## Scope

Automatic exhaustion applies only to:

| Family | Exact query identity |
| --- | --- |
| `AuthorWorks` | viewer + contributor handle |
| `ConversationIndex` | viewer + scope (`mine`, `all`, `shared`) |
| `LibrariesIndex` | viewer |
| `LibraryEntries` | viewer + library + `LibraryEntryView` |
| `PodcastSubscriptions` | viewer + sort + filter + normalized `q` + optional `library_id` |
| `PodcastEpisodes` | viewer + podcast + state + sort + normalized `q` |

Podcast subscription values remain:

- sort: `recent_episode | unplayed_count | alpha`;
- filter: `all | has_new | not_in_library`;
- Library scope: absent or one visible `library_id`.

Podcast episode values remain:

- state: `all | unplayed | in_progress | played`;
- sort: `newest | oldest | duration_asc | duration_desc`.

Retain explicit user-driven continuation for global Search, Stats history,
older-message prepend, conversation/Library destination choosers, Library
members, and invitations. They use the shared page decoder where their endpoint
changes, but not the exhaustive driver.

`GET /conversations` has three modes:

| Mode | Identity | UX |
| --- | --- | --- |
| index | viewer + scope | exhaustive |
| destination | viewer + normalized `q` | manual chooser |
| context | viewer + `has_context_ref` | explicit pagination |

The modes have distinct cursor families. `q`, `scope`, and `has_context_ref`
composition remains closed and mode-specific.

## Non-goals

- Full publisher-history ingestion or feed scheduling.
- Virtualization, IndexedDB, offline replication, streaming JSON, a BFF
  aggregator, or retained database snapshots.
- Changing excluded list UX.
- A universal row schema or total-count query.
- Eager list images, connections, chapters, embeds, show notes, transcript
  forecasts, or other detail payload.

## Target behavior

1. The browser requests 100 first-page rows. External clients may request up to
   the endpoint maximum.
2. Zero rows commit `Complete`, render the empty state and `0` count, and make no
   continuation request.
3. A single page with no cursor commits `Complete` immediately.
4. Otherwise, after first-page paint, request exactly one continuation at a time
   until cursor absence.
5. While draining, Running Head uses its existing pending folio and one quiet
   `Loading remaining items…` status. It does not call loaded length the total.
6. Completion shows the deduped committed row count.
7. There is no healthy-path pagination control or scroll trigger.
8. Pure suffix append does not move focus or scroll and does not start a View
   Transition.
9. A query/view change or owner epoch change aborts the old request and rejects
   stale settlement.
10. Hidden documents and inactive panes finish the current request, then pause
    before the next page. They do not abort. Resume continues the same cursor.
11. A network/5xx terminal failure preserves rows and offers
    `Could not finish loading — Retry`.
12. An invalid/stale cursor preserves rows and offers
    `This list can no longer continue — Refresh list`.
13. A changed server revision preserves rows and offers
    `List changed while loading — Refresh list`.
14. A restored complete snapshot makes no continuation request. A restored
    partial snapshot resumes only when its pane is active and the document is
    visible. A known owner revision invalidates either snapshot.
15. Library reorder is enabled only after completion. Reading Slate renders only
    after the complete entry list.

## Page and revision contract

All six exhaustive reads hard-cut to:

```json
{
  "data": {
    "items": [],
    "collectionRevision": 0,
    "nextCursor": { "kind": "Absent" }
  }
}
```

Affected reads:

- `GET /contributors/{contributor_handle}/works`
- `GET /conversations`
- `GET /libraries`
- `GET /libraries/{library_id}/entries`
- `GET /podcasts/subscriptions`
- `GET /podcasts/{podcast_id}/episodes`

`collectionRevision` is a branded non-negative integer. `nextCursor` is
`Presence<CollectionCursor>`, where `CollectionCursor` is an opaque branded
string. Delete endpoint-local `has_more`; delete podcast `offset`.
`LibraryPageInfo.has_more` remains only on excluded endpoints such as
`/libraries/writable-destinations`; its deletion is out of scope.

First-page requests omit `cursor` and `collection_revision`. Continuations
require both exactly once. `limit` defaults to 100 and must be a canonical ASCII
integer in `1..200`; reject rather than clamp.

One shared raw-query parser consumes `request.query_params.multi_items()` for all
six routes. It rejects duplicate/unknown keys, empty cursor/revision values,
`offset`, noncanonical numbers, and invalid mode-specific combinations before
typed domain parsing. Do not rely on FastAPI to reject unknown scalar query
parameters. Request-shape failures are `400 E_INVALID_REQUEST`; authenticated
cursor failures are `400 E_INVALID_CURSOR`.

### Durable revisions

Add:

```text
viewer_collection_revisions(
  viewer_id UUID REFERENCES users(id),
  family TEXT,
  revision BIGINT NOT NULL,
  PRIMARY KEY(viewer_id, family)
)
```

Absent reads as revision `0`; reads never create rows. A write uses one
application-owned upsert/increment helper in the same transaction as the domain
mutation. The service owns a closed `CollectionFamily` type; do not add a
database `CHECK`, trigger, or database enum for application policy.

Rules:

- bump every affected viewer/family for an insertion, deletion, visible row-fact
  change, membership/filter transition, or sort-key change;
- background feed/ingest workers bump affected subscription/episode viewers;
- consumption changes bump `PodcastEpisodes` and `PodcastSubscriptions` when
  their state/filter/sort relation can change;
- Library, Chat, Author/media, sharing, and governance writers bump their
  affected families;
- broad affected-viewer invalidation is allowed for this one-user prototype;
- first page reads revision and rows in one repeatable-read transaction;
- continuation compares the supplied revision to current revision in the same
  repeatable-read transaction before querying;
- mismatch is `409 E_COLLECTION_CHANGED`; never continue or fall back silently.

Mandatory bump boundaries:

| Family | Mutation owners |
| --- | --- |
| `AuthorWorks` | contributor-credit/link changes; visible media ingest, metadata/order changes, deletion, and visibility changes |
| `ConversationIndex` | conversation create/delete; `seq.assign_next_seq` updates to conversation order; conversation sharing/visibility changes |
| `LibrariesIndex` | Library create/delete/rename and membership/invitation acceptance or removal |
| `LibraryEntries` | entry placement/reorder, media/podcast row facts, media deletion, Library visibility, and consumption facts used by a view |
| `PodcastSubscriptions` | subscribe/unsubscribe/settings, podcast identity/title, feed episode changes, consumption-derived counts, and Library-scope placement |
| `PodcastEpisodes` | episode ingest/update/delete/visibility, searchable media title, and consumption episode state |

Call the revision helper at these application transaction boundaries, including
worker paths. Do not hide revision policy in database triggers or low-level
generic stores.

The revision is an optimistic chain precondition, not a capability. The signed
cursor binds viewer/query/order. An owner may advance to a mutation response’s
new revision without changing the cursor only for a proven safe monotonic
removal or row-only patch in the current exact query. Every other revision
change refreshes page one.

### Signed keyset cursor

One internal codec owns all cursor families:

```text
canonical JSON { family, queryDigest, after } || HMAC-SHA256
  using domain nexus:signed-keyset-cursor:v1
  -> unpadded base64url
```

- `family` includes the conversation mode and prevents cross-endpoint use.
- `queryDigest` binds viewer and exact query identity without serializing viewer
  identity.
- `after` is a strict tagged tuple matching one total order.
- Decode verifies canonical encoding, full MAC in constant time, exact keys,
  family/query digest, tag types, tuple length, and value bounds.
- Every order ends in a pinned immutable unique key and direction.
- Filtering occurs before keyset and `limit + 1`.
- Cursor reads perform no writes.

Extract and generalize the authenticated Library codec. The shared sort-value
vocabulary is:

```text
int | datetime | datetime_or_null | uuid | text | text_or_null
```

Every nullable order value is preceded by an integer missing-rank key ordered
ascending (`0` present, `1` missing). Equality is NULL-safe. The strict
comparison relies on the preceding rank.

Podcast total orders are:

```text
subscriptions.alpha:
  lower(title) ASC, podcast_id ASC

subscriptions.unplayed_count:
  unplayed_count DESC,
  latest_missing ASC, latest_published_at DESC,
  subscription_updated_at DESC, podcast_id DESC

subscriptions.recent_episode:
  latest_missing ASC, latest_published_at DESC,
  subscription_updated_at DESC, podcast_id DESC

episodes.newest:
  published_missing ASC, published_at DESC, media_id DESC

episodes.oldest:
  published_missing ASC, published_at ASC, media_id ASC

episodes.duration_asc:
  duration_missing ASC, duration_seconds ASC,
  published_missing ASC, published_at DESC, media_id DESC

episodes.duration_desc:
  duration_missing ASC, duration_seconds DESC,
  published_missing ASC, published_at DESC, media_id DESC
```

Mutable/computed keys are safe only because continuation requires an unchanged
server revision. No ordinary index can directly satisfy aggregate subscription
orders. Add no speculative index.

## Browser composition

```ts
type CollectionPage<T> = {
  items: readonly T[];
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
};

type ExhaustionState =
  | { kind: "Idle" }
  | { kind: "Draining"; loadedCount: number }
  | { kind: "Complete"; itemCount: number }
  | { kind: "ResumeFailed"; error: ApiError; retry: () => void }
  | {
      kind: "RefreshRequired";
      reason: "CollectionChanged" | "InvalidCursor";
      error: ApiError;
      refresh: () => void;
    };

useExhaustivePagination<T>({
  active,             // existing PaneRuntimeContextValue.isActive
  chainKey,           // exact query identity + owner chain epoch
  cursor,
  collectionRevision,
  loadPage,           // (cursor, revision, AbortSignal) -> CollectionPage<T>
  commitPage,         // owner verifies cursor/revision, dedupes and appends
  refresh,
}) -> ExhaustionState
```

The driver owns only sequential request mechanics:

- start in `useEffect`, after first-page commit;
- one request in flight;
- generation-check success and failure;
- abort on chain change/unmount, not visibility/activity pause;
- use a new `apps/web/src/lib/api/retryPolicy.ts` extracted behaviorally from
  `useResource`, including signal-cancellable backoff;
- retry network/5xx at most three attempts; never retry 4xx;
- scope visited cursors to owner chain epoch;
- a first-page commit or safe revision rebase increments that epoch;
- a repeated cursor/cycle, malformed page, impossible family, or decoder failure
  is a reported same-system defect, not Retry UX.

Owners retain first-page loading, rows, API paths, decoding, dedupe, exact query
identity, revision rebasing, mutation policy, snapshots, and error presentation.

`CollectionView` classifies row identity changes:

- identical identity/order: direct commit;
- pure suffix append: direct commit, no View Transition;
- reorder or replacement: the existing single View Transition.

Add a shared collection-busy prop through `CollectionView` and `ResourceList` so
the native list owns `aria-busy`. Do not change the existing
`content-visibility: auto` or `contain-intrinsic-size: auto 52px` without measured
evidence.

`useCursorPagination` remains the manual chooser primitive. It was never the
universal finite-list owner.

## Mutation continuity

| Mutation effect on current exact query | Owner action |
| --- | --- |
| known removal of an already-loaded row, with no other row crossing the cursor boundary | patch locally, install returned revision, increment chain epoch, continue same cursor |
| row-only fact that cannot alter membership/order | patch locally; install returned revision and increment chain epoch when it changed |
| insert, reorder, membership addition, sort-key change, or unknown effect | abort drain; request page one |
| ambient/background revision change | preserve rows; require refresh |
| query-wide command | preserve rows; request authoritative page one |

First-page replacement keeps committed rows visible until commit, preserves the
semantic scroll anchor/focus, and never assigns `scrollTop = 0`. Explicit user
query/view navigation retains its existing navigation policy.

When already complete, safe removal/row patches make no request. Inserts,
reorders, or unknown effects still refresh: completion does not make stale order
authoritative.

List-affecting same-pane mutation responses used for safe continuation return the
new `collectionRevision`. The owner must not synthesize it.

## Compact row contracts

Schemas are strict, list-owned, and `extra="forbid"`. There is no universal row
DTO.

- Library entries: replace nested `MediaOut`/broad Podcast records with a closed
  `LibraryEntryListItemOut` union containing identity, row text/credits, list
  state/progress, placement/reorder facts, and consumed action booleans only.
- Followed Podcasts: keep identity, title/credits, unplayed count, latest episode
  date, compact sync/settings state, and consumed actions. Drop provider/feed/
  site/image/description, visible-Library expansion, sync telemetry, and unrelated
  timestamps.
- Episodes: keep identity/title/credits, publication/duration, processing and
  listening/transcript state, resettable/action facts, `hasShowNotes`, and one
  compact `playerDescriptor`. Drop duplicate playback fields, chapters, embeds,
  images, descriptions/show-note text, telemetry, publisher/language, and broad
  capabilities.
- Author and Chat summaries are already list projections. `LibraryOut` remains
  the Libraries-row projection.

Remove list-time `useConnectionSummaries`. Use existing detail reads for
connections/show notes. Forecast one transcript on panel open and a query-wide
batch only on command invocation. Poll compact transcript state, not `MediaOut`.

## Query-wide episode commands

Loaded rows never define command scope.

```text
PodcastEpisodeSelection {
  state: all | unplayed | in_progress | played
  query: Presence<NormalizedSearchText>
}
```

Podcast ID comes from the route. Sort is excluded because it does not affect
membership. One Podcast query owner normalizes and resolves this selection for
listing, forecast, and execution.

- `POST /podcasts/{podcast_id}/episodes/mark-played` resolves all matching IDs
  server-side, delegates one batch to Consumption, and returns
  `{matchedCount, changedCount, collectionRevision}`.
- UI copy is `Mark all episodes as played` without a filter and
  `Mark matching episodes as played` with a state/search filter. Delete “visible”.
- Transcript forecast/request accepts
  `{kind:"PodcastEpisodeQuery", podcastId, selection, reason}`.
- Forecast resolves the eligible ID set and fingerprints the canonical sorted
  media IDs with a domain-separated SHA-256.
- Request re-resolves and fingerprints inside the mutating transaction, compares
  before any write, and rejects mismatch as `409 E_SELECTION_CHANGED`.
- Register `E_SELECTION_CHANGED` and `E_COLLECTION_CHANGED` in `ApiErrorCode` and
  the 409 map.
- Podcast owns selection resolution. Consumption and Transcript may retain their
  existing Podcast-table reads for other capabilities; they do not duplicate
  this command’s selection relation.

## Pane snapshots

Each finite-list snapshot stores:

```text
rows
collectionRevision
nextCursor
exhaustion: Partial | Complete
owner-specific detail needed for first paint
```

Delete `hasMore`, `nextOffset`, and `hasMoreEpisodes`. Do not snapshot busy/error,
requests, functions, visited cursors, or chain epochs.

A complete snapshot is inert unless a known owner revision invalidates it. A
partial snapshot may resume after paint when active/visible. This is the explicit
finite-list exception to the predecessor’s blanket inert-restore rule.

## Files

Shared frontend:

- `apps/web/src/lib/api/{collectionPage,retryPolicy,useExhaustivePagination}.ts`
  and focused tests
- `apps/web/src/lib/api/useResource.ts`
- `apps/web/src/lib/contributors/credit.ts`
- `apps/web/src/components/collections/CollectionExhaustionNotice.tsx`
- `apps/web/src/components/collections/CollectionView.tsx`
- `apps/web/src/components/ui/ResourceList.tsx`
- `apps/web/src/lib/ui/viewTransitions.ts`

Frontend owners:

- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/components/chat/ConversationDestinationOverlay.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/{PodcastDetailPaneBody,PodcastEpisodeList}.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/useEpisodeTranscriptController.ts`
- their descriptors, decoders, snapshots, mutation seams, and focused tests

Backend:

- `migrations/alembic/versions/0200_complete_collection_lists.py`
- `python/nexus/schemas/{collection_page,contributors,conversation,library,podcast,media}.py`
- `python/nexus/services/{collection_revisions,signed_keyset_cursor}.py`
- `python/nexus/api/routes/{contributors,conversations,libraries,podcasts,podcast_transcripts}.py`
- `python/nexus/services/{contributors,conversations,library_governance,library_entries,media}.py`
- `python/nexus/services/{seq,shares,library_invitations,media_deletion}.py`
- `python/nexus/services/podcasts/{episodes,feed,ingest,poll,subscriptions,subscriptions_query,transcription}.py`
- `python/nexus/services/consumption/service.py`
- every direct writer named in the mandatory revision-bump table
- focused schema/service/API/query-plan tests

Docs:

- this document
- `docs/modules/library.md` stale pagination passages
- every predecessor named under supersession

## Hard-cut residue

Delete from the six finite panes/endpoints:

- `Load more`, bottom triggers, append-focus repair, and load-more booleans;
- local continuation loops replaced by the driver; Author/Chats/Libraries gain
  shared cancellation rather than deleting nonexistent local controllers;
- `hasMore`, `hasMoreEpisodes`, `nextOffset`, length-derived continuation, and
  podcast `offset`;
- old cursor codecs/fixtures and permissive route parsing;
- loaded-ID batch commands and “visible episodes” copy;
- eager connection-summary/transcript-forecast effects;
- dead broad list fields/hydration;
- documentation calling `useCursorPagination` universal.

Retain manual pagination code only on excluded surfaces.

## Delivery

1. Add migration, revision owner/bump coverage, strict page schema/parser, error
   codes, signed codec, keysets, compact DTOs, and query-wide commands.
2. Prove first/continuation/revision-change behavior for every query/order,
   including nullable podcast facts and every conversation mode.
3. Add shared decoder, cancellable retry policy, exhaustive driver, append
   classification, busy state, and focused tests.
4. Migrate all six controllers/snapshots/mutation seams.
5. Remove legacy UI/API/state/tests and update normative docs.
6. Deploy migration, backend, and web in one maintenance-window cut. Old clients
   fail; there is no compatibility interval.

## Acceptance criteria

1. Zero-row and single-page lists complete without continuation requests.
2. Multi-page fixtures at 100/300/500 rows exhaust automatically with one request
   in flight and no duplicates/skips under an unchanged revision.
3. A concurrent sort/membership write produces `E_COLLECTION_CHANGED`; no chain
   reports completion.
4. Pure suffix append starts no View Transition, preserves active element and
   scroll, and remains browser-Find searchable after completion.
5. Reorder/replacement retains one View Transition.
6. Hidden/inactive panes finish at most the current request, pause, then resume
   once.
7. Network/5xx yields `ResumeFailed`; invalid cursor/revision yields
   `RefreshRequired`; cursor cycles/malformed pages report defects.
8. Safe removal continues the same cursor under the returned revision. Inserts,
   reorders, and unknown changes replace page one without clearing rows or
   jumping to top.
9. Complete/partial pane snapshots restore with the specified request behavior.
10. Strict routes reject duplicate/unknown keys, offsets, malformed/old cursors,
    invalid revisions, and noncanonical/out-of-range limits.
11. Nullable podcast rows traverse every order; cursor family/query/viewer/tamper
    failures fail closed.
12. Final count equals deduped committed row length and appears only at
    completion for that revision.
13. Library reorder is impossible before completion; Slate appears afterward.
14. Episode-wide commands affect the exact server selection and detect a
    transaction-time fingerprint change.
15. List reads issue no connection-summary requests, eager transcript forecasts,
    or broad `MediaOut` payload.
16. `CollectionView` exposes list `aria-busy`; announcements occur once for
    drain and once for completion/failure.
17. Source/DOM residue contains no finite-pane `Load more`, offset continuation,
    length-derived totals, or superseded snapshot fields.

Implementation evidence, not permanent blocking test gates:

- record browser profiles for 100/300/500 rows; target no append task over 50 ms
  and INP at or below 200 ms;
- capture `EXPLAIN (ANALYZE, BUFFERS)` for first/continuation aggregate queries;
- add an index only where measured evidence and expected volume justify it;
- retain `contain-intrinsic-size: auto 52px` unless profiles show material
  scrollbar/anchor drift on tall rows.

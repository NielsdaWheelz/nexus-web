# Resonance + Reading Slate Hard Cutover

> **Superseded (2026-07-22):**
> [`library-sorting-hard-cutover.md`](library-sorting-hard-cutover.md) deletes
> this document's non-default library Resonance ordering (`rank_library_entry_page`,
> `rank_library_entries`, library rank weights/SQL, the `library_entries:resonance:v2`
> cursor) in favor of factual view lenses. Slate and Related ordering remain
> Resonance-owned and unaffected.

Status: IMPLEMENTED — 2026-07-21

Type: hard cutover. No legacy paths, compatibility decoding, fallbacks, dual
reads, or released intermediate state.

## 1. Pre-cutover state and problem

Before this cutover, four independent paths interpreted overlapping relevance
evidence:

- Lectern Recent was a public consumption projection owned by
  `api/routes/lectern.py` and `services/consumption/_projection.py`.
- Surfaced Today independently derived viewer-day recency inside
  `services/library_entries.py`.
- Related independently acquired semantic and shared-author peers inside
  `services/media_related.py`.
- Library Resonance independently computed recency, graph, shared-author, and
  semantic signals inside `services/library_entries.py`.

These products were not identical, but their evidence normalization, trust
policy, decay, deterministic ordering, and explanation rules had one semantic
owner only by convention. That duplication made drift likely and left no single
place to compose a short next-reading projection.

Before this cutover, the frontend had one `useMediaRelated` implementation, not
duplicate hooks. The cutover moved that implementation to the new owner.

`can_edit_entries` is broader than filing and is already inconsistent with
Default filing behavior. Repairing the complete library capability model is a
separate cutover; this one does not change or delete it.

## 2. Decision and final architecture

Create one deterministic `resonance` subsystem with one replaceable
`reading_slate` projection:

```text
Consumption / Libraries / Resource Graph / Contributors / Semantic Index
                                  |
                       typed public read ports
                                  |
                      Resonance evidence kernel
                                  |
       Related | Library Resonance sort | Lectern slate | Library slate
```

Resonance owns evidence vocabulary, trust policy, normalization, contextual
ranking, reason selection, and slate composition. Existing domains remain the
sole owners of their tables, mutations, visibility rules, and canonical facts.

There is one evidence language, not one universal score. Related, library
ordering, and the two slates are separate contextual policies over the same
kernel. Graph Thread and Rediscovery are internal slate strategies, not
services or user-facing labels.

This cutover consumes persisted Synapse edges. It does not replace or extend
the Synapse writer in `synapse-resonance-engine.md`, and no Resonance read
calls Synapse, an AI provider, or a model.

Locked decisions:

- Slates are queried on demand on first active mount and every inactive-to-active
  pane transition, regardless of destination item count. An existing server
  first-paint seed may satisfy a restored visible Lectern pane's first read.
- Each slate contains zero to ten items; weak evidence returns fewer or zero.
- Opening is navigation only. A canonical Add command is the only acceptance.
- Default accepts media suggestions only.
- Read-only and system libraries produce an empty slate.
- Library suggestions require relational library affinity; recency alone is
  never sufficient.
- Related keeps its current semantic/shared-author policy and wire shape. Graph
  peers remain in Connections; the rail removes cross-list duplicates by
  canonical ref, with the factual graph peer winning.

## 3. Target behavior

Lectern:

- `At hand` appears after the Lectern collection.
- It suggests placeable media across documents, audio, video, and podcast
  episodes; raw podcast objects are not Lectern targets.
- Complete queue membership and `Finished` targets are excluded server-side.

Library:

- `Suggested for this library` appears after entries and Load More.
- It is independent of the library's main empty state and current loaded page.
- It is always a comfortable vertical list and never inherits Gallery or
  density preferences.
- Complete server-side destination membership is excluded.
- `Finished` media remains eligible.
- A non-default, non-system admin destination accepts media and actively
  subscribed podcasts. Default accepts media only. Other destinations return
  zero items.

Both:

- A successful `Ready([])` omits the section. Loading and failure are not
  zero-evidence states and follow Section 9.
- Row activation opens the target.
- Each row exposes exactly one visible Add control.
- There is no pagination, suppression, `Not now`, daily language, empty
  placeholder, scheduler, or client-supplied limit.

## 4. Authorization, eligibility, and normalization

Do not change `LibraryOut`, `can_edit_entries`, or existing
Add/remove/reorder capability semantics in this cutover. `LibraryEntryOut`
loses only the Surfaced Today fields named below. The slate endpoint remains
the authorization owner and returns only targets its canonical Add command can
accept.

Hard checks occur inside acquisition queries, before candidate limits:

- viewer visibility and teardown state;
- supported destination target kind;
- complete Lectern queue or library membership;
- current Lectern capacity under the existing `LECTERN_MAX_ITEMS = 2000`;
- Lectern `Finished` exclusion;
- active subscription for a podcast target;
- destination role, Default, and system-library rules.

Every Add command remains separate and reauthorizes at commit time. A stale
suggestion can therefore return the canonical command error after a concurrent
change.

Normalization is closed and one hop:

- `media` and `podcast` references are directly addable where supported;
- media-owned fragments, highlights, evidence spans, content chunks, and
  apparatus items normalize to their canonical media owner;
- pages and note blocks may be anchors but never slate outputs;
- arbitrary transitive graph traversal is forbidden.

Normalization uses a bounded set-based owner read. It must not materialize
every child through generic owner expansion.

Default excludes its complete live personal-All set. Its remaining candidate
universe is readable media outside that set, currently chiefly system-only
corpus media such as Oracle material, or nothing.

## 5. Evidence and contextual policies

The internal evidence vocabulary is closed:

```text
ResonanceEdgeOrigin =
  user | citation | note_body | highlight_note | document_embed | synapse

Continuity { targetRef, state, progress, lastEngagedAt }
Arrival =
  AddedToNexus { targetRef, addedAt }
  | Published { targetRef, publishedOn }
  | NewEpisode { targetRef, publishedAt }
Edge       { targetRef, anchor, edgeId, edgeKind,
             edgeOrigin: ResonanceEdgeOrigin, createdAt }
SharedAuthor { targetRef, anchor, authors: NonEmpty<{ id, displayName }> }
Semantic   { targetRef, anchor, similarity }
```

Relational evidence carries one live, readable anchor and only the factual
fields required for ranking and compact reason rendering.

Graph evidence uses exactly:

```text
user
citation
note_body
highlight_note
document_embed
synapse
```

`assistant` and `system` are excluded. Resonance owns this default-deny
allowlist; it does not widen or reuse `LIST_CONNECTION_ORIGINS`.

Edge evidence is incident in both directions after the one-hop normalization in
Section 4. When the normalized anchor matches one endpoint, the opposite
normalized endpoint is the candidate. Exclude normalized self-relations; wire
reasons intentionally expose no direction. Library `connectionCount` uses the
same incident-both-directions and normalized-self exclusion.

Semantic evidence is read from existing active embeddings, where
`similarity = 1 - cosineDistance`. Related and Library Resonance preserve their
current contextual use of it. Semantic-only Slate qualification requires a
checked-in production constant in Resonance containing one exact
`(provider, model, dimensions, min_similarity)` tuple. A test-only calibration
fixture holds 12 human-labeled positive pairs and 12 nearest-neighbor hard
negatives judged unrelated, plus their frozen observed similarities; runtime
never reads that fixture.

Select the floor for precision: no labeled hard negative may qualify; missed
positives are acceptable. The cutover is blocked unless at least one labeled
positive qualifies. Only the exact calibrated tuple may contribute
Semantic Slate evidence. A changed or uncalibrated tuple contributes none;
Edge or SharedAuthor may still qualify. There is no runtime calibration,
cross-model comparison, or fallback threshold.

Semantic acquisition is media-anchor-only. Reuse Related's first active target
chunk ordered by
`(content_chunks.chunk_idx ASC, content_chunks.id ASC)`, require the same active
provider/model/dimensions on peers, deduplicate each peer media by minimum
cosine distance, and expose `1 - distance`. Podcast, NoteBlock, and Page anchors
contribute no Semantic evidence in this cutover.

Context contracts:

| Consumer | Candidate set | Qualification and ordering |
| --- | --- | --- |
| Related | Visible media outside one readable media anchor | Existing semantic and shared-author relation only. Similarity peers first by distance, then shared-author-only peers by author count, then target ref. Preserve default limit 8 and range 1..20. |
| Library Resonance | Every visible physical member of a non-default library | Existing 14-day recency decay, graph count, shared-author cohesion, and existing semantic term. Score all members before keyset pagination. |
| Lectern slate | Visible, placeable media outside the complete queue | Continuity, Arrival, Graph Thread, or Rediscovery. |
| Library slate | Destination-addable visible resources outside complete membership | Relation to a representative library anchor. After relation tier/strength, recent engagement and exact arrival are secondary keys; neither can qualify or become the primary reason. |

Library Resonance preserves the current weights and keyset while moving its
owner and removing false partial-date instants:

```text
score =
  1.00 * recencyDecay(halfLife=14 days)
  + 0.10 * ln(1 + connectionCount)
  + 0.05 * sharedAuthorHits
  + 0.05 * semanticSimilarity

order = score DESC, entryId DESC
```

`recencyDecay` uses the minimum non-negative age across entry creation,
canonical engagement, allowed edge creation, exact episode publication, and
day-precision media publication. Timestamp ages use elapsed UTC days; a
day-only publication uses UTC calendar-date age. Future facts are ignored.
Month/year publication strings never become artificial first-of-period
timestamps. `connectionCount` uses the Resonance origin allowlist above.

It ranks the complete eligible membership. Slate acquisition limits never
truncate Library Resonance or Related.

## 6. Slate policy and determinism

Initial policy constants:

```text
SLATE_LIMIT                       = 10
SLATE_ANCHOR_LIMIT                = 5
SLATE_FAMILY_CANDIDATE_LIMIT      = 20
SLATE_UNIQUE_CANDIDATE_LIMIT      = 80
CONTINUITY_MAX_IDLE_DAYS          = 30
ARRIVAL_WINDOW_DAYS               = 14
REDISCOVERY_MIN_AGE_DAYS          = 90
SLATE_SEMANTIC_CALIBRATION        = { provider, model, dimensions, min_similarity }
```

All time arithmetic uses one database `asOf` instant in UTC.

Anchor selection:

- Lectern anchors are the five newest distinct readable refs from canonical
  media engagement, highlights, and note/page edits. Order by activity instant
  descending, source priority
  `Consumption > Highlight > NoteBlock > Page`, then canonical ref ascending.
  Consumption and Highlight facts normalize to their media owner before
  deduplication; NoteBlock and Page remain exact refs. Finished resources may
  be anchors.
- Library anchors come from complete membership, not the loaded page. Order by
  `lastEngagedAt DESC NULLS LAST`, entry `createdAt DESC`, then canonical ref
  ascending; take five distinct refs.

Family qualification:

- Continuity: canonical consumption state is `InProgress` and
  `asOf - 30 days <= lastEngagedAt <= asOf`. There is no new dwell or
  "meaningfully engaged" heuristic.
- Arrival: canonical Nexus media creation or exact episode publication is in
  `[asOf - 14 days, asOf]`; day-precision media publication has UTC calendar
  age `0..13`. Month/year publication facts never manufacture an instant or
  qualify by recency.
- Rediscovery: the target's latest exact arrival/engagement instant is at least
  90 days old and relational evidence qualifies.
- Graph Thread: qualifying Edge, SharedAuthor, or Semantic evidence not assigned
  to a preceding family.

Lectern family assignment is exhaustive and deterministic:

```text
Continuity > Arrival > Rediscovery > Graph Thread
```

After relational qualification, Library assigns
`Rediscovery > Graph Thread`; Continuity and Arrival never change its family or
reason. Within the same relation tier/strength, use
`lastEngagedAt DESC NULLS LAST, exactArrivalAt DESC NULLS LAST`, then anchor rank
and target ref.

Within-family order:

- Continuity: `lastEngagedAt DESC, targetRef ASC`.
- Arrival: UTC calendar date descending,
  `NewEpisode > Published > AddedToNexus`, exact instant descending
  `NULLS LAST`, then target ref. A day-only
  `Published` value participates as a date and never receives a fabricated
  time. The target's sort date is its newest qualifying Arrival date and its
  exact instant is the newest exact fact on that date; reason selection still
  follows the fixed reason precedence below.
- Graph Thread and Rediscovery:
  `Edge > SharedAuthor > Semantic`; Edge origin priority follows the graph
  allowlist order above, then `createdAt DESC`, edge-kind priority
  `context > supports > contradicts`, and `edgeId ASC`;
  SharedAuthor deduplicates contributors across the candidate/anchor pair and
  uses distinct-author count descending then lowest `authorId ASC`; Semantic
  uses similarity descending. Remaining ties use anchor rank then target ref. A
  target equal to its anchor after normalization is excluded.

Lectern's first composition pass uses the fixed family schedule:

```text
Continuity, Graph Thread, Arrival, Rediscovery,
Continuity, Graph Thread, Arrival, Rediscovery,
Continuity, Graph Thread
```

Missing slots are backfilled round-robin in
`Graph Thread > Continuity > Rediscovery > Arrival` order using only remaining
qualified candidates. A library slate uses only Graph Thread and Rediscovery
and may fill all ten from them.

For each slot, the composer scans the ranked family list and selects the first
candidate for which every present selected `anchorRef`, selected `authorId`,
`mediaKind`, and `reasonKind` has appeared fewer than two times. For
SharedAuthor, select the lowest-id author from the strongest candidate/anchor
aggregate; its canonical display name is the reason label. Missing attributes
do not count. If
none qualifies, select the ranked head. Every candidate is unique by canonical
`ResourceRef`; the final tie-break is always that ref.

Primary reason is the assigned family's strongest factual evidence:

```text
Continuity: Continue
Arrival:    NewEpisode > Published > AddedToNexus
Relation:   Connected > SharedAuthor > Similar
```

Library reasons are always relational. Graph Thread and Rediscovery are never
rendered as labels.

## 7. Read consistency and bounded work

Each Resonance GET runs in one `REPEATABLE READ, READ ONLY` request transaction
through `get_repeatable_read_db`. Database `now()` is captured inside that
request's snapshot.

Library Resonance creates `asOf` on its first page and carries it unchanged in
the strict opaque cursor. The new cursor kind is
`library_entries:resonance:v2`; every old `library_entries:resonance:v1` cursor
fails with `400 E_INVALID_CURSOR`. Preserve viewer/library/sort scope,
live-signal mutation semantics, and `(score DESC, entryId DESC)` keyset.

Slate requests are unpaged and capture one `asOf` per request. “No snapshot”
means no persisted/client-visible slate snapshot, cursor, exclusion parameter,
or refill endpoint; it does not prohibit the transaction snapshot.

Each family retains at most 20 eligible candidates and the deduplicated union
retains at most 80. Authorization, exclusion, and one-hop normalization happen
before those caps. Membership, graph, contributor, consumption, and hydration
reads are batched. Up to five fixed ANN anchor queries, or one set-based
equivalent, are acceptable; query count has a fixed upper bound and must not
grow with corpus, candidate, or rendered-row count. No per-row N+1 is allowed.

Inspect query plans before adding an index. No migration or speculative index is
part of this cutover.

## 8. Wire schema and API

New models are strict camelCase boundary records with PascalCase union
discriminants, `extra="forbid"`, and `Presence<T>` for meaningful successful
absence.

```text
SlateOut
  items: SlateItemOut[0..10]

SlateItemOut
  target: SlateTargetOut
  reason: SlateReasonOut

SlateTargetOut
  Media
    kind: "Media"
    ref: ResourceRefUri string
    mediaKind: MediaKind
    title: string
    subtitle: Presence<string>
    imageUrl: Presence<string>
    href: string
  Podcast
    kind: "Podcast"
    ref: ResourceRefUri string
    title: string
    subtitle: Presence<string>
    imageUrl: Presence<string>
    href: string

SlateReasonOut
  Continue
    kind: "Continue"
    progress: Presence<float>
    lastEngagedAt: instant
  AddedToNexus
    kind: "AddedToNexus"
    addedAt: instant
  Published
    kind: "Published"
    publishedOn: date
  NewEpisode
    kind: "NewEpisode"
    publishedAt: instant
  Connected
    kind: "Connected"
    anchor: SlateAnchorOut
    edgeOrigin: ResonanceEdgeOrigin
  SharedAuthor
    kind: "SharedAuthor"
    anchor: SlateAnchorOut
    authorName: string
  Similar
    kind: "Similar"
    anchor: SlateAnchorOut

SlateAnchorOut
  ref: ResourceRefUri string
  label: string
```

Every `ResourceRefUri` is the canonical existing URI form such as
`media:<uuid>`, decoded through the existing strict ResourceRef parser. It is
the sole shared identity for stable refill. `href` comes only from the existing
resource-activation owner and is a canonical internal route. Do not embed
`MediaOut`, `LibraryPodcastOut`, scores, confidence, family names, arbitrary
metadata, generated timestamps, action descriptors, debug evidence, or machine
rationale.

Present `Continue.progress` is finite and constrained to `0..1`.

`AddedToNexus` means canonical `media.created_at`. `Published` is emitted only
from a stored day-precision publication date; month/year values never qualify
for Arrival or create a reason. `NewEpisode` uses an exact episode publication
instant. Connected reasons render neutral factual copy such as
`Connected with X`; a Synapse may render `Synapse · connected with X`.

Slate endpoints:

```http
GET /lectern/slate
GET /libraries/{library_id}/slate
```

They reject every query parameter with `400 E_INVALID_REQUEST` and return
exactly:

```json
{
  "data": {
    "items": []
  }
}
```

Routes use `ok(SlateOut(...), by_alias=True)`; frontend envelope and payload
decoders reject unknown or missing keys.

An inaccessible library returns masked `404`. A readable but non-fileable
library returns `{"data":{"items":[]}}`.

Existing contextual APIs remain first-class and delegate exclusively to
Resonance:

```http
GET /media/{media_id}/related?limit={1..20}
GET /libraries/{library_id}/entries?sort=resonance
```

Related preserves its current response schema, unreadable-anchor masking, and
limit contract. Existing Add endpoints and responses remain unchanged.

## 9. Stable refill and frontend state

Every slate GET returns the canonical current top ten. After Add, preserve the
visible survivors and append at most one novel replacement:

```text
captured    = visible rows when Add is invoked
survivors   = captured except accepted ref
fresh       = GET canonical top 10 after Add commits
replacement = first fresh ref absent from survivors and accepted ref
visible     = exact survivor objects in original order, then replacement
```

The destination-keyed controller owns one monotonic generation and this
exhaustive state:

```text
InitialLoading
InitialFailed { error, retry }
Ready { items }
Refreshing { items }
RefreshFailed { items, error, retry }
Adding { items, acceptedRef, acceptedIndex }
AddFailed { items, error }
AddUnknown { items, error, recovery }
Refilling { survivors }
RefillFailed { survivors, error, retry }
```

Rules:

- One lane serializes activation GETs, Add, and refill per destination.
- Obsolete GETs are aborted and generation-checked. Writes are never cancelled
  or raced away; an obsolete generation may ignore their result only after the
  side effect finishes.
- Activation during Add, AddUnknown, or refill coalesces until that attempt
  settles, then into its post-commit GET; it never installs a competing refresh.
- Disable every Add control during `Adding`, `AddUnknown`, `Refilling`, and
  `RefillFailed`; the accepted control shows loading only during `Adding`.
  A local `AddUnknown` exposes only its exact-attempt Retry. Links remain
  enabled.
- Wait for canonical Add success before removing anything. A definitive command
  rejection keeps every row and runs no refill GET.
- A network, timeout, or server response that cannot prove whether an
  idempotent Add committed enters `AddUnknown`, keeps every row, says
  `Couldn't confirm Add`, and parks activation. A local retry reuses the frozen
  request body and the same client mutation id where supported; it never starts
  a second logical command. Disposal abandons only observation, never the
  possibly committed write; the next mount performs a canonical GET.
- Successful Add removes only the accepted ref, preserves exact survivor
  objects, keys, state, and order, then appends at most one newcomer.
- If no newcomer qualifies, remain shorter.
- Refreshing preserves last-good rows. Refresh failure enters `RefreshFailed`
  with those rows and quiet Retry; success may install a full canonical
  recomposition.

Lectern acceptance calls `LecternProvider.placeItems`, whose success installs
the canonical queue before resolving, and announces `Added to Lectern`. A
narrow observer option reports the provider's parked unknown state, but
`LecternMutationNotice` remains the sole assertive message and sole Retry owner.
The Slate creates no second Lectern lane or recovery action; if it unmounts, the
shell owner remains available.

Library acceptance calls the existing media/podcast filing command, announces
`Added to {library}`, and marks the main entry projection stale. It does not
synthesize or optimistically insert a `LibraryEntry` from slate data and does
not reset a loaded paginated collection immediately. The next pane activation
canonically reloads the current library sort and resets its paging state.
Failure of that later read never reclassifies the committed Add as failed.

There is no refill endpoint, client exclusions parameter, slate cursor, or
client-supplied limit.

## 10. UI composition and accessibility

`ReadingSlateSection` receives:

```text
destination: Lectern | Library { id, name }
paneId: string
isActive: boolean
accept(target, { signal, onUnknown }): Promise<AcceptResult>

AcceptResult =
  Accepted
  | Rejected { error }
  | Abandoned

UnknownRecovery =
  Local { retry: () => void }
  | External { owner: "LecternMutationNotice" }

onUnknown({ error, recovery: UnknownRecovery })
```

The promise remains pending across an unknown outcome. `onUnknown` moves the
controller to `AddUnknown`; Local Retry resumes that exact attempt and returns
to `Adding`, while External recovery stays with its named shell owner. Aborting
the observer signal resolves only the adapter wrapper as `Abandoned`; it must
not cancel or classify the underlying write. The original promise otherwise
resolves `Accepted` or `Rejected`.

It owns only slate reads, slate state, stable merge, errors, and focus. It
imports no Lectern or library mutation implementation; each host pane supplies
its canonical command.

Every active Lectern or Library destination queries its endpoint. Inactive
client-mounted panes issue no request. Existing server first-paint seeding may
prefetch a restored visible Lectern pane and the pane consumes that seed as its
first read; minimized panes are not seeded. Cached `can_edit_entries` never
suppresses a request; the endpoint is the sole current eligibility authority
and returns empty for a readable non-fileable destination.

Presentation:

- Add `lib/resonance/presentSlateItem.ts`. It emits one ResourceRef-keyed
  `CollectionRowView`, one exhaustively rendered reason, and
  `relatedMediaId: null`.
- A Present subtitle maps to a new optional plain-text
  `CollectionRowView.description`, forwarded to the existing
  `ResourceRow.description` slot. The reason alone occupies `signals`; both
  remain visible at 320px and neither displaces the other.
- It emits no Connections, Related, action menu, swipe action, destructive
  status, or contextual resource action.
- Render with `PaneSection`, `CollectionView`, and `CollectionRow` using
  `view="list"`, `density="comfortable"`, `surface={false}`, and
  `rowActionsVisibility="always"`.
- Add is supplied only through `rowControls`.
- Lectern may display `Add to Lectern`. A library row displays `Add` with
  accessible name `Add {title} to {library}` to remain usable at 320px.
- Render the main library empty notice in its own collection branch; a non-empty
  slate must not suppress it through `PaneSurface.empty`.

Focus and errors:

- The slate `PaneSection` has an id, `aria-label`, and `tabIndex={-1}`.
- After removal, focus the next survivor at the accepted index, otherwise the
  previous survivor, otherwise the mounted slate section.
- Appended content never receives programmatic focus.
- Before terminal `Ready([])` unmounts a focused slate, move focus to
  `findPaneChromeFocusTarget`.
- Lectern `InitialLoading` renders a bounded section loading state. Library
  initial loading is visually omitted so a known-empty/non-fileable response
  cannot flash a Slate; the endpoint remains the filing-policy authority.
- `InitialFailed` renders compact Retry.
- `AddFailed` preserves rows, re-enables Add, and announces a screen-boundary
  error.
- Local `AddUnknown` preserves rows, keeps row Add controls disabled, announces
  uncertainty, and exposes exact-attempt Retry. External `AddUnknown` renders
  quiet status only; `LecternMutationNotice` alone announces and owns Retry.
- `RefreshFailed` preserves last-good rows and exposes quiet Retry.
- `Refilling` preserves survivors.
- `RefillFailed` preserves survivors and exposes quiet Retry. This
  section-level recovery action is not a second row action.
- Map structured errors once through exhaustive
  `readingSlateErrorMessage`; authentication remains owned by the existing
  boundary.
- Set `aria-busy=true` on the section during visible `InitialLoading`,
  `Refreshing`, `Adding`, and `Refilling`; clear it in every settled/error
  state.

## 11. Ownership and module structure

Backend:

```text
python/nexus/services/resonance/
  service.py          public typed contextual queries
  _evidence.py        bounded fact acquisition and one-hop normalization
  _ranking.py         Related/library-order policies + production calibration
  _reading_slate.py   pure family assignment, reasons, diversity, composition

python/nexus/schemas/resonance.py
  strict HTTP boundary models only
```

Public operations:

```text
related_media(...)
rank_library_entry_page(...)
build_lectern_slate(...)
build_library_slate(...)
```

Resonance composes two public port shapes: parameterized SQL relations for
database-shaped filtering and frozen typed batch results for hydration. A
relation documents its columns and binds and is never materialized as a
complete Python ID list.

Required relation ports:

```text
auth.permissions.visible_media_ids_cte_sql()
auth.permissions.visible_podcast_ids_cte_sql()
consumption.engagement_fact_rows_sql(...)
consumption.lectern_membership_rows_sql(...)
library_entries.destination_membership_rows_sql(...)
library_entries.physical_entry_rows_sql(...)
resource_graph.resolve.resource_owner_rows_sql(...)
resource_graph.connection_summaries.edge_fact_rows_sql(...)
contributor_credits.visible_author_credit_rows_sql()
semantic_chunks.media_neighbor_rows_sql(...)
media.media_candidate_rows_sql(...)
podcasts.episodes.episode_publication_rows_sql(...)
podcasts.subscriptions_query.active_subscription_rows_sql(...)
```

Required scalar/batch ports:

```text
library_governance.lock_library_for_member(..., lock=False)
consumption.lectern_item_count(...)
consumption.recent_engagement_anchor_facts(...)
highlights.recent_highlight_anchor_facts(...)
notes.recent_note_anchor_facts(...)
library_entries.library_anchor_facts(...)
library_entries.hydrate_entry_page(...)
media.hydrate_compact_media_targets(...)
podcasts.subscriptions_query.hydrate_compact_podcast_targets(...)
```

Resonance supplies the edge-origin allowlist, calibrated embedding tuple,
anchors, and family limits. Fact owners do not name or implement Resonance
policy. The destination-membership relation represents complete physical
membership and Default's complete personal-All set; the Lectern relation and
count include hidden rows. The physical-entry relation is uncapped so Library
Resonance scores the full eligible membership.

The author-credit relation filters `role = 'author'` before either side is
joined and returns contributor id plus the canonical contributor display name;
credited-name variants never choose Slate reason copy.

Only checked-in owner relation builders compose SQL; request text never becomes
a relation, identifier, column, or ordering fragment.

Eligibility, destination anti-joins, one-hop owner normalization, and
consumption-state exclusion are composed into each acquisition query before
its `ORDER BY`/`LIMIT`. `media_neighbor_rows_sql` accepts that already-eligible
media relation so ANN limiting cannot precede authorization. Capacity is read
once before Lectern acquisition. Hydration happens only after final selection.

HTTP adapters dispatch position/default library listing to `library_entries`
and Resonance listing/slates/Related to `resonance`.
`library_entries` never imports Resonance. Resonance uses named typed public
relations and batch ports only. It never reads sibling-owned tables directly,
imports owner-private helpers, or performs owner-table DML.

`connection_summaries` remains the factual collection aggregate and does not
own recommendation policy. Consumption remains the state/engagement owner;
contributors own credits; the semantic index owns embeddings; resource graph
owns edges; Synapse remains the sole Synapse writer.

Frontend:

```text
apps/web/src/lib/resonance/
  contract.ts
  client.ts
  presentSlateItem.ts
  useReadingSlate.ts
  useRelatedMedia.ts

apps/web/src/components/collections/ReadingSlateSection.tsx
```

The component stays beside the collection primitives instead of creating a
single-file component directory.

## 12. Hard-cut file scope

Create:

- `python/nexus/services/resonance/{service,_evidence,_ranking,_reading_slate}.py`.
- `python/nexus/services/resonance/__init__.py` as an empty package marker.
- `python/nexus/schemas/resonance.py`.
- Slate handlers in the existing Lectern and Libraries route owners.
- `apps/web/src/app/api/lectern/slate/route.ts`.
- `apps/web/src/app/api/libraries/[id]/slate/route.ts`.
- `apps/web/src/lib/resonance/{contract,client,presentSlateItem,useReadingSlate,useRelatedMedia}.ts`.
- `apps/web/src/components/collections/ReadingSlateSection.tsx`.
- `python/tests/fixtures/resonance_semantic_calibration.json`: stable labeled
  positive pairs, hard negatives, and frozen similarities for the production
  calibration tuple; test-only, never loaded by the API.
- Focused backend, pure, component, and E2E test files.

Modify:

- `python/nexus/api/routes/{lectern,libraries,media}.py`.
- `python/nexus/services/consumption/{service,_projection}.py`: expose
  engagement, complete Lectern membership/count ports; remove the public Recent
  product.
- `python/nexus/services/library_entries.py`: remove Surfaced Today and inline
  Resonance policy; expose complete destination membership, uncapped physical
  entry, anchor, and hydration ports.
- `python/nexus/services/highlights.py`: expose a bounded recent-highlight
  anchor-fact query.
- `python/nexus/services/notes.py`: expose one bounded recent NoteBlock/Page
  anchor-fact query.
- `python/nexus/services/contributor_credits.py`: expose the policy-neutral
  visible author-credit relation with canonical contributor names.
- `python/nexus/services/resource_graph/{connection_summaries,resolve}.py`:
  expose policy-neutral edge rows and one-hop resource-owner rows without
  changing list origins or generic expansion.
- `python/nexus/services/semantic_chunks.py`: expose policy-neutral bounded
  same-model neighbors over a supplied eligible-media relation.
- `python/nexus/services/media.py` and
  `python/nexus/services/podcasts/{episodes,subscriptions_query}.py`: expose
  policy-neutral media, exact episode-publication, active-subscription, and
  compact hydration facts.
- `python/nexus/schemas/{consumption,library}.py` and focused backend tests.
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx`.
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`.
- `apps/web/src/lib/lectern/LecternProvider.tsx`,
  `apps/web/src/lib/lectern/{client,contract}.ts`, and
  `apps/web/src/lib/api/resource.ts`: expose parked-unknown observation while
  retaining the existing provider lane and shell Retry owner.
- `apps/web/src/lib/panes/paneResourceLoaders.ts` and its tests.
- `apps/web/src/lib/workspace/bootstrap.server.test.ts`: replace Recent bootstrap
  expectations with Slate. `bootstrap.server.ts` itself remains unchanged;
  `paneResourceLoaders` owns the seed. Library Slate remains component-local and
  never gates core first paint.
- `apps/web/src/lib/collections/types.ts` and
  `apps/web/src/components/collections/CollectionRow.tsx`: add/forward the
  optional plain-text description and retarget Related to the Resonance hook.
- `apps/web/src/components/collections/ConnectionRail.tsx`: deduplicate Related
  peers already present in graph peers by canonical ref, preserving graph order
  and then Related order.
- Existing Lectern, Library, collection, proxy-route-count, contract, and
  presenter tests.
- `docs/architecture.md` and `docs/modules/{player,library}.md`.
- `docs/cutovers/collection-surface-hard-cutover.md`.
- `docs/cutovers/default-library-virtualization-and-transient-state-pruning-hard-cutover.md`.
- `docs/cutovers/{lectern-hard-cutover,lectern-player-lifecycle-hard-cutover}.md`.

Delete:

- `python/nexus/services/media_related.py` after Related moves.
- `GET /lectern/recent` and
  `apps/web/src/app/api/lectern/recent/route.ts`.
- Recent-consumption public schemas, service method, client method, decoder,
  resource descriptor, presenter branch, bootstrap data, and tests.
- `surfaced_today`, its timezone transport/calculation/lane, and tests.
- Root `LibraryEntryOut.last_engaged_at`, which exists only for that lane;
  retain nested `MediaOut.last_engaged_at` and consumption-owner facts.
- Inline Library Resonance SQL, weights, cursor branch, and private helpers
  after ownership moves.
- `apps/web/src/lib/collections/useMediaRelated.ts` after the hook moves.
- Only CSS selectors proven unused after those deletions.

Retain:

- `can_edit_entries` and existing library mutation/capability contracts.
- `resource_edges`, `connection_summaries`, consumption state projections,
  contributor ownership, semantic indexing, and the Synapse writer.
- Shell-owned `LecternMutationNotice` recovery behavior.
- Existing Related HTTP response and Library Resonance pagination contracts.

No aliases, redirects, dual reads, fallback ranking, compatibility decoders, or
released intermediate state.

## 13. Goals and non-goals

Goals:

- Produce a short, deterministic, explainable, mixed-media reading slate.
- Consolidate relevance semantics under one replaceable owner without stealing
  storage or mutation ownership.
- Make successful Add stable: survivors never jump, reset, or lose local state.
- Keep every read bounded, read-only, and cheap enough for one user.
- Prefer factual provenance and no suggestion over weak or invented relevance.

Non-goals:

- Learned ranking, generation, new embeddings, request-time AI, or per-model
  calibration infrastructure.
- Persistence, migration, cache, worker, daily job, recommendation history,
  suppression, impressions, analytics, experiments, or training signals.
- A general recommendation framework.
- A global `can_edit_entries` capability redesign.
- Immediate optimistic insertion into the visible library entry collection.
- Redesigning Connections, player Next, Launcher history, library pagination,
  Lectern ordering, podcast auto-queue, graph writes, or Synapse generation.
- Expanding Related beyond its current contextual media UX or adding graph
  peers to its payload.

## 14. Acceptance criteria

Behavior:

- The same database snapshot and `asOf` produce the same total order.
- Every item in a server response is unique, readable, actionable, and
  destination-eligible at that response's snapshot. A preserved survivor may
  become stale before Add; the command reauthorizes it.
- Hard exclusions occur before family acquisition limits.
- Lectern excludes complete queue membership and `Finished`; libraries exclude
  complete membership but permit `Finished`.
- Default returns only addable visible system-only media, or zero.
- Related retains semantic/shared-author behavior; ConnectionRail renders a ref
  at most once when it is also a graph Connection.
- Opening performs no mutation.
- Persisted Synapse evidence qualifies without a model, provider, scan, or job.
- Stable refill preserves exact survivor objects and order and appends at most
  one novel ref.
- Rapid actions and activation races cannot duplicate, resurrect, overwrite, or
  reorder post-Add survivors. A later activation may intentionally perform a
  full canonical recomposition.
- A library Add is acknowledged immediately; its main entries canonically
  refresh on the next activation.
- Main empty state and Slate render independently.
- Keyboard, focus, errors, and layout remain usable at 320px.

Architecture:

- Related, Library Resonance, and both slates use one Resonance evidence owner
  and separate contextual policies.
- The dependency graph is acyclic; `library_entries` never imports Resonance.
- No relevance implementation remains in `media_related.py` or
  `library_entries.py`.
- Fact owners remain sole storage/mutation owners.
- Resonance GETs use one repeatable-read, read-only transaction.
- Library Resonance still ranks all members and preserves cursor semantics.
- Slate acquisition and query count are hard-bounded and free of per-row N+1.
- Wire decoders are exact; target/reason rendering is exhaustive.
- There is no fallback to Recent or Surfaced Today.
- `can_edit_entries` behavior is unchanged.

Negative gates over active code, scoped away from historical documents:

```text
/lectern/recent
RecentConsumption
RECENT_CONSUMPTION_MAX_ITEMS
get_recent_consumption
getRecentConsumption
decodeRecentConsumption
recent_consumption
_load_recent_consumption_rows
LECTERN_RECENT_LIMIT
presentRecentConsumptionItem
lecternRecentResource
surfaced_today
Surfaced today
_surfaced_today
_start_of_today
_entry_recency_signals
viewer_tz
surfacedEntries
media_related
useMediaRelated
queryMediaRelated
```

Within `python/nexus/services/library_entries.py` only:

```text
_RESONANCE_
_SIMILARITY_SQL
resonance_score
_LAST_ENGAGED_AT_SQL
_CONNECTION_COUNT_SQL
_LAST_CONNECTED_AT_SQL
_PUBLISHED_AT_SQL
_SHARED_AUTHOR_HITS_SQL
_MOST_RECENT_ACTIVITY_SQL
```

`can_edit_entries` is intentionally not a negative gate.

Historical cutover documents receive explicit supersession notes instead of
being included in global negative searches.

## 15. Verification

Backend integration:

- Exact `{"data":{"items":[]}}` envelope, aliases, strict target/reason unions,
  maximum ten, and `400 E_INVALID_REQUEST` for any slate query parameter.
- Visibility, teardown, target-kind, active-subscription, Default, system,
  admin/member, full-capacity Lectern, complete membership/queue, and
  `Finished` cases.
- Exclusion beyond the currently loaded library page.
- Unrelated Continuity/Arrival never qualifies a library suggestion.
- Synapse allowlist includes `synapse` and excludes `assistant/system`.
- Incoming and outgoing incident edges both qualify after owner normalization;
  normalized self-relations do not.
- Shared-author evidence requires `author` on both sides and reasons use the
  canonical contributor display name.
- The checked-in semantic tuple/floor rejects every labeled hard negative,
  admits at least one labeled positive, and an uncalibrated tuple contributes no
  Semantic Slate evidence.
- Related preserves limit, masking, semantic acquisition, and deterministic
  order; rail-level graph overlap dedupes by ref.
- Library Resonance preserves first-page `asOf`, next-page ordering,
  wrong-scope `E_INVALID_CURSOR`, rejection of every old v1 cursor, and accepted
  live-mutation semantics.
- Slate limits do not truncate full Library Resonance pagination.
- One repeatable-read, read-only snapshot; no write, Synapse invocation,
  provider call, or model-runtime boundary is reachable.
- Query count stays under one fixed upper bound at zero, one, five, and many
  anchors/candidates and is independent of corpus/candidate/rendered-row count;
  no generic owner-child expansion. Capture query-plan evidence before any
  index.

Pure tests:

- Family qualification, rank keys, reason precedence, diversity, backfill,
  partial-publication non-recency, and canonical ref tie-breaks.
- Stable merge for 10-to-10, one-to-one, no newcomer, duplicate fresh refs,
  repeated accepted ref, and stale generations.
- Exhaustive wire decoding and reason presentation.

Browser component tests:

- Initial loading/failure, successful zero omission, Refreshing/refresh failure,
  definitive/unknown Add outcomes, Refilling, refill failure/retry, busy state,
  and authentication boundary.
- Local Library unknown has one exact-attempt Retry; Lectern unknown has exactly
  one assertive alert/action in `LecternMutationNotice` and none in the Slate.
- Visible survivor ref/title order, focused-row continuity, no visible remount
  state loss, and one appended replacement. Exact object identity stays in the
  pure reducer test.
- Activation/Add/refill interleavings, disabled controls, and rapid clicks.
- ConnectionRail graph/Related overlap renders once; graph order and metadata win.
- Focus next/previous/section/pane-chrome priorities and no focus theft.
- Always-visible keyboard-reachable Add, library empty plus Slate, fixed List
  inside Gallery, subtitle plus reason, and no overflow at 320px.

Real-stack E2E:

- Open Slate, Add, observe committed destination state and server exclusion,
  preserve nine exact survivors, append one novel replacement, reactivate the
  library, and observe canonical entry reconciliation.

Run focused owner lint, typecheck, backend tests, browser tests, the single E2E,
negative searches, and `git diff --check`. Broad suites are unnecessary unless
focused evidence exposes a cross-cutting regression.

## 16. Implementation order

1. Add strict domain/wire contracts and pure policy/refill tests.
2. Create Resonance read ports and hard-cut Related plus Library Resonance
   ownership into the acyclic service.
3. Add repeatable-read Slate queries, routes, and backend integration tests.
4. Add the shared presenter, controller, section, and host-owned Add adapters.
5. Replace Lectern Recent and Surfaced Today; delete every legacy path.
6. Add library next-activation reconciliation, focused component/E2E coverage,
   active-doc updates, negative gates, and final owner verification.

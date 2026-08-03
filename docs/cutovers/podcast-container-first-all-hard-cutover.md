# Podcast Container-First All Hard Cutover

Status: IMPLEMENTED AND LOCALLY VERIFIED · 2026-08-02

Type: hard cutover. No feature flag, dual read, legacy list path, compatibility
cursor, fallback, migration window, or released intermediate state.

Open questions: none. The accepted 80/20 losses below are fixed.

Governing contracts:

- `docs/rules/{boundaries,cleanliness,codebase,control-flow,correctness,database,frontend,naming,simplicity}.md`
- `docs/modules/{library,podcast}.md`
- `docs/cutovers/{browse-discovery-preview-acquisition,library-all-and-smart-views,library-entry-type-filter-and-filter-row-reflow}-hard-cutover.md`

## Decision

Subscribing to a Podcast places one Podcast container in Default/All. Episodes
of an actively subscribed Podcast do not appear as independent roots in that
view. They remain first-class Media and remain available through the Podcast
pane, show detail, queue, Lectern, Search, Atlas, transcripts, and intelligence.

Implement this as server-owned parent-over-child subsumption in the Default
root inventory. Keep the existing descendant Media scope and storage model.
Add no schema, migration, route, DTO, response field, worker, preference, or
frontend feature.

Philosophy: subscription is intent to follow a source, not intent to file every
delivery as a peer of the source. Inventory is container-first; descendants are
addressable without becoming inventory roots.

## Goals

- A Podcast with any history contributes exactly one visible All root.
- Sync/backfill may change that root's facts and order, never its root count.
- One backend relation owns Default list membership and Default item count.
- Preserve existing episode identity, access, retention, discovery, and filing.
- Deliver the product correction with a small, reversible read-model seam.

## Scope

In scope:

- Default/All `All items`, `Unfiled`, `In Progress`, completion, and Type
  projections.
- Default list pagination, opaque cursor identity, and resource item count.
- Subscription, sync, explicit Episode Add, and unsubscribe characterization.
- Removal of duplicate Default count SQL and superseded flat-list claims.

Out of scope:

- Named/system Library membership or presentation.
- A Feed/Inbox, Saved/Favorite, archive, download, or recommendation system.
- New subscription policies, episode limits, auto-queue behavior, or Podcast UI.
- Reclassifying historical `library_entries`, adding provenance, or deleting
  retained episode rows.
- Changing authorization, Search/RAG scope, Atlas, Library Intelligence,
  Dossier anchors, transcript access, teardown, or Media lifecycle.
- A generic hierarchy, smart-view, projection, or policy framework.
- Schema/index changes. If measured plans require an index, stop and amend this
  spec before adding it.

## Target Behavior

For viewer `u`:

```text
DescendantMedia(u) = existing library_media_ids relation
ActivePodcasts(u)   = podcast_subscriptions.podcast_id WHERE user_id = u

DefaultRoots(u) =
  { m in DescendantMedia(u)
    where no podcast_episodes(media_id=m, podcast_id=p)
          has p in ActivePodcasts(u) }
  UNION ALL
  { p in ActivePodcasts(u) }
```

Rules:

- Determine parentage only through `podcast_episodes(media_id, podcast_id)`.
- Determine active following only through
  `podcast_subscriptions(user_id, podcast_id)`.
- Suppression is viewer-scoped. Another user's subscription has no effect.
- Suppress an active Podcast's Episode root regardless of which current
  personal Library membership supplies that Episode to All.
- Apply root subsumption before projection, Type, completion, ordering, keyset,
  and `LIMIT + 1`.
- `entry_type=podcast` returns active Podcast containers.
- `entry_type=podcast_episode` excludes children of active subscriptions.
- `Unfiled` and `In Progress` exclude those children. The Podcasts pane, queue,
  and Lectern remain their consumption surfaces.
- Named Libraries continue to show directly filed Podcast or Episode targets.
- Podcast container rows remain virtual and expose absent placement exactly as
  today. Do not insert Default `library_entries(podcast_id)` rows.

Examples:

| State | Default/All roots | Named Library |
|---|---|---|
| Subscribe to show with 500 retained episodes | one Podcast | unchanged |
| Sync adds 20 episodes | same one Podcast | unchanged |
| Explicitly add its Episode while subscribed | still one Podcast | Episode appears if filed there |
| Unsubscribe | Podcast disappears; retained Episode rows resurface | existing explicit placement remains |

## Capability Contract

`python/nexus/services/library_entries.py` owns both relations:

```text
list_library_entries(
  db, viewer_id, library_id, *, view, limit, cursor, collection_revision
) -> CollectionPage<EntryTarget>
count_default_root_inventory(db, *, viewer_id, library_id) -> int
library_media_ids_cte_sql(*, library_param=":library_id") -> SQL[media_id]  # unchanged
```

`EntryTarget = Media | Podcast` and the existing hydration DTOs remain
unchanged. The first two operations consume the same private normalized
Default-root relation. Other modules call the public count query; they do not
import private SQL or read Podcast tables to reconstruct the policy.

Do not rename or widen `library_media_ids_cte_sql`: it remains the canonical
descendant scope for authorization-adjacent reads, Search, evidence, anchors,
Atlas, transcripts, and lifecycle. Root inventory and descendant scope are
different capabilities.

## API And Cursor Design

Keep the existing API exactly:

```http
GET /libraries/{library_id}/entries
  ?projection=unfiled|in-progress
  &completion=unfinished
  &entry_type=web_article|epub|pdf|video|podcast_episode|podcast
  &sort=...&direction=...&cursor=...&limit=...&collection_revision=...
```

- Response union, `collectionRevision`, `nextCursor`, errors, and URL state are
  unchanged.
- Omission means `All items` and all completion states; unsupported explicit
  `all` values remain invalid.
- Bind Default cursors to the exact internal inventory discriminator
  `RootSubsumed`. Pre-cutover Default cursors must fail normal cursor query
  validation; add no compatibility decoder.
- Keep named-Library cursor identity and behavior unchanged.
- Subscription and Podcast-ingest revision bumps remain authoritative because
  a show's latest-episode facts and canonical order may change.

## Data And System Composition

No new durable state exists. Existing normalized facts carry the behavior:

- `podcast_subscriptions`' unique `(user_id, podcast_id)` edge is active follow
  intent and supplies the container root.
- `podcast_episodes`' `media_id -> podcast_id` edge supplies normalized
  parentage.
- `library_entries`' exactly-one Media-or-Podcast target remains the filing and
  descendant access/retention reference.

| Owner/consumer | Relation | Final behavior |
|---|---|---|
| Library root list/count | `DefaultRoots` | container-first |
| Podcast pane/show detail | `podcast_subscriptions` + `podcast_episodes` | unchanged episode triage |
| Named Libraries | physical `library_entries` | unchanged |
| Access/Search/Atlas/intelligence/transcripts | `library_media_ids_cte_sql` | unchanged descendants |
| Ingest/backfill | Default `library_entries(media_id)` | retained for access/lifecycle |
| Resource graph Library summary | public root-count query | no duplicate SQL |

The retained Default Episode row is not a fallback or legacy list path. It is
the current descendant access/retention reference. Stopping that write requires
a larger acquisition/authorization/provenance cutover and is explicitly not
part of this 80/20 slice.

## Key Decisions And Accepted Losses

- An explicitly added Episode is hidden in Default while its parent subscription
  is active; direct named-Library placement remains visible.
- Unsubscribe removes the container and retained physical Episode rows resurface
  as standalone Default roots. Existing storage cannot safely distinguish
  sync-created rows from explicit Episode Adds; do not guess or destructively
  remediate them.
- Atlas/Search/intelligence may expose many descendant Episodes while All shows
  one container. This is intentional: scope is not inventory.
- No preference can disable subsumption. One-user prototype behavior is fixed.
- A later gold cut may separate delivery/acquisition from explicit save, but
  this spec adds no speculative state for it.

## Architecture And Ownership

1. In `python/nexus/services/library_entries.py`, extract one private Default
   root candidate relation from the existing Default branch of
   `_membership_cte_sql`.
2. Exclude Media joined through `podcast_episodes` to the viewer's active
   `podcast_subscriptions`; union the existing virtual Podcast rows.
3. Reuse that relation for every Default view and for a narrow public
   `count_default_root_inventory` query.
4. In `python/nexus/services/resource_graph/resolve.py`, delegate Default counts
   to that query and delete `_count_default_virtual_items` and its raw SQL.
5. Do not filter in React, duplicate the predicate in a route, or introduce a
   cross-domain projection service.

Query requirements:

- Set-based anti-join/`NOT EXISTS`; no per-row service calls or N+1 queries.
- Materialize the final membership once as today.
- Preserve representative-row selection and every existing total-order
  tiebreaker after subsumption.
- Count the same root set the list can exhaust, before pagination.

## Files

Production:

- `python/nexus/services/library_entries.py` — sole root relation, list, count,
  cursor binding.
- `python/nexus/services/resource_graph/resolve.py` — delegate count; delete
  duplicate policy.
- No frontend production file should change.

Tests:

- `python/tests/test_libraries.py` — root projections, Type filters, pagination,
  user scoping, explicit placement.
- `python/tests/test_podcasts.py` — storage/list distinction, sync stability,
  unsubscribe resurfacing.
- `python/tests/test_resource_graph_resolve.py` — count/list parity.
- `python/tests/test_library_entry_plans.py` — exact Default plans at scale.
- `e2e/tests/real-media/podcast-refresh.spec.ts` — one subscribe/sync/All journey.

Docs updated in the implementation:

- `docs/{architecture.md,modules/library.md,modules/podcast.md}`.
- `browse-discovery-preview-acquisition-hard-cutover.md` — supersede the claim
  that subscribed Episodes appear as All roots.
- `library-all-and-smart-views-hard-cutover.md` — supersede the flat Default
  `All items` definition.
- `library-entry-type-filter-and-filter-row-reflow-hard-cutover.md` — bind Type
  filtering to the subsumed root inventory.

Use narrow supersession notes; do not rewrite unrelated historical specs.

## Implementation Order

1. Characterize current storage, list, count, explicit Add, and unsubscribe
   behavior through public-surface tests.
2. Add the root relation and hard-invalidate old Default cursors.
3. Route Default list/count through it; delete duplicate count logic.
4. Update tests and living docs; remove stale flat-inventory assertions/copy.
5. Run focused suites, exact query-plan gates, static checks, and real-stack
   E2E.

No phase may ship alone. Deploy backend before or with the unchanged frontend.
Rollback is whole-SHA rollback, not a runtime branch.

## Acceptance Criteria

- [x] Subscribing to a show with `N >= 1` Episodes changes Default root count by
      exactly `+1` and returns one Podcast row, zero child Episode rows.
- [x] Initial sync, refresh, and backfill preserve that cardinality while show
      facts/order and collection revision may advance.
- [x] Every valid composition of `All items`, `Unfiled`, `In Progress`,
      unfinished, Type, order, and page applies the same pre-pagination
      subsumption.
- [x] Named Libraries and direct Podcast/Episode placement are unchanged.
- [x] Podcast detail, queue, Lectern, authorization, Search, Atlas, transcripts,
      Dossier anchors, and intelligence still resolve descendant Episodes.
- [x] Explicit Episode Add while subscribed is characterized as hidden in
      Default; unsubscribe is characterized as container removal plus retained
      Episode resurfacing, with listening/reading state preserved.
- [x] Suppression is isolated by viewer and active subscription.
- [x] Exhausting the Default list equals the resource summary count for the
      same committed facts; no duplicate count SQL remains outside the owner.
- [x] A pre-cutover Default cursor is rejected; current Default and named
      cursors retain exact scope/order/view binding and stable keysets.
- [x] Exact production query plans show no correlated repeated scan, spill, or
      material regression; no speculative index is added.
- [x] Static residue scans find no frontend Podcast-child filter, old flat
      Default-root path, compatibility branch, feature flag, or stale normative
      claim.
- [x] No schema, migration, route, DTO, wire shape, worker, preference, or new UI
      surface is introduced.

## Verification Record

- Ten exact backend selectors pass across list/count, sync, explicit Add,
  unsubscribe, backfill, Resource Graph, cursor invalidation, and plan gates.
- The 145-descendant plan fixture yields 126 Default roots; every measured case
  executes below 100 ms against the 500 ms gate, with no read or spill and work
  loops bounded at 155 of 1,160.
- Exact Ruff, Pyright, web TypeScript, diff, and residue checks pass.
- The exact real-media Podcast refresh flow passes through browser, API, worker,
  SSE, physical child ingest, show detail, and container-first All.

## Done

The cutover is complete only when source, tests, living docs, supersession
notes, query-plan evidence, and real-stack E2E all describe one container-first
Default inventory with the old flat behavior absent.

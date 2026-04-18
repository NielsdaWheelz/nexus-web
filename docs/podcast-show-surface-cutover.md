# podcast show surface cutover

this brief defines the hard cutover to one show-first row contract and one
explicit in-app open path for podcast surfaces.

it builds on:

- [docs/podcast-home-cutover.md](./podcast-home-cutover.md)
- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/podcast-detail-episode-pane-cutover.md](./podcast-detail-episode-pane-cutover.md)
- [docs/library-target-picker-cutover.md](./library-target-picker-cutover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)

## goals

make every podcast show surface open the in-app show pane and present show
identity clearly.

after this cutover:

- every show row opens `/podcasts/[podcastId]`
- discovered shows open in-app before subscribe
- no show row uses an external website or feed url as its primary click action
- show rows use artwork and summary copy instead of placeholder badges and raw
  urls
- subscribed-show rows expose operational metadata for quick scanning
- podcast detail makes show identity readable at a glance

## scope

this change covers:

- followed-show rows on `/podcasts`
- discovery rows in the global `Add` dialog `Podcast` mode
- the primary show-summary area in podcast detail
- the backend resolution path required to open an unresolved discovered show
- bff and backend tests that assert the new contract

## target behavior

### followed shows on `/podcasts`

`/podcasts` remains the one top-level show-management surface, per
[docs/podcast-home-cutover.md](./podcast-home-cutover.md).

each followed-show row must show:

- artwork
- title
- one short summary line from description when present
- author or network when present
- latest episode recency
- unplayed count when greater than zero
- visible non-default library badges
- sync state when not healthy
- playback speed and auto-queue when enabled

each followed-show row must expose:

- open detail
- library picker
- refresh sync
- settings
- unsubscribe

feed url and website url belong in row overflow only.

they do not belong in the visible meta line.

### discovery rows in `Add`

the global `Add` dialog `Podcast` mode remains the only discovery surface, per
[docs/podcast-home-cutover.md](./podcast-home-cutover.md).

each discovery row must show:

- artwork
- title
- one short summary line from description when present
- author when present
- clear subscribed state when already followed

each discovery row must expose:

- open detail
- primary `Subscribe`
- adjacent picker trigger for `Subscribe + add to library` when not subscribed
- library picker plus separate `Unsubscribe` when already subscribed

do not keep a generic `Add to library` label on unsubscribed rows.

do not make the primary row action open an external site.

### podcast detail

podcast detail keeps the ownership split defined in
[docs/podcast-detail-episode-pane-cutover.md](./podcast-detail-episode-pane-cutover.md).

the primary column must clearly show:

- artwork
- title
- description or summary copy
- author and feed metadata
- subscribe and unsubscribe
- podcast-level library membership
- podcast-level settings
- show-level status

the secondary episode pane continues to own episode rows, filters, sort, search,
queue actions, transcript actions, and episode library actions.

do not move episode controls back into the primary column.

### open-in-app flow

there is one show-detail route: `/podcasts/[podcastId]`.

there is no second route shape for provider ids, feed urls, or unresolved
search results.

opening a show works like this:

1. if a row already has local `podcast_id`, open `/podcasts/[podcastId]`
   directly.
2. if a discovered row does not yet have local `podcast_id`, call one explicit
   idempotent ensure route.
3. open `/podcasts/[podcastId]` using the returned local id.

do not pre-create local podcast rows for every search result.

only ensure a local row on explicit open.

## non-goals

this change does not cover:

- redesigning episode rows
- changing podcast detail pane width or ownership rules
- adding podcast folders, tags, categories, playlists, or stations
- adding batch show operations
- redesigning the global player or queue
- changing library membership semantics
- introducing a generic row renderer, generic entity resolver, generic pane-open
  framework, generic discovery framework, or generic filter schema

## key decisions

`/podcasts/[podcastId]` is the only show-detail route.

do not add `/podcasts/provider/[providerId]`, `/podcasts/by-feed`,
`/podcasts/resolve/[something]`, or any other unresolved-resource route.

discovery remains read-first.

do not create local podcast rows for every search result during discovery.

only create or hydrate a local row when the user explicitly opens an unresolved
show.

the open path gets one explicit backend capability: ensure a local podcast row
exists for one discovered show and return its local `podcast_id`.

that capability stays podcast-specific.

do not add a generic `resolve media-like thing into route` layer.

row rendering stays local to each surface.

do not add a generic podcast-row abstraction unless a later implementation can
show a clear payoff in both callsites.

small duplication is acceptable if it keeps the row contract obvious in place.

feed and website links are secondary affordances.

they belong in overflow, not in the main row text and not in the primary click
path.

## hard cutover rules

- do a hard cutover. do not keep placeholder `POD` artwork once image urls are
  available.
- do a hard cutover. do not keep external website or feed links as the primary
  row click action.
- do not keep `/podcasts/subscriptions` in the shipped app.
- do not keep discovery on `/podcasts`.
- do not keep generic `Add to library` copy on unsubscribed podcast surfaces.
- do not add redirects, aliases, compatibility routes, fallback route ids, or
  legacy row layouts.
- do not support both `podcast_id` detail routing and provider-id detail
  routing.
- do not introduce a generic resolver endpoint or generic entity-open helper.

## implementation rules

- keep `/podcasts` page control flow local and linear in `PodcastsPaneBody.tsx`.
- keep podcast-detail show-summary control flow local and linear in
  `PodcastDetailPaneBody.tsx`.
- keep add-dialog `Podcast` mode control flow local and linear in the dialog
  component.
- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md).
- keep podcast business logic in `python/nexus/services/podcasts.py`.
- keep branching explicit for followed show row state, discovery row state,
  resolved versus unresolved open behavior, and subscribed versus unsubscribed
  actions.
- keep request and response shapes shallow and explicit.
- do not add nested resolver payloads, generic state bags, or intermediate
  transport models.
- if a value is used once and does not carry real semantic weight, inline it.
- if a helper is used once, inline it unless it hides substantial incidental
  complexity.

## api contract

keep these existing routes:

- `GET /api/podcasts/discover`
- `GET /api/podcasts/subscriptions`
- `POST /api/podcasts/subscriptions`
- `GET /api/podcasts/{podcastId}`
- `GET /api/podcasts/{podcastId}/episodes`
- `GET /api/podcasts/{podcastId}/libraries`

add one new explicit route: `POST /api/podcasts/ensure`.

`GET /api/podcasts/discover` must return `podcast_id` when the discovered show
already exists locally.

it must continue to return:

- `provider_podcast_id`
- `title`
- `author`
- `feed_url`
- `website_url`
- `image_url`
- `description`

`POST /api/podcasts/ensure` must accept one shallow request body:

- `provider_podcast_id`
- `feed_url`
- `title`
- `author`
- `image_url`
- `description`

it must:

- first try to find a local podcast by provider id
- then try to find a local podcast by feed url
- create or hydrate one local podcast row only if still missing
- return one local `podcast_id`

it must not:

- subscribe the user
- create library membership
- enqueue episodes
- accept nested discovery payloads
- become a generic resolver for other resource types

`GET /api/podcasts/subscriptions` must include the exact row fields needed for
the followed-show contract:

- podcast summary
- subscription status
- unplayed count
- latest episode recency field
- visible non-default libraries for badges
- playback speed
- auto-queue
- sync state

## files

docs to add:

- `docs/podcast-show-surface-cutover.md`

primary frontend files to edit:

- `apps/web/src/app/(authenticated)/podcasts/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/page.module.css`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.module.css`
- `apps/web/src/components/IngestionTray.tsx` if kept, or its replacement add
  dialog component if renamed
- `apps/web/src/components/IngestionTray.module.css` if kept, or the
  replacement stylesheet if renamed
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`

frontend files to remove:

- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.module.css`

frontend bff files to edit:

- `apps/web/src/app/api/podcasts/discover/route.ts`
- `apps/web/src/app/api/podcasts/ensure/route.ts`
- `apps/web/src/app/api/podcasts/subscriptions/route.ts`
- `apps/web/src/app/api/podcasts/[podcastId]/route.ts`
- `apps/web/src/app/api/podcasts/[podcastId]/episodes/route.ts`
- `apps/web/src/app/api/podcasts/[podcastId]/libraries/route.ts`

backend files to edit:

- `python/nexus/api/routes/podcasts.py`
- `python/nexus/schemas/podcast.py`
- `python/nexus/services/podcasts.py`

tests to update:

- `apps/web/src/app/(authenticated)/podcasts/podcasts-flows.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcasts-action-menus-cutover.test.tsx`
- `apps/web/src/app/api/podcasts/podcasts-routes.test.ts`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
- `python/tests/test_podcasts.py`

## implementation plan

1. delete the dedicated subscriptions page files and remove the route from the
   pane registry, per [docs/podcast-home-cutover.md](./podcast-home-cutover.md).
2. rewrite `PodcastsPaneBody.tsx` into the followed-show page contract instead
   of discovery plus `MediaCatalogPage`.
3. move discovery into the global `Add` dialog `Podcast` mode if that cutover
   is not already complete.
4. extend `GET /api/podcasts/discover` so it includes local `podcast_id` when
   already known.
5. add `POST /api/podcasts/ensure` for unresolved show open.
6. wire unresolved discovery-row open to `ensure`, then open
   `/podcasts/[podcastId]`.
7. strengthen followed-show rows to show artwork, summary, recency, unplayed
   count, libraries, and operational metadata.
8. strengthen the podcast-detail primary summary area to show artwork and
   description clearly while keeping episode ownership unchanged.
9. align unsubscribed and subscribed podcast actions with
   [docs/library-target-picker-cutover.md](./library-target-picker-cutover.md).
10. update tests and remove assertions that depend on external-link primary
    clicks, placeholder artwork, `/podcasts/subscriptions`, or legacy row copy.

## cases to cover

- followed show with artwork and description
- followed show without artwork
- followed show with no description
- followed show with unplayed episodes
- followed show with healthy sync state
- followed show with sync error state
- followed show in one or more libraries
- unresolved discovery result open
- already-local discovery result open
- unsubscribed discovery result `Subscribe`
- unsubscribed discovery result `Subscribe + add to library`
- subscribed discovery result library picker
- subscribed discovery result `Unsubscribe`
- podcast detail for subscribed show
- podcast detail for unsubscribed show
- detail view after unresolved discovery open

## acceptance criteria

- `/podcasts` shows followed-show rows, not discovery cards or episode catalog
  rows.
- `/podcasts/subscriptions` no longer exists in the shipped app.
- every show row on `/podcasts` opens `/podcasts/[podcastId]`.
- every discovery row in `Add` `Podcast` mode opens `/podcasts/[podcastId]`.
- unresolved discovery rows create or hydrate a local podcast only on explicit
  open.
- no podcast row uses `website_url` or `feed_url` as its primary click action.
- no podcast row shows raw feed url in the visible meta line.
- podcast rows show artwork whenever `image_url` is available.
- unsubscribed podcast surfaces show `Subscribe` plus an adjacent
  `Subscribe + add to library` picker trigger.
- subscribed podcast surfaces show the library picker plus separate
  `Unsubscribe`.
- podcast detail primary content clearly shows artwork and description.
- podcast detail secondary pane ownership remains unchanged.
- the implementation does not introduce a second detail route, generic resolver
  layer, generic row renderer, generic pane-open helper, or legacy
  compatibility path.

## regression coverage

required frontend coverage includes:

- pane registry test: `/podcasts/subscriptions` is removed
- podcasts page test: followed-show rows render artwork, summary, recency, and
  operational metadata
- podcasts page test: row primary click opens local detail route
- add dialog test: unresolved discovery result calls `ensure` then opens detail
- add dialog test: already-local discovery result opens detail without `ensure`
- add dialog test: unsubscribed and subscribed action sets match the picker
  cutover contract
- detail test: primary summary shows artwork and description while episode-pane
  controls remain in the secondary pane

required backend coverage includes:

- discover test: rows include local `podcast_id` when already known
- ensure test: provider-id match returns the existing local podcast id
- ensure test: feed-url fallback returns the existing local podcast id
- ensure test: missing podcast creates or hydrates one local row and returns its
  id
- ensure test: ensure does not subscribe the user or create library membership
- subscriptions list test: rows include the show-level metadata required by the
  followed-show contract

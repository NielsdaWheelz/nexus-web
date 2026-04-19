# podcast show surface cutover

this brief defines the hard cutover to one show-first contract across
`/podcasts`, `Browse`, and podcast detail.

it builds on:

- [docs/browse-add-search-cutover.md](./browse-add-search-cutover.md)
- [docs/podcast-home-cutover.md](./podcast-home-cutover.md)
- [docs/podcast-detail-episode-pane-cutover.md](./podcast-detail-episode-pane-cutover.md)
- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/library-target-picker-cutover.md](./library-target-picker-cutover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)

## goal

make every podcast show surface open the in-app show pane and present show
identity clearly.

after this cutover:

- followed-show rows on `/podcasts` open `/podcasts/[podcastId]`
- browse results open `/podcasts/[podcastId]`
- discovery no longer lives in `Add`
- no show row uses an external website or feed url as its primary click action
- show rows use artwork and summary copy instead of placeholder badges and raw
  urls

## scope

this change covers:

- followed-show rows on `/podcasts`
- podcast results in `Browse`
- the primary show-summary area in podcast detail
- the backend ensure path required to open unresolved browse results
- tests that assert the final row and open contract

## non-goals

this change does not cover:

- redesigning episode rows
- changing podcast detail pane width or ownership rules
- changing library membership semantics
- redesigning the global player or queue
- introducing a generic row renderer, generic resolver, or generic pane-open
  framework

## target behavior

### followed shows on `/podcasts`

`/podcasts` remains the one top-level show-management surface.

each followed-show row must show:

- artwork
- title
- one short summary line when present
- author or network when present
- latest episode recency
- unplayed count when greater than zero
- visible non-default library badges
- sync state when not healthy

each followed-show row must expose:

- open detail
- library picker
- refresh sync
- settings
- unsubscribe

feed url and website url belong in row overflow only.

### podcast results in `Browse`

`Browse` is the only acquisition surface for podcasts.

each browse result must show:

- artwork
- title
- one short summary line when present
- author when present
- clear subscribed state when already followed

each browse result must expose:

- open detail
- primary `Subscribe`
- adjacent picker trigger for `Subscribe + add to library` when not subscribed
- library picker plus separate `Unsubscribe` when already subscribed

do not route podcast search through `Add`.

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

### open-in-app flow

there is one show-detail route: `/podcasts/[podcastId]`.

opening a show works like this:

1. if a row already has local `podcast_id`, open `/podcasts/[podcastId]`
   directly.
2. if a browse result does not yet have local `podcast_id`, call one explicit
   idempotent ensure route.
3. open `/podcasts/[podcastId]` using the returned local id.

do not pre-create local podcast rows for every browse result.

## key decisions

`/podcasts/[podcastId]` is the only show-detail route.

do not add provider-id routes, feed-url routes, or unresolved-resource routes.

discovery remains read-first.

only ensure a local row when the user explicitly opens an unresolved show.

the ensure path stays podcast-specific.

do not add a generic resolver or generic entity-open layer.

row rendering stays local to each surface.

small duplication is acceptable if it keeps the row contract obvious in place.

## hard cutover rules

- do a hard cutover. do not keep discovery on `/podcasts`.
- do a hard cutover. do not keep discovery in `Add`.
- do not keep `/podcasts/subscriptions` in the shipped app.
- do not keep external website or feed links as the primary row click action.
- do not add redirects, aliases, compatibility routes, fallback route ids, or
  legacy row layouts.
- do not support both `podcast_id` detail routing and provider-id detail
  routing.
- do not introduce a generic resolver endpoint or generic entity-open helper.

## implementation rules

- keep `/podcasts` page control flow local and linear in `PodcastsPaneBody.tsx`.
- keep browse podcast-result control flow local and linear in the browse
  surface.
- keep podcast-detail show-summary control flow local and linear in
  `PodcastDetailPaneBody.tsx`.
- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md).
- keep podcast business logic in `python/nexus/services/podcasts.py`.
- keep branching explicit for followed-show state, browse-result state,
  resolved-versus-unresolved open behavior, and subscribed-versus-unsubscribed
  actions.
- keep request and response shapes shallow and explicit.

## api contract

keep these routes:

- `GET /api/podcasts/discover`
- `GET /api/podcasts/subscriptions`
- `POST /api/podcasts/subscriptions`
- `GET /api/podcasts/{podcastId}`
- `GET /api/podcasts/{podcastId}/episodes`
- `GET /api/podcasts/{podcastId}/libraries`
- `POST /api/podcasts/ensure`

`GET /api/podcasts/discover` feeds `Browse`, not `Add`.

`POST /api/podcasts/ensure` exists only to resolve one browse result into one
local `podcast_id`.

## acceptance criteria

- every followed-show row on `/podcasts` opens `/podcasts/[podcastId]`
- every podcast browse result opens `/podcasts/[podcastId]`
- unresolved browse results call `ensure` before opening detail
- discovery is not shipped in `Add`
- `/podcasts` shows followed-show rows, not discovery cards or episode catalog
- the implementation does not introduce a generic resolver, generic row
  renderer, compatibility route, or second show-detail route

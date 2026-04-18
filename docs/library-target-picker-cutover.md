# library target picker cutover

this brief defines the hard cutover from binary or flat library actions to one
explicit specific-library picker at the point of action.

it builds on:

- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/function-parameters.md](./rules/function-parameters.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)
- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)

## goal

make every user-facing library add flow target a specific non-default library at
the moment the user acts.

after this cutover:

- media detail no longer toggles only the default library
- add-new-media can send a new item directly to one chosen library
- podcast subscribe can subscribe and place the show into one chosen library in
  the same action
- existing media and podcast library actions use one searchable picker pattern
  instead of long flat `Add to X` menus

## scope

this change covers:

- the media detail header action
- the add-new-media modal for file upload and add-from-url
- podcast discovery, subscriptions, and podcast detail library actions
- backend read paths for item-to-library membership state
- backend write paths for upload, add-from-url, and subscribe with a target
  library
- frontend tests and backend tests for the new selection flow

this change does not cover:

- redesigning the library pane
- redesigning default-library closure
- adding batch multi-library editing
- adding multi-library targeting during upload or subscribe
- adding playlists, podcast folders, or new organization primitives

## product decision

non-default libraries are the only user-facing destination picker.

default libraries remain hidden media-only infrastructure.

default libraries do **not** appear in the picker.

the picker edits explicit non-default-library membership only.

the picker does **not** stand in for default-library closure state.

upload and add-from-url may target zero or one non-default library.

if the user does not pick a library during upload or add-from-url, the item is
created with the existing media visibility behavior only.

podcast subscribe remains a distinct operational action.

on unsubscribed podcast surfaces, the user gets:

- a primary `Subscribe` action
- an adjacent library picker action that performs `subscribe + add to library`

on subscribed podcast surfaces, the user gets:

- a library picker action for membership changes
- a separate `Unsubscribe` action

all user-facing library selection surfaces use one searchable picker pattern.

the app does **not** keep a mix of:

- binary default-library toggles
- flat `Add to X` lists
- one-off subscription menus

## hard cutover rules

- remove the media detail default-library-only toggle and its supporting client
  logic.
- remove flat per-library `Add to X` and `Remove from X` menus on surfaces that
  are choosing a library.
- remove client-side library-membership scans that fetch every library and page
  through entries just to answer membership for one item.
- do not keep old library-action variants behind flags, screen-specific
  fallbacks, or compatibility branches.
- do not add a generic mixed-content write endpoint.
- do not add a generic `kind + target_id` write payload.
- do not add a generic picker framework, overlay framework, or command-style
  launcher abstraction.
- do not surface default libraries in any user-facing library picker.
- do not add multi-select library targeting for upload or subscribe.

## implementation rules

- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md).
- keep business logic in `python/nexus/services/libraries.py`,
  `python/nexus/services/upload.py`, and `python/nexus/services/podcasts.py`.
- keep service control flow local and linear.
- keep library writes explicit by content type:
  - `POST /api/libraries/{libraryId}/media`
  - `DELETE /api/libraries/{libraryId}/media/{mediaId}`
  - `POST /api/libraries/{libraryId}/podcasts`
  - `DELETE /api/libraries/{libraryId}/podcasts/{podcastId}`
- add explicit item-to-library read routes instead of reusing library-entry list
  routes for one-item membership checks.
- add only real boundary fields that have real call sites:
  - optional `library_id` on upload init
  - optional `library_id` on add-from-url
  - optional `library_id` on podcast subscribe
- keep those boundary fields shallow.
- keep picker control flow local to the picker component and each calling
  surface.
- if a branch handles media versus podcast behavior, keep that branch explicit
  and exhaustive at the call site.

## api shape

### library membership reads

add explicit read endpoints for picker state:

- `GET /api/media/{mediaId}/libraries`
- `GET /api/podcasts/{podcastId}/libraries`

each endpoint returns one row per visible non-default library with:

- library id
- library name
- library color
- whether the item is already in that library
- whether the viewer can add there
- whether the viewer can remove there

do not return default-library closure state from these endpoints.

do not overload `GET /api/libraries/{libraryId}/entries` for this capability.

### media creation writes

extend these request bodies with optional `library_id`:

- `POST /api/media/upload/init`
- `POST /api/media/from-url`

the field is nullable or omitted.

there is no array form.

there is no nested `target` object.

### podcast subscribe write

extend `POST /api/podcasts/subscriptions` with optional `library_id`.

the route remains the one subscribe entry point.

if `library_id` is present, the service must:

1. subscribe or reactivate the subscription
2. validate that the target library is a visible non-default library
3. add the podcast to that library
4. return one response

do not split this into separate client calls when one explicit server operation
can complete it atomically.

## backend design

### libraries service

`python/nexus/services/libraries.py` owns item-to-library picker reads.

add two explicit read operations:

- one for media library membership
- one for podcast library membership

do not add one generic mixed-target read helper unless the final code is
materially smaller and clearer than two explicit functions.

each function should:

1. select visible non-default libraries for the viewer
2. left join the relevant entry table state for the requested item
3. compute explicit `can_add` and `can_remove` fields
4. return rows in a stable order

do not make the client derive permissions or membership by stitching together
multiple unrelated responses.

### upload service

`python/nexus/services/upload.py` owns upload targeting.

`init_upload` accepts optional `library_id` as a keyword-only business field.

the flow stays explicit:

1. validate upload request
2. create or reuse media row
3. ensure default-library media closure behavior
4. if `library_id` is present, validate it and add explicit media membership
5. return the existing upload init response

if the target library is invalid, default, or not writable by the viewer, fail
the request explicitly.

do not silently drop the target library.

### media from url service

the add-from-url path in `python/nexus/services/media.py` accepts optional
`library_id` and follows the same explicit rule:

1. create or resolve media
2. preserve existing ingest behavior
3. ensure default-library media closure behavior
4. if `library_id` is present, validate it and add explicit media membership
5. return the existing response

### podcasts service

`python/nexus/services/podcasts.py` owns subscribe targeting.

`subscribe_to_podcast` accepts optional `library_id`.

the flow stays explicit:

1. upsert the podcast
2. create or reactivate the subscription
3. enqueue sync as today
4. if `library_id` is present, validate it and add podcast membership
5. return the existing subscribe response

unsubscribe remains separate and destructive.

unsubscribe does **not** move into the picker.

## frontend design

### one library picker capability

add one dedicated library picker component for this cutover.

it is a library picker, not a generic combobox.

it must provide:

- anchored popup behavior
- search input for library filtering
- one row per non-default library
- explicit add/remove affordance per row
- loading, empty, and error states

it must not provide:

- generic command results
- arbitrary option rendering hooks
- reusable filtering engines
- a second overlay system

the component earns its keep because it is reused in:

- media detail
- media catalog rows
- podcast discovery rows
- podcast subscriptions rows
- podcast detail
- add-new-media

### media detail

replace the current binary `Add to library` / `Remove from library` action in
`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` and
`useMediaViewState.tsx`.

the media detail surface must:

- fetch explicit non-default library membership from `GET /api/media/{id}/libraries`
- open the library picker instead of toggling default-library membership
- add or remove explicit non-default-library membership from the picker

do not keep the old default-library membership fetch or page scan.

### media catalog surfaces

replace flat per-library option lists in `apps/web/src/components/MediaCatalogPage.tsx`
with the picker.

the catalog surface must not build one action-menu entry per library anymore.

the picker should own search and filtering when the user chooses a library.

### add-new-media

`apps/web/src/components/IngestionTray.tsx` gets one optional library selector
above the file and url entry controls.

rules:

- the selector targets one non-default library or none
- the selected library is snapped onto each queued item when that item is added
- changing the selector later does not rewrite already queued items
- each queued item carries its own explicit target library id or no target

do not add per-item inline library editing in this cutover.

### podcast surfaces

replace flat per-library menus in:

- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`

unsubscribed podcast surfaces must show:

- one primary `Subscribe` button
- one adjacent library picker trigger for `subscribe + add to library`

subscribed podcast surfaces must show:

- the library picker for add or remove
- a separate `Unsubscribe` action

do not make `Unsubscribe` a picker row.

do not hide subscribe semantics behind a generic `Add to library` label.

## implementation plan

1. add the new cutover doc.
2. add explicit fastapi and bff read routes for media-to-library and
   podcast-to-library picker state.
3. extend the upload init, add-from-url, and podcast subscribe request schemas
   with optional `library_id`.
4. update backend services so those writes use the target library explicitly and
   fail explicitly on invalid target libraries.
5. add one dedicated frontend library picker component.
6. replace the media detail binary toggle with the picker.
7. replace flat per-library option lists on media and podcast surfaces with the
   picker.
8. add the optional library selector to `IngestionTray` and snapshot the
   selected target onto each queued item.
9. update tests and remove old default-library-only client logic.

## file plan

### docs

- add `docs/library-target-picker-cutover.md`

### backend routes

- `python/nexus/api/routes/media.py`
- `python/nexus/api/routes/podcasts.py`
- `python/nexus/api/routes/libraries.py`

### backend schemas

- `python/nexus/schemas/media.py`
- `python/nexus/schemas/podcast.py`
- `python/nexus/schemas/library.py`

### backend services

- `python/nexus/services/libraries.py`
- `python/nexus/services/upload.py`
- `python/nexus/services/media.py`
- `python/nexus/services/podcasts.py`

### frontend bff routes

- `apps/web/src/app/api/media/upload/init/route.ts`
- `apps/web/src/app/api/media/from-url/route.ts`
- `apps/web/src/app/api/media/[id]/libraries/route.ts`
- `apps/web/src/app/api/podcasts/subscriptions/route.ts`
- `apps/web/src/app/api/podcasts/[podcastId]/libraries/route.ts`

### frontend components

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/components/MediaCatalogPage.tsx`
- `apps/web/src/components/IngestionTray.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- one new dedicated library picker component under `apps/web/src/components/`

### tests

- `apps/web/src/app/api/media/media-routes.test.ts`
- `apps/web/src/app/api/podcasts/podcasts-routes.test.ts`
- `apps/web/src/app/api/libraries/libraries-media-routes.test.ts`
- focused browser or component tests for the picker surfaces
- focused python tests under `python/tests/`

## cases to cover

- media not in any non-default library
- media in one non-default library
- media in multiple non-default libraries
- shared library where the viewer can add but cannot remove
- shared library where the viewer can remove
- media detail open for an item that is only in default-library closure
- upload with no library selected
- upload with a valid non-default library selected
- upload with an invalid or default library selected
- queue several upload items, then change the selected library and queue more
  items
- add-from-url with no library selected
- add-from-url with a valid non-default library selected
- unsubscribed podcast primary subscribe with no library target
- unsubscribed podcast subscribe into a chosen library
- already subscribed podcast add to another library
- subscribed podcast remove from one library while remaining subscribed
- library picker search with matching results
- library picker search with no results
- library picker network error state

## acceptance criteria

- on media detail, clicking `Add to library` no longer toggles default-library
  membership directly.
- on media detail, the user can search visible non-default libraries and add or
  remove the item explicitly.
- on media and podcast list surfaces, the app no longer renders one flat action
  per library when the user is choosing a destination library.
- on add-new-media, the user can pick one non-default library before uploading a
  file or submitting a url.
- on add-new-media, leaving the library blank still succeeds and preserves the
  current media creation behavior.
- on add-new-media, queued items keep the library target they had when they were
  queued.
- on podcast discovery and detail, the user can subscribe without choosing a
  library.
- on podcast discovery and detail, the user can subscribe directly into one
  chosen library in one server-backed action.
- on subscribed podcast surfaces, library membership changes remain separate
  from unsubscribe.
- default libraries do not appear in any user-facing library picker.
- the client no longer scans every library or pages through default-library
  entries to answer membership for one item.
- the implementation keeps explicit content-type-specific write routes and does
  not add a generic mixed-content write endpoint.
- the implementation keeps control flow local and linear in the touched
  services and ui surfaces.

## regression coverage

required backend coverage includes:

- unit or integration test: `GET /media/{id}/libraries` returns visible
  non-default libraries with correct membership and permission flags
- unit or integration test: `GET /podcasts/{id}/libraries` returns visible
  non-default libraries with correct membership and permission flags
- unit or integration test: upload init with `library_id` adds explicit
  non-default-library membership
- unit or integration test: add-from-url with `library_id` adds explicit
  non-default-library membership
- unit or integration test: upload and add-from-url reject default or invalid
  target libraries
- unit or integration test: subscribe with `library_id` subscribes and adds the
  podcast to that library
- unit or integration test: subscribe without `library_id` keeps current
  behavior
- unit or integration test: default-library closure remains media-only and is
  not exposed as picker membership

required frontend coverage includes:

- route test: new media library read route proxies correctly
- route test: new podcast library read route proxies correctly
- route test: upload init continues proxying with the extended request body
- route test: subscribe continues proxying with the extended request body
- browser or component test: media detail opens the picker and renders filtered
  library results
- browser or component test: media catalog row uses the picker instead of a
  long flat menu
- browser or component test: add-new-media passes the chosen library target for
  queued uploads and queued urls
- browser or component test: queued items keep their snapped library target
- browser or component test: unsubscribed podcast surface supports primary
  subscribe and subscribe-into-library as distinct actions
- browser or component test: subscribed podcast surface keeps library actions
  separate from unsubscribe

## validation commands

```bash
make test-back-unit
make test-front-browser
make verify
```

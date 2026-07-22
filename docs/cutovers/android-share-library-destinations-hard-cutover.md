# Android share library destinations hard cutover

## Status

Implemented on 2026-06-04. This document records the final behavior, owner
contracts, and verification scope for the hard cutover.

## Summary

Android share-to-Nexus must become a destination-first capture flow for URL
shares. Before any URL media is created, the share surface lets the user:

- search writable non-default libraries without a 100-library ceiling,
- select zero or more destination libraries in addition to the implicit default
  library,
- create a new non-default library inline,
- auto-select the newly created library,
- save all shared URLs with the selected destinations in the initial ingest
  request.

This is a hard cutover. The current post-save "Add to libraries?" lane is
removed from `/share`. No compatibility path keeps saving URL media first and
asking for libraries later.

Android native code remains the share handoff layer. Product behavior stays in
the web/FastAPI/library services layers.

## Why

The current Android share flow works for small library counts but has the wrong
shape for a user with many libraries:

- `/share` saves URL media first with `libraryIds: []`, then opens a modal to
  add existing libraries.
- The modal can only select from already loaded libraries.
- The library list comes from `GET /libraries`, which defaults to 100 rows and
  clamps to 200.
- The picker filters client-side.
- There is no inline create-library path.
- Library destination writes currently validate "accessible" libraries first,
  then the actual add path requires admin. That is a capability mismatch.
- Bulk add can partially apply because the former resolved-library loop called a
  singular transaction owner once per destination.

The long-term-safe owner-layer fix is not a route-local button in
`ShareCapture`. The target state is one canonical writable-library destination
contract, one frontend destination picker, one library create client, and one
atomic backend add-media-to-libraries write path.

## External UX and platform constraints

Android receive-share guidance says a share target should let the user confirm
and edit shared content before using it, especially for text data:
<https://developer.android.com/training/sharing/receive>

`ChooserAction` is sender-side Android Sharesheet customization for
`Intent.ACTION_CHOOSER`, not the receiver-side API for Nexus as a share target:
<https://developer.android.com/reference/android/service/chooser/ChooserAction>

The picker must follow the WAI-ARIA combobox/listbox model where search input
keeps DOM focus and the active option is represented through
`aria-activedescendant`:

- <https://www.w3.org/WAI/ARIA/apg/patterns/combobox/>
- <https://www.w3.org/WAI/ARIA/apg/patterns/listbox/>

## Existing owner boundaries

### Android shell

Owner: `apps/android/app/src/main/java/app/nexus/android/ShareActivity.kt`

Responsibilities that remain:

- receive `ACTION_SEND` `text/plain`,
- trim `Intent.EXTRA_TEXT`,
- finish immediately for empty text,
- load `${NEXUS_BASE_URL}/share?text=...` in the shared hardened WebView,
- intercept `nexus-share://open`, `nexus-share://done`, and
  `nexus-share://dismiss`,
- hand off owned-origin open requests to `MainActivity`.

Responsibilities that must not move into Android:

- product API calls,
- Supabase/session work,
- library search,
- library creation,
- media ingestion,
- upload clients,
- JavaScript bridges.

This follows `docs/rules/codebase.md` and `docs/rules/layers.md`: Android is a
shell, not a product API client.

### Web share surface

Owner: `apps/web/src/app/share/`

Responsibilities after the cutover:

- parse the shared text,
- classify URL-share versus non-URL quick note,
- for URL shares, run destination selection before ingestion,
- call web BFF APIs only through frontend client helpers,
- show progress and per-URL success/failure results,
- deep-link back to Android via `nexus-share://...`.

`/share` stays outside the authenticated app shell. It must continue to avoid
redirecting logged-out users into a trapped login flow. Session gating remains
the compact sign-in-required card in `apps/web/src/app/share/page.tsx`.

### Library governance

Owner: `python/nexus/services/library_governance.py`

Responsibilities after the cutover:

- create non-default libraries,
- own `libraries` and `memberships`,
- expose the single backend query for writable destination libraries,
- expose the single backend helper that resolves user-submitted destination
  library IDs to writable non-default IDs.

### Library entries

Owner: `python/nexus/services/library_entries.py`

Responsibilities after the cutover:

- remain the sole writer of `library_entries`,
- keep `EntryTarget`,
- keep `ensure_entry` as the append primitive,
- add media to multiple libraries atomically in one service-level command,
- attach media to the default library plus selected destinations in one
  sequentially valid operation,
- return the actual inserted destination IDs.

### Media ingest

Owner: `python/nexus/services/media_ingest.py` plus source owners
`youtube_ingest.py`, `x_ingest.py`, `remote_file_ingest.py`, and
`media.py`.

Responsibilities after the cutover:

- validate selected destination libraries before creating media,
- create or reuse URL media through the source owner,
- assign default plus selected destinations through `library_entries`,
- preserve `FromUrlResponse.idempotency_outcome`.

## Target behavior

### URL share from Android

1. User shares text containing one or more URLs to Nexus.
2. `ShareActivity` loads `/share?text=...`.
3. `/share` verifies an active or refreshable session exactly as today.
4. The web share card shows:
   - a concise preview of the URLs to be saved,
   - a destination picker labeled as library destinations,
   - an implicit "My Library" default destination indicator,
   - actions: `Save`, `Cancel`.
5. The destination picker:
   - starts with recent or first writable destinations,
   - searches server-side as the user types,
   - caps visible result count,
   - supports keyboard selection,
   - supports multi-select,
   - keeps selected libraries visible as chips even when filtered out,
   - shows a create row when the normalized query is a valid new library name
     and no exact match exists,
   - creates the library through `POST /api/libraries`,
   - auto-selects the created library,
   - leaves the picker open after create.
6. If the user taps `Cancel` before saving, no URL media is created. A library
   created explicitly from the picker remains because that was its own committed
   action.
7. If the user taps `Save`, every URL is submitted with the same selected
   destination library IDs in the initial `/api/media/from-url` request.
8. While saving, destination controls are disabled and the card reports progress.
9. On completion, the card shows one result per URL:
   - `Saved` for newly created media,
   - `Already in your library` for reused media,
   - `Could not save` for failures.
10. For successful media, `Open in Nexus` deep-links to `/media/{id}` through
    `nexus-share://open?path=...` when in the Android shell.
11. `Done` closes the share activity through `nexus-share://done` when in the
    Android shell.
12. Retry keeps the same selected destination IDs and retries only failed URLs.

### URL share in a normal browser

Same behavior as Android except:

- `Done` links to `/`,
- successful media links directly to `/media/{id}`,
- no native deep link is used.

### Non-URL text share

Non-URL shared text remains a quick capture to today's daily note.

No library destination picker is shown for non-URL text because libraries are
media/podcast containers today. Creating a library with no item to file is not a
valid product action in this flow.

### Multi-URL share

The same selected destination set applies to all URLs in the share payload.

The flow is per-URL atomic, not all-URLs atomic. If one URL fails and another
URL succeeds, the successful URL remains saved with the selected destinations.
The retry lane retries failed URLs only.

### Empty share

Native Android continues to finish the activity immediately for empty shared
text. Browser `/share?text=` continues to render the compact empty-state card.

## Non-goals

- No `ACTION_SEND_MULTIPLE` support.
- No `EXTRA_STREAM` support.
- No Android image, video, PDF, or EPUB share intake.
- No native Android product API client.
- No JavaScript bridge.
- No Android `ChooserAction` work.
- No Direct Share targets.
- No note-to-library filing.
- No tags/folders/playlists taxonomy.
- No generic picker framework beyond the library destination capability needed
  here.
- No backward-compatible support for the old `/share` post-save add-libraries
  lane.

## Hard cutover rules

- Delete the old `/share` behavior that calls `addMediaFromUrl({ libraryIds: [] })`
  before the user confirms destinations.
- Delete the post-save `LibraryMultiSelectPicker` modal from `ShareCapture`.
- Do not keep a hidden fallback where failed destination load silently saves to
  My Library.
- Do not keep `fetchNonDefaultLibraries` as the destination source for ingest
  pickers.
- Do not silently accept default library IDs in destination arrays.
- Do not silently accept duplicate destination IDs in a single request.
- Do not validate write destinations through an "accessible" helper.
- Do not leave a second `LibrarySummary` type in a component.
- Do not add a route-local create-library client inside `ShareCapture`.
- Do not make Android call FastAPI or Next API routes directly outside the
  current WebView navigation handoff.

## Capability contract

### Library destination

A library destination is a non-default library where the viewer can add library
entries.

Properties:

- `id`: UUID string
- `name`: non-empty string, max 100 chars
- `color`: string or null
- `created_at`: ISO datetime
- `updated_at`: ISO datetime

Invariants:

- default library is never returned,
- member-only libraries are never returned,
- owner/admin libraries are returned,
- result order is deterministic,
- search is case-insensitive,
- query normalization happens once at the backend route/schema boundary,
- the backend result is already authorized for write selection.

### Destination ID array

In request bodies, `library_ids` means selected non-default writable destination
library IDs. It does not mean all accessible libraries.

Rules:

- omitted or empty means "My Library only",
- default library ID is invalid,
- duplicate IDs are invalid,
- inaccessible IDs are forbidden,
- member-only IDs are forbidden,
- already-present media-library entries are idempotent no-ops,
- success is `204 No Content`; authoritative membership is read separately.

## Backend API design

### `GET /libraries/writable-destinations`

Route owner: `python/nexus/api/routes/libraries.py`

Service owner: `python/nexus/services/library_governance.py`

Query parameters:

- `q?: string`
- `cursor?: string`
- `limit?: int`, default 25, min 1, max 50

Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Research",
      "color": "#0ea5e9",
      "created_at": "2026-06-04T00:00:00Z",
      "updated_at": "2026-06-04T00:00:00Z"
    }
  ],
  "page": {
    "next_cursor": "opaque-or-null"
  }
}
```

Behavior:

- returns only non-default libraries where viewer membership role is `admin` or
  viewer is owner,
- excludes default library,
- applies escaped case-insensitive name search when `q` is present,
- uses a deterministic order:
  - exact normalized name match first,
  - prefix match next,
  - substring match next,
  - `updated_at DESC`,
  - `created_at DESC`,
  - `id ASC`,
- encodes cursor as opaque base64url JSON over the deterministic sort fields,
- rejects malformed cursor with `E_INVALID_REQUEST`,
- never falls back to unfiltered `/libraries`.

Implementation detail:

- The route must be registered before `/libraries/{library_id}`.
- The route is transport-only. It validates query parameters, calls one service,
  and returns an envelope.

### `POST /libraries`

Existing route remains the create-library command.

Hardening required:

- frontend create-library client is centralized,
- response is adapted to `LibraryDestination` for picker insertion,
- name trim and length validation remain owned by schema/service boundary,
- created library is non-default and creator has admin membership.

### `POST /media/from_url`

Existing endpoint remains, but its `library_ids` field is redefined as writable
destination IDs.

Required backend behavior:

- validate `library_ids` with the new writable destination helper before media
  creation,
- reject default IDs,
- reject duplicate IDs,
- reject member-only or inaccessible IDs,
- create or reuse media through the existing source owner,
- assign default library plus selected destinations through `library_entries`,
- preserve the `FromUrlResponse` shape.

### `POST /media/{media_id}/libraries`

Existing endpoint remains for post-hoc media membership management outside the
share flow.

Required backend behavior:

- verify viewer can read the media,
- validate writable destination IDs,
- reject default IDs,
- reject duplicate IDs,
- add all destination entries atomically,
- return `204 No Content`.

### Other ingest endpoints

The writable destination contract applies to every endpoint that accepts
`library_ids` for library-entry writes:

- `POST /media/upload/init`
- `POST /media/{id}/ingest`
- `POST /media/capture/article`
- `POST /media/capture/url`
- `POST /media/capture/file` via `x-nexus-library-ids`
- podcast subscription library assignment if it writes library entries

No caller may keep using the old "accessible" validation helper for write
destinations.

## Backend service design

### `library_governance.py`

Add:

- `LibraryDestinationPage` service return type or schema-backed result.
- `list_writable_library_destinations(db, viewer_id, q, cursor, limit)`.
- `resolve_writable_non_default_library_ids(db, viewer_id, library_ids)`.

Remove or stop using for writes:

- `resolve_accessible_non_default_library_ids`.
- `validate_libraries_accessible`.

If a read-only member-library resolver is still needed, it must be renamed to
express membership/read semantics. It must not be called from write paths.

### `library_entries.py`

Refactor writes so there is one atomic add-multiple command:

- `ensure_media_in_libraries_for_viewer(db, viewer_id, media_id, library_ids)`
- `assign_libraries_for_media(db, viewer_id, media_id, library_ids)`

Required properties:

- one transaction around the multi-library operation,
- all destination validation before first insert,
- default-library intrinsic handled once,
- non-default entries inserted through `ensure_entry`,
- closure edges updated through the default-library closure owner,
- no partial apply across selected destinations,
- no nested independent transaction per destination,
- idempotent for already-present entries,
- no response metadata; callers read authoritative membership separately.

Concurrency:

- All concurrent calls must correspond to a valid sequential ordering.
- `ensure_entry` may keep its current library-row lock as the append
  serialization point.
- Do not add extra locks on top of SERIALIZABLE transactions unless the
  isolation boundary requires it and the code includes `justify-concurrency`.

## Frontend architecture

### Canonical library client

Add `apps/web/src/lib/libraries/client.ts`.

Exports:

- `LibraryDestination`
- `LibraryDestinationPage`
- `searchWritableLibraryDestinations(input)`
- `createLibrary(input)`

Rules:

- This module owns `/api/libraries` and
  `/api/libraries/writable-destinations` client calls.
- Components do not call `apiFetch("/api/libraries"...` directly for create or
  destination search.
- Component-local response types for library summaries are deleted.

### Destination picker

Add `apps/web/src/components/LibraryDestinationPicker.tsx`.

Add `apps/web/src/components/LibraryDestinationPicker.module.css`.

Delete after call sites migrate:

- `apps/web/src/components/LibraryMultiSelectPicker.tsx`
- `apps/web/src/components/LibraryMultiSelectPicker.test.tsx`
- `apps/web/src/lib/media/useNonDefaultLibraries.ts`
- `apps/web/src/lib/media/useNonDefaultLibraries.test.tsx`

Component contract:

```ts
interface LibraryDestinationPickerProps {
  selected: readonly LibraryDestinationSelection[];
  onChange(next: readonly LibraryDestinationSelection[]): void;
  presentation:
    | { kind: "Inline" }
    | { kind: "DisclosureContent"; onRequestClose(): void };
  label: string;
  interaction:
    | { kind: "Enabled" }
    | { kind: "Disabled" }
    | { kind: "Creating" };
  onCreateDestination(name: string): Promise<LibraryDestinationSelection>;
}
```

Behavior:

- owns remote search state,
- debounces query,
- aborts stale requests,
- latest response wins,
- keeps selected destinations visible as chips,
- allows removing selected chips,
- exposes create row for valid query,
- calls centralized `createLibrary`,
- inserts and selects created library,
- does not close on create,
- works with zero existing destinations,
- supports empty selection as "My Library only",
- announces loading, no matches, and result counts,
- uses CSS modules, not runtime `<style>` injection.

Accessibility:

- Use a real text input with `role="combobox"`.
- Use `aria-controls` to point at the result listbox.
- Use `aria-activedescendant` for the active row.
- Keep DOM focus on the input while arrowing.
- `Enter` toggles/selects the active result or runs create.
- `Escape` closes a popup or clears query according to the surface state.
- Do not intercept browser-native text editing keys.
- Use a persistent `role="status"` live region for result counts and loading.

Surfaces:

- Share and other always-visible destination steps render the picker inline.
- Explicit Add has one current owner: `AddPanel` renders the same picker inside
  the controlled `LibraryDestinationDisclosure`; it is closed by default and
  never reserves permanent picker height.
- Inline and disclosure content both participate in normal layout instead of
  floating over later controls; Save/Cancel and Add row actions are never
  occluded by an open result list.
- No `PaletteSheet` or second mobile-only picker is introduced in this cutover.

### Share capture

Refactor `apps/web/src/app/share/ShareCapture.tsx`.

Allowed shape:

- `ShareCapture` remains the page-level component.
- A controller hook may own state transitions:
  `useShareCaptureController`.
- A presentational destination step may render the URL preview and picker.
- A result step renders per-URL results.

Required state machine:

- `empty`
- `requiresDestination`
- `saving`
- `results`
- `failed`

Forbidden state:

- a state where URL media has been saved but destinations have not yet been
  confirmed.

Submit behavior:

- Do not call `addMediaFromUrl` during mount for URL shares.
- Call `addMediaFromUrl({ url, libraryIds: selected.map(({ id }) => id) })` only after
  the user taps `Save`.
- Retry failed URLs with the same selected destinations.
- Use `nexus-share://done` only after the user explicitly completes. The final
  state keeps the result card visible and lets the user tap `Done` or `Open`.

### Other library-picking call sites

Migrate these from `LibraryMultiSelectPicker` and `useNonDefaultLibraries` to
`LibraryDestinationPicker`:

- `apps/web/src/components/launcher/AddPanel.tsx` through the controlled
  `LibraryDestinationDisclosure`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/share/ShareCapture.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- podcast subscribe/settings surfaces that select destination libraries

The goal is one destination picker for write destinations. Do not leave a second
client-filtered destination picker for ingest.

### Membership panel

`LibraryMembershipPanel` remains a separate capability because it displays
current membership and add/remove affordances for an existing item. It should not
be collapsed into `LibraryDestinationPicker` in this cutover.

Allowed consolidation:

- share `LibraryColorDot`,
- share canonical library destination/summary types,
- share a row component only if it removes real duplication without mixing
  membership state into destination selection.

## Duplicate and repetitive patterns to remove

### Duplicate library summary types

Current duplication:

- `LibraryMultiSelectPicker.tsx` defines `LibrarySummary`.
- `mediaLibraries.ts` defines another `LibrarySummary`.

Final state:

- one exported type under `apps/web/src/lib/libraries/`.
- components import that type.
- response mapping types stay private to client modules.

### Repeated destination mapping

Current duplication:

- call sites map `{ id, name, color }` from hook rows into picker props.

Final state:

- picker consumes canonical `LibraryDestination` values directly.
- call sites do not remap destination rows.

### Route-local library creation

Current duplication risk:

- `LibrariesPaneBody` manually calls `apiFetch("/api/libraries")`.
- Share would be tempted to add another manual call.

Final state:

- `createLibrary` lives in `apps/web/src/lib/libraries/client.ts`.
- `LibrariesPaneBody` and `LibraryDestinationPicker` both call the shared
  client.

### Client-filtered destination search

Current duplication:

- `LibraryMultiSelectPicker` filters locally.
- `LibraryMembershipPanel` filters locally.
- Command palette has stronger remote/debounced search mechanics.

Final state:

- destination picker uses server-backed search.
- membership panel may keep local filter because it is a loaded current-item
  membership list, not the high-cardinality destination source.
- command palette mechanics are reused by architecture, not by coupling the
  destination picker to command-palette item types.

### Atomic write ownership

Current duplication/problem:

- validation says accessible,
- add path says admin,
- multi-add loops through single-add transactions.

Final state:

- one writable destination resolver,
- one atomic media-to-many-libraries command,
- all write callers use that command.

## File plan

### Docs

Add or update:

- `docs/cutovers/android-share-library-destinations-hard-cutover.md`
- `docs/modules/sharing.md`
- `docs/modules/library.md` if endpoint/capability wording changes

### Backend schemas

Update:

- `python/nexus/schemas/library.py`
- `python/nexus/schemas/media.py`
- podcast schema files if podcast library assignment keeps `library_ids`

### Backend routes

Update:

- `python/nexus/api/routes/libraries.py`
- `python/nexus/api/routes/media.py`
- `python/nexus/api/routes/media_ingest.py`
- `python/nexus/api/routes/podcasts.py` if subscription library selection writes
  destinations

### Frontend API proxy routes

Add:

- `apps/web/src/app/api/libraries/writable-destinations/route.ts`

### Backend services

Update:

- `python/nexus/services/library_governance.py`
- `python/nexus/services/library_entries.py`
- `python/nexus/services/media_ingest.py`
- `python/nexus/services/upload.py`
- `python/nexus/services/media.py`
- `python/nexus/services/epub_lifecycle.py`
- `python/nexus/services/podcasts/subscriptions.py`
- `python/nexus/services/podcasts/ingest.py`
- source ingest services that accept `library_ids`

### Frontend clients and hooks

Add:

- `apps/web/src/lib/libraries/client.ts`
- `apps/web/src/lib/libraries/useLibraryDestinationSearch.ts` if the picker
  controller is not local

Update:

- `apps/web/src/lib/media/ingestionClient.ts`
- `apps/web/src/lib/media/mediaLibraries.ts`
- `apps/web/src/lib/media/useAddMediaToLibraries.ts`
- `apps/web/src/app/share/ShareCapture.tsx`

Delete or replace:

- `apps/web/src/lib/media/useNonDefaultLibraries.ts`
- `apps/web/src/lib/media/useNonDefaultLibraries.test.tsx`

### Frontend components

Add:

- `apps/web/src/components/LibraryDestinationPicker.tsx`
- `apps/web/src/components/LibraryDestinationPicker.module.css`
- `apps/web/src/components/LibraryDestinationPicker.test.tsx`

Update:

- `apps/web/src/components/launcher/AddPanel.tsx`
- `apps/web/src/components/LibraryDestinationDisclosure.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- podcast subscription settings components if they use destination libraries
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`

Delete after migration:

- `apps/web/src/components/LibraryMultiSelectPicker.tsx`
- `apps/web/src/components/LibraryMultiSelectPicker.test.tsx`

### Android

No implementation change expected.

Only update Android tests if the native URL handoff behavior changes. This spec
does not require that.

## Acceptance criteria

### Product behavior

- Sharing a URL to Nexus shows destination selection before any URL media is
  created.
- Cancelling URL share before Save creates no media.
- Creating a library from the share picker creates a non-default library and
  selects it.
- Saving a URL with a newly created library files the media into My Library and
  that library.
- Sharing multiple URLs applies the same selected destinations to each URL.
- Retrying failed URL saves reuses the same selected destinations.
- Non-URL text share still quick-captures to today's daily note and never shows
  library creation.
- A user with 150 writable libraries can search and select a destination beyond
  the first 100.
- Member-only libraries do not appear in destination results.
- Default library does not appear as a selectable destination.

### API behavior

- `GET /libraries/writable-destinations` returns only writable non-default
  libraries.
- `GET /libraries/writable-destinations?q=...` is server-filtered and paged.
- `POST /media/from_url` rejects default library IDs.
- `POST /media/from_url` rejects duplicate library IDs.
- `POST /media/from_url` rejects member-only library IDs.
- `POST /media/{id}/libraries` rejects default, duplicate, inaccessible, and
  member-only IDs.
- Existing media plus existing entry remains idempotent.
- Multi-library add has no partial apply if one selected destination is invalid.

### Architecture

- No Android product API client is added.
- `ShareCapture` no longer calls URL ingest on mount for URL shares.
- `ShareCapture` no longer renders the old post-save `LibraryMultiSelectPicker`
  modal.
- No caller imports `LibraryMultiSelectPicker`.
- No caller imports `useNonDefaultLibraries`.
- No frontend component defines a duplicate `LibrarySummary` type.
- No write path uses `resolve_accessible_non_default_library_ids` or
  `validate_libraries_accessible`.
- Library destination creation/search calls go through
  `apps/web/src/lib/libraries/client.ts`.
- Picker styles live in CSS modules, not runtime `<style>` injection.

## Test plan

### Backend

Add or update:

- `python/tests/test_libraries.py`
  - writable destination list excludes default,
  - writable destination list excludes member-only libraries,
  - search finds libraries beyond 100,
  - cursor pagination is stable,
  - malformed cursor returns `E_INVALID_REQUEST`.
- `python/tests/test_media.py`
  - `/media/from_url` saves directly into selected writable destinations,
  - default ID rejected,
  - duplicate ID rejected,
  - member-only ID rejected,
  - reused URL add remains idempotent.
- `python/tests/test_media_libraries_endpoint.py`
  - atomic no-partial behavior,
  - `204` plus authoritative membership under already-present entries,
  - invalid target prevents all inserts.
- podcast tests if podcast library assignment uses the writable destination
  resolver.

### Frontend unit and browser tests

Add or update:

- `LibraryDestinationPicker.test.tsx`
  - server search loads results,
  - stale responses are ignored,
  - selected chip remains visible when query filters it out,
  - create row appears for valid unmatched query,
  - create calls shared client and auto-selects the result,
  - keyboard arrow/enter works with `aria-activedescendant`,
  - loading and result counts are announced.
- `ShareCapture.test.tsx`
  - URL share does not ingest on mount,
  - Cancel before Save does not ingest,
  - Save sends selected `library_ids` in `/media/from-url`,
  - create destination then Save sends created ID,
  - multi-URL share sends same selected IDs to every URL,
  - non-URL share still quick-captures to daily note,
  - old post-save add-libraries modal is absent.
- `components/launcher/AddPanel.test.tsx` and
  `components/LibraryDestinationDisclosure.test.tsx`
  - destination picker uses server-backed destinations,
  - selected destination IDs are submitted unchanged.

### E2E

Update `e2e/tests/share.spec.ts`:

- authenticated URL share can create a library before Save,
- the saved media appears in the created library,
- cancelling before Save creates no media,
- unauthenticated share still shows sign-in-required card.

Update `e2e/tests/libraries.spec.ts` only if the library create form is moved to
the shared client in a way that affects visible behavior.

### Android

No new required test if native `ShareActivity` stays unchanged.

Optional instrumentation hardening:

- assert non-empty `ACTION_SEND` loads the exact `/share?text=...` owned-origin
  URL,
- assert `nexus-share://done` finishes `ShareActivity`,
- assert `nexus-share://open?path=/media/...` hands off to `MainActivity`.

## Verification commands

Targeted local checks after implementation:

```bash
cd apps/web
./node_modules/.bin/eslint src/app/share src/app/api/libraries/writable-destinations src/components/LibraryDestinationPicker.tsx src/components/LibraryDestinationPicker.test.tsx src/components/LibraryDestinationDisclosure.tsx src/components/LibraryDestinationDisclosure.test.tsx src/components/launcher/AddPanel.tsx src/components/launcher/AddPanel.test.tsx src/lib/libraries src/lib/media src/app/'(authenticated)'/browse/BrowsePaneBody.tsx src/app/'(authenticated)'/podcasts/PodcastsPaneBody.tsx src/app/'(authenticated)'/podcasts/'[podcastId]'/PodcastDetailPaneBody.tsx src/app/'(authenticated)'/podcasts/'[podcastId]'/PodcastDetailPaneBody.test.tsx src/lib/androidShell.podcastDetailPaneBody.test.tsx
bun run lint:css-tokens
bun run typecheck
bun run test:unit -- src/lib/libraries/client.test.ts
bun run test:browser -- src/components/LibraryDestinationPicker.test.tsx src/components/LibraryDestinationDisclosure.test.tsx src/components/launcher/AddPanel.test.tsx src/app/share/ShareCapture.test.tsx src/app/'(authenticated)'/podcasts/'[podcastId]'/PodcastDetailPaneBody.test.tsx src/lib/androidShell.podcastDetailPaneBody.test.tsx
```

Backend:

```bash
./scripts/with_test_services.sh sh -c 'make _test-back-db-ready && cd python && NEXUS_ENV=test uv run pytest -q tests/test_libraries.py tests/test_media.py tests/test_media_libraries_endpoint.py tests/test_podcasts.py -k "WritableLibraryDestinations or FromUrlLibraryIds or PostMediaLibrariesEndpoint or SubscribeWithLibraryIds"'
```

E2E:

```bash
PLAYWRIGHT_ARGS=tests/share.spec.ts make test-e2e
```

Android, only if native share code changes:

```bash
make verify-android
make test-android
```

## Implementation sequence

1. Backend writable destination contract
   - Add schema and route for `GET /libraries/writable-destinations`.
   - Add `list_writable_library_destinations`.
   - Add `resolve_writable_non_default_library_ids`.
   - Add backend tests for list/search/pagination/permissions.

2. Backend write hardening
   - Replace write-path accessible validation with writable validation.
   - Reject default IDs and duplicates.
   - Make add-media-to-many-libraries atomic.
   - Update media ingest/upload/capture/podcast write callers.
   - Update tests that expected silent default/duplicate dedupe.

3. Frontend library client
   - Add `apps/web/src/lib/libraries/client.ts`.
   - Move create-library client usage out of `LibrariesPaneBody`.
   - Add tests for client URL shapes if needed.

4. Destination picker
   - Build `LibraryDestinationPicker`.
   - Use combobox/listbox semantics from command palette.
   - Use CSS module styling.
   - Add picker tests.

5. Share hard cutover
   - Refactor `ShareCapture` to destination-first state machine.
   - Delete post-save library modal.
   - Ensure URL ingest happens only after Save.
   - Add share tests.

6. Migrate other destination-picker call sites
   - `AddPanel` through `LibraryDestinationDisclosure`.
   - `BrowsePaneBody`.
   - `PodcastsPaneBody`.
   - `PodcastDetailPaneBody`.
   - Delete `LibraryMultiSelectPicker` and `useNonDefaultLibraries`.

7. Docs and E2E
   - Fill `docs/modules/sharing.md`.
   - Update library docs if endpoint names changed.
   - Add `/share` E2E create-and-save case.
   - Run targeted checks.

## Final-state invariants

- Library destinations are searched by one backend capability.
- Library destinations are selected through one frontend picker capability.
- Library creation is called through one frontend library client.
- Android remains a shell.
- URL share is destination-first.
- Old post-save destination assignment from `/share` does not exist.
- Write destination validation means writable, not merely accessible.
- Multi-destination media attachment is atomic.
- Default library is implicit and never selectable.
- The codebase has no duplicate `LibrarySummary` type for this capability.

# Inbound Capture Sharing

This module owns content received from Android or the `/share` web surface.
Resource access grants and anonymous public reading are separately owned by
[resource-sharing.md](resource-sharing.md).

## Owner Boundaries

- **Android shell** (`apps/android/.../ShareActivity.kt`) receives
  `ACTION_SEND` text, trims it, exits on empty native shares, loads
  `/share?text=...`, and consumes only the documented `nexus-share://open`,
  `nexus-share://done`, and `nexus-share://dismiss` callbacks. It does not call
  product APIs, manage Supabase sessions, search libraries, create libraries, or
  ingest media.
- **Web share surface** (`apps/web/src/app/share/*`) owns the compact capture
  card. It renders outside the authenticated app shell, shows an empty-state card
  for browser empty shares, blocks URL ingest until the user taps Save, and sends
  selected destination IDs plus a stable per-URL attempt `id` in the first
  ingest request.
- **Library destination UI** (`DestinationField`: a trigger and summary in
  flow, opening `DestinationChooser` in the shared `ChooserSurface`, a desktop
  anchored popover or the phone `MobileSheet`). The chooser searches
  `GET /libraries/destinations` (exact → prefix → contains → name, paged), one
  abortable read at a time, keeps the chosen libraries on top, and creates a
  library with a client-minted id that a retry resends.
- **Backend ingest owners** validate `library_ids` through
  `libraries.resolve_writable_destinations` before work starts,
  then write default plus selected destinations through `library_entries`. Source
  owners attach destinations inside their creation transaction whenever they
  create new media; upload confirm (local uploads and extension captures alike)
  revalidates its destinations at publication and attaches them in the same
  transaction as the receipt, for new and reused media, only after the candidate
  bytes verified.

## Android Share Flow

Native Android finishes immediately for empty shared text. Browser
`/share?text=` renders the empty-state card.

For URL shares, `/share` renders a destination picker before ingest. The user can
search existing writable libraries or create a new one inline. Save calls
`addMediaFromUrl({ url, libraryIds, id })`; Cancel performs no
ingest. Multi-URL shares use the same selected destination set for each URL and
retry failed URLs only. Retrying a URL resends its original attempt `id`, which
answers the acceptance that already landed instead of duplicating it.

For non-URL text, `/share` first reads `/me`, exact-decodes the account calendar
timezone, freezes one account-local date with the capture identities, and sends
the text through the dated daily-capture command. Retry keeps that date even
after midnight. Profile failure sends no capture. The flow does not show a
library picker because libraries are media/podcast containers.

## Destination Contract

`library_ids` on share/media ingest requests means selected non-default
libraries where the viewer can write. Default library IDs, duplicate IDs,
member-only libraries, and inaccessible libraries are invalid.

The selected destination set is additive and idempotent:

- every successful capture is in the user's default library,
- selected destinations are added in request order after validation,
- existing entries are not duplicated,
- canonical URL/provider media dedupe applies selected destinations to the
  returned winner media ID,
- failed confirm-time upload validation does not attach confirm-time
  destinations.
- failed post-acceptance source acquisition or extraction remains attached to
  the accepted media/source-attempt row and is retried through the media retry
  API.

## Non-Goals

- No Android `ACTION_SEND_MULTIPLE` or `EXTRA_STREAM` intake.
- No native Android product API client.
- No library picker for non-URL note shares.
- No compatibility lane for the old post-save add-to-libraries modal.

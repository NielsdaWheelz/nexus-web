# Sharing

Sharing covers inbound capture surfaces, not library membership management.
The Android share sheet, `/share`, and media ingest services compose to save a
shared item into the user's default library plus selected writable destination
libraries.

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
  selected destination IDs plus a stable per-URL `Idempotency-Key` in the first
  ingest request.
- **Library destination UI** (`LibraryDestinationPicker`) searches
  `GET /libraries/writable-destinations` and creates libraries through the shared
  `lib/libraries/client.ts` client. It is a multi-select combobox/listbox and
  keeps create-in-flight state observable so parents cannot submit before a new
  destination has been selected.
- **Backend ingest owners** validate `library_ids` through
  `library_governance.validate_writable_library_destinations` before work starts,
  then write default plus selected destinations through `library_entries`. Source
  owners attach destinations inside their creation transaction whenever they
  create new media; upload confirm attaches confirm-time destinations only after
  successful staged-file validation.

## Android Share Flow

Native Android finishes immediately for empty shared text. Browser
`/share?text=` renders the empty-state card.

For URL shares, `/share` renders a destination picker before ingest. The user can
search existing writable libraries or create a new one inline. Save calls
`addMediaFromUrl({ url, libraryIds, idempotencyKey })`; Cancel performs no
ingest. Multi-URL shares use the same selected destination set for each URL and
retry failed URLs only. Retrying a URL reuses its original idempotency key so an
already accepted source attempt is not duplicated.

For non-URL text, `/share` quick-captures the text to today's daily note and does
not show a library picker because libraries are media/podcast containers.

## Invitation Acceptance And The Default List

`library_invitations.accept_library_invite` is one transaction: membership
upsert, then invite status update. The response is
`{invite, membership, idempotent}`; accepting an already-accepted invite
returns the same shape with `idempotent: true` and mutates nothing. There is
no follow-up backfill job or projection step — the membership commit alone is
what the accepting user's default library's list/count reflects on their
very next read, because that list is a live query over current memberships,
not a materialized or catch-up-able set (see [library.md](library.md)).

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

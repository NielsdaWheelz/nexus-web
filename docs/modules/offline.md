# offline (android)

owner of: episode audio and document reading copies kept on an android 14+
phone, the packaged Downloads screen (the *shelf*) that lists and reads them,
and carrying reading positions taken offline back to nexus.

## the idea

offline is one thing on one device: a **download list** of items (episode
audio or a reading copy), each fetched by **one user-initiated data-transfer
job** into **one directory**, recorded in **one json state file**, exposed to
web code through **one bridge** (`window.nexusDownloads`), and shown in **one
screen**, the shelf. the shelf is the Downloads screen whether or not there is
a network. the hosted app only enqueues, reflects item state in its resource
menus, opens the shelf and purges on sign-out. a reading copy is a zip of the
**reader document** the signed-in reader reads (`GET /media/{id}/reader`), so
the shelf renders it with the same reader (`lib/documentReader`). the server
owns one route and one optional field.

## parts

| part | where | does |
|---|---|---|
| store | `apps/android/.../offline/OfflineStore.kt` | `files/offline/state.json` + `files/offline/items/{mediaId}/`; items, positions, leases, account binding, wipe |
| jobs | `offline/OfflineJobService.kt`, `Transfers.kt`, `PositionSync.kt` | one UIDT transfer job (both kinds, network per policy) and one persisted sync job |
| bridge | `offline/OfflineBridge.kt` ⇄ `apps/web/src/lib/offline/bridge.ts` | `window.nexusDownloads` on the hosted and shelf origins |
| router | `offline/ShelfRouter.kt` | serves `https://appassets.androidplatform.net/shelf/**`; 404s every other subresource while the shelf is the main document |
| shelf | `apps/web/src/shelf/` (`Shelf.tsx`, `ShelfReader.tsx`) | the Downloads screen and the shared reader core over a copy; built by `bun run build:shelf` into the git-ignored `assets/shelf` |
| hosted | `lib/actions/resourceActionMenu.tsx` (`Download`), `components/appnav/AccountMenu.tsx` | menu commands, *Downloads* entry, purge before sign-out |
| server | `python/nexus/services/reading_copy.py`, `GET /stream/media/{id}/reading-copy`, `PUT /media/{id}/reader-state` + `expected_reader_generation` | builds copies; fences offline position writes |

the player plays a ready episode from its file: `NexusPlaybackService` takes a
lease (`store.open`) and plays `file://`, else streams.

## flows

- **download.** a `Download{mediaKind, title, audioUrl}` capability (episodes
  with an https enclosure; pdf/epub/web article when ready for reading) →
  `enqueue`. the store refuses with `Storage` below 512 MiB free or
  `Unsupported` for a url OkHttp cannot parse as https (a hud); otherwise the
  item is `Queued` and the transfer job drains the queue. audio streams the
  enclosure into `staging/{id}/audio`, retrying a retryable failure three times
  on the job's backoff, then failing (a waiting item never holds back the items
  queued behind it); it is sniffed as mp3/m4a. a partial outlives every failure
  but a bad sniff and resumes only as the same representation: `Range` with
  `If-Range` set to the first answer's strong ETag, appending only a 206 for
  exactly the rest of the recorded length; anything else restarts from zero,
  and a server without a strong ETag always restarts. a reading copy checks
  `GET /api/me` against the bound account, mints `POST /api/stream-token`,
  fetches `{stream_base_url}/stream/media/{id}/reading-copy` with the bearer,
  unzips into staging (zip-slip guard, CRC, drained length), reads
  `GET /api/media/{id}/reader-state` as its baseline, and publishes by rename.
- **read offline.** cold start without a validated network, the "could not
  connect" terminal and the account menu's *Downloads* all load the shelf.
  *Open* takes a lease; `ShelfReader` reads `/shelf/copies/{id}/reader.json`
  (pdf: `document.pdf`, ranged), rewrites epub `/api/media/{id}/assets/`
  to `/shelf/copies/{id}/assets/` and mounts the whole document in the shared
  reader with contents and the overview rail. web articles are text-only. a
  copy that does not open (incomplete, or made before the reader-document
  format) says so and offers *Remove downloaded copy*; download it again.
- **positions.** every reader save is fsynced before its reply and schedules
  the sync job (10 s; 0 s on hello, on resume and when the user leaves the
  app). a pass checks `me()`, then for
  each pending position `PUT reader-state {locator, base_revision,
  expected_reader_generation}`: 200 syncs it; `E_READER_STATE_CONFLICT` reads
  the canonical cursor and either agrees (equal locators) or becomes
  `Conflict`, resolved only by the user; `E_READER_CONTENT_CHANGED` keeps the
  copy and position on the device; 404 is retried later; 401/403 sets
  `authRequired` (for the account the pass started with) and stops. a pass
  also refreshes the baseline of every synced ready copy that is not open, so
  reading the same document online never yields a false conflict, while an
  open copy keeps the revision its reader started from (its next save still
  meets a remote move as a conflict).
- **identity.** `hello {accountId}` from the hosted page binds the store; a
  different account wipes everything first. *Sign Out* is `purge`, then the
  normal `POST /auth/signout`. without the bridge (desktop, android < 14) the
  download action is disabled *Not supported on this device*, there is no
  *Downloads* entry, and sign-out is the plain web post.

## contracts

**bridge** `window.nexusDownloads` (both origins, main frame, json string
frames). request `{id, op, ...args}`; reply `{id, ok: true, ...}` or
`{id, ok: false, error}`; push `{snapshot}` to the document that last said
hello, always before the reply to the op that caused it (download progress
throttled to 500 ms). ops: `hello {accountId?}` → `{snapshot}`; `enqueue
{mediaId, kind, title, url?}` (`Storage`, `Unsupported`); `cancel`, `retry`,
`remove`, `open`, `close {mediaId}` (`NotFound`); `save {mediaId, locator}`
after fsync; `resolve {mediaId, choice: Canonical|Device}`; `policy {value}`;
`showDownloads`; `openHosted {path}`; `purge`. a malformed frame is `Invalid`.
there is no version: the object name is the identity, and an incompatible
change renames it.

`Snapshot = {policy: UnmeteredOnly|AnyConnected, authRequired, consumptionRevision, items}`, items
in enqueue order: `{mediaId, kind, title, state: Queued|Downloading|Ready|
Failed|Removing, failure, attempts, received, total, sizeBytes, savedAt,
progress}`. `progress` is set only on a ready reading copy: `Canonical
{snapshot}`, `Pending|ContentChanged|SourceUnavailable {baseline, device}` or
`Conflict {canonical, device}`.

`consumptionRevision` advances after accepted canonical saves, including an
equal-locator save whose cursor revision is unchanged. Pending storage alone
does not advance it. A newer equal canonical cursor retires old pending data
without resuming unread; genuine equal-position activity at the matching base
still sends a real save. The reader adopts `Pending → Canonical` even when the
revision is unchanged.

**reading copy** `GET /stream/media/{id}/reading-copy`, `Authorization: Bearer
<stream token>` → 200 `application/zip` with `Content-Length`,
`Nexus-Reader-Generation`, `Cache-Control: private, no-store`; 401
`E_STREAM_TOKEN_INVALID|EXPIRED`, 404 `E_MEDIA_NOT_FOUND`, 409
`E_MEDIA_NOT_READY|E_READER_CONTENT_CHANGED`. members: `reader.json` =
`{media: {id, title, kind}, document: ReaderDocumentOut}`, the document as
`GET /media/{id}/reader` builds it except that a pdf's `file.url` is the member
`document.pdf` and web article images are text placeholders; plus
`document.pdf` or `assets/{asset_key}`. the build reads one repeatable-read snapshot, releases
it, then streams objects; a vanished object is `E_READER_CONTENT_CHANGED`.

**position fence** `PUT /media/{id}/reader-state` accepts an optional
`expected_reader_generation`; when present the publication generation must
equal it, else 409 `E_READER_CONTENT_CHANGED`.

## states and copy

- item: absent → Queued (enqueue) → Downloading (job) → Ready (publish) |
  Queued (retryable failure, system stop, process death) | Failed(reason);
  Queued/Downloading → absent (cancel); Failed → Queued (retry); Ready/Failed →
  absent, or Removing while leased (remove); Removing → absent (last close).
- position (ready reading copies): synced → Pending (save); Pending and
  SourceUnavailable → synced | Conflict | ContentChanged | SourceUnavailable
  (sync); Conflict → Conflict with the new device position (save: reading on
  while the choice waits) | synced (Canonical) | Pending (Device).
- shelf copy: *Download queued · waits for Wi-Fi · another download is
  active*, *Retrying after interruption*, *x of y*, *Downloaded · size · saved
  date* with *Position synced / saved on this device / needs your choice / A
  newer source version exists… / kept locally · source unavailable*, *Download
  failed · sign in required / source unavailable / source changed · retry /
  not enough storage / network interrupted / server unavailable / not a
  playable file / stopped by Android*, *Removes when playback stops* (episode)
  or *Removes when closed* (copy).

## invariants

- I1 nothing of a previous account is listed, opened, played or synced:
  binding wipes first (by rename, swept at start), and `me()` precedes all
  authenticated remote work.
- I3, I5 `Ready` only after a complete, sniffed or CRC-checked body; staging is
  renamed into place and deleted at start.
- I4, I7 a file in use is leased; remove defers to `Removing`; a page start
  closes its document's leases. purge and account switch do not wait.
- I8 the shelf makes no network request: CSP `default-src 'none'` (`img-src
  'self' data:`), the router's 404, and gated navigations.
- I9, I10 offline positions write against their generation and base revision;
  conflicts are the user's.
- there is no in-place redownload: a changed source keeps its copy and position
  until the user removes it (confirmed when the position is unsynced).

## not here

integrity beyond TLS, `Content-Length`, zip CRC and the audio sniff; a manifest
or digest; schema versions; server attestation; sign-out from the shelf;
offline images for web articles; android < 14. release order and skew:
[offline-cutover-release-steps](../tickets/offline-cutover-release-steps.md).

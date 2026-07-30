# Android Episode Offline Downloads — Hard Cutover

**Status:** IMPLEMENTED LOCALLY · physical-device acceptance pending · 2026-07-30
**Type:** Hard cutover; one managed-download path, no compatibility path.

## Decision

Ship Android-only **Download for offline** for eligible podcast episodes.

- App-private, device-local, manual, pinned until removed.
- Android Media3 owns transfers, manifest, bytes, recovery, and local serving.
- The final web player from
  [`global-player-surfaces-hard-cutover.md`](global-player-surfaces-hard-cutover.md)
  remains the sole player and lands first.
- Episode menus own Download/Cancel/Retry/Remove. Rows show state. Account owns
  one compact Downloads inventory.
- The server owns identity, visibility, and the current stable enclosure URL.
  It never owns device availability.

This is a managed-download foundation, not complete offline app mode:

- completed bytes and inventory survive process death, update, and reboot;
- interrupted work resumes when Nexus next opens in the foreground;
- playback works offline only while the authenticated web shell is loaded;
- cold-launch airplane mode and automatic boot/background restart are non-goals.

Assumptions:

- public HTTPS progressive MP3/M4A only;
- one active transfer; later requests queue;
- one app-wide network policy, default `UnmeteredOnly`;
- incomplete representations restart from byte zero; partial resume is excluded.

## Goals

1. One command creates one durable, observable, idempotent device operation.
2. `Ready` means complete local bytes seek without network.
3. Manual downloads never disappear through cache eviction.
4. No unapproved transfer continues on a metered network after restart.
5. Local availability remains independent of subscription, Library, Lectern,
   listening progress, transcript state, and source freshness.
6. Reuse current owners; add only the missing native capability.

## Scope

Build:

- Download, Cancel, Retry, Remove;
- persistent row state and a Downloads inventory;
- Media3 transfer/cache ownership and foreground notification;
- reload/process-death/update/reboot persistence and next-foreground recovery;
- strict origin-bound web/native commands and pushed state;
- one lazy authenticated download-spec read;
- complete-file playback through the existing web player;
- one global mobile-data decision, a 512 MiB free-space reserve, account
  isolation, and explicit removal.

Non-goals:

- automatic restart at boot or from a killed/background process;
- Files export/share, SD card, public storage, storage chooser;
- iOS, browser/PWA downloads, service workers, Background Fetch, Capacitor;
- native player/`MediaSessionService`, cold-launch offline, background playback,
  durable offline listening progress;
- auto/bulk/show downloads, auto-delete, quotas, recommendations, cross-device
  commands;
- HLS, DRM, private/authenticated/expiring feeds, transcoding, quality choice;
- validator-aware partial resume;
- offline transcripts/chapters/notes/queue or a local Nexus replica;
- server audio archive, download table, migration, `is_downloaded`;
- general download settings beyond the single mobile-data policy.

## Target Behavior

| State | Row | Menu |
|---|---|---|
| `Absent` | — | **Download for offline** |
| `Resolving` | `Preparing download…` | **Cancel download** |
| `Queued.Capacity` | `Download queued` | **Cancel download** |
| `Queued.WaitingForNetwork` | `Waiting for network` | **Cancel download** |
| `Queued.WaitingForUnmetered` | `Waiting for Wi-Fi` | **Cancel download** |
| `Queued.SystemLimit` | `Download paused by Android` | **Cancel download** |
| `Downloading` | `Downloading · 47%` or bytes | **Cancel download** |
| `Restarting` | `Restarting download…` | **Cancel download** |
| `Ready` | downloaded indicator | **Remove download** |
| `Failed` | `Download failed` | **Retry download**, **Remove download** |
| `Removing` | `Removing download…` | disabled **Remove download** |

Rules:

- Action group: `operations`, after **Open source**, before server processing.
- Exact ids:
  `ResourceOperation.Media.DownloadOffline`,
  `.CancelOfflineDownload`, `.RetryOfflineDownload`, `.RemoveOfflineDownload`.
- A dedicated server projection `offline_download_eligible`, not
  `audio_playable`, gates Download.
- Download publishes `Resolving` immediately. Cancel aborts its fetch and fences
  stale completion.
- A resolving API/decode failure returns to `Absent` with feedback.
- Every busy catalog entry provides `busyLabel` or `disabledReason`.
- Announce milestone states through one polite status region, never percentages.
- Text plus icon conveys state; color is never the sole signal.

Row precedence:

1. active download operation or `Failed`;
2. existing exceptional processing state;
3. existing listening activity.

`Ready` is a separate accessible indicator and never hides listening progress.

### Network Policy

```text
NetworkPolicy = UnmeteredOnly | AnyConnected
```

- Persist one app-wide policy; default `UnmeteredOnly`.
- Apply it to Media3 `DownloadManager.setRequirements` before resuming work on
  every process construction.
- After source preflight succeeds, Enqueue durably inserts a stopped Media3
  request before replying `Accepted`. On a metered network under
  `UnmeteredOnly`, it becomes `Queued.WaitingForUnmetered`.
- The Downloads surface may ask once whether to enable **Download over mobile
  data**. Approval changes the global policy and releases every pending item.
- No per-request consent bit, app-owned connectivity scheduler, stop-reason
  scheduler, or per-download network policy exists.

### Downloads Inventory

- Account shows **Downloads** only after native handshake.
- Reuse `Dialog` and stay-mounted `MobileSheet`.
- Include browser-local `Resolving` plus every non-absent native item.
- Order active first, then latest updated.
- Show title, state, transferred/total size when known, total completed bytes,
  and all applicable actions.
- Title activates the existing `/media/{mediaId}` target; add no route/pane.
- Empty: **No downloaded episodes.**
- No Remove All, search, filtering, or custom sorting.

### Playback, Freshness, and Removal

- The final player resolves local versus remote exactly once while executing
  `StartSession`; capture that URL in the session epoch.
- Never recompute or switch an active source when download state changes.
- `Ready` resolves to `<owned-origin>/_native/offline-media/{mediaId}`. Native
  resolves the key only within the currently connected account.
- The native route supports GET and one byte range: `200`, `206`, `416`.
- Missing/incomplete local bytes mark the indexed item repair-required and
  project durable generic `Failed`; that activation never falls back remotely.
- `OfflineMediaStore` owns read leases. Remove hides the item, defers byte
  deletion until open response streams close, then completes.
- Cancel deletes partial bytes. Failed offers Remove so partials cannot leak.
- `Ready` is an immutable snapshot. Remote source changes do not refresh or
  switch it; Remove then Download obtains current bytes.
- A later canonical `404` does not silently delete manual bytes. The existing
  route remains unavailable; the native inventory item remains removable and
  cannot initiate playback from the missing page.

## Final Architecture

```text
episode menu / Account Downloads
  -> OfflineMediaProvider
       -> stable OfflineMediaController
       -> keyed OfflineMediaClientStore subscriptions
       -> GET /api/media/{mediaId}/offline-download-spec
       -> exact nexusOfflineMedia transport
            -> Android OfflineMediaStore
                 -> Media3 DownloadManager + DownloadIndex
                 -> SimpleCache(filesDir, NoOpCacheEvictor)
                 -> SafeProgressiveDownloaderFactory
                 -> OfflineMediaDownloadService
                 -> pushed state

PlayerCommandsCapability.playAudio
  -> StartSession execution
       -> OfflineMediaController.resolveStreamUrl
            -> canonical remote URL | captured owned-origin local URL
                 -> WebViewClient -> OfflineMediaStore.openRange
```

| Concern | Sole owner |
|---|---|
| Identity, visibility, static eligibility, stable source | media service |
| Action copy/order | `RESOURCE_ACTION_CATALOG` |
| Browser command lifecycle | `OfflineMediaController` |
| Browser snapshots/subscriptions | `OfflineMediaClientStore` |
| Row projection/precedence | episode presenter + `CollectionRow` |
| Transfer/index/cache/recovery/network policy | `OfflineMediaStore` |
| Request safety, zero-resume, storage guard | `SafeProgressiveDownloaderFactory` |
| User-started background transfer | `OfflineMediaDownloadService` |
| Local range response/read leases | Android offline-media capability/store |
| Source selection/playback | final `globalPlayer.tsx` runtime |
| Overlay/focus/Back | existing `Dialog` / `MobileSheet` |

`RenderEnvironment.androidShell` is only a hint. Successful handshake is the
capability truth.

## Backend API

```text
GET /media/{media_id}/offline-download-spec
GET /api/media/{media_id}/offline-download-spec

OfflineDownloadSpec = {
  kind: "ProgressiveAudio",
  mediaId: MediaId,
  title: string,
  sourceUrl: string
}
```

- Strict camelCase; `extra="forbid"`; private/no-store.
- `title` is 1..512 Unicode code points and `sourceUrl` is 1..8192 Unicode code
  points in Python, TypeScript, and Kotlin.
- Add one `derive_offline_download_source` owner. It accepts only a podcast
  episode's non-empty `external_playback_url`; never fall back to
  `canonical_source_url`.
- `sourceUrl` is the stable enclosure/redirector URL, not a post-redirect CDN
  URL.
- Derive compact `offline_download_eligible` through the same static URL
  policy: HTTPS, credential-free, fragment-free.
- `404` for missing/invisible.
- `409 E_OFFLINE_MEDIA_UNAVAILABLE` for wrong kind or missing enclosure.
- `422 E_OFFLINE_MEDIA_UNSUPPORTED_SOURCE` for invalid static source.
- Register both codes and statuses in `python/nexus/errors.py`.
- No headers, cookies, final redirect, filename, local state, token, source URL
  on compact episode DTOs, table, or migration.
- Do not reuse `CapabilitiesOut.can_download_file`; it remains PDF/EPUB
  server-file capability.

## Browser Capability

Mount one `OfflineMediaProvider` above Account, episode rows, and the final
player. Its context publishes stable references, never an items map:

```text
Unavailable |
Connecting |
Ready {
  controller: OfflineMediaController,
  store: OfflineMediaClientStore
}

OfflineMediaController = {
  enqueue(mediaId), cancel(mediaId), retry(mediaId), remove(mediaId),
  setNetworkPolicy(policy), openDownloads(),
  resolveStreamUrl(mediaId, remoteUrl)
}

OfflineMediaClientStore = {
  getItem(mediaId), subscribeItem(mediaId, listener),
  getInventory(), subscribeInventory(listener),
  getNetworkPolicy(), subscribeNetworkPolicy(listener)
}
```

- Implement selectors with `useSyncExternalStore`.
- A row subscribes only to its `mediaId`; the overlay subscribes to inventory.
- Only `enqueue` fetches/strict-decodes `OfflineDownloadSpec`.
- Bound that single attempt with
  `OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS = 35_000`; do not retry it.
- `OfflineMediaTransport` is an injected interface; production wraps WebKit
  messages and tests use a fake.
- Provider owns request correlation, abort/generation fences, strict feedback,
  account-session fencing, and snapshot installation.
- Pass the verified `verifySession().userId` through
  `AuthenticatedLayout -> WorkspaceBootstrapGate -> AuthenticatedShell`.

```text
LocalAvailability =
  Resolving |
  Queued {
    reason: Capacity | WaitingForNetwork | WaitingForUnmetered | SystemLimit
  } |
  Downloading { bytesDownloaded, totalBytes: Presence<bytes> } |
  Restarting |
  Ready { sizeBytes, contentType, updatedAt } |
  Failed { code: DownloadFailed } |
  Removing
```

Absence is `Presence<LocalAvailability>.Absent`. `Resolving` is browser-local;
all other states are native. Match every state exhaustively.

## Web/Native Protocol

Install one AndroidX WebKit listener: `nexusOfflineMedia`.

- Exact `BuildConfig.NEXUS_BASE_URL` origin; main frame; verify `sourceOrigin`.
- Strict JSON, exact keys/bounds, canonical UUIDs.
- Exact `protocolVersion: 1`; reject mismatch. This is a schema discriminator,
  not negotiation or compatibility.
- UUID `requestId`; replies echo it.
- Push events. `GetSnapshot` only on connect and visibility return; never poll.

```text
Commands =
  Connect { requestId, protocolVersion, accountId } |
  GetSnapshot { requestId, protocolVersion } |
  Enqueue { requestId, protocolVersion, spec } |
  Cancel { requestId, protocolVersion, mediaId } |
  Retry { requestId, protocolVersion, mediaId } |
  Remove { requestId, protocolVersion, mediaId } |
  SetNetworkPolicy { requestId, protocolVersion, policy }

Reply = {
  requestId,
  protocolVersion,
  outcome:
    Connected { items, networkPolicy } |
    Snapshot { items, networkPolicy } |
    Accepted |
    Rejected {
      code:
        InvalidRequest | AccountMismatch | NetworkUnavailable |
        SourceForbidden | SourceMissing | SourceUnavailable |
        UnsupportedAudio | StorageInsufficient
    }
}

Event =
  { protocolVersion, kind: "StateChanged", mediaId,
    state: Presence<NativeLocalAvailability> } |
  { protocolVersion, kind: "NetworkPolicyChanged", policy }
```

A rejection creates no durable item. Runtime transfer failure is the one
durable `DownloadFailed` product state; detailed causes belong in diagnostics.

No `addJavascriptInterface`, generic fetch, arbitrary headers/path/filesystem,
script evaluation, or native product API client. Keep file/content access,
mixed content, cleartext, and third-party cookies disabled.

Residual trust assumption: the exact owned-origin web application supplies the
`mediaId`/`sourceUrl` binding. Native validates origin, account, syntax, size,
and public-network policy but cannot independently prove the server binding
without the intentionally excluded native API client.

## Native Contract

- Pin every Media3 artifact to `1.10.1`. Compile against Android SDK 36, its
  minimum supported compile SDK; retain target SDK 35 behavior.
- Structured key: `(ownedOrigin, accountId, mediaId)`. Derive one stable request
  id and use it as Media3 id plus `customCacheKey`.
- One app-scoped `SimpleCache` below `filesDir`; never `cacheDir`; one
  `DownloadManager`; `maxParallelDownloads = 1`.
- Media3 `DownloadIndex` is the sole durable item manifest. No Room or mirrored
  item registry.
- Persist only the app-wide network policy beside the manifest; it is
  configuration, not per-item lifecycle state.
- Map Media3 `STATE_RESTARTING` explicitly to `Restarting`; unknown Media3
  states/stop reasons defect.
- Media3 failure reason projects to generic `DownloadFailed`. A broken
  completed entry uses one app-defined repair-required stop reason in the same
  index and projects to the same state.
- Reuse `DownloadService.getForegroundNotification`'s Media3-owned cadence to
  publish changed progress; no second sampler.

```text
DownloadRequest.data = OfflineMediaMetadata {
  schemaVersion: 1,
  accountId: UUID,
  mediaId: MediaId,
  title: string,
  contentType: string,
  contentLength: Presence<bytes>
}
```

- `DownloadRequest.uri` is the stable vetted enclosure/redirector URL, never the
  post-redirect final URL.
- Before enqueue, perform one `Range: bytes=0-0` preflight with
  `OFFLINE_PREFLIGHT_DEADLINE_MS = 30_000` through the owned public-HTTPS
  OkHttp data source. Validate status and MIME and determine length when
  available; do not issue HEAD.
- Re-run redirect policy on every attempt. Reject credentials, non-HTTPS,
  IP literals, non-global DNS, redirect loops, and more than five redirects.
- Log structured request/media ids, sanitized host, response status, redirect
  count, byte counts, and error class. Never log credentials, full URLs, or
  paths/queries.
- `SafeProgressiveDownloaderFactory` deletes every incomplete cache resource
  before a new attempt. Failed/interrupted work never resumes cached spans.
- `Ready` requires Media3 completion, complete cache coverage, and an MP3/M4A
  container signature read from the completed cache. Verification is an
  internal transition, not a visible state.
- Before enqueue, require known remaining bytes plus the 512 MiB reserve when
  length is known. An owned sink guard checks allocatable space during writes
  and fails before crossing the reserve.
- `NoOpCacheEvictor` never evicts manual downloads.
- `OfflineMediaStore` owns a keyed read-lease registry and pending removals.
- On a new `Connect(accountId)`, hide old state, purge every other account's
  index/cache entries, then reply `Connected`. Never expose cross-account data.

Android lifecycle:

- The user starts a non-exported `dataSync` `DownloadService`.
- Admission first inserts the request with the app's `SystemLimit` stop reason.
  The first DownloadIndex-backed `onDownloadChanged` is the durability
  acknowledgement. Only then may a still-current foreground account session
  start the service, clear that stop reason, and reply `Accepted`; cancellation
  or account-generation change removes the request instead.
- `getScheduler()` returns `null`. Add no restart intent filter,
  `PlatformScheduler`, WorkManager, Android `DownloadManager`, UIDT, boot
  receiver, connectivity scheduler, or second lifecycle owner.
- On target-SDK-35 `dataSync` timeout, pause work and call the Media3 superclass
  timeout path promptly. Project `Queued.SystemLimit`; resume only after Nexus
  is next foregrounded and a completed `Connect` has established the active
  account.
- Process death/reboot preserves index and complete/partial cleanup facts but
  does not promise automatic background restart.
- Add only the required new permissions:
  `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`.
- Remove Media3 ExoPlayer's transitive `WAKE_LOCK` declaration from the merged
  manifest; this download-only path does not use ExoPlayer wake mode.

## Intra-System Composition

Add:

```text
CollectionRowView.localAvailability: Presence<LocalAvailability>
```

- `PodcastEpisodeList` threads selected offline state/capability through
  `EpisodePresenterContext`, matching the current `playedState` pattern.
- Episode presenter maps the complete union; other presenters emit `absent()`.
- `CollectionRow` owns copy, icons, Ready indicator, and explicit precedence.
- Hard-cut `ResourceRow.activity` plus `exceptionalStatus` to one domain-free
  `status` prop. This is required because `ResourceRow` currently owns semantic
  precedence and `CollectionRow` is its sole caller; do not create an
  episode-only row.
- The provider wraps the final player provider. Resolve and capture local source
  privately during `StartSession`; expose no raw-URL activation.

## Hard-Cut Rules

- No server/device duplicate item state, compact DTO URL, R2 copy, or fallback.
- No per-request metered state, `allowMetered`, `PlatformScheduler`, boot
  receiver, typed durable runtime error taxonomy, validator-aware resume, or
  visible verification state.
- No UA-only execution, permissive parsing, optional protocol fields, protocol
  fallback, browser polling, second progress sampler, feature flag,
  compatibility hook, or pre-player-cutover adapter.
- No file/content URI, public/system downloader, PWA path, native player, or
  duplicate queue/progress model.
- Delete superseded prototypes and orphaned cache entries before merge.

## Files

Backend/BFF:

- `python/nexus/{errors.py,schemas/media.py,services/media.py,api/routes/media.py}`
- `python/nexus/{schemas/podcast.py,services/podcasts/episodes.py}` for the
  compact eligibility projection
- `python/nexus/services/playback_source.py` or one focused sibling owning
  offline source derivation; do not overload playback fallback semantics
- `python/tests/test_media_offline_download_spec.py`
- `apps/web/src/app/api/media/[id]/offline-download-spec/{route.ts,route.test.ts}`

Web:

- add `apps/web/src/lib/offlineMedia/{contract.ts,clientStore.ts,transport.ts,
  OfflineMediaProvider.tsx}`
- add `apps/web/src/components/offlineMedia/DownloadsOverlay.tsx`
- change authenticated layout/bootstrap/shell for verified account id/provider
- change `AccountMenu.tsx`, `resourceActions.ts`, `PodcastEpisodeList.tsx`,
  episode presenter, collection types/row, `ResourceRow.tsx`, final
  `globalPlayer.tsx`, and colocated tests

Android:

- pin AndroidX WebKit, Media3 download/cache/OkHttp data-source, and OkHttp
- change `app/build.gradle.kts`, manifest, `MainActivity.kt`, strings
- add `offline/{OfflineMediaContract.kt,OfflineMediaStore.kt,
  OfflineMediaDownloadService.kt,OfflineMediaWebCapability.kt,
  SafeProgressiveDownloaderFactory.kt}`
- add unit tests under `src/test/.../offline/` and instrumentation under
  `src/androidTest/.../OfflineMediaTest.kt`

Docs:

- update `architecture.md`, `local-rules/codebase.md`,
  `modules/{podcast,player}.md`, `chapbook.md`
- replace the blanket no-bridge rule only for this exact capability

## Implementation Order

1. Land/verify Global Player Surfaces; target only its final contracts.
2. Red tests for API and pure TS/Kotlin protocol/state.
3. Offline source derivation, eligibility, errors, API, BFF.
4. Native manifest/cache/safe downloader/network policy/reconciliation.
5. Exact-origin messages and GET/range serving with read leases.
6. Stable browser controller, keyed store, actions, row, inventory.
7. Player `StartSession` resolver/capture.
8. Delete superseded paths; update canonical docs.
9. Focused tests, Android instrumentation, physical-device gates, negative
   residue searches, `git diff --check`.

## Acceptance Criteria

1. Only statically eligible episodes with a successful Android handshake expose
   Download; browser, forged UA, iframe, and protocol mismatch do not.
2. Every menu/row/inventory state is representable and truthful. Resolving is
   cancellable; Failed is removable; duplicate commands are idempotent.
3. The index and completed bytes survive reload, process death, update, and
   reboot. Interrupted work resumes only when Nexus next opens foregrounded.
4. Incomplete cached spans are deleted and restarted from zero. Only complete
   cache coverage becomes `Ready`; changed/corrupt representations never play.
5. `Ready` playback seeks in airplane mode while the shell remains loaded.
   `StartSession` captures one source; active playback never switches.
6. `UnmeteredOnly` survives process death/reboot. Leaving Wi-Fi cannot continue
   on cellular. Enabling mobile data is global and releases all pending work.
7. Preflight and in-flight guards preserve 512 MiB; manual downloads are never
   evicted.
8. Cancel/Remove affect only local availability. Removal waits for active read
   leases and never changes domain state.
9. Runtime failure survives as generic `DownloadFailed`; every preflight/policy
   rejection returns exact `Rejected { code }` and creates no item.
10. Connecting a new account exposes no old state and purges the former
    account's index/cache entries before `Connected`.
11. A Ready item remains an immutable snapshot across source changes. A deleted
    canonical media route cannot play it but leaves it removable.
12. Off-origin/subframe/malformed/oversized/wrong-version/private-host traffic
    is rejected; WebView hardening remains.
13. No server download state, compact DTO URL, alternate downloader/player/
    cache/scheduler, compatibility path, or dead prototype remains.

## Required Proof

- Backend integration: visibility, strict external-enclosure eligibility,
  404/409/422 mapping, exact wire.
- Web unit/component: strict decode, resolving cancellation/fencing, keyed
  subscriptions, every action/state, precedence, inventory, focus,
  accessibility, and one-time player source capture.
- Android unit/instrumentation: origin/frame/protocol rejection, `Rejected`,
  idempotency, global network policy persistence, every Media3 state including
  restarting, zero-resume, reserve guard, read leases, account purge,
  notification denial, timeout, reconciliation, GET/ranges.
- Physical device: download/cancel/retry/remove; loaded-shell airplane seek;
  reload/process kill/reboot then foreground resume; Wi-Fi-to-cellular policy;
  slow/storage-full; short-lived redirects; 401/403/404/429/5xx; corruption;
  TalkBack, large text, focus, notification.

Report focused local, real-stack, physical-device, CI, deploy, and production
proof separately. Browser tests do not prove Android storage or lifecycle.

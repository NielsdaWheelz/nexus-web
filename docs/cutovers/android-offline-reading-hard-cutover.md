# Android Offline Reading — Staged Hard-Cut Plan

Status: approved implementation specification; implementation and promotion proof in progress

Type: three sequential hard cuts. Each cut has one final owner and deletes its
superseded internal path. There is no feature flag, fallback renderer,
compatibility decoder, or dual write.

Target: Android API 34+. The target-36 platform prerequisite is present and the
release owner verifies it from the signed manifest; offline-reading code does
not own a compatibility mode for lower targets.

Current cut status: `compileSdk` and `targetSdk` are 36. The release controller
attests target 36 from the signed APK manifest. Edge-to-edge and supported back
dispatch are implemented; the signed physical target-36 baseline remains a
promotion prerequisite.

## Implementation and evidence status

This document remains the acceptance contract; unchecked acceptance criteria
are not implied complete by the presence of code.

The hosted application fonts are vendored as local WOFF2 build inputs rather
than fetched through `next/font/google`, because this cutover's immutable
artifact requirement extends to typography: a production build, the hosted app,
and the packaged reader must all be reproducible with no third-party font CDN
in their dependency closure.

The current worktree contains the shared reader session, publication/progress
and package services, V1 cross-language corpus, Android store/job/shelf owners,
host/component/service proof, the physical-device capability selection, and a
signed instrumentation method for SQLite/files/binding-seal recreation,
lease-delayed removal, and account purge. The controller also registers the
three specified service faults, but a dirty worktree is not supported
sensitivity evidence; promotion requires a clean `./scripts/test prove`/PR run.

The protected release workflow now targets one USB-backed physical device and
the signed promotion owner requires a strictly older installed baseline before
an in-place candidate update. The executable owner and its protected-input
contract are present: the controller passes only canonical non-secret synthetic
account/PDF/EPUB/article fixture UUIDs, while the older physical baseline must
already carry that account's real WebView session. It stages real-local-API
acquisition of all three formats, cold shelf/progress checks after controller
force-stop, reboot-after-first-unlock, and airplane mode, then the in-place
reopen/progress/purge candidate phase. This checkout has not run that scenario
on its protected USB device, so its hardware/operator evidence remains
`not_run` and fails `nightly`/`release`; none of the host, component,
debug-device, or narrow signed lifecycle checks substitutes for the signed
physical promotion evidence. That scenario must also attest that
the real mint response's exact `package_base_url` equals the API origin embedded
in the APK; the controller reads that constant back from the signed APK's
`BuildConfig` bytecode, and the release evidence and immutable artifact manifest
retain the measured origin. Native must never relax this comparison or follow an arbitrary returned
origin. Its default compatible topology builds both APKs without installing the
candidate, installs only the release instrumentation APK beside the strictly
older baseline, and runs
`OfflineReadingSignedPhysicalPromotionTest#acquiresAllFormatsAndPersistsPendingProgress`
against that baseline. It then owns force-stop, reboot, first-unlock and
airplane attestations before `#opensShelfAfterForceStopRebootAndAirplaneMode`,
installs the candidate in place, and runs
`#reopensPersistedPackagesThenPurgesOfflineState` with the narrow signed
lifecycle/auth checks.

An incompatible reader-contract release cannot honestly replay legacy packages
through the candidate. Its explicit `empty_baseline_hard_cut` topology is
admitted only after the candidate backend contract is live. The controller
enables airplane mode and runs
`#attestsEmptyOfflineStateOnIncompatibleBaseline`, which requires the complete
legacy shelf — not merely the three promotion fixtures — to be empty. The old
app is force-stopped first, and the test reads its package files and durable
tables without opening the product store; reconciliation cannot erase evidence
before the assertion. It then
installs the candidate, disables airplane mode for candidate acquisition, and
runs the same rebooted cold-offline and purge proofs against candidate-created
packages. The retained evidence names the topology and measured network state.
This mode is mutually exclusive with `bootstrap_no_device`; it refuses any
legacy state rather than guessing, migrating, or deleting it. Missing protected USB access, the
pre-authenticated baseline, ready real-API fixtures, or their evidence returns
`not_run`; the narrow signed lifecycle fixture cannot produce a release pass in
their place.

## Decision

Ship a small verified local reading replica, not an offline Nexus replica.

```text
online open
  -> current hosted source -> shared reader core -> canonical HTTP progress

offline or explicit "Open downloaded copy"
  -> APK shelf -> native lease -> verified package -> same reader core
  -> native latest-value progress -> generation-fenced canonical CAS
```

Deliver it as three independently shippable cuts:

1. **Reader core:** extract and prove the hosted reader with no behavior change.
2. **Publication identity:** add document-only generation and offline progress
   endpoints without changing the existing reader-state contract.
3. **Android vertical slice:** direct package token, package service, native
   store/job, APK shell, and UI.

Existing podcast downloads are current production behavior, not a legacy
offline-reading path. Keep `nexusOfflineMedia`, `OfflineMediaProvider`,
`OfflineMediaContract`, `OfflineMediaStore`, Media3 storage identities, and all
audio consumers. Compose reading beside audio; do not genericize either state
machine in this cut.

## Locked choices

- Manual pinned downloads for ready PDF, EPUB, and web articles.
- Cold launch after process death, force-stop, and reboot after first unlock.
- Web articles are text/semantic structure only; remote images and embeds are
  excluded and the limitation is visible.
- Online opens current hosted content. Local content is used only offline or
  through an explicit downloaded-copy action.
- The persisted queue contains download intent, never authorization.
- A fresh scoped direct token is minted only after the selected network is
  available and immediately consumed.
- Native derives account identity from an authenticated fixed endpoint; a
  renderer never supplies or attests the account.
- Document publication generation is separate from `media` and
  `reader_media_state`. Existing web/mobile reader snapshots and cursor rows do
  not change shape.
- Removing a copy also removes its local baseline and pending locator after a
  confirmation that names unsynced-position loss.
- No resumable transfer. Current ingest limits are at most 100 MiB PDF and
  50 MiB EPUB; interruption restarts from byte zero.
- No maintenance window or APK/web bridge cut is required. Old APKs keep audio
  behavior and simply lack the new reading capability.

## Target behaviour

| ID | Situation | Required result |
| --- | --- | --- |
| TB-01 | Eligible ready document on capable Android | Show one `Download for offline` action. Other clients omit it. |
| TB-02 | Enqueue | Persist intent, then show `Preparing -> Queued/Downloading -> Verifying -> Ready`. |
| TB-03 | Default policy without unmetered network | Remain `Queued: Waiting for Wi-Fi`; mint no token and use no cellular data. |
| TB-04 | Failure | Show one typed reason and valid Retry/Remove action; never publish Ready. |
| TB-05 | Open while online | Open current hosted content unless the user explicitly chooses the downloaded copy. |
| TB-06 | Cold launch offline | Load the APK shelf without waiting for DNS/auth/hosted bootstrap. |
| TB-07 | Web article | Render text/semantic HTML and `Text-only copy; images not included`. |
| TB-08 | EPUB | Render canonical navigation, sections, and declared local assets. |
| TB-09 | PDF | Render local bytes with packaged PDF.js worker/CMaps/fonts/WASM and byte ranges. |
| TB-10 | Offline progress | Acknowledge only after the latest locator is durable natively. |
| TB-11 | Same-publication CAS conflict | Preserve both values and ask `Use saved location from Nexus` or `Keep this device's location`. |
| TB-12 | Source publication changed | Keep the old copy readable and its locator local; never write it into the new publication. |
| TB-13 | Source deleted | Keep the installed copy readable, mark sync `Source unavailable`, and allow Remove. |
| TB-14 | Remove | Deny new leases, finish live leases, delete bytes/package/baseline/pending state, then disappear. |
| TB-15 | Logout/account switch | Purge old account packages, transfers, leases, baselines, and pending progress before exposing another account. |
| TB-16 | App Link while shelf is active | Keep the shelf; open a matching installed document locally or ask before leaving for hosted Nexus. |
| TB-17 | In-place APK update | Continue to open every installed package whose one current schema is declared supported. |
| TB-18 | Empty shelf | Show `Nothing downloaded for offline reading` and reconnect/open-online actions; never imitate the workspace. |

Downloaded is a verified device fact, never a server field or cache hint. No
optimistic Ready, silent eviction, automatic prefetch, hidden cellular use, or
remote request from the APK shelf.

## Goals / non-goals

Goals:

- Trustworthy offline reading for the three dominant document formats.
- Native-owned durable bytes, account isolation, transfer lifecycle, and
  pending locator; server-owned authorization and canonical packaging;
  web-owned presentation.
- One shared reader core and one visible Downloads surface, with specialist
  audio and reading stores/contracts beneath it.
- Typed interruption, corruption, space, authorization, account, source, and
  cursor-conflict outcomes.

Non-goals:

- Service worker/PWA/Cache Storage/OPFS/IndexedDB document storage.
- Android below 34, iOS, a native renderer, or a second reader coordinator.
- Offline highlights/notes/evidence/Document Map, search, AI, TTS, transcripts,
  completion, automation, export, sets, or prefetch.
- Online use of stale local content, reanchoring across publications, raw EPUB
  parsing on device, article-image preservation, DRM, or content encryption.
- Full offline auth/workspace, local FastAPI/PostgreSQL, package sync, or
  server-persisted packages.
- Media3 rewrite, generic offline bridge, audio state migration, or audio class
  rename.
- Update detection beyond a typed conflict observed during download/progress
  work. V1 replacement is explicit Remove, then Download.

## Final ownership

| Owner | Owns | Excludes |
| --- | --- | --- |
| shared document-reader composition | Session-orchestrated format/progress load, initial restore, leaf positioning/navigation/Find, locator emission | Workspace chrome, network, persistence, highlights |
| `DocumentReaderSession` | Source/progress orchestration, initial active unit and preferred-locator selection, canonical locator projection | Visible Find, subsequent UI navigation, leaf scrolling/PDF positioning |
| `HostedReaderSource` | Current BFF/API document inputs | Local packages |
| `OfflineReaderSource` | Lease-scoped package inputs | Remote fetch |
| `ReaderProgressPort` | Exact load/save/conflict result contract | Transport implementation |
| `reader_publications` | Current document publication generation; atomic bump | User cursor, package/device state |
| `offline_reader_progress` | Generation fence around the existing cursor store | Alternate cursor row or merge heuristic |
| existing direct-token service | JWT signing, scope verification, one-time JTI claim | Package authorization rules |
| `offline_reading_packages` | Authorized consistent package projection | Device state, progress, durable server artifact |
| `OfflineReadingOriginClient` | Fixed BFF JSON calls and fixed direct package stream | Renderer URL/header input |
| `OfflineReadingStore` | SQLite/files, verification, publication, leases, removal, reconciliation | HTTP, rendering, audio |
| `OfflineReadingTransferJobService` | One constrained UIDT queue runner and notification | Package truth, account truth, policy persistence |
| `OfflineNetworkPolicyStore` | Existing persisted network-policy value and events | Store-specific enforcement |
| `OfflineReadingWebCapability` | Strict reading protocol/correlation/snapshot push | Audio, generic fetch/filesystem APIs |
| existing audio owners | Media3 cache/index/playback/download protocol and store-local fences | Reading packages |
| Downloads presentation adapter | Audio and reading rows in one overlay | Store/protocol state ownership |

Native package rows are authoritative for reading availability. React and the
notification are projections. Media3 remains authoritative for audio.

## Cut 1 — Hosted reader-core extraction

### Contract

Extract the reader before any offline code. `MediaPaneBody` remains hosted
composition and supplies current data, decorations, activity, completion, and
chrome. The extracted core is runtime-safe browser code and imports no Next
route/layout/auth/workspace module.

```ts
// MediaId and SectionId are contract-named string aliases. Every source load
// is abortable; progress saves carry the CAS base revision and the lifecycle
// keepalive flag because teardown flushes and "Stay at this position" are part
// of the preserved hosted behavior.
interface ReaderDocumentSource {
  loadDescriptor(mediaId: MediaId, signal: AbortSignal): Promise<ReaderMedia>;
  loadTextDocument(mediaId: MediaId, signal: AbortSignal): Promise<ReaderTextDocument>;
  loadEpubNavigation(mediaId: MediaId, signal: AbortSignal): Promise<ReaderNavigation>;
  loadEpubSection(
    mediaId: MediaId,
    sectionId: SectionId,
    signal: AbortSignal,
  ): Promise<EpubSectionContent>;
  openPdf(mediaId: MediaId, signal: AbortSignal): Promise<ResolvedPdfDocument>;
  resolveAsset(ref: ReaderAssetRef): ReaderAssetUrl;
}

interface ReaderProgressPort {
  load(mediaId: MediaId, signal?: AbortSignal): Promise<ReaderProgressView>;
  save(
    mediaId: MediaId,
    locator: ReaderResumeState,
    options?: { keepalive?: boolean; baseRevision?: number },
  ): Promise<ReaderProgressSaveResult>;
  resolve(mediaId: MediaId, choice: "Canonical" | "Device"): Promise<ReaderProgressView>;
}

type ReaderProgressView =
  | { kind: "Canonical"; snapshot: ReaderCursorSnapshot }
  | { kind: "Pending"; baseline: ReaderCursorSnapshot; device: ReaderResumeState }
  | { kind: "Conflict"; canonical: ReaderCursorSnapshot; device: ReaderResumeState }
  | { kind: "ContentChanged"; baseline: ReaderCursorSnapshot; device: ReaderResumeState }
  | { kind: "SourceUnavailable"; baseline: ReaderCursorSnapshot; device: ReaderResumeState };

type ReaderProgressSaveResult =
  | { kind: "Canonical"; snapshot: ReaderCursorSnapshot }
  | { kind: "DurablyPending"; view: ReaderProgressView }
  | { kind: "Conflict"; canonical: ReaderCursorSnapshot; device: ReaderResumeState }
  | { kind: "ContentChanged"; view: ReaderProgressView }
  | { kind: "SourceUnavailable"; view: ReaderProgressView };
```

The shared document-reader composition owns active content, lazy EPUB sections,
restore/position behavior, Find, and locator emission. Within it,
`DocumentReaderSession` owns source/progress orchestration, initial active-unit
and preferred-locator selection, and canonical locator projection;
`TextDocumentReader`, `PdfReader`, and the format adapter own their visible
navigation/scroll state. Reader leaves never fetch media, signed URLs, page
highlights, or progress.

Highlights/decorations are a hosted layer over canonical content. Stop baking
highlight markup or remote embed thumbnails into `renderedHtml`. The canonical
text/HTML input remains undecorated; hosted decoration is applied after load;
offline supplies no decoration. External article embeds become inert semantic
text/link projections before they can enter an offline package.

`HostedReaderSource` and `HostedReaderProgressPort` are the only Cut-1 adapters.
They preserve current URLs, cursor CAS, restore handoff, activity, and visible
behavior. No offline branch, placeholder source, or dual reader remains.

### Exit

- Existing PDF, EPUB, web-article, Find, restore, highlight, and reader-progress
  browser proofs pass unchanged or are replaced by stronger behavior proofs.
- One parameterized Chromium component proof drives all three formats through
  `DocumentReaderSession` and observes the same locator/restore behavior.
- The old orchestration and fetches are deleted from reader leaves and
  `MediaPaneBody`; no adapter points back to them.
- Cut 1 can deploy and roll back as a web-only immutable artifact.

## Cut 2 — Document publication and offline progress

### Schema

Do not add `media.reader_generation` or
`reader_media_state.reader_generation`. Add one isolated owner:

```text
reader_publications(
  id UUIDv7 PRIMARY KEY,
  media_id UUID UNIQUE NOT NULL REFERENCES media(id),
  generation BIGINT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL
)
```

Backfill one row at generation `1` for ready PDF, EPUB, and web articles. The
new table is additive; rolled-back application artifacts ignore it. Generation
positivity and increment semantics belong to the service, not a database
business `CHECK`.

### Publication rule

`reader_publication` is the only service allowed to publish or replace
reader-visible file pointers, fragments, EPUB navigation/sections/assets, or
article canonical content for the three eligible kinds.

1. Complete object writes under immutable attempt-scoped keys.
2. Lock the media publication row.
3. Replace the canonical DB projection and increment generation once in the
   same PostgreSQL transaction.
4. Commit the pointer swap only after every referenced object exists.

Initial backfill and a document's first ready publication use generation `1`.
An ingest retry that publishes nothing does not bump. Any replacement of
reader-visible canonical input bumps even if the new prose happens to compare
equal; this affects offline fencing only. Podcast/video transcript reruns never
touch this table. Media deletion explicitly deletes the non-cascading
publication row and does not rewrite existing `reader_media_state`.

`reader_publication.capture_current` uses generation as a seqlock and becomes
the Cut-3 package builder's only projection input:

1. Capture one repeatable-read projection and its immutable object keys at G.
2. Assemble and verify outside the transaction.
3. Re-read generation and media existence before response.
4. Changed G restarts the whole capture once; second change returns typed
   `E_READER_PUBLICATION_BUSY`.
5. Missing object at unchanged G defects. Missing object after a bump restarts.

### Offline progress API

Keep the canonical `ReaderCursorSnapshot`, `CursorWrite`,
`reader_media_state`, and all existing online clients unchanged. Add a narrow
authenticated BFF route and service envelope:

```http
GET /api/media/{media_id}/offline-reader-state
PUT /api/media/{media_id}/offline-reader-state
X-Nexus-Expected-Account-Id: <native bound UUID>

OfflineReaderState = {
  accountId: AccountId;
  readerGeneration: number;
  cursor: ReaderCursorSnapshot;
}

OfflineReaderWrite = {
  expectedReaderGeneration: number;
  baseRevision: number;
  locator: ReaderResumeState;
}
```

The BFF uses a route-specific proxy policy for
`X-Nexus-Expected-Account-Id`; do not widen the global request allowlist. It
forwards `Nexus-Account-Id` and `Nexus-Reader-Generation` only for this response.
FastAPI verifies expected account equals the authenticated viewer **before**
any mutation. In one DB transaction it locks/reads the publication, rejects a
mismatched generation, then calls the existing cursor store CAS.

- Generation mismatch: `409 E_READER_CONTENT_CHANGED`; no cursor write.
- Ordinary revision mismatch: existing cursor conflict with current snapshot.
- Missing/deleted/invisible media: `404`; no existence leak.
- Success: exact canonical cursor snapshot plus account/generation headers.

`readerRevisionKey` is package integrity/local identity, not a second server
fence. A matching generation deterministically denotes the package projection.

### Exit

- Real migration proof covers empty/head and supported prior snapshot/head,
  backfill, explicit non-cascading cleanup, and rollback-artifact reads/writes
  against the migrated DB.
- A real PostgreSQL/MinIO service scenario races publication and proves one G,
  one object projection, one increment, and no mixed reader capture.
- A service scenario proves wrong-account and wrong-generation PUT requests
  leave `reader_media_state` byte-for-byte unchanged.
- Current desktop/Android hosted reader progress is behavior-identical.
- All eligible publication call sites use the owner; direct writes are deleted.

## Cut 3 — Android offline-reading vertical slice

### Production authentication boundary

Reuse the existing BFF-mint/direct-connect/JTI-claim mechanism in
`stream_tokens.py`; do not add `offline_reading_grants`, ship
`X-Nexus-Internal`, or accept a Supabase JWT at the direct route.

Add scope `offline-reading-package` to the existing signed-token service. The
JWT has the existing issuer/audience and exact claims:

```text
sub, jti, iat, exp,
scope = offline-reading-package,
media_id, reader_generation, package_schema_version = 1
```

The current signing key and `stream_token_jti_claims` remain the sole signing
and one-use-claim owners; do not rename the stream issuer/table in this cut.
Package-token TTL is 300 seconds and only bounds request arrival. The route
claims JTI before assembly; disconnect/failure after claim requires a new
token.

```http
POST /api/media/{media_id}/offline-reading-token   # authenticated BFF
GET  /offline-reading/packages/{media_id}          # direct configured API origin
Authorization: Bearer <scoped token>
Accept-Encoding: identity
```

The BFF calls one internal mint endpoint with its server-only HMAC and session
bearer. The response contains the configured API origin, token, account,
generation, schema, and expiry. Native accepts only that exact configured
origin and compares account to its durable binding.

Extend middleware with an exact offline-package-path predicate. That path skips
the internal-HMAC/Supabase middleware only so its route dependency can verify
issuer, audience, scope, path media, generation, expiry, and one-time JTI.
Unrouted paths do not inherit the exemption. Stream CORS behavior is unchanged;
the native package route emits no browser CORS.

Verification order is fixed: validate signature/claims and path binding;
authorize token `sub` against current media visibility; compare current
generation/schema; atomically claim JTI; then capture/assemble. Wrong path,
revoked visibility, or changed generation produces no package and no general
fetch authority.

The persisted native transfer contains only `{bindingId, mediaId, requestedAt}`.
After JobScheduler supplies an allowed network, native uses its existing
WebView `CookieManager` source to call the fixed BFF mint route and immediately
calls the direct route. Missing/expired hosted cookies yield
`AuthorizationRequired`; foreground login/Retry mints anew. No token, package
URL, cookie, or authorization header is persisted or logged. Every native
state-changing BFF call sends the exact pinned hosted origin required by the
BFF CSRF boundary; OkHttp defaults are never treated as browser attestation.

Add fixed `GET /api/offline-reading/account-binding`. Its BFF-authenticated
response supplies the viewer UUID and supported protocol/schema. A hosted
renderer can request connection but cannot send an account ID. Every token,
package, and progress response is compared to this binding. First connect
creates a sealed binding; a different attested UUID completes old-account purge
before inserting or exposing the new binding.

### Transfer lane

The direct response is:

```http
200 Content-Type: application/vnd.nexus.offline-reading+zip
    Content-Length: <compressed bytes, <= 512 MiB>
    Content-Digest: sha-256=:<base64>:
    Nexus-Account-Id: <viewer UUID>
    Nexus-Reader-Generation: <positive integer>
    Nexus-Expanded-Length: <declared entries, <= 512 MiB>
    Cache-Control: private, no-store
```

Caddy owns an exact pre-`encode` matcher for this path, forwards identity bytes,
and applies: 20-second upstream dial, 660-second response-header, and
3600-second stream read/write bounds. FastAPI package assembly is bounded at
600 seconds. Native uses 20-second connect and per-read timeouts with no whole
call deadline. Any `Content-Encoding`, redirect, missing length, chunked body,
or conflicting digest/length is rejected.

The proxy seam is proved under `service`: a pinned ledger-owned Caddy process
loads the production Caddyfile with only its site/upstream/admin endpoints
substituted for controller-owned loopback values, then proxies a ledger-owned
Uvicorn/FastAPI fixture. It proves the exact matcher, forwarded authorization
and identity/length/digest headers, byte preservation, no package encoding, and
that fallback encoding remains active. The kernel token/path proof owns
media/lane/generation/schema binding and the exact direct-path predicate. The
authenticated production FastAPI/TestClient service proof owns account and
generation attestation, generation denial before JTI claim, one-use replay, and
package integrity. The BFF header policy has its separate TypeScript kernel
proof; this boundary does not claim a real BFF process. The immutable deployed
Caddyfile remains owned by `release-artifact`;
`static-platform` does not own the runtime proxy seam.

FastAPI stages production object members under one scoped temp owner, hashes and
ZIP-streams them into one scoped response temp file, and checks its cooperative
assembly deadline while reading and writing every chunk. Length/digest are
known before headers. It deletes every staged member and response file after
stream close, disconnect, timeout, or error and persists no package artifact.

### Package schema

```ts
type OfflineReadingManifest = {
  packageSchemaVersion: 1;
  readerContractVersion: 1;
  minimumReaderBundleVersion: 1;
  mediaId: MediaId;
  mediaKind: "Pdf" | "Epub" | "WebArticle";
  title: string; // 1..512 Unicode code points
  readerGeneration: number;
  readerRevisionKey: Sha256Hex;
  entries: readonly {
    path: SafePackagePath;
    mediaType: string;
    sizeBytes: number;
    sha256: Sha256Hex;
  }[];
};
```

ZIP membership is `manifest.json` plus exactly the declared entries. Rules:
sorted UTF-8 paths; no duplicate/absolute/empty/`.`/`..`/backslash/symlink/
nested-archive entry; maximum archive and expanded totals are 512 MiB;
`reader.json` has an exact 64-MiB maximum matching the existing EPUB rendered-
text/API-container bound; SVG has an exact 8-MiB maximum because verification
performs a bounded XML parse; device verification also re-parses every
`htmlSanitized` fragment with jsoup (a WHATWG-algorithm HTML parser, no I/O)
to re-apply the tag/attribute/URL allowlist as defense in depth — its input is
bounded by the 64-MiB `reader.json` cap, and a platform XML parser cannot
serve because sanitized HTML is not well-formed XML and a hand-rolled parser
would risk sanitizer-bypass parser differentials against the WebView renderer;
every other member has a 512-MiB maximum. JSON is
strict UTF-8 with exact keys; ZIP entries have fixed DOS timestamp
`1980-01-01T00:00:00`, permissions, compression level, and order.
`manifest.json` is never an entry and is excluded from its revision hash.

```text
manifest.json
reader.json
document.pdf       # PDF only
assets/<safe-key>  # EPUB only; referenced assets only
```

`reader.json` is a strict `readerContractVersion: 1` union:

- PDF: minimal media DTO plus `documentPath`.
- Web article: minimal media, ordered canonical fragments/navigation, and
  undecorated sanitized semantic HTML. Remove executable/remote subresources;
  retain inert text, alt text, and safe link labels.
- EPUB: minimal media, navigation, canonical sections, and every referenced
  allowlisted asset rewritten to a declared package path.

Include no credentials, user data, highlights, notes, conversations, remote
URLs, source HTML/scripts, or undeclared assets. Do not parse EPUB on device.

Both Python and Kotlin recompute `readerRevisionKey` from:

```text
UTF8("NexusOfflineReadingRevision\0")
|| UINT64_BE(readerGeneration)
|| for each manifest entry sorted by UTF-8 path bytes:
     UINT32_BE(pathByteLength) || pathUTF8
     || SHA256_ENTRY_BYTES[32] || UINT64_BE(sizeBytes)
     || UINT16_BE(mediaTypeByteLength) || mediaTypeASCII
```

Hex is lowercase. `reader.json` binds media identity/title/kind.
`Content-Digest` independently binds exact ZIP bytes.

The APK declares `readerBundleVersion = 1` and supports exactly package/reader
schema `1`. An in-place app update must open an existing V1 package before
release. A future schema replacement is a separate hard cut with an explicit
atomic migration or explicit user-confirmed invalidation; adding a second
decoder here is forbidden.

### Native durable state

Use one `SQLiteOpenHelper`; add no Room/database framework.

```text
offline_reader_binding(id UUID PRIMARY KEY, singleton_id = 1 UNIQUE,
  binding_id UUID UNIQUE,
  account_id UUID UNIQUE, binding_seal BLOB,
  remote_authorization_required BOOLEAN, bound_at)
offline_reader_account_transitions(id UUID PRIMARY KEY, singleton_id = 1 UNIQUE,
  kind Logout|AccountSwitch, target_account_id UUID?, requested_at)
offline_reader_purges(id UUID PRIMARY KEY, binding_id UNIQUE,
  reason Logout|AccountSwitch, requested_at)

offline_reader_packages(id UUID PRIMARY KEY, binding_id, media_id, media_kind,
  title, reader_generation, reader_revision_key, package_schema_version,
  reader_contract_version, minimum_bundle_version, package_sha256, size_bytes,
  installed_at, UNIQUE(binding_id, media_id))
offline_reader_transfers(id UUID PRIMARY KEY, binding_id, media_id,
  requested_title, requested_media_kind, state_json ReadingTransferState,
  automatic_restart_count, staging_name, requested_at,
  UNIQUE(binding_id, media_id))
offline_reader_removals(id UUID PRIMARY KEY, package_id UNIQUE, requested_at)

offline_reader_progress_baselines(id UUID PRIMARY KEY, binding_id, media_id,
  reader_generation, server_snapshot_json ReaderCursorSnapshot, observed_at,
  UNIQUE(binding_id, media_id))
offline_reader_progress_pending(id UUID PRIMARY KEY, binding_id, media_id,
  reader_generation,
  reader_revision_key, base_server_revision,
  locator_json ReaderResumeState,
  sync_state Pending|Conflict|ContentChanged|SourceUnavailable, updated_at,
  UNIQUE(binding_id, media_id))
```

No grant/token column exists. Package row alone means usable. Transfer and
removal rows are operations. Missing pending row means synced.

```ts
type ReadingTransferPhase =
  | { kind: "Preparing" }
  | { kind: "Queued"; reason: "WaitingForUnmetered" | "Capacity" | "Scheduler" }
  | { kind: "Authorizing" }
  | { kind: "Downloading"; receivedBytes: number; totalBytes: number }
  | { kind: "Verifying" }
  | { kind: "Restarting"; attempt: number; reason: "Interrupted" | "PolicyChanged" };

type ReadingFailureReason =
  | "AuthorizationRequired" | "SourceUnavailable" | "ContentChanged"
  | "TooLarge" | "LowSpace" | "Network" | "SystemStopped"
  | "Integrity" | "UnsupportedPackage" | "RecoveryRequired" | "Server";

type ReadingFailed = { kind: "Failed"; reason: ReadingFailureReason };
type ReadingTransferState = ReadingTransferPhase | ReadingFailed;

type ReadingAvailability =
  | ReadingTransferState
  | { kind: "Ready"; sizeBytes: number; installedAt: Instant;
      readerGeneration: number; readerRevisionKey: Sha256Hex;
      progress: ReaderProgressView }
  | { kind: "Removing" };
```

Trusted persisted JSON that fails these exact unions defects during
reconciliation; it is not normalized or guessed.

Bytes live under credential-encrypted
`filesDir/offline-reading/<bindingId>/`, never cache/shared/device-protected
storage. Add Android-12+ `dataExtractionRules` that exclude every file,
database, SharedPreferences, and root path from cloud backup and device
transfer; keep `allowBackup=false`/`fullBackupContent=false`.

Because some OEMs may ignore D2D exclusions, seal the binding with a
non-exportable Android Keystore HMAC key that is not transferred. Before any
shelf/package exposure, a missing key or invalid seal causes crash-recoverable
purge of all reading state. This is device-binding integrity, not package
encryption.

Use alias `nexus_offline_reading_binding_v1`, HMAC-SHA-256, and
`setUnlockedDeviceRequired(true)`. Seal bytes are:

```text
HMAC(key,
  UTF8("NexusOfflineReadingBinding\0")
  || BINDING_UUID_BYTES[16]
  || ACCOUNT_UUID_BYTES[16])
```

Install:

1. Capture binding ID and allowed `JobParameters.network`.
2. Mint fresh token; require token account equals binding.
3. Require response headers and reserve compressed + expanded + fixed
   filesystem overhead + the existing 512-MiB headroom. Extraction uses a
   counting sink and cannot cross declared/aggregate bounds.
4. Download from zero to a unique staging file.
5. Verify response digest, ZIP grammar, exact manifest, supported versions,
   recomputed revision, every entry hash/size/MIME, and required files.
6. Fetch offline reader-state baseline through BFF; require account and
   generation equality with token/headers/manifest.
7. Recheck binding/Keystore seal; fsync and atomically rename the sealed
   directory.
8. In one SQLite transaction insert package/baseline and delete transfer; only
   then emit Ready.

Crash after rename but before row publication leaves an invisible orphan.
Reconciliation deletes it and records `RecoveryRequired`; it never guesses
Ready. Partial staging, corrupt entries, missing baseline, row/file mismatch,
and unsupported versions likewise converge to absent or Failed.

Remove inserts a removal row, hides the package, denies new leases, waits for
live leases, deletes/verifies bytes, then atomically deletes package, removal,
transfer, baseline, and pending rows. Restart has no process leases and
completes the same sequence. The user confirmation explicitly names discarded
unsynced position when pending exists.

Account switch/logout inserts a purge row, closes leases, stops work, and asks
the existing audio owner plus the reading store to purge their own state. The
coordinator exposes no new account until both stores acknowledge. Reading
deletes purge/binding last. Local logout also clears owned WebView cookies and
hosted-origin storage. Crash resumes the hidden old-account purge.

Offline possession remains authorized until explicit local logout; remote
revocation is unknowable without network. The first authenticated binding,
token, or progress denial observed online stops work and requires reauth; an
attested different account triggers the purge sequence. Authorization denial
sets the durable binding fence, cancels active remote I/O, and moves every
nonterminal transfer to `Failed: AuthorizationRequired`; installed packages
remain readable. A successful matching hosted attestation clears the fence and
Retry is explicit. V1 invents no offline license timer.

### Scheduling and network policy

Extract only the current persisted network-policy value into
`OfflineNetworkPolicyStore`, preserving preference file/key/value in place.
Both audio and reading observe it; each store enforces it. Keep
`OfflineDownloadSpec` and `SafeProgressiveDownloaderFactory`. Keep its public
HTTPS rule audio-owned because reading accepts only the configured API origin.
Extract the exact 512-MiB reserve calculation into one
`StorageAdmissionPolicy`; the audio factory must delegate with
behavior-identical proof before its duplicate is removed.

When reading capability is present, one native `SetNetworkPolicy` command is
the UI mutation owner: apply/persist reading first, apply the same persisted
value to Media3 second, and reply Accepted only after both complete. A second
owner failure replies Rejected; repeating the same value is the explicit
idempotent convergence path.

- `UnmeteredOnly` is default; `AnyConnected` is explicit and visible.
- API-34 enqueue while visible inserts SQLite intent, then calls
  `ensureScheduled` for one persisted UIDT runner.
- Manifest owns `RUN_USER_INITIATED_JOBS`, `ACCESS_NETWORK_STATE`,
  `RECEIVE_BOOT_COMPLETED`, and a `JobService` protected by
  `BIND_JOB_SERVICE`. JobInfo is user-initiated, persisted, constrained, and
  promptly supplies a notification.
- One fixed JobInfo ID represents the queue, never a document.
  `OfflineReadingScheduler` serializes scheduler calls. Enqueue does not call
  `schedule()` when that job is pending/running; it signals the runner, which
  drains SQLite serially. Empty-to-nonempty transition schedules once.
- Runner empty-check/idle checkpoint and enqueue share that serialization
  boundary: enqueue before the checkpoint is drained by the current run;
  enqueue after it schedules the now-absent job. No item can remain Queued with
  neither a running nor pending JobInfo.
- Enqueue returns only after SQLite commit and one scheduler-admission attempt.
  Admission failure atomically moves every nonterminal queue item to
  `Failed: RecoveryRequired`; no item remains queued without a pending/running
  job. Explicit Retry reopens selected work; a same-value policy application
  rechecks scheduler admission for existing nonterminal work. Foreground
  reconciliation calls the same `ensureScheduled`, closing a crash between
  commit and admission while the app is again visible.
  Already-admitted persisted jobs survive reboot; no boot receiver fabricates
  a fresh user gesture.
- Policy change intentionally checkpoints the active item as
  `Restarting: PolicyChanged`, reschedules the one JobInfo with the new
  constraint, and generation-fences stale callbacks. It does not count against
  restart budget.
- All transfer I/O uses only `JobParameters.network`; never race a separate
  connectivity check and then use the default network.
- Cancel, policy/account transition, and `onStopJob` cancel the owned active
  OkHttp `Call` before staging deletion/checkpoint; generation fencing alone is
  not cancellation.
- One ordinary interruption may automatically restart from zero. A second
  converges to `Failed: SystemStopped`. Task-Manager Stop may provide no
  callback and forbids reschedule; foreground reconciliation also converges it
  to manual Retry.
- `onStopJob` persists before return and requests reschedule only while that
  one-attempt budget remains. `jobFinished` follows durable state. Cancel/Retry
  are binding/media fenced; Cancel is idempotent and Retry accepts only a
  current Failed transfer.
- A rebooted job mints only when its network constraint is satisfied. If the
  WebView cookie session is unavailable, intent remains and becomes
  `AuthorizationRequired`; no background credential is invented.

### download publication selection

`Enqueue` freezes a positive publication generation before native intent commits.
The location-independent “download current copy” action selects the current
immutable descriptor at invocation, then uses its generation, title, and kind.
Descriptor failure aborts enqueue. Preparation, token minting, interruption, and
explicit retry retain that generation; none reselects a newer publication.
An older visible pane does not change this command's selection semantics.

Native preparation remains the scheduling owner. Its persisted
`Queued: Preparation` state displays “preparing downloaded copy”; the web UI
starts no preparation poller.

### Web capability

Add one new WebKit object `nexusOfflineReading`; keep `nexusOfflineMedia`
unchanged. Accept only exact hosted origin or the exact APK shelf main frame,
strict JSON, canonical UUIDs, exact keys, duplicate-key rejection, 64-KiB
maximum, `protocolVersion: 1`, request UUID correlation, and snapshot push.

```ts
type ReadingCommand =
  | ConnectHosted                 // no accountId
  | ConnectOffline
  | GetSnapshot
  | Enqueue<{
      mediaId: MediaId;
      readerGeneration: number; // positive selected publication generation
      mediaKind: "WebArticle" | "Epub" | "Pdf";
      requestedTitle: string;
    }>
  | Cancel<{ mediaId: MediaId }>
  | Retry<{ mediaId: MediaId }>
  | Remove<{ mediaId: MediaId }>
  | OpenReading<{ mediaId: MediaId }>
  | OpenDownloadedCopy<{ mediaId: MediaId }>
  | CloseReading<{ leaseId: UUID }>
  | SaveReaderProgress<{
      mediaId: MediaId;
      readerGeneration: number;
      readerRevisionKey: Sha256Hex;
      locator: ReaderResumeState;
    }>
  | ResolveReaderProgress<{ mediaId: MediaId; choice: "Canonical" | "Device" }>
  | SetNetworkPolicy<{ policy: "UnmeteredOnly" | "AnyConnected" }>
  | OpenHosted
  | LogoutAndPurge;

type ReadingReply =
  | Connected | { kind: "Snapshot"; snapshot: ReadingSnapshot } | OpenedReading
  | { kind: "ReaderProgressSaved"; result: ReaderProgressSaveResult }
  | Accepted | Rejected;

type ReadingSnapshot = {
  binding: Presence<{
    accountId: AccountId;
    authorizationRequired: boolean;
  }>;
  networkPolicy: "UnmeteredOnly" | "AnyConnected";
  items: readonly {
    mediaId: MediaId;
    title: string;
    mediaKind: "Pdf" | "Epub" | "WebArticle";
    availability: ReadingAvailability;
  }[];
};

type Connected = { kind: "Connected"; snapshot: ReadingSnapshot };

type OpenedReading = {
  kind: "OpenedReading";
  leaseId: UUID;
  readerGeneration: number;
  readerRevisionKey: Sha256Hex;
  readerUrl: InternalHttpsUrl;
  progress: ReaderProgressView;
  installedAt: Instant;
};

type Accepted = { kind: "Accepted" };
type Rejected = {
  kind: "Rejected";
  code: "InvalidRequest" | "Unsupported" | "NotConnected" | "NotFound"
    | "Busy" | "AuthorizationRequired" | "ContentChanged" | "Failed";
};

type ReadingResponse = {
  protocolVersion: 1;
  requestId: UUID;
  outcome: ReadingReply;
};

type ReadingEvent = {
  protocolVersion: 1;
  event:
    | { kind: "SnapshotChanged"; snapshot: ReadingSnapshot }
    | { kind: "OpenReadingRequested"; mediaId: MediaId };
};
```

`OpenReadingRequested` is emitted only to the connected packaged shell, and only
for a media ID native has already confirmed installed and Ready: it carries the
App Link or `OpenDownloadedCopy` target the shell must open locally. It is
pushed once, after the `Connected` reply for the shell document that will
consume it, and never carries any other package fact.

`ConnectHosted` performs the fixed native account-binding call before replying.
`ConnectOffline` is accepted only from the exact active packaged shell and
current MainActivity navigation generation. Any durable item, policy, progress,
content, source, or purge change pushes one full `SnapshotChanged`; never poll.

The server-owned resource-action snapshot supplies canonical media kind and a
strict 1..512-code-point `requestedTitle` to the renderer's enqueue command.
The transfer snapshot projects that requested kind; package verification must
match it. After installation, the snapshot projects the verified manifest kind
and title. Presentation metadata never selects a path or authorizes work.
Native constructs every path/header. The bridge exposes no generic URL,
header, cookie, SQL, fetch, or filesystem API.

### APK shelf and package serving

Build `apps/web/src/offline-reading/` with the repository's existing Vite
dependency, not Bun's bundler and not a second Next app. Use system font stacks;
the offline bundle cannot import `next/font`. Reuse the existing PDF.js copy
owner and include the exact worker/CMaps/standard fonts/WASM used by
`PdfReader`.

Commit generated output under the Android asset owner. One documented command
regenerates it; policy/build fail when output, dependency closure, or checksum
is stale. Static closure rejects external URL/import/font/image/worker/CMap
references.

Serve only exact main frame
`https://appassets.androidplatform.net/nexus-offline/index.html`.
`WebViewAssetLoader` may serve packaged static assets, but it does **not** own
PDF ranges: `PathHandler` cannot observe request headers.

`WebViewClient.shouldInterceptRequest(WebResourceRequest)` owns all requests on
the reserved host:

- exact static asset -> asset loader response;
- exact unguessable 128-bit lease path -> declared package entry;
- one valid PDF `Range` -> bounded `206` with exact `Accept-Ranges`,
  `Content-Range`, length, and seekable stream;
- anything else -> closed local `404`, never `null`/network fallback.

Lease path capability is in memory only. Close, logout, account change, package
removal, or process death invalidates it. Same-origin shelf/package serving
needs no CORS. CSP begins `default-src 'none'` and adds only exact packaged
script/style/image/font/worker/connect needs. While shelf mode is active,
WebView rejects every non-appassets HTTP(S), `file:`, and `content:` request;
external links require explicit Android handoff.

At process start, native uses current validated network capability: validated
loads hosted Nexus; absent/unvalidated loads the shelf immediately. Hosted
failure offers `Open downloaded copies`; it does not silently substitute stale
content. An App Link received by `singleTask.onNewIntent` while the shelf is
active opens an exact installed media ID locally or asks before leaving for
hosted Nexus; it never tears down the shelf implicitly.

If hosted Nexus loads but its protocol/account-binding endpoint is unavailable,
an Android-owned `Open downloaded copies` affordance opens the exact shelf;
native does not reveal package inventory to the unattested hosted renderer.

### Progress state machine

Before Ready, native stores the account/generation-attested canonical baseline.
An ordinary offline save upserts one latest locator transactionally before
returning `ReaderProgressSaved: DurablyPending`. While progress is Conflict,
ContentChanged, or SourceUnavailable, movement still replaces the device
locator durably but preserves that state and emits no remote write. Only an
explicit Device choice rebases a Conflict for CAS; Canonical discards it.
Reading activity remains in its existing independent outbox.

Foreground sync:

1. GET offline reader state with expected bound account.
2. `404`: mark `SourceUnavailable`; keep package/pending readable/removable.
3. Generation mismatch: mark `ContentChanged`; keep package/pending; stop.
4. Matching generation and canonical locator equals pending: clear pending and
   replace baseline.
5. Matching generation and canonical revision equals pending base: CAS PUT;
   on success clear pending and replace baseline.
6. Different same-generation revision: emit Canonical/Device handoff. Canonical
   clears pending; Device rebases once and performs one CAS.
7. Racing conflict returns to step 6. Never use timestamps, furthest-wins,
   auto-discard, or cross-generation reanchor.

Remove is the only way to discard a changed/deleted publication's local
position. After removal, the baseline is absent, so a later installation
inserts cleanly without primary-key conflict.

### UI

- Extend `ResourceOperation.Media.Offline` only for ready eligible documents on
  a connected reading-capable Android client.
- Keep the current audio provider/contract. The Downloads overlay consumes a
  presentation-only adapter and groups `Reading` and `Listening`; shared policy
  and total bytes are shown once.
- Reading rows show title, kind, exact phase/reason, progress, installed bytes,
  installed date, and one valid action.
- Every local reader says `Downloaded copy · saved <date>`. Web article warning
  appears before download, on first open, and in reader chrome.
- Changed source: `A newer source version exists. This downloaded copy and its
  position remain only on this device.` Offer Continue or confirmed Remove.
- Same-generation progress conflict labels never say latest/furthest; include
  page/chapter context when known.
- Pending Remove confirmation says
  `Remove downloaded copy and discard this device's unsynced position`.
- Shelf offers `Remove offline data and sign out`; success leaves a reconnect
  screen. Reuse current dialog/focus/announcement/reduced-motion primitives.

## Hard-cut and release rules

Each cut is atomic at its owner boundary:

- Cut 1 deletes the inline reader orchestration/fetch path after its hosted
  adapter is green. No duplicate reader survives.
- Cut 2 deletes direct eligible publication writes after all call sites use
  `reader_publication`. It does not change or retain two cursor contracts.
- Cut 3 has exactly one reading bridge/package schema/store. There was no
  legacy reading bridge to preserve. Audio paths are outside this replacement.

Deployment:

1. Complete target-36 cut.
2. Deploy/prove Cut 1. Rollback is the prior immutable web artifact.
3. Deploy Cut-2 additive migration/API. Rollback deploys the prior application
   artifact **against the migrated DB**; never downgrade the database.
   the original Cut-3 preflight supplied missing generation-`1` publication rows.
   for the bounded-workspace successor, `reader_publication_preflight rebuild`
   now atomically enqueues exact-generation immutable member preparation. let the
   candidate background worker finish, stop ALL old/candidate publication writers
   through the existing release maintenance owner, then run
   `python -m nexus.ops.reader_publication_preflight verify` in the candidate's
   one-shot container before activation. verification checks exact member bytes
   and query projections; enqueue or descriptor existence never proves readiness.
   keep that maintenance stop through activation; see the authoritative commands
   in [deployment.md](../../deployment.md#reader-publication-preflight).
4. Deploy Cut-3 API/BFF/Caddy/web assets before distributing the APK. Old APKs
   continue audio. New APK advertises hosted reading only after the fixed
   account-binding response declares protocol/schema 1.
5. Prove the signed APK on the dedicated release device, then install it on the
   user device.

Android rollback never uninstalls and never installs a lower `versionCode`.
Before user exposure, rollback is a higher-version artifact built from the last
known-good source and installed in place. After user offline state can exist,
the server rollback floor is Cut 2 and the APK rollback floor is the last
known-good V1-capable build; fixes move forward with a higher version. No
rollback path deletes or rewrites `filesDir/offline-reading` or its SQLite
owner.

Mixed release behavior is bounded, not emulated: an old APK lacks reading and
the hosted UI disables Android sign-out because it cannot prove a native purge;
update the APK to restore that action. A new APK with an old/rolled-back server
keeps installed copies readable but reports hosted authorization/sync
unavailable. It never falls back to another package or auth protocol.

## Non-overlapping implementation tracks

| Track | Exclusive concern/files | Exit |
| --- | --- | --- |
| P. Target-36 prerequisite | Android target SDK/platform behavior only | Signed target-36 baseline green before this plan starts |
| 1A. Reader core | `MediaPaneBody`, `TextDocumentReader`, `PdfReader`, new reader session/source/progress-port modules | Hosted behavior green; old inline owner deleted |
| 2A. Publication | additive migration/model, `reader_publication`, eligible publication call sites | One document generation owner |
| 2B. Offline progress | new offline reader-state schema/service/routes and `apps/web/src/lib/api/proxy.ts` exact headers | Pre-mutation account/generation fence |
| 3A. Direct package | existing token service/path predicates, package schema/service/routes, BFF token route, Caddy | Scoped one-use identity stream |
| 3B. Native store/job | new `offline/reading/**`, SQLite/files/Keystore/UIDT/manifest/data rules | Atomic install/recovery/remove/purge |
| 3C. Shell/bridge/UI | `nexusOfflineReading`, Vite shell/assets, MainActivity interception/deep links, reader offline adapter, Downloads composition | Same reader opens local packages; audio untouched |
| 3D. Shared-policy extraction | exact network preference owner; pure HTTPS/reserve primitives if earned | Existing audio inventory/policy/bytes unchanged |
| Q. Proof/control/docs | one conformance vector, corpus/proof/fault registry, existing test-controller capability wiring, canonical docs | One proof per boundary; no invented capability |

Tracks 1A, then 2A/2B, then 3A–3D. Within Cut 3, 3A and 3B may proceed
against the shared reviewed vector; 3C follows their public contracts. A file
has one track owner. Cross-track need moves to that owner; no temporary adapter.

Every track follows Red -> Green -> Refactor under
`docs/local-rules/testing-standards.md`: requirement-derived proof fails against
base or a controlled fault; smallest owner passes; then centralize/delete and
run the appropriate gate. No owned-code mocks, sleeps, retries-to-green,
copied implementation snapshots, or new broad browser journey.

## 80/20 proof shape

Use existing priority risks: `auth-privacy-secrets`, `reading-progress`,
`durable-job-replay`, `database-object-convergence`,
`immutable-production-release`, and `native-release-auth-handoff`. Do not add a
feature-scoped risk or capability.

Add one independently reviewed
`testdata/offline-reading-contract-v1.json`, registered in
`testdata/manifest.json`. Python, TypeScript, and Kotlin consume the same valid
and invalid vectors; no language-local copy or TypeScript reimplementation is
the oracle.

| Boundary | One primary proof | Existing lane |
| --- | --- | --- |
| Reader extraction | Parameterized Chromium `DocumentReaderSession` component proves hosted PDF/EPUB/article load, initial restore, and canonical save through the source/progress ports. Existing visible-reader proofs remain the owners for navigation, Find, locator emission, and hosted decorations. | `component` |
| Migration/publication | Real PostgreSQL upgrade plus PostgreSQL/MinIO publication-race scenario | `migrations` + `service` |
| Progress account/generation CAS | Real FastAPI/PostgreSQL scenario proves rejection occurs before mutation and conflict preserves both values | `service` |
| Token/direct/Caddy | Kernel token/path proof owns media/lane/generation/schema binding and the exact direct-path predicate. Authenticated FastAPI/TestClient service proof owns account and generation attestation, generation denial before JTI claim, one-use replay, and package integrity. A pinned real Caddy process loads the production Caddyfile and proxies a real local Uvicorn/FastAPI fixture, proving the exact path seam, forwarded authorization and identity/length/digest headers, byte preservation, no package encoding, and active fallback encoding. BFF header policy remains a separate TypeScript kernel proof; no real BFF process or delayed-first-byte process proof is claimed. | Python kernel + `service` |
| Package/schema/protocol | Shared cross-language vector and property rejection of path/count/size/hash/version/origin faults | Python/web kernel + `android-host` |
| Native lifecycle | Exact `OfflineReadingDeviceLifecycleTest#sqliteFilesSealRecreateLeaseRemovalAndAccountPurge` covers SQLite/file/binding-seal recreation, lease-delayed removal, and account purge only. | `android-device` + `android-release` |
| UI/shell | Chromium component consumes the shared vector: enqueue -> Ready -> open -> progress conflict -> Remove; focus/a11y included | `component` |
| Signed physical final wiring | Executable staged promotion owner: the compatible topology acquires on the older signed baseline before rebooted-airplane cold reopen and in-place candidate validation. The incompatible topology first proves the complete legacy shelf empty offline, then installs and acquires with the candidate before the same rebooted-airplane reopen/progress/purge proof. The retained evidence names the topology. The protected USB run remains mandatory; the narrow signed lifecycle method is not a substitute. | `android-release` + `android-device` |
| Deployment config | Immutable release contains the exact no-encoding Caddy route and current APK asset closure/checksums. The controller reads the API origin from signed `BuildConfig` bytecode and the signed physical scenario compares that measured origin with the real mint response before promotion. | `release-artifact` |

The release workflow minimally adds the existing `ANDROID_DEVICE` capability;
do not invent `android-offline-reading-device`. Its controller path uses a USB
ADB device, not wireless ADB. The dedicated device has an automation-safe
unlock policy or records an explicit operator-unlock checkpoint after reboot.
Missing device/operator evidence is `not_run` and fails release.

Extend the existing `ANDROID_RELEASE` owner to run the offline-reading signed
artifact scenario alongside its auth-handoff proof; do not claim ordinary
debug `connectedAndroidTest` proves the signed artifact.

Sensitivity faults live only at supported service/kernel owners:

- `offline-reading-mixed-publication-generation` -> service publication proof;
- `offline-reading-expected-account-bypass` -> service progress/token proof;
- `offline-reading-generation-cas-bypass` -> service progress proof.

Verification-before-publication sensitivity must be demonstrated red/green at
the Android host state-machine seam; do not register a Gradle device-lane
fault. The current dirty worktree is not that evidence.

Gate by cut:

- Cut 1: focused component, `changed`, `confidence`.
- Cut 2: focused migration/service, `pr` including sensitivity.
- Cut 3 before device: focused kernel/component/Android host, then `full`.
- Promotion: fail-closed `nightly` and `release` device/artifact evidence.

`confidence` is not claimed to run migrations, sensitivity, Kotlin, or device
proof. Broad journeys do not repeat package edge cases or Android lifecycle.

## Acceptance criteria

- [ ] AC-01/TB-01: only eligible ready documents on connected protocol-1
  Android expose Download.
- [ ] AC-02/TB-02: durable intent traverses the exact enumerated phases; Ready
  occurs only after package, entries, account, generation, versions, and
  baseline verify.
- [ ] AC-03/TB-03: unmetered policy queues without minting a token or using a
  default/cellular network.
- [ ] AC-04/TB-04: every expected failure maps to one enumerated reason and
  never leaves readable staging bytes.
- [ ] AC-05/TB-05: ordinary online open uses current hosted content/highlights;
  only explicit downloaded-copy open uses local data.
- [ ] AC-06/TB-06: signed APK opens the shelf after force-stop and
  reboot-after-first-unlock in airplane mode without hosted bootstrap.
- [ ] AC-07/TB-07: article package/shell contains no remote subresource and
  visibly discloses text-only scope.
- [ ] AC-08/TB-08: canonical EPUB TOC, links, sections, and declared assets work
  without raw on-device EPUB parsing.
- [ ] AC-09/TB-09: local PDF seek/range and packaged worker/CMap/font/WASM work
  with no network/file/content fallback.
- [ ] AC-10/TB-10: process death after save restores the latest acknowledged
  locator from native durable state.
- [ ] AC-11/TB-11: same-generation CAS conflict preserves both choices and
  never resolves by time/furthest position.
- [ ] AC-12/TB-12: changed generation cannot mutate canonical cursor or replace
  local pending position.
- [ ] AC-13/TB-13: deleted server media leaves local package readable/removable
  and progress explicitly orphaned, not permanently retrying.
- [ ] AC-14/TB-14: Remove waits for leases and deletes bytes, package, transfer,
  removal, baseline, and pending state without primary-key residue.
- [ ] AC-15/TB-15: account transition verifies both stores purged before new
  binding; wrong-account requests fail before mutation/publication.
- [ ] AC-16/TB-16: shelf-active App Links cannot silently navigate to hosted
  Nexus or expose a stale lease.
- [ ] AC-17/TB-17: in-place higher-version update opens a pre-update V1 package;
  rollback never uninstalls or downgrades versionCode.
- [ ] AC-18/TB-18: empty shelf/reconnect UI is accessible, honest, and contains
  no workspace imitation or remote fetch.
- [ ] Existing Ready audio, Media3 index/cache, `OfflineDownloadSpec`, bridge,
  all current consumers, and network-policy value survive behavior-identically.
- [ ] `dataExtractionRules`, Keystore seal, CSP/host interception, redacted
  logs, and token/JTI scope prove fail-closed account and byte ownership.
- [ ] Old reader orchestration/direct publication writes and any temporary
  adapters are deleted after their replacement proof is sensitive and green.

## Expected files

Cut 1:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/components/{TextDocumentReader,PdfReader}.tsx`
- new `apps/web/src/lib/reader/{DocumentReaderSession,ReaderDocumentSource,ReaderProgressPort}.ts*`
- hosted reader component proofs and existing reader proof ownership in
  `testdata/proofs.json`

Cut 2:

- one additive Alembic migration; `python/nexus/db/models.py`
- new `python/nexus/services/reader_publication.py`; every eligible publication
  call site
- new offline reader-state schema/service/routes
- BFF offline reader-state routes and `apps/web/src/lib/api/proxy.ts` exact
  request/response header allowlists
- migration and real PostgreSQL/MinIO service proofs

Cut 3:

- existing `python/nexus/services/stream_tokens.py`, auth/direct path predicate,
  and JTI proof; new offline package schema/service/routes
- BFF account-binding/token routes; `deploy/hetzner/Caddyfile`
- new `apps/android/app/src/main/java/app/nexus/android/offline/reading/**`
- small shared Android policy primitives; existing
  `SafeProgressiveDownloaderFactory.kt`, `OfflineDownloadSpec`, audio bridge and
  storage identities retained
- Android manifest, data-extraction rules, MainActivity/WebView interception,
  Gradle/Vite generated-asset owner, host/device/release proof
- new `apps/web/src/lib/offlineReading/**`, reading provider/controller,
  Downloads presentation composition, offline reader source/progress adapter,
  and `apps/web/src/offline-reading/**`
- one shared contract vector plus `testdata/{manifest,proofs}.json`, supported
  service faults, existing `python/nexus_test_control/**` capability extension,
  architecture/reader/player/Android/cutover documentation

## Final state

One honest offline-reading plane: native keeps verified immutable artifacts and
pending intent; the shared web reader renders them; the server authorizes and
canonicalizes but never claims device availability. The online reader remains
current, existing audio remains specialized, and later annotations/search/
intelligence remain separate product cuts.

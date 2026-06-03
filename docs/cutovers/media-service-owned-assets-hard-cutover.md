# Media Service And Owned Assets Hard Cutover

Status: Implemented cutover spec  
Date: 2026-06-03  
Owner: Backend media, storage, Oracle, web BFF  
Scope: `python/nexus/services/media.py`, owned media assets, URL ingest, EPUB assets, image proxying, Oracle plate storage, deploy preconditions, docs and tests

## 1. Thesis

`python/nexus/services/media.py` is no longer allowed to be the integration point for every media-adjacent capability. The final state is a hard cutover from a broad media god-service to capability-owned services with explicit storage, auth, route, and lifecycle contracts.

The same rule applies to image and binary asset delivery. Public owned assets and private user media assets are different capabilities. They must use different routes, different auth expectations, and different Next image behavior. The system must not rely on route-local exceptions, image optimizer accidents, hidden fallbacks, or test-only behavior.

This cutover removes legacy lanes. There is no compatibility wrapper, no old X oEmbed path, no permissive Oracle plate storage key contract, no private-media optimization through cookie-dependent routes, and no local hacks to paper over production deployment ordering.

## 2. Goals

1. Split `media.py` into narrow owner modules whose names match the capability they own.
2. Preserve the external product behavior for supported capabilities while deleting unsupported legacy code.
3. Make URL ingest a dispatch boundary, not a place where X, YouTube, EPUB, remote file, enrichment, and storage state all live.
4. Make processing-state transitions single-owner through `media_processing_state.py`.
5. Keep private user media assets private and authenticated.
6. Keep public owned Oracle plate assets public only through an internal-header-protected BFF route.
7. Make owned Oracle plate storage keys content-addressed by contract, enforced in Python and PostgreSQL.
8. Put production Oracle seed-object ordering in deploy/operator code, not in app startup or tests.
9. Replace duplicate/repetitive service patterns with repo-standard abstractions already present in storage, permissions, proxying, and state-machine modules.
10. Update docs so the module map names the real owners after the migration.

## 3. Non-Goals

1. No generic `media_objects` or `media_references` table in this cutover.
2. No cross-user public route for arbitrary media images.
3. No compatibility with historical X oEmbed ingest behavior.
4. No source URL fallback for `oracle_reading_events` payloads after the owned-asset cutover.
5. No broad rewrite of `python/nexus/services/oracle.py` beyond the Oracle plate asset boundary needed here.
6. No change to product-level media semantics unless required to remove legacy behavior.
7. No test-only branches, env flags, fake fallbacks, or lab-only storage hacks.
8. No background repair job that silently fixes missing production storage objects after a request fails.
9. No hidden app-startup mutation that writes required objects to storage.
10. No new routing convention unless it composes with existing BFF proxy and auth middleware conventions.

## 4. Governing Rules

1. The owning module owns the invariant. Routes, tests, or call sites may not patch invariants locally.
2. Storage path builders live in `python/nexus/storage/paths.py`.
3. Storage read integrity uses existing storage client primitives and `read_object_checked` patterns where content verification matters.
4. User media authorization stays DB-side through `can_read_media` and related permission helpers.
5. Public owned assets must not require viewer cookies.
6. Private assets must not be put behind public or bearer-exempt routes.
7. The Next image optimizer may only optimize routes that are cookie-free and safe for unauthenticated optimizer fetches.
8. Production deployment must establish external storage preconditions before DB migrations that expose rows pointing at those objects.
9. Hand-written Alembic migrations are required for schema constraints and data rewrites.
10. Hard cutover means old names, old branches, and old source markers are deleted after data is migrated or confirmed unused.

## 5. Pre-Cutover State

Before this cutover, `media.py` owned too much:

1. Media hydration and listing.
2. Listening-state CRUD.
3. URL ingest dispatch.
4. X ingest.
5. Stale X oEmbed article creation.
6. YouTube ingest.
7. Remote file download and staging.
8. Remote file classification.
9. Upload lifecycle composition.
10. EPUB private asset metadata and bytes.
11. Signed media download URL access.
12. Reingest processing-state reset.
13. Metadata enrichment dispatch helpers.

The file was also a migration catch-all. It contained real production capabilities mixed with dead lanes and duplicate owner logic:

1. `_reset_media_for_reingest` duplicates processing-state ownership.
2. `_download_remote_file` owns outbound HTTP behavior that belongs behind a reusable client boundary.
3. Remote URL ingest stages an object and then calls upload confirmation code that reads and copies storage again.
4. EPUB asset serving follows the right authorization/storage pattern but lives in the wrong service.
5. `create_or_reuse_x_oembed_article` and `_X_OEMBED_TIMEOUT` remain even though active X URL ingest goes through the X API service.
6. Oracle plates are now stored as owned objects, but production deploy ordering and DB storage-key constraints are not yet strong enough.
7. Frontend image behavior correctly separates proxied media images from owned Oracle plates, but the distinction is not fully encoded in docs and tests.

## 6. Final State

`media.py` becomes a narrow media catalog service. It may own:

1. Hydrating media rows into API response models.
2. Listing media visible to a viewer.
3. Shared media row lookup helpers that are genuinely media-catalog concerns.

All other capabilities move to named owner modules:

1. `python/nexus/services/x_ingest.py`
2. `python/nexus/services/youtube_ingest.py`
3. `python/nexus/services/remote_file_ingest.py`
4. `python/nexus/services/remote_file_client.py`
5. `python/nexus/services/epub_assets.py`
6. `python/nexus/services/listening_state.py`
7. `python/nexus/services/media_file_access.py`
8. `python/nexus/services/oracle_plates.py`
9. `python/nexus/services/media_ingest.py`
10. Existing `python/nexus/services/media_processing_state.py`

Routes become transport adapters. Each route should do only request parsing, dependency injection, and response shaping. Business decisions live in services.

The web BFF keeps two explicit image lanes:

1. Private media image lane: `/api/media/image` -> `proxyToFastAPI` -> backend `/media/image`, viewer-authenticated, not optimized by Next Image.
2. Public owned Oracle plate lane: `/api/oracle/plates/[id]` -> `proxyPublicToFastAPI` -> backend `/oracle/plates/{id}`, internal-header-protected, cookie-free, optimized by Next Image through `images.localPatterns`.

## 7. Target Behavior

### 7.1 Media Listing And Hydration

1. A viewer sees the same library entries they can read today.
2. Listing and hydration do not know how X, YouTube, EPUB, or remote files are ingested.
3. Listing and hydration do not contain storage download, upload staging, or external HTTP client logic.
4. Shared response model conversion remains centralized, but capability-specific response shaping moves with the capability owner.

### 7.2 URL Ingest

1. The URL ingest entrypoint classifies the URL and dispatches to the source owner.
2. X URLs go only through `x_ingest.py`.
3. YouTube URLs go only through `youtube_ingest.py`.
4. Remote downloadable files go only through `remote_file_ingest.py`.
5. Unsupported URLs fail closed with a typed domain error that maps to the existing API error shape.
6. There is no X oEmbed fallback, function, timeout constant, source marker, or branch.

### 7.3 Remote File Ingest

1. Remote file fetch policy is centralized in `remote_file_client.py`.
2. Redirect, timeout, content length, MIME sniffing, extension validation, max-byte, and SSRF protections live there.
3. Downloaded content is streamed to the staging object when practical, while hashing and counting bytes.
4. The ingest service does not hold the full remote file in memory unless a small-file explicit threshold is accepted in the owner contract.
5. Upload confirmation does not perform an avoidable storage read/copy round trip for objects that were already staged by remote ingest.
6. The final media row and storage owner row are committed atomically with the database-side metadata that points at the staged/final object.

### 7.4 X Ingest

1. X ingest uses the existing X API thread/article path.
2. Existing X API error behavior remains fail-closed.
3. Source records created after this cutover use only supported source markers.
4. Historical `x_oembed_article` data is migrated or proven absent before the source marker is removed.
5. No oEmbed compatibility route exists after the cutover.

### 7.5 YouTube Ingest

1. YouTube ingest lives in `youtube_ingest.py`.
2. YouTube-specific URL parsing, metadata, transcript, and media creation rules do not remain in `media.py`.
3. Shared ingest response models are imported from a neutral schema location, not duplicated.

### 7.6 EPUB Assets

1. EPUB asset authorization remains private and viewer-bound.
2. The service opens a DB session only to authorize and resolve immutable storage metadata.
3. The storage object is read after the DB session is released.
4. Missing, unauthorized, and corrupted assets map to explicit errors.
5. The BFF route `/api/media/[id]/assets/[...assetKey]` remains authenticated.
6. EPUB assets are not added to `next.config.ts` image optimization patterns.

### 7.7 Listening State

1. Listening-state read/write behavior lives in `listening_state.py`.
2. The API route imports only listening-state service functions for this capability.
3. The capability uses existing viewer authorization helpers instead of duplicating media visibility checks.

### 7.8 Processing State

1. `media_processing_state.py` owns every processing-state transition.
2. Reingest reset is a named state-machine operation.
3. Timestamps come from one owner and are consistent with existing DB time usage.
4. Attempt counter semantics are documented and tested at the state-machine layer.
5. No route or ingest owner writes status fields ad hoc.

### 7.9 Private Media Images

1. `/api/media/image` remains an authenticated media proxy.
2. It requires the viewer context for protected media.
3. Frontend `MediaImage` keeps proxied images unoptimized.
4. `/api/media/image` is not added to `images.localPatterns`.
5. Any component that needs protected media images uses the proxied image contract explicitly.

### 7.10 Public Owned Oracle Plates

1. Oracle plate images are object-backed and content-addressed.
2. `/api/oracle/plates/[id]` is cookie-free at the BFF boundary.
3. The BFF injects the internal header and strips viewer cookies before calling FastAPI.
4. FastAPI allows the public plate route only when the internal header is valid.
5. The route supports cache validators correctly.
6. The Next image optimizer may optimize this route because it is public, owned, and cookie-free.
7. Missing storage objects are deployment/data-integrity failures, not runtime fallbacks.

## 8. Architecture

### 8.1 Service Ownership

Final owner map:

| Capability | Owner |
| --- | --- |
| Media listing and hydration | `python/nexus/services/media.py` |
| URL dispatch | `python/nexus/services/media_ingest.py` |
| X URL ingest | `python/nexus/services/x_ingest.py` |
| YouTube URL ingest | `python/nexus/services/youtube_ingest.py` |
| Remote downloadable file ingest | `python/nexus/services/remote_file_ingest.py` |
| Outbound remote file HTTP policy | `python/nexus/services/remote_file_client.py` |
| EPUB private assets | `python/nexus/services/epub_assets.py` |
| Listening state | `python/nexus/services/listening_state.py` |
| Signed media file access | `python/nexus/services/media_file_access.py` |
| Processing-state transitions | `python/nexus/services/media_processing_state.py` |
| Oracle plate storage and bytes | `python/nexus/services/oracle_plates.py` |
| Storage path construction | `python/nexus/storage/paths.py` |
| Storage client operations | `python/nexus/storage/client.py` |
| Public BFF proxying | `apps/web/src/lib/api/proxy.ts` |
| Frontend image URL contracts | `apps/web/src/lib/media/imageProxy.ts` and Oracle URL helpers |

### 8.2 Layering

Layering is strict:

1. API routes parse transport and call services.
2. Services enforce capability invariants.
3. Permission helpers answer user visibility questions.
4. Storage paths build keys, but do not authorize users.
5. Storage clients read, write, stream, copy, sign, and verify objects.
6. Web BFF routes bridge browser/Next/FastAPI behavior.
7. Components consume frontend contracts and do not infer backend route semantics.

Forbidden dependencies:

1. `media.py` importing `httpx` after remote client extraction.
2. `media.py` importing X oEmbed helpers after X cutover.
3. API routes writing processing-state fields directly.
4. Components building protected media URLs by hand.
5. Backend public routes trusting viewer cookies.
6. Migrations calling object storage.
7. Runtime app startup seeding production storage.

### 8.3 Data And Storage Flow

Remote downloadable file ingest:

1. API route receives URL request.
2. Ingest dispatcher classifies the URL.
3. `remote_file_ingest.py` requests a staging object path from storage path helpers.
4. `remote_file_client.py` fetches the URL under outbound policy.
5. The response body is streamed into object storage while computing size and hash.
6. The ingest owner creates or reuses the media DB row and storage metadata.
7. The processing-state owner transitions the media row.
8. Downstream workers continue from the canonical media row.

EPUB asset read:

1. API route receives viewer-authenticated asset request.
2. `epub_assets.py` authorizes through DB permissions.
3. The service resolves storage key, content type, byte size, and digest metadata.
4. DB session closes.
5. Storage read verifies the object against metadata.
6. Route returns bytes with content type and cache headers appropriate for private assets.

Oracle plate read:

1. Browser or Next optimizer requests `/api/oracle/plates/[id]`.
2. BFF strips viewer credentials and injects only the configured internal header.
3. FastAPI internal-header middleware authorizes route access.
4. `oracle_plates.py` resolves DB metadata and reads object storage.
5. Route returns immutable cache headers, validators, and bytes.

## 9. Capability Contracts

### 9.1 `media.py`

Allowed public functions:

1. `hydrate_media(...)`
2. `list_media_for_viewer(...)`
3. Narrow lookup helpers that return media catalog records.

Disallowed responsibilities:

1. External HTTP clients.
2. X-specific article creation.
3. YouTube-specific parsing or transcript logic.
4. Remote file staging.
5. EPUB asset reads.
6. Listening-state CRUD.
7. Direct processing-state field mutation.
8. Oracle plate storage or image serving.

### 9.2 `media_ingest.py`

This module owns source dispatch only.

Contract:

```python
def enqueue_media_from_url(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    request_id: str | None = None,
) -> MediaIngestResult:
    ...
```

Rules:

1. It may classify URL shape.
2. It may call source-specific services.
3. It may normalize returned service results into the API response contract.
4. It may not download remote bytes.
5. It may not contain X, YouTube, or file-specific creation logic.

### 9.3 `x_ingest.py`

Contract:

```python
def create_or_reuse_x_author_thread_article(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    request_id: str | None = None,
) -> MediaIngestResult:
    ...
```

Rules:

1. This is the only supported X ingest path.
2. It uses the existing X API client and thread-author policy.
3. It owns X-specific dedupe.
4. It owns X-specific contributor credit composition.
5. It does not import or call oEmbed.

Deletion criteria:

1. Remove `create_or_reuse_x_oembed_article`.
2. Remove `_X_OEMBED_TIMEOUT`.
3. Remove or migrate the `x_oembed_article` source marker.
4. Remove tests that assert oEmbed behavior.
5. Add tests proving X URL ingest dispatches to the X API path only.

### 9.4 `youtube_ingest.py`

Contract:

```python
def create_or_reuse_youtube_media(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    request_id: str | None = None,
) -> MediaIngestResult:
    ...
```

Rules:

1. YouTube URL parsing belongs here.
2. YouTube metadata and transcript rules belong here.
3. Shared media row creation helpers may be imported from neutral modules.
4. No route or dispatcher duplicates YouTube URL parsing.

### 9.5 `remote_file_client.py`

Contract:

```python
@dataclass(frozen=True)
class RemoteFileFetchResult:
    storage_key: str
    content_type: str
    byte_size: int
    sha256: str
    final_url: str
    etag: str | None

def fetch_to_storage(
    *,
    url: str,
    storage_key: str,
    storage: StorageClientBase,
    expected_kind: RemoteFileKind | None,
    request_id: str | None = None,
) -> RemoteFileFetchResult:
    ...
```

Rules:

1. It validates scheme before network access.
2. It rejects private, loopback, link-local, and metadata-service addresses before and after redirects.
3. It enforces max redirects.
4. It enforces connect, read, and total timeouts.
5. It enforces max bytes while streaming.
6. It validates content type and extension through one policy.
7. It hashes bytes while writing.
8. It never creates media rows.
9. It never commits DB transactions.

Required storage client support:

```python
def put_object_stream(
    self,
    key: str,
    body: BinaryIO | Iterable[bytes],
    *,
    content_type: str,
    byte_size: int | None = None,
    metadata: Mapping[str, str] | None = None,
) -> StorageWriteResult:
    ...
```

Streaming storage write support is part of the target state. Holding arbitrary remote downloads in memory is not an accepted implementation path for this cutover.

### 9.6 `remote_file_ingest.py`

Contract:

```python
def ingest_remote_file_url(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    request_id: str | None = None,
) -> MediaIngestResult:
    ...
```

Rules:

1. It allocates staging/final storage keys through `storage.paths`.
2. It calls `remote_file_client.fetch_to_storage`.
3. It creates or reuses the media row.
4. It records storage metadata once.
5. It calls upload lifecycle only through an API that accepts already-staged object metadata.
6. It does not re-read a staged object just to copy it again.
7. It calls `media_processing_state` for transitions.

### 9.7 `epub_assets.py`

Contract:

```python
@dataclass(frozen=True)
class EpubAssetOut:
    data: bytes
    content_type: str
    byte_size: int

def get_epub_asset_for_viewer(
    *,
    session_factory: Callable[[], Session],
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
    storage: StorageClientBase | None = None,
) -> EpubAssetOut:
    ...
```

Rules:

1. It owns EPUB resource lookup.
2. It authorizes with the same media visibility helper used elsewhere.
3. It closes DB sessions before reading storage.
4. It verifies storage reads against DB metadata.
5. It exposes a stable private asset response contract to routes.
6. It is the only backend module imported by the EPUB asset route for this capability.

### 9.8 `listening_state.py`

Contract:

```python
def get_listening_state_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> ListeningStateOut:
    ...

def update_listening_state_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    patch: ListeningStatePatch,
) -> ListeningStateOut:
    ...
```

Rules:

1. It owns validation of media visibility for listening state.
2. It owns create/update semantics.
3. It does not know how the media was ingested.
4. It does not duplicate response hydration beyond the listening-state response model.

### 9.9 `media_processing_state.py`

New required operation:

```python
def reset_for_reingest(
    *,
    db: Session,
    media: Media,
    reason: str,
    now: datetime | None = None,
) -> Media:
    ...
```

Rules:

1. It is the only operation that resets extraction/processing fields for reingest.
2. It decides whether attempt counters reset or increment.
3. It uses the same timestamp source as other processing transitions.
4. It emits any existing observability/event hooks used by other transitions.
5. `_reset_media_for_reingest` is deleted from `media.py`.

### 9.10 `oracle_plates.py`

Contract:

```python
@dataclass(frozen=True)
class OraclePlateBytes:
    data: bytes
    content_type: str
    byte_size: int
    sha256: str
    etag: str

@dataclass(frozen=True)
class OraclePlateMetadata:
    image_id: UUID
    storage_key: str
    content_type: str
    byte_size: int
    sha256: str
    etag: str

def oracle_plate_url(plate_id: str) -> str:
    ...

def get_oracle_plate_metadata(
    *,
    session_factory: Callable[[], Session],
    image_id: UUID,
) -> OraclePlateMetadata:
    ...

def read_oracle_plate_bytes(
    metadata: OraclePlateMetadata,
    *,
    storage_client: StorageClientBase | None = None,
) -> OraclePlateBytes:
    ...

def get_oracle_plate_bytes(
    *,
    session_factory: Callable[[], Session],
    image_id: UUID,
    storage_client: StorageClientBase | None = None,
) -> OraclePlateBytes:
    ...
```

Rules:

1. It owns Oracle plate URL construction.
2. It owns DB metadata lookup for plate storage keys.
3. It reads storage through integrity-checked storage helpers.
4. It does not authorize viewers.
5. It assumes route-level internal-header protection.
6. It returns missing object as an integrity error.
7. It releases the DB session before reading object storage.
8. It can answer matching ETags from validated metadata without reading storage.
9. It does not fall back to fixture URLs or bundled files.

### 9.11 `proxyPublicToFastAPI`

Contract:

1. Public BFF proxying is separate from authenticated BFF proxying.
2. It injects the internal header.
3. It forwards cache validators needed for image caching.
4. It strips cookies and authorization headers from the browser request.
5. It preserves backend status, content type, ETag, cache-control, and 304 semantics.
6. It never forwards a response body on 304.

Testing requirement:

```typescript
export function proxyPublicToFastAPIWithDeps(
  req: NextRequest,
  path: string,
  deps: ProxyDeps,
): Promise<Response> {
  ...
}
```

If an equivalent dependency-injection helper already exists, use it. The goal is direct unit coverage without brittle module-global fetch mocks.

### 9.12 Image Component Contract

1. `MediaImage kind="proxied"` remains unoptimized.
2. Owned Oracle plate images use a dedicated owned-asset URL helper or typed component prop.
3. Components do not build `/api/media/image` or `/api/oracle/plates` strings ad hoc.
4. `next.config.ts` keeps `images.localPatterns` limited to owned public image routes.

## 10. API Design

### 10.1 Existing Public Browser Routes

These routes stay stable:

1. `GET /api/media/image`
2. `GET /api/media/[id]/assets/[...assetKey]`
3. `GET /api/oracle/plates/[id]`

Route contracts after cutover:

| Route | Auth | Optimizable | Backend target | Owner |
| --- | --- | --- | --- | --- |
| `/api/media/image` | Viewer session | No | `/media/image` | `media image proxy` |
| `/api/media/[id]/assets/[...assetKey]` | Viewer session | No | `/media/{id}/assets/{assetKey}` | `epub_assets.py` |
| `/api/oracle/plates/[id]` | Internal header only | Yes | `/oracle/plates/{id}` | `oracle_plates.py` |

### 10.2 Backend Routes

Backend routes should be thin:

1. `python/nexus/api/routes/media.py` imports `epub_assets.py` for EPUB assets.
2. `python/nexus/api/routes/media.py` imports `listening_state.py` for listening state.
3. `python/nexus/api/routes/media.py` imports `media_ingest.py` or source owner modules for URL ingest.
4. `python/nexus/api/routes/oracle.py` imports `oracle_plates.py` for plate bytes and URLs.

### 10.3 Error Contracts

Errors should be typed at service boundaries and mapped by routes:

1. Unauthorized private media asset -> 404 or the existing private-media not-found shape.
2. Missing private media asset row -> existing private-media not-found shape.
3. Missing private media storage object -> integrity/storage error, not fallback bytes.
4. Missing Oracle plate DB row -> 404.
5. Missing Oracle plate storage object -> 500-class integrity error with production logs.
6. Unsupported URL ingest source -> typed unsupported-source error.
7. Remote URL blocked by SSRF policy -> typed rejected-remote-url error.
8. Remote URL too large -> typed max-size error.
9. X API unavailable -> existing fail-closed X ingest error.

## 11. Data Model And Migrations

### 11.1 Oracle Plate Storage Key Constraint

The DB contract must match the Python path builder.

Required PostgreSQL check:

```sql
storage_key ~ '^oracle/plates/[0-9a-f]{64}\.(jpg|png|webp)$'
```

Required model-level expectation:

1. `storage_key` is non-null.
2. `content_type` is non-null.
3. `byte_size` is non-null and positive.
4. `sha256` is non-null and exactly 64 lowercase hex characters.
5. `storage_key` extension matches the allowed content-type family.

Implementation:

1. Add a new head migration. Do not edit already-applied migration `0127`.
2. Backfill or reject any rows that fail the stricter constraint before adding it.
3. Update model `CheckConstraint`.
4. Update migration tests that currently allow weak fixture keys.

### 11.2 X oEmbed Source Marker

Before deleting `x_oembed_article`:

1. Query production and local data for rows with this marker.
2. If zero, delete marker and code in the same cutover.
3. If non-zero, add an explicit migration that rewrites them to the supported X API source marker only if the target semantics are equivalent.
4. If the semantics are not equivalent, stop and write a one-time data migration plan. Do not keep runtime compatibility code.

### 11.3 Generic Media Objects

No generic media storage ownership table is introduced here.

Rationale:

1. Existing typed owner tables already encode different lifecycles: `media_file`, `epub_resources`, and `oracle_corpus_images`.
2. Private media, EPUB internals, and public Oracle plates have different auth and cache contracts.
3. A generic table would be a storage architecture project, not a safe completion of the `media.py` migration.

## 12. Deploy And Operations

### 12.1 Oracle Seed Object Ordering

Production deployment must ensure Oracle seed objects before migrations that expose DB rows requiring those objects.

Final deploy ordering:

1. Build image.
2. Start/prepare one-shot application container with production storage env.
3. Run Oracle seed-object command.
4. Run Alembic migrations.
5. Start API and worker.
6. Run health checks and smoke tests.

Required command owner:

1. Add a production-safe script, for example `python/scripts/ensure_oracle_seed_objects.py`.
2. The script calls `ensure_oracle_seed_objects(get_storage_client())`.
3. The script writes only known Oracle seed objects.
4. The script does not mutate DB rows.
5. The script is idempotent.

`deploy/hetzner/deploy.sh` must call this command before `alembic upgrade head`.

### 12.2 Operator Behavior

If the seed command fails:

1. Deployment stops.
2. Migrations do not run.
3. API and worker do not restart into a half-cutover state.
4. Logs identify the storage key and failure class.

If a runtime Oracle plate object is missing:

1. Request fails as data-integrity failure.
2. The service logs the plate id and storage key.
3. The service does not synthesize a response.

### 12.3 Environment Ownership

1. Backend storage credentials belong to backend/deploy env ownership.
2. Frontend public URL and BFF env belong to frontend env ownership.
3. Shared env sync scripts must not accept frontend-only keys in backend-only env files.
4. Any deploy script changes must pass the existing env validator scripts.

## 13. Duplicate Patterns To Reuse Or Consolidate

### 13.1 Storage Paths

Use `python/nexus/storage/paths.py` for:

1. Media original paths.
2. Upload staging paths.
3. EPUB asset paths.
4. Oracle plate paths.

Do not build storage keys with ad hoc f-strings in services or routes.

### 13.2 Storage Integrity Reads

Reuse the checked-read pattern already used by EPUB assets and Oracle assets:

1. Resolve metadata under DB authorization.
2. Release DB session when safe.
3. Read object storage through storage client helpers.
4. Verify expected size/hash when metadata exists.

### 13.3 Permission Helpers

Use existing permission helpers:

1. `can_read_media` for viewer media visibility.
2. Internal-header middleware for public owned asset BFF access.
3. Do not duplicate visibility SQL in listening state or EPUB asset services.

### 13.4 Processing-State Owner

Use `media_processing_state.py` for:

1. Begin extraction.
2. Mark extracted.
3. Mark failed.
4. Reset for reingest.
5. Any future transition.

Delete direct status writes outside the owner after equivalent owner functions exist.

### 13.5 BFF Proxy Helpers

Use:

1. `proxyToFastAPI` for viewer-authenticated FastAPI calls.
2. `proxyPublicToFastAPI` for cookie-free owned public assets.

Do not add route-local proxy code that reconstructs these behaviors.

### 13.6 Frontend Image Helpers

Use:

1. `buildMediaImageProxySrc` for protected media image URLs.
2. A dedicated Oracle plate URL helper for owned public plate images.
3. `MediaImage` kind semantics for optimization behavior.

Do not build image URLs inline in components.

### 13.7 Enrichment Dispatch

If metadata enrichment dispatch remains duplicated between services and task modules, select one owner:

1. Task modules own queue dispatch mechanics.
2. Services own the domain decision of whether enrichment is needed.
3. Routes do neither.

After selection, remove duplicate helper names from `media.py`.

## 14. File Plan

### 14.1 New Files

1. `python/nexus/services/media_ingest.py`
2. `python/nexus/services/x_ingest.py`
3. `python/nexus/services/youtube_ingest.py`
4. `python/nexus/services/remote_file_ingest.py`
5. `python/nexus/services/remote_file_client.py`
6. `python/nexus/services/epub_assets.py`
7. `python/nexus/services/listening_state.py`
8. `python/nexus/services/media_file_access.py`
9. `python/nexus/services/oracle_plates.py`
10. `python/nexus/services/web_article_indexing.py`
11. `python/scripts/ensure_oracle_seed_objects.py`
12. `migrations/alembic/versions/0128_oracle_plate_storage_key_contract.py`
13. `python/tests/test_media_processing_state.py`
14. `python/tests/test_oracle_seed_objects.py`
15. `apps/web/src/lib/media/oraclePlateImage.ts`
16. `apps/web/src/lib/media/oraclePlateImage.test.ts`

### 14.2 Modified Files

1. `python/nexus/services/media.py`
2. `python/nexus/services/media_processing_state.py`
3. `python/nexus/services/upload.py`
4. `python/nexus/api/routes/media.py`
5. `python/nexus/api/routes/oracle.py`
6. `python/nexus/db/models.py`
7. `python/nexus/storage/client.py`
8. `python/nexus/storage/paths.py`
9. `python/nexus/services/contributor_credits.py`
10. `python/nexus/oracle/seed_objects.py`
11. `deploy/hetzner/deploy.sh`
12. `apps/web/src/lib/api/proxy.ts`
13. `apps/web/src/components/ui/MediaImage.tsx`
14. `apps/web/src/components/ui/MediaImage.test.tsx`
15. `apps/web/src/app/api/media/image/route.ts`
16. `apps/web/src/app/api/media/[id]/assets/[...assetKey]/route.ts`
17. `apps/web/src/app/api/oracle/plates/[id]/route.ts`
18. `apps/web/next.config.ts`
19. `apps/web/src/next-config.test.ts` or equivalent config test owner
20. `e2e/tests/oracle-plate-image.csp.spec.ts`
21. `python/tests/test_migrations.py`
22. `python/tests/test_oracle_plate_route.py`
23. `python/tests/test_auth.py`
24. `docs/architecture.md`
25. `docs/modules/storage.md`
26. `docs/modules/oracle.md`
27. `docs/modules/library.md`

### 14.3 Deleted Code

1. `create_or_reuse_x_oembed_article`
2. `_X_OEMBED_TIMEOUT`
3. `x_oembed_article` source marker after migration/proof
4. `_reset_media_for_reingest`
5. EPUB asset dataclasses and helpers from `media.py`
6. Listening-state helpers from `media.py`
7. Remote download helpers from `media.py`
8. YouTube ingest helpers from `media.py`
9. X ingest helpers from `media.py`
10. Ad hoc readable status sets outside `media_processing_state.py`
11. Inline Oracle plate URL builders outside `oracle_plates.py` or frontend helper

## 15. Implementation Sequence

### Phase 0: Guardrails

1. Add or update tests that lock the desired final behavior.
2. Add grep checks in review notes for code that must disappear.
3. Confirm whether any persisted rows use `x_oembed_article`.
4. Confirm next Alembic revision id.
5. Confirm production deploy command can access object storage before migrations.

### Phase 1: Oracle Owned Asset Hardening

1. Add production-safe Oracle seed-object script.
2. Wire deploy script to run seed before Alembic.
3. Add direct unit tests for `ensure_oracle_seed_objects`.
4. Add strict Oracle plate storage-key DB constraint in a new migration.
5. Update model constraint and migration tests.
6. Add `proxyPublicToFastAPI` unit coverage for header injection, credential stripping, cache validators, 304 behavior, and backend error propagation.
7. Add Next config test proving only `/api/oracle/plates/**` is optimizable for this lane.

### Phase 2: Processing-State Ownership

1. Add `reset_for_reingest` to `media_processing_state.py`.
2. Move attempt counter and timestamp rules into this owner.
3. Replace `_reset_media_for_reingest` call sites.
4. Delete `_reset_media_for_reingest`.
5. Add state-machine tests.

### Phase 3: EPUB And Listening State Extraction

1. Move EPUB asset dataclasses and helpers to `epub_assets.py`.
2. Update media route imports.
3. Move listening-state behavior to `listening_state.py`.
4. Update route imports.
5. Add service tests that assert authorization and storage-session behavior.
6. Confirm `media.py` no longer contains EPUB or listening-state capability code.

### Phase 4: Remote File Ingest Extraction

1. Add `remote_file_client.py` with outbound HTTP policy tests.
2. Extend storage client for streaming writes or implement the approved temporary-file production path.
3. Add `remote_file_ingest.py`.
4. Add an upload lifecycle entrypoint that accepts already-staged metadata.
5. Remove duplicate storage read/copy from remote ingest.
6. Delete remote HTTP helpers from `media.py`.
7. Add integration tests for successful ingest, oversized response, blocked host, redirect-to-private-host, MIME mismatch, and storage write failure.

### Phase 5: Source Ingest Extraction

1. Add `x_ingest.py`.
2. Move active X API ingest logic.
3. Delete X oEmbed code after data proof/migration.
4. Add `youtube_ingest.py`.
5. Move YouTube logic.
6. Add `media_ingest.py` dispatch owner.
7. Update API route to call dispatch owner only.
8. Add tests proving URL classification selects the right owner and unsupported URLs fail closed.

### Phase 6: Media File Access Extraction

1. Move signed download URL behavior to `media_file_access.py`.
2. Keep permission checks through existing helpers.
3. Update routes and tests.
4. Confirm `media.py` remains catalog/hydration only.

### Phase 7: Docs And Cleanup

1. Update `docs/architecture.md` module map.
2. Populate `docs/modules/storage.md`.
3. Populate `docs/modules/oracle.md`.
4. Update `docs/modules/library.md` if library image/media behavior is documented there.
5. Remove stale comments that describe old media god-service ownership.
6. Run targeted verification.

## 16. Acceptance Criteria

### 16.1 Code Shape

1. `media.py` no longer imports `httpx`.
2. `media.py` no longer contains EPUB asset dataclasses or asset read helpers.
3. `media.py` no longer contains listening-state CRUD.
4. `media.py` no longer contains source-specific X or YouTube ingest internals.
5. `media.py` no longer contains remote file download/staging internals.
6. `media.py` no longer contains `_reset_media_for_reingest`.
7. `media_processing_state.py` has tested reingest reset ownership.
8. API routes import capability owner modules, not helper fragments from `media.py`.

### 16.2 Deleted Legacy

These searches return no production code hits:

```bash
rg "create_or_reuse_x_oembed_article|_X_OEMBED_TIMEOUT|x_oembed_article" python
rg "_reset_media_for_reingest" python
```

If `x_oembed_article` appears only in a historical migration, that is acceptable and must be documented in the migration comment.

### 16.3 Asset Contracts

1. `/api/media/image` stays authenticated and unoptimized.
2. `/api/oracle/plates/[id]` stays cookie-free and optimized.
3. `apps/web/next.config.ts` includes `/api/oracle/plates/**` and does not include `/api/media/image`.
4. Public BFF proxy unit tests cover header and credential behavior.
5. FastAPI auth tests cover internal-header acceptance and rejection.
6. Oracle route tests cover 200, 304, 404, invalid internal header, missing object, and cache headers.

### 16.4 Storage And Migration

1. Oracle plate storage key DB constraint requires `oracle/plates/<64 lowercase hex>.<jpg|png|webp>`.
2. Model constraints match migration constraints.
3. Storage path builder tests match DB constraint examples.
4. Production deploy script runs Oracle seed objects before Alembic.
5. Seed-object script is idempotent and tested.
6. No migration performs network or storage I/O.

### 16.5 Remote File Ingest

1. SSRF protections reject private network targets before and after redirects.
2. Max byte enforcement works while streaming.
3. Hash and byte size recorded in DB match stored object.
4. Remote ingest does not copy an already-staged object through an unnecessary second storage read.
5. Storage failures leave no committed media row pointing at an absent object.

### 16.6 Docs

1. `docs/architecture.md` no longer describes `media.py` as the owner of all media-adjacent behavior.
2. `docs/modules/storage.md` documents storage owner tables, path builders, and public/private asset lanes.
3. `docs/modules/oracle.md` documents Oracle plate owned asset flow and deploy seed precondition.
4. Route spellings are explicit: frontend BFF route names and backend FastAPI route names are not conflated.

## 17. Verification Commands

Targeted Python checks:

```bash
python -m pytest \
  python/tests/test_oracle_plate_route.py \
  python/tests/test_oracle_seed_objects.py \
  python/tests/test_migrations.py \
  python/tests/test_media_processing_state.py \
  python/tests/test_epub_asset_lifetime.py \
  python/tests/test_from_url.py \
  python/tests/test_storage.py \
  python/tests/test_upload.py
```

Targeted frontend checks:

```bash
cd apps/web
./node_modules/.bin/vitest run \
  src/lib/api/proxy.test.ts \
  src/lib/media/oraclePlateImage.test.ts \
  src/components/ui/MediaImage.test.tsx \
  src/next-config.test.ts
```

Targeted E2E:

```bash
cd apps/web
./node_modules/.bin/playwright test ../../e2e/tests/oracle-plate-image.csp.spec.ts
```

Static cutover checks:

```bash
rg "create_or_reuse_x_oembed_article|_X_OEMBED_TIMEOUT|x_oembed_article" python
rg "_reset_media_for_reingest" python
rg "httpx" python/nexus/services/media.py
rg "EpubAsset|epub_asset|listening_state" python/nexus/services/media.py
```

Deploy-script check:

```bash
rg "ensure_oracle_seed_objects|alembic upgrade" deploy/hetzner/deploy.sh
```

## 18. Key Decisions

1. The cutover is hard. Old code is deleted after data proof/migration.
2. Public owned assets and private user media assets remain separate lanes.
3. The Next image optimizer is allowed only for cookie-free owned public assets.
4. Object storage preconditions are deploy/operator concerns, not DB migration side effects.
5. Missing owned objects are integrity failures.
6. DB constraints must be as strict as Python storage path builders.
7. `media.py` becomes a catalog/hydration owner, not an ingest or asset owner.
8. Source ingest modules own source-specific dedupe and metadata behavior.
9. Remote HTTP policy is a reusable client concern.
10. Processing-state changes are state-machine operations.
11. No generic storage ownership abstraction is introduced until there is a separate design for all typed owner tables.

## 19. Composition With Other Systems

### 19.1 Library

Library screens consume media listing and image contracts. They do not need to know whether a media item came from X, YouTube, upload, EPUB, or remote URL ingest. They choose the correct image path by capability:

1. Protected media image -> proxied media image helper.
2. Oracle owned plate -> Oracle owned asset helper.

### 19.2 Reader

Reader EPUB rendering uses the private EPUB asset BFF route. It relies on `epub_assets.py` for DB authorization and storage integrity. Reader code must not reuse the Oracle public asset lane for EPUB internals.

### 19.3 Oracle

Oracle reading events may embed owned plate URLs in payloads. The URL is the public BFF URL, not a storage URL and not a legacy fixture URL. The backend event producer imports the Oracle plate URL helper, not an ad hoc path literal.

### 19.4 Auth

Auth middleware continues to gate public owned asset backend access through the internal header. Viewer auth is not required on the backend Oracle plate route because the BFF has already converted public browser access into an internal service call.

Private media routes continue to use viewer auth and `get_viewer`.

### 19.5 Next Image

Next image optimizer can request Oracle plate BFF URLs without cookies. It cannot request protected media BFF URLs because optimizer fetches do not preserve viewer session semantics.

### 19.6 Storage

Storage remains a dumb object layer plus integrity metadata. It does not know viewer ownership. Viewer ownership is DB-side and service-side.

### 19.7 Deploy

Deploy must be aware that DB rows can reference object storage keys. This is why Oracle seed objects are an explicit pre-migration step.

## 20. Rejected Fixes

1. Add `/api/media/image` to `images.localPatterns`.
2. Make `/media/image` public to satisfy Next optimizer.
3. Add a fallback from missing Oracle storage object to a bundled image.
4. Keep X oEmbed as a hidden fallback.
5. Leave `x_oembed_article` as an accepted source marker.
6. Leave `_reset_media_for_reingest` in `media.py` as a convenience wrapper.
7. Add a generic `media_objects` table as part of this cutover.
8. Stream remote files into memory and call that production-ready.
9. Add a deploy comment without an executable seed step.
10. Run Oracle seed objects from FastAPI startup.
11. Edit migration `0127` instead of adding a new migration.
12. Duplicate BFF proxy code in route files.
13. Duplicate `can_read_media` SQL in new services.

## 21. SME Review Checklist

1. Does every capability have exactly one owner module?
2. Does each owner module enforce its own invariants?
3. Does the route layer remain transport-only?
4. Are public and private asset lanes impossible to confuse?
5. Does every optimized image route work without cookies?
6. Are storage keys built only through path helpers?
7. Do DB constraints match Python path constraints?
8. Does deploy establish external storage preconditions before migrations?
9. Can a missing storage object be detected as corruption instead of hidden?
10. Are all legacy names removed from production code?
11. Are tests asserting owner contracts rather than implementation accidents?
12. Are docs updated to match the final architecture?

## 22. Done Definition

The cutover is done when:

1. `media.py` is small enough to describe as media catalog and hydration only.
2. Every moved capability has service-level tests.
3. Every affected route has route-level tests or existing route coverage updated.
4. Frontend image tests prove protected media remains unoptimized and owned Oracle plates remain optimizable.
5. The deploy script has an executable Oracle seed-object step before Alembic.
6. The Oracle plate DB constraint is strict and tested.
7. Dead X oEmbed code and markers are gone or present only in immutable historical migrations.
8. Targeted verification passes.
9. Documentation names the new owners and contracts.
10. There are no feature flags, fallbacks, compatibility wrappers, or route-local hacks left behind.

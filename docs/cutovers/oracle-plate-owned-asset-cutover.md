# Oracle plate owned-asset cutover

**Status:** **Implemented** on branch `oracle-plate-owned-asset` (Rev 4). All source + tests landed; backend ruff/pyright clean, 311 backend tests green (oracle/plate-route/auth/image_proxy/sanitize/media), migration up→down→up verified; frontend eslint `next/image` gate green, 533 unit + 831 browser green; e2e CSP spec + MinIO seed written (runs in CI infra, not executed locally). Fixture sha256 = `451cc39a41ea2a2b1bb0dccc9e58df2c7908bd0bac67d219878bf767234a8fa3` (9382 bytes). One minimalism deviation from the §8.5 sketch: `get_oracle_plate_bytes` captures the 4 metadata primitives as locals inside the session scope instead of a one-use `_PlateMeta` dataclass. **Rev 3** (rev-2: review findings 1–7; rev-3: auth-lane wording hardened to "new prefix lane after `_verify_internal_header`, before bearer extraction"; deploy step 1 gated on `head_object` + size/sha verification; legacy-fidelity consequence kept plain; event FK confirmed `reading_id`). See §0.
**Rev 5 (standards-review remediation).** A 48-agent adversarial review (12 dimensions → per-finding verify → synthesis) found the implementation substantively correct — core goal met, no security or AC-blocking defect. Fixed 8 verified items + 4 nits, all re-verified green: (1) an ESLint flat-config **clobber** that silently dropped the `next/image` import ban for the 7 shell-module globs (Block B redeclared `no-restricted-imports` with only `patterns`, replacing Block A's `paths`) — single-sourced a `NEXT_IMAGE_BAN` const applied in both blocks (probe-confirmed); (2) the plate-route tests had **no pytest tier marker** (skipped by every marker-scoped CI lane) and monkeypatched our own service (§7 internal-boundary mock) — re-tiered: pure service tests `@pytest.mark.unit`, route tests `@pytest.mark.integration` against a real test DB + the sanctioned `FakeStorageClient` seam (`patch nexus.services.oracle.get_storage_client`), asserting 200/headers/ETag, 304, and integrity-mismatch→500 `E_STORAGE_ERROR`; (3) the migration test now asserts the four CHECKs + NOT NULL actually **fire** (negative-insert IntegrityError per constraint, mutation-tested); (4) `MediaImage` test now asserts the owned-optimized vs proxied-`unoptimized` distinction (mock forwards `data-unoptimized`); (5) route `If-None-Match` reuses the conformant `etags_match` (weak validators/lists/`*`); (6) single-owner `ext_for_content_type`/`PLATE_CONTENT_TYPE_TO_EXT` in `storage/paths.py` (collapses the build-script content-type→ext map + the path-builder allowlist); (7) added unit tests for `read_object_checked`'s silent-corruption (equal-size/wrong-sha) + over/under-size branches and `build_oracle_plate_storage_path` reject branches; (8) plus nits — `OraclePlateBytes` `frozen=True`, inlined one-use `ORACLE_PLATE_ROUTE`, seed script reuses `oracle_plate_path`, removed two avoidable `jsx-a11y/alt-text` disables (destructure `alt`), dropped a dead `?? null`. Left as-is (verifier-grounded in cleanliness/simplicity): the sibling-proxy duplication in `proxyPublicToFastAPI`, the streaming time-to-first-byte timeout, and the 304-reads-full-bytes path (all match spec design / "leave small local duplication"). Re-verified: ruff + pyright clean; 729 backend unit + affected integration green; migration-0127 schema-contract test green; 831 browser + eslint green.
**Owner:** TBD.
**Supersedes:** the deferred line "the oracle `images.remotePatterns` gap (pre-existing, non-CSP)" in `docs/cutovers/csp-and-security-headers-hardening.md:23` — that line is a **misdiagnosis** and is corrected here.

---

## 0. Rev-2 corrections (review findings)

1. **Auth lane.** The plate route must use a **new prefix lane placed *after* the internal-header check** (`middleware.py:160`), alongside `INTERNAL_ONLY_PATHS`/`EXTENSION_AUTH_PATHS` — **not** the stream/SSE block (`:147-154`), which `return`s *before* `_verify_internal_header` and would drop the BFF-only boundary. (§7 D5, §8.5.)
2. **No sha256 uniqueness.** Dropped the proposed `unique(corpus_set_version_id, sha256)` — it conflicts with the single-fixture backfill and with legitimate shared content. `sha256` is `NOT NULL` for integrity only. (§8.1.)
3. **Migration ownership.** `0127` is the **sole** schema-change owner; historical `0072` is **not** edited. (§8.1.)
4. **DB session lifecycle.** The plate service uses the `session_factory` release-before-stream pattern (mirrors `get_epub_asset_for_viewer`, `media.py:2622`, regression-tested at `test_media.py:1557`); the route does **not** inject `Depends(get_db)`. (§8.5.)
5. **Legacy persisted plate events.** Plate events persist `_oracle_image_payload` (`oracle.py:824`); a **data migration** in `0127` rewrites existing `oracle_reading_events` plate payloads `source_url`→`url`. `_oracle_event_out` becomes a pass-through. (§8.1, §8.7.)
6. **`proxyPublicToFastAPI`.** Streams the body (no content-length recompute), forwards upstream `Content-Length`/`ETag`/`Cache-Control` (a dedicated response-header allowlist that, unlike `proxy.ts:68`, includes `content-length`), and the route-shape test (`proxy-routes.test.ts:5,35`) is updated (count + recognize the helper). (§8.6.)
7. **`buildMediaImageProxySrc` stays exported.** It has a non-`next/image` caller — Media Session artwork (`mediaSession.ts:166`). It is **not** made internal to `MediaImage`; only the `next/image` *import* is lint-gated. (§8.10, §9.4.)

---

## 1. Summary

Oracle plates are public-domain engravings (Doré et al.) curated in a fixed, versioned, immutable corpus. Today they are **hot-linked from Wikimedia at request time** and funneled through the per-user authenticated SSRF image proxy (`/api/media/image`). This produces a real, user-visible `next/image` **400** on every plate and couples the product to Wikimedia's availability, hotlinking policy, bot-User-Agent handling, and `Special:Redirect` 302 behavior.

This cutover **reclassifies oracle plates as owned, public, immutable assets**: ingest the bytes into our own object storage (R2 / MinIO) once at corpus-build time, store integrity metadata in the DB, and serve them from a **public, same-origin, immutable, cacheable** route that `next/image` can optimize. It also lands the **structural guardrails** (a single `<MediaImage>` owner, an ESLint gate, a real optimizer test) so this class of defect cannot recur, and **consolidates** three duplicated concerns the audit already flagged.

Hard cutover. No fallback, no dual-path, no legacy code.

---

## 2. Why (root cause + the deeper error)

### 2.1 The 400, precisely

- Oracle image URLs reaching the frontend are already **same-origin proxied** to `/api/media/image?url=…` by `_oracle_image_proxy_url` (`python/nexus/services/oracle.py:985-990`), applied at `oracle.py:430` (Aleph thumbnail), `:995` (reading detail), `:1010` (SSE plate event).
- The two oracle `<Image>` sites — `OracleAlephGrid.tsx:71-78` and `OracleReadingPaneBody.tsx:623-638` — are the **only** proxied images in the app **not** marked `unoptimized` (all nine others are: `GlobalPlayerFooter`, `TranscriptPlaybackPanel`, `PodcastsPaneBody`, `PodcastSummaryCard`, `BrowsePaneBody`). They therefore route through `/_next/image`.
- The optimizer fetches the source **server-side** via `fetchInternalImage` (`next/dist/server/image-optimizer.js:909`), which builds the internal request with **empty headers** (`createRequestResponseMocks({ url, headers = {} })`, `mock-request.js:424`) → no cookie.
- `/api/media/image` is auth-only: `proxyToFastAPI` reads the Supabase session from the `cookie` header and returns **401 JSON** when absent (`apps/web/src/lib/api/proxy.ts:320-389`; backend route requires `Depends(get_viewer)`, `python/nexus/api/routes/media.py:91-96`).
- The optimizer treats the 401 JSON body as the image, runs `detectContentType` → `application/json`, and throws **`ImageError(400, "The requested resource isn't a valid image.")`** (`image-optimizer.js:970-978`).

Empirically confirmed: Next 15.5.18's own `hasLocalMatch` **accepts** the proxied local URL, and `remotePatterns` is never consulted for a local src. The doc's "remotePatterns gap" framing is wrong; adding `remotePatterns` fixes nothing.

### 2.2 The deeper error — asset misclassification

The invariant the 400 violates is:

> **The shared `next/image` optimizer may only fetch public, unauthenticated origins.** It runs contextless server-side; any per-user auth on the source guarantees failure.

The root cause is that **public-domain, build-time-known catalog art is being served through a per-user authenticated SSRF proxy built for arbitrary, user-supplied remote media.** Two different asset classes were collapsed onto one path. Fixing the class — own the bytes, serve them publicly — dissolves the 400 *and* the Wikimedia coupling, and unlocks real optimization on the hero plate. `unoptimized` (the consistent stopgap) only silences this one instance and leaves the coupling in place; it is explicitly **rejected** as the destination here.

### 2.3 Latent fragility removed as a side effect

`manifest_plates.json` already stores `resolved_source_url` values that point at `Special:Redirect/file/…` (302 redirects), while the proxy enforces `follow_redirects=False` + max-1-redirect (`image_proxy.py:491,547-551`) and sends `User-Agent: NexusImageProxy/1.0`. Even the *working* (`unoptimized`) thumbnails depend on Wikimedia serving a bot UA through ≤1 redirect. Owning the bytes removes this entire failure surface.

---

## 3. Goals

1. Oracle plates render through `next/image` **optimized** (resize, AVIF/WebP, responsive `srcset`, blur-up), with **no** `unoptimized`.
2. Plate bytes are **owned**: downloaded, validated, and stored in R2 **once at build time**; never fetched from Wikimedia at request time.
3. CSP stays exactly `img-src 'self' data:` and `remotePatterns` stays empty — no loosening.
4. A single `<MediaImage>` component is the **only** place `next/image` is used; a lint rule enforces it.
5. A **real** `/_next/image` optimizer assertion runs under the CSP-enforced (production-build) e2e profile.
6. Consolidate the three duplicated concerns the audit flagged: the image-proxy **path constant** (3 owners → 1), the **SSRF/decode validation** (proxy + build-time ingestion share one module), and the **streaming-with-integrity** read (EPUB asset + plate share one helper).
7. Hermetic tests/CI: no network egress to Wikimedia in any test or migration.

---

## 4. Non-goals (explicit)

- **Migrating podcast / episode cover art to owned storage.** Different asset class: mutable (feeds change art), third-party-hosted, ingested per-subscription, potentially unbounded. The capability built here is designed so podcast-sync can adopt it later (see §11), but doing it now is out of scope. Podcast/browse art stays `kind="proxied"` (proxy + `unoptimized`) through the new `<MediaImage>`.
- **YouTube / browse-search thumbnails** (`BrowsePaneBody.tsx:510`). Transient search results, never persisted, never ownable. Stay `kind="proxied"`.
- **Sanitized-HTML inline images** (web-article fragments, podcast show notes). Stay proxied; the only change here is the path-constant consolidation (§9.1).
- **Removing or re-auth-ing the `/api/media/image` proxy.** It remains, correctly auth-gated, for the proxied class. Oracle simply stops using it.
- **SVG plates.** Plates are raster (JPEG/PNG/WebP). SVG is rejected at ingestion; the EPUB SVG-CSP special-case is not needed for plates.
- **A public R2 custom domain / CDN offload.** Same-origin streaming is the chosen delivery (§7.3, decision D4). A CDN domain is a future optimization, not this cutover.
- **Changing plate selection** (embedding similarity, `_pick_plate`, `oracle.py:1523-1572`) — untouched.

---

## 5. Target architecture (final state)

```
BUILD TIME (scripts/oracle/build_corpus.py, immutable per ORACLE_CORPUS_VERSION)
  manifest → resolve Wikimedia file-page → download bytes (httpx)
           → fetch_validated_image(): SSRF + redirect + Pillow decode + magic-byte + dimension/size caps
           → sha256(bytes)               (content address)
           → storage.put_object("oracle/plates/{sha256}.{ext}", bytes, content_type)   [idempotent: head_object first]
           → INSERT oracle_corpus_images(storage_key, content_type, byte_size, sha256, width, height,
                                          source_url, source_page_url, …)               [source_url = provenance only]

REQUEST TIME (browser, authenticated reading page)
  <MediaImage kind="owned" src="/api/oracle/plates/{image_id}" width height/>
     → next/image emits  /_next/image?url=%2Fapi%2Foracle%2Fplates%2F{id}&w=…&q=…        (same-origin → img-src 'self')
     → optimizer internal-fetches  /api/oracle/plates/{id}   (no cookie — and none needed)
          → Next BFF  proxyPublicToFastAPI  (attaches X-Nexus-Internal, NO user bearer)
          → FastAPI  GET /oracle/plates/{id}   (anonymous, internal-gated; NO Depends(get_viewer))
               → resolve image_id → storage_key/sha256/size/content_type
               → read_object_checked(): stream from R2 + verify sha256 + byte_size
               → 200 image/jpeg, Cache-Control: public, max-age=31536000, immutable, ETag: "{sha256}"
     → optimizer succeeds → optimized variant served from /_next/image
```

No Wikimedia at request time. No CSP change. No `remotePatterns`. The optimizer only ever fetches a **public** same-origin route.

---

## 6. Capability contract

A new capability, **Owned Public Immutable Asset (OPIA) delivery**, with these guarantees. Oracle plates are its first consumer; podcast art is a designed-for future consumer.

- **Ownership:** bytes live in our object storage under a content-addressed key `oracle/plates/{sha256}.{ext}`. The DB row is the index; the object is the truth; `sha256` ties them.
- **Integrity:** every read streams and verifies `sha256` + `byte_size` against the DB before returning (reuses the EPUB integrity pattern). A mismatch is a 5xx, never a silent serve.
- **Immutability:** corpus versions are immutable (`_ensure_corpus_set_version`, `build_corpus.py:105-114`); content-addressed keys never change → `Cache-Control: public, max-age=31536000, immutable` + strong `ETag` are sound.
- **Public, but BFF-gated:** no per-user auth (the content is public-domain and the id leaks nothing user-specific), but the FastAPI route still requires the internal-secret header — it is reachable only through the BFF, never the open internet. This is the lane that lets the contextless optimizer fetch succeed.
- **Optimizable:** because the origin is public, `next/image` optimizes normally. This is the property `kind="proxied"` images structurally cannot have.
- **Same-origin:** the browser only ever sees `/_next/image…` and `/api/oracle/plates/…`, both `'self'`. CSP is untouched.

---

## 7. Key decisions (with rejected alternatives)

**D1 — Own the bytes at build time; do not hot-link at request time.**
Rejected: keep hot-linking + add `remotePatterns` for Wikimedia + loosen `img-src`. Contradicts the deliberate same-origin CSP posture and keeps Wikimedia in the hot path. Rejected: keep hot-linking but proxy + `unoptimized` (the stopgap). Leaves the coupling and forfeits optimization.

**D2 — Content-addressed storage keys (`oracle/plates/{sha256}.{ext}`).**
Dedup across versions, free integrity, immutable cache key. New top-level `oracle/` prefix (not under `media/{media_id}/…`) because plates are corpus assets, not user media. Rejected: `media_id`-style keys — plates have no media_id and content-addressing is strictly better for immutable public art.

**D3 — Serve keyed by `oracle_corpus_images.id` (UUID), not by sha256, in the URL.**
URL = `/api/oracle/plates/{image_id}`. The id is already the reading's FK reference; the route resolves id → storage internals server-side (storage layout stays private; the route can 404 non-corpus ids). The PK lookup is one indexed `get`, negligible, and responses are immutable-cached. Rejected: sha256-in-URL — leaks content hashes and turns the route into an unauthenticated read-by-hash of arbitrary objects.

**D4 — Same-origin streaming delivery (mirror the EPUB asset route), not presigned-R2 or CDN domain.**
Keeps everything `'self'`; reuses `stream_object` + the integrity check; no `remotePatterns`/`connect-src` change; no public-bucket infra. Rejected: presigned R2 URL as the `<Image src>` — needs R2 in `remotePatterns`, presign TTL fights `immutable` caching and CDN. Rejected: public R2 custom domain — real infra, deferred (see Non-goals).

**D5 — Public-but-internal-gated route via `AuthMiddleware`, plus a `proxyPublicToFastAPI` BFF helper.**
The plate route uses a **new prefix lane added *after* the internal-header check** in `AuthMiddleware.dispatch` (after `python/nexus/auth/middleware.py:160`, alongside the `EXTENSION_AUTH_PATHS`/`INTERNAL_ONLY_PATHS` returns at `:162-166`): internal-header **required**, bearer **exempt**. The BFF attaches `X-Nexus-Internal` but **no** user bearer. This is precisely what makes the contextless optimizer fetch succeed while keeping FastAPI off the open internet.
- Rejected: the **SSE stream block** (`:147-154`) — it `return`s *before* `_verify_internal_header` (`:156-160`), so it skips **both** bearer and internal header and would expose the route without the BFF trust signal.
- Rejected: `PUBLIC_PATHS` (`:32`) — same problem, drops the internal-header gate.
- Rejected: `INTERNAL_ONLY_PATHS` as-is (`:43`) — exact-match set; the plate path is a prefix (`/oracle/plates/{id}`), so it needs a `startswith` lane, not a set membership.
- Rejected: reusing `proxyToFastAPI` — it hard-requires a session (the original bug).

**D6 — One `<MediaImage>` owner + lint gate; `next/image` importable nowhere else.**
The oracle divergence happened because call sites used `next/image` directly and even bypassed `buildMediaImageProxySrc`. Make the correct thing the only thing. Rejected: a custom AST lint rule inspecting `src`/`unoptimized` — more brittle than simply banning the import outside the wrapper.

**D7 — Centralize the three duplicated concerns (path constant, image validation, integrity read).**
Aligns with the cleanliness audit's "one owner" rule (`docs/cutovers/codebase-cleanliness-audit.md` §3/§4). See §9.

**D8 — Hermetic seed via one bundled fixture plate.**
Migrations and tests never hit the network. A single small public-domain fixture image is committed and uploaded to object storage by an idempotent seed helper; the migration backfills existing rows to the fixture so the new NOT NULL columns hold. Real corpus bytes come only from `build_corpus.py`. Rejected: running `build_corpus` in e2e setup — reintroduces Wikimedia network flakiness (the exact thing `ccfc2d0a` fixed).

---

## 8. Detailed design

### 8.1 Data model + migration

New migration `migrations/alembic/versions/0127_oracle_owned_plates.py` (head is `0126`, `0126_drop_prompt_version_columns.py`). **`0127` is the sole owner of this schema change.** Historical `0072_oracle.py` is **not** edited (editing it would duplicate columns on fresh `alembic upgrade head`). The model in `models.py` reflects the final state; `0072`'s seed INSERT (which predates these columns) is unchanged and is reconciled by `0127`'s backfill.

**Schema add** to `oracle_corpus_images` (model `python/nexus/db/models.py:6151-6201`):

| Column | Type | Constraints |
|---|---|---|
| `storage_key` | `Text` | `NOT NULL`, `CHECK (storage_key LIKE 'oracle/plates/%')` |
| `content_type` | `Text` | `NOT NULL`, `CHECK (content_type IN ('image/jpeg','image/png','image/webp'))` |
| `byte_size` | `BigInteger` | `NOT NULL`, `CHECK (byte_size > 0)` |
| `sha256` | `Text` | `NOT NULL`, `CHECK (char_length(sha256) = 64)` |

- **No uniqueness on `sha256`** (review #2). `sha256` is `NOT NULL` for integrity only. A `unique(corpus_set_version_id, sha256)` would (a) break the single-fixture backfill below and (b) forbid legitimate distinct rows that reference identical bytes; the object store deduplicates content-addressed keys on its own. The existing `uix_oracle_images_version_source_url` stays as the meaningful natural key.
- Keep `source_url` / `source_page_url` — **demoted to provenance only**; never served.

**Backfill (in `0127`, before `SET NOT NULL`).** The only pre-existing rows are the deterministic `0072` seed rows (`0072_oracle.py:635` seeds many images into one version). Set them all to the bundled fixture (§8.8) — legal now that `sha256` is non-unique:
```sql
UPDATE oracle_corpus_images
SET storage_key='oracle/plates/{FIXTURE_SHA256}.jpg', content_type='image/jpeg',
    byte_size={FIXTURE_BYTES}, sha256='{FIXTURE_SHA256}';
-- then ALTER … SET NOT NULL on all four columns
```
`FIXTURE_SHA256`/`FIXTURE_BYTES` are compile-time constants of the committed fixture. In prod the fixture object is guaranteed present by `ensure_oracle_seed_objects` running on deploy (§13); real plates arrive via the `build_corpus` rebuild. Consequence (intentional, stated): readings that reference a *superseded* corpus version render the fixture engraving until/unless re-ingested — we do **not** download legacy plate bytes inside a migration (no network in migrations, review-finding spirit). The optional fidelity path is `ingest_existing_corpus_plates` (§13), a post-deploy script.

**Data migration for persisted plate events (review #5).** Plate SSE events persist `_oracle_image_payload` into `oracle_reading_events.payload` (`oracle.py:824`). A hard `source_url`→`url` cutover must rewrite existing rows or old reading details violate the new DTO:
```sql
UPDATE oracle_reading_events e
SET payload = (e.payload - 'source_url')
            || jsonb_build_object('url', '/api/oracle/plates/' || r.image_id::text)
FROM oracle_readings r
WHERE e.reading_id = r.id          -- oracle_reading_events.reading_id (models.py:6377, 0072:476)
  AND e.event_type = 'plate'
  AND r.image_id IS NOT NULL;
```
Degenerate plate events with `image_id IS NULL` cannot render and are left as-is (the frontend `parseImagePayload` returns `null` when `url` is absent). After this migration, `_oracle_event_out` is a pure pass-through (§8.7).

Mirror the column adds in the SQLAlchemy model.

### 8.2 Build-time ingestion (`scripts/oracle/build_corpus.py`)

In `_seed_plates` (`build_corpus.py:~240-330`), between metadata resolution and the INSERT, for each plate:

1. `bytes, content_type, sha256, width, height = fetch_validated_image(resolved_source_url, client)` — using the centralized validator (§9.2). This **replaces** trusting manifest `width`/`height` with values decoded from the actual bytes (authoritative).
2. `ext = ext_for_content_type(content_type)` (`jpeg`→`jpg`, `png`, `webp`).
3. `storage_key = build_oracle_plate_storage_path(sha256, ext)` (§8.4).
4. Idempotent upload: `if storage.head_object(storage_key) is None: storage.put_object(storage_key, bytes, content_type)`.
5. INSERT now sets `storage_key, content_type, byte_size=len(bytes), sha256` in addition to existing columns. `source_url` keeps the resolved CDN URL as provenance; `source_page_url` keeps the Wikimedia file page.

Wire a storage client into the script: `from nexus.storage.client import get_storage_client` (the script already builds a DB session + httpx client at `build_corpus.py:465-468`). Document the new required env (`R2_*`) in the script docstring and `.env.example` per `docs/rules/environment.md`.

`_resolve_wikimedia_image` (`build_corpus.py:55-89`) stays as the file-page → CDN resolver; the download step follows it. Embeddings (`build_text_embeddings`, `build_corpus.py:256`) and corpus-version immutability are unchanged.

### 8.3 Centralized image validation (§9.2) used by both the proxy and the build

`build_corpus` and `image_proxy` both need: SSRF URL validation, bounded-redirect fetch, content-type + magic-byte rejection, Pillow decode with dimension/decompression-bomb caps. Extract these from `image_proxy.py` into `python/nexus/services/image_validation.py` and add one orchestrator:

```python
def fetch_validated_image(url: str, client: httpx.Client) -> ValidatedImage:
    # ValidatedImage(data: bytes, content_type: str, sha256: str, width: int, height: int)
    # validate_url → check_hostname_denylist → validate_dns_resolution
    # → fetch_with_redirect → validate_content_type → sniff_magic_bytes
    # → validate_and_decode_image (returns content_type + (width,height)) → sha256
```

`image_proxy.fetch_image` becomes a thin cache layer over `fetch_validated_image` (its `ImageCache` stays proxy-local; do **not** move it — `image_proxy.py:128-199`).

### 8.4 Storage keys

Add to `python/nexus/storage/paths.py` (alongside `build_storage_path`, `build_epub_asset_storage_path`):

```python
def build_oracle_plate_storage_path(sha256: str, ext: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError("oracle plate sha256 must be 64 lowercase hex chars")
    if ext not in {"jpg", "png", "webp"}:
        raise ValueError("oracle plate ext must be jpg|png|webp")
    return f"oracle/plates/{sha256}.{ext}"
```

### 8.5 Serving: FastAPI public route + integrity read + middleware

**Integrity read helper** (consolidation §9.3) — extract from `get_epub_asset_for_viewer` (`python/nexus/services/media.py:2607-2650`) into the storage layer:

```python
# python/nexus/storage/read.py
def read_object_checked(storage: StorageClientBase, storage_path: str, *,
                        expected_sha256: str, expected_size: int) -> bytes:
    # stream_object loop, accumulate, enforce size ceiling, verify sha256+size, raise StorageError on mismatch
```

Re-point `get_epub_asset_for_viewer` to use it (no behavior change), and have the plate service use it too.

**Service** — `python/nexus/services/oracle.py`. Mirror `get_epub_asset_for_viewer` (`media.py:2607-2650`): **read metadata inside a `session_factory()` scope, exit it, then stream** (review #4 — never hold the request DB session across the storage read; this is regression-tested for EPUB at `test_media.py:1557`).

```python
ORACLE_PLATE_ROUTE = "/api/oracle/plates"          # single owner of the public path string
def oracle_plate_path(image_id: UUID) -> str:
    return f"{ORACLE_PLATE_ROUTE}/{image_id}"

@dataclass(frozen=True)
class _PlateMeta:
    storage_key: str; sha256: str; byte_size: int; content_type: str

@dataclass
class OraclePlateBytes:
    data: bytes; content_type: str; etag: str   # etag = quoted sha256

def get_oracle_plate_bytes(*, session_factory: Callable[[], Session],
                           image_id: UUID,
                           storage_client: StorageClientBase | None = None) -> OraclePlateBytes:
    with session_factory() as db:                      # DB released before the stream read
        img = db.get(OracleCorpusImage, image_id)
        if img is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Oracle plate not found")
        meta = _PlateMeta(img.storage_key, img.sha256, img.byte_size, img.content_type)
    sc = storage_client or get_storage_client()
    data = read_object_checked(sc, meta.storage_key,
                               expected_sha256=meta.sha256, expected_size=meta.byte_size)
    return OraclePlateBytes(data=data, content_type=meta.content_type, etag=f'"{meta.sha256}"')
```

**Route** — `python/nexus/api/routes/oracle.py` (router has no prefix; mounted at app root, `oracle.py:20`). **No `Depends(get_viewer)` and no `Depends(get_db)`** — it passes `get_session_factory()` exactly like `get_epub_asset` (`media.py:621-652`). Handle `If-None-Match` → 304.

```python
@router.get("/oracle/plates/{image_id}")
def get_oracle_plate(image_id: UUID, request: Request) -> Response:
    inm = request.headers.get("If-None-Match")
    plate = oracle_service.get_oracle_plate_bytes(
        session_factory=get_session_factory(), image_id=image_id)
    if inm and inm.strip() == plate.etag:
        return Response(status_code=304, headers={"ETag": plate.etag})
    return Response(content=plate.data, media_type=plate.content_type, headers={
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": str(len(plate.data)),
        "X-Content-Type-Options": "nosniff",
        "ETag": plate.etag,
    })
```

**Middleware** — `python/nexus/auth/middleware.py`: add a **prefix lane after the internal-header check**, i.e. immediately after `:160` and beside the `EXTENSION_AUTH_PATHS`/`INTERNAL_ONLY_PATHS` returns (`:162-166`):

```python
if request.url.path.startswith("/oracle/plates/"):
    return await call_next(request)   # internal-header already verified above; bearer-exempt
```

It must **not** be added to the stream block (`:147-154`, returns before the internal check), to `PUBLIC_PATHS` (`:32`), or to `INTERNAL_ONLY_PATHS` (`:43`, exact-match set; this is a prefix). Net posture: internal-header required (BFF-only), no user bearer.

### 8.6 BFF public proxy + Next route

**`proxyPublicToFastAPI`** — `apps/web/src/lib/api/proxy.ts`. Like `proxyToFastAPI` but: no session read, no `Authorization`; still sets `X-Nexus-Internal` (`getInternalApiConfig`) + `X-Request-ID`; forwards `If-None-Match`. Two concrete deltas from the existing buffering proxy (review #6):
- **Stream, don't buffer.** The existing path reads the whole body and *recomputes* `content-length` (`proxy.ts:452`, `setBodyContentLength`). For multi-MB engravings, return the upstream `Response.body` (a `ReadableStream`) directly in the `NextResponse` and **forward the upstream `Content-Length`** rather than recomputing.
- **Dedicated response-header allowlist.** `ALLOWED_RESPONSE_HEADERS` (`proxy.ts:68-80`) does **not** include `content-length`. Define a `PUBLIC_ASSET_RESPONSE_HEADERS = {content-type, content-length, cache-control, etag, x-content-type-options, x-request-id}` for this helper; keep `set-cookie`/`authorization`/`x-internal-*` blocked. Pass 304 (no body) through unchanged. Reuse the timeout controller.

**Route-shape test** — `apps/web/src/app/api/proxy-routes.test.ts`: it hard-asserts `API_ROUTE_COUNT = 126` (`:5`) and recognizes a route as a proxy only if the source contains `proxyToFastAPI`/`proxyExtensionToFastAPI` (`:35-36`). Note `"proxyPublicToFastAPI".includes("proxyToFastAPI")` is **false**. Update: bump the count to **127** and add `usesPublicProxy = source.includes("proxyPublicToFastAPI")` to the accepted set (it is neither an extension route nor a local sink).

**Route** — `apps/web/src/app/api/oracle/plates/[id]/route.ts`:

```ts
import { proxyPublicToFastAPI } from "@/lib/api/proxy";
export const runtime = "nodejs";
type Params = Promise<{ id: string }>;
export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyPublicToFastAPI(req, `/oracle/plates/${id}`);
}
```

### 8.7 DTO / schema + frontend

**Backend DTOs** (`python/nexus/schemas/oracle.py`):
- `OracleReadingImageOut` (`:69-79`): rename `source_url` → `url`. `url` = `oracle_plate_path(image.id)`. Keep `attribution_text, artist, work_title, year, width, height`.
- `OracleReadingSummaryOut.plate_thumbnail_url` (`:45`): keep the field name; value = `oracle_plate_path(image_id)`.

**Backend emitters** (`python/nexus/services/oracle.py`) — **delete** `_oracle_image_proxy_url` (`:985-990`) and `ORACLE_IMAGE_PROXY_PATH` (`:97`):
- `_oracle_image_payload` (`:993-1002`): emit `"url": oracle_plate_path(image.id)`.
- `list_all_readings` (`:427-443`): `plate_thumbnail_url = oracle_plate_path(row["image_id"])`; the SQL no longer needs `image_source_url` for the URL (keep only what alt-text uses).
- **Plate SSE event.** The write-site is `_append_event(db, reading_id, "plate", _oracle_image_payload(plate))` (`oracle.py:820-825`). Since `_oracle_image_payload` now emits `url`, **new** events persist `url` automatically. **Existing** persisted events are migrated by the `0127` data migration (§8.1). `_oracle_event_out` (`:1005-1014`) therefore **deletes** its `source_url` proxy-rewrite branch and becomes a pass-through for `plate` payloads (the `error` branch is unchanged).

**Frontend** (`apps/web/src/app/(oracle)/…`):
- `OracleReadingPaneBody.tsx`: `ImagePayload.source_url` → `url` (`:36-44`); `parseImagePayload` reads `url` (`:139-167`); render `<MediaImage kind="owned" src={state.image.url} width={…} height={…} priority sizes=…/>` (`:623-638`).
- `OracleAlephGrid.tsx`: `<MediaImage kind="owned" src={row.plate_thumbnail_url} fill sizes=…/>` (`:71-78`).
- `AtlasPaneBody.tsx`: `plate_thumbnail_url` is carried but not rendered — value updates for free; no `<Image>` change.

### 8.8 Hermetic seed fixture

- Commit one small public-domain fixture plate: `python/nexus/oracle/fixtures/seed_plate.jpg` (a downscaled Doré engraving, ≤ ~40 KB). Its sha256/byte-size are compile-time constants used by the migration backfill (§8.1) and the model seed.
- `python/nexus/oracle/seed_objects.py`: `ensure_oracle_seed_objects(storage)` — idempotent `head_object`-then-`put_object` of the fixture under `oracle/plates/{FIXTURE_SHA256}.jpg`. Called by: dev bootstrap (`make setup`), e2e `global-setup.mjs` (against MinIO), and any seed make target. No network, no Wikimedia.

### 8.9 `next.config.ts` + CSP

- `next.config.ts:9-15`: set `localPatterns: [{ pathname: "/api/oracle/plates/**" }]`. **Remove** the `/api/media/image` entry — it is dead under the new invariant (every proxied image is `unoptimized`, so it never reaches the optimizer / `localPatterns`).
- CSP (`apps/web/src/lib/security/csp.ts`): **no change.** `img-src 'self' data:` and empty `remotePatterns` stand.

### 8.10 Guardrails

**`<MediaImage>`** — `apps/web/src/components/ui/MediaImage.tsx` (`"use client"`, default export, matches `components/ui/Button.tsx` style). The single owner of `next/image`. Discriminated contract:

```ts
type MediaImageProps =
  | ({ kind: "owned";   src: string }      & SharedImageProps)   // same-origin OPIA path → optimized
  | ({ kind: "proxied"; remoteUrl: string } & SharedImageProps); // arbitrary remote → proxied + unoptimized
// kind="owned":   <Image src={src} {...} />
// kind="proxied": <Image src={buildMediaImageProxySrc(remoteUrl)} unoptimized {...} />
```

`buildMediaImageProxySrc` (`apps/web/src/lib/media/imageProxy.ts`) **stays exported** — it has a legitimate non-`next/image` caller, the OS Media Session artwork URL (`apps/web/src/lib/player/mediaSession.ts:166`, an `artwork[].src` string, not an image element) (review #7). `MediaImage` is *a* caller (for `kind="proxied"`), not the sole owner. The enforced invariant is narrower and exact: **`next/image` is imported only in `MediaImage`** — that is what the lint gates, and it is sufficient (the proxy-vs-owned/`unoptimized` decision lives entirely inside `MediaImage`). All 7 current `next/image` files convert: 2 oracle → `kind="owned"`; the 5 proxied surfaces (`GlobalPlayerFooter`, `TranscriptPlaybackPanel`, `PodcastsPaneBody`, `PodcastSummaryCard`, `BrowsePaneBody`) → `kind="proxied"`. `mediaSession.ts` is **unchanged**.

**ESLint** — `apps/web/eslint.config.mjs`: add `no-restricted-imports` forbidding `next/image`, with a file-scoped override re-enabling it only in `src/components/ui/MediaImage.tsx` (mirror the existing pane-body import gate at `eslint.config.mjs:55-76`). Message: "Use `<MediaImage>`; bare next/image is forbidden so the proxied-vs-owned/unoptimized invariant is enforced in one place."

**Tests** — see §12.

---

## 9. Consolidation / reuse map (duplicate patterns centralized)

### 9.1 Image-proxy **path constant**: 3 owners → 1
Audit finding (`codebase-cleanliness-audit.md` §3, issue #3): `ORACLE_IMAGE_PROXY_PATH` (`oracle.py:97`), `IMAGE_PROXY_URL = "/media/image?url=…"` (`sanitize_html.py:85`), and the route `@router.get("/media/image")` (`media.py:91`) jointly define one path and disagree on the `/api` prefix.
- Delete `ORACLE_IMAGE_PROXY_PATH` (oracle stops proxying).
- Define one canonical owner for the *remaining* proxy path and have `sanitize_html` + the frontend reference it; the FastAPI route stays `/media/image` (mounted under the app's `/api`). **Audit the `/media/image` vs `/api/media/image` discrepancy in `sanitize_html.py:317`** during implementation — sanitized HTML must emit the same public path the frontend uses (`/api/media/image`). (Adjacent latent bug surfaced by this work; fix within the consolidation.)

### 9.2 Image **validation/fetch**: proxy + build share one module
Extract the SSRF/redirect/decode core of `image_proxy.py` into `services/image_validation.py` (§8.3). Proxy keeps only its cache; build-time ingestion reuses `fetch_validated_image`. Audit "one owner" satisfied.

### 9.3 **Streaming-with-integrity** read: EPUB + plate share one helper
Extract the `stream_object` + sha256/size verification loop from `get_epub_asset_for_viewer` (`media.py:2607-2650`) into `storage/read.py:read_object_checked` (§8.5). Both call sites use it.

### 9.4 `next/image` usage: 7 sites → 1 owner
`<MediaImage>` + lint (§8.10). The gated invariant is the `next/image` *import* (one owner: `MediaImage`), which removes the bypass that let oracle diverge. `buildMediaImageProxySrc` is **not** consolidated into `MediaImage` — it remains a shared util because Media Session artwork (`mediaSession.ts:166`) needs the proxy-URL string without an image element.

---

## 10. How it composes with existing systems

- **`next/image` optimizer:** now fetches a public same-origin route; the contextless internal fetch succeeds. Optimization (resize/format/srcset/blur) is fully active.
- **CSP / middleware:** unchanged. Browser sees only `'self'` URLs. `connect-src`/`R2_S3_API_ORIGIN` untouched (no browser→R2 traffic for plates; R2 is server-side only).
- **BFF / `AuthMiddleware`:** the plate route adds a **new** prefix lane in `AuthMiddleware.dispatch` placed **after `_verify_internal_header` and before bearer extraction** (i.e. after `middleware.py:160`, beside `:162-166`) — **not** the stream/SSE bypass (`:147-154`, which returns before the internal check). Internal-header required, bearer exempt; FastAPI stays BFF-only. `proxyPublicToFastAPI` is a sibling of `proxyToFastAPI`.
- **Object storage:** reuses `StorageClientBase` (`put_object`/`head_object`/`stream_object`) and `storage/paths.py`. New `oracle/` key prefix; R2 in prod, MinIO in dev/test.
- **Corpus build + embeddings:** ingestion is an added step in the existing immutable build; `_pick_plate` and embeddings unchanged. Plate width/height now come from decoded bytes (authoritative), not the manifest.
- **Readings:** `oracle_readings.image_id` FK and selection unchanged; only the emitted URL field changes (`source_url`→`url` = `/api/oracle/plates/{id}`).

---

## 11. Future consumer (designed-for, not built): podcast cover art

The OPIA capability is built so podcast-sync (`python/nexus/services/podcasts/sync.py`) can later: at subscription/sync time, `fetch_validated_image(feed_art_url)` → `put_object("podcast/covers/{sha256}.{ext}")` → store key/sha256/size on the podcast row → serve via a `/api/media/owned/{…}` route (same `read_object_checked` + public-internal lane) → render `<MediaImage kind="owned">`. Out of scope here; no code in this cutover presumes it, but names/contracts (`read_object_checked`, `fetch_validated_image`, `kind="owned"`) are chosen to accommodate it.

---

## 12. Acceptance criteria

**Functional**
1. On a reading page, the plate renders via `/_next/image?url=%2Fapi%2Foracle%2Fplates%2F…` returning **200** with an `image/*` content-type (not 400, not JSON).
2. `GET /api/oracle/plates/{id}` returns 200 image bytes with `Cache-Control: public, max-age=31536000, immutable` and `ETag: "{sha256}"`; `If-None-Match` with the matching ETag → 304.
3. No request to `upload.wikimedia.org` / `commons.wikimedia.org` occurs at request time (verified by network capture in the e2e test).
4. Aleph thumbnails and reading-detail plate both load and are Next-optimized (response served by the optimizer; `srcset` present).

**Architecture / invariants**
5. `rg "next/image" apps/web/src` matches only `components/ui/MediaImage.tsx`; ESLint fails on any other `next/image` import.
6. `rg "_oracle_image_proxy_url|ORACLE_IMAGE_PROXY_PATH" python` returns nothing.
7. `next.config.ts` `localPatterns` contains `/api/oracle/plates/**` and **not** `/api/media/image`. `csp.ts` `img-src` is exactly `'self' data:`; `remotePatterns` absent.
8. `oracle_corpus_images` has `storage_key/content_type/byte_size/sha256` NOT NULL with the documented CHECKs; every row's object exists in storage and its bytes' sha256 matches the column.
9. The image-proxy path string has exactly one owner; `sanitize_html` emits the same public path as the frontend.

**Hermeticity**
10. Full unit + browser + e2e (incl. CSP profile) and the migration run with **zero** external image egress.

**Operational**
11. After the runbook (§13), production serves all plates from R2; the legacy proxy path is unused by oracle.

---

## 13. Migration & operational runbook (hard cutover, no fallback)

1. **Seed the fixture object first, and verify it:** run `ensure_oracle_seed_objects` against prod storage (idempotent, one tiny object), then **gate the migration on a verification**: `head_object(fixture_key)` exists with `size_bytes == FIXTURE_BYTES` (and content-type `image/jpeg`), plus a one-shot `read_object_checked(fixture_key, expected_sha256=FIXTURE_SHA256, expected_size=FIXTURE_BYTES)`. The migration creates DB pointers (and rewrites legacy plate-event payloads) to this object, so it must provably exist and match before step 2 runs. Abort the deploy if verification fails.
2. **Deploy** migration `0127_oracle_owned_plates` (adds the four columns, backfills legacy rows to the fixture, sets `NOT NULL`, and rewrites `oracle_reading_events` plate payloads `source_url`→`url`).
3. **Build the owned corpus:** run the updated `build_corpus.py` with `R2_*` env and a **new** `ORACLE_CORPUS_VERSION` (immutable). It downloads, validates, uploads bytes, and writes rows with storage metadata.
4. **Flip** the active corpus to the new version (existing `ORACLE_CORPUS_VERSION` mechanism). New readings get real plates. Readings bound to a *superseded* version render the fixture engraving (intentional, §8.1).
5. **(Optional, fidelity)** run `ingest_existing_corpus_plates` — a post-deploy admin script (network allowed; not a migration) that downloads+uploads real bytes for legacy rows and sets their storage columns, restoring historical readings' true art.
6. **Verify** acceptance criteria 1–4 against the deployed env.

No dual-read, no "try R2 then Wikimedia" fallback. If a plate object is missing, the route 404/5xxs loudly (integrity over silent degradation). (dev/test: steps 1–3 are automated by bootstrap + e2e `global-setup`; no network.)

---

## 14. Files

**Create**
- `migrations/alembic/versions/0127_oracle_owned_plates.py`
- `python/nexus/services/image_validation.py` (extracted SSRF/decode core + `fetch_validated_image`)
- `python/nexus/storage/read.py` (`read_object_checked`)
- `python/nexus/oracle/fixtures/seed_plate.jpg`
- `python/nexus/oracle/seed_objects.py` (`ensure_oracle_seed_objects`)
- `apps/web/src/app/api/oracle/plates/[id]/route.ts`
- `apps/web/src/components/ui/MediaImage.tsx`
- `e2e/tests/oracle-plate-image.csp.spec.ts`
- `apps/web/src/components/ui/MediaImage.test.tsx`
- `python/tests/test_oracle_plate_route.py`

**Modify**
- `python/nexus/db/models.py` (`OracleCorpusImage` new columns)
- `python/nexus/services/oracle.py` (delete proxy fn/const; add `oracle_plate_path`, `get_oracle_plate_bytes`, `OraclePlateBytes`; update payload/list/SSE emitters)
- `python/nexus/schemas/oracle.py` (`source_url`→`url`)
- `python/nexus/api/routes/oracle.py` (add `get_oracle_plate`)
- `python/nexus/auth/middleware.py` (add a **new** `/oracle/plates/` prefix lane **after `_verify_internal_header`, before bearer extraction** — *not* the stream bypass at `:147-154`)
- `python/nexus/services/image_proxy.py` (re-base on `image_validation`; keep cache)
- `python/nexus/services/media.py` (`get_epub_asset_for_viewer` → `read_object_checked`)
- `python/nexus/services/sanitize_html.py` (path-constant consolidation + `/api` prefix fix)
- `python/nexus/storage/paths.py` (`build_oracle_plate_storage_path`)
- `scripts/oracle/build_corpus.py` (download+validate+upload; INSERT new columns)
- `apps/web/src/lib/api/proxy.ts` (`proxyPublicToFastAPI` — streaming, `PUBLIC_ASSET_RESPONSE_HEADERS`)
- `apps/web/src/app/api/proxy-routes.test.ts` (count 126→127; recognize `proxyPublicToFastAPI`)
- `apps/web/next.config.ts` (`localPatterns`)
- `apps/web/eslint.config.mjs` (`next/image` import gate)
- The 7 `next/image` call sites → `<MediaImage>`:
  `OracleAlephGrid.tsx`, `OracleReadingPaneBody.tsx`, `GlobalPlayerFooter.tsx`, `TranscriptPlaybackPanel.tsx`, `PodcastsPaneBody.tsx`, `PodcastSummaryCard.tsx`, `BrowsePaneBody.tsx`
- Frontend image payload types (`OracleReadingPaneBody.tsx`, `OracleAlephGrid.tsx`, `AtlasPaneBody.tsx`)
- `apps/web/vitest.browser-setup.ts` (mock `MediaImage`'s `next/image` consistently; keep optimizer out of unit/browser)
- `e2e/global-setup.mjs` (call `ensure_oracle_seed_objects` against MinIO)
- ~~`.env.example` (R2 vars now read by `build_corpus.py`)~~ — **no change needed**: `build_corpus.py` reuses the already-documented `R2_*` vars (no new env var introduced), so `docs/rules/environment.md` is already satisfied.
- Python tests asserting old shape: `python/tests/test_oracle.py` (`:722-727`, `:854-900`, `:1311-1328` and any others)
- `docs/cutovers/csp-and-security-headers-hardening.md:23` (correct the misdiagnosis line; link here)

**Delete**
- `_oracle_image_proxy_url`, `ORACLE_IMAGE_PROXY_PATH` (`python/nexus/services/oracle.py`)
- the proxy-rewrite branch in `_oracle_event_out`
- the `/api/media/image` `localPatterns` entry
- direct `next/image` imports in all 7 components

---

## 15. Rules / invariants (enforced)

- **R1.** `next/image` is imported only in `MediaImage.tsx` (ESLint).
- **R2.** `kind="owned"` ⇒ optimized + same-origin OPIA path; `kind="proxied"` ⇒ `unoptimized` + proxy. No third mode.
- **R3.** The `next/image` optimizer fetches only public origins. The plate route is anonymous (bearer-exempt) and internal-gated.
- **R4.** Plate bytes are content-addressed; every read verifies sha256 + byte_size (no silent serve on mismatch).
- **R5.** No request-time third-party image egress for plates; no Wikimedia in tests/migrations.
- **R6.** One owner each for: the proxy path constant, image SSRF/decode validation, streaming-with-integrity reads, `next/image` usage.
- **R7.** CSP `img-src 'self' data:` and empty `remotePatterns` are invariant.

---

## 16. Test plan

- **Python unit** (`test_oracle_plate_route.py`): `get_oracle_plate` returns bytes + immutable cache + ETag; 304 on If-None-Match; 404 for unknown id; integrity mismatch → 5xx (mock storage). `oracle_plate_path` shape. The service does **not** hold a DB session across the storage read (assert the metadata session is closed before `read_object_checked`, mirroring `test_media.py:1557`). Updated `test_oracle.py` asserts `image.url == /api/oracle/plates/{id}` and that no Wikimedia URL appears in any serialized DTO/event.
- **Auth lane** (`test_auth_middleware*`): `GET /oracle/plates/{id}` is rejected without `X-Nexus-Internal` when `requires_internal_header` is on, and accepted **without** a bearer when the internal header is present (distinguishes the new lane from both the stream bypass and bearer-required routes).
- **Migration** (`0127`): on a DB seeded by `0072`, the four columns become `NOT NULL` with the fixture values; existing `plate` events have `url` and no `source_url`; non-`plate` events are untouched.
- **Build** (`test_build_corpus_*`): with a mocked storage + stubbed `fetch_validated_image`, assert `put_object` called with a content-addressed key and rows written with `storage_key/sha256/byte_size/content_type`; idempotent skip when `head_object` hits.
- **Frontend browser** (`MediaImage.test.tsx`): `kind="owned"` renders without `unoptimized`; `kind="proxied"` renders the proxy src with `unoptimized`. (`next/image` still mocked here — these assert wrapper logic, not the optimizer.)
- **E2E CSP** (`oracle-plate-image.csp.spec.ts`, production build, `E2E_DISABLE_CSP=0`): seed a reading with the fixture plate; load the page; assert the plate's `/_next/image?...` request is **200** `image/*`; assert **no** request to a Wikimedia host; assert zero `securitypolicyviolation` events (parity with `security-headers.csp.spec.ts`). This is the regression test the mocked unit suites structurally cannot provide.

---

## 17. Risks & mitigations

- **Existing readings reference superseded-version image_ids.** Mitigation: rows are not deleted on version flip; objects persist; the route resolves by id regardless of active version.
- **Migration backfill needs a value for legacy rows.** Mitigation: bundled fixture constants; real bytes arrive via `build_corpus`.
- **Large engraving bytes through the BFF proxy.** Mitigation: `proxyPublicToFastAPI` streams; responses are immutable-cached so repeats are cheap; `MAX_IMAGE_DIMENSION`/`MAX_IMAGE_BYTES` cap source size at ingest.
- **Manifest `resolved_source_url` 302s / UA blocks at build.** Now a *build-time* failure (loud, retryable), not a request-time user-facing one; `fetch_with_redirect` already validates one hop.

---

## 18. Open questions to confirm during implementation

1. **Resolved.** No non-oracle reader of `oracle_corpus_images.source_url` for display. The column stays as provenance only; the served DTO/event field is now `url` = the owned path, and `list_all_readings` no longer selects `source_url` for the URL. (`grep` of the codebase confirms the column is read only inside oracle build/provenance paths.)
2. **Resolved.** `sanitize_html.py` `IMAGE_PROXY_URL` corrected to `/api/media/image?url=…` (the `/api` prefix bug). Tests in `test_sanitize_html.py` / `test_podcasts.py` / `test_web_article_highlight_e2e.py` updated to the corrected public path.
3. **Still an operational confirm (carried forward).** Confirm `requires_internal_header` is enabled in prod so the plate route's BFF-gating holds (`app.py:296-304`). The lane is implemented correctly (internal-header required, bearer-exempt) and `test_auth.py` exercises both: rejected 403 without the header, allowed (404 for unknown id) with it. If the header is **off** in any deployed env, the plate route is reachable without the BFF trust signal — acceptable only for public-domain bytes; otherwise gate another way.

*(Resolved in rev-2/rev-3: SSE plate write-site `oracle.py:820-825`; auth lane = new prefix check after `_verify_internal_header`, before bearer extraction; sha256 non-unique; `0127` sole schema owner; `buildMediaImageProxySrc` stays exported for `mediaSession.ts:166`; event FK is `oracle_reading_events.reading_id`, `models.py:6377` / `0072:476` / `oracle.py:1045`.)*

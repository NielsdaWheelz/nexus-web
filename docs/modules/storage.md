# Storage

Storage objects are owned by capability-specific DB rows. A storage key by itself
does not authorize access and must not encode user identity.

## Owners

| Object family | DB owner | Key shape | Access lane |
|---|---|---|---|
| Original PDF/EPUB uploads | `media_file` | `media/{media_id}/original.{pdf|epub}` | viewer-authenticated media/file services |
| Direct-upload staging | transient upload flow | `uploads/media/{media_id}/original.{pdf|epub}` | private upload lifecycle only |
| Extracted EPUB resources | `epub_resources` | `media/{media_id}/assets/{asset_key}` | viewer-authenticated EPUB asset route |
| Oracle plates | `oracle_plates` | `oracle/plates/{slug}.{jpg|png|webp}` | public owned-asset route, internal-header protected |

All storage path construction goes through `python/nexus/storage/paths.py`.
Storage keys are owner IDs or stable source keys, not content hashes. Object
reads enforce DB-owned byte-size metadata at read time.

Oracle plates remain a public owned-asset lane (`oracle/plates/...`) holding plate
image metadata only — no embeddings. The Oracle public-domain corpus is ordinary
media: its source files (EPUB/PDF/web-article) use the normal `media_file` /
`epub_resources` lanes above, never plate storage.

## Public vs Private Assets

Private media assets require a viewer authorization check before metadata is
resolved. They must not be added to Next Image `images.localPatterns`.

Public owned Oracle plates are different: the browser requests
`/api/oracle/plates/[id]`, the BFF strips browser credentials, and FastAPI serves
`/oracle/plates/{id}` only after internal-header verification. The route uses DB
metadata for ETags and storage metadata validation, then reads the object through
the storage client only for `200` responses.

## Deployment

Object-storage preconditions that migrations depend on are established by deploy
or operator code, not app startup. Backend deploy migrates schema first, then runs
`python /app/scripts/ensure_oracle_seed_objects.py` and the Oracle corpus
seed/readiness commands so runtime surfaces only see storage-backed Oracle assets.

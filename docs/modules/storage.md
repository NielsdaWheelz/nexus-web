# Storage

Storage objects are owned by capability-specific DB rows. A storage key by itself
does not authorize access and must not encode user identity.

## Owners

| Object family | DB owner | Key shape | Access lane |
|---|---|---|---|
| Original PDF/EPUB uploads | `media_file` | `media/{media_id}/original.{pdf|epub}` | viewer-authenticated media/file services |
| Direct-upload staging | transient upload flow | `uploads/media/{media_id}/original.{pdf|epub}` | private upload lifecycle only |
| Extracted EPUB resources | `epub_resources` | `media/{media_id}/assets/{asset_key}` | viewer-authenticated EPUB asset route |
| Oracle plates | `oracle_corpus_images` | `oracle/plates/{slug}.{jpg|png|webp}` | public owned-asset route, internal-header protected |

All storage path construction goes through `python/nexus/storage/paths.py`.
Storage keys are owner IDs or stable source keys, not content hashes. Object
reads enforce DB-owned byte-size metadata at read time.

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
or operator code, not app startup. Backend deploy runs
`python /app/scripts/ensure_oracle_seed_objects.py` before Alembic so migrations
can expose Oracle rows that reference already-existing owned objects.

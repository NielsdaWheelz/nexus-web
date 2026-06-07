# EPUB

EPUB has separate owners for original-file lifecycle, extracted structure, and
private resource assets.

- `media_source_ingest.py`: durable source acceptance and retry/refresh for
  uploaded EPUBs, remote EPUB URLs, and browser-captured EPUB files.
- `upload.py`: direct-upload initialization and byte confirmation primitives
  used by the source owner.
- `epub_ingest.py` / related reader services: extraction, fragments, TOC,
  navigation, resume data.
- `epub_assets.py`: private extracted resource asset reads.

`ingest_media_source` is the only worker job kind that starts source processing.
It calls the EPUB extraction task after the accepted source bytes are durable.
Routes and UI clients do not enqueue `ingest_epub` directly.

## Asset Lane

EPUB resources are served through
`/api/media/[id]/assets/[...assetKey]` → `/media/{id}/assets/{assetKey}`. The
route is viewer-authenticated. `epub_assets.py` authorizes the viewer, resolves
current `epub_resources` storage metadata, releases the DB session, then reads
storage through byte-size-checked helpers.

EPUB assets are private media assets. They are not public owned assets and must
not be added to Next Image `images.localPatterns`.

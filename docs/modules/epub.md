# EPUB

EPUB has separate owners for original-file lifecycle, extracted structure, and
private resource assets.

- `epub_lifecycle.py`: upload confirmation, dedupe, original file lifecycle.
- `epub_ingest.py` / related reader services: extraction, fragments, TOC,
  navigation, resume data.
- `epub_assets.py`: private extracted resource asset reads.

## Asset Lane

EPUB resources are served through
`/api/media/[id]/assets/[...assetKey]` → `/media/{id}/assets/{assetKey}`. The
route is viewer-authenticated. `epub_assets.py` authorizes the viewer, resolves
immutable `epub_resources` storage metadata, releases the DB session, then reads
storage through integrity-checked helpers.

EPUB assets are private media assets. They are not public owned assets and must
not be added to Next Image `images.localPatterns`.

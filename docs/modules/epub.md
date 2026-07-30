# EPUB

EPUB has separate owners for original-file lifecycle, extracted structure, and
private resource assets.

- `media_source_ingest.py`: durable source acceptance and retry/refresh for
  uploaded EPUBs, remote EPUB URLs, and browser-captured EPUB files.
- `upload.py`: direct-upload initialization and byte confirmation primitives
  used by the source owner.
- `epub_ingest.py` / related reader services: extraction, fragments, TOC,
  navigation, resume data.
- `epub_find.py`: bounded literal Find over current canonical fragments in one
  repeatable-read snapshot.
- `epub_assets.py`: private extracted resource asset reads.

`ingest_media_source` is the only worker job kind that starts source processing.
It calls the EPUB extraction task after the accepted source bytes are durable.
Source success atomically requests `media_content_reindex_job`; routes and UI
clients do not enqueue source-specific or retrieval jobs directly.

## Browse And Preview

Browse searches owned EPUBs through the Nexus adapter and external public-domain
books through the Project Gutenberg adapter. External candidates carry a sealed
Gutenberg identity. Preview refetches catalog truth, proxies remote artwork, and
exposes the provider's canonical import/source URL without creating Media,
Library entries, files, source attempts, or jobs. It never exposes a fabricated
`/browse/gutenberg/{id}` download path.

Add passes the Preview-resolved canonical EPUB URL to `/media/from_url`; normal
remote-file validation, durable source acceptance, dedupe, Library assignment,
and `ingest_media_source` processing remain the only acquisition path.

## Asset Lane

EPUB resources are served through
`/api/media/[id]/assets/[...assetKey]` → `/media/{id}/assets/{assetKey}`. The
route is viewer-authenticated. `epub_assets.py` authorizes the viewer, resolves
current `epub_resources` storage metadata, releases the DB session, then reads
storage through byte-size-checked helpers.

EPUB assets are private media assets. They are not public owned assets and must
not be added to Next Image `images.localPatterns`.

## Find

Readable EPUB panes publish the shared pane-local `FindOccurrences`
capability. `POST /media/{id}/epub-find` validates the current first-fragment
witness, then scans one fragment at a time in spine order. It returns only
ordered occurrence locators and plain-text snippets, stops at match 2,001, and
uses no global search index.

Cross-section results render through an ephemeral preview override. The
committed section, URL, restore session, reader progress, activity, and
completion remain unchanged until genuine reader input adopts the rendered
section. One immutable origin powers **Go back to reading position**.

## Reader Apparatus

EPUB reader apparatus extraction happens while `epub_ingest.py` still has access
to raw XHTML semantics such as `epub:type`, DPUB-ARIA roles, element ids, and
package hrefs. Exact `noteref -> footnote/endnote` relations are normalized into
the shared reader apparatus model with `epub_fragment_offsets` locators. Counts,
fixture hashes, and per-source support status are owned by the reader apparatus
manifest, not this module doc.

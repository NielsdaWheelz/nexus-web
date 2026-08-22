# EPUB

EPUB has separate owners for original-file lifecycle, extracted structure, and
private resource assets.

- `media_upload_sessions.py`: durable direct-upload intent, generation fencing,
  byte verification, and atomic publication for uploaded EPUBs.
- `media_source_ingest.py`: durable source processing and retry/refresh after
  publication, plus remote EPUB URLs and browser-captured EPUB files.
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

## Bounded Parse

`epub_ingest.py` scans every XML or XHTML entry in one streaming structural pass
before it builds a DOM or rewrites a chapter. Content documents (spine items)
are scanned with the same tolerant HTML grammar that renders them, so markup
that is not well-formed XML stays exactly as readable as the recovering parser
makes it; `container.xml`, the OPF, the NCX, the EPUB 3 navigation document, and
referenced SVG assets are scanned strictly, because each is then parsed as XML.

A doctype that names public or system identifiers is inert: nothing declares or
resolves it, and the parser never reaches the network. The XHTML named entities
such a document may reference resolve from a fixed local table, so EPUB 2
content documents and NCX files keep their text. An internal DTD subset is the
one doctype form that can declare entities, and it is refused as
`E_INVALID_FILE_TYPE`.

An absent or unparseable optional entry is absence: the book imports with a
smaller table of contents. Only a required entry (`container.xml`, the OPF)
turns an unparseable entry into a terminal `E_INVALID_FILE_TYPE`.

A breach of a declared budget — XML depth, elements, attributes, the 16 MiB
decoded bytes each XHTML entry may produce, rendered text, parse time, or the
bounded apparatus index — is terminal `E_RESOURCE_LIMIT` carrying a safe
dimension. `E_ARCHIVE_UNSAFE` remains reserved for archive path safety. A
stored object that does not match the media source's persisted digest is
terminal `E_SOURCE_INTEGRITY`, refused before the archive is opened.

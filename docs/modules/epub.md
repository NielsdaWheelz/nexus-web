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
capability. `POST /media/{id}/epub-find` validates the publication generation and
current fragment witness, then scans one fragment at a time in spine order. it returns only
ordered occurrence locators and plain-text snippets, stops at match 2,001, and
uses no global search index.

cross-fragment results use the shared reader navigation owner. inspection keeps
one captured origin, fences progress and completion, and never changes the
reading spot until explicit **continue reading here**. return restores the
origin's passage and viewport placement.

## Reader Apparatus

epub reader apparatus extraction happens while `epub_ingest.py` still has raw
xhtml semantics such as `epub:type`, roles, ids, reciprocal links and package
hrefs. declared note relations and bounded, reciprocal untyped note groups
become shared apparatus items with `epub_fragment_offsets` locators. supported
sanitized note structure is retained; unavailable bodies remain explicit.
anonymous occurrence refresh preserves identity only with unique exact
correspondence. ambiguous changes to referenced items reject publication.

## contents and sections

the declared epub 3 toc or epub 2 ncx supplies publisher labels and destinations;
other navigation lists stay separate. source headings can supply missing reading
boundaries. one reconciled boundary may have several published toc labels, while a
note or commentary target remains available in the full contents without becoming
a routine section. source-only commentary headings receive independent contents
targets beneath their evidenced notes collection. exact-heading destination repair
requires a unique heading, an incompatible source target, and consistent neighboring
publisher entries; ambiguous links retain their source
destination. `epub_toc_nodes` stores the source href, effective target, resolution,
and optional same-point section link. the compact reader controls use sections;
the full contents uses all reachable toc targets.

`reader_navigation_repair.py` inspects retained originals and existing fragments,
then installs only corresponding navigation and apparatus metadata under a
generation fence. it preserves fragment bytes, ids, assets, and reading offsets.
stored source digest, package hrefs, canonical text, and source-anchor positions
must agree before a repair can write.

## Bounded Parse

`epub_ingest.py` reads each archive entry once; staged XHTML is parsed in bounded
passes to confirm cross-file note links before classification. `container.xml`, the OPF, the NCX, the
EPUB 3 navigation document, and referenced SVG assets are parsed as XML with
entity expansion and external resolution disabled; content documents (spine
items) are parsed by the same recovering HTML parser that renders them, so
markup that is not well-formed XML stays exactly as readable as it was.

A doctype that names public or system identifiers is inert: nothing declares or
resolves it, and the parser never reaches the network. The XHTML named entities
such a document may reference resolve from a fixed local table, so EPUB 2
content documents and NCX files keep their text. An internal DTD subset is the
one doctype form that can declare entities, and it is refused as
`E_INVALID_FILE_TYPE`.

An absent or unparseable optional entry is absence: the book imports with a
smaller table of contents. Only a required entry (`container.xml`, the OPF)
turns an unparseable entry into a terminal `E_INVALID_FILE_TYPE`.

The declared budgets are the archive ones (entry count, per-entry and total
uncompressed size, compression ratio, parse time), the 16 MiB an XHTML or
navigation entry may declare in its ZIP header, the 64 MiB of rendered text one
book may produce, and the bounded apparatus index. A breach is terminal
`E_RESOURCE_LIMIT` carrying a safe dimension. `E_ARCHIVE_UNSAFE` remains
reserved for archive path safety. A stored object that does not match the media
source's persisted digest is terminal `E_SOURCE_INTEGRITY`, refused before the
archive is opened.

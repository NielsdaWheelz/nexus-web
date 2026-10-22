# release: ingest follow-ups

status: on branch `cleanup/ingest-followups`; ships with the reader python ingest
re-slice ([release-reader-python-ingest.md](release-reader-python-ingest.md)) in the
next backend and web release. no migration, no environment change. api and both
worker lanes run from one image.

wire: the source issue union (`ReaderTextDocumentOut.source_issues`,
`ImportDetail.source_issues`, offline copies) gains `TooManyNotes`. `WIRE_REVISION`
stays 13, which no release carries yet (android-v0.3.4 carries 11). if 13 ships
before this merges, this change needs 14. the web (reader notice, Imports) ships with
the backend; android and the extension are unchanged.

data effect: none on stored rows. new ingests change as the PR body lists (items
2-7 and the review's sanitizer fixes); a refresh keeps its media readable while it
runs and after it fails (item 1).

before release, on the newest production backup brought to the release's head (mac
only, disposable, deleted after), count only:

- media whose latest source attempt is in flight with a dead `ingest_media_source`
  job (L4's stuck refreshes failed `E_RESOURCE_CONFLICT`; any other dead refresh
  too): extracting with a publication, unreadable, offered a repair. after deploy a
  repair makes each readable again on its publication as its run starts, and a
  refusal settles it failed at once; the owner repairs them.
- failed web articles and pdfs that keep a reader publication (a refresh that failed
  before this release left them unreadable). nothing here changes them until their
  creator refreshes or retries one, whose admission makes it ready on the retained
  publication; the owner decides whether that, or a one-off repair, is wanted.
- `release-reader-python-ingest.md`'s C21 and C22 now read: an undeclared or absent
  raster in an `img` or an inline svg no longer refuses a book (8a67: 4 attempts), and
  a web article over the apparatus budget publishes with its notes inline (8a67: 2
  `E_SANITIZATION_FAILED` attempts, cause unproven).

delete this file once those counts are taken and the owner has decided the
repairs.

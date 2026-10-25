# release: ingest follow-ups

status: #718 already shipped with the reader python ingest re-slice in production
`dc12792e0` (schema 0312, wire 14). no migration or environment change was needed.
the remaining existing-data census and repair decisions below are not established
by deployment; [reader ingest](release-reader-python-ingest.md) owns its related counts.

wire: the source issue union (`ReaderTextDocumentOut.source_issues`,
`ImportDetail.source_issues`, offline copies) gained `TooManyNotes`. the deployed
wire-14 api/web pair already includes it; the original conditional wire-bump
instructions are obsolete. #718 changed neither android nor the extension.

data effect: none on stored rows. new ingests change as the PR body lists (items
2-7 and the review's sanitizer fixes); a refresh keeps its media readable while it
runs and after it fails (item 1).

remaining census, on a current production backup at the current head (mac only,
disposable, deleted after):

- media whose latest source attempt is in flight with a dead `ingest_media_source`
  job (L4's stuck refreshes failed `E_RESOURCE_CONFLICT`; any other dead refresh
  too): extracting with a publication, unreadable, offered a repair. an ordinary
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

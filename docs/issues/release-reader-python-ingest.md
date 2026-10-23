# release: reader python ingest re-slice

status: on branch `cleanup/reader-python-ingest-reslice`; ships in the next
backend and web release. no migration, no environment change, no wire bump. api
and both worker lanes run from one image, as today. the web ships the one-line
canonical whitespace fix (`domTextCursor.ts`: U+FEFF is not whitespace, as in
python); it works with the old and the new backend. android and the extension
are unchanged.

data effect: none on stored rows (no backfill, no rewrite). new ingests change
only as the PR body lists (L3, L5, L7, L8, L12, R6).

before release, on the newest production backup brought to the release's head
(mac only, disposable, deleted after), count only:

- C18 (`2026-10-20/rpy/design.md` §5) must be 0: an epub with rows but no
  publication. the epub publish no longer deletes prior rows, so a nonzero count
  blocks the release until the publish's deletes return. the 8a67 backup
  (0292-era data, 10-18): 0.
- C19 (stored carriage returns; per kind, apparatus bodies, x wrappers): record
  the counts in `stored-carriage-returns-unmarkable.md`. 8a67: 0.
- C20-C23: failed sources this release may make importable (L3 duplicate
  spine, L7 undeclared raster image, L5 web budget, L12 capture refusals). give
  the owner the counts; the owner chooses which to retry. 8a67: 0, 4 (none
  naming an svg path; one whose image sits in inline svg still refuses:
  `epub-svg-wrapped-images-refuse-books.md`), 2 web `E_SANITIZATION_FAILED`
  (budget breach not established), 0.
- no P1/P2 (the design's stored-row canonicalization check): this release
  changes `canonicalize.py` only in its array typecode expression, which stores
  the same values for every text under 2^32 boundaries (the 64 MiB output cap
  bounds a fragment far below that), and leaves `html_tree.py` byte-identical.

after deploy, 24 h of worker logs: no rise in `E_INGEST_FAILED` or `E_WORKER_HANDLER_FAILED`
on `ingest_media_source`, no `IntegrityError` on `uq_epub_*`.

optional owner check (#660 / #661 on the private book57 originals; the
campaign never reads them): on the mac, with `<base>` the main sha this branch
merges onto, `<tip>` a checkout at the branch tip (or the merge) and
`<originals>` the directory holding the original epubs.

the former `nexus-web-campaign-artifacts/2026-10-20/rpy/harness/offline/`
command and inputs were owner-retired on 2026-10-22. this optional check has no
current executable. its required output is one line per book (SAME, or DIFF with
the first lines of the difference) and a report. a DIFF is acceptable only
where one of the listed rules applies (a duplicate spine document, an
undeclared raster image, an ncx over 16 MiB, a `&#13;` reference, inline svg
text, template content; with the ingest follow-ups, `hidden` or `aria-hidden`
content, svg `title`, `desc`, `metadata` or text outside a `text`, a `dd`, `dl`
or `dt` inside an svg, an svg that wraps a missing raster, a sup marker whose
note returns to the sup or whose label is bracketed); any other DIFF blocks the
release.

delete this file once the counts and the log observation are recorded.

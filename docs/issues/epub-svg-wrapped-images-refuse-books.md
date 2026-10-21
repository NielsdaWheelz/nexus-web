# epub images inside inline svg refuse the book

status: open (needs a ruling: a placeholder for the enclosing svg changes new
rows)
origin: 2026-10-20 review of the reader python ingest re-slice (13a)
area: reader python, epub

a raster image referenced by an svg `image` element
(`<svg><image xlink:href="cover.png"/></svg>`, the cover wrapper calibre and
sigil write) refuses the whole book `E_INVALID_FILE_TYPE` when the manifest
omits it or the archive lacks it:

- archived, undeclared: `Extraction failed: Referenced EPUB image asset missing
  from OPF manifest: <path>`;
- absent: `Extraction failed: Referenced SVG image asset missing from archive`.

the same image through an `img` imports as an unavailable image with a
`MissingImage` source issue (L7, the re-slice). main refuses all three svg cases
with the same messages; the re-slice keeps that.

impact: a readable book is refused for one image, usually its cover. census C21
(8a67, 0292-era): 4 failed attempts carry the manifest message; whether their
images sit in an `img` or an svg `image` is unknown
([epub-missing-images-abort-readable-books.md](epub-missing-images-abort-readable-books.md)).

evidence: `python/nexus/services/epub_ingest.py`, `_rewrite_chapter_resources`
(its `tag == "image" and missing_paths` arm) and `_ensure_asset_entry`. probe
epubs (`2026-10-20/rpy/harness/offline/probes/l7_svg_wrapped.py`):
`svg-undeclared-archived`, `svg-undeclared-absent`, `svg-declared-absent`
refuse identically on main `157b84471` and the branch; `img-undeclared-archived`
refuses on main and imports on the branch.

proposed fix: replace the enclosing `svg` with the image placeholder and record
a `MissingImage` issue, as `img` does. an svg that draws more than the one image
would lose that drawing, so the rule needs a ruling (owner or coordinator).

resolved when such a book imports with the placeholder and the source issue, or
a ruling keeps the refusal and this file goes.

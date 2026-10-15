# a title-page division inherits the whole work's extent

status: open; whole-book repair unsafe, not applied
origin: 2026-10-15 book-repair original-source review, operator `150328b65`
area: epub coincident section boundaries

media `868bf466-0862-4770-a46b-bd398a23a718` has separate sections for
the work title and the publisher's `Title Page`, both at `2:0`. the original
ncx explicitly names the latter. its complete source document contains only
the work-title h1 and author h2; the opf declares a different document as the
text start. the candidate keeps the title-page identity and label but expands
its end from `3:0` to the book's eof at `41:18545`, through contents and narrative.

the work-title division may legitimately span the book. it does not follow
that a separately named title page at the same coordinate has the same scope.
`python/nexus/services/reader_structure.py:103–107` gives coincident roots the
same natural end; no source container or qualified title-page boundary then
limits this publisher row. this is not a claim that every page should end at
a file boundary or that all flat publisher roots must remain section roots.

exact original page/opf/ncx and complete proposal are bound by
`c-sources/navigation-ra-eef-scope-review-v1.json`, sha256
`b4a100fe5ac91d0a3ff056bc281ba9c16dffceecd859e330b195c4e36dffbb0b`;
independent review `a-maintenance/ra-eef-scopes-independent-review.json`,
sha256 `3fc1e47c5f65330b4df0313b8337086d7249a8e4e8c9bfe546ec147b00e7b3ce`.
stored text and destinations remain intact. other changed fields are
unadjudicated; no api/browser/device behavior was executed.

resolve each section's semantic ownership before assigning a shared endpoint.
preserve the proven title-page scope while independently resolving the work
division. do not add a global label blacklist, infer every file as a division,
or fabricate an endpoint where source ownership is unknown.

acceptance: this full proposal keeps the title page at its authored page scope
and handles the independent work title correctly. verify coincident sections
with different roles and genuine equal-scope duplicates, then qualify complete
installed extents before applying this book. the shared range-owner repair is
outside the bounded campaign.

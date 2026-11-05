# reader section labels and search discard proved section ends

problem: server sections have semantic extents, but ordinary reader consumers use
only the latest section start. content after a bounded section can be attributed
to that section and included in its section-scoped search.

evidence: static inspection on 2026-11-04. for retained source
`<section><h2>one</h2><p>inside</p></section><p>outside</p>`,
`python/nexus/services/web_article_structure.py:515-550` proves the heading's
container and `python/nexus/services/reader_structure.py:215-217` caps its extent.
`python/nexus/services/reader_document.py:250-257` drops that end;
`apps/web/src/lib/documentReader/model.ts:296-301` uses last-start lookup and
`apps/web/src/lib/documentReader/text/find.ts:68-71` uses next start or document
end. thus `outside` belongs to `one` on the client despite lying outside its
server extent. this example has not been run in the browser.

impact: current-section labels, contents markers and section-scoped find can
disagree with source-backed piece selection. the opening-prefix fix does not
require a general extent rewrite: its next section starts at its exact end.

resolved when the reader's section ownership/search contract is explicit and
consistent with server extents, including bounded containers, nested sections
and text outside all sections. verify the source example through the real reader.

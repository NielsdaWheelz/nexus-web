# the sanitizer publishes noscript content and hidden web text as readable

status: open (owner judgement)
origin: 2026-10-20 reader python ingest harness (`2026-10-20/rpy/harness/defects.txt` N4, N5)
area: reader python, html substrate (both sanitizer policies)

- noscript: both policies unwrap `noscript`, so its content is stored as ordinary
  visible paragraphs, though the canonicalizer and the source browser skip the
  element (`gen-hostile.epub`: "noscript zeta" in canonical text). `template`,
  the other half of N4, is dropped since the re-slice.
- hidden (web policy only): `hidden` and `aria-hidden` are not allowlisted, so
  the attribute goes and the text stays visible. a capture packet (no
  readability upstream) publishes hidden text as readable (journey S2: "hidden
  theta", "aria hidden iota"); fetched pages are safe only because readability
  drops hidden nodes first.

impact: readers see text the source did not show. the opposite choice also
costs: noscript often carries the only fallback image, and `hidden` often hides
accordion content a reader wants, which is why this waits on the owner.

evidence: `python/nexus/services/sanitize_html.py` (`_WEB_TAGS`,
`_EPUB_DROPPED`, the web visit's attribute rule); harness journeys S2, S3.

resolved when the owner chooses per element (drop with content, keep hidden,
or keep visible), and the identity corpus shows only the chosen change on new
ingests.

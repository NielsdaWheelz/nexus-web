# PDF

PDF source acceptance is owned by `media_source_ingest.py`.

- Public URL, upload, and browser-file capture entry points create a `media` row
  plus a `media_source_attempts` row before PDF fetch/extraction work starts.
- `ingest_media_source` is the only worker job kind that starts source
  processing. It dispatches remote PDF fetches, uploaded PDFs, and
  browser-captured PDFs into the PDF extraction task after the source is durable.
- `pdf_ingest.py` owns PDF text extraction artifacts, page spans, plain text,
  and evidence-index handoff.
- `pdf_readiness.py`, `pdf_highlights.py`, and related reader services own PDF
  quote/highlight readiness and locator behavior.

Retry and refresh create a new source attempt. They do not enqueue `ingest_pdf`
directly from routes or UI clients.

## Reader Apparatus

PDF reader apparatus is intentionally conservative.

- `pdf_ingest.py` may emit exact `bibliography_ref` rows from native internal
  PDF links whose destinations are citation destinations and whose source
  rectangles have exact page geometry.
- When those native citation destinations resolve to deterministic bracketed
  reference blocks, the same adapter may emit exact `bibliography_entry` targets
  and `cites_bibliography_entry` edges. This is scoped native-link graph
  support, not generic PDF citation parsing.
- For arXiv PDFs with a committed source package, source-first TeX/BibTeX
  apparatus may emit `bibliography_ref`, `bibliography_entry`, and source
  footnote rows from structured LaTeX/BibTeX files. This verifies the source
  package citation graph; it does not imply PDF page-geometry alignment unless
  geometry locators are explicitly present.
- For law-review-style born-digital PDFs, the `pdf_legal_footnotes_v1` adapter
  may emit `footnote_ref`, `footnote`, and `points_to_note` rows only when
  raised body markers pair one-to-one with same-page lower-band note labels via
  exact page geometry, footnote-sized target text, and adjacent body-text marker
  context. These rows are `strong` confidence because the PDF does not encode
  semantic note links.
- Marker-only PDF apparatus remains `partial` when native citation links exist
  but target materialization cannot be resolved without ambiguity.
- Plain extracted text, superscript-like glyphs, line numbers, and reference
  section segmentation do not create apparatus rows by themselves.
- Redistributable scholarly PDFs may be committed as unsupported-adapter
  fixtures to prove this negative behavior. That fixture status is not a claim
  that notes, references, or author-year citations have been extracted.
- Future scholarly, legal-footnote, or literary-annotation PDF support must be
  explicit adapter work with its own diagnostics, confidence contract, and
  fixtures.

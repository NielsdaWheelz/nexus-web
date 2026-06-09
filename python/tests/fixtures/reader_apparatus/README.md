# Reader Apparatus Fixtures

This directory contains deterministic fixtures for source-authored reader
apparatus extraction: footnotes, endnotes, sidenotes, bibliographies, reference
lists, and in-document citation markers.

`corpus_manifest.json` is the authoritative source for:

- the 20 motivating source URLs,
- fixture commit policy and current support status,
- verifier tier and proof scope for each automated fixture,
- source-level apparatus support level,
- source-level raw fixture eligibility,
- structured source and fixture license/provenance metadata,
- committed fixture paths,
- byte lengths and SHA-256 hashes,
- expected apparatus counts, confidences, methods, and body needles,
- fixture-to-real-media/API coverage contracts,
- non-apparatus legacy media files that must not be reused as reader apparatus
  evidence,
- whether a source has only been temporarily scanned or is actually covered by
  a deterministic fixture.

Do not duplicate expected counts or fixture hashes in README prose or test
constants. Tests should load the manifest through
`tests.reader_apparatus_corpus`.

## Fixture Policy

- Full committed documents must be legally redistributable and documented in
  the manifest.
- Restricted or unclear sources stay URL-only. Tests may use synthetic pattern
  fixtures that mimic source-authored markup shapes, but not copied source text.
- `license_provenance` is required for every source and every automated
  fixture. Raw committed full-source fixtures must be marked
  `verified_redistributable`; legacy existing fixtures such as
  `attention.pdf` may only be used under an explicit partial/legacy contract.
- `raw_source_fixture_eligibility` describes whether the motivating source is
  legally/procedurally eligible to become a raw fixture. It does not describe
  current parser coverage.
- `apparatus_support_level` describes current tested support. Legal eligibility
  can coexist with `url_only`, `pattern_verified`, or
  `shared_pattern_verified` until a source fixture and independent verifier
  exist.
- `committed_fixture_graph_verified` and
  `committed_fixture_negative_graph_verified` only claim that the committed
  fixture graph was verified. They do not claim live-upstream completeness,
  unsupported adapter support, or UI surfacing unless those contracts are listed
  separately. Fixture-scope "all" language must be backed by a structured
  independent DOM/archive verifier or a gold graph.
- HTML pattern fixtures in `html/` are minimal parser fixtures, not complete
  copies of the motivating web pages.
- PDFs in sibling fixture directories that are not part of the apparatus corpus
  must be listed in `non_apparatus_fixture_files` and may not be treated as
  positive or negative apparatus coverage.
- Live/manual corpus fetches must write to a local ignored cache, not into the
  repository.
- Every automated fixture must be mapped in `real_media_fixture_contracts` to
  the API/ingest test path that exercises it, or to an explicit non-media
  contract such as an arXiv source package unit contract.
- Every automated fixture must also be classified in `verifier_tiers`. The tier
  describes the proof source: independent DOM/archive/PDF/source-package
  verifier, current-extractor gold snapshot, hand-sampled gold, unsupported
  negative, or synthetic pattern.
- Every automated fixture must be listed in `frontend_surface_contracts`. That
  ledger distinguishes payload projection, direct Citations component rendering,
  reader-shell publication, and reader-shell omission proof, so payload-rendered
  fixtures cannot be mistaken for complete frontend coverage.
- A green automated fixture proves the declared fixture contract only. It does
  not prove broader source formats, unsupported adapters, live upstream drift, or
  frontend surfacing unless those contracts are also listed and tested.

## HTML Fixtures

- `distill-custom-citations.html`: Distill-style `d-cite`, `d-footnote`, and
  rendered bibliography list.
- `distill-legacy-bibtex.html`: older Distill-style `dt-cite` with
  source-authored BibTeX metadata.
- `distill-misread-tsne-full.html`: curated Distill source fixture preserving
  the article body and legacy BibTeX citation metadata.
- `distill-gp-full.html`, `distill-growing-ca-full.html`, and
  `distill-research-debt-full.html`: curated Distill source fixtures
  preserving article-body `d-cite`/`d-footnote` markup and bibliography
  metadata while excluding unreviewed external assets.
- `gwern-dpub-endnotes.html`: DPUB-style noteref/endnotes/backlink markup.
- `gwern-sidenote-full.html`: curated Gwern article/endnotes fixture with the
  complete source-authored `doc-noteref` graph for the motivating page.
- `tufte-sidenote.html`: Tufte CSS label/input/sidenote structure.
- `tufte-css-full.html`: curated Tufte CSS article fixture preserving all
  label/input sidenote and margin-note apparatus while excluding external
  media assets.
- `numinous-ttft-full.html`: curated Numinous TTFT article fixture preserving
  all standalone `span.marginnote` apparatus and the source license text while
  excluding external media assets.
- `mediawiki-references.html`: MediaWiki `sup.reference` and
  `li#cite_note-*` backlink structure.
- `wikipedia-waste-land-full.html`: curated text-only MediaWiki parser-output
  fixture preserving reference markers, targets, backlinks, and rendered
  `CITEREF` works-cited links while excluding media assets.
- `legacy-named-notes.html`: old flat HTML `a[href=#fNNn]` markers pointing to
  `a[name=fNNn]` targets in a trailing `Notes` block. This is a synthetic parser
  fixture for a blocked motivator, not counted full-source corpus coverage.
- `gutenberg-argonautica-full.html`: full Project Gutenberg source fixture with
  39 `linknoteref-N` markers, `linknote-N` anchors, `p.footnote` bodies, and
  backlinks preserved. It is the fixture-eligible linked-endnote source replacing
  the rights-blocked Paul Graham motivator in the counted corpus.
- `gutenberg-waste-land-full.html`: full Project Gutenberg source fixture with
  the notes chapter and full Project Gutenberg license terms preserved. It is a
  full-source negative fixture: the source has no encoded marker-to-note graph,
  so the parser must not invent apparatus edges.
- `gutenberg-notes-chapter-negative.html`: minimal stress fixture for a notes
  chapter without inline marker-to-note relationships.
- `legacy-named-notes-negative.html`: old named anchors without enough source
  evidence to infer note edges.

EPUB and PDF media fixtures referenced by the manifest live in sibling fixture
directories.

## PDF Fixtures

- `pdf/law-review-footnotes.pdf`: synthetic law-review layout fixture for
  paired same-page legal footnotes. It verifies geometry-based footnote pairing,
  not Bluebook citation parsing or full Harvard Law Review source coverage.
- `pdf/philpapers-lop-aiz.pdf`: committed CC BY PhilPapers PDF fixture for an
  unsupported scholarly-PDF adapter contract. It verifies that the current PDF
  adapters do not invent apparatus from endnote/reference text or external URI
  links. It is not a citation-completeness fixture until a scholarly PDF/TEI
  adapter and independent verifier exist.
- `pdf/commons-waste-land.pdf`: committed Wikimedia Commons public-domain PDF
  fixture for an unsupported literary-PDF adapter contract. It verifies that the
  current PDF adapters do not invent apparatus from OCR/plain text or printed
  notes when the PDF has no encoded link graph or supported footnote geometry.
  It is not literary-PDF note extraction support.

## Scholarly TEI Fixtures

- `reader_apparatus/tei/philpapers-lop-aiz.grobid-0.8.2.tei.xml`: parser-only
  GROBID 0.8.2 TEI fixture generated from the committed PhilPapers CC BY PDF.
  It verifies conservative TEI bibliography graph extraction and unresolved-ref
  diagnostics. It does not promote the PhilPapers source to citation-complete
  coverage; a hand-audited gold graph is still required for that.

## ArXiv Source Fixtures

- `arxiv/2606.01109-source.tar`: committed arXiv source package used for
  TeX/BibTeX source-first citation graph verification and for the remote arXiv
  PDF ingest-to-reader-apparatus API contract. It is not a PDF geometry fixture:
  source-package rows are expected to surface as sidecar items with missing PDF
  locators.

# EPUB Test Fixtures

Real and synthetic EPUB files for integration smoke testing of the S5
extraction pipeline. Synthetic in-memory builders in `test_epub_ingest.py`
remain the primary edge-case and failure-injection harness; these fixtures
complement them with parser fidelity coverage on complete archive structures
produced by real tool chains.

## Real Book Corpus (Project Gutenberg, public domain)

Four public-domain books, each in EPUB 2 (`-old`) and EPUB 3 (`-epub3`)
versions. Sourced from [Project Gutenberg](https://www.gutenberg.org/).
All carry "Public domain in the USA" rights per `dc:rights` metadata.

| File | Title | PG# | Format | Size | Covers |
|------|-------|-----|--------|------|--------|
| `confessions-epub3.epub` | The Confessions of St. Augustine | 3296 | EPUB3 (nav + ncx) | 319K | Multi-chapter spine, nav TOC, cover image, CSS |
| `confessions-old.epub` | The Confessions of St. Augustine | 3296 | EPUB2 (ncx) | 326K | Multi-chapter spine, NCX TOC, cover image, CSS |
| `zarathustra-epub3.epub` | Thus Spake Zarathustra | 1998 | EPUB3 (nav + ncx) | 637K | Many chapters (27+), nav TOC, cover image, CSS |
| `zarathustra-old.epub` | Thus Spake Zarathustra | 1998 | EPUB2 (ncx) | 640K | Many chapters, NCX TOC, cover image, CSS |
| `moby-dick-epub3.epub` | Moby Dick; Or, The Whale | 2701 | EPUB3 (nav + ncx) | 797K | Large book (11+ chapters), nav TOC, cover image, CSS |
| `moby-dick-old.epub` | Moby Dick; Or, The Whale | 2701 | EPUB2 (ncx) | 821K | Large book (22+ chapters), NCX TOC, cover image, CSS |
| `city-of-god-epub3.epub` | The City of God, Volume I | 45304 | EPUB3 (nav + ncx) | 574K | Large book (11+ chapters), nav TOC, cover image, CSS |
| `city-of-god-old.epub` | The City of God, Volume I | 45304 | EPUB2 (ncx) | 592K | Large book (22+ chapters), NCX TOC, cover image, CSS |

These exercise real-world parser paths: varied chapter counts, real
HTML content patterns, CSS stylesheets, cover images (JPEG/PNG), and
tool-chain-specific OPF/packaging conventions that synthetic builders
cannot reproduce.

## Synthetic Edge-Case Fixtures

Generated programmatically for deterministic edge-case coverage that
real books don't naturally provide.

| File | Format | Covers |
|------|--------|--------|
| `epub3_assets.epub` | EPUB3 | Internal image + stylesheet refs, external image rewrite, broken ref degradation, active-content sanitization (`<script>`, `onclick`, `javascript:` URL) |
| `epub3_unicode.epub` | EPUB3 | Unicode text (emoji, CJK, Arabic, combining marks, NBSP), NFC normalization |

## Guidelines

- Real fixtures are Project Gutenberg public domain works. Keep the
  corpus small and repository-safe (total < 10 MB).
- Synthetic fixtures contain only original test content with no
  license restriction.
- Each fixture documents which S5 scenarios/invariants it covers.
- Synthetic in-memory builders remain the primary edge-case/failure
  harness; real fixtures are complementary parser-fidelity smoke coverage.

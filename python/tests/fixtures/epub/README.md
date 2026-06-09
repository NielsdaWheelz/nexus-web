# EPUB Test Fixtures

EPUB fixtures for backend integration and parser-fidelity tests.

## Contents

- Real public-domain books from Project Gutenberg (`*-old.epub`, `*-epub3.epub`).
- Standard Ebooks public-domain/CC0 EPUBs used for cross-fragment endnote
  apparatus coverage.
- Synthetic fixtures for deterministic edge cases:
  - `epub3_assets.epub`
  - `epub3_unicode.epub`
  - `reader-apparatus-note.epub`

## Purpose

- Real books cover packaging/toolchain variance and full-archive parsing behavior.
- Synthetic files cover targeted failure and edge-case behavior.

Synthetic in-memory builders in backend tests remain the primary edge-case harness.
These files complement that harness with real archive fidelity checks.

## Fixture Policy

- Keep corpus size repository-safe.
- Keep synthetic content license-clean and deterministic.
- Document new fixtures in this file with what behavior they validate.
- Reader-apparatus counts, hashes, and source-corpus coverage are authoritative
  in `../reader_apparatus/corpus_manifest.json`.

## Documented Synthetic Fixtures

### reader-apparatus-note.epub

- Source: synthetic fixture built for reader apparatus tests.
- License: repository test fixture.
- Byte length: 1190
- SHA-256: `ce63bfa76e30cb056ca5f4e5b2b21f6f7f3cc0bcf19315c5667410d416767b82`
- Purpose: EPUB 3 fixture with `epub:type="noteref"` pointing to
  `epub:type="footnote"`, used to verify exact persisted reader apparatus
  through the real file-ingest path.

## Documented Real Fixtures

### waste-land-epub3.epub

- Source URL: https://www.gutenberg.org/ebooks/1321.epub3.images
- Catalog URL: https://www.gutenberg.org/ebooks/1321
- Source title: The Waste Land
- Publisher: Project Gutenberg
- License: Public domain in the USA; Project Gutenberg license bundled in the EPUB.
- Byte length: 83841
- SHA-256: `de1125e11abf9ede2417527a2a9043f8186464833f303e17297fbb2e18272c04`
- Purpose: real EPUB fixture with a plain notes chapter and no exact inline
  note-reference links, used to verify reader apparatus does not invent edges.

### standardebooks-t-s-eliot-poetry.epub

- Source URL: https://standardebooks.org/ebooks/t-s-eliot/poetry/downloads/t-s-eliot_poetry.epub?source=download
- Catalog URL: https://standardebooks.org/ebooks/t-s-eliot/poetry
- Source title: Poetry
- Publisher: Standard Ebooks
- License: Standard Ebooks production content is public domain via CC0; source
  work is public domain in the United States.
- Byte length: 470962
- SHA-256: `7fc1c684ff08b36b4ac9a3900fafd4b5b4d6c2ba31662a05b9dc5a97368baaa2`
- Purpose: real EPUB fixture with 53 cross-fragment
  `endnote_ref -> endnote` relations.

### standardebooks-t-s-eliot-poetry-advanced.epub

- Source URL: https://standardebooks.org/ebooks/t-s-eliot/poetry/downloads/t-s-eliot_poetry_advanced.epub?source=download
- Catalog URL: https://standardebooks.org/ebooks/t-s-eliot/poetry
- Source title: Poetry
- Publisher: Standard Ebooks
- License: Standard Ebooks production content is public domain via CC0; source
  work is public domain in the United States.
- Byte length: 582941
- SHA-256: `cb8605e49a6f2d79cc99d26fe0e5cdfbde4c1f3738e8497ee6cda5f5198506ab`
- Purpose: advanced real EPUB fixture with the same 53 cross-fragment
  `endnote_ref -> endnote` relations as the regular edition.

### standardebooks-william-james-pragmatism.epub

- Source URL: https://standardebooks.org/ebooks/william-james/pragmatism/downloads/william-james_pragmatism.epub?source=download
- Catalog URL: https://standardebooks.org/ebooks/william-james/pragmatism
- Source title: Pragmatism
- Publisher: Standard Ebooks
- License: Standard Ebooks production content is public domain via CC0; source
  work is public domain in the United States.
- Byte length: 661212
- SHA-256: `055a87eafc57df5bdfc1775d577942f62ab26876228adc982b211ad4ff123295`
- Purpose: real EPUB fixture with 13 cross-fragment
  `endnote_ref -> endnote` relations.

### standardebooks-william-james-pragmatism-advanced.epub

- Source URL: https://standardebooks.org/ebooks/william-james/pragmatism/downloads/william-james_pragmatism_advanced.epub?source=download
- Catalog URL: https://standardebooks.org/ebooks/william-james/pragmatism
- Source title: Pragmatism
- Publisher: Standard Ebooks
- License: Standard Ebooks production content is public domain via CC0; source
  work is public domain in the United States.
- Byte length: 834443
- SHA-256: `dde746bac2ee6f99cf386068b951838e5686fa771ba6cf85c9dd092db2568355`
- Purpose: advanced real EPUB fixture with the same 13 cross-fragment
  `endnote_ref -> endnote` relations as the regular edition.

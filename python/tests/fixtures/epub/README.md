# EPUB Test Fixtures

EPUB fixtures for backend integration and parser-fidelity tests.

## Contents

- Real public-domain books from Project Gutenberg (`*-old.epub`, `*-epub3.epub`).
- Synthetic fixtures for deterministic edge cases:
  - `epub3_assets.epub`
  - `epub3_unicode.epub`

## Purpose

- Real books cover packaging/toolchain variance and full-archive parsing behavior.
- Synthetic files cover targeted failure and edge-case behavior.

Synthetic in-memory builders in backend tests remain the primary edge-case harness.
These files complement that harness with real archive fidelity checks.

## Fixture Policy

- Keep corpus size repository-safe.
- Keep synthetic content license-clean and deterministic.
- Document new fixtures in this file with what behavior they validate.

# S5 PR-05 Hardening Notes

## Scope

This hardening pass stabilizes EPUB reader navigation by aligning backend
navigation contracts and frontend anchor behavior.

## Canonical Navigation Contract

- New canonical endpoint: `GET /media/{id}/navigation`
- Response shape:
  - `sections[]`: canonical reader targets (`section_id`, `fragment_idx`,
    `anchor_id`, `source`, `ordinal`)
  - `toc_nodes[]`: deterministic TOC tree with nullable `section_id` linkage
- Reader URL contract:
  - canonical deep link query param is `loc=<section_id>`
  - legacy `chapter=<idx>` remains fallback-only during initial resolution

## In-Fragment TOC Navigation

Many EPUB TOC leaves target anchors inside a fragment (`#anchor`).
To keep those links navigable:

- EPUB sanitization now preserves anchor target attributes (`id`, `a[name]`)
  via an EPUB-only sanitizer option.
- Security posture remains strict:
  - event handlers (`on*`) still removed
  - `class`/`style` still removed
  - script/form/iframe/svg/etc. still removed

## Operational Notes

- Migration `0015` must be applied before serving `/media/{id}/navigation`.
- Historical rows without persisted nav locations still work via runtime fallback
  in `epub_read` (derived sections from TOC/fragments).
- Existing rows ingested before anchor-preservation changes may require
  re-ingest/re-extract to populate preserved anchor targets in stored fragment HTML.

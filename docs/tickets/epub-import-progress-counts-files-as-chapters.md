# epub import progress names content files as chapters

status: open
origin: 2026-09-12 reader document map cutover audit
area: source ingestion progress

`python/nexus/services/epub_ingest.py:668` counts staged spine files and emits
the unit `Chapter`. `apps/web/src/lib/status/imports.ts:455` consequently tells
the user “extracting chapter x of y”, even when one file contains many chapters
or numbered entries. reader navigation no longer uses this count.

replace this import-progress vocabulary with the existing fragment/resource
concept across source publication, python/ts schemas, progress copy, and stored
attempt history. preserve counts; do not reinterpret them as semantic sections.
coordinate the strict wire/history cutover with the source-progress owner.

acceptance: an epub with several headings in one spine file reports one content
file of extraction work without calling it one chapter; typed live/history
progress agrees, while reader section counts remain independent.

# db substrate release acceptance

merged in #711 and deployed in production `99320b630` on 2026-10-22, schema 0306.
the mapping no longer restates ddl; the database owns those rules. the complete
migration chain passed on the fresh stopped-writer restore and in production.
0303 converted json-null retrieval locators; the production post-check found zero
remaining json-null locators. the x source repair and schema deployment are complete.

remaining owner checks are `NOT_RUN`:

- run the campaign's schema identity check in the paired image on a disposable
  current backup restore (`2026-10-20/db/sketches/identity.py <dsn> models.py retries.py`)
  and record c1–c10 (`2026-10-20/db/spec.md` §8). c2 and c7 passed in production;
  the other census entries and the dedicated mapping check are not established
  by migration success. c8 includes the four mapped generated columns and
  raw-sql-owned `content_chunks.chunk_text_tsv`.
- observe 24 hours of api/worker logs: no foreign-key violations or increase in
  `exhausted after` failures.

delete this file once the remaining mapping and observation checks are
complete. passing release health does not substitute for them.

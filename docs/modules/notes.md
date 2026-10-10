# notes

`api/routes/notes.py` and `services/notes.py` (under `python/nexus/`) own pages,
daily pages and note-block reads. web paths are relative to `apps/web/src/`.

## page and daily read boundary

the seven json routes (`GET`/`POST /notes/pages`, `GET`/`PATCH
/notes/pages/{id}`, `GET /notes/daily/{date}`, `POST
/notes/daily/{date}/captures`, `GET /notes/blocks/{id}`) return their owned
models through `Data`, by camel alias; page deletion is a bodyless 204. pages
are viewer-owned. list query validation, ordering and tie-breaks, title bounds,
timestamps and daily metadata presence are the server contract. create is
idempotent by the caller-chosen page id; a different owner or title conflicts.
a daily read of an unbound date returns a `Latent` descriptor and creates
nothing; a bound date returns `Materialized` with its page and surface.

`lib/notes/pageContract.ts` uses the generated page and summary types and adds
only the canonical action subject; list, create, get and daily reads consume
generated endpoint output. body/block parsing, journals and recovery keep their
own owners.

the writing acknowledgement, persistence protocol and outline contracts have no
module doc yet: [ticket](../tickets/notes-writing-contract-has-no-module-doc.md).

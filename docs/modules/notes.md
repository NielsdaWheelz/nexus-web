# notes

`api/routes/notes.py` and `services/notes.py` (under `python/nexus/`) own pages,
daily pages and note-block reads. web paths are relative to `apps/web/src/`.

## page and daily read boundary

the seven json routes (`GET`/`POST /notes/pages`, `GET`/`PATCH
/notes/pages/{id}`, `GET /notes/daily/{date}`, `POST
/notes/daily/{date}/captures`, `GET /notes/blocks/{id}`) return their owned
models through `Data`; page deletion is a bodyless, idempotent 204. pages
are viewer-owned. the index is a keyset collection page (`sort`, `direction`,
`limit`, `cursor`) in the chats index's four views (`UPDATED_TITLE_PLANS`); title
bounds, timestamps and daily metadata presence are the server contract. create is
idempotent by the caller-chosen page id: the same owner gets the page back, another
owner's id conflicts.
a daily read of an unbound date returns a `Latent` descriptor and creates
nothing; a bound date returns `Materialized` with its page and surface.

`lib/notes/pageContract.ts` adds the canonical action subject to a page; the index
(`NotesPaneBody`, `useServerList` over `fetchNotePages`) and create (`createPage`,
publishing `Notes`) consume generated endpoint output. body/block parsing, journals and recovery keep their
own owners.

the writing acknowledgement, persistence protocol and outline contracts have no
module doc yet: [ticket](../tickets/notes-writing-contract-has-no-module-doc.md).

# portable authored export

status: explicitly deferred by the owner on 2026-11-10 for a future agent.
keep outside the current journal, task and habit work. no implementation authorized.

problem: the inspected user surfaces do not offer a complete portable export
of authored notes, pages, annotations and their relationships.

evidence at nexus `71726834845554b5d533b07bf83d13d5e26b69da`:
`apps/web/src/lib/notes/clipboard.ts:17-23` emits a private structured clipboard
format and indented plain text. `node/authored/src/types.ts:33-49` contains
identities, authored state, links and passage provenance that plain text cannot
retain. inspection of web settings/actions, api routes and module docs found no
authored-vault export. this bounded search does not prove absence everywhere.

impact: durable local storage is not an independently readable archive. moving
writing to another application or inspecting it outside nexus requires more
than copying visible text.

decision: define the export scope and fidelity. readable markdown can be paired
with structured identities, relationships, source locators and attachment
mappings. retain the authored store as the only writable authority.

future pickup: recheck the then-current authored model, including the note-owned
work facts in [notes](../modules/notes.md#work). inventory existing export surfaces before adding one.
agree on readable export versus lossless backup; do not turn this into a second
writable file store or silently omit completion history.

resolved when an exported sample containing nested writing, formatting, links,
images and source annotations remains understandable outside nexus, and every
unsupported or omitted feature is explicit. do not promise round-trip import
unless its separate semantics are designed and verified.

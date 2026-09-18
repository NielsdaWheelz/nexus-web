# note passage links have no navigation consumer

status: open · origin: 2026-09-17 cleanup audit, 8cbfc9580 · area: note navigation · oi-165

`python/nexus/services/resource_items/routing.py:503,640` emits
`/notes/{id}#passage-{anchor}`. `NotePaneBody.tsx` consumes explicit note pulse
targets but does not resolve passage hashes; the live passage resolution in
`services/reader_connections.py:321-325` only handles media owners.

establish whether note passage navigation is a present product requirement.
give it one route-to-resolution-to-editor owner, or remove the unused locator
path. do not add another durable offset source. quote resolution already maps
normalized note matches back into raw stored-text offsets.

acceptance: a created note passage link navigates and marks its intended text,
or the unsupported link capability and its dead consumers are removed together.

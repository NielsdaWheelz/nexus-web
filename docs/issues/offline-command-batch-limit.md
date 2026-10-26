# offline command backlog exceeds the upload contract

`bf2a168d7`, stock firefox run `20261026-115038-c9d19f41c903`, creates and edits
a page/note offline, kills the browser, then reopens the same profile offline
with exact durable text. read-only sql proves both resources absent on the
server before reconnect. reconnect never uploads them within ninety seconds.

`failure-store.json` shows command sequence 77, server cursor zero and sync error;
`api.log` records repeated `POST /authored/changes` 400 `E_INVALID_REQUEST`.
`schemas/authored.py:UploadChanges` caps a packet at 64 changes, while browser
`Persistence.pending` reads up to 100 and applies only a byte bound. the native
pending reader needs the same protocol count bound.

bound upload selection by both count and bytes, retaining the immutable ordered
pending prefix. resolve with the unchanged firefox backlog/kill/reopen/reconnect
journey and the corresponding installed-host path; do not raise the server cap
or reduce the workload.

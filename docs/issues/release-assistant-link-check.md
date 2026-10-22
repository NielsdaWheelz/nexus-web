# release steps owed by the assistant link check

status: open · origin: 2026-10-19 cleanup/assistant-link-check · area: release / resource graph

0294 dropped `ck_resource_edges_assistant_snapshot_excerpt`, which refused every
assistant link (and the chat answer carrying it) since 0290. production `99320b630`
ran it on 2026-10-22.

owed after the release:

- one assistant link lands: a chat asked to link two resources in its context
  answers, its tool card shows the link, and Connections lists it as an
  assistant-created link with its rationale.

resolved when that is recorded. delete this file then.

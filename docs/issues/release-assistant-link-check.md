# release steps owed by the assistant link check

status: open · origin: 2026-10-19 cleanup/assistant-link-check · area: release / resource graph

0294 drops `ck_resource_edges_assistant_snapshot_excerpt`, which refused every
assistant link (and the chat answer carrying it) since 0290. no row changes; an
ordinary `deploy.sh <sha>` applies it.

owed after the release:

- the release log shows 0294 applied, with its line `0294 census: <n> assistant edges`.
- one assistant link lands: a chat asked to link two resources in its context
  answers, its tool card shows the link, and Connections lists it as an
  assistant-created link with its rationale.

resolved when both are recorded. delete this file then.

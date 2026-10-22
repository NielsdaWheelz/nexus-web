# new-chat retries can recreate deleted chats

status: open
origin: 2026-10-16 chat viewer specification review
area: chat / admission replay

`python/nexus/services/chat/admit.py::_settle` uses the surviving `ChatRun`
to answer an accepted command's retry. the `chat_runs` foreign keys
(`migrations/alembic/versions/0306_baseline_schema.sql:4620,4628,4644`, `ON DELETE
CASCADE`) delete that row when its conversation or messages are deleted by
`conversations.py::_delete`. retrying the original `New`
request/key then finds no run, creates a conversation in `_destination` and
admits the old run id again. this is source-proven; no destructive live
reproduction of `New` was performed.

since the chat re-slice a new chat's uncertain send lives only in its tab's command
owner (`apps/web/src/lib/chat/commands.ts`, key `account:new`): the retry window is the
tab's life, no longer a reload-surviving session-storage request. the hazard is the same
inside that window.

impact: a response lost before deletion can later resurrect a chat and incur
another generation. the viewer's conditional existing-chat writes fence its
`Existing` requests; conversation revision checks alone cannot fence `New`.

prerequisite: a separate creation/recovery contract consistent with the binding
no-replay-ledger rule in `origin/main:AGENTS.md` at `ff5712884`. after hard
deletion, absent durable evidence cannot distinguish an unadmitted request
from a deleted accepted request. do not rename a replay table to evade that
rule or claim a revision check solves `New`. the user explicitly deferred
creation/retry and draft persistence from the viewer scope on 2026-10-16.

acceptance: admit a disposable new chat, lose its response, delete the chat,
then exercise the chosen recovery protocol. it must not silently recreate a
conversation or issue another provider call. document the supported recovery
lifetime, unavoidable information limit and treatment of pre-cutover commands.

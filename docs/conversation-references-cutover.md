# Conversation References Cutover

## Status

This is the canonical post-cutover contract for conversation references,
reader-backed chats, citation write-through, chat-run tailing, and the `/tree`
read path.

The cutover is strict:

- No singleton chat API.
- No `scope_*` conversation columns.
- No `message_context_items`.
- No `/api/conversations/resolve`.
- No `/api/chat-references/*`.
- No legacy payload aliases.
- No fallback compatibility path.

Any code path that still depends on those concepts is wrong and should be
deleted, not adapted.

## Problem Statement

The previous refactor mixed two different designs:

1. A reference model where a conversation owns a flat set of resource URIs.
2. Older chat-target and singleton mechanics where a conversation was implicitly
   "about" one document, library, or branch.

That split created concrete failures:

- Sending from reader flows sent stale `singleton` payloads.
- Reader document chats opened full conversation panes instead of staying in the
  reader-adjacent chat surface.
- Full conversation panes and reader panes had separate reference state.
- Reference labels duplicated because the client and backend did not share one
  event/API shape.
- `/conversations/{id}/tree` did too much database work and held request-scoped
  database sessions while large responses were transferred.
- The frontend repeatedly fetched `/tree` and active chat-runs after sends and
  SSE retries.
- SSE reconnect ownership was split across layers.
- Exhausted background jobs could become dead without finalizing the associated
  chat run.

The correct fix is one hard cutover to the reference contract below.

## Goals

- One table represents every durable conversation-to-resource connection.
- References are resource pointers, not copied payloads.
- Cited app-search results become durable references for later turns.
- Reader/library/podcast entry points create ordinary conversations with initial
  references.
- Frontend reference state is owned once per pane and rendered everywhere from
  that source.
- Hot read routes fully materialize payloads and release DB connections before
  response transfer.
- `/tree` is a read-only, batched query path.
- Chat-run SSE reconnects are bounded and owned by a single layer.
- Dead-lettered chat-run jobs deterministically finalize their chat runs.

## Non-Goals

- Preserving singleton chat behavior.
- Preserving stale BFF endpoints.
- Supporting both `uri` and `resource_uri`.
- Supporting both `scope` and `scopes` for app-search URI scoping.
- Preserving message-level context attachment tables.
- Reintroducing `conversation.scope_type`, `scope_media_id`, or
  `scope_library_id`.
- Tracking the origin or grouping of references.
- Keeping per-message historical attachment locality.
- Adding DB-level cascades to make cleanup implicit.
- Adding `INSERT ... ON CONFLICT` convenience paths.

## Design Rules

The database rules in `docs/rules/database.md` govern this cutover:

- Every table uses `id` plus `created_at`.
- Foreign keys use the database default non-cascading behavior.
- Cleanup is explicit in application code.
- Do not use `INSERT ... ON CONFLICT`.
- Check for an existing row with `SELECT`, then mutate.
- Use DB uniqueness only for true local schema-owned keys.

Consequences for this feature:

- `conversation_references` uses `created_at`, not `added_at`.
- `conversation_references.conversation_id` has no `ON DELETE CASCADE`.
- The dedupe invariant is enforced by a unique constraint plus explicit
  select-then-insert code.
- Test cleanup and application deletion paths must explicitly delete references.

## Data Model

`conversation_references` is the only durable association between a
conversation and a resource.

Required columns:

- `id uuid primary key default gen_random_uuid()`
- `conversation_id uuid not null references conversations(id)`
- `resource_uri text not null`
- `created_at timestamptz not null default now()`

Required constraints and indexes:

- `UNIQUE (conversation_id, resource_uri)` as
  `uq_conversation_references_conversation_uri`
- `ix_conversation_references_resource_uri` for reverse lookup/filtering
- `ix_conversation_references_conversation_created` for ordered conversation
  reference reads

The database does not parse `resource_uri`. URI grammar is validated in the
service/API layer.

## Resource URI Contract

All references use:

```text
<scheme>:<uuid>
```

Allowed schemes:

- `media`
- `library`
- `span`
- `chunk`
- `highlight`
- `page`
- `note_block`
- `fragment`
- `conversation`
- `message`

Invalid syntax is `400 E_INVALID_REQUEST`.

Unknown, forbidden, or invisible resources are not admitted through user-facing
reference add/create paths. Resolver reads can still represent an already
persisted stale reference as `missing=true` so existing rows do not crash prompt
assembly or API reads.

## Capability Contract

### References

A reference is:

- Conversation-scoped.
- Owned by the conversation owner.
- Ordered by `created_at`.
- Idempotent by `(conversation_id, resource_uri)`.
- Resolved on read into label, summary, inline body, fetch hint, and missing
  state.

A reference is not:

- A copied text payload.
- A message attachment.
- A scope column.
- A singleton chat marker.
- A permission grant.

### Resolution

`nexus.services.resource_resolver` is the only layer that converts URIs into
model/UI context.

Public surface:

```python
resolve(db, uri, *, viewer_id)
resolve_batch(db, uris, *, viewer_id)
```

The resolver returns:

- `uri`
- `label`
- `summary`
- `inline_body`
- `fetch_hint`
- `missing`

Resolution rules:

- Batch by scheme.
- Load each scheme group with bounded queries.
- Enforce viewer visibility before returning content.
- Inline only when the body is below the resolver threshold.
- Use `read_resource("scheme:uuid")` for citeable small/large resource fetches.
- Use `app_search(scopes=["media:uuid"], query=...)` or
  `app_search(scopes=["library:uuid"], query=...)` for large searchable scopes.

### Search Tool

`app_search` accepts `scopes: string[]`.

Rules:

- `scopes` entries are URI scopes, currently `media:UUID` and `library:UUID`.
- When `scopes` is omitted, app-search searches the conversation's referenced
  media/library set; if none exist, it uses the existing viewer-wide default.
- Singular `scope` is invalid for URI scoping and must surface as a tool error.
- The model should fix the tool call instead of getting a silent broad search.

The database `message_tool_calls.scope` column may continue to store the
resolved search scope label for retrieval bookkeeping. That is not the public
tool API.

### Read Resource Tool

`read_resource(uri)` fetches the full readable content for a referenced
citeable resource. It is the correct path for `span`, `chunk`, `highlight`,
`page`, `note_block`, `fragment`, `message`, and `conversation` summaries.

`media` and `library` are search scopes, not direct body reads. Their resolver
fetch hints point the model to `app_search(scopes=[...], query=...)`.

## API Contract

### POST `/conversations`

Creates an empty private conversation.

Request:

```json
{
  "initial_references": ["media:UUID", "library:UUID"]
}
```

Rules:

- `initial_references` is optional.
- Each URI is validated and admitted with the same service path as normal
  reference adds.
- Conversation creation plus initial references commit atomically.
- Invalid or invisible references fail the whole request.

### GET `/conversations`

Optional filter:

```text
has_reference=<scheme>:<uuid>
```

Rules:

- Returns conversations whose references contain that URI.
- Uses the same cursor and page shape as the normal conversation list.
- Fully materializes response payloads before releasing the request DB session.

### Conversation Reference API

The reference API returns the resolved payload shape:

```json
{
  "id": "reference-uuid",
  "conversation_id": "conversation-uuid",
  "resource_uri": "media:uuid",
  "label": "Human label",
  "summary": "Short summary",
  "inline_body": null,
  "fetch_hint": "app_search(scopes=[\"media:uuid\"], query=...)",
  "missing": false,
  "created_at": "2026-05-29T00:00:00+00:00"
}
```

The field is `resource_uri`. `uri` is not accepted as a compatibility alias.

### Deleted APIs

These APIs do not exist:

- `/api/chat-singletons/*`
- `/api/conversations/resolve`
- `/api/chat-references/*`

Frontend flows must call `/api/conversations` with `initial_references` or the
conversation reference API directly.

## SSE Contract

`reference_added` is emitted when a cited retrieval graduates into a durable
conversation reference.

Payload:

```json
{
  "reference_id": "reference-uuid",
  "conversation_id": "conversation-uuid",
  "resource_uri": "chunk:uuid",
  "label": "Source - chunk: first line",
  "summary": "First line of body",
  "inline_body": "optional inline text",
  "fetch_hint": "read_resource(\"chunk:uuid\")",
  "missing": false,
  "created_at": "2026-05-29T00:00:00+00:00"
}
```

Rules:

- Backend validates the strict payload before storing/replaying the event.
- Frontend SSE parsing requires the full resolved shape.
- Frontend upserts this event into pane-level reference state.
- Duplicate labels are a bug; the sidecar renders the resolved label once.

## Citation Write-Through

When a chat-run emits a citation index:

1. The chat-run service reads cited `message_retrievals`.
2. It maps citeable retrievals to reference URIs.
3. It inserts missing `conversation_references` rows idempotently.
4. It resolves each inserted row.
5. It emits `reference_added` after `citation_index`.

Uncited retrievals stay in retrieval tables only.

The insert path is:

1. Validate/adapt the URI.
2. `SELECT` for an existing row.
3. If absent, insert inside a savepoint.
4. On unique violation, reselect.
5. Return the row and whether it was newly created.

There is no `ON CONFLICT` path.

## Chat-Run Job State Machine

Background job dead-lettering and chat-run state must compose.

Required final states:

- A successful job completes the associated chat run.
- A failed retryable job leaves the chat run retryable until attempts remain.
- A job that exhausts attempts becomes `dead`.
- When a `chat_run` job becomes `dead`, the chat run finalizes to terminal
  `error` in the same database transaction as the dead queue transition.
- Expired running jobs that have already exhausted attempts are dead-lettered by
  the worker, not silently hidden by claim logic.

Worker responsibilities:

- Claim due jobs.
- Handle one expired exhausted running job per `run_once`.
- Invoke the kind-specific dead-letter handler in the same transaction before
  commit.
- Reload and handle the job if `fail_job` transitions it to `dead`.

Chat-run finalizer responsibilities:

- No-op if the run is already terminal.
- Persist an assistant error message.
- Emit the terminal chat-run error/done events.
- Support `commit=False` so the worker controls the transaction boundary.

## Tree Read Path

`GET /conversations/{id}/tree` is a hot read route.

Rules:

- It must be read-only.
- It must not persist active paths.
- It must not mutate conversation metadata.
- It must load conversation messages once and build branch/fork structures from
  in-memory maps.
- It must batch run-status lookup by assistant message IDs.
- It must materialize the response payload before returning the DB connection.

Writing active paths belongs only to explicit active-path mutation routes.

## Request Session Lifecycle

FastAPI yield-dependency cleanup runs after response transfer. For large JSON
read routes, that can keep a PostgreSQL connection and transaction checked out
while the ASGI server is blocked on the client.

Hot read routes must:

1. Query service data.
2. Convert Pydantic objects to JSON-compatible dictionaries/lists.
3. Call `release_connection(db)`.
4. Return the already materialized response.

`release_connection` rolls back any open read transaction and closes the
session. It is for fully materialized read responses only.

## Frontend Architecture

Each conversation pane owns one reference state source:

- `useConversationReferences(conversationId)` loads current references.
- `upsertReference(reference)` merges `reference_added` events.
- `removeReference(referenceId)` deletes from server and local state.
- The conversation references surface is prop-driven and has no hidden hook.
  Target desktop placement is a workspace sidecar pane under
  `docs/workspace-sidecar-pane-cutover.md`.

Reader, new-conversation, full-conversation, library, and podcast chat entry
points all compose with the same reference state.

Entry point rules:

- Library chat: `POST /api/conversations` with
  `initial_references: ["library:UUID"]`.
- Media/document/podcast-episode chat: `POST /api/conversations` with
  `initial_references: ["media:UUID"]`.
- Existing conversation references are rendered by the sidecar surface from pane
  state.
- Reader selections remain message content unless the user creates a durable
  highlight/reference.

## Frontend Request Control

The conversation pane must prevent request storms.

Rules:

- Dedupe in-flight `/tree` requests by conversation and request scope.
- Ignore stale `/tree` responses after conversation changes.
- Dedupe active chat-run fetches.
- Do not immediately refetch `/tree` after a send just because a run was
  created.
- Let the tail/SSE path drive incremental updates.
- Keep callback identities stable where they feed chat-run tailing effects.

## SSE Reconnect Control

Only one layer owns retries for a stream.

Rules:

- The SSE client supports `maxReconnects`.
- Reconnects are bounded.
- Progress resets reconnect counters only after typed event progress, not merely
  after opening a socket or receiving keepalive noise.
- `useChatRunTail` disables inner reconnects when the outer chat-tail lifecycle
  owns retry policy.

Unbounded reconnect loops are not acceptable in production.

## File Ownership

Backend:

- `python/nexus/db/models.py`
- `python/nexus/db/session.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/conversation_references.py`
- `python/nexus/api/routes/chat_runs.py`
- `python/nexus/services/conversation_references.py`
- `python/nexus/services/resource_resolver.py`
- `python/nexus/services/conversation_branches.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/chat_run_finalize.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/jobs/queue.py`
- `python/nexus/jobs/registry.py`
- `python/nexus/jobs/worker.py`
- `python/nexus/tasks/chat_run.py`
- `python/nexus/schemas/conversation.py`

Frontend:

- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/conversations/useConversationReferences.ts`
- `apps/web/src/lib/api/sse-client.ts`
- `apps/web/src/lib/api/sse/events.ts`
- `apps/web/src/components/chat/ConversationReferencesSidecar.tsx`
- `apps/web/src/components/chat/useChatRunTail.ts`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`

Migrations and tests:

- `migrations/alembic/versions/0123_conversation_references_conversation_created_index.py`
- `migrations/alembic/versions/0124_drop_legacy_conversation_state_snapshots.py`
- `python/tests/test_conversation_references.py`
- `python/tests/test_resource_resolver.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_job_queue.py`
- `python/tests/test_job_worker.py`
- `python/tests/test_migrations.py`
- `e2e/tests/reader-pane-tabs.spec.ts`
- `e2e/tests/quote-attach-references.spec.ts`
- `e2e/tests/real-media/context-chat-citations.spec.ts`

Deleted stale surfaces:

- `apps/web/src/app/api/conversations/resolve/route.ts`
- `apps/web/src/app/api/chat-references/media/[mediaId]/route.ts`
- `e2e/tests/chat-singletons.spec.ts`

## Acceptance Criteria

Schema:

- `conversation_references` has `created_at`, not `added_at`.
- The `conversation_references` FK does not cascade.
- The read-path index on `(conversation_id, created_at)` exists.
- Legacy `conversation_state_snapshots` and prompt-assembly memory/snapshot
  columns are gone.
- No new migration uses `ON DELETE CASCADE` for this feature.
- No feature code uses `INSERT ... ON CONFLICT` for reference insertion.

Backend:

- Invalid `resource_uri` returns `400 E_INVALID_REQUEST`.
- Invisible resources are not admitted as new references.
- `reference_added` stores and replays the full strict payload.
- Cited retrievals write a durable reference exactly once.
- Uncited retrievals do not write a reference.
- Singular `scope` app-search tool calls produce a tool error.
- `/tree` GET does not mutate active paths.
- `/tree` uses loaded message maps and batched run status.
- Hot read routes release DB sessions after materialization.
- Dead-lettered chat-run jobs finalize their chat run to terminal `error`.

Frontend:

- Reader/library/podcast entry points create conversations with
  `initial_references`.
- No frontend code calls deleted BFF endpoints.
- Reference sidecar content is prop-driven and renders from pane-level state.
- `reference_added` upserts into the same state the sidecar renders.
- `/tree` and active chat-run fetches are deduped.
- Sending a message does not cause an unconditional immediate `/tree` refetch.
- SSE reconnects are bounded.

Verification:

- `uv run python -m compileall nexus`
- `uv run ruff check` on touched backend/tests
- `uv run pytest` for reference, resolver, chat-run citation, job queue/worker,
  and migration tests
- `pnpm exec tsc --noEmit --pretty false`
- Relevant frontend unit tests for conversation panes and chat tabs
- Repository grep shows no live references to deleted endpoint contracts,
  excluding historical migrations or unrelated terminology.

## Legitimate False Positives

Some strings are not part of the stale conversation-reference contract:

- `scope_type` inside search internals is object-search scope plumbing, not
  `conversations.scope_type`.
- Podcast sync "singleton" wording refers to a background polling lock, not
  chat singleton semantics.
- Historical migrations may contain dropped table or old-column names because
  migration history is append-only.

Do not rewrite unrelated subsystems just to remove those words.

## Final State

The system has one durable way to say "this conversation can use this resource":
a `conversation_references` row with a `resource_uri`.

Every other layer composes from that:

- API creation admits initial references.
- Resolver turns URIs into UI/model context.
- Tools fetch or search through that resource contract.
- Citation write-through grows the same reference set.
- SSE streams the same resolved payload the REST API returns.
- Frontend panes render one reference state.
- Tree reads and chat-run tails no longer amplify each other into request
  storms.
- Queue dead letters no longer leave chat runs stuck in non-terminal states.

That is the production contract. Reintroducing older singleton, scope, or BFF
compatibility paths violates the cutover.

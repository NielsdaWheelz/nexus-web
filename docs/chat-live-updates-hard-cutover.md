# Chat Live Updates Hard Cutover

## Purpose

Make chat responses update live without requiring a page reload.

The current durable chat-run model is the right foundation: HTTP creates a run,
the worker persists events, and the browser tails those persisted events over
SSE. The broken behavior is in the production hardening around that model:
stream setup, stream parsing, stream lifecycle ownership, terminal
reconciliation, local configuration, and test coverage.

This is a hard cutover. The final state has no legacy stream client, no feature
flag, no polling transport, no BFF stream proxy, no duplicate chat-run tailing
path, and no backward-compatible event aliases.

## Goals

- Assistant responses render incrementally in the chat pane without reload.
- New chat, existing chat, and quote chat use one chat-run tailing lifecycle.
- The durable event log remains the source of truth.
- SSE remains a delivery pipe that can disconnect and reconnect without
  changing run execution.
- Stream reconnects use fresh stream tokens and `Last-Event-ID`.
- Terminal state is reconciled from persisted run data after every stream
  lifecycle outcome.
- Local setup creates a working browser -> FastAPI streaming environment.
- Production deployments have an explicit stream proxy/CORS contract.
- Tests cover the full live-update path, not only the optimistic user message.

## Target Behavior

- Sending a message immediately renders the persisted user message and pending
  assistant message returned by `POST /api/chat-runs`.
- The assistant message receives streamed `delta` content as events arrive.
- Tool activity, tool results, and citations update through the same message
  mutation path used today.
- A `done` event flushes any buffered delta, marks terminal status, fetches the
  persisted chat run, and replaces local run messages with the canonical rows.
- If the stream disconnects before `done`, the client reconnects with:
  - a newly minted stream token,
  - the latest observed event id,
  - the same run id.
- If the stream cannot be resumed or closes without a terminal event, the client
  reconciles from `GET /api/chat-runs/:id` and reflects the persisted run state.
- A run that became terminal while the client was disconnected does not leave the
  stream open forever. The backend closes the stream when the cursor is already
  at or beyond terminal `done`.
- Stream failures are visible enough for users and operators:
  - the UI can show reconnecting or failed-to-update state,
  - logs include run id, last event id, status code, and retry classification,
  - terminal persisted content still appears without reload.
- Auto-scroll behavior remains unchanged:
  - local sends force scroll intent to the bottom,
  - live deltas keep the view pinned only if the user is near the bottom,
  - reading older messages is not interrupted.

## Final State

### Kept

- `POST /api/chat-runs` is the only chat send endpoint.
- Browser -> FastAPI `/stream/*` remains the streaming exception to the BFF
  route rule.
- Stream tokens remain short-lived bearer tokens minted through
  `/api/stream-token`.
- Chat-run events remain durable rows in Postgres.
- SSE event shapes remain `meta`, `tool_call`, `tool_result`, `citation`,
  `delta`, and `done`.
- `useChatMessageUpdates` remains the single local message mutation layer for
  streamed message content, tools, citations, and terminal status.
- `ChatSurface` remains the chat scroll/log surface.

### Removed

- Duplicate stream lifecycle code in `ConversationPaneBody` and
  `QuoteChatSheet`.
- Any unused frontend or backend streaming feature flag.
- Any stream client path that does not support bearer headers.
- Any parser behavior that depends on LF-only event framing.
- Any path that requires page reload to observe a completed run.
- Any polling transport for chat-run progress.
- Any query-string bearer token design.
- Any BFF SSE proxy route.
- Any backward-compatible event aliases or duplicate event contracts.

## Architecture

```text
Browser
  ChatComposer
    POST /api/chat-runs
      Next.js BFF
        FastAPI /chat-runs
          conversations/messages/chat_runs/chat_run_events
          background_jobs

  useChatRunTail
    POST /api/stream-token
      Next.js BFF
        FastAPI /internal/stream-tokens

    GET {stream_base_url}/stream/chat-runs/:runId/events
      Authorization: Bearer <fresh stream token>
      Last-Event-ID: <latest observed seq, when present>
        FastAPI /stream/chat-runs/:runId/events
          durable event replay/tail

Worker
  background_jobs(chat_run)
    execute_chat_run
      append chat_run_events
      update assistant message
      append done
```

The stream client owns connection maintenance. The chat run owns application
work. The persisted run response owns final canonical UI state.

## Structure

### Frontend Stream Client

- Keep a fetch-based SSE client because browser-native `EventSource` cannot send
  custom `Authorization` headers.
- Parse the SSE wire format according to the HTML event-stream rules:
  - `\n`, `\r\n`, and `\r` line endings,
  - blank-line event dispatch,
  - comment lines,
  - `id`,
  - `event`,
  - multiple `data:` lines joined with newline,
  - optional `retry`,
  - unknown fields ignored.
- Preserve max event size protection.
- Track the latest observed event id from parsed `id` fields.
- Classify stream outcomes:
  - terminal event,
  - clean close before terminal,
  - abort,
  - retryable network error,
  - retryable server error,
  - fatal client/auth/config error.
- Mint a fresh stream token for every connection attempt.
- Never reuse a stream token after any request has been attempted.

### Chat Run Tailing Hook

- Add one hook or local module that owns chat-run tailing.
- Inputs:
  - run data returned by `POST /api/chat-runs` or `GET /api/chat-runs/:id`,
  - message update handlers,
  - canonical message merge/replace callback,
  - run-finished callback,
  - scroll intent callback.
- Responsibilities:
  - merge initial run messages,
  - open and maintain the SSE connection,
  - map event IDs and assistant message IDs,
  - call `useChatMessageUpdates` handlers,
  - reconcile canonical persisted rows after terminal or failed stream lifecycle,
  - dedupe active run subscriptions,
  - abort on unmount or route change.
- The hook must support both full chat and quote chat without route-specific
  duplicate stream code.

### Backend Stream Route

- Keep `/stream/chat-runs/:runId/events` as the only stream route.
- Continue to replay durable events after `after` or `Last-Event-ID`.
- Before sleeping for more events, inspect run terminal state:
  - if terminal and no newer event exists, close the stream,
  - do not keep heartbeating forever past `done`.
- Detect client disconnects and stop tailing.
- Keep stream response headers:
  - `Content-Type: text/event-stream; charset=utf-8`,
  - `Cache-Control: no-cache, no-transform`,
  - `X-Accel-Buffering: no`.
- Keep heartbeat comments, with interval derived from a named stream idle TTL.
- Keep stream route free of chat execution logic.

### Stream CORS And Environment

- Local setup writes working stream settings:
  - `STREAM_BASE_URL=http://localhost:8000`,
  - `STREAM_CORS_ORIGINS=http://localhost:3000,http://localhost:3001`.
- `make api` and `make web` preserve stream URL/origin consistency when
  `API_PORT` or `WEB_PORT` are overridden.
- FastAPI startup warns or fails fast when:
  - the effective stream base URL is cross-origin from app public URL,
  - stream CORS origins are empty in an environment that serves browser traffic.
- CORS preflight for `/stream/*` allows:
  - `GET`,
  - `OPTIONS`,
  - `Authorization`,
  - `Last-Event-ID`.
- The `Authorization` header is listed explicitly. Do not rely on wildcard
  header behavior.

### Production Proxy Contract

Document and test where possible that `/stream/*` requires:

- response buffering disabled for the stream path,
- compression disabled for the stream path,
- idle/read timeouts greater than heartbeat interval,
- no response transformation,
- no caching,
- HTTP/2 preferred for browser connection headroom.

The app already emits `X-Accel-Buffering: no`; deployment config must also honor
streaming semantics for the chosen proxy/CDN.

## Rules

- Hard cutover only.
- No feature flag.
- No legacy stream client.
- No duplicate chat-run tailing implementation.
- No native `EventSource` path for authenticated streams.
- No query-string auth tokens.
- No BFF stream proxy.
- No polling transport.
- No backward-compatible event aliases.
- No change to chat-run request payload shape.
- No change to persisted SSE event names or payload shape.
- No chat execution work in the stream route.
- No business logic in Next.js BFF routes.
- No generic real-time framework.
- No generic subscription registry.
- No speculative reconnect settings surface in the UI.
- Keep frontend work in `apps/web/`.
- Keep backend work in `python/nexus/`.
- Keep config/setup changes explicit and environment-owned.
- Tests must describe behavior, not implementation details.

## Key Decisions

1. Keep durable chat runs as the source of truth.

   Live rendering is an optimization over durable state, not the state owner.
   This preserves reload/resume behavior and lets transport reconnect without
   affecting worker execution.

2. Use fetch-based SSE.

   The app authenticates streams with bearer tokens. Native `EventSource` cannot
   set custom request headers, so it is not the right primitive for this
   authenticated stream.

3. Make reconciliation mandatory, not optional.

   The canonical assistant message is persisted by the backend. Every terminal
   or failed stream lifecycle resolves through canonical run data so the UI does
   not depend on seeing every event live.

4. Centralize chat-run tailing.

   Existing full-chat and quote-chat stream code are similar enough that keeping
   both creates drift. One lifecycle owner is easier to reason about and test.

5. Keep event shapes unchanged.

   The bug is transport/lifecycle reliability, not the chat event contract.
   Changing event payloads would increase blast radius without solving the
   missing-live-update path.

6. Close terminal streams even when the cursor is past `done`.

   Reconnects can legitimately arrive after all events have already been read.
   Keeping that connection open forever is misleading and prevents deterministic
   client reconciliation.

7. Treat stream CORS as setup, not tribal knowledge.

   A direct browser -> FastAPI stream with `Authorization` needs explicit CORS.
   Local setup and production config should encode that requirement.

8. Prefer targeted local code over a generic real-time layer.

   This app needs one durable chat-run tail. A generic subscription framework
   would add surface area without improving correctness.

## Files

### Add

- `apps/web/src/components/chat/useChatRunTail.ts`
  - Shared chat-run tail lifecycle for full chat and quote chat.

- `apps/web/src/components/chat/useChatRunTail.test.tsx`
  - Component or hook tests for create/tail/reconnect/reconcile behavior.

- `docs/chat-live-updates-hard-cutover.md`
  - This plan and behavior contract.

### Update

- `apps/web/src/lib/api/sse.ts`
  - Spec-compliant SSE parsing.
  - Fetch-based reconnect lifecycle.
  - Response classification.
  - Fresh-token-per-attempt behavior.

- `apps/web/src/lib/api/sse.test.ts`
  - CRLF, CR, LF, multiline `data`, comments, `id`, `retry`, unknown fields,
    max event size, non-OK classification, and reconnect token behavior.

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
  - Remove local stream lifecycle.
  - Use shared chat-run tail owner.
  - Keep conversation data, pagination, canonical message merge, and scroll
    intent ownership.

- `apps/web/src/components/chat/QuoteChatSheet.tsx`
  - Remove duplicate stream lifecycle.
  - Use shared chat-run tail owner.
  - Keep sheet-specific conversation creation and open-full-chat behavior.

- `apps/web/src/components/chat/useChatMessageUpdates.ts`
  - Keep as the message mutation layer.
  - Update only if the shared tail owner needs explicit flush or reset hooks.

- `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx`
  - Cover quote-chat live update and open-full-chat behavior with the shared
    tail owner.

- `e2e/tests/conversations.spec.ts`
  - Add real-stack coverage that assistant content appears live without reload.
  - Keep existing optimistic send and scroll coverage.

- `python/nexus/api/routes/stream.py`
  - Terminal-cursor close behavior.
  - Disconnect handling.
  - named stream timing constants.
  - heartbeat interval derived from stream idle TTL.

- `python/nexus/middleware/stream_cors.py`
  - Ensure preflight and GET response headers cover authenticated stream fetches.

- `python/nexus/config.py`
  - Remove unused streaming feature flag.
  - Add or tighten stream URL/origin validation helpers.

- `python/tests/test_chat_run_stream.py`
  - Terminal cursor closes.
  - CORS preflight includes explicit `Authorization` and `Last-Event-ID`.
  - Stream GET exposes required headers.
  - Disconnect behavior where testable.

- `scripts/agency_setup.sh`
  - Write local stream URL and CORS origins.

- `.env.example`
  - Remove dead feature flags.
  - Document required stream URL/origin settings.

- `Makefile`
  - Preserve stream URL/origin consistency for overridden local ports.

- `apps/web/README.md`
  - Keep streaming environment notes current after flag removal.

- `README.md`
  - Link this hard-cutover plan.

### Avoid Unless Proven Necessary

- Database migrations.
- Chat-run table shape changes.
- Chat-run event payload changes.
- LLM provider/router changes.
- Background job queue changes.
- Global workspace shell changes.
- Generic subscription infrastructure.
- WebSocket infrastructure.

## Acceptance Criteria

- Existing conversation chat renders assistant deltas live without reload.
- New conversation chat navigates to the created conversation and continues
  rendering assistant deltas live.
- Quote chat renders assistant deltas live in the sheet and can open the full
  chat with the active run.
- Stream disconnect before `done` reconnects with a fresh stream token and
  `Last-Event-ID`.
- Stream token replay is not triggered by normal reconnect behavior.
- If reconnect cannot continue, canonical persisted assistant content appears
  without page reload.
- If the client reconnects with a cursor at or beyond terminal `done`, the
  backend closes the stream and the client reconciles.
- No duplicate user or assistant messages appear after meta remap, reconnect, or
  canonical reconciliation.
- Tool calls, tool results, and citations still render during live updates.
- Auto-scroll behavior matches `docs/chat-scroll-hard-cutover.md`.
- Browser stream CORS preflight succeeds for local development.
- Local `make setup`, `make api`, and `make web` produce a working stream setup
  on default ports.
- Overridden `API_PORT` and `WEB_PORT` do not silently produce a broken stream
  base URL or CORS origin.
- The SSE parser accepts LF, CRLF, and CR line endings.
- The SSE parser handles multiline `data:` fields according to the event-stream
  format.
- The SSE parser ignores comments and unknown fields.
- The SSE parser preserves event ids for reconnect.
- The stream route still returns `Cache-Control: no-cache, no-transform` and
  `X-Accel-Buffering: no`.
- No `NEXT_PUBLIC_ENABLE_STREAMING` or `ENABLE_STREAMING` flag remains.
- No native `EventSource` stream path exists.
- No polling chat-run progress path exists.
- No BFF SSE proxy route exists.
- Targeted frontend unit/browser tests pass.
- Targeted backend stream tests pass.
- Targeted conversations E2E passes when local services and model keys are
  available.
- `bunx tsc --noEmit` passes in `apps/web`.
- `bun run lint` passes in `apps/web`.
- `uv run pytest` targeted backend stream tests pass.

## Non-Goals

- Do not switch chat live updates to WebSockets.
- Do not add polling for chat progress.
- Do not proxy SSE through Next.js.
- Do not change chat-run request or response payloads.
- Do not change persisted SSE event shapes.
- Do not change message database schema.
- Do not change background job queue semantics.
- Do not change LLM provider selection or routing.
- Do not redesign message rows.
- Do not redesign the composer.
- Do not change chat scroll ownership beyond preserving existing behavior.
- Do not add rate-limit UI.
- Do not add a reconnect settings UI.
- Do not add offline queueing.
- Do not add cross-device live sync for conversations.
- Do not add collaborative multi-user chat.

## Implementation Order

1. Add failing coverage for parser correctness, stream CORS, terminal cursor
   close, and live assistant rendering.
2. Remove unused streaming feature flags from config/docs/test env.
3. Fix local setup and make targets so direct streaming works by default.
4. Harden backend stream route for terminal cursor close, disconnect handling,
   and named heartbeat timing.
5. Harden `sseClientDirect` parsing and reconnect classification.
6. Add shared chat-run tail owner.
7. Move full chat to the shared tail owner and delete local stream lifecycle.
8. Move quote chat to the shared tail owner and delete local stream lifecycle.
9. Add terminal reconciliation after all stream lifecycle outcomes.
10. Update production stream proxy documentation.
11. Run targeted frontend, backend, and E2E checks.

## External Reference Notes

- HTML event-stream format defines CRLF/CR/LF line endings, `id`,
  `Last-Event-ID`, `retry`, comments, and multiline `data` behavior:
  https://html.spec.whatwg.org/multipage/server-sent-events.html
- MDN documents SSE comments as keepalive and warns about HTTP/1 connection
  limits:
  https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- MDN documents that `Authorization` must be explicitly allowed for CORS
  preflight:
  https://developer.mozilla.org/docs/Web/HTTP/Headers/Access-Control-Allow-Headers
- NGINX documents that proxy response buffering is on by default and must be
  disabled for low-latency streaming paths:
  https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/
- Fetch-based SSE clients exist because native `EventSource` cannot set custom
  headers:
  https://github.com/Azure/fetch-event-source

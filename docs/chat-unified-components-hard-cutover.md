# Unified Chat Components Hard Cutover

## Status

Implementation spec.

## Role

This document owns the target-state plan for unifying chat component usage across
full conversation panes, new chat panes, the media secondary-rail `Ask` pane, and
the mobile reader assistant sheet.

The target is one shared chat spine with separate product shells:

- shared transcript layout
- shared message presentation
- shared composer behavior
- shared durable chat-run streaming runtime
- shared context and scope identity helpers
- separate shells for branch-aware full chat, new-chat routing, reader-local Ask,
  mobile modal behavior, and reader source navigation

This document does not replace the product behavior specified by:

- `docs/chat-workbench-hard-cutover.md`
- `docs/chat-reader-prose-hard-cutover.md`
- `docs/chat-composer-bottom-dock-hard-cutover.md`
- `docs/chat-streaming-hard-cutover.md`
- `docs/quote-to-chat-hard-cutover.md`
- `docs/reader-secondary-rail-hard-cutover.md`

It resolves the component-ownership question across those documents. Where older
docs imply route-specific chat renderers, duplicate state machines, or desktop
quote-to-chat route handoff as the default behavior, this document follows the
newer hard-cutover targets: shared chat spine, reader-local desktop Ask, explicit
full-chat promotion, and no compatibility path.

## Hard-Cutover Policy

This is a hard cutover.

- No feature flags.
- No environment toggles.
- No query-param toggles.
- No compatibility props for old chat layouts.
- No old/new component branches mounted in parallel.
- No wrapper components that preserve removed APIs.
- No duplicate embedded chat state machines.
- No route-specific transcript renderer for full chat, new chat, or reader Ask.
- No separate mini-chat implementation for the reader rail.
- No fallback from reader Ask to opening a full workspace chat pane.
- No desktop quote-to-chat default path that calls `requestOpenInAppPane`.
- No `context=` URL compatibility path.
- No `attach_*` URL path for the default desktop reader Ask flow.
- No raw selected quote text in telemetry or logs.
- Remove or rewrite tests that assert removed route-opening or mini-chat behavior.

The implementation may land as multiple commits, but the merge target is one
coherent component cutover with no reachable legacy path.

## Context

The codebase already shares the most important chat primitives:

- `ChatSurface` renders the transcript scrollport, message log, load-older
  affordance, empty state, and composer dock.
- `ChatComposer` owns draft text, model settings, context chips, branch composer
  header, and chat-run submission.
- `MessageRow`, `UserMessage`, `AssistantMessage`, and `SystemMessage` own message
  presentation.
- `useChatRunTail` owns durable chat-run streaming, replay, reconciliation, and
  active-run tracking.

The remaining duplication is mostly above that spine:

- conversation controllers repeat scroll intent and load-older restoration logic
- media Ask and `MediaPaneBody` repeat context and scope dedupe helpers
- reader Ask owns a linear chat state machine inline in `ReaderAssistantPane`
- full chat owns branch tree/path state inline in `ConversationPaneBody`
- mobile reader Ask uses a sheet shell around `ReaderAssistantPane`

The correct unification is not one large `Chat` component. Full chat and reader
Ask have different product shells and different responsibilities. The correct
unification is a small set of shared primitives and helpers with strict ownership
boundaries.

## Goals

1. Keep one shared transcript and composer component spine across every chat
   surface.
2. Keep one shared durable streaming runtime for chat runs.
3. Keep one shared message presentation model across full chat, new chat, reader
   Ask, and the mobile reader assistant sheet.
4. Extract repeated context and scope identity logic into one primary API.
5. Extract repeated scroll intent behavior where it is used by multiple chat
   surfaces.
6. Make `ReaderAssistantPane` reader-specific chrome over shared chat behavior,
   not a mini-chat fork.
7. Keep `QuoteChatSheet` a mobile shell only. It must not own chat runtime,
   composer logic, or message rendering.
8. Keep full conversation chat branch-aware without forcing reader Ask to carry
   branch/fork API surface.
9. Preserve reader-local Ask behavior: selecting text opens the media secondary
   rail on desktop and a local sheet on mobile.
10. Preserve explicit full-chat promotion after a conversation exists, including
    active `run` preservation while streaming.
11. Preserve reader source activation for same-media citations and attached
    reader-selection contexts.
12. Reduce route-specific code paths without adding speculative generic APIs.

## Non-Goals

- Do not redesign the workspace pane system.
- Do not remove full conversation panes.
- Do not make reader Ask open full chat automatically.
- Do not make full chat use the media secondary rail.
- Do not make mobile use a persistent secondary rail.
- Do not redesign chat branching, branch graph APIs, or active-path persistence.
- Do not remove branch mode from full chat.
- Do not add branch/fork UI to reader Ask in this cutover.
- Do not redesign `ChatComposer` visual hierarchy.
- Do not redesign model/provider settings.
- Do not replace durable chat runs or SSE transport.
- Do not alter backend conversation, message, or chat-run schemas unless an
  implementation test proves the current contract is insufficient.
- Do not merge reader-selection context semantics with assistant-answer branch
  anchor semantics.
- Do not make chat inherit media reader typography themes or reader profile
  settings.

## Final State

Every chat surface renders through this shared spine:

```text
ChatSurface
  transcriptScrollport role="region" aria-label="Chat conversation"
    transcript role="log" aria-label="Chat messages"
      optional scope banner
      optional load older control
      optional empty state
      MessageRow
        UserMessage | AssistantMessage | SystemMessage
  composerDock data-testid="chat-composer-dock"
    ChatComposer
```

Every chat send uses this runtime contract:

```text
ChatComposer
  -> POST /api/chat-runs
  -> onChatRunCreated(runData)
  -> useChatRunTail.tailChatRun(runData)
  -> shared message merge, SSE replay, reconciliation, terminal status
```

Surface shells own only their local product concerns:

- existing full chat owns conversation tree loading, active path, branch/fork
  state, context/forks side rail, deletion, pane title, and URL run tailing
- new chat owns initial route state, first-send local stream, and replacement to
  `/conversations/:id?run=:runId`
- reader Ask owns reader header, scope picker, pending reader context
  presentation, scoped conversation resolution, promotion, telemetry, and reader
  source activation
- mobile reader Ask owns modal sheet behavior, focus trapping, body overflow
  lock, and close behavior
- `MediaPaneBody` owns media rail mode, rail expansion, selection-to-context
  builders, saved-highlight Ask context builders, and explicit full-chat
  promotion routing

No surface owns a private transcript renderer, private composer, or private
chat-run streaming lifecycle.

## Target Behavior

### Existing Full Conversation

1. Opening `/conversations/:id` loads the branch-aware conversation tree.
2. The visible transcript renders one selected path through `ChatSurface`.
3. Branch/fork controls render through shared message components.
4. The context/forks side surface remains outside `ChatSurface`.
5. Sending from the composer creates a durable chat run.
6. The sent user message and pending assistant row merge immediately into the
   visible selected path when the run belongs to that path.
7. Streaming, retry, replay, reconciliation, and terminal status are handled by
   `useChatRunTail`.
8. Branch switching does not remount a different chat renderer.
9. Branch mode remains in the same `ChatComposer`, not an inline transcript input.

### New Chat

1. Opening `/conversations/new` renders the same `ChatSurface` and `ChatComposer`
   before any run exists.
2. Attached contexts and conversation scope are shown through the shared composer
   context rail and context side surface.
3. First send creates a durable chat run and streams locally before navigation is
   required.
4. The pane URL is replaced with `/conversations/:id?run=:runId` after the run
   exists.
5. The destination conversation pane tails the same run if the replacement
   remounts the page.
6. The user never sees a blank route-handoff state after first send.

### Desktop Reader Ask

1. Selecting text and invoking Ask expands the media secondary rail if needed.
2. The rail switches to `Ask`.
3. The assistant surface renders synchronously before scoped conversation
   resolution, history loading, PDF quote validation, or model catalog loading
   resolves.
4. Pending quote context is visible before send.
5. The composer is focused without changing the active workspace pane.
6. The document remains visible and active.
7. Sending starts a durable chat run scoped to the selected conversation scope.
8. If a scoped conversation has not resolved yet, the send payload includes
   `conversation_scope` and no stale `conversation_id`.
9. The answer streams in place through the shared runtime.
10. Full chat opens only through explicit promotion after a conversation exists.
11. Promotion includes `?run=:runId` while the run is active.
12. Activating a same-media citation or attached reader-selection source navigates
    within the current media pane and projects the reader source highlight.

### Mobile Reader Ask

1. Mobile Ask opens a local modal sheet.
2. The sheet renders `ReaderAssistantPane` or its direct replacement.
3. The sheet traps focus and locks body scrolling.
4. The assistant body uses the same shared chat spine as desktop reader Ask.
5. Closing the sheet does not create or activate a workspace chat pane.
6. Promotion closes the sheet only when opening full chat on mobile.

### Saved Highlight Ask

1. Asking from a saved highlight row switches the same media rail to `Ask`.
2. The saved highlight is attached as an object-ref context.
3. Asking from saved highlights and unsaved selections uses the same reader Ask
   surface.
4. Saved highlight Ask does not require creating another highlight.

### Scope Changes

1. Document scope is the default reader Ask scope.
2. New-chat and library scopes are selected inside the assistant surface.
3. Changing scope preserves pending contexts and unsent draft text.
4. Changing scope clears the active conversation id unless the new scope resolves
   to the same durable conversation.
5. Stale background resolution results are ignored after a send or later scope
   change.
6. `ChatComposer` sends `conversation_scope` only when there is no active
   conversation id.

### Source Activation

1. `MessageRow` keeps the optional reader-source activation callback.
2. User-message context citations can activate reader-selection targets.
3. Assistant citations can activate resolvable evidence targets.
4. Reader Ask intercepts same-media targets and navigates the current reader.
5. Full chat uses normal link or pane routing when no reader activation callback
   is supplied.
6. Unresolved, stale, or permission-denied locators render explicit unavailable
   UI and do not approximate navigation.

## Architecture

### Shared Component Spine

`ChatSurface` owns layout only:

- surface column
- transcript scrollport
- named message log
- scope banner placement
- load-older placement
- empty-state placement
- composer dock placement
- wheel forwarding from composer dock to transcript scrollport

`ChatSurface` must not:

- fetch data
- create chat runs
- tail streams
- own branch state
- know about reader media
- know about workspace routing
- know about mobile sheet behavior

`ChatComposer` owns composer internals:

- draft text
- draft keys
- branch composer header
- attached context chip rail
- model catalog selection
- reasoning mode selection
- key mode selection
- web search mode selection
- submit button state
- composer-local submission feedback
- `/api/chat-runs` submission

`ChatComposer` must not:

- navigate by default
- open workspace panes
- know about media rail state
- own message arrays
- tail streams
- resolve scoped conversations

`MessageRow` owns role dispatch and shared wiring:

- stable `data-message-id`
- stable `data-role`
- timestamp and error-label derivation
- `UserMessage`, `AssistantMessage`, and `SystemMessage` dispatch
- optional reader-source activation callback plumbing

Role-specific message components own presentation. Callers do not select route
specific message layouts.

### Shared Runtime

`useChatRunTail` remains the primary durable chat-run runtime.

It owns:

- active run registry
- run response message merge
- stream token lifecycle
- direct FastAPI SSE connection
- `Last-Event-ID` replay
- delta replay dedupe
- tool-call, tool-result, citation, and delta updates
- terminal `done` handling
- `/api/chat-runs/:runId` reconciliation
- active-run abort on unmount or superseded run

Surface controllers pass local state setters and visibility guards. They do not
reimplement streaming or polling.

### Shared Chat Helpers

Create focused helpers only when at least two call sites need them.

Required shared helpers:

- context identity and dedupe for `ContextItem`
- conversation scope identity and equality
- optional scroll intent helper for bottom-pinning and load-older restoration

These helpers live under `apps/web/src/lib/conversations/` or
`apps/web/src/components/chat/` according to ownership:

- data identity helpers live in `lib/conversations`
- DOM scroll helpers live in `components/chat`

Do not add a broad chat framework or generic state manager.

### Reader Assistant Shell

`ReaderAssistantPane` owns reader-specific chrome:

- `Ask` title and target label
- scope picker
- back-to-highlights action
- close action
- `Open full chat` action
- pending reader context cards
- scoped conversation resolution
- reader assistant telemetry
- reader source activation callback forwarding

Its chat body must use shared chat primitives and helpers. It must not contain a
private transcript renderer, private composer, or private streaming loop.

If a shared embedded component is extracted, its final boundary is:

```text
EmbeddedChatPanel
  owns linear message/session controller for embedded non-branching chat
  uses ChatSurface
  uses ChatComposer
  uses useChatRunTail
  accepts shell-owned header/context/promotion data through narrow props
```

`EmbeddedChatPanel` must not own reader rail state, selection builders,
workspace routing, or mobile modal behavior.

### Full Conversation Shell

`ConversationPaneBody` stays branch-aware.

It owns:

- conversation tree loading
- selected path state
- active leaf state
- branch graph state
- fork options and path cache
- branch draft state
- branch switching
- context/forks side rail
- pane title and resource options
- deletion and route-level errors

It uses shared chat primitives for rendering and streaming. It does not become
the implementation source for reader Ask.

### New Conversation Shell

`ConversationNewPaneBody` stays route-aware.

It owns:

- URL draft state
- URL-attached contexts for explicit full-chat routes
- initial conversation scope
- first-send URL replacement
- new-chat context rail or drawer

It uses shared chat primitives and shared runtime. It does not implement a
special first-send transcript.

### Media Host

`MediaPaneBody` owns media-local reader Ask orchestration:

- `secondaryRailMode`
- `isSecondaryRailExpanded`
- `readerAssistantState`
- mobile highlights drawer state
- selection-to-reader-context builders
- saved-highlight context builders
- media and library scope options
- explicit full-chat promotion route
- same-media citation/source navigation

It must not import `ChatSurface`, `ChatComposer`, or `useChatRunTail` directly.
It composes reader Ask through `ReaderAssistantPane` or its replacement.

### Mobile Sheet

`QuoteChatSheet` or its replacement owns modal shell behavior only:

- backdrop
- focus trap
- escape handling
- body overflow lock
- close behavior
- focus restoration

It must not fetch models, load messages, create runs, tail streams, or render
messages directly.

## Structure

Target component structure:

```text
apps/web/src/components/chat/
  ChatSurface.tsx
  ChatSurface.module.css
  MessageRow.tsx
  MessageRow.module.css
  UserMessage.tsx
  AssistantMessage.tsx
  SystemMessage.tsx
  useChatRunTail.ts
  useChatMessageUpdates.ts
  useChatScrollIntent.ts              # if extracted
  ReaderAssistantPane.tsx
  ReaderAssistantPane.module.css
  EmbeddedChatPanel.tsx               # only if shared by real call sites
  EmbeddedChatPanel.module.css        # only with EmbeddedChatPanel
  QuoteChatSheet.tsx                  # mobile shell only, or replaced outright

apps/web/src/components/
  ChatComposer.tsx
  ChatComposer.module.css

apps/web/src/lib/conversations/
  types.ts
  display.ts
  attachedContext.ts
  useAttachedContextsFromUrl.ts
  readerContexts.ts                   # context builders and identity helpers
```

Existing files may be renamed only as a hard cutover. Do not keep compatibility
aliases for old names.

## Key Decisions

### Shared Spine, Not One Giant Shell

The shared abstraction boundary is the chat spine and small helpers. Full chat,
new chat, reader Ask, and mobile Ask remain separate shells because their product
responsibilities are different.

### Branching Stays Full-Chat Only

Full conversation chat remains branch-aware. Reader Ask remains linear in this
cutover. Shared code must not force branch props into reader Ask.

### Reader Ask Stays Reader-Local

Desktop reader Ask opens in the media secondary rail. It does not open a full
conversation pane by default. Full chat promotion is explicit and disabled until
a conversation id exists.

### Bottom Dock Wins

The composer is a reserved footer region outside the transcript scrollport.
Older wording that says "sticky inside the scrollport" is superseded by the
bottom-dock hard cutover.

### `ChatComposer` Submits, Callers Route

`ChatComposer` creates chat runs and calls `onChatRunCreated`. It does not
navigate. Conversation pages and reader shells decide what to do after a run is
created.

### Scope Identity Is Shared

Scope equality must be computed through one helper. Media scope changes must not
reuse stale conversation ids.

### Context Identity Is Shared

Context dedupe must be computed through one helper. Reader-selection contexts
dedupe by `client_context_id`; object-ref contexts dedupe by object identity and
evidence span identity.

### Reader Source Activation Is Optional

Message rendering accepts reader activation as a callback. Reader Ask supplies
it. Full chat can omit it and use normal routing/link behavior.

### Mobile Is A Shell Difference

The mobile reader sheet can differ in modal behavior, focus trapping, and body
overflow control. It must not differ in chat body implementation.

## Key Details

### Pending Context Presentation

Reader Ask has two visible context presentations before send:

- large reader context cards above the chat body
- compact composer context chips inside `ChatComposer`

Both presentations read from the same pending context state. Removing a context
from either presentation updates the single pending context list before any send
payload is built.

### History Loading

Full chat and reader Ask do not need the same history endpoint.

- full chat loads branch-aware trees
- reader Ask can load linear conversation messages
- new chat begins with local empty state and no history endpoint

The shared boundary is message rendering, scrolling, composer behavior, and
runtime tailing. Endpoint-specific loading stays with the shell that owns the
product behavior.

### Page Sizes And Constants

Message page sizes may differ by surface when the surface has a real product
reason. Each timing value, page size, threshold, and retry value introduced or
moved by this cutover must have a named constant.

### Model Catalog Loading

Model catalog loading must not block reader Ask visibility. The composer may
load models after the assistant is visible. Model loading remains cached so
opening full chat, reader Ask, and mobile Ask does not refetch the catalog for
each mount.

### Scoped Conversation Resolution

Reader Ask may resolve a scoped conversation in the background. Resolution is not
required for initial render.

Resolution rules:

- ignore stale results after scope changes
- ignore stale results after a send creates or resolves a conversation
- clear the active conversation id on scope changes
- send `conversation_scope` when no active conversation id exists
- do not send a stale `conversation_id`

### Active Run Promotion

Reader Ask tracks the active run id returned by the shared runtime. Full-chat
promotion uses:

```text
/conversations/:conversationId
/conversations/:conversationId?run=:runId
```

The second form is required while the answer is still streaming.

### Telemetry

Reader assistant telemetry remains reader-owned. It may record event type,
latency, scope type, context kinds, media kinds, status, and typed error code. It
must not record raw quote text, raw prompt text, raw answer text, or provider key
material.

### Stale Documentation

Older testing guidance that expects desktop quote-to-chat to open or update a
full chat pane is stale for the default desktop reader Ask path. The active
target is reader-local Ask with explicit full-chat promotion.

## Rules

- One primary chat transcript layout: `ChatSurface`.
- One primary composer: `ChatComposer`.
- One primary message row dispatcher: `MessageRow`.
- One primary streaming runtime: `useChatRunTail`.
- One primary context identity helper.
- One primary scope identity helper.
- Surface controllers may own product state, not duplicated chat primitives.
- Reader shell components may render reader-specific context cards, not alternate
  message rows.
- Route-specific CSS may size containing shells, not change message presentation.
- Context removal must update every visible context representation before send.
- Scope changes must preserve pending contexts and draft text.
- Scope changes must clear stale conversation ids.
- Active run promotion must preserve `run` in the full-chat route.
- No selected quote text in telemetry or logs.
- No raw `ApiError.message` display for expected failures.
- Expected transient failures render typed feedback states.
- Broken invariants fail loudly.

## Files

Primary frontend files:

- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/MessageRow.module.css`
- `apps/web/src/components/chat/UserMessage.tsx`
- `apps/web/src/components/chat/AssistantMessage.tsx`
- `apps/web/src/components/chat/SystemMessage.tsx`
- `apps/web/src/components/chat/useChatRunTail.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
- `apps/web/src/components/chat/ReaderAssistantPane.tsx`
- `apps/web/src/components/chat/ReaderAssistantPane.module.css`
- `apps/web/src/components/chat/QuoteChatSheet.tsx`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/ChatComposer.module.css`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/lib/conversations/readerContexts.ts`
- `apps/web/src/lib/conversations/display.ts`
- `apps/web/src/lib/conversations/attachedContext.ts`
- `apps/web/src/lib/conversations/types.ts`

Possible new frontend files:

- `apps/web/src/components/chat/useChatScrollIntent.ts`
- `apps/web/src/components/chat/EmbeddedChatPanel.tsx`
- `apps/web/src/components/chat/EmbeddedChatPanel.module.css`
- `apps/web/src/lib/conversations/contextIdentity.ts`
- `apps/web/src/lib/conversations/scopeIdentity.ts`

Add a possible new file only when the implementation has at least two real call
sites. Prefer extending `readerContexts.ts` for reader-context identity if that
keeps one owner.

Primary tests:

- `apps/web/src/__tests__/components/ChatSurface.test.tsx`
- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
- `apps/web/src/__tests__/components/ReaderAssistantPane.test.tsx`
- `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx`
- `apps/web/src/__tests__/components/ChatContextDrawer.test.tsx`
- `apps/web/src/components/chat/ChatStreamingHardCutover.test.tsx`
- `apps/web/src/components/chat/MessageRow.test.tsx`
- `e2e/tests/real-media/quote-to-chat.spec.ts`
- `e2e/tests/real-media/context-chat-citations.spec.ts`

## Implementation Plan

### 1. Lock The Shared Spine

- Verify all chat surfaces render through `ChatSurface`.
- Verify all sends go through `ChatComposer`.
- Verify all messages render through `MessageRow`.
- Verify all streaming goes through `useChatRunTail`.
- Delete any route-specific transcript, composer, or streaming code found during
  implementation.

### 2. Extract Context And Scope Identity

- Move context dedupe key logic into one helper.
- Move scope identity/equality logic into one helper.
- Replace local copies in `MediaPaneBody` and `ReaderAssistantPane`.
- Add focused tests for reader-selection and object-ref dedupe.
- Add focused tests for general, media, and library scope identity.

### 3. Extract Shared Scroll Intent Where Useful

- Compare scroll-bottom and load-older restoration logic in full chat, new chat,
  and reader Ask.
- Extract only the shared mechanics that have multiple real call sites.
- Keep branch-switch scroll-to-top behavior in full chat.
- Keep surface-specific load endpoints in their owning controllers.

### 4. Split Reader Chrome From Embedded Linear Chat

- Keep reader header, scope picker, pending quote cards, promotion, telemetry, and
  reader source activation in reader-owned code.
- Move reusable linear chat session mechanics out of reader chrome if they are
  shared with another surface.
- If `EmbeddedChatPanel` is created, it uses `ChatSurface`, `ChatComposer`, and
  `useChatRunTail`; it does not own reader rail or mobile sheet behavior.

### 5. Preserve Branch-Aware Full Chat

- Keep conversation tree loading and branch switching in `ConversationPaneBody`.
- Keep branch draft state tied to the shared composer.
- Keep branch/fork side surface outside `ChatSurface`.
- Ensure shared helper extraction does not add branch props to reader Ask.

### 6. Keep Mobile Sheet Shell-Only

- Ensure `QuoteChatSheet` imports only the reader assistant body and shell helpers.
- Ensure it does not import `ChatSurface`, `ChatComposer`, or `useChatRunTail`
  unless it has become the reader assistant body itself by a hard rename.
- Keep modal focus and body-scroll behavior covered by tests.

### 7. Rewrite Tests Around Final Behavior

- Component tests assert shared structure and behavior, not implementation
  snapshots.
- Reader Ask tests assert synchronous rail/sheet visibility before network
  resolution.
- Full chat tests assert branch behavior still works through shared components.
- Real-media E2E asserts desktop quote-to-chat stays in the reader rail by
  default.
- Delete old tests that expect desktop quote-to-chat to open a full chat pane.

## Acceptance Criteria

### Static Acceptance

- `rg "<ChatSurface" apps/web/src` shows full chat, new chat, and reader Ask
  using the shared surface or a shared embedded component that uses it.
- `rg "useChatRunTail" apps/web/src` shows usage only in approved chat runtime
  owners.
- `QuoteChatSheet` does not own chat-run creation, message loading, or stream
  tailing.
- There is no `MiniChat`, `ReaderChatOverlay`, or route-specific transcript
  component.
- There is no local duplicate of context dedupe key logic.
- There is no local duplicate of scope identity logic.
- There is no `context=` quote-to-chat URL path.
- There is no default desktop reader Ask call to `requestOpenInAppPane`.

### Behavioral Acceptance

- Desktop selected-text Ask opens the media secondary rail in `Ask` mode.
- Desktop saved-highlight Ask opens the same media secondary rail in `Ask` mode.
- Desktop Ask renders before scoped conversation resolution and history loading
  complete.
- Desktop Ask focuses the composer without changing the active workspace pane.
- Pending quote context is visible and removable before send.
- Removing context removes it from both the large reader card and composer chips.
- Sending while scoped conversation resolution is pending sends
  `conversation_scope` and no stale `conversation_id`.
- The sent user message and pending assistant row appear immediately after run
  creation.
- Streaming updates the visible pending assistant row.
- Full-chat promotion is disabled before a conversation exists.
- Full-chat promotion after send opens `/conversations/:id`.
- Full-chat promotion during an active run opens `/conversations/:id?run=:runId`.
- Same-media citation activation from reader Ask navigates the current reader.
- Full conversation branch switching, fork strips, branch composer mode, and
  context/forks rail still work.
- New chat first send streams locally and replaces the URL after run creation.
- Mobile reader Ask opens a modal sheet with the same chat body behavior.

### Accessibility Acceptance

- Every chat surface has one named chat conversation region.
- Every chat surface has one named message log.
- The composer is outside the transcript scrollport and inside the composer dock.
- The composer remains reachable by keyboard.
- Reader Ask back, close, remove-context, scope, and full-chat promotion controls
  are real buttons or form controls.
- Mobile sheet traps focus and restores previous focus on close.
- Message citations and source controls are keyboard reachable.

### Layout Acceptance

- The composer is a reserved footer region and never overlaps the final message.
- Loading older messages preserves transcript scroll position.
- Streaming stays pinned only while the user is near the bottom.
- Composer growth reduces transcript height instead of covering transcript
  content.
- Reader rail width does not trigger a separate message layout.
- Mobile safe-area behavior remains intact.

### Test Acceptance

- Focused frontend unit/browser tests pass for shared chat components.
- Reader assistant tests cover pending contexts, scope changes, promotion, and
  before-network visibility.
- Full chat tests cover branch/fork behavior through the shared spine.
- Real-media quote-to-chat E2E passes for desktop rail behavior and mobile sheet
  behavior.
- Context-chat citation E2E passes for reader source activation and full-chat
  promotion.

## Rejected Designs

### One Universal Chat Shell

Rejected. A universal shell would require optional branch state, optional reader
rail state, optional mobile modal state, optional workspace routing, optional
source navigation, and optional context/forks side surfaces. That API would be
larger and more fragile than the duplicated code it removes.

### Separate Mini Chat For Reader Ask

Rejected. It violates the shared runtime, shared message presentation, and no
duplicate state machine requirements.

### Full Chat Opens By Default From Reader Ask

Rejected. It breaks reader-local Ask behavior and the explicit promotion model.

### Compatibility Wrappers

Rejected. They preserve removed APIs and keep old code paths reachable.

### Route-Specific Message Layout Props

Rejected. Message presentation is shared across full chat, new chat, reader Ask,
and mobile Ask. Shells can constrain width and height; they cannot select a
different message renderer.

## Verification Commands

Use the repo's canonical commands for final verification. Focused commands during
implementation:

```bash
rg "<ChatSurface|useChatRunTail|contextDedupeKey|scopeDedupeKey|requestOpenInAppPane" apps/web/src
make test-front-unit
make test-front-browser
make test-e2e
make test-real-media
```

Run broader verification before merge:

```bash
make check
make verify
```

# Scoped Chat Hard Cutover

## Purpose

Make document chat and library chat first-class, durable chat scopes.

The user-facing model is:

- a normal chat has no corpus scope,
- a document chat is the canonical ongoing conversation for one media item,
- a library chat is the canonical ongoing conversation for one library,
- selected quotes and highlights are per-message context layered on top of the
  conversation scope.

This is a hard cutover. The final state has no legacy quote-routing behavior,
no unscoped document-chat inference, no duplicate chat surfaces, no
compatibility mode, no fallback prompt path, and no hidden all-library retrieval
inside scoped conversations.

## Goals

- Give every readable media item one canonical owner-local document chat.
- Give every readable library one canonical owner-local library chat.
- Preserve one chat execution path through durable chat runs.
- Make scope visible in the UI before the user sends a message.
- Make source scope visible in the UI after the assistant answers.
- Route quote-to-chat explicitly to new chat, document chat, or library chat.
- Search scoped chats against the scoped source set by default.
- Keep attached quote/highlight context precise, per-message, and removable.
- Keep prompt rendering and retrieval policy in backend Nexus services.
- Keep citations as backend-owned source objects, not model-authored strings.
- Add query rewriting for conversational retrieval in scoped chats.
- Add production observability for retrieval misses, selected sources, and
  citation coverage.
- Leave a clean extension point for a later compiled library/wiki layer.

## Target Behavior

### Starting Chats

- `New chat` creates an unscoped conversation.
- `Chat about this document` opens the canonical media-scoped conversation for
  the current media item.
- `Chat about this library` opens the canonical library-scoped conversation for
  the current library.
- Opening a media or library chat twice opens the same conversation.
- A scoped conversation displays its scope in the pane chrome and composer:
  - `Document: <media title>`,
  - `Library: <library name>`.
- Scope is not implied by route location. It is persisted on the conversation.

### Quote-To-Chat

- Selecting reader text exposes one chat action with an explicit destination
  menu:
  - `Ask in new chat`,
  - `Ask in this document`,
  - `Ask in library...`.
- `Ask in new chat` creates or opens an unscoped new-chat draft with the
  highlight attached to the first message.
- `Ask in this document` resolves the media-scoped conversation and attaches
  the highlight to the next message.
- `Ask in library...` resolves the selected library-scoped conversation and
  attaches the highlight to the next message.
- If the media belongs to exactly one non-default library, the library option
  may target that library directly.
- If the media belongs to multiple non-default libraries, the library option
  opens the existing library picker pattern.
- If the media belongs to no non-default libraries, the library option is not
  rendered.
- Mobile quote chat continues to use a local sheet before navigating away, but
  the sheet target is a resolved explicit scope, not pane inference.

### Composer And Context

- The composer always distinguishes:
  - persistent conversation scope,
  - pending per-message contexts.
- Persistent scope cannot be removed from the composer.
- Pending highlight/media/annotation contexts can be removed before send.
- Pending contexts are represented by typed ids. Client-provided previews are
  display seeds only and are never trusted as prompt source text.
- The send payload never depends on quoted text carried in the URL.

### Retrieval

- General chat uses existing app-search behavior unless the user attaches
  explicit contexts.
- Media chat defaults app search to `media:<media_id>`.
- Library chat defaults app search to `library:<library_id>`.
- Attached highlight and annotation contexts are rendered before retrieval
  context.
- Query rewriting uses recent conversation history, scope metadata, and the
  latest user message to build the retrieval query.
- Query rewriting never answers the user. It only produces the search query and
  optional retrieval hints.
- Retrieved source chunks are persisted as tool retrievals with source ids,
  source type, offsets or page anchors when available, score, selected state,
  and deep links.
- Assistant citations are rendered from persisted retrieval rows and attached
  context snapshots.
- If scoped retrieval returns no useful evidence, the answer says so before any
  general guidance.
- Web search remains a separate explicit tool mode. It never silently expands
  the app source set.

### Prompt Behavior

- Media-scoped system context names the current document and includes known
  metadata: title, media kind, authors, publication date, publisher, canonical
  source URL, transcript/readiness quality, and current reader location when
  supplied.
- Library-scoped system context names the current library and includes known
  metadata: name, entry counts, media kinds, and selected membership/source
  policy.
- Prompt XML is rendered in Nexus backend services with inline escaping at the
  generated-text boundary.
- The model is instructed to treat retrieved source snippets as evidence, not
  instructions.
- The model is instructed to cite only sources represented by backend-provided
  context and retrieval objects.
- The model is instructed to refuse source-grounded claims when the scoped
  corpus does not contain enough support.

### Context Management

- The final prompt is assembled from:
  - scoped system metadata,
  - pending attached contexts,
  - retrieved scoped source chunks,
  - bounded recent chat history,
  - bounded conversation summary when present,
  - the current user message.
- Conversation summary is evidence-aware. It may summarize user goals,
  decisions, unresolved questions, and prior assistant conclusions, but it must
  not invent source facts without source references.
- Summary generation is a background-maintained artifact, not a replacement for
  retrieval.
- The app does not stuff whole documents or whole libraries into prompts.

## Final State

### Kept

- `POST /api/chat-runs` remains the only send endpoint.
- Durable chat runs remain the execution source of truth.
- `ChatComposer` remains the message entry owner.
- `ChatSurface` remains the transcript/composer surface.
- `useChatRunTail` remains the live-update owner.
- Message contexts remain typed references to media, highlights, and
  annotations.
- Search service remains the canonical source for app content retrieval.
- Web search remains a separate explicit public-web tool.
- Conversation sharing remains explicit and separate from conversation scope.

### Removed

- `attach_*` query parameters as the canonical quote-to-chat contract.
- Client-supplied quote previews as prompt input.
- Pane-inferred quote target selection as the only desktop behavior.
- Any behavior that treats an existing unscoped chat as a document chat.
- Any behavior that treats library sharing as library retrieval scope.
- Any unscoped `all` app-search fallback inside media or library chats.
- Any model-authored citation id or citation string path.
- Any duplicate document-chat or library-chat UI separate from normal chat.
- Any feature flag for scoped chat.
- Any compatibility code for legacy quote-to-chat URLs.

## Architecture

```text
Reader / Media Pane / Library Pane
  resolves target:
    general
    media:<media_id>
    library:<library_id>

Conversation route
  ChatSurface
    ChatComposer
      persistent scope chip
      pending context chips
      POST /api/chat-runs

Next.js BFF
  transport-only /api/* proxy

FastAPI routes
  validate request
  call services

Services
  conversations
    resolve or create scoped conversation
    enforce scope visibility

  chat_runs
    create durable run
    persist user message and context refs
    execute app/web tools
    assemble prompt
    stream model output

  agent_tools.app_search
    rewrite scoped conversational query
    run scoped retrieval
    persist retrieval rows

  chat_prompt / context_rendering
    render scope metadata
    render attached contexts
    render retrieved contexts
```

Scope is persisted on the conversation. Message contexts are persisted on user
messages. Retrievals are persisted on assistant tool calls. These are separate
concepts and must not collapse into one overloaded table.

## Data Model

### Conversations

Add a non-null finite scope to `conversations`:

- `scope_type`: `general | media | library`
- `scope_media_id`: nullable FK to `media.id`
- `scope_library_id`: nullable FK to `libraries.id`

Constraints:

- `general` requires both target columns to be null.
- `media` requires `scope_media_id` and null `scope_library_id`.
- `library` requires `scope_library_id` and null `scope_media_id`.
- Every existing conversation migrates to `general`.
- Final schema has no nullable legacy scope state.
- Partial unique indexes enforce one canonical media chat per
  `(owner_user_id, scope_media_id)`.
- Partial unique indexes enforce one canonical library chat per
  `(owner_user_id, scope_library_id)`.

Scope does not imply sharing. A library-scoped conversation is private unless
the owner explicitly shares it through the existing conversation sharing model.

### Message Contexts

Message contexts stay per-message and typed:

- `media`
- `highlight`
- `annotation`

Do not add `library` as a message context type in this cutover. Library is a
conversation scope, not a one-off message attachment.

### Retrievals

Persist enough retrieval metadata to render citations without trusting the
model:

- source type,
- source id,
- media id when applicable,
- scope at retrieval time,
- deep link,
- selected flag,
- score,
- quote text or snippet,
- page number, timestamp, fragment id, or offsets when available.

The assistant response may mention sources in prose, but UI citations come from
persisted retrieval rows and context snapshots.

### Summaries

Add a scoped conversation summary table only when summary generation is
implemented:

- `conversation_id`
- `summary_text`
- `source_refs`
- `covered_through_seq`
- `prompt_version`
- `created_at`
- `updated_at`

Do not store opaque model memory without source coverage metadata.

## Structure

### Frontend

- Reader selection uses a destination menu, not a single ambiguous chat button.
- Media pane exposes `Chat about this document` in pane actions.
- Library pane exposes `Chat about this library` in pane actions.
- Conversation panes display persistent scope above or inside the composer.
- Context side pane displays:
  - conversation scope,
  - pending contexts,
  - persisted per-message contexts,
  - selected retrieval citations.
- Conversation list displays scope badges for scoped conversations.
- URL state for pending contexts carries typed ids only.

### Backend

- Route handlers validate input and call services.
- Services own scope resolution, visibility checks, retrieval policy, prompt
  rendering, and run execution.
- BFF routes stay transport-only.
- App search receives an explicit scope from conversation scope.
- Query rewriting is a service step with structured output, not prompt string
  parsing inside the search function.

### Retrieval Pipeline

For each scoped chat turn:

1. Load conversation scope and authorize it.
2. Load pending attached context refs.
3. Build a retrieval query from latest user message, recent history, and scope
   metadata.
4. Retrieve from the explicit scope.
5. Rerank or score selected chunks.
6. Persist all retrieved and selected retrieval metadata.
7. Render selected chunks into prompt context.
8. Generate answer.
9. Render citations from persisted objects.

## Rules

- Hard cutover only.
- No feature flag.
- No fallback to unscoped retrieval inside scoped chats.
- No legacy `attach_*` URL compatibility.
- No duplicate document-chat route.
- No duplicate library-chat route.
- No duplicate composer or chat surface.
- No model-authored citations.
- No client-provided quote text as prompt evidence.
- No implicit sharing from scope.
- No business logic in Next.js BFF routes.
- No generic workspace framework.
- No speculative arbitrary-source-set builder in this cutover.
- No compiled wiki implementation in this cutover.
- Branch exhaustively on `general | media | library`.
- Branch exhaustively on context target types.
- Escape prompt XML values inline where generated text is built.
- Keep services explicit and side-effect boundaries clear.
- Tests must prove user-visible behavior and backend retrieval policy.

## Key Decisions

1. Scope is a conversation property, not a message context.

   The scope defines the ongoing corpus and retrieval policy. Message contexts
   define what the user attached to one turn.

2. One canonical scoped conversation per owner and target.

   The product promise is "the document chat" and "the library chat." A second
   scoped thread for the same target creates ambiguity in quote routing and
   context continuity. Users can still create unscoped chats and attach quotes
   there.

3. Scope does not imply sharing.

   A library can be collaborative while a user's chat remains private. Sharing a
   conversation is a separate explicit action with existing permission rules.

4. Retrieval scope is explicit, never inferred from wording alone.

   Phrases like "this document" are useful retrieval hints, but they are not a
   source-of-truth boundary. The persisted conversation scope is the boundary.

5. Citations are backend-owned.

   Users need reliable source navigation. The model may produce helpful prose,
   but citation chips and source panels must come from persisted context and
   retrieval rows.

6. Query rewriting is required for professional conversational RAG.

   Follow-up questions like "what about the method section?" need a standalone
   retrieval query. Passing raw chat history to search is noisy and brittle.

7. Whole-corpus prompt stuffing is forbidden.

   Long context windows do not remove the need for retrieval. They increase the
   blast radius of irrelevant context and make failures harder to debug.

8. Compiled knowledge is a later artifact layer.

   The LLM Wiki pattern is valuable for long-running research libraries, but it
   should be a distinct compiled artifact on top of scoped chat and retrieval,
   not hidden inside chat-run execution.

9. Existing chat infrastructure remains canonical.

   Scoped chat changes how conversations are scoped, searched, and prompted. It
   does not create a second chat product.

## Files

### Add

- `migrations/alembic/versions/<next>_conversation_scopes.py`
  - Add hard-cutover conversation scope columns, constraints, and unique
    indexes.

- `python/nexus/services/conversation_scopes.py`
  - Resolve/create canonical scoped conversations.
  - Authorize media and library scopes.
  - Build scope metadata for prompts and UI.

- `python/tests/test_conversation_scopes.py`
  - Scope constraints, authorization, canonical resolution, and no implicit
    sharing.

- `python/tests/test_scoped_chat_runs.py`
  - Chat-run creation and retrieval policy for media and library scopes.

- `apps/web/src/components/chat/ConversationScopeChip.tsx`
  - Persistent scope display for composer and chat surfaces.

- `apps/web/src/components/chat/ScopedQuoteDestinationMenu.tsx`
  - Reader quote destination menu.

- `apps/web/src/__tests__/components/ScopedQuoteDestinationMenu.test.tsx`
  - Destination rendering and selection behavior.

- `docs/scoped-chat-hard-cutover.md`
  - This plan and behavior contract.

### Update

- `python/nexus/db/models.py`
  - Conversation scope columns and relationships.

- `python/nexus/schemas/conversation.py`
  - Conversation scope request/response schemas.
  - Chat-run create request scope branch when no `conversation_id` is supplied.

- `python/nexus/api/routes/conversations.py`
  - Return scope metadata.
  - Add scoped conversation resolution route if opening an empty scoped chat
    needs a conversation before first send.

- `python/nexus/api/routes/chat_runs.py`
  - Validate exactly one of `conversation_id` or `conversation_scope`.

- `python/nexus/services/conversations.py`
  - Serialize scope metadata.
  - List and get scoped conversations.
  - Delete scoped conversations without orphaning scope state.

- `python/nexus/services/chat_runs.py`
  - Resolve conversation scope in the run creation transaction.
  - Pass explicit retrieval scope to app search.
  - Load bounded summary when summary table exists.

- `python/nexus/services/agent_tools/app_search.py`
  - Accept explicit app-search scope from chat runs.
  - Add scoped query rewriting.
  - Persist retrieval scope.
  - Remove wording-only `this document` scope inference as source of truth.

- `python/nexus/services/search.py`
  - Preserve existing `media:<id>` and `library:<id>` scope behavior.
  - Add missing citation anchor fields only where needed by UI citations.

- `python/nexus/services/context_rendering.py`
  - Render scope metadata blocks.
  - Expand media metadata rendering beyond title and URL.

- `python/nexus/services/chat_prompt.py`
  - Accept scope metadata and retrieval policy.
  - Render source-grounding instructions per scope.

- `apps/web/src/lib/api/sse.ts`
  - Update request types for conversation scope.

- `apps/web/src/lib/conversations/types.ts`
  - Add scope metadata to conversation and chat-run types.

- `apps/web/src/lib/conversations/attachedContext.ts`
  - Replace legacy `attach_*` parsing with typed pending context ids.

- `apps/web/src/components/ChatComposer.tsx`
  - Render persistent scope separately from pending contexts.
  - Submit scope when sending from a scoped new-chat draft.

- `apps/web/src/components/chat/ContextChips.tsx`
  - Keep per-message context chip rendering.
  - Do not render persistent scope as a removable context chip.

- `apps/web/src/components/ConversationContextPane.tsx`
  - Show persistent scope, pending contexts, persisted contexts, and retrieval
    sources in distinct groups.

- `apps/web/src/components/SelectionPopover.tsx`
  - Replace single chat button behavior with scoped destination menu trigger.

- `apps/web/src/components/PdfReader.tsx`
  - Use the same scoped quote destination behavior for PDF selections.

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - Resolve media and library chat destinations explicitly.
  - Add pane action for document chat.
  - Remove legacy quote target inference as canonical behavior.

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  - Add pane action for library chat.

- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
  - Represent scope explicitly for scoped drafts.

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
  - Load and display persisted scope metadata.

- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
  - Display scope badges and scope-aware titles.

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
  - Ensure scoped chat routes have stable titles and subtitles.

- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
  - Scope chip display and scoped send payload behavior.

- `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx`
  - Mobile scoped quote behavior.

- `e2e/tests/conversations.spec.ts`
  - Real-stack scoped chat creation, quote routing, and citations.

- `README.md`
  - Link this plan.

### Avoid Unless Proven Necessary

- New chat runtime separate from `chat_runs`.
- New message table.
- New generic project/workspace table.
- WebSocket infrastructure.
- Background job queue changes.
- LLM provider/router changes.
- Arbitrary source-set UI.
- Compiled wiki tables.

## Acceptance Criteria

- Existing unscoped chat still works through the hard-cutover path.
- Every conversation row has non-null `scope_type`.
- Existing conversations are migrated to `general`.
- A media-scoped conversation cannot be created for unreadable media.
- A library-scoped conversation cannot be created for a library where the user
  is not a member.
- Opening document chat twice for the same user/media opens the same
  conversation.
- Opening library chat twice for the same user/library opens the same
  conversation.
- Scoped chat creation does not share the conversation automatically.
- Media chat app-search runs with `scope=media:<media_id>`.
- Library chat app-search runs with `scope=library:<library_id>`.
- Scoped app-search never falls back to `all` after zero results.
- The assistant explicitly says when scoped retrieval found no useful evidence.
- Web search citations are visually distinct from app/source citations.
- Citation chips are rendered from persisted retrieval/context objects.
- No answer citation depends on a model-authored bracket marker.
- Reader quote destination menu shows the correct destinations.
- Quote to document chat attaches the selected highlight and opens the
  media-scoped conversation.
- Quote to library chat attaches the selected highlight and opens the selected
  library-scoped conversation.
- Quote to new chat creates an unscoped conversation with the highlight
  attached to the first message.
- Mobile quote sheet targets the selected explicit destination.
- Pending context URLs contain typed ids, not quote text.
- Legacy `attach_*` parsing is removed.
- Composer shows persistent scope separately from removable context chips.
- Conversation context pane groups scope, pending contexts, persisted contexts,
  and retrieval sources separately.
- Conversation list shows whether a conversation is general, document-scoped, or
  library-scoped.
- Prompt tests cover general, media, and library scope instructions.
- Retrieval tests cover follow-up query rewriting.
- Backend tests cover scope authorization and unique canonical resolution.
- Browser component tests cover destination menu behavior.
- E2E covers document chat, library chat, and quote-to-scoped-chat routing.
- TypeScript typecheck passes.
- Targeted frontend tests pass.
- Targeted backend tests pass.
- Targeted migration tests pass.

## Non-Goals

- Do not build compiled LLM Wiki pages in this cutover.
- Do not add arbitrary user-created projects.
- Do not add arbitrary source checkboxes in chat.
- Do not add multi-chat project memory.
- Do not make library-scoped conversations automatically shared.
- Do not redesign the entire conversations list.
- Do not redesign message rows beyond source/citation display needed for scope.
- Do not add file upload to chat composer.
- Do not change reader resume behavior.
- Do not change highlight storage semantics.
- Do not change media/library membership semantics.
- Do not change billing or model availability behavior.
- Do not add web browsing beyond the existing web-search tool.
- Do not add prompt suggestions.
- Do not add collaborative live editing.

## Implementation Order

1. Add migration tests for conversation scope constraints and canonical indexes.
2. Add backend scope schemas and service tests.
3. Add the conversation scope migration and model updates.
4. Add scoped conversation resolution service.
5. Update conversation serialization and list/get endpoints.
6. Update chat-run creation to resolve scope transactionally.
7. Pass explicit app-search scope through chat runs.
8. Add scoped query rewriting and retrieval tests.
9. Add scope-aware prompt rendering tests.
10. Replace legacy frontend pending context URL parsing.
11. Add persistent scope types and scope chip UI.
12. Update composer and context pane to separate scope from contexts.
13. Add media pane document-chat action.
14. Add library pane library-chat action.
15. Replace reader quote chat button with destination menu.
16. Update PDF quote-to-chat to use the same destination behavior.
17. Update mobile quote sheet target handling.
18. Update conversation list scope badges.
19. Add real-stack E2E for document chat and library chat.
20. Delete legacy quote routing and `attach_*` compatibility code.
21. Run targeted backend, frontend, migration, and E2E checks.

## External Reference Notes

- ChatGPT Projects group chats, files, instructions, and project memory into a
  durable workspace:
  https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt
- Claude Projects use self-contained workspaces with chat histories, knowledge
  bases, and project instructions:
  https://support.claude.com/en/articles/9517075-what-are-projects
- NotebookLM makes source selection visible and uses citations to navigate back
  to source quotes:
  https://support.google.com/notebooklm/answer/16179559
- OpenAI File Search uses vector stores for searchable knowledge bases:
  https://platform.openai.com/docs/guides/tools-file-search/
- Azure OpenAI On Your Data separates ingestion, filtering, reranking, prompt
  inclusion, generation, and citation debugging:
  https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/on-your-data-best-practices
- AWS Bedrock Knowledge Bases describes managed RAG with session context
  management and source attribution:
  https://docs.aws.amazon.com/prescriptive-guidance/latest/retrieval-augmented-generation-options/rag-fully-managed-bedrock.html
- LangChain conversational retrieval rewrites the latest question into a
  standalone retrieval query before retrieval:
  https://reference.langchain.com/python/langchain-classic/chains/conversational_retrieval/base/ConversationalRetrievalChain
- LlamaIndex context chat retrieves from an index for each chat interaction and
  bounds chat memory:
  https://docs.llamaindex.ai/en/stable/examples/chat_engine/chat_engine_context/
- The LLM Wiki pattern compiles raw sources into durable cited knowledge pages
  instead of re-deriving every answer at query time:
  https://llmwiki.lol/

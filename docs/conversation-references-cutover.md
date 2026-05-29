# Spec: Conversation References Cutover

## Summary

Replace six fragmented chat-context tables with one polymorphic `conversation_references` table whose rows are pure pointers (URI + timestamp). All conversation-connected resources — pinned media, libraries, cited spans, retrieved chunks, user highlights, note blocks, other messages, other conversations — collapse into this single table, dispatched by a URI scheme. Prompt assembly resolves each URI on the fly via a resolver layer; small bodies inline, large ones expose a fetch/search tool surface. Citations from `app_search` auto-write references so the model is no longer amnesiac across turns. Singletons, scopes, and memory items are deleted outright. Hard cutover; no shims, no fallbacks, no data migration.

---

## Goals

1. **One table connects any object to a conversation.** `conversation_references(conversation_id, resource_uri, added_at)`. No `kind`, no `scope_ref`, no `content_ref`, no `origin`.
2. **Resources are pointers, not payloads.** Prompt size is independent of how much the model has cited or how many sources are pinned. Inline only when the body is small.
3. **The model is no longer amnesiac across turns.** When `app_search` retrieves a span and the model cites it, that span becomes a reference; the next turn's prompt sees it without re-searching.
4. **Scope is emergent, not declared.** A conversation's "scope" is the set of media/library references it holds. Expand mid-conversation = add a reference. Contract = remove one. No special-case columns.
5. **One chat type.** No singletons, no doc-chats-vs-library-chats-vs-free-chats distinction in code or schema. The UX affordance "Chat about this document" becomes "find or create a chat with this media in its references."
6. **Delete dead architecture.** `conversation_memory_items`, `conversation_memory_item_sources`, `conversation_pinned_sources`, `chat_singletons`, `message_context_items`, and `conversations.scope_*` columns are gone, not deprecated.
7. **Two tools, one mental model.** `read_resource(uri)` for citeable units; `app_search(query, scopes?)` accepts URIs for scope. The URI grammar is the contract.

## Non-goals

- Not redesigning `messages`, `message_retrievals`, `chat_run_events`, `message_tool_calls`, `evidence_spans`, `content_chunks`, or any retrieval infrastructure. These stay exactly as-is.
- Not preserving any "what was attached at message N specifically" temporal locality. References are conversation-scoped only.
- Not migrating production data. Single-user prototype; drop tables, recreate, start fresh.
- Not introducing per-reference ACLs, ordering, or grouping. `added_at` orders; user can remove; that's it.
- Not generating reference summaries with an LLM at write-time. Summaries are pulled from existing object metadata (title, author, excerpt) by the resolver layer.
- Not changing the URL/hash contract for the reader. That's `docs/reader-target-link-cutover.md`'s domain.
- Not adding a "memory" or "long-term context" feature. The reference list IS the memory. If the user wants a fact remembered, they pin the source.
- Not soft-deleting anything. `DROP TABLE`, `DROP COLUMN`. Real cutover.

---

## North Star: the reference model

Every persistent connection between a conversation and any other object in the system is a **reference**: an opaque URI pointing at a typed resource. The conversation owns a flat, deduplicated set of references. The model reads them every turn as part of the system context.

| Layer              | What it is                                         | Where it lives                          | Lifetime                            |
| ------------------ | -------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| **Reference**      | A pointer to something the model can access        | `conversation_references` row           | Until user removes                  |
| **Resolution**     | URI → label / summary / inline body / fetch hint   | `resource_resolver.py` dispatch by scheme | Per prompt-assembly call            |
| **Body**           | The actual text of the resource                    | Source-of-truth table (media, spans, …) | Lifetime of the underlying object   |
| **Inline message** | Transient text the user pasted (reader selections) | Message body, never a reference         | With the message                    |

Anything that doesn't fit one of those four is misplaced and the spec rejects it.

---

## Resource URI grammar

Single URI per reference. Format:

```
<scheme>:<uuid>
```

Allowed schemes and what each resolves to:

| Scheme         | Underlying table       | Inline body? | Fetch surface                                       |
| -------------- | ---------------------- | ------------ | --------------------------------------------------- |
| `media`        | `media`                | No (too big) | `app_search(scope="media:UUID", query=...)`         |
| `library`      | `libraries`            | No (too big) | `app_search(scope="library:UUID", query=...)`       |
| `span`         | `evidence_spans`       | Yes if small | `read_resource("span:UUID")`                        |
| `chunk`        | `content_chunks`       | Yes if small | `read_resource("chunk:UUID")`                       |
| `highlight`    | `highlights`           | Always (it's a highlight) | `read_resource("highlight:UUID")`         |
| `page`         | `note_pages`           | Yes if small | `read_resource("page:UUID")`                        |
| `note_block`   | `note_blocks`          | Always (it's a block) | `read_resource("note_block:UUID")`        |
| `fragment`     | `fragments`            | Yes if small | `read_resource("fragment:UUID")`                    |
| `conversation` | `conversations`        | No (sequence)| `read_resource("conversation:UUID")` returns summary; deeper requires search |
| `message`      | `messages`             | Yes if small | `read_resource("message:UUID")`                     |

Unknown scheme → resolver returns a placeholder block and the reference becomes a candidate for cleanup (`reference_unresolved` event surfaced once in the UI; user can dismiss). No exceptions; the model still sees something.

**Inline threshold:** 1500 chars of body. Configurable as a constant in the resolver module. Smaller → inline; larger → pointer with summary.

**No `reader_selection:` scheme.** Reader selections stay inline in the user message they were sent with (rendered as `<reader_selection>` text). If the user wants persistence, they make a highlight.

---

## Schema changes

### New

```sql
CREATE TABLE conversation_references (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    resource_uri TEXT NOT NULL,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, resource_uri)
);
CREATE INDEX conversation_references_uri_idx ON conversation_references(resource_uri);
CREATE INDEX conversation_references_conversation_added_idx
    ON conversation_references(conversation_id, added_at DESC);
```

The `ON DELETE CASCADE` on `conversation_id` is an explicit exception to `docs/rules/database.md`'s no-cascade rule. Justification: a deleted conversation has no meaningful surviving references.

`resource_uri` is opaque to the database. No FK to the underlying object. Cleanup of dangling references happens at read time (resolver returns a `missing` block), not at write time.

### Deleted tables

- `conversation_memory_items`
- `conversation_memory_item_sources`
- `conversation_pinned_sources`
- `chat_singletons`
- `message_context_items`

### Deleted columns on `conversations`

- `scope_type`
- `scope_media_id`
- `scope_library_id`

### Untouched

- `conversations` (minus the three columns above)
- `messages`
- `message_tool_calls`
- `message_retrievals` (cited spans become references via write-through; the retrieval row itself is unchanged)
- `message_retrieval_candidate_ledgers`
- `chat_run_events`
- `source_manifests`
- `conversation_media` (materialized derivation; rebuild trigger source changes from `message_context_items` → `conversation_references`)
- `evidence_spans`, `content_chunks`, `source_snapshots`, etc.

### Single migration

One Alembic migration file: `python/db/migrations/0XXX_conversation_references_cutover.py`. Drops the five tables, drops the three conversation columns, creates the new table. No downgrade path (single-user, hard cutover).

---

## Resolver layer

New module: `python/nexus/services/resource_resolver.py`.

### Public surface

```python
@dataclass(frozen=True)
class ResolvedResource:
    uri: str
    label: str           # one-line human-readable
    summary: str         # ~1-2 lines, for model relevance judgment
    inline_body: str | None   # full text if <INLINE_THRESHOLD, else None
    fetch_hint: str      # tells the model how to fetch full content
    missing: bool = False

def resolve(db: Session, uri: str, *, viewer_id: UUID) -> ResolvedResource:
    """Single-resource resolve. O(1) DB hits."""

def resolve_batch(db: Session, uris: Sequence[str], *, viewer_id: UUID) -> list[ResolvedResource]:
    """Batch resolver. Groups by scheme and loads each group in one query."""
```

### Per-scheme resolver functions

Internal dispatch table:

```python
_RESOLVERS: dict[str, Callable] = {
    "media": _resolve_media,
    "library": _resolve_library,
    "span": _resolve_span,
    "chunk": _resolve_chunk,
    "highlight": _resolve_highlight,
    "page": _resolve_page,
    "note_block": _resolve_note_block,
    "fragment": _resolve_fragment,
    "conversation": _resolve_conversation,
    "message": _resolve_message,
}
```

Each resolver:
1. Validates the viewer's permission to access the resource (delegates to existing permission helpers — `can_read_media`, `is_library_member`, owner checks).
2. Loads the underlying row via the appropriate FK.
3. Returns `ResolvedResource` with label/summary derived from already-stored metadata. **Never generates new text.** Title, author, excerpt, page number, etc. come from the source object as-is.
4. On missing/forbidden: returns `ResolvedResource(missing=True, label="(resource unavailable)", ...)`.

### Batch pattern

```python
def resolve_batch(db, uris, *, viewer_id):
    by_scheme = defaultdict(list)
    for uri in uris:
        scheme, _, ident = uri.partition(":")
        by_scheme[scheme].append((uri, ident))
    results: dict[str, ResolvedResource] = {}
    for scheme, items in by_scheme.items():
        resolver = _BATCH_RESOLVERS.get(scheme)
        for resolved in resolver(db, items, viewer_id=viewer_id):
            results[resolved.uri] = resolved
    return [results[u] for u in uris]
```

Each batch resolver issues one SQL query per scheme. N+1 is structurally prohibited.

### Inline threshold

```python
INLINE_THRESHOLD_CHARS = 1500
```

Resolvers fill `inline_body` if and only if the rendered body would be under this length. Above it, `inline_body = None` and the prompt block is pointer-only.

---

## Tool surface

Two tools added to the chat-run loop. The existing `app_search` is extended; `read_resource` is new. `web_search` is unaffected.

### `read_resource`

```json
{
  "name": "read_resource",
  "description": "Fetch the full content of a resource that appears in <resources> in your system context. Accepts a resource URI such as 'span:UUID', 'chunk:UUID', 'highlight:UUID', 'page:UUID', 'note_block:UUID', 'fragment:UUID', 'message:UUID', or 'conversation:UUID'. Not valid for 'media:UUID' or 'library:UUID' — those are search scopes; use app_search with scope=...",
  "parameters": {
    "type": "object",
    "properties": {
      "uri": {"type": "string", "description": "Resource URI to read."}
    },
    "required": ["uri"]
  }
}
```

Behavior:
- URI must already be a reference of the current conversation. **No reading arbitrary URIs.** Enforces the model only reads what's been admitted as context.
- Returns the full text body of the resource.
- For `media:` / `library:`: returns an error message instructing the model to use `app_search` with the URI as scope.
- For unknown / missing / forbidden: returns an error block; does not raise.

Handler: `python/nexus/services/agent_tools/read_resource.py` (new).

### `app_search` modified

Add an optional `scopes: string[]` parameter. Each entry is a `media:UUID` or `library:UUID` URI.

```json
{
  "name": "app_search",
  "description": "Search across your saved articles, books, podcasts, PDFs, highlights, and notes. By default, searches within the conversation's referenced media and libraries. Pass scopes=['media:UUID', 'library:UUID'] to narrow further.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {"type": "string"},
      "scopes": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Optional URI scopes to restrict the search to. Each must be 'media:UUID' or 'library:UUID' present in the conversation's references."
      }
    },
    "required": ["query"]
  }
}
```

Resolution rules:
- If `scopes` is omitted: search defaults to all media/library URIs present in `conversation_references` for this conversation. If none, search the viewer's entire library.
- If `scopes` is provided: must be a subset of references; otherwise error.
- The `media_id` / `library_id` arguments currently passed into `execute_app_search` (from pinned-sources resolution) are dropped. Scope derivation moves entirely to URI form.

Modified handler: `python/nexus/services/agent_tools/app_search.py`. The `_pinned_search_scope` helper in `chat_runs.py:169` is deleted.

---

## Prompt assembly

The system prompt gains one new dynamic block: `<resources>`. Built fresh every turn by `context_assembler.assemble_chat_context`. Placement: after the stable system instructions, before message history.

```xml
<resources>
  <resource uri="media:abc-123">
    label: The Selfish Gene by Richard Dawkins
    summary: Evolutionary biology, 1976. ~80k words. Searchable.
    fetch: app_search(scope="media:abc-123", query=...)
  </resource>
  <resource uri="span:def-456">
    label: p. 47, "We are survival machines..."
    summary: From The Selfish Gene; passage on gene-centric evolution.
    body:
      We are survival machines—robot vehicles blindly programmed
      to preserve the selfish molecules known as genes.
  </resource>
</resources>
```

Implementation:
1. `assemble_chat_context` loads all `conversation_references` for the conversation (one query, ordered by `added_at`).
2. Passes the URI list to `resource_resolver.resolve_batch`.
3. Renders each `ResolvedResource` into a `<resource>` block. Inline body present → `<body>...</body>`. Inline body absent → omit the body element.
4. Appends as a single `PromptBlock` with `cache_policy=None` (dynamic; per-turn changes invalidate, so it's not in the stable prefix).

Order within `<resources>`: by `added_at` ascending. Stable, predictable, gives the model temporal context for what the user pinned earliest vs most recently.

### What's deleted from prompt assembly

- `load_active_memory_items` → deleted. No memory injection.
- `load_pinned_blocks` → deleted. Pinned content surfaces via the unified `<resources>` block.
- `message.context_items` per-message loop in history rendering → deleted. The conversation's references suffice; per-turn user attachments live in the message body itself.
- The reader-selection rendering path (`<reader_selection>` block in user messages) stays.

---

## Citation pipeline write-through

When `_emit_citation_index` finalizes citations for the assistant message (`chat_runs.py:256`), it gains a side effect: for each `MessageRetrieval` that received a `citation_ordinal`, write a `conversation_references` row pointing at the cited resource.

```python
def _persist_cited_references(db, conversation_id, retrievals):
    for r in retrievals:
        uri = _retrieval_to_uri(r)
        if uri is None:
            continue
        db.execute(
            insert(ConversationReference)
            .values(conversation_id=conversation_id, resource_uri=uri)
            .on_conflict_do_nothing(index_elements=["conversation_id", "resource_uri"])
        )
```

URI derivation from `MessageRetrieval.result_type`:
- `evidence_span` → `span:{evidence_span_id}`
- `content_chunk` → `chunk:{chunk_id}` (from `result_ref`)
- `highlight` → `highlight:{highlight_id}` (from `result_ref`)
- `page` → `page:{page_id}` (from `result_ref`)
- `note_block` → `note_block:{block_id}`
- `media` → `media:{media_id}` (rare; only if the citation references a whole media)
- `conversation` → `conversation:{conversation_id}`
- `message` → `message:{message_id}`
- `web_result` → no reference (web results don't have a persistent URI in this system)

Runs in the same transaction as `_emit_citation_index`. Failure surfaces as run failure.

**No retrieval-without-citation write-through.** The model called `app_search`, got 12 results, but only cited 3? Only those 3 graduate to references. The other 9 stay in `message_retrievals` for audit but never enter the prompt scope. Cleaner and aligned with "the model decides what's relevant."

---

## API surface

### Deleted endpoints

```
GET    /api/chat-singletons/media/{media_id}
GET    /api/chat-singletons/library/{library_id}
GET    /api/chat-references/media/{media_id}
GET    /api/conversations/{conversation_id}/pinned-sources
POST   /api/conversations/{conversation_id}/pinned-sources
DELETE /api/conversations/{conversation_id}/pinned-sources/{ordinal}
```

Backend files deleted in full:
- `python/nexus/api/routes/chat_singletons.py`
- `python/nexus/services/chat_singletons.py`
- The pinned-sources subroutes in `python/nexus/api/routes/conversations.py:283-330`
- Memory-related services and routes (search for `conversation_memory`).

Frontend files deleted in full:
- `apps/web/src/app/api/chat-singletons/media/[mediaId]/route.ts`
- `apps/web/src/app/api/chat-singletons/library/[libraryId]/route.ts`
- `apps/web/src/app/api/conversations/[id]/pinned-sources/route.ts`
- `apps/web/src/app/api/conversations/[id]/pinned-sources/[ordinal]/route.ts`
- `apps/web/src/lib/conversations/useConversationSingleton.ts`
- `apps/web/src/lib/conversations/useDocReferencingChats.ts`
- `apps/web/src/lib/conversations/usePinnedSources.ts`
- `apps/web/src/components/chat/PinnedSourcesTray.tsx`

### New endpoints

```
GET    /api/conversations/{conversation_id}/references
       → 200 [{ id, resource_uri, label, summary, added_at }, ...]
       Resolves and returns the full list. Used by sidebar UI.

POST   /api/conversations/{conversation_id}/references
       body: { resource_uri: string }
       → 201 { id, resource_uri, label, summary, added_at }
       Idempotent on (conversation_id, resource_uri).

DELETE /api/conversations/{conversation_id}/references/{reference_id}
       → 204
```

```
GET    /api/conversations?has_reference={resource_uri}
       → 200 [ConversationSummary, ...]
       Filters conversations by presence of a specific reference URI.
       Replaces the "list referencing chats for media X" use case.
```

New backend module: `python/nexus/api/routes/conversation_references.py` mounting under the `conversations_router`.
New service: `python/nexus/services/conversation_references.py` with `list`, `add`, `remove`, `list_conversations_with_reference` functions.

### Modified endpoints

`GET /api/conversations` — drop the scope-filter param entirely. Add `has_reference=<uri>` as the only filter beyond pagination and search. Response shape: `ConversationSummary` loses the `singleton` field.

`POST /api/conversations` — accept optional `initial_references: string[]` so creation can atomically auto-add references (used by "Chat about this document" button).

`POST /api/chat-runs` — drop the `contexts` array. Per-message attached contexts are deleted as a concept. If the user attached something in the composer, the frontend writes the reference first via `POST /references`, then sends a normal chat-run.

### Modified backend SQL/services

`python/nexus/services/conversations.py:1202-1293` (`list_referencing_conversations_for_media`) → deleted. Replaced by `list_conversations_with_reference("media:UUID")` in the new service.

`python/nexus/services/chat_run_message_prep.py:83` (`insert_contexts_batch`) → deleted. No more per-message contexts.

`python/nexus/services/conversations.py` `list_messages` → strip out `message_context_items` join; messages no longer carry attached contexts.

### SSE events

One new event in the chat-run stream:

```
event: reference_added
data: { reference_id, resource_uri, label, summary, added_at }
```

Emitted by the citation write-through path whenever a NEW reference is inserted (i.e., when `on_conflict_do_nothing` actually inserted, not skipped). Emitted after `citation_index`, before `done`.

`source_manifest_delta` → deleted. It's been obsolete since the prior cutover (see `.agency/report.md:152`) and nothing about the new design needs it.

All other event types (`meta`, `tool_call`, `retrieval_result`, `citation_index`, `delta`, `done`) are unchanged.

---

## Frontend changes

### Deleted UI concepts

- The "Chat about this document" singleton card and badge. There is no canonical chat per (user, media); any chat with `media:X` in references is "about" X.
- The "Other chats" list in `DocChatTab`. Replaced by a uniform list of "Chats with this in references."
- The pinned-sources tray (`PinnedSourcesTray.tsx`). Replaced by a references rail.
- Per-message attached contexts in the composer (`ComposerContextRail.tsx`). Replaced by adding references at the conversation level.
- The `ConversationSingleton` type and `singleton` field on `ConversationSummary`.
- The `is_singleton` field on `ConversationListItem`.

### New / modified UI

#### Chat sidebar in the media reader (`DocChatTab.tsx`)

Rewritten:
- Fetch: `GET /api/conversations?has_reference=media:{mediaId}` — list of chats with this media as a reference.
- Per row: title, snippet of latest message, last activity timestamp. No "singleton" treatment; all rows equal.
- "Start new chat" button → `POST /api/conversations` with `initial_references: ["media:{mediaId}"]` → opens the new chat in the secondary rail.
- Top-of-list affordance: if the list is empty, prominent "Start new chat about this document" CTA. If non-empty, an inline "+ New" button.

#### Chat sidebar in libraries (`LibraryChatTab.tsx`)

Same treatment with `library:{libraryId}`.

#### Chat detail (`ConversationPaneBody.tsx`)

New right-rail panel: **References**.
- Fetch via `GET /api/conversations/{id}/references`.
- Per item: label, summary line, X-to-remove. Click opens the resource in a new pane (or the existing media reader if it's a media/span/highlight).
- Add: small input/picker. URI grammar visible in dev mode only; production has a search-and-pick over the viewer's library.

Subscribed to the SSE `reference_added` event: live-appends when the model cites something new.

#### Composer (`ChatComposer.tsx`)

`attachedContexts` prop and `ComposerContextRail` deleted. The composer is just a text input + submit. The "add context" action moves to the references rail.

If the user wants to attach a reader selection: it's pasted into the composer as inline text. The `<reader_selection>` wrapper is added by the user-message rendering path (already exists; unchanged).

#### Global conversations list (`ConversationsPaneBody.tsx`)

Remove all singleton-aware code (lines 114-134). Rows are uniform. No icons distinguishing doc-chats from library-chats. Reference badges shown inline ("3 sources") with hover for the full list.

### Modified types (`apps/web/src/lib/conversations/types.ts`)

Deleted:
- `ConversationSingleton`
- `ConversationPinnedSource`
- `ConversationPinnedSourceKind`
- `singleton` field on `ConversationSummary`
- `is_singleton` field on `ConversationListItem`
- `ContextItem` (per-message attachment shape)

Added:
- `ConversationReference { id, resource_uri, label, summary, added_at }`

### Modified hooks

Deleted: `useConversationSingleton`, `useDocReferencingChats`, `usePinnedSources`.

Added: `useConversationReferences(conversationId)` — fetches and live-updates the references list via SSE.

Added: `useChatsByReference(resourceUri)` — replaces `useDocReferencingChats`; generalizes to any URI.

---

## Files touched

### Backend new
- `python/db/migrations/0XXX_conversation_references_cutover.py`
- `python/nexus/services/resource_resolver.py`
- `python/nexus/services/conversation_references.py`
- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/api/routes/conversation_references.py`

### Backend modified
- `python/nexus/db/models.py` — drop 5 classes (memory items × 2, pinned sources, singletons, message context items), add `ConversationReference`, drop scope columns on `Conversation`.
- `python/nexus/services/context_assembler.py` — rewrite around `<resources>` block; delete memory and pinned loaders.
- `python/nexus/services/chat_runs.py` — delete `_pinned_search_scope` (169-182); delete `_CHAT_TOOL_SPECS` entry assembly to include `read_resource`; add citation write-through call; delete singleton resolution paths.
- `python/nexus/services/agent_tools/app_search.py` — accept `scopes: list[str]` param; resolve scope from URIs not from `media_id`/`library_id` args; emit `media:`/`library:` URI form in `scope` field of `MessageRetrieval`.
- `python/nexus/services/conversations.py` — delete `list_referencing_conversations_for_media`; strip context-item joins from `list_messages`; add `list_conversations_with_reference`.
- `python/nexus/services/chat_run_message_prep.py` — delete `insert_contexts_batch` and its call sites.
- `python/nexus/services/locator_resolver.py` — repurpose into a sub-component used by the new resolver layer (existing logic for span resolution becomes the body of `_resolve_span`).
- `python/nexus/services/context_lookup.py` — fold into the new resolver layer; this is essentially the same dispatch we're rebuilding.
- `python/nexus/services/message_context_snapshots.py` — delete entirely (snapshots were per-message context; no longer needed).
- `python/nexus/api/routes/conversations.py` — delete pinned-sources subroutes; strip scope filtering from `list`; accept `has_reference` and `initial_references`.
- `python/nexus/api/routes/__init__.py` — drop the `chat_singletons_router` import and mount.
- `python/nexus/schemas/conversation.py` — drop `source_manifest_delta` from the SSE event union; add `reference_added`.

### Backend deleted
- `python/nexus/api/routes/chat_singletons.py`
- `python/nexus/services/chat_singletons.py`
- All `conversation_memory*` services.

### Frontend new
- `apps/web/src/lib/conversations/useConversationReferences.ts`
- `apps/web/src/lib/conversations/useChatsByReference.ts`
- `apps/web/src/components/chat/ConversationReferencesRail.tsx`

### Frontend modified
- `apps/web/src/components/chat/DocChatTab.tsx` — rewrite list fetch + creation path.
- `apps/web/src/components/chat/LibraryChatTab.tsx` — same treatment.
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx` — drop singleton paths.
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx` — swap pinned tray for references rail.
- `apps/web/src/components/ChatComposer.tsx` — drop `attachedContexts` prop.
- `apps/web/src/lib/conversations/types.ts` — type surgery.
- `apps/web/src/lib/conversations/display.ts` — drop `SINGLETON_KIND_ICONS`, `formatSingletonLabel`.
- `apps/web/src/lib/api/sse/events.ts` — add `reference_added`, drop `source_manifest_delta`.
- `apps/web/src/components/chat/useChatRunTail.ts` — handle the new event.
- `apps/web/src/components/chat/useChatMessageUpdates.ts` — wire the new event into state.

### Frontend deleted
- `apps/web/src/app/api/chat-singletons/media/[mediaId]/route.ts`
- `apps/web/src/app/api/chat-singletons/library/[libraryId]/route.ts`
- `apps/web/src/app/api/conversations/[id]/pinned-sources/route.ts`
- `apps/web/src/app/api/conversations/[id]/pinned-sources/[ordinal]/route.ts`
- `apps/web/src/lib/conversations/useConversationSingleton.ts`
- `apps/web/src/lib/conversations/useDocReferencingChats.ts`
- `apps/web/src/lib/conversations/usePinnedSources.ts`
- `apps/web/src/components/chat/PinnedSourcesTray.tsx`
- `apps/web/src/components/chat/ComposerContextRail.tsx`

### Tests modified
- `apps/web/src/__tests__/components/DocChatTab.test.tsx`
- `apps/web/src/__tests__/components/ConversationsPaneBody.test.tsx`
- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
- `python/tests/test_conversations.py` (any scope or pinned-sources tests)
- `python/tests/test_chat_singletons.py` → delete
- `python/tests/test_chat_runs.py` (scope derivation, citation pipeline)
- New: `python/tests/test_conversation_references.py`, `python/tests/test_resource_resolver.py`, `python/tests/test_read_resource_tool.py`

---

## Key decisions

1. **No `kind` column.** URI scheme is the discriminator. Adding a new resource type is one resolver function, zero schema changes.

2. **No FK from `resource_uri` to underlying objects.** Cleanup is lazy via the resolver's `missing` path. Cost: orphan rows accumulate over time. Mitigation: a periodic janitor job is acceptable but out of scope for this cutover.

3. **One table for all reference origins (user-pinned vs model-cited vs system-added).** No `origin` column. The user doesn't care how it got there; they just see what's connected. If origin is ever needed for analytics, query `chat_run_events` instead.

4. **No prompt windowing.** All references render every turn. Inline-vs-pointer threshold of 1500 chars keeps prompt growth bounded: 100 references × ~80 tokens of metadata = 8k tokens, well under any budget.

5. **Citations auto-add references, retrievals do not.** Cited = "the model decided this was load-bearing." Retrieved-but-not-cited = "search noise." Only the former graduates.

6. **`read_resource` requires URIs already in the conversation.** Prevents the model from poking at arbitrary IDs. Maintains the invariant: every piece of content the model can read came through the references list (which is controlled by user or by cited retrievals).

7. **No singleton concept anywhere.** "Chat about this document" is a UI affordance, not a database concept. Implemented as: `POST /api/conversations` with `initial_references: ["media:UUID"]`. The "canonical chat" is whatever the user chose to call canonical — the system has no opinion.

8. **`scope_type` columns on conversations: gone, no replacement.** Scope is the set of media/library references. No `WHERE scope_type='media'` queries ever again. The scope filter in `GET /api/conversations` is replaced by `has_reference=media:UUID`.

9. **Reader selections stay inline.** They're transient pasted text, not persistent resources. If you want to keep a passage, highlight it.

10. **`conversation_media` materialized view rebuilds from `conversation_references`.** Same idea, different source. Implementation: trigger or scheduled re-derive; existing infrastructure stays.

11. **The `<resources>` block lives in `dynamic_system_blocks`, not the stable prefix.** It changes per-turn (new references from citations). Cache prefix invalidation would be ruinous; placement in the dynamic section keeps the stable prefix cacheable across the whole conversation lifetime.

12. **No GUI for raw URIs.** The reference picker is search-and-pick over the viewer's content. URIs are an implementation detail. The model sees them; the user doesn't.

13. **Hard cutover.** No `conversations.scope_type_legacy`, no `conversation_pinned_sources_deprecated_at`, no feature flag. Prod DB is wiped. Single-user prototype; the cost is one user re-pinning their stuff.

---

## Capability contract

What the system promises after cutover:

1. **Adding a reference is one row insert.** No ordinals, no joins, no triggers fired against context tables.
2. **Removing a reference is one row delete.** No cascading content cleanup; the source object is untouched.
3. **The prompt size is bounded by `references.count × ~80 tokens + sum(inline_body.length, inline only)`.** Pointer-only references have a stable per-reference budget.
4. **The model can always reach any reference's full text via `read_resource(uri)` or `app_search(scope=uri, …)`.** No reference is "stuck" as a label.
5. **Citations are sticky.** Anything the model cites in turn N is in the references list by turn N+1.
6. **Conversation deletion cascades only to its own references.** Source objects (media, spans, highlights) are unaffected.
7. **Permission checks happen in the resolver layer.** A reference URI never bypasses the existing permission model — if the viewer can't see the underlying object, the reference renders as `missing`.

What the system does NOT promise:

- Reference integrity over object lifetime. Deleting a referenced media leaves dangling references (rendered as `missing`).
- Ordering beyond `added_at`. No manual reorder.
- Cross-conversation reference sharing. Each conversation's references are its own.
- Reference visibility in shared conversations. (Shares stay scoped to messages, not references, per existing share model.)

---

## How this composes with other systems

### Reader (`docs/reader-target-link-cutover.md`)

Orthogonal. Reader targets are about *where in a media to focus on first paint*, not *what's connected to a conversation*. A reference to `span:UUID` doesn't navigate the reader; the existing pulse-event path does that. But: when a user clicks a reference in the chat sidebar, the click handler resolves the URI to a media + locator and opens the reader with the appropriate hash target. The two specs meet at the click handler in `ConversationReferencesRail` → `nexus:reader-pulse-highlight` event.

### Citations (existing)

Unchanged at the assistant-output layer. `[N]` markers still substitute via `ReaderCitation` components. The reader_citation `href` still derives from `hrefForReaderTarget`. The only addition is the write-through: when `_emit_citation_index` runs, the cited resources get reference rows. The SSE `citation_index` event is unchanged; the new `reference_added` event is independent.

### `message_retrievals` (existing)

The durable record of every `app_search` execution. Untouched. The new system treats it as the source of truth for "what the model searched and what came back" — fully orthogonal from "what's in the conversation context." Selected-but-uncited retrievals stay in this table for audit; they don't enter the prompt.

### Reader selection (`<reader_selection>` blocks)

Stays exactly as-is. The user pastes a passage; the message wraps it; the model sees the passage in the user message text. Not a reference.

### Workspace pane state (`wsv`/`ws`)

Untouched. Pane hrefs are addresses; references are conversation content. Different layers.

### Shares (`/api/conversations/{id}/shares`)

Untouched. Sharing shares messages, not references. (Shared viewer sees the conversation history; the resolver layer enforces their permission on each referenced resource.)

---

## Cutover sequence

Strict order; each step compiles and runs. No half-states.

1. **Migration.** Drop the 5 tables, drop 3 columns, create `conversation_references`. Single Alembic revision.
2. **Resolver + read_resource tool.** Build `resource_resolver.py`, `read_resource.py`, tests. Wire tool into `_CHAT_TOOL_SPECS`. No call sites yet.
3. **`app_search` URI scopes.** Modify `app_search` to accept `scopes` URI form. Drop `media_id`/`library_id` params. Drop `_pinned_search_scope`. Update tests.
4. **References service + API.** `conversation_references.py` service, `/api/conversations/{id}/references` routes, `has_reference` filter on `/api/conversations`, `initial_references` on `POST /api/conversations`.
5. **Citation write-through.** Modify `_emit_citation_index` to upsert references and emit `reference_added` SSE event.
6. **Prompt assembly rewrite.** `context_assembler.py` builds `<resources>` block from references + resolver. Delete memory + pinned-source loaders + per-message context items. Update tests.
7. **Backend deletes.** Singletons routes/services, pinned-sources subroutes, memory tables/services, context-item snapshot service.
8. **Frontend types + hooks.** Types refactor; delete dead hooks; add `useConversationReferences` + `useChatsByReference`.
9. **Frontend components.** Rewrite `DocChatTab`, `LibraryChatTab`, references rail in `ConversationPaneBody`. Strip singletons from global list. Drop `ChatComposer.attachedContexts`.
10. **SSE handling.** Add `reference_added` consumer. Drop `source_manifest_delta`.
11. **Test sweep.** Update or delete affected tests; add new ones for resolver, references service, citation write-through.
12. **Smoke test in browser.** Reader → cite → next-turn-sees-it. Create chat from media page → appears in list after refresh. Add reference manually → renders in prompt. Remove reference → disappears.

---

## Acceptance criteria

A reviewer should be able to verify each:

1. **`grep -r "conversation_memory_items\|conversation_pinned_sources\|chat_singletons\|message_context_items\|scope_type\|scope_media_id\|scope_library_id" python/ apps/web/`** returns zero results.
2. **`grep -r "useConversationSingleton\|useDocReferencingChats\|usePinnedSources\|PinnedSourcesTray\|ConversationSingleton\|attachedContexts" apps/web/`** returns zero results.
3. **`SELECT * FROM information_schema.tables WHERE table_name IN ('conversation_memory_items', 'conversation_memory_item_sources', 'conversation_pinned_sources', 'chat_singletons', 'message_context_items')`** returns zero rows after migration.
4. **`SELECT column_name FROM information_schema.columns WHERE table_name='conversations' AND column_name LIKE 'scope_%'`** returns zero rows.
5. Creating a new chat from a media page, sending a message, refreshing — the chat appears in the doc-chat list.
6. The model cites `[2]` in turn 1; turn 2's prompt contains a `<resource>` block for the cited span; the model can reference it without calling `app_search` again.
7. Removing a reference via the rail makes that reference vanish from the next turn's prompt.
8. `read_resource("span:VALID_UUID")` returns the body; `read_resource("span:INVALID_UUID")` returns an error block without crashing the run.
9. `read_resource("media:UUID")` returns an instruction to use `app_search` instead, no crash.
10. `app_search(query="X", scopes=["media:UUID_NOT_IN_REFS"])` errors with "scope must be in conversation references."
11. A conversation with 50 references produces a prompt with 50 `<resource>` blocks; inline bodies only for resources whose body is < 1500 chars.
12. Permission revocation (e.g., a referenced media gets deleted) results in `<resource uri="…" missing="true">…</resource>` blocks; no run crashes.
13. SSE stream during a chat run with a citation emits, in order: `meta`, `tool_call`, `retrieval_result`, `citation_index`, `reference_added`, `done`.
14. `pytest python/` passes. `pnpm test` in `apps/web/` passes.

---

## Out of scope

- LLM-generated summaries for references. Resolver uses existing metadata only.
- Reference reordering, grouping, tagging.
- Per-reference permissions or visibility flags.
- Cross-conversation reference reuse / templates.
- Background janitor to clean up dangling references.
- Reference versioning (if a source object updates, the reference still points to "now"; no snapshot semantics).
- Bulk reference import.
- Reference search / filtering UI (assume small N per conversation; just list them).
- `reader_selection:` URI scheme (selections stay inline in messages).
- Memory features of any kind. Killed deliberately.

---

## Risk register

| Risk                                                                                  | Likelihood | Mitigation                                                                                          |
| ------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| Model forgets to call `read_resource` for a pointer it should have read.              | Medium     | Good `summary` text; aggressive inline threshold so most things are visible without fetching.       |
| Prompt grows unboundedly in a long-lived conversation.                                | Low        | 80-token-per-reference ceiling; references are added selectively (only cited results).              |
| Dangling references degrade UX.                                                       | Low        | Resolver emits `missing` blocks; user can remove. No crash path.                                    |
| Cache invalidation: every new citation invalidates the `<resources>` block prefix.    | Medium     | Block lives in dynamic system blocks, NOT the stable prefix. Stable prefix cacheability preserved.  |
| `read_resource` adds round-trips, slowing complex turns.                              | Medium     | Accepted cost. Inline threshold keeps most lookups synchronous in the prompt.                       |
| Reference dedup race: two simultaneous citations of the same span.                    | Low        | `UNIQUE (conversation_id, resource_uri)` + `ON CONFLICT DO NOTHING`. Idempotent.                    |
| Single-user prototype assumption breaks under sharing.                                | Low        | Resolver enforces per-viewer permissions. Shared viewer sees `missing` for resources they can't see.|

---

## Open questions

None at spec time. All previously raised concerns resolved during the discussion:
- `kind` column → no (URI grammar handles it).
- Scope-on-conversation → no (references handle it).
- Windowing → no (pointer model handles it).
- Read tool → yes, justified.
- Memory items → kill.
- Singletons → kill.
- Backward compat → none. Hard cutover.

# Spec: Chat Search and Reader Pane Cutover

Status: Implemented
Owner: chat + reader
Date: 2026-05-25
Hard cutover. No legacy code, no fallbacks, no backward compatibility, no feature flag, no migration of existing conversations.

---

## 1. Problem statement

The chat surface conflates four orthogonal concerns inside one busy composer:

1. **Web search mode** (`off` / `auto` / `required`) — a per-message dropdown forcing the user to decide what the model is allowed to do.
2. **Conversation scope** (`general` / `media:<id>` / `library:<id>`) — a conversation-level retrieval boundary, set at creation and effectively immutable, but rendered as a removable chip in the composer.
3. **Attached quote contexts** — per-message, ephemeral.
4. **Model + reasoning + key-mode** — per-message settings.

The result is a composer with two unrelated taxonomies (scope and web-search-mode) and three separate sets of badges/pickers. Worse, scope is rendered in **two places at once**: the `ComposerContextRail` *and* the top-of-thread `ChatSurface` banner — both are the same chip wired to the same data.

The reader assistant pane is similarly muddled. It exposes a scope dropdown that, when switched, navigates the user to a *different conversation* — the dropdown reads like "change scope" but actually means "discard this chat, start one over there". With the multi-library work landed (commit `98ebfc1`), a media row can belong to several libraries, which makes "the library scope dropdown for this doc" structurally ambiguous.

Underlying this is a category error in the data model: scope is stored on `conversations.scope_type` / `scope_id` and enforced by retrieval planning, even though every modern chat surface (Claude, ChatGPT, Cursor, claude.ai web) trusts the model to invoke tools when relevant rather than asking the user to gate them.

The fix is a hard cutover that does five things simultaneously:

1. Delete web-search mode selection. `app_search` and `web_search` are both available to the model on every chat run, and the model chooses when to invoke them. No `off` / `auto` / `required`. No "Allow web search" flag.
2. Delete conversation scope as a property of conversations. No `scope_type` / `scope_id` on the row, no scope chip, no scope banner, no scope-locked retrieval.
3. Materialize two **singleton chats** per media context: the **doc chat** (one per `(user, media)`) and the **library chat** (one per `(user, library)`). These are addressable, conserved, and immutable in identity.
4. Restructure the reader pane's secondary rail into a three-tab strip — Highlights / Doc chat / Library chat — with single Lucide icons, bronze-accent glow on the active tab, and no in-composer scope indicators anywhere.
5. Inside the Doc chat tab, present a pinned-singleton + reference-list view; inside the Library chat tab, present a flat list of the libraries this doc belongs to, each item being that library's singleton.

## 2. Goals

- G1. Composer carries one set of controls: model pill, send button, and quote chips (only when present). No web-search picker, no scope chip, no key-mode badge in the composer toolbar.
- G2. The model — not the UI — decides when to call `app_search` or `web_search`. Both tools are always available on every chat run.
- G3. Conversations have no scope. The `conversations` table drops `scope_type` and `scope_id` outright.
- G4. Each user has exactly one **doc chat** per media they have access to, lazily created on first message, never deletable, never duplicable. Same for library chat per library.
- G5. The reader pane's secondary rail exposes three tabs (Highlights / Doc chat / Library chat) with icon-only triggers, tooltips, and bronze-accent glow on the active tab.
- G6. Doc chat tab content = pinned doc singleton at top + list of other chats with quote-context references to this doc + "Start new chat" affordance. Tapping any item slides into that chat within the pane; back arrow returns to the list.
- G7. Library chat tab content = flat list of libraries this doc belongs to. Each row = that library's singleton chat. Tapping a row slides into that library's chat.
- G8. The accent color (`--accent`) is the single visual signal for "active mode" on tabs and any remaining toggle-like UI.
- G9. Single icon vocabulary: `Highlighter` for highlights, `FileText` for doc chat, `Library` for library chat, reused from `CONVERSATION_SCOPE_ICONS` (lifted from a chip vocabulary to a tab vocabulary).
- G10. Chats are immutable logs. No clear-messages action exists anywhere in the surface.
- G11. Orphaned chats (whose source media or library was deleted) remain readable and findable through the global chats pane and global search, but disappear from any reader-pane tab strip.

## 3. Non-goals

- NG1. Migration of existing conversations. This is a greenfield cutover at the data layer. Existing rows in `conversations` with `scope_type != 'general'` are dropped to general scope (the column is removed; the value disappears). No backfill. No reassignment to singletons.
- NG2. Backwards compatibility of any kind. Old payload fields are deleted, not deprecated. Endpoints that accept `web_search` or `conversation_scope` reject those keys with a 422.
- NG3. "Clear messages" / "Reset chat" actions on singleton or non-singleton chats. Compaction is a separate future PR.
- NG4. Orphaned-chat ceremony beyond hiding from the reader pane. No "Source removed" banner, no archival workflow, no soft-delete. The chat persists with its messages; its references no longer resolve.
- NG5. Library-page or library-level reader surface (a future Phase 2). This spec touches only the *document* reader pane.
- NG6. Per-library "last-used" memory on the Library chat tab. The library list is unordered (or ordered by library name); the user picks each time.
- NG7. Compound or composite icons (icon + badge). One Lucide icon per tab.
- NG8. Web-search policy controls (allowed/blocked domains, freshness windows, "only if cited"). All web-search policy currently exposed on `ChatRunCreateRequest.web_search` is deleted; the model decides per its own training.
- NG9. Provider-side gating of `web_search` per user (cost, plan). Out of scope here.
- NG10. Notifications/unread indicators on tabs. The pane is read-on-demand.
- NG11. Search within the Doc chat list view. Not yet warranted; defer.
- NG12. Promotion ceremony for a "blank" reader chat. There is no "blank chat" entry point anymore — see §4.4.
- NG13. Mobile pane strip restructure. Mobile reader continues to use the existing drawer for highlights and the existing pane for the assistant; the new 3-tab strip applies on desktop secondary rail and mobile assistant pane chrome both, but no new mobile-only routes are added.

## 4. Final state — target behavior

### 4.1 Composer (`apps/web/src/components/ChatComposer.tsx`)

The composer renders, top to bottom:

1. **Error/disabled banners**, when applicable (existing behavior, unchanged).
2. **Branch reply header** (`BranchComposerHeader`), when in branch-draft mode (existing behavior, unchanged).
3. **Attached-context rail** (`ComposerContextRail`) — renders **only quote/context chips**, never a scope chip. The component's `scope` and `onClearScope` props are removed.
4. **Textarea** (existing autogrow behavior).
5. **Action row** with exactly three elements:
   - **Model settings pill** (existing, unchanged in shape: model + reasoning popover with key-mode toggle inside).
   - **Send button** (existing, unchanged).
   - No other elements.

Removed from the composer:

- Web-search-mode `<Select>` (Auto / Required / Off) and its surrounding `<label>` + icon.
- The `webSearchMode` state and its inclusion in `ChatRunCreateRequest`.
- The "Your key" badge (folded into model settings popover; no top-level badge).
- All `scope` rendering: scope chip, scope-aware classnames, `onClearScope` callback.

### 4.2 Reader secondary rail (`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`, `apps/web/src/components/secondaryRail/SecondaryRail.tsx`)

The secondary rail in the reader pane is a three-tab surface. Tab triggers are icon-only buttons in a horizontal strip at the top of the rail. Tooltips appear on hover (desktop) or long-press (mobile). The active tab's icon is rendered in `--accent` with an `--accent-muted` background pill ("bronze glow"); inactive tabs are rendered in `--fg-muted`.

| Tab id | Icon (Lucide) | Tooltip | Tab body |
|---|---|---|---|
| `highlights` | `Highlighter` | "Highlights for this document" | Existing visible-only highlights rail (unchanged content). |
| `doc-chat` | `FileText` | "Chat about this document" | List view (§4.3) into a chat detail slide-in (§4.5). |
| `library-chat` | `Library` | "Chat about this library" | List of libraries (§4.4) into a chat detail slide-in (§4.5). |

Tab order is fixed: highlights → doc-chat → library-chat. The previously-rendered `ScopeSidebar` / `ChatSurface` scope banner is deleted everywhere it appeared inside the reader pane and the conversation pane.

Tabs persist their selected mode across pane re-mount via the existing `secondaryRailMode` state. The shape of that state changes from `"highlights" | "ask"` to `"highlights" | "doc-chat" | "library-chat"`. Old persisted values are not migrated; any unrecognized value falls back to `"highlights"`.

### 4.3 Doc chat tab body

The body renders, top to bottom:

1. **Pinned singleton row.** Always present (subject to §4.7). Card-style row with:
   - Title: "Chat about this document".
   - Subtitle: count of messages in this singleton (`"12 messages"`, `"No messages yet"`).
   - Icon: `FileText`.
   - Tap → slide into chat detail (§4.5).
2. **Section header**: "Other chats".
3. **List of other chats** that reference this document (§4.6). Each row:
   - Title: first user message text, truncated.
   - Subtitle: relative date + message count.
   - Tap → slide into chat detail.
   - Empty state: no rows; section header omitted entirely.
4. **"Start new chat" button** at the bottom of the scrolling area. Tapping it opens a fresh empty chat in slide-in mode (§4.5).

The body has no scope-toggle, no scope label, no library selector, no overflow menu. There is no "clear" or "delete" affordance on any row.

### 4.4 Library chat tab body

The body renders:

1. **Section header**: "Libraries containing this document".
2. **Flat list of libraries** the doc belongs to (queried from `library_entries` via the existing `mediaLibraryMembership` source). Each row:
   - Title: library name.
   - Subtitle: count of messages in *that library's singleton chat* (`"3 messages"`, `"No messages yet"`).
   - Icon: `Library`.
   - Tap → slide into the library's singleton chat detail.
3. **Empty state**: if the doc belongs to zero libraries (it always belongs to My Library, so this is rare; only relevant if the user has deleted membership elsewhere and the only remaining library is the default — see §4.7), render: "This document isn't in any additional libraries yet."

The body has no "Start new chat" button. Library chats are always-existing singletons; the only way to create a new chat associated with a library is to attach a quote-context from a doc in that library to a chat. Such chats do not surface on this tab — they surface on the doc chat tab of the doc whose quote they referenced (§4.6).

### 4.5 Chat detail slide-in

Tapping any list item or "Start new chat" replaces the tab body content with the chat surface for that conversation. The previous list view slides out left, the chat view slides in from the right. A `< Back` button in the chat detail's header returns to the list (slide reverses). The active tab remains highlighted in the tab strip throughout. The transition uses `prefers-reduced-motion` semantics (existing tokens).

The chat detail header shows:

- `< Back` button (left).
- Chat title (center): "Chat about this document", "Chat about *<library name>*", or first user message truncated.
- `Open in full chat` button (right), per §4.10.

The chat detail body is the existing `ChatSurface` plus `ChatComposer`, rendered with the chat's conversation id. No scope chip, no scope banner.

### 4.6 Reference rule for the Doc chat tab's "Other chats" list

A conversation `C` appears in the "Other chats" list of media `M` iff:

- `C` is not the singleton doc chat for `(viewer, M)`; **and**
- At least one message in `C` has an attached `media_context` whose `media_id = M.id`.

Singletons never appear in their own "Other chats" list. A conversation may appear in multiple docs' "Other chats" lists simultaneously (one per distinct referenced doc).

The list is ordered by most-recent-message time, descending. There is no pagination; if the list grows beyond a reasonable rendered length, the rail scrolls. (Search/filter on this list is NG11.)

### 4.7 Singletons: identity, creation, deletion

- A **doc-chat singleton** is the conversation row identified by the row in `chat_singletons` matching `(user_id, kind='media', target_id=media_id)`. Lazily materialized: the singleton row is created on the *first* `POST /chat_runs` that targets this singleton, in the same transaction as the conversation creation.
- A **library-chat singleton** is identified by `(user_id, kind='library', target_id=library_id)`. Same lazy materialization.
- Singletons are never deletable through any user-facing action. They are not exposed to delete-conversation routes (see §7.5).
- When the underlying media row is deleted, the media-deletion service explicitly deletes `chat_singletons WHERE kind='media' AND target_id=<media_id>` for every user. The pointed-at `conversations.id` is **not** deleted; its messages remain; it falls off the reader pane (doc is gone) but is still listed in the global chats pane and findable via global search. No user-facing "orphaned" badge is rendered (NG4).
- Same shape for library deletion.
- Same shape for user deletion: the existing user-deletion path adds an explicit delete of `chat_singletons WHERE user_id=<user_id>`.
- The same conversation cannot be both a doc-chat singleton and a library-chat singleton. The `UNIQUE (conversation_id)` constraint enforces this at the schema layer.

### 4.8 Chat creation flows

There are exactly three ways a new conversation row is created:

1. **Doc-chat singleton materialization** — first send into a doc-chat tab's pinned row.
2. **Library-chat singleton materialization** — first send into a library-chat tab's list-item slide-in.
3. **General conversation creation** — any `POST /chat_runs` without a singleton target. This is invoked by:
   - The "Start new chat" button on the doc-chat tab.
   - The "+ New" button on the global conversations pane.
   - The quote-chat sheet (`QuoteChatSheet`, §4.9) — quoting from a reader populates `attached_contexts` and creates a general conversation on first send.
   - Other existing entry points (command palette "Ask AI", URL-driven `/conversations/new`, etc.).

No flow creates a conversation with a "scope". No flow re-uses an existing non-singleton conversation as if it were a singleton. The `POST /chat_runs` API distinguishes between singleton-targeted and general creation via an explicit request field (§7).

### 4.9 Quote attachment

Quote attachment behavior is unchanged:

- User selects text in a reader → quote-chat sheet opens (`QuoteChatSheet`) → user can either start a new chat or attach the quote to a draft in the assistant pane.
- Attachments are per-message `attached_contexts`, identical to today.
- Attaching a quote from doc M to a conversation C causes C to surface in M's "Other chats" list per §4.6, regardless of whether C is being sent from the reader pane or the global chat pane.
- The doc-chat singleton supports attached contexts too — a quote from the doc itself can be attached to a doc-chat message (redundant for retrieval, but useful as a focus signal). Quotes from *other* docs can be attached to a doc-chat message; if attached, that other doc's "Other chats" list gains this singleton conversation. (Singletons appearing in other docs' lists is acceptable; they are distinguished from non-singletons only by their pinned-row treatment in their own doc's tab.)

### 4.10 "Open in full chat" button behavior

The "Open in full chat" button in the chat detail slide-in header navigates to `/conversations/{id}` — the full chat pane for that conversation id. The full chat pane uses the same `ChatComposer` (now scopeless) and the same `ChatSurface` (now without the scope banner).

The full chat pane's URL structure is unchanged; only the rendered chrome changes (no scope banner).

### 4.11 Conversations pane (global chat list)

The conversations pane (`apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`) lists every conversation visible to the viewer. After this cutover:

- Singletons are listed alongside other conversations, ordered by most-recent-message time.
- Singletons receive an icon decoration in the row: `FileText` next to doc-chat singletons (with the media title as subtitle), `Library` next to library-chat singletons (with the library name as subtitle).
- Non-singletons render with the existing default icon.
- No section grouping by kind. Just one ordered list.
- No filter UI for "doc chats" / "library chats" / "general" is added in this cutover (defer).
- Existing global search continues to find conversations by message content, title, or attached context. No changes required.

### 4.12 Web-search and app-search execution

Every chat run gets both tools registered, unconditionally:

- `app_search` — searches the viewer's library, takes a model-supplied query and optional model-supplied scope filter (`media_id`, `library_id`). The model decides whether/when to call.
- `web_search` — searches the public web, takes a model-supplied query. The model decides whether/when to call.

There is no `WebSearchOptions`, no `web_search_mode`, no `freshness_days`, no `allowed_domains`, no `blocked_domains`. The retrieval planner's branch on web-search mode is deleted.

The model's tool definition for `app_search` permits an *optional* scope filter so the model can narrow retrieval when context warrants (e.g., the user's message mentions "the chapter I'm reading"). The reader pane communicates the currently-open doc, if any, to the chat run via a request field; this is **a hint to the model, not a backend enforcement**. The model may ignore it or override it.

## 5. Architecture

### 5.1 Singleton mapping table

```sql
CREATE TABLE chat_singletons (
    user_id          UUID NOT NULL REFERENCES users(id),
    kind             TEXT NOT NULL CHECK (kind IN ('media','library')),
    target_id        UUID NOT NULL,
    conversation_id  UUID NOT NULL UNIQUE REFERENCES conversations(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, target_id)
);
```

Per `docs/rules/database.md`, no `ON DELETE CASCADE` and no database triggers. Cleanup is explicit in application code:

- When a media row is deleted, the deletion service explicitly deletes `chat_singletons WHERE kind='media' AND target_id=<media_id>` for every user.
- When a library row is deleted, the deletion service explicitly deletes `chat_singletons WHERE kind='library' AND target_id=<library_id>` for every user.
- When a user is deleted, the existing user-deletion path deletes `chat_singletons WHERE user_id=<user_id>`.
- When a conversation that happens to be a singleton is somehow deleted (it shouldn't be — see §7.5, but defense-in-depth), the conversation-deletion path deletes the matching `chat_singletons` row first.

The polymorphic `(kind, target_id)` keeps the table tight. No FK from `(kind, target_id)` to media or libraries is declared — type discipline lives in the application layer that writes the table, and the `kind` CHECK constraint guards the closed enum.

The PK is `(user_id, kind, target_id)`. The UNIQUE on `conversation_id` is a real local alternate key (the conversation is also addressable as "the singleton for X"). No extra index is created — the PK and the UNIQUE constraint each generate their own index.

### 5.2 `conversations` table — schema changes

Remove:

- `scope_type` column
- `scope_id` column
- The `ck_conversations_scope_type` check constraint
- The two partial indexes on `(scope_type = 'media')` and `(scope_type = 'library')`

Remove the `scope` JSON projection from the `ConversationOut` schema and from all repositories that produce it.

### 5.3 `assistant_evidence_summaries` table — schema changes

`assistant_evidence_summaries.scope_type` is dropped. Evidence summaries no longer carry a "conversation scope" — they record only the actual tool invocations (`app_search`, `web_search`) with their per-call parameters. The `ck_assistant_evidence_summaries_scope_type` constraint is dropped.

### 5.4 Retrieval planner — gutted

`python/nexus/services/retrieval_planner.py`'s `_plan_web_search` function is deleted. The planner no longer makes decisions about whether to invoke `web_search`. The planner's role is reduced to:

- Building the system prompt's retrieval-context hint (e.g., "the user is currently viewing media M in library L").
- Selecting which tools to register on the run (always: `app_search`, `web_search`; possibly also `quote_search`, etc., unchanged).

The web-search-cue heuristic (the `WEB_SEARCH_CUE_WORDS` list and the ≥2-word filter) is deleted entirely.

### 5.5 `app_search` tool — scope is now a model parameter, not run config

`python/nexus/services/agent_tools/app_search.py` already accepts a `scope` parameter. After the cutover, that parameter is supplied by the model (via tool-call args), not by the backend from `conversations.scope_type`. The tool's input schema is exposed to the model as:

```json
{
  "name": "app_search",
  "parameters": {
    "type": "object",
    "properties": {
      "query":      { "type": "string" },
      "media_id":   { "type": "string", "format": "uuid", "nullable": true },
      "library_id": { "type": "string", "format": "uuid", "nullable": true },
      "types":      { "type": "array", "items": { "type": "string" } }
    },
    "required": ["query"]
  }
}
```

Internally, `media_id` + `library_id` map to the existing scope-string parameter (`"media:<id>"`, `"library:<id>"`, `"all"`) used by `parse_scope`. They are mutually exclusive at the tool boundary (specifying both → 400 from the tool, surfaced to the model as a tool error result).

### 5.6 `web_search` tool — unchanged interface, always registered

`python/nexus/services/agent_tools/web_search.py` keeps its current interface. The "always invoke when mode='required'" code path is deleted. The tool is registered on every run.

### 5.7 Chat-run request shape

`ChatRunCreateRequest` (`python/nexus/schemas/conversation.py`) loses:

- `web_search: WebSearchOptions` field (entire field deleted).
- `conversation_scope: ConversationScopeRequest` field (entire field deleted).

It gains:

- `singleton: SingletonTarget | None` field. Mutually exclusive with `conversation_id`. When present and `conversation_id` is null, the backend looks up or creates the singleton row matching `(viewer_id, singleton.kind, singleton.target_id)` and uses its `conversation_id` for this run.
- `reader_context: ReaderContextHint | None` field. Optional model-prompt hint identifying the doc/library the user is currently viewing. Not a retrieval constraint.

```python
class SingletonTarget(BaseModel):
    kind: Literal["media", "library"]
    target_id: UUID

class ReaderContextHint(BaseModel):
    media_id: UUID | None = None
    library_id: UUID | None = None
```

Singleton resolution at run time, inside a SERIALIZABLE transaction (per `docs/rules/database.md` and `docs/rules/concurrency.md`):

1. `SELECT conversation_id FROM chat_singletons WHERE (user_id, kind, target_id) = ($viewer, $kind, $target)`.
2. If a row exists, use that `conversation_id`.
3. If no row exists, INSERT a new `conversations` row, then INSERT a `chat_singletons` row pointing at it.
4. Concurrent first-send attempts under SERIALIZABLE either commit one winner or one of them fails with a serialization error that the standard retry path catches and re-executes (which then takes branch 2).

No `SELECT FOR UPDATE`, no `INSERT ... ON CONFLICT` — SERIALIZABLE handles the race.

### 5.8 Frontend type system

`apps/web/src/lib/conversations/types.ts`:

- `ConversationScope` union — deleted.
- `ConversationScopeInput` — deleted.
- `Conversation.scope` field — deleted.
- New: `Singleton = { kind: "media" | "library"; target_id: string }`.
- New: `Conversation.singleton: Singleton | null` field — present iff this conversation is a singleton.

`apps/web/src/lib/conversations/display.ts`:

- `CONVERSATION_SCOPE_ICONS` — renamed to `SINGLETON_KIND_ICONS`, keys become `"media" | "library"`. `Globe` mapping for `general` is deleted (the icon is freed up).
- `formatConversationScopeLabel` — renamed to `formatSingletonLabel`, drops the general branch. Returns `"Chat about *<media title>*"` or `"Chat about *<library name>*"`.

`apps/web/src/lib/api/sse/requests.ts`:

- `ChatRunCreateRequest.web_search` — deleted.
- `ChatRunCreateRequest.conversation_scope` — deleted.
- Adds `ChatRunCreateRequest.singleton: SingletonTargetInput | null`.
- Adds `ChatRunCreateRequest.reader_context: ReaderContextHintInput | null`.

### 5.9 Composer state

In `ChatComposer.tsx`:

- `webSearchMode` state — deleted.
- `WEB_SEARCH_MODES`, `WebSearchMode` type — deleted.
- `WEB_SEARCH_MODE_LABELS` — deleted.
- The `<Select>` for web search — deleted.
- `keyMode` rendering as a top-level badge — deleted (folded into model settings popover).

In `ComposerContextRail.tsx`:

- `scope` prop — deleted.
- `onClearScope` prop — deleted.
- The scope-chip branch — deleted. The component renders only quote-context chips, and renders nothing if there are no chips.

`ConversationScopeChip.tsx` — **deleted** as a file.

### 5.10 Reader pane secondary rail

`MediaPaneBody.tsx`'s `secondaryRailMode` state changes from `"highlights" | "ask"` to `"highlights" | "doc-chat" | "library-chat"`. The `ReaderAssistantPane` is restructured:

- Header is replaced by a back-button + title pattern, only when inside a chat detail slide-in. The tab strip itself lives one level up, in the `SecondaryRail` chrome.
- Scope dropdown is deleted.
- "Open in full chat" remains, but moves to the chat detail header (visible only inside a slide-in).
- "Close" button remains, owned by `SecondaryRail` chrome.

`SecondaryRail.tsx` gains a new prop:

```ts
type SecondaryRailTab = {
  id: "highlights" | "doc-chat" | "library-chat";
  icon: ComponentType<{ size?: number }>;
  tooltip: string;
  body: ReactNode;
};

type Props = {
  tabs: SecondaryRailTab[];
  activeTabId: SecondaryRailTab["id"];
  onActiveTabIdChange: (id: SecondaryRailTab["id"]) => void;
  // ...existing chrome props
};
```

The previous bespoke "highlights" / "ask" branching is replaced by this uniform tabs array.

### 5.11 New components

- `apps/web/src/components/chat/DocChatTab.tsx` — renders the pinned singleton row, the "Other chats" list, the "Start new chat" button, and owns slide-in routing inside the rail.
- `apps/web/src/components/chat/LibraryChatTab.tsx` — renders the libraries list and owns slide-in routing inside the rail.
- `apps/web/src/components/chat/SingletonChatRow.tsx` — shared row component for both tabs.
- `apps/web/src/components/chat/ReferencingChatRow.tsx` — list row for non-singleton chats with a reference to this doc.
- `apps/web/src/components/chat/ChatDetailSlideIn.tsx` — the slide-in chrome with the back button and "Open in full chat" affordance, wrapping `ChatSurface` + `ChatComposer`.

### 5.12 Server-side singleton resolution endpoints

```
GET  /api/chat-singletons/media/{media_id}      → { conversation_id, message_count }
GET  /api/chat-singletons/library/{library_id}  → { conversation_id, message_count }
```

Both endpoints are **read-only**: they return null `conversation_id` if no singleton exists yet (so the UI knows whether to render "No messages yet"). They do not lazily materialize. Materialization happens only on first `POST /chat_runs` with a `singleton:` field.

```
GET  /api/chat-references/media/{media_id}      → { conversations: ConversationListItem[] }
```

Returns the list of non-singleton conversations whose messages have at least one `media_context` attachment referencing this `media_id`, ordered by most-recent-message desc. Pagination uses the existing offset/limit query params (`limit=50` default, `offset=0`). The viewer's own access to each conversation is enforced by the existing `conversations_viewer_can_see` predicate.

### 5.13 Composition with other systems

| Subsystem | Interaction |
|---|---|
| **`retrieval_planner`** | Web-search planning branch deleted (§5.4). Scope-based retrieval pre-fetch deleted. `app_search` selection logic remains (tool registration). |
| **`app_search` tool** | Scope param remains, but now exclusively model-supplied (§5.5). |
| **`web_search` tool** | Always registered; `mode` parameter on the tool's own signature deleted (§5.6). |
| **`assistant_evidence_summaries`** | `scope_type` column dropped (§5.3). Evidence summary rendering (`AssistantEvidenceDisclosure.tsx`) drops the "web auto"/"web required"/"web off" badges from each row — only the actual tool call appears. |
| **`conversations.scope_type` / `scope_id`** | Columns dropped (§5.2). All read sites in `conversations.py`, `chat_run_message_blocks.py`, `chat_run_scope.py`, `object_search.py`, `context_assembler.py`, `chat_run_evidence.py`, `context_rendering.py`, `chat_run_validation.py` are updated to not read these columns. `chat_run_scope.py` is **deleted** entirely if its only purpose was scope-locked retrieval (it is). |
| **`ChatSurface` scope banner** | Deleted. `scope` prop removed from `ChatSurface`. |
| **`ConversationContextPane`** | This pane (full chat pane sidebar) currently shows a scope-derived summary. After cutover, it shows: the conversation's referenced media (one row per distinct `media_context` referenced across messages), plus the active model, plus key-mode. No scope line. |
| **Quote-chat sheet (`QuoteChatSheet`)** | Unchanged interaction. Continues to create new general-scope conversations with the quote as the first `attached_context`. Since "general" is now the only kind, no scope decision is needed. |
| **Conversations pane (`/conversations`)** | Singletons appear with icon decoration (§4.11). |
| **Conversation deletion endpoint** | Refuses to delete a singleton. `409 E_SINGLETON_UNDELETABLE`. The conversations pane's row-level delete is suppressed for singletons (the delete icon doesn't render). |
| **Conversation branching (`ForkStrip`, `ForkGraphOverview`)** | Branching off a singleton produces a *non-singleton* branch. The branch is a normal conversation. Singletons themselves cannot be branch-targets of moves (no "convert this branch into the singleton"). |
| **Command palette "Ask AI"** | Unchanged. Creates a general (non-singleton) conversation. Singletons are not addressable from the palette in this cutover. |
| **Multi-library work (commit `98ebfc1`)** | Already supported — `library_entries` is N:M. The Library chat tab's list is just `SELECT libraries.* FROM library_entries WHERE media_id = ?` joined to `libraries`, filtered by viewer access. |
| **Browser extension capture, share-to-Nexus, podcasts** | Unaffected. No ingest paths read scope. |
| **Reader profile, focus mode, theme** | Unaffected. |
| **Recent docs / Oracle recents** | Unaffected. |
| **Global chats search** | Unaffected (does not use scope columns). |

## 6. Data model

### 6.1 Migration

`migrations/alembic/versions/0114_chat_singletons_drop_scope.py`:

```python
def upgrade():
    # 1. Create chat_singletons (no CASCADE, no extra index — per database.md).
    op.create_table(
        "chat_singletons",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.PrimaryKeyConstraint("user_id", "kind", "target_id",
                                name="pk_chat_singletons"),
        sa.UniqueConstraint("conversation_id", name="uq_chat_singletons_conversation_id"),
        sa.CheckConstraint("kind IN ('media','library')", name="ck_chat_singletons_kind"),
    )

    # 2. Drop scope from conversations.
    op.drop_index("ix_conversations_scope_media", table_name="conversations")
    op.drop_index("ix_conversations_scope_library", table_name="conversations")
    op.drop_constraint("ck_conversations_scope_type", "conversations", type_="check")
    op.drop_column("conversations", "scope_id")
    op.drop_column("conversations", "scope_type")

    # 3. Drop scope from assistant_evidence_summaries.
    op.drop_constraint("ck_assistant_evidence_summaries_scope_type",
                      "assistant_evidence_summaries", type_="check")
    op.drop_column("assistant_evidence_summaries", "scope_type")


def downgrade():
    raise NotImplementedError("Hard cutover: 0114 is not reversible")
```

`downgrade()` raises explicitly. The cutover is irreversible by policy. Recovery, if needed, is from a backup taken before the migration ran.

No data backfill. No reassignment of pre-existing `scope_type='media'` conversations to singletons. They become general-scope conversations as far as the new schema is concerned (the column is gone). Their existing attached contexts continue to render in references views correctly.

### 6.2 Constraint summary

After migration:

- `chat_singletons` PK = `(user_id, kind, target_id)` — guarantees one singleton per `(user, kind, target)`.
- `chat_singletons.conversation_id UNIQUE` — guarantees one conversation can be at most one singleton.
- `chat_singletons.kind IN ('media','library')` — closed enum at the DB.
- `conversations` no longer has scope columns.
- `assistant_evidence_summaries` no longer has `scope_type`.

## 7. API contract

### 7.1 `POST /api/chat_runs`

Request body (final):

```json
{
  "conversation_id": "UUID | null",
  "singleton": {
    "kind": "media | library",
    "target_id": "UUID"
  } "| null",
  "content": "string",
  "model_id": "string",
  "reasoning": "default|none|minimal|low|medium|high|max",
  "key_mode": "...",
  "reader_context": {
    "media_id": "UUID | null",
    "library_id": "UUID | null"
  } "| null",
  "contexts": [ ... attached contexts ... ]
}
```

Validation:

- Exactly one of `conversation_id` or `singleton` must be set. Both null → 422 (no target).
- `conversation_id` and `singleton` may not both be set → 422.
- `singleton.target_id` must reference an existing media or library that the viewer can see. Otherwise → 403 `E_SINGLETON_TARGET_FORBIDDEN`.
- `reader_context.media_id` and `reader_context.library_id` may both be set (a doc in a library); both null is also valid; arbitrary mismatch (a media that isn't in that library) is **not validated** at the request layer (it's a hint).
- Request bodies that include `web_search`, `conversation_scope`, or any of their sub-fields → 422 (extra-fields-forbid Pydantic config).

Behavior:

- If `singleton` is set: resolve or create the singleton conversation, then proceed as a normal run on that conversation.
- If `conversation_id` is set: proceed as a normal run on that existing conversation.

### 7.2 `GET /api/chat-singletons/media/{media_id}`

Response:

```json
{ "conversation_id": "UUID | null", "message_count": "int" }
```

- `conversation_id` is null when no singleton exists yet. `message_count` is 0 in that case.
- 403 if the viewer can't see the media.
- 404 if the media doesn't exist.

### 7.3 `GET /api/chat-singletons/library/{library_id}`

Same shape as 7.2, for libraries.

### 7.4 `GET /api/chat-references/media/{media_id}`

Response:

```json
{
  "conversations": [
    {
      "id": "UUID",
      "title": "string | null",
      "first_user_message_excerpt": "string",
      "message_count": "int",
      "updated_at": "ISO8601",
      "is_singleton": false
    },
    ...
  ],
  "next_offset": "int | null"
}
```

- Returns conversations C where:
  - C is not the doc-chat singleton for `(viewer, media_id)`, **and**
  - some message of C has at least one `attached_context` of kind `media_context` with `media_id` = the requested `media_id`.
- Ordered by `updated_at` descending.
- Default `limit=50`, max `limit=200`. `offset` defaults to 0.
- 403 if the viewer can't see the media. 404 if the media doesn't exist.

### 7.5 `DELETE /api/conversations/{id}`

Behavior changes:

- Returns 409 `E_SINGLETON_UNDELETABLE` if the target conversation has a row in `chat_singletons`.
- All other cases unchanged.

### 7.6 `GET /api/conversations/{id}` and list responses

The response shape no longer includes `scope` / `scope_type` / `scope_id`. It includes:

```json
"singleton": { "kind": "media|library", "target_id": "UUID", "target_title": "string" } | null
```

`target_title` is the joined media title or library name, denormalized into the response for display.

### 7.7 Endpoints removed

None — every endpoint that previously read or wrote `web_search` / `conversation_scope` is updated, not removed. The fields go away; the routes stay.

### 7.8 Error codes (in `python/nexus/errors.py`)

New:

- `E_SINGLETON_TARGET_FORBIDDEN` (403)
- `E_SINGLETON_UNDELETABLE` (409)

Removed:

- All web-search-mode-related error codes that existed for invalid mode strings (the field is gone).

## 8. Service contract

| Function | File | Final signature |
|---|---|---|
| `resolve_singleton_conversation` *(new)* | `services/chat_run_singletons.py` *(new)* | `(db, viewer_id, kind: Literal["media","library"], target_id: UUID) -> UUID` — returns the conversation_id, lazily creating the singleton row. |
| `get_singleton_conversation_for_media` *(new)* | same | `(db, viewer_id, media_id: UUID) -> UUID | None` — read-only; no creation. |
| `get_singleton_conversation_for_library` *(new)* | same | `(db, viewer_id, library_id: UUID) -> UUID | None` |
| `list_referencing_conversations_for_media` *(new)* | `services/conversations.py` | `(db, viewer_id, media_id: UUID, *, limit: int, offset: int) -> list[ConversationListItemOut]` |
| `create_chat_run` | `services/chat_runs.py` | Signature drops `web_search: WebSearchOptions` and `conversation_scope: ConversationScopeRequest`; gains `singleton: SingletonTarget | None` and `reader_context: ReaderContextHint | None`. |
| `_plan_web_search` | `services/retrieval_planner.py` | **Deleted.** |
| `parse_scope` | `services/search.py` | Unchanged — still used by `app_search` tool's internal handling. |
| `*` in `services/chat_run_scope.py` | `services/chat_run_scope.py` | **File deleted.** |

All callers migrated in one PR. No alias signatures.

## 9. Frontend architecture

### 9.1 Files touched

| File | Change |
|---|---|
| `apps/web/src/components/ChatComposer.tsx` | Delete web-search `<Select>`, `webSearchMode` state, `WEB_SEARCH_MODES`, `WebSearchMode`, `WEB_SEARCH_MODE_LABELS`. Delete key-mode badge. Update `ChatRunCreateRequest` body construction: no `web_search`, no `conversation_scope`; pass `singleton` and `reader_context` from new props. |
| `apps/web/src/components/chat/ComposerContextRail.tsx` | Delete `scope` and `onClearScope` props. Render only quote/context chips. Render nothing when no chips. |
| `apps/web/src/components/chat/ConversationScopeChip.tsx` | **Delete file.** |
| `apps/web/src/components/chat/ChatSurface.tsx` | Delete the top-of-thread scope banner. Delete `scope` prop. |
| `apps/web/src/components/chat/ReaderAssistantPane.tsx` | Replace pane-level scope dropdown + "Ask" header with the simpler chat-detail chrome (`< Back`, title, "Open in full chat"). Pane no longer owns the tab strip — that moves to `SecondaryRail`. |
| `apps/web/src/components/secondaryRail/SecondaryRail.tsx` | Accept `tabs` + `activeTabId` + `onActiveTabIdChange` per §5.10. Render the icon-only tab strip with `--accent` glow. |
| `apps/web/src/components/chat/DocChatTab.tsx` | **New.** |
| `apps/web/src/components/chat/LibraryChatTab.tsx` | **New.** |
| `apps/web/src/components/chat/SingletonChatRow.tsx` | **New.** |
| `apps/web/src/components/chat/ReferencingChatRow.tsx` | **New.** |
| `apps/web/src/components/chat/ChatDetailSlideIn.tsx` | **New.** |
| `apps/web/src/lib/conversations/types.ts` | Delete `ConversationScope`, `ConversationScopeInput`, `Conversation.scope`. Add `Singleton`, `Conversation.singleton`. |
| `apps/web/src/lib/conversations/display.ts` | Rename `CONVERSATION_SCOPE_ICONS` → `SINGLETON_KIND_ICONS`; drop `general`/`Globe`. Rename `formatConversationScopeLabel` → `formatSingletonLabel`; drop general branch. |
| `apps/web/src/lib/conversations/attachedContext.ts` | Unchanged surface; verify no scope coupling. |
| `apps/web/src/lib/api/sse/requests.ts` | Drop `web_search`, `conversation_scope`. Add `singleton`, `reader_context`. |
| `apps/web/src/lib/api/sse/events.ts` | Remove `web_search_mode` field from any SSE event payloads that surfaced it. |
| `apps/web/src/components/chat/AssistantEvidenceDisclosure.tsx` | Remove the "web auto" / "web required" / "web off" mode badge per evidence row. Tool-call rows continue to render their actual tool name (`web_search`, `app_search`) and their arguments. Web-search rows render with the `Globe` Lucide icon; app-search rows render with `Search`. |
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` | Change `secondaryRailMode` state type to `"highlights" | "doc-chat" | "library-chat"`. Pass `tabs` array to `SecondaryRail`. Fetch singleton + references for the doc-chat tab; fetch library list for the library-chat tab. |
| `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx` | Remove scope-aware props passed to `ChatSurface` / `ChatComposer`. |
| `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx` | Add icon decoration for singleton conversations per §4.11. Suppress delete affordance for singletons. |
| `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx` | Remove scope-selection UI. Creating from `/conversations/new` always creates a general (non-singleton) conversation. |
| `apps/web/src/components/ConversationContextPane.tsx` | Remove scope line; render referenced-media list and active model. |
| `apps/web/src/components/chat/QuoteChatSheet.tsx` | Remove scope dropdown if any; quote-to-chat always creates a general conversation. |
| `apps/web/src/lib/conversations/useAttachedContextsFromUrl.ts` | Unchanged surface; verify no scope coupling. |

### 9.2 New hooks

`apps/web/src/lib/conversations/useDocChatSingleton.ts`:

```ts
function useDocChatSingleton(mediaId: string): {
  conversationId: string | null;
  messageCount: number;
  isLoading: boolean;
};
```

`apps/web/src/lib/conversations/useLibraryChatSingleton.ts`:

```ts
function useLibraryChatSingleton(libraryId: string): {
  conversationId: string | null;
  messageCount: number;
  isLoading: boolean;
};
```

`apps/web/src/lib/conversations/useDocReferencingChats.ts`:

```ts
function useDocReferencingChats(mediaId: string): {
  conversations: ConversationListItem[];
  nextOffset: number | null;
  isLoading: boolean;
};
```

These hooks wrap §7.2–7.4. They use the existing fetch/cache infra (TanStack Query or whatever the repo standard is — match the convention in `apps/web/src/lib/api/hooks/`).

### 9.3 Bronze-accent active-tab styling

The icon-only tab triggers use the existing `--accent`, `--accent-muted`, `--accent-hover`, `--accent-active`, and `--ring` tokens from `apps/web/src/app/globals.css`. The visual treatment:

```css
.tabTrigger {
  color: var(--fg-muted);
  background: transparent;
  border-radius: 8px;
  padding: 6px;
}
.tabTrigger[data-active="true"] {
  color: var(--accent);
  background: var(--accent-muted);
}
.tabTrigger:hover {
  color: var(--accent-hover);
}
.tabTrigger:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
```

No new color tokens are introduced.

### 9.4 Icon vocabulary

| Concept | Lucide icon | Source of truth |
|---|---|---|
| Highlights | `Highlighter` | New, in this spec. |
| Doc chat | `FileText` | Already in `SINGLETON_KIND_ICONS["media"]`. |
| Library chat | `Library` | Already in `SINGLETON_KIND_ICONS["library"]`. |
| Web-search evidence row | `Globe` | Reassigned from the deleted general-scope chip in this PR. |
| App-search evidence row | `Search` | Existing retrieval-icon convention; unchanged. |

Tooltips on each tab trigger, exactly:

- "Highlights for this document"
- "Chat about this document"
- "Chat about this library"

## 10. Capability contract

No new capability flags in `services/capabilities.py`. The feature is universal. The model determines whether to call `web_search` or `app_search`; the user has no UI affordance to gate either, and the backend has no flag that disables either.

(If a future plan-tier introduces metered web-search calls, that gating lives in the tool-execution path, not in the composer or in `ChatRunCreateRequest`.)

## 11. Rules

- Hard cutover only.
- One PR (or one stack), merged together.
- No feature flag, no `?legacy=1`, no dual-write of scope.
- No data backfill. Existing non-general-scope conversations lose their scope at migration time and are not re-keyed to singletons.
- No "Allow web search" or "Enable web search" anywhere in the UI.
- No clear-messages action.
- No singleton deletion through any user-facing path.
- No scope-mention copy in any user-visible string ("scope", "in this library", "search within this document" — all gone from user-visible strings).
- `Globe` is reassigned to the `web_search` evidence row in this PR and used nowhere else; no other repurposing.
- No second pane-mode registry beyond `secondaryRailMode`.
- No new conversation-list pagination cursors; reuse offset/limit per §7.4.
- No `?singletonHint=` URL parameters or other reflection of singleton state in URLs beyond `/conversations/{id}`.
- Tests assert user-visible behavior, not implementation wiring.
- Update `docs/` in the same PR.

## 12. Acceptance criteria

### 12.1 Composer

- A1. The composer renders no web-search selector.
- A2. The composer renders no scope chip in `ComposerContextRail` and no scope banner above the thread.
- A3. The composer's only action-row elements are model-pill and send-button.
- A4. Sending a message produces a `POST /api/chat_runs` request body containing no `web_search` and no `conversation_scope` fields.
- A5. A request body that does include either field returns 422 from the backend.

### 12.2 Singletons

- A6. `GET /api/chat-singletons/media/{id}` returns `conversation_id: null, message_count: 0` for a media with no doc-chat yet.
- A7. After the first `POST /api/chat_runs` with `singleton: {kind: "media", target_id: M}`, a `chat_singletons` row exists for `(viewer, "media", M)` and subsequent `GET` returns its `conversation_id`.
- A8. Two concurrent first-sends to the same singleton produce exactly one `chat_singletons` row (race-safe under PK contention).
- A9. `DELETE /api/conversations/{id}` returns 409 `E_SINGLETON_UNDELETABLE` for a singleton's conversation id.
- A10. Deleting the underlying media deletes the `chat_singletons` row in application code; the pointed-at `conversations` row and its messages remain intact.

### 12.3 Reader pane tabs

- A11. The secondary rail renders three icon-only tab triggers in order: Highlights / Doc chat / Library chat.
- A12. The active tab's icon is rendered in `--accent` with an `--accent-muted` background pill; inactive tabs in `--fg-muted`.
- A13. Tooltips on the three triggers are exactly "Highlights for this document", "Chat about this document", "Chat about this library".
- A14. Switching tabs does not navigate the URL or unmount the reader pane.
- A15. The Doc chat tab renders the pinned singleton row at top, followed by an "Other chats" section (when non-empty) and a "Start new chat" button at the bottom.
- A16. The Library chat tab renders one row per library the doc belongs to (filtered by viewer access). For a doc in 0 additional libraries beyond My Library, the empty state message renders.
- A17. Tapping any row slides in a chat detail view; tapping `< Back` returns to the list with the active tab unchanged.
- A18. Inside the chat detail, the `Open in full chat` button navigates to `/conversations/{id}`.

### 12.4 Reference list

- A19. A general conversation that has attached a quote from media M (anywhere in its message history) appears in M's "Other chats" list at `GET /api/chat-references/media/{M.id}`.
- A20. The doc-chat singleton for `(viewer, M)` does not appear in M's "Other chats" list.
- A21. A conversation that has attached quotes from two distinct media M1 and M2 appears in both M1's and M2's reference lists.
- A22. List ordering is by most-recent-message descending.

### 12.5 Conversations pane

- A23. Singleton conversations appear in `/conversations` with their kind icon (`FileText` for doc, `Library` for library) and target title as subtitle.
- A24. The row-level delete icon is not rendered for singleton rows.

### 12.6 Backend retrieval

- A25. Every chat run registers both `app_search` and `web_search` as available tools.
- A26. `retrieval_planner._plan_web_search` does not exist.
- A27. `services/chat_run_scope.py` does not exist.
- A28. The `app_search` tool's parameter schema accepts an optional `media_id` and `library_id`; the model can supply either to narrow retrieval.
- A29. `assistant_evidence_summaries` rows do not include `scope_type` (the column is gone).
- A29a. `AssistantEvidenceDisclosure` renders `web_search` tool-call rows with the `Globe` icon and `app_search` rows with the `Search` icon. No other component imports `Globe` from `lucide-react` after the cutover.

### 12.7 Code shape

- A30. `git grep "WebSearchMode\|WEB_SEARCH_MODES\|web_search_mode\|WEB_SEARCH_CUE_WORDS"` returns no live implementation hits in `apps/web/src` or `python/nexus/`.
- A31. `git grep "ConversationScope\|conversation_scope\|scope_type\|scope_id"` returns no live implementation hits in the same dirs (database column types from `models.py` are removed; only historical mentions in migration files or this spec remain).
- A32. `git grep "ConversationScopeChip"` returns zero matches.
- A33. The file `apps/web/src/components/chat/ConversationScopeChip.tsx` does not exist.
- A34. The file `python/nexus/services/chat_run_scope.py` does not exist.

## 13. Verification plan

### 13.1 Backend tests (`python/tests/`)

Update or add:

- `test_chat_runs.py`:
  - `test_chat_run_request_rejects_web_search_field` — request with `web_search: {...}` → 422.
  - `test_chat_run_request_rejects_conversation_scope_field` — same.
  - `test_chat_run_request_requires_conversation_id_or_singleton` — neither → 422; both → 422.
  - `test_chat_run_singleton_resolves_existing` — second send to same `(viewer, kind, target)` reuses the conversation.
  - `test_chat_run_singleton_creates_lazily` — first send creates `chat_singletons` row + new conversation in same transaction.
  - `test_chat_run_singleton_race_safety` — two concurrent first-sends produce exactly one row (use `concurrent.futures` + `pg_advisory_xact_lock`-aware fixture or rely on PK contention behavior).
  - `test_chat_run_tools_always_registered` — every run has both `app_search` and `web_search` in its tool list.
  - `test_chat_run_reader_context_passes_to_prompt` — `reader_context.media_id` shows up in the system prompt's retrieval hint, not as a hard filter.
- `test_chat_singletons_routes.py` *(new)*:
  - `test_get_singleton_media_null_when_absent`.
  - `test_get_singleton_media_returns_conversation_when_present`.
  - `test_get_singleton_library_null_when_absent`.
  - `test_get_singleton_library_returns_conversation_when_present`.
  - `test_get_singleton_forbidden_when_media_invisible`.
- `test_chat_references_routes.py` *(new)*:
  - `test_references_media_lists_referencing_general_conversation`.
  - `test_references_media_excludes_singleton`.
  - `test_references_media_orders_by_recency`.
  - `test_references_media_pagination_offset_limit`.
  - `test_references_media_forbidden_for_invisible_media`.
- `test_conversations.py`:
  - `test_conversation_delete_refuses_singleton` — 409 `E_SINGLETON_UNDELETABLE`.
  - `test_conversation_response_has_no_scope_field`.
  - `test_conversation_response_has_singleton_field_for_singletons`.
- `test_retrieval_planner.py`:
  - Delete every test asserting web-search-mode behavior.
  - Add `test_planner_does_not_branch_on_web_search` (smoke test confirming both tools are always registered).
- `test_assistant_evidence_summaries.py`:
  - Update schema-shape assertion to drop `scope_type`.
- `test_migrations.py`:
  - `test_0114_upgrade_applies_chat_singletons_and_drops_scope_columns`.
  - `test_0114_downgrade_raises` — confirms the migration is intentionally not reversible.

### 13.2 Frontend unit tests (`apps/web/src/...`)

Update or add:

- `ChatComposer.test.tsx`:
  - Remove every test asserting web-search-mode behavior.
  - Remove every test asserting scope-chip rendering.
  - Add: composer renders no web-search selector and no scope chip.
  - Add: send body has no `web_search`, no `conversation_scope`; includes `singleton` or `conversation_id` per fixture.
- `ComposerContextRail.test.tsx`:
  - Remove scope-prop tests.
  - Add: renders nothing when no contexts.
- `ChatSurface.test.tsx`:
  - Remove scope-banner tests.
- `ReaderAssistantPane.test.tsx`:
  - Replace scope-dropdown tests with: pane no longer owns the tab strip; pane renders only the chat detail when one is open.
- `DocChatTab.test.tsx` *(new)*:
  - Renders pinned singleton row + Other chats list + Start new chat.
  - Empty Other chats hides the section header.
  - Tapping a row triggers slide-in.
  - "Start new chat" creates a new general conversation on first send.
- `LibraryChatTab.test.tsx` *(new)*:
  - Renders one row per library the doc is in.
  - Empty state when doc is in zero additional libraries.
  - Tapping a row slides into that library's singleton chat.
- `SecondaryRail.test.tsx`:
  - Three tabs render with the correct Lucide icons.
  - Active tab uses `--accent` styling (assertion: `data-active="true"` attribute).
  - Switching tabs updates `activeTabId` and preserves state of inactive tabs.
- `ConversationsPaneBody.test.tsx`:
  - Singleton rows render with the kind icon + target title subtitle.
  - Delete affordance is absent for singleton rows.
- `AssistantEvidenceDisclosure.test.tsx`:
  - Web-search-mode badge no longer appears.
  - Tool-call rows still render with their tool name and args.
- `display.test.ts` (if it exists for `lib/conversations/display.ts`):
  - `SINGLETON_KIND_ICONS` exposes `media` → `FileText`, `library` → `Library`.
  - `formatSingletonLabel` returns the right title for each kind.

### 13.3 E2E tests (`e2e/`)

Update or add:

- `tests/chat-composer.spec.ts`:
  - Composer renders no web-search selector.
  - Sending a message succeeds without any scope or web-search controls.
- `tests/reader-pane-tabs.spec.ts` *(new)*:
  - Open a media pane → secondary rail shows three icon-only tabs.
  - Switching to Doc chat shows the pinned singleton row.
  - Sending a message into the doc chat persists the singleton across reload.
  - Switching to Library chat shows the library list when the doc is in multiple libraries.
- `tests/chat-singletons.spec.ts` *(new)*:
  - Trying to delete a singleton conversation from the conversations pane is impossible (no affordance).
  - Two browser tabs concurrently sending the first doc-chat message produce one persistent doc-chat conversation, not two.
- `tests/quote-attach-references.spec.ts` *(new)*:
  - Selecting text → attaching to a new chat → that chat surfaces in the doc's "Other chats" list on next visit to the reader pane.

### 13.4 Static gates

```bash
cd apps/web && bun run typecheck
cd apps/web && bun run lint
make check
make test-front-unit
make test-front-browser
make test-back
make test-e2e
```

Plus the grep gates in A30–A34.

## 14. Cutover plan

One PR (or one stack), merged together. Development order:

### Phase 1 — Migration + schema

- Write `0114_chat_singletons_drop_scope.py`.
- Apply locally; confirm `chat_singletons` exists and `conversations.scope_*` are gone.
- Update SQLAlchemy models: `Conversation` drops `scope_type` / `scope_id`; new `ChatSingleton` model; `AssistantEvidenceSummary` drops `scope_type`.

### Phase 2 — Backend service + route layer

- Add `services/chat_run_singletons.py` with `resolve_singleton_conversation`, `get_singleton_conversation_for_media`, `get_singleton_conversation_for_library`.
- Delete `services/chat_run_scope.py`.
- Update `services/retrieval_planner.py`: delete `_plan_web_search`, delete `WEB_SEARCH_CUE_WORDS`, simplify tool registration.
- Update `services/chat_runs.py::create_chat_run`: new signature; `singleton` resolution; pass `reader_context` to prompt assembly.
- Update `schemas/conversation.py`:
  - Delete `WEB_SEARCH_MODES` literal, `WebSearchOptions`, `ConversationScopeRequest`.
  - Delete `web_search_mode` from every schema that had it.
  - Add `SingletonTarget`, `ReaderContextHint`.
  - Add `Conversation.singleton` field to outputs.
- Update routes: `chat_runs.py` (new request shape), `conversations.py` (singleton field; refuse delete on singleton).
- New routes: `GET /api/chat-singletons/media/{id}`, `GET /api/chat-singletons/library/{id}`, `GET /api/chat-references/media/{id}`.
- New error codes wired in `errors.py`.
- Update `assistant_evidence_summaries` writes to not emit `scope_type`.
- Update `chat_run_message_blocks.py`, `chat_run_evidence.py`, `context_assembler.py`, `context_rendering.py`, `chat_run_validation.py`, `object_search.py`, `conversations.py` to drop scope reads.

### Phase 3 — Frontend types + composer

- Update `lib/conversations/types.ts`, `lib/conversations/display.ts`, `lib/api/sse/requests.ts`, `lib/api/sse/events.ts`.
- Update `ChatComposer.tsx`: delete web-search and scope code paths.
- Update `ComposerContextRail.tsx`: drop scope.
- Delete `ConversationScopeChip.tsx`.
- Update `ChatSurface.tsx`: drop scope banner.

### Phase 4 — Reader pane tab strip

- Update `SecondaryRail.tsx` to accept the `tabs` prop shape.
- Update `MediaPaneBody.tsx`: new `secondaryRailMode` values, build the `tabs` array.
- Add `DocChatTab.tsx`, `LibraryChatTab.tsx`, `SingletonChatRow.tsx`, `ReferencingChatRow.tsx`, `ChatDetailSlideIn.tsx`.
- Add hooks `useDocChatSingleton.ts`, `useLibraryChatSingleton.ts`, `useDocReferencingChats.ts`.
- Update `ReaderAssistantPane.tsx`: simplified header; no tab strip; no scope dropdown.
- Update `QuoteChatSheet.tsx`: drop scope.

### Phase 5 — Conversations pane + full chat pane

- Update `ConversationsPaneBody.tsx`: render singleton icon decoration; suppress delete for singletons.
- Update `ConversationPaneBody.tsx`: drop scope props to `ChatSurface` / `ChatComposer`.
- Update `ConversationNewPaneBody.tsx`: drop scope picker if any.
- Update `ConversationContextPane.tsx`: replace scope line with referenced-media list.
- Update `AssistantEvidenceDisclosure.tsx`: drop web-search-mode badges; swap evidence-row icons (`Globe` for `web_search`, `Search` for `app_search`).

### Phase 6 — Tests + docs

- Add/update tests per §13.
- Update `docs/command-palette.md` if it references scope-aware chat creation (it doesn't directly today, but verify).
- Keep this spec at `docs/chat-search-and-reader-pane.md` as the implemented reference; flip the `Status:` line to `Implemented` in the PR that ships it.

### Phase 7 — Verification

- Run all gates in §13.4.
- Manual desktop pass: full chat pane, reader pane all three tabs, quote-attach flow, singleton race smoke test (two browser windows).
- Manual mobile pass: assistant pane tabs render at narrow widths; tooltips fall back to long-press.

## 15. Key decisions

1. **Web-search is a tool, not a mode.** The user does not gate web search. The model decides per-run. Three controls (`off` / `auto` / `required`) collapse to zero controls.
2. **Scope is not a conversation property.** It moves from "row in `conversations`" to "row in `chat_singletons` (singleton)" or "attached `media_context` per message (reference)". The category was wrong; this fixes it.
3. **Singletons are conserved per `(user, target)`.** One row per pairing, lazily created, immutable in identity, never user-deletable.
4. **Lazy singleton creation on first send.** Tabs render an empty state until the user sends a message. Concurrency is handled by PK contention on `chat_singletons`.
5. **Library chat tab is a list, not a singleton.** A doc in N libraries gets N entries (each is *its* library's singleton). No "last-used" memory.
6. **Reference rule is reference-only.** "Origin" tracking is intentionally not added. A chat shows up in this doc's tab iff it attached a quote from this doc. New chats that don't attach a quote are visible only globally.
7. **Three tabs, single-icon, bronze glow.** No composite icons. No labels under icons. Tooltips on hover/long-press.
8. **Hard cutover, no migration.** Existing non-general conversations lose their scope at the schema-drop and are not reassigned to singletons. They become normal general conversations.
9. **Immutable chats.** No clear-messages action exists.
10. **Orphan policy is minimal.** Cascade the `chat_singletons` row on source deletion; leave the conversation; no badge, no archive, no banner.
11. **`reader_context` is a hint, not a constraint.** The backend never enforces "must search this media." The model is free to use or ignore the hint.
12. **`Globe` is reassigned to `web_search` evidence rows.** The icon previously stood for "all libraries" (general scope) and is now the visual signal for "the model went to the public web." The semantic match (web-as-globe) is stronger than the old one, and the reassignment lands in the same PR as the deletion so no orphan-icon window exists.
13. **Singleton ≠ "the only place to chat about X."** A user can always start a non-singleton chat from `/conversations/new`, attach a quote from doc X to it, and that chat will surface in doc X's "Other chats" list — equal-class with everything except the pinned singleton row.

## 16. Risks

| Risk | Mitigation |
|---|---|
| R1. Singleton race under concurrent first-send produces duplicate conversations. | SERIALIZABLE transaction in `resolve_singleton_conversation` with explicit SELECT-then-INSERT; concurrent attempts hit PK contention and one transaction retries (taking the SELECT branch). E2E concurrency test (§13.3 `chat-singletons.spec.ts`). |
| R2. Existing users' non-general conversations lose their scope. | Accepted by hard-cutover policy. Conversations remain readable; only the badge/banner disappears. Documented in this spec. |
| R3. Model fails to invoke `app_search` when it should because no scope hint is forced. | `reader_context` hint in the system prompt nudges the model; broader observability via evidence summaries; if pathological, tighten the prompt — but the policy is "trust the model" by design. |
| R4. Library chat tab clutter for docs in many libraries. | Accept up to ~20 rows uncluttered; defer search/filter (NG11). |
| R5. Users miss the "force web search" control. | Accept. Their phrasing reliably triggers `web_search` in current models. If a real ergonomic gap appears, the right answer is improving the prompt or the tool description, not adding a UI toggle back. |
| R6. Singleton non-deletability surprises users who want to "start over." | Accept; future compaction PR will give them a way to prune history. The singleton's identity is what's conserved; its content can be summarized down later. |
| R7. `Globe` reassignment to `web_search` evidence rows could clash with future "all libraries" affordances. | Acceptable — the spec explicitly claims `Globe` for web. Future "all libraries" affordances must pick a different icon (`LibraryBig` or `Boxes` are the obvious candidates). Reviewed at code-review time. |
| R8. SSE event payload churn breaks live dashboards / replays. | All SSE schemas updated in lockstep; backfill of historical event rows is **not** performed (hard cutover; old replay would render with absent fields). |
| R9. `assistant_evidence_summaries` history rows for `scope_type` are dropped on migration. | Column drop is destructive. No backfill; replays of pre-cutover runs will show no scope, which is the new correct shape anyway. |
| R10. Existing E2E specs that assert scope-chip presence will break. | Removed and replaced in §13.3 as part of this PR — no parallel-suite period. |

## 17. Definition of done

- Implementation matches the final state in §4–5 and the API in §7.
- All A1–A34 acceptance criteria pass.
- All test suites in §13 pass.
- All grep gates in A30–A34 pass.
- `docs/chat-search-and-reader-pane.md` (this file) status is updated to `Implemented`.
- No stale references to `WebSearchMode`, `web_search_mode`, `conversation_scope`, `scope_type`, `scope_id`, `ConversationScopeChip`, `chat_run_scope.py`, or `_plan_web_search` exist in code, tests, or docs (other than this spec describing their removal).
- The composer in production renders model-pill + send + (optional) quote chips, and nothing else.
- The reader pane in production shows three icon-only tabs with bronze glow on the active tab.
- The doc-chat singleton conversation for any user-visible media is reachable in at most three taps (tab → row → message).

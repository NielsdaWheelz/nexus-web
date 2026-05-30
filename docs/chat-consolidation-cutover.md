# Chat consolidation — hard cutover spec

Status: approved — ready to implement · Owner: chat/conversations · Type: hard cutover (no legacy, no fallbacks, no back-compat)

One live-chat engine, one transcript view that owns its scroll, one composer assembled from
focused units, and one fork panel assembled from focused units. The three duplicated live-chat
surfaces (`ConversationPaneBody`, `ConversationNewPaneBody`, `ReaderChatDetail`) collapse onto a
single `useConversation` engine + `ChatSurface` view. Scroll becomes ChatGPT-style
**pin-the-question-near-the-top**, owned in exactly one place. The two god-files
(`ChatComposer` 651 lines, `ConversationForksPanel` 712 lines) are decomposed into pure utilities,
hooks, and presentational components. No surface keeps a private copy of lifecycle, scroll, send,
or tree logic.

---

## 1. Context & problem

Chat works, but the live-chat behaviour is **triplicated and divergent**, and two files have grown
into god-files. Concrete evidence:

**Three live-chat surfaces re-implement the same lifecycle by copy-paste, and disagree.**

| Capability | `ConversationPaneBody` (846L) | `ConversationNewPaneBody` (232L) | `ReaderChatDetail` (282L) |
|---|:---:|:---:|:---:|
| seed `useChatRunTail` + optimistic messages | ✅ | ✅ | ✅ |
| resolve/create conversation on send | implicit (id from route) | ✅ POST `/conversations` | ✅ POST `/conversations` + media refs |
| load history | `/tree` (`:375`) | — | `/messages` linear (`:117`) |
| load-older + scroll restore | ✅ (`:464`,`:437`) | — | partial (`:139`, no restore) |
| **scroll-to-bottom on new message** | ✅ `useLayoutEffect([messages])` (`:428`) | ✅ (`:119`) | ❌ **absent** |
| **release auto-scroll on manual scroll-up** | ✅ `handleChatScroll` (`:450`) | ✅ (`:161`) | ❌ **never wired** |
| branch/forks (state, graph, switch, restore) | ✅ | — | — |
| references sidecar | ✅ | ✅ (refs only) | — (creates with media ref) |

`ReaderChatDetail` declares `shouldScrollRef`/`scrollportRef` (`ReaderChatDetail.tsx:54-55`),
threads them into `ChatSurface`/`useChatRunTail`, **but has no `useLayoutEffect` that ever writes
`scrollTop` and never passes `onScroll`** — both refs are vestigial, so the reader doc-chat does not
auto-scroll at all. That single dropped copy is the whole argument for one owner.

**Scroll is consumer-owned, not view-owned.** `ChatSurface` owns the scrollport DOM
(`ChatSurface.tsx:110-117`) but mirrors `scrollportRef` out (`:52-61`) and delegates all scroll
intelligence to each parent. Symptoms: the `handleComposerWheel` hack manually re-drives
`scrollport.scrollTop` (`ChatSurface.tsx:76-106`) because the composer sits outside the scrollport;
auto-scroll keys on `useLayoutEffect([messages])`, which fires only on message-array identity change
and desyncs on any height change not tied to it (markdown image load, tool-activity reveal, fork
strip). There is no "jump to latest" affordance and no `overflow-anchor` management.

**Two god-files mix many concerns.**
- `ChatComposer.tsx` (651L): props, a draft-persistence map keyed by branch/path
  (`:190-226`), module-level model cache + load + filter + auto-select (`:91-273`), a send/idempotency
  state machine (`:292-394`), branch-anchor body building (`:336-362`), the auto-grow textarea, and a
  mobile/desktop model-settings popover (`:542-647`).
- `ConversationForksPanel.tsx` (712L): pure tree utilities (`buildForkTree`/`filterNodes`/
  `flattenVisibleRows`/`collectExpandableIds`/`updateNode`/`removeNode`, `:594-711`), a keyboard-nav
  model (`:180-264`), rename/delete API flows (`:103-151`), a tree/graph view toggle, and a 226-line
  recursive `ForkNodeRow` (`:366-592`).

**The streaming spine is already good and is out of scope.** `useChatRunTail.ts` (SSE, reconnect,
replay-skip) and `useChatMessageUpdates.ts` (RAF-batched delta flush) are shared by all three
surfaces and are correct. The mess is entirely in the **container, scroll, and god-file** layers.

---

## 2. Goals

1. **One live-chat engine** — `useConversation()` owns messages, history load, send/resolve,
   optimistic seeding, retry, branch state, and reference fan-out. The three surfaces stop owning any
   of it.
2. **One transcript view that owns its scroll** — `ChatSurface` is the single owner of scroll.
   `shouldScrollRef`, the three `useLayoutEffect([messages])` copies, the `handleChatScroll` copies,
   the `handleComposerWheel` hack, and `branchScroll.ts` as a standalone all disappear into it.
3. **Pin-the-question-near-the-top** — on send, the user's message animates to the top of the
   scrollport and the answer streams beneath it; the question stays put (no bottom-chasing), with a
   reserved spacer so a short turn can still place the question at the top.
4. **Collapse three surfaces into one** — delete `ConversationNewPaneBody` (it is the conversation
   route with `conversationId={null}`); reduce `ReaderChatDetail` to a thin header + view bound to the
   same engine. One load path (`/tree`), one resolve path, one scroll owner.
5. **Decompose `ChatComposer`** into a pure body builder + `useChatDraft` + `useChatModels` +
   `ModelSettingsPopover` + `PendingReferencesBar`, leaving a thin orchestrator.
6. **Decompose `ConversationForksPanel`** into `lib/conversations/forkTree.ts` (pure) + `useForkPanel`
   + `useForkTreeKeyNav` + `ForkTreeView` + `ForkNodeRow`, leaving a thin orchestrator.
7. **Reuse, don't reinvent** — `useChatRunTail`/`useChatMessageUpdates` (untouched), `branching.ts`,
   `useConversationReferences`, `useStringIdSet`, `apiFetch`, `toFeedback`/`FeedbackNotice`,
   `Button`/`Textarea(autoGrow)`/`Select`/`ActionMenu`/`MarkdownMessage`, and the pane runtime hooks.
8. **Token-driven CSS, one module per component**; no behavioural change to SSE, the references data
   model, or fork endpoints.

---

## 3. Non-goals

- **No change to the streaming transport.** `useChatRunTail.ts`, `useChatMessageUpdates.ts`, and the
  SSE client/parser (`lib/api/sse/*`) are not touched except for the `shouldScrollRef` parameter
  removal (§6.2). Delta batching, reconnect, replay-skip stay byte-for-byte.
- **No backend / endpoint / schema change.** `/chat-runs`, `/conversations`, `/tree`, `/messages`
  (the linear endpoint is simply no longer called from the client; leaving the route is fine),
  `/references`, `/forks`, `/active-path`, `/models` are unchanged.
- **No change to the references data model or its sidecar rendering.** `ConversationReferencesSidecar`
  row markup is owned by `docs/item-card-cutover.md` (resource `ItemCard` variant). This cutover keeps
  consuming `useConversationReferences` and rendering whatever that component renders; it does not
  build `ItemCard`/`Disclosure`.
- **No new fork features** (no reorder, no multi-select, no new graph layout). Decomposition is
  behaviour-preserving.
- **No new model/provider/reasoning features.** `useChatModels` preserves current selection, filtering,
  and auto-select semantics exactly.
- **No stick-to-bottom mode.** Pin-the-question is the one scroll model; we do not also ship a legacy
  bottom-follow toggle.
- **`ChatComposer` model-picker product redesign** is out of scope; it is split, not redesigned.

---

## 4. Target behaviour (UX)

### 4.1 Pin-the-question-near-the-top (the headline)

```
   ┌───────────────────────────── scrollport ─────────────────────────────┐
   │  ▸ (top inset = transcript padding)                                   │
   │  ┌─────────────────────────────────────────────────────────────────┐ │  ← the user's message
   │  │  You:  How does the retrieval pipeline pick chunks?              │ │     pinned just under the
   │  └─────────────────────────────────────────────────────────────────┘ │     top inset on send
   │  ┌─────────────────────────────────────────────────────────────────┐ │
   │  │  Assistant:  The pipeline first… ▍                               │ │  ← answer streams downward
   │  │  …(grows into the reserved space below as tokens arrive)         │ │     into reserved space
   │  └─────────────────────────────────────────────────────────────────┘ │
   │                                                                       │
   │            (reserved spacer — collapses to 0 as the answer grows)     │
   │                                                          [ ↓ Latest ] │  ← appears only when the
   └───────────────────────────────────────────────────────────────────────┘     newest content is
        [ composer dock — outside the scrollport, fixed height ]                   below the fold
```

- **On send:** the new user message is the *anchor*. After the optimistic user+assistant pair is
  inserted, the transcript smooth-scrolls so the anchor's top sits at the top inset
  (`scrollTop = anchor.offsetTop − topInset`).
- **A reserved spacer** is rendered after the last turn so the anchor can reach the top even when the
  turn is short: `spacer = max(0, scrollport.clientHeight − topInset − contentBelowAnchorTop)`.
- **During streaming:** the answer grows *below* the fixed anchor; `scrollTop` is **not** rewritten,
  so the question stays pinned at the top. As the answer grows, `contentBelowAnchorTop` increases and
  the spacer shrinks to 0; once the turn exceeds the viewport, the answer simply continues below the
  fold (no auto-chase to bottom — the user reads top-to-bottom, like ChatGPT/Claude).
- **Manual scroll** releases the pin: once the user scrolls, the engine does not re-pin until the next
  send. A **"↓ Latest"** affordance appears when the newest message bottom is below the fold and
  re-pins-to-latest on click (jumps to the newest user turn, or to the bottom if the assistant turn is
  taller than the viewport).
- **Load older / branch switch:** position is preserved around a stable anchor message
  (offset-from-top capture/restore), never jumping to bottom.
- **First load of an existing conversation:** opens at the bottom (latest turn visible), no animation.
- **Empty/new conversation:** empty state centered; first send begins the pin cycle.

### 4.2 Surfaces (unchanged externally)

- **Conversation pane** (`/conversations/[id]` and `/conversations/new`): full transcript, composer,
  branching (fork strips inline + forks sidecar), references sidecar, pane title/options. `new` is the
  same surface with no id yet.
- **Reader doc-chat** (inside the media pane's `reader-doc-chat` sidecar surface): same transcript +
  composer + pin-scroll, plus a compact header (back, title, "Open in full chat"); no sub-sidecars, no
  forks chrome; creates the conversation with the document reference on first send.

---

## 5. Architecture & final state

The split is **engine hook (state/effects) + presentational view (DOM/scroll) + thin mount adapters
(chrome)**. The adapters are thin because everything stateful lives in the engine and everything
scroll-related lives in the view.

```
                         components/chat/useChatRunTail.ts   ← UNTOUCHED (SSE stream)
                         components/chat/useChatMessageUpdates.ts ← UNTOUCHED (RAF delta flush)
                                         ▲
                         components/chat/useConversation.ts   ← THE ENGINE (one owner of lifecycle)
                         · messages, history(/tree), olderCursor, loadOlder
                         · resolveConversation(initialReferences) on send
                         · optimistic seed, retry, abort
                         · branch state (forkOptionsByParentId, branchGraph, switchToLeaf)
                         · reference fan-out (onReferenceAdded → useConversationReferences)
                                         ▲
        ┌────────────────────────────────┴───────────────────────────────────┐
        │                                                                      │
  components/chat/Conversation.tsx                      components/chat/ReaderChatDetail.tsx
  (PANE BODY — /conversations/[id] & /new)              (EMBEDDED in reader sidecar)
  · useConversation({ id })                             · useConversation({ id:null|id,
  · useSetPaneTitle / usePaneChromeOverride               initialReferences:[`media:${id}`],
  · usePaneSidecar(conversation-context:                   readerContext })
      references + forks)                                · renders its own <header> (back / open-full)
  · branching chrome ON                                 · NO pane-chrome hooks (it is inside a sidecar)
        │                                                      │
        └───────────────────────┬──────────────────────────────┘
                                 ▼
                  components/chat/ChatSurface.tsx   ← THE VIEW (one owner of scroll)
                  · renders transcript (MessageRow[]) + composer slot + spacer
                  · uses useChatScroll() internally; exposes ChatScrollHandle via ref
                  · pin-question, release-on-scroll, ↓Latest, preserveAround()
                                 ▼
                  components/chat/ChatComposer.tsx  ← THIN ORCHESTRATOR
                  · buildChatRunBody() (pure)   · useChatDraft()   · useChatModels()
                  · <ModelSettingsPopover/>     · <PendingReferencesBar/>  · <BranchComposerHeader/>
```

Why **two adapters, not one component with a flag:** the pane-chrome hooks (`usePaneSidecar`,
`useSetPaneTitle`, `usePaneChromeOverride`) write to the **nearest** pane context. `ReaderChatDetail`
renders *inside the reader pane's `reader-doc-chat` sidecar body*, so if it called those hooks it would
clobber the reader pane's own publications. React also forbids conditionally calling hooks. Therefore
the shared core is the **hook + view**, and the two adapters differ only by which chrome hooks they
call. `ConversationNewPaneBody` is deleted outright (it is `Conversation` with `conversationId={null}`).

Fork panel and composer final shape:

```
ConversationForksPanel.tsx (~140L orchestrator)
 ├── lib/conversations/forkTree.ts      (pure: types + buildForkTree/filterNodes/flattenVisibleRows/
 │                                        collectExpandableIds/updateNode/removeNode)
 ├── useForkPanel.ts                     (search load + rename/delete mutations + editing/pending state)
 ├── useForkTreeKeyNav.ts               (arrow/Home/End/→/←/Enter/F2/Delete/Escape model)
 ├── ForkTreeView.tsx                    (tree container)
 │    └── ForkNodeRow.tsx                (recursive row)
 └── ForkGraphOverview.tsx              (UNCHANGED)

ChatComposer.tsx (~150L orchestrator)
 ├── lib/conversations/chatRunBody.ts    (pure buildChatRunBody → ChatRunCreateRequest)
 ├── useChatDraft.ts                     (draftsByKey map, activeDraftKey, save/restore/clear)
 ├── useChatModels.ts                    (load+cache+filter+select; provider/model/reasoning options)
 ├── ModelSettingsPopover.tsx            (provider/model/reasoning/keys; desktop popover + mobile sheet)
 ├── PendingReferencesBar.tsx            (pending-reference chips)
 └── BranchComposerHeader.tsx           (UNCHANGED)
```

---

## 6. Capability contract & API design

### 6.1 `components/chat/useConversation.ts` — the engine

```ts
export interface UseConversationOptions {
  /** Existing conversation id, or null to create on first send. */
  conversationId: string | null;
  /** URIs attached to the conversation when it is created on first send (e.g. ["media:<id>"]). */
  initialReferences?: string[];
  /** Reader context hint forwarded to the composer/run (media/library); not a retrieval constraint. */
  readerContext?: ReaderContextHintInput | null;
  /** Enable branch state + active-path persistence. Pane: true. Reader embed: false. */
  branching?: boolean;
  /** Fired when a `reference_added` SSE event lands for this conversation (pane upserts the sidecar). */
  onReferenceAdded?: (data: SSEReferenceAddedEvent["data"]) => void;
  /** Fired the first time a run resolves a concrete conversation id (new-chat navigation). */
  onConversationCreated?: (conversationId: string, runId: string) => void;
}

export interface UseConversation {
  // transcript
  messages: ConversationMessage[];
  olderCursor: string | null;
  loadOlder: () => Promise<void>;
  loading: boolean;
  error: FeedbackContent | null;

  // identity
  conversationId: string | null;            // resolves from null → real id after first send
  title: string;

  // send pipeline (passed straight into <ChatComposer/>)
  resolveConversation: () => Promise<string>; // creates with initialReferences, or attaches them
  onChatRunCreated: (data: ChatRunResponse["data"]) => void;

  // retry
  retryingAssistantMessageIds: StringIdSet;
  retryAssistantResponse: (assistantMessageId: string) => Promise<void>;

  // branching (present only when options.branching === true; otherwise undefined)
  branch?: {
    forkOptionsByParentId: Record<string, ForkOption[]>;
    branchGraph: BranchGraph;
    switchableLeafIds: Set<string>;
    activeLeafMessageId: string | null;
    selectedPathMessageIds: Set<string>;
    branchDraft: BranchDraft | null;
    setBranchDraft: (draft: BranchDraft | null) => void;
    switchToLeaf: (leafMessageId: string, anchorMessageId: string | null) => Promise<void>;
    switchToFork: (fork: ForkOption) => Promise<void>;
    reload: () => Promise<void>;
  };

  // scroll handle wiring (engine → view): the adapter passes this ref to <ChatSurface/>
  scrollRef: RefObject<ChatScrollHandle | null>;
}

export function useConversation(options: UseConversationOptions): UseConversation;
```

Engine internals (consolidated from the three surfaces):
- **History load** always uses `GET /conversations/{id}/tree` (selected path + `fork_options_by_parent_id`
  + `branch_graph` + `next_cursor`). The reader's linear `/messages` load path is deleted. When
  `branching` is false the fork data is ignored (not rendered).
- **`resolveConversation`** = the merged logic of `ConversationNewPaneBody:171` and
  `ReaderChatDetail:159`: if an id exists, POST each `initialReferences` URI to `/references`; else POST
  `/conversations` with `{ initial_references }`, mark it locally-created (skip the history fetch), and
  set the id.
- **Optimistic seed + run tail** via `useChatRunTail({ setMessages, setForkOptionsByParentId?,
  shouldApplyRun?, onReferenceAdded?, onConversationAvailable })` — same options the pane passes today
  (`ConversationPaneBody:229`), with branching options omitted when `branching` is false.
- **`switchToLeaf`** keeps the active-path POST and path cache (`branching.ts` helpers
  `selectedPathAfterRun`/`activeForkOptionsForPath`/`activeBranchGraphForPath` reused as-is), and calls
  `scrollRef.current?.preserveAround(anchorMessageId)` before swapping messages (replacing the bespoke
  `pendingBranchScrollRef` dance at `ConversationPaneBody:431`).

### 6.2 `components/chat/ChatSurface.tsx` + `useChatScroll.ts` — the scroll owner

`ChatSurface` keeps its presentational shape (scrollport → transcript → composer slot) but **owns
scroll**. It no longer accepts `scrollportRef`/`onScroll`; instead it forwards a `ref` exposing:

```ts
export interface ChatScrollHandle {
  /** Pin a specific message to the top inset (smooth). Called by the view on a new user turn. */
  pinToTop: (messageId: string) => void;
  /** Jump to the newest content (the ↓ Latest action). */
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  /** Capture offset of a stable anchor, run `mutate`, then restore it (load-older / branch switch). */
  preserveAround: (anchorMessageId: string | null) => void;
  /** True when the newest message bottom is below the fold (drives the ↓ Latest affordance). */
  readonly isLatestBelowFold: boolean;
}

export interface ChatSurfaceProps {
  messages: ConversationMessage[];
  composer: ReactNode;
  olderCursor?: string | null;
  onLoadOlder?: () => void;
  emptyState?: ReactNode;
  // branching-aware transcript props (unchanged, optional):
  forkOptionsByParentId?: Record<string, ForkOption[]>;
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onRetryAssistantResponse?: (assistantMessageId: string) => void;
  retryingAssistantMessageIds?: Set<string>;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}
```

`useChatScroll(scrollportRef, transcriptRef)` implements the §4.1 algorithm and is the **single** place
any of this lives:
- Detects a new trailing **user** message (compare last user message id across renders) → records it as
  the anchor and `pinToTop(anchorId)` on the next layout (smooth).
- Renders a measured **spacer** element (last child of the transcript) with
  `height = max(0, clientHeight − topInset − contentBelowAnchorTop)`; recomputed via a single
  `ResizeObserver` on the scrollport + transcript (the reuse-able observer pattern already used at
  `ReaderOverviewRuler.tsx:67` / `AnchoredHighlightsSidecar.tsx:296`).
- Tracks a `pinned` flag; any user-initiated scroll (wheel/touch/keyboard) clears it and the engine does
  not re-pin until the next send. Programmatic scrolls are flagged so they don't clear `pinned`.
- Computes `isLatestBelowFold` for the **↓ Latest** button (replaces the old 48px near-bottom check).
- `topInset` reads the transcript's top padding; `overflow-anchor: none` is set on the transcript to
  stop native scroll-anchoring fights.
- `preserveAround` absorbs `branchScroll.ts` (`captureBranchScroll`/`restoreBranchScroll`,
  `[data-message-id]` offset math) and the load-older `scrollHeight` restore. `branchScroll.ts` is
  deleted; its tested behaviour moves into `useChatScroll`.

The `handleComposerWheel` hack is deleted; with one scroll owner and the composer fixed below the
scrollport, wheel events over the composer no longer need manual redirection (the composer is a fixed
dock; the transcript is the only scroll region and receives wheel events directly).

### 6.3 `useChatRunTail` parameter change (only edit to the spine)

`useChatRunTail` currently takes `shouldScrollRef` purely so callers could gate their own
`useLayoutEffect`. Scroll now lives in the view, so **`shouldScrollRef` is removed from
`UseChatRunTailOptions`** and from `useChatMessageUpdates`. No other behaviour changes. (This is the
single allowed edit to the streaming files; it is a deletion.)

### 6.4 `components/chat/Conversation.tsx` — pane-body adapter (replaces both pane bodies)

```ts
export default function Conversation({ conversationId }: { conversationId: string | null }) {
  const convo = useConversation({ conversationId, branching: true, onReferenceAdded, onConversationCreated });
  useSetPaneTitle(convo.conversationId ? `Chat: ${convo.title}` : "New chat");
  usePaneChromeOverride({ options: paneOptions });            // references / forks / delete / open-resource
  usePaneSidecar(conversationContextSidecar(/* references + (branch ? forks) */));
  return <ChatSurface ref={convo.scrollRef} messages={convo.messages} composer={<ChatComposer …/>} … />;
}
```

- Used by **both** `conversations/[id]/page` and `conversations/new/page` (the latter passes `null`).
- Branching chrome (forks sidecar, fork strips, reply-to-assistant) is wired from `convo.branch`.
- References sidecar uses `useConversationReferences(convo.conversationId)` exactly as today; rendered by
  `ConversationReferencesSidecar` (owned by the item-card cutover).

### 6.5 `components/chat/ReaderChatDetail.tsx` — embedded adapter (slimmed)

```ts
export default function ReaderChatDetail({ conversationId, mediaId, pendingQuoteUri, onBack, onOpenFullChat, onReaderSourceActivate }) {
  const convo = useConversation({
    conversationId,
    initialReferences: [`media:${mediaId}`, ...(pendingQuoteUri ? [pendingQuoteUri] : [])],
    readerContext: { media_id: mediaId, library_id: null },
    branching: false,
  });
  return (
    <section className={styles.pane}>
      <header className={styles.header}>{/* back · title · open-in-full-chat */}</header>
      <ChatSurface ref={convo.scrollRef} messages={convo.messages} composer={<ChatComposer …/>} … />
    </section>
  );
}
```

- No pane-chrome hooks (it lives inside the reader pane's sidecar). Pending-quote chips are passed to the
  composer via `pendingReferences` (engine still owns commit on `resolveConversation`).
- "Open in full chat" calls the existing `onOpenFullChat(convo.conversationId)` callback supplied by
  `MediaPaneBody`.

### 6.6 `ChatComposer` decomposition

```ts
// lib/conversations/chatRunBody.ts — pure, no React
export function buildChatRunBody(input: {
  conversationId: string; content: string; modelId: string;
  reasoning: ReasoningMode; onlyUseMyKeys: boolean;
  branchDraft: BranchDraft | null; parentMessageId: string | null;
  readerContext: ReaderContextHintInput | null;
}): ChatRunCreateRequest;                                   // moves :336-362

// components/chat/useChatDraft.ts
export function useChatDraft(input: {
  draftKey?: string; branchDraft?: BranchDraft | null;
  parentMessageId?: string | null; conversationId?: string | null; initialContent?: string;
}): { content: string; setContent: (v: string) => void; activeDraftKey: string; clearDraft: () => void };
                                                            // moves :190-226

// components/chat/useChatModels.ts
export function useChatModels(input: { onlyUseMyKeys: boolean }): {
  availableModels: ComposerModel[]; selectedModel: ComposerModel | undefined;
  selectedProvider: string; selectedModelId: string; selectedReasoning: ReasoningMode;
  providerOptions: string[]; reasoningOptions: ReasoningMode[]; modelSummary: string;
  setProvider: (p: string) => void; setModel: (id: string) => void; setReasoning: (m: ReasoningMode) => void;
};                                                          // moves :91-273, :396-427 (module cache stays module-level)

// components/chat/ModelSettingsPopover.tsx  — desktop popover + mobile sheet (moves :542-647 + dismiss/lock :275-286)
// components/chat/PendingReferencesBar.tsx   — chips (moves :466-485)
```

`ChatComposer` becomes a thin orchestrator: `useChatDraft` + `useChatModels` + a small send state
machine that calls `buildChatRunBody` then `apiFetch("/api/chat-runs", { Idempotency-Key })`, renders
`BranchComposerHeader` / `PendingReferencesBar` / `Textarea(autoGrow)` / `ModelSettingsPopover`. The
public `ChatComposerProps` (`:38-74`) is unchanged so adapters wire it identically.

### 6.7 `ConversationForksPanel` decomposition

```ts
// lib/conversations/forkTree.ts — pure
export type ConversationForkNode = ForkOption & { children: ConversationForkNode[] };
export type VisibleForkRow = { node: ConversationForkNode; depth: number; parentId: string | null };
export function buildForkTree(forks: ForkOption[]): ConversationForkNode[];
export function filterNodes(nodes: ConversationForkNode[], query: string): ConversationForkNode[];
export function flattenVisibleRows(nodes: ConversationForkNode[], expandedIds: Set<string>): VisibleForkRow[];
export function collectExpandableIds(nodes: ConversationForkNode[]): string[];
export function updateNode(nodes, id, patch: { title: string | null }): ConversationForkNode[];
export function removeNode(nodes, id: string): ConversationForkNode[];
                                                            // moves :594-711

// components/chat/useForkPanel.ts   — search load (:73-101), rename (:103-115), delete (:117-151), editing/pending state
// components/chat/useForkTreeKeyNav.ts — keyboard model (:172-264) → { handleTreeKeyDown, focusRow }
// components/chat/ForkTreeView.tsx   — tree container (:327-361)
// components/chat/ForkNodeRow.tsx    — recursive row (:366-592)
```

`ConversationForksPanel` keeps its props (`:26-46`) and becomes a ~140-line orchestrator composing the
above + the existing `ForkGraphOverview` for the graph tab.

---

## 7. How it composes with other systems

- **Pane runtime** (`lib/panes/paneRuntime.tsx`): the pane adapter uses `useSetPaneTitle(title)`,
  `usePaneChromeOverride({ options })`, `usePaneRouter()` (`push`/`replace` for new-chat navigation),
  and `usePaneRuntime()?.openInNewPane(href, hint, surfaceId)` for opening cited resources. The reader
  adapter uses **none** of these (it is inside a sidecar body).
- **Sidecars** (`lib/panes/paneSidecarModel.ts`): the pane adapter publishes
  `groupId: "conversation-context"` with surfaces `"conversation-references"` (always) and
  `"conversation-forks"` (when `branch` present), via
  `usePaneSidecar({ groupId, defaultSurfaceId: "conversation-references", surfaces })`
  (`PaneSidecar.tsx:20`). The reader doc-chat continues to be the body of the media pane's
  `"reader-doc-chat"` surface under `"reader-tools"` — i.e. `ReaderChatDetail` is the `body` passed by
  `MediaPaneBody`'s `usePaneSidecar`. Mobile uses the same surfaces via `MobileSidecarHost`
  (`activeSurface.mobileBody ?? body`).
- **References** (`conversation-references-cutover.md`): unchanged. The engine forwards `reference_added`
  SSE events to `onReferenceAdded`; the pane adapter `upsert`s into `useConversationReferences`. The
  sidecar list rendering belongs to `item-card-cutover.md`.
- **Streaming** (`useChatRunTail`/`useChatMessageUpdates`): unchanged except the `shouldScrollRef`
  deletion (§6.3). The engine is the sole caller.
- **Reader source activation:** both adapters pass `onReaderSourceActivate` down to `ChatSurface →
  MessageRow` so citation clicks open the cited span/page (pane: `openInNewPane`; reader: the callback
  `MediaPaneBody` supplies).
- **Mobile chrome controller** (`PaneShell.usePaneMobileChromeController`): the conversation route is
  `bodyMode: "contained"`, so the document-scroll auto-hide does not apply; no wiring needed. The
  transcript scrollport is the only scroll region.

---

## 8. Reuse / consolidation decisions (resolved)

| Question | Decision | Why |
|---|---|---|
| Scroll model | **Pin-the-question only.** Single owner in `ChatSurface`/`useChatScroll`. | The user's target; one model, no toggles (`simplicity.md`). |
| Where scroll lives | **In the view, not the consumers.** Delete `shouldScrollRef`, 3× layout effects, 3× `handleChatScroll`, `handleComposerWheel`, `branchScroll.ts`. | One owner per concern (`cleanliness.md`). The dropped copy in `ReaderChatDetail` proves consumer-owned scroll is unmaintainable. |
| One component vs hook+view | **Hook (`useConversation`) + view (`ChatSurface`) + two thin adapters.** | Pane-chrome hooks must not run inside the reader sidecar body; React forbids conditional hooks. A single component with an `embedded` flag would clobber the reader pane's publications. |
| `ConversationNewPaneBody` | **Delete.** New chat = `Conversation` with `conversationId={null}`. | Removes a whole duplicated lifecycle copy. |
| History load path | **`/tree` everywhere; delete client use of linear `/messages`.** | One load path. Reader ignores fork data when `branching:false`. |
| Decompose god-files vs leave | **Decompose both** into pure utils + hooks + presentational units. | `cleanliness.md` god-files rule; pure tree utils + draft/model hooks are independently testable. |
| `ChatComposer` public API | **Unchanged.** Internal split only. | Adapters keep wiring it identically; no call-site churn. |
| References sidecar rendering | **Owned by `item-card-cutover.md`, not here.** | Avoid a near-duplicate of that in-flight cutover. |
| Build a generic `useResizeObserver`? | **No — inline the one observer in `useChatScroll`.** | Used once here; matches existing inline RO usage (`ReaderOverviewRuler`, `AnchoredHighlightsSidecar`). Generalize only if a third site needs it. |

---

## 9. Scope

**In scope**
- New `components/chat/useConversation.ts` (+ test).
- New `components/chat/useChatScroll.ts` (+ test) and `ChatSurface` rebuilt to own scroll (+ test update).
- New `components/chat/Conversation.tsx` (pane adapter) replacing `ConversationPaneBody` +
  `ConversationNewPaneBody`; route pages render it.
- `ReaderChatDetail.tsx` slimmed to a header + engine + view.
- `ChatComposer` decomposition: new `lib/conversations/chatRunBody.ts`, `components/chat/useChatDraft.ts`,
  `useChatModels.ts`, `ModelSettingsPopover.{tsx,module.css}`, `PendingReferencesBar.{tsx,module.css}`;
  `ChatComposer.tsx` slimmed.
- `ConversationForksPanel` decomposition: new `lib/conversations/forkTree.ts`, `useForkPanel.ts`,
  `useForkTreeKeyNav.ts`, `ForkTreeView.{tsx,module.css}`, `ForkNodeRow.{tsx,module.css}`;
  `ConversationForksPanel.tsx` slimmed.
- Delete `shouldScrollRef` from `useChatRunTail`/`useChatMessageUpdates`.
- Delete `branchScroll.ts` (absorbed into `useChatScroll`).
- Update/extend affected tests.

**Out of scope**
- SSE transport internals; references data model; fork endpoints; `/models`; backend.
- `ConversationReferencesSidecar` row rendering (`item-card-cutover.md`).
- `ForkGraphOverview` / `ForkStrip` internals (reused as-is).
- Any new chat/fork/model feature.

---

## 10. Files

**New**
- `apps/web/src/components/chat/useConversation.ts` (+ `.test.tsx`)
- `apps/web/src/components/chat/useChatScroll.ts` (+ `.test.tsx`)
- `apps/web/src/components/chat/Conversation.tsx`
- `apps/web/src/lib/conversations/chatRunBody.ts` (+ `.test.ts`)
- `apps/web/src/components/chat/useChatDraft.ts` (+ `.test.tsx`)
- `apps/web/src/components/chat/useChatModels.ts` (+ `.test.tsx`)
- `apps/web/src/components/chat/ModelSettingsPopover.tsx` + `.module.css`
- `apps/web/src/components/chat/PendingReferencesBar.tsx` + `.module.css`
- `apps/web/src/lib/conversations/forkTree.ts` (+ `.test.ts`)
- `apps/web/src/components/chat/useForkPanel.ts`
- `apps/web/src/components/chat/useForkTreeKeyNav.ts`
- `apps/web/src/components/chat/ForkTreeView.tsx` + `.module.css`
- `apps/web/src/components/chat/ForkNodeRow.tsx` + `.module.css`

**Modified**
- `apps/web/src/components/chat/ChatSurface.tsx` + `.module.css` (owns scroll; spacer; ↓Latest; remove
  `scrollportRef`/`onScroll`/`handleComposerWheel`)
- `apps/web/src/components/chat/ChatComposer.tsx` (→ thin orchestrator; move out of `components/` into
  `components/chat/`) + `.module.css`
- `apps/web/src/components/chat/ConversationForksPanel.tsx` + `.module.css` (→ thin orchestrator)
- `apps/web/src/components/chat/useChatRunTail.ts`, `useChatMessageUpdates.ts` (delete `shouldScrollRef`)
- `apps/web/src/app/(authenticated)/conversations/[id]/page.tsx` (render `<Conversation conversationId={id}/>`)
- `apps/web/src/app/(authenticated)/conversations/new/page.tsx` (render `<Conversation conversationId={null}/>`)
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` (unchanged usage; `ReaderChatDetail`
  import path/props stable)
- Affected tests: `ConversationPaneBody.test.tsx` (→ `Conversation.test.tsx`), `ChatComposer.test.tsx`,
  `ReaderChatDetail.test.tsx`, `MediaPaneBody.test.tsx`, any fork-panel test.

**Deleted**
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx` (becomes `Conversation.tsx`)
- `apps/web/src/app/(authenticated)/conversations/[id]/branchScroll.ts` (absorbed into `useChatScroll`)
- `apps/web/src/app/(authenticated)/conversations/[id]/branchScroll.test.ts` if present (moves to `useChatScroll.test.tsx`)

Blast radius to confirm before deleting: `ConversationNewPaneBody`/`ConversationPaneBody` are referenced
only by their route pages; `branchScroll` only by `ConversationPaneBody`; `ChatComposer` by the three
adapters; `ChatSurface` by the three adapters. `rg` each before deletion.

---

## 11. Key details

- **Pin math, exactly:** `topInset` = transcript `padding-top` (`--space-4`); anchor = the latest
  user message element (`[data-message-id]`); `contentBelowAnchorTop = transcript.scrollHeight −
  anchor.offsetTop − currentSpacerHeight`; `spacer = max(0, scrollport.clientHeight − topInset −
  contentBelowAnchorTop)`; pin = `scrollport.scrollTo({ top: anchor.offsetTop − topInset, behavior:
  "smooth" })`. During streaming only the spacer is recomputed; `scrollTop` is untouched while pinned.
- **Programmatic-vs-user scroll:** set a `programmaticScroll` flag immediately before any
  `scrollTo`/`scrollTop` write and clear it on the next `scroll` event; only non-flagged scroll events
  clear `pinned`. Prevents the smooth pin from releasing itself.
- **First load / existing conversation:** no anchor yet → start at bottom (`scrollTop = scrollHeight`),
  no animation, `pinned = false`.
- **`overflow-anchor: none`** on `.transcript`; `scrollbar-gutter: stable` retained.
- **Spacer is `aria-hidden` and non-interactive**; it sits after the last `MessageRow` inside
  `.transcript` so it scrolls with content.
- **Model cache stays module-level** (`cachedModels`/`modelLoadPromise`) inside `useChatModels.ts` so it
  survives composer remounts across surfaces — same semantics as today.
- **Draft keys** keep their exact format (`branch:…:selection:…` / `branch:…:message` / `path:…`) so
  in-flight drafts are preserved across branch/path switches.
- **Idempotency-Key** on `POST /api/chat-runs` is preserved (random id per send).
- **`switchToLeaf`** still POSTs `/active-path` and keeps the path cache; only its scroll-restore call
  changes (now `scrollRef.preserveAround`).
- **Tokens only**: spacing `--space-*`, type `--text-*`/`--leading-*`, color `--surface-*`/`--ink-*`/
  `--edge`, motion `--duration-*`/`--ease-*`. The ↓Latest button reuses `ui/Button` (`pill`/`sm`).
- **Test ids** retained: `data-testid="chat-composer-dock"`, `data-message-id`, streaming cue; add
  `data-testid="chat-scroll-latest"` for the ↓Latest affordance.

---

## 12. Key decisions (resolved)

1. **Pin-the-question, not stick-to-bottom** — explicit product choice; the only scroll model shipped.
2. **Engine + view + two adapters** — driven by the pane-context hook constraint (§5, §8 table). One
   component with a flag is rejected.
3. **Delete `ConversationNewPaneBody`** — new chat is `conversationId={null}`.
4. **Unify on `/tree`** — single history load path; reader ignores fork data.
5. **`shouldScrollRef` removed from the streaming hooks** — the one allowed edit there, and it is a
   deletion.
6. **`ChatComposer` keeps its public props** — internal-only decomposition; no call-site churn.
7. **References row rendering deferred to `item-card-cutover.md`** — no overlap.
8. **`useResizeObserver` not generalized** — single inline observer in `useChatScroll`.

---

## 13. Acceptance criteria

1. **Single scroll owner.** `rg "shouldScrollRef"` is empty; `rg "handleChatScroll"` is empty;
   `branchScroll.ts` is deleted and unreferenced; `ChatSurface` no longer exposes `scrollportRef`/
   `onScroll`; the `handleComposerWheel` block is gone. All scroll logic resides in `useChatScroll`.
2. **Pin behaviour (pane + reader).** Sending a message smooth-scrolls the new user message to the top
   inset; the assistant answer streams in below it while the question stays pinned (its top does not
   move during streaming); a short turn reserves space so the question reaches the top; the view does
   not auto-jump to the bottom during streaming.
3. **Release + ↓Latest.** A manual scroll-up during streaming stops re-pinning; when the newest content
   is below the fold a `chat-scroll-latest` control appears and, on click, jumps to the latest turn.
4. **Reader doc-chat scrolls.** The reader doc-chat now pins/scrolls identically to the pane (the prior
   no-autoscroll bug is gone) — verified in `ReaderChatDetail.test.tsx`.
5. **Three → one.** `ConversationNewPaneBody.tsx` and `ConversationPaneBody.tsx` are deleted; both
   conversation routes render `Conversation`; `ReaderChatDetail` contains no lifecycle/scroll/send code
   (only header + `useConversation` + `ChatSurface`). `useConversation` is the only caller of
   `useChatRunTail` outside its own tests.
6. **One load path.** `rg "/messages\?limit"` (client) is empty; history loads via `/tree`.
7. **Composer decomposed.** `ChatComposer.tsx` ≤ ~180 lines; `buildChatRunBody` is a pure exported
   function with unit tests (branch-anchor cases, `key_mode`, conditional `parent_message_id`);
   `useChatDraft`/`useChatModels` exist with tests; `ModelSettingsPopover`/`PendingReferencesBar` are
   separate components. `ChatComposerProps` is unchanged. Existing `ChatComposer.test.tsx` assertions
   (run payload shape, model selection, 320px mobile layout) still pass.
8. **Forks decomposed.** `ConversationForksPanel.tsx` ≤ ~160 lines; `lib/conversations/forkTree.ts`
   exports the six pure functions with unit tests; keyboard nav (arrows/Home/End/→/←/Enter/F2/Delete/
   Escape), rename (PATCH), and delete (DELETE, with active-path guard) behave exactly as before;
   tree/graph toggle intact.
9. **Branching preserved.** Fork switching, active-path persistence, fork strips, branch-reply composer,
   and **scroll preservation across a branch switch** all work (covered by the migrated
   `Conversation.test.tsx`, formerly `ConversationPaneBody.test.tsx`).
10. **Gates green.** `make check-front` (lint + typecheck, max-warnings 0), `make test-front-unit`, and
    `make test-front-browser` pass. New tests cover `useChatScroll` (pin/release/preserve via a
    `ResizeObserverMock` like `MediaPaneBody.test.tsx:266`) and `useConversation` (resolve-on-send,
    optimistic seed, retry).

---

## 14. Rules adhered to (`docs/rules/`)

- **cleanliness:** hard cutover — delete `ConversationNewPaneBody`, `ConversationPaneBody`,
  `branchScroll.ts`, `shouldScrollRef`, the duplicated scroll effects, and the wheel hack. No dead code,
  no compat shims, no fallbacks. God-files split by ownership.
- **module-apis:** one engine, one scroll owner, one body builder, one draft hook, one model hook — each
  capability in a single primary form; `ChatComposer`/`ConversationForksPanel` keep one public API.
- **simplicity:** one scroll model (no toggle); `/tree` is the one load path; no speculative props; the
  `branching` flag exists only because two real call sites differ; the RO is not generalized until a
  third site needs it.
- **conventions:** CSS Modules + design tokens; readable class names; mobile breakpoints + safe-area as
  in `ChatSurface.module.css`.
- **typescript:** strict; discriminated `BranchAnchor`/message unions reused; `ChatScrollHandle` and
  `UseConversation` are explicit; no implicit any.
- **testing_standards:** behaviour-first tests (role/text queries, observable scroll/DOM state); pure
  functions (`buildChatRunBody`, `forkTree.*`) unit-tested in Node; component/scroll tests in Vitest
  browser mode; mock only external boundaries.

---

## 15. Cutover steps (ordered)

1. **Scroll owner first (self-contained, fixes the visible bug).** Build `useChatScroll` (absorb
   `branchScroll.ts`); rebuild `ChatSurface` to own scroll, render the spacer, expose `ChatScrollHandle`,
   add ↓Latest; remove `scrollportRef`/`onScroll`/`handleComposerWheel`. Temporarily adapt the three
   existing surfaces to the new `ChatSurface` ref API and delete their scroll effects. Add
   `useChatScroll.test.tsx`. Gate.
2. **Remove `shouldScrollRef`** from `useChatRunTail`/`useChatMessageUpdates` and all callers. Gate.
3. **Engine.** Build `useConversation` (merge lifecycle/resolve/branch/retry); add tests. Gate.
4. **Pane adapter.** Create `Conversation.tsx` from `ConversationPaneBody` using the engine + new
   `ChatSurface`; point `[id]` and `new` routes at it; delete `ConversationNewPaneBody` and
   `ConversationPaneBody`; migrate `ConversationPaneBody.test.tsx` → `Conversation.test.tsx`. Gate.
5. **Reader adapter.** Slim `ReaderChatDetail` to header + engine + view; delete its dead refs; update
   `ReaderChatDetail.test.tsx` to assert it now scrolls. Gate.
6. **Composer split.** Extract `buildChatRunBody` (+ test), `useChatDraft`, `useChatModels`,
   `ModelSettingsPopover`, `PendingReferencesBar`; slim `ChatComposer` and move it into `components/chat/`;
   keep `ChatComposerProps`. Gate (`ChatComposer.test.tsx`).
7. **Forks split.** Extract `forkTree.ts` (+ test), `useForkPanel`, `useForkTreeKeyNav`, `ForkTreeView`,
   `ForkNodeRow`; slim `ConversationForksPanel`. Gate.
8. **Full gate + manual pass:** `make check-front && make test-front-unit && make test-front-browser`;
   manually verify pin/stream/release/↓Latest on desktop + mobile, in the conversation pane (existing +
   new) and the reader doc-chat, plus a branch switch and a load-older.

---

## 16. Risks & mitigations

- **Smooth pin re-triggering release.** Mitigate with the `programmaticScroll` flag (§11); covered by a
  `useChatScroll` test that asserts `pinned` survives a programmatic pin and clears on a synthetic
  user-wheel.
- **Spacer flicker during fast streaming.** Recompute the spacer in the same `ResizeObserver` callback
  that measures content; clamp at 0; never animate the spacer height. RAF-batched deltas already
  coalesce growth.
- **`/tree` heavier than linear `/messages` for reader chats.** Accepted for one load path (single-user
  prototype, `simplicity.md`); fork data is ignored when `branching:false`. Revisit only if measured.
- **Branch-switch scroll regression.** `preserveAround` must reproduce `branchScroll.ts` exactly; port
  its tests into `useChatScroll.test.tsx` before deleting the file.
- **Engine prop-drift between adapters.** Keep `UseConversation` explicit and tested; adapters must not
  re-derive any lifecycle state locally (lint-review for stray `useState<ConversationMessage[]>` in
  adapters — there should be none).
```

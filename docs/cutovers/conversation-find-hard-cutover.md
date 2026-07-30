# Conversation Find Hard Cutover

**Status:** IMPLEMENTED
**Date:** 2026-07-29
**Series:** Spec 4 of 6
**Type:** hard cut; no legacy matcher, AST marking path, fallback, flag, or
compatibility branch

## 0. Decision

Hard-cut the existing unspecced Conversation Find slice to the implemented Pane
Search system.

- `Cmd/Ctrl+F` finds literal text in the open conversation's selected path.
- `Cmd/Ctrl+K` remains global Search.
- Search the stable primary message text exactly as rendered.
- Build the corpus from committed DOM, after citation rewriting, GFM parsing,
  and syntax highlighting.
- Reuse the canonical matcher, DOM cursor/provenance, exact `Range` mapping,
  CSS Custom Highlight registry, transcript scroll owner, and Companion.
- Show all matches and a distinct active match. Do not inject `<mark>` into the
  React/Markdown tree.
- Result activation is a reversible preview. Close stays at the result;
  **Go back to reading position** restores the one origin.
- Use the already-loaded selected path. Add no endpoint, index, migration, or
  persistence.

No product question blocks implementation.

## 1. Authority And Amendment

Import without restating:

1. [`pane-search-foundation-hard-cutover.md`](pane-search-foundation-hard-cutover.md)
   — capability, controls, shortcut, session, Companion, and Return;
2. [`canonical-text-surfaces-find-hard-cutover.md`](canonical-text-surfaces-find-hard-cutover.md)
   — `canonicalTextFind`, DOM provenance/ranges, CSS Custom Highlights, and
   preview-lease precedent;
3. [`chat-scroll-anchoring-hard-cutover.md`](chat-scroll-anchoring-hard-cutover.md)
   — `ChatSurface`, `useChatScroll`, and `PinMode`;
4. [`../modules/chat.md`](../modules/chat.md) — selected-path, rendering,
   branching, and tree ownership.

This spec explicitly amends the foundation's same-pane source-replacement
lifecycle:

- a mounted producer changing `adapter.sourceKey` cancels old work, results,
  presentation, lease, and Return origin;
- it preserves a nonempty query plus Match case/Whole word, prepares the new
  source, and reruns the query;
- ordinary searching/result-count announcements report the refreshed state;
- initial mount, route-key exit/unmount, Dismiss, and explicit clearing still
  reset the query.

`usePaneFind` owns query preservation/reprepare. The format owner synchronously
invalidates DOM presentation and leases. This is one shared hard cut, not a
Conversation flag.

## 2. Goals

- Find ordinary prose and code in long conversations.
- Search visible content, never Markdown source syntax or diagnostic chrome.
- Keep result identity, presentation, scrolling, and concurrency exact.
- Preserve branch, URL, pane history, composer, run, and chat state.
- Reuse existing owners; delete the duplicate matcher and `<mark>` machinery.

## 3. Scope And Non-Goals

In:

- hydrated existing Conversation panes, including loaded-empty conversations;
- terminal primary text on the selected root-to-leaf path;
- rendered plain text, Markdown prose, link labels, inline code, and fenced
  code;
- Match case, Whole word, count, Previous/Next, Companion results, all/active
  highlights, and Return;
- stable-source preparation, invalidation, nested code-scroll reveal, and chat
  pin restoration.

Out:

- the conversation index; Spec 2 owns its local row filter;
- sibling-fork/all-forks search, ranking, or implicit fork switching;
- global, semantic, fuzzy, stemmed, regex, embedding, or agentic search;
- pending text, composer drafts, quote cards, citations, sources, tools, trust
  trails, Details, failure-card copy, Forks, Context, Dossier, or timestamps;
- matches spanning messages or `message_document` blocks;
- search history, saved queries, URL state, analytics, persistence,
  virtualization, server search, or pagination changes;
- **Continue from here**, multiple origins, or a navigation stack.

## 4. Product Rules

1. The selected path is the local document. A sibling fork is absent until the
   user explicitly switches to it.
2. The product copy is **Find in conversation**. Do not expose “branch” jargon.
   The single internal scope id is `SelectedPath`; its hidden required label is
   **Current fork**.
3. Find indexes only construction-time-proven, renderable primary content.
   Activation never silently drops an unrenderable candidate.
4. Results are literal, deterministic, complete, transient, and unranked.
5. Search preview never selects a fork, sends, seeks, navigates, writes
   history, or changes chat state.
6. One owner exists for matching, DOM projection, highlights, scrolling, and
   Companion state.
7. Stale work is cancellation. Missing same-source content/ranges are defects.
   Only expected user-recoverable failures enter an error union.

## 5. Target Behavior

1. A loaded existing Conversation publishes `FindOccurrences`, even when it has
   zero searchable units. `/conversations/new`, loading, and failed routes do
   not.
2. The adapter publishes one `EntireResource` option:
   `SelectedPath / Current fork`. The foundation renders no selector.
3. Opening prepares the committed selected-path DOM. Defaults remain
   case-insensitive and Whole word off.
4. The first Ready result previews. Previous/Next and Companion rows wrap and
   activate the same occurrence.
5. Each row supplies `You|Assistant|System` plus `Message N` to the shared
   context formatter, followed by the shared typed-emphasis snippet.
6. All current matches are highlighted; the active match adds a non-color
   double-underline distinction.
7. Activation reveals the first active range at the transcript top inset. For
   code, reveal the range inside the horizontal code scroller first, then
   position the outer transcript.
8. Preview does not move focus. Companion/current-result status is the
   authoritative screen-reader reading path; highlights are visual.
9. Close clears highlights/results and leaves the revealed eye-line. Return
   remains available.
10. Return restores eye-line and pin mode once, restores a still-connected
    reading focus target best-effort, then retires the origin.
11. Same-pane source replacement clears old highlights, preview lease,
    Companion rows, and origin, then preserves and reruns the query against the
    new source.
12. Pending token deltas do not change the projected source key, adapter,
    session, query, or results. Each effective eligible projection change —
    terminalization or later citation-ordinal reconciliation — produces one
    source replacement and one refresh, never token-level churn.

## 6. Search Corpus

`convo.messages` is already the complete selected path because `Conversation`
uses `useConversation({ branching: true })`.

| Content | Rule |
| --- | --- |
| `complete` user/system primary blocks | Include |
| `complete` assistant answer blocks | Include |
| `error` / `cancelled` primary blocks | Include only when the transcript renders them |
| refused assistant body suppressed by `AssistantMessage` | Exclude |
| `pending` message text | Exclude |
| visible prose, link labels, inline/fenced code | Include |
| Markdown syntax, link destinations, raw HTML | Absent unless rendered as visible text |
| resolved citation controls | Exclude |
| quote/citation/source/tool/trail/detail/failure/time chrome | Exclude |

`message_document.blocks` is the structural boundary:

- render each text block through its normal plain/Markdown renderer; preserve
  the joined renderer's collapsed `\n\n` boundary margins across the separate
  block roots;
- give each primary block root
  `messageId + blockIndex + role + messageOrdinal`;
- build one searchable DOM cursor per block after commit;
- never match across blocks;
- mark non-corpus descendants with one shared `data-pane-find-exclude="true"`
  contract. Resolved citation controls and code header/copy controls use it.

`MarkdownMessage` retains the sole citation-source rewrite. Find neither
reproduces nor interprets it; it projects the committed result. Exact citation
projection inputs are part of `sourceKey`, so citation reconciliation performs
one source replacement and rerun.

The assistant visibility predicate moves to one pure conversation presentation
owner consumed by both `AssistantMessage` and Find. Do not mirror refused or
terminal-partial rules.

## 7. Final Architecture

```text
selected-path ConversationMessage[]
  -> exact eligible-source identity
  -> PaneFindSourceKey
  -> sourceKey-stable snapshot + adapter

committed primary block roots
  -> shared DOM text cursor/provenance
  -> PreparedConversationFindUnit[]
  -> CanonicalTextFindUnit[]
  -> canonicalTextFind
  -> compact logical occurrences + Companion rows
  -> exact DOM Range groups
  -> createWebFindHighlightOwner(all, active)
  -> useChatScroll preview lease/reveal/Return
```

### 7.1 Rendered-DOM projection

Projection occurs after:

```text
message blocks
  -> renderer-owned citation-source rewrite
  -> react-markdown v10 remarkParse + remarkGfm + remarkRehype
  -> rehypeHighlight
  -> React DOM
  -> Pane Find DOM cursor
```

Do not construct a parallel unified pipeline and do not insert a pre-highlight
`<mark>`. `rehypeHighlight` replaces code children; post-highlight AST leaves
also split multi-token queries. The committed DOM is the sole parity boundary.

Extract the traversal/NFC/whitespace/provenance core currently owned inside
`canonicalCursor.ts` into one DOM text-cursor primitive. Preserve
`buildCanonicalCursor` behavior unchanged. Conversation supplies a required
exclusion predicate for `data-pane-find-exclude`; it does not fork the
canonicalization algorithm.

A browser parity corpus renders the real `MarkdownMessage` and then projects
its DOM. It pins GFM emphasis/link labels, citation replacement/exclusion,
inline code, syntax-highlighted multi-token fenced code, whitespace, NFC,
astral text, and multiple blocks. A react-markdown/highlighter upgrade that
changes visible projection fails this public-render test; no private-internals
test is needed.

### 7.2 Matching

`apps/web/src/lib/reader/canonicalTextFind.ts` remains the sole matcher.
Conversation inherits NFC source projection/query normalization, Unicode regex
case folding, `Intl.Segmenter("und")` Whole word boundaries, non-overlapping
left-to-right order, right-open codepoint ranges, 64-codepoint snippet context,
and `TooManyMatches(2_000)`.

Delete the Conversation-local lowercase matcher, word regex, snippet builder,
UTF-16 locator contract, and threshold constant.

### 7.3 Highlight presentation

Reuse `createWebFindHighlightOwner`; do not create a chat registry or inject
React marks.

- resolve every occurrence through its prepared block cursor;
- missing or disconnected same-source roots/provenance defect before a Ready
  response or preview move;
- publish all occurrence ranges to `nexus-find-all`;
- publish the active occurrence's one-or-more ranges to `nexus-find-active`;
- one logical code occurrence may span multiple syntax-token ranges;
- clear the owner on query change, Close, source replacement, Return, and
  unmount.

Scope CSS to the transcript:

- all: highlight-yellow background with inherited text color;
- active: same background plus double underline and distinct active message
  outline;
- forced colors: `Highlight` / `HighlightText`, with the active double
  underline retained.

This is normative WCAG 1.4.1/1.4.11 behavior, not optional decoration.

## 8. Capability And Identity Contracts

```ts
interface ConversationFindSource {
  readonly sourceKey: PaneFindSourceKey;
  readonly sourceRevision: number;
  readonly messages: readonly ConversationFindMessage[];
}

interface ConversationFindUnit {
  readonly unitId: string;
  readonly messageId: string;
  readonly messageOrdinal: number;
  readonly blockIndex: number;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

interface PreparedConversationFindUnit extends ConversationFindUnit {
  readonly cursor: DomTextCursor;
}

interface ConversationFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly messageId: string;
  readonly blockIndex: number;
  readonly startCp: number;
  readonly endCp: number;
  readonly row: PaneFindResultRow;
}

type ChatFindPreviewSettlement =
  | { readonly kind: "Revealed" }
  | { readonly kind: "Cancelled" };
```

Rules:

- `sourceKey` contains conversation id, selected leaf id, and ordered eligible
  message id/sequence/role/status/visibility, exact blocks, and resolved
  citation ordinals. Citation metadata that cannot change rendered primary text
  is excluded.
- `sourceRevision` is a visit-local monotonic token minted only when that exact
  `sourceKey` changes; it is never persisted or reused.
- The adapter/snapshot memoization key is `sourceKey`, never `messages`,
  candidate-object identity, or token-flush identity.
- Result keys use compact source
  `{ kind: "ConversationFindSnapshot", conversationId, sourceRevision }` plus
  `{ messageId, blockIndex, startCp, endCp }`. They never repeat block or
  transcript text.
- Unit/result order is message, block, then codepoint order. Completeness is
  always `Complete`.
- `Cancelled` covers AbortSignal or preview-generation loss. The adapter maps
  it to abort/cancellation, never `Failed`.
- Missing block root, cursor, exact range, or same-source anchor throws inside
  the owner that detects it.
- `conversationFind.ts` remains DOM-free. The chat DOM adapter adds
  `PreparedConversationFindUnit.cursor` and resolves ranges.

The closed expected error union is:

```ts
type ConversationFindError =
  | { readonly kind: "OriginUnavailable" };
```

`OriginUnavailable` means the transcript eye-line contains no message anchor,
for example when it is wholly inside the trailing spacer. Missing scroll owners
or same-source content are defects.

## 9. Source Replacement And Preview Safety

### 9.1 Shared `usePaneFind` amendment

Key adapter lifecycle by `adapter.sourceKey`, not adapter object identity.
While the key is unchanged, a producer rerender cannot replace the prepared
adapter or its occurrence map.

On a new key in the same mounted producer:

1. abort old prepare/query/preview/clear/return work and generation-fence every
   settlement;
2. retire result/active key and Return availability;
3. retain query, Match case, and Whole word;
4. prepare the new adapter;
5. rerun a retained nonempty query once; normal Searching/count announcements
   communicate the refresh.

Initial mount, route-key exit/unmount, Dismiss, and explicit empty query retain
their existing reset semantics.

### 9.2 Conversation invalidation seam

`usePaneFind` does not own DOM marks or chat pin state. A Conversation
`useLayoutEffect` keyed by `sourceKey` must synchronously:

1. increment the `useChatScroll` Find preview generation;
2. clear all/active Custom Highlights;
3. clear the active-message presentation marker;
4. end the preview lease without restoring the old pin mode;
5. retire the adapter origin;
6. close the transient Companion result surface.

Retain this effect and its cleanup. It is a required external-side-effect fence,
not a React state mirror. Aborting an in-flight foundation
`clearPresentation()` cannot replace it.

### 9.3 Preview lease and Return

Extend the chat origin:

```ts
interface ChatReadingPosition {
  readonly anchorMessageId: string;
  readonly anchorOffsetTop: number;
  readonly focusTarget: HTMLElement | null;
  readonly pinMode: "top" | "bottom" | "released";
}
```

- Capture immediately before the first successful move.
- The chat-local lease pauses top/bottom following during programmatic result
  preview without rewriting the saved pin mode.
- `previewFindOccurrence` accepts exact `Range[]` and returns
  `Revealed | Cancelled`. It throws for missing ranges/targets.
- Its generation fence covers state commit plus the existing double-RAF
  validation/reveal interval.
- Commit the first origin and Return only on `Revealed`. `Cancelled` rolls back
  an unreported lease and commits no origin.
- Genuine transcript input ends preview ownership and delegates the final
  `top/bottom/released` decision to the existing `onScroll`; near-bottom input
  may re-engage `bottom`.
- Close leaves the result eye-line in `released` so streaming cannot snap it
  away.
- Return requires the saved message anchor, restores eye-line and pin mode,
  then focuses only if the saved target remains connected inside the
  scrollport. A disconnected focus target is benign; a missing same-source
  anchor defects.

## 10. API And Persistence

No external API or schema change.

- Source: existing authenticated
  `GET /api/conversations/{conversationId}/tree`.
- Do not call `/api/search`; it is ranked cross-fork retrieval.
- Add no Find endpoint, FTS index, worker, cursor, revision column, migration,
  or BFF.
- Write no selected leaf, message, URL/history, storage, workspace, analytics,
  progress, engagement, or playback state.

Every request remains fenced by
`sessionId + queryId + sourceKey + AbortSignal`.

## 11. Ownership

| Capability | Sole owner |
| --- | --- |
| shortcut, toolbar, query, stepping, Companion, Return publication | Pane Search foundation |
| same-pane query preservation/reprepare | `usePaneFind` |
| selected path and active leaf | `useConversation` branch engine |
| assistant primary-body visibility | shared conversation presentation helper |
| eligible source, text units, result mapping | `conversationFind.ts` |
| committed block lookup, DOM cursors, exact ranges | `conversationFindDom.ts` |
| DOM normalization/provenance core | extracted shared DOM text cursor |
| literal matching/snippets | `canonicalTextFind.ts` |
| all/active range registry | `webFindHighlights.ts` |
| adapter and source-key invalidation | `useConversationPaneFind.ts` |
| block roots/exclusions | message render chain / `MarkdownMessage` |
| preview lease, nested reveal, eye-line/focus/pin restore | `useChatScroll.ts` |
| publication and transient Companion closure | `Conversation.tsx` |

No generic search provider, chat-specific highlight registry, second Markdown
pipeline, second scroll hook, or AST `<mark>` path is permitted.

## 12. Files

Create/extract:

- `apps/web/src/lib/highlights/domTextCursor.ts` + unit/browser tests — shared
  traversal, NFC/whitespace projection, and DOM provenance;
- `apps/web/src/components/chat/conversationFindDom.ts` + browser test —
  committed block roots, excluded descendants, cursors, and exact ranges;
- one pure conversation primary-body visibility helper and test.

Hard-cut:

- `apps/web/src/lib/highlights/canonicalCursor.ts` + tests — delegate to the
  shared core with behavior unchanged;
- `apps/web/src/lib/panes/usePaneFind.ts` + tests — sourceKey identity and
  preserve/reprepare/rerun amendment;
- `apps/web/src/lib/conversations/conversationFind.ts` + tests;
- `apps/web/src/components/chat/useConversationPaneFind.ts` + tests;
- `apps/web/src/components/chat/useChatScroll.ts`;
- `apps/web/src/components/chat/{ChatSurface,MessageRow,AssistantMessage,UserMessage,SystemMessage,ConversationMessageText,AssistantAnswer}.tsx`
  and focused tests;
- `apps/web/src/components/ui/{MarkdownMessage,ReaderCitation}.tsx` and tests;
- relevant chat/Markdown CSS;
- `apps/web/src/components/chat/Conversation.tsx` and integration tests;
- `docs/cutovers/pane-search-foundation-hard-cutover.md`;
- `docs/modules/chat.md`.

Reuse unchanged:

- `canonicalTextFind.ts`;
- `webFindHighlights.ts`;
- Pane Search controls/Companion owners;
- conversation tree/BFF/backend services.

Add no search, Markdown, or highlighting dependency.

## 13. Hard Cut

Remove:

- `findConversationOccurrences` as an independent matcher;
- `CONVERSATION_FIND_MATCH_THRESHOLD`, local case/word/snippet helpers;
- UTF-16 `start/end` occurrence fields;
- `EntireConversation`, **Entire conversation**, **This branch**, and
  **Find in this branch**;
- `StaleSource` / `OccurrenceUnavailable` product errors;
- `ConversationMessageText` / `MarkdownMessage` `<mark>` injection,
  `findRange`, `rehypeFindMark`, mark data attributes, and `.findMark` CSS;
- boolean preview settlements;
- any adapter dependency on `messages` or candidate snapshot identity;
- any silent activation-time “not renderable” drop;
- any test blessing raw Markdown matching, active-only marks, silent query loss,
  or stale-as-retry behavior.

## 14. Atomic Implementation Order

1. Lock corpus, DOM projection, source lifecycle, and preview contracts in
   focused tests.
2. Extract the shared DOM cursor and prove `canonicalCursor` behavior unchanged.
3. Land the foundation sourceKey amendment and the complete Conversation
   vertical slice atomically: source/snapshot, matcher mapping, DOM ranges,
   all/active highlights, scroll settlement/lease, adapter, renderer, and
   publication. Do not merge an intermediate locator/renderer mismatch.
4. Update module docs, run focused/static/browser suites and residue gates.

Do not mix list filtering, global Search, backend retrieval, or another media
format into this cutover.

## 15. Acceptance Criteria

AC1. `Cmd/Ctrl+F` opens/focuses **Find in conversation** in a loaded existing
Conversation, including an empty one; `Cmd/Ctrl+K` is unchanged.

AC2. Selected-path occurrences are complete and ordered. A sibling-fork-only
term is absent and activation never changes the active fork.

AC3. Terminal visible user/assistant/system primary blocks are included.
Pending/refused-hidden and all auxiliary chrome are excluded by the shared
visibility/exclusion owners.

AC4. The browser parity corpus uses the real `MarkdownMessage`: visible
emphasis/link labels, citations, inline code, and multi-token fenced-code
queries project and range-map exactly; syntax and hidden URLs never become
results.

AC5. Match case, Whole word, Unicode/codepoint behavior, snippets, non-overlap,
order, and the cap equal `canonicalTextFind`.

AC6. All matches and the active match publish through the shared Custom
Highlight owner. Active/all, forced-colors, and active-message distinctions are
non-color testable.

AC7. First, Previous/Next, and Companion activation select identical
occurrences. Rows expose exact role + `Message N`, typed snippets, active state,
and foundation announcements.

AC8. A code occurrence spanning syntax-token nodes highlights every exact range
and reveals both its inner horizontal scroller and outer transcript.

AC9. First preview captures one origin. Repeated previews retain it. Close does
not return. Return restores eye-line/pin once; disconnected focus degrades
without failure.

AC10. Pending token flushes preserve sourceKey, adapter identity, session,
query, results, highlights, and Return. Each effective eligible projection
change clears stale presentation/lease/origin, preserves query/options, and
reruns exactly once; it never refreshes per token.

AC11. Fork switch, send/path change, stable message replacement, route exit,
and unmount generation-fence every in-flight preview. No stale double-RAF
settlement can reveal or strand a lease.

AC12. `Cancelled` preview is inert. Missing same-source roots, provenance,
ranges, or anchor messages defect. Only an eye-line wholly outside messages
returns `OriginUnavailable`.

AC13. Find performs no fetch, fork mutation, pane navigation, URL/history,
storage, progress/engagement, playback, or focus theft.

AC14. Focused unit/browser/integration tests, typecheck, lint, CSS-token lint,
diff checks, and residue gates pass.

## 16. Residue Gates

```bash
rg -n "findConversationOccurrences|CONVERSATION_FIND_MATCH_THRESHOLD|literalMatches|WORD_CODEPOINT|SNIPPET_CONTEXT_CODEPOINTS" \
  apps/web/src/lib/conversations apps/web/src/components/chat
rg -n "EntireConversation|Entire conversation|Find in this branch|This branch" \
  apps/web/src/components/chat apps/web/src/lib/conversations
rg -n "StaleSource|OccurrenceUnavailable" \
  apps/web/src/components/chat/useConversationPaneFind.ts \
  apps/web/src/lib/conversations/conversationFind.ts
rg -n "data-find-active-mark|data-find-block-index|data-find-start|data-find-end|findRange|rehypeFindMark|\\.findMark" \
  apps/web/src/components/chat apps/web/src/components/ui/MarkdownMessage*
rg -n "markdownTextProjection" apps/web/src
rg -n "ChatFindOccurrencePosition|activeFindOccurrence|Promise<boolean>" \
  apps/web/src/components/chat/useChatScroll.ts
rg -n "createWebFindHighlightOwner|WEB_FIND_ALL_HIGHLIGHT_NAME|WEB_FIND_ACTIVE_HIGHLIGHT_NAME" \
  apps/web/src/lib/reader apps/web/src/components/chat apps/web/src/app
```

Expected:

1. zero duplicate matcher/private snippet/threshold symbols in Conversation;
2. zero legacy scope/input copy;
3. zero legacy stale/unavailable error variants;
4. zero chat/Markdown AST-mark plumbing;
5. zero parallel Markdown projection or boolean preview settlement;
6. one shared Custom Highlight implementation, with deliberate reader and
   Conversation consumers only.

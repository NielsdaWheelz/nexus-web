# Chat Branching SOTA Completion Hard Cutover

## Role

This document is the target-state implementation plan for finishing the chat
branching hard cutover after the first implementation pass. It closes the
verified gaps in quote anchors, immediate path switching, fork-strip metadata,
keyboard tree behavior, branch-path concurrency, branch delete, and graph
overview navigation.

This remains a hard cutover. The final state keeps no arrow-only alternates, no
fork-as-separate-chat model, no route-only branch state, no legacy append
fallback, no compatibility branch-anchor payload, no graph view that is only a
static illustration, and no hidden sibling transcript state in the main chat.

The implementation follows `docs/rules/`: service logic stays in backend
services, BFF routes proxy only, finite states are exhaustive, destructive
cleanup is explicit, and every extra code path must pay for itself in visible
product behavior.

## Current Gaps

- Assistant-answer quote anchors map selection offsets with `indexOf`, so
  repeated text and markdown rendering can produce wrong offsets.
- Backend stores selection anchors without validating that `message_id`,
  offsets, exact text, prefix, and suffix match the parent assistant answer.
- Clicking an existing fork updates active flags immediately but waits for the
  active-path response before the main transcript changes.
- The inline fork strip is compact and clickable, but it does not expose the
  full reply text to assistive technology and omits message-count metadata.
- The fork panel uses tree roles but does not implement the full keyboard tree
  pattern.
- Chat-run busy checks are conversation-wide, blocking non-conflicting sibling
  branch work.
- Branch delete rewrites active paths to the parent for the requesting viewer;
  the target behavior is explicit rejection when the current active path would
  be removed.
- There is no graph overview where selecting a leaf switches chat state.
- Test coverage is focused on the first-pass happy paths and does not prove the
  SOTA edge behavior.

## Goals

1. Make assistant quote anchors exact and auditable.
2. Switch visible transcript paths synchronously for every clickable inline fork
   and graph leaf.
3. Make the fork strip spec-grade: compact, readable, fully labeled, and
   keyboard-friendly.
4. Make the fork panel a real keyboard tree with search, rename, delete, and
   selection behavior.
5. Allow non-conflicting branch runs while rejecting true path conflicts.
6. Make branch delete explicit, owner-only, subtree-aware, and safe around
   active runs and the current active path.
7. Add a graph overview that exposes the whole conversation branch topology and
   lets a user click a leaf to switch chat state.
8. Preserve the linked-context panel by keeping all branch inventory inside the
   existing `Context` / `Forks` surface.
9. Keep the implementation direct: local code, clear API shapes, no generic
   graph framework, no speculative adapters.

## Non-Goals

- Do not add fork-as-separate-chat.
- Do not add branch feature flags or legacy payload acceptance.
- Do not keep `indexOf` as a compatibility fallback for mapped quote offsets.
- Do not add saved highlights for assistant-answer selections.
- Do not add a graph library unless the direct SVG/HTML implementation proves
  insufficient during implementation.
- Do not render full nested transcripts inside message rows or graph nodes.
- Do not make the graph replace the tree; the Forks panel exposes both views.
- Do not allow prompt assembly to include sibling branch messages.
- Do not make branch delete silently switch the requesting viewer to a different
  path.

## Final State

The chat surface has three coordinated views over the same durable message tree:

- **Transcript**: one selected path, rendered as normal chat.
- **Inline fork strips**: branch points beside assistant messages on the
  selected path.
- **Forks panel**: management view with searchable keyboard tree and graph
  overview.

Every clickable fork or graph leaf has a full cached path. Activating it updates
the visible transcript in the same event turn, persists the active leaf through
`POST /conversations/:id/active-path`, and reconciles with the backend response.
If a path is not cached, the UI does not render it as a clickable switch target.

Assistant-answer selection anchors are either:

- `mapped`: exact source offsets validated against the parent assistant message,
  or
- `unmapped`: exact selected text plus rendered prefix/suffix, with no claimed
  source offsets.

Mapped and unmapped are both explicit states. Invalid mapped offsets are
request errors; they are never silently downgraded to unmapped.

## Target Behavior

### Quote Anchors

1. User selects text inside a complete assistant answer.
2. The selection popover appears only when the selection is fully inside that
   assistant answer.
3. The branch draft includes:
   - `kind: "assistant_selection"`
   - `message_id`: the parent assistant message id
   - `exact`: selected visible text
   - `prefix` and `suffix`: nearby rendered text, not guessed source text
   - `offset_status`: `"mapped"` or `"unmapped"`
   - `start_offset` and `end_offset` only when `offset_status` is `"mapped"`
   - `client_selection_id`
4. The frontend marks the selection `mapped` only when the selected visible text
   maps to exactly one source span in `message.content` and the source slice
   exactly equals `exact`.
5. Repeated source text, markdown-only ambiguity, or source mismatch creates an
   `unmapped` anchor with no offsets.
6. The backend validates:
   - parent exists and is a complete assistant message
   - `branch_anchor.message_id == parent_message_id`
   - `mapped` anchors have integer offsets within the answer length
   - `parent.content[start_offset:end_offset] == exact`
   - provided source prefix/suffix, when present on a mapped anchor, align with
     the source text around the offsets
   - `unmapped` anchors do not include offsets
   - `exact` is non-empty after trimming and below the branch-anchor length cap
7. Prompt assembly renders the stored quote anchor exactly once as a mandatory
   branch-anchor context block.

### Immediate Fork Switching

1. `ConversationPaneBody` stores a path cache keyed by leaf message id.
2. `GET /conversations/:id/tree` returns the selected path, fork options, graph
   overview, and cached full paths for every rendered switch target.
3. Clicking an inline fork preview or graph leaf:
   - reads the full path from the path cache
   - replaces the transcript immediately
   - updates active fork and graph state immediately
   - scrolls to the branch point when the branch point exists in the old path,
     otherwise keeps the top of the new path stable
   - posts the selected leaf to `/active-path`
4. If the active-path response differs from the optimistic path, the response
   wins and the transcript is replaced with the backend path. This is
   reconciliation, not a fallback append path.
5. Failed persistence restores the previous selected path and shows the typed
   error.

### Spec-Grade Fork Strip

1. Assistant messages with fewer than two user children show no strip.
2. The strip renders as a compact horizontal list of real buttons.
3. Each preview shows:
   - branch title when present
   - user reply preview
   - selected assistant quote preview when present
   - active/current marker
   - assistant status
   - message count
   - created date
4. Visual text is truncated to one or two lines, but each button has an
   accessible label containing the full branch title, full user reply preview,
   status, message count, date, and active state.
5. Keyboard behavior:
   - Tab enters the strip.
   - ArrowLeft and ArrowRight move between previews.
   - Home and End move to first and last preview.
   - Enter and Space activate the focused preview.
6. The active preview uses `aria-current="true"` and does not rely only on
   color.

### Fork Panel Tree

The Forks panel keeps the existing search, rename, delete, and select controls,
but the tree becomes a complete keyboard tree pattern.

Rules:

- `role="tree"` wraps the visible tree rows.
- Each row uses `role="treeitem"`, `aria-level`, `aria-selected`, and
  `aria-expanded` when it has children.
- Child rows are wrapped in `role="group"` when expanded.
- Roving `tabIndex` keeps only one treeitem in the tab order.
- ArrowDown and ArrowUp move through visible rows.
- ArrowRight expands a collapsed row or moves to the first child.
- ArrowLeft collapses an expanded row or moves to the parent.
- Home and End move to first and last visible rows.
- Enter and Space switch to the row's branch leaf.
- F2 starts rename for the active tree row.
- Delete opens explicit branch delete confirmation for the active tree row.
- Escape closes rename mode or clears pending delete confirmation.
- Search updates visible rows, highlights matches, and announces result count
  through an `aria-live` region.
- Rename and delete icon buttons remain reachable by Tab for users who do not
  use tree shortcuts.

### Graph Overview

The Forks panel adds a `Tree` / `Graph` segmented control under the existing
`Context` / `Forks` toggle.

Graph behavior:

1. The graph shows the whole conversation branch topology using compact nodes
   and connector lines.
2. Nodes are laid out by depth from root and stable DFS order. The active path
   is visually emphasized.
3. Branch points show their number of outgoing replies.
4. Leaf nodes are real buttons. Clicking a leaf switches the selected path using
   the same immediate path cache as the fork strip.
5. Keyboard users can tab through graph leaves in visual order and activate
   them with Enter or Space.
6. Search highlights matching leaves and branch nodes. Non-matching nodes remain
   visible when needed to preserve the path structure.
7. The graph does not render full transcripts, only compact titles, reply
   previews, quote previews, status, and count metadata.

Implementation choice:

- Use direct HTML plus a simple SVG edge layer in
  `ForkGraphOverview.tsx`.
- Do not add React Flow, D3, Dagre, Mermaid, or a generic graph adapter in this
  pass.
- Keep layout deterministic and local: depth columns, DFS rows, fixed node
  dimensions, and edges derived from the same flat overview rows used by the
  tree.

### Branch-Path-Specific Busy Checks

Conversation-wide busy checks are removed from chat-run creation.

Rules:

- A send is valid when its parent is a complete assistant message in the same
  conversation and the rate limiter allows the run.
- Active runs in sibling branches do not block creating a new branch.
- Active runs below a different child of the same assistant do not block
  creating another child branch.
- Existing scoped conversations with messages still require `conversation_id`
  and `parent_message_id`; scope-only sends never append to an existing scoped
  conversation.
- Branch delete rejects any subtree containing a non-terminal chat run.
- Active-path switching is allowed while other branches stream.
- The frontend can tail multiple active runs, but only runs whose branch leaf is
  on or selected into the current path update the visible transcript.

This is branch-path-specific because conflicts are determined by the requested
parent and affected subtree, not by the conversation id alone.

### Branch Delete

Delete remains hard delete with explicit cleanup.

Rules:

- Only the conversation owner can delete a branch.
- The branch id is the branch user message id.
- Delete confirmation names the branch title or full user reply preview and
  states the subtree message count.
- Backend rejects delete when:
  - the branch does not exist
  - the branch is outside the conversation
  - the branch subtree contains a non-terminal chat run
  - the requesting viewer's active leaf is inside the branch subtree
- For other viewers whose active leaf is inside the deleted subtree, cleanup is
  explicit: update their active leaf to the deleted branch's parent assistant
  before deleting message rows.
- Delete removes branch metadata, active-path rows, chat runs, run events,
  prompt assemblies, message contexts, tool calls, retrievals, evidence rows,
  object links, message LLM rows, and messages in one service-owned transaction.
- Delete never silently changes the requesting viewer's active path. The UI must
  switch away first.

## Data Contracts

### Assistant Selection Anchor

```ts
type AssistantSelectionBranchAnchorRequest = {
  kind: "assistant_selection";
  message_id: string;
  exact: string;
  prefix: string | null;
  suffix: string | null;
  offset_status: "mapped" | "unmapped";
  start_offset?: number | null;
  end_offset?: number | null;
  client_selection_id: string;
};
```

Hard-cutover rules:

- `offset_status` is required.
- `message_id` is required.
- `mapped` requires `start_offset` and `end_offset`.
- `unmapped` rejects non-null offsets.
- Unknown keys are request errors.

### Conversation Tree Response

Replace the first-pass response with a graph-aware tree response.

```ts
interface ConversationTreeResponse {
  conversation: ConversationSummary;
  selected_path: ConversationMessage[];
  active_leaf_message_id: string | null;
  fork_options_by_parent_id: Record<string, ForkOption[]>;
  path_cache_by_leaf_id: Record<string, ConversationMessage[]>;
  branch_graph: BranchGraph;
  page: { before_cursor: string | null };
}

interface BranchGraph {
  nodes: BranchGraphNode[];
  edges: BranchGraphEdge[];
  root_message_id: string | null;
}

interface BranchGraphNode {
  id: string;
  message_id: string;
  parent_message_id: string | null;
  leaf_message_id: string;
  role: "user" | "assistant";
  depth: number;
  row: number;
  title: string | null;
  preview: string;
  branch_anchor_preview: string | null;
  status: "complete" | "pending" | "error" | "cancelled";
  message_count: number;
  child_count: number;
  active_path: boolean;
  leaf: boolean;
  created_at: string;
}

interface BranchGraphEdge {
  from: string;
  to: string;
}
```

Rules:

- `path_cache_by_leaf_id` includes every `leaf_message_id` referenced by a
  clickable `ForkOption` or graph leaf.
- `branch_graph.nodes` uses message ids as stable node ids unless a visual
  aggregate node is unavoidable. Aggregate nodes should be avoided in the first
  pass.
- `leaf_message_id` is the message id passed to `/active-path`.
- The backend decides active path truth; frontend optimistic state is
  reconciled against the response.

## API Contracts

Existing routes remain, but their contracts become stricter:

- `GET /conversations/:id/tree`
  - returns selected path, fork options, branch graph, and path cache.
- `POST /conversations/:id/active-path`
  - accepts `active_leaf_message_id`
  - validates the leaf is in the conversation
  - returns the full graph-aware tree response
- `GET /conversations/:id/forks?search=...`
  - returns fork rows using the same preview/title/status semantics as graph
  - search includes title, reply text, quote text, and assistant text
- `PATCH /conversations/:id/forks/:branch_id`
  - renames branch metadata only
- `DELETE /conversations/:id/forks/:branch_id`
  - performs validated hard delete and returns 204

No new fork-as-chat route is added.

## Backend Architecture

### `conversation_branches.py`

Owns:

- path loading and validation
- branch graph query/build
- path cache query/build
- active path persistence
- fork list/search
- rename
- delete
- subtree active-run checks
- current-viewer active-path delete guard

Keep this service explicit. It may have small local functions for repeated tree
queries and output shaping, but no generic tree framework.

### `chat_runs.py`

Owns:

- parent validation
- branch-anchor validation call
- removal of conversation-wide busy checks for anchored sends
- scoped-conversation hard-cutover rules
- active leaf persistence after run creation

### `context_assembler.py`

Owns:

- rendering mapped and unmapped assistant-selection anchors
- including exactly one branch-anchor block for the current user message
- preserving branch-path-only history

### `conversation_memory.py`

Keeps path-aware memory filtering. Add tests only if busy/delete/graph changes
touch memory inclusion.

### Errors

Add typed branch errors to `ApiErrorCode` instead of overloading every branch
failure as `E_INVALID_REQUEST`:

- `E_BRANCH_PATH_INVALID`
- `E_BRANCH_ANCHOR_INVALID`
- `E_BRANCH_DELETE_ACTIVE_PATH`
- `E_BRANCH_HAS_ACTIVE_RUN`

Map invalid path and invalid anchor to 400. Map delete-active-path and active
run conflicts to 409.

## Frontend Architecture

### `ConversationPaneBody.tsx`

Owns:

- graph-aware tree load
- `pathCacheByLeafId`
- immediate selected-path replacement
- active-path persistence and reconciliation
- branch-point scroll restoration
- passing graph data to `ConversationContextPane`

### `ForkStrip.tsx`

Owns:

- spec-grade fork preview rendering
- full accessible labels
- roving focus inside the strip
- activation callbacks only; no API calls

### `ConversationForksPanel.tsx`

Owns:

- `Tree` / `Graph` segmented control
- shared search state
- tree keyboard state
- rename/delete UI state
- passing graph leaf activation to parent

### `ForkGraphOverview.tsx`

New component.

Owns:

- deterministic depth/row layout
- SVG connector layer
- compact leaf buttons
- active-path styling
- search highlighting
- leaf activation callbacks

### `MessageRow.tsx`

Owns:

- assistant selection capture
- robust mapped/unmapped anchor creation
- branch draft creation

Selection code should stay local unless it becomes hard to test. If extraction
is needed, use one small file such as
`apps/web/src/lib/conversations/assistantSelection.ts` with focused tests. Do
not add a generic selection framework.

### `BranchAnchorPreview.tsx`

Shows:

- parent assistant sequence
- selected quote or parent answer preview
- mapped/unmapped marker only when useful for debugging user trust
- remove button

## Files

Backend:

- `python/nexus/errors.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/services/conversation_branches.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/conversations.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_context_assembler.py`
- new or extended branch service route tests
- migration only if persisted data must be normalized for new hard-cutover
  anchor shape

Frontend:

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/ForkStrip.tsx`
- `apps/web/src/components/chat/ForkStrip.module.css`
- `apps/web/src/components/chat/ConversationForksPanel.tsx`
- `apps/web/src/components/chat/ConversationForksPanel.module.css`
- `apps/web/src/components/chat/ForkGraphOverview.tsx`
- `apps/web/src/components/chat/ForkGraphOverview.module.css`
- `apps/web/src/components/chat/BranchAnchorPreview.tsx`
- `apps/web/src/components/ConversationContextPane.tsx`
- `apps/web/src/components/chat/ChatContextDrawer.tsx`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/conversations/branching.ts`
- optional `apps/web/src/lib/conversations/assistantSelection.ts`
- focused component and unit tests for all touched behavior

## Key Decisions

- Use the existing message tree tables. No second branch-tree persistence model.
- Keep branch ids equal to branch user message ids.
- Add `offset_status` and `message_id` to assistant-selection anchors as
  required hard-cutover fields.
- Use path caching to make clickable branch switches immediate.
- Render graph overview with direct HTML/SVG, not a graph dependency.
- Reject current active branch deletion instead of silently moving the
  requesting viewer.
- Allow sibling active runs; conflict checks are tied to parent validity and
  destructive subtree operations.
- Keep all branch management in the existing context surface.

## Acceptance Criteria

### Backend

- Existing conversation sends without `parent_message_id` fail.
- Sends with a complete assistant parent succeed even when a sibling branch has
  an active run.
- Sends with incomplete, non-assistant, missing, or cross-conversation parents
  fail with typed errors.
- Mapped quote anchors persist only when offsets exactly match parent content.
- Repeated selected text that cannot be uniquely source-mapped is stored as
  `unmapped`, without offsets.
- Backend rejects `mapped` anchors with wrong offsets, wrong message id,
  missing offsets, or mismatched exact text.
- Prompt assembly includes the selected quote block and excludes sibling branch
  history.
- Tree response includes graph nodes, graph edges, and cached paths for every
  clickable leaf.
- Active-path response returns the graph-aware tree response.
- Delete rejects current-viewer active branch deletion.
- Delete rejects branches with active runs in the subtree.
- Delete hard-removes the subtree and all dependent rows in one explicit
  transaction.

### Frontend

- Selecting repeated assistant text creates an unmapped anchor, not wrong
  offsets.
- Selecting uniquely mapped assistant text creates a mapped anchor with correct
  offsets.
- Clicking an inline fork preview changes the transcript before the active-path
  request resolves.
- Failed active-path persistence restores the previous path and shows an error.
- Fork strip shows title/reply/quote/status/message count/date/current state and
  exposes full labels.
- Fork strip ArrowLeft/ArrowRight/Home/End/Enter/Space behavior works.
- Fork panel tree implements roving focus and Arrow/Home/End/Enter/F2/Delete
  behavior.
- Search filters/highlights tree and graph results and announces counts.
- Graph overview renders nodes and edges, highlights active path, and switches
  transcript state when a leaf is clicked.
- Mobile drawer exposes the same tree, graph, search, rename, delete, and
  switching operations as desktop.

### End To End

- A user can create a root chat, fork from an old assistant message, create a
  quote-anchored branch, switch between branches from the strip, switch from the
  graph, rename a branch, search for it, and delete an inactive branch.
- A branch created from an old assistant does not include later sibling
  corrections, preferences, or decisions in prompt history.
- A graph leaf click changes the visible selected path and remains selected
  after reload.

## Verification Commands

- `make check-back`
- `make type-back`
- `cd apps/web && bun run typecheck`
- `cd apps/web && bun run lint`
- focused frontend unit/browser tests for branching components
- focused backend DB tests for branch services and chat-run creation
- migration tests if anchor normalization or branch constraints change
- at least one Playwright or browser-flow test covering graph leaf switching

## Implementation Order

1. Tighten backend schemas and typed errors for branch anchors and delete.
2. Implement backend anchor validation, graph response, path cache, and
   branch-path busy/delete rules.
3. Update frontend types and tree loading to consume graph-aware responses.
4. Implement immediate path switching from cached paths.
5. Fix assistant selection mapping and branch-anchor payload creation.
6. Upgrade ForkStrip metadata and keyboard behavior.
7. Upgrade Forks tree keyboard behavior.
8. Add ForkGraphOverview.
9. Add tests for each target behavior.
10. Run the full verification set and remove any unused compatibility code.

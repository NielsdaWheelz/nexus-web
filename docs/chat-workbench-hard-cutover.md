# Chat Workbench Hard Cutover

## Role

This document is the target-state plan for replacing the current chat surface
with a production-grade, branch-aware, source-grounded workbench.

The final product is not a generic messenger. It is a versioned research and
reasoning workspace:

- one active transcript path rendered as a readable document
- first-class forks with immediate path switching
- one clear composer with explicit branch mode
- inline citations backed by durable source references
- evidence available on demand through progressive disclosure
- no leaked implementation/debug state in the default reading path

This document supersedes the chat-specific UX guidance in
`chat-branching-hard-cutover.md`,
`chat-branching-sota-completion-hard-cutover.md`, and
`visual-refactor-1b-hard-cutover.md` where they conflict. Branch-switch viewport
behavior is superseded by `chat-branch-switch-viewport-hard-cutover.md`.
Backend branch and evidence data contracts from those documents remain valid
unless this document explicitly replaces them.

## Hard-Cutover Policy

This is a hard cutover. The final state keeps no legacy chat surface, no mixed
old/new evidence panel, no fallback branch UI, and no compatibility layer for
old visual behavior.

- No feature flags.
- No query-param toggles.
- No environment gates.
- No old evidence panel hidden behind a prop.
- No old message row kept as a wrapper.
- No fallback from branch switching to append-at-tail behavior.
- No separate "fork as chat copy" path as the primary branch model.
- No raw debug evidence fields in the default UI.
- No duplicate old/new tests. Rewritten behavior gets rewritten tests.
- No backward-compatible aliases for replaced frontend component APIs.
- No partial shipping where old and new chat views can both be reached.

The branch may land as several commits for review, but the merge target is one
coherent cutover.

## Context

The backend already exposes most of the durable primitives needed for the target
experience:

- `GET /conversations/:id/tree` returns the selected path, fork options, path
  cache, active leaf, and branch graph.
- `POST /conversations/:id/active-path` persists viewer-local active path state
  and returns a reconciled tree.
- `GET /conversations/:id/forks` supports fork search.
- `PATCH /conversations/:id/forks/:branch_id` renames forks.
- `DELETE /conversations/:id/forks/:branch_id` deletes inactive fork subtrees.
- `MessageOut` includes `evidence_summary`, `claims`, and flat
  `claim_evidence`.
- Chat run creation already accepts `parent_message_id` and `branch_anchor`.

The current frontend exposes these primitives too literally:

- evidence summaries and claim evidence render fully expanded inline
- internal fields like `support_status`, `retrieval_status`,
  `included_in_prompt`, and `score` appear as primary UI
- fork switching uses cached paths, but older scroll behavior can reset or stale
  the user's visible reading context during comparison
- branch authoring is represented as a small chip inside the normal composer,
  which makes the interaction easy to miss and easy to misunderstand
- user and assistant messages share too much visual treatment
- fork controls are present, but the whole experience reads as accumulated
  implementation surfaces instead of one designed workflow

## Goals

1. Make chat feel like a professional versioned workbench, not a generic chat
   skin.
2. Keep all existing branch, evidence, citation, model, web-search, and context
   capabilities.
3. Render one active transcript path and make path changes feel immediate
   without losing reading context.
4. Switch branches synchronously from cached paths and preserve the visible
   viewport by semantic anchor when possible.
5. Make branch creation explicit without placing a full input in the middle of
   the transcript.
6. Make user prompts and assistant answers visually distinct while preserving a
   document-first reading model.
7. Put source trust in the main flow through inline citations.
8. Move evidence detail behind accessible progressive disclosure.
9. Keep branch inventory and management in the existing context/forks side
   surface on desktop and mobile.
10. Protect unsent drafts from being sent to hidden or stale branch parents.
11. Keep frontend code local, typed, and direct. Do not introduce a graph or
    state-management framework for this pass.
12. Add tests for the user-visible behavior, not implementation details.

## Non-Goals

- Do not redesign the backend message-tree schema.
- Do not add branch copying as a replacement for tree-structured branching.
- Do not introduce consumer messaging-style right-aligned bubbles as the default
  transcript model.
- Do not add a global "developer mode" or preferences system for evidence
  visibility in this pass.
- Do not replace the citation persistence contract.
- Do not add React Flow, D3, Dagre, Mermaid, or a graph layout package.
- Do not implement branch diff/compare.
- Do not implement multi-branch merge.
- Do not redesign the model/provider settings architecture beyond the composer
  presentation needed for this cutover.
- Do not change quote-to-chat reader semantics except where the composer UI must
  display attached context consistently.
- Do not preserve old snapshots or tests that assert the removed visual shape.

## Final State

A user opens a conversation and sees one clean transcript path. User prompts are
visually identifiable prompt blocks. Assistant replies read as document prose
with inline citation controls. The transcript does not show implementation
badges or raw evidence diagnostics.

If an assistant answer has forks, a compact fork strip appears below that
answer. Selecting a fork immediately replaces the transcript with that branch,
preserves the visible viewport by semantic anchor when possible, updates active
branch indicators, and then persists the active leaf. Backend reconciliation may
replace the optimistic state, but it must not introduce a top jump or visible
append fallback.

If the user chooses "Fork" or "Fork from selection", the sticky composer enters
branch mode. The composer shows a clear branch header with the parent message
and selected quote when present. The user writes in the same sticky composer,
not in an inline input embedded in the transcript. Sending creates a new child
branch under the selected assistant message.

Evidence is visible in two layers:

- inline citations in the answer for fast source inspection
- a collapsed evidence disclosure below the answer for deeper review

Opening the evidence disclosure reveals claim support, source snippets, and
links. Secondary diagnostics are behind a nested details control and never
appear as primary UI.

Desktop exposes branch inventory through the existing side rail's `Context` /
`Forks` modes. Mobile exposes the same inventory and operations through the
existing drawer shell. Both surfaces support branch search, tree navigation,
graph navigation, rename, delete, and active-path selection.

## Product Rules

### Hierarchy

The interface hierarchy is:

1. transcript content
2. current branch/path state
3. attached context and inline citations
4. evidence summary
5. evidence details
6. retrieval/debug diagnostics

Lower layers must not visually dominate higher layers.

### Branches

- A conversation is a message tree.
- The transcript renders exactly one selected path.
- Branch switching is navigation, not filtering.
- Branch switching uses cached full paths only.
- A fork or graph leaf without a cached path is not rendered as an enabled
  switch target.
- Clicking a branch target replaces the transcript in the same event turn.
- Branch switching preserves visible viewport context by semantic anchor when
  possible.
- If no semantic anchor exists in the next path, branch switching preserves the
  current scroll offset subject to normal browser clamping.
- Branch switching updates active fork and graph states immediately.
- Branch switching persists through `POST /conversations/:id/active-path`.
- Persistence failure restores the previous path and shows typed feedback.
- Backend reconciliation wins over optimistic frontend state.
- No branch switch may leave the composer pointing at a hidden branch parent.

### Drafts

- Normal continuation drafts are keyed by active leaf message id.
- Branch drafts are keyed by parent assistant message id and anchor identity.
- Switching branches stores the current draft locally and restores the draft for
  the next active path when one exists.
- A branch draft whose parent is not visible in the new active path is suspended,
  not silently reused.
- Sending always uses the parent shown by the composer header.
- Clearing branch mode does not clear attached reader/context chips.

### Evidence

- Inline citations are the primary evidence affordance.
- Evidence panels are collapsed by default.
- The collapsed evidence row shows human labels only.
- The default evidence row may show support state, supported/total claims, source
  count, and retrieval availability.
- Raw field names are not shown in default UI.
- Retrieval score, `selected`, `included_in_prompt`, resolver status, prompt
  assembly id, and source version are secondary diagnostics.
- Secondary diagnostics render only inside a nested disclosure labelled
  `Details`.
- Missing or unavailable sources render as explicit muted states.
- Source links and reader-jump controls remain available when resolvable.
- Evidence controls use real buttons with `aria-expanded`.

### Transcript

- User and assistant messages share the document column but not the same visual
  treatment.
- User messages render as compact prompt blocks with a visible `You`
  attribution.
- Assistant messages render as document body text with no avatar and no
  assistant label.
- System messages remain quiet, centered, and low emphasis.
- Pending assistant messages use a gutter cue, not a spinner or status sentence.
- Timestamps appear on hover/focus and remain accessible.
- Long messages cannot create horizontal overflow.

### Composer

- There is exactly one primary composer per chat surface.
- The composer is sticky at the bottom of the chat scrollport.
- The composer does not render inline under historical assistant messages.
- Branch mode has a dedicated header, not only a chip.
- The branch header shows:
  - branch action label
  - parent message sequence or stable display label
  - parent answer preview
  - selected quote preview when present
  - cancel control
  - optional jump-to-parent control when the parent is visible
- Attached context remains in the context chip rail.
- Model settings remain behind the existing settings popover/sheet.
- Send button accessible label changes in branch mode to `Send fork reply`.

### Mobile

- Mobile has feature parity for fork inventory and branch switching.
- Mobile branch switching closes the drawer before replacing the transcript.
- Mobile evidence disclosure works in-place under the assistant answer.
- Mobile composer branch mode uses the same content hierarchy as desktop.
- No desktop-only operation is required to rename, delete, search, or switch
  branches.

### Accessibility

- Disclosures use buttons with `aria-expanded` and `aria-controls`.
- Fork strips use real buttons with `aria-current` for the active branch.
- Fork strip keyboard behavior supports Tab, ArrowLeft, ArrowRight, Home, End,
  Enter, and Space.
- The fork tree follows the WAI tree pattern: `role="tree"`,
  `role="treeitem"`, `aria-level`, `aria-selected`, `aria-expanded`, and roving
  tab index.
- Search result counts announce through `aria-live`.
- Dialogs/sheets trap focus where modal.
- Hover-only information is also available by focus or click.
- Reduced-motion users do not receive nonessential animation.

## Target Behavior

### 1. Loading A Conversation

1. The conversation pane calls `GET /conversations/:id/tree`.
2. The selected path renders as the transcript.
3. The active leaf id initializes the composer draft key.
4. Fork options and graph nodes hydrate the inline fork strips and side panel.
5. Evidence state initializes collapsed for all assistant messages.
6. Active runs visible in the selected path tail as streaming messages.
7. If the conversation cannot load, a `FeedbackNotice` renders in the chat
   primary column.

### 2. Switching Forks Inline

1. User activates a fork button under an assistant answer.
2. The handler reads `path_cache_by_leaf_id[fork.leaf_message_id]`.
3. If no path exists, the button was disabled and no action fires.
4. Current composer draft state is saved under its current draft key.
5. The transcript is replaced with the cached path synchronously.
6. Active leaf, selected path ids, fork strip state, and graph state update
   synchronously.
7. The current viewport anchor is restored in the next layout pass.
8. The composer restores the draft for the new active leaf or enters an empty
   normal continuation state.
9. The pane posts `POST /conversations/:id/active-path`.
10. If the response differs, the response tree replaces optimistic state and the
    viewport remains anchored.
11. If persistence fails, the previous path, draft state, and viewport are
    restored and feedback is shown.

### 3. Switching Forks From The Panel Or Graph

1. Desktop users open the side rail and choose `Forks`.
2. Mobile users open the context drawer and choose `Forks`.
3. The user searches, navigates the tree, or activates a graph leaf.
4. Activation follows the same branch switch flow as inline fork activation.
5. Mobile drawer closes before transcript replacement.
6. Rename and delete operate only on inactive branches.
7. Delete confirmation states the branch title/preview and subtree message count.
8. Backend delete errors render as typed inline feedback.

### 4. Forking From An Assistant Message

1. User hovers or focuses a complete assistant message.
2. A small `Fork` action appears below or beside the message body.
3. Activating it creates a branch draft anchored to that assistant message.
4. The sticky composer enters branch mode and focuses the textarea.
5. The branch header shows the parent answer preview.
6. The user writes a reply.
7. Sending posts `parent_message_id` and an `assistant_message` branch anchor.
8. On chat-run creation, the selected path switches to the new branch immediately.
9. The parent assistant's fork strip includes the new branch.
10. The composer exits branch mode after the send is accepted.

### 5. Forking From A Selection

1. User selects text fully inside a complete assistant answer.
2. A compact selection popover appears.
3. Activating `Fork from selection` creates an `assistant_selection` branch
   draft.
4. The composer branch header shows the selected quote before the parent preview.
5. Sending posts `parent_message_id` and the selection branch anchor.
6. The backend validates mapped/unmapped anchor fields.
7. Prompt assembly includes the branch quote exactly once.
8. Assistant-answer selections do not create saved highlights or reader objects.

### 6. Reading Evidence

1. Assistant answer renders with inline citations when claim evidence exists.
2. A compact collapsed evidence row appears below the assistant answer.
3. The collapsed row reads like product copy, not a schema dump.
4. Activating the row expands the evidence inspector.
5. Expanded view groups evidence by claim.
6. Each claim shows support state, claim text, and source snippets.
7. Each source item offers a reader jump, external link, or unavailable state.
8. A nested `Details` disclosure exposes diagnostics.
9. Collapsing the evidence inspector returns the answer to a readable transcript
   shape.

### 7. Normal Continuation

1. If no branch draft is active, the composer replies to the latest complete
   assistant message on the active path.
2. Existing-conversation sends include the active-path parent message id and an
   `assistant_message` branch anchor.
3. Root conversation creation keeps the root/no-parent behavior.
4. Active runs in sibling branches do not globally block composing.

## Frontend Architecture

### Ownership

`ConversationPaneBody` owns:

- loading `/tree`
- selected path state
- path cache
- active leaf id
- optimistic branch switching
- branch-switch viewport transition state
- backend reconciliation
- draft key persistence across path switches
- desktop/mobile rail wiring

`ChatSurface` owns:

- one scroll region
- one message log
- transcript column layout
- composer slot placement
- load-older control
- empty state placement

`MessageRow` owns:

- role dispatch only
- stable `data-message-id`
- passing message data to role-specific renderers

`UserMessage` owns:

- user attribution
- user prompt block
- user-attached citation row
- user error feedback
- user timestamp placement

`AssistantMessage` owns:

- assistant answer body
- streaming gutter cue
- assistant selection capture
- selection popover
- fork action
- inline fork strip placement
- evidence disclosure placement
- assistant error feedback
- assistant timestamp placement

`SystemMessage` owns:

- quiet system copy
- system error feedback

`AssistantEvidenceDisclosure` owns:

- collapsed evidence summary row
- expanded claim evidence inspector
- nested diagnostics disclosure
- source activation callbacks

`ChatComposer` owns:

- content drafting
- branch mode header
- context chip rail
- send payload construction
- model settings popover/sheet
- send/cancel interaction

`ComposerContextRail` owns:

- attached context and scope chips only
- no branch header rendering

`ForkStrip` owns:

- compact inline branch choices
- active state
- keyboard behavior
- accessible labels

`ConversationContextPane` owns:

- desktop `Context` / `Forks` mode shell
- existing context view
- fork panel host

`ChatContextDrawer` owns:

- mobile drawer presentation
- mobile close-on-branch-select behavior

`ConversationForksPanel` owns:

- branch tree
- branch graph
- search
- rename
- delete confirmation
- branch selection

### Data Flow

```text
GET /conversations/:id/tree
  -> ConversationPaneBody
  -> ChatSurface
  -> MessageRow
  -> UserMessage | AssistantMessage | SystemMessage

Fork activation
  -> ConversationPaneBody.switchToLeaf
  -> cached selected path replacement
  -> viewport anchor restoration
  -> POST /active-path
  -> reconciled tree replacement

Fork authoring
  -> AssistantMessage creates BranchDraft
  -> ChatComposer branch header
  -> POST /chat-runs with parent_message_id + branch_anchor
  -> selected path switches to new run branch

Evidence rendering
  -> AssistantMessage
  -> AssistantEvidenceDisclosure
  -> ReaderCitation / source activation
```

### Component Files

Create:

- `apps/web/src/components/chat/UserMessage.tsx`
- `apps/web/src/components/chat/UserMessage.module.css`
- `apps/web/src/components/chat/AssistantMessage.tsx`
- `apps/web/src/components/chat/AssistantMessage.module.css`
- `apps/web/src/components/chat/SystemMessage.tsx`
- `apps/web/src/components/chat/SystemMessage.module.css`
- `apps/web/src/components/chat/StreamingGutterCue.tsx`
- `apps/web/src/components/chat/StreamingGutterCue.module.css`
- `apps/web/src/components/chat/AssistantEvidenceDisclosure.tsx`
- `apps/web/src/components/chat/AssistantEvidenceDisclosure.module.css`
- `apps/web/src/components/chat/BranchComposerHeader.tsx`
- `apps/web/src/components/chat/BranchComposerHeader.module.css`
- `apps/web/src/lib/conversations/evidenceDisplay.ts`
- `apps/web/src/lib/conversations/draftKeys.ts`

Modify:

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/MessageRow.module.css`
- `apps/web/src/components/chat/ForkStrip.tsx`
- `apps/web/src/components/chat/ForkStrip.module.css`
- `apps/web/src/components/chat/ConversationForksPanel.tsx`
- `apps/web/src/components/chat/ConversationForksPanel.module.css`
- `apps/web/src/components/chat/ForkGraphOverview.tsx`
- `apps/web/src/components/chat/ForkGraphOverview.module.css`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/ChatComposer.module.css`
- `apps/web/src/components/chat/ComposerContextRail.tsx`
- `apps/web/src/components/chat/ComposerContextRail.module.css`
- `apps/web/src/components/ConversationContextPane.tsx`
- `apps/web/src/components/chat/ChatContextDrawer.tsx`
- `apps/web/src/lib/conversations/branching.ts`
- `apps/web/src/lib/conversations/display.ts`
- `apps/web/src/lib/conversations/types.ts` only if stronger frontend-only
  display types are needed

Delete or reduce to a thin role dispatcher:

- old evidence rendering helpers embedded in `MessageRow.tsx`
- old branch-chip-only branch mode presentation in `ChatComposer.tsx`
- old message-row CSS that makes role treatment indistinct
- old evidence badge CSS that exposes schema/debug fields as primary UI

Do not leave deprecated exports behind.

### Backend Files

No backend schema change is required for the cutover.

Backend files remain contract owners:

- `python/nexus/schemas/conversation.py`
- `python/nexus/services/conversation_branches.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/context_assembler.py`

Backend changes are allowed only if an existing contract cannot express a
required visible state. Any backend change must follow `docs/rules/layers.md`.

## Visual Structure

### Transcript Column

- Uses a centered readable column.
- Does not use nested cards for page sections.
- Message blocks define vertical rhythm.
- Fixed-width controls cannot resize the transcript when labels change.
- Mobile width uses the full safe content width.

### User Prompt Block

User messages render with:

- muted `You` attribution
- compact prompt body
- subtle left rule or light surface tint
- no avatar
- no right alignment
- no large bubble radius
- attached citation controls before or within the prompt block

### Assistant Answer

Assistant messages render with:

- no avatar
- no assistant label
- document typography
- inline citations
- fork controls below the answer body
- evidence disclosure below fork controls
- timestamp on hover/focus

### Evidence Disclosure

Collapsed row content:

- `Evidence`
- support label
- supported claim count
- source count
- unavailable/no-evidence state when applicable

Expanded content:

- short evidence summary
- claim cards or rows
- grouped source snippets
- source actions
- nested diagnostic `Details`

Diagnostic content:

- raw support/retrieval/verifier states
- included/excluded prompt status
- score
- resolver status
- source version
- prompt assembly id

### Branch Composer Header

Branch mode header renders above the textarea and below any high-level composer
error.

It contains:

- branch icon
- "Fork reply" label
- parent message label
- selected quote preview when anchor kind is `assistant_selection`
- parent preview
- cancel button
- optional jump-to-parent button

It does not replace the context chip rail. Branch mode is attachment state, not
source context.

## Key Decisions

1. **Document workbench over bubbles.** This product handles long answers,
   citations, sources, and branch navigation. Right-aligned messenger bubbles
   reduce readability and waste horizontal space.
2. **Preserve viewport on branch switch.** A branch switch changes the selected
   path, but the user's visible reading context should remain stable when the
   next path can represent the same semantic anchor.
3. **One composer.** Inline historical composers create focus, layout, and send
   target ambiguity. Branch mode belongs in the sticky composer with a strong
   header.
4. **Branch header, not branch chip.** A chip is too small for the semantic risk
   of changing the send parent.
5. **Evidence collapsed by default.** Evidence is essential for trust, but full
   evidence details are secondary to reading the answer.
6. **Diagnostics are secondary.** Retrieval internals are useful for debugging,
   not for default user comprehension.
7. **Existing branch API stays.** The backend already supports tree, path cache,
   active path, forks, graph, and branch anchors.
8. **No graph framework.** The existing branch graph is compact and deterministic
   enough for direct HTML/SVG.
9. **No hidden enabled targets.** If a branch leaf cannot switch immediately from
   cache, it is disabled or omitted as a switch action.
10. **Accessibility is a product requirement.** Disclosure, branch tree, graph
    leaf buttons, and fork strips must be keyboard-operable.

## Implementation Order

### Step 1 - Branch Navigation Semantics

- Change branch switching to preserve viewport anchors as specified by
  `chat-branch-switch-viewport-hard-cutover.md`.
- Keep optimistic cached path replacement.
- Keep backend reconciliation.
- Disable or omit switch targets without cached paths.
- Add local draft key helpers.
- Store/restore composer drafts across path switches.
- Ensure branch drafts do not survive into paths where their parent is hidden.

### Step 2 - Message Role Split

- Create `UserMessage`, `AssistantMessage`, `SystemMessage`, and
  `StreamingGutterCue`.
- Collapse `MessageRow` into a role dispatcher.
- Move assistant selection logic into `AssistantMessage`.
- Move user citation rendering into `UserMessage`.
- Strip indistinct role styling from `MessageRow.module.css`.
- Apply the new transcript visual hierarchy.

### Step 3 - Evidence Disclosure

- Create `AssistantEvidenceDisclosure`.
- Move evidence summary, claim, and evidence item logic out of `MessageRow`.
- Render evidence collapsed by default.
- Add nested diagnostic details.
- Replace raw field-name badges with human labels.
- Preserve citation source activation and reader pulse behavior.

### Step 4 - Branch Composer Mode

- Create `BranchComposerHeader`.
- Render branch header in `ChatComposer` when `branchDraft` is active.
- Remove branch header responsibility from `ComposerContextRail`.
- Keep scope/context chips in one rail.
- Update send accessible label and send payload construction.
- Add cancel and optional jump-to-parent controls.

### Step 5 - Fork UI Polish

- Tighten `ForkStrip` visual density.
- Remove hidden/debug leaf-id display from visual structure.
- Preserve full accessible labels.
- Improve active/current marker.
- Keep keyboard behavior.
- Tighten `ConversationForksPanel` tree/graph density and empty/error states.

### Step 6 - Tests And Screenshots

- Rewrite component tests for the new message and evidence shape.
- Add branch switch viewport preservation tests.
- Add branch composer mode tests.
- Add evidence collapsed/expanded tests.
- Preserve fork strip and fork panel keyboard tests.
- Update or delete obsolete screenshots.

## Acceptance Criteria

### Branch Switching

- Activating an enabled inline fork replaces the transcript before the
  `/active-path` response resolves.
- Activating an enabled graph leaf replaces the transcript before the
  `/active-path` response resolves.
- After any branch switch, the viewport remains anchored when possible and does
  not reset to top unless it was already at top or browser clamping requires it.
- If the backend returns a different selected path, the backend path replaces
  optimistic state and the viewport remains anchored.
- If persistence fails, the previous path is restored and typed feedback is
  visible.
- Fork/graph targets without cached paths are not enabled.
- Switching branches cannot send a draft to a hidden parent.

### Branch Authoring

- Complete assistant messages expose a compact fork action on hover/focus.
- Selecting assistant text exposes `Fork from selection`.
- Branch mode focuses the sticky composer.
- Branch mode shows a branch header with parent preview.
- Selection branch mode shows selected quote preview.
- Branch mode can be cancelled.
- Sending in branch mode includes `parent_message_id` and the correct
  `branch_anchor`.
- No inline full composer appears inside historical transcript content.

### Transcript Visuals

- User messages are visually distinct from assistant answers.
- Assistant answers retain document readability.
- User messages are not right-aligned messenger bubbles.
- Pending assistant messages show only the gutter cue.
- No role-level background, border, or radius from the removed message-row shape
  remains in `MessageRow.module.css`.
- Long messages and long source titles do not create horizontal overflow.

### Evidence

- Evidence summary and claim details are collapsed by default.
- The collapsed evidence row uses a real button with `aria-expanded`.
- Expanded evidence shows grouped claims and source snippets.
- Inline citations still show hover/focus previews.
- Clickable citations still dispatch reader pulse behavior.
- Raw field names such as `support_status`, `retrieval_status`,
  `included_in_prompt`, and `verifier_status` are not visible in the collapsed
  default UI.
- Raw diagnostics are visible only inside nested `Details`.
- Evidence with unavailable sources renders an explicit unavailable state.

### Fork Inventory

- Desktop `Forks` panel supports tree, graph, search, rename, delete, and branch
  selection.
- Mobile drawer supports the same operations.
- Fork strip supports keyboard navigation with ArrowLeft, ArrowRight, Home, End,
  Enter, and Space.
- Active fork state uses `aria-current` and a non-color-only visual marker.
- Delete is blocked or guarded for active-path branches.
- Delete confirmation states the subtree impact.

### Accessibility

- All disclosure controls expose correct `aria-expanded` state.
- Fork tree uses valid tree roles and roving tab index.
- Search result count is announced through `aria-live`.
- Hover preview content is available by keyboard focus.
- Modal mobile surfaces close on Escape and restore body scroll.
- Reduced-motion preferences disable nonessential animation.

### Testing Gates

Required local gates before merge:

```bash
cd apps/web
bun run typecheck
bun run lint
bun run test:unit
bun run test:browser
```

Run e2e coverage when the branch touches pane routing, mobile drawer behavior,
or reader citation pulse integration.

## Test Plan

Frontend unit/browser tests:

- `MessageRow` dispatches to role renderers.
- `UserMessage` renders attribution, prompt body, citations, and error feedback.
- `AssistantMessage` renders answer body, fork action, selection popover, fork
  strip, and evidence disclosure.
- `AssistantEvidenceDisclosure` is collapsed by default, expands on click, and
  hides diagnostics until `Details` opens.
- `ChatComposer` renders branch header in branch mode and sends the correct
  payload shape.
- `ChatComposer` cancellation clears only branch mode, not attached context.
- `ForkStrip` keyboard behavior remains intact.
- `ConversationForksPanel` tree behavior remains intact.
- Branch switch handler preserves viewport context and restores the previous
  viewport on failure.

E2E tests:

- create a conversation, fork from an older assistant answer, and verify the new
  branch becomes the selected path
- switch between forks from inline strip and verify the transcript does not reset
  to top
- switch between forks from mobile drawer and verify drawer closes
- fork from selected assistant quote and verify composer branch header includes
  the selected quote
- expand evidence and activate a reader citation

## Deletion Checklist

- Remove old evidence rendering from `MessageRow.tsx`.
- Remove old evidence badge CSS from `MessageRow.module.css`.
- Remove branch-as-chip-only branch mode from `ChatComposer.tsx`.
- Remove tests that assert always-expanded evidence.
- Remove tests that assert branch switch scrolls to top or to a last shared
  message.
- Remove snapshots that pin the old message row visual shape.
- Remove unused imports and dead styles after component extraction.

## Risks

- Evidence disclosure can hide important trust signals if collapsed row labels
  are too vague. The collapsed row must include support state and counts.
- Draft preservation across path switches can introduce stale draft bugs if keys
  are not explicit. Draft key helpers must be pure and tested.
- Splitting `MessageRow` can regress citation activation if source-target
  helpers move without tests.
- Mobile drawer branch switching can race close animation and transcript
  replacement. The state update must not wait for animation.
- Hiding diagnostics by default can slow debugging. Nested `Details` keeps the
  information available without making it primary product UI.

## Definition Of Done

- The old chat visual shape cannot be reached.
- Branch switching feels like immediate navigation.
- The viewport remains anchored after branch switches.
- User and assistant messages are unmistakably different.
- Branch mode is explicit in the composer.
- Evidence is inspectable without dominating the answer.
- Fork inventory works on desktop and mobile.
- Accessibility contracts are covered by tests.
- No old/new compatibility path remains.
- Required frontend gates pass.

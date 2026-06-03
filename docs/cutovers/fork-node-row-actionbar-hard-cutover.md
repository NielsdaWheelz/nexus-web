# Fork Node Row ActionBar Hard Cutover

Status: draft implementation spec
Date: 2026-06-03
Owner: web app / conversation forks UI
Scope: `apps/web` conversation fork tree row actions, active-path delete
eligibility, tree keyboard containment, focused tests, and the fork action
descriptor contract

## 1. Thesis

`ForkNodeRow` currently hand-renders a compact icon action group with local
`Button` elements for rename, delete, save, and cancel. The app already has a
shared compact action renderer: `ActionBar`, backed by the same
`ActionMenuOption` descriptor model used by `ActionMenu`.

This is not just a renderer cleanup. The current fork row also repeats
active-path delete eligibility in two places and lets row-level tree keyboard
handling surround nested controls. A professional cutover must collapse these
concerns to their owners:

- `ActionBar` owns compact icon action rendering.
- chat/conversation code owns fork action descriptors.
- a pure conversation helper owns active-path fork membership.
- `useForkTreeKeyNav` owns tree keyboard behavior and explicitly excludes nested
  interactive controls from row navigation.
- `ForkNodeRow` owns row semantics, layout, edit field, recursive rendering, and
  inline delete confirmation.

This is a hard cutover:

- no fork-only inline action button lane
- no wrapper that duplicates `ActionBar`
- no feature flag
- no old/new renderer branch
- no compatibility prop
- no test-only hook, marker, or handler
- no local active-path recomputation after a shared helper exists
- no swallowing keyboard conflicts with broad `stopPropagation` hacks

## 2. Governing Rules And Standards

Repo rules:

- `docs/rules/cleanliness.md`: one owner per concern, collapse repeated derived
  logic, delete legacy and fallback lanes, and do not keep duplicate state
  machines.
- `docs/rules/module-apis.md`: expose each capability in one primary form and
  reuse an existing module capability instead of introducing a near-duplicate.
- `docs/rules/codebase.md`: default functionality to internal unless it is
  clearly external; do not import private component helpers across module
  boundaries.
- `docs/rules/correctness.md`: expected states must be modeled; trusted values
  must be canonical after their boundary.
- `docs/rules/typescript.md`: prefer type shapes that make invalid states hard
  to express.
- `docs/rules/testing_standards.md`: frontend interaction and accessibility
  behavior belongs in Vitest Browser Mode using role/label queries; tests should
  cover public behavior, not internal wiring.
- `docs/architecture.md`: chat branching is a frontend chat surface owned under
  `components/chat/*` and `lib/conversations/*`; UI primitives live in
  `components/ui/*`.
- `apps/web/README.md`: `src/components/` owns UI components and
  `src/lib/highlights/`/`src/lib/conversations/` own domain utilities.

External accessibility targets:

- WAI-ARIA APG Tree View pattern: the tree owns arrow, Home/End, expand/collapse,
  and selectable treeitem behavior.
- WAI-ARIA APG Toolbar pattern: a widget called a toolbar has a distinct
  keyboard contract. Current `ActionBar` is not a toolbar; it is a labelled group
  of native buttons.
- WCAG 2.2 SC 2.1.1 Keyboard and SC 2.4.3 Focus Order: nested row controls must
  remain operable by keyboard and must not unexpectedly trigger row navigation or
  branch switching.

References:

- https://www.w3.org/WAI/ARIA/apg/patterns/treeview/
- https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
- https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html
- https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html

## 3. Current State

### 3.1 Shared Action Primitives

Owner today:

- `apps/web/src/components/ui/ActionBar.tsx`
- `apps/web/src/components/ui/ActionBar.module.css`
- `apps/web/src/components/ui/ActionMenu.tsx`

Current `ActionBar` contract:

- accepts `ActionMenuOption[]`
- renders nothing for an empty option list
- renders a labelled `role="group"`
- maps each option `label` to `aria-label` and `title`
- renders icon-only `Button` controls
- supports `disabled`
- supports `pressed` via `aria-pressed`
- supports `separatorBefore`
- supports `tone="danger"` as a filled danger button
- supports `render` options as anchored popover dialogs
- stops click propagation before calling `onSelect`

Important limitation:

- `ActionBar` does not implement `href` or `restoreFocusOnClose`, even though the
  shared `ActionMenuOption` model includes those fields for `ActionMenu`.
- `ActionBar` does not implement toolbar keyboard behavior and must not be
  documented or tested as a `role="toolbar"` widget unless that capability is
  intentionally added later.
- `ActionBar` does not stop keydown propagation. The surrounding owner must
  decide whether bubbling keys are meaningful.

### 3.2 Existing Descriptor Patterns To Reuse

Strongest local pattern:

- `apps/web/src/components/highlights/highlightActions.tsx`
- `apps/web/src/components/highlights/HighlightActionBar.tsx`
- `apps/web/src/components/highlights/highlightActions.test.ts`

The highlight action model has the shape this cutover should reuse:

- one pure builder owns action order, labels, icons, gating, tone, disabled, and
  pressed state
- a small rendering component delegates to `ActionBar` or `ActionMenu`
- callers pass semantic handlers
- tests assert descriptor output and user-visible behavior, not JSX internals

Other similar patterns:

- `apps/web/src/lib/actions/resourceActions.ts` builds `ActionMenuOption[]` for
  resource, library, podcast, and conversation actions.
- `apps/web/src/components/ui/SurfaceHeader.tsx` and
  `apps/web/src/components/ui/AppList.tsx` accept `ActionMenuOption[]` and render
  shared menu primitives instead of local per-row menus.
- `apps/web/src/components/palette/paletteActions.ts` keeps palette item action
  derivation pure and separate from controller/rendering behavior.

Conclusion:

- fork row actions should have a chat-local pure descriptor builder
- the builder should return the shared action descriptor shape
- no new generic "row action bar" component is justified
- no fork-only rendering primitive is justified

### 3.3 Fork Row UI

Owners today:

- `apps/web/src/components/chat/ForkNodeRow.tsx`
- `apps/web/src/components/chat/ForkTreeView.tsx`
- `apps/web/src/components/chat/ConversationForksPanel.module.css`

Current behavior:

- `ForkTreeView` renders `role="tree"` with `aria-label="Conversation forks"`.
- `ForkNodeRow` renders each row as `role="treeitem"`.
- `ForkNodeRow` computes active-in-path state from:
  - `node.active`
  - `activeLeafMessageId`
  - `selectedPathMessageIds`
  - `node.leaf_message_id`
  - `node.user_message_id`
  - `node.assistant_message_id`
- non-edit rows render a title button if the fork is switchable
- edit rows render a textarea
- action buttons are hand-rendered:
  - `Rename fork {title}`
  - `Delete fork {title}`
  - `Save fork {title}`
  - `Cancel rename fork {title}`
- delete is disabled on active-path rows
- delete confirmation is inline, row-local, and accessible:
  - `role="group"`
  - `aria-label` with title, reply, optional quote, and subtree size
  - `aria-describedby` pointing at hidden detail text
  - visible copy: `Delete this fork and N messages?`
  - destructive commit button: `Delete`
  - cancel button: `Cancel`
- child rows recurse under `role="group"`.

### 3.4 Fork Panel State And Mutations

Owners today:

- `apps/web/src/components/chat/useForkPanel.ts`
- `apps/web/src/components/chat/ConversationForksPanel.tsx`

Current behavior:

- fetches server fork search results and falls back to tree data already present
  in the conversation response
- owns submitted search state, edit state, pending delete state, error state,
  and expanded ids
- sends PATCH for rename
- sends DELETE for delete
- blocks deletion for active-path forks by re-deriving an active-path condition
  from `fork.active` and `selectedPathMessageIds`

Defect:

- `useForkPanel` does not include `activeLeafMessageId` in its deletion guard,
  while `ForkNodeRow` includes it in its disabled state.
- UI and mutation layers can disagree about whether a fork is deletable.
- the same derived concept has two owners.

### 3.5 Tree Keyboard Behavior

Owner today:

- `apps/web/src/components/chat/useForkTreeKeyNav.ts`

Current behavior:

- ArrowUp/ArrowDown rove focus between visible rows
- Home/End jump to first/last visible row
- ArrowRight expands or moves to child
- ArrowLeft collapses or moves to parent
- Enter/Space selects a switchable fork
- F2 starts rename
- Delete requests delete
- Escape cancels rename or pending delete

Defect:

- row key handling is attached to the treeitem article
- nested controls live inside that article
- `ActionBar` stops click propagation but not keydown propagation
- keyboard activation or editing keys inside nested controls can bubble into tree
  navigation unless tree handling explicitly ignores nested interactive targets

## 4. Final State

The final state has one fork action model and one action renderer:

- `ForkNodeRow` no longer imports action icons for rename/delete/save/cancel.
- `ForkNodeRow` no longer hand-renders those compact action buttons.
- fork row action descriptors are built by one chat-owned pure function.
- compact row actions render through `ActionBar`.
- `ActionBar` remains a generic UI primitive and does not learn fork concepts.
- delete confirmation remains inline in `ForkNodeRow`.
- active-path membership is computed by one pure conversation helper.
- `useForkPanel` mutation guards and `ForkNodeRow` disabled state consume the same
  active-path helper.
- tree keyboard behavior ignores nested interactive controls for row navigation
  keys, while preserving Escape cancellation for edit/delete state.
- exact user-visible labels and accessible names stay stable.
- tests cover the behavior at the smallest meaningful owner.

## 5. Capability Contracts

### 5.1 Fork Active-Path Contract

Capability:

- determine whether a fork belongs to the currently selected active path

Owner:

- preferred: `apps/web/src/lib/conversations/forkPath.ts`
- acceptable if the implementation keeps the tree model together:
  `apps/web/src/lib/conversations/forkTree.ts`

Public API:

```ts
export interface ForkPathMembershipInput {
  fork: Pick<
    ForkOption,
    "active" | "leaf_message_id" | "user_message_id" | "assistant_message_id"
  >;
  activeLeafMessageId?: string | null;
  selectedPathMessageIds: ReadonlySet<string>;
}

export function isForkInActivePath(input: ForkPathMembershipInput): boolean;
```

Rules:

- The helper is pure.
- It performs no normalization and no null coercion outside the declared shape.
- It accepts a `ReadonlySet` so callers cannot mutate the selected path through
  the helper.
- It is the only source of this active-path membership calculation.
- It is used by `ForkNodeRow` and `useForkPanel`.
- No component imports this helper through another component module.

Expected implementation semantics:

```ts
return (
  fork.active ||
  fork.leaf_message_id === activeLeafMessageId ||
  selectedPathMessageIds.has(fork.leaf_message_id) ||
  selectedPathMessageIds.has(fork.user_message_id) ||
  (fork.assistant_message_id
    ? selectedPathMessageIds.has(fork.assistant_message_id)
    : false)
);
```

### 5.2 Fork Node Action Descriptor Contract

Capability:

- derive the compact action descriptors for a fork tree row

Owner:

- `apps/web/src/components/chat/forkNodeActions.tsx`

Public API:

```ts
export type ForkNodeActionInput =
  | {
      mode: "view";
      title: string;
      deleteDisabled: boolean;
      handlers: {
        onStartRename: () => void;
        onRequestDelete: () => void;
      };
    }
  | {
      mode: "edit";
      title: string;
      handlers: {
        onSaveRename: () => void;
        onCancelRename: () => void;
      };
    };

export function buildForkNodeActions(input: ForkNodeActionInput): ActionMenuOption[];
```

Rules:

- The builder is pure with respect to inputs. It does not read React state, DOM,
  browser globals, route state, or APIs.
- It returns a new descriptor array for the supplied state.
- It uses the existing lucide icons:
  - `Pencil` for rename
  - `Trash2` for request delete
  - `Check` for save
  - `X` for cancel
- It preserves exact labels:
  - `Rename fork {title}`
  - `Delete fork {title}`
  - `Save fork {title}`
  - `Cancel rename fork {title}`
- View mode returns exactly `rename` and `delete`.
- Edit mode returns exactly `save` and `cancel`.
- Delete action disabled state comes from `deleteDisabled`.
- The request-delete action must not perform the destructive delete directly. It
  only opens the row-owned confirmation.
- The destructive commit remains the confirmation `Delete` button.
- The request-delete action should not set `tone="danger"` unless product design
  intentionally wants a filled danger icon button in every row. This cutover is
  not a visual redesign.
- The builder must not use `href`, `render`, or `restoreFocusOnClose`; those are
  not fork row action capabilities.

### 5.3 Fork Row Rendering Contract

Owner:

- `apps/web/src/components/chat/ForkNodeRow.tsx`

Rules:

- Row semantics remain in the row:
  - `role="treeitem"`
  - `tabIndex`
  - `aria-level`
  - `aria-selected`
  - `aria-expanded`
- The row computes `activeInPath` only by calling the shared helper.
- The row derives `title` exactly as it does today unless a separate title
  contract change is approved.
- The row passes action descriptors to:

```tsx
<ActionBar
  options={actions}
  label="Fork actions"
  className={styles.actions}
/>
```

- `styles.actions` remains the row layout slot.
- `ActionBar` owns the inner compact button group styling.
- Delete confirmation remains row-local and unchanged in accessible meaning.
- The row may keep using `Button` for delete confirmation actions.
- The row must not keep a local action button branch for rename/delete/save/cancel.

### 5.4 Tree Keyboard Contract

Owner:

- `apps/web/src/components/chat/useForkTreeKeyNav.ts`

Rules:

- Tree navigation keys apply when focus is on the treeitem row itself.
- Tree navigation keys do not apply when the event target is inside a nested
  interactive control:
  - `button`
  - `a[href]`
  - `input`
  - `textarea`
  - `select`
  - `[role="button"]`
  - `[role="menuitem"]`
  - `[contenteditable="true"]`
- Enter and Space on nested buttons must activate the button only, not select the
  fork.
- Delete inside the rename textarea must edit text only, not request fork delete.
- Arrow keys inside the rename textarea must move text cursor only, not move tree
  focus.
- Escape may remain a row-level cancel key for edit/delete state if explicitly
  tested. If the implementation chooses to ignore Escape inside nested controls,
  it must provide another tested keyboard path to cancel edit/delete state.
- The key-nav hook must not import helpers from `ForkNodeRow`.

## 6. File Plan

### 6.1 Add

- `apps/web/src/components/chat/forkNodeActions.tsx`
  - pure fork action descriptor builder
  - lucide icon ownership for fork row actions
- `apps/web/src/components/chat/forkNodeActions.test.ts`
  - action ids
  - exact labels
  - disabled delete
  - mode split
  - no unsupported option fields
- `apps/web/src/lib/conversations/forkPath.ts`
  - pure active-path membership helper
- `apps/web/src/lib/conversations/forkPath.test.ts`
  - active flag
  - active leaf match
  - selected leaf/user/assistant matches
  - inactive fork
  - null assistant id

If implementation keeps the active-path helper inside `forkTree.ts`, add tests to
`apps/web/src/lib/conversations/forkTree.test.ts` instead of creating
`forkPath.test.ts`.

### 6.2 Update

- `apps/web/src/components/chat/ForkNodeRow.tsx`
  - remove hand-rendered compact action buttons
  - remove action icon imports from this file
  - import `ActionBar`
  - import `buildForkNodeActions`
  - import shared active-path helper
  - use `ActionBar` for compact row actions
  - preserve delete confirmation group
- `apps/web/src/components/chat/useForkPanel.ts`
  - accept `activeLeafMessageId`
  - use shared active-path helper for delete guard
  - remove local duplicate guard expression
- `apps/web/src/components/chat/ConversationForksPanel.tsx`
  - pass `activeLeafMessageId` into `useForkPanel`
- `apps/web/src/components/chat/useForkTreeKeyNav.ts`
  - remove imports from `ForkNodeRow`
  - move `treeItemDomId` and `toForkOption` to a non-render helper module if the
    hook still needs them
  - ignore nested interactive targets for tree navigation keys
- `apps/web/src/components/chat/ConversationForksPanel.module.css`
  - keep `.actions` as row layout only
  - adjust only if `ActionBar` changes row alignment or wrapping
- `apps/web/src/components/chat/ConversationForksPanel.test.tsx`
  - preserve current behavior assertions
  - add nested-control keyboard assertions
  - add active delete button disabled assertion if not already covered at
    component level
  - add cancel-confirm click assertion if touched
- `apps/web/src/components/ui/ActionBar.test.tsx`
  - add focused coverage for the shared behavior now relied on by fork rows:
    disabled options, group label, `title`, stopPropagation, and `triggerEl`

### 6.3 Optional Documentation

- `docs/modules/chat.md`
  - only after implementation, add a concise module contract that conversation
    fork row actions are descriptor-owned and rendered by shared action UI
    primitives
  - do not duplicate this cutover spec there

## 7. Key Decisions

### Decision 1: Use `ActionBar`, Not `ActionMenu`

Fork row actions are always visible compact controls. They are not overflow menu
commands, not links, and not menuitems. `ActionBar` is the correct primitive.

### Decision 2: Keep Delete Confirmation Out Of `ActionBar`

The delete confirmation is not an action descriptor. It is row-local conditional
UI with rich accessible context. Moving it into `ActionBar.render` would turn a
shared compact button group into a fork-specific confirmation owner and would
weaken the current accessible group contract.

### Decision 3: Do Not Make `ActionBar` A Toolbar

The current component renders `role="group"` and native buttons. That is valid
for compact actions. Renaming it semantically to a toolbar would require roving
focus and toolbar keyboard behavior. This cutover does not add that capability.

### Decision 4: Delete Gating Is A Domain Helper, Not Row State

Whether a fork is on the active path affects both UI affordance and mutation
safety. That makes it a conversation contract, not a row-only visual condition.

### Decision 5: Keyboard Conflicts Are Solved At The Tree Owner

Nested controls are valid inside the row. The tree navigation owner must know
when a key event belongs to a nested control. Adding scattered
`stopPropagation()` to every child control would create a brittle local patch.

### Decision 6: No New Generic Row Action Abstraction

There are not enough distinct row action families to justify another generic
primitive. The existing generic primitive is `ActionBar`; the missing piece is a
fork-owned descriptor builder.

## 8. Composition With Other Systems

### 8.1 Conversation Branching

No backend branch behavior changes:

- no schema changes
- no API route changes
- no active-path endpoint changes
- no fork list/search endpoint changes
- no branch graph changes
- no chat run behavior changes

The cutover only changes frontend ownership of row action rendering and shared
frontend active-path derivation.

### 8.2 Conversation Secondary Pane

`ConversationForksPanel` remains the secondary surface body mounted by
`Conversation`. The pane system contract does not change:

- `conversation-forks` remains the surface id
- desktop secondary pane behavior remains unchanged
- mobile secondary dialog behavior remains unchanged
- pane chrome toggle behavior remains unchanged

### 8.3 Inline Fork Previews

`ForkStrip` is out of scope. It owns inline branch switching under assistant
messages and uses a separate horizontal roving selection model. It should not be
folded into `ActionBar`.

### 8.4 Shared UI Primitives

`ActionBar` remains shared and fork-agnostic. This cutover may add tests for
behavior `ActionBar` already implements, but it must not add fork-specific props,
fork-specific classes, or fork-specific semantics to `ActionBar`.

### 8.5 Resource And Highlight Actions

Existing resource and highlight action builders remain unchanged. The fork
builder should copy the pattern, not share a new generic builder that would blur
feature ownership.

## 9. Target Behavior

### 9.1 View Mode Row

For a switchable inactive row:

- title button is visible and selectable
- action group is labelled `Fork actions`
- `Rename fork {title}` button starts rename
- `Delete fork {title}` button opens inline confirmation
- Enter/Space on the title selects the fork
- Enter/Space on the action buttons activates only the action button
- Delete key on the row opens confirmation
- Delete key on the delete action button does not also trigger row delete through
  a bubbled key event

For an active-path row:

- row remains marked selected/active exactly as today
- `Delete fork {title}` is disabled
- keyboard Delete on the row shows `Switch away from this fork before deleting
  it.`
- click/keyboard activation of the disabled delete action cannot open
  confirmation

### 9.2 Edit Mode Row

When rename starts:

- textarea receives focus as today
- action group is labelled `Fork actions`
- `Save fork {title}` saves the current edit title
- `Cancel rename fork {title}` exits edit mode
- Delete in the textarea edits text only
- Arrow keys in the textarea move the text cursor only
- Enter/Space in the textarea do not select the fork
- Escape cancellation behavior is preserved and tested

### 9.3 Delete Confirmation

When delete is requested for a deletable fork:

- inline confirmation group appears under the same row
- group accessible name includes:
  - confirmation phrase
  - title
  - reply preview
  - quote preview when present
  - subtree message count
- `aria-describedby` points at hidden detail text
- visible copy remains `Delete this fork and N messages?`
- `Delete` sends DELETE and removes the row on success
- `Cancel` closes the confirmation without mutation
- failed DELETE leaves the row available and shows `Fork delete failed.`

## 10. Non-Goals

- no backend API changes
- no database changes
- no branch graph redesign
- no inline `ForkStrip` redesign
- no pane shell or mobile secondary pane changes
- no new generic action framework
- no conversion of `ActionBar` to `role="toolbar"`
- no overflow menu behavior for fork row actions
- no visual redesign beyond layout adjustments required by the shared renderer
- no new compatibility branch for old fork action markup
- no additional docs that duplicate this cutover spec

## 11. Acceptance Criteria

### 11.1 Structure

- `ForkNodeRow` compact row actions render through `ActionBar`.
- `ForkNodeRow` has no local JSX branch for rename/delete/save/cancel icon
  buttons.
- action icons for rename/delete/save/cancel live in the fork action descriptor
  builder.
- `ForkNodeRow` may still use `Button` for delete confirmation.
- `useForkTreeKeyNav` does not import from `ForkNodeRow`.
- active-path membership is implemented once and imported by all callers.
- no new feature flag, compatibility prop, fallback path, or duplicate renderer
  exists.

### 11.2 Behavior

- existing fork action accessible names remain stable.
- active-path delete disabled state and mutation guard agree.
- row keyboard navigation still works.
- nested action buttons do not select forks.
- nested textarea keys do not navigate/delete/select unexpectedly.
- delete confirmation accessible details remain stable.
- rename success and failure behavior remain stable.
- delete success, cancel, and failure behavior remain stable.

### 11.3 Tests

- pure active-path helper tests pass.
- pure fork action builder tests pass.
- `ConversationForksPanel` browser tests cover:
  - tree navigation
  - action click behavior through `ActionBar`
  - active delete disabled state
  - nested-control keyboard containment
  - rename save/failure
  - delete confirm/cancel/success/failure as applicable
- `ActionBar` tests cover the shared behaviors fork rows rely on.
- existing E2E fork coverage remains green.

### 11.4 Verification Commands

Focused frontend verification:

```bash
cd apps/web
bunx vitest run --project browser src/components/chat/ConversationForksPanel.test.tsx src/components/ui/ActionBar.test.tsx
bunx vitest run src/components/chat/forkNodeActions.test.ts src/lib/conversations/forkPath.test.ts
bunx tsc --noEmit
```

If the implementation changes visible row layout or hit targets, also run:

```bash
make test-e2e-ui
```

or the targeted Playwright conversations spec through the repo's e2e harness.

## 12. Implementation Sequence

1. Add the active-path membership helper and tests.
2. Add the fork node action builder and tests.
3. Move non-render row helpers out of `ForkNodeRow` if key-nav still needs them.
4. Update `useForkPanel` to accept `activeLeafMessageId` and consume the helper.
5. Update `ConversationForksPanel` to pass `activeLeafMessageId` into the panel
   hook.
6. Update `useForkTreeKeyNav` to ignore nested interactive controls for row
   navigation keys.
7. Replace `ForkNodeRow` local compact action button JSX with `ActionBar`.
8. Adjust row action layout CSS only if required by the shared renderer.
9. Expand component tests around nested keyboard handling and action behavior.
10. Expand `ActionBar` tests for the shared behaviors now relied on by fork rows.
11. Run focused verification.
12. Delete any leftover imports, helpers, styles, and test setup made obsolete by
    the cutover.

## 13. Risks And Mitigations

Risk: `ActionBar` changes visual density in fork rows.

- Mitigation: keep `.actions` as the row slot, use the existing `ActionBar`
  compact styles, and avoid visual redesign. Update CSS only for alignment.

Risk: nested buttons trigger row selection through bubbled Enter/Space.

- Mitigation: key-nav ignores events from nested interactive controls. Add tests.

Risk: rename textarea Delete opens fork delete confirmation.

- Mitigation: same key-nav containment. Add tests for Delete and arrow keys in
  the textarea.

Risk: UI disables delete for a fork that the mutation guard still allows.

- Mitigation: both paths use the same active-path helper, including
  `activeLeafMessageId`.

Risk: `ActionBar` unsupported option fields leak into fork actions.

- Mitigation: builder tests assert no `href`, `render`, or
  `restoreFocusOnClose` fields for fork row actions.

Risk: confirmation accessibility regresses during renderer replacement.

- Mitigation: keep confirmation markup row-local and preserve existing
  role/name/description tests.

## 14. SME Checklist

Before implementation is accepted, confirm:

- The diff removes more duplicated ownership than it adds.
- The shared UI primitive remains generic.
- The chat action descriptor builder is small, pure, and feature-owned.
- Active-path membership has one owner.
- Tree keyboard ownership is explicit and tested.
- No old fork action rendering code remains.
- Tests assert behavior through accessible names and public UI, not internals.
- The final result would still make sense if another compact fork action is added
  later.

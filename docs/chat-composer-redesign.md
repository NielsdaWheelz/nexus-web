# Chat Composer Redesign

## Purpose

Replace the current horizontally scrolling chat input controls with one compact,
mobile-safe composer.

This is a hard cutover. The final state has no legacy control bar, no
compatibility mode, no fallback composer, and no duplicate UI path.

## Goals

- Keep message entry as the dominant interaction.
- Keep all composer controls usable at `320px` width without horizontal scroll.
- Keep chat-run payload behavior unchanged.
- Keep the change local to the existing composer surface.
- Make the implementation easy to read in one pass.
- Prefer explicit local code over reusable-looking indirection.

## Target Behavior

- The composer renders as one rounded surface at the bottom of chat.
- Attached context chips render inside the composer surface above the textarea.
- The textarea remains multiline, auto-grows up to the existing maximum height,
  and keeps `Enter` to send and `Shift+Enter` for a newline.
- The send button remains visible and disabled until the message can be sent.
- The bottom action row wraps or compresses within the composer; it never
  requires horizontal scrolling.
- The visible model control is a compact summary button, for example:
  `GPT-5.5 / medium`.
- Activating the model summary opens one settings surface that controls:
  - provider,
  - model,
  - reasoning,
  - key mode.
- Web search is a compact visible mode control with the existing modes:
  `auto`, `required`, and `off`.
- Key mode is not a standalone long label in the primary row. It is shown in
  the settings surface and may appear as compact status text only when useful.
- Errors remain inline with the composer.
- Quote-chat and full-chat use the same composer.

## Final State

### Removed

- The old top-level `.composerControlBar`.
- Mobile `overflow-x: auto` for composer controls.
- Hidden mobile scrollbars for composer controls.
- Three always-visible native selects for provider, model, and reasoning.
- The always-visible `Only use my keys` checkbox row label.
- E2E selectors that depend on the send button being the textarea sibling.

### Kept

- `ChatComposer` owns model fetching, selected options, textarea state, send
  behavior, and context submission.
- `ChatSurface` owns transcript/composer layout and bottom pinning.
- `ContextChips` owns chip rendering.
- Chat-run request shape is unchanged.
- `/api/models` remains the only model list source.
- `/api/chat-runs` remains the only send endpoint.

## Architecture

`ChatComposer` remains the composer owner.

```text
ChatSurface
  renders composer slot

ChatComposer
  fetches models
  tracks selected provider/model/reasoning/key mode/web search
  renders composer shell
  sends ChatRunCreateRequest

ContextChips
  renders attached context chips
```

Do not add a shared composer framework, design-system wrapper, settings
registry, menu builder, view model, adapter, manifest, DSL, or generic utility.

Use existing components only when they already match the job. Do not contort a
shared component into a near-fit just to avoid local code.

## Structure

### Composer Shell

The shell contains, in order:

1. Inline error, if present.
2. Context chips, if present.
3. Textarea row.
4. Action row.

The shell is a single visual container. Page-level layout remains in
`ChatSurface`.

### Action Row

The action row contains:

- model settings trigger,
- web search control,
- optional compact key status,
- send button.

The row uses wrapping, truncation, and fixed-size icon buttons. It does not use
horizontal scrolling.

### Model Settings Surface

Desktop uses a local popover anchored to the model summary trigger. Mobile uses
a modal sheet-style dialog.

The settings surface contains native controls:

- provider select,
- model select,
- reasoning select,
- `Use my keys only` checkbox.

The desktop popover closes with `Escape`, outside pointer down, or a committed
selection. The mobile dialog closes with `Escape`, backdrop click, or its close
button.

## Rules

- Follow `docs/rules/codebase.md`: keep frontend work in `apps/web/` and use
  `@/` imports when imports would otherwise climb too far.
- Follow `docs/rules/layers.md`: client code calls `/api/*` only, except the
  existing streaming exception.
- Follow `docs/rules/module-apis.md`: expose one composer UI path, not old and
  new variants.
- Follow `docs/rules/simplicity.md`: do not add speculative props, options, or
  flags.
- Follow `docs/rules/control-flow.md`: branch explicitly on finite option sets.
- Follow `docs/rules/conventions.md`: keep one-use values inline unless the
  name carries real semantic value.
- Follow `docs/rules/testing_standards.md`: test user-visible behavior in
  browser-mode component tests and real-stack E2E where needed.

Implementation rules:

- No feature flag.
- No legacy class kept for compatibility.
- No separate `ChatComposerV2`.
- No one-use exported type.
- No one-use helper function unless it hides meaningful complexity.
- No one-use constant unless the name improves the usage site.
- No intermediate model object for selected settings.
- No extra request payload type beyond the existing `ChatRunCreateRequest`.
- No new shared menu/select abstraction.
- No stringly control registry.
- No CSS that hides horizontal scrollbars instead of removing overflow.

## Key Decisions

1. Keep the composer local.

   The problem is presentation and interaction density inside one component.
   A shared abstraction would make the code harder to audit.

2. Keep `ChatSurface` stable.

   It already provides the correct transcript/composer split and bottom pinning.
   Moving that behavior would expand the blast radius without improving the
   composer.

3. Use progressive disclosure for model settings.

   Provider, exact model, reasoning, and key mode are important, but they are
   not the primary task on every message. The primary row shows the selected
   state; the detailed controls live one action away.

4. Keep web search visible.

   Web search changes answer provenance and user expectation for freshness. It
   should remain directly discoverable.

5. Treat horizontal scroll as a defect.

   The composer is not a two-dimensional workspace. Controls must fit, wrap, or
   move into a settings surface.

6. Prefer native controls in the settings surface.

   Native selects are acceptable when not forced into a cramped always-visible
   row. Replace them only if native behavior cannot satisfy layout or
   accessibility.

7. Add stable accessible selectors.

   Tests should find the message textbox and send button by role/name, not by
   DOM adjacency.

## Files

### Update

- `apps/web/src/components/ChatComposer.tsx`
  - Remove the legacy control bar markup.
  - Render the composer shell and action row.
  - Render the model settings surface.
  - Keep send payload construction unchanged.
  - Add accessible names for compact controls.

- `apps/web/src/components/ChatComposer.module.css`
  - Remove legacy control-bar styles.
  - Remove mobile horizontal-scroll styles.
  - Add shell, action-row, compact-control, and settings-surface styles.
  - Ensure all controls fit at `320px`.

- `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx`
  - Update expectations only where labels or accessible names change.

- `e2e/tests/conversations.spec.ts`
  - Stop locating send by textarea sibling position.
  - Use role/name selectors.

### Add

- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
  - Browser-mode component tests for composer behavior and layout.

### Avoid Unless Proven Necessary

- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/components/chat/QuoteChatSheet.tsx`
- backend files
- migrations
- API schemas

## Acceptance Criteria

- No horizontal composer scroll exists at `320px`, `390px`, `640px`, or desktop
  pane widths.
- The old `.composerControlBar` selector is gone.
- The mobile composer CSS contains no `overflow-x: auto`.
- A user can send a message with the keyboard and with the visible send button.
- `Shift+Enter` inserts a newline.
- The send button has an accessible name.
- The model summary opens a settings surface.
- The settings surface can change provider, model, reasoning, and key mode.
- The selected settings produce the same `ChatRunCreateRequest` fields as
  before:
  - `model_id`,
  - `reasoning`,
  - `key_mode`,
  - `web_search.mode`.
- Web search modes still submit `auto`, `required`, and `off`.
- Attached contexts still submit through `contexts`.
- Quote-chat still shows the linked context chip before send.
- Existing chat, new chat, and quote-chat all use the same composer.
- Browser component tests cover send behavior, settings changes, context chip
  removal, and no-overflow layout.
- Targeted E2E covers real chat send selector stability.
- `bunx tsc --noEmit` passes in `apps/web`.
- `bun run lint` passes in `apps/web`.
- Targeted browser tests pass.

## Non-Goals

- Do not change chat-run persistence.
- Do not change backend schemas.
- Do not change SSE event shapes.
- Do not add attachments or file upload.
- Do not add voice input.
- Do not add prompt suggestions.
- Do not add model routing.
- Do not add rate-limit UI.
- Do not redesign message rows.
- Do not redesign chat history.
- Do not change mobile command palette behavior.
- Do not add a new design-system package.
- Do not create a generic popover/select/menu library.

## Implementation Order

1. Add a focused `ChatComposer` browser test that documents current send
   behavior and the intended no-overflow mobile layout.
2. Replace composer markup with the shell/action-row/settings-surface layout.
3. Delete legacy control-bar CSS.
4. Update selectors in existing tests.
5. Run targeted frontend typecheck, lint, and browser tests.
6. Run targeted conversations E2E if local services are available.

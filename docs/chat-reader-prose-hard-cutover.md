# Chat Reader Prose Hard Cutover

## Role

This document owns the target-state presentation for chat transcript messages
across full conversation panes, new chat panes, and embedded reader assistant
surfaces.

The goal is a hybrid between modern AI workbench UI and readable long-form
prose:

- assistant answers render like reader-grade document prose
- short user prompts are right-anchored prompt blocks
- long or structured user prompts become readable full-column prompt blocks
- role distinction is clear without turning the surface into a messenger skin

This document supersedes the transcript presentation guidance in
`docs/chat-workbench-hard-cutover.md` and
`docs/visual-refactor-1b-hard-cutover.md` where they conflict. Branching,
evidence contracts, citation contracts, reader rail behavior, and composer
docking remain owned by their existing hard-cutover documents unless this
document explicitly touches message presentation.

## Hard-Cutover Policy

This is a hard cutover.

- No feature flags.
- No query-param toggles.
- No environment gates.
- No old and new message layouts mounted in parallel.
- No compatibility prop for legacy message bubbles.
- No CSS classes retained only for the old bubble shape.
- No fallback to previous left-aligned user bubble behavior.
- No route-specific transcript variants for full chat, new chat, and reader
  assistant.
- No duplicate snapshots or tests that assert the removed visual model.
- No hidden preference for choosing messenger mode versus reader-prose mode.

The branch may land as multiple commits, but the merge target is one coherent
message presentation cutover.

## Context

Classic chat design systems use sender-right / recipient-left alignment because
it makes turn ownership immediately recognizable. That pattern works well for
short conversational exchange.

Modern AI workbench products split the problem differently. The prompt remains a
small steering artifact, while substantial AI output is treated as document,
artifact, answer, or canvas content. The product lesson is that an assistant
answer is often work product, not a received text message.

Reader-grade typography still has a stronger evidence base than messenger
styling for long answers:

- target line length around 45-75 characters, with roughly 66 characters as the
  practical sweet spot
- body text around 15-16px in app surfaces
- line height around 1.5-1.6
- left-aligned, ragged-right text
- block paragraph rhythm, not dense walls of text
- structured blocks like code, tables, and citations need their own width and
  overflow behavior

The current chat implementation already has a centered transcript column and
assistant answers without a bubble, but it still renders user messages as
left-aligned bubble-like blocks. This cutover makes the intended hybrid explicit.

## Goals

1. Make assistant answers as readable as the media reader without copying the
   media reader theme wholesale.
2. Keep user prompts instantly identifiable as the user's turns.
3. Right-anchor short user prompts inside the transcript column.
4. Prevent long, pasted, quoted, code-heavy, or multi-paragraph user prompts from
   being squeezed into narrow right-side bubbles.
5. Preserve a stable top-to-bottom reading path for assistant prose.
6. Preserve inline citations and evidence affordances near the claims they
   support.
7. Keep the same message rendering model across full chat, new chat, and
   embedded reader assistant.
8. Keep all message text left-aligned internally in left-to-right locales.
9. Avoid horizontal overflow in normal prose.
10. Improve code and table readability without widening ordinary paragraphs past
    reader measure.
11. Keep implementation local to chat presentation components and tests.
12. Add behavior-oriented tests for compact versus expanded user prompts,
    assistant prose measure, and structured block overflow.

## Non-Goals

- Do not redesign chat runs, SSE streaming, branch state, conversation trees, or
  backend message contracts.
- Do not replace `react-markdown` or citation parsing.
- Do not redesign `ChatComposer`.
- Do not change composer docking; it remains a reserved footer region outside
  the transcript scrollport.
- Do not make chat inherit the user's media reader profile, font family, theme,
  focus mode, or hyphenation setting.
- Do not introduce a second "reader mode" transcript route.
- Do not add an assistant avatar or assistant label to every answer.
- Do not make assistant answers right-aligned.
- Do not right-align the text inside user prompt blocks in left-to-right locales.
- Do not collapse or hide long user prompts by default.
- Do not add a global style preference for compact versus expanded prompts.
- Do not remove existing branch, evidence, citation, or timestamp functionality.

## Final State

A user opens any chat surface and sees one centered transcript column.

Assistant answers read as prose. They use a reader-grade measure, comfortable
font size, relaxed leading, clear paragraph rhythm, and markdown styling tuned
for long answers. They are not wrapped in a message bubble. The assistant's role
is implicit from placement, typography, actions, citations, and the absence of a
`You` attribution.

Short user turns render as compact prompt blocks anchored to the right edge of
the transcript column. The block carries a visible `You` attribution and subtle
prompt styling. Its text remains left-aligned. The block is visually a prompt
object, not a messenger bubble.

Long or structured user turns render as expanded prompt blocks. These occupy the
full readable column so pasted text, code, and multi-paragraph prompts do not
wrap into an unusable narrow measure. They still carry user prompt styling and a
`You` attribution, with prompt chrome biased toward the right edge so ownership
remains clear.

System messages remain quiet, centered, and low emphasis.

## Target Behavior

### Assistant Answers

- Assistant message body is left-aligned, ragged right.
- Normal prose width targets 60-70 characters per line.
- Body type uses app typography but approximates reader defaults:
  - font size: `var(--text-md)` or an equivalent 16px token
  - line height: 1.55-1.6
  - paragraph gap: one relaxed line or the nearest app spacing token
- Headings, lists, blockquotes, citations, code, and tables keep markdown
  semantics and readable spacing.
- Inline citations remain in the answer flow at the claim location.
- Evidence disclosure remains below the assistant answer.
- Message action rows, fork strips, and evidence disclosure must not compress
  the prose width.
- Pending assistant messages use the existing gutter cue, rendered against the
  prose column.

### Short User Prompts

Short user prompts are right-anchored prompt blocks.

A user prompt is compact when all of these are true:

- normalized visible text is at most 320 characters
- visible text contains no hard line break
- visible text does not contain a fenced code block marker
- visible text does not look like a markdown table
- visible text does not contain a long unbroken token over 80 characters

Compact prompt behavior:

- The outer message row spans the transcript column.
- The prompt block is aligned to the inline-end side in LTR layouts.
- Text inside the block remains left-aligned.
- Width is intrinsic up to a cap, not fixed.
- Max width is no more than 72% of the transcript column on desktop.
- Mobile max width may rise to 88-92% of the transcript column.
- The visual treatment is subtle:
  - visible `You` attribution
  - optional muted surface tint or one-pixel border
  - radius no larger than the app's small/medium radius
  - no speech-bubble tail
  - no saturated messenger color fill
- Citations attached to the user prompt sit with the prompt block and do not
  force assistant-style full width unless the prompt is expanded.

### Expanded User Prompts

Expanded user prompts are readable prompt blocks for substantial user input.

A user prompt is expanded when any compact condition fails.

Expanded prompt behavior:

- The prompt block uses the full transcript prose column.
- Text remains left-aligned.
- The `You` attribution and prompt actions sit in a compact header row.
- The header row may align its attribution/actions to inline-end to preserve the
  "my turn" signal.
- The prompt body uses readable line length and pre-wrap behavior.
- Multi-paragraph prompt bodies preserve author-entered line breaks without
  creating horizontal overflow.
- Fenced code or code-like content renders in a structured block when supported;
  otherwise it remains pre-wrapped and horizontally safe.
- Long unbroken tokens break safely.
- Expanded prompt blocks are never collapsed by default.

### Structured Assistant Blocks

- Code blocks are allowed to use more horizontal room than prose when the
  transcript column permits it.
- Tables scroll horizontally inside their own container instead of forcing the
  transcript to overflow.
- Inline code wraps safely when needed.
- Wide blocks must not change the prose measure for paragraphs above or below.
- Copy actions remain available for code blocks.

### Reader Assistant Rail

- `ReaderAssistantPane` uses the same message components and rules.
- The rail's narrower width naturally reduces line length; do not special-case
  it into a separate chat layout.
- Compact user prompts may occupy nearly full rail width on narrow rails.
- Assistant prose remains left-aligned and readable at rail width.
- Full-chat promotion does not change message presentation.

### Mobile

- Mobile uses the same compact versus expanded classification.
- Compact prompt blocks are right-anchored but capped to avoid extreme narrow
  wrapping.
- Expanded prompts are full-width.
- Assistant prose remains left-aligned and uses the available column.
- Safe-area behavior remains owned by `ChatSurface` and pane chrome.
- No mobile-only legacy bubble layout is retained.

### Bidirectionality

- In LTR layouts, compact user prompt blocks align inline-end and assistant prose
  aligns inline-start.
- In RTL layouts, inline-start and inline-end naturally mirror through logical
  CSS properties.
- Text alignment follows content direction; do not force right-aligned prompt
  text for LTR English content.

## Product Rules

### Hierarchy

The transcript hierarchy is:

1. assistant answer prose
2. user prompt ownership and content
3. inline citations and context references
4. branch/fork controls
5. evidence disclosure
6. timestamps and secondary actions

Lower layers must not visually dominate answer prose or prompt content.

### Role Differentiation

- User turns are identified by right anchoring, `You` attribution, prompt block
  surface, and prompt-specific actions.
- Assistant turns are identified by prose layout, citation/evidence affordances,
  assistant actions, and streaming state.
- Do not rely on color alone to distinguish roles.
- Do not add avatars unless a later spec redesigns participant identity across
  the whole workbench.

### Readability

- Assistant paragraphs target reader measure, not maximum pane width.
- Long answers should invite reading, scanning, copying, and source checking.
- Paragraphs, lists, and headings should have enough vertical rhythm to avoid
  dense walls of text.
- User prompt blocks should not make pasted working material harder to review.
- Ordinary answer prose should not jump left-right between roles.

### Styling

- Use app semantic tokens for chat colors.
- Do not use media reader literal theme tokens in chat.
- It is acceptable for chat prose to use reader-grade measure and rhythm without
  using the reader's warm light/dark palettes.
- Prompt block styling must remain quieter than assistant prose.
- Avoid large rounded messenger bubbles.
- Avoid saturated user-message fills.
- Avoid borders/backgrounds around assistant prose.

### Accessibility

- The transcript remains a named `role="log"` inside a named chat region.
- User prompt attribution is visible text and available to assistive technology.
- Timestamp visibility on hover/focus may remain, but timestamps must remain
  reachable or announced through accessible names where already supported.
- Copy, fork, evidence, citation, and source-jump controls remain real buttons.
- Focus order follows visual order.
- Reduced-motion users do not receive nonessential animations.
- High-contrast and zoomed text must not cause prompt blocks or tables to
  overlap the composer.

## Structure

The target message structure is:

```text
ChatSurface
  transcriptScrollport
    transcript role="log"
      scope banner
      load older control
      empty state
      MessageRow[data-role="user"]
        UserMessage
          userPromptShell[data-presentation="compact" | "expanded"]
            promptHeader
              attribution "You"
              optional actions
            promptContextCitations
            promptBody
            feedback
            timestamp
      MessageRow[data-role="assistant"]
        AssistantMessage
          optional message actions
          optional tool activity
          assistantBody
            StreamingMarkdownMessage | AssistantEvidenceDisclosure
          selection popover
          feedback
          fork strip
          timestamp
      MessageRow[data-role="system"]
        SystemMessage
  composerDock
    ChatComposer
```

`MessageRow` stays a role switch and shared vertical-rhythm wrapper. Role-specific
layout belongs in `UserMessage`, `AssistantMessage`, and their CSS.

## Architecture

### Ownership

`ChatSurface` owns transcript layout only:

- surface column
- transcript scrollport
- centered transcript column
- composer dock integration
- scroll/wheel ownership

`MessageRow` owns:

- role dispatch
- stable `data-message-id`
- stable `data-role`
- shared timestamp/error label derivation
- reader source activation callback wiring

`UserMessage` owns:

- compact versus expanded prompt presentation
- user attribution
- user context citation placement
- prompt body rendering
- prompt-level error display and timestamp placement

`AssistantMessage` owns:

- assistant answer body placement
- pending streaming cue placement
- assistant selection capture
- fork action placement
- tool activity placement
- assistant-level error display and timestamp placement

`MarkdownMessage` owns:

- reader-grade assistant markdown typography
- prose rhythm
- code block presentation
- table overflow behavior
- inline citation placement

`AssistantEvidenceDisclosure` owns:

- citation injection into completed assistant content
- evidence summary and disclosure placement
- source jump controls

### Prompt Presentation Classifier

Add a small pure helper local to the chat module:

```ts
type UserPromptPresentation = "compact" | "expanded";

function getUserPromptPresentation(message: ConversationMessage): UserPromptPresentation;
```

Rules:

- Pending empty content is compact.
- Whitespace-only complete content is compact but renders the existing empty
  fallback behavior.
- Character count uses normalized visible text, not raw JSON.
- Hard line breaks force expanded.
- Fenced code markers force expanded.
- Markdown-table shape forces expanded.
- Long unbroken tokens force expanded.
- The helper must be deterministic and covered by unit tests.

This classifier is presentational only. It must not alter message persistence,
message content, branch behavior, or prompt submission.

### CSS Model

Use logical properties so RTL support is natural:

- `margin-inline-start`
- `margin-inline-end`
- `padding-inline`
- `border-inline-start`
- `border-inline-end`
- `text-align: start`
- `justify-content: flex-end` only where ownership is visual, not where text is
  read

Recommended local custom properties:

```css
--chat-prose-measure: 66ch;
--chat-prose-font-size: var(--text-md);
--chat-prose-line-height: 1.58;
--chat-compact-prompt-max-width: min(72%, 46ch);
--chat-compact-prompt-max-width-mobile: min(92%, 100%);
```

These may live in `ChatSurface.module.css` or `MessageRow.module.css` depending
on the final CSS boundary. Keep them chat-local, not global root tokens, unless
another surface consumes them.

### Width Rules

- Transcript column remains centered and constrained.
- Assistant prose should be measured by `ch`, not raw pixels.
- Compact user prompts use intrinsic width with a max cap.
- Expanded user prompts use full transcript width.
- Wide structured assistant blocks may scroll internally.
- The transcript itself must not create page-level horizontal overflow.

## Files

### Primary Frontend Files

- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/MessageRow.module.css`
- `apps/web/src/components/chat/UserMessage.tsx`
- `apps/web/src/components/chat/AssistantMessage.tsx`
- `apps/web/src/components/chat/AssistantEvidenceDisclosure.tsx`
- `apps/web/src/components/ui/MarkdownMessage.tsx`
- `apps/web/src/components/ui/MarkdownMessage.module.css`

### Chat Surface Callers

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/components/chat/ReaderAssistantPane.tsx`
- `apps/web/src/components/chat/QuoteChatSheet.tsx`

Callers should not need new presentation props. They are listed because the same
surface must remain consistent across all mounts.

### Tests

- `apps/web/src/components/chat/MessageRow.test.tsx`
- `apps/web/src/components/chat/ChatStreamingHardCutover.test.tsx`
- `apps/web/src/__tests__/components/ChatSurface.test.tsx`
- `apps/web/src/__tests__/components/MarkdownMessage.test.tsx`
- `apps/web/src/__tests__/components/ReaderAssistantPane.test.tsx`
- `apps/web/src/__tests__/components/ConversationPaneBody.test.tsx`
- `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx`

Add or update screenshots only where the test suite already owns screenshots.
Delete old snapshots that assert the removed bubble presentation.

## Key Decisions

- **Right anchoring is block placement, not text alignment.** User prompt text
  remains left-aligned in LTR content because prompt readability matters more
  than mirroring messenger text alignment.
- **Compact and expanded prompts are deterministic.** No layout measurement or
  post-render resize observer decides prompt shape.
- **Long user prompts do not collapse by default.** Users should be able to audit
  what they sent without another click.
- **Assistant answers are prose, not bubbles.** Assistant content gets reader
  measure and rhythm but keeps app colors so it remains visually distinct from
  media reader content.
- **Chat does not inherit reader settings.** Reader preferences are for media
  consumption. Chat uses reader standards as product defaults, not per-user
  reader profile state.
- **Structured blocks can be wider than paragraphs.** Tables and code need
  practical width without ruining prose measure.
- **One layout across surfaces.** Full chat, new chat, reader rail, and mobile
  sheet all consume the same message presentation components.

## Implementation Plan

1. Add the user prompt presentation helper and tests.
2. Refactor `UserMessage` markup into a prompt shell with compact/expanded
   variants.
3. Replace user bubble CSS with right-anchored prompt-block CSS.
4. Update `MarkdownMessage.module.css` for reader-grade assistant prose rhythm.
5. Add safe overflow rules for assistant tables, code blocks, inline code, and
   long tokens.
6. Verify `AssistantEvidenceDisclosure` still preserves citations and evidence
   placement under the new prose CSS.
7. Verify `ReaderAssistantPane` inherits the same layout without rail-specific
   branches.
8. Delete stale bubble-related CSS and snapshots.
9. Update focused browser/unit tests for the new user-visible behavior.

## Acceptance Criteria

### Visual Behavior

- Short user prompts appear as right-anchored prompt blocks in full chat.
- Short user prompts appear as right-anchored prompt blocks in new chat.
- Short user prompts appear as right-anchored prompt blocks in reader assistant.
- Long user prompts render as expanded readable prompt blocks.
- Multi-paragraph user prompts render expanded.
- Code-like user prompts render expanded.
- Assistant answers have no bubble background, border, or card wrapper.
- Assistant prose line length is constrained by reader-grade measure on desktop.
- Assistant paragraphs, lists, headings, blockquotes, and citations have readable
  rhythm.
- Tables and code blocks do not create transcript-level horizontal overflow.
- Mobile compact prompts do not become unusably narrow.
- Mobile expanded prompts use the available width.

### Behavioral Preservation

- Sending messages still creates the same chat run payloads.
- Streaming assistant messages still update in place.
- Pending assistant messages still show the gutter cue.
- Fork actions still work.
- Fork-from-selection still works.
- Inline citations still activate reader targets.
- Evidence disclosure still opens and closes.
- Message errors still render in the transcript.
- Timestamps remain visible on hover/focus and accessible.
- Load-older scroll restoration still works.
- Composer docking remains unchanged.

### Code And Test Hygiene

- No legacy `.userBody` bubble styling remains.
- No role-specific CSS exists solely to preserve old user bubble behavior.
- No feature flag or compatibility prop controls the new layout.
- No route-specific message presentation branch exists for reader assistant.
- Unit tests cover compact versus expanded prompt classification.
- Browser/component tests assert user prompt anchoring and assistant prose
  rendering.
- Old snapshots that assert the removed bubble shape are deleted or re-recorded.
- `cd apps/web && bun run typecheck` passes.
- `cd apps/web && bun run lint` passes.
- Focused component/browser tests for chat message rendering pass.

## Validation Commands

```bash
cd apps/web && bun run typecheck
cd apps/web && bun run lint
cd apps/web && bun run test:unit
cd apps/web && bun run test:browser
```

If the full browser suite is too slow during iteration, run the focused chat and
markdown tests first, then run the full suite before review.

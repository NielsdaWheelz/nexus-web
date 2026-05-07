# Visual Refactor 1B — Hard Cutover Spec

This phase swaps eight reader-and-shell patterns to their target shapes
in a single coherent refactor. 1B is the structural pass that comes
between 1A (token system + light mode + UI primitives) and 2 (final
visual direction). Every pattern below is direction-agnostic and lands
the same regardless of the eventual aesthetic.

## Supersession

The desktop reader chat and expanded highlights slide-over requirements in this
document are superseded by
[`reader-secondary-rail-hard-cutover.md`](reader-secondary-rail-hard-cutover.md).
Mobile sheet and drawer behavior remains active. Treat the P4/P5 overlay text
below as historical context where it conflicts with the secondary rail spec.

## Goals

- Replace the bubble-chat surface with a flowing document chat.
- Move reader-adjacent desktop chat and highlights into a shared stable
  right-side secondary rail, with mobile retaining drawer and sheet behavior.
- Replace the existing pill citations with superscript + hover-preview
  citations that jump and pulse the reader.
- Consolidate composer chips into a single context rail.
- Make the command palette aware of its invoking pane and surface a
  scope chip plus pane-specific commands.
- Keep a thin always-visible ghost gutter for the collapsed media highlights
  state, expanding into the stable reader secondary rail.
- Re-skin the marketing and legal pages as a magazine layout that does
  not look like a SaaS hero.
- Realign the reader's color palette to the warm-neutral 1A tokens and
  ship the focus-mode contract from the reader docs.

## Non-goals

- Picking or styling the final visual direction. Token VALUES stay as
  1A's neutral baseline. Phase 2 swaps colors, fonts, motion curves.
- Token system or UI primitive changes. 1A is frozen.
- Reader resume, ingestion, or content sanitization changes.
- Any backend changes other than the single `reader_profile.hyphenation`
  field added in P0.
- Performance work, accessibility audits, or test framework rewrites
  unless required to land a pattern.
- Replacing the workspace pane runtime. Panes still exist; chat and
  highlights are removed from the pane lineup but the pane shell
  stays for everything else.

## Hard-cutover policy

This is a hard cutover. Every pattern is replaced wholesale and the
predecessor is deleted in the same PR.

- No feature flags. No `?next_chat=1` query toggles. No environment gates.
- No fallback paths. If the new reader secondary rail fails to mount,
  the user sees an error boundary, not the old companion pane or
  overlay path.
- No backward-compatibility shims. Type aliases for renamed types are
  removed in the same PR. No `// removed in 1B` comments — delete the line.
- No deprecation period. The old `InlineCitations`, `BranchAnchorPreview`,
  `MediaHighlightsPaneBody`, reader overlay paths, and the chat-as-pane
  registry entry are removed in the PRs that introduce their replacements.
- No reuse of replaced files as "wrappers". When a component is renamed
  or restructured, it is rewritten in its new file and the old file is
  deleted.
- Tests and screenshots that exercise removed behavior are deleted.
  Tests that exercise still-valid behavior are rewritten against the
  new shape. We do NOT keep duplicated old/new test paths.

## Final state (one-paragraph picture)

A user opens a media item. The reader fills the pane in a
warm-neutral light or dark theme; a 36px gutter on the right edge
shows a vertical heatmap of every highlight in the document. Selecting
text spawns a tight selection popover; choosing a color creates a
highlight, which immediately appears as a tick in the gutter. Expanding
the gutter opens a stable desktop secondary rail with `Highlights` and
`Ask` modes, reflowing the reader column instead of overlaying it. On
mobile, highlights and Ask remain drawer or sheet experiences. The chat
is a flowing document, not bubbles: the user's message reads as muted
attribution, the assistant's reply as full-body prose.
Citations in the reply render as superscript pills; hovering one shows
a 3-line excerpt card; clicking jumps the reader to the source span and
pulses the highlight. The composer above the input is a single chip
rail: scope, branch, selection, attached refs. Cmd-K opens with a
scope chip showing "In: Media — [title]" and surfaces commands relevant
to this pane. Collapsing the secondary rail returns the reader to the
narrow highlight gutter. The login and legal pages read as a
quiet magazine: no gradients, no glass, body font matching the reader.

## Cross-cutting rules

- **Slide-over contract.** All slide-overs (chat, expanded highlights)
  mount as right-edge overlays positioned absolutely within their host
  surface. They dim the host with a backdrop at 0.6 opacity. Backdrop
  click, Esc, or explicit close button all dismiss. Slide-over animates
  with `transform: translateX` over `--duration-base` using
  `--ease-glide`. `prefers-reduced-motion` snaps without animation.
- **Hover-preview contract.** Citations and gutter ticks share one
  preview card primitive. Card width is 240px desktop, 80vw mobile;
  body text is 3-line clamped; appears after 150ms hover delay; closes
  on pointerleave with no delay. On touch devices, hover is replaced
  by tap to open a sheet, tap-outside to dismiss.
- **Pulse contract.** "Jump and pulse" is a single global custom event:
  `window.dispatchEvent(new CustomEvent("nexus:reader-pulse-highlight",
  { detail: { mediaId, locator, snippet } }))`. The active reader
  subscribes; on receipt it scrolls to the locator and applies a
  `.pulsing` class for 1200ms (a 2-cycle opacity pulse on the highlight
  background). Citation clicks and gutter tick clicks both dispatch the
  same event.
- **Streaming gutter cue.** Pending assistant messages render a 2px
  vertical bar at the message's left edge. The bar uses
  `--accent-muted` as background and pulses opacity 0.4 → 1.0 → 0.4 on a
  1.4s loop. No "Generating response..." text, no spinner glyph, no
  ellipsis animation.
- **Color discipline.** Highlight colors and citation pill colors use
  the existing `--highlight-*` tokens from globals.css. Do not add
  new color tokens in 1B.
- **Density.** Within any single overlay or chip rail, control sizes
  use `--size-sm` (28px) for inline controls and `--size-md` (32px) for
  primary actions. No new size values.
- **A11y baseline.** Every overlay sets `role="dialog"`,
  `aria-modal="true"`, manages focus on open, returns focus on close,
  and traps Tab. Every pulse/dim respects `prefers-reduced-motion`.
- **No new global state.** Slide-overs are local component state in the
  surface that owns them. The workspace store does not learn about chat
  or highlights overlays.

## Sequencing and PR strategy

Eight PRs, in order. Each PR is independently shippable behind no flag —
hard cutover means each PR replaces the prior shape entirely.

1. **P0 — Reader theme realignment + focus mode + typography rules.**
   Foundation for everything reader-side. Lands the warm palette and
   focus-mode behavior the user already approved.
2. **P1 — Citation system.** Highest cross-cutting surface. Lands
   `ReaderCitation` and the pulse contract; deletes `InlineCitations`
   and `ReplyBar`.
3. **P2 — Context-chip rail.** Replaces the composer's three chip
   layers (scope, branch, attachments) with one rail.
4. **P3 — Chat as document.** Rewrites `MessageRow` and `ChatSurface`
   for flowing typography; introduces gutter streaming cue.
5. **P6 — Contextual Cmd-K.** Independent of the reader work; can
   land in parallel with P3 if convenient. Adds scope chip + per-pane
   command sections.
6. **P7 — Marketing/login → magazine layout.** Independent; sequenced
   here so it doesn't conflict with the reader-pane PRs.
7. **P5 — Ghost gutter.** Reorganizes the reader chrome to host the
   gutter; replaces the sibling highlights pane.
8. **P4 — Slide-over chat over reader.** Highest risk because it
   restructures pane orchestration. Lands last so the gutter and
   citation pulse already exist.

---

## P0. Reader theme realignment + focus mode + typography rules

### Target behavior

The reader matches the rest of the app's warm-neutral palette, never
sits at pure black/white, enforces block paragraph spacing, never
justifies, hyphenates only on narrow viewports (or never if the user
opts out), and supports four discrete focus modes via
`reader_profile.focus_mode` and the keyboard shortcut Cmd/Ctrl+Shift+F.

### Architecture

Reader-specific tokens stay isolated under `--reader-*` custom
properties so user-tunable typography (font-family, size, line-height,
column width) can change without touching app theme tokens. The values
of those tokens move into the warm-neutral family from the cool
slate/catppuccin palette they currently use. Focus mode is implemented
as data-attribute classes on the reader scroll container, with CSS
selectors handling dimming. The "current paragraph/sentence" pointer is
computed in JS via an `IntersectionObserver` on paragraph children of
`HtmlRenderer` and `EpubContentPane`.

### Files

**Modify:**
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css` — replace
  `.reader.themeLight` and `.reader.themeDark` color values per
  reader-implementation.md "color contrast"; add `[data-focus-mode]`
  selectors with dimming rules; add `[data-hyphenation="auto"]`
  selector with `hyphens: auto` and the limit chars/lines, gated to
  `@media (max-width: 600px)`.
- `apps/web/src/components/HtmlRenderer.module.css` — change
  `.renderer p { margin: 0 0 1em }` to `margin: 0 0 var(--reader-line-height, 1.55)em`
  (block paragraph spacing = one line-height); confirm `text-align: left`
  is the default on `.renderer` (no justify); add per-paragraph
  `data-paragraph` for focus targeting.
- `apps/web/src/components/HtmlRenderer.tsx` — wrap each top-level
  paragraph descendant emitted in render with `data-paragraph="true"`;
  on selectionchange, emit a "selection-active" data-attribute on the
  reader root so focus mode can auto-suspend.
- `apps/web/src/lib/reader/types.ts` — extend `ReaderProfile` with
  `focus_mode: "off" | "distraction_free" | "paragraph" | "sentence"`
  and `hyphenation: "auto" | "off"`; widen the discriminated union if
  the type narrows elsewhere.
- `apps/web/src/lib/reader/useReaderProfile.ts` — add the two new
  fields to the read/write surface; default `focus_mode = "off"` and
  `hyphenation = "auto"`.
- `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx` (or
  reader settings sub-pane) — add the two controls: focus mode segmented
  control with four options; hyphenation toggle.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` —
  install the global `Cmd/Ctrl+Shift+F` keydown listener that cycles
  focus mode; on mount, install the IntersectionObserver that tracks
  the centered paragraph; pass `data-focus-mode` and
  `data-hyphenation` down to the reader root.

**Create:**
- `apps/web/src/lib/reader/focusModeKeybinding.ts` — binding helper that
  reads the current focus mode, computes the next, writes it via
  `useReaderProfile`. Pure module, exports a single
  `cycleReaderFocusMode(current): next` function.

**Delete:**
- Nothing for P0. This is purely additive on the schema and a
  values-only swap on CSS.

**Backend (single small change):**
- `python/nexus/api/routes/reader_state.py` (or wherever `reader_profile`
  is persisted) — add `hyphenation` column and accept the new
  `focus_mode` enum value `"distraction_free"` (it likely currently
  accepts only `"off"` and a single legacy `"on"`-style value if any).
  Migration: `ALTER TABLE reader_profile ADD COLUMN hyphenation TEXT
  NOT NULL DEFAULT 'auto'`.

### Key decisions

- Focus mode dimming is implemented purely in CSS, driven by a
  data-attribute on the reader root and `data-paragraph-current="true"`
  / `data-sentence-current="true"` set by JS. Dimming uses
  `opacity: 0.4` (paragraph mode) / `0.7` for the active paragraph in
  sentence mode and `0.3` for the rest. No transition on dim during
  scroll — only on enter/exit of the mode (180ms ease-glide, snap on
  reduced motion).
- "Sentence" mode requires sentence segmentation. Use the
  `Intl.Segmenter` API where available (>= Safari 16, all current
  Chromium); fall back to a regex segmenter on older engines without
  shipping a polyfill. If segmentation is unavailable, sentence mode
  silently downgrades to paragraph mode.
- Auto-suspend during selection: the reader root toggles
  `data-selection-active="true"` on `selectionchange`, and the focus
  mode CSS selector chains require `:not([data-selection-active])`.
- Hyphenation toggle is binary; we do not expose `hyphenate-limit-*`
  to the user.

### Acceptance criteria

- All four `--reader-bg` / `--reader-text` values match the table in
  `docs/reader-implementation.md` exactly.
- `<p>` elements render with `margin-bottom` equal to one line-height of
  body text (verified via DOM inspector on a sample article).
- Justifying via the browser DevTools is the only way to get justified
  text; no setting in the app produces it.
- On a viewport <= 600px with `hyphenation = "auto"`, long words break
  with a hyphen at the end of the line. On a viewport >= 601px, they
  do not.
- Pressing Cmd/Ctrl+Shift+F cycles through the four modes in order.
  Pressing Esc returns to "off". The chosen mode persists across reload.
- Selecting text while in `paragraph` or `sentence` mode visually
  removes the dimming until the selection clears.

---

## P1. Citation system — superscript + hover-preview + jump-and-pulse

### Target behavior

Inline citations in chat replies render as small superscript numerals
(`¹ ² ³`), color-coded by the underlying highlight color. Hovering a
citation summons a 240px-wide preview card with the source title, a
3-line clamped excerpt, and any source meta (route, podcast/library
name). Clicking a citation pulses-and-jumps the reader: dispatches the
`nexus:reader-pulse-highlight` event with the locator; the active
reader scrolls to that locator and pulses the highlight twice. If the
underlying source is unresolvable in the reader (no media, no locator),
the citation renders muted and is not clickable.

### Architecture

A single `ReaderCitation` primitive replaces both `InlineCitations`
(multi-context user message pills) and `ReplyBar` (single-context user
message bar). Single-context user messages render the citation inline
at the start of the message body. Multi-context user messages render a
horizontal row of citations followed by the message body. Assistant
messages with claim-grounded evidence (today rendered via
`ClaimEvidenceMessage` and `EvidenceItem`) keep their evidence panel
structure but the inline reference markers (currently `[1]` markdown
links) become `ReaderCitation`s rendered by a small markdown plugin
that runs over the assistant content.

### Files

**Create:**
- `apps/web/src/components/ui/ReaderCitation.tsx` — the citation
  primitive. Props: `index`, `color: HighlightColor | "neutral"`,
  `preview: { title?: string; excerpt?: string; meta?: string[] }`,
  `target: ReaderSourceTarget | null`, `onActivate: (target) => void`.
- `apps/web/src/components/ui/ReaderCitation.module.css` — superscript
  styling, hover lift, color tints from `--highlight-*` tokens, focus
  ring.
- `apps/web/src/components/ui/HoverPreview.tsx` — shared preview card
  primitive used by `ReaderCitation` and (in P5) `ReaderGutter`.
  Handles 150ms hover delay, viewport edge collision, focus-trap on
  touch.
- `apps/web/src/components/ui/HoverPreview.module.css` — card width,
  shadow, padding, line-clamp.
- `apps/web/src/lib/reader/pulseEvent.ts` — exports
  `dispatchReaderPulse(target)` and a React hook
  `useReaderPulseHighlight(handler)` for subscribers.
- `apps/web/src/lib/conversations/insertCitationsIntoMarkdown.ts` —
  pure function that consumes assistant message content + the
  `claims[]` evidence index and returns markdown with inline
  `<ReaderCitation>` placeholders (or a serialized form a markdown
  renderer plugin can hydrate).

**Modify:**
- `apps/web/src/components/chat/MessageRow.tsx` — replace
  `<InlineCitations>` with `<ReaderCitation>` rows; replace `<ReplyBar>`
  with a single inline `<ReaderCitation>` in front of the user message;
  in `ClaimEvidenceMessage`, remove `contentWithClaimMarkers`'s
  `[n](#anchor)` insertion in favor of calling
  `insertCitationsIntoMarkdown` and let the markdown renderer emit
  `ReaderCitation`s with proper `target` props.
- `apps/web/src/components/ui/MarkdownMessage.tsx` — register a small
  remark plugin (or a string-replace pre-pass if the markdown stack is
  not remark-based) that recognizes the citation placeholder shape and
  swaps it for a `ReaderCitation` React element.
- `apps/web/src/components/PdfReader.tsx` and
  `apps/web/src/components/HtmlRenderer.tsx` and
  `apps/web/src/app/(authenticated)/media/[id]/EpubContentPane.tsx` —
  subscribe to `useReaderPulseHighlight`; on pulse, scroll the
  highlight into view and apply `.pulsing` class for 1200ms.
- `apps/web/src/components/PdfReader.module.css`,
  `HtmlRenderer.module.css`, and the EPUB content pane CSS — add a
  `.pulsing` keyframe (2-cycle opacity ramp on highlight background).

**Delete:**
- `apps/web/src/components/ui/InlineCitations.tsx`
- `apps/web/src/components/ui/InlineCitations.module.css`
- The `ReplyBar` component export and the
  `[styles.replyBar][styles.replyBar-color]` rules from
  `MessageRow.module.css`.
- The `contentWithClaimMarkers` and `claimDomId` helpers from
  `MessageRow.tsx` (replaced by `insertCitationsIntoMarkdown`).
- `apps/web/src/components/chat/__screenshots__/MessageRow.test.tsx/`
  snapshots that pin the old pill shape; new ones generated against
  the superscript shape.

### Key decisions

- Color: when the source is a reader highlight, the citation tints to
  that highlight's color via the existing `--highlight-*` tokens. When
  the source is web evidence (no highlight), the citation tints to
  `--ink-muted` and shows a small globe glyph in the preview card meta.
- Numbering: citations are numbered in order of first appearance per
  message. The same source cited twice keeps the same number.
- Click target: clickable only when `target.media_id` resolves to a
  pane the user can open and the locator is non-empty. Otherwise
  rendered as a muted superscript with `tabIndex={-1}` and no hover
  preview interaction.
- Pulse on jump: even if the reader for the target media is already
  open in the active media pane, the click still dispatches the pulse
  event so the user gets visual feedback.

### Acceptance criteria

- `InlineCitations.tsx` no longer exists in the repo.
- Hovering any citation in any chat surface within 150ms produces a
  preview card with title and a 3-line excerpt.
- Clicking a clickable citation in a media pane scrolls the reader to
  the locator and visibly pulses the highlight twice.
- Snapshots of `MessageRow.test.tsx` reflect the new superscript shape
  and have been re-recorded.
- The single citation case (1 context) and multi citation case (2+
  contexts) both render with `ReaderCitation` and not `ReplyBar`.

---

## P2. Context-chip rail — composer chip consolidation

### Target behavior

A single horizontal chip rail sits above the composer textarea and is
the only place chips appear in the composer. Chip ordering is fixed and
predictable: scope chip first (only when scope is non-general), branch
chip second (only when branching), then selection / object-ref chips in
the order they were attached. Each chip uses the existing `Chip`
primitive from 1A. Removing a chip uses the `X` icon already on `Chip`.
The rail collapses into nothing visually when no chips are present.

### Architecture

`ComposerContextRail` is a presentational component that takes a
single `items` array of typed entries (scope, branch, context) and
renders them through the `Chip` primitive. Conversion from raw inputs
(`ConversationScope`, `BranchDraft`, `ContextItem[]`) to chip items
happens in a small adapter module so the rail itself does not know about
domain types.

### Files

**Create:**
- `apps/web/src/components/chat/ComposerContextRail.tsx`
- `apps/web/src/components/chat/ComposerContextRail.module.css`
- `apps/web/src/components/chat/composerChipAdapter.ts` — pure adapter:
  `toChipItems({ scope, branchDraft, attachedContexts })` returns
  ordered `ChipItem[]` with `{ kind, label, color?, onRemove? }`.

**Modify:**
- `apps/web/src/components/ChatComposer.tsx` — remove the inline
  `<ConversationScopeChip>` block (lines 428-432), the
  `<BranchAnchorPreview>` block (lines 434-439), and the
  `<ContextChips>` block (lines 441-445); replace with a single
  `<ComposerContextRail items={...}>`. Pass `onRemoveScope` (clears
  conversationScope to general at the call site), `onRemoveBranch`
  (calls `onClearBranchDraft`), and `onRemoveContext` through the
  adapter.

**Delete:**
- `apps/web/src/components/chat/ContextChips.tsx`
- `apps/web/src/components/chat/ContextChips.module.css`
- `apps/web/src/components/chat/BranchAnchorPreview.tsx`
- `apps/web/src/components/chat/BranchAnchorPreview.module.css`
- `apps/web/src/components/chat/ConversationScopeChip.module.css` (the
  module-css; the chip is now styled solely by the shared `Chip`
  primitive). Keep `ConversationScopeChip.tsx` ONLY if it is still used
  by `ChatSurface` for the scope banner above the message log; check
  consumers and delete if not.

### Key decisions

- Scope chip in the rail uses a small "scope" leading icon (Globe for
  general, Book for media, Folder for library) but the rest of the
  chrome is the standard `Chip` look — no separate stylesheet.
- Branch chip is non-removable visually only when the branch is
  required (currently never — `onClearBranchDraft` always exists in
  branchDraft mode), so the X is always present.
- The rail does not render the small "Selection" preview body that
  `BranchAnchorPreview` previously showed; that preview is now part of
  the chip's hover preview (using the same `HoverPreview` primitive
  P1 introduces).

### Acceptance criteria

- `ContextChips`, `BranchAnchorPreview`, and (if appropriate)
  `ConversationScopeChip.module.css` no longer exist in the repo.
- `ChatComposer` renders exactly one chip-rail row above the textarea,
  with chip order: scope (if any), branch (if any), then attached
  contexts in attachment order.
- Removing each chip type works and updates parent state correctly.
- `ChatComposer.test.tsx` snapshots are re-recorded against the rail.

---

## P3. Chat as document — strip bubbles, add gutter cue

### Target behavior

Messages flow as document blocks with no container shape. The user's
message renders as a small muted attribution: a single
`text-sm`-weight-`medium` `--ink-muted` line whose first child is the
text "You", followed by the message content as a regular paragraph
inset by `--space-3` from the left edge. The assistant's response
renders as full-width body typography with no leading label, no avatar,
and no container background or border. The pending state has no
"Generating response..." text and no spinner; instead, a 2px vertical
bar at the message's left edge pulses opacity 0.4 → 1 → 0.4 on a 1.4s
loop.

### Architecture

`MessageRow` becomes much smaller: it picks the right sub-renderer
based on role and status. `UserMessage`, `AssistantMessage`, and
`SystemMessage` are siblings under `MessageRow` and each renders the
plain document blocks for its role. The streaming gutter cue is a
`StreamingGutterCue` component that renders the bar; it is placed by
`AssistantMessage` when `status === "pending"`.

### Files

**Create:**
- `apps/web/src/components/chat/UserMessage.tsx`
- `apps/web/src/components/chat/AssistantMessage.tsx`
- `apps/web/src/components/chat/SystemMessage.tsx`
- `apps/web/src/components/chat/StreamingGutterCue.tsx`
- `apps/web/src/components/chat/StreamingGutterCue.module.css`

**Modify:**
- `apps/web/src/components/chat/MessageRow.tsx` — collapse to a thin
  switch: read `message.role`, render the correct sub-component, pass
  through props. Keep the assistant selection capture logic
  (`captureAssistantSelection`) but move the implementation into
  `AssistantMessage`. Delete `ReplyBar` entirely (already handled in
  P1). Delete role-class binding (`styles[message.role]`).
- `apps/web/src/components/chat/MessageRow.module.css` — strip the
  `.user`, `.assistant`, `.system` rules; keep `.message` as a thin
  vertical-rhythm wrapper (margin-bottom = 1 line-height); strip
  background, border, border-radius from all role variants.
- `apps/web/src/components/chat/ChatSurface.module.css` — adjust
  `.transcript` to use the same `--reader-line-height` rhythm; widen
  inner column to a max-width of `var(--content-max-width, 700px)` and
  center it; remove any leftover bubble-related rules.
- `apps/web/src/components/chat/ReaderAssistantPane.tsx` — no
  structural change; just pass through the new MessageRow.

**Delete:**
- All snapshots under
  `apps/web/src/components/chat/__screenshots__/MessageRow.test.tsx/`
  and `__screenshots__/ChatStreamingHardCutover.test.tsx/`. Re-record.
- The `<div className={styles.pendingStatus} role="status">Generating
  response...</div>` block in `MessageRow.tsx` (now in
  `AssistantMessage`, but the text and the spinner go away).

### Key decisions

- User messages are NOT visually right-aligned. Both roles flow at the
  same column; differentiation is typographic only.
- Assistant attribution: there is no "Assistant" label. The reply just
  flows.
- User attribution: a single muted line `You` precedes the user's
  text. This is the only role indicator in the document.
- Markdown rendering: assistant content keeps `MarkdownMessage`. User
  content stays plain text (no markdown).
- Branch / fork affordances stay as small ghost-button rows below the
  message body; their visual is unchanged by P3 but they sit inside
  `AssistantMessage`.

### Acceptance criteria

- No `border`, `background`, `border-radius`, or `box-shadow` is set on
  `.user`, `.assistant`, `.system`, or `.message` in
  `MessageRow.module.css`.
- A pending assistant message visibly shows the gutter bar pulsing and
  no text label.
- User and assistant messages flow at the same column; viewing the chat
  log reads as a typographic transcript, not a chat thread.
- All chat screenshots have been re-recorded against the new shape.

---

## P4. Slide-over chat over reader

### Target behavior

When the user invokes the reader assistant in a media pane (via the
"ask" button in the SelectionPopover or the chat affordance in the
pane chrome), a chat overlay slides in from the right edge of the media
pane. On desktop, the overlay is 440px wide, anchors to the right edge
of the media pane, and dims a backdrop over the gutter only — the
reader column does not reflow. On mobile, the overlay covers the full
pane width and the existing `QuoteChatSheet` mounting point is reused.
The chat in the overlay is the same `ChatSurface` used in
`/conversations/:id`. Closing the overlay (Esc, backdrop click, or
explicit close) returns the reader to its untouched state.

### Architecture

Chat is no longer a workspace pane sibling of the media pane. The
`/conversations/new` and `/conversations/:id` routes remain in
`paneRouteRegistry` for full-screen chat usage outside the reader, but
the media pane no longer requests opening a sibling pane for chat.
Instead, `MediaPaneBody` owns a local boolean `isReaderChatOpen` plus
the in-progress draft, and renders `<ReaderChatOverlay>` as a
positioned-overlay child. `ReaderChatOverlay` wraps `ChatSurface` and
the composer; the overlay is responsible for the slide animation,
backdrop, focus management, Esc handling.

### Files

**Create:**
- `apps/web/src/components/chat/ReaderChatOverlay.tsx`
- `apps/web/src/components/chat/ReaderChatOverlay.module.css`

**Modify:**
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` —
  add `isReaderChatOpen` state; on selection-popover "ask" or chat
  affordance click, set true and pass the selection as initial
  `attachedContexts`; replace the current sibling-pane request
  (`requestOpenInAppPane(...)` for chat) with an internal mount of
  `<ReaderChatOverlay>`. The current `ReaderAssistantPane` mounting
  paths that target `surface="embedded"` are removed; new path is
  through the overlay.
- `apps/web/src/components/chat/ReaderAssistantPane.tsx` — remove the
  `surface` prop; the pane no longer needs to know its hosting
  context. All callers either render it inside `ReaderChatOverlay`
  (P4), inside `QuoteChatSheet` (mobile, unchanged), or as a
  full-screen pane body (route-based usage).
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` — remove any
  registry entries that opened chat as a sibling/companion pane to a
  media pane. The pane route entries for `/conversations/new` and
  `/conversations/:id` stay (full-screen chat is still a valid pane).
- `apps/web/src/components/PaneShell` mobile chrome lock reasons —
  remove the `"reader-assistant"` lock reason since reader assistant
  is no longer a pane.

**Delete:**
- The `surface="embedded"` branch and any CSS in
  `ReaderAssistantPane.module.css` scoped to the embedded variant.
- Pane registry entries that wired chat-as-companion-of-media (exact
  IDs depend on registry; identify and remove in the PR).

### Key decisions

- The overlay is positioned RELATIVE to the media pane shell, NOT
  fixed-positioned to the viewport. This keeps it from overlaying
  other workspace panes when the workspace has multiple panes open.
- Reader column does not reflow because the overlay slides over the
  reader's right gutter (which P5 introduces). Without P5's gutter, the
  overlay would sit over the right edge of the reading column. P5 must
  ship before P4 lands so the column has room.
- Mobile uses the existing `QuoteChatSheet` modal; we do NOT mount
  `ReaderChatOverlay` on mobile because the screen is too narrow for a
  side overlay to be useful.
- The composer in the overlay always submits to the media's scoped
  conversation, NOT a general one.

### Acceptance criteria

- No workspace pane is opened when the user invokes reader chat from a
  media pane.
- The reader column's pixel layout is unchanged when the overlay opens
  (verified by snapshot diff of a fixed scroll position before and
  after).
- Esc, backdrop click, and the explicit close button all dismiss the
  overlay and return focus to the originating element (selection
  popover or chrome button).
- Mobile users continue to get `QuoteChatSheet`; the overlay does not
  render on mobile.

---

## P5. Ghost gutter — reader highlights as a tick gutter

### Target behavior

Every reader (PDF, EPUB, web article, transcript) renders a 36px-wide
gutter on the right edge of the reading column. Each highlight in the
document appears as a horizontal tick (3px tall, 24px wide, colored by
the highlight color) at the vertical position corresponding to the
highlight's location in the document. Tick density acts as a vertical
heatmap. Hovering a tick shows a `HoverPreview` card with the
highlighted text. Clicking a tick dispatches the
`nexus:reader-pulse-highlight` event (P1) — the reader scrolls to the
highlight and pulses it. A small "expand" affordance at the gutter top
opens the full highlights inspector as a right-edge slide-over (the
same overlay shape as P4 chat).

### Architecture

`ReaderGutter` is a positioned column rendered by `MediaPaneBody`
inside the media pane shell, anchored to the right edge of the reader
content area. It receives the highlights array and the reader's scroll
metrics (total height + scrollTop) and computes tick positions.
Position computation differs by reader kind:

- For HtmlRenderer + EpubContentPane: tick position is the highlight's
  first-character DOM offset's `getBoundingClientRect().top` relative
  to the scroll container's full scrollHeight.
- For PdfReader: tick position is `(page_number + intra_page_y) /
  total_pages` mapped to gutter height.
- For TranscriptContentPanel: tick position is `t_start_ms /
  duration_ms` mapped to gutter height.

The expanded inspector is a `HighlightsInspectorOverlay` that wraps the
existing `MediaHighlightsPaneBody` content (now NOT mounted as a
sibling pane).

### Files

**Create:**
- `apps/web/src/components/reader/ReaderGutter.tsx`
- `apps/web/src/components/reader/ReaderGutter.module.css`
- `apps/web/src/components/reader/HighlightsInspectorOverlay.tsx`
- `apps/web/src/components/reader/HighlightsInspectorOverlay.module.css`
- `apps/web/src/components/reader/highlightTickPositioning.ts` — pure
  positioning module. Three functions:
  `tickPositionForHtml(highlight, scroll)`,
  `tickPositionForPdf(highlight, totalPages)`,
  `tickPositionForTranscript(highlight, durationMs)`.

**Modify:**
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` —
  remove the `AnchoredSecondaryPane` mount of
  `MediaHighlightsPaneBody`; mount `ReaderGutter` as an absolutely
  positioned right-rail child of the reader area; mount
  `HighlightsInspectorOverlay` conditionally on
  `isHighlightsInspectorOpen` state.
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
  — keep the body content but remove anything pane-shell-aware (mobile
  drawer handling, pane-chrome-override calls). It becomes a pure body
  rendered inside the overlay.
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css` —
  remove the `.highlightsRail` / sibling-pane layout rules; add the
  `.readerWithGutter` two-column layout (column + 36px gutter).
- `apps/web/src/components/AnchoredSecondaryPane.tsx` — if its only
  consumer was `MediaHighlightsPaneBody`, delete it (verify with grep).

**Delete:**
- The "highlights as a sibling pane" path from `MediaPaneBody` and any
  pane-registry entries that opened a media-companion highlights pane.
- Mobile-specific drawer code in `MediaHighlightsPaneBody` (the
  inspector overlay handles both desktop and mobile from this point).

### Key decisions

- The gutter is always visible (cannot be collapsed). A document with
  no highlights shows an empty gutter, which is the negative space
  carrier for new ticks as the user highlights.
- Click target for ticks is generous (the tick is 3px tall but the
  hit area extends 6px above and below).
- Multiple highlights at the same scroll position stack as a slightly
  thicker tick; hover preview shows them as a list.
- The expanded inspector slides in from the right edge of the media
  pane (same shape as the P4 chat overlay) and dims the gutter only —
  reader column does not reflow.
- On mobile, the gutter is 24px wide and ticks are 4px tall (touch
  targets); tap on the gutter expand affordance opens the inspector
  full-width as a sheet.

### Acceptance criteria

- The right edge of every reader (PDF, EPUB, web, transcript) shows the
  36px gutter (24px on mobile).
- Each highlight in the document corresponds to exactly one tick at
  the correct vertical position.
- Hovering a tick shows the preview card within 150ms; clicking
  scrolls and pulses.
- The expand affordance opens the highlights inspector as a slide-over
  overlay, not a workspace pane.
- `MediaHighlightsPaneBody` no longer mounts as a sibling pane in any
  code path.

---

## P6. Contextual Cmd-K — scope chip + per-pane commands

### Target behavior

Pressing Cmd-K from any pane opens the command palette with a scope
chip at the top of the input row reading "In: [Pane Type] — [Title]"
(e.g., "In: Media — Hyperion Cantos"). The chip is dismissible: click
or Esc clears scope and returns the palette to global mode. When scope
is set: a section labeled "In this [pane type]" appears at the top
listing pane-relevant commands (e.g., for media: "Add highlight",
"Open chat", "Toggle focus mode"); ranking applies a strong scope
boost to commands declaring an affinity for the active pane type.

### Architecture

Scope is captured at palette open time by reading
`useWorkspaceStore().state.activePaneId` and resolving its route in
`paneRouteRegistry`. The resolved route's `id` (e.g., `"media"`,
`"conversation"`, `"daily-note"`) becomes the scope tag. Commands gain
an optional `scopeAffinity: PaneRouteId[]` field. The ranker's existing
`scopeBoost` becomes a hard scope filter when the scope chip is set,
PLUS the ranking boost it already applies when no scope filter is on.

### Files

**Create:**
- `apps/web/src/components/CommandPaletteScopeChip.tsx`
- `apps/web/src/components/CommandPaletteScopeChip.module.css`
- `apps/web/src/components/command-palette/perPaneCommands.ts` —
  `commandsForPaneType(paneRouteId, paneContext)` returns the
  pane-specific commands (e.g., for media: highlight + chat + focus).

**Modify:**
- `apps/web/src/components/CommandPalette.tsx` — at open, capture
  `scope = { paneRouteId, paneTitle }` from the workspace store; pass
  to `Palette`; render the chip in the input row; reset scope on
  close. Insert the per-pane commands at the top of the static
  command list when scope is set.
- `apps/web/src/components/command-palette/commandRanking.ts` — add a
  `scopeFilter` parameter; when set, drop commands that do not declare
  affinity AND apply a strong boost to commands that do declare it.
- `apps/web/src/components/command-palette/commandProviders.ts` —
  declare `scopeAffinity` on the relevant existing commands (e.g.,
  "Open in new pane" gets affinity for any non-system pane).
- `apps/web/src/components/palette/types.ts` — extend
  `PaletteCommand` with `scopeAffinity?: string[]`.
- `apps/web/src/components/palette/Palette.tsx` — render the scope
  chip slot in the input row, controlled by parent.

**Delete:**
- Nothing structural. P6 is additive on the palette.

### Key decisions

- Scope is captured at palette open and is not dynamic. If the user
  switches panes while the palette is open, scope does not update.
- Scope chip is visual + functional; clicking it sets `scopeFilter =
  null` and reranks.
- Per-pane commands are NOT persisted in the recent list (they are
  always-fresh contextual actions).
- Pane types initially supported: `media`, `conversation`, `note`,
  `page`, `daily-note`, `library`, `podcast`. Other pane types pass
  through with no per-pane section.

### Acceptance criteria

- Opening Cmd-K from a media pane shows "In: Media — [Title]" chip and
  a top section "In this media" with the media-specific commands.
- Clicking the chip removes scope; commands rerank to global.
- The chip never appears on the palette when the user opens Cmd-K
  from outside any pane (e.g., on `/login`).
- Existing palette tests are extended to cover scope chip, scope
  removal, and per-pane command surfacing.

---

## P7. Marketing/login → magazine layout

### Target behavior

The login page is no longer a centered card on a colored canvas. It is
a magazine-style two-column layout: a left editorial column with a
large title, a deck-line subtitle, and 2-3 short paragraphs about what
Nexus is; a right column with the provider sign-in buttons and the
legal copy. On mobile, the columns stack: editorial first, then
sign-in. The legal pages (Terms, Privacy) become single-column long-form
articles centered at `--content-max-width`. Body font is the same as
the reader body font — coherence reads as confidence. No glassmorphism,
no radial gradient, no card shadow other than the subtle hairline
border the rest of the app uses.

### Architecture

`LoginPageClient` keeps the same OAuth handlers and error rendering;
only the layout changes. Editorial copy lives directly in the JSX (no
CMS, no string table — a marketing site can come later). Privacy and
terms render their (existing) markdown / static content inside a
shared `<LongFormArticle>` wrapper that supplies the magazine type
treatment.

### Files

**Create:**
- `apps/web/src/components/marketing/LongFormArticle.tsx`
- `apps/web/src/components/marketing/LongFormArticle.module.css`
- `apps/web/src/components/marketing/EditorialSplit.tsx`
- `apps/web/src/components/marketing/EditorialSplit.module.css`

**Modify:**
- `apps/web/src/app/login/LoginPageClient.tsx` — wrap the existing
  provider buttons + error block in `<EditorialSplit>` with the
  editorial column's title, deck, and body paragraphs. The OAuth
  handlers and `<Button>` instances stay as they are.
- `apps/web/src/app/login/page.module.css` — strip everything; the
  page now relies on `EditorialSplit` and `LongFormArticle` styles.
- `apps/web/src/app/legal.module.css` — strip everything; rely on
  `LongFormArticle`.
- `apps/web/src/app/privacy/page.tsx`, `apps/web/src/app/terms/page.tsx`
  — wrap content in `<LongFormArticle>` and remove any one-off layout
  rules.

**Delete:**
- The `.shell`, `.card`, `.header`, `.eyebrow`, `.title`, `.subtitle`,
  `.form`, `.error`, `.providerButton`, `.providerIcon`, `.legalCopy`,
  `.legalLink` rules from `app/login/page.module.css`. (Buttons now
  use the shared `<Button>` primitive's variants directly; legal copy
  uses `LongFormArticle`'s typography.)

### Key decisions

- Editorial copy is intentionally short and product-confident, not
  marketing-spammy. Three short paragraphs maximum on login.
- Body font: in 1B, this resolves to `var(--font-sans)` (the current
  baseline). When Phase 2 picks the direction, this updates by
  changing the token, not by editing each component.
- No animation on initial load. The page reads as still typography.

### Acceptance criteria

- The login page on a 1280px viewport shows two columns: editorial
  left, sign-in right; on a 640px viewport, columns stack.
- No `radial-gradient`, `backdrop-filter`, or `glass` reference exists
  in any login or legal CSS.
- Privacy and Terms pages render with `LongFormArticle` and are
  visually consistent with each other and with the login editorial
  column.
- The sign-in buttons remain functionally identical (same OAuth
  providers, same redirect handling, same error states).

---

## Acceptance criteria (top-level)

A 1B-complete repo satisfies all of these:

- `apps/web/src/components/ui/InlineCitations.tsx` does not exist.
- `apps/web/src/components/chat/ContextChips.tsx` does not exist.
- `apps/web/src/components/chat/BranchAnchorPreview.tsx` does not exist.
- `MessageRow.module.css` defines no role-keyed background, border, or
  border-radius.
- `paneRouteRegistry.tsx` does not register a chat pane as a companion
  to a media pane.
- `MediaHighlightsPaneBody` is not mounted as a sibling/secondary pane
  by any code path.
- Every reader surface has a 36px right gutter (24px on mobile).
- Cmd-K opened from any pane displays a scope chip.
- The login page CSS contains no `radial-gradient`, `backdrop-filter`,
  or `box-shadow` outside the shared shadow tokens.
- All chat, citation, and pane-registry snapshots have been re-recorded
  against the new shapes.

## Test and screenshot strategy

- Each PR re-records the snapshots it invalidates. We do not keep both
  shapes side-by-side.
- Component unit tests are rewritten against the new components. Old
  test files for deleted components are deleted (e.g., the
  ContextChips and BranchAnchorPreview test files).
- E2E reader tests in `make test-e2e` and `make test-e2e-ui` continue
  to pass. The `quote-to-chat` and reader resume e2e specs need
  updates because chat now mounts as an overlay rather than a pane.
- A new e2e spec `reader-overlays.spec.ts` covers: open chat overlay
  from selection popover; ESC dismisses; reader column unchanged
  before/after; gutter ticks present; click tick scrolls + pulses;
  Cmd-K scope chip appears.

## Risks

- **P4 timing.** Reorganizing pane orchestration last means the
  preceding 1B PRs need to coexist with the still-existing chat-as-pane
  shape. Each PR must be careful not to touch
  `requestOpenInAppPane(...)` for chat-from-media until P4. Mitigation:
  P0–P3, P5, P6, P7 only modify their own surfaces.
- **Pulse event subscriber lifetime.** If multiple reader instances
  (multiple media panes open at once) subscribe to the global pulse
  event, only the one matching `mediaId` should respond. Each reader
  filters on its own `mediaId` before scrolling.
- **Sentence segmentation in P0.** `Intl.Segmenter` is broadly
  supported but missing on a few older mobile browsers. Sentence focus
  silently downgrades to paragraph focus on those — no polyfill ships.
- **Highlight tick positioning for HTML/EPUB requires layout.** First
  paint of the gutter shows ticks computed from approximate text
  offsets; precise tick positions stabilize after the IntersectionObserver
  settles (~one frame after layout).
- **Citation insertion into markdown.** If the markdown stack is not
  remark-based (verify), the placeholder substitution happens as a
  pre-pass on the content string. Edge case: a literal `[1]` in the
  source content that is NOT a citation must be left alone — the
  placeholder uses a unique sentinel like `<<cite:NN>>` and is only
  emitted by `insertCitationsIntoMarkdown`.

## Out of scope (to prevent scope creep during PRs)

- New chat features (e.g., quote replies in the overlay beyond what
  exists today).
- Reader settings page redesign beyond adding the focus-mode and
  hyphenation controls.
- Pinning the highlights inspector open as a non-overlay (deferred to
  Phase 2 if useful).
- Customizing per-pane command sets beyond the seven supported pane
  types.
- Writing landing/marketing pages beyond login + privacy + terms.

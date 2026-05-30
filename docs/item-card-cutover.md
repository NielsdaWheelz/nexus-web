# Item Card — hard cutover spec

Status: approved — ready to implement · Owner: reader/highlights · Type: hard cutover (no legacy, no fallbacks, no back-compat)

A single, centralized, presentational card for "an item in a list" — a highlight (with
its selected text in context, an inline note, linked chats, and an actions menu) and,
in the same visual vocabulary, a referenced resource (media/page) when items are listed
in a chat's context. Replaces the bespoke row markup inside `ReaderHighlightsSurface`
and `ConversationReferencesSurface`, and folds the bespoke `HighlightActionsMenu` into
`ui/ActionMenu`.

---

## 1. Context & problem

Highlights/notes are rendered today by one component — `ReaderHighlightsSurface.tsx`
(`renderRow`, lines 553–705) — but the row markup is bespoke, heavy, and visually broken:

- **The "giant bullet point"** is the outline drag-handle. Notes render through
  `ProseMirrorOutlineEditor`, whose schema `toDOM` always emits
  `<button class="note-block-handle">` (`lib/notes/prosemirror/schema.ts:39`), styled as a
  6→10px filled dot at `left:6px; top:0.82em` inside an `li` with `padding-left:24px`
  (`ProseMirrorOutlineEditor.module.css:34,42`). Pointless for a single-block highlight note.
- **A full rich-text editor is mounted on every row, even with no note.** `renderRow`
  forces `notesToRender = linkedNotes.length ? linkedNotes : [null]`
  (`ReaderHighlightsSurface.tsx:562`) and `HighlightNoteEditor.module.css:6` pins
  `.ProseMirror { min-height: 76px }` at `--text-md`. Every highlight carries a ~76px empty
  bulleted box.
- **Row chrome competes for ~280–360px.** Snippet button + two icon chat-buttons + a bespoke
  menu all share one flex row (`:589`) inside a width-capped secondary.
- **Two parallel menu systems.** `ui/ActionMenu` (portaled, full keyboard nav, `tone:"danger"`,
  separators) and `reader/HighlightActionsMenu` (tab-trap only) coexist; the chat actions live
  in neither.
- **Linked conversations are always-on stacked full-width buttons** (`:683`), not collapsible.

The same "list item" concept is duplicated elsewhere: `ConversationReferencesSurface.tsx`
(the chat context list) hand-rolls its own row (`:20`). `ui/ContextRow` is a third, unrelated
row primitive (horizontal, single-line) used by search/AppList.

**The margin-note alignment engine is correct and out of scope.** `alignRows`, the projection
in `useAnchoredHighlightProjection`, `rowHeights` measurement, the `ResizeObserver`, overflow
counting, and mobile above/below navigation (`ReaderHighlightsSurface.tsx:150–375, 818–851`)
stay **byte-for-byte unchanged**. This cutover swaps only the *content* of each positioned row.

---

## 2. Goals

1. One centralized, presentational `ItemCard` that renders a highlight or a referenced resource,
   reused by the reader highlights secondary and the chat context list.
2. Selected text shown highlighted in context (`HighlightSnippet`), readable and wrapping cleanly.
3. A single `⋯` actions menu per item — quote-to-chat, color, edit bounds, delete — built on
   `ui/ActionMenu`. No loose row buttons.
4. An inline note editor that is compact and bullet-free (no handle, no 24px indent, no 76px min).
5. Linked items (chats, …) in a collapsible disclosure.
6. Consolidate: delete `HighlightActionsMenu`; extend `ui/ActionMenu` once; add one `ui/Disclosure`.
7. Clean, token-driven layout (rows/cols/flex/spacing/typography), no magic pixels.

## 3. Non-goals

- **No change to the alignment engine** (`alignRows`, projection, measurement, overflow, mobile
  nav). The card is positioned and measured exactly as the current row is.
- No change to highlight/note/reference data models, APIs, or BFF routes.
- No change to `ui/ContextRow` or its consumers (`SearchResultRow`, `AppList`).
- No backend enrichment of conversation references (resource variant uses the label/summary it
  already has).
- No new highlight features (no reorder, no multi-select, no preview modes).
- `ReaderOverviewRuler` keeps using `HighlightSnippet` directly; untouched.

---

## 4. Target behaviour (UX)

A highlight card, compact by default, inside the reader highlights secondary:

```
┌────────────────────────────────────────────┐
│ …the selected text shown in context with a  │   ← HighlightSnippet (prefix · mark(exact) · suffix)
│   colored mark, wrapping to 2 lines.    [⋯] │   ← ActionMenu trigger, top-right
│ Add a note…                                  │   ← compact, bullet-free inline editor (always visible)
│ ▸ 2 linked chats                             │   ← Disclosure, collapsed by default
└────────────────────────────────────────────┘
```

- **Compact (unfocused):** snippet clamped to ~2 lines; one-line note editor; disclosure collapsed.
- **Expanded (focused):** full snippet context; note editor grows with content; disclosure openable.
  Expansion is driven by the host's existing `focusedId`; the host already remeasures row heights
  when `focusedId` changes (`ReaderHighlightsSurface.tsx:251`), so no engine change is needed.
- **Click** on the card body (not on an interactive child) focuses + scrolls to the highlight.
- **Hover** outlines the in-document highlight segments (reader-only behaviour, injected by host).
- **`⋯` menu:** Quote to new chat · Quote to existing chat · Edit bounds (toggles to "Cancel edit
  bounds") · color swatches · Delete highlight (danger, separated).
- **Resource variant** (chat context list): kind icon + title (label) + summary meta + `⋯`
  (Open · Remove). No note editor, no snippet, no linked-items disclosure.

---

## 5. Architecture & final state

Presentational card + thin adapters; stateful concerns stay in the hosts.

```
ui/ActionMenu (extended: + render escape hatch for custom content)
ui/Disclosure (new primitive)
ui/HighlightSnippet (reused as-is)
        ▲                ▲              ▲
        └──────── components/items/ItemCard ────────┐  (pure, presentational, no domain imports)
                          ▲                          │  renders: snippet|title, ⋯ menu, note slot,
                          │                          │           linked-items disclosure
        ┌─────────────────┴───────────┐     ┌────────┴─────────────────┐
   reader adapter                      │     chat-context adapter       │
   ReaderHighlightsSurface           │     ConversationReferencesSurface
   (alignment engine UNCHANGED;        │     (resource variant; open/remove)
    builds ActionMenuOption[];         │
    injects <HighlightNoteEditor       │
    compact/> as the note slot;        │
    maps linked_conversations →        │
    linkedItems[])                     │
```

Key boundary: **`ItemCard` imports only leaf UI** (`HighlightSnippet`, `ActionMenu`, `Disclosure`,
`Pill`, icons). It does **not** import `HighlightNoteEditor`, ProseMirror, or any highlights/
conversations API *at runtime*. The editor arrives as a `note` ReactNode slot; linked items arrive
as data. Type-only imports are allowed — purity is about runtime coupling, not types — so the
`HighlightColor` type import in §6.1 is fine (it erases at compile time and pulls in no runtime
domain code). That purity is what makes it reusable in both hosts and keeps the alignment engine
isolated.

---

## 6. Capability contract & API design

### 6.1 `components/items/ItemCard.tsx`

```ts
import type { CSSProperties, ReactNode, Ref } from "react";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { HighlightColor } from "@/lib/highlights/segmenter";

export interface ItemCardLinkedItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onActivate: () => void;
}

export type ItemCardContent =
  | {
      kind: "highlight";
      snippet: { prefix?: string | null; exact: string; suffix?: string | null; color: HighlightColor };
    }
  | {
      kind: "resource";
      title: ReactNode;
      icon?: ReactNode; // kind glyph; adapter derives it from the resource_uri scheme (see §7)
    };

export interface ItemCardProps {
  content: ItemCardContent;
  meta?: ReactNode;                 // page / source / date — muted line
  actions?: ActionMenuOption[];     // ⋯ menu; omitted/empty → no trigger rendered
  note?: ReactNode;                 // injected editor slot (highlight variant only)
  linkedItems?: ItemCardLinkedItem[];
  linkedItemsSummary?: ReactNode;   // disclosure summary; default `${n} linked`
  expanded?: boolean;               // compact (false) vs expanded (true); from host focus
  selected?: boolean;               // focused styling + aria-pressed on the body button
  onActivate?: () => void;          // body click (ignores clicks on a/button/input/editor)
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;

  // Host pass-through (the card root is the measured/positioned element):
  rootRef?: Ref<HTMLDivElement>;    // host sets for measurement (was setRowRef)
  style?: CSSProperties;            // host sets `transform: translateY(...)` on desktop
  className?: string;               // host adds flowRow (mobile) / focus class
  highlightId?: string;             // → data-highlight-id (reader)
  testId?: string;                  // → data-testid
}
```

Behavioural rules baked into the card:
- The body-click guard (ignore clicks landing on `a, button, input, textarea, select,
  [contenteditable="true"], .ProseMirror`) moves **into the card** (was inline in the host at
  `ReaderHighlightsSurface.tsx:576`).
- The snippet/title region is a `<button aria-pressed={selected}>` calling `onActivate`.
- `⋯` rendered iff `actions?.length`. Linked-items disclosure rendered iff `linkedItems?.length`.
- Compact vs expanded is pure CSS keyed off `expanded` (snippet line-clamp, note max-height).
  No JS height math in the card — the host measures the rendered card as it already does.

### 6.2 `ui/ActionMenu` — custom-content escape hatch (single, minimal extension)

`ActionMenuOption` gains one optional field:

```ts
export interface ActionMenuOption {
  id: string;
  label: string;            // required (used as accessible name even for custom content)
  // NEW: a render *function* (not a bare node) so custom content can dismiss the menu
  // after acting. ActionMenu's `closeMenu` is otherwise private (ActionMenu.tsx:64, 276).
  render?: (controls: { closeMenu: () => void; triggerEl: HTMLButtonElement | null }) => ReactNode;
  onSelect?: (detail: { triggerEl: HTMLButtonElement | null }) => void;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  restoreFocusOnClose?: boolean;
  separatorBefore?: boolean;
}
```

- When `render` is set, `ActionMenu` calls it with `{ closeMenu, triggerEl }` and emits
  `<li role="none">{render(...)}</li>` wrapped in `role="group" aria-label={label}`, **not** a
  `menuitem` button. `closeMenu` is the menu's own dismiss-and-restore-focus function
  (`ActionMenu.tsx:64`), passed in so rendered content can close the menu after acting — the same
  thing the built-in option handlers do at `ActionMenu.tsx:263, 279`. Arrow/Home/End/typeahead
  navigation continues to target `[role="menuitem"]` and skips custom content; custom content is
  reachable via the existing Tab trap (`ActionMenu.tsx:133–144`). This matches the prior
  `HighlightActionsMenu` behaviour (Tab-only into the color row) while inheriting ActionMenu's
  superior menuitem nav for the textual options.
- The color picker is supplied as
  `{ id: "color", label: "Highlight color", render: ({ closeMenu }) => <HighlightColorPicker … onSelectColor={(c) => { void onColorChange(c); closeMenu(); }} /> }`.
  Selecting a swatch applies the color and dismisses the menu via the injected `closeMenu`.

### 6.3 `ui/Disclosure.tsx` (new primitive — none exists in the repo)

```ts
export interface DisclosureProps {
  summary: ReactNode;           // e.g. "2 linked chats"
  children: ReactNode;          // revealed region
  defaultOpen?: boolean;        // default false
  className?: string;
  summaryClassName?: string;
  regionClassName?: string;
}
```

- Uncontrolled `open` state; `<button aria-expanded aria-controls>` + region with matching `id`.
- A chevron rotates via a token-driven transition (`--duration-fast`, `--ease-snap`).
- Stays generic (no highlight/chat coupling) so search results, references, etc. can adopt it.

### 6.4 `ProseMirrorOutlineEditor` — `compact` prop

```ts
interface ProseMirrorOutlineEditorProps { /* …existing… */ compact?: boolean; }
```

- `compact` adds a `styles.compact` class to the editor shell. In compact mode the module CSS:
  - hides `.note-block-handle` (`display:none`) — **removes the bullet**;
  - sets `li[data-note-block-id] { padding-left: 0 }` — removes the 24px indent;
  - drops `min-height` on `.note-block-content`/`p` to a single line; font `--text-xs`,
    line-height `--leading-snug`, color `--ink-muted`.
- The schema is unchanged (shared); compaction is purely presentational. `HighlightNoteEditor`
  passes `compact` and its own module CSS drops the `min-height: 76px` rule.

---

## 7. How it composes with other systems

- **Alignment engine (untouched):** the host renders `<ItemCard rootRef=… style={{transform}} … />`
  in place of the old `<div>`; `rootRef` replaces `setRowRef`, `style` carries the `translateY`,
  `className` carries `flowRow`/focus. `alignRows`, projection, `rowHeights`, `ResizeObserver`,
  `overflowCount`, and mobile above/below remain identical.
- **Note editor session:** `HighlightNoteEditor`'s save/conflict/optimistic-lock logic
  (`useNoteEditorSession`, revisions) is unchanged; only `compact` styling is added. The host still
  owns note state, the `notesToRender` fan-out, draft keys, and `scheduleNoteLayoutMeasure` →
  `noteLayoutVersion` (which the editor triggers via `onLocalChange`). The card just hosts the slot.
- **Actions:** the host builds `ActionMenuOption[]` from highlight ownership/flags
  (`canQuoteToChat`, `is_owner`, `isEditingBounds`, `changingColor`, `deleting`) and the existing
  handlers (`handleColorChange`, `handleDelete`, `onQuoteToNewChat`, `onQuoteToExtantChat`,
  `onStartEditBounds`/`onCancelEditBounds`). `HighlightColorPicker` is passed via `render`.
- **Pane runtime:** unchanged. `HighlightNoteEditor` keeps using `usePaneRuntime` for opening
  linked objects; resource-variant "Open" uses the host's existing `onOpenResource`.
- **References (chat context):** `ConversationReferencesSurface` maps each `ConversationReference`
  → `ItemCard` (`content.kind:"resource"`, title=label, meta=summary, actions=[Open, Remove],
  `missing` → dimmed + disabled Open). The kind icon comes from a **complete scheme→glyph map**
  matching the resolver's dispatch table and the reference URI grammar: `media`, `library`, `span`,
  `chunk`, `highlight`, `page`, `note_block`, `fragment`, `conversation`, `message` — plus a generic
  fallback glyph for any unknown/`missing` scheme. (Sources of truth:
  `python/nexus/services/resource_resolver.py:62` dispatch and
  `python/nexus/services/conversation_references.py:42` `_URI_PATTERN`; chat runs auto-add
  `span`/`chunk`/`note_block`/etc., `python/nexus/services/chat_runs.py:396`.) The
  scheme→glyph map lives in one small helper (e.g. `lib/resources/resourceKind.ts`) so the icon
  set has a single owner; do not inline a partial switch in the secondary.

---

## 8. Reuse / consolidation decisions (resolved)

| Question | Decision | Why |
|---|---|---|
| `ItemCard` vs `ui/ContextRow` | **Keep separate.** | Different archetypes: ContextRow is a horizontal, single-line (`white-space:nowrap`) row; ItemCard is a vertical rich card (wrapping snippet, embedded editor, disclosure). Folding one into the other means fighting `.title` nowrap + restructuring at every slot (the near-duplicate-API smell `docs/rules/module-apis.md` warns against). The real DRY win is reusing `ItemCard` across hosts. |
| `ui/ActionMenu` vs `reader/HighlightActionsMenu` | **Merge → delete `HighlightActionsMenu`.** | ActionMenu is strictly better (keyboard nav, danger tone, separators); the bespoke menu existed only to host the color swatches + edit-bounds toggle. One small `render` escape hatch closes the gap and upgrades the highlight menu's a11y. |
| `AssistantEvidenceDisclosure` vs `expandedContent` | **Neither is a disclosure — build `ui/Disclosure`.** | `AssistantEvidenceDisclosure` is a misnamed chat message-body renderer (no toggle); `expandedContent` is a static full-width slot. No collapsible primitive exists, so introduce one. |

---

## 9. Scope

**In scope**
- New `components/items/ItemCard.{tsx,module.css}` (+ test).
- New `components/ui/Disclosure.{tsx,module.css}` (+ test).
- Extend `ui/ActionMenu` with `render` option (+ test).
- Add `compact` to `ProseMirrorOutlineEditor` and compact CSS; drop the 76px min in
  `HighlightNoteEditor.module.css`.
- Rebuild `ReaderHighlightsSurface` row rendering on `ItemCard`; trim dead CSS.
- Rebuild `ConversationReferencesSurface` rows on `ItemCard` (resource variant).
- Delete `reader/HighlightActionsMenu.{tsx,module.css}`.
- Update affected tests.

**Out of scope**
- Alignment engine, projection, measurement, mobile nav.
- Data models / APIs / BFF routes; reference enrichment.
- `ui/ContextRow` and its consumers.
- `ReaderOverviewRuler`.

---

## 10. Files

**New**
- `apps/web/src/components/items/ItemCard.tsx`
- `apps/web/src/components/items/ItemCard.module.css`
- `apps/web/src/components/items/ItemCard.test.tsx`
- `apps/web/src/components/chat/ConversationReferencesSurface.test.tsx`

> **As built — minimalism deviations** (the implementing goal's "treat every abstraction as a cost / inline one-use" directive overrode the spec, since each proposed primitive had exactly one consumer):
> - **No `ui/Disclosure` component.** The collapsible linked-items list is a native `<details>/<summary>` inlined in `ItemCard` — zero JS, keyboard-operable and accessible by default (AC6 satisfied via native disclosure semantics rather than `aria-expanded`/`aria-controls`).
> - **No `lib/resources/resourceKind.ts` helper.** The scheme→icon map (all 10 schemes + `Link2` fallback) is an inline `const SCHEME_ICONS` in its only consumer, `ConversationReferencesSurface.tsx`.
> - `HighlightNoteEditor` hardcodes `compact` on its internal editor (highlight notes are always compact) instead of threading a prop through its own API.

**Modified**
- `apps/web/src/components/ui/ActionMenu.tsx` (+ `render` option) · `ActionMenu.test.tsx`
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx` (+ `compact`) ·
  `ProseMirrorOutlineEditor.module.css` (compact rules)
- `apps/web/src/components/notes/HighlightNoteEditor.tsx` (pass `compact`) ·
  `HighlightNoteEditor.module.css` (drop `min-height:76px`)
- `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` (render `ItemCard`; build
  `ActionMenuOption[]`; engine code unchanged) · `ReaderHighlightsSurface.module.css` (remove
  `.linkedItemRow/.rowTop/.contextButton/.contextText/.rowActions/.chatButton/.noteEditor*/
  .conversationList/.conversationButton/.editHint`; keep `.root/.header/.linkedItemsContainer/
  .mobileVisibleContainer/.flowRow/.overflowIndicator/.mobileIndicator/.empty*`) ·
  `ReaderHighlightsSurface.test.tsx`
- `apps/web/src/components/chat/ConversationReferencesSurface.tsx` (render `ItemCard`) ·
  `ConversationReferencesSurface.module.css` (reduce to container only)

**Deleted**
- `apps/web/src/components/reader/HighlightActionsMenu.tsx`
- `apps/web/src/components/reader/HighlightActionsMenu.module.css`

Confirmed blast radius: `HighlightActionsMenu` is imported only by `ReaderHighlightsSurface`;
`ConversationReferencesSurface` is consumed by `ConversationPaneBody` and `ConversationNewPaneBody`
(both via the secondary, so no pane-body edits needed); `ContextRow` consumers are unaffected.

---

## 11. Key details

- **The bullet** = `note-block-handle` from `schema.ts:46` (a real "open note block" button), not
  CSS decoration. Compact mode hides it; the schema is shared and untouched.
- **Always-visible compact editor:** per decision, the note editor stays mounted on every highlight
  card (one ProseMirror instance per visible highlight — accepted cost), but compact and bullet-free.
- **Color in the menu:** `HighlightColorPicker` (`components/highlights/HighlightColorPicker.tsx`)
  is reused verbatim as the `render(controls)` payload of the color option; `onSelectColor` applies
  the color and calls the injected `controls.closeMenu()` to dismiss the menu.
- **Resource scheme icons:** the scheme→glyph map must cover all ten schemes the backend resolves
  (`media library span chunk highlight page note_block fragment conversation message`) with a
  generic fallback; centralized in one helper (§7), not a partial inline switch.
- **Tokens only:** spacing `--space-*`, radii `--radius-*`, type `--text-*`/`--leading-*`, colors
  `--surface-*`/`--ink-*`/`--edge-*`/`--accent`, highlight marks `--highlight-*`, control sizes
  `--size-*`. No raw px except where a measured constant is justified (`docs/rules/conventions.md`).
- **Measurement parity:** the card root carries `rootRef`; the host's `useLayoutEffect`
  height measurement and `alignRows` see the card exactly as before.

---

## 12. Key decisions (resolved)

1. **Name & location → `components/items/ItemCard`.** Kind-neutral; it renders both a highlight and
   a media/resource item. (`components/items` is currently free; confirmed no `ItemCard` collisions.)
2. **Migrate the chat context list now → yes.** `ConversationReferencesSurface` is rebuilt on
   `ItemCard` (resource variant) in this cutover so there is genuinely "one component." The resource
   variant uses only data the reference already carries (label/summary/uri) — no snippet, no editor,
   no backend change.

---

## 13. Acceptance criteria

1. No element in a highlight card renders a bullet/disc; `.note-block-handle` is not visible in the
   secondary (compact editor). No 24px note indent; empty note editor is a single line, not ~76px.
2. Each highlight card shows the selected text via `HighlightSnippet` (colored `mark`, wrapping),
   a single `⋯` menu, the compact note editor, and — when present — a collapsed "N linked chats"
   disclosure. No loose chat/color/delete buttons remain on the row.
3. The `⋯` menu contains Quote-to-new-chat, Quote-to-existing-chat, Edit/Cancel-bounds, color
   swatches, and Delete (danger, separated); all actions perform exactly as before.
4. `reader/HighlightActionsMenu.*` is deleted and unreferenced; `rg HighlightActionsMenu` is empty.
5. `ui/ActionMenu` supports `render` options; existing menus elsewhere are visually/behaviourally
   unchanged; keyboard nav still cycles textual `menuitem`s.
6. `ui/Disclosure` toggles with `aria-expanded`/`aria-controls` and is keyboard-operable.
7. The alignment engine is unchanged: highlights still float to their in-document position, collide/
   stack correctly, show `+N more below`, and the mobile above/below navigation works. Diff of
   `alignRows`/projection/measurement code is empty.
8. The chat context list (`ConversationReferencesSurface`) renders via `ItemCard` (resource variant),
   including the `missing` dimmed/disabled state, open, and remove, with a kind icon for every
   resolver scheme (`media library span chunk highlight page note_block fragment conversation
   message`) and a generic fallback for unknown schemes.
9. `ItemCard` imports no *runtime* domain/editor/API modules (presentational purity); type-only
   imports such as `HighlightColor` are allowed. The note editor and color picker reach it via the
   `note` slot and the `render` option, never via direct import.
10. `make check-front` (lint + typecheck), `make test-front-unit`, and `make test-front-browser`
    pass; updated tests cover the new card, the `ActionMenu` `render` option, and `Disclosure`.

---

## 14. Rules adhered to (`docs/rules/`)

- **module-apis:** one card, one menu, one disclosure — each capability in a single primary form.
- **cleanliness:** hard cutover — delete `HighlightActionsMenu` and all superseded CSS; no dead
  classes, no fallbacks, no compat shims.
- **simplicity:** no speculative props; `render`/`compact` added only because real call sites need
  them; compact/expanded is CSS, not a new state machine.
- **conventions:** tokens over magic numbers; constants only where the name adds information.
- **typescript:** discriminated `ItemCardContent` union; no decomposed inner type params.

---

## 15. Cutover steps (ordered)

1. Add `ui/Disclosure` (+ test).
2. Extend `ui/ActionMenu` with `render` (+ test); verify existing menus unchanged.
3. Add `compact` to `ProseMirrorOutlineEditor` (+ CSS); drop `min-height:76px` in
   `HighlightNoteEditor`.
4. Build `components/items/ItemCard` (+ CSS, + test) — presentational only.
5. Rebuild `ReaderHighlightsSurface` `renderRow` on `ItemCard`; build `ActionMenuOption[]`; leave
   the engine untouched; trim dead CSS; update its test.
6. Delete `reader/HighlightActionsMenu.*`.
7. Rebuild `ConversationReferencesSurface` rows on `ItemCard` (resource variant); reduce its CSS;
   add the `lib/resources/resourceKind.ts` scheme→glyph helper.
8. `make check-front && make test-front-unit && make test-front-browser` (or `make verify` for the
   full gate); manual pass on desktop + mobile reader and a chat with references.

---

## 16. Risks & mitigations

- **Color swatches inside ActionMenu keyboard model.** Mitigate: render as `role="group"` custom
  content reachable by Tab (parity with the old menu), leaving arrow-nav to textual items.
- **Compact editor height vs alignment collisions.** Lower, predictable note heights only *help* the
  existing collision math; measurement is unchanged, so risk is cosmetic. Verify expand-on-focus
  still triggers the host remeasure (it keys off `focusedId`).
- **Resource variant is data-thin.** It intentionally shows label/summary only; if richer media
  metadata is wanted in chat context later, enrich the references payload (separate change).

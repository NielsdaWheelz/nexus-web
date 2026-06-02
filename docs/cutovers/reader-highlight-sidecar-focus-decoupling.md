# Reader highlights sidecar — focus stops gating verbosity · hard cutover spec

Status: **Approved direction, ready to implement.** Hard cutover. No legacy paths, no
fallbacks, no compatibility shims, no feature flags. One render path per slot.

This spec finishes the job that
[`reader-highlight-sidecar-focus-navigation.md`](./reader-highlight-sidecar-focus-navigation.md)
started. That cutover split **focus** from **navigation** ("focus never scrolls"). This one
splits **focus** from **verbosity**: focus stops being the gate that expands the snippet,
expands the note, and turns linked chats from non-interactive scent into clickable rows.
After this, focus means exactly one thing — *this card is selected; its mark is ringed in the
reader* — and nothing the user wants to **do** (open a linked chat, read a long highlight) is
hidden behind a select-first click.

It supersedes:

- [`reader-highlight-focus-driven-linked-chats.md`](./reader-highlight-focus-driven-linked-chats.md)
  — its §2/§4/§7 "blurred → scent, focused → clickable list" rule for linked chats, and
  AC1/AC2/AC6. The *render-gated, no-`hidden`, visible≡a11y* principle it established (§3)
  is **kept and strengthened**: chats are now always rendered as real buttons, so painted ≡
  reachable becomes unconditional. The `pluralize` consolidation it landed is untouched.
- [`reader-highlight-sidecar-exact-only.md`](./reader-highlight-sidecar-exact-only.md) — its
  "full untruncated on focus" assertion for the snippet/note. Clamp is no longer keyed on
  focus; it is per-slot and explicitly toggled.

It amends the focus-model docstring in `useHighlightInteraction.ts` (the comment claiming
"focus determines which linked-item row is expanded").

---

## 1. Context & problem

The sidecar (`ReaderHighlightsSurface`) renders each visible highlight as an `ItemCard` with
four slots: snippet, action bar, note, linked chats. A single host state — `focusState.focusedId`
(`useHighlightInteraction.ts:33-38`), threaded as `expanded={isFocused}`
(`ReaderHighlightsSurface.tsx:557`) — currently drives **four** unrelated things:

1. `selected` card styling — the accent border + the prose-mark ring (`.hl-focused`). *(Legit:
   this is selection/emphasis.)*
2. snippet clamp on/off (`ItemCard.module.css:82-87`, `-webkit-line-clamp: 6`).
3. note clamp on/off (`ItemCard.module.css:98-101`, `max-height: var(--size-xs)`).
4. linked chats: **non-interactive scent line** (blurred) vs **clickable `<ul>` of buttons**
   (focused) (`ItemCard.tsx:112-133`).

Items 2–4 are *verbosity* — how much of a card's content is shown and whether it is actionable.
Tying them to `focusedId` makes focus a **mode you must enter**, with two concrete costs:

- **Opening an existing linked chat takes two clicks.** A chat spawned from a highlight is the
  payoff of an AI-first reader; the prior cutover even argued chat titles must never hide behind
  a click — yet it left the *clickable target* behind a focus click. Titles show as scent; the
  button only exists once the card is focused (`ItemCard.tsx:113-126`,
  `ReaderHighlightsSurface.test.tsx:481-497` focuses first). Hiding the most valuable action
  behind a preliminary select is the wrong place to economize clicks.
- **Reading a long highlight requires selecting it,** and editing a long note requires the same
  (the note editor is clamped to one line at rest, `:98-101`, so you cannot see what you type
  until the card is focused). "Focus to read / focus to edit" is the same hidden-behind-a-click
  friction.

Every mature margin-annotation UI (Hypothesis, Readwise Reader, Google Docs comments) keeps a
*selected/active-annotation* state — that part is right and stays — but none gate the
annotation's primary actions behind selecting it first. The fix is not to delete focus; it is to
stop overloading it.

**Root cause.** `expanded` is one input wired to four outputs. Selection (output 1) belongs to
focus. Verbosity (outputs 2–4) does not. Collapse the conflation: give each verbosity slot its
own, explicit, focus-independent control.

---

## 2. Goals

1. **Linked chats are always interactive.** One click on a chat title opens that conversation,
   focused or not. No select-first step.
2. **Long highlights expand in place.** A per-card "Show more / Show less" toggle reveals a
   clamped snippet, shown **only when the text actually overflows the clamp**. Independent of
   focus and multi-open (several cards may be expanded at once).
3. **The note is always fully shown and editable.** Remove the note clamp; editing never
   requires focusing the card first.
4. **Focus becomes pure selection.** After this, `focusedId` drives only the `.selected` card
   styling, the prose `.hl-focused` ring, reveal-if-needed (unchanged), and the edit-bounds
   target. It no longer changes any slot's verbosity.
5. **Strengthen the render-gate invariant.** Linked-chat *painted ≡ reachable* becomes
   unconditional (always real `<button>`s); no `hidden`/CSS-display visibility logic anywhere
   in the card.
6. **Consolidate, don't proliferate.** Reuse the existing host-owned-`Set` expansion pattern
   and the `Button`/lucide toggle idiom; add no speculative shared hook.

---

## 3. Non-goals

- **Not** changing focus/navigation behaviour from the prior cutover: `focusHighlight` stays
  scroll-free; `revealHighlightInReader({align,onlyIfNeeded})` (`ReaderHighlightsSurface.tsx:367-399`)
  is untouched; ruler/URL-deep-link navigation is untouched.
- **Not** changing the prose `.hl-focused` / `.hl-hover-outline` appliers, `hoveredHighlightId`,
  or bidirectional hover (`MediaPaneBody.tsx:2508-2518`, `:3587-3598`).
- **Not** changing the action bar (`HighlightActionBar`/`buildHighlightActions`), its gating, or
  its hover/`:focus-within` opacity reveal (`ItemCard.module.css:38-46`). Quote-to-chat is
  already a single hover+click and is not in question.
- **Not** changing edit-bounds: it stays focus-coupled (selecting a highlight is the natural
  precondition for re-dragging its bounds) and is a single action-bar icon click, not a
  two-click gate (`ReaderHighlightsSurface.tsx:510-517`, `highlightActions.tsx:86-94`).
- **Not** changing the delete UX (`window.confirm`, `HighlightActionBar.tsx:86`) — still
  deferred per the prior cutover §16.
- **Not** changing the note editor, multi-note handling, color picker, or quote flows.
- **Not** a repo-wide `-webkit-line-clamp` utility sweep (9 call sites today across
  `ReaderCitation`, `HoverPreview`, `ReferencingChatRow`, `AppList`, `ReaderOverviewRuler`,
  oracle/podcasts pages). Already flagged optional in the prior cutover §10; stays out.
- **Not** adding overflow-gated "show more" to the note (it becomes always-full instead) or to
  any non-highlight `ItemCard` content.

---

## 4. Target behaviour (UX)

### 4.1 Linked chats — always one click

```
BEFORE (focus-gated)                              AFTER (always interactive)
┌────────────────────────────────────┐           ┌────────────────────────────────────┐
│ poolpah hit the fan. I had the…  ⋯ │           │ poolpah hit the fan. I had the…  ⋯ │
│ 💬 Poolpah theory · Vonnegut on war │  ──click  │ 💬 Poolpah theory                  │ ← each a
└────────────────────────────────────┘   row──▶  │ 💬 Vonnegut on war                 │   button,
   chats are a non-interactive scent line;        └────────────────────────────────────┘   always.
   you must focus the card before the                one click on a title opens that
   titles become clickable buttons.                  conversation. No focus required.
```

- A highlight with linked chats **always** renders them as a vertical list of clickable rows
  (icon + title each), regardless of focus. Clicking a row calls
  `onOpenConversation(id, title)` exactly once and does **not** fire the card's `onActivate`
  (stop-propagation preserved).
- Zero chats → renders nothing (unchanged).
- The blurred "scent line" (`styles.linkedScent`) is **deleted** — there is no blurred state for
  chats anymore.

### 4.2 Long highlight snippet — explicit show-more

- The snippet is clamped to 6 lines at rest (unchanged clamp count).
- When the snippet **overflows** the clamp, a compact "Show more" toggle renders beneath it
  (`Button variant="ghost" size="sm"`, lucide `ChevronDown`/`ChevronUp`). Clicking it expands the
  card to full text and flips the label to "Show less"; clicking again re-clamps.
- When the snippet does **not** overflow (short highlight), no toggle renders.
- Expansion is per-card and multi-open: expanding one card does not collapse others, and is
  independent of which card (if any) is focused.

### 4.3 Note — always full

- The note editor is rendered at full height in every state (the `:not(.expanded) .note`
  max-height clamp is removed). Editing a note never requires focusing the card first.

### 4.4 What focus still does (unchanged)

- **Click a card** → `onFocusHighlight(id)` → the card gains `.selected` (accent border) and its
  prose mark(s) gain `.hl-focused`; the reader reveals-if-needed (desktop in-view → no-op,
  mobile → gentle scroll). This is the SME-standard "select the on-screen annotation, don't move
  the document" behaviour the prior cutover landed.
- **Hover** (bidirectional), **mobile above/below jumps**, **edit-bounds** → unchanged.

---

## 5. Architecture & final state

### 5.1 Two ownership channels, by surface scope

The codebase already separates *cross-surface* state (lives in `MediaPaneBody`, mirrored into the
prose DOM) from *sidecar-local* state. This cutover respects that line:

```
CROSS-SURFACE (MediaPaneBody owns; reflected in the reader prose)   — UNCHANGED
  focusState.focusedId   → .selected card  + .hl-focused prose ring + reveal-if-needed + edit target
  hoveredHighlightId     → .hovered card   + .hl-hover-outline prose

SIDECAR-LOCAL (ReaderHighlightsSurface owns; never touches the prose) — NEW
  expandedTextIds: Set<string>  → which cards show the full (un-clamped) snippet
```

`expandedTextIds` is *sidecar-only* because text expansion has no meaning in the reader prose —
unlike focus/hover, it is never mirrored onto a mark. Putting it in `MediaPaneBody` would bloat
the host with state no other surface reads. It therefore lives in `ReaderHighlightsSurface`,
mirroring exactly how `PodcastDetailPaneBody` owns `expandedShowNotesMediaIds: Set<string>` for
the same "which rows are expanded" problem (§8.1).

### 5.2 The verbosity decoupling

`ItemCard`'s single `expanded` prop (one input → four outputs) is removed and replaced by
purpose-specific inputs:

| Old (`expanded` = `isFocused`) | New |
|---|---|
| `.selected` accent styling | `selected` prop (still `isFocused`) — **unchanged** |
| snippet clamp off | `showFullText` prop (from `expandedTextIds`), gated by measured overflow |
| note clamp off | **removed** — note always full |
| chats: scent ↔ list | **removed** — chats always a clickable list |

After the change `expanded` no longer exists on `ItemCard`. `selected`/`hovered` remain.
`focusedId` no longer changes any card's height except via the existing edit-bounds `meta` line
(`ReaderHighlightsSurface.tsx:550-554`), so the focus dependency stays in the layout-measure
effect for that reason alone (§11).

---

## 6. Capability contract & API design

### 6.1 `components/items/ItemCard.tsx`

```ts
interface ItemCardProps {
  content: ItemCardContent;
  meta?: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  linkedItems?: ItemCardLinkedItem[];   // now ALWAYS rendered as a clickable list
  selected?: boolean;                    // focus → accent border (unchanged)
  hovered?: boolean;                     // hover emphasis (unchanged)
  showFullText?: boolean;                // NEW: un-clamp the highlight snippet
  onToggleFullText?: () => void;         // NEW: user toggled the show-more control
  onActivate?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  rootRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  className?: string;
  highlightId?: string;
  testId?: string;
  // REMOVED: expanded
}
```

**`linkedItems` rendering rule (new contract):** always a
`<ul className={styles.linkedList} aria-label={pluralize(n, "linked chat")}>` of
`<li><button onClick={i.onActivate} /* stop-propagation */>{i.icon}<span>{i.label}</span></button></li>`.
No `expanded` branch. No `linkedScent` div. `pluralize` (already centralized) keeps the grammar
correct (`reader-highlight-focus-driven-linked-chats.md` §4).

**Snippet + show-more (the one narrow state `ItemCard` owns):** `ItemCard` keeps a body ref and
measures whether the *clamped* snippet overflows; it renders the toggle iff
`showFullText || isClamped` (§11 for the measurement contract). The toggle calls
`onToggleFullText`. This is presentational measurement of the component's own rendered DOM — it
has no desync risk with any other state (unlike the linked-chats-vs-focus desync the prior
cutover's "no internal state" rule guarded against, which this cutover deletes outright). It is
the only `useState`/`useLayoutEffect` in `ItemCard`. (Rejected alternatives: always-on toggle —
§12.3; lifting the body ref into `ReaderHighlightsSurface` — §12.4.)

`onToggleFullText`/`showFullText` are highlight-only; the `kind:"resource"` consumer
(`ConversationReferencesSurface.tsx`) ignores them, exactly as it ignored `expanded`.

### 6.2 `components/reader/ReaderHighlightsSurface.tsx`

```ts
// NEW sidecar-local state
const [expandedTextIds, setExpandedTextIds] = useState<Set<string>>(() => new Set());
const toggleTextExpansion = useCallback((id: string) => {
  setExpandedTextIds((prev) => {
    const next = new Set(prev);            // immutable replace → new ref → layout effect re-runs
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
}, []);
```

`renderRow` (`:482-592`) changes:

```ts
// remove:  expanded={isFocused}
selected={isFocused}                       // unchanged
hovered={hoveredId === highlight.id}       // unchanged
showFullText={expandedTextIds.has(highlight.id)}   // NEW
onToggleFullText={() => toggleTextExpansion(highlight.id)}   // NEW
```

No prop changes to `ReaderHighlightsSurfaceProps`: `expandedTextIds` is internal. `linkedItems`
mapping (`:540-549`) and everything else stay.

Prune stale ids (a card scrolled out of the viewport-scoped list): the existing draft/note-key
cleanup effect (`:256-276`) is the template — drop ids from `expandedTextIds` that are no longer
in `highlights`. (Cheap correctness; avoids an unbounded set across long reading sessions.)

### 6.3 `lib/highlights/useHighlightInteraction.ts`

No signature or behaviour change. Update the focus-model docstring (`:9-13`): delete "Focus
determines which linked-item row is expanded"; state that focus = selection/emphasis + the
edit-bounds target, and that **verbosity (snippet/note/chats) is no longer focus-driven.** The
scroll-free invariant comment (`:124-130`) stays.

---

## 7. How it composes with other systems

- **Focus/navigation cutover.** Orthogonal and preserved. This change removes outputs *from*
  `focusedId`; it adds nothing to the focus path and never makes focus scroll.
- **Scanline layout engine** (`alignRows`, `rowHeights`, `useLayoutEffect` `:215-254`). Toggling
  show-more changes a card's height; the engine repacks on the same `useLayoutEffect` that
  already repacks on note edits. `expandedTextIds` is added to its deps (§11), mirroring how the
  note slot signals height changes via `scheduleNoteLayoutMeasure` → `noteLayoutVersion`
  (`:423-431`, `:107`). Always-full notes only ever *grow* a card; packing handles it as it does
  any tall card today.
- **`ItemCard` resource consumer** (`ConversationReferencesSurface.tsx`). Renders `kind:"resource"`
  with `content`/`meta`/`actions`/`onActivate`, never `expanded`/`linkedItems`/`note`. Removing
  `expanded` and the note clamp cannot regress it. Verified: it is the only other `ItemCard`
  mount.
- **`HighlightSnippet`** (`ItemCard`, `ReaderOverviewRuler`). Untouched — it stays a pure text
  renderer; the clamp/toggle live in `ItemCard`, so the ruler's preview is unaffected.
- **`onOpenConversation`** (`MediaPaneBody.tsx:3212-3218` → `openInNewPane('/conversations/:id', title)`).
  Unchanged; chats now reach it without a focus precondition.

---

## 8. Reuse / consolidation decisions (resolved)

1. **Reuse the host-owned-`Set` expansion pattern.** `expandedTextIds: Set<string>` +
   immutable-`new Set` toggle is the same shape as
   `PodcastDetailPaneBody.expandedShowNotesMediaIds` (toggle-a-`Set` of expanded rows). Same
   idiom, same `data`/class-driven clamp removal. No new abstraction; just a second, consistent
   instance of an established pattern.
2. **Reuse the toggle idiom, do not centralize it.** The show-more control uses
   `Button variant="ghost" size="sm"` + a lucide chevron — the house pattern already used by
   `PodcastDetailPaneBody` (ghost text toggle) and `ForkNodeRow` (`:104-113`, chevron rotated via
   `data-expanded`). Two pre-existing show-more sites differ materially (podcast = always-on, no
   overflow detection; this = overflow-gated), so a shared `<ShowMore>` component or
   `useExpandable` hook would be a hollow generic over divergent needs. Per
   `docs/rules/cleanliness.md` ("prefer a little duplication over a hollow generic helper") and
   `docs/rules/simplicity.md` ("do not add speculative API surface"), **no shared component/hook
   is extracted.**
3. **No `useOverflow` hook.** None exists in the repo; this is its only real consumer. Detect
   overflow locally in `ItemCard` (`scrollHeight > clientHeight` on the clamped body). Extracting
   a hook for one call site is the speculative surface the rules forbid; revisit only when a
   genuine second consumer appears.
4. **Delete dead CSS/markup, don't leave it.** `.linkedScent` (`:103-110`) and the
   `:not(.expanded) .note` clamp (`:98-101`) and the `.expanded` class are removed, not retained
   "just in case" (hard-cutover rule). The shared single-line-ellipsis rule (`:112-119`) keeps
   only its `.linkedList button span` selector.
5. **Keep `pluralize`.** The always-rendered list keeps `aria-label={pluralize(n, "linked chat")}`
   — the prior cutover's consolidation stands.

---

## 9. Scope

**In:** `ItemCard.tsx` (remove `expanded`; always-list chats; add `showFullText`/`onToggleFullText`
+ local overflow measurement + show-more toggle), `ItemCard.module.css` (drop `.linkedScent`,
note clamp, `.expanded`; re-key snippet clamp to `:not(.showFull)`; add `.showMoreToggle`),
`ReaderHighlightsSurface.tsx` (own `expandedTextIds`; thread new props; prune stale ids; layout
deps), `useHighlightInteraction.ts` (1 docstring), and tests for all of it. Amend the two prior
cutover docs' superseded assertions (pointer notes, as the focus-navigation cutover did to
exact-only).

**Out:** everything in §3 — delete UX, action bar, navigation, note show-more, repo-wide clamp
sweep.

---

## 10. Files

| File | Change |
|---|---|
| `apps/web/src/components/items/ItemCard.tsx` | Remove `expanded` prop + the `expanded ? <ul> : <scent>` branch → always render the clickable `<ul>`. Add `showFullText`/`onToggleFullText`. Add a body ref + `useLayoutEffect`-measured `isClamped` state; render the show-more `Button` when `showFullText || isClamped`. |
| `apps/web/src/components/items/ItemCard.module.css` | Delete `.linkedScent` (`:103-110`) and `.card:not(.expanded) .note` (`:98-101`). Re-key snippet clamp `:not(.expanded)`→`:not(.showFull)` (`:82-87`). Replace `.expanded` (cx) with `.showFull`. Add `.showMoreToggle` (ghost-button alignment). |
| `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` | Add `expandedTextIds` state + `toggleTextExpansion`. In `renderRow`: drop `expanded`, add `showFullText`/`onToggleFullText`. Add `expandedTextIds` to the layout-measure effect deps (`:247-254`). Prune stale ids in the cleanup effect (`:256-276`). |
| `apps/web/src/lib/highlights/useHighlightInteraction.ts` | Update the focus-model docstring (`:9-13`) — focus is selection/emphasis + edit-bounds target; verbosity is no longer focus-driven. |
| `apps/web/src/components/items/ItemCard.test.tsx` | Rewrite the scent/list tests (`:33-110`) to the always-list contract; add show-more tests (overflow → toggle expands/collapses; short → no toggle). |
| `apps/web/src/components/reader/ReaderHighlightsSurface.test.tsx` | Rewrite "opens a linked conversation from a focused card" (`:481-497`) → "…without focusing first" (drop `focusedId`). Add a show-more test on a long-`exact` row. Keep focus-no-scroll (`:339-352`) + hover (`:354-367`). |
| `docs/cutovers/reader-highlight-focus-driven-linked-chats.md` | Amend §2/§4/§7/AC to point here (chats always interactive). |
| `docs/cutovers/reader-highlight-sidecar-exact-only.md` | Amend the "full on focus" snippet/note assertion to point here. |

No new files. Net deletion of CSS + one branch; net addition of one small measured toggle.

---

## 11. Key details

- **Overflow measurement contract.** On the clamped snippet body element, set
  `isClamped = el.scrollHeight - el.clientHeight > 1` in a `useLayoutEffect`. Measure **only while
  collapsed** (`!showFullText`) — when expanded the box is un-clamped and `scrollHeight ==
  clientHeight`, which is not a signal to hide the toggle. Re-measure when the snippet text or the
  card width changes (deps: `content.snippet.exact`, plus a `ResizeObserver` on the body, or reuse
  the row width signal). Toggle is shown iff `showFullText || isClamped`. This works because
  component tests run in **real Chromium** (Vitest browser project — `*.test.tsx` and
  `src/lib/highlights/**`), where `-webkit-line-clamp` and `scrollHeight` are real; jsdom would
  not compute clamp geometry (`docs/rules/testing_standards.md`: no jsdom for component behaviour).
- **Layout repack on toggle.** `expandedTextIds` (new `Set` ref per toggle) is added to the
  `useLayoutEffect` deps at `ReaderHighlightsSurface.tsx:247-254`. The effect already no-ops when
  measured heights are unchanged, so the extra dep is safe. `focusedId` stays in the deps: it
  still changes height via the edit-bounds `meta` line, even though it no longer expands slots.
- **Stop-propagation on chat buttons.** Preserve the existing behaviour so a chat click does not
  also fire the card's `onActivate` (focus). The `ItemCard` root `onClick` already early-returns
  for clicks inside `button` (`:84-93`); keep that and the existing `ItemCard.test.tsx:33-59`
  assertion (un-gated by `expanded`).
- **Always-full note height.** Notes are short; removing the clamp only grows cards that have a
  note, and the scanline packer handles tall cards already. No new measurement needed — the note
  editor's `scheduleNoteLayoutMeasure` path is unchanged.
- **Toggle a11y.** The show-more `Button` carries `aria-expanded={showFullText}` and an
  `aria-label` that names the action ("Show full highlight" / "Show less"), matching the
  `aria-expanded` + descriptive-label idiom used by `ForkNodeRow`/`PodcastDetailPaneBody`.

---

## 12. Key decisions (resolved)

1. **Chats are always a list, not always-clickable scent.** Rejected keeping a compact one-line
   scent with each title individually clickable: it muddies touch targets and re-introduces a
   second render shape for the same slot (more code paths). Chats-per-highlight is small (prior
   cutover §10), most highlights have **zero** linked chats, and the density cost of a vertical
   list is paid only where there is real payoff to surface. One render path wins
   (`docs/rules/simplicity.md`).
2. **Note becomes always-full; it does not get its own show-more.** The note is an *editable*
   ProseMirror surface; clamping an editor you can type into is a footgun, and overflow-gating an
   element whose height grows as you type is fiddly. Always-full removes the "focus-to-edit"
   friction directly. (If a pathological long note ever swamps the scanline, give the note its own
   toggle then — YAGNI now.)
3. **Show-more is overflow-gated, not always-on.** Rejected the simpler always-on toggle (which
   `PodcastDetailPaneBody` uses) because a dead "Show more" on a three-word highlight is noise.
   The cost is one local measurement, which a real-browser test layer makes observable. This is
   the only state `ItemCard` gains.
4. **Overflow measurement lives in `ItemCard`, not `ReaderHighlightsSurface`.** Rejected lifting a
   body ref into the host: it would couple the host to `ItemCard`'s internal DOM (`.body`) and lag
   the toggle by a render. The component that renders the clamped text is the only honest owner of
   "did my text overflow." The host owns *intent* (`expandedTextIds`); the card owns *measurement*
   (`isClamped`). Clean split, no desync.
5. **`expandedTextIds` is sidecar-local (RHS), not host-global (`MediaPaneBody`).** Text expansion
   is never mirrored into the prose; only focus/hover are. Keeping it in RHS avoids bloating the
   host with state no other surface reads (`docs/rules/cleanliness.md`: one owner per concern).
6. **Hard cutover.** `.linkedScent`, the note clamp, the `.expanded` class, and the `expanded`
   prop are deleted, not branched or flagged.

---

## 13. Acceptance criteria

1. **Chats open in one click, unfocused.** A blurred highlight with 2 linked chats renders two
   `<button>`s (accessible name = title); clicking one calls `onOpenConversation(id, title)` once
   and does not fire the card's `onActivate`. No `focusedId` is required first. The scent line
   (`First chat · Second chat` joined text) no longer exists in any state.
2. **Chat list a11y is unconditional.** `getByRole("list", { name: pluralize(n,"linked chat") })`
   and one `button` per chat are present whether or not the card is focused. Singular grammar:
   one chat → "1 linked chat".
3. **Long snippet shows a working toggle.** A highlight whose snippet overflows 6 lines renders a
   "Show more" control; clicking expands to full text and flips to "Show less"; clicking again
   re-clamps. A short snippet renders **no** toggle.
4. **Multi-open + focus-independent.** Expanding card A does not collapse card B; expanding a card
   does not focus it, and focusing a card does not expand its text.
5. **Note is always full and editable.** With no focus, a card's note editor is fully visible and
   editable (no one-line clamp); typing past one line is visible.
6. **Focus is pure selection.** Clicking a card sets `.selected` + the prose `.hl-focused` ring +
   reveal-if-needed (in-view desktop anchor → no scroll), and changes **no** slot's verbosity. The
   focus-no-scroll test stays green.
7. **No dead artifacts.** No `.linkedScent`, no `:not(.expanded) .note`, no `.expanded` class, no
   `expanded` prop on `ItemCard`; grep is clean. Typecheck + lint + full test suite green.
8. **Resource cards unregressed.** `ConversationReferencesSurface` renders identically (no
   `expanded`/note dependence).

---

## 14. Test plan

Component tests run in the **real-Chromium** Vitest browser project (per repo testing standards
and the project split for `*.test.tsx`), so clamp geometry and `scrollHeight` are real.

- **`ItemCard.test.tsx`** — rewrite `:61-110` to the always-list contract: blurred (no `expanded`)
  shows the clickable list, not a scent line; `onActivate` not fired by a chat-button click
  (`:33-59`, drop the `expanded` prop). Add: (a) a long-`exact` highlight in a width-constrained
  container renders a "Show more" button, clicking it un-clamps and shows "Show less"; (b) a short
  highlight renders no toggle.
- **`ReaderHighlightsSurface.test.tsx`** — rename `:481-497` to "opens a linked conversation
  without focusing first" (drop `focusedId="h1"`); assert `onOpenConversation("c1","Linked chat")`.
  Add a show-more test on a long row (assert the scanline repacks — row height grows — on expand).
  Keep focus-no-scroll (`:339-352`) and hover (`:354-367`) green.
- **E2E** (largest layer per `docs/rules/testing_standards.md`): in the desktop reader, click an
  existing linked chat from an unfocused card → conversation opens in a new pane; expand a long
  highlight → full text shows and neighbouring scanline cards reflow.

---

## 15. Rules adherence

- `docs/rules/simplicity.md` — one render path per slot (chats: list only; snippet: clamp +
  one toggle); no speculative props beyond `showFullText`/`onToggleFullText`.
- `docs/rules/cleanliness.md` — one owner per concern (focus = MediaPaneBody; text expansion =
  RHS; overflow measurement = ItemCard); deletes the conflated `expanded` input and dead CSS;
  declines a hollow shared show-more abstraction.
- `docs/rules/module-apis.md` — chats expose one primary interactive form, not two
  (scent + list) for the same capability.
- `docs/rules/testing_standards.md` — behaviour observable in the real-browser component layer +
  one user-flow E2E; no jsdom reliance for clamp geometry.
- Hard cutover — no legacy branch, no flag, no retained `Disclosure`/scent fallback.

---

## 16. Risks & mitigations

- **Overflow measurement flicker / SSR.** Measure in `useLayoutEffect` (post-layout, pre-paint);
  default `isClamped=false` so the server/first paint simply omits the toggle and it appears after
  measurement — no layout jump beyond the toggle's own small height, which the scanline repack
  absorbs.
- **Scanline density with always-full notes / always-listed chats.** Only cards that *have* a note
  or chats grow; most don't. The packer (`alignRows`) already spaces by measured height and emits
  `+N more` overflow. If real usage shows crowding, a note show-more is the future lever (§12.2) —
  not reintroducing focus-gating.
- **Stale `expandedTextIds`.** Pruned in the existing cleanup effect against the live `highlights`
  set, so a long session can't accumulate ids for scrolled-away highlights.
- **Touch (`hover:none`).** The action bar is already always-opacity-1 on touch
  (`ItemCard.module.css:48-52`); the show-more toggle is a normal tap target and chats are normal
  buttons — no hover dependence anywhere in the new paths.
</content>
</invoke>

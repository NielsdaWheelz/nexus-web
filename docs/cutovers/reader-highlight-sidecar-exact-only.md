# Reader highlights sidecar — exact-only selection · hard cutover spec

Status: approved — ready to implement · Owner: reader/highlights · Type: hard cutover (no legacy, no fallbacks, no back-compat)

The reader highlights secondary (`ReaderHighlightsSurface`, colloquially "the sidecar")
renders each highlight as the **selected text only, untruncated** — no surrounding
prefix/suffix context, no 2-line clip of the user's own selection. The selection is the
one piece of identifying content; it must always be the thing shown, in full. Surrounding
context is redundant here (it is on screen in the reader by definition) and belongs to the
overview ruler's hover popover, which is unchanged. This reverses, for the sidecar summary
form only, the "selected text in context, clamped to 2 lines" decision made in
`item-card-cutover.md` §4.

---

## 1. Context & problem

Each visible highlight is rendered by `ReaderHighlightsSurface.renderRow`
(`ReaderHighlightsSurface.tsx:556`), which builds an `ItemCard` (`kind:"highlight"`,
`ReaderHighlightsSurface.tsx:622–633`) whose body is a `HighlightSnippet`
(`ItemCard.tsx:67–74`) laying out `prefix` + `<mark>exact</mark>` + `suffix`. Two current
behaviours are wrong for this surface:

- **Context is always rendered.** `renderRow` passes `prefix`/`suffix` and never sets
  `compact`, so both render around the mark. The whole snippet sits at `--ink-muted`, with
  prefix/suffix further dimmed to `opacity: 0.7` (`HighlightSnippet.module.css:4,13–16`).
- **The selection — not the context — gets truncated.** Collapsed (unfocused) cards clamp
  the body to `-webkit-line-clamp: 2` (`ItemCard.module.css:52–57`); only the focused card
  (`expanded={isFocused}`, `ReaderHighlightsSurface.tsx:676`) is untruncated. Because
  `HighlightSnippet` emits prefix **first**, a long prefix fills both clamped lines and
  **pushes the actual highlighted text out of view**. The user scans a column of dim grey
  context with the `<mark>` — the thing that identifies the highlight — clipped or buried.

This duplicates what is already on screen. Per `docs/modules/reader-implementation.md:43–48`,
the secondary is **visible-only** — it shows only highlights in the *current viewport*,
"with their notes and actions" — and is explicitly the *"here, with notes"* instrument, as
opposed to the ruler *"map."* The surrounding prose is therefore already rendered in the
reader pane beside the card. Showing prefix/suffix again is pure redundancy.

The house rule already exists. `HighlightSnippet` ships a `compact` mode that renders
**exact-only at full `--ink` strength** (`HighlightSnippet.tsx:27–31`,
`HighlightSnippet.module.css:9–11`), used today by the ruler's cluster preview
(`ReaderOverviewRuler.tsx:336`). And the chat surface already distinguishes the two forms:
a highlight **summary renders as the exact text only**, while the full prefix/exact/suffix
`<quote>` is reserved for model context (chat quote-context cutover). The sidecar list is a
summary surface; it should use the summary form.

**Edge case the change exposes.** PDF highlights can have an empty `exact` (no text-layer
match — `plain_text_match_status` of `no_match`/`empty_exact`; `CreatePdfHighlightRequest.exact`
"may be empty"). Today such a highlight still shows *something* (its prefix/suffix context).
Exact-only would render a **blank card**. The cutover adds a placeholder so these stay
identifiable and clickable.

---

## 2. Goals

1. The sidecar shows each highlight as its **`exact` text only** — no prefix, no suffix —
   at full `--ink` strength, via `HighlightSnippet`'s existing `compact` mode.
2. The selection is **never clipped to hide itself**: collapsed cards clamp to a *generous*
   bound (option B); the focused card shows the full selection untruncated.
3. An empty-`exact` highlight renders a single muted placeholder ("No selectable text"),
   not a blank mark — owned in one place so every `HighlightSnippet` consumer benefits.
4. Consolidate on the existing exact-only renderer (`compact`): after this change `compact`
   = "summary form" is used by **both** the sidecar and the ruler cluster preview; the only
   prefix/exact/suffix "context form" consumer is the ruler's single-highlight popover.
5. Drop now-dead surface area: remove `prefix`/`suffix` from `ItemCard`'s highlight content
   (the sidecar is its only producer) — hard cutover, no compatibility shim.

## 3. Non-goals

- **No data-model / API / BFF change.** `Highlight.exact/prefix/suffix`, the highlights
  endpoints, `AnchoredHighlightRow.prefix/suffix`, and `toAnchoredHighlightRow` are
  unchanged. `prefix`/`suffix` remain on the row because the ruler popover still needs them.
- **No change to the alignment/projection engine** (`useAnchoredHighlightProjection`,
  `alignRows`, row measurement, `ResizeObserver`, overflow, mobile above/below). The card is
  positioned and measured exactly as now; only its body content/clamp changes.
- **No change to the ruler's single-highlight context popover** (`ReaderOverviewRuler.tsx:347–352`)
  — it keeps rendering prefix/exact/suffix. The ruler component file is not edited at all; it
  only inherits the empty-`exact` placeholder through the shared `HighlightSnippet` leaf.
- **No change to notes, linked-chats disclosure, the actions menu, color picker, or
  quote-to-chat.** The `note` clamp (`ItemCard.module.css:68–71`) is untouched.
- No new highlight features (no reorder, multi-select, preview modes, per-card "show context"
  toggle). Context lives in the reader and the ruler; that is the design.

---

## 4. Target behaviour (UX)

A highlight card in the reader highlights sidecar — **before → after**:

```
BEFORE (current)                              AFTER (this cutover)
┌────────────────────────────────────────┐   ┌────────────────────────────────────────┐
│ …still retain the ability to function.  │   │ poolpah                            [⋯]  │  ← exact only, full --ink,
│ poolpah hit the fan. I had the unmiti…  │   │ Add a note…                             │    untruncated (≤6 lines
│ Add a note…                       [⋯]   │   │ ▸ 2 linked chats                        │    collapsed; full on focus)
│ ▸ 2 linked chats                         │   └────────────────────────────────────────┘
└────────────────────────────────────────┘
  prefix(muted)+mark(exact)+suffix(muted),       the user's selection is the first and only
  clamped to 2 lines — exact can be off-screen   text; context lives in the reader + ruler
```

Empty-`exact` highlight (PDF region with no text layer):

```
┌────────────────────────────────────────┐
│ No selectable text                 [⋯]  │  ← muted italic placeholder, still clickable
│ ▸ 1 linked chat                          │    (click focuses; reveals only if off-screen
│                                          │     — see focus-navigation cutover)
└────────────────────────────────────────┘
```

- **Collapsed (unfocused):** `exact` only, full `--ink`, clamped to **6 lines** so a
  paragraph-length highlight cannot dominate the viewport-scoped list. Note editor and
  linked-chats disclosure behave exactly as today.
- **Expanded (focused):** `exact` only, **untruncated** — full selection shown. Driven by
  the host's existing `focusedId` → `expanded` (`ReaderHighlightsSurface.tsx:676`); the host
  already remeasures row heights on focus change, so no engine change is needed.
- **Click / hover / actions / notes:** unchanged.

---

## 5. Architecture & final state

The change is confined to the presentational leaf (`HighlightSnippet`), the presentational
card (`ItemCard`), and how the host calls the card. No stateful or engine code moves.

```
ui/HighlightSnippet            two modes, single owner of highlight-text rendering:
  ├─ compact  = SUMMARY form   exact only, full --ink              ← sidecar AND ruler clusters
  └─ default  = CONTEXT form   prefix·mark(exact)·suffix, muted     ← ruler single-highlight popover ONLY
  (+ empty-exact placeholder, rendered in place of an empty <mark> in BOTH modes)
        ▲                                   ▲
        │ compact (hardcoded)               │ compact + prefix/suffix
        │                                   │
components/items/ItemCard                ReaderOverviewRuler  (file unchanged; inherits placeholder)
  kind:"highlight" → { exact, color }
  renders <HighlightSnippet … compact/>
  collapsed clamp 6 lines / full on focus
        ▲
        │ snippet:{ exact, color }
        │
reader/ReaderHighlightsSurface.renderRow   (alignment engine UNCHANGED; stops passing prefix/suffix)
```

- `HighlightSnippet` stays the **single owner** of "how a highlight's text is shown." Adding
  the empty-`exact` placeholder there (not in the card) means the ruler cluster preview gets
  the same fix for free, with no edit to the ruler.
- `ItemCard` stays pure/presentational; its highlight content shrinks to `{ exact, color }`.
- The host (`renderRow`) keeps owning actions, notes, linked items, focus, and measurement.

---

## 6. Capability contract & API design

### 6.1 `ui/HighlightSnippet` — two modes + empty fallback (props unchanged)

```ts
interface HighlightSnippetProps {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
  color?: HighlightColor | "neutral";   // default "neutral"
  compact?: boolean;                     // default false
  className?: string;
}
```

- **`compact` is the formal "summary form":** prefix/suffix are omitted and the root renders
  at full `--ink` (`HighlightSnippet.module.css:9–11`). Default (`compact={false}`) is the
  "context form": prefix/exact/suffix, root `--ink-muted`, prefix/suffix `opacity: 0.7`.
- **Empty-`exact` fallback (new behaviour, no prop change):** when `exact.trim()` is empty,
  render a muted placeholder element instead of an empty `<mark>`:
  `<span class={styles.empty}>No selectable text</span>` — `--ink-faint`, `font-style: italic`,
  no mark background — in both modes. `EMPTY_EXACT_LABEL = "No selectable text"` is a module
  constant. In the context form the placeholder simply sits where the mark would, between any
  prefix/suffix.

### 6.2 `components/items/ItemCard` — highlight content drops context

```ts
type ItemCardContent =
  | {
      kind: "highlight";
      snippet: { exact: string; color: HighlightColor };   // was { prefix?, exact, suffix?, color }
    }
  | { kind: "resource"; title: ReactNode; icon?: ReactNode };
```

- The highlight branch renders `<HighlightSnippet exact={…} color={…} compact />`
  (`ItemCard.tsx:67–74`). `compact` is **hardcoded** — an item card is always a summary form,
  the same idiom by which `HighlightNoteEditor` hardcodes its editor's compact mode
  (`item-card-cutover.md` §10 "as built"). No new `ItemCard` prop is introduced.
- `prefix`/`suffix` are removed from the type and the JSX. This is a compile-enforced cutover:
  the sole producer (`ReaderHighlightsSurface.renderRow`) and the test fixtures must update or
  the build fails. No optional/back-compat fields.

### 6.3 `ItemCard.module.css` — generous collapsed clamp (option B)

```css
/* collapsed: clamp the selection to a generous bound so one long highlight
   cannot swamp the viewport-scoped list; focused (.expanded) shows it in full. */
.card[data-content-kind="highlight"]:not(.expanded) .body {
  display: -webkit-box;
  -webkit-line-clamp: 6;        /* was 2 */
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

- **Why 6:** at `--text-sm` (0.8125rem ≈ 13px) × `--leading-snug` (1.35) ≈ 17.6px/line, six
  lines ≈ ~105px — enough to read a multi-sentence selection in full, bounded enough to keep
  the list scannable. A unitless integer literal matches the codebase's existing line-clamp
  idiom (2, 3 across `ReaderOverviewRuler`, `HoverPreview`, `AppList`); no token exists for
  clamp counts and none is introduced.
- The `.expanded` (focused) case has no clamp → untruncated, satisfying option B.

### 6.4 `ReaderHighlightsSurface.renderRow` — stop passing context

The `ItemCard` content becomes `snippet: { exact: highlight.exact, color: highlight.color }`
(`ReaderHighlightsSurface.tsx:626–633`). `highlight.prefix`/`highlight.suffix` are no longer
read here. `hasQuoteText` and every other branch are unchanged.

---

## 7. How it composes with other systems

- **Overview ruler:** unchanged at the file level. Its single-highlight popover keeps the
  context form (`ReaderOverviewRuler.tsx:347–352`); its cluster preview keeps `compact`
  (`:336`). Both inherit the empty-`exact` placeholder from the shared leaf — a strict
  improvement (empty-`exact` cluster members stop rendering as blank marks).
- **Alignment/projection engine:** unchanged. The card root still carries `rootRef`/`style`/
  `className`; height measurement and `alignRows` see the card exactly as before. A shorter
  collapsed body (no context lines) is just a smaller measured height — the engine handles it
  with no code change.
- **Highlight data model & read paths:** unchanged. `prefix`/`suffix` still flow from the API
  through `toAnchoredHighlightRow` onto `AnchoredHighlightRow` for the ruler. The sidecar
  simply ignores them.
- **Chat surface:** independent. `ConversationReferencesSurface` uses only `ItemCard`
  `kind:"resource"` (`ConversationReferencesSurface.tsx:29`) and is unaffected by the highlight
  content shape change.
- **Notes / actions / linked chats / quote-to-chat / color:** all unchanged; they are separate
  `ItemCard` slots and host-owned `ActionMenuOption[]`.

---

## 8. Reuse / consolidation decisions (resolved)

| Question | Decision | Why |
|---|---|---|
| New "exact-only" renderer vs reuse `compact` | **Reuse `compact`.** | The exact-only, full-ink summary form already exists and is already used by the ruler clusters. Routing the sidecar through it gives one renderer for both surfaces (`docs/rules/module-apis.md`: use the existing capability, don't add a near-duplicate). |
| Empty-`exact` fallback in `ItemCard` vs `HighlightSnippet` | **`HighlightSnippet`.** | It is the single owner of highlight-text rendering. Placing the fallback there fixes the sidecar *and* the ruler cluster preview with one change and no ruler edit. A fallback in `ItemCard` would leave the ruler still emitting empty marks. |
| Host-provided rich fallback (e.g. "Highlight on page N") vs generic placeholder | **Generic placeholder.** | A page-number label would couple `HighlightSnippet`/`ItemCard` to PDF surface semantics and add speculative API (`docs/rules/simplicity.md`). The placeholder only needs to keep the row identifiable and clickable; the user jumps to the region in the reader, where it is visible. |
| Keep `prefix`/`suffix` on `ItemCardContent` "just in case" | **Remove them.** | Hard cutover; the sidecar is the only producer and it stops sending them. Dead fields violate `docs/rules/cleanliness.md` (delete unreferenced). The ruler uses `HighlightSnippet` directly, not via `ItemCard`. |
| Make the collapsed clamp count a token | **No — keep the integer literal.** | No clamp-count token exists; the codebase uses bare integers (2/3) for `-webkit-line-clamp`. Introducing one would be speculative. |
| Per-card "show context" toggle | **No.** | Context is in the reader and the ruler by design; a toggle re-introduces the redundancy this cutover removes. |

---

## 9. Scope

**In scope**
- `ui/HighlightSnippet`: empty-`exact` placeholder (constant + CSS); document the two modes.
- `components/items/ItemCard`: drop `prefix`/`suffix` from highlight content; hardcode
  `compact`; raise collapsed clamp 2 → 6.
- `reader/ReaderHighlightsSurface.renderRow`: stop passing `prefix`/`suffix`.
- Update affected tests (`ItemCard.test.tsx`, `ReaderHighlightsSurface.test.tsx`,
  `HighlightSnippet` test if present).

**Out of scope**
- Alignment/projection/measurement engine; mobile above/below nav.
- Highlight/PDF data models, schemas, APIs, BFF routes, `toAnchoredHighlightRow`.
- `ReaderOverviewRuler` (logic/file); `ConversationReferencesSurface`; `ui/ContextRow`.
- Notes editor, note clamp, actions menu, color picker, quote-to-chat, linked-chats disclosure.

---

## 10. Files

**Modified**
- `apps/web/src/components/ui/HighlightSnippet.tsx` — empty-`exact` placeholder; `EMPTY_EXACT_LABEL`.
- `apps/web/src/components/ui/HighlightSnippet.module.css` — `.empty` (muted, italic, no mark bg).
- `apps/web/src/components/items/ItemCard.tsx` — highlight content `{ exact, color }`; hardcode `compact`.
- `apps/web/src/components/items/ItemCard.module.css` — `-webkit-line-clamp: 6` (was 2) + comment.
- `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` — `renderRow` drops `prefix`/`suffix`
  from the `ItemCard` snippet (`:626–633`).

**Tests (modified)**
- `apps/web/src/components/items/ItemCard.test.tsx` — fixtures drop `prefix`/`suffix`
  (`:13–16`); add: prefix/suffix text is **not** in the DOM; empty-`exact` renders the
  placeholder, not an empty mark; non-empty `exact` still renders as `MARK`.
- `apps/web/src/components/reader/ReaderHighlightsSurface.test.tsx` — **invert** the current
  assertions: today `:287–289` assert prefix ("Before visible context") *and* suffix
  ("after visible context.") are visible; after the cutover only `exact` ("Visible quote") is
  visible and the prefix/suffix strings are absent. The `highlight()` fixture may keep
  `prefix`/`suffix` (still valid `AnchoredHighlightRow` fields) but they must not be asserted
  visible. Add an empty-`exact` row asserting the placeholder.
- `apps/web/src/components/reader/ReaderOverviewRuler.test.tsx` — add (or extend) an
  empty-`exact` cluster-member case asserting the placeholder; existing context-popover
  assertions stay green.

**New** — none. **Deleted** — none. (Consolidation is via reuse of existing `compact`.)

Confirmed blast radius (`rg`): `kind:"highlight"` `ItemCard` content is produced only in
`ReaderHighlightsSurface.tsx` (+ `ItemCard.test.tsx`); `ConversationReferencesSurface` uses
`kind:"resource"`; `HighlightSnippet` is consumed only by `ItemCard` and `ReaderOverviewRuler`.

---

## 11. Key details

- **Why the bug bites:** prefix renders first (`HighlightSnippet.tsx:28`) and the collapsed
  clamp is 2 lines, so a ≤64-codepoint prefix can consume the entire visible budget and hide
  the `<mark>`. Exact-only removes the failure mode at the root, not by tuning the clamp.
- **Full ink, not muted:** `compact` already swaps the root from `--ink-muted` to `--ink`
  (`HighlightSnippet.module.css:1–11`), so the selection reads at full strength once it is the
  only content — a side benefit of reusing the existing mode.
- **Empty-`exact` reachability:** fragment highlights derive `exact` from
  `canonical_text[start:end]` (non-empty for a real selection); only PDF highlights without a
  text-layer match yield empty `exact`. `hasQuoteText` (`ReaderHighlightsSurface.tsx:564`)
  already gates quote-to-chat off for these; the placeholder covers their display.
- **Tokens / no magic px:** `.empty` uses `--ink-faint`; the clamp count is a unitless integer
  (consistent with `ReaderOverviewRuler`/`HoverPreview`/`AppList`). No raw px added.
- **Measurement parity:** the card root still carries `rootRef`; collapsed cards are simply
  shorter. `alignRows`/projection diff is empty.

---

## 12. Key decisions (resolved)

1. **Truncation policy → option B** (generous collapsed clamp, full on focus), not "never
   truncate." Highlights' `exact` is uncapped (a fragment selection can span paragraphs;
   `ReaderSelectionRequest.exact` allows up to 20,000 chars), and the secondary is a
   viewport-scoped *scan/navigate* surface — an unbounded card would bury its neighbours and
   their notes/actions. Six collapsed lines + full-on-focus honours "untruncated" for the
   realistic case while bounding the pathological one.
2. **Empty-`exact` placeholder copy → "No selectable text"**, muted italic, owned by
   `HighlightSnippet`. Neutral and accurate for a PDF region with no text layer; keeps the row
   clickable so the user can still focus it (and reveal it if off-screen) in the reader. See
   [`reader-highlight-sidecar-focus-navigation.md`](./reader-highlight-sidecar-focus-navigation.md):
   sidecar click focuses; it does not jump for an already-visible mark.
3. **`prefix`/`suffix` stay in the data model and the ruler, leave the sidecar.** Context is
   correct on the ruler's hover popover (you may be looking elsewhere in the document) and
   redundant in the visible-only secondary (the prose is on screen). This is the ruler-vs-secondary
   split from `docs/modules/reader-implementation.md:43–48`, applied to the snippet text.

---

## 13. Acceptance criteria

1. A highlight card in the sidecar shows **only** `exact` — its `prefix`/`suffix` strings are
   not present in the card's DOM — at full `--ink` (the `compact` treatment).
2. Collapsed (unfocused) cards clamp the selection to **6 lines**; focused
   (`expanded`) cards show the **full** selection with no clamp. A paragraph-length highlight
   does not exceed ~6 lines while unfocused and is shown in full when focused.
3. A highlight with empty `exact` renders the **"No selectable text"** placeholder (muted,
   not a `<mark>`), and the card remains clickable (focuses it; reveals only if off-screen, per
   [`reader-highlight-sidecar-focus-navigation.md`](./reader-highlight-sidecar-focus-navigation.md)).
   No blank card.
4. The empty-`exact` placeholder also appears for empty-`exact` members of the ruler's compact
   cluster preview; the ruler's single-highlight popover still shows prefix/exact/suffix.
5. `ItemCard`'s highlight content type is `{ exact, color }`; `rg 'snippet:\s*{[^}]*prefix'`
   over the app source is empty; `prefix`/`suffix` are not passed to any `ItemCard`.
6. The alignment engine is unchanged: highlights still float to their in-document position,
   collide/stack, show `+N more`, and mobile above/below nav works. Diff of
   `useAnchoredHighlightProjection`/`alignRows`/measurement code is empty.
7. `bun run typecheck`, `bun run lint`, and the updated component tests pass.

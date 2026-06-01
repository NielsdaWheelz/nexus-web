# Reader highlights sidecar — focus-driven linked chats · hard cutover spec

Status: implemented · Owner: reader/highlights · Type: hard cutover (no legacy, no fallbacks, no back-compat)

The reader highlights secondary (`ReaderHighlightsSurface`, the "sidecar") renders each
highlight card with three stacked slots — snippet, note, linked chats. Two of them already
obey one rule: **focused → full, blurred → minimal**, driven by the host's `focusedId`
(`expanded` on `ItemCard`). Linked chats are the outlier: they hang off an independent
`Disclosure` toggle that (a) is **broken** — its `.region { display: grid }` overrides the
native `[hidden]` attribute so it never actually collapses — and (b) is **invisible to
tests**, because jsdom honors `hidden` but never applies the CSS, so the unit test is green
while the control is visibly broken in every browser.

This cutover brings linked chats onto the same single source of truth (`expanded`), deletes
the `Disclosure` outlier, and — because a chat spawned from a highlight is the *payoff* in an
AI-first reader, the trace of thinking a highlight sparked — never hides chat titles behind a
click. Titles are shown as scent when blurred and as a clickable list when focused. It
supersedes the linked-chats disclosure introduced in `b7dd83da`.

---

## 1. Context & problem

Each visible highlight is rendered by `ReaderHighlightsSurface.renderRow`
(`ReaderHighlightsSurface.tsx:556`), which builds an `ItemCard` and passes
`expanded={isFocused}` (`:671`), `linked_conversations` mapped to `linkedItems` (`:650–659`),
and a `linkedItemsSummary` count label (`:660–664`). Inside `ItemCard`, the snippet body and
the note both clamp via CSS keyed on `:not(.expanded)` (`ItemCard.module.css:54`, `:70`), but
linked chats are wrapped in `Disclosure` (`ItemCard.tsx:112–124`) with its own React `open`
boolean.

Two defects fall out of that outlier:

- **It never collapses.** `Disclosure` hides its region with the native `hidden` attribute
  (`Disclosure.tsx:52`), but `Disclosure.module.css:45–48` unconditionally sets
  `.region { display: grid }`. An author `display` beats the UA `[hidden] { display: none }`
  rule in the cascade, so `hidden` is ignored — the region is always shown. This is why the
  chats are "always visible" and the toggle appears dead (the chevron rotates via `data-open`,
  but nothing hides).
- **The bug is untestable in the current harness.** `Disclosure.test.tsx` asserts the region
  is absent when closed and passes, because jsdom respects the `hidden` attribute for the
  accessibility tree but never evaluates the stylesheet. The green test masks a feature broken
  in every real browser.

Both are symptoms of a missing contract: the card slot's verbosity was never specified as a
single function of one state, so the slot grew its own mechanism.

`Disclosure` is imported by exactly one file — `ItemCard.tsx` (the chat-pane
`AssistantEvidenceDisclosure` is an unrelated, same-named component, not a consumer). So once
`ItemCard` stops using it, `Disclosure` is dead code.

---

## 2. Target behaviour

```
BLURRED (not focused) — minimal                 FOCUSED — full payoff
┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ poolpah hit the fan. I had the…  [⋯]  │        │ poolpah hit the fan. I had the         │
│ A note, clamped to one line…           │        │ unmitigated… (full, untruncated)  [⋯]  │
│ 💬 Poolpah theory · Vonnegut on war    │  ───▶  │ A note, shown in full.                 │
└──────────────────────────────────────┘        │ ┌────────────────────────────────────┐ │
  snippet ≤6 lines · note clamped ·               │ │ 💬 Poolpah theory                  │ │ ← each row a
  chats = one scented line (titles, ellipsis)      │ │ 💬 Vonnegut on war                 │ │   button → opens
                                                   │ └────────────────────────────────────┘ │   conversation
                                                   └──────────────────────────────────────┘
```

- **Blurred** (`!expanded`): snippet clamped to ≤6 lines (today), note clamped (today),
  linked chats = **one muted line** — `MessageSquare` icon + `items.map(label).join(" · ")`,
  single-line ellipsis. Non-interactive; clicking the row focuses it (existing behaviour).
- **Focused** (`expanded`): snippet full, note full, linked chats = **vertical list of
  clickable rows** (icon + title each); clicking a row opens that conversation in a new pane.
- **Zero chats:** the slot renders nothing in either state.
- The blurred ↔ focused transition is driven solely by `focusedId` changing; the existing
  `useLayoutEffect` whose deps include `focusedId` (`ReaderHighlightsSurface.tsx:254–261`)
  remeasures and realigns row heights for free. No engine change.

---

## 3. Architecture & key decision

**The decisive move: linked-chat visibility becomes a _render_ decision, not a _CSS_
decision.**

- Old: content is always in the DOM; `hidden`/CSS toggles its display → desyncable, and the
  desync is invisible to jsdom.
- New: `ItemCard` render-gates on `expanded`. The focused list is literally absent from the
  DOM when blurred; the scent line is literally absent when focused.

Consequences, all upside:

- **The "CSS overrides `hidden`" bug class becomes impossible** — there is no `hidden`
  attribute left to override.
- **Visual state ≡ accessibility-tree state, by construction** — both derive from the same
  `expanded` input. (The old code diverged in opposite directions: sighted users always saw
  the chats; screen-reader users could not reach them when "collapsed.")
- **jsdom now fully covers it** — `getByRole("button", { name: title })` is present iff
  `expanded`. No Playwright/visual-regression layer is needed to catch the regression that
  started this. This is the durable, systemic fix — and it is *subtractive*.

`ItemCard` stays a **pure, stateless view**: no `useState`, no internal toggle. `expanded` is
owned upstream by `useHighlightInteraction.focusedId` (click-driven, single-focus), passed as
`expanded={focusedId === highlight.id}`. One card is ever expanded at a time.

---

## 4. Capability contract / API design

### `ItemCard` (changed)

```ts
type ItemCardContent =
  | { kind: "highlight"; snippet: { exact: string; color: HighlightColor } }
  | { kind: "resource"; title: ReactNode; icon?: ReactNode };

interface ItemCardLinkedItem {
  id: string;
  icon?: ReactNode;
  label: string;
  onActivate: () => void;
}

interface ItemCardProps {
  content: ItemCardContent;
  expanded?: boolean;          // SINGLE source of truth for verbosity (focus).
                               // Drives snippet clamp, note clamp, AND linked-chats render.
  selected?: boolean;
  linkedItems?: ItemCardLinkedItem[];
  // REMOVED: linkedItemsSummary  ← count label deleted; titles are the scent, count moves to aria.
  note?: ReactNode;
  actions?: ActionMenuOption[];
  meta?: ReactNode;
  onActivate?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  rootRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  className?: string;
  highlightId?: string;
  testId?: string;
}
```

**`linkedItems` rendering rule (the contract):**

| `linkedItems` | `expanded` | Output |
|---|---|---|
| empty / undefined | any | nothing |
| present | `false` | `<div className={styles.linkedScent}>` — `items[0].icon` + `items.map(i => i.label).join(" · ")`, one line, ellipsis. Non-interactive. No `aria-label`: the visible titles **are** the accessible content (an `aria-label` would replace them, making it count-only for screen readers — a regression vs invariant 4). |
| present | `true` | `<ul className={styles.linkedList} aria-label={pluralize(n, "linked chat")}>` of `<li><button onClick={i.onActivate}>{i.icon}<span>{i.label}</span></button></li>`. |

No internal state, no `Disclosure`. The list buttons keep stop-propagation semantics so a chat
click does not also fire the row's `onActivate`.

### `pluralize` (new, centralized)

```ts
// apps/web/src/lib/text/pluralize.ts
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
```

`pluralize(1, "linked chat") → "1 linked chat"`, `pluralize(2, "chat") → "2 chats"`. Fixes the
**"1 linked chats" grammar bug** and consolidates the scattered inline pluralizers (§5).

---

## 5. Consolidation (reuse / centralize)

Replace duplicated inline pluralizers with `pluralize`:

- `components/chat/ForkNodeRow.tsx` — delete the private `messageCountLabel()` (`~:257`); call
  `pluralize(count, "message")`.
- `components/chat/ReferencingChatRow.tsx` — `pluralize(message_count, "message")` (`~:39`).
- `components/chat/ConversationForksPanel.tsx` — `pluralize(visibleCount, "fork")` for the
  "N forks found" label (`~:117`).

The validation pass then swept `pluralize` across the rest of the app — every remaining
inline `n === 1 ? … : …s` count label now routes through the single owner:
`workspace/PaneShell.tsx` ("open tab"), `oracle/atlas/AtlasPaneBody.tsx` ("star"),
`podcasts/PodcastsPaneBody.tsx` ("followed show"),
`podcasts/[podcastId]/PodcastSummaryCard.tsx` + `podcasts/podcastSubscriptions.ts`
("library"/"libraries", "shared library"/"shared libraries"),
`podcasts/[podcastId]/PodcastDetailPaneBody.tsx` ("visible episode"),
`LocalVaultAutoSync.tsx` + `settings/local-vault/SettingsLocalVaultPaneBody.tsx`
("conflict file", "local edit"). `pluralize`'s `singular` arg takes the whole noun phrase,
so adjectives stay attached. No inline **count-label** pluralizer (`${n} <noun>`) remains in
the web app; the only surviving `n === 1 ? … : …s` ternaries are inside the relative-time
formatters, which are a different concern, deliberately left (see below).

Out of consolidation scope (deliberately):

- **Relative-time formatting.** Three private "time ago" formatters exist —
  `chat/MessageRow.tsx::formatTime` (terse: `5m ago` / `3h ago`, hour floor),
  `chat/ReferencingChatRow.tsx::formatRelativeTime` (verbose: `5 minutes ago` … `X days ago`,
  day floor, pluralized), and `podcasts/PodcastsPaneBody.tsx::formatLatestEpisodeLabel`
  (`Latest today` / `Latest yesterday` / `Latest Xd ago`, day-granularity, prefixed). They are
  **not copy-paste drift of one function** — they are three distinct presentation specs that
  share only the trivial `Date.now() - ts` arithmetic, differing on granularity floor, unit
  verbosity, calendar special-cases, prefix, and absolute fallback. Merging them would mean an
  options-bag util with ~5 axes each used exactly once: the wrong abstraction, and a violation
  of the "a helper is justified only by real reuse" rule that justifies `pluralize` itself.
  This is *not* the same as the count-label pluralization `pluralize` owns — so the inline
  `n === 1 ? "minute" : "minutes"` ternaries in these formatters are intentionally left as-is;
  routing them through `pluralize` would conflate two concerns for no gain. The genuinely
  correct long-term owner is the browser-native `Intl.RelativeTimeFormat`, but adopting it
  **changes user-visible strings** (a behaviour change, not a refactor) and touches files
  outside this cutover — a separate, deliberate task, not smuggled in here.
- The repo-wide `-webkit-line-clamp` duplication (40+ files) — see §10.

---

## 6. Files

**Modify**

- `apps/web/src/components/items/ItemCard.tsx` — remove the `Disclosure` import; implement the
  focus-driven `linkedItems` render; drop `linkedItemsSummary`.
- `apps/web/src/components/items/ItemCard.module.css` — replace the `.linked` (Disclosure)
  rules with `.linkedList` (focused) + `.linkedScent` (blurred); both echo the existing
  `.expanded` idiom; reuse the single-line-ellipsis pattern already in `.linked button span`.
- `apps/web/src/components/items/ItemCard.test.tsx` — rewrite the two disclosure tests to the
  focus-driven contract.
- `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` — drop the `linkedItemsSummary`
  prop; keep the `linked_conversations → linkedItems` map (already canonical).
- `apps/web/src/components/reader/ReaderHighlightsSurface.test.tsx` — rewrite "opens a linked
  conversation from the card disclosure" to focus-first (no disclosure button).
- `apps/web/src/components/chat/ForkNodeRow.tsx`,
  `apps/web/src/components/chat/ReferencingChatRow.tsx`,
  `apps/web/src/components/chat/ConversationForksPanel.tsx` — adopt `pluralize`.

**Delete (dead after this change)**

- `apps/web/src/components/ui/Disclosure.tsx`
- `apps/web/src/components/ui/Disclosure.module.css`
- `apps/web/src/components/ui/Disclosure.test.tsx`

**Add**

- `apps/web/src/lib/text/pluralize.ts`
- `apps/web/src/lib/text/pluralize.test.ts`

---

## 7. Rules / invariants

1. `ItemCard` holds **no collapse state**. `expanded` is the only verbosity input; it derives
   from `focusedId`.
2. Linked-chat **visibility is render-gated**, never CSS/`hidden`-gated. No element may rely on
   a `hidden` attribute fighting a `display` rule.
3. Visible state ≡ accessibility-tree state for linked chats, by construction.
4. Chat **titles are always visible** in some form (scent line when blurred, list when focused)
   — never zero-scent, count-only.
5. One pluralization helper; no inline `n === 1 ? … : …s` count labels remain in the touched
   files.

---

## 8. Acceptance criteria

- **AC1 (blurred scent):** A blurred highlight with 2 chats renders a single line containing
  both titles (joined ` · `); no individual chat `<button>` exists in the DOM; row height stays
  within the collapsed budget.
- **AC2 (focused list):** Focusing the row renders one `<button>` per chat with accessible name
  = title; clicking calls `onOpenConversation(id, title)` exactly once and does **not** fire the
  row's `onActivate`.
- **AC3 (no toggle):** No "N linked chats" disclosure button and no `aria-expanded` anywhere in
  the highlight card.
- **AC4 (grammar):** A single chat reads "1 linked chat" (aria), never "1 linked chats".
- **AC5 (empty):** A highlight with no linked chats renders no linked-chat element in either
  state.
- **AC6 (a11y parity):** Blurred → no chat is an actionable control in the accessibility tree;
  focused → each is — matching what is painted.
- **AC7 (dead code gone):** `ui/Disclosure.{tsx,module.css,test.tsx}` deleted; no remaining
  import of `@/components/ui/Disclosure`; typecheck + full test suite green.
- **AC8 (consolidation):** `ForkNodeRow`, `ReferencingChatRow`, `ConversationForksPanel` use
  `pluralize`; `pluralize.test.ts` covers 0/1/2 and a custom plural.

---

## 9. How it composes with existing systems

- **Focus model** (`useHighlightInteraction`): click row / click highlight in reader →
  `focusedId` → `expanded={focusedId === id}`. Single-focus; exactly one card expanded. No new
  state.
- **Layout engine:** `useLayoutEffect` already depends on `focusedId`
  (`ReaderHighlightsSurface.tsx:254–261`); switching scent-line ↔ list changes height and is
  remeasured/realigned for free. `scheduleNoteLayoutMeasure` untouched.
- **Open action:** unchanged — `onActivate → onOpenConversation → openInNewPane(/conversations/:id, title)`.
- **Other slots:** `HighlightSnippet` (incl. empty-text), `HighlightNoteEditor` (multi-note),
  `ActionMenu`, `HighlightColorPicker` — untouched; separate slots.
- **Testing layer:** render-gating makes the whole behaviour observable in the existing
  jsdom/RTL setup — the systemic close of the gap that let this ship broken.

---

## 10. Non-goals

- No viewport/scroll-driven focus (focus stays explicit/click-driven).
- No cap / "+K more" on the focused chat list (chats-per-highlight is small; YAGNI for a
  single-user prototype).
- No Chip/Pill-ifying linked chats (rows read better in a narrow sidecar).
- No repo-wide line-clamp utility sweep (40+ files) — flagged as a separate, optional cleanup.
- No Playwright / visual-regression addition (render-gating removes the need that motivated it).
- No changes to notes, actions, color, quote-to-chat, the overview ruler, or the chat pane.
- No keeping `Disclosure` "just in case" — re-add it correctly if a real future need appears.

---

## 11. Risks & mitigations

- **Scent line too long in a narrow sidecar** → single-line ellipsis
  (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`), reusing the existing
  `.linked button span` rule.
- **Deleting a clean a11y primitive (`Disclosure`)** → accepted under the no-legacy rule; the
  render-gate pattern adopted here is the better template anyway. This is the one reversible
  judgment call — flagged for sign-off.
- **Focused chat-list height churn** → already handled by the `focusedId`-keyed remeasure.

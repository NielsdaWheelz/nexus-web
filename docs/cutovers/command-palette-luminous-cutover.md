# Command Palette — Luminous Cutover

> **Status:** Spec — ratified direction, not yet built
> **Date:** 2026-06-02
> **Type:** Hard cutover (delete-and-replace; no fallback, no legacy, no back-compat)
> **Reference pattern:** `docs/cutovers/app-navigation-unification.md` (the AppNav cutover — single-source model, one CSS module per family, hard cutover discipline) and `docs/cutovers/dialog-overlay-hook-unification.md` (the overlay-hook family this builds on).

---

## 1. Summary

The command palette is the app's "do-anything / go-anywhere" surface. Today it is a **568-line god component** (`components/CommandPalette.tsx`) that hand-rolls five inline command sources, two keyboard listeners, a raw native `<dialog>`, and — on mobile — `history.pushState` back-button hacks plus a bespoke swipe gesture. It works, but it has **no architecture** (nothing derives from a single model) and **no soul** (a flat list in a box).

This cutover rebuilds it as **AppNav's twin**: one `paletteModel` (single source of truth) feeding a **provider registry** and a **pure ranking engine**, orchestrated by one **controller hook**, rendered by two thin presenters (a desktop **luminous-glass surface** and a mobile **search-first bottom sheet**) that share an input, a list, and a row. It adds the three ratified capabilities: an **omni-input with intent lanes + an always-present "Ask AI" fallback** (never auto-routed), **nested "act-on-a-result" action views** (a cmdk-style page stack), and **contextual re-ranking** ("the palette knows where you are"). It is built on the existing `useDialogOverlay` accessibility family, and it deletes the god component and both legacy command directories outright.

The backend (`/api/me/palette-history`, `/api/me/palette-selections`, frecency service) is **unchanged**; its wire contract is preserved exactly.

---

## 2. Current state & problem inventory

### 2.1 Surfaces today

| File | Lines | Role | Verdict |
|---|---|---|---|
| `components/CommandPalette.tsx` | 568 | God controller: 11 state atoms, 5 inline command sources, 2 keyboard listeners, execution + selection-logging, viewport picker | **Delete** |
| `components/palette/PaletteDesktopShell.tsx` | 95 | Desktop raw `<dialog>` + `activeCommandId` state | **Delete** |
| `components/palette/PaletteMobileShell.tsx` | 181 | Mobile raw `<dialog>`, `history.pushState`, swipe, `visualViewport` | **Delete** |
| `components/palette/PaletteBody.tsx` | 213 | Shared input + listbox + key nav + IME | **Delete** (split into PaletteInput + PaletteList) |
| `components/palette/PaletteRow.tsx` | 98 | Row render + trailing action | **Rewrite** (keycaps, drill affordance) |
| `components/palette/types.ts` | 36 | `PaletteCommand`/`PaletteTarget`/`PaletteView` | **Fold into** `paletteModel.ts` |
| `components/command-palette/staticCommands.ts` | 239 | Static catalog + `matchesCommand` | **Fold into** `paletteModel.ts` + `paletteRanking.ts` |
| `components/command-palette/commandRanking.ts` | 91 | `buildPaletteView` scoring + grouping | **Rewrite** as `paletteRanking.ts` |
| `components/command-palette/commandProviders.ts` | 48 | Ask-AI + See-all pinned commands | **Fold into** `paletteProviders.ts` |
| `components/commandPaletteEvents.ts` | 7 | `dispatchOpenCommandPalette()` | **Keep** (already the single dispatcher) |
| `components/palette/PaletteBody.module.css` / `PaletteDesktopShell.module.css` / `PaletteMobileShell.module.css` | 143 / 39 / 47 | Three CSS modules | **Delete** → one `palette.module.css` |

### 2.2 Defects (numbered)

1. **God component.** `CommandPalette.tsx` owns state, data fetching, five command-source builders (`:247–349`), execution dispatch (`:386–493`), and global hotkeys (`:508–536`). Nothing is independently testable or reusable.
2. **No single source of truth.** Sections are defined in `commandRanking.ts:3–10` (`RESTING_SECTIONS`) **and** redundantly in `PaletteRow.tsx:18–25` (`SECTION_TAGS`). Adding a section means editing ≥3 files. (Contrast AppNav's one `NAV_MODEL`.)
3. **Five inline source loops.** Panes, recents, oracle, static, search are five hand-written `for` loops with divergent rank shapes (`scopeBoost` vs `frecencyBoost` vs `searchScore`). No provider interface; no isolation; no test seam.
4. **Two query-match implementations.** `matchesCommand` (`staticCommands.ts:233`) filters, then `buildPaletteView` (`commandRanking.ts:24`) re-scores. The same query is matched twice with subtly different rules.
5. **Raw `<dialog>` + manual a11y.** Both shells call `dialogRef.current?.showModal()` and re-implement focus (rAF hack `PaletteBody.tsx:43–48`), Escape (`onCancel`), and backdrop dismissal by hand — while the codebase already has `useDialogOverlay` (used by `NavSheet`, `MobileSecondaryPaneHost`, `GlobalPlayerFooter`, `PodcastSubscriptionSettingsModal`).
6. **Mobile history hack.** `PaletteMobileShell.tsx:68–98` pushes a synthetic history entry to make the Android back button close the palette, with `ignoreNextPopState` dedup flags — fragile and untested on-device.
7. **Bespoke swipe + frozen viewport.** `:110–133` hand-rolls a pointer gesture (`SWIPE_DISMISS_THRESHOLD_PX = 96`, header-only start); `visualViewport` is read but the sheet only resizes reactively, so the keyboard can briefly occlude results.
8. **No nesting.** Selecting a search hit dead-ends in navigation; there is no "what can I do with this?" — the single biggest gap vs. Raycast/Linear/Vercel.
9. **AI is a footnote.** "Ask AI" appears only when `query ≥ 2` and no title matches (`commandProviders.ts:14–18`); there is no persistent, predictable AI affordance and no way to force the AI lane.
10. **Flat aesthetic.** A `surface-1` box with `--shadow-4`; no depth, no motion beyond a 16px mobile slide; the desktop has no open animation at all.
11. **No shortcut-teaching footer; only *latent* contextual awareness.** Re-ranking already boosts the active pane (`CommandPalette.tsx:266`, `scopeBoost: 300`) and the current route (`commandRanking.ts:55`, `+250`), but nothing is *surfaced* — no "Continue · <doc>" suggestion, no route-relatedness beyond an exact-href match, and shortcuts are shown per-row but never taught via a footer. (The mobile open-tab badge is *not* stale — it reads live from `primaryPanes.length`, `AppNav.tsx:128`.)

---

## 3. Goals

- **G1 — One model.** Every static command, section, lane membership, and icon derives from a single `paletteModel.ts`, the way nav derives from `NAV_MODEL`.
- **G2 — Provider registry.** Every dynamic source (panes, recents, oracle, search, ask) is a pure `PaletteProvider` over a fetched `PaletteContext`. Adding a source = adding one provider.
- **G3 — One controller.** A `usePaletteController` hook owns all state, fetching, execution, and hotkeys, and exposes a documented view-model. Presenters are thin and dumb.
- **G4 — Omni-input + Ask-AI lane.** One input; instant local default; lanes via sigils (`>` actions, `@` content, `?` ask); a **permanent** "Ask AI" row that escalates on Enter and **never auto-runs** (ratified D-1).
- **G5 — Nested actions.** Selecting a result can push a sub-view of contextual actions (open · ask-about · copy link · close tab …), each with its own shortcut; query preserved across drill/back (ratified D-3).
- **G6 — Surface contextual awareness (extend, don't invent).** Build on the *existing* active-pane (`scopeBoost: 300`, `CommandPalette.tsx:266`) and current-href (`+250`, `commandRanking.ts:55`) boosts, and actually surface them: a context suggestion at rest ("Continue · <doc>"), route-relatedness boosts beyond exact-href, and reader-aware ordering.
- **G7 — Luminous glass.** A premium, dark-first, glass-edged, spring-motion surface, pinned high on desktop (ratified D-2).
- **G8 — Search-first mobile sheet.** A thumb-reached bottom sheet, input pinned above the keyboard, pre-populated before typing (ratified D-4).
- **G9 — Correct, fast, accessible.** dialog+combobox+listbox semantics, focus stays on input via `aria-activedescendant`, focus trap + return, Escape, result-count/empty announcements, reduced-motion; instant local ranking, stale-query cancellation, capped lists.
- **G10 — Consolidation.** Reuse `useDialogOverlay`; centralize sections, matching, viewport-keyboard handling, and history-dismiss; collapse two dirs + three CSS modules into one each.

---

## 4. Non-goals

- **N1 — No inline AI answers / agentic streaming / generative UI inside the palette.** The "Ask AI" target still hands off to a new conversation (prefill). Inline streamed answers and agentic reading tasks are the **Agentic surface** option we explicitly did *not* pick; deferred (§19).
- **N2 — No backend changes.** History/selections/frecency endpoints, schemas, and DB rows are untouched; the selection-logging wire contract is preserved byte-for-byte (E-3).
- **N3 — No new fuzzy-search dependency** (no `cmdk`, `kbar`, `match-sorter`, `fuse`). Scoring stays hand-rolled (E-5).
- **N4 — No virtualization.** Lists are capped (~tens of rows), not hundreds; virtualization is unnecessary and deferred (§19).
- **N5 — No shared `<BottomSheet>`/`<OverlayScrim>` primitive in this cutover.** The repeated portal+scrim+sheet markup is real (C10) but extracting it touches files the palette doesn't own; deferred to its own cutover.
- **N6 — No change to the global viewport meta** (`app/layout.tsx`). Flipping `interactiveWidget` is app-wide and would affect `SelectionPopover`/`PdfReader`; we use `visualViewport` instead (E-4).
- **N7 — No reader-scoped RAG (`@thisdoc` grounded answers).** The `@` lane scopes *content results*; grounding an AI answer in the current document needs backend work — deferred (§19). The target type is shaped to allow it.
- **N8 — No SelectionPopover migration.** We extract `useKeyboardInset` and use it in the palette; migrating `SelectionPopover` onto it is a deferred follow-up (C6).
- **N9 — No second resource-action catalog.** The palette's nested actions are a small curated set (§5.4/§7.5); the canonical resource context menu (`PaneShell.paneMenuOptions` → `ActionMenu`, live `ActionMenuOption` closures, `PaneShell.tsx:263`) is **not** mirrored into the palette. Bridging it is deferred (F6).

---

## 5. Target behaviour (the experience contract)

### 5.1 Opening & closing

- **Triggers (unchanged surface, one dispatcher):** the global keybinding `open-palette` (toggle); `OPEN_COMMAND_PALETTE_EVENT` from the AppNav rail command bar, the mobile top-bar command button, and the NavSheet command bar; and the deep-link `?palette=1` / `?cmd=<id>` / `?q=<text>` read on mount (URL cleaned via `replaceState`, preserved from today).
- **Toggle:** pressing the open key while open closes it and returns focus to the opener.
- **Close:** Escape, backdrop click (desktop), drag-down / handle / Android back (mobile), or selecting an item.

### 5.2 The input & intent lanes (D-1)

One input. Parsing is pure (`parsePaletteInput`):

| Leading sigil | Lane | Scope of results |
|---|---|---|
| *(none)* | `all` | Everything: panes, recents, static, oracle, search, + Ask-AI fallback |
| `>` | `actions` | Action/create/settings commands only |
| `@` | `content` | Documents/recents/search/tabs only |
| `?` | `ask` | Ask-AI is primary; minimal local results |

- When a sigil is active, the input renders a **lane chip** ("Actions ›") before the caret; **Backspace at position 0** clears the lane back to `all`.
- The **"Ask AI" row is always present** while there is a term (and is the top row in `ask`). Enter on it opens a new conversation prefilled with the term (and, when reading, the current doc as a `scopeHref` hint). It **never auto-executes**; the user must land on it.
- Empty input (`all`, at rest) shows the **resting view**: a context suggestion (if any), Open tabs, Recent, Recent folios, Create, Go to, Settings — grouped, capped.

### 5.3 Results, ranking, contextual awareness (G6)

- **Instant & local:** panes, recents, static, oracle render with zero network. Search is async (debounced 200ms, aborted on keystroke) and merges in as it arrives behind an `aria-busy` state.
- **Deterministic ordering** for a given query (start-of-word > whole-word > keyword > substring > subsequence), then additive boosts (search score, frecency, recency, scope). Frequency never reshuffles the **resting** groups beyond the existing recency/frecency model (preserves muscle memory).
- **Contextual boosts:** the active pane is boosted; items whose route matches/relates to the current pane are boosted; at rest, a **"Continue · <title>"** suggestion for the active reader/doc appears first.
- **Capping:** each resting group capped (panes ≤ 6, recent ≤ 6, folios ≤ 5, search ≤ 6); querying view capped (~40) with the last visible row half-clipped to imply more.

### 5.4 Nested "act on a result" (D-3)

- Rows that support actions show a **drill affordance** (`→`). **RightArrow** or **Tab** (or clicking the affordance) **pushes an actions page** for the focused item; **Enter** runs the item's **default** action (open/switch); **Esc / LeftArrow / Backspace-when-term-empty** pops back to the root, **preserving the query**.
- Action sets (pure, by source/target):
  - **Content/href (doc, recent, search, oracle):** Open *(default)* · Ask AI about this · Copy link · *(Open externally, when `externalShell`)*.
  - **Open tab (pane):** Switch to tab *(default)* · Close tab · Ask AI about this.
  - **Static action/nav:** typically no sub-actions (Enter executes).
- The actions page reuses the same list/row UI and keyboard model; each action shows its own shortcut where one exists.

### 5.5 Footer hint bar (teaches shortcuts)

A persistent footer shows live affordances: `↩ open · → actions · esc close`, and the focused item's keyboard shortcut when it has one. This converts the palette into a tutor (the Superhuman effect).

### 5.6 Desktop presentation (luminous glass — D-2)

- A portal'd, scrim-backed surface pinned ~16–18% from top, `width: min(640px, 92vw)`, radius `--radius-2xl`, a **glass fill** (`--palette-glass-bg` + `backdrop-filter` blur) with a **single lit hairline edge** (`--palette-glass-ring`) and a soft lift (`--shadow-5`) plus an inset top highlight (`--palette-glass-glow`).
- **Morphing:** the surface height springs (`--ease-bloom`) between resting, querying, and actions states. Input at top; results below; footer pinned.
- Open: `opacity` + `translateY` + slight `scale` spring (≈120–180ms). Honors reduced motion (snaps).

### 5.7 Mobile presentation (search-first bottom sheet — D-4)

- A portal'd, scrim-backed **bottom sheet** with a drag **grabber**, `border-radius: 16px 16px 0 0`, anchored to the bottom, that **snaps to (near) full height when the input is focused**.
- **Input pinned at the bottom, above the keyboard** (thumb zone), positioned via `useKeyboardInset` (`visualViewport`); **results scroll above it**, nearest-the-thumb first; recents/actions shown before typing.
- Dismiss: drag-down past threshold (momentum-aware, 100ms scroll-guard), grabber/Close button, scrim tap, or **Android back** (history-dismiss). Reduced motion disables drag (keeps Close + back).
- `env(safe-area-inset-*)` honored top and bottom.

---

## 6. Architecture & module layout

### 6.1 Final directory (one family, flat — AppNav convention)

Consolidate `components/command-palette/` **and** `components/palette/` into one `components/palette/`:

```
components/palette/
  paletteModel.ts          # types + STATIC_COMMANDS + SECTIONS + lane membership   (single source — C1, C2)
  paletteIntent.ts         # parsePaletteInput(raw) -> PaletteIntent   (pure)
  paletteProviders.ts      # PaletteProvider interface + PALETTE_PROVIDERS registry  (C3)
  paletteRanking.ts        # rankPalette(ctx) -> PaletteView  (pure; folds matchesCommand — C4)
  paletteActions.ts        # buildItemActions(item, ctx) -> PaletteAction[]  (pure; nesting — G5)
  usePaletteController.ts   # state + fetching + execution + hotkeys -> PaletteController  (G3, C8)
  CommandPalette.tsx       # thin mount: controller + viewport picker
  PaletteSurface.tsx       # desktop luminous-glass presenter  (useDialogOverlay — C5)
  PaletteSheet.tsx         # mobile bottom-sheet presenter  (useDialogOverlay + useKeyboardInset + useHistoryDismiss — C5/C6/C7)
  PaletteInput.tsx         # morphing input + lane chip + key handling  (C8, C9)
  PaletteList.tsx          # listbox: groups | results | actions | states  (C9)
  PaletteRow.tsx           # one row: icon, title/subtitle, keycap, drill/trailing
  PaletteFooter.tsx        # hint/affordance bar  (§5.5)
  palette.module.css       # one CSS module for the family  (E-7)

lib/ui/
  useKeyboardInset.ts      # visualViewport bottom-inset hook (palette now; SelectionPopover later — C6)
  useHistoryDismiss.ts     # synthetic-history "back closes overlay" hook (C7)
```

### 6.2 Data flow (one direction)

```
fetched data (panes, history, oracle, search, keybindings)            intent (parsed input)
                       \                                              /
                        \                                            /
                         ▼                                          ▼
                    PaletteContext  ──►  PALETTE_PROVIDERS.build(ctx)  ──►  PaletteItem[]
                                                                              │
                                                          rankPalette(ctx) ───┤  (score, lane-filter, group/flatten, cap)
                                                                              ▼
                                                                          PaletteView
                                              page === "actions"?  buildItemActions(item, ctx) ──► PaletteAction[]
                                                                              ▼
                              usePaletteController  ──►  PaletteController (view-model)
                                                                              ▼
                                       CommandPalette ──► PaletteSurface | PaletteSheet
                                                                              ▼
                                              PaletteInput + PaletteList(+PaletteRow) + PaletteFooter
```

Fetching stays in the controller (uses existing `useApiResource` + the search effect); providers are **pure** transforms of already-fetched context, so they are unit-testable without network.

---

## 7. Capability contract & API design

> All names below are the **final** names. `PaletteCommand` → `PaletteItem`; the `prefill` **target kind** → `ask` (a frontend rename only — it maps back to the wire value `prefill`, E-3/§7.7). **`PaletteSource` and `PaletteTarget.kind` "href"/"action" are NOT renamed** — `source` is posted verbatim and is constrained by the backend (`command_palette.py:8`, `models.py:5901`). `lane` (UI routing) and `source` (provenance) are **different axes**: the Ask-AI item has lane `"ask"` and source `"ai"`.

### 7.1 Core types (`paletteModel.ts`)

```ts
export type PaletteLane = "all" | "actions" | "content" | "ask";
// source == backend wire enum (command_palette.py:8 / models.py:5901) — DO NOT rename:
export type PaletteSource = "static" | "workspace" | "recent" | "oracle" | "search" | "ai";
export type PaletteSectionId =
  | "context" | "open-tabs" | "recent" | "recent-folios"
  | "create" | "navigate" | "settings" | "search-results" | "ask";

export type PaletteIcon = ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;

export type PaletteTarget =
  | { kind: "href"; href: string; externalShell: boolean }
  | { kind: "action"; actionId: string }
  | { kind: "ask"; text: string; scopeHref?: string };   // was "prefill"; scopeHref reserved for reader-scoped (N7)

export interface PaletteRankSignals {
  searchScore?: number; frecencyBoost?: number; recencyBoost?: number; scopeBoost?: number;
}

export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  sectionId: PaletteSectionId;
  lanes: PaletteLane[];              // which sigil lanes include this item ("all" always implied)
  icon: PaletteIcon;
  target: PaletteTarget;
  source: PaletteSource;
  rank: PaletteRankSignals;
  shortcutLabel?: string;
  hasActions?: boolean;             // row is drillable (→)
  trailingAction?: { actionId: string; ariaLabel: string };
}

export interface PaletteSection { id: PaletteSectionId; label: string; cap: number; }
export const SECTIONS: PaletteSection[];     // ordered; single source for order, label, and cap (C2)
export const STATIC_COMMANDS: PaletteItem[]; // the catalog (was staticCommands.ts)

// Nested-action types live in the model (paletteActions.ts builds them) to avoid a
// circular import (paletteActions imports PaletteItem from here):
export type PaletteActionRun =
  | { kind: "open"; href: string; externalShell: boolean }
  | { kind: "ask"; text: string; scopeHref?: string }
  | { kind: "copy-link"; href: string }     // reuses the existing copyText util (see PaneShell copyPaneLink)
  | { kind: "pane-activate"; paneId: string }
  | { kind: "pane-close"; paneId: string };
export interface PaletteAction {
  id: string; label: string; icon: PaletteIcon; shortcutLabel?: string; run: PaletteActionRun;
}

export interface PaletteGroup { sectionId: PaletteSectionId; label: string; items: PaletteItem[]; }
// Three view states. The "actions" state is the nested page (§5.4); PaletteList switches on all three.
export type PaletteView =
  | { state: "resting"; groups: PaletteGroup[] }
  | { state: "querying"; results: PaletteItem[] }
  | { state: "actions"; item: PaletteItem; actions: PaletteAction[] };
```

### 7.2 Intent (`paletteIntent.ts`)

```ts
export interface PaletteIntent { lane: PaletteLane; term: string; raw: string; }
export function parsePaletteInput(raw: string): PaletteIntent;
// ">x" -> {lane:"actions", term:"x"}; "@x" -> content; "?x" -> ask; "x" -> all. Sigil stripped, term trimmed.
```

### 7.3 Provider registry (`paletteProviders.ts`)

```ts
export interface PaletteContext {
  intent: PaletteIntent;
  panes: WorkspacePrimaryPane[];
  activePaneId: string | null;
  currentHref: string | null;                 // active pane href (contextual re-ranking)
  runtimeTitleByPaneId: Record<string, string>;
  historyRows: RecentRow[];
  frecencyBoosts: Map<string, number>;
  oracleRows: OracleReadingSummary[];
  searchResults: SearchResultRowViewModel[];
  keybindings: Record<string, string>;
  androidShell: boolean;
  canOpenConversation: boolean;
}

export interface PaletteProvider {
  id: string;
  build(ctx: PaletteContext): PaletteItem[];   // pure; android-restricted routes filtered HERE
}

export const PALETTE_PROVIDERS: PaletteProvider[]; // [context, panes, recents, oracle, static, search, ask]
```

Providers fully own their concerns, including the Android route filter (`isAndroidShellRestrictedRouteId`) that is currently sprinkled across `CommandPalette.tsx:253/274/305/322`. Provider *ids* are presentational (`panes`, `ask`); the **`source`** they stamp is the wire enum (the panes provider emits `source: "workspace"`; the ask provider emits `source: "ai"`). The **ask** provider replaces `getAskAiPinnedCommand` + `getSeeAllInSearchCommand` and emits the always-present Ask-AI item (lane `"ask"`, source `"ai"`) plus a "See all in search" item (lane `content`/`all`, source `"search"`).

### 7.4 Ranking (`paletteRanking.ts`)

```ts
export function rankPalette(ctx: PaletteContext, items: PaletteItem[]): PaletteView;
// 1. lane-filter (item.lanes ∋ intent.lane, or lane==="all")
// 2. score (deterministic tiers; folds the old matchesCommand as "score>0")
// 3. additive boosts (search/frecency/recency/scope + active-pane/current-href)
// 4. empty term -> grouped by SECTIONS (capped); non-empty -> flat results (capped), pinned-last preserved
```

### 7.5 Nested actions (`paletteActions.ts`)

`PaletteAction` / `PaletteActionRun` types live in `paletteModel.ts` (§7.1). This module is the pure builder only:

```ts
export function buildItemActions(item: PaletteItem, ctx: PaletteContext): PaletteAction[];
```

**No second resource-action catalog (N9).** The palette's nested actions are a deliberately **small, navigation-oriented set** — content/href: Open · Ask AI about this · Copy link · *(Open externally)*; pane: Switch · Close · Ask AI about this. The **canonical resource context menu** — `PaneShell.paneMenuOptions` → `ActionMenu` (`PaneShell.tsx:263`), which are live `ActionMenuOption` *closures* (`onSelect`, `render`, `href`), not declarative IDs — is **not** mirrored into the palette. `copy-link` reuses the existing `copyText` util that `copyPaneLink` already uses, so there is no second copy implementation. Bridging the full pane Options menu into the palette is a deferred option (§19 F6), explicitly out of scope.

### 7.6 Controller (`usePaletteController.ts`)

```ts
export type PalettePage =
  | { kind: "root" }
  | { kind: "actions"; item: PaletteItem; actions: PaletteAction[] };

export interface PaletteController {
  open: boolean;
  query: string;
  intent: PaletteIntent;
  page: PalettePage;
  view: PaletteView;            // derived from page: root → resting|querying; actions page → { state:"actions", item, actions }
  searchLoading: boolean;
  activeId: string | null;
  // input
  setQuery(next: string): void;
  setActiveId(id: string): void;
  clearLane(): void;           // Backspace-at-0 → drop sigil
  // navigation
  select(item: PaletteItem): void;   // default action OR open; logs selection
  drill(item: PaletteItem): void;    // push actions page (no-op if !hasActions)
  back(): void;                      // pop actions page; preserves query
  runAction(action: PaletteAction): void;
  trailing(item: PaletteItem): void; // e.g. close tab
  close(): void;
}
export function usePaletteController(): PaletteController;
```

**Responsibilities centralized here:** open/close + toggle, deep-link read, debounced history fetch (`useApiResource`), oracle TTL fetch, debounced+aborted search, building `PaletteContext`, running providers + ranking (memoized), execution + **selection logging** (with the preserved wire contract), and the **global** keybinding dispatch (open-palette + static-command hotkeys). In-modal key handling (arrows/Enter/Esc/drill/IME) lives in `PaletteInput`. This is the clean split that replaces the two tangled listeners (C8).

### 7.7 Selection-logging wire contract (preserved — E-3)

`POST /api/me/palette-selections` body stays exactly `{ query, target_key, target_kind, target_href, title_snapshot, source }`. The backend constrains both `target_kind` (`href|action|prefill`) and `source` (`static|workspace|recent|oracle|search|ai`) — `command_palette.py:8-9`, `models.py:5897-5902`. The controller maps frontend → wire at **one** point:

| Frontend | Wire `target_kind` | Wire `target_key` | Wire `target_href` |
|---|---|---|---|
| `target.kind: "href"` | `"href"` | canonical href | the href |
| `target.kind: "action"` | `"action"` | `item.id` | `null` |
| `target.kind: "ask"` | **`"prefill"`** | `"prefill:conversation:<text>"` | `null` |

**`source` is posted verbatim** — `PaletteSource` *is* the wire enum, so no source mapping exists (a pane item posts `"workspace"`, the Ask-AI item posts `"ai"`). The frontend `ask` *target-kind* name never leaks to the wire. No migration; analytics/frecency continuity intact. A `CommandPalette.test.tsx` assertion pins the exact body for an href, an action, and an ask selection (§16).

---

## 8. Visual & interaction design

### 8.1 Theme-aware glass tokens (added to `globals.css`, all three theme blocks — AppNav style, E-6)

| Token | Dark (`:root`) | Light (`[data-theme="light"]` + prefers-light) |
|---|---|---|
| `--palette-glass-bg` | `color-mix(in srgb, var(--surface-1) 82%, transparent)` | `color-mix(in srgb, var(--surface-1) 90%, transparent)` |
| `--palette-glass-ring` | `rgba(255, 255, 255, 0.08)` | `rgba(20, 20, 30, 0.10)` |
| `--palette-glass-glow` | `rgba(255, 255, 255, 0.06)` | `rgba(255, 255, 255, 0.5)` (inset top highlight) |

`--palette-glass-blur: 20px` goes in the theme-invariant scale block. The surface uses `background: var(--palette-glass-bg); backdrop-filter: blur(var(--palette-glass-blur)) saturate(1.2); box-shadow: 0 0 0 1px var(--palette-glass-ring), var(--shadow-5); border: 0;` with an `inset 0 1px 0 var(--palette-glass-glow)` top highlight. Existing tokens carry everything else (radii, spacing, ink, accent, motion).

### 8.2 Rows, keycaps, active state

- Row: `grid-template-columns: auto minmax(0,1fr) auto`, `min-height: var(--size-xl)` (44px touch target), `border-radius: var(--radius-md)`, `padding: var(--space-2) var(--space-3)`.
- **Active row** (keyboard or hover): `background: var(--accent-muted); color: var(--ink);` (warm wash, not a flat grey) + the inline keycap brightens.
- **Keycaps:** `font-mono`, `--text-xs`, `padding: 1px var(--space-2)`, `border: 1px solid var(--edge)`, `border-radius: var(--radius-sm)`, `background: var(--surface-2)`, right-aligned.
- **Drill affordance:** a right chevron at the trailing edge for `hasActions` rows; the trailing **close** button (tabs) keeps its `tabIndex={-1}` reveal-on-active behavior.
- Section labels: uppercase, `--tracking-wider`, `--ink-faint`, `--text-xs`.

### 8.3 Motion (property-scoped, reduced-motion safe — AppNav §9 discipline)

- Surface open: `opacity` + `transform: translateY(8px) scale(0.98) → none`, `--duration-base`/`--ease-bloom`.
- Height morph between states: `--ease-bloom`; only `transform`/`opacity`/`max-height` animated; **never `transition: all`**.
- Mobile sheet: slide-up `translateY(100%) → 0`, `--ease-snap`; drag uses live `transform` (no transition), snap-back transitions.
- All durations collapse to 0 under `prefers-reduced-motion` (global token zeroing already in `globals.css:218–226`); drag-dismiss disabled under reduced motion.

### 8.4 Mobile keyboard / viewport playbook (E-4)

- `useKeyboardInset()` reads `window.visualViewport` (`height`, `offsetTop`) and returns the bottom inset; the sheet positions its pinned input above it and constrains the scroll area. Consistent with `SelectionPopover.tsx:104–113,228–238`.
- No change to `app/layout.tsx` viewport meta (N6). `env(safe-area-inset-bottom)` added beneath the input.

### 8.5 Stacking & exclusivity (E-8)

`useDialogOverlay` is **behavior-only** (scroll-lock, focus-trap, return-focus, Escape) — it owns no z-index. Stacking is owned in the presenter's portal markup/CSS. The relevant layers today: `--z-modal` = 1000 (Dialog/AddContentTray), NavSheet panel = `--z-modal + 1` = 1001 (`AppNav.module.css`), `ActionMenu` portal = 1200 (`ActionMenu.module.css:34`), `--z-toast` = 10000.

- **The palette must outrank NavSheet.** A global hotkey can open the palette while the NavSheet is open — they are **not** mutually exclusive today (AppNav only closes the sheet on `activePathname` change, `AppNav.tsx:106`). This cutover makes them exclusive **and** orders them: (a) **Modify AppNav to close its sheet on `OPEN_COMMAND_PALETTE_EVENT`** (one `useEffect` listener), and (b) render the palette backdrop+panel at a dedicated layer **above** NavSheet — add `--z-palette` (= 1100) between NavSheet (1001) and ActionMenu (1200), set on the portal'd backdrop.
- **ActionMenu (1200) sits above the palette by design** and is irrelevant here: the palette spawns no `ActionMenu` (its nested actions render inside the palette list, §5.4/§7.5), and any pre-existing menu dismisses on outside interaction. The palette must stay **below** `--z-toast` (10000) so feedback toasts remain visible.

---

## 9. Accessibility contract (WAI-ARIA combobox-in-dialog)

- Container: portal'd, `role="dialog"`, `aria-modal="true"`, accessible name (`aria-label="Command palette"`); built with `useDialogOverlay` (scroll-lock + focus-trap + return-focus + Escape) — backdrop `onClick` dismiss with panel `stopPropagation` (the portal-safe pattern, per dialog-overlay doc §9).
- Input: `role="combobox"`, `aria-expanded="true"`, `aria-controls="palette-listbox"`, `aria-autocomplete="list"`, `aria-activedescendant="palette-option-<id>"`. **DOM focus stays on the input**; options are never focused (preserves typeahead).
- List: `role="listbox"` `id="palette-listbox"`; resting groups use `role="group"` + `aria-labelledby` section headings; rows `role="option"` + `aria-selected`.
- Keyboard: ↑/↓ move, Home/End jump, Enter activates default, →/Tab drill, Esc/←/Backspace-at-empty pop or close, Backspace-at-0 clears lane; IME composition guard retained.
- Announcements: `aria-busy` during search; result-count and "No matches" via `role="status"` live regions.
- Focus return to the opener on close; visible focus ring readable at 200% zoom; reduced-motion respected.

---

## 10. Performance contract

- **Local-first instant:** static/panes/recents/oracle/ask render with no network. Search is the only async source — debounced 200ms, **aborted on every keystroke** (existing `AbortController`), merged behind `aria-busy`.
- **Pure, memoized pipeline:** providers + ranking are pure and memoized on `PaletteContext`; no work when closed (controller returns early; presenters unmounted).
- **Capped DOM:** per-section and total caps (§5.3); no virtualization (N4).
- **No per-frame JS** for motion; CSS only. No `backdrop-filter` on any persistent surface (only the transient palette).

---

## 11. Composition with other systems

| System | Touchpoint | Direction |
|---|---|---|
| **Workspace store** (`useWorkspaceStore`, `getWorkspacePrimaryPanes`, `resolveWorkspacePaneTitle`) | panes provider, tab actions (`activatePane`/`closePane`/`restorePane`), `activePrimaryPaneId`/`currentHref` for context | read + command |
| **Panes** (`requestOpenInAppPane`, `resolvePaneRoute`, `getPaneRouteIcon`) | open hrefs in-app; row icons; route identity for restrictions | command + read |
| **Search** (`fetchSearchResultPage`, `resultRowAdapter`, `ALL_SEARCH_TYPES`, `SEARCH_TYPE_ICON`) | async search provider | read |
| **Keybindings** (`loadKeybindings`, `matchesKeyEvent`, `formatKeyCombo`) | global hotkeys (controller); per-row `shortcutLabel`; footer hints | read |
| **Add content** (`dispatchOpenAddContent`) | `quick-note` / `content` / `opml` actions | command |
| **Feedback** (`useFeedback`, `toFeedback`) | error + Android-restriction toasts | command |
| **Android shell** (`isAndroidShell`, `isAndroidShellRestrictedRouteId`) | provider-level route filtering + execute-time guard | read |
| **Notes** (`createNotePage`) | "New page" action | command |
| **Backend** (`/api/me/palette-history`, `/api/me/palette-selections`, `/api/oracle/readings`) | recents+frecency, selection logging (wire preserved), oracle folios | read + write |
| **AppNav** (`commandPaletteEvents`, NavRail/NavTopBar/NavSheet command triggers, live open-tab badge `:128`) | open dispatch (unchanged); badge stays; **+ close NavSheet on open-palette event** (§8.5) | event |
| **AuthenticatedShell** | mounts `<CommandPalette/>` | mount (import path change only) |

The palette **does not** own navigation, panes, search, or auth — it composes them. It is a pure orchestration surface over existing capabilities.

---

## 12. Consolidation ledger

| # | Repetition / smell today | Action |
|---|---|---|
| **C1** | Two command dirs: `components/palette/` + `components/command-palette/` | One `components/palette/` family |
| **C2** | Section id→label defined twice: `commandRanking.ts:3–10` (`RESTING_SECTIONS`) **and** `PaletteRow.tsx:18–25` (`SECTION_TAGS`) | One `SECTIONS` in `paletteModel.ts` |
| **C3** | Five inline source loops (`CommandPalette.tsx:247–349`) with divergent rank shapes | `PaletteProvider` registry (`paletteProviders.ts`) |
| **C4** | Two query-match impls: `matchesCommand` (`staticCommands.ts:233`) + scoring (`commandRanking.ts:24`) | One `rankPalette` (filter = score>0) |
| **C5** | Raw `<dialog>` + manual `showModal`/focus-rAF/`onCancel`/backdrop in both shells; `useDialogOverlay` already used by NavSheet/MobileSecondaryPaneHost/GlobalPlayerFooter/PodcastSubscriptionSettingsModal | Build both presenters on `useDialogOverlay` portal pattern |
| **C6** | `visualViewport` keyboard handling duplicated: `PaletteMobileShell.tsx:56–66` + `SelectionPopover.tsx:228–238` | Extract `useKeyboardInset` (palette now; SelectionPopover migration deferred, N8) |
| **C7** | Bespoke synthetic-history back-button close (`PaletteMobileShell.tsx:68–98`) | Extract `useHistoryDismiss` hook |
| **C8** | Two tangled keyboard listeners in the god component (`:508–536` global + `PaletteBody.tsx:50–96` modal) | Controller owns global hotkeys; `PaletteInput` owns modal keys |
| **C9** | Desktop/mobile shells duplicate `PaletteBody` wiring with divergent boolean flags (`showShortcuts`/`autoFocusInput`/`showTag`/`activeCommandId`) | One `PaletteInput` + `PaletteList`; presenter passes a small presentation config |
| **C10** (defer) | Portal+scrim+sheet markup repeated across NavSheet, MobileSecondaryPaneHost, AddContentTray, GlobalPlayerFooter, PodcastSubscriptionSettingsModal, + palette | Candidate shared `<OverlayScrim>`/`<BottomSheet>` — its own cutover (N5) |

---

## 13. Key decisions

**Owner-ratified (the three direction questions):**

- **D-1 — Omni-input + Ask-AI lane.** Instant local default; sigil lanes (`>`/`@`/`?`); a permanent "Ask AI" fallback row that escalates on Enter and never auto-routes.
- **D-2 — Luminous glass aesthetic.** Glass fill, single lit edge, soft lift, spring motion, pinned high (desktop).
- **D-3 — Nested action views, built now.** cmdk-style page stack; per-result action panels with query preserved on back.
- **D-4 — Mobile = search-first bottom sheet** with the input pinned above the keyboard (thumb zone).
- **D-5 — Hard cutover.** Delete the god component + both command dirs + three CSS modules; no fallback, no legacy, no back-compat.

**Engineering:**

- **E-1 — `useDialogOverlay` portal pattern**, not raw `<dialog>` (native top-layer is traded for explicit `--z-palette` stacking; see §8.5 / R-1).
- **E-2 — Pure provider registry over a fetched `PaletteContext`;** controller owns fetching.
- **E-3 — Preserve the selection-logging wire contract.** `PaletteSource` *is* the backend `source` enum (posted verbatim: `workspace`/`ai`, never `pane`/`ask`); only the frontend `ask` *target-kind* maps to wire `prefill` (§7.7). No backend change, no migration.
- **E-4 — `useKeyboardInset` via `visualViewport`;** do not touch the global viewport meta.
- **E-5 — Keep hand-rolled scoring;** no new fuzzy dependency; fold `matchesCommand` into ranking.
- **E-6 — Theme-aware glass tokens** in `globals.css` (three theme blocks).
- **E-7 — One CSS module** `palette.module.css`.
- **E-8 — Stacking owned in markup** (new `--z-palette` = 1100) + AppNav closes its sheet on open-palette; `useDialogOverlay` stays behavior-only (§8.5).

---

## 14. File plan

**Create**

- `components/palette/paletteModel.ts` — types + `STATIC_COMMANDS` + `SECTIONS` (from `types.ts` + `staticCommands.ts`, with `lanes` added).
- `components/palette/paletteIntent.ts` — `parsePaletteInput`.
- `components/palette/paletteProviders.ts` — `PaletteProvider`, `PaletteContext`, `PALETTE_PROVIDERS` (from the five inline loops + `commandProviders.ts`).
- `components/palette/paletteRanking.ts` — `rankPalette` (from `commandRanking.ts` + `matchesCommand`).
- `components/palette/paletteActions.ts` — `buildItemActions` (the `PaletteAction`/`PaletteActionRun` *types* live in `paletteModel.ts`, §7.1).
- `components/palette/usePaletteController.ts` — the controller hook.
- `components/palette/CommandPalette.tsx` — thin mount (replaces `components/CommandPalette.tsx`).
- `components/palette/PaletteSurface.tsx` — desktop presenter.
- `components/palette/PaletteSheet.tsx` — mobile presenter.
- `components/palette/PaletteInput.tsx`, `PaletteList.tsx`, `PaletteRow.tsx`, `PaletteFooter.tsx`.
- `components/palette/palette.module.css`.
- `lib/ui/useKeyboardInset.ts`, `lib/ui/useHistoryDismiss.ts`.
- Tests (see §16): `paletteIntent.test.ts`, `paletteRanking.test.ts`, `paletteProviders.test.ts`, `paletteActions.test.ts` (unit); `PaletteSurface.test.tsx`, `PaletteSheet.test.tsx`, `PaletteInput.test.tsx`, `CommandPalette.test.tsx` (browser).

**Modify**

- `app/(authenticated)/AuthenticatedShell.tsx` — import `@/components/palette/CommandPalette` (path change).
- `app/globals.css` — add `--palette-glass-*` tokens to the three theme blocks, `--palette-glass-blur` in the scale block, and `--z-palette: 1100` in the z-index scale (§8.5).
- `components/appnav/AppNav.tsx` — close the NavSheet on `OPEN_COMMAND_PALETTE_EVENT` (one listener), so a hotkey-opened palette never sits behind an open sheet (§8.5).
- `components/commandPaletteEvents.ts` — keep; optionally extend the event `detail` to carry an initial query/lane (only if a trigger needs it).
- `lib/androidShell.commandPalette.test.tsx` — retarget to the new modules.

**Delete**

- `components/CommandPalette.tsx`
- `components/command-palette/` (entire dir: `staticCommands.ts`, `commandProviders.ts`, `commandRanking.ts`, `commandProviders.test.ts`, `commandRanking.test.ts`)
- `components/palette/PaletteBody.tsx` + `.module.css` + `.test.tsx`
- `components/palette/PaletteDesktopShell.tsx` + `.module.css` + `.test.tsx`
- `components/palette/PaletteMobileShell.tsx` + `.module.css` + `.test.tsx`
- `components/palette/types.ts`
- `__tests__/components/CommandPalette.test.tsx` (i.e. `apps/web/src/__tests__/components/CommandPalette.test.tsx`; replaced)

---

## 15. Acceptance criteria

**Functional**

- ⌘K (the bound key) toggles open/close and returns focus to the opener; event + deep-link triggers still open it.
- Sigils route lanes (`>`/`@`/`?`); lane chip renders; Backspace-at-0 clears it.
- "Ask AI" is present whenever a term exists and never executes without being selected; Enter on it opens a prefilled conversation.
- Typing yields instant local results; search merges in asynchronously without blocking typing; stale results never overwrite newer ones.
- A drillable row drills on →/Tab/affordance and runs its default on Enter; back preserves the query; actions execute correctly (open / ask / copy link / switch / close tab).
- Contextual suggestion appears for the active reader/doc at rest; active pane is boosted.
- Android-restricted routes never appear and are guarded at execution.
- Selection logging posts the **identical** wire body as today.

**Visual**

- Desktop: glass surface pinned high, single lit edge, soft lift, spring open, height morph between states; last querying row half-clipped.
- Mobile: bottom sheet with grabber, snap-to-full on focus, input above keyboard, safe-area padding, drag-dismiss.
- Active row uses the warm accent wash; keycaps are mono and aligned; footer hint bar present.

**A11y**

- dialog+combobox+listbox roles; focus stays on input; `aria-activedescendant` tracks selection; focus trap + return; Escape; `aria-busy`/`role=status` announcements; 200%-zoom focus visibility; reduced-motion honored.

**Perf**

- No network on the resting/instant path; search aborted per keystroke; no `transition: all`; no `backdrop-filter` on persistent surfaces.

**Cleanup**

- `components/CommandPalette.tsx`, `components/command-palette/`, and the three legacy palette shells/CSS are gone; section labels and query-matching exist once; `lint`, `typecheck`, `vitest` (unit + browser), and the e2e palette spec pass with no warnings.

---

## 16. Test plan

**Unit (jsdom project):**

- `paletteIntent.test.ts` — sigil parsing truth table (none/`>`/`@`/`?`, whitespace, empty, sigil-only).
- `paletteRanking.test.ts` — tier ordering, additive boosts, lane filtering, capping, resting grouping order, pinned-last, deterministic tiebreak (ported from `commandRanking.test.ts`).
- `paletteProviders.test.ts` — each provider's items from a fixture context; Android filtering; dedup vs open panes; ask-fallback presence rules (ported from `commandProviders.test.ts`).
- `paletteActions.test.ts` — action sets per source/target; tab vs content; default-action identity; **the actions-page keyboard truth table** (→/Tab drill; Enter runs default; Esc/←/Backspace-at-empty pop; query preserved).

**Unit (hooks):**

- `lib/ui/useKeyboardInset.test.tsx` — bottom inset from a mocked `visualViewport` (height/offsetTop resize + scroll events); SSR/no-viewport fallback.
- `lib/ui/useHistoryDismiss.test.tsx` — pushes one synthetic entry, closes on `popstate`, dedups the self-initiated `history.back()`, cleans up.

**Browser (real-Chromium project):**

- `PaletteSurface.test.tsx` — open/close, focus into input, Escape, backdrop dismiss, arrow nav + `aria-activedescendant`, Enter executes, drill → actions page → back preserves query, footer hints, **stacking above an open NavSheet** (§8.5).
- `PaletteSheet.test.tsx` — sheet renders, focus-trap + return, Android back-dismiss (history), drag threshold close, reduced-motion path; keyboard-inset positioning contract (mock `visualViewport`).
- `PaletteInput.test.tsx` — lane chip, Backspace-at-0 clears lane, IME composition guard.
- `CommandPalette.test.tsx` — viewport picker (desktop↔mobile), deep-link open (`?palette/cmd/q`), toggle key, and **exact selection-logging POST bodies** (mock `apiFetch`): an `href` selection (`source` verbatim, e.g. `"workspace"`/`"recent"`), an `action` selection, and an **`ask` selection asserting `target_kind:"prefill"`, `target_key:"prefill:conversation:<text>"`, `source:"ai"`** (§7.7).
- `appnav` coverage — the mobile NavTopBar command trigger dispatches the open event, the open-tab badge reflects `paneCount`, and opening the palette **closes an open NavSheet** (§8.5).
- `lib/androidShell.commandPalette.test.tsx` — retargeted: restricted route absent from history/static/search; settings still present.

**E2E:** port `e2e/tests/command-palette.spec.ts` (168 lines) to the new DOM (roles unchanged; selectors by role/label, not internal class names).

---

## 17. Hard-cutover steps

1. Land the **pure foundation**: `paletteModel.ts`, `paletteIntent.ts`, `paletteProviders.ts`, `paletteRanking.ts`, `paletteActions.ts` + their unit tests (green before any UI).
2. Add the **shared hooks**: `useKeyboardInset.ts`, `useHistoryDismiss.ts` + tests.
3. Build the **controller** `usePaletteController.ts` (fetching + execution + hotkeys), wired to the foundation.
4. Build the **presentation**: `PaletteRow` → `PaletteList` → `PaletteInput` → `PaletteFooter` → `PaletteSurface` (desktop) → `PaletteSheet` (mobile) → `CommandPalette` mount.
5. Add the **glass tokens** to `globals.css`; author `palette.module.css`.
6. **Rewire** `AuthenticatedShell` to the new mount.
7. **Delete** the god component, `components/command-palette/`, the three legacy shells/CSS/types, and the superseded tests.
8. Port/author tests; run `lint` + `typecheck` + `vitest` (unit + browser) + e2e — **zero warnings**; capture new screenshots.

No transition window, no feature flag, no parallel old path.

---

## 18. Risks & mitigations

- **R-1 — Loss of native `<dialog>` top-layer.** The portal pattern owns its own stacking, and the palette is **not** mutually exclusive with NavSheet today (a hotkey can open it behind the sheet — NavSheet is `--z-modal + 1`). Mitigation (§8.5): introduce `--z-palette` = 1100 (above NavSheet's 1001, below `ActionMenu`'s 1200 and `--z-toast`'s 10000) on the portal'd backdrop, **and** have AppNav close its sheet on `OPEN_COMMAND_PALETTE_EVENT`; a browser test asserts the palette sits above an open sheet and that feedback toasts remain above the palette.
- **R-2 — Mobile keyboard jank.** `visualViewport` resize can lag. Mitigation: position via `useKeyboardInset` with `transform` (compositor-only), `svh` fallback, and a 100ms scroll-guard on drag; device-verify on iOS Safari + Android shell.
- **R-3 — Drill model complexity / key conflicts.** →/Tab/Backspace overloading. Mitigation: explicit truth-table tests; Backspace drills back only when the term is empty; Tab never leaves the trap.
- **R-4 — Autofocus aggressiveness on mobile** (keyboard pops on open). Mitigation: ship autofocus (search-first) but keep it a one-line toggle in the sheet presenter; validate on device, revisit if intrusive.
- **R-5 — Wire-contract drift.** Renaming `prefill`→`ask` could leak to the POST body. Mitigation: a single mapping point in the controller + a `CommandPalette.test.tsx` assertion on the exact body.
- **R-6 — Android back-button regressions.** History-dismiss is fragile. Mitigation: isolate in `useHistoryDismiss` with the existing dedup semantics + a browser test simulating `popstate`.
- **R-7 — Deep-link / hotkey timing.** Static-command hotkeys must keep firing while closed. Mitigation: controller registers the global listener unconditionally (as today), independent of `open`.

---

## 19. Deferred follow-ups (explicitly out of this cutover)

- **F1 — Agentic surface (the option not chosen):** inline streamed AI answers, reader-scoped `@thisdoc` grounded responses (N7), and agentic reading tasks (summarize highlights, build reading list) rendered with progress + approval gates inside the palette. The `ask` target's `scopeHref` and the page-stack are the seams that make this additive later.
- **F2 — Shared `<BottomSheet>`/`<OverlayScrim>` primitive (C10):** unify the six portal+scrim+sheet sites in a dedicated cutover.
- **F3 — `SelectionPopover` onto `useKeyboardInset` (C6/N8).**
- **F4 — List virtualization (N4)** if any provider ever returns hundreds of rows.
- **F5 — "Quick keys"** (user-bound short strings → saved actions/prompts) over the same omni-input.
- **F6 — Bridge `PaneShell` resource options into the palette (N9):** surface the live `ActionMenuOption` closures (`paneMenuOptions`) as nested palette actions for a focused content/tab item, so the palette's drill-down matches the pane's `⋯` menu without a duplicated catalog. Needs a shared, presentation-agnostic action source (the candidate `<BottomSheet>`/options unification, F2).
```

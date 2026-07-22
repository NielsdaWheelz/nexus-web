# The Docent — guided walk through cited passages — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims.

## One-line

One keystroke enters a guided walk that steps through an assistant answer's sources pane by pane, with the citing sentence as caption — the honest, cheap form of "generated UI", built entirely on already-shipped primitives (`CitationOut.deep_link`, `openInNewPane`, `hasSamePaneRoute` deduplication).

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** `CitationOut` (frontend: `apps/web/src/lib/conversations/citationOut.ts:41`) carries `deep_link: string | null` built backend-side in `python/nexus/services/resource_items/routing.py:108-113`. For evidence-span targets the href is `/media/{media_id}#evidence-{span_id}`; for fragments, `/media/{media_id}#fragment-{id}`; for note-block targets, `/notes/{block_id}`. Verified live values in `AssistantMessage.test.tsx:169` (`deep_link: "/reader/source"` on a `CitationOut`-shaped object). `deep_link === null` only when the target is genuinely unrouteable (deleted media, unresolved oracle anchor).
- **P-2.** `openInNewPane` (pane runtime signature in `apps/web/src/lib/panes/paneRuntime.tsx`): `(href: string, labelHint?: string, secondarySurfaceId?: WorkspaceSecondarySurfaceId) => void`. The workspace `open_pane` reducer deduplicates by `hasSamePaneRoute`, which uses `normalizePaneRouteKeyHref` to strip the `#` fragment. Consequence: successive walk steps targeting different evidence spans in the **same media file** navigate an existing reader pane to each new span rather than opening additional panes. Steps targeting different media open additional panes. `MAX_PANES = 12` bounds pane-spam.
- **P-3.** `ConversationMessage.citations` (`types.ts:282`): `CitationOut[]` delivered from the server via `citation_index` SSE event and the message GET; already available on the React rendering path at `AssistantEvidenceDisclosure.tsx:28`. The message text is `conversationMessageText(message)` (`types.ts:290-296`): concatenation of `message_document.blocks[*].text`. Both are available client-side in `AssistantMessage.tsx` without any new API.
- **P-4.** `FloatingActionSurface` (`apps/web/src/components/ui/FloatingActionSurface.tsx`) exists and is used by the highlight quick-note composer. **Verified not the right primitive for the docent HUD** — it portals to `document.body` and is designed for transient popovers anchored to selection rects or DOM elements. The docent HUD is a persistent layout slot. DocentOverlay instead renders inline in the `ChatSurface` compositor slot (see §7.1).
- **P-5.** `MachineText` (`machine-hand-hard-cutover.md`, SPEC, P-1 of that spec). The citing-sentence caption in the HUD is rendered in MachineText inline variant (`variant="inline"`, `origin={{ label: "Assistant" }}`). See P-9; machine-hand-hard-cutover.md is a hard prerequisite — no fallback `<span>` shim ships.
- **P-6.** On mobile (`isMobile = true`, `WorkspaceHost.tsx:647`), only the active pane is rendered (`renderedPanes = isMobile ? [activePane] : panes`, `:1097`). Walk steps on mobile use `router.push(href)` (in-pane navigation) instead of `openInNewPane`. The pane runtime `router.push` is available from `usePaneRouter()` (`paneRuntime.tsx` — same file as openInNewPane). There is no "back to conversation" magic; the user navigates back via pane history (`canGoBack` / `router.back()`), which the HUD advertises once it is open.
- **P-7.** The `messageActions` div (`AssistantMessage.tsx:101`) is currently rendered when `canBranchFromAssistant || canResendAssistant`. Adding the Walk button requires expanding this outer gate to also render when `onStartWalk && message.status === "complete" && (message.citations?.length ?? 0) >= 2` (`canWalk`). The Walk button has its own inner gate: `canWalk`. The Fork and Resend buttons retain their individual inner gates (`canBranchFromAssistant`, `canResendAssistant`). The outer condition becomes `canBranchFromAssistant || canResendAssistant || canWalk`.
- **P-8.** No backend code, no migration, no migration number. This is a purely frontend cutover.
- **P-9.** `machine-hand-hard-cutover.md` (SPEC) must land before this cutover. `MachineText` is a hard dependency of `DocentOverlay.tsx`; no fallback `<span>` shim is permitted (hard-cutover doctrine). If the ordering cannot be guaranteed, sequence docent after machine-hand.

---

## 1. Problem (grounded diagnosis)

### 1.1 Citations exist but cannot be toured

The assistant already constructs grounded answers with citation edges (`origin='citation'`, `resource_graph/citations.py`). Each `CitationOut` carries a `deep_link` that resolves to the exact evidence span in the reader. The `openInNewPane` primitive and `hasSamePaneRoute` deduplication already exist. `[n]` markers in the assistant text already identify which sentence each source supports. None of this is wired together into a navigable sequence. The user who wants to verify the answer must click each `[n]` chip individually, losing their place in the text each time.

### 1.2 Chat is the only surface without corpus choreography

The reader has evidence-span highlighting, the Oracle has three-act passage navigation, the Connections panel navigates edge-by-edge. The chat surface — where the most grounded synthesis happens — has no affordance for navigating its own sources as a sequence. The workspace choreography primitives already exist and are already used by these surfaces; the gap is a missing compositor, not missing machinery.

---

## 2. Target behavior (user-facing)

- **Desktop, walk entry.** A completed assistant message with ≥2 citations shows a "Walk the sources" action in its message actions row (alongside Fork). Clicking enters walk mode.
- **Desktop, walking.** A HUD bar appears above the chat composer: `1 / 4 · Source Title` on the left; a `←` (p) / `→` (n) / `✕ Leave` control cluster on the right. Below the bar, the citing sentence from the answer is displayed in the machine register (MachineText inline). Each step opens (or navigates) a reader pane to the exact evidence span with the ambient pulse highlight the reader already provides for `#evidence-{span_id}` deep links. Successive steps to the same media file reuse the same reader pane.
- **Desktop, keyboard.** While walking: `n` or `→` advances, `p` or `←` retreats, `Escape` leaves. Keys fire only when focus is not inside an `<input>`, `<textarea>`, or `contenteditable`. No conflict with existing `Meta+k` (Launcher) or `Meta+Shift+→/←` (pane navigation) bindings.
- **Desktop, leaving.** `Escape` or the `✕` button ends the walk. The reader panes opened during the walk remain open (not closed). No "restore" state — the workspace was always in a sane state; walk only added panes.
- **Mobile.** The HUD appears above the composer (sticky). Each step calls `router.push(href)`, navigating the active pane to the evidence. The pane history grows; Back returns toward the conversation. The HUD advertises "`← back` to return to chat" when the user has navigated away.
- **Skipped step.** A step whose `deep_link === null` (deleted media) shows the step's title with a struck-through `<s>` wrapper and the note "Source unavailable" in place of the citing sentence. The walk does not advance automatically; the user presses `n` to continue.
- **Walk complete.** After the last step, pressing `n` ends the walk (`status: 'complete'` → renders nothing; HUD unmounts). Re-entry from a message restarts from step 1.
- **Oracle / LI.** The docent verb is not wired to oracle reading panes (no pane runtime until oracle-shell-dissolution lands) or the LI pane in this slice. Both are forward-refs (§10); their `CitationOut` arrays share the same deep-link shape and could be wired identically when their pane contexts carry `openInNewPane`.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Pure state machine: `docentWalk.ts` contains zero side effects; all transitions are deterministic pure functions; unit-testable without a DOM.
- **G2.** One entry verb per complete assistant message: "Walk the sources" in `messageActions`, ≥2 citations, status complete.
- **G3.** One HUD owner: `DocentOverlay.tsx`. Conversation.tsx owns walk state; ChatSurface owns the render slot; DocentOverlay owns only presentation.
- **G4.** No new backend. No new endpoint. No new SSE event. No migration.
- **G5.** Deduplicate reader panes via the existing workspace store contract, verified.
- **G6.** Keyboard shortcuts (`n/p/Escape`) scoped to walk-active only, not registered in `KeybindingsProvider` (they are modal shortcuts, not configurable global shortcuts).
- **G7.** Mobile path produces correct navigation via `router.push`.
- **G8.** Citing sentence extraction is a pure function with unit tests covering edge cases (marker at sentence start/end, multiple markers in same sentence, missing marker, marker in code fence).

### Non-goals

- **N1.** No autoplay. The walk advances only on user action (keypress or button). No `setTimeout`-based auto-advance.
- **N2.** No AI calls. The docent is an ordinal sequence over the already-built `CitationOut[]`; it does not re-query, re-rank, or re-summarize anything.
- **N3.** No persistence. Walk state is ephemeral React state. Leaving/reloading resets to idle. No `localStorage`, no URL params, no server record.
- **N4.** No new resource_edges origin. The walk is a navigation affordance, not a provenance event.
- **N5.** No walknotes integration. The WalkNotes spec owns the GlobalPlayerFooter; the docent owns the conversation pane HUD. They are separate surfaces.
- **N6.** No "open all sources" mode. Each step is deliberate; batch-opening all sources at once would be pane-spam and is rejected (D-4).
- **N7.** No oracle reading scope in S0–S3. Oracle panes lack `openInNewPane` until oracle-shell-dissolution; wiring is a forward-ref.
- **N8.** No configurable keybindings. `n/p/Escape` are modal and unlisted in settings.

---

## 4. Architecture and final state

### 4.1 Ownership table

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| Walk state (steps, index, status) | `lib/conversations/docentWalk.ts` pure state machine | (new) |
| Sentence extraction from message text | `docentWalk.ts:extractCitingSentence` pure function | (new) |
| Walk reducer hook + keyboard + pane driving | `lib/conversations/useDocentWalk.ts` | (new) |
| HUD presentation | `components/chat/DocentOverlay.tsx` | (new) |
| HUD render slot in layout | `ChatSurface.tsx` (optional `docentOverlay` prop slot) | (new prop) |
| Walk state ownership in pane | `Conversation.tsx` | (new state) |
| Entry verb | `AssistantMessage.tsx` messageActions | (new button) |

### 4.2 State machine (`docentWalk.ts`)

```typescript
import type { CitationOut } from "@/lib/conversations/citationOut";

export interface DocentStep {
  ordinal: number;               // citation ordinal (1-based)
  title: string;                 // citation.snapshot?.title ?? "Untitled source"
  href: string | null;           // citation.deep_link; null = unrouteable/deleted
  citingSentence: string | null; // sentence containing [ordinal] in message text
}

export type DocentWalkStatus = "idle" | "active" | "complete";

export interface DocentWalkState {
  steps: readonly DocentStep[];
  index: number;     // 0-based current step; only meaningful when status = 'active'
  status: DocentWalkStatus;
}

export type DocentAction =
  | { type: "start"; citations: CitationOut[]; messageText: string }
  | { type: "next" }
  | { type: "prev" }
  | { type: "leave" };

export const DOCENT_IDLE: DocentWalkState = { steps: [], index: 0, status: "idle" };

export function docentReducer(
  state: DocentWalkState,
  action: DocentAction,
): DocentWalkState;

/** Extracts the sentence containing [ordinal] from message prose text. */
export function extractCitingSentence(text: string, ordinal: number): string | null;

/** Builds ordered DocentStep[] from the message's citation array and text. */
export function buildDocentSteps(
  citations: CitationOut[],
  messageText: string,
): DocentStep[];
```

**`extractCitingSentence` algorithm:** (1) Regex-locate the first occurrence of `[ordinal](?!\()` in `text` (identical pattern to `substituteCitationMarkers` in `MarkdownMessage.tsx:161-166`, regex at `:163`). If absent, return `null`. (2) Scan backward from the match position to the nearest sentence boundary: `". "`, `".\n"`, `"\n\n"`, or string start — whichever comes last. (3) Scan forward to the next sentence boundary or string end. (4) Return the trimmed slice. Edge cases with unit tests (§11.S0): marker absent → `null`; marker in code fence (``` ` ``` or ```` ``` ````) → `null` (guard: if the character at marker position has an odd count of backticks before it on the same line, skip); marker at string start/end; multiple markers in one sentence (returns same sentence for each); text with only inline code, no prose.

**`docentReducer`:**
- `start`: builds steps, starts at `index: 0`, `status: 'active'`.
- `next`: if `index + 1 >= steps.length`, returns `status: 'complete'`; else increments index.
- `prev`: if `index === 0`, no-op; else decrements index.
- `leave`: returns `DOCENT_IDLE`.

### 4.3 Hook (`useDocentWalk.ts`)

```typescript
export function useDocentWalk({
  openInNewPane,
  router,
  isMobile,
}: {
  openInNewPane: ((href: string, labelHint?: string) => void) | undefined; // omits unused secondarySurfaceId
  router: PaneScopedRouter;
  isMobile: boolean;
}): {
  walk: DocentWalkState;
  startWalk: (citations: CitationOut[], messageText: string) => void;
  next: () => void;
  prev: () => void;
  leave: () => void;
};
```

Pane-driving side effect: a `useEffect` on `[walk.status, walk.index]` that fires when the walk is `active`. It reads `walk.steps[walk.index].href`. If `null`, no-op (broken step). If non-null: on mobile → `router.push(href)`; on desktop → `openInNewPane?.(href, step.title)`. A `useRef` tracks the previous `(status, index)` pair to guard against spurious re-fires.

Keyboard side effect: a `useEffect` on `[walk.status]` that attaches a `keydown` handler to `document` when `status === 'active'`. Guard: skip if `target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as HTMLElement).isContentEditable`. Keys: `n` / `ArrowRight` → `next()`; `p` / `ArrowLeft` → `prev()`; `Escape` → `leave()`. All call `event.preventDefault()` to suppress default browser actions. Cleanup removes the listener when status leaves `active`.

### 4.4 HUD (`DocentOverlay.tsx`)

Receives `walk: DocentWalkState`, `onNext`, `onPrev`, `onLeave`. Renders nothing when `walk.status !== 'active'`. When active:

```
┌──────────────────────────────────────────────────────────┐
│  1 / 4  ·  Capital in the Twenty-First Century          │
│  "The evidence for secular stagnation is strongest [1]"  │
│                             ← prev   next →   ✕ Leave  │
└──────────────────────────────────────────────────────────┘
```

- Top row: `{index+1} / {steps.length}` (small-caps, `--ink-faint`) · source title (`--ink`).
- Citation sentence row: when `step.href !== null`, MachineText inline `variant="inline" origin={{ label: "Assistant" }}`. When `step.href === null`, `<s aria-label="Source unavailable">{step.title}</s>`.
- Button row: `← prev` (disabled at index 0), `next →`, `✕ Leave` — plain text buttons, `--font-sans`, `--ink-faint`.
- `role="status"` on the container; `aria-live="polite"` on the title row so screen readers announce step changes.
- `data-testid="docent-overlay"` for test queries.

CSS: `position: sticky; bottom: 0;` inside the `composerSlot`. A `border-top: 1px solid var(--stroke-hairline)` separates it from the transcript scroll area. `background: var(--surface-1)`. No `border-radius` (flush to pane edges, editorial — matches Correspondence doctrine). `padding-inline: var(--pane-inline-padding)`.

### 4.5 ChatSurface layout change

`ChatSurface.tsx` receives two new optional props: `docentOverlay?: ReactNode` (renders as the first child of `styles.composerSlot`, before `{composer}`) and `onStartWalk?: (citations: CitationOut[], text: string) => void` (forwarded to each `<MessageRow />`). When null/undefined, both are no-ops and the layout is unchanged.

---

## 5. Data model / migration

**None.** No new tables, no migration, no backend schema change. Walk state lives entirely in React. Walk is ephemeral.

---

## 6. API

**None.** No new routes, no new SSE events, no new query params. The walk reads `message.citations` (already fetched) and calls `openInNewPane` (already exists).

---

## 7. Frontend

### 7.1 Files created

| File | Purpose |
|---|---|
| `apps/web/src/lib/conversations/docentWalk.ts` | Pure state machine, `buildDocentSteps`, `extractCitingSentence`, `docentReducer` |
| `apps/web/src/lib/conversations/docentWalk.test.ts` | Unit tests — node project (pure logic, no DOM) |
| `apps/web/src/lib/conversations/useDocentWalk.ts` | Hook: `useReducer` + keyboard effect + pane-driving effect |
| `apps/web/src/lib/conversations/useDocentWalk.test.tsx` | Browser tests (Chromium) — hook smoke tests for pane-driving and keyboard effects |
| `apps/web/src/components/chat/DocentOverlay.tsx` | HUD presenter |
| `apps/web/src/components/chat/DocentOverlay.module.css` | HUD layout CSS |
| `apps/web/src/components/chat/DocentOverlay.test.tsx` | Browser test (Chromium) |

### 7.2 Files modified

| File | Change |
|---|---|
| `apps/web/src/components/chat/AssistantMessage.tsx` | Add `onStartWalk?: (citations: CitationOut[], text: string) => void` prop; expand `messageActions` outer gate to `canBranchFromAssistant \|\| canResendAssistant \|\| canWalk`; add Walk button inside the div gated on `canWalk` |
| `apps/web/src/components/chat/ChatSurface.tsx` | Add `docentOverlay?: ReactNode` prop (render before `{composer}` inside `composerSlot`); add `onStartWalk?: (citations: CitationOut[], text: string) => void` prop (forwarded to each `<MessageRow />`) |
| `apps/web/src/components/chat/Conversation.tsx` | Add `import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport"` and `const isMobile = useIsMobileViewport()`; own `useDocentWalk({ openInNewPane, router, isMobile })`; pass `docentOverlay={<DocentOverlay … />}` and `onStartWalk` to `ChatSurface` |
| `apps/web/src/components/chat/MessageRow.tsx` | Add `onStartWalk?: (citations: CitationOut[], text: string) => void` to `MessageRowProps`; pass to `AssistantMessage` |

### 7.3 MessageRow prop threading

`MessageRow` receives a new optional `onStartWalk?: (citations: CitationOut[], text: string) => void` and passes it directly to `AssistantMessage`. `AssistantMessage` calls it with `(message.citations ?? [], conversationMessageText(message))`. The threading is uniform 2-param at every layer: `Conversation → ChatSurface → MessageRow → AssistantMessage`. Walk-active state is communicated to the user solely through the DocentOverlay HUD; there is no "walking" visual toggle on the Walk button itself.

### 7.4 Soft coordination with `correspondence-hard-cutover.md` (SPEC)

The Correspondence cutover (`correspondence-hard-cutover.md`) introduces `MessageFootnotes.tsx` (a numbered source list below the prose). When that spec lands, "Walk the sources" could gain a second mount site in the `MessageFootnotes` header (e.g., "4 sources — Walk"). **For S0–S3 the sole canonical entry verb is `AssistantMessage.tsx` `messageActions`** (as per §4.1 ownership table). The footnote-header affordance is a forward-ref for correspondence to add; until then, only the messageActions mount exists. The docent and correspondence specs are **independent**; either can land first:

- Docent first: verb lives in `messageActions`; when correspondence lands it may add the footnote-header affordance by wiring the same `onStartWalk` callback (no removal of messageActions verb required).
- Correspondence first: `MessageFootnotes` renders without a Walk affordance; when docent lands, the messageActions verb is wired and the footnote mount can follow.

The only shared file is `AssistantMessage.tsx`. If both specs are in flight simultaneously, the correspondence branch touches `.messageActions` to re-style the Fork button area; docent adds a button there. Resolve by porting docent's new button into the correspondence branch at merge, keeping both buttons in the same container.

---

## 8. Key decisions

**D-1. Walk state in Conversation.tsx, not a global store.** Walk scope is one conversation pane. Storing walk state globally (workspace store or context above pane boundary) would require a pane-ID key and lifecycle cleanup on pane close. A local `useDocentWalk` hook inside `Conversation.tsx` scopes cleanup to the component lifetime automatically. *Rejected:* global atom (Zustand/jotai) — adds coupling across panes for a single-pane feature; workspace store action — premature abstraction.

**D-2. Pure state machine + separate hook, not a single stateful component.** `docentWalk.ts` is pure so all transitions can be tested without a DOM or React. The hook is the impure shell (effects, refs). `DocentOverlay.tsx` is a pure presenter. Three layers: logic / effects / presentation. *Rejected:* co-located reducer inside the component (untestable transition logic); XState (dependency not justified for a 3-state machine).

**D-3. openInNewPane via existing workspace deduplication, not imperative cross-pane routing.** The brief proposed two designs: (A) `openInNewPane` + deduplication (verified); (B) an imperative cross-pane router handle. (A) is correct. The workspace `open_pane` reducer already does exactly what the docent needs: if a reader pane for `/media/{id}` is open, `applyPaneHrefTransition` navigates it to `/media/{id}#evidence-{span_id}` rather than opening a duplicate. This is the designed extension point (`hasSamePaneRoute` is fragment-agnostic by construction). (B) would require new cross-pane communication primitive. *Rejected.*

**D-4. No "open all sources" mode.** Opening all sources at once would be 2–8 new panes in rapid succession, disrupting workspace layout without the user directing it. The step-by-step walk is the correct affordance. *Rejected: batch mode.*

**D-5. Keyboard shortcuts not registered in KeybindingsProvider.** `n/p/Escape` are modal shortcuts active only during a walk. They don't conflict with any default keybinding (`DEFAULT_KEYBINDINGS` in `keybindings.ts:6-10` registers `open-launcher`, `pane-next`, `pane-previous` — none overlap). Adding them to the keybindings settings page would mislead users into thinking they are always active. *Rejected: configurable bindings.*

**D-6. DocentOverlay is an inline layout slot, not FloatingActionSurface.** `FloatingActionSurface` is anchored to a DOM element, portals to `document.body`, and self-dismisses on outside-click/Escape. The docent HUD is persistent (survives clicks elsewhere, does NOT dismiss on outside click, only on Escape or explicit Leave). An inline `position: sticky; bottom: 0` inside `composerSlot` is the correct primitive. *Rejected: FloatingActionSurface — wrong dismiss model and wrong positioning strategy for a persistent HUD.*

**D-7. citingSentence extracts at walk-start (buildDocentSteps), not at each render.** Extraction happens once when the user clicks "Walk", not per-render. The message text doesn't change post-completion. This is cheap and keeps DocentOverlay a pure presenter. *Rejected: lazy extraction per step — adds state complexity for zero benefit.*

**D-8. Oracle/LI scope deferred to forward-ref.** Oracle readings today live in `app/(oracle)/` with no pane runtime (`openInNewPane` unavailable until oracle-shell-dissolution). Library Intelligence pane is in the workspace and has a pane runtime, but its citation array is in the LI component's own state, not propagated to Conversation.tsx. Including oracle or LI in S0–S3 would require either: (a) polling for pane runtime presence (fragile), or (b) threading citation state from new surfaces. Deferred cleanly as a fourth slice. *Rejected: include LI in S3 — threading requires touching 4 more files for a non-blocking feature.*

**D-9. No Correspondence dependency.** The docent walks on `message.citations: CitationOut[]` which exists in the current message model (P-3). The Correspondence spec repres the _visual_ rendering of those same citations (chips → superscripts + footnotes) but does not change `CitationOut`, `toReaderCitationData`, or `message.citations`. There is no data contract dependency. *Rejected: treating Correspondence as P-N.*

---

## 9. What dies (exhaustive)

No existing files are deleted. No symbols are removed. No CSS blocks are cut.

**Specifically not deleted:**
- `ReaderCitation`, `toReaderCitationData`, `substituteCitationMarkers` — unchanged. The walk reads `CitationOut.deep_link` directly without touching the citation chip rendering.
- Any "open all sources" or "reveal all citations" affordance: searched via `rg "open.*all.*sources|openAllSources|reveal.*sources" apps/web/src` — no matches. Nothing to absorb.

---

## 10. Sibling cutovers and sequencing

**machine-hand-hard-cutover.md (SPEC):** `MachineText` (`variant="inline" origin={{ label: "Assistant" }}`) is used by `DocentOverlay` for the citing-sentence caption. **Hard prerequisite** (P-9): this spec must land before docent. No fallback `<span>` shim is permitted. The negative guard (§13, G9) asserts MachineText IS imported in `DocentOverlay.tsx`.

**correspondence-hard-cutover.md (SPEC):** Shares `AssistantMessage.tsx`. Coordination: docent adds a button in `messageActions`; correspondence restructures the message layout. See §7.4 for merge protocol. No data contract overlap.

**amanuensis-hard-cutover.md (SPEC):** Also shares `AssistantMessage.tsx` — amanuensis extends the streaming active-tool-label switch and adds trust-trail write rows (inside the machine-hand `MachineText` block), while docent adds the `Walk` button in `messageActions`. Disjoint regions; both sequence after machine-hand; merge additively. No data contract overlap.

**oracle-shell-dissolution-hard-cutover.md (SPEC):** After oracle pane routes land in the workspace pane system, `OracleReadingPaneBody` will have `usePaneRuntime()` → `openInNewPane`. The oracle reading's per-passage `citation: CitationOut | null` array (`OracleReadingPaneBody.tsx:75`) shares the identical deep-link shape (`_citation_out` in `citations.py` is the same backend function). A future S4 wires the Walk verb into oracle by: (1) collecting `state.passages.map(p => p.citation).filter(Boolean)` as the step array; (2) using `passage.exact_snippet` as the `citingSentence` (no `[n]` marker extraction needed). Blocked on oracle-shell-dissolution.

**walknotes-hard-cutover.md (SPEC):** Unrelated — owns `GlobalPlayerFooter`. No shared files.

**pane-header-identity-hard-cutover.md (BUILT):** Owns pane header projection
and the global interaction-owner contract. Docent participates only through
`useDocentWalk` suppressing shortcuts while a modal or transient interaction
owns the command layer.

**Shared vocabulary verified against sibling specs:**
- `CitationOut.deep_link` format (evidence span href) — consistent with oracle-shell-dissolution and correspondence.
- `MachineText` `origin` labels — only `"Assistant"` is used here; consistent with machine-hand-hard-cutover's label set (`Assistant`, `Synapse`, `Dossier`, `Dawn`, `Summary`; open/extensible per its G3 — e.g. `one-press-artifact-engine-hard-cutover.md` adds `Distillate`). This spec adds no new label.
- No new `resource_edges` origin — consistent with house rule that zero siblings add a new origin.
- `openInNewPane` signature — unchanged from paneRuntime.tsx; no sibling modifies it.

---

## 11. Slices (each independently buildable)

**S0 — Pure logic: `docentWalk.ts` + `docentWalk.test.ts`**

Create `lib/conversations/docentWalk.ts`:
- `DocentStep`, `DocentWalkState`, `DocentWalkStatus`, `DocentAction` types
- `DOCENT_IDLE` constant
- `extractCitingSentence(text, ordinal): string | null` — pure, no imports beyond string utils
- `buildDocentSteps(citations: CitationOut[], messageText: string): DocentStep[]` — sorts by ordinal, calls extractCitingSentence for each
- `docentReducer(state, action): DocentWalkState`

Create `lib/conversations/docentWalk.test.ts` (`.test.ts` = node unit project):
```typescript
describe("extractCitingSentence", () => {
  it("returns the sentence containing the marker");
  it("returns null when ordinal is absent from text");
  it("handles marker at the very start of text");
  it("handles marker at the very end of text");
  it("returns the same sentence when two markers share it");
  it("returns null for a marker inside a code fence");
  it("handles paragraph-break sentence boundaries (\\n\\n)");
});
describe("docentReducer", () => {
  it("start builds steps and enters active at index 0");
  it("next advances index");
  it("next transitions to complete at end of steps");
  it("prev decrements index");
  it("prev is a no-op at index 0");
  it("leave returns DOCENT_IDLE from any state");
});
```

*Verify:* `cd apps/web && bun run test:unit --reporter=verbose docentWalk`

---

**S1 — Hook: `useDocentWalk.ts` + `useDocentWalk.test.tsx`**

Create `lib/conversations/useDocentWalk.ts`. Imports: `docentReducer`, `DOCENT_IDLE` from `docentWalk.ts`; `useReducer`, `useEffect`, `useRef`, `useCallback` from React; `CitationOut`, `DocentWalkState`.

Implements:
- `useReducer(docentReducer, DOCENT_IDLE)`
- Stable `startWalk`, `next`, `prev`, `leave` callbacks via `useCallback`
- Pane-driving `useEffect`: fires when `walk.status` or `walk.index` changes; reads current step; calls `openInNewPane(href, step.title)` or `router.push(href)` per mobile flag; skips when `href === null`; guards against re-fire via `useRef` tracking prior `(status, index)` pair.
- Keyboard `useEffect`: attaches `keydown` on document when `status === 'active'`; maps `n/ArrowRight → next`, `p/ArrowLeft → prev`, `Escape → leave`; guards against input/textarea/contenteditable target; cleans up on status change.

Create `lib/conversations/useDocentWalk.test.tsx` (`.test.tsx` = Chromium browser project — hooks with DOM effects require browser):
```typescript
describe("useDocentWalk", () => {
  it("calls openInNewPane with step href on startWalk");
  it("calls openInNewPane with next step href when next() is called");
  it("does not call openInNewPane when step href is null (broken step)");
  it("calls router.push instead of openInNewPane on mobile");
  it("attaches keydown listener while walk is active; n calls next");
  it("attaches keydown listener while walk is active; p calls prev");
  it("Escape calls leave and removes keydown listener");
  it("does not fire key handlers when focus is inside an input");
});
```

*Verify:* `cd apps/web && bun run typecheck && bun run test:browser -- useDocentWalk`

---

**S2 — HUD: `DocentOverlay.tsx` + `DocentOverlay.module.css` + `DocentOverlay.test.tsx`**

Create `DocentOverlay.tsx`:
```tsx
export default function DocentOverlay({
  walk, onNext, onPrev, onLeave,
}: {
  walk: DocentWalkState;
  onNext: () => void;
  onPrev: () => void;
  onLeave: () => void;
});
```
Renders nothing when `walk.status !== 'active'`. When active: renders the bar (§4.4). Uses `MachineText` unconditionally (`variant="inline" origin={{ label: "Assistant" }}`); machine-hand is a hard prerequisite (P-9). Includes `aria-live="polite"` region.

Create `DocentOverlay.module.css`: sticky, hairline border-top, surface-1 background, pane-inline-padding.

Create `DocentOverlay.test.tsx` (`.test.tsx` = Chromium browser project):
```typescript
describe("DocentOverlay", () => {
  it("renders nothing when walk is idle");
  it("renders step counter and title when active");
  it("shows citing sentence in machine register");
  it("disables prev at index 0");
  it("shows struck-through title and 'Source unavailable' for null-href step");
  it("calls onNext when next button is clicked");
  it("calls onLeave when Leave button is clicked");
  it("has aria-live=polite on the announcement region");
});
```

*Verify:* `cd apps/web && bun run test:browser --reporter=verbose DocentOverlay`

---

**S3 — Wire-up: entry verb + layout slot + Conversation integration**

Modify `AssistantMessage.tsx`: add `onStartWalk?: (citations: CitationOut[], text: string) => void` prop; expand the outer `messageActions` gate from `canBranchFromAssistant || canResendAssistant` to also include `canWalk` (`= !!onStartWalk && message.status === "complete" && (message.citations?.length ?? 0) >= 2`); add inside the div:
```tsx
const canWalk =
  !!onStartWalk &&
  message.status === "complete" &&
  (message.citations?.length ?? 0) >= 2;

// outer gate: {canBranchFromAssistant || canResendAssistant || canWalk ? (
//   <div className={styles.messageActions}>
//     ... existing Fork / Resend buttons ...
{canWalk ? (
  <Button
    variant="ghost"
    size="sm"
    onClick={() => onStartWalk!(message.citations!, conversationMessageText(message))}
    aria-label="Walk the sources"
  >
    Walk
  </Button>
) : null}
```

The Walk button carries no `aria-pressed` attribute — active walk state is indicated solely by the DocentOverlay HUD, not by toggle semantics on the trigger button.

Modify `MessageRow.tsx`: add `onStartWalk?: (citations: CitationOut[], text: string) => void` to `MessageRowProps`; pass to `AssistantMessage`.

Modify `ChatSurface.tsx`: add `docentOverlay?: ReactNode` to `ChatSurfaceProps` (render `{docentOverlay}` before `{composer}` inside `.composerSlot`); add `onStartWalk?: (citations: CitationOut[], text: string) => void` to `ChatSurfaceProps`; forward to each `<MessageRow />`.

Modify `Conversation.tsx`: add `import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport"` and `const isMobile = useIsMobileViewport()`; initialize `useDocentWalk({ openInNewPane, router, isMobile })`; pass `docentOverlay={<DocentOverlay walk={walk} onNext={next} onPrev={prev} onLeave={leave} />}` and `onStartWalk={(citations, text) => startWalk(citations, text)}` to `ChatSurface`.

*Verify:*
```bash
cd apps/web && bun run typecheck && bun run lint
bun run test:unit -- docentWalk
bun run test:browser -- DocentOverlay
```
Then manually: open a conversation with citations, click "Walk", verify pane opens at evidence span, n/p/Escape work, HUD shows correct step and citing sentence, mobile navigation works.

---

**S4 (future) — Oracle/LI extension**

After `oracle-shell-dissolution-hard-cutover.md` lands: wire Walk verb into `OracleReadingPaneBody` (collect `state.passages.map(p => p.citation).filter(Boolean)` as steps; use `passage.exact_snippet` as citingSentence; mount `useDocentWalk` inside the oracle pane component). After LI dossier renders in a workspace pane with `openInNewPane`: thread citations through the LI surface. No state machine change needed — `docentWalk.ts` is already format-agnostic over `CitationOut[]`.

---

## 12. Acceptance criteria (testable)

**AC-1.** A completed assistant message with ≥2 citations shows a "Walk the sources" button in its actions row. An in-progress or errored message does not show it.

**AC-2.** Clicking "Walk the sources" opens (or navigates) a reader pane to the first cited source at the exact evidence span (the `#evidence-{span_id}` hash is present in the pane's href).

**AC-3.** The HUD shows `1 / N · {title}` and the citing sentence (the sentence from the answer that contains `[1]`).

**AC-4.** Pressing `n` advances to step 2; the reader pane navigates to the second citation's evidence span. Pressing `p` retreats to step 1.

**AC-5.** Two steps targeting different evidence spans of the same media file reuse one reader pane (the pane's route key is the same; no second `/media/{id}` pane is opened). Verified by `hasSamePaneRoute` contract.

**AC-6.** Pressing `Escape` while the walk is active ends the walk (HUD unmounts). Reader panes opened during the walk remain open.

**AC-7.** A step with `deep_link === null` shows the step title with `<s>` and "Source unavailable" text. No reader pane is opened for this step. Pressing `n` advances past it.

**AC-8.** After the final step, pressing `n` ends the walk (HUD unmounts, `status: 'complete'`).

**AC-9.** While focus is inside the chat composer input, `n`/`p`/`Escape` do NOT advance/retreat/leave the walk (input guard is active).

**AC-10.** Walk works for oracle reading panes IF `openInNewPane` is available in the pane runtime (gated; not required to pass in S0–S3 — a forward-ref AC for S4).

**AC-11.** On mobile (`window.innerWidth <= 768`), each walk step calls `router.push(href)` instead of `openInNewPane`. The HUD is visible above the composer.

**AC-12.** `bun run typecheck` passes with zero new errors. `bun run lint` passes.

---

## 13. Negative gates (grep-able)

All gates run from `apps/web/` after the cutover is complete.

```bash
# G1: No setTimeout-based autoplay anywhere in the docent
rg "setTimeout" src/lib/conversations/docentWalk.ts src/lib/conversations/useDocentWalk.ts
# expected: no matches

# G2: extractCitingSentence is covered by tests (unit project)
rg "extractCitingSentence" src/lib/conversations/docentWalk.test.ts
# expected: at least 7 matches (one per test case)

# G3: No new API endpoint or fetch call in docentWalk / useDocentWalk / DocentOverlay
rg "apiFetch|fetch\(" src/lib/conversations/docentWalk.ts src/lib/conversations/useDocentWalk.ts src/components/chat/DocentOverlay.tsx
# expected: no matches

# G4: No new resource_edges origin in docentWalk stack
rg "origin.*docent|docent.*origin|resource_edges" src/lib/conversations/docentWalk.ts src/lib/conversations/useDocentWalk.ts
# expected: no matches

# G5: DocentOverlay uses aria-live (AC-12)
rg "aria-live" src/components/chat/DocentOverlay.tsx
# expected: at least 1 match

# G6: Walk entry is gated on >= 2 citations (AC-1)
rg "citations.*length.*2\|>= 2\|>= 2" src/components/chat/AssistantMessage.tsx
# expected: at least 1 match

# G7: No FloatingActionSurface import in DocentOverlay
rg "FloatingActionSurface" src/components/chat/DocentOverlay.tsx
# expected: no matches

# G8 (vitest source-grep — run in docentWalk.test.ts after S0):
# The test file must assert on null-href (deleted source) behavior
rg "null.*href\|href.*null\|unavailable\|Source unavailable" src/lib/conversations/docentWalk.test.ts
# expected: at least 1 match

# G9: DocentOverlay imports MachineText (hard dependency on machine-hand)
rg "MachineText" src/components/chat/DocentOverlay.tsx
# expected: at least 1 match
```

---

## 14. Test plan

### Unit (`.test.ts` — node project)

`lib/conversations/docentWalk.test.ts`:
- `extractCitingSentence`: 7 cases (§11.S0)
- `buildDocentSteps`: 3 cases (ordinal ordering, null deep_link passthrough, empty citations)
- `docentReducer`: 6 transition cases (§11.S0)
- Total: ~16 assertions

### Browser (`.test.tsx` — Chromium project)

`lib/conversations/useDocentWalk.test.tsx`:
- 8 cases (§11.S1): pane-driving effect, mobile vs desktop, keyboard handler, input-guard

`components/chat/DocentOverlay.test.tsx`:
- 8 cases (§11.S2)
- Renders with real React; queries by `role="button"` / `aria-label`; no `vi.mock` of internal modules

### Guards

`rg` assertions in §13 (9 gates, G1–G9). Run as CI lint step or manually post-build.

### Integration (manual, S3)

1. Open a conversation with ≥2 citations.
2. Verify "Walk" button appears in `messageActions` after streaming completes.
3. Click Walk → HUD appears, step 1 opens reader pane to evidence span.
4. Press `n` → step 2 opens/navigates reader pane.
5. Verify same-media steps reuse one pane (count open panes in workspace).
6. Verify broken step (if test data has one): title struck-through, no pane open.
7. Press `Escape` → HUD gone, panes remain.
8. Mobile: verify HUD appears above composer, each step navigates in-pane.

### Backend / E2E

None required. Frontend-only; no new backend contract.

---

## 15. Files (created / modified / deleted)

### Created
- `apps/web/src/lib/conversations/docentWalk.ts`
- `apps/web/src/lib/conversations/docentWalk.test.ts`
- `apps/web/src/lib/conversations/useDocentWalk.ts`
- `apps/web/src/lib/conversations/useDocentWalk.test.tsx`
- `apps/web/src/components/chat/DocentOverlay.tsx`
- `apps/web/src/components/chat/DocentOverlay.module.css`
- `apps/web/src/components/chat/DocentOverlay.test.tsx`

### Modified
- `apps/web/src/components/chat/AssistantMessage.tsx` — `onStartWalk` prop; expanded outer `messageActions` gate (`canWalk`); Walk button
- `apps/web/src/components/chat/MessageRow.tsx` — thread `onStartWalk` prop
- `apps/web/src/components/chat/ChatSurface.tsx` — `docentOverlay?: ReactNode` prop + `onStartWalk?: (citations: CitationOut[], text: string) => void` prop (forwarded to MessageRow)
- `apps/web/src/components/chat/Conversation.tsx` — `useIsMobileViewport` import + `isMobile`; `useDocentWalk` integration; pass `docentOverlay` and `onStartWalk`

### Deleted
None.

---

## 16. Risks

**R-1. Pane deduplication assumption (MEDIUM).** The docent relies on `hasSamePaneRoute` stripping `#` fragments to reuse a reader pane when navigating successive spans in the same media. Verified in `paneIdentity.ts:18-21` and the `open_pane` reducer `store.tsx:134-165`. *Mitigation:* AC-5 verifies this in integration. If deduplication semantics change in a future pane routing refactor, the docent still works (just opens more panes), but the "reuse" property is lost. Add a `store.test.tsx` case asserting fragment-stripped deduplication is preserved (the test file covers `open_pane` behavior at `:176-244`; add a fragment-dedup case there).

**R-2. Marker extraction brittleness (MEDIUM).** Sentence extraction uses a heuristic (split on `. ` / `\n\n`) adequate for AI-generated prose but wrong for: lists with period terminators, code blocks, inline `. ` in URLs. *Mitigation:* Unit tests cover code-fence guard and edge cases (§11.S0); `extractCitingSentence` returns `null` gracefully on failure — the HUD then shows no citing sentence but still shows title and ordinal. No walk step fails because of extraction failure.

**R-3. Walk state leak on pane close (LOW).** If the conversation pane is closed while a walk is active, `useDocentWalk`'s cleanup effects run (keyboard listener removed), but opened reader panes remain open. This is correct — opened panes are real navigation, not temporary state. *Mitigation:* none needed; behavior is intentional.

**R-4. Mobile HUD occludes composer (LOW).** On very small screens the HUD (≈60px) plus the composer reduces the visible scroll area for the transcript. *Mitigation:* HUD is `position: sticky; bottom: 0` only; it does not overlap the transcript — it pushes the composerSlot content down. Tested in DocentOverlay.test.tsx at mobile viewport width (375px).

**R-5. Multi-pane navigation on last step (LOW).** If the user walks all 8 citations of an answer, up to 8 reader panes (or fewer, via deduplication) may open. `MAX_PANES = 12` allows this without error, but the workspace may feel crowded. *Mitigation:* The pane-spam cap at `MAX_PANES` (`store.tsx:168-173`) evicts the oldest non-active pane by insertion order (the non-active pane at the front of the `panes` array) when the cap is hit. Acceptable for an explicit user action that is inherently a "deep dive" workflow.

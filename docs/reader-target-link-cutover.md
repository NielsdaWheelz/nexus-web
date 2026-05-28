# Spec: Reader Target & Deep-Link Contract

## Summary
Replace the URL-as-highlight-state pattern with a three-layer model: canonical URL for address, hash fragment for one-shot deep-link intent, component state for dismissible focus. One primitive hook (`useReaderTarget`) owns the lifecycle. Hard cutover; old `?evidence`/`?fragment`/`?highlight`/`?page`/`?loc`/`?t_start_ms` query consumption is deleted.

---

## Goals

1. **Citations are dismissible.** Esc, click X, click outside, or click the highlight chip removes the focus state without navigating.
2. **URLs are clean.** No transient UI state lands in `?…` query string. `wsv`/`ws` payloads shrink because pane hrefs no longer carry intent params.
3. **Deep-links still survive refresh and shift+click.** Hash fragment carries intent into a freshly-loaded reader; reader consumes once, then scrubs.
4. **Reading progress stays where it belongs.** `reader_media_state` remains the source of truth for "where I was". URL never tracks scroll position.
5. **One mental model across all targeting origins** — citation, TOC jump, search jump, user-highlight click, share link. Same hook, same dismissal UX.
6. **Pane history is meaningful again.** Back/forward steps through *media*, not citation jumps within a media.

## Non-goals

- Not redesigning the workspace pane model. `wsv`/`ws` URL encoding stays exactly as-is — only the *content* of `pane.href` becomes canonical.
- Not redesigning `reader_media_state` resume. Already gold-standard.
- Not introducing sessionStorage / IndexedDB / new client-side storage. All persistence remains server-side.
- Not changing the pulse animation. `nexus:reader-pulse-highlight` event stays; it becomes one of two inputs into the unified target hook.
- Not unifying `evidence_span_id` and `fragment_id` in the backend data model — they remain distinct identifiers; the hook resolves them.
- Not adding cross-device "last focused highlight" memory.

---

## North Star: three-layer separation

| Layer       | What it is                                 | Where it lives                                        | Lifetime                              | Shareable            |
| ----------- | ------------------------------------------ | ----------------------------------------------------- | ------------------------------------- | -------------------- |
| **Address** | Which media you're looking at              | URL path `/media/<id>` (+ `wsv`/`ws` for pane layout) | Until you navigate                    | Yes                  |
| **Intent**  | Where in that media to land on first paint | URL hash `#<kind>-<value>`                            | Consumed once at mount, then scrubbed | Yes (until consumed) |
| **Focus**   | Which target is currently highlighted      | React state via `useReaderTarget`                     | Until dismissed                       | No                   |
| **Resume**  | Where you were last time                   | `reader_media_state` table                            | Across sessions                       | No                   |

Anything that doesn't fit one of these four categories is misplaced and the spec rejects it.

---

## URL contract

### Query params recognized by `/media/[id]`
**None for transient intent.** The reader page accepts no transient query params after cutover. Workspace params (`wsv`, `ws`) are unchanged and unaffected.

### Hash grammar
Single hash. One target per URL. Format:

```
#<kind>-<value>
```

Allowed kinds and value shapes:

| Kind        | Value                   | Semantics                                                           |
| ----------- | ----------------------- | ------------------------------------------------------------------- |
| `evidence`  | UUID                    | Open at the fragment containing this evidence span; focus the span. |
| `fragment`  | UUID                    | Open at this fragment; focus it.                                    |
| `highlight` | UUID                    | Open at the fragment containing this user highlight; focus it.      |
| `page`      | positive integer        | PDF: open at this page; PDF only.                                   |
| `loc`       | section id (path-safe)  | EPUB: open at this section.                                         |
| `t`         | non-negative integer ms | Transcript: scrub to this start time.                               |

Mutually exclusive — only one `#<kind>-<value>` per URL. If multiple, last wins (deterministic).

Hash is **case-sensitive** for values, kind is lowercase. Whitespace not allowed.

Anything not matching the grammar is ignored silently (defensive — no errors for human-typed hashes).

### What the backend emits

`MessageRetrieval.deep_link` shape changes from
```
/media/<media_id>?evidence=<id>&fragment=<id>
```
to
```
/media/<media_id>#evidence-<id>
```

The fragment id is no longer embedded — the reader resolves it from the evidence span server-side. If the evidence span is missing, falls back to `#fragment-<id>` using the locator. If neither, `deep_link` is `null` and the citation renders as label-only.

---

## Target lifecycle (state machine)

```
            ┌─────────┐
            │  idle   │  ← initial; no target focused
            └────┬────┘
        seed     │     dismiss
 (hash/pulse)    │     (Esc/X/outside)
            ┌────▼────┐
            │ pending │  ← target known, reader hasn't mounted the candidate yet
            └────┬────┘
   candidate-found
            ┌────▼────┐
            │ active  │  ← persistent focus class on candidate; pulse animation overlaid
            └────┬────┘
        dismiss  │
            ┌────▼────┐
            │dismissed│  ← terminal until next seed; hash already scrubbed
            └─────────┘
```

Transitions:
- **idle → pending:** hash on mount OR `nexus:reader-pulse-highlight` event received OR explicit `setTarget(...)` call.
- **pending → active:** reader finds candidate DOM node and applies focus class. Hash is scrubbed at this moment (replace, not push).
- **pending → idle:** candidate not found within 2s budget (defensive timeout); silent dismissal.
- **active → dismissed:** Esc, X chip, click outside the candidate, click on the candidate itself.
- **dismissed → pending:** same as idle → pending. The dismissed state is for UX clarity (so we know to not re-trigger pulse for the same target).

Each transition emits no telemetry by default but is testable via the hook's exposed state.

---

## Capability contract: `useReaderTarget`

```ts
// apps/web/src/lib/reader/useReaderTarget.ts

export type ReaderTargetKind =
  | "evidence"
  | "fragment"
  | "highlight"
  | "page"
  | "loc"
  | "t";

export interface ReaderTarget {
  kind: ReaderTargetKind;
  value: string;          // UUID, page number, section id, or ms — kind-specific
  origin: "hash" | "pulse" | "manual";  // who seeded it (for debugging + UX)
}

export interface ReaderTargetState {
  target: ReaderTarget | null;
  status: "idle" | "pending" | "active" | "dismissed";
  setTarget: (target: ReaderTarget) => void;       // imperative seed (manual)
  markActive: () => void;                          // reader calls when candidate found
  clearTarget: () => void;                         // dismiss
}

export function useReaderTarget(mediaId: string): ReaderTargetState;
```

**Behavior:**
- On mount: parse `window.location.hash`. If valid grammar, seed `target` with `origin: "hash"`; status = `pending`.
- Subscribe to `nexus:reader-pulse-highlight`. When event's `mediaId` matches, seed with `origin: "pulse"`; status = `pending`. (Pulse event already carries an in-memory `ReaderPulseTarget`; we translate it to `ReaderTarget`.)
- `markActive()`: status → `active`. If status came from `hash`, call `paneRuntime.router.replace(pathnameWithoutHash)` to scrub. If from `pulse`, hash was never present — no-op.
- `clearTarget()`: status → `dismissed`. Hash already scrubbed. Reader removes focus class.
- `setTarget(...)`: status → `pending` from any prior state. Used for in-pane TOC clicks etc.
- Cleans up on unmount and on `mediaId` change.

The hook is the **only** code path that reads or writes the URL hash. All other components consume `target` reactively.

---

## Data contracts

### Hash encoding helpers (pure)

```ts
// apps/web/src/lib/reader/readerTargetHash.ts

export function parseReaderTargetHash(hash: string): ReaderTarget | null;
export function buildReaderTargetHash(target: ReaderTarget): string;
export function isReaderTargetHash(hash: string): boolean;
```

These functions are pure and live alongside the hook. They have no dependency on React.

### `ReaderSourceTarget` (existing) ↔ `ReaderTarget` (new)

`ReaderSourceTarget` (the rich type passed via `nexus:reader-pulse-highlight`) keeps its existing shape — it has the snippet, label, source_version, etc. that the reader uses to *find* the candidate node.

`ReaderTarget` (the new hook state) is the minimal addressable identity used for hash encoding and lifecycle management.

Mapping function (one direction only — pulse → target):
```ts
function readerTargetFromPulse(t: ReaderSourceTarget): ReaderTarget {
  if (t.evidence_span_id) return { kind: "evidence", value: t.evidence_span_id, origin: "pulse" };
  // locator -> fragment_id is locator-kind dependent; spec-out below
  if (isFragmentLocator(t.locator)) return { kind: "fragment", value: t.locator.fragment_id, origin: "pulse" };
  if (isPdfLocator(t.locator)) return { kind: "page", value: String(t.locator.page), origin: "pulse" };
  ...
}
```

### Backend `deep_link` post-cutover

Computed in `python/nexus/services/retrieval_results.py` (or wherever `MessageRetrieval.deep_link` is built — discoverable, but spec asserts it's a single emission site):

```python
def deep_link_for_retrieval(retrieval: MessageRetrieval) -> str | None:
    if not retrieval.media_id:
        return None
    base = f"/media/{retrieval.media_id}"
    if retrieval.evidence_span_id:
        return f"{base}#evidence-{retrieval.evidence_span_id}"
    if retrieval.locator and retrieval.locator.kind == "fragment":
        return f"{base}#fragment-{retrieval.locator.fragment_id}"
    if retrieval.locator and retrieval.locator.kind == "pdf_page":
        return f"{base}#page-{retrieval.locator.page}"
    if retrieval.locator and retrieval.locator.kind == "transcript_time":
        return f"{base}#t-{retrieval.locator.t_start_ms}"
    return base  # canonical, no intent
```

Same function used for pinned-source `href`, search-result link, share-link generation. **One source of truth.**

---

## Dismissal UX

Three input surfaces, all routed through `clearTarget()`:

1. **Esc key:** while reader pane is focused AND `target.status === "active"`. Pre-empts the focus-mode toggle currently bound to Esc — focus mode keybinding moves to a non-Esc shortcut (e.g., `Shift+Esc` or stays on `Cmd+Shift+F`).
2. **X chip on the focused highlight:** small dismissal pill appears adjacent to the focused span. Persistent (not auto-hiding). Click → `clearTarget()`.
3. **Click outside the focused highlight:** if the click lands on reader content not inside the focused span AND no text is selected (selection-collapse check is preserved from current `handleReaderContentClick`).
4. **Click the focused highlight itself:** toggles off. (Currently a click activates the highlight interaction menu; menu still opens, but clicking the *visual* chip area dismisses.)

Auto-dismiss after N seconds is **not** included by default — explicit UI is preferred per the [[feedback_explicit_ui_over_automation]] convention.

---

## Composition with other systems

### Workspace state (`wsv`/`ws`)
- `pane.href` becomes the canonical resource URL: `/media/<id>`. Hash is *not* persisted into the pane href.
- When the reader seeds from a hash, it consumes the hash and scrubs via `paneRuntime.router.replace(canonicalHref)`. The workspace store sees a `navigate_pane` with `mode: "replace"` and updates its encoded state — no history entry, no URL bloat.
- For shift+click → new pane: `paneLinkNavigation.ts` constructs the pane href as canonical, and passes the hash separately as a one-shot intent. The new pane is created with href `/media/<id>`; the first render of the reader receives the intent via initial-target prop, then scrubs.
  - Implementation note: extend `openInNewPane(href, opts?: { initialTarget?: ReaderTarget })`. The workspace store passes `initialTarget` to the page via React context (`PaneInitialTargetProvider`) or via a transient field on `WorkspacePaneState` that's stripped before URL encoding. **Pick the prop/context route** to avoid bloating the workspace blob.

### Pane history
- `pane.history.back[]` and `forward[]` store only canonical hrefs. A user opening five citations in the same media produces zero history entries (no navigation occurred). Back-arrow goes to the previous *media*, which is what the user expects.
- The `reader-implementation.md` line stating "reader section/TOC/source/highlight jumps that change `?loc`, `?fragment`, `?page`, `?evidence`, or transcript time are pane-local push navigation" is **deleted**. Only explicit navigation (TOC click that swaps fragment, file-level page change, switching media) produces history.

### `reader_media_state` resume
- Unchanged. `useReaderResumeState` continues debounced PUTs.
- Resume restoration runs alongside `useReaderTarget`. Priority on cold-open:
  1. If `target` is seeded (hash or pulse), reader scrolls to target. **Resume is suppressed for this load.**
  2. If no `target`, resume restoration runs as today.
- This matches the existing layered restore order in `reader-implementation.md` but reframed in terms of the new primitive.

### `nexus:reader-pulse-highlight` event
- Stays. Becomes one of two seeding inputs for `useReaderTarget`.
- The pulse *animation* (the 1200ms decoration) stays separate — it's an aesthetic overlay applied via `styles.pulsing`. The persistent `.hl-focused` class is what `useReaderTarget` controls.
- Event payload is unchanged.

### Manual highlight click / TOC click / search jump
- All call `useReaderTarget.setTarget(...)`. Same lifecycle as citation, same dismissal.
- The `useHighlightInteraction` hook (current owner of `.hl-focused` state) is refactored to read from `useReaderTarget` rather than from `useSearchParams`. It no longer reads URL.

### Selection system
- Unchanged. Text selection still suppresses click-outside dismissal (selection-collapse check).

### `useHighlightInteraction` (existing)
- Loses its query-param consumption logic.
- Becomes a thin shim: reads `useReaderTarget().target`, computes which DOM node should have `.hl-focused`, applies/removes class.
- Reports `markActive()` back to the hook once it's applied focus.

---

## Files

### New
- `apps/web/src/lib/reader/useReaderTarget.ts` — the hook.
- `apps/web/src/lib/reader/readerTargetHash.ts` — pure hash encode/decode + grammar guards.
- `apps/web/src/components/reader/ReaderTargetDismissChip.tsx` — the X chip rendered next to the focused span.
- `docs/reader-target-contract.md` — short doc capturing this spec's URL contract section and the state machine, linked from `reader-implementation.md`.

### Modified
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - Delete query-param read block (current lines ~426–433).
  - Replace `useHighlightInteraction` URL coupling with `useReaderTarget` consumption.
  - Wire Esc / outside-click into `clearTarget`.
- `apps/web/src/lib/conversations/readerTarget.ts`
  - `readerTargetFromRetrieval` and `readerTargetFromPinned` keep producing `ReaderSourceTarget` (for the pulse event).
  - Add `hrefFromRetrieval(retrieval)` returning canonical+hash href for shift+click.
  - `hrefFromPinned` updated similarly.
- `apps/web/src/lib/panes/paneLinkNavigation.ts`
  - Shift+click uses `hrefFromRetrieval` (canonical href with hash).
  - Default click path unchanged (still dispatches pulse).
- `apps/web/src/components/ui/ReaderCitation.tsx`
  - `activationTarget` merge logic simplified; `href` is always canonical+hash.
- `apps/web/src/components/chat/MessageRow.tsx`
  - `activateTarget` continues to dispatch pulse. `onReaderSourceActivate` is called with canonical media id only — the parent (workspace) opens/swaps a pane with canonical href.
- `apps/web/src/lib/reader/highlights/useHighlightInteraction.ts` (or wherever `.hl-focused` is managed)
  - Drop `useSearchParams`. Consume `useReaderTarget().target`.
  - Call `markActive()` when focus class applied.
- `apps/web/src/lib/reader/useReaderResumeState.ts`
  - Read `useReaderTarget().status`. Suppress resume restore if status is `pending` or `active`.
- `python/nexus/services/retrieval_results.py` (or the canonical `deep_link` builder)
  - Emit hash-based deep links per the contract above.
- `python/nexus/services/chat_runs.py`
  - If it builds `deep_link` inline anywhere, route through the canonical builder.
- `python/nexus/services/pinned_sources.py`
  - Ditto for pinned-source link generation.
- `docs/reader-implementation.md`
  - Revise the "pane-local push navigation" rule (cited above) to: *"Pane history reflects media-level navigation only. Intra-media targeting (citation jumps, evidence focus, fragment highlights) does not push pane history."*
  - Add cross-reference to `docs/reader-target-contract.md`.

### Code paths deleted (no fallback)
- Every `searchParams.get("evidence")` / `searchParams.get("fragment")` / `searchParams.get("highlight")` / `searchParams.get("page")` / `searchParams.get("loc")` / `searchParams.get("t_start_ms")` / `searchParams.get("t_end_ms")` inside the reader.
- Any logic that writes those params back to the URL on user interaction.
- Conditional branches handling "old-style" deep_link URLs in chat (none should exist after backend cutover).

---

## Backend cutover

Single migration step — no version flagging, no dual-emission:

1. **`deep_link` regenerator.** Either a one-time data migration that rewrites existing `message_retrievals.deep_link` rows to the new format, or accept that pre-cutover messages have stale links (the reader will still open at `/media/<id>` — the hash is just missing, so they land at resume position). Spec preference: **don't backfill** — old citations degrade to "opens at resume position", which is acceptable. Historical messages are not the product.
2. **`deep_link` emitter consolidation.** Confirm one and only one function builds deep_link strings; refactor inline builds into it.
3. **Schema unchanged.** `MessageRetrieval.deep_link` stays `Text | null`. The constraint is at the application layer.

No backend code reads the old URL format, so there's no consumer to migrate.

---

## Acceptance criteria

A reviewer can verify each independently:

1. **No transient query params survive cutover.** Grep for `evidence`, `fragment`, `highlight`, `t_start_ms` in `apps/web/src/app/(authenticated)/media/**` returns zero hits in `useSearchParams` consumers.
2. **Citation default-click produces no URL change** when the citation's media matches the current pane. The pulse animation and focus chip appear; URL stays as the canonical pane URL.
3. **Citation shift+click opens a new pane** with href `/media/<id>` (canonical). The new pane's reader receives the hash on first render, scrolls to the target, displays the focus chip, then scrubs hash. After scrub, `wsv`/`ws` URL is the workspace blob plus path; no `#evidence-…` remains.
4. **Esc dismisses focus.** With a focus chip visible, pressing Esc removes the `.hl-focused` class and the chip. Focus mode keybinding is moved to a non-Esc combination.
5. **X chip dismisses focus.** Clicking the chip removes it.
6. **Outside click dismisses focus.** Clicking on reader text outside the focused span (with no selection) dismisses.
7. **Refresh on a hash URL works.** `/media/<id>#evidence-<id>` refreshed → reader opens, focuses target, scrubs hash. URL after first paint: `/media/<id>`.
8. **Resume still works.** Opening `/media/<id>` (no hash) restores the user's last position from `reader_media_state`. Opening with a hash suppresses resume for that load.
9. **Pane back-button skips citation jumps.** Open media A, click three citations in media A (in-place pulse), then open media B. Back-button returns to media A (one step), not to "media A before citation 3".
10. **Workspace blob shrinks.** Comparing `ws=` base64 length before/after for an identical multi-pane layout, post-cutover length is meaningfully smaller (each pane href is shorter).
11. **Backend emits hash-form deep_links** for all new retrievals. Verifiable via SQL: `SELECT deep_link FROM message_retrievals WHERE created_at > <cutover>` shows only `#`-form URLs (or `null`).
12. **No dual-format parsing.** Reader code has exactly one URL consumer for intent (`useReaderTarget`); it accepts hash only.
13. **Same dismissal model for non-citation focus.** Clicking a TOC entry, a user-created highlight in the rail, or a search result lands the user with a dismissible focus chip — identical UX.

---

## Rules (going forward)

1. **URL query is for address state only.** If a value belongs in the URL, it must be loadable, refreshable, and shareable indefinitely. Anything that becomes stale after the user acts on it does not belong in the query.
2. **URL hash is for one-shot intent.** Reader scrubs it on consumption. No code path writes to the hash after first read.
3. **Component state is for dismissible focus.** Always dismissible by Esc and at least one click affordance.
4. **`reader_media_state` is for resume.** No URL involvement.
5. **One builder for deep_links.** Backend has exactly one function that produces media deep-link strings. New surfaces (search, share, export) call it.
6. **One consumer for reader targeting.** Frontend has exactly one hook (`useReaderTarget`) that owns the focused-target lifecycle. New surfaces (search jump, user highlight click, share link) call it.
7. **Pane history is media-grained.** Sub-media navigation does not push history.

---

## Risks & open questions

- **Hash-based deep-links in email/Slack:** any link auto-unfurler that strips hash will degrade the link to canonical. Acceptable — reader still opens, just doesn't focus. This is the same trade-off as today's `?evidence=` which most unfurlers preserve, but emoji/preview behavior may differ. Worth a one-test verification.
- **Workspace session restore:** when `workspace_sessions` is restored on cold-open of a new tab, the pane's `href` is whatever was last persisted. If a hash was persisted (pre-scrub), the user lands focused on it. This is fine — same lifecycle applies, hash is scrubbed on consumption.
- **The transient `initialTarget` prop for new panes:** if we route it through React context, we need a clean way for the workspace store to attach it to a specific newly-opened pane (keyed by pane id). Acceptable engineering; just an internal API choice.
- **Esc rebinding for focus mode:** users with the current keymap will notice. Document in changelog; the new combo (`Shift+Esc` or `Cmd+Shift+F`-only) should be discoverable via the existing keybindings overlay.
- **PDF page intent (`#page-42`) vs canonical URL with `?page=42`:** the spec moves page intent to hash, which means PDFs shared with "open at page 42" can't be deep-linked via query — only via hash. If any external consumer relies on `?page=` (RSS, syndicated link), that breaks. Spec assumes no external consumers; verify.
- **Transcript time intent (`#t-180000`):** podcast player needs to consume the same hook. Confirm `useReaderTarget` extends cleanly to the audio surface, or scope this spec strictly to the visual reader and follow up for audio.

---

## Scope boundary

In scope: visual reader (web articles, EPUB, PDF, transcript view). The audio player consumes the same hash kind (`#t-`) but the dismissal UX may differ — leave the audio surface to a follow-up unless the implementer finds it trivial to share.

Out of scope: search-result deep-linking format (uses the same backend builder, so it gets the new format for free, but no UX changes are spec'd here for the search results page).
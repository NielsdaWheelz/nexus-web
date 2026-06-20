# Chat Scroll Anchoring Hard Cutover

Status: BUILT - Rev 3 (adversarial review pass)
Author altitude: SME / staff
Date: 2026-06-19
Type: hard cutover - no legacy paths, no dual pin model, no behavior flag.

Built 2026-06-19: the hybrid `PinMode` state machine in
`apps/web/src/components/chat/useChatScroll.ts`, with AC-1..AC-5 driven by
`ChatSurface.test.tsx` (browser project).

Rev 3 (review hardening): a 7-agent adversarial review fixed four issues and
hardened the suite. (1) **HIGH** — a non-moving user gesture at the bottom (e.g.
a wheel-down while already pinned to the bottom) no longer drops the follow:
`onScroll` is now the sole pin-mode authority, and the wheel/touch/key handler
(`beginUserScroll`, formerly `releasePin`) only abandons the programmatic-settle
marker — it never eagerly sets `released`. Before, the eager release fired no
scroll event (already at max, `overscroll-behavior-y: contain`, no rubber-band on
Linux/Windows), so `onScroll` never re-engaged and `↓ Latest` appeared while the
user sat at the bottom. (2) **MEDIUM** — the top→bottom handoff, the `↓ Latest`
mode pick, and the below-fold flag now share one `overflowsBelow(target)`
predicate, so they can no longer disagree; the old `scrollToLatest` used an
assistant-height-only test that mis-picked `top` for tall-question / apparatus
turns, breaking AC-4. (3) **LOW** — first load of an existing conversation opens
in `bottom`-follow (not `released`), so a resumed in-flight run streams into view
and the bottom write is honestly mode-gated. (4) **LOW** — discrete jumps honor
`prefers-reduced-motion` via the shared `preferredScrollBehavior()`. New tests:
gesture-at-bottom-keeps-follow, one-way `top→bottom`-on-shrink, `↓ Latest`
re-engage mid-stream; AC-8 is an explicit `it.todo` (device / e2e). Green:
typecheck / lint / 17 ChatSurface (+1 todo) / 91 sibling chat + adapter browser
tests.

The row-memoization tail (§6.4 / §7 / S2 / AC-7's third clause) is **deferred to
`sota-chat-streaming-hard-cutover.md` (its AC-10)** — it is a no-op until the
adapters stop handing `ChatSurface` per-render row props (see §6.4), and
`docs/rules/cleanliness.md` forbids memos without a measured need. The scroll
behavior — the North Star — ships complete and independent of it.

Supersedes the transcript anchoring *behavior* currently implemented in
`apps/web/src/components/chat/useChatScroll.ts` (boolean pin-to-top only).

Does not supersede:

- `ChatSurface` as the sole transcript scroll owner;
- `useChatScroll` as the single scroll hook (this cutover extends it, it does
  not replace it with a library);
- the eye-line `captureAnchor` / restore contract for branch-switch and
  load-older;
- `docs/cutovers/sota-chat-streaming-hard-cutover.md`, which owns streaming
  *cadence* (coalescing, RAF fold, markdown streaming-tail perf). This cutover
  owns transcript *anchoring behavior* only. They compose; this lands first.

---

## 0. North Star

When the user sends a message, the new question animates to the top of the
viewport and the answer streams in below it (the ChatGPT feel). The moment the
answer grows past the bottom of the viewport, the transcript begins to **follow
the newest streamed text** at the bottom edge, so the user never has to chase
the output. If the user scrolls up to read, following stops instantly and does
not fight them; a "↓ Latest" affordance returns them to live output, and
arriving back at the bottom re-engages following.

This is the **hybrid** model: pin-to-top on send, then stick-to-bottom once the
answer overflows.

---

## 1. SME Thesis

The transcript already implements the hard half of this correctly — it pins the
user's question to the top inset on send and reserves a spacer so short turns
sit at the top. What it is missing is the second half: it never transitions to
following the bottom. For any answer taller than the viewport, the newest text
streams *below the fold* and the user must click "↓ Latest" to see it. That is
the opposite of "follow the text as the agent writes."

The professional move is not to import a scroll library as a parallel owner.
`use-stick-to-bottom` (the primitive under bolt.new and Vercel AI Elements) is
the correct *reference* for the follow algorithm — `ResizeObserver` on growing
content, a near-bottom threshold instead of exact equality, an explicit
user-escape state, instant (not CSS-smooth) writes during streaming — but it
cannot own pin-to-top and it cannot own the eye-line restore that branch-switch
needs. Wrapping it would create a second authority over `scrollTop`.

The move is to **promote the overflow branch that already exists in
`scrollToLatest` into the streaming pin loop**, generalizing the boolean pin
state into a three-state pin mode, and to port the robustness ideas from the
reference primitive into the hook the codebase already owns.

---

## 2. Current Head Facts

### 2.1 Good architecture to keep

- `ChatSurface` (`apps/web/src/components/chat/ChatSurface.tsx`) is the sole
  scroll owner. It wires `onScroll`, and `releasePin` onto wheel/touch/keydown,
  renders the reserved `spacer` as the last transcript child, and renders the
  sticky `↓ Latest` dock from `isLatestBelowFold`.
- `useChatScroll` (`useChatScroll.ts`, 449 lines) already owns: pin to the top
  inset on a new user turn (`useLayoutEffect`, the `isNewTurn` branch), spacer
  sizing (`measureSpacer`), below-fold detection (`measureLatestBelowFold`), the
  single pin-release path discriminating a genuine user gesture from the hook's
  own programmatic scroll (`programmaticTargetRef` + `onScroll`), composer-wheel
  forwarding (`onComposerWheel`), and eye-line capture/restore for branch-switch
  and load-older (`captureAnchor` / `restorePendingAnchor`).
- `scrollToLatest` **already contains the hybrid decision** (`useChatScroll.ts`
  ~`:177-196`): it computes `assistantExceedsViewport` and either pins the user
  turn to the top *or* scrolls to `scrollHeight`. This logic just never runs
  except on a manual "↓ Latest" click.
- CSS (`ChatSurface.module.css`): `.scrollport { overflow-anchor: none;
  overscroll-behavior-y: contain; }`, desktop `scrollbar-gutter: stable`, mobile
  composer honors `env(safe-area-inset-bottom)`. Native scroll anchoring is
  deliberately disabled so the hook owns anchoring.

### 2.2 Gaps this cutover owns

- The streaming follow is missing. While streaming, the `ResizeObserver` calls
  `holdPinned()`, which re-asserts the *question* at the top inset every reflow.
  It never switches to following the bottom, so long answers fall below the fold
  and require a manual "↓ Latest" click.
- Pin state is a single boolean (`pinnedRef`): pinned-to-top or released. There
  is no representation of "following the bottom," so the overflow transition has
  nowhere to live.
- Re-engagement is all-or-nothing. Returning to the bottom after scrolling up
  does not re-arm following; only the "↓ Latest" button does.
- `MessageRow` / `AssistantMessage` are not memoized, so every streamed text
  flush re-renders every row. Tolerable at single-user transcript sizes; the
  memo is deferred to the streaming cutover (§6.4), not owned here.

---

## 3. Hard-Cutover Posture

- One pin model after the cutover: the hybrid state machine. No boolean
  `pinnedRef` survives, no feature flag, no "classic vs new" branch.
- `useChatScroll` remains the single scroll owner. No `use-stick-to-bottom`,
  `react-scroll-to-bottom`, or other scroll library is added as a parallel
  authority over `scrollTop`.
- No per-frame `behavior: "smooth"` follow. Smooth is reserved for discrete
  one-shot jumps (`scrollToLatest`, `scrollToMessage`); streaming follow writes
  are instant and RAF-batched.
- No CSS-only `overflow-anchor` follow. It is dead on Safari/iOS and cannot pull
  the viewport to *new* bottom content; `overflow-anchor: none` stays.

---

## 4. Goals

G1. Send animates the question to the top inset (preserve the current feel).

G2. While the answer streams, once it overflows the viewport the transcript
follows the newest text at the bottom edge automatically — no manual action.

G3. A user scroll-up during streaming stops following immediately and never
fights the user; "↓ Latest" appears.

G4. Returning to within a near-bottom threshold re-engages following; "↓ Latest"
also re-engages and lands in the correct mode.

G5. Short answers that fit keep the question pinned at the top; they never jump
to the bottom.

G6. Branch-switch and load-older eye-line restore is unchanged.

G7. No scroll jitter: the hook's own writes never self-trigger a pin release,
follow writes are RAF-batched, and completed rows have stable identity.

---

## 5. Non-Goals

N1. No change to streaming transport, event grammar, coalescing, or the RAF
fold layer. Those are owned by `sota-chat-streaming-hard-cutover.md`.

N2. No markdown streaming-tail reparse optimization beyond the minimal row
memoization needed for a non-thrashing follow. The deeper `MarkdownMessage`
optimization is owned by the streaming cutover (its AC-10).

N3. No new scroll library dependency.

N4. No virtualization. A single-user transcript renders all rows; virtualization
fights scroll anchoring and forfeits find-in-page/copy-all for no benefit at
this scale.

N5. No change to the composer dock, `↓ Latest` placement, or gutter policy
beyond what the follow requires.

---

## 6. Final Architecture

### 6.1 Pin mode

Replace `pinnedRef: boolean` with a single pin-mode ref:

```ts
type PinMode = "top" | "bottom" | "released";
```

- `top` — the active user turn is held at the top inset; the answer fits or has
  not yet overflowed.
- `bottom` — the transcript follows the newest content at the bottom edge.
- `released` — the user scrolled away; the hook does not move the viewport;
  `↓ Latest` is shown.

It is a single enum, not two booleans, so the modes cannot drift.

### 6.2 Transitions

- **First load of an existing conversation**: set `bottom` and open at the newest
  message. A finished transcript never moves under `bottom`; a resumed in-flight
  run follows into view.
- **On a new user turn** (the `isNewTurn` branch): set `top`, scroll the user
  message to `offsetTop - topInset()`. Unchanged feel.
- **During streaming** (the `ResizeObserver` / per-delta layout path, where
  `holdPin` runs): while in `top`, if the newest content would fall below the
  fold when pinned at the top inset — the single `overflowsBelow(target)`
  predicate — transition `top → bottom`.
- **While `bottom`**: hold `scrollport.scrollTop = maxScrollTop` (clamped),
  instant, coalesced by the RAF-batched delta flush. `↓ Latest` is hidden because
  the newest text is in view.
- **One-way per turn**: `top → bottom` does not bounce back within a turn if the
  answer transiently shrinks. The next send resets to `top`.
- **User scroll-up**: `onScroll` is the sole mode authority, using the
  `programmaticTargetRef` discrimination to ignore the hook's own writes. A
  genuine scroll past `NEAR_BOTTOM_PX` → `released`; show `↓ Latest`. The
  wheel/touch/key handler (`beginUserScroll`) only drops the programmatic marker —
  a gesture that moves nothing (e.g. a wheel already at the bottom) fires no
  scroll event and so never drops the follow.
- **Re-engage**: a genuine scroll that lands within `NEAR_BOTTOM_PX` of the
  bottom returns `released → bottom`. The `↓ Latest` button calls `scrollToLatest`,
  which picks `top` vs `bottom` by the same `overflowsBelow` predicate.

```ts
const NEAR_BOTTOM_PX = 72; // reference: use-stick-to-bottom STICK_TO_BOTTOM_OFFSET_PX
```

### 6.3 Robustness ported from the reference primitive

- **Threshold, not equality.** Near-bottom and re-engage decisions use
  `NEAR_BOTTOM_PX`, never exact `scrollTop === maxScrollTop`. Sub-pixel rounding
  must never unpin on a single new line.
- **Ignore self.** The existing `programmaticTargetRef` guard already prevents
  the hook's own write from being read as a user gesture; the `bottom`-mode
  write reuses it. No new scroll-event source of truth.
- **Instant follow.** Streaming follow uses direct `scrollTop` assignment inside
  the RAF, not `scrollTo({ behavior: "smooth" })` — smooth can never catch
  content that grows every frame.
- **Reduced motion.** Discrete one-shot jumps (`scrollTo`) honor
  `prefers-reduced-motion` via `preferredScrollBehavior()`; the per-frame follow
  is always instant regardless.
- **Escape is sticky.** `released` persists until the user returns to the bottom
  band or sends again; transient reflows do not re-pin.

### 6.4 Row identity (deferred to the streaming cutover)

Memoizing `MessageRow` so a streamed text flush re-renders only the streaming
row is a strict subset of the streaming cutover's AC-10 — and it is **deferred
there**, not done in this cutover. The reducer already preserves object identity
for unchanged rows (`useChatMessageUpdates.flushDeltas` returns the same object
when a row has no delta), and deltas are RAF-batched to one commit per frame, so
a row memo *would* be effective — **except** `ChatSurface` hands every row
per-render props that defeat a shallow `memo` in *every* adapter. The
unconditional defeater is `forkOptions={forkOptionsByParentId[msg.id] ?? []}`:
the `?? []` mints a fresh array for each fork-less row on every render, live even
in the reader path that passes no `onSelectFork`. On top of that sit unstable
callback props (`Conversation.tsx`'s inline `onSelectFork` arrow) and `Set` props
(`retryingAssistantMessageIds`). Stabilizing **all** of those — not just the fork
callback — is adapter / per-run-context work owned by the consolidation and
streaming cutovers (AC-10 must stabilize all four prop families), and
`docs/rules/cleanliness.md` forbids memos without a measured need. The follow
does not jitter at single-user transcript sizes without it.

---

## 7. Files To Change

- `apps/web/src/components/chat/useChatScroll.ts`
  - replace `pinnedRef: boolean` with `pinModeRef: PinMode`;
  - unify the overflow decision into one `overflowsBelow(target)` predicate shared
    by the `top → bottom` streaming handoff (`holdPin`), the `↓ Latest` mode pick
    (`scrollToLatest`), and the below-fold flag;
  - add `bottom`-mode follow (instant, coalesced by the RAF-batched delta flush,
    clamped to max scrollTop);
  - make `onScroll` the sole mode authority (`NEAR_BOTTOM_PX` re-engage / release
    on a genuine scroll); the wheel/touch/key handler `beginUserScroll` only drops
    the programmatic-settle marker, so a non-moving gesture never drops the follow;
  - keep `captureAnchor` / `restorePendingAnchor`, `onComposerWheel`, and the
    `programmaticTargetRef` discrimination intact.
- `apps/web/src/components/chat/MessageRow.tsx` / `AssistantMessage.tsx`
  - no change in this cutover. Row memoization is deferred to the streaming
    cutover (§6.4).
- `apps/web/src/components/chat/ChatSurface.module.css`
  - keep `overflow-anchor: none`; adjust spacer/dock only if the follow needs it.
- Tests:
  - `apps/web/src/__tests__/components/ChatSurface.test.tsx` (browser project) —
    the §9 acceptance behaviors;
  - keep `useChatScroll` covered through `ChatSurface` (test behavior, not the
    hook's internals).

---

## 8. Composition With Existing Systems

- **`sota-chat-streaming-hard-cutover.md`**: that cutover's "verify no scroll
  jitter under high-frequency updates" (§10.3) and "scroll anchoring remains
  stable" (AC-10) now refer to *this* anchoring model. This cutover lands first
  and independently; the streaming cutover then verifies the coalesced cadence
  keeps the follow stable.
- **`docs/modules/chat.md` Scrollport Contract**: extended to state the hybrid
  anchoring behavior; this spec is its implementation owner.
- **`resource-chat-subject-hard-cutover.md`**: independent. Every resource/
  reader/LI chat adapter renders through `ChatSurface`, so they inherit the
  follow with no per-adapter work.
- **Mobile / `visualViewport`**: the keyboard-inset handling stays where it is;
  `bottom`-mode follow must remain correct when the visual viewport shrinks.
  `FloatingActionSurface` keeps its own visual-viewport handling (unchanged).

---

## 9. Acceptance Criteria

AC-1 Send to top. Sending a message animates the new user turn to the top inset.

AC-2 Auto-follow on overflow. While the assistant streams, once the answer
exceeds the viewport the transcript follows the newest text at the bottom edge
with no manual action, and `↓ Latest` is not shown while following.

AC-3 No fight on scroll-up. A user scroll-up during streaming stops following
immediately, the viewport stays where the user put it, and `↓ Latest` appears.

AC-4 Re-engage. Scrolling back to within `NEAR_BOTTOM_PX` re-engages following;
`↓ Latest` re-engages and lands in the correct mode.

AC-5 Short answers stay top. An answer that fits the viewport keeps the question
pinned at the top and never jumps to the bottom.

AC-6 Restore intact. Branch-switch and load-older eye-line restore is unchanged.

AC-7 No jitter. Follow writes are instant (direct `scrollTop`, coalesced by the
ResizeObserver and the already-RAF-batched delta flush — one commit per frame)
and the hook's own writes never trigger a pin release. The "only the streaming
row re-renders per flush" memo is deferred to the streaming cutover (§6.4).

AC-8 Mobile. With the keyboard open, `bottom`-mode follow keeps the newest text
above the composer; `overflow-anchor: none` and mobile gutter policy are kept.

---

## 10. Negative Gates

- No `scrollTop = scrollHeight` (or `scrollTo` to bottom) write that is not
  gated on pin mode `bottom` / near-bottom (the first-load open-at-bottom is in
  `bottom` mode).
- No `behavior: "smooth"` on the per-frame streaming follow path (`holdPin` and
  the ResizeObserver path write `scrollTop` directly). The only smooth site is
  the shared `scrollTo` discrete-jump helper (new-turn / first-load top pins,
  `scrollToLatest`, `scrollToMessage`), which resolves behavior through
  `preferredScrollBehavior()` to honor reduced-motion.
- No boolean `pinnedRef` after the cutover; pin state is the single `PinMode`
  enum.
- No second scroll owner: no scroll library import in `apps/web/src/components/chat/*`.
- No `overflow-anchor` value other than `none` on the scrollport/transcript.

Must remain:

- `ChatSurface` as the sole scroll owner;
- `captureAnchor` / restore eye-line contract;
- the single pin-mode authority (`onScroll`) with programmatic-vs-user
  discrimination;
- `overscroll-behavior-y: contain` and the desktop/mobile gutter policy.

---

## 11. Implementation Sequence

S0. Add the failing `ChatSurface` browser tests for AC-1..AC-7 (drive a fake
streaming message whose height grows past the viewport).

S1. Introduce `PinMode`, replace `pinnedRef`, port `scrollToLatest`'s overflow
branch into the observer path, add `bottom` follow + `NEAR_BOTTOM_PX` re-engage.

S2. (Deferred) Row `React.memo` moves to the streaming cutover (§6.4); it is a
no-op until the adapter callbacks are stabilized there.

S3. Mobile pass (keyboard/`visualViewport`) and the AC-8 check.

S4. Negative-gate greps; update `docs/modules/chat.md`; mark this spec built.

Lands as one branch; main never holds two pin models.

---

## 12. Rejected Alternatives

**Pure stick-to-bottom (always follow the bottom).** Rejected: drops the
pin-to-top feel the product chose; short answers would jump to the bottom.

**Keep pure pin-to-top (status quo).** Rejected: this is the defect — long
answers fall below the fold and require a manual "↓ Latest".

**Adopt `use-stick-to-bottom` wholesale.** Rejected as the owner: it cannot do
pin-to-top or eye-line restore, and it would become a second authority over
`scrollTop`, conflicting with `captureAnchor`. It remains the algorithm
*reference* (threshold, escape, ResizeObserver, instant writes).

**CSS `overflow-anchor` only.** Rejected: unsupported on Safari/iOS, and it
stabilizes content shifts above the anchor — it does not pull the viewport to
*new* bottom content. The hook already disables it on purpose.

**Virtualize the transcript.** Rejected at this scale: fights scroll anchoring
and forfeits find-in-page/copy-all/accessibility for a single-user list.

---

## 13. Done Means

- Send animates the question to the top; the answer streams below.
- Once the answer overflows, the transcript follows the newest text with no
  manual action.
- Scrolling up stops the follow without a fight; `↓ Latest` and the near-bottom
  band re-engage it.
- Short answers stay pinned at the top.
- Branch-switch/load-older restore is intact; no jitter; mobile keyboard safe.
- One pin model, one scroll owner; `docs/modules/chat.md` and negative gates pin
  the final state.

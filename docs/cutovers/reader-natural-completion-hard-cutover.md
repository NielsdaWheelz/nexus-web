# Reader Natural Completion Hard Cutover

Status: BUILT AND VERIFIED — 2026-07-27

Proof: 126 focused browser tests, 4 geometry unit tests, 3 isolated
Consumption integration tests, touched-file lint and strict E2E compile, plus
the production-build real-stack Chromium flow are green. Adversarial review
found no remaining blocker or major.

Type: hard cutover. One final path; no feature flag, legacy listener, fallback
scroll owner, dual completion rule, compatibility prop, or mixed-version support.

No blocking product question remains.

## Decision

A reflowable document is naturally finishable when trusted reader input reaches
the end of its final semantic text unit.

The browser then reports one ordinary canonical locator at the exact text end:
`progression = 1` and `total_progression = 1`. Existing reader-state persistence
and the existing Consumption projection remain authoritative. The browser never
owns a Finished threshold and never sends a second completion command.

Explicit **Mark as finished** remains available. Completion never auto-navigates.

## Goals

- Make every web article naturally finishable at every viewport and font size.
- Apply the same rule to the final EPUB section.
- Keep resume position, engagement high-water, and explicit status in their
  existing owners.
- Put the end state and existing next-item affordance inside the actual scroll
  flow.
- Consolidate reflowable-reader scroll ownership without building a generic
  viewport framework.

## Target behavior

| Situation | Final behavior |
| --- | --- |
| Long article reaches physical bottom | Save an exact terminal locator; Consumption derives `Finished` |
| Short article already fits | Opening does not finish it; trusted forward scroll intent or `End` while the end is visible does |
| Restore, hash jump, layout reflow, or section load lands at bottom | Do not finish without later trusted scroll intent |
| EPUB reaches a non-final section end | Preserve progress; do not finish the book |
| EPUB reaches the final section end | Save the exact document-end locator |
| Terminal save succeeds | Lectern performs one provider-owned revalidation; canonical Finished state may publish the existing next prompt |
| Terminal save fails/conflicts | Keep the existing reader-progress Retry/handoff behavior; do not show optimistic Finished UI |
| Next item exists | Show the existing next-item prompt in the in-flow endcap; open only on selection |
| No next item exists | Show a quiet semantic end label; do not invent an empty action |

## Scope

In scope:

- ready web-article text and the final ready EPUB section;
- one exact text viewport ref and one scroll publication path;
- trusted scroll-intent gating;
- exact terminal-locator capture through `useReaderProgress`;
- provider-owned Lectern revalidation after an acknowledged terminal write;
- an accessible, restrained in-flow endcap;
- focused component/pure tests and one real-stack browser flow;
- deletion of the superseded reflowable scroll/listener paths.

Non-goals:

- PDF, transcript, audio, video, or podcast completion changes;
- changing the canonical `0.95` Consumption policy;
- a new completion-evidence table, command, event, handle, timestamp, or device
  ledger;
- API, DTO, database, migration, worker, or realtime changes;
- continuous EPUB scrolling, automatic section advance, or redesigned EPUB
  navigation;
- guaranteed offline delivery, an outbox, polling, SSE, WebSocket, or
  `IntersectionObserver`;
- changes to explicit completion, Undo, Set Unread, or Reset Progress semantics;
- a generic scroll/visibility subsystem.

Repository standards:

- Follow `docs/rules/cleanliness.md` and `simplicity.md`: one owner, no dead
  listener, speculative option, compatibility path, or hollow abstraction.
- Follow `docs/rules/frontend.md`: derive end/Finished presentation from owned
  state; do not mirror it in another component state machine.
- Follow `docs/rules/timing.md`: name the pixel tolerance; retain existing named
  save schedules.
- Follow `docs/rules/testing.md`: prove the user flow on the real stack and test
  pure geometry only at its owner.

## Product rules

1. The DOM end is evidence; raw percentage is not browser policy.
2. End means both:
   - the viewport is within the named fractional-pixel tolerance of its physical
     bottom; and
   - the rendered end marker intersects that same viewport.
3. Natural completion requires trusted scroll intent after the current content
   generation was positioned.
4. Classify trusted intent as forward or backward. Only forward wheel/touch
   movement, `ArrowDown`, `PageDown`, unshifted `Space`, `End`, or a
   pointer-initiated increase in `scrollTop` arms completion. Both directions
   still cancel a pending restore and count as reader input.
5. A trusted intent must run the end check even when no `scroll` event fires.
   This is the short-document path. Content clicks, link navigation, and
   programmatic scrolls are never scroll intent.
6. Only ready, non-empty content can complete.
7. Final-unit identity comes from canonical order: the last web fragment or the
   last EPUB navigation section. Do not infer it from scroll percentage.
8. Only that final unit at
   `text_offset = canonicalCpLength(activeContent.canonicalText)` can emit exact
   `progression = 1` and `total_progression = 1`. Keep the existing target and
   final quote-context window.
9. The server remains the sole owner of `Finished`; UI waits for canonical
   projection installation.
10. Reaching the end never removes a Lectern row and never navigates.

## Final architecture

```text
trusted viewport intent / viewport scroll
  -> TextDocumentReader (one exact scrollport)
  -> MediaPaneBody end check + canonical text-end locator
  -> useReaderProgress (existing CAS, coalescing, retry, lifecycle save)
  -> PUT /api/media/{id}/reader-state (unchanged)
  -> Consumption transaction
       cursor + reader engagement high-water + completion transition
  -> acknowledged terminal write
  -> LecternProvider.revalidate() (one FIFO-owned GET)
  -> canonical Finished projection
  -> in-flow existing LecternNextPrompt
```

Ownership:

| Concern | Owner |
| --- | --- |
| Scrollport DOM, end marker, trusted viewport events | `TextDocumentReader` |
| Media/final-unit eligibility and locator construction | `MediaPaneBody` |
| Bottom geometry helper and tolerance | `paneTextAnchor.ts` |
| Cursor ordering, CAS, Retry, acknowledgement | `useReaderProgress` |
| Finished policy and completion fact | Consumption service/projection |
| Lectern GET ordering and canonical installation | `LecternProvider` |
| Endcap presentation | existing reader styles and `LecternNextPrompt` |

## Browser capability contract

`TextDocumentReader` receives required exact refs and one required viewport
contract. Do not retain old optional/parallel props.

```text
textViewportRef: RefObject<HTMLDivElement | null>
textEndRef: RefObject<HTMLElement | null>
onViewportReady(snapshot): void
onViewportScroll(snapshot): void
onTrustedScrollIntent(direction: "forward" | "backward"): void
endContent: ReactNode

ReaderViewportSnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}
```

`ReaderViewportSnapshot` replaces the mobile-chrome-named snapshot at the
reader boundary. Mobile chrome consumes it; it does not own it.

`isTextViewportAtEnd(viewport, endMarker)` is a small pure DOM helper:

- use one named `READER_END_TOLERANCE_PX` for fractional scroll rounding;
- require bottom distance `<= 2px`;
- require end-marker/viewport intersection;
- return false for disconnected or zero-content elements.

`MediaPaneBody` owns one per-content-generation boolean:
`hasTrustedForwardTextScrollIntent`. Reset it before media/fragment/section
changes, canonical or remote cursor application, URL/hash positioning, Reset
Progress, and reader-layout reflow. Set it only from a forward intent. Replace
the current directionless `isUserScrollKey` check with this one classifier; do
not keep both.

On scroll or trusted intent, one animation-frame capture:

1. update existing mobile chrome from the same snapshot;
2. capture the ordinary first-visible locator for resume/activity;
3. if eligible and at end, call the existing locator builder with the active
   canonical text length; its one final-unit branch emits both exact `1` values;
4. report a terminal locator once per content generation.

Do not duplicate `0.95` in TypeScript. Do not fabricate a separate completion
payload.

## API and intra-system composition

HTTP and database contracts do not change.

```text
PUT /api/media/{id}/reader-state
{ locator: ReaderResumeState, base_revision: integer >= 0 }
```

The terminal write is a normal `web` or `epub` `ReaderResumeState`. Existing
server behavior atomically:

- conditionally installs the cursor;
- advances reader engagement high-water;
- records the completion transition when the canonical policy crosses;
- returns the authoritative cursor snapshot.

Add one required `onTerminalWriteAcknowledged` callback to the local
`useReaderProgress` options. Invoke it only after a successful/equal terminal
write, never on report, failure, or conflict.

Add `LecternCapability.revalidate(): void`. It queues one forced no-store GET in
the existing FIFO, bypassing the 60-second lifecycle throttle while preserving
install-counter ordering. It owns fetch/error/auth behavior and keeps the last
good snapshot on background failure. Leaves never call `getLectern` directly.

`MediaPaneBody` wires the acknowledgement callback to `lectern.revalidate()`.
There is no completion command after a cursor write.

## UX

- Render the endcap after canonical content and inside `.documentViewport`.
- Use the existing reading column width, generous block-end breathing room,
  safe-area padding, a subtle divider, and subdued type.
- Copy is `End of article` for web and `End of book` for the final EPUB section.
- Keep the endcap stable before and after canonical reconciliation.
- Place the existing `LecternNextPrompt` inside it when canonical state permits.
- Keep **Mark as finished** in the existing resource action menu; do not add a
  duplicate endcap button.
- The viewport is keyboard reachable, has a visible focus treatment, and its
  accessible name identifies the document reading area.
- Respect existing theme, focus mode, reduced-motion, and mobile-chrome rules.

## Hard-cut cleanup

- Replace `TextDocumentReader`'s private viewport ref and separate
  start/update-mobile callbacks with the required contract above.
- Delete `MediaPaneBody`'s second discovered-container scroll listener and fold
  capture into the single viewport publication path.
- Delete the restore-only wheel/touch/key listener; the viewport intent owner
  cancels restore and calls `noteGenuineInput`.
- Use the exact text viewport ref for restore, lifecycle capture, focus, and
  text activity measurement.
- Feed text-activity measurement from the shared viewport publication; remove
  `ReaderActivityAdapter`'s discovered-container text scroll listener. Its
  broader content-interaction eligibility remains a separate domain signal.
- Keep `getPaneScrollContainer` only for generic anchor/highlight callers that
  start from arbitrary descendants; it is no longer a primary text-reader
  progress owner.
- Move the existing next prompt from outside `TextDocumentReader` into the
  endcap.
- Delete superseded props, types, comments, tests, and styles in the same
  change. Add no aliases or compatibility branches.

## Files

Primary implementation:

- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/paneTextAnchor.ts`
- `apps/web/src/app/(authenticated)/media/[id]/ReaderActivityAdapter.ts`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/lib/reader/useReaderProgress.ts`
- `apps/web/src/lib/lectern/LecternProvider.tsx`

Focused tests:

- matching colocated/component tests for the files above;
- `e2e/tests/reader-natural-completion.spec.ts`;
- extend the existing dedicated reader-resume seed only if the current article
  cannot exercise short and long layouts.

Docs updated with implementation:

- `docs/modules/reader-implementation.md`
- `docs/modules/reader-design-rationale.md`
- supersession note in `docs/cutovers/lectern-hard-cutover.md` for its rejection
  of end sentinels and its old out-of-flow next-prompt placement.

Verified unchanged:

- `python/nexus/services/consumption/_policy.py`
- `python/nexus/services/consumption/_projection.py`
- `python/nexus/services/consumption/_reader_engagement_store.py`
- `python/nexus/services/consumption/service.py`
- all API routes, schemas, migrations, and tables.

## Acceptance criteria

1. A real long web article becomes canonically `Finished` after trusted input
   reaches its physical bottom; the persisted locator has both progressions `1`.
2. Large final paragraphs, narrow/mobile panes, large fonts, and safe-area
   padding cannot make completion unreachable.
3. A short or exactly-one-viewport article does not finish on open; a trusted
   forward intent while its end is visible does. Backward intent does not.
4. Restore, remote handoff, hash/evidence navigation, resize, font change, and
   initial render at bottom do not finish without later trusted scroll intent.
5. A non-final EPUB section never finishes the book; the final section follows
   the same terminal rule.
6. Terminal save failure/conflict uses existing Retry/handoff UI and publishes
   no optimistic Finished/next state.
7. After terminal acknowledgement, one provider-owned revalidation installs
   canonical state without polling or a raw leaf GET.
8. The endcap is in the scrollport, keyboard-accessible, themed, and never
   auto-navigates.
9. Explicit Mark Finished, Undo, Set Unread, Reset Progress, resume, mobile
   chrome, and EPUB toolbar navigation retain their existing behavior.
10. Exactly one reflowable scroll listener publishes reader viewport movement;
    no old props/listeners/fallback progress path remains.

## Verification and implementation order

1. Red: add the real-stack web-article flow and focused geometry/coordinator
   cases.
2. Cut viewport ownership and trusted-intent gating.
3. Add terminal locator capture and in-flow endcap.
4. Add acknowledged-write Lectern revalidation.
5. Delete superseded paths and update current docs.
6. Run only focused frontend/component tests, Consumption projection/service
   regressions, the new E2E file, typecheck/lint for touched files, and
   `git diff --check`.

Implementation is complete only when old paths are deleted, acceptance behavior
is proven through public surfaces, and the diff lowers total reader complexity.

# Highlight quick-note composer hard cutover

## Status

Implemented 2026-06-09. Single-user prototype; hard cutover; no flags, no legacy
paths, no backward compatibility.

## Summary

Add a third verb to the selection popover — **Note** — that creates the highlight
and opens an annotation composer in one gesture. The composer is one new owner
component, `HighlightQuickNoteComposer`, that hosts the **existing**
`HighlightNoteEditor` (ProseMirror, debounced autosave, draft persistence) in two
skins: a `FloatingActionSurface` popover anchored at the selection on desktop, and
a `MobileSheet` with a quote header on mobile. The same composer is reachable from
the existing-highlight click popover ("Add note"/"Edit note" action) and from a
reader-local `n` chord while a selection is active. The current backend path is
the highlight-shaped product route `PUT/DELETE /api/highlights/{highlightId}/note`:
notes remain `note_block`s attached to highlights with
`resource_edges(origin='highlight_note')`, written through
`set_highlight_note_body_pm_json` / `delete_highlight_note`, and therefore
indexed, searchable, and chat-citeable like any note.

As part of the cutover, the four duplicated create-then-quote wrappers in
`MediaPaneBody` and `PdfReader` are consolidated: `SelectionPopover` becomes the
single owner of "create the highlight, then run the verb" sequencing.

## SME framing

The 2026 consensus across Kindle, Apple Books, Instapaper, Hypothes.is, and
Readwise (`N` key) is:

1. **Highlight creation is instant and never gated on the note.** Tapping a color
   stays exactly as it is today.
2. **A second verb combines create + annotate.** The note verb commits the
   highlight first; the note is additive metadata. Abandoning the note never
   destroys the highlight.
3. **Desktop = anchored composer with immediate focus; Enter-free autosave; Esc
   closes (saving, not discarding).** Mobile = keyboard-docked bottom sheet with a
   quote header; tap on the verb is the keyboard consent.
4. **One composer, presented in context** — not a second note-editing
   implementation. This repo already has the right composer
   (`HighlightNoteEditor`); the entire feature is presentation + wiring.

This also matches the repo's own doctrine: `docs/modules/reader-design-rationale.md`
names frictionless annotation as the largest retention lever, and
`docs/rules/cleanliness.md` forbids a second mutation path for a capability that
has a canonical owner.

## Problem statement

- A highlight's note can only be edited in the reader sidecar
  (`ReaderHighlightsSurface` → `HighlightNoteEditor`). After creating a highlight
  from the selection popover, annotating requires: open the highlights secondary,
  find the row, tap the note field. On mobile (no ruler, sheet-only secondary)
  this is 3–4 taps and a context switch.
- There is no "create highlight + annotate" affordance at all, and no keyboard
  path to annotation.
- `MediaPaneBody.tsx:5004-5019` and `PdfReader.tsx:2345-2361` each hand-roll the
  same "create yellow highlight, then quote" sequencing — four copies of one
  pattern, about to become six if the note verb copies it again.

## Target behavior

### Desktop

1. User selects text → selection popover (unchanged: color dots, quote verbs) now
   also shows a **Note** button.
2. Clicking **Note** (or pressing `n` with a reader selection active): the
   selection popover is replaced *in place* by the composer — a small anchored
   popover at the selection rect containing the highlight-note editor, focused,
   ready to type. The highlight is created concurrently (default color, same as
   the quote verbs).
3. Typing autosaves (existing debounced session semantics; "Unsaved/Saving/Saved"
   status). Esc, click-outside, or scroll closes the composer; pending edits are
   flushed, never discarded. An empty composer creates no note. The highlight
   survives in all branches.
4. Clicking an existing highlight → the existing action popover now includes
   **Add note** (or **Edit note** when a note exists), opening the same composer
   anchored at the highlight, pre-loaded with the first linked note.

### Mobile

Same verbs, but the composer presents as a `MobileSheet`: quote of the highlighted
text as a one-line clamped header, editor beneath, keyboard-docked via the sheet's
existing inset machinery. The verb tap is the focus consent — the editor is
focused via the sheet's `initialFocus` so the keyboard rises immediately. Swipe,
scrim tap, back button, or Escape dismisses; edits flush.

### All surfaces — finite state machine (explicit, per `docs/rules/control-flow.md`)

1. Verb tapped → composer opens; highlight create starts (or highlight already
   exists for the existing-highlight entry).
2. User types + composer closes → note saved through `saveHighlightNote`; sidecar
   and ruler reflect it (existing `handleNoteSave` slot patching).
3. User closes without typing → no note created; highlight persists.
4. Highlight creation fails → editor save fails with feedback; composer stays open
   (the user's text is never silently lost); dismiss closes it. Drafts persist in
   localStorage under the session key regardless.

## Final architecture

```
selection popover verb ─┐
reader `n` chord ───────┼──► MediaPaneBody / PdfReader entry handlers
existing-highlight ─────┘            │ set QuickNoteSession
  popover action                     ▼
                        HighlightQuickNoteComposer  (ONE owner, always mounted)
                        ├─ desktop: FloatingActionSurface (anchor = rect snapshot)
                        └─ mobile:  MobileSheet (quote header, initialFocus)
                                     │ hosts (unchanged)
                                     ▼
                            HighlightNoteEditor ──► onSave/onDelete =
                            (ProseMirror session,    MediaPaneBody handleNoteSave /
                             drafts, autosave)       handleNoteDelete (existing)
                                                       │
                                                       ▼
                                       saveHighlightNote (lib/highlights/api.ts)
                                       /api/highlights/{highlightId}/note
                                       → set_highlight_note_body_pm_json / delete_highlight_note
```

State lives in `MediaPaneBody` (the pane owns all highlight surfaces; no route, no
pane, no URL change — `docs/architecture.md` §9). `PdfReader` raises its entry via
a new `onAddNote` callback prop, mirroring its quote callbacks.

## Capability contract

### `HighlightQuickNoteComposer` — post-create annotation surface (NEW owner)

Owns: which skin renders (desktop popover vs mobile sheet), the quote header, the
pending-create → save bridging (awaiting the creation promise inside its `onSave`
wrapper), focus into the editor on open, and dismiss wiring.

Does NOT own: note persistence semantics (that is `HighlightNoteEditor` +
`useNoteEditorSession` + `handleNoteSave`, all unchanged), keyboard geometry
(`MobileSheet`/`useKeyboardInset` only), positioning (`FloatingActionSurface`),
highlight creation (the readers' existing `handleCreateHighlight`).

### `SelectionPopover` — create-then-verb sequencer (EXPANDED)

Becomes the single owner of "create the highlight with the default color, then run
the verb with the created highlight". Quote verbs and the note verb stop being
sequenced by each reader. Color taps unchanged.

### `buildHighlightActions` — action source of truth (EXPANDED)

Gains the `note` option. Stays pure: same target/flags/state/handlers → same
descriptors.

### Unchanged owners (load-bearing)

- `HighlightNoteEditor`: not modified. Its `highlightId` prop is treated as an
  opaque session key by the composer (see Key decisions).
- `MobileSheet`: the only bottom sheet, the only keyboard-inset consumer. The
  composer obeys the mount contract (driven by `active`, never conditionally
  mounted).
- `handleNoteSave` / `handleNoteDelete` (`MediaPaneBody.tsx:3041-3075`): the only
  frontend note mutation path; already patch both fragment and PDF highlight
  slots, so the sidecar reflects composer-written notes with no extra wiring.
- Backend: zero changes. No new endpoints, no `note_text` on the create payload —
  the two-phase create-then-link is intentional and stays.

## API design

### Session model (exported from `HighlightQuickNoteComposer.tsx`)

```ts
export type QuickNoteSession =
  | {
      kind: "pending-create";
      sessionId: string;                     // createRandomId(); stable for the session's life
      quote: string;                          // selection text at verb time
      anchorRect: DOMRect;                    // selection rect snapshot
      creation: Promise<{ id: string } | null>; // the in-flight highlight create
    }
  | {
      kind: "existing";
      highlightId: string;
      note: HighlightLinkedNoteBlock | null;  // first linked note, or null
      quote: string;                          // highlight.exact
      anchorRect: DOMRect;
    };
```

### Composer component

```ts
interface HighlightQuickNoteComposerProps {
  session: QuickNoteSession | null;   // null = closed (component stays mounted)
  onClose: () => void;
  onSaveNote: typeof handleNoteSave;  // (highlightId, noteBlockId, createBlockId, bodyPmJson)
  onDeleteNote: typeof handleNoteDelete;
  onOpenLink: (href: string, options: { newPane: boolean }) => void; // same cb the sidecar gets
}
```

Internals: `useIsMobileViewport()` picks the skin. Desktop renders
`FloatingActionSurface` (`anchor={session.anchorRect}`, `placement="below"`,
`flip`, `scrollBehavior="dismiss"`, `role="dialog"`,
`label="Add note to highlight"`) only while `session` is non-null. Mobile renders
`MobileSheet` permanently with `active={Boolean(session) && isMobile}`,
`ariaLabel="Add note to highlight"`, `layer="modal"`, `scrim="soft"`,
`initialFocus` targeting the editor's contenteditable. For `pending-create`
sessions the composer wraps `onSaveNote`:

```ts
const resolved = await rememberedResolution(session.creation); // memoized once
if (!resolved) throw new Error("Highlight was not created");   // → editor shows "Save failed" + feedback
return onSaveNote(resolved.id, noteBlockId, createBlockId, bodyPmJson);
```

The editor receives `highlightId = sessionId` (pending) or the real id (existing),
and is keyed on that value so it never re-keys mid-session.

### `SelectionPopover` (reworked, generic over the created type)

```ts
interface SelectionPopoverProps<H extends { id: string }> {
  selectionRect: DOMRect;
  selectionLineRects?: DOMRect[];
  containerRef: React.RefObject<HTMLElement | null>;
  onCreateHighlight: (color: HighlightColor) => Promise<H | null>; // returns the highlight now
  onQuoteToNewChat?: (highlight: H) => void | Promise<void>;       // receives created highlight
  onQuoteToExtantChat?: (highlight: H) => void | Promise<void>;
  onAddNote?: () => void;        // parent sequences (must open composer synchronously)
  onDismiss: () => void;
  isCreating?: boolean;
}
```

`SelectionPopover` internally sequences the quote verbs:
`const h = await onCreateHighlight(DEFAULT_COLOR); if (h) await onQuoteToNewChat(h);`.
The note verb is a plain callback because the parent must open the composer
synchronously inside the gesture (iOS keyboard) and run the create concurrently.

The current `onCreateHighlight: (color) => void | Promise<void | string | null>`
type is deleted; both readers already return the created highlight internally.

### `buildHighlightActions` (one new option)

```ts
// new flag + handler alongside canQuoteToChat / onQuoteToNewChat
canAddNote: boolean;
handlers.onAddNote: () => void;
```

Option: `id: "note"`, icon `NotebookPen`, label `"Add note"` for selection targets
and existing targets without a note, `"Edit note"` when
`target.highlight.linked_note_blocks` is non-empty. Ordered directly after
`color`. Gated on `canAddNote` (sidecar passes `false` — its editor is already
inline; both popover consumers pass `true`).

### `PdfReader` (one new prop, mirroring the quote props)

```ts
onAddNote?: (session: {
  quote: string;
  anchorRect: DOMRect;
  creation: Promise<{ id: string } | null>;
}) => void;
```

PdfReader's internal `SelectionPopover` wiring passes `onAddNote` only when text
geometry is reliable (same gate as the quote verbs); the handler snapshots the
selection, kicks its internal `handleCreateHighlight(DEFAULT_COLOR)` without
awaiting, and raises the session. `MediaPaneBody` turns it into a
`pending-create` session.

### `MediaPaneBody` (wiring only)

- `const [quickNote, setQuickNote] = useState<QuickNoteSession | null>(null);`
- Text-reader note verb: capture `String(document.getSelection())` and
  `selection.rect`, set the session with `creation: handleCreateHighlight(DEFAULT_COLOR)`
  (not awaited — `handleCreateHighlight` already reads the retained snapshot and
  clears the selection itself), generate `sessionId`.
- Existing-highlight entry (from `HighlightActionPopover`'s new action): set
  `{ kind: "existing", highlightId, note: firstLinkedNote, quote: highlight.exact,
  anchorRect: highlightActionAnchor.rect }`, then `dismissHighlightActions()`.
- Render `<HighlightQuickNoteComposer session={quickNote} onClose={() =>
  setQuickNote(null)} onSaveNote={handleNoteSave} onDeleteNote={handleNoteDelete}
  onOpenLink={…} />` unconditionally (mount contract).

### Chord — `useHighlightNoteChord` (NEW, `lib/highlights/`)

```ts
export function useHighlightNoteChord(args: {
  enabled: boolean;        // a reader text selection is active
  onTrigger: () => void;   // the note verb entry handler
}): void
```

Window `keydown`: fires on bare `n` (no meta/ctrl/alt/shift), guarded by
`isEditableTarget(event.target)` (existing guard, `lib/ui/isEditableTarget`) and
`enabled`; `preventDefault()` when it fires. Used by `MediaPaneBody` (text
readers) and `PdfReader` (its own selection state). Not registered in
`BINDABLE_ACTIONS` — that registry is app-global keybindings dispatched by
WorkspaceHost/palette; this is a context-scoped chord whose dispatch must live
with the selection state, and `captureKeyCombo` cannot even capture bare keys for
rebinding. One owner, hardcoded, documented.

## Files in scope

### Runtime

| File | Change |
|---|---|
| `apps/web/src/components/highlights/HighlightQuickNoteComposer.tsx` | NEW — owner component + `QuickNoteSession` types |
| `apps/web/src/components/highlights/HighlightQuickNoteComposer.module.css` | NEW — quote header clamp, composer panel sizing (geometry only; sheet geometry stays in MobileSheet) |
| `apps/web/src/lib/highlights/useHighlightNoteChord.ts` | NEW — bare-`n` chord hook |
| `apps/web/src/components/SelectionPopover.tsx` | rework: generic created type, owns create-then-quote sequencing, `onAddNote` |
| `apps/web/src/components/highlights/highlightActions.tsx` | `note` option (`canAddNote`, `onAddNote`, dynamic label) |
| `apps/web/src/components/highlights/HighlightActionBar.tsx` | pass-through `canAddNote`/`onAddNote` |
| `apps/web/src/components/highlights/HighlightActionPopover.tsx` | pass-through; composer must be in its dismiss-ignore scope if nested (it is not — composer replaces it) |
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` | session state + entries + chord + composer render; DELETE both create-then-quote wrappers |
| `apps/web/src/components/PdfReader.tsx` | `onAddNote` prop + internal verb + chord; DELETE both create-then-quote wrappers |

### Tests

| File | Change |
|---|---|
| `apps/web/src/components/highlights/HighlightQuickNoteComposer.test.tsx` | NEW (browser project) |
| `apps/web/src/lib/highlights/useHighlightNoteChord.test.tsx` | NEW (browser project) |
| `apps/web/src/__tests__/components/SelectionPopover.test.tsx` | new button + sequencing contract |
| `apps/web/src/components/highlights/highlightActions.test.ts` | `note` option gating/labels |
| `apps/web/src/components/highlights/HighlightActionBar.test.tsx` | menu/bar renders note action |
| `e2e/tests/notes.spec.ts` | extend: select → Note → type → Saved → sidecar + API |

### Documentation

| File | Change |
|---|---|
| `docs/modules/reader-implementation.md` | document the composer as a highlight surface + the `n` chord |

Untouched on purpose: `HighlightNoteEditor.tsx`, `useNoteEditorSession.ts`,
`ReaderHighlightsSurface.tsx`, `MobileSheet.tsx`, all backend code, all
migrations.

## Existing patterns to reuse

- **Dual presentation (desktop layer / mobile sheet)** — `ModelSettingsPopover.tsx:191-212`
  is the template, including the `active={open && isMobile}` mount contract.
- **Content + `initialFocus`/`focusKey`** — palette (`PaletteSheet.tsx`) shows how
  focus is driven into a sheet's input.
- **Anchored ephemeral popover with dismiss-on-scroll** — `HighlightActionPopover.tsx`.
- **Create-then-act** — the quote verbs (being consolidated, not copied).
- **Reader-local chord with editable-target guard** — the Shift+G doc-chat handler
  in `MediaPaneBody` (`isEditableTarget`).
- **Note persistence** — `HighlightNoteEditor` + `handleNoteSave`/`handleNoteDelete`
  + `saveHighlightNote`, verbatim.

## Duplicate patterns being deleted

- 4 hand-rolled `handleCreateHighlight("yellow")`-then-quote wrappers
  (`MediaPaneBody.tsx:5004-5019`, `PdfReader.tsx:2345-2361`) → sequencing moves
  into `SelectionPopover` once.
- The `onCreateHighlight` return-type smell (`Promise<void | string | null>`)
  → `Promise<H | null>`.

## Key decisions

### Decision: a verb, not an unconditional morph

Color taps stay zero-friction (the 90% case); morphing after every create would
force a composer (and on mobile a keyboard) on users who just wanted a highlight.
The combined verb is the SOTA pattern and the only one consistent with the
reader's frictionless-annotation doctrine. The chord (`n`) gives power users the
one-keystroke path (Readwise model).

### Decision: reuse `HighlightNoteEditor` wholesale; its `highlightId` is an opaque key

"Reused, no duplicated" means the actual composer, not a new `<Textarea>`. This
buys autosave, drafts, save-status, empty→delete semantics, the pinned
`textbox "Highlight note"` a11y contract, and the single mutation path for free.
The editor only uses `highlightId` for its draft `resourceKey` and as a
pass-through to `onSave` — so the composer may pass a session id and bridge to the
real id inside its `onSave` wrapper. **Landmine:** never swap the editor's
`highlightId` prop mid-session (when the create resolves); the editor's
`currentResourceKeyRef` guard would cancel in-flight saves and orphan the draft.
The session id is stable for the session's entire life.

### Decision: create concurrently; open the composer synchronously in the gesture

iOS Safari raises the keyboard only for focus initiated by the user gesture.
Awaiting the create (~100–500 ms) before mounting the sheet kills that. So the
verb handler opens the composer immediately and lets the create race the user's
first keystrokes; the save (debounced anyway) awaits the creation promise. This
also makes desktop and mobile one code path. The composer memoizes the promise
resolution so duplicate-create (`E_HIGHLIGHT_CONFLICT` → existing highlight) and
success behave identically.

### Decision: anchor to the selection-rect snapshot, not a highlight DOM lookup

The created highlight occupies the same screen area as the selection; a static
`DOMRect` snapshot works identically for fragment readers and the PDF reader
(whose highlight elements live in a different layer), needs no DOM query, and
matches `FloatingActionSurface`'s existing `DOMRect` anchor mode.
`scrollBehavior="dismiss"` (the `HighlightActionPopover` precedent) handles
staleness: scrolled away = dismissed, edits flushed.

### Decision: Esc and tap-away save, never discard

Apple Books/Zotero semantics for private single-user notes. The editor already
flushes pending saves on blur and on unmount; the composer adds nothing. Empty
content creates no note (existing `highlightNoteBodyHasContent` gate); a
previously-saved note emptied in the composer is deleted (existing semantics).
There is no "discard" affordance and no confirmation dialog.

### Decision: creation failure keeps the composer open

If the create resolves `null` or rejects, the wrapped `onSave` throws → the editor
shows "Save failed" plus feedback (its existing error path). The user's text is
visible and copyable; dismissing closes the composer. No retry machinery — the
highlight verbs already surface their own warnings (mismatch, stale selection).

### Decision: duplicate-highlight + existing note appends a second note block

If the note verb lands on an exact-duplicate span, `handleCreateHighlight` returns
the existing highlight. The composer (mounted with an empty pending session)
saves a **new** note block linked to it. Multiple `note_about` blocks per
highlight are valid in the model and rendered by the sidecar. Merging into the
existing note would require mid-session re-keying (see landmine above) for a
vanishingly rare case.

### Decision: `DEFAULT_COLOR` (yellow), no last-used-color persistence

The quote verbs already create yellow; the note verb matches. A last-used-color
preference is a separate, orthogonal feature (non-goal).

### Decision: the chord is reader-local and hardcoded, not a `BINDABLE_ACTIONS` entry

The keybindings registry is app-global (WorkspaceHost/palette dispatch) and its
capture UI cannot record bare keys. A selection-scoped chord must be dispatched
where the selection state lives. One small hook, two consumers, documented in the
keybindings settings copy if desired later (non-goal).

### Decision: no new dual-presentation primitive

`ModelSettingsPopover` (centered layer) and this composer (anchored popover) share
only the mobile half, which `MobileSheet` already owns. Two consumers with
different desktop shapes do not justify an abstraction (`docs/rules/simplicity.md`).

### Decision: sidecar gets no note action

`ReaderHighlightsSurface` renders the editor inline beneath each row; an action
that opens a second editor for the same note would be a duplicate surface.
`canAddNote: false` there, `true` in both popovers.

## Implementation plan

1. **Slice 1 — sequencing consolidation (pure refactor).** Rework
   `SelectionPopover` props (generic `H`, quote verbs receive the created
   highlight, internal sequencing); delete the four wrappers in `MediaPaneBody`
   and `PdfReader`; update `SelectionPopover.test.tsx`. No behavior change.
2. **Slice 2 — action model.** `buildHighlightActions` `note` option +
   `HighlightActionBar`/`HighlightActionPopover` pass-throughs + tests. Renders
   nowhere yet (handlers not passed).
3. **Slice 3 — composer, desktop.** `HighlightQuickNoteComposer` (+ CSS, types),
   `MediaPaneBody` session state, text-reader note verb, existing-highlight entry.
   Component tests: pending-create save bridging, failure branch, Esc flush,
   dismiss-on-scroll, "Edit note" preload.
4. **Slice 4 — mobile sheet.** Sheet skin, quote header, `initialFocus`, mount
   contract. Tests at 390 px viewport incl. history/back via the MobileSheet
   contract.
5. **Slice 5 — PDF.** `onAddNote` prop, internal verb + gating, session raising.
6. **Slice 6 — chord.** `useHighlightNoteChord` + both consumers + tests.
7. **Slice 7 — e2e + docs.** Extend `notes.spec.ts`; update
   `reader-implementation.md`. Full verify.

Each slice lands green (`cd apps/web && bun run typecheck && bun run lint` + the
unit/browser projects); e2e in slice 7.

## Acceptance criteria

### Functional

- AC-1: Selecting text shows a "Add note" button in the selection popover (both
  readers); activating it creates a highlight (default color) and opens the
  composer with the editor focused; the selection popover is gone.
- AC-2: Typing in the composer and dismissing (Esc / outside / scroll / sheet
  swipe / back button) persists the note: it appears in the sidecar row and in
  `GET /api/fragments/{id}/highlights` `linked_note_blocks`.
- AC-3: Dismissing the composer without typing creates no note; the highlight
  persists.
- AC-4: Clicking an existing highlight → action popover shows "Add note" (no
  note) / "Edit note" (note exists); activating opens the composer pre-loaded
  with the first linked note; edits persist through the same path.
- AC-5: On a 390 px viewport the composer is a bottom sheet with a one-line quote
  header; the keyboard does not occlude the editor (sheet inset machinery);
  browser back dismisses the sheet without navigating.
- AC-6: Pressing `n` with a reader text selection active (and focus not in an
  editable) triggers the note verb; `n` while typing anywhere does nothing.
- AC-7: If highlight creation fails, the composer shows "Save failed" + feedback
  and stays open; the typed draft is still present.
- AC-8: Color taps and both quote verbs behave byte-for-byte as before slice 1
  (existing tests unmodified except for the new prop shape).
- AC-9: A note created via the composer is searchable and citeable (covered by
  existing backend behavior; e2e asserts the note lands as a real `note_block`
  reachable at `/notes/{blockId}`).

### Structural

- AC-10: Exactly one composer implementation: the only ProseMirror note editor
  for highlights is `HighlightNoteEditor`; the composer contains no editor logic,
  no save scheduling, no keyboard-geometry code.
- AC-11: `MediaPaneBody`/`PdfReader` contain zero create-then-quote wrappers;
  `SelectionPopover` is the only create-then-verb sequencer.
- AC-12: The composer is rendered unconditionally and driven by
  `session`/`active` (MobileSheet mount contract).
- AC-13: All note writes flow through `handleNoteSave`/`handleNoteDelete` →
  `saveHighlightNote`/`deleteHighlightNote`. No new fetch call sites for notes.

### Negative invariants (grep gates)

- G-1: `useKeyboardInset` imported only by `MobileSheet.tsx` + tests (unchanged
  ESLint gate stays green).
- G-2: `rg -n "createNoteBlock|updateNoteBlock" apps/web/src --glob '!lib/**'`
  → no hits outside `lib/highlights/api.ts` / `lib/notes/api.ts` (no bypass of
  `saveHighlightNote`).
- G-3: `rg -n "visualViewport" apps/web/src/components/highlights` → no hits.
- G-4: `rg -n "handleCreateHighlight\(\"yellow\"\)" apps/web/src` → no hits
  (sequencing consolidated; the default lives in `SelectionPopover`).
- G-5: `rg -n "addEventListener\(\"keydown\"" apps/web/src/components/highlights`
  → no hits (chord logic only in `useHighlightNoteChord`).

### Verification

- `cd apps/web && bun run typecheck && bun run lint`
- Unit + browser vitest projects green (browser project runs the new `*.test.tsx`
  in real Chromium; highlights `*.test.ts` also run there per the project split).
- `e2e` notes spec green (remember: seeds must index synchronously; run e2e per
  the cleanup-green session notes — whole-repo grep for renamed contracts).
- Manual device pass (deferred, like the mobile-sheet AC-20): iOS Safari keyboard
  rises on the Note verb tap; Android `resizes-content` path.

## Test design details

### `HighlightQuickNoteComposer.test.tsx` (browser project)

- Pending-create: open with a controllable promise; type before it resolves;
  resolve; assert `onSaveNote` called with the real highlight id and the typed
  doc. Assert the editor key never changed (no re-mount: same DOM node).
- Pending-create failure: resolve `null`; assert "Save failed" status renders and
  the typed text is still in the editor; `onClose` not auto-called.
- Existing session: note preloaded; edit → `onSaveNote` with the existing
  `note_block_id`.
- Dismissal: Esc → flush then `onClose`; outside pointerdown likewise; quote
  header text clamped and present on mobile viewport.
- Mobile: 390 px viewport → `role="dialog"` sheet with `aria-label="Add note to
  highlight"`; back-button popstate dismisses once (reuses the MobileSheet
  contract — keep the `active` gate, never conditional mount).
- A11y: editor reachable as `textbox "Highlight note"`; container labeled
  "Add note to highlight".

### `SelectionPopover.test.tsx` additions

- "Add note" button present iff `onAddNote` provided; fires synchronously (no
  await before the callback — assert called in the same tick as the click).
- Quote verb: `onCreateHighlight` resolves a highlight → `onQuoteToNewChat`
  receives that highlight; resolves `null` → quote callback not called.
- Existing pinned contracts (`group "Selection actions"`, placement data
  attribute, preventDefault-inside) unchanged.

### `useHighlightNoteChord.test.tsx`

- `n` with `enabled` → triggers + preventDefault; `n` in a textarea /
  contenteditable → no trigger; `Meta+n`, `N` with shift → no trigger;
  `enabled: false` → no trigger.

### What tests cannot cover

Real iOS keyboard raise timing and the OS text-selection callout interplay —
manual device pass only.

## Non-goals

- Backend changes of any kind (endpoints, schemas, migrations, combined
  create-with-note payload).
- Last-used-color persistence; color choice inside the composer.
- Tags, recent-tags autocomplete, voice input, AI assist inside the composer.
- Multi-note management UI in the composer (first linked note only; the sidecar
  remains the multi-note surface).
- Rebindable/contextual keybinding registry work; palette exposure of the verb.
- A shared "desktop popover / mobile sheet" primitive.
- Changes to `AssistantSelectionPopover` (chat selection quoting) or the notes
  pages/outline editors.
- Comment-first semantics (highlight is never contingent on the note).

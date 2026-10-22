# note input rerenders its whole outline session

status: open · origin: owner source audit, 2026-10-21 · area: notes outline and text owner (`lib/notes/useOutlineSession.ts`, `lib/notes/texts.ts`)

problem: every ordinary note edit replaces the child-action array with a newly
filtered one, even when no child action exists or changes. its external-store
subscription rerenders the session-owning surface, so outline projection and filter
work run on each keystroke. the text owner also notifies every text subscriber and
advances the workspace title revision on each value and timer update (two per
keystroke), and each notification makes the unsaved-work guard compare loaded texts.

evidence (source at `2e154f053`; no profile taken):
- `apps/web/src/lib/notes/useOutlineSession.ts:2733-2735` (`editBody`) always calls
  `actions.set(prior => prior.filter(...))`; `lib/resourceGraph/useResourceDraft.ts:29-36,60`
  notifies and publishes the new array through `useSyncExternalStore`.
- `lib/notes/useOutline.ts:420-428` projects rows on each render, and
  `components/notes/OutlineEditor.tsx:50-52` serializes their filter fields.
- `lib/notes/texts.ts:97-107`: `update` calls `notifyTexts`, which bumps
  `titleRevision` and calls every listener; `editText` (`:172-197`) updates the value
  and then the save timer (`schedule`, `:407-416`). `lib/workspace/presentations.tsx:142,238-248`
  rerenders and reruns its pane-title effect on each bump.
- every notification refreshes the guard (`lib/unsavedWork.tsx:57-58,90`); the writing
  owner (`texts.ts:387-388`) runs `hasUnsavedText` over loaded texts until one is dirty,
  and `sameBody` key-sorts and serializes both bodies (`lib/notes/noteBody.ts:239-246`).

impact: input work grows with the loaded outline and open texts instead of staying
local to the edited note and its visible peers. a performance hazard by source, not a
measured frame-time regression.

fix: change child-action state only when an action is actually cancelled; subscribe by
note identity; publish title changes only when a projected title or status changes; let
the guard read a maintained dirty count instead of rescanning texts. keep prose editing
outside unrelated outline and workspace render paths while preserving same-note peer
updates, history and composition.

resolved when a browser profile shows ordinary typing with no child actions does not
rerender unrelated outline rows or workspace titles, and per-keystroke work does not
grow with loaded texts; composition, same-note peer editing, structural undo and
pending-child cancellation still work.

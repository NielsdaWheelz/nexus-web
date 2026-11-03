# a held soft-keyboard backspace is not fenced at an item boundary

problem: touch boundary deletion is enabled: `structuralInput`
(`apps/web/src/components/notes/NoteEditor.tsx`) joins at an item's start and
removes an empty item from `beforeinput` with no pointer check. its fence for a held
deletion keys on `event.repeat`, which only a keydown carries (`handleKeyDown`'s
boundary arm). gboard and other soft keyboards repeat a held backspace as
`beforeinput` `deleteContentBackward` events, often without a keydown, so each
repeat reaches `structuralInput`: it can empty an item, remove it, then join or
delete into the item above. `removalFence` (`outlineController.ts`) arms only from
a keydown backspace or delete.

impact: on a phone a held backspace can cross item boundaries; the item above can
lose text. the earlier coarse-pointer guard that disabled touch boundary deletion
for exactly this hazard is gone, so the hazard is live and unfenced.

evidence: the adversary review of the outline engine (finding 10) by source
reading; the held-deletion journey is proven only through chromium keydown repeats
(case `outline-engine-11-held-backspace`, green in run
`20261102-102922-ba2c2cc0301b`). no soft keyboard has run it.

candidate fix: arm the removal fence from a boundary `beforeinput` delete as well
as from keydown, and release it on a timer when no keyup can arrive. keep a fresh
press able to join or remove; do not restore a blanket touch guard.

resolved when, on an owned emulator with gboard, a held backspace empties an item,
stops at its boundary and leaves the item above intact, while a fresh backspace at
the start still joins, with undo and the caret intact.

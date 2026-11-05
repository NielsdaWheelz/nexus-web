# internal annotation opening can take newer focus

remaining scope after the selection annotation icon change: the dock uses a
validated external request; other hosts retain the internal blank text opener.

`apps/web/src/components/notes/HighlightAnnotation.tsx:236` sets `asked` when its
document is cold. the effect at `:106` calls `begin()` after opening; `:100`
captures interaction generation at that later time. it does not retain the
original invoker's focus claim. `lib/ui/overlay.ts:531–535` tracks overlay
transitions, not ordinary movement between fields.

the same internal path was reproduced at `b115cbce7` in a disposable chromium
reader: pause the real authored worker, activate the original dock text opener,
type in the question, then release its exact document reply; annotation takes
focus. the dock no longer uses this path. delayed internal opening in retained
non-dock hosts remains unqualified.

capture internal activation intent before document opening and retire it when
focus moves, at the annotation owner using existing primitives. preserve drafts,
preview activation and undo; no new focus controller or product delay seam.

resolved when a delayed real document open through a retained internal blank
opener preserves later field input/focus, and a subsequent valid activation
still focuses its editor.

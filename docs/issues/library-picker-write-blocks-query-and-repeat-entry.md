# library writes block query editing and repeated entry

status: open · origin: 2026-10-14 library picker design audit · area: web / libraries

problem: the picker cannot sustain type, arrows, enter, type again. ordinary selection retains the previous query; persisted membership changes additionally make search read-only through a write and reread.

evidence: `apps/web/src/components/libraries/LibraryDestinationPicker.tsx:138-158` clears query after create only, not toggle. `LibraryEntryEditor.tsx:192-195` also leaves query after toggle. `LibraryPlacementOverlay.tsx:146-168,205-210` holds a single pending slot through the mutation and full membership read; `LibraryChooser.tsx:134-150,283` rejects every activation and marks search read-only while busy. source trace only.

prerequisites: settle the repeated-entry contract and share placement command ownership with imports; preserve inherited/default-library rules and uncertain-write recovery.

fix: keep query and navigation independent from mutation admission. after accepted activation, clear the query and retain search focus. scope pending feedback and conflict blocking to the affected command; any queued work must carry an explicit desired membership rather than a replayable toggle.

tradeoff: repeated searches become immediate, but repeating the same filter requires retyping. preserving the query should not be an undocumented mode.

acceptance: under a delayed write/reread, typing and navigation remain available and independent intended edits remain ordered; failure is visible without stealing current focus or changing the newer query.

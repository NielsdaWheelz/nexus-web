# text highlight acknowledgment clears a later selection

- status: open
- origin: 2026-09-14 bounded reader residency review
- area: hosted text highlight creation

`MediaPaneBody.tsx:3474` and the equal-span recovery branch call `clearReaderSelection()` after awaited writes/reads without comparing the retained selection with the initiating selection. that function clears retained state and any browser range inside this reader. a newer selection in the same live reader can therefore be cleared by an older completion. the pdf owner already fences this case; the text owner still uses `selectionRetiring` to defer unlocking until selection becomes null.

prerequisite: reproduce through the actual text reader with a held create response and a later browser selection. fence local selection cleanup by the initiating selection and exact mutation owner; retire the completed write independently of clearing selection. preserve committed acknowledgment and ordinary duplicate suppression.

acceptance: the new selection survives old success and duplicate recovery; subsequent highlighting works, and ordinary completion clears only its own selection. demonstrate the real faulty completion before closing.

actual body red: `daa5328e13af4bc2` issued a held create for `Home`, captured `source`, then released the original response. the named oracle failed: `earlier highlight acknowledgment erased the newer selection: expected '' to be 'source'`. the same body now fences retirement by captured range and completes its write lock independently; `2c6a1454d84289e1` and `f1cefb10b390759f` pass ordinary completion and the next write. the duplicate recovery variant and final sensitivity remain pending.

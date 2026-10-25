# mobile inspector menu closes itself

problem: on a phone-width viewport, the inspector sheet's own resource menu
(the "more actions for {title}" trigger in the companion sheet header) closes
without input a few seconds after opening. the menu is ready, lists its verbs,
and then disappears while the user is still reading it.

impact: a slow reader loses the menu mid-choice and must reopen it; any
assertion of what the menu offers races its own retirement.

evidence: lab runs at main `4a5b1c710` and on branch `fork-gesture-pane-noun`,
390×844 touch viewport, epub media pane: open header more → "Inspector" → the
sheet's own more. with no further input, `page.getByRole("dialog")` counted 2
(the sheet and the menu) at +1 s and +4 s, and 1 (the sheet only) at +10 s.
the desktop header menu, opened the same way, stayed open for the whole case.
cause unknown: candidates are a menu publication retirement when the
subject's facts refresh (`components/ui/ActionMenu.tsx` retirement on
subject/meaning change), or the mobile chrome or sheet dismissing on a focus
or geometry change.

resolved when the sheet's menu, opened on a settled epub pane at 390×844,
stays open with no input for at least 30 s, and closes only on choice,
escape, outside tap or a real subject change.

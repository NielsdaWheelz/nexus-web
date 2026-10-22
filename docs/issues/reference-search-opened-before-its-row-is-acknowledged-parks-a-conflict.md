# `@` in a row whose creation is unanswered parks a false conflict on Escape

status: open · origin: notes re-slice second review fixes, harness outline/O21 and O21b,
2026-10-21 · area: notes outline (`lib/resourceGraph/useReferenceInput.ts` `begin`,
`lib/notes/texts.ts` `editText`)

`@` records the row's acknowledged body as the reference search's base. in a row whose
own insert is still unanswered there is none, so the base holds `acknowledged: null`.
if the insert's reply then acknowledges the row (empty, version 1) while the search is
open, Escape hands the literal text to `editText` with that base; `editText` sees an
acknowledgement where the base had none and parks it as a change made elsewhere.

impact: the literal "@heath" stays in the row unsaved, under "this note changed
elsewhere" with "keep mine" / "use saved" against an empty saved body that this tab
created. "keep mine" saves it; leaving first asks (the unsaved-work guard counts the
conflict). nothing is lost silently, but the person is told of an edit nobody made.

evidence: outline/O21 (Enter, `@heath`, Escape) failed in two cycles while the host's
load was high: the
screenshot shows the conflict with saved "(empty)", and the api log for that page has
the row's insert and no body save and no 409, so the tab parked it. it passed in every
earlier cycle (engine at 6 cpus); with the engine at 4 cpus it failed 4 of 20 on the tip at
host load 11 to 18 with no synthetic load. outline/O21b holds the
row's insert until the search is open, then lets it land before Escape: 20 of 20 show the
conflict on the tip (an xfail on every tree). `begin` and `editText` are main's
(`b4721d528`), unchanged by the re-slice, so main has it.

likely fix (idk): a base taken before the row's creation was acknowledged takes that
first acknowledgement as its own (version 1 is this tab's creation), not as a change
elsewhere.

resolved when: outline/O21b passes, and outline/O21 stays green in cycles at high load.

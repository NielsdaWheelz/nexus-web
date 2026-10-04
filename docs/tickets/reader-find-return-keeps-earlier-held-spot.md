# reader find return keeps an earlier held spot

status: open; needs a decision · origin: 2026-10-04 one-find slice, isolated find harness (baseline defect 3) · area: reader navigation / find

after any reader exploration that holds a reading spot (a contents jump, a
source link), find's first preview does not replace that spot, so the reader's
"back to your spot" returns to the place before the earlier jump, not to where
find started. the pane-find spec (j9) says the reader records the origin on
find's first preview.

evidence: harness baseline (`W`: held 3302 vs find start 2736; `E`: label
"reading spot held · Chapter One" while find started in Chapter Three). the
cause is the navigation owner, not find:
`apps/web/src/lib/reader/useReaderNavigation.ts` `begin()` keeps
`previous.mode` while already `Exploring`, so every inspect after the first
shares the first origin. find only calls `inspect` (`media/[id]/mediaFind.ts`,
`components/pdfFind.ts`). the harness's `W.J9.reader-return` adopts the place
("continue reading here") before find to pin find's own origin.

prerequisite: decide which spot "back to your spot" means after a jump then a
find: the place before the first exploration (today), or where the latest
deliberate exploration (find opening) began. the second needs the navigation
owner to accept a caller-declared new origin; find must not adopt or save
progress itself.

acceptance: per the decision, a contents jump, then find, preview and close,
then "back to your spot" lands where the spec says, on web and epub.

# section navigation does nothing at the very top of a web article

status: open, fixed by reader pr2 · origin: 2026-10-04 cleanup campaign (claude coordinator), reader harness baseline · area: web reader (hosted pane)

## what is wrong

at scroll 0, "Next section" and picking the first section from the bar do nothing; the bar stays on the article title. after any scroll both work. pinned as xfail `R.W.J5.section-nav-from-start` (also seen by the find harness).

## fix

resolve the current section from the reading anchor even at offset 0 (pr2's navigator). see `reader-pr2-replace-hosted-pane.md`.

## acceptance

the pinned journey passes on the hosted pane.

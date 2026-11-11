# search screen-reader acceptance

status: open; owner explicitly deferred manual qualification on 2026-10-21.

compact-palette acceptance separately requires actual spoken qualification. the owner explicitly deferred that observation on 2026-10-28;
it remains unverified, not passed. headless checks do not establish speech.

[search](../modules/search.md) requires a manual screen-reader check. source review
and browser assertions cover one polite atomic search live region per active
surface, visible progress and focus restoration; they cannot prove the spoken
sequence. desktop launcher, mobile launcher and full search remain unqualified
with an actual screen reader.

check delayed lexical/hybrid delivery, held updates, retry, settled empty results
and refresh with voiceover. verify one coherent announcement, no hidden-surface
announcements, usable successful rows and query focus after refresh. resolved
when an operator records those actual observations. no product change or
permanent test harness is required merely to complete this check.

for the compact palette, also check default/import, a multiline note, unavailable
primary with usable options and use-text return. spoken identity must agree with
visible content and activation without repeating the primary as evidence.
desktop access needs the specific approval required by
`docs/local-rules/testing-standards.md`; browser names and focus assertions cannot
substitute for this observation.

also verify automatic candidate speech while editing/browsing, and clearing
`aria-activedescendant` when a query replacement or hidden results removes the
candidate. source-level live regions and active-descendant cleanup alone do not
establish actual spoken output.

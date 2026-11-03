# the Today place never latches or gains frecency

status: open · origin: 2026-11-02 palette s1 · area: web / nexus ranking

`quick note` opens today's page, so its learning identity (law 10) is the
date-free `/daily` (`rows.ts` `learnedHref`; `remember` posts the same for every
`OpenDailyPage` dispatch). the `open today` place leads to the same page. two
rows under one identity would both be admitted as `Latched` and tie down to the
key, where `Destination:today` beats `QuickAction:Nexus.Quick.Note`: a user who
chose `quick note` twice under `n` would find `open today` armed. so the place
carries `href: null` and `learns_selection: false` (`rows.ts` `placeHref`).

impact: choosing `open today` twice under a typed string never arms it by latch,
and it never accrues frecency; `today` and `tod` still reach it by name.

fix: give the two targets distinct identities the server stores (an
`OpenDailyPage` entry form for `AppendNote`, or a second canonical path), then
let the place learn under `/daily`.

resolved when choosing `open today` twice under `to` arms it on the third `to`
while `quick note` chosen twice under `n` still arms `quick note`.

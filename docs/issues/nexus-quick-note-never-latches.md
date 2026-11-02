# quick note and today never latch or gain frecency

status: open · origin: 2026-11-02 palette s1 · area: web / nexus ranking

`remember` posts the materialized href (`useNexusController.ts` `run`), which
for an `OpenDailyPage` target is `/daily/<local date>`: a different key every
day. the `quick note` command row and the `Today` place carry `href: null`
(`rows.ts` `commandRow`, `placeRow` has `/daily`), so `latchedHref` and
`frecency` never match them. the contract's trade-off "commands latch, so `n`
can outrank a resource until picked" holds for `new chat` (`/conversations/new`)
and `new page` only.

impact: the most-used command cannot be learned; `n` under a typed string never
arms `quick note` by latch.

fix: post and key on a date-free identity for Today (`/daily`) in both
`remember` and the server's record, or give `OpenDailyPage` rows `href:
"/daily"` and post that for learning while dispatching the dated href.

resolved when choosing `quick note` twice under `n` arms it on the third `n`.

# pane return closes the inspector

status: open.
origin: 2026-11-01 connections-scroll lab, case a6.
area: workspace pane history.

problem: a reader pane with its inspector (connections) open, which follows a link to a note and
then goes back, returns to the media with the inspector closed. `moveTo` in
`apps/web/src/lib/workspace/model.ts:64-77` keeps `secondary` only within one resource, so the
move to `/notes/<id>` drops it, and the back visit restores the media without it. the
connections pane's visit memento (`Reader.Connections`, its anchor and memory) survives, but
nothing renders it until the reader reopens the inspector.

impact: the connections-scroll contract's pane return ("exact row and offset") needs a manual
inspector click on every return; a reader who does not reopen it sees no connections. the model
comment says the drop is intended for resource changes; whether a history return should restore
the inspector it left with is the owner's call.

evidence: a6 on main `61562d112`, desktop chromium and stock firefox, both books, both speeds:
8 of 8 returns came back with `closed: true`; after one inspector click the anchor row and offset
matched exactly (a6 anchor rows pass). reproduced on 2026-11-02 in the suite's baseline (`main2`, same
build): 8 of 8 returns, each through the pane's `Go back in this pane`, reopened with the inspector closed.

reproduce: desktop, open a book, open the inspector's connections, click a linked note's
`/notes/<id>` link, press `Go back in this pane`.

resolved when: a back (or forward) visit restores the inspector it left with, or the contract
states that it does not and a6 drops its reopen step by decision.

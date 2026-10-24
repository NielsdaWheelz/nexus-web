# a quick note sent before today's draft saves makes the same tab say "saved in another tab"

status: open · origin: notes re-slice harness (pages/P0b; spec L9's remainder), 2026-10-21;
fixed only by the dropped web engine (P2) · area: notes pages (`lib/notes/useOutline.ts`)

with today latent (no items), the open day proposes a page id for its draft. if a launcher
or share capture is sent from the same tab before the draft's first save, the capture binds
today to the page the server makes for it. the draft's first save then still targets its
proposed page, the server answers 409 with `current_page_ref`, and the tab reports a
conflict with itself. P1 (#734) fixed the other order (the draft's save already queued: the
capture waits behind it in the FIFO).

impact: "this day was saved in another tab · save to this day" after a capture this tab
made; the draft's text waits until the person presses "save to this day". nothing is lost.

evidence (main `c0063b28e`):
- `lib/notes/useOutline.ts:140-157`: the draft's creator always inserts at its proposed
  page (`daily_page` source with `proposed.page`, links version 1).
- `lib/notes/useOutline.ts:160-173`: a 409 with `current_page_ref` becomes `dailyConflict`.
- `app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:121` renders the notice.
- `lib/notes/api.ts:47-59` (`captureToday`) learns the day's page id and only publishes
  `Notes`; the open day's `boundDailyPage` (`useOutline.ts:74`) is not told, and the
  creator's request ignores it anyway.
- pages/P0b is an xfail on main and on P1 (#734).

repro: open today with no items; type in the draft row and, within 1.5 s, send a launcher
`/n` quick note.

starting point: P2 (`88acbbf1e`) remembered each day's page in the tab (daily reads,
captures, first items: `api.bindDay`/`boundDay`) and retargeted a latent draft's first
save to it at send.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: pages/P0b passes (one page holds both items, no notice).

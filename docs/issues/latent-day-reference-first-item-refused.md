# a reference as a latent day's first item publishes the day, then its link is refused

status: open · origin: notes re-slice harness (overlay/O-9c), 2026-10-21; fixed only by the
dropped web engine (P2) · area: notes pages and outline (`lib/notes/useOutlineSession.ts`)

on a day with no items yet (latent), typing `@` in its draft row and picking a resource
publishes the day and an empty draft note, then the request that carries the link is
refused 409.

impact: the day exists with one empty row and no link; the tab shows "this change was
refused. your drafts are kept." and "that change couldn’t be saved". a split or a paste as
the first item publishes the day correctly (overlay/O-9a, O-9b).

evidence (main `c0063b28e`), mechanism afaict:
- `components/notes/CanonicalNoteEditor.tsx:88-96`: the latent draft's `@` passes both the
  day's `publication` and a `creator` for the unacknowledged draft.
- `lib/notes/useOutlineSession.ts:2199-2220`: `admitAction` first materializes the draft
  through its creator, which publishes the day (`insert_note` 200).
- `lib/notes/useOutlineSession.ts:2238-2240`: the reference batch still prepends the
  publication (`ensure_daily` + the draft's `insert_note`, `publicationEdits` `:941-958`) at
  links version 1, though the lane has moved; the batch answers 409. which command the
  server refuses is unproven.
- overlay/O-9c is an xfail on main and on P1 (#734): `insert_note` 200, then
  `ensure_daily+insert_note+insert_link` 409.

repro: open a future day with no items; in its draft row type `@` and a query, pick a
resource.

starting point: P2 (`88acbbf1e`) kept one latent-day shape: the day's first structure
write (a split, paste or `@`) carries the publication once, and the day stops being latent
when its draft's creation is acknowledged, so nothing sends it twice.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: overlay/O-9c passes (the day holds the resource link as its first item, no
refusal).

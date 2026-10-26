# a command sent before the previous insert is acknowledged is refused

two observed forms share one mechanism: a write built while an insert is in flight
carries the links version from before that insert, and the server answers 409.

## structural move after a fresh row

origin: 2026-10-25 outline touch accessory lab (case c7), base `a09557224`.
on a page item's title, enter, type, then move the item at once (the bar's
"move item down", or ⌘⇧↓ in item text). the trace shows `insert_note` succeeding
at links version 3, then the move sent with `expected_links_version: 3` and
answered `409 E_RESOURCE_CONFLICT "Outline version changed"`. the tab shows
"this change was refused. your drafts are kept." and the order reverts. with the
insert acknowledged first, the move succeeds. keyboard users reach this faster
than bar users. key repeats do not execute structural commands partly for this
reason (held chords would hit it every time).

## `@` right after Enter makes a row whose resource link is refused

status: open · origin: notes re-slice harness (outline/O31, overlay/O-7f, consumers/Q4h;
defect D5), 2026-10-21; fixed only by the dropped web engine (P2) · area: notes outline
(`lib/notes/useOutlineSession.ts`, `components/notes/CanonicalNoteEditor.tsx`)

Enter creates a row; typing `@` in it at once, before the row's insert is acknowledged,
opens the reference search with that row's slot already captured. picking a resource sends
`insert_link` with the links version the page had before the row's insert, and the server
answers 409.

impact: the link is not made. the tab shows "this change was refused. your drafts are
kept." and "that change couldn’t be saved". the same happens to a reference picked in a row
put after a long page's last loaded row (overlay/O-7f), and it keeps consumers/Q4h (a
reference retried after an answered 500) from being exercised on main. with the row's
creation acknowledged before `@` (outline/O20) it links.

evidence (main `c0063b28e`), mechanism afaict:
- `lib/notes/useOutlineSession.ts:1968-1981`: `position` answers the slot after a row from
  the local graph with the graph's current `links_version`. the admitted row is already in
  the graph, so a slot after an unacknowledged row gets the pre-insert version; the pending
  proof branch (`:1983-1988`) is never reached.
- `components/notes/CanonicalNoteEditor.tsx:78-97` hands that slot to the reference host,
  which `begin` captures when `@` opens (`lib/resourceGraph/useReferenceInput.ts:451-472`).
- `lib/notes/useOutlineSession.ts:2229-2241` seals it against the queue serial at send
  (`captureWriteSerial()`), after the row's insert completed, so `advanceLinksVersion`
  (`lib/notes/writes.ts:77-96`) skips the insert that moved the lane.
- outline/O31, overlay/O-7f and consumers/Q4h are xfails on main and on P1 (#734); the api
  log shows `set_body+insert_note` 200, then `insert_link` 409.

repro: in a page, Enter at the end of a row, type `@heath` at once, pick the resource.

related, by code only (P1's notes): a failed reference action's retry right after a pending
occurrence shown elsewhere still refuses at build after an answered defect.

starting point: P2 (`88acbbf1e`) proved a slot after an unacknowledged row by that row's
receipt, and recorded the receipt on the one proof every captured position shares (no
clone), so sealing advances through the acknowledged insert.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: outline/O31, overlay/O-7f and consumers/Q4h pass, and enter, type,
then an immediate move (bar or key) lands without a refusal.

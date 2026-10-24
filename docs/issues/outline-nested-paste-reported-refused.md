# a nested outline paste lands, then the tab says it was refused

status: open · origin: notes re-slice harness (outline/O30, defect D3), 2026-10-21; fixed
only by the dropped web engine (P2) · area: notes outline
(`components/resources/ResourceDisclosure.tsx`, `lib/resourceGraph/useResourceOutline.ts`)

pasting a nested outline creates the parent and its children in one commands batch, and
the server applies it. the tab opens the pasted parent's branch at admission and reads it
before the batch lands; the read answers 404, which the tab takes as the parent's
deletion. the acknowledged paste is then shown as refused.

impact: the person is told the paste failed ("this change was refused. your drafts are
kept.", "that change couldn’t be saved") and sees the pasted notes as "this note is no
longer available", while the server holds all of them. the deletion is tab-global
(`isDeletedResource`), so afaict later edits naming those notes are refused until a
reload. flat pastes are unaffected.

evidence (main `c0063b28e`):
- `lib/notes/useOutlineSession.ts:1301-1308`: admission opens the pasted parent's fold.
- `components/resources/ResourceDisclosure.tsx:37`: an open branch reads its resource at
  once, including a note this tab is still creating.
- `lib/resourceGraph/useResourceOutline.ts:103-106`: any 404 of an outline read announces
  the resource deleted (`announceResourceDeletion`).
- `lib/notes/useOutlineSession.ts:475-485`: a write naming a deleted resource is cancelled
  with "a resource used by this change is no longer available".
- outline/O30 is an xfail on main and on P1 (#734): one `POST /resource-graph/commands`
  answers 200, then the tab shows the refusal and four "no longer available" notices.

repro: block-select a row, paste `- t1\n  - t1a\n- t2` as text/plain.

starting point: P2 (`88acbbf1e`) skipped the read of a note whose text has no
acknowledgement yet (`useText(ref)?.acked === null`) and rendered its rows from the admitted
intent.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: outline/O30 passes (the paste shows as saved, no refusal or unavailable
notice), and an outline read's 404 for a note this tab is creating announces nothing.

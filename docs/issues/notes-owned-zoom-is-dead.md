# notes-owned zoom is dead code, and the module doc still describes it

status: open · origin: notes re-slice spec (N1, L7), 2026-10-21; removed only by the dropped
web engine (P2) · area: notes outline (`lib/notes/useOutlineSession.ts`,
`components/notes/OutlineEditor.tsx`, `docs/modules/notes.md`)

`session.zoom(row)` has no caller, so `view.zoom` is always `[]`. its plumbing, the zoom
menu and "back to linked notes" are unreachable, and the module doc describes them as
behaviour. the doc's "root-note `+`" names no control.

impact: no user-visible fault. readers of `notes.md` reason about a mode that cannot be
entered, and the outline session carries code paths no journey can reach.

evidence (main `c0063b28e`):
- `lib/notes/useOutlineSession.ts:2901-2908` (`zoom`, `zoomOut`): `rg 'zoom\('` under
  `apps/web/src` finds no caller of `zoom`; `view.zoom` starts `[]` (`:973`).
- readers that only ever see `[]`: `lib/notes/useOutline.ts:411`, `:426`, `:477`;
  `components/notes/OutlineEditor.tsx:226-245` (zoom menu, "back to linked notes"),
  `:262`.
- `docs/modules/notes.md:185` ("notes-owned zoom remains editable"), `:327` ("root-note
  `+`"), `:333` ("an empty zoomed latent note").

starting point: P2 (`88acbbf1e`, `f37fb3eb9`) deleted `session.zoom`/`zoomOut`, `View.zoom`,
the zoom menu, "back to linked notes" and `OutlineEditor`'s unread `activateTarget`, and
dropped those doc lines.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: no notes-owned zoom code or doc line remains, or a caller makes it
reachable and a journey exercises it.

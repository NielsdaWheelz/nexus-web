# local-first outline lacks the outline focus model and touch-accessory fixes

status: open · origin: 2026-10-26 review of `99feec0d2` on `codex/local-first-writing`
against the outline touch accessory change on main · area: local-first outline
(`components/notes/LocalOutline.tsx`, `BoundNoteEditor.tsx`, `BoundPageTitleEditor.tsx`,
`components/resources/ResourceOutlineRow.tsx`)

`99feec0d2` ported an early version of the touch accessory: the pane shell's touch
gate and clearance, `useTouchCapable`, `outlineStructuralCommand` and an outline
keybindings section. main then fixed what that version got wrong. when local-first
merges main, its deletions of `useOutlineSession`, `OutlineSurface`,
`PageTitleEditor` and `CanonicalNoteEditor` win, and these contracts must be
re-established in the local-first editors:

- keyboard trap. item text (a row's own note body or inline page title) must not
  be a sequential tab stop (`tabindex="-1"` while editable and idle and no `@`
  query is open), or escape, escape, tab re-enters the text, where tab is
  structural, and keyboard traversal can never pass an editable item. the
  local-first `Outline.Clear` row's "tab then moves on" is false until then.
- f2. f2 on a row (its target or its own controls) with editable item text and no
  active `@` reference puts the caret at the end of that text. it is announced
  with `aria-keyshortcuts="F2"`. the keybindings page lists it.
- strict refusal applies only in item text; root text, the insertion line and
  annotation bodies keep native keys.
- key repeat. main never executes structural commands, or enter, on auto-repeat,
  because its server-versioned writes refuse a second command sent before the
  first is acknowledged (`outline-command-after-unacknowledged-insert-refused.md`).
  `BoundPageTitleEditor` executes on repeat. keep that only if local writes
  sequence correctly, and say so in the module doc.
- `SelectionDock` must read `usesMeta(platform)`, not `navigator.platform`.
- copy: main's outline rows are sentence case and use "item", matching the bar.
  reconcile the vocabulary once ("item" or "block") across the bar and the page.

resolved when local-first, merged with main, passes: no tab trap through an
outline in either direction; f2 into item text from the row and from its bullet;
no command bar on fine pointers; and the keybindings rows true to the behaviour.

# the small label is declared a dozen times

status: open · found 2026-11-12 by survey at `858cb192e` · area: web / visual system

the same small, faint, tracked label is written out separately in at least twelve
css modules, in three spellings of the same intent:

- `text-transform: uppercase`: `components/chat/ChatSurface.module.css:164`
  (`.kicker`), `app/(authenticated)/media/[id]/media.module.css:69`,
  `app/(authenticated)/authors/[handle]/page.module.css:14`,
  `components/nexus/Nexus.module.css` (`.head`, `.sub`),
  `components/ui/Pill.module.css:3`.
- `font-variant-caps: all-small-caps`: `components/ui/MachineText.module.css:17`,
  `app/(authenticated)/settings/appearance/page.module.css:231`.
- raw `em` tracking instead of the `--tracking-*` tokens:
  `app/(authenticated)/stats/StatsPaneBody.module.css:34`,
  `app/s/publicShare.module.css:36`.

`ChatSurface.module.css:149` calls its rows small-caps and sets uppercase.

impact: a label's case, size and tracking differ by pane for no stated reason, and
each new surface adds another copy.

resolved when the label has one declared form (a class or a token set) with the
exceptions named, or the differences are recorded as intended in
`docs/modules/visual-system.md`.

headword replaces desktop uses of `.head` and `.sub` with lowercase margin
side-heads and locators. both uppercase declarations remain for the phone;
this change removes no duplicate label declarations.

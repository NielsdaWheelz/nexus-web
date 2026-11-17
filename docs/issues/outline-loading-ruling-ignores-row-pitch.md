# outline loading lines use a different pitch from loaded rows

source finding at `fcd6843db` on 2026-11-15; not a rendered loading transition.
`apps/web/src/components/feedback/Ruling.module.css` falls back to
`--size-xl` (44px) when `--ruling-pitch` is absent. the ruling in
`apps/web/src/components/notes/LocalOutline.tsx` has no outline-specific pitch.
normal outline rows use a 14px font, 1.5 leading and 2px block padding on each
side (`NoteEditor.module.css`, `OutlineEditorRow.module.css`): a 25px single line.

impact is cosmetic: the loading lines do not anticipate the loaded row spacing.

resolved when: the outline supplies its ruling pitch from the same row tokens,
and the loading and first loaded rows align without a separate literal size.

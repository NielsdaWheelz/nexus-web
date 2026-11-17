# the sans reader profile names a literal `Inter`, which the app never defines

found 2026-11-16 at 839bb918b, photographing the notes in a lab for a redesign.

## problem

the sans reader profile's font stack starts with the family name `Inter`. the
app's Inter is a `next/font/local` face loaded under a generated family name and
exposed only through the `--font-inter` css variable, so a literal `Inter` matches
only a locally installed font. a sans profile then renders in the next stack
entry (the system font) on most machines, and so do the librarian's answers set
in the reader face.

## impact

the sans choice does not give the bundled face the rest of the app uses; what a
reader sees depends on whether Inter happens to be installed.

## evidence

- `apps/web/src/lib/reader/typography.ts:7`: `sans: "Inter, ui-sans-serif,
  system-ui, ..."`, published as `--reader-font-family` (`typography.ts:14`) and
  used by the reader, chat, excerpts and the library views
  (`media.module.css:366`, `ChatSurface.module.css:12`,
  `MarkdownMessage.module.css:7`, `ReaderExcerpt.module.css:5`).
- `apps/web/src/app/layout.tsx:44-50`: `localFont({src: "./fonts/inter-latin.woff2",
  variable: "--font-inter"})`; `globals.css:6` uses `var(--font-inter)` at the head
  of the app stack. `packagedFonts.css:6` and `android/fonts.css:66` redefine
  `--font-inter` for the packaged reader and android, so a bare `Inter` also
  bypasses those overrides.
- the settings preview paints the same literal stack
  (`settings/reader/SettingsReaderPaneBody.tsx:52`), so it shows the same fallback.
- a lab photograph taken during the survey (not kept in the repo). to reproduce:
  choose the sans profile in reader settings on a machine without a local Inter and
  read the computed `font-family` of a reader surface in devtools.

## proposed fix

put `var(--font-inter)` at the head of the stack. or choose the system face
deliberately (it has a true italic) and record that choice where the stack is
defined.

## resolved when

a sans profile's computed font on a machine without a local Inter is the bundled
Inter, or the choice of the system face is recorded beside the stack.

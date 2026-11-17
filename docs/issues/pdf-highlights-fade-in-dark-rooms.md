# dark-room highlight inks become faint on white pdf pages

source/arithmetic finding at `09c14e68f`; not a rendered pdf case. the pdf mark
uses room-dependent highlight inks and `mix-blend-mode: multiply` in
`apps/web/src/lib/documentReader/documentReader.module.css` `.pdfMark`;
`pdf/PdfSurface.tsx` supplies the highlight colour.
dark-room inks are pale for dark text surfaces, but a pdf page remains white;
multiplication on white retains those pale colours.

impact: room switching can make pdf highlights much fainter despite an
unchanged white page.

resolved when: the pdf mark owner uses inks appropriate to the page surface,
with readable overlap in each room. this differs from the reader swatch
mismatch recorded in [highlight swatches](highlight-swatches-ignore-dark-reader-inks.md).

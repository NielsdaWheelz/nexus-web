# highlight colours disable the current colour

problem: the swatch row and split button mark the persisted colour
`aria-disabled` with "this colour is already applied."
(`apps/web/src/app/(authenticated)/media/[id]/HighlightColourPicker.tsx:27,33,57,60`),
while also setting `aria-pressed`. this is the pattern the owner rejected for the
reader theme: current state presented as unavailability.

impact: the current colour reads as blocked rather than chosen; the reason text
explains a non-problem.

proposed fix: the current colour is a checked no-op. before moving `Colours` onto
the menu choice (`MenuChoice`, `apps/web/src/lib/ui/actionDescriptor.ts`), decide
whether recolouring keeps close-on-select.

resolved when no swatch is disabled for being current and the selected colour
is conveyed as selection.

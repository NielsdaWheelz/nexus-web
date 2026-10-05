# the shared reader core leaves hosted-only surfaces to the hosted cutover

status: open · origin: 2026-10-04 reader rewrite pr1 (`cleanup/reader-reauthor`) · area: web reader (`lib/documentReader`)

pr1 moved the public `/s` reader and the offline shelf onto
`lib/documentReader` and left the hosted pane (`MediaPaneBody`) on the old
reader. these primitive features have no pr1 consumer, or depend on the
css-highlight probe the owner made a condition for paint (amendment r4), so pr1
did not build them:

- focus mode (paragraph, sentence, distraction-free) and the reader theme
  classes (`--reader-*` colours, today in `media/[id]/page.module.css`);
- pulse decoration and pdf mark hover;
- the text and pdf `FindSource`s (`lib/find` adapters);
- the eslint import boundary on `lib/documentReader` (design: once the old
  reader files are gone).

built to the design's interface but without a pr1 consumer, so unexercised
until pr2's `R.*` journeys: text and pdf selection capture (`onSelection`),
mark activation and hover (`onMarks`), note-marker binding and activation
(`noteRefs`, `onApparatus`), transcript time seek (`onSeekTime`), embed
portals (`renderEmbed`), scrollbar-drag seek, the `Newer` handoff after
revalidation, `install`/`drainForReset` (lectern reset) and `reload`.

pr1 paints marks as `<mark data-reader-mark class="hl-<colour>">` (text) and
overlay rects (pdf), which is what `/s` painted before; the `Decorations` port
does not name a mechanism, so the probe's verdict changes only `text/paint.ts`.

the progress contract pr2's `hostedProgress` implements: a 409 on save is
`{kind: "Stale", canonical: details.current}`, which the sync turns into the
`newer reading spot available` handoff (movement waits; *keep my reading spot*
saves the spot being read at the newer revision). the hosted cursor has no
`Conflict` view, so its `resolve` is never called; only the shelf's device
store has one, and reading keeps moving its device side. a cursor `GET` that
fails opens the document with *reading position unavailable* and nothing
saves; pr1 has no recovery short of reopening, which the hosted pane needs
(revalidate after `LoadFailed` must not save the reader's spot over a cursor it
never read).

temporary duplicates pr2 deletes with the old reader:
`DocumentReader.tsx`'s `readerSurfaceStyle` copies
`lib/reader/readerSurfaceStyle.ts` (`MediaPaneBody` still uses it), and
`pdf/pdfjs.ts` repeats `components/pdfReaderRuntime.ts`'s loader
(`scripts/copy-pdfjs.mjs` lists both as asset sources).

budget: `lib/documentReader` is 3,863 formatted lines after pr1's review fixes
(gate 4,200). the design's pr1 plan of 3,790 included focus mode, pulse, pdf
hover and the reader theme, which pr1 deferred, and per-file overruns spent the
plan's slack (`DocumentReader.tsx` +114, `model.ts` +69, `text/geometry.ts`
+71, `runtime.ts` +64, `chrome.module.css` +60). pr2 still adds the find
sources (design 290), focus mode, pulse, theme, hover and the r4 painter with
its conditions, against ~337 lines of headroom. before pr2 adds those, it
spends the design's §9 valves inside the primitive, in order: (1) crowded rail
ticks open the first marker (−60), (4) rail hover previews become `title` text
(−40), (5) sentence focus folds into paragraph if the owner signs d9 (−30).
if the primitive still projects over 4,200, pr2 stops and re-plans with the
owner rather than raising the gate.

done when: the hosted cutover (pr2) lands these, or the owner drops one.

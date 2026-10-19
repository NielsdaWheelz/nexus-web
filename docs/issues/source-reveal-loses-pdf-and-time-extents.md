# source reveals lose pdf and timed extents before painting

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: reader / source activation

problem: source activation can navigate to pdf geometry or a timed passage, but
the arrival decoration represents text ranges only. pdf evidence is not painted;
timed citations discard the end time and do not identify the complete passage.

evidence: `apps/web/src/app/(authenticated)/media/[id]/hostedReader.ts:111-127`
sets evidence/pulse only for text. `:147-154` preserves pdf quads for positioning
but maps every time range to its start only; `:171-175` again paints only text.
`apps/web/src/lib/documentReader/DocumentReader.tsx:60-71` restricts both transient
decorations to `TextRange`. `apps/web/src/lib/documentReader/pdf/PdfSurface.tsx:268-305`
on main `ff57128842b470510446b3edca54922ebcace41e` paints saved marks and the
selection composer's active passage, but `MediaPaneBody.tsx:441` supplies that
passage only from the composer. reference arrivals still have no pdf inspection
decoration. source-confirmed; no live execution.

prerequisite: define the requested persistent inspection decoration separately
from saved user highlights and from the point used to scroll.

proposed fix: carry the existing resolved extent through the arrival, retain it
per reader instance, and let each format paint it using the existing
`Passage`/`MarkAnchor` machinery with separate inspection and composition state.
show a page-level target
honestly when only a page is known; map a time range to its covered transcript
segments without inventing character precision.

acceptance: pdf citations with verified exact geometry outline the cited area;
approximate geometry is identified as such; page-only
citations identify the page; transcript/audio/video ranges retain their full
extent and mark the available passage. source inspection never creates or edits
a saved highlight, and its visual treatment remains distinguishable from one.

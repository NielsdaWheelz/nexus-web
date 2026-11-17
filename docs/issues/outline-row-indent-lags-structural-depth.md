# indentation can lag the row's structural depth

reported at `839bb918b` on 2026-11-16 while typing quickly under load: an
indented row briefly painted at its former depth. the lab photograph was not
retained, and the mechanism has not been reproduced.

source hypothesis: `apps/web/src/lib/notes/outlineController.ts` paints
`dataset.depth` from the projected `rows` map (lines 2118–2119). `rebuild`
defers that map while writing is pending or arrangement is unavailable
(line 1230); `syncMetadata` reads the same map. this could leave paint behind
the committed structure. no padding animation was found in the row stylesheet.

impact: the outline briefly misrepresents the structure the writer just changed.

resolved when: indenting and continuing to type under load updates the row's
paint with the settled structural command, while preserving pending writing.
first confirm whether deferred projection causes the observed lag.

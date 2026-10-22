# pending-page presentation qualification observed another read

run24 at `2c827362f`, lab `20261021-193419-601b5c19c34d`, passed the actual
200-row continuation/refresh/cursor-repair journey. the later
`writing-presentation.spec.ts:85` quiet-window assertion observed one completed
workspace-presentation post during its one-second no-input window, before page
publication. its retained trace and `presentation-read-observation` attachment
contain the exact locator batches and timing.

the target's first unavailable version probe completed 80 ms into the quiet
window; its one bootstrap invalidation caused the new batch at 108 ms. the case
waited for presentation flights but omitted that initial probe. source review of
`writingReceive.ts:81–90` confirms repeated identical unavailable results are
deduplicated and the presentation owner retains the same watch; the trace itself
contains only the initial probe. no product fix is justified.

wait for the exact recovered target's initial probe and its ensuing presentation
completion before starting the unchanged one-second zero-read window. preserve
the two-second post-publication watch check. resolved when that real case passes.

# phone busy control remains after the hybrid response

observation: the round-1 phone typed screenshot at d5c2a6a5f still shows busy about
800ms after hybrid landed. this alone does not establish stale feedback:
`lib/nexus/useNexusFind.ts:196` also includes local preview, retained-local admission
and resource reads in `pending`; `NexusRow.tsx` publishes that to `FeedbackBusy`.

impact: the palette may appear unfinished after remote results settle. the exact
pending owner was not captured, so removing busy on hybrid would conceal real work.

resolved when a real phone/emulated run correlates the remaining read with the
control, confirms it clears on that read's settlement, or repairs the responsible
pending owner if it does not. no production instrumentation seam is required.

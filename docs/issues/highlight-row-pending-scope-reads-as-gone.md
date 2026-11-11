# non-held highlights confuse pending scope with absence

status: absence guard restored by source reconciliation; fresh-profile qualification remains open.

historical evidence from the 2026-11-01 lab also recorded literal highlight ids
on synced cold mounts during scrolling for 15–41 frames per pass. that predates
the held-row correction; it does not establish a current recurrence.

placed reader connections now render their held projection through one `AuthoredRow`
and keep the mark while scope catches up. pending row chrome names a resource's
type instead of printing its ref. `HighlightAnnotation` no longer owns a query.

`node/authored/src/queries.ts:excerptQuery` returns empty rows and
`scope_available: false` when reading scope is missing. the feedback-homes merge of
main `3ba73e379` preserves the existing absence guard at
`apps/web/src/components/resources/ResourceOutlineRow.tsx:150`: `LocalRow` passes
`answered={read.data?.scope_available===true}` to the new projection-based
`AuthoredRow`. its absence fact therefore requires a hydrated scope.
directly supplied projections remain answered. other reference paths can navigate
to the generic highlight before a reading-scoped activation is available.

impact: a pending local read can falsely describe the user's writing as deleted
on non-held surfaces. the original fresh-profile observation predates this branch;
the remaining surfaces have not all been replayed. the repaired reader path alone does not qualify those surfaces.

the row/query correction is established by source and the static gate, not a live
hydration journey. verify the remaining surfaces and their reading destinations
without remounting the annotation owner.

resolved when fresh-profile highlight rows on every reading-scoped surface keep
correct pending/absent semantics and their intended destination until scope arrives.

# non-held highlights confuse pending scope with absence

status: open outside reader connections; source review.

placed reader connections now render their held projection through one `AuthoredRow`
and keep the mark while scope catches up. pending row chrome names a resource's
type instead of printing its ref. `HighlightAnnotation` no longer owns a query.

remaining cause: `node/authored/src/queries.ts:excerptQuery` returns empty rows and
`scope_available: false` when reading scope is missing. in
`components/resources/ResourceOutlineRow.tsx:LocalRow`, a known owned resource with
that answer still reaches `AuthoredRow` with `answered=true` and `resource=null`,
which says `no longer available on this device`. other reference paths can navigate
to the generic highlight before a reading-scoped activation is available.

impact: a pending local read can falsely describe the user's writing as deleted
on non-held surfaces. the original fresh-profile observation predates this branch;
the remaining surfaces have not all been replayed. a1 in the reader is insufficient
to close this record.

fix at the row/query boundary: distinguish unavailable scope from proven absence
without changing the reading identity or remounting the annotation owner.

resolved when fresh-profile highlight rows on every reading-scoped surface keep
correct pending/absent semantics and their intended destination until scope arrives.

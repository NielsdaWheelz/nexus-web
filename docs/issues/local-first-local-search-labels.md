# local search omits derived daily titles and saved source labels

`apps/web/src/lib/authored/persistence.ts` builds FTS text from nullable title/body
or highlight quote. an empty daily title therefore indexes empty text, although
its displayed title is date-derived. native `authored/AuthoredStore.kt` does the
same. source-stub writes create no FTS row, and shared `queries.ts` search joins
only `resources`; a saved source label cannot appear in offline reference search.

these are reference metadata, not permission to read remote source bytes. the
shared query/projection owner should define indexed display text and the intended
searchable source-stub closure, with both persistence adapters consuming it.
prove an untitled daily page is found by its displayed date and a captured source
label resolves offline without a server search or source-access claim.

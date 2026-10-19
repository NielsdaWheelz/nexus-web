# search passage snippets hide source attribution

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation audit
area: search / resource presentation

the search projection computes a result's type and source label, but the
collection presenter discards both whenever a snippet is present. for fragments
and chunks the primary text is already that snippet, so the row repeats the
passage while omitting its source title and resource type.

evidence: `apps/web/src/lib/search/searchViewModel.ts:67-68` and `:99-104`
make the plain snippet primary and retain source metadata.
`apps/web/src/lib/collections/presenters/search.ts:29-38` chooses the snippet
instead of the type/source line. `components/collections/CollectionRow.tsx:205-210`
(under `apps/web/src/`) renders only the chosen context. this is a source audit;
no browser reproduction was run.

prerequisite: retain a distinct source-attribution field in the shared resource
presentation contract. render the passage once, with search matches emphasized,
and retain its type, source title and available author credits below it.

acceptance: fragment, chunk and highlight search results with snippets display
recognizable passage content once and retain source title/type/author metadata;
rows without snippets retain equivalent attribution.

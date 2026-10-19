# old library search results remain actionable during a new query

status: open · origin: 2026-10-14 library picker design audit · area: web / destination search

problem: a query change retires request authority but leaves the previous query's destinations actionable through debounce and loading.

evidence: `apps/web/src/components/libraries/useLibraryDestinationSearch.ts:82-99,117-143` keeps `results` while delaying typed queries by 180 ms and waiting for replacement data. `LibraryDestinationPicker.tsx:176-179,267-279` renders those results. `LibraryChooser.tsx:134-150` gates activation on mutation busy state, not result/query correspondence. `resultsQuery` already exists but guards create eligibility only (`LibraryDestinationPicker.tsx:194-207`). source trace only.

reproduce: load one query, type a different query, press enter before the replacement response. the old highlighted row remains actionable.

prerequisites: retain existing generation fencing and paging ownership; choose local complete-catalog filtering or query-qualified remote results.

the extension uses this search owner over nonabortable background messaging (`apps/web/src/extension/popup.tsx:300-307,338-384`), so preserve generation fencing even if browser matching becomes local.

fix: make every activation refer to candidates valid for the displayed query. retain old data visually only if it cannot masquerade as current actionable results. a query change must invalidate stale active identity immediately.

acceptance: with delayed and reordered responses, typing a new query never changes membership in an old-query destination; failed refresh cannot revive stale activation.

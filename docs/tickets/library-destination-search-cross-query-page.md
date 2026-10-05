# destination search can append another query's page

status: deferred
origin: 2026-10-05 independent source audit at `031c3c95de81f25306b4e17fd656d9eeaf72218c`
area: web / library destination search

`useLibraryDestinationSearch.ts:77` advances generation on query change, but
retires the old cursor only when its delayed first-page request starts at
88. `loadMore:114–135` can admit the old results query/cursor under that new
generation. both settlements accept it. the picker still exposes continuation
at `LibraryDestinationPicker.tsx:246–249`.

source permits query b's first page to install, then query a's admitted
continuation to append into it. no live incident is claimed. the extension also
uses this hook and does not forward its cancellation signal.

retire continuation authority when the requested query changes and bind each
admitted page to its inventory. controlled completion ordering must preserve
query/cursor isolation in both callers, ordinary paging, failure/retry and
close/reopen behavior. keep native search/ranking authority unchanged.

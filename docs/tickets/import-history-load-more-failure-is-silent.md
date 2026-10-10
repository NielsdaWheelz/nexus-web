# import history "Load earlier events" failure is silent

status: open · origin: 2026-10-10 imports reauthor (cleanup/imports-reauthor), conserved from before · area: web / imports

in the inspector's Attempts section (`components/imports/ImportInspector.tsx` `Attempts`), a failed "Load earlier events" read keeps the loaded events and hides the button (`hasMore && !(short && error)`), but shows no notice and offers no retry; the reader sees the button vanish. the list's Load more says "More imports couldn’t be loaded" with Retry; history says nothing. the previous inspector behaved the same way (its pagination error was never rendered).

fix: render the list's load-more notice (copy already in `lib/imports/copy.ts`) under the timeline when the history read failed while short, with Retry calling the read's refetch.

acceptance: with history reads 503 after the first page, "Load earlier events" shows "More imports couldn’t be loaded" + Retry, and Retry recovers.

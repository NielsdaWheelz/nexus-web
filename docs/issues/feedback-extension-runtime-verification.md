# verify shared feedback in the installed extension

status: open; actual permission refusal and admitted retry remain unverified
origin: 2026-10-16 compact feedback cutover
area: browser extension / popup

`apps/web/src/extension/popup.tsx` now uses shared status, notice and field
primitives. the extension builds and its command contract is unchanged; the
original feedback campaign did not execute the installed popup or a real
browser permission prompt.

prerequisite: an isolated installed build with its normal authenticated host.
exercise capture reading/uploading/accepted states, an admitted retry and an
actual permission refusal. use real requests and native permission controls.

acceptance: correct stage copy, usable compact feedback, exact supported retry,
no false completion and no replacement of the browser's permission interface.

2026-10-17 wire-10 closeout reports temporary installation of the matching
s3 firefox extension, native popup sign-in and permission consent, one ordinary
save, accepted feedback, and an opened readable, indexed source with visible
import history. the retained handback reports required consumers accepted;
the [raw campaign evidence was not retained](wire10-qualification-evidence-not-retained.md).
permission consent is not a refusal, and this successful save does not
qualify retry behavior.

bibliography reported unavailable required `web.search` before model dispatch;
source/index completion remained distinct from that attention state. the source
logo returned typed 502 `Too many redirects` while its text remained readable.
neither limitation is evidence that the whole network journey passed.

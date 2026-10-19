# libraries filter is not retained for pane return

status: open
origin: 2026-10-14 libraries-pane design review; checkout `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: web / libraries visit continuity

planned resolution: libraries creation plan (#629).

`apps/web/src/lib/panes/paneFilterRows.ts:95-111` describes visit-local filtering
but keeps the query only in component state initialized to empty. libraries
uses it at `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx:234-246`.
libraries and library detail use different bodies
(`apps/web/src/lib/panes/paneRenderRegistry.tsx:13-14`), so returning after a body
remount does not recover the former filter. the existing list snapshot and scroll
memento do not capture that query. source inspection only; no live back journey
was performed in this review.

reproduction: filter the libraries index, follow a library in the same pane,
then use pane back. inspect whether the previous filter and resulting list
context return together.

prerequisite: make filter restoration an explicit part of the return contract
before adopting create-and-open. retain the query through the existing per-visit
data mechanism (`apps/web/src/lib/workspace/paneReturnMemento.tsx:347-361`), without
introducing durable draft storage or a second visit store.

acceptance: pane back restores the prior filter, sort and visible-list position;
a genuinely new visit starts with the declared default filter.

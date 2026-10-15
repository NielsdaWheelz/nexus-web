# search scope chip shows a ref

**problem**: an `in:` scope chip in the search pane reads its raw ref ("In: media:3f2c…"),
not the scope's title.

**impact**: cosmetic. reachable only by typing an `in:<ref>` operator or opening a `scope=`
url; no product surface writes `scope=` today.

**evidence**: `apps/web/src/app/(authenticated)/search/SearchControls.tsx`, the applied chip
built from `query.scope` (`In: ${query.scope}`). a title needs a resource read the web does
not have yet.

**resolved when**: the chip shows the scope's title read from the actions slice's
`GET /resource-items/{ref}` (one `usePaneFreeServerValue` keyed by the ref), and the search
harness journey P5 asserts the title instead of the ref.

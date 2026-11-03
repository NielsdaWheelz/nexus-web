# account menu closes while its sync status turns

problem: the rail's account menu (`components/appnav/AccountMenu.tsx`) closes by
itself a few seconds after opening, while its status row reads "syncing … n of m
readings ready". once the row reads "up to date" the menu stays open.

evidence: the glyph lexicon's sign-off lab opened the menu during reading preparation
on a fresh account, ten runs in a row. each time the menu was gone before it could be
captured, with no pointer, key or resize. opening it after the status settled captured
it at once in twelve of twelve runs. cause not traced: `syncStatusOption`
(`SyncStatus.tsx`) may hand `ActionMenu` a new option identity, or preparation's
completion may move focus.

impact: a person who opens the account menu during reading preparation sees it vanish.

resolved when, with a reading preparation in flight, the account menu stays open across
the status turning to "up to date" (a lab: seed an article, open the menu at once, poll
its visibility for 30s).

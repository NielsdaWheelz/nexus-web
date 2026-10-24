# saved-media detail qualification

status: open; native runtime observation outstanding

the offline catalog change introduced a `SavedMedia` caller of the index identity
presenter. bounded indexes require focus recovery and omit full date/credit facts;
this standalone detail must wrap. `SavedMedia` in
`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:176` now composes
the existing full bibliography, reading facts and processing-failure status.
static checks cover the interface; the ordinary browser lab has no saved native
catalog and cannot enter this branch. no native behavior is claimed from it.

resolve on an installed authenticated native client: save a real catalog with a
long/multiple-author item, make its full reader unavailable, and open its saved
detail. confirm complete wrapping credits, supported original-date precision,
reading facts and failure status; reconnect and open the full reader. use actual
native catalog provisioning, not an injected browser snapshot or fake bridge.

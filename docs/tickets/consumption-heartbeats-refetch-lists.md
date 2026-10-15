# consumption heartbeats reread consumption-dependent lists

status: open · origin: 2026-10-10 collection-revision cut (cleanup/collection-keyset-continuations, design Q3) · area: consumption / lists

every accepted listening heartbeat (`lib/player/browserEngine.ts`, one per 15 s
while audio plays) and every reader-state save (`media/[id]/hostedReader.ts`)
publishes `Consumption` (`lib/api/changes.ts`). each mounted view that follows it
rereads: a library pane in the Remaining order or the In progress / unfinished
projections rereads its whole loaded prefix (`lib/libraries/useLibraryEntries.ts`
`followsConsumption`), state-filtered episodes reread, and
`MediaSummaryProvider.invalidateAll` re-resolves every retained summary. the
consumption slice's own consumers are gated (2026-10-14): the Stats pane
follows `Consumption` only while it is the active pane, quick reads and
suggestions refresh only when the lectern pane becomes active, and the Lectern
read does not follow it. the publisher split below stays open. cost is unchanged from before the cut (the revision bus did
the same); kept for conservation (design Q3).

the cheaper alternative: publish `Consumption` only on state transitions
(finish, unread, reset, the first progress on an unread item) and let summaries
patch percentages through their own refresh. needs a decision on whether the
remaining-time order should track live listening.

acceptance: a decision; if taken, heartbeats and reader saves publish only on a
transition and a playing episode no longer rereads an open remaining-ordered
library every 15 s.

# source reveals are broadcast before the destination pane is chosen

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: workspace / reader source activation

problem: activating a citation dispatches a media-wide reveal before workspace
activation chooses or creates its destination. every mounted copy of that media
can move. the first mounted copy consumes the pending reveal, so a newly forked
pane cannot rely on that handoff; the href must independently carry the target.
a rejected fork can still move existing readers.

evidence: `apps/web/src/components/chat/Conversation.tsx:84-99` dispatches before
activation. `apps/web/src/lib/reader/pulseEvent.ts:23-43` keys the pending reveal
only by media id and synchronously broadcasts it. every mounted reader with that
media consumes and acts on the event at
`apps/web/src/app/(authenticated)/media/[id]/hostedReader.ts:279-285`; it does not
check pane identity or whether another copy consumed it. the actual landing pane
and pane-limit rejection are decided later in
`apps/web/src/lib/workspace/store.tsx:325-365`. source-confirmed; no live execution.

prerequisite: retain the existing central follow/fork planner and define a reveal
as belonging to one successful destination visit.

proposed fix: deliver the located source target through the workspace activation
result or its existing pane/visit-scoped entry channel. claim it in that reader;
supersede earlier pending arrivals for the same visit. retire the media-wide
pre-navigation handoff after all citation and quote callers migrate.

acceptance: with two copies of one source open, follow moves only the chosen
copy; shift-click creates a third copy at the cited passage and leaves both old
copies unchanged. opening a located quote whose href lacks a range still reveals
its exact target. a pane-limit rejection moves nothing. repeat activation and a
delayed older resolution cannot displace the latest target.

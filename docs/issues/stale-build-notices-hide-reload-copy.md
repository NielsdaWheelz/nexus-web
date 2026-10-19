# a stale tab's notices hide "nexus was updated" behind details

status: open
origin: 2026-10-19 edge triage (E5, E5d, E5e red since #650)
area: web / shared feedback / api edge skew

after its one reload, a tab built for another wire gets 426 on every request.
`docs/modules/api-edge.md:24-27` promises that every 426 then reads "Nexus was
updated. Reload this page to continue." `apiTransportFeedback`
(`apps/web/src/lib/api/client.ts:126-127`) still puts that copy in `message`
under the caller's own title. #650's renderer moved `message` and diagnostics
into a collapsed "details" disclosure (`apps/web/src/components/feedback/Feedback.tsx:241,265,321`).
so a modeled 426 now leads with the caller's failure and the caller's retry:
- "This chat couldn’t be opened." (no action)
- "The Atlas couldn’t be loaded" + retry
- "recent selection not confirmed" + retry save
- "workspace changes not confirmed" + reload app

retry gets 426 again until the page reloads. only the two boundaries
(`PaneRouteErrorBoundary.tsx:64`, `AuthenticatedWorkspaceErrorBoundary.tsx:49`)
title themselves "nexus was updated". #650's plan made the title the complete
short fact; for a stale build it isn't.

impact: after a deploy that moves the wire, an open tab looks broken, not
outdated. this happens when its reload is spent, or when a leave-page prompt
kept it open. it invites a retry that cannot succeed. the reason and the remedy
sit one click away, and the only reload offered sits under a title that reads
as lost work. nothing is lost.

evidence (`nexus-web-campaign-artifacts/2026-10-18/edge-triage/run-d6b73c712/`):
- on `d6b73c712`, E5 never sees the copy in 60 s.
- a stale chat tab shows "This chat couldn’t be opened. [details]". the copy is
  in the dom but not visible until details opens (`diag.txt`,
  `diag-E5-before.png`, `diag-E5-details.png`).
- the atlas shows "The Atlas couldn’t be loaded [retry] [details]".
- a stale nexus history write shows "recent selection not confirmed [retry save]
  [details]".
- the 2026-10-15 reference run (`2026-10-14/replay2/runs/g4-tip3-edge.txt`)
  showed the copy inline.

reproduction: signed in, route every `/api/**` request with `X-Nexus-Wire` one
below `WIRE_REVISION`. the first 426 reloads once; the reloaded tab shows the
notices above, with the copy only under "details". or run edge E5/E5d/E5e
through the c3ef harness copy, with the journey ports listed in
`edge-triage/` (#625's "Search" launcher, #650's markup).

resolved when: past its one reload, every modeled 426 states the update without
a disclosure and offers reload or nothing, never a retry. edge E5, E5d and E5e,
ported, pass.

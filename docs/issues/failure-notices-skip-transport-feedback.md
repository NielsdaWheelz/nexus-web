# failure notices that never read the error offer retry to a stale tab

status: open
origin: 2026-10-20 stale-build notice fix (`cleanup/stale-build-notice`)
area: web / shared feedback / api edge skew

a stale build's notice reads "Nexus was updated. Reload this page to continue."
with reload as its only action only when its content comes from
`apiTransportFeedback` or `STALE_BUILD_FEEDBACK` (`apps/web/src/lib/api/client.ts`).
some failure notices build their content from any `ApiError` without reading
its code, and attach their own retry:
- `apps/web/src/components/chat/ChatContext.tsx:40`: "context couldn’t be
  loaded" / "couldn’t refresh connections" + retry
- `apps/web/src/app/(authenticated)/stats/StatsPaneBody.tsx:1026,1029`
- `apps/web/src/components/podcasts/PodcastSubscriptionSettingsOverlay.tsx:44`
- `apps/web/src/components/contributors/MediaAuthorsEditor.tsx:111`
- `apps/web/src/app/(authenticated)/media/[id]/Embeds.tsx:172,190`: bare retry
  buttons outside the feedback signals

on a tab past its one reload they show their own title, the request id under
details and a retry that meets 426 again; the update copy never appears. a
network or upstream failure there also misses the transport copy.

impact: lower than the regression fixed beside this record: these are
secondary surfaces, and edge E5's stale chat tab showed none of them. but each
looks broken, not outdated, and invites a retry that cannot succeed.

evidence: reading. the list comes from a pattern search, not an audit.

resolved when: every failure notice takes its content from the error through
`apiTransportFeedback` (or a domain owner that does), and a stale tab on chat
context, statistics, podcast subscription settings, media authors and embeds
shows the update copy with no retry.

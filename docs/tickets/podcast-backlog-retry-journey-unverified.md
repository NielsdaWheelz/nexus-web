# the podcast detail's "Retry backlog" has no live proof

status: open · origin: 2026-10-10 podcasts/browse web rewrite (design §12 P2) · area: podcasts / verification

The rewritten detail pane shows "Retry backlog" when the subscription's
backfill is `Failed` and runs `retryPodcastSubscriptionBackfill` through
`useCommand` (`apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`).
The podcasts harness cannot reach `Failed`: a backfill fails only after three
job attempts on 60/300/900 s retry delays (~21 min), and the non-strict rss page
fetch swallows fetch and parse errors, so no fake input fails a step
(`nexus-web-campaign-artifacts/2026-10-09/podcasts/harness/baseline.txt`).
Only `NotEligible` is pinned over http (journey H7).

fix: give the harness a product-path way to fail one backfill step quickly
(e.g. a fake feed page that the strict step rejects, or a test-sized retry
schedule), then drive the button.

acceptance: a journey shows a Failed backfill, presses Retry backlog, and sees
the backfill fact leave Failed without a reload.

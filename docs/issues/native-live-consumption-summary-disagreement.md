# native live consumption summary disagreement

status: open; rendered disagreement observed, responsible owner unproven.

problem: the native library row showed finished while a contemporary live read
and an earlier retained native observation explicitly said unread. the check in
`apps/web/src/components/media/MediaIdentity.tsx` renders only for `Finished`;
full listening position does not override explicit unread in the canonical
consumption projection. rendered consumption coherence is unqualified.

evidence: source `b039b3b6bfb3f4b80e9fefcb2ebf229b8daba22e`, private lab
`20261025-190630-c84270b9790c`, retained `artifacts/native-index/`:

- `native-observation-after.json` (20:01:24 pdt): media
  `08598728-8b4a-4220-8e40-755e7cec9273`, observed revision 8, unread override 2,
  reset epoch 1, position/duration 6014/6014, local null; saved catalogue revision 1.
- `native-live-observation-api.json` (20:02:23): real 20-item response observation
  revision 8 with the same unread state; its captured dom already contains
  `index-00020-000000` followed by `finished.`.
- `10-native-final-live20.png` (20:03:29) shows the same row's gold check.

the actual summary item, shared summary entry, and javascript listening facts
were not captured together. observation delivery from revision 1 to 8 remains
proven; the rendered disagreement cannot yet be attributed to a stale shared
summary, an observation-publication problem, or subsequent local playback.

source candidate: live `LibraryPaneBody` resolves its fresh per-read seeds through
`MediaSummaryProvider`, where an already resolved retained entry wins and unchanged
membership does not ingest new seeds. that ownership and its invalidation triggers
already exist on main `000af194d`; the index change's no-op notification suppression
still replaces and publishes any changed summary. android playback, native facts
publication, and canonical consumption projection are unchanged. no regression
owner has been established.

qualification used the real same-origin unread endpoint directly, without the
application command's consumption-topic publication, then the actual toolbar
refresh. distinguish that observation-transport exercise from the ordinary
application mutation path when investigating summary freshness.
the normal command publishes `Consumption` and `Podcasts` after acknowledgement
(`lib/consumption/state.tsx`); the fixture omitted that publication. the summary
owner's 60-second foreground limit is a throttle on returning, not a periodic poll.

reproduce with a real short episode retained through native playback, mark that
same media unread through its canonical writer, and refresh the live library.
capture the response summary and stamped observation, displayed shared summary,
and native/javascript listening facts at one publication. resolved when that
evidence identifies and repairs the responsible owner, and the rendered state
respects the accepted unread override without concealing newer local activity.

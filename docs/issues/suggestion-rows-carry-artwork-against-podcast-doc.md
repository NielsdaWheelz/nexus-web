# suggestion rows carry artwork against the podcast doc

`docs/modules/podcast.md:58` says `presentFeed` projects `image_url` into an
artwork capability and "suggestions omit that capability". the code passes it:
`apps/web/src/lib/suggestions.ts:69-78` calls `presentFeed({ …, imageUrl:
target.image_url, … })`, so suggested podcasts and feeds draw their artwork
(found at `839bb918b` during the face-out survey, `research/anatomy.md` defect 23).

impact: the doc and the code disagree about what a suggestion row may paint and
fetch. a reader trusting the doc will expect no artwork requests from suggestions.

proposed fix: decide which is right. if suggestions should show art (they read
better with it), change the doc's clause; if not, pass `imageUrl: null` here.

resolved when `podcast.md` and `suggestions.ts` say the same thing.

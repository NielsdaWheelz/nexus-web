# resource-first search cutover

ship api and hosted web together: `/search` has the resource/passage response
union, `/search/preview` owns launcher discovery, and the old openables endpoint
is removed. reload open clients after rollout; there is no compatibility reader.

wire remains 12: the x-thread cutover already advanced it from released wire 11.
do not advance it again before that release. search adds no migration or env key.
the base branch's schema/client prerequisites remain owned by
[release-x-thread-imports.md](release-x-thread-imports.md) and
[release-x-articles.md](release-x-articles.md).

after rollout, check exact-name promotion, ordinary enter to search, source versus
matching-passage opening, view switching and semantic-incomplete feedback. delete
this record once the coordinated rollout and checks are complete.
